'use strict';
// Maintenance du réseau : charge radio des relais, autonomie, firmwares, rôles.
// Porte sur les nœuds « surveillés » (relais, passerelles, liste NOEUDS_SURVEILLES) situés dans la zone de la carte.

const LIMITE_EMISSION = 10; // % du temps, sous-bande 869,4–869,65 MHz
const SEUIL_TENSION = 3.3;

function heureParis(t) { return Number(new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).slice(0, 2)); }
function regression(xs, ys) {
  const n = xs.length; if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return sxx > 0 ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx : 0;
}
const distKm = (a, b) => { const r = Math.PI / 180, s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(s)); };
// "2.7.26.54e0d8d" → [2, 7, 26]
const versionNum = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const comparer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

function creerMaintenance({ stockage, config, reseau, installations, journal }) {
  const db = stockage.db;
  const telem = db.prepare('SELECT heure, tension, batterie, canal, emission FROM telemetrie WHERE num = ? AND heure >= ? ORDER BY heure');
  const dansZone = (n) => { const z = config.zone; return n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]; };
  const nom = (n) => n.nom_long || n.nom_court || n.id;
  // Nœuds sans position : gardés seulement s'ils sont listés explicitement (NOEUDS_SURVEILLES), sinon on ne sait pas où ils sont
  const explicite = (n) => config.noeudsSurveilles.some((x) => x === n.id || x === n.nom_court || x === n.nom_long);
  const surveilles = () => stockage.q.noeuds.all().filter((n) => reseau.estSurveille(n) && (dansZone(n) || (n.lat == null && explicite(n))) && (n.dernier_vu || 0) > Date.now() - 7 * 86400000);

  // ---- 11. Charge radio des relais -------------------------------------------------------------
  function chargeRadio() {
    const maintenant = Date.now(), depuis = maintenant - 7 * 86400000;
    const lignes = [];
    for (const n of surveilles()) {
      const t = telem.all(n.num, depuis).filter((x) => x.canal != null || x.emission != null);
      if (!t.length) continue;
      const h24 = t.filter((x) => x.heure >= maintenant - 86400000);
      const moy = (l, k) => { const v = l.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
      const max = (l, k) => { const v = l.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.round(Math.max(...v) * 100) / 100 : null; };
      // Tendance : moyenne journalière de l'émission sur 7 jours
      const jours = new Map();
      for (const x of t) { if (x.emission == null) continue; const j = Math.floor(x.heure / 86400000); const v = jours.get(j) || []; v.push(x.emission); jours.set(j, v); }
      const js = [...jours.keys()].sort();
      const pente = js.length >= 3 ? regression(js, js.map((j) => jours.get(j).reduce((a, b) => a + b, 0) / jours.get(j).length)) : 0;
      const emis24 = moy(h24, 'emission');
      const joursAvantLimite = pente > 0.05 && emis24 != null && emis24 < LIMITE_EMISSION ? Math.round((LIMITE_EMISSION - emis24) / pente) : null;
      // Série horaire pour les petites courbes
      const parH = new Map();
      for (const x of t) { const h = Math.floor(x.heure / 3600000) * 3600000; const v = parH.get(h) || { heure: h, canal: [], emission: [] }; if (x.canal != null) v.canal.push(x.canal); if (x.emission != null) v.emission.push(x.emission); parH.set(h, v); }
      const serie = [...parH.values()].map((v) => ({ heure: v.heure, canal: v.canal.length ? Math.max(...v.canal) : null, emission: v.emission.length ? Math.max(...v.emission) : null }));
      lignes.push({
        num: n.num, nom: nom(n), role: n.role,
        canal: n.canal, emission: n.emission, canal24: moy(h24, 'canal'), canalMax24: max(h24, 'canal'), emission24: emis24, emissionMax24: max(h24, 'emission'),
        tendanceEmission: Math.round(pente * 100) / 100, joursAvantLimite,
        niveau: (n.emission ?? 0) >= LIMITE_EMISSION || (n.canal ?? 0) >= config.seuils.canalCritiquePourcent ? 'critique' : (emis24 ?? 0) >= config.seuils.emissionPourcent || (n.canal ?? 0) >= config.seuils.canalPourcent || (joursAvantLimite != null && joursAvantLimite <= 14) ? 'attention' : 'ok',
        serie,
      });
    }
    return lignes.sort((a, b) => (b.emission24 ?? -1) - (a.emission24 ?? -1));
  }

  // ---- 12. Autonomie des relais sur batterie ou solaire ------------------------------------------
  function autonomie() {
    const maintenant = Date.now(), depuis = maintenant - 7 * 86400000;
    const lignes = [];
    for (const n of surveilles()) {
      const fiche = installations.lire(n.num, true) || {};
      const t = telem.all(n.num, depuis).filter((x) => x.tension > 0);
      const secteur = (n.batterie != null && n.batterie > 100) || fiche.alimentation === 'secteur';
      if (!t.length) { if (fiche.alimentation) lignes.push({ num: n.num, nom: nom(n), alimentation: fiche.alimentation, etat: 'inconnu', message: 'pas de télémétrie de tension' }); continue; }
      const derniere = t[t.length - 1].tension;
      if (secteur) { lignes.push({ num: n.num, nom: nom(n), alimentation: fiche.alimentation || 'secteur', tension: derniere, etat: 'secteur', message: 'sur secteur' }); continue; }
      // Décharge nocturne : pente de la tension entre 21 h et 6 h (pas de soleil), en V par heure
      const nuits = new Map();
      for (const x of t) {
        const h = heureParis(x.heure);
        if (h >= 21 || h < 6) { const cle = Math.floor((x.heure + 3 * 3600000) / 86400000); const v = nuits.get(cle) || []; v.push(x); nuits.set(cle, v); }
      }
      const pentes = [...nuits.values()].filter((v) => v.length >= 3 && v[v.length - 1].heure - v[0].heure > 4 * 3600000)
        .map((v) => regression(v.map((x) => (x.heure - v[0].heure) / 3600000), v.map((x) => x.tension))).filter((p) => p < 0).sort((a, b) => a - b);
      const decharge = pentes.length ? -pentes[Math.floor(pentes.length / 2)] : null; // V/h
      // Recharge : écart max − min par jour
      const jours = new Map();
      for (const x of t) { const j = Math.floor((x.heure + 3600000) / 86400000); const v = jours.get(j) || { min: Infinity, max: -Infinity }; v.min = Math.min(v.min, x.tension); v.max = Math.max(v.max, x.tension); jours.set(j, v); }
      const js = [...jours.values()];
      const recharge = js.length ? Math.round((js.reduce((a, j) => a + (j.max - j.min), 0) / js.length) * 100) / 100 : null;
      const maxRecents = js.slice(-2).map((j) => j.max);
      const joursSansSoleil = decharge && decharge > 0.0003 && derniere > SEUIL_TENSION ? Math.round(((derniere - SEUIL_TENSION) / (decharge * 24)) * 10) / 10 : null;
      const pasDeCharge = js.length >= 2 && maxRecents.every((m) => m < config.seuils.chargeSolaireVolts);
      const etat = derniere < SEUIL_TENSION + 0.1 ? 'critique' : (joursSansSoleil != null && joursSansSoleil < 3) || pasDeCharge ? 'attention' : 'ok';
      lignes.push({
        num: n.num, nom: nom(n), alimentation: fiche.alimentation || (n.batterie != null ? 'batterie' : null), batterieAh: fiche.batterieAh, panneauW: fiche.panneauW,
        tension: Math.round(derniere * 100) / 100, batterie: n.batterie, dechargeVparJour: decharge ? Math.round(decharge * 24 * 1000) / 1000 : null, rechargeV: recharge,
        joursSansSoleil, pasDeCharge, etat,
        message: joursSansSoleil != null ? `tiendrait environ ${joursSansSoleil} jour${joursSansSoleil >= 2 ? 's' : ''} sans soleil` : 'décharge nocturne non mesurable',
      });
    }
    const ordre = { critique: 0, attention: 1, ok: 2, inconnu: 3, secteur: 4 };
    return lignes.sort((a, b) => ordre[a.etat] - ordre[b.etat] || (a.joursSansSoleil ?? 99) - (b.joursSansSoleil ?? 99));
  }

  // ---- 13. Firmwares --------------------------------------------------------------------------
  let derniereVersion = null, verifiee = 0;
  async function verifierVersionFirmware() {
    try {
      const r = await fetch('https://api.github.com/repos/meshtastic/firmware/releases?per_page=30', { headers: { 'User-Agent': 'carte-live', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const l = await r.json();
      const stables = l.filter((x) => !x.prerelease && !x.draft && versionNum(x.tag_name));
      const alphas = l.filter((x) => versionNum(x.tag_name));
      const pick = (arr) => arr.map((x) => ({ tag: x.tag_name, nom: x.name, date: x.published_at, url: x.html_url, v: versionNum(x.tag_name) })).sort((a, b) => comparer(b.v, a.v))[0] || null;
      derniereVersion = { stable: pick(stables), test: pick(alphas) };
      verifiee = Date.now();
    } catch (e) { journal('[Maintenance] version firmware :', e.message); }
  }
  setTimeout(verifierVersionFirmware, 30000).unref();
  setInterval(verifierVersionFirmware, 12 * 3600000).unref();

  function firmwares() {
    const ref = derniereVersion && derniereVersion.stable ? derniereVersion.stable.v : null;
    const lignes = surveilles().map((n) => {
      const v = versionNum(n.firmware);
      let etat = 'inconnu', retard = null;
      if (v && ref) {
        if (comparer(v, ref) >= 0) etat = 'a-jour';
        else { retard = v[0] < ref[0] ? 'majeure' : v[1] < ref[1] ? `${ref[1] - v[1]} version(s) mineure(s)` : `${ref[2] - v[2]} correctif(s)`; etat = v[0] < ref[0] || ref[1] - v[1] >= 2 ? 'ancien' : 'retard'; }
      } else if (v) etat = 'connu';
      return { num: n.num, nom: nom(n), materiel: n.materiel, firmware: n.firmware, version: v ? v.join('.') : null, etat, retard, role: n.role };
    });
    const parVersion = {};
    for (const l of lignes) parVersion[l.version || 'inconnue'] = (parVersion[l.version || 'inconnue'] || 0) + 1;
    const ordre = { ancien: 0, retard: 1, connu: 2, inconnu: 3, 'a-jour': 4 };
    return { reference: derniereVersion, verifiee, parVersion, noeuds: lignes.sort((a, b) => ordre[a.etat] - ordre[b.etat] || String(a.version).localeCompare(String(b.version))) };
  }

  // ---- 14. Contrôle des rôles ------------------------------------------------------------------
  // couverture : résultat de la couverture actuelle (apport propre de chaque relais) ; sommets : points hauts classés
  // Règles de Meshtastic (blog « Demystifying ROUTER_LATE », 2025) :
  //  ROUTER seulement sur un site haut et dégagé ; ROUTER_LATE seulement pour un site indispensable qui ne voit pas les
  //  routeurs (il réémet tout, coûteux) ; CLIENT_BASE pour un toit ; CLIENT par défaut. Changer de rôle si l'occupation
  //  du canal dépasse ~25 % ou l'émission du nœud ~7-8 %. REPEATER obsolète depuis 2.7.11.
  function roles(couverture, sommets) {
    const conseils = [];
    const maintenant = Date.now(), depuis3 = maintenant - 3 * 86400000;
    const tous = stockage.q.noeuds.all().filter((n) => dansZone(n) && (n.dernier_vu || 0) > depuis3);
    const parNum = new Map(tous.map((n) => [n.num >>> 0, n]));
    const INFRA = ['ROUTER', 'ROUTER_LATE', 'REPEATER', 'ROUTER_CLIENT'];
    const routeurs = tous.filter((n) => INFRA.includes(n.role));
    const apport = new Map(((couverture && couverture.noeuds) || []).map((x) => [x.num, x]));
    let charge = new Map();
    try { charge = new Map(chargeRadio().map((x) => [x.num, x])); } catch { /* pas de télémétrie */ }
    // Qui entend qui directement (3 jours, liaison exploitable)
    const entend = new Map();
    for (const l of stockage.q.liens.all(depuis3)) {
      if (l.snr != null && l.snr < -12) continue;
      const b = l.b >>> 0;
      if (!entend.has(b)) entend.set(b, new Map());
      const e = entend.get(b).get(l.a >>> 0);
      if (!e || (l.snr ?? -99) > (e ?? -99)) entend.get(b).set(l.a >>> 0, l.snr);
    }
    const routeursEntendus = (n) => [...((entend.get(n.num >>> 0) || new Map()).entries())].map(([num, snr]) => ({ n: parNum.get(num), snr })).filter((x) => x.n && x.n.role === 'ROUTER' && x.n.num !== n.num);
    const texteVus = (vus) => vus.slice(0, 3).map((x) => `${nom(x.n)}${x.snr != null ? ` (${x.snr.toFixed(1).replace('.', ',')} dB)` : ''}`).join(', ');
    const mobile = (n) => { const pos = stockage.q.positionsNoeud24h.all(n.num, maintenant - 86400000); return pos.length > 1 && Math.max(...pos.map((p) => distKm(pos[0], p))) > 1; };
    const surToit = (n) => /\b(toit|maison|domicile|chemin[ée]e|habitation|balcon|grenier|pignon|faîtage|faitage)\b/i.test((installations.lire(n.num, true) || {}).site || '');
    const ajouter = (n, roleCible, conseil, niveau, raison, extra = {}) => conseils.push({ num: n.num, nom: nom(n), role: n.role || 'CLIENT', conseil, roleCible, niveau, raison, ...extra });
    const meilleurs = (sommets || []).filter((x) => x.rang && x.rang <= 30);
    const siteHaut = (n) => n.lat != null && meilleurs.find((x) => distKm(x, n) < 0.3);

    for (const n of tous) {
      if (n.role === 'ROUTER_CLIENT') ajouter(n, 'CLIENT', 'ROUTER ou CLIENT', 'attention', 'Rôle ROUTER_CLIENT obsolète depuis le firmware 2.3 : il se comporte comme un client qui relaie tout et charge le canal.');
      if (n.role === 'REPEATER') ajouter(n, 'ROUTER', 'ROUTER', 'attention', 'Rôle REPEATER obsolète depuis le firmware 2.7.11 : il ne publie ni fiche ni télémétrie et crée des « trous » dans la chaîne de relais. Meshtastic conseille ROUTER (ou ROUTER_LATE).');
    }
    for (const n of routeurs.filter((x) => ['ROUTER', 'ROUTER_LATE'].includes(x.role))) {
      const a = apport.get(n.num), c = charge.get(n.num), vus = routeursEntendus(n);
      if (mobile(n)) { ajouter(n, 'CLIENT', 'CLIENT', 'attention', `Rôle ${n.role} sur un nœud qui se déplace (plus de 1 km en 24 h) : un relais mobile change sans cesse les chemins et use les sauts. CLIENT conseillé (ou CLIENT_BASE pour un relais de véhicule).`); continue; }
      if (surToit(n)) { ajouter(n, 'CLIENT_BASE', 'CLIENT_BASE', 'attention', `Installé sur un toit d’après sa fiche (« ${(installations.lire(n.num, true) || {}).site} ») : Meshtastic déconseille ROUTER et ROUTER_LATE sur une maison. CLIENT_BASE relaie en priorité pour vos nœuds favoris ; mettez aussi les routeurs voisins en favoris (sauts gratuits).`); continue; }
      const em = c ? c.emission24 : null, ca = c ? c.canal24 : null;
      if (n.role === 'ROUTER_LATE') {
        if ((em ?? 0) >= 7.5 || (ca ?? 0) >= 25) {
          ajouter(n, 'CLIENT', 'CLIENT', 'attention', `ROUTER_LATE réémet tout ce qu’il entend : ici émission ${em != null ? em.toFixed(1).replace('.', ',') + ' %' : '?'} et canal ${ca != null ? ca.toFixed(1).replace('.', ',') + ' %' : '?'} en moyenne sur 24 h. Au-delà de 7-8 % d’émission ou 25 % d’occupation, Meshtastic conseille de changer de rôle.`);
        } else if (vus.length && a && a.propreKm2 <= 5) {
          ajouter(n, 'CLIENT', 'CLIENT', 'info', `Entend directement ${vus.length > 1 ? 'les routeurs' : 'le routeur'} ${texteVus(vus)} et ne couvre que ${a.propreKm2} km² qu’aucun autre relais ne couvre : ses voisins atteignent déjà le réseau. En CLIENT, il ne réémet que si personne ne l’a fait (moins de temps d’antenne).`);
        } else if (!vus.length && a && a.propreKm2 >= 50 && siteHaut(n)) {
          const sh = siteHaut(n);
          ajouter(n, 'ROUTER', 'ROUTER', 'info', `Sur ${sh.nom || 'un point haut'} (${sh.alt} m, ${sh.rang}ᵉ site du département), il couvre seul ${a.propreKm2} km² et n’entend aucun ROUTER : c’est un site de ROUTER.`);
        }
      } else if (n.role === 'ROUTER') {
        if (a && a.propreKm2 <= 5 && vus.length) {
          ajouter(n, 'CLIENT', 'CLIENT', 'info', `Redondant : il ne couvre que ${a.propreKm2} km² qu’aucun autre relais ne couvre et entend directement ${texteVus(vus)}. Deux ROUTER qui se voient doublent les réémissions ; en CLIENT (ou CLIENT_BASE), il reste utile sans prendre la priorité.`);
        } else if (a && a.km2 < 60) {
          ajouter(n, 'CLIENT', 'CLIENT ou déplacer', 'info', `Point bas : couverture calculée ${a.km2} km² seulement. Un ROUTER mal placé prend la priorité sur de meilleurs relais et use les sauts trop tôt ; un site plus haut ou le rôle CLIENT serait plus utile.`);
        } else if ((em ?? 0) >= 7.5 || (ca ?? 0) >= 25) {
          ajouter(n, null, 'surveiller', 'attention', `Charge élevée : émission ${em != null ? em.toFixed(1).replace('.', ',') + ' %' : '?'}, canal ${ca != null ? ca.toFixed(1).replace('.', ',') + ' %' : '?'} sur 24 h. Vérifiez les nœuds bavards autour (onglet Statistiques) avant de toucher à ce relais bien placé.`);
        }
      }
    }
    // Trop de relais au même endroit
    const vusAmas = new Set();
    for (const n of routeurs) {
      if (vusAmas.has(n.num)) continue;
      const amas = routeurs.filter((m) => m.lat != null && n.lat != null && distKm(m, n) < 10);
      if (amas.length < 4) continue;
      amas.forEach((m) => vusAmas.add(m.num));
      conseils.push({ type: 'amas', num: n.num, nom: nom(n), role: n.role, conseil: 'réduire', roleCible: null, niveau: 'attention', raison: `${amas.length} relais dans un rayon de 10 km (${amas.map(nom).slice(0, 5).join(', ')}) : trop de relais au même endroit multiplient les retransmissions. Gardez le mieux placé en ROUTER, passez les autres en CLIENT (ROUTER_LATE seulement si un site ne voit aucun routeur).` });
    }
    // Clients : point haut → ROUTER ; toit → CLIENT_BASE
    for (const n of tous) {
      if (n.lat == null || !['CLIENT', null, undefined].includes(n.role) && n.role !== 'CLIENT_BASE') continue;
      const s = siteHaut(n);
      if (s) {
        const fiche = installations.lire(n.num, true) || {};
        const alim = (n.batterie != null && n.batterie > 100) || ['secteur', 'secteur+batterie', 'solaire+batterie'].includes(fiche.alimentation);
        ajouter(n, 'ROUTER', 'ROUTER', 'info', `Installé sur ${s.nom || 'un point haut'} (${s.alt} m, ${s.rang}ᵉ meilleur site du département)${alim ? ' et alimenté en continu' : ''} : il ferait un très bon relais.${alim ? '' : ' À condition d’avoir une alimentation fiable (secteur ou solaire).'}`);
      } else if (n.role !== 'CLIENT_BASE' && surToit(n) && !mobile(n)) {
        ajouter(n, 'CLIENT_BASE', 'CLIENT_BASE', 'info', `Module de toit d’après sa fiche : en CLIENT_BASE, il relaie en priorité pour vos nœuds favoris (portable, voiture) tout en restant discret pour le reste.`);
      }
    }
    const repartition = {};
    for (const n of tous) repartition[n.role || 'inconnu'] = (repartition[n.role || 'inconnu'] || 0) + 1;
    return { repartition, conseils };
  }

  // ---- 15. Préparation du firmware 2.8 ------------------------------------------------------------
  // 2.8 coupe par défaut la position (précision 0) et la télémétrie sur les canaux publics, et la 2.8.0 a été retirée.
  function v28() {
    const maintenant = Date.now();
    const lignes = [];
    let n27 = 0, n28 = 0;
    for (const n of surveilles()) {
      const v = versionNum(n.firmware);
      if (!v) continue;
      if (v[0] === 2 && v[1] < 8) { n27++; continue; }
      n28++;
      const pb = [];
      if (v[0] === 2 && v[1] === 8 && v[2] === 0) pb.push({ niveau: 'critique', texte: 'firmware 2.8.0 retiré par Meshtastic : ses signatures sont incompatibles avec la 2.8.1, passez-le en 2.8.1.' });
      const actif = maintenant - (n.dernier_vu || 0) < 24 * 3600000;
      if (actif && (!n.heure_position || maintenant - n.heure_position > 48 * 3600000)) pb.push({ niveau: 'attention', texte: `ne diffuse plus sa position${n.heure_position ? ' depuis ' + Math.round((maintenant - n.heure_position) / 86400000) + ' j' : ''} : en 2.8, la précision de position des canaux publics passe à 0. Rétablissez la précision du canal (ou une position fixe sur un canal privé) dans Programmer.` });
      if (actif && (!n.heure_telemetrie || maintenant - n.heure_telemetrie > 48 * 3600000)) pb.push({ niveau: 'attention', texte: 'n’envoie plus sa télémétrie : en 2.8, « Télémétrie de l’appareil » est désactivée par défaut. Réactivez-la dans Programmer › Modifier ses réglages.' });
      lignes.push({ num: n.num, nom: nom(n), firmware: n.firmware, role: n.role, problemes: pb });
    }
    return { n27, n28, noeuds: lignes.sort((a, b) => b.problemes.length - a.problemes.length) };
  }

  return { chargeRadio, autonomie, firmwares, roles, v28 };
}

module.exports = { creerMaintenance };
