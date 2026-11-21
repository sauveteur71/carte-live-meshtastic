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
//   · la précision annoncée par le firmware (positions floutées 2.7/2.8 : precision_bits) élargit la marge : une
//     position floutée reste surveillée (elle est « dehors » seulement si toute sa maille l'est) ; tant qu'elle ne
//     permet pas de trancher, le nœud est signalé « non surveillable précisément » (alerte de niveau attention) ;
//   · une position dont la mesure GPS est périmée (nœud qui répète un vieux fix) n'est pas comptée ;
//   · un même paquet reçu par plusieurs passerelles ne compte qu'une fois.
// - Sortie probable : une seule position hors secteur suivie d'un silence (plus de nouvelles depuis 10 min ou un
//   intervalle de suivi) est signalée sans attendre la confirmation, qui n'arrivera peut-être jamais.
// - Perte de contact (option) : aucune nouvelle position depuis X minutes pour un membre suivi. Délai de grâce
//   au démarrage, et vérification suspendue (une seule alerte « flux interrompu ») quand la carte ne reçoit plus
//   rien d'aucune source : le silence vient alors de la carte, pas des intervenants.
// - Journal des événements (entrées, sorties, pertes de contact…) gardé dans secteurs.json (3 000 derniers).
// Les alertes rejoignent celles du réseau (onglet Alertes, domotique, appli Android) ; ce module ne fait aucun
// envoi radio lui-même : l'envoi LoRa facultatif passe par la fonction « envoyerLora » fournie par le serveur
// (file d'attente bornée, un message toutes les 30 s, 20 par heure au plus, 200 octets par message).

const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');

const R = 6371000, RAD = Math.PI / 180;
const JOURNAL_MAX = 3000;
const SENS = ['sortie', 'entree', 'deux'];
const LORA_ESPACEMENT_MS = 30000, LORA_FILE_MAX = 10, LORA_PAR_HEURE = 20, LORA_OCTETS_MAX = 200;
const FLUX_COUPE_MIN = 10; // plus rien reçu d'aucune source depuis ce délai : surveillance des silences suspendue
const CANDIDAT_EXPIRE_MS = 3600000; // un comptage « peut-être dehors » non confirmé est oublié au bout d'une heure

// ---- Géométrie (fonctions pures, testées dans tests/radio.js) ------------------------------------------------
function distance(a, b) {
  const dl = (b.lat - a.lat) * RAD, dg = (b.lon - a.lon) * RAD;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Écart de longitude ramené dans ]-180, 180] : un secteur à cheval sur l'antiméridien (180°) reste d'un seul tenant
