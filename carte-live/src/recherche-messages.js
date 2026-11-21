'use strict';
// Recherche dans les messages texte (Meshtastic et MeshCore) : un mot du texte, ou le nom (long, court),
// l'identifiant (!xxxxxxxx, numéro, début de clé MeshCore) de l'expéditeur — et du destinataire d'un message direct.
//
// Le texte passe par deux index plein texte SQLite FTS5 (tokenizer « unicode61 remove_diacritics 2 » : sans
// majuscules ni accents) à contenu externe : les messages restent dans « paquets » et « mc_messages », l'index ne
// garde que les mots. Des déclencheurs (triggers) tiennent l'index à jour à chaque insertion, modification ou
// suppression, y compris la purge de rétention : un message supprimé disparaît aussi de la recherche.
// Les noms sont lus au moment de la requête dans les tables des nœuds : un nœud renommé est retrouvé sous son
// nom actuel (et, pour MeshCore, aussi sous le nom porté par le message).
//
// Droits : la route appelle chercher() après le même contrôle que /api/messages et /api/mc/messages ; en
// démonstration (visiteur), seuls les canaux publics sont cherchés, jamais les messages directs.

const BROADCAST = 4294967295;
const LIMITE_NOEUDS = 500; // nœuds dont le nom correspond, au plus (une recherche trop vague reste rapide)

