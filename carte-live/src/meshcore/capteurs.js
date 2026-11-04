'use strict';
// Capteurs des nœuds MeshCore (télémétrie Cayenne LPP : tension, température, humidité, pression, courant…).
// - relevé périodique, intervalle réglable nœud par nœud (tâche « télémétrie » de l'administration) ;
// - historique de chaque mesure pour les courbes ;
// - libellé personnalisable de chaque mesure (« Batterie », « Abri », au lieu de « tension 1 »).

const fs = require('fs');
const path = require('path');

const INTERVALLES = [0, 15, 30, 60, 180, 360, 720, 1440]; // minutes, 0 = jamais

function creerCapteursMc({ db, config, adminMc, companion, journal }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mc_capteurs (cle TEXT, heure INTEGER, mesure TEXT, valeur REAL, unite TEXT);
    CREATE INDEX IF NOT EXISTS idx_mc_capteurs ON mc_capteurs(cle, heure);
  `);
  const q = {
    inserer: db.prepare('INSERT INTO mc_capteurs (cle, heure, mesure, valeur, unite) VALUES (?, ?, ?, ?, ?)'),
    serie: db.prepare('SELECT heure, mesure, valeur, unite FROM mc_capteurs WHERE cle = ? AND heure >= ? ORDER BY heure'),
    purger: db.prepare('DELETE FROM mc_capteurs WHERE heure < ?'),
  };
  const fichier = path.join(path.dirname(config.fichierBase), 'meshcore-capteurs.json');
  let reglages = {}; // cle -> { intervalleMin, libelles: { 'temperature:2': 'Abri' }, dernier }
  try { reglages = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch { /* aucun */ }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(reglages)); } catch { /* lecture seule */ } };

  // Une mesure LPP = type + canal ; seules les valeurs numériques font une courbe (GPS, accéléromètre : ignorés)
  function noter(cle, mesures) {
    const h = Date.now();
    let n = 0;
    for (const m of mesures || []) {
      if (typeof m.valeur !== 'number' || !Number.isFinite(m.valeur)) continue;
      q.inserer.run(cle, h, `${m.type}:${m.canal}`, m.valeur, m.unite || '');
      n++;
    }
    reglages[cle] = { ...(reglages[cle] || {}), dernier: h };
    sauver();
    return n;
  }

  function lire(cle, jours = 7) {
    const r = reglages[cle] || {};
    const series = new Map();
    for (const p of q.serie.all(cle, Date.now() - jours * 86400000)) {
      if (!series.has(p.mesure)) series.set(p.mesure, { mesure: p.mesure, unite: p.unite, points: [] });
      series.get(p.mesure).points.push([p.heure, p.valeur]);
    }
    return { intervalleMin: r.intervalleMin || 0, libelles: r.libelles || {}, dernier: r.dernier || null, intervalles: INTERVALLES, series: [...series.values()] };
  }

  function regler(cle, { intervalleMin, libelles } = {}) {
    const r = reglages[cle] || {};
    if (intervalleMin !== undefined) {
      const v = Number(intervalleMin);
      if (!INTERVALLES.includes(v)) throw new Error('intervalle invalide');
      r.intervalleMin = v;
    }
    if (libelles && typeof libelles === 'object') {
      r.libelles = { ...(r.libelles || {}) };
      for (const [k, v] of Object.entries(libelles)) {
        if (!/^[a-z_]+:\d{1,3}$/.test(k)) continue;
        const t = String(v || '').trim().slice(0, 40);
        if (t) r.libelles[k] = t; else delete r.libelles[k];
      }
    }
    reglages[cle] = r;
    sauver();
    return lire(cle, 1);
  }

  // Relevés périodiques : une tâche « télémétrie » à la fois, quand le companion est prêt
  const minut = setInterval(() => {
    try {
      if (!companion.etat().pret) return;
      const maintenant = Date.now();
      const enCours = new Set(adminMc.taches().filter((t) => !t.fin && t.type === 'telemetrie').flatMap((t) => t.cles));
      const dus = Object.entries(reglages).filter(([cle, r]) => r.intervalleMin > 0 && !enCours.has(cle) && maintenant - (r.essai || r.dernier || 0) >= r.intervalleMin * 60000).map(([cle]) => cle);
      if (!dus.length) return;
      for (const cle of dus) reglages[cle].essai = maintenant; // pas de nouvelle demande avant l'intervalle, même en cas d'échec
      sauver();
      adminMc.lancer('telemetrie', dus.slice(0, 10), {}, 'capteurs (relevé automatique)');
    } catch (e) { journal('relevé des capteurs :', e.message); }
  }, 60000);
  // Historique gardé 90 jours
  const purge = setInterval(() => { try { q.purger.run(Date.now() - 90 * 86400000); } catch { /* ignoré */ } }, 6 * 3600000);

  return { noter, lire, regler, arreter: () => { clearInterval(minut); clearInterval(purge); }, INTERVALLES };
}

module.exports = { creerCapteursMc };
