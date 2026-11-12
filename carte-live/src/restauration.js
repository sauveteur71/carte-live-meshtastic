'use strict';
// Restauration d'une sauvegarde complète (carte-live-complete-DATE.tar.gz) depuis la carte.
// 1. L'archive envoyée est vérifiée (chemins relatifs, base de données présente) puis extraite à côté des données,
//    dans « restauration-en-attente ». 2. La carte redémarre. 3. Au démarrage, avant d'ouvrir la base, les fichiers
//    actuels concernés sont mis de côté dans « avant-restauration-DATE », puis remplacés par ceux de l'archive.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ATTENTE = 'restauration-en-attente';

// Vérifie et extrait l'archive ; renvoie le nombre de fichiers et la date de la base
function preparer(fichierArchive, dossierDonnees, nomBase) {
  const liste = spawnSync('tar', ['-tzf', fichierArchive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (liste.status !== 0) throw new Error('fichier illisible : ce n’est pas une archive .tar.gz');
  const entrees = liste.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  // Liens (symboliques ou physiques) refusés : une sauvegarde de la carte n'en contient pas, et un lien placé dans
  // le dossier des données pourrait faire écrire ailleurs
  const detail = spawnSync('tar', ['-tvzf', fichierArchive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (detail.status !== 0 || detail.stdout.split('\n').some((l) => /^[lh]/.test(l))) throw new Error('archive refusée : elle contient des liens, ce n’est pas une sauvegarde complète de la carte');
  for (const e of entrees) {
    const n = path.posix.normalize(e.replace(/^\.\//, ''));
    if (e.startsWith('/') || n.startsWith('..') || n.includes('/../')) throw new Error(`chemin refusé dans l’archive : ${e}`);
  }
  if (!entrees.some((e) => e.replace(/^\.\//, '') === nomBase)) throw new Error(`l’archive ne contient pas la base ${nomBase} : ce n’est pas une sauvegarde complète de la carte`);
  const cible = path.join(dossierDonnees, ATTENTE);
  fs.rmSync(cible, { recursive: true, force: true });
  fs.mkdirSync(cible, { recursive: true });
  const x = spawnSync('tar', ['-xzf', fichierArchive, '-C', cible, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8' });
  if (x.status !== 0) { fs.rmSync(cible, { recursive: true, force: true }); throw new Error('extraction impossible : ' + (x.stderr || '').trim().slice(0, 200)); }
  // Contrôle de la base : en-tête SQLite
  const b = Buffer.alloc(16);
  const fd = fs.openSync(path.join(cible, nomBase), 'r'); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd);
  if (b.toString('latin1') !== 'SQLite format 3\u0000') { fs.rmSync(cible, { recursive: true, force: true }); throw new Error('la base de l’archive est abîmée'); }
  fs.writeFileSync(path.join(cible, '.pret'), String(Date.now()));
  return { fichiers: entrees.filter((e) => !e.endsWith('/')).length, base: fs.statSync(path.join(cible, nomBase)).size };
}

// Au démarrage : applique une restauration préparée (avant l'ouverture de la base)
function appliquerSiPrete(dossierDonnees, nomBase, journal = console.log) {
  const src = path.join(dossierDonnees, ATTENTE);
  if (!fs.existsSync(path.join(src, '.pret'))) return false;
  const cote = path.join(dossierDonnees, 'avant-restauration-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  fs.mkdirSync(cote, { recursive: true });
  // Les fichiers de la base en cours (WAL compris) partent de côté
  for (const f of [nomBase, nomBase + '-wal', nomBase + '-shm']) { try { fs.renameSync(path.join(dossierDonnees, f), path.join(cote, f)); } catch { /* absent */ } }
  let n = 0;
  const copier = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (r === '.pret') continue;
      const dst = path.join(dossierDonnees, r);
      if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copier(r); continue; }
      if (fs.existsSync(dst)) { fs.mkdirSync(path.dirname(path.join(cote, r)), { recursive: true }); try { fs.renameSync(dst, path.join(cote, r)); } catch { /* garde */ } }
      fs.renameSync(path.join(src, r), dst);
      n++;
    }
  };
  copier('');
  fs.rmSync(src, { recursive: true, force: true });
  journal(`[Restauration] sauvegarde complète appliquée : ${n} fichier(s) ; l’ancien état est gardé dans ${path.basename(cote)}`);
  return true;
}

module.exports = { preparer, appliquerSiPrete, ATTENTE };
