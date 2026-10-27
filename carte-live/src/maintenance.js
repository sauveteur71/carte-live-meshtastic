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
  function roles(couverture, sommets) {
    const conseils = [];
    const tous = stockage.q.noeuds.all().filter((n) => dansZone(n) && (n.dernier_vu || 0) > Date.now() - 3 * 86400000);
    const routeurs = tous.filter((n) => ['ROUTER', 'ROUTER_LATE', 'REPEATER', 'ROUTER_CLIENT'].includes(n.role));
    const apport = new Map(((couverture && couverture.noeuds) || []).map((x) => [x.num, x]));
    for (const n of tous) {
      if (n.role === 'ROUTER_CLIENT') conseils.push({ num: n.num, nom: nom(n), role: n.role, conseil: 'ROUTER ou CLIENT', niveau: 'attention', raison: 'Rôle ROUTER_CLIENT obsolète depuis le firmware 2.3 : il se comporte comme un client qui relaie tout et charge le canal.' });
    }
    for (const n of routeurs) {
      const a = apport.get(n.num);
      const proches = routeurs.filter((m) => m !== n && m.lat != null && n.lat != null && distKm(m, n) < 6);
      if (a && a.propreKm2 <= 5 && proches.length && n.role !== 'ROUTER_LATE') {
        conseils.push({ num: n.num, nom: nom(n), role: n.role, conseil: 'ROUTER_LATE', niveau: 'info', raison: `Couvre seulement ${a.propreKm2} km² que les autres relais ne couvrent pas, avec ${proches.length} autre(s) relais à moins de 6 km (${proches.slice(0, 3).map(nom).join(', ')}). En ROUTER_LATE, il ne relaie qu’en dernier recours : moins de collisions, même filet de sécurité.` });
      } else if (a && a.km2 < 60 && n.role === 'ROUTER') {
        conseils.push({ num: n.num, nom: nom(n), role: n.role, conseil: 'CLIENT ou déplacer', niveau: 'info', raison: `Point bas : couverture calculée ${a.km2} km² seulement. Un ROUTER mal placé relaie beaucoup pour peu de portée ; un site plus haut ou le rôle CLIENT serait plus utile.` });
      }
      const amas = routeurs.filter((m) => m.lat != null && n.lat != null && distKm(m, n) < 10);
      if (amas.length >= 4 && !conseils.some((c) => c.type === 'amas' && amas.some((m) => m.num === c.num))) {
        conseils.push({ type: 'amas', num: n.num, nom: nom(n), role: n.role, conseil: 'réduire', niveau: 'attention', raison: `${amas.length} relais dans un rayon de 10 km (${amas.map(nom).slice(0, 5).join(', ')}) : trop de ROUTER au même endroit multiplient les retransmissions. Gardez les mieux placés en ROUTER, passez les autres en ROUTER_LATE ou CLIENT.` });
      }
    }
    // Clients bien placés : à moins de 300 m d'un des meilleurs points hauts
    const meilleurs = (sommets || []).filter((s) => s.rang && s.rang <= 30);
    for (const n of tous) {
      if (n.lat == null || !['CLIENT', 'CLIENT_BASE', null, undefined].includes(n.role)) continue;
      const s = meilleurs.find((x) => distKm(x, n) < 0.3);
      if (!s) continue;
      const fiche = installations.lire(n.num, true) || {};
      const alim = (n.batterie != null && n.batterie > 100) || ['secteur', 'secteur+batterie', 'solaire+batterie'].includes(fiche.alimentation);
      conseils.push({ num: n.num, nom: nom(n), role: n.role || 'CLIENT', conseil: 'ROUTER', niveau: 'info', raison: `Installé sur ${s.nom || 'un point haut'} (${s.alt} m, ${s.rang}ᵉ meilleur site du département)${alim ? ' et alimenté en continu' : ''} : il ferait un très bon relais.${alim ? '' : ' À condition d’avoir une alimentation fiable (secteur ou solaire).'}` });
    }
    const repartition = {};
    for (const n of tous) repartition[n.role || 'inconnu'] = (repartition[n.role || 'inconnu'] || 0) + 1;
    return { repartition, conseils };
  }

  return { chargeRadio, autonomie, firmwares, roles };
}

module.exports = { creerMaintenance };