const ecartLon = (lon, ref) => (((lon - ref + 540) % 360) + 360) % 360 - 180;
// Projection locale en mètres autour d'une origine (plan tangent) : précise à mieux que 0,1 % sur quelques dizaines de km
const projeter = (o, lat, lon) => ({ x: ecartLon(lon, o.lon) * RAD * R * Math.cos(o.lat * RAD), y: (lat - o.lat) * RAD * R });
// Sommets d'un polygone projetés autour du point p, longitudes déroulées autour du premier sommet : un polygone à
// cheval sur l'antiméridien reste d'un seul tenant, et un point à l'autre bout du monde reste dehors
function sommetsAutour(p, points) {
  const ref = points[0][1], lonP = ref + ecartLon(p.lon, ref);
  return points.map(([la, lo]) => ({ x: (ref + ecartLon(lo, ref) - lonP) * RAD * R * Math.cos(p.lat * RAD), y: (la - p.lat) * RAD * R }));
}
// Point dans un polygone (lancer de rayon), points = [[lat, lon], …]
function pointDansPolygone(p, points) {
  let dedans = false;
  const q = sommetsAutour(p, points);
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
  const q = sommetsAutour(p, s.points);
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
// Deux segments [a, b] et [c, d] (plan) se croisent-ils franchement (hors extrémités communes) ?
function segmentsCroises(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}
// Polygone auto-intersecté (nœud papillon) : deux arêtes non voisines se croisent
function polygoneCroise(points) {
  const o = { lat: points[0][0], lon: points[0][1] };
  const q = points.map(([la, lo]) => projeter(o, la, lo));
  const n = q.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // arêtes voisines par le bouclage
      if (segmentsCroises(q[i], q[(i + 1) % n], q[j], q[(j + 1) % n])) return true;
    }
  }
  return false;
}
// Taille caractéristique (rayon équivalent, m) : sert à juger si une position est assez précise pour ce secteur
const tailleSecteur = (s) => (s.forme === 'cercle' ? s.rayon : Math.sqrt(surfacePolygone(s.points) / Math.PI));
// Rayon d'incertitude d'une position floutée (Meshtastic precision_bits) : demi-diagonale de la maille gardée,
// à la latitude donnée (la maille est un carré en degrés, donc un rectangle au sol : moins large vers les pôles).
// 32 (ou absent) = position exacte ; à 45° de latitude : 13 bits ≈ 3,6 km ; 16 bits ≈ 450 m ; 19 bits ≈ 56 m.
function incertitude(bits, lat = 0) {
  const b = Number(bits);
  if (!Number.isFinite(b) || b <= 0 || b >= 32) return 0;
  return 2 ** (31 - b) * 1e-7 * 111320 * Math.hypot(1, Math.cos((Number(lat) || 0) * RAD));
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
// st = { etat: 'inconnu'|'dedans'|'dehors', candidat, nb, candidatDepuis, depuis, alertes: { dehors, dedans } }
// Renvoie l'événement éventuel : { type: 'sortie'|'entree', initial, alerte, notifier }
function etape(s, st, classe, t) {
  if (classe === 'bordure') return null; // ni confirme ni annule : un aller-retour sur la limite ne compte pas
  if (classe === st.etat) { st.candidat = null; st.nb = 0; delete st.candidatDepuis; return null; }
  if (st.candidat === classe) st.nb++; else { st.candidat = classe; st.nb = 1; st.candidatDepuis = t; }
  if (st.nb < s.confirmations) return null;
  return changerEtat(s, st, classe, t, false);
}
// Changement d'état confirmé (ou sortie probable) : événement, alerte et anti-répétition
function changerEtat(s, st, classe, t, probable) {
  const initial = st.etat === 'inconnu';
  st.etat = classe; st.depuis = t; st.candidat = null; st.nb = 0; delete st.candidatDepuis;
  if (probable) st.probable = t; else delete st.probable;
  const evt = { type: classe === 'dehors' ? 'sortie' : 'entree', initial, probable: !!probable, alerte: alertant(s, classe) && !(initial && classe === 'dedans' && s.sens === 'deux'), notifier: false };
  if (evt.alerte) {
    st.alertes = st.alertes || {};
    const der = st.alertes[classe] || 0;
    if (t - der >= s.delaiMin * 60000) { evt.notifier = true; st.alertes[classe] = t; }
  }
  return evt;
}

const fmtDist = (m) => (Math.abs(m) < 1000 ? `${Math.round(Math.abs(m))} m` : `${(Math.abs(m) / 1000).toFixed(1).replace('.', ',')} km`);
const entier = (v, min, max, def) => { if (v === undefined || v === null || v === '') return def; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Valeur hors limites (${min} à ${max})`); return n; };
// Coupe un texte à N octets UTF-8 sans casser un caractère (limite des messages radio)
function couperOctets(texte, max) {
  let n = 0, out = '';
  for (const c of String(texte)) { const l = Buffer.byteLength(c); if (n + l > max) break; n += l; out += c; }
  return out;
}
// Cellule CSV : guillemets si nécessaire, et une apostrophe devant tout ce qu'un tableur prendrait pour une formule
function celluleCsv(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

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
      if (pts.some(([la]) => Math.abs(la) > 85)) throw new Error('Polygone trop près d’un pôle (latitude 85° au plus)');
      if (polygoneCroise(pts)) throw new Error('Le contour se croise lui-même : redessinez le polygone sans croiser ses côtés');
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
  // Alerte à l'entrée : la marge est prise à l'intérieur ; au-delà de la moitié du secteur, rien ne pourrait plus être « dedans »
  if (s.sens !== 'sortie' && s.marge >= tailleSecteur(s) / 2) throw new Error(`Marge trop grande pour ce secteur (moins de ${Math.round(tailleSecteur(s) / 2)} m pour une alerte à l’entrée)`);
  s.confirmations = entier(b.confirmations, 1, 5, ancien.confirmations ?? 2);
  s.delaiMin = entier(b.delaiMin, 1, 240, ancien.delaiMin ?? 10);
  s.silenceMin = entier(b.silenceMin, 0, 1440, ancien.silenceMin ?? 30);
  if (s.silenceMin && s.silenceMin < 5) throw new Error('Perte de contact : 5 minutes au moins');
  if (b.canalLora !== undefined) s.canalLora = b.canalLora === null || b.canalLora === '' ? null : entier(b.canalLora, 0, 7, null);
  if (s.canalLora === undefined) s.canalLora = null;
  if (b.actif !== undefined) s.actif = !!b.actif; else if (s.actif === undefined) s.actif = true;
  return s;
}

function creerSecteurs({
  config, journal = () => {}, diffuser = () => {}, surEvenement = () => {}, envoyerLora = null,
  membresEquipe = () => [], nomEquipe = () => null, nomDe = () => null, positionDe = () => null,
  // Intervalle de suivi (minutes) de l'équipe, 0 si aucun ; dernière réception d'un paquet par la carte (toutes
  // sources) ; demande de position immédiate à un nœud Meshtastic (facultatif)
  suiviMinDe = () => 0, derniereReception = null, demanderPosition = null,
  maintenant = () => Date.now(), intervalleMs = 60000,
}) {
  const fichier = path.join(path.dirname(config.fichierBase), 'secteurs.json');
  let secteurs = [], etats = {}, evenements = [];
  try { const d = lireJson(fichier); secteurs = d.secteurs || []; etats = d.etats || {}; evenements = d.journal || []; } catch { /* aucun */ }
  const demarre = maintenant();

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
  // Intervalle de suivi (ms) qui s'applique à un secteur : celui de son équipe
  const intervalleSuivi = (s) => { try { return (Number(s.equipe ? suiviMinDe(s.equipe) : 0) || 0) * 60000; } catch { return 0; } };
  // Silence à partir duquel une seule position « dehors » devient une sortie probable
  const seuilProbable = (s) => Math.max(600000, intervalleSuivi(s));
  // Âge au-delà duquel une mesure GPS est périmée
  const seuilPerimee = (s) => Math.max(900000, 2 * intervalleSuivi(s));

  function noter(s, k, type, champs = {}) {
    const e = { id: crypto.randomBytes(5).toString('hex'), heure: maintenant(), secteur: s ? s.id : null, nomSecteur: s ? s.nom : null, noeud: k || null, nom: k ? nomNoeud(k) : null, type, ...champs };
    evenements.push(e);
    if (evenements.length > JOURNAL_MAX) evenements.splice(0, evenements.length - JOURNAL_MAX);
    return e;
  }
  function message(e) {
    const S = e.nomSecteur, n = e.nom;
    switch (e.type) {
      case 'sortie': return e.probable ? `Secteur ${S} : sortie probable de ${n} (une position hors secteur, plus de nouvelles depuis ${e.minutes} min)` : e.initial ? `Secteur ${S} : ${n} est hors du secteur (${fmtDist(e.distance)} au-delà de la limite)` : `Secteur ${S} : ${n} est sorti du secteur (${fmtDist(e.distance)} au-delà de la limite)`;
      case 'entree': return e.initial ? `Secteur ${S} : ${n} est dans le secteur` : `Secteur ${S} : ${n} est entré dans le secteur`;
      case 'silence': return `Secteur ${S} : ${n} sans nouvelle position depuis ${e.minutes} min`;
      case 'contact': return `Secteur ${S} : contact retrouvé avec ${n}`;
      case 'imprecise': return `Secteur ${S} : ${n} non surveillable précisément : position floutée (± ${fmtDist(e.precision)})`;
      case 'perimee': return `Secteur ${S} : position de ${n} périmée (mesure GPS d’il y a ${e.minutes} min), non comptée`;
      case 'flux': return `Plus aucun paquet reçu depuis ${e.minutes} min : flux interrompu, surveillance des secteurs suspendue`;
      case 'flux-retour': return 'Flux de paquets revenu : surveillance des secteurs reprise';
      case 'creation': return `Secteur ${S} créé par ${e.auteur}`;
      case 'modification': return `Secteur ${S} modifié par ${e.auteur}`;
      case 'suppression': return `Secteur ${S} supprimé par ${e.auteur}`;
      case 'desactivation': return `Secteur ${S} désactivé : son équipe a été supprimée`;
      default: return `Secteur ${S} : ${e.type}`;
    }
  }
  // ---- Envoi LoRa facultatif : file bornée, un message toutes les 30 s, 20 par heure, regroupés quand c'est possible
  let dernierLora = 0, minutLora = null;
  const fileLora = [], envoisLora = []; // envoisLora : heures des envois de la dernière heure
  function lora(s, e) {
    if (s.canalLora == null || !envoyerLora || !e.notifier) return;
    if (fileLora.length >= LORA_FILE_MAX) { e.lora = 'abandonné : file d’envoi pleine'; return; }
    fileLora.push({ s, e });
    e.lora = 'en attente';
    viderLora();
  }
  const texteLora = (s, l) => {
    const noms = [...new Set(l.map((x) => x.e.nom))].join(', '), e = l[0].e;
    return e.type === 'sortie' ? `⛔ ${noms} hors secteur ${s.nom}` : e.type === 'entree' ? `⚠ ${noms} entré secteur ${s.nom}` : e.type === 'silence' ? `⚠ ${noms} sans position ${e.minutes} min (${s.nom})` : `⚠ ${noms} ${s.nom}`;
  };
  function viderLora() {
    clearTimeout(minutLora); minutLora = null;
    if (!fileLora.length) return;
    const t = maintenant();
    while (envoisLora.length && t - envoisLora[0] > 3600000) envoisLora.shift();
    const attente = Math.max(LORA_ESPACEMENT_MS - (t - dernierLora), envoisLora.length >= LORA_PAR_HEURE ? envoisLora[0] + 3600000 - t : 0);
    if (attente > 0) {
      for (const x of fileLora) x.e.lora = envoisLora.length >= LORA_PAR_HEURE ? 'différé : 20 messages par heure au plus' : 'différé';
      minutLora = setTimeout(viderLora, attente + 50); if (minutLora.unref) minutLora.unref();
      return;
    }
    // Un envoi : le premier de la file et ceux du même secteur et du même genre (« A, B hors secteur X »)
    const tete = fileLora[0];
    const groupe = fileLora.filter((x) => x.s === tete.s && x.e.type === tete.e.type);
    for (const x of groupe) fileLora.splice(fileLora.indexOf(x), 1);
    try {
      envoyerLora(couperOctets(texteLora(tete.s, groupe), LORA_OCTETS_MAX), tete.s.canalLora);
      dernierLora = t; envoisLora.push(t);
      for (const x of groupe) x.e.lora = groupe.length > 1 ? 'envoyé (groupé)' : 'envoyé';
    } catch (x) {
      // Échec (module coupé…) : abandonné pour ce groupe, la file continue sans bloquer le compteur
      for (const y of groupe) y.e.lora = 'échec : ' + x.message;
    }
    if (fileLora.length) { minutLora = setTimeout(viderLora, LORA_ESPACEMENT_MS + 50); if (minutLora.unref) minutLora.unref(); }
  }
  function publier(s, e) {
    e.message = message(e);
    if (s) lora(s, e);
    // Critique seulement pour un passage qui déclenche l'alerte du secteur (pas pour « dans le secteur » au départ)
    const niveau = (e.type === 'sortie' || e.type === 'entree') && e.alerte ? 'critique' : ['silence', 'imprecise', 'perimee', 'flux'].includes(e.type) ? 'attention' : 'info';
    diffuser({ genre: 'secteur-alerte', niveau, ...e });
    if (e.notifier) journal(`[Secteurs] ${e.message}`);
    try { surEvenement({ ...e, niveau }); } catch (x) { journal('[Secteurs]', x.message); }
  }
  // Au premier signe de sortie, position fraîche demandée tout de suite (une fois par 10 min par nœud)
  const demandes = new Map();
  function demanderVite(k) {
    if (!demanderPosition || !k.startsWith('mt:')) return;
    const t = maintenant(), num = Number(k.slice(3)) >>> 0;
    if (t - (demandes.get(num) || 0) < 600000) return;
    demandes.set(num, t);
    try { demanderPosition(num, 'secteur'); } catch { /* module coupé : la confirmation attendra la prochaine position */ }
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
  // Un comptage « peut-être dehors / dedans » trop vieux est oublié (sauf s'il devient une sortie probable avant)
  function expirerCandidat(s, st, t) {
    if (!(st.candidat && st.candidatDepuis && t - st.candidatDepuis > Math.max(CANDIDAT_EXPIRE_MS, 2 * seuilProbable(s)))) return false;
    st.candidat = null; st.nb = 0; delete st.candidatDepuis;
    return true;
  }

  // Position reçue d'un nœud. cle = 'mt:NUM' ou 'mc:CLÉ' ;
  // p = { lat, lon, precision (bits), heure (réception), heureFix (mesure GPS annoncée), id (paquet) }
  function position(cle, p) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return [];
    if (Math.abs(p.lat) < 1e-4 && Math.abs(p.lon) < 1e-4) return []; // « 0, 0 » : pas de position GPS
    const concernes = secteurs.filter((s) => s.actif && membres(s).includes(cle));
    if (!concernes.length) return [];
    // Sans identifiant de paquet (annonces MeshCore sans horodatage) : la même position répétée ne compte qu'une fois
    if (dejaVu(p.id != null ? cle + ':' + p.id : cle + '@' + p.lat.toFixed(5) + ',' + p.lon.toFixed(5))) return [];
    const t = Math.min(p.heure || maintenant(), maintenant()); // jamais dans le futur (horloge d'un observateur)
    const inc = incertitude(p.precision, p.lat);
    const sortie = [];
    for (const s of concernes) {
      const st = etatDe(s, cle);
      if (st.derniere && st.derniere.heure && t < st.derniere.heure) continue; // horodatage plus vieux que la dernière position : paquet en retard
      const pos = { lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 };
      if (st.silence) { const e = noter(s, cle, 'contact', { ...pos, notifier: false }); delete st.silence; publier(s, e); sortie.push(e); }
      // Mesure GPS périmée : le nœud répète un vieux fix (GPS perdu). Un fix qui avance malgré une horloge fausse est gardé.
      const fixPrecedent = st.derniere ? st.derniere.fix : null;
      if (p.heureFix && t - p.heureFix > seuilPerimee(s) && (fixPrecedent == null || p.heureFix <= fixPrecedent)) {
        if (!st.perimee) { const e = noter(s, cle, 'perimee', { ...pos, minutes: Math.round((t - p.heureFix) / 60000), notifier: false }); publier(s, e); sortie.push(e); }
        st.perimee = t; st.derniere = { ...pos, heure: t, fix: p.heureFix, precision: Math.round(inc), d: st.derniere ? st.derniere.d : null, perimee: true };
        continue;
      }
      delete st.perimee;
      expirerCandidat(s, st, t);
      const d = distanceLimite(s, p);
      st.derniere = { ...pos, heure: t, fix: p.heureFix || null, precision: Math.round(inc), d: Math.round(d) };
      const classe = classer(s, d, inc);
      // Position floutée trop large pour trancher : surveillée quand même, mais signalée (alerte « attention »)
      if (classe === 'bordure' && inc && inc > tailleSecteur(s) / 2) {
        if (!st.imprecise) { const e = noter(s, cle, 'imprecise', { ...pos, precision: Math.round(inc), notifier: false }); publier(s, e); sortie.push(e); }
        st.imprecise = t;
      } else delete st.imprecise;
      const evt = etape(s, st, classe, t);
      if (!evt && st.candidat === 'dehors' && st.nb === 1 && alertant(s, 'dehors')) demanderVite(cle);
      if (evt) {
        const e = noter(s, cle, evt.type, { heure: t, ...pos, distance: Math.round(d), precision: Math.round(inc), initial: evt.initial, alerte: evt.alerte, notifier: evt.notifier });
        if (evt.alerte && !evt.notifier) e.detail = 'alerte non répétée (délai minimal entre deux alertes)';
        publier(s, e); sortie.push(e);
      }
    }
    sauver();
    return sortie;
  }

  // Flux de paquets : la carte reçoit-elle encore quelque chose (MQTT, module radio, agents) ?
  let fluxCoupe = null;
  function fluxActif(t) {
    if (!derniereReception) return true;
    let der = 0;
    try { der = Number(derniereReception()) || 0; } catch { der = 0; }
    const coupe = t - Math.max(der, demarre) >= FLUX_COUPE_MIN * 60000;
    if (coupe && !fluxCoupe) {
      fluxCoupe = t;
      publier(null, noter(null, null, 'flux', { heure: t, minutes: Math.round((t - Math.max(der, demarre)) / 60000), notifier: true }));
    } else if (!coupe && fluxCoupe) {
      fluxCoupe = null;
      publier(null, noter(null, null, 'flux-retour', { heure: t, notifier: true }));
    }
    return !coupe;
  }

  // Vérification périodique : sorties probables, pertes de contact, comptages expirés
  function verifierSilences() {
    const t = maintenant();
    let change = false;
    // Flux de paquets vérifié seulement quand un secteur est actif (une carte sans secteur n'a rien à signaler)
    const flux = secteurs.some((s) => s.actif) ? fluxActif(t) : (fluxCoupe = null, true);
    for (const s of secteurs) {
      if (!s.actif) continue;
      for (const k of membres(s)) {
        const st = etatDe(s, k);
        let der = Math.max(st.derniere ? st.derniere.heure : 0, s.modifie || s.cree || 0);
        if (k.startsWith('mt:')) { try { const p = positionDe(Number(k.slice(3))); if (p && p.heure) der = Math.max(der, p.heure); } catch { /* base indisponible */ } }
        // Une position hors secteur puis plus rien : sortie probable, sans attendre une confirmation qui ne viendra peut-être pas
        if (flux && st.candidat === 'dehors' && st.etat !== 'dehors' && st.derniere && t - der >= seuilProbable(s)) {
          const evt = changerEtat(s, st, 'dehors', t, true);
          const e = noter(s, k, 'sortie', { heure: t, lat: st.derniere.lat, lon: st.derniere.lon, distance: st.derniere.d, precision: st.derniere.precision, minutes: Math.round((t - der) / 60000), probable: true, initial: evt.initial, alerte: evt.alerte, notifier: evt.notifier });
          if (evt.alerte && !evt.notifier) e.detail = 'alerte non répétée (délai minimal entre deux alertes)';
          publier(s, e); change = true;
          continue;
        }
        if (expirerCandidat(s, st, t)) change = true;
        if (!s.silenceMin || st.silence) continue;
        if (!flux) continue; // la carte ne reçoit plus rien : ce n'est pas l'intervenant qui se tait
        if (t - demarre < s.silenceMin * 60000) continue; // délai de grâce après le démarrage de la carte
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
      return { cle: k, nom: nomNoeud(k), etat: st.etat, probable: st.probable || null, depuis: st.depuis || null, derniere: st.derniere || null, silence: st.silence || null, imprecise: st.imprecise || null, perimee: st.perimee || null, candidat: st.candidat || null };
    });
    const { id, nom, forme, centre, rayon, points, equipe, noeuds, noeudsMc, sens, marge, confirmations, delaiMin, silenceMin, canalLora, actif, cree, auteur, modifie } = s;
    return { id, nom, forme, centre, rayon, points, equipe, nomEquipe: equipe ? nomEquipe(equipe) : null, noeuds, noeudsMc, sens, marge, confirmations, delaiMin, silenceMin, canalLora, actif, cree, auteur, modifie: modifie || null,
      taille: Math.round(tailleSecteur(s)), suiviMin: intervalleSuivi(s) / 60000, membres: l, dehors: l.filter((m) => m.etat === 'dehors').length, dedans: l.filter((m) => m.etat === 'dedans').length };
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
    // Réglages changés : les comptages en cours repartent de zéro ; forme changée : l'état connu ne vaut plus rien
    for (const k of Object.keys(etats)) {
      if (!k.startsWith(s.id + '|')) continue;
      const st = etats[k];
      st.candidat = null; st.nb = 0; delete st.candidatDepuis;
      if (geo) { st.etat = 'inconnu'; st.depuis = null; delete st.imprecise; delete st.probable; if (st.derniere) st.derniere.d = null; }
    }
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
  // Équipe supprimée : ses secteurs qui ne suivent qu'elle sont désactivés (jamais supprimés : le journal reste)
  function equipeSupprimee(idEquipe) {
    let nb = 0;
    for (const s of secteurs) {
      if (s.equipe !== idEquipe) continue;
      s.equipe = null; s.equipeSupprimee = true;
      if (!s.noeuds.length && !s.noeudsMc.length && s.actif) { s.actif = false; nb++; publier(null, noter(s, null, 'desactivation', { notifier: true })); }
    }
    if (nb) { sauver(true); diffuser({ genre: 'secteurs' }); }
    return nb;
  }

  // Alertes actives : membre hors du secteur (ou dedans pour un secteur « entrée »), perte de contact, position floue, flux coupé
  function alertes() {
    const l = [];
    if (fluxCoupe) l.push({ type: 'secteur', cle: `secteur:flux:${fluxCoupe}`, niveau: 'attention', depuis: fluxCoupe, message: 'Flux de paquets interrompu : surveillance des secteurs (pertes de contact) suspendue' });
    for (const s of secteurs) {
      if (!s.actif) continue;
      for (const k of membres(s)) {
        const st = etats[s.id + '|' + k];
        if (!st) continue;
        const num = k.startsWith('mt:') ? Number(k.slice(3)) : null;
        const base = { type: 'secteur', noeud: num, noeudMc: num == null ? k.slice(3) : null, secteur: s.id };
        if (st.etat === 'dehors' && s.sens !== 'entree') l.push({ ...base, cle: `secteur:${s.id}:${k}:dehors:${st.depuis}`, niveau: 'critique', depuis: st.depuis, message: st.probable ? `Secteur ${s.nom} : sortie probable de ${nomNoeud(k)} (une position hors secteur, plus de nouvelles depuis ${Math.round((maintenant() - (st.derniere ? st.derniere.heure : st.depuis)) / 60000)} min)` : `Secteur ${s.nom} : ${nomNoeud(k)} hors du secteur${st.derniere && st.derniere.d != null ? ` (${fmtDist(st.derniere.d)} au-delà de la limite)` : ''}` });
        if (st.etat === 'dedans' && s.sens === 'entree') l.push({ ...base, cle: `secteur:${s.id}:${k}:dedans:${st.depuis}`, niveau: 'critique', depuis: st.depuis, message: `Secteur ${s.nom} : ${nomNoeud(k)} est dans le secteur` });
        if (st.silence) l.push({ ...base, cle: `secteur:${s.id}:${k}:silence:${st.silence}`, niveau: 'attention', depuis: st.silence, message: `Secteur ${s.nom} : ${nomNoeud(k)} sans nouvelle position depuis ${Math.round((maintenant() - Math.max(st.derniere ? st.derniere.heure : 0, s.modifie || s.cree || 0)) / 60000)} min` });
        if (st.imprecise) l.push({ ...base, cle: `secteur:${s.id}:${k}:imprecise`, niveau: 'attention', depuis: st.imprecise, message: `Secteur ${s.nom} : ${nomNoeud(k)} non surveillable précisément : position floutée (± ${fmtDist(st.derniere ? st.derniere.precision : 0)})` });
        if (st.perimee) l.push({ ...base, cle: `secteur:${s.id}:${k}:perimee`, niveau: 'attention', depuis: st.perimee, message: `Secteur ${s.nom} : position de ${nomNoeud(k)} périmée (le nœud répète une vieille mesure GPS)` });
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
    const l = lireJournal({ secteur, depuis, limite: JOURNAL_MAX }).reverse();
    const heureLocale = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' });
    return ['heure_utc;heure_locale;secteur;type;noeud;nom;lat;lon;distance_m;precision_m;notifie;message',
      ...l.map((e) => [new Date(e.heure).toISOString(), heureLocale(e.heure), e.nomSecteur, e.type, e.noeud ? e.noeud.replace(/^mt:(\d+)$/, (_, n) => '!' + (Number(n) >>> 0).toString(16).padStart(8, '0')).replace(/^mc:/, '') : '', e.nom, e.lat, e.lon, e.distance, e.precision, e.notifier ? 'oui' : 'non', e.message || message(e)].map(celluleCsv).join(';'))].join('\n');
  }
  // Résumé pour la fiche d'une équipe
  const resumeEquipe = (idEquipe) => secteurs.filter((s) => s.equipe === idEquipe).map((s) => { const v = vue(s); return { id: v.id, nom: v.nom, forme: v.forme, actif: v.actif, dehors: v.dehors, sens: v.sens }; });
  // Nœud renuméroté (firmware 2.8) : il garde ses secteurs et son état sous son nouveau numéro
  function renumeroter(ancien, nouveau) {
    const a = ancien >>> 0, n = nouveau >>> 0;
    if (a === n) return 0;
    let nb = 0;
    for (const s of secteurs) { const i = (s.noeuds || []).indexOf(a); if (i >= 0 && !s.noeuds.includes(n)) { s.noeuds[i] = n; nb++; } }
    for (const k of Object.keys(etats)) {
      if (!k.endsWith('|mt:' + a)) continue;
      const nk = k.replace(/\|mt:\d+$/, '|mt:' + n);
      // Le nouveau numéro a déjà un état plus récent : on le garde, l'ancien est seulement retiré
      const ex = etats[nk];
      if (!ex || (ex.etat === 'inconnu' && !ex.derniere) || ((etats[k].derniere || {}).heure || 0) > ((ex.derniere || {}).heure || 0)) etats[nk] = etats[k];
      delete etats[k]; nb++;
    }
    if (nb) sauver(true);
    return nb;
  }
  return {
    liste: () => secteurs.map(vue), secteur: (id) => vue(exiger(id)), creer, modifier, supprimer, zoneEquipe, equipeSupprimee,
    position, verifierSilences, viderLora, alertes, journal: lireJournal, csv, resumeEquipe, renumeroter,
    fluxCoupe: () => fluxCoupe,
    arreter: () => { clearInterval(minutSilence); clearTimeout(minuterie); clearTimeout(minutLora); sauver(true); },
  };
}

module.exports = { creerSecteurs, distance, distanceLimite, pointDansPolygone, surfacePolygone, polygoneCroise, tailleSecteur, incertitude, classer, etape, valider, couperOctets, celluleCsv };
