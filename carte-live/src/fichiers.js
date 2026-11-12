'use strict';
// Écriture et lecture sûres des fichiers d'état (réglages, équipes, liaisons, tâches…).
// Écriture : fichier temporaire, vidé sur le disque, puis renommé à la place de l'ancien, qui devient « .bak ».
// Une coupure de courant pendant l'écriture laisse donc toujours soit l'ancienne version, soit la nouvelle, jamais
// un fichier tronqué. Lecture : si le fichier manque ou est illisible alors qu'une copie « .bak » existe, la copie est
// reprise et le problème est écrit dans le journal, au lieu de repartir en silence sur une liste vide.
const fs = require('fs');
const path = require('path');

const TAILLE_MAX_COPIE = 2 * 1024 * 1024; // au-delà (relief, caches), pas de copie .bak : ces fichiers se refont seuls

function ecrireSur(fichier, contenu, options = {}) {
  const tmp = fichier + '.tmp';
  const fd = fs.openSync(tmp, 'w', options.mode ?? 0o644);
  try {
    fs.writeFileSync(fd, typeof contenu === 'string' || Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu.buffer, contenu.byteOffset, contenu.byteLength));
    try { fs.fsyncSync(fd); } catch { /* système de fichiers sans fsync */ }
  } finally { fs.closeSync(fd); }
  try {
    if (fs.statSync(fichier).size < TAILLE_MAX_COPIE) fs.renameSync(fichier, fichier + '.bak');
  } catch { /* premier enregistrement */ }
  fs.renameSync(tmp, fichier);
}

const signales = new Set();
function lireJson(fichier) {
  try {
    return JSON.parse(fs.readFileSync(fichier, 'utf8'));
  } catch (e) {
    const bak = fichier + '.bak';
    if (!fs.existsSync(bak)) throw e; // fichier jamais créé : l'appelant prend ses valeurs par défaut
    const r = JSON.parse(fs.readFileSync(bak, 'utf8')); // copie illisible aussi : l'erreur remonte à l'appelant
    if (!signales.has(fichier)) {
      signales.add(fichier);
      console.error(new Date().toISOString(), `[Fichiers] ${path.basename(fichier)} ${e.code === 'ENOENT' ? 'absent' : 'illisible (' + e.message + ')'} : copie précédente reprise`);
    }
    return r;
  }
}

module.exports = { ecrireSur, lireJson };
