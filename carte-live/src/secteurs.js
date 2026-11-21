'use strict';
// Secteurs d'alerte (géorepérage) des équipes de terrain : prévenir quand un membre sort d'un secteur (ou y entre).
//
// - Un secteur est un cercle (centre + rayon) ou un polygone dessiné sur la carte, rattaché à une équipe (ses membres
//   du moment) et/ou à des nœuds choisis (Meshtastic par numéro, MeshCore par clé publique).
// - Détection sur chaque position reçue, avec anti-rebond :
//   · une position n'est « dehors » qu'au-delà d'une marge (en mètres) après la limite, et « dedans » qu'en deçà ;
//     entre les deux (bordure), elle ne change rien ;
//   · il faut N positions consécutives du même côté (2 par défaut) pour changer d'état ;
//   · deux alertes du même genre pour le même nœud et le même secteur sont espacées d'un délai minimal ;
//   · la précision annoncée par le firmware (positions floutées 2.7/2.8 : precision_bits) élargit la marge, et une
//     position trop floue par rapport à la taille du secteur est ignorée (notée une fois dans le journal) ;
//   · un même paquet reçu par plusieurs passerelles ne compte qu'une fois.
// - Perte de contact (option) : aucune nouvelle position depuis X minutes pour un membre suivi.
// - Journal des événements (entrées, sorties, pertes de contact…) gardé dans secteurs.json (3 000 derniers).
// Les alertes rejoignent celles du réseau (onglet Alertes, domotique, appli Android) ; ce module ne fait aucun
// envoi radio lui-même : l'envoi LoRa facultatif passe par la fonction « envoyerLora » fournie par le serveur.

const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');

const R = 6371000, RAD = Math.PI / 180;
const JOURNAL_MAX = 3000;
const SENS = ['sortie', 'entree', 'deux'];

// ---- Géométrie (fonctions pures, testées dans tests/radio.js) ------------------------------------------------
function distance(a, b) {
  const dl = (b.lat - a.lat) * RAD, dg = (b.lon - a.lon) * RAD;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Projection locale en mètres autour d'une origine (plan tangent) : précise à mieux que 0,1 % sur quelques dizaines de km
const projeter = (o, lat, lon) => ({ x: (lon - o.lon) * RAD * R * Math.cos(o.lat * RAD), y: (lat - o.lat) * RAD * R });
// Point dans un polygone (lancer de rayon), points = [[lat, lon], …]
function pointDansPolygone(p, points) {
  let dedans = false;
  const q = points.map(([la, lo]) => projeter(p, la, lo));
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > 0) !== (b.y > 0) && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) dedans = !dedans;
  }
  return dedans;
}
// Distance de l'origine (0, 0) au segment [a, b]
function distanceSegment(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / l2)) : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}
// Distance signée à la limite du secteur, en mètres : positive dehors, négative dedans
function distanceLimite(s, p) {
  if (s.forme === 'cercle') return distance(s.centre, p) - s.rayon;
  const q = s.points.map(([la, lo]) => projeter(p, la, lo));
  let d = Infinity;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) d = Math.min(d, distanceSegment(q[j], q[i]));
  return pointDansPolygone(p, s.points) ? -d : d;
}
// Surface d'un polygone (m²), formule du lacet dans le plan tangent du premier sommet
function surfacePolygone(points) {
  const o = { lat: points[0][0], lon: points[0][1] };
  const q = points.map(([la, lo]) => projeter(o, la, lo));
  let s = 0;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) s += q[j].x * q[i].y - q[i].x * q[j].y;
  return Math.abs(s) / 2;
}
// Taille caractéristique (rayon équivalent, m) : sert à juger si une position est assez précise pour ce secteur
const tailleSecteur = (s) => (s.forme === 'cercle' ? s.rayon : Math.sqrt(surfacePolygone(s.points) / Math.PI));
// Rayon d'incertitude d'une position floutée (Meshtastic precision_bits) : la moitié de la maille gardée.
// 32 (ou absent) = position exacte ; 13 bits ≈ 2,9 km ; 16 bits ≈ 364 m ; 19 bits ≈ 45 m.
function incertitude(bits) {
  const b = Number(bits);
  if (!Number.isFinite(b) || b <= 0 || b >= 32) return 0;
  return 2 ** (31 - b) * 1e-7 * 111320;
}
// Côté de la limite où se trouve une position : 'dehors', 'dedans' ou 'bordure' (dans la marge, ou trop incertaine)
// La marge s'applique du côté qui déclenche l'alerte : au-delà de la limite pour une sortie, en deçà pour une entrée.
function classer(s, d, inc = 0) {
  const margeDehors = s.sens === 'entree' ? 0 : s.marge, margeDedans = s.sens === 'sortie' ? 0 : s.marge;
  if (d - inc > margeDehors) return 'dehors';
  if (d + inc < -margeDedans) return 'dedans';
  return 'bordure';
}
// Le passage vers cet état déclenche-t-il une alerte pour ce secteur ?
const alertant = (s, vers) => s.sens === 'deux' || (s.sens === 'sortie' && vers === 'dehors') || (s.sens === 'entree' && vers === 'dedans');

