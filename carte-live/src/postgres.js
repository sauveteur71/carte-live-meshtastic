'use strict';
// Archive PostgreSQL (facultative) : tout ce qui transite est recopié dans une base PostgreSQL,
// sans limite de durée (la base SQLite de la carte, elle, est purgée après quelques jours).
// Activation : POSTGRES_URL=postgres://utilisateur:motdepasse@hote:5432/base dans le .env.
//
// Copie incrémentale toutes les 20 s, table par table, dans l'ordre du temps ; les 10 dernières minutes
// sont recopiées à chaque tour (mises à jour tardives : nombre de réceptions, texte déchiffré…).

const fs = require('fs');
const path = require('path');

// table SQLite -> colonne de temps ; cle : clé primaire (sinon le rowid SQLite, colonne _rowid)
const TABLES = [
  { t: 'noeuds', temps: 'dernier_vu', cle: ['num'] },
  { t: 'paquets', temps: 'heure', cle: ['rowid'] },
  { t: 'receptions', temps: 'heure' },
  { t: 'positions', temps: 'heure' },
  { t: 'telemetrie', temps: 'heure' },
  { t: 'traceroutes', temps: 'heure', cle: ['id'] },
  { t: 'liens', temps: 'dernier_vu', cle: ['a', 'b', 'source'] },
  { t: 'mc_noeuds', temps: 'dernier_vu', cle: ['cle'] },
  { t: 'mc_paquets', temps: 'heure', cle: ['rowid'] },
  { t: 'mc_receptions', temps: 'heure' },
  { t: 'mc_messages', temps: 'heure', cle: ['id'] },
  { t: 'mc_telemetrie', temps: 'heure' },
  { t: 'mc_liens', temps: 'dernier_vu', cle: ['a', 'b', 'source'] },
];
const LOT = 1000, MAX_PAR_TOUR = 20000, RECOUVREMENT = 10 * 60000;
const typePg = (t) => (/INT/i.test(t) ? 'BIGINT' : /REAL|FLOA|DOUB/i.test(t) ? 'DOUBLE PRECISION' : /BLOB/i.test(t) ? 'BYTEA' : 'TEXT');
const q = (x) => '"' + String(x).replace(/"/g, '') + '"';

// Réglages (console d'administration, fichier /data/postgres.json, privé) ; POSTGRES_URL du .env sert de valeur initiale
function lireUrl(u) {
  try {
    const x = new URL(u);
    return { hote: x.hostname, port: Number(x.port) || 5432, base: decodeURIComponent(x.pathname.replace(/^\//, '')) || 'carte', utilisateur: decodeURIComponent(x.username), motDePasse: decodeURIComponent(x.password), ssl: /sslmode=require/.test(x.search) };
  } catch { return null; }
}
const versUrl = (c) => `postgres://${encodeURIComponent(c.utilisateur || '')}${c.motDePasse ? ':' + encodeURIComponent(c.motDePasse) : ''}@${c.hote}:${c.port || 5432}/${encodeURIComponent(c.base || 'carte')}${c.ssl ? '?sslmode=require' : ''}`;

function creerArchivePostgres(config, stockage, journal) {
  let Pool = null;
  try { ({ Pool } = require('pg')); } catch { /* module absent */ }
  const db = stockage.db;
  const dossier = path.dirname(config.fichierBase);
  const fReglages = path.join(dossier, 'postgres.json');
  const fCurseurs = path.join(dossier, 'postgres-curseurs.json');
  let reglages = { actif: false, hote: '', port: 5432, base: 'carte', utilisateur: '', motDePasse: '', ssl: false, retentionJours: 0, maxGo: 0 };
  const env = process.env.POSTGRES_URL ? lireUrl(process.env.POSTGRES_URL) : null;
  if (env) reglages = { ...reglages, ...env, actif: true };
  try { reglages = { ...reglages, ...JSON.parse(fs.readFileSync(fReglages, 'utf8')) }; } catch { /* aucun */ }
  let curseurs = {};
  try { curseurs = JSON.parse(fs.readFileSync(fCurseurs, 'utf8')); } catch { /* premier lancement */ }
  let pool = null;
  const etat = { connecte: false, erreur: null, dernierTour: null, copies: {}, total: 0, tailleOctets: null, derniereMaintenance: null, supprimees: 0 };
  let schemas = new Map(); // table -> { colonnes, cle, existe }

  function ouvrir() {
    if (pool) { pool.end().catch(() => {}); pool = null; }
    schemas = new Map();
    etat.connecte = false; etat.erreur = null;
    if (!reglages.actif || !reglages.hote || !Pool) return;
    pool = new Pool({ connectionString: versUrl(reglages), max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000, ssl: reglages.ssl ? { rejectUnauthorized: false } : undefined });
    pool.on('error', (e) => journal('[PostgreSQL]', e.message));
    journal(`[PostgreSQL] archive vers ${reglages.hote}:${reglages.port}/${reglages.base} (${reglages.retentionJours ? 'conservée ' + reglages.retentionJours + ' j' : 'conservée toujours'}${reglages.maxGo ? ', ' + reglages.maxGo + ' Go au plus' : ''})`);
    setTimeout(tour, 2000);
  }

  function schemaSqlite(def) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info(${def.t})`).all(); } catch { return null; }
    if (!cols.length) return null;
    const avecRowid = !def.cle || (def.cle.length === 1 && def.cle[0] === 'rowid' && !cols.some((c) => c.name === 'rowid'));
    const colonnes = cols.map((c) => ({ nom: c.name, type: typePg(c.type) }));
    if (avecRowid) colonnes.unshift({ nom: '_rowid', type: 'BIGINT' });
    const cle = avecRowid ? ['_rowid'] : def.cle;
    return { colonnes, cle, avecRowid };
  }

  async function preparer(def) {
    if (schemas.has(def.t)) return schemas.get(def.t);
    const s = schemaSqlite(def);
    if (!s) { schemas.set(def.t, null); return null; }
    await pool.query(`CREATE TABLE IF NOT EXISTS ${q(def.t)} (${s.colonnes.map((c) => `${q(c.nom)} ${c.type}`).join(', ')}, PRIMARY KEY (${s.cle.map(q).join(', ')}))`);
    // Colonnes ajoutées depuis (nouvelle version de la carte)
    const ex = new Set((await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [def.t])).rows.map((r) => r.column_name));
    for (const c of s.colonnes) if (!ex.has(c.nom)) await pool.query(`ALTER TABLE ${q(def.t)} ADD COLUMN ${q(c.nom)} ${c.type}`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${q('idx_' + def.t + '_' + def.temps)} ON ${q(def.t)} (${q(def.temps)})`);
    schemas.set(def.t, s);
    return s;
  }

  async function copierTable(def) {
    const s = await preparer(def);
    if (!s) return 0;
    const c = curseurs[def.t] || { temps: 0, rowid: 0 };
    // Recouvrement : les dernières minutes sont toujours recopiées (mises à jour tardives)
    let t0 = c.temps, r0 = c.rowid;
    if (t0 > Date.now() - RECOUVREMENT) { t0 = Date.now() - RECOUVREMENT; r0 = 0; }
    const sel = db.prepare(`SELECT rowid AS _r, * FROM ${def.t} WHERE (${def.temps} > ?) OR (${def.temps} = ? AND rowid > ?) ORDER BY ${def.temps}, rowid LIMIT ${LOT}`);
    const noms = s.colonnes.map((x) => x.nom);
    const maj = noms.filter((n) => !s.cle.includes(n));
    let n = 0;
    while (n < MAX_PAR_TOUR) {
      const lignes = sel.all(t0, t0, r0);
      if (!lignes.length) break;
      const valeurs = [], params = [];
      for (const l of lignes) {
        const v = noms.map((nom) => (nom === '_rowid' ? l._r : l[nom] === undefined ? null : l[nom]));
        valeurs.push('(' + v.map((x) => { params.push(Buffer.isBuffer(x) ? x : x); return '$' + params.length; }).join(', ') + ')');
      }
      await pool.query(`INSERT INTO ${q(def.t)} (${noms.map(q).join(', ')}) VALUES ${valeurs.join(', ')}
        ON CONFLICT (${s.cle.map(q).join(', ')}) DO ${maj.length ? `UPDATE SET ${maj.map((x) => `${q(x)} = EXCLUDED.${q(x)}`).join(', ')}` : 'NOTHING'}`, params);
      const der = lignes[lignes.length - 1];
      t0 = der[def.temps] ?? t0; r0 = der._r;
      if ((der[def.temps] ?? 0) >= (c.temps || 0)) curseurs[def.t] = { temps: t0, rowid: r0 };
      n += lignes.length;
      if (lignes.length < LOT) break;
    }
    return n;
  }

  let enCours = false;
  async function tour() {
    if (enCours || !pool) return;
    enCours = true;
    try {
      for (const def of TABLES) {
        const n = await copierTable(def);
        if (n) { etat.copies[def.t] = (etat.copies[def.t] || 0) + n; etat.total += n; }
      }
      fs.writeFileSync(fCurseurs, JSON.stringify(curseurs));
      if (!etat.connecte) journal('[PostgreSQL] archive active');
      etat.connecte = true; etat.erreur = null; etat.dernierTour = Date.now();
    } catch (e) {
      if (etat.erreur !== e.message) journal('[PostgreSQL] copie impossible :', e.message);
      etat.connecte = false; etat.erreur = e.message;
    }
    enCours = false;
  }
  // Maintenance (toutes les heures) : durée de conservation, puis taille maximale (les plus anciennes données partent d'abord)
  const AJOUT = TABLES.filter((d) => !['noeuds', 'liens', 'mc_noeuds', 'mc_liens'].includes(d.t));
  async function taille() { return Number((await pool.query('SELECT pg_database_size(current_database()) AS n')).rows[0].n); }
  async function supprimerAvant(limite) {
    let n = 0;
    for (const d of AJOUT) {
      if (!schemas.get(d.t)) continue;
      n += (await pool.query(`DELETE FROM ${q(d.t)} WHERE ${q(d.temps)} < $1`, [limite])).rowCount;
    }
    return n;
  }
  async function maintenance() {
    if (!pool || !etat.connecte) return;
    try {
      let n = 0;
      if (reglages.retentionJours > 0) n += await supprimerAvant(Date.now() - reglages.retentionJours * 86400000);
      if (reglages.maxGo > 0) {
        const max = reglages.maxGo * 1024 ** 3;
        for (let k = 0; k < 8 && (await taille()) > max; k++) {
          // Retire le plus ancien dixième de l'historique, puis compacte les tables pour rendre la place au disque
          const r = (await pool.query(`SELECT MIN(heure) AS a, MAX(heure) AS b FROM ${q('paquets')}`)).rows[0];
          if (!r || r.a == null) break;
          const a = Number(r.a), b = Number(r.b);
          n += await supprimerAvant(a + Math.max(3600000, (b - a) / 10));
          for (const d of AJOUT) if (schemas.get(d.t)) await pool.query(`VACUUM FULL ${q(d.t)}`);
        }
      }
      if (n) journal(`[PostgreSQL] maintenance : ${n} ligne(s) ancienne(s) supprimée(s)`);
      etat.supprimees += n;
      etat.tailleOctets = await taille();
      etat.derniereMaintenance = Date.now();
    } catch (e) { journal('[PostgreSQL] maintenance :', e.message); }
  }
  setInterval(tour, 20000).unref();
  setInterval(maintenance, 3600000).unref();
  setInterval(() => { if (pool && etat.connecte) taille().then((t) => { etat.tailleOctets = t; }).catch(() => {}); }, 300000).unref();
  ouvrir();
  setTimeout(maintenance, 60000).unref();

  const masquer = () => ({ ...reglages, motDePasse: undefined, motDePasseDefini: !!reglages.motDePasse });
  return {
    etat: () => ({ ...etat, reglages: masquer(), moduleAbsent: !Pool }),
    // Essai de connexion sans rien enregistrer
    async tester(c) {
      if (!Pool) throw new Error('module « pg » absent de cette image');
      const r = { ...reglages, ...c, motDePasse: c.motDePasse || reglages.motDePasse };
      const p = new Pool({ connectionString: versUrl(r), max: 1, connectionTimeoutMillis: 8000, ssl: r.ssl ? { rejectUnauthorized: false } : undefined });
      try {
        const v = (await p.query('SELECT version() AS v, pg_database_size(current_database()) AS t')).rows[0];
        return { version: String(v.v).split(' ').slice(0, 2).join(' '), tailleOctets: Number(v.t) };
      } finally { p.end().catch(() => {}); }
    },
    configurer(c) {
      const n = { ...reglages };
      if ('actif' in c) n.actif = !!c.actif;
      if (c.hote !== undefined) n.hote = String(c.hote).trim().slice(0, 253);
      if (c.port !== undefined) { const p = Number(c.port); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port invalide'); n.port = p; }
      if (c.base !== undefined) n.base = String(c.base).trim().slice(0, 63) || 'carte';
      if (c.utilisateur !== undefined) n.utilisateur = String(c.utilisateur).trim().slice(0, 63);
      if (c.motDePasse) n.motDePasse = String(c.motDePasse);
      if ('ssl' in c) n.ssl = !!c.ssl;
      if (c.retentionJours !== undefined) { const j = Number(c.retentionJours); if (!Number.isInteger(j) || j < 0 || j > 36500) throw new Error('Durée invalide'); n.retentionJours = j; }
      if (c.maxGo !== undefined) { const g = Number(c.maxGo); if (!(g >= 0 && g <= 100000)) throw new Error('Taille invalide'); n.maxGo = g; }
      if (n.actif && !n.hote) throw new Error('Indiquez l’adresse du serveur PostgreSQL');
      reglages = n;
      fs.writeFileSync(fReglages, JSON.stringify(reglages), { mode: 0o600 });
      ouvrir();
      setTimeout(maintenance, 30000);
      return masquer();
    },
  };
}

module.exports = { creerArchivePostgres };
