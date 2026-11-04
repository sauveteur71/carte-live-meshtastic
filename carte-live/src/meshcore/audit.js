'use strict';
// Audit des régions et des identifiants courts des répéteurs MeshCore.
//
// Régions : pour chaque répéteur, celles qu'il DÉCLARE (requête anonyme du companion, aux répéteurs entendus en
// direct) et celles qu'il RELAIE réellement (étiquette de région des paquets « inondation (zone) » dont le chemin
// passe par lui). Un écart signale un réglage à revoir : région déclarée jamais relayée, ou relayée sans être déclarée.
//
// Collisions : un chemin note chaque relais par les premiers octets de sa clé (1, 2 ou 3 octets selon path.hash.mode).
// Deux répéteurs voisins qui commencent par le même octet rendent les chemins à 1 octet ambigus.

const fs = require('fs');
const path = require('path');
const { decoderPaquet } = require('./paquet');

const RELAIS = new Set(['repeteur', 'salon']);

function creerAuditMc({ db, config, reseauMc, journal }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'meshcore-regions-declarees.json');
  let declarees = {};
  try { declarees = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch { /* aucun */ }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(declarees)); } catch { /* lecture seule */ } };
  const q = {
    paquets: db.prepare(`SELECT rowid, brut, chemin, route FROM mc_paquets WHERE heure >= ? AND route IN ('TRANSPORT_FLOOD', 'FLOOD') AND sauts > 0`),
    chemins: db.prepare('SELECT DISTINCT chemin FROM mc_receptions WHERE paquet = ? AND chemin IS NOT NULL'),
    noeuds: db.prepare("SELECT cle, nom, role, lat, lon, dernier_vu FROM mc_noeuds WHERE role IN ('repeteur', 'salon')"),
    tailles: db.prepare(`SELECT brut FROM mc_paquets WHERE heure >= ? AND sauts > 0 LIMIT 20000`),
  };
  const dansBbox = (n, b) => !b || (n && n.lat != null && n.lat >= b[0] && n.lat <= b[2] && n.lon >= b[1] && n.lon <= b[3]);
  let cache = null; // { cle, heure, val }

  function noterDeclarees(cle, r) {
    declarees[cle] = { heure: Date.now(), regions: r.regions, joker: r.joker };
    sauver();
    cache = null;
  }

  // Régions relayées : pour chaque paquet en inondation, on résout les relais de chaque chemin entendu
  function relayees(jours) {
    const depuis = Date.now() - jours * 86400000;
    const par = new Map(); // cle -> Map(region -> nb)
    const parRegion = new Map();
    let total = 0, zone = 0;
    for (const p of q.paquets.all(depuis)) {
      let region = '-';
      if (p.route === 'TRANSPORT_FLOOD') {
        const d = decoderPaquet(p.brut);
        if (!d.valide) continue;
        region = d.region || '?';
        zone++;
      }
      total++;
      parRegion.set(region, (parRegion.get(region) || 0) + 1);
      const vus = new Set();
      const chemins = [p.chemin, ...q.chemins.all(p.rowid).map((r) => r.chemin)];
      for (const c of chemins) {
        let l; try { l = JSON.parse(c || '[]'); } catch { continue; }
        if (!l.length) continue;
        for (const n of reseauMc.resoudreChemin(l, null, null)) {
          if (!n || vus.has(n.cle)) continue;
          vus.add(n.cle);
          if (!par.has(n.cle)) par.set(n.cle, new Map());
          const m = par.get(n.cle); m.set(region, (m.get(region) || 0) + 1);
        }
      }
    }
    return { par, parRegion, total, zone };
  }

  function auditRegions({ jours = 2, bbox = null } = {}) {
    const cle = `${jours}|${bbox ? bbox.join(',') : ''}`;
    if (cache && cache.cle === cle && Date.now() - cache.heure < 10 * 60000) return cache.val;
    const debut = Date.now();
    const { par, parRegion, total, zone } = relayees(jours);
    const repeteurs = [];
    for (const n of q.noeuds.all()) {
      if (!dansBbox(n, bbox)) continue;
      const vu = par.get(n.cle), dec = declarees[n.cle];
      if (!vu && !dec) continue;
      const relaie = vu ? Object.fromEntries([...vu.entries()].sort((a, b) => b[1] - a[1])) : {};
      const nomsRelayes = Object.keys(relaie).filter((r) => r !== '-' && r !== '?');
      // Un répéteur relaie une région déclarée, ou une région fille (fr-43 sous fr) : on compare les noms exacts
      const nonVues = dec ? dec.regions.filter((r) => !relaie[r]) : [];
      const nonDeclarees = dec ? nomsRelayes.filter((r) => !dec.regions.includes(r)) : [];
      const sansRegion = relaie['-'] || 0;
      const alertes = [];
      if (dec && nonVues.length && nomsRelayes.length) alertes.push(`déclare ${nonVues.join(', ')} sans l’avoir relayée`);
      if (dec && nonDeclarees.length) alertes.push(`relaie ${nonDeclarees.join(', ')} sans la déclarer`);
      if (dec && !dec.joker && sansRegion) alertes.push('relaie des messages sans région alors qu’il ne les accepte pas');
      repeteurs.push({ cle: n.cle, nom: n.nom || n.cle.slice(0, 8), role: n.role, dernierVu: n.dernier_vu, declare: dec || null, relaie, sansRegion, nonVues, nonDeclarees, alertes });
    }
    repeteurs.sort((a, b) => b.alertes.length - a.alertes.length || (b.declare ? 1 : 0) - (a.declare ? 1 : 0) || a.nom.localeCompare(b.nom));
    const val = { jours, total, zone, parRegion: Object.fromEntries([...parRegion.entries()].sort((a, b) => b[1] - a[1])), repeteurs, dureeMs: Date.now() - debut };
    cache = { cle, heure: Date.now(), val };
    return val;
  }

  // Collisions de préfixes entre répéteurs actifs (14 jours) de la zone, et part des chemins à 1 octet
  function collisions({ bbox = null, jours = 14 } = {}) {
    const depuis = Date.now() - jours * 86400000;
    const rep = q.noeuds.all().filter((n) => (n.dernier_vu || 0) >= depuis && dansBbox(n, bbox));
    const grouper = (octets) => {
      const g = new Map();
      for (const n of rep) { const k = n.cle.slice(0, octets * 2); if (!g.has(k)) g.set(k, []); g.get(k).push(n); }
      return [...g.entries()].filter(([, l]) => l.length > 1).map(([prefixe, l]) => {
        let dmin = null;
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
          if (l[i].lat == null || l[j].lat == null) continue;
          const d = Math.hypot((l[i].lat - l[j].lat) * 111.2, (l[i].lon - l[j].lon) * 111.2 * Math.cos((l[i].lat * Math.PI) / 180));
          if (dmin == null || d < dmin) dmin = d;
        }
        // Même lieu (< 200 m) : presque toujours le même répéteur, réenregistré sous une clé abîmée (annonce mal reçue)
        return { prefixe, doublon: dmin != null && dmin < 0.2, distanceMinKm: dmin == null ? null : Math.round(dmin * 10) / 10, noeuds: l.map((n) => ({ cle: n.cle, nom: n.nom || n.cle.slice(0, 8), role: n.role, dernierVu: n.dernier_vu })) };
      }).sort((a, b) => (a.doublon - b.doublon) || (a.distanceMinKm ?? 999) - (b.distanceMinKm ?? 999));
    };
    const tailles = { 1: 0, 2: 0, 3: 0 };
    for (const p of q.tailles.all(Date.now() - 2 * 86400000)) {
      const b = Buffer.from(p.brut, 'hex');
      const routeN = b[0] & 3, i = routeN === 0 || routeN === 3 ? 5 : 1;
      if (b.length > i) { const t = (b[i] >> 6) + 1; if (tailles[t] != null) tailles[t]++; }
    }
    const nb = tailles[1] + tailles[2] + tailles[3];
    return {
      repeteurs: rep.length, un: grouper(1), deux: grouper(2),
      chemins: { total: nb, parTaille: tailles, partUnOctetPct: nb ? Math.round((tailles[1] / nb) * 1000) / 10 : null },
    };
  }

  return { auditRegions, collisions, noterDeclarees, declarees: () => declarees, RELAIS };
}

module.exports = { creerAuditMc };