// Une étape de la machine à états d'un nœud dans un secteur (fonction pure) :
// st = { etat: 'inconnu'|'dedans'|'dehors', candidat, nb, depuis, alertes: { dehors, dedans } }
// Renvoie l'événement éventuel : { type: 'sortie'|'entree', initial, alerte, notifier }
function etape(s, st, classe, t) {
  if (classe === 'bordure') return null; // ni confirme ni annule : un aller-retour sur la limite ne compte pas
  if (classe === st.etat) { st.candidat = null; st.nb = 0; return null; }
  if (st.candidat === classe) st.nb++; else { st.candidat = classe; st.nb = 1; }
  if (st.nb < s.confirmations) return null;
  const initial = st.etat === 'inconnu';
  st.etat = classe; st.depuis = t; st.candidat = null; st.nb = 0;
  const evt = { type: classe === 'dehors' ? 'sortie' : 'entree', initial, alerte: alertant(s, classe) && !(initial && classe === 'dedans' && s.sens === 'deux'), notifier: false };
  if (evt.alerte) {
    st.alertes = st.alertes || {};
    const der = st.alertes[classe] || 0;
    if (t - der >= s.delaiMin * 60000) { evt.notifier = true; st.alertes[classe] = t; }
  }
  return evt;
}

const fmtDist = (m) => (Math.abs(m) < 1000 ? `${Math.round(Math.abs(m))} m` : `${(Math.abs(m) / 1000).toFixed(1).replace('.', ',')} km`);
const entier = (v, min, max, def) => { if (v === undefined || v === null || v === '') return def; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Valeur hors limites (${min} à ${max})`); return n; };

function valider(b, ancien = {}, equipeExiste = () => true) {
  const s = { ...ancien };
  if (b.nom !== undefined || !ancien.nom) {
    const nom = String(b.nom || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    if (!nom) throw new Error('Donnez un nom au secteur');
    s.nom = nom;
  }
  if (b.forme !== undefined || !ancien.forme) {
    if (b.forme === 'cercle') {
      const lat = Number(b.centre && b.centre.lat), lon = Number(b.centre && b.centre.lon), rayon = Number(b.rayon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Centre du secteur invalide');
      if (!(rayon >= 50 && rayon <= 100000)) throw new Error('Rayon du secteur invalide (50 m à 100 km)');
      Object.assign(s, { forme: 'cercle', centre: { lat, lon }, rayon: Math.round(rayon) }); delete s.points;
    } else if (b.forme === 'polygone') {
      const pts = Array.isArray(b.points) ? b.points.map((p) => [Number(p[0] ?? p.lat), Number(p[1] ?? p.lon ?? p.lng)]) : [];
      if (pts.length < 3 || pts.length > 200) throw new Error('Polygone : 3 à 200 sommets');
      if (pts.some(([la, lo]) => !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180)) throw new Error('Sommet du polygone invalide');
      const surf = surfacePolygone(pts);
      if (surf < 2000) throw new Error('Polygone trop petit (2 000 m² au moins)');
      if (Math.sqrt(surf / Math.PI) > 100000) throw new Error('Polygone trop grand (100 km de rayon au plus)');
      Object.assign(s, { forme: 'polygone', points: pts.map(([la, lo]) => [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6]) }); delete s.centre; delete s.rayon;
    } else throw new Error('Forme du secteur : cercle ou polygone');
  }
  if (b.equipe !== undefined) {
    if (b.equipe && !equipeExiste(String(b.equipe))) throw new Error('Équipe inconnue');
    s.equipe = b.equipe ? String(b.equipe) : null;
  }
  if (b.noeuds !== undefined) s.noeuds = [...new Set((Array.isArray(b.noeuds) ? b.noeuds : []).map((x) => Number(x) >>> 0))].filter(Boolean).slice(0, 200);
  if (b.noeudsMc !== undefined) {
    const l = (Array.isArray(b.noeudsMc) ? b.noeudsMc : []).map((x) => String(x).trim().toUpperCase());
    if (l.some((x) => !/^[0-9A-F]{64}$/.test(x))) throw new Error('Nœud MeshCore : clé publique complète attendue (64 caractères hexadécimaux)');
    s.noeudsMc = [...new Set(l)].slice(0, 200);
  }
  s.noeuds = s.noeuds || []; s.noeudsMc = s.noeudsMc || [];
  if (!s.equipe && !s.noeuds.length && !s.noeudsMc.length) throw new Error('Rattachez le secteur à une équipe ou à des nœuds');
  if (b.sens !== undefined || !ancien.sens) { const v = b.sens || 'sortie'; if (!SENS.includes(v)) throw new Error('Alerte : sortie, entrée ou les deux'); s.sens = v; }
  s.marge = entier(b.marge, 0, 2000, ancien.marge ?? 30);
  s.confirmations = entier(b.confirmations, 1, 5, ancien.confirmations ?? 2);
  s.delaiMin = entier(b.delaiMin, 1, 240, ancien.delaiMin ?? 10);
  s.silenceMin = entier(b.silenceMin, 0, 1440, ancien.silenceMin ?? 0);
  if (s.silenceMin && s.silenceMin < 5) throw new Error('Perte de contact : 5 minutes au moins');
  if (b.canalLora !== undefined) s.canalLora = b.canalLora === null || b.canalLora === '' ? null : entier(b.canalLora, 0, 7, null);
  if (s.canalLora === undefined) s.canalLora = null;
  if (b.actif !== undefined) s.actif = !!b.actif; else if (s.actif === undefined) s.actif = true;
  return s;
}

function creerSecteurs({
  config, journal = () => {}, diffuser = () => {}, surEvenement = () => {}, envoyerLora = null,
  membresEquipe = () => [], nomEquipe = () => null, nomDe = () => null, positionDe = () => null,
  maintenant = () => Date.now(), intervalleMs = 60000,
}) {
  const fichier = path.join(path.dirname(config.fichierBase), 'secteurs.json');
  let secteurs = [], etats = {}, evenements = [];
  try { const d = lireJson(fichier); secteurs = d.secteurs || []; etats = d.etats || {}; evenements = d.journal || []; } catch { /* aucun */ }

  let minuterie = null;
  function sauver(tout = false) {
    clearTimeout(minuterie);
    const ecrire = () => { try { ecrireSur(fichier, JSON.stringify({ secteurs, etats, journal: evenements }), { mode: 0o600 }); } catch (e) { journal('[Secteurs] enregistrement impossible :', e.message); } };
    if (tout) ecrire(); else { minuterie = setTimeout(ecrire, 2000); if (minuterie.unref) minuterie.unref(); }
  }
  const trouver = (id) => secteurs.find((s) => s.id === id);
  function exiger(id) { const s = trouver(id); if (!s) throw new Error('Secteur inconnu'); return s; }
  // Membres suivis d'un secteur : clés « mt:NUM » et « mc:CLÉ »
  function membres(s) {
    const l = new Set();
    if (s.equipe) for (const n of membresEquipe(s.equipe) || []) l.add('mt:' + (Number(n) >>> 0));
    for (const n of s.noeuds || []) l.add('mt:' + (n >>> 0));
    for (const c of s.noeudsMc || []) l.add('mc:' + c);
    return [...l];
  }
  const nomNoeud = (k) => { try { const v = nomDe(k); if (v) return v; } catch { /* sans nom */ } return k.startsWith('mt:') ? '!' + (Number(k.slice(3)) >>> 0).toString(16).padStart(8, '0') : k.slice(3, 11); };
  const etatDe = (s, k) => (etats[s.id + '|' + k] ||= { etat: 'inconnu', candidat: null, nb: 0, depuis: null, alertes: {} });

  function noter(s, k, type, champs = {}) {
    const e = { id: crypto.randomBytes(5).toString('hex'), heure: maintenant(), secteur: s.id, nomSecteur: s.nom, noeud: k || null, nom: k ? nomNoeud(k) : null, type, ...champs };
    evenements.push(e);
    if (evenements.length > JOURNAL_MAX) evenements.splice(0, evenements.length - JOURNAL_MAX);
    return e;
  }
  function message(e) {
    const S = e.nomSecteur, n = e.nom;
    switch (e.type) {
      case 'sortie': return e.initial ? `Secteur ${S} : ${n} est hors du secteur (${fmtDist(e.distance)} au-delà de la limite)` : `Secteur ${S} : ${n} est sorti du secteur (${fmtDist(e.distance)} au-delà de la limite)`;
      case 'entree': return e.initial ? `Secteur ${S} : ${n} est dans le secteur` : `Secteur ${S} : ${n} est entré dans le secteur`;
      case 'silence': return `Secteur ${S} : ${n} sans nouvelle position depuis ${e.minutes} min`;
      case 'contact': return `Secteur ${S} : contact retrouvé avec ${n}`;
      case 'imprecise': return `Secteur ${S} : position de ${n} trop imprécise (± ${fmtDist(e.precision)}) pour ce secteur, ignorée`;
      case 'creation': return `Secteur ${S} créé par ${e.auteur}`;
      case 'modification': return `Secteur ${S} modifié par ${e.auteur}`;
      case 'suppression': return `Secteur ${S} supprimé par ${e.auteur}`;
      default: return `Secteur ${S} : ${e.type}`;
    }
  }
  // Envoi LoRa facultatif du secteur : au plus un message toutes les 30 s pour toute la carte (le reste est noté)
  let dernierLora = 0;
  function lora(s, e) {
    if (s.canalLora == null || !envoyerLora || !e.notifier) return;
    const t = maintenant();
    if (t - dernierLora < 30000) { e.lora = 'différé'; return; }
    dernierLora = t;
    const texte = e.type === 'sortie' ? `⛔ ${e.nom} hors secteur ${s.nom}` : e.type === 'entree' ? `⚠ ${e.nom} entré secteur ${s.nom}` : `⚠ ${e.nom} sans position ${e.minutes} min (${s.nom})`;
    try { envoyerLora(texte.slice(0, 200), s.canalLora); e.lora = 'envoyé'; } catch (x) { e.lora = 'échec : ' + x.message; }
  }
  function publier(s, e) {
    e.message = message(e);
    lora(s, e);
    // Critique seulement pour un passage qui déclenche l'alerte du secteur (pas pour « dans le secteur » au départ)
    const niveau = (e.type === 'sortie' || e.type === 'entree') && e.alerte ? 'critique' : e.type === 'silence' ? 'attention' : 'info';
    diffuser({ genre: 'secteur-alerte', niveau, ...e });
    if (e.notifier) journal(`[Secteurs] ${e.message}`);
    try { surEvenement({ ...e, niveau }); } catch (x) { journal('[Secteurs]', x.message); }
  }

  // Dédoublonnage des paquets reçus par plusieurs passerelles (clé du paquet, 10 min)
  const vus = new Map();
  function dejaVu(id) {
    if (id == null) return false;
    const t = maintenant();
    if (vus.has(id) && t - vus.get(id) < 600000) return true;
    vus.set(id, t);
    if (vus.size > 5000) for (const [k, v] of vus) { if (t - v > 600000 || vus.size > 4000) vus.delete(k); else break; }
    return false;
  }

  // Position reçue d'un nœud. cle = 'mt:NUM' ou 'mc:CLÉ' ; p = { lat, lon, precision (bits), heure, id (paquet) }
  function position(cle, p) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return [];
    if (Math.abs(p.lat) < 1e-4 && Math.abs(p.lon) < 1e-4) return []; // « 0, 0 » : pas de position GPS
    const concernes = secteurs.filter((s) => s.actif && membres(s).includes(cle));
    if (!concernes.length || dejaVu(p.id != null ? cle + ':' + p.id : null)) return [];
    const t = p.heure || maintenant();
    const inc = incertitude(p.precision);
    const sortie = [];
    for (const s of concernes) {
      const st = etatDe(s, cle);
      const pos = { lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 };
      if (st.silence) { const e = noter(s, cle, 'contact', { ...pos, notifier: false }); delete st.silence; publier(s, e); sortie.push(e); }
      if (inc && inc > tailleSecteur(s) / 2) {
        // Position volontairement floutée, plus large que le secteur : elle ne dit rien de dedans ou dehors
        if (!st.imprecise) { const e = noter(s, cle, 'imprecise', { ...pos, precision: Math.round(inc), notifier: false }); publier(s, e); sortie.push(e); }
        st.imprecise = t; st.derniere = { ...pos, heure: t, precision: Math.round(inc), d: null };
        continue;
      }
      delete st.imprecise;
      const d = distanceLimite(s, p);
      st.derniere = { ...pos, heure: t, precision: Math.round(inc), d: Math.round(d) };
      const evt = etape(s, st, classer(s, d, inc), t);
      if (evt) {
        const e = noter(s, cle, evt.type, { heure: t, ...pos, distance: Math.round(d), precision: Math.round(inc), initial: evt.initial, alerte: evt.alerte, notifier: evt.notifier });
        if (evt.alerte && !evt.notifier) e.detail = 'alerte non répétée (délai minimal entre deux alertes)';
        publier(s, e); sortie.push(e);
      }
    }
    sauver();
    return sortie;
  }

  // Perte de contact : aucun signe depuis silenceMin (dernière position vue ici, ou en base, ou création du secteur)
  function verifierSilences() {
    const t = maintenant();
    let change = false;
    for (const s of secteurs) {
      if (!s.actif || !s.silenceMin) continue;
      for (const k of membres(s)) {
        const st = etatDe(s, k);
        if (st.silence) continue;
        let der = Math.max(st.derniere ? st.derniere.heure : 0, s.modifie || s.cree || 0);
        if (k.startsWith('mt:')) { try { const p = positionDe(Number(k.slice(3))); if (p && p.heure) der = Math.max(der, p.heure); } catch { /* base indisponible */ } }
        if (t - der < s.silenceMin * 60000) continue;
        st.silence = t;
        const der2 = st.alertes && st.alertes.silence || 0;
        const notifier = t - der2 >= s.delaiMin * 60000;
        if (notifier) { st.alertes = st.alertes || {}; st.alertes.silence = t; }
        const e = noter(s, k, 'silence', { heure: t, minutes: Math.round((t - der) / 60000), notifier, ...(st.derniere ? { lat: st.derniere.lat, lon: st.derniere.lon } : {}) });
        publier(s, e); change = true;
      }
    }
    if (change) sauver();
  }
  const minutSilence = intervalleMs ? setInterval(() => { try { verifierSilences(); } catch (e) { journal('[Secteurs] perte de contact :', e.message); } }, intervalleMs) : null;
  if (minutSilence && minutSilence.unref) minutSilence.unref();

  function vue(s) {
    const l = membres(s).map((k) => {
      const st = etats[s.id + '|' + k] || { etat: 'inconnu' };
      return { cle: k, nom: nomNoeud(k), etat: st.etat, depuis: st.depuis || null, derniere: st.derniere || null, silence: st.silence || null, imprecise: st.imprecise || null };
    });
    const { id, nom, forme, centre, rayon, points, equipe, noeuds, noeudsMc, sens, marge, confirmations, delaiMin, silenceMin, canalLora, actif, cree, auteur, modifie } = s;
    return { id, nom, forme, centre, rayon, points, equipe, nomEquipe: equipe ? nomEquipe(equipe) : null, noeuds, noeudsMc, sens, marge, confirmations, delaiMin, silenceMin, canalLora, actif, cree, auteur, modifie: modifie || null,
      taille: Math.round(tailleSecteur(s)), membres: l, dehors: l.filter((m) => m.etat === 'dehors').length, dedans: l.filter((m) => m.etat === 'dedans').length };
  }
  const equipeExiste = (id) => nomEquipe(id) != null;
  function creer(b, auteur) {
    if (secteurs.length >= 200) throw new Error('200 secteurs au plus');
    const s = { id: crypto.randomBytes(5).toString('hex'), ...valider(b || {}, {}, equipeExiste), cree: maintenant(), auteur };
    secteurs.push(s);
    noter(s, null, 'creation', { auteur });
    sauver(true);
    journal(`[Secteurs] secteur « ${s.nom} » créé par ${auteur}`);
    diffuser({ genre: 'secteurs' });
    return vue(s);
  }
  function modifier(id, b, auteur) {
    const s = exiger(id);
    const n = valider(b || {}, s, equipeExiste);
    const geo = b.forme !== undefined;
    Object.assign(s, n, { modifie: maintenant() });
    if (n.forme === 'cercle') delete s.points; else { delete s.centre; delete s.rayon; }
    // Forme ou réglages changés : les comptages en cours repartent de zéro (l'état connu reste)
    for (const k of Object.keys(etats)) if (k.startsWith(s.id + '|')) { etats[k].candidat = null; etats[k].nb = 0; if (geo) delete etats[k].imprecise; }
    noter(s, null, 'modification', { auteur });
    sauver(true);
    diffuser({ genre: 'secteurs' });
    return vue(s);
  }
  function supprimer(id, auteur) {
    const s = exiger(id);
    secteurs = secteurs.filter((x) => x !== s);
    for (const k of Object.keys(etats)) if (k.startsWith(s.id + '|')) delete etats[k];
    noter(s, null, 'suppression', { auteur });
    sauver(true);
    journal(`[Secteurs] secteur « ${s.nom} » supprimé par ${auteur}`);
    diffuser({ genre: 'secteurs' });
    return { ok: true };
  }
  // Ancienne « zone de sécurité » (cercle) d'une équipe : devient un secteur rattaché à l'équipe
  function zoneEquipe(idEquipe, zone, auteur = 'carte') {
    const ex = secteurs.find((s) => s.equipe === idEquipe && s.zoneEquipe);
    if (!zone) { if (ex) supprimer(ex.id, auteur); return null; }
    const b = { nom: `Zone de sécurité ${nomEquipe(idEquipe) || ''}`.trim(), forme: 'cercle', centre: { lat: zone.lat, lon: zone.lon }, rayon: zone.rayon, equipe: idEquipe };
    if (ex) return modifier(ex.id, b, auteur);
    const v = creer({ ...b, marge: 100 }, auteur);
    trouver(v.id).zoneEquipe = true; sauver(true);
    return v;
  }

  // Alertes actives : membre hors du secteur (ou dedans pour un secteur « entrée »), perte de contact
  function alertes() {
    const l = [];
    for (const s of secteurs) {
      if (!s.actif) continue;
      for (const k of membres(s)) {
        const st = etats[s.id + '|' + k];
        if (!st) continue;
        const num = k.startsWith('mt:') ? Number(k.slice(3)) : null;
        const base = { type: 'secteur', noeud: num, noeudMc: num == null ? k.slice(3) : null, secteur: s.id };
        if (st.etat === 'dehors' && s.sens !== 'entree') l.push({ ...base, cle: `secteur:${s.id}:${k}:dehors:${st.depuis}`, niveau: 'critique', depuis: st.depuis, message: `Secteur ${s.nom} : ${nomNoeud(k)} hors du secteur${st.derniere && st.derniere.d != null ? ` (${fmtDist(st.derniere.d)} au-delà de la limite)` : ''}` });
        if (st.etat === 'dedans' && s.sens === 'entree') l.push({ ...base, cle: `secteur:${s.id}:${k}:dedans:${st.depuis}`, niveau: 'critique', depuis: st.depuis, message: `Secteur ${s.nom} : ${nomNoeud(k)} est dans le secteur` });
        if (st.silence) l.push({ ...base, cle: `secteur:${s.id}:${k}:silence:${st.silence}`, niveau: 'attention', depuis: st.silence, message: `Secteur ${s.nom} : ${nomNoeud(k)} sans nouvelle position depuis ${Math.round((maintenant() - Math.max(st.derniere ? st.derniere.heure : 0, s.modifie || s.cree || 0)) / 60000)} min` });
      }
    }
    return l;
  }
  function lireJournal({ secteur, limite = 200, depuis = 0 } = {}) {
    let l = evenements;
    if (secteur) l = l.filter((e) => e.secteur === secteur);
    if (depuis) l = l.filter((e) => e.heure >= depuis);
    return l.slice(-Math.min(Math.max(Number(limite) || 200, 1), JOURNAL_MAX)).reverse().map((e) => ({ ...e, message: e.message || message(e) }));
  }
  function csv({ secteur, depuis } = {}) {
    const q = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const l = lireJournal({ secteur, depuis, limite: JOURNAL_MAX }).reverse();
    const heureLocale = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' });
    return ['heure_utc;heure_locale;secteur;type;noeud;nom;lat;lon;distance_m;precision_m;notifie;message',
      ...l.map((e) => [new Date(e.heure).toISOString(), heureLocale(e.heure), e.nomSecteur, e.type, e.noeud ? e.noeud.replace(/^mt:(\d+)$/, (_, n) => '!' + (Number(n) >>> 0).toString(16).padStart(8, '0')).replace(/^mc:/, '') : '', e.nom, e.lat, e.lon, e.distance, e.precision, e.notifier ? 'oui' : 'non', e.message || message(e)].map(q).join(';'))].join('\n');
  }
  // Résumé pour la fiche d'une équipe
  const resumeEquipe = (idEquipe) => secteurs.filter((s) => s.equipe === idEquipe).map((s) => { const v = vue(s); return { id: v.id, nom: v.nom, forme: v.forme, actif: v.actif, dehors: v.dehors, sens: v.sens }; });
  // Nœud renuméroté (firmware 2.8) : il garde ses secteurs et son état sous son nouveau numéro
  function renumeroter(ancien, nouveau) {
    const a = ancien >>> 0, n = nouveau >>> 0;
    let nb = 0;
    for (const s of secteurs) { const i = (s.noeuds || []).indexOf(a); if (i >= 0 && !s.noeuds.includes(n)) { s.noeuds[i] = n; nb++; } }
    for (const k of Object.keys(etats)) if (k.endsWith('|mt:' + a)) { etats[k.replace(/\|mt:\d+$/, '|mt:' + n)] = etats[k]; delete etats[k]; }
    if (nb) sauver(true);
    return nb;
  }
  return {
    liste: () => secteurs.map(vue), secteur: (id) => vue(exiger(id)), creer, modifier, supprimer, zoneEquipe,
    position, verifierSilences, alertes, journal: lireJournal, csv, resumeEquipe, renumeroter,
    arreter: () => { clearInterval(minutSilence); clearTimeout(minuterie); sauver(true); },
  };
}

module.exports = { creerSecteurs, distance, distanceLimite, pointDansPolygone, surfacePolygone, tailleSecteur, incertitude, classer, etape, valider };
