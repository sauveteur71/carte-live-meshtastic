'use strict';
// Sauvegarde des réglages de la carte : fichiers de réglages du volume /data et comptes.
// Une sauvegarde par jour (14 gardées) dans /data/sauvegardes, téléchargeable et restaurable depuis la carte.
// Les données radio (paquets, liens…) ne sont pas sauvegardées : elles se reconstituent toutes seules.
const fs = require('fs');
const path = require('path');

const FICHIERS = [
  'reglages.json', 'installations.json', 'traceroutes-reglages.json', 'modules-radio.json', 'config-module.json',
  'configs-noeuds.json', 'lectures-noeuds.json', 'noeuds-administrables.json',
  'meshcore-admin.json', 'meshcore-companion.json', 'meshcore-lectures.json', 'code-agents.txt',
];
const GARDER = 14;

function creerSauvegardes(dossier, db, journal) {
  const rep = path.join(dossier, 'sauvegardes');
  try { fs.mkdirSync(rep, { recursive: true, mode: 0o700 }); } catch { /* existe */ }

  function contenu() {
    const fichiers = {};
    for (const f of FICHIERS) { try { fichiers[f] = fs.readFileSync(path.join(dossier, f), 'utf8'); } catch { /* absent */ } }
    let comptes = [];
    try { comptes = db.prepare('SELECT * FROM comptes').all(); } catch { /* table absente */ }
    return { format: 'carte-live-sauvegarde', version: 1, date: new Date().toISOString(), fichiers, comptes };
  }
  function nomDuJour(d = new Date()) { return `sauvegarde-${d.toISOString().slice(0, 10)}.json`; }

  function sauvegarder() {
    const c = contenu();
    const nom = nomDuJour();
    fs.writeFileSync(path.join(rep, nom), JSON.stringify(c), { mode: 0o600 });
    // Rotation : on garde les plus récentes
    const liste = fs.readdirSync(rep).filter((x) => /^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    for (const x of liste.slice(0, Math.max(0, liste.length - GARDER))) { try { fs.unlinkSync(path.join(rep, x)); } catch { /* ignoré */ } }
    journal(`[Sauvegarde] ${nom} : ${Object.keys(c.fichiers).length} fichiers de réglages, ${c.comptes.length} comptes`);
    return { nom, fichiers: Object.keys(c.fichiers).length, comptes: c.comptes.length };
  }

  function liste() {
    return fs.readdirSync(rep).filter((x) => /^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().reverse()
      .map((nom) => { const st = fs.statSync(path.join(rep, nom)); return { nom, taille: st.size, date: st.mtimeMs }; });
  }
  function lire(nom) {
    if (!/^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(nom)) throw new Error('Nom invalide');
    return fs.readFileSync(path.join(rep, nom));
  }

  // Restauration : fichiers réécrits, comptes remplacés ; le service redémarre ensuite
  function restaurer(s) {
    if (!s || s.format !== 'carte-live-sauvegarde' || typeof s.fichiers !== 'object') throw new Error('Ce fichier n’est pas une sauvegarde de la carte');
    // Sauvegarde de sécurité de l'état actuel avant d'écraser
    fs.writeFileSync(path.join(rep, 'avant-restauration.json'), JSON.stringify(contenu()), { mode: 0o600 });
    let n = 0;
    for (const [f, texte] of Object.entries(s.fichiers)) {
      if (!FICHIERS.includes(f) || typeof texte !== 'string') continue;
      fs.writeFileSync(path.join(dossier, f), texte, { mode: 0o600 });
      n++;
    }
    let c = 0;
    if (Array.isArray(s.comptes) && s.comptes.length) {
      const cols = ['id', 'identifiant', 'indicatif', 'email', 'hash', 'role', 'statut', 'cree', 'derniere', 'version'];
      const ins = db.prepare(`INSERT INTO comptes (${cols.join(', ')}) VALUES (${cols.map((x) => '@' + x).join(', ')})`);
      db.transaction(() => {
        db.prepare('DELETE FROM comptes').run();
        for (const x of s.comptes) { if (x && x.identifiant && x.hash) { ins.run(Object.fromEntries(cols.map((k) => [k, x[k] ?? null]))); c++; } }
      })();
    }
    journal(`[Sauvegarde] restauration du ${s.date} : ${n} fichiers, ${c} comptes ; redémarrage`);
    return { fichiers: n, comptes: c, date: s.date };
  }

  // Une sauvegarde par jour, vers 3 h 30 (et au démarrage s'il n'y en a pas encore aujourd'hui)
  setInterval(() => { const d = new Date(); if (d.getHours() === 3 && d.getMinutes() >= 30 && d.getMinutes() < 32) { try { sauvegarder(); } catch (e) { journal('[Sauvegarde]', e.message); } } }, 120000).unref();
  setTimeout(() => { try { if (!fs.existsSync(path.join(rep, nomDuJour()))) sauvegarder(); } catch (e) { journal('[Sauvegarde]', e.message); } }, 60000).unref();

  return { sauvegarder, liste, lire, restaurer };
}

module.exports = { creerSauvegardes };