// Sans accents ni majuscules, comme le tokenizer (é → e, Œ → œ, İ → i)
function normaliser(t) {
  return String(t == null ? '' : t).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

// Mots de la recherche (lettres et chiffres), dans l'ordre, sans doublon ; un mot d'une lettre est ignoré s'il y en a d'autres
function motsRecherche(q) {
  const l = [...new Set((normaliser(q).match(/[\p{L}\p{N}]+/gu) || []).map((x) => x.slice(0, 40)))].slice(0, 8);
  const longs = l.filter((x) => x.length > 1);
  return longs.length ? longs : l;
}

// Requête FTS5 : chaque mot en « phrase » préfixée ("chap"* trouve chapeau), tous obligatoires (ET implicite)
function requeteFts(mots) {
  return mots.map((m) => `"${m.replace(/"/g, '""')}"*`).join(' ');
}

const echapperLike = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

function creerRechercheMessages(db, journal = () => {}) {
  // Fonction SQL de normalisation (pour les noms : recherche d'une partie du nom, sans accents ni majuscules)
  db.function('recherche_norm', { deterministic: true }, (t) => (t == null ? null : normaliser(t)));

  let fts = true;
  try {
    db.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS temp.essai_fts5 USING fts5(x, tokenize='unicode61 remove_diacritics 2')").run();
    db.prepare('DROP TABLE IF EXISTS temp.essai_fts5').run();
  } catch (e) {
    fts = false;
    journal('[Recherche] FTS5 indisponible dans cette version de SQLite, recherche plus lente (sans index) :', e.message);
  }

  if (fts) migrer();

  // Création des index, des déclencheurs et remplissage depuis l'historique, en une seule transaction :
  // un redémarrage pendant la migration la refait entièrement au démarrage suivant.
  function migrer() {
    const existe = (nom) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nom);
    const nouveauMt = !existe('recherche_mt'), nouveauMc = !existe('recherche_mc');
    const debut = Date.now();
    let n = 0;
    db.transaction(() => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS recherche_mt USING fts5(texte, content='paquets', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER IF NOT EXISTS recherche_mt_ai AFTER INSERT ON paquets WHEN new.port = 'texte' AND new.texte IS NOT NULL BEGIN
          INSERT INTO recherche_mt(rowid, texte) VALUES (new.rowid, new.texte);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_mt_ad AFTER DELETE ON paquets WHEN old.port = 'texte' AND old.texte IS NOT NULL BEGIN
          INSERT INTO recherche_mt(recherche_mt, rowid, texte) VALUES ('delete', old.rowid, old.texte);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_mt_au AFTER UPDATE OF texte, port ON paquets BEGIN
          INSERT INTO recherche_mt(recherche_mt, rowid, texte) SELECT 'delete', old.rowid, old.texte WHERE old.port = 'texte' AND old.texte IS NOT NULL;
          INSERT INTO recherche_mt(rowid, texte) SELECT new.rowid, new.texte WHERE new.port = 'texte' AND new.texte IS NOT NULL;
        END;
        CREATE VIRTUAL TABLE IF NOT EXISTS recherche_mc USING fts5(texte, content='mc_messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER IF NOT EXISTS recherche_mc_ai AFTER INSERT ON mc_messages WHEN new.texte IS NOT NULL BEGIN
          INSERT INTO recherche_mc(rowid, texte) VALUES (new.id, new.texte);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_mc_ad AFTER DELETE ON mc_messages WHEN old.texte IS NOT NULL BEGIN
          INSERT INTO recherche_mc(recherche_mc, rowid, texte) VALUES ('delete', old.id, old.texte);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_mc_au AFTER UPDATE OF texte ON mc_messages BEGIN
          INSERT INTO recherche_mc(recherche_mc, rowid, texte) SELECT 'delete', old.id, old.texte WHERE old.texte IS NOT NULL;
          INSERT INTO recherche_mc(rowid, texte) SELECT new.id, new.texte WHERE new.texte IS NOT NULL;
        END;
        CREATE INDEX IF NOT EXISTS idx_mc_messages_de ON mc_messages(de);
      `);
      // Remplissage initial : seulement les messages texte (pas « rebuild », qui indexerait tout le trafic)
      if (nouveauMt) n += db.prepare("INSERT INTO recherche_mt(rowid, texte) SELECT rowid, texte FROM paquets WHERE port = 'texte' AND texte IS NOT NULL").run().changes;
      if (nouveauMc) n += db.prepare('INSERT INTO recherche_mc(rowid, texte) SELECT id, texte FROM mc_messages WHERE texte IS NOT NULL').run().changes;
    })();
    if (nouveauMt || nouveauMc) {
      journal(`[Recherche] index des messages créé : ${n} messages en ${Date.now() - debut} ms`);
    }
  }

  const q = {
    noeudsMt: db.prepare(`SELECT num FROM noeuds WHERE recherche_norm(nom_long) LIKE @motif ESCAPE '\\' OR recherche_norm(nom_court) LIKE @motif ESCAPE '\\'
        OR (@idm IS NOT NULL AND lower(id) LIKE @idm) OR num = @num ORDER BY dernier_vu DESC LIMIT ${LIMITE_NOEUDS}`),
    noeudsMc: db.prepare(`SELECT cle FROM mc_noeuds WHERE recherche_norm(nom) LIKE @motif ESCAPE '\\' OR (@hexa IS NOT NULL AND cle LIKE @hexa)
        ORDER BY dernier_vu DESC LIMIT ${LIMITE_NOEUDS}`),
  };
  const cache = new Map(); // requêtes préparées, une par forme (avec ou sans texte, noms trouvés, démonstration)
  const preparer = (sql) => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };

  function chercherMt({ fts: requete, motif, mots, nums, demo, publics, avant, limite }) {
    const sources = [];
    if (requete && fts) sources.push('SELECT rowid FROM recherche_mt WHERE recherche_mt MATCH @requete');
    if (!fts && mots.length) sources.push(`SELECT rowid FROM paquets WHERE port = 'texte' AND ${mots.map((_, i) => `recherche_norm(texte) LIKE @m${i} ESCAPE '\\'`).join(' AND ')}`);
    if (nums.length) {
      sources.push("SELECT rowid FROM paquets WHERE port = 'texte' AND de IN (SELECT value FROM json_each(@nums))");
      if (!demo) sources.push(`SELECT rowid FROM paquets WHERE port = 'texte' AND vers <> ${BROADCAST} AND vers IN (SELECT value FROM json_each(@nums))`);
    }
    if (!sources.length) return [];
    const sql = `SELECT p.rowid, p.de, p.vers, p.canal, p.heure, p.texte, p.id_paquet AS idPaquet, p.sauts,
      nd.nom_long AS nomLongDe, nd.nom_court AS nomCourtDe, nd.id AS idDe, nv.nom_long AS nomLongVers, nv.nom_court AS nomCourtVers, nv.id AS idVers
      FROM paquets p LEFT JOIN noeuds nd ON nd.num = p.de LEFT JOIN noeuds nv ON nv.num = p.vers
      WHERE p.rowid IN (${sources.join(' UNION ')}) AND p.port = 'texte' AND p.heure < @avant
      AND (@demo = 0 OR (p.vers = ${BROADCAST} AND p.canal IN (SELECT value FROM json_each(@publics))))
      ORDER BY p.heure DESC LIMIT @limite`;
    const params = { requete, nums: JSON.stringify(nums), publics: JSON.stringify(publics || []), demo: demo ? 1 : 0, avant, limite };
    mots.forEach((m, i) => { params['m' + i] = '%' + echapperLike(m) + '%'; });
    const st = preparer(sql);
    // Paramètres nommés inutilisés refusés par better-sqlite3 : on ne passe que ceux de la requête
    const utiles = Object.fromEntries(Object.entries(params).filter(([k]) => sql.includes('@' + k)));
    const nset = new Set(nums), motsTexte = (t) => { const n = normaliser(t); return mots.length > 0 && mots.every((m) => n.includes(m)); };
    return st.all(utiles).map((m) => {
      const direct = m.vers !== BROADCAST;
      const parNomDe = nset.has(m.de), parNomVers = direct && nset.has(m.vers);
      return {
        reseau: 'mt', cle: 'mt' + m.rowid, rowid: m.rowid, heure: m.heure, canal: m.canal, direct, de: m.de, vers: m.vers, texte: m.texte, sauts: m.sauts, idPaquet: m.idPaquet,
        nomDe: m.nomLongDe || null, nomCourtDe: m.nomCourtDe || null, idDe: m.idDe || '!' + (m.de >>> 0).toString(16).padStart(8, '0'),
        nomVers: direct ? m.nomLongVers || null : null, nomCourtVers: direct ? m.nomCourtVers || null : null, idVers: direct ? m.idVers || '!' + (m.vers >>> 0).toString(16).padStart(8, '0') : null,
        trouve: [motsTexte(m.texte) ? 'texte' : null, parNomDe ? 'expediteur' : null, parNomVers ? 'destinataire' : null].filter(Boolean),
      };
    });
  }

  function chercherMc({ fts: requete, motif, mots, cles, demo, avant, limite }) {
    const sources = [];
    if (requete && fts) sources.push('SELECT rowid FROM recherche_mc WHERE recherche_mc MATCH @requete');
    if (!fts && mots.length) sources.push(`SELECT id FROM mc_messages WHERE ${mots.map((_, i) => `recherche_norm(texte) LIKE @m${i} ESCAPE '\\'`).join(' AND ')}`);
    // Nom porté par le message (canaux : la seule trace de l'expéditeur), et nom actuel par la clé
    sources.push("SELECT id FROM mc_messages WHERE recherche_norm(nom_de) LIKE @motif ESCAPE '\\'");
    if (!demo) sources.push("SELECT id FROM mc_messages WHERE genre = 'direct' AND recherche_norm(nom_vers) LIKE @motif ESCAPE '\\'");
    if (cles.length) {
      sources.push('SELECT id FROM mc_messages WHERE de IN (SELECT value FROM json_each(@cles))');
      if (!demo) sources.push("SELECT id FROM mc_messages WHERE genre = 'direct' AND vers IN (SELECT value FROM json_each(@cles))");
    }
    const sql = `SELECT m.*, nd.nom AS nomActuelDe, nv.nom AS nomActuelVers FROM mc_messages m LEFT JOIN mc_noeuds nd ON nd.cle = m.de LEFT JOIN mc_noeuds nv ON nv.cle = m.vers
      WHERE m.id IN (${sources.join(' UNION ')}) AND m.heure < @avant
      AND (@demo = 0 OR (m.genre = 'canal' AND (lower(m.canal) = 'public' OR m.canal LIKE '#%')))
      ORDER BY m.heure DESC LIMIT @limite`;
    const params = { requete, motif, cles: JSON.stringify(cles), demo: demo ? 1 : 0, avant, limite };
    mots.forEach((m, i) => { params['m' + i] = '%' + echapperLike(m) + '%'; });
    const st = preparer(sql);
    const utiles = Object.fromEntries(Object.entries(params).filter(([k]) => sql.includes('@' + k)));
    const cset = new Set(cles), motifNu = motif.slice(1, -1).replace(/\\(.)/g, '$1');
    const nomContient = (n) => !!n && normaliser(n).includes(motifNu);
    return st.all(utiles).map((m) => {
      const direct = m.genre === 'direct';
      const nomDe = m.nom_de || m.nomActuelDe || null;
      return {
        reseau: 'mc', cle: 'mc' + m.id, id: m.id, heure: m.heure, canal: m.canal, direct, sens: m.sens, de: m.de, vers: direct ? m.vers : null, texte: m.texte, sauts: m.sauts, indexCanal: m.index_canal,
        nomDe, nomActuelDe: m.nomActuelDe && m.nomActuelDe !== nomDe ? m.nomActuelDe : null,
        nomVers: direct ? m.nom_vers || m.nomActuelVers || null : null,
        trouve: [mots.length && mots.every((x) => normaliser(m.texte).includes(x)) ? 'texte' : null,
          cset.has(m.de) || nomContient(m.nom_de) ? 'expediteur' : null,
          direct && (cset.has(m.vers) || nomContient(m.nom_vers)) ? 'destinataire' : null].filter(Boolean),
      };
    });
  }

  /**
   * Cherche dans les messages. Options : q (texte saisi), demo (visiteur en démonstration : canaux publics seulement),
   * publics (noms des canaux Meshtastic publics), avant (heure en ms : page suivante), limite (1 à 500).
   * Résultat : { q, mots, resultats (du plus récent au plus ancien), suite (heure pour la page suivante ou null) }.
   */
  function chercher({ q: brut, demo = false, publics = [], avant, limite = 100 } = {}) {
    const texte = String(brut || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const nq = normaliser(texte);
    if (nq.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return { q: texte, mots: [], resultats: [], suite: null, tropCourt: true };
    limite = Math.min(Math.max(Number(limite) || 100, 1), 500);
    avant = Number(avant) > 0 ? Number(avant) : Number.MAX_SAFE_INTEGER;
    const mots = motsRecherche(texte);
    const requete = mots.length ? requeteFts(mots) : null;
    const motif = '%' + echapperLike(nq) + '%';
    // Identifiant : « !a1b2 » (début) ou « a1b2c3d4 » (complet), numéro décimal exact ; début de clé publique MeshCore
    // (4 caractères hexadécimaux au moins : « 73 » ne doit pas ramener tous les nœuds dont l'identifiant contient 73)
    const num = /^\d{1,10}$/.test(nq) && Number(nq) <= 0xffffffff ? Number(nq) : null;
    const idm = /^![0-9a-f]{2,8}$/.test(nq) || /^[0-9a-f]{8}$/.test(nq) ? '!' + nq.replace(/^!/, '') + '%' : null;
    const hexa = /^!?[0-9a-f]{4,64}$/.test(nq) ? nq.replace(/^!/, '').toUpperCase() + '%' : null;
    const nums = q.noeudsMt.all({ motif, idm, num: num ?? -1 }).map((r) => r.num);
    const cles = q.noeudsMc.all({ motif, hexa }).map((r) => r.cle);
    const commun = { fts: requete, motif, mots, demo: !!demo, avant, limite: limite + 1 };
    const l = [...chercherMt({ ...commun, nums, publics }), ...chercherMc({ ...commun, cles })]
      .sort((a, b) => b.heure - a.heure || (a.cle < b.cle ? 1 : -1));
    const resultats = l.slice(0, limite);
    return { q: texte, mots, resultats, suite: l.length > limite ? resultats[resultats.length - 1].heure : null };
  }

  return { chercher, fts: () => fts };
}

module.exports = { creerRechercheMessages, normaliser, motsRecherche, requeteFts };
