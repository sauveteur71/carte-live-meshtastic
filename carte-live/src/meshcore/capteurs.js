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
    derniers: db.prepare('SELECT c.cle, c.mesure, c.valeur, c.unite, c.heure FROM mc_capteurs c JOIN (SELECT cle, mesure, MAX(heure) h FROM mc_capteurs WHERE cle = ? GROUP BY mesure) d ON d.cle = c.cle AND d.mesure = c.mesure AND d.h = c.heure'),
    purger: db.prepare('DELETE FROM mc_capteurs WHERE heure < ?'),
    effacerTout: db.prepare('DELETE FROM mc_capteurs WHERE cle = ?'),
    effacerMesure: db.prepare('DELETE FROM mc_capteurs WHERE cle = ? AND mesure = ?'),
    effacerAvant: db.prepare('DELETE FROM mc_capteurs WHERE cle = ? AND heure < ?'),
  };
  const fichier = path.join(path.dirname(config.fichierBase), 'meshcore-capteurs.json');
  let reglages = {}; // cle -> { intervalleMin, libelles: { 'temperature:2': 'Abri' }, seuils: { 'tension:1': { min: 3.4 } }, dernier, nom }
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
    return { intervalleMin: r.intervalleMin || 0, libelles: r.libelles || {}, seuils: r.seuils || {}, masquees: r.masquees || [], dernier: r.dernier || null, intervalles: INTERVALLES, series: [...series.values()] };
  }

  function regler(cle, { intervalleMin, libelles, seuils, masquees, nom } = {}) {
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
    // Seuils d'alerte d'une mesure : minimum et/ou maximum (vide = pas de seuil)
    if (seuils && typeof seuils === 'object') {
      r.seuils = { ...(r.seuils || {}) };
      for (const [k, v] of Object.entries(seuils)) {
        if (!/^[a-z_]+:\d{1,3}$/.test(k)) continue;
        const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
        const mn = num(v && v.min), mx = num(v && v.max);
        if (mn == null && mx == null) delete r.seuils[k]; else r.seuils[k] = { min: mn, max: mx };
      }
    }
    // Mesures masquées (non pertinentes : tension 0 V d'une voie non câblée…) : { 'tension:4': true | false }
    if (masquees && typeof masquees === 'object') {
      const l = new Set(r.masquees || []);
      for (const [k, v] of Object.entries(masquees)) { if (!/^[a-z_]+:\d{1,3}$/.test(k)) continue; if (v) l.add(k); else l.delete(k); }
      r.masquees = [...l].slice(0, 60);
    }
    if (typeof nom === 'string' && nom) r.nom = nom.slice(0, 40);
    reglages[cle] = r;
    sauver();
    return lire(cle, 1);
  }

  // Remise à zéro (capteur renommé ou recâblé, canaux LPP qui ont changé de sens) :
  // historique : 'tout' | 'avant' (relevés antérieurs à `avant`) | null ; reglages : libellés, seuils et masquage effacés
  // (l'intervalle de relevé est gardé) ; mesure : une seule mesure (historique + son libellé, seuil, masquage)
  function reinitialiser(cle, { historique = null, avant = null, reglages: aussiReglages = false, mesure = null } = {}) {
    const r = reglages[cle] || {};
    let lignes = 0;
    if (mesure) {
      if (!/^[a-z_]+:\d{1,3}$/.test(mesure)) throw new Error('mesure invalide');
      lignes = q.effacerMesure.run(cle, mesure).changes;
      if (r.libelles) delete r.libelles[mesure];
      if (r.seuils) delete r.seuils[mesure];
      if (r.masquees) r.masquees = r.masquees.filter((m) => m !== mesure);
    } else {
      if (historique === 'tout') lignes = q.effacerTout.run(cle).changes;
      else if (historique === 'avant') {
        const t = Number(avant);
        if (!Number.isFinite(t) || t <= 0) throw new Error('date invalide');
        lignes = q.effacerAvant.run(cle, t).changes;
      }
      if (aussiReglages) { delete r.libelles; delete r.seuils; delete r.masquees; }
      if (!historique && !aussiReglages) throw new Error('rien à réinitialiser');
    }
    reglages[cle] = r;
    sauver();
    journal(`capteurs ${cle.slice(0, 8)} : ${mesure ? 'mesure ' + mesure + ' effacée' : 'réinitialisés'} (${lignes} relevé(s) supprimé(s)${aussiReglages ? ', libellés et seuils effacés' : ''})`);
    return { lignes, ...lire(cle, 1) };
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

  // Alertes : dernière valeur d'une mesure hors des seuils réglés (valeur de moins de 48 h)
  const LIB = { tension: 'tension', temperature: 'température', humidite: 'humidité', pression: 'pression', courant: 'courant', pourcentage: 'charge', luminosite: 'luminosité' };
  function alertes(nomDe = () => null) {
    const l = [];
    for (const [cle, r] of Object.entries(reglages)) {
      if (!r.seuils || !Object.keys(r.seuils).length) continue;
      for (const d of q.derniers.all(cle)) {
        const s = r.seuils[d.mesure];
        if (!s || Date.now() - d.heure > 48 * 3600000 || (r.masquees || []).includes(d.mesure)) continue;
        const bas = s.min != null && d.valeur < s.min, haut = s.max != null && d.valeur > s.max;
        if (!bas && !haut) continue;
        const [type, canal] = d.mesure.split(':');
        const libelle = (r.libelles && r.libelles[d.mesure]) || `${LIB[type] || type}${canal !== '1' ? ' ' + canal : ''}`;
        const nom = nomDe(cle) || r.nom || cle.slice(0, 8);
        const v = String(Math.round(d.valeur * 100) / 100).replace('.', ',');
        l.push({ cle: `mc-capteur:${cle}:${d.mesure}`, noeud: cle, type: 'capteur', niveau: 'attention', nom, depuis: d.heure,
          message: `${nom} · ${libelle} : ${v} ${d.unite || ''}`.trim() + ` (${bas ? 'sous ' + String(s.min).replace('.', ',') : 'au-dessus de ' + String(s.max).replace('.', ',')} ${d.unite || ''})`.replace(' )', ')') });
      }
    }
    return l;
  }
  // Export CSV (séparateur « ; », virgule décimale, pour un tableur français)
  function csv(cle, jours = 90) {
    const r = reglages[cle] || {};
    const lignes = ['date;heure;mesure;libellé;valeur;unité'];
    for (const p of q.serie.all(cle, Date.now() - jours * 86400000)) {
      const d = new Date(p.heure);
      const jour = d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }), h = d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
      const lib = String((r.libelles && r.libelles[p.mesure]) || '').replace(/[;\r\n"]/g, ' ');
      lignes.push([jour, h, p.mesure, lib, String(p.valeur).replace('.', ','), p.unite || ''].join(';'));
    }
    return '\ufeff' + lignes.join('\r\n') + '\r\n';
  }

  return { noter, lire, regler, reinitialiser, alertes, csv, arreter: () => { clearInterval(minut); clearInterval(purge); }, INTERVALLES };
}

module.exports = { creerCapteursMc };
