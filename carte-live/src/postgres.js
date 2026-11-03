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

function creerArchivePostgres(config, stockage, journal) {
  const url = process.env.POSTGRES_URL || '';
  if (!url) return null;
  let Pool;
  try { ({ Pool } = require('pg')); } catch { journal('[PostgreSQL] module « pg » absent : archive désactivée'); return null; }
  const pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30000, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  pool.on('error', (e) => journal('[PostgreSQL]', e.message));
  const db = stockage.db;
  const fCurseurs = path.join(path.dirname(config.fichierBase), 'postgres-curseurs.json');
  let curseurs = {};
  try { curseurs = JSON.parse(fs.readFileSync(fCurseurs, 'utf8')); } catch { /* premier lancement */ }
  const etat = { actif: true, connecte: false, erreur: null, dernierTour: null, copies: {}, total: 0 };
  const schemas = new Map(); // table -> { colonnes, cle, existe }

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
    if (enCours) return;
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
  const minuterie = setInterval(tour, 20000);
  if (minuterie.unref) minuterie.unref();
  setTimeout(tour, 5000);
  journal(`[PostgreSQL] archive vers ${url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:••••@')}`);
  return { etat: () => ({ ...etat, curseurs }) };
}

module.exports = { creerArchivePostgres };
