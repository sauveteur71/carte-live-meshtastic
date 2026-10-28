'use strict';
// Nouveaux nœuds du secteur : apparus depuis N jours, avec un diagnostic automatique de ce qui manque
// (fiche, position, remontée MQTT, seulement vu comme relais ou comme voisin…).
// « Du secteur » : position dans la zone, ou sans position mais entendu par une passerelle de la zone,
// ou voisin déclaré d'un nœud de la zone.

function creerNouveaux(stockage, config, reseau) {
  const db = stockage.db;
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_receptions_relais_num ON receptions(relais_num)'); } catch { /* ancienne base */ }
  const q = {
    nouveaux: db.prepare('SELECT * FROM noeuds WHERE premier_vu >= ? ORDER BY premier_vu DESC LIMIT 400'),
    paquets: db.prepare('SELECT port, COUNT(*) AS nb, MAX(heure) AS dernier FROM paquets WHERE de = ? GROUP BY port'),
    receptions: db.prepare(`SELECT r.passerelle, COUNT(*) AS nb, MIN(r.sauts) AS sautsMin, MAX(r.snr) AS snr, MAX(r.heure) AS dernier
      FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = ? GROUP BY r.passerelle`),
    commeRelais: db.prepare('SELECT COUNT(*) AS nb, MAX(heure) AS dernier FROM receptions WHERE relais_num = ? AND heure >= ?'),
    liens: db.prepare('SELECT a, b, source, snr, nb, dernier_vu FROM liens WHERE a = ? OR b = ?'),
  };
  const z = () => config.zone;
  const dansZone = (n) => { const zz = z(); return !zz || (n && n.lat != null && n.lat >= zz[0] && n.lat <= zz[2] && n.lon >= zz[1] && n.lon <= zz[3]); };
  const nomDe = (num) => { const n = stockage.q.noeud.get(num >>> 0); return n ? n.nom_long || n.nom_court || '!' + (num >>> 0).toString(16).padStart(8, '0') : '!' + (num >>> 0).toString(16).padStart(8, '0'); };

  function lister(jours = 7) {
    const depuis = Date.now() - Math.min(Math.max(jours, 1), 60) * 86400000;
    const sortie = [];
    for (const n of q.nouveaux.all(depuis)) {
      const ports = q.paquets.all(n.num);
      const recs = q.receptions.all(n.num);
      const liens = q.liens.all(n.num, n.num);
      let rel = { nb: 0, dernier: null };
      try { rel = q.commeRelais.get(n.num, depuis); } catch { /* colonne absente (ancienne base) */ }
      const gw = recs.map((r) => ({ ...r, nom: nomDe(r.passerelle), noeud: stockage.q.noeud.get(r.passerelle >>> 0) }));
      const voisinsZone = liens.filter((l) => dansZone(stockage.q.noeud.get((l.a === n.num ? l.b : l.a) >>> 0)));
      // Sans position : entendu en direct (ou par un seul relais) par une passerelle de la zone, ou voisin déclaré d'un nœud de la zone
      // (les nœuds lointains reçus par MQTT ou après plusieurs relais ne sont pas « du secteur »)
      const secteur = n.lat != null ? dansZone(n) : gw.some((g) => dansZone(g.noeud) && g.sautsMin <= 1) || voisinsZone.some((l) => l.source !== 'traceroute');
      if (!secteur) continue;
      const nbPaquets = ports.reduce((t, p) => t + p.nb, 0);
      const diag = [];
      if (!nbPaquets && rel.nb) diag.push({ niveau: 'attention', texte: `ne remonte jamais ses propres paquets, mais a relayé ${rel.nb} paquet(s) : il fonctionne en radio. Cochez « OK to MQTT » (Autoriser l’envoi vers MQTT) dans sa configuration LoRa.` });
      else if (!nbPaquets && liens.length) diag.push({ niveau: 'attention', texte: 'connu seulement comme voisin d’autres nœuds (voisinage, traceroute) : ses paquets n’arrivent à aucune passerelle. « OK to MQTT » décoché ? trop loin des passerelles ?' });
      if (!n.nom_long && !n.nom_court) diag.push({ niveau: 'info', texte: 'pas encore de fiche (nom, matériel) : elle arrive avec son « Infos nœud » (toutes les 3 h par défaut) ou après un redémarrage.' });
      if (n.lat == null) diag.push({ niveau: 'info', texte: 'pas de position : sans GPS, donnez-lui une position fixe (Programmer › Position fixe) pour qu’il apparaisse sur la carte.' });
      if (nbPaquets && gw.length && gw.every((g) => g.sautsMin > 0)) diag.push({ niveau: 'info', texte: `aucune passerelle ne l’entend en direct : il passe par ${Math.min(...gw.map((g) => g.sautsMin))} relais au moins.` });
      if (['ROUTER', 'ROUTER_LATE', 'REPEATER'].includes(n.role) && n.lat == null) diag.push({ niveau: 'attention', texte: 'relais sans position : impossible de calculer sa couverture.' });
      sortie.push({
        num: n.num, id: '!' + (n.num >>> 0).toString(16).padStart(8, '0'), nom: n.nom_long || n.nom_court || null, role: n.role, materiel: n.materiel, firmware: n.firmware,
        lat: n.lat, lon: n.lon, premierVu: n.premier_vu, dernierVu: n.dernier_vu, nbPaquets, ports: ports.map((p) => p.port),
        passerelles: gw.sort((a, b) => a.sautsMin - b.sautsMin || (b.snr ?? -99) - (a.snr ?? -99)).slice(0, 6).map(({ noeud, ...g }) => g),
        relaye: nbPaquets ? 0 : rel.nb, voisins: liens.slice(0, 6).map((l) => ({ nom: nomDe(l.a === n.num ? l.b : l.a), source: l.source, snr: l.snr })),
        diagnostic: diag,
      });
    }
    return { jours, noeuds: sortie };
  }

  return { lister };
}

module.exports = { creerNouveaux };
