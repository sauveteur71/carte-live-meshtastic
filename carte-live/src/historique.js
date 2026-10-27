'use strict';
// Historique long et léger : un résumé par heure et par jour (conservés plus d'un an),
// calculés à partir des données détaillées avant qu'elles ne soient purgées.
// + compactage hebdomadaire de la base quand beaucoup de place a été libérée par les purges.

const COLONNES = ['mt_noeuds_actifs', 'mt_actifs_zone', 'mt_passerelles', 'mt_liens', 'mt_paquets', 'mt_canal_moyen', 'mt_canal_max', 'mc_noeuds_actifs', 'mc_paquets', 'couverture_pct'];

function creerHistorique(db, config, sources, journal) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS historique_heure (heure INTEGER PRIMARY KEY, ${COLONNES.map((c) => c + ' REAL').join(', ')});
    CREATE TABLE IF NOT EXISTS historique_jour (jour TEXT PRIMARY KEY, ${COLONNES.map((c) => c + ' REAL').join(', ')}, ${COLONNES.map((c) => c + '_max REAL').join(', ')});
  `);
  const inserer = db.prepare(`INSERT OR REPLACE INTO historique_heure (heure, ${COLONNES.join(', ')}) VALUES (@heure, ${COLONNES.map((c) => '@' + c).join(', ')})`);
  const jourDe = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // Résumé de l'heure écoulée
  function noterHeure() {
    const h = Math.floor(Date.now() / 3600000) * 3600000;
    const r = { heure: h };
    for (const c of COLONNES) r[c] = null;
    try { Object.assign(r, sources.meshtastic()); } catch (e) { journal('[Historique] Meshtastic :', e.message); }
    try { Object.assign(r, sources.meshcore ? sources.meshcore() : {}); } catch (e) { journal('[Historique] MeshCore :', e.message); }
    try { const c = sources.couverture(); if (c != null) r.couverture_pct = c; } catch { /* relief pas prêt */ }
    inserer.run(r);
    resumerJour(jourDe(h));
  }
  // Résumé du jour (moyennes et maximums des heures ; paquets = somme)
  function resumerJour(jour) {
    const debut = new Date(jour + 'T00:00:00').getTime(), fin = debut + 86400000;
    const lignes = db.prepare('SELECT * FROM historique_heure WHERE heure >= ? AND heure < ?').all(debut, fin);
    if (!lignes.length) return;
    const r = { jour };
    for (const c of COLONNES) {
      const v = lignes.map((l) => l[c]).filter((x) => x != null);
      r[c] = v.length ? (c.endsWith('paquets') ? v.reduce((a, b) => a + b, 0) : Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10) : null;
      r[c + '_max'] = v.length ? Math.max(...v) : null;
    }
    const cols = Object.keys(r);
    db.prepare(`INSERT OR REPLACE INTO historique_jour (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(r);
  }
  // Premier démarrage : on reconstitue le nombre de paquets par heure à partir des données encore présentes
  function reconstituer() {
    if (db.prepare('SELECT COUNT(*) AS n FROM historique_heure').get().n) return;
    try {
      const mt = db.prepare('SELECT (heure / 3600000) * 3600000 AS h, COUNT(*) AS n FROM paquets GROUP BY heure / 3600000').all();
      let mc = [];
      try { mc = db.prepare('SELECT (heure / 3600000) * 3600000 AS h, COUNT(*) AS n FROM mc_paquets GROUP BY heure / 3600000').all(); } catch { /* pas de MeshCore */ }
      const parH = new Map();
      for (const x of mt) parH.set(x.h, { mt_paquets: x.n });
      for (const x of mc) parH.set(x.h, { ...(parH.get(x.h) || {}), mc_paquets: x.n });
      const maintenant = Math.floor(Date.now() / 3600000) * 3600000;
      db.transaction(() => {
        for (const [h, v] of parH) {
          if (h >= maintenant) continue;
          const r = { heure: h };
          for (const c of COLONNES) r[c] = v[c] ?? null;
          inserer.run(r);
        }
      })();
      const jours = new Set([...parH.keys()].map(jourDe));
      for (const j of jours) resumerJour(j);
      journal(`[Historique] reconstitué : ${parH.size} heures de trafic`);
    } catch (e) { journal('[Historique] reconstitution impossible :', e.message); }
  }

  // Compactage : le dimanche vers 4 h, si plus d'un quart du fichier est de la place libérée
  function compacterSiUtile(forcer) {
    const pages = db.pragma('page_count', { simple: true }), libres = db.pragma('freelist_count', { simple: true }), taille = db.pragma('page_size', { simple: true });
    const libreMo = Math.round((libres * taille) / 1048576), totalMo = Math.round((pages * taille) / 1048576);
    if (!forcer && libres < pages * 0.25) return { compacte: false, libreMo, totalMo };
    const debut = Date.now();
    journal(`[Historique] compactage de la base (${libreMo} Mo libres sur ${totalMo} Mo)…`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    const apresMo = Math.round((db.pragma('page_count', { simple: true }) * taille) / 1048576);
    journal(`[Historique] base compactée en ${Math.round((Date.now() - debut) / 1000)} s : ${totalMo} → ${apresMo} Mo`);
    return { compacte: true, avantMo: totalMo, apresMo, dureeS: Math.round((Date.now() - debut) / 1000) };
  }

  reconstituer();
  let derniereHeure = Math.floor(Date.now() / 3600000);
  setInterval(() => {
    const h = Math.floor(Date.now() / 3600000);
    if (h !== derniereHeure) { derniereHeure = h; try { noterHeure(); } catch (e) { journal('[Historique]', e.message); } }
    const d = new Date();
    if (d.getDay() === 0 && d.getHours() === 4 && d.getMinutes() < 2) { try { compacterSiUtile(false); } catch (e) { journal('[Historique] compactage :', e.message); } }
  }, 60000).unref();
  setTimeout(() => { try { noterHeure(); } catch (e) { journal('[Historique]', e.message); } }, 120000).unref();

  return {
    lire(jours) {
      const depuis = Date.now() - jours * 86400000;
      if (jours <= 7) return { pas: 'heure', points: db.prepare('SELECT * FROM historique_heure WHERE heure >= ? ORDER BY heure').all(depuis) };
      const j0 = jourDe(depuis);
      return { pas: 'jour', points: db.prepare('SELECT * FROM historique_jour WHERE jour >= ? ORDER BY jour').all(j0).map((p) => ({ ...p, heure: new Date(p.jour + 'T12:00:00').getTime() })) };
    },
    tailleBase() {
      const taille = db.pragma('page_size', { simple: true });
      return { totalMo: Math.round((db.pragma('page_count', { simple: true }) * taille) / 1048576), libreMo: Math.round((db.pragma('freelist_count', { simple: true }) * taille) / 1048576) };
    },
    compacter: () => compacterSiUtile(true),
  };
}

module.exports = { creerHistorique };
