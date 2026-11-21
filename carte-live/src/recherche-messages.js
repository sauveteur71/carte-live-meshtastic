'use strict';
// Recherche dans les messages texte (Meshtastic et MeshCore) : un mot du texte, ou le nom (long, court),
// l'identifiant (!xxxxxxxx, numéro, début de clé MeshCore) de l'expéditeur — et du destinataire d'un message direct.
//
// Le texte passe par deux index plein texte SQLite FTS5 (tokenizer « unicode61 remove_diacritics 2 » : sans
// majuscules ni accents) à contenu externe : les messages restent dans « paquets » et « mc_messages », l'index ne
// garde que les mots. Des déclencheurs (triggers) tiennent l'index à jour à chaque insertion, modification ou
// suppression, y compris la purge de rétention : un message supprimé disparaît aussi de la recherche.
//
// ATTENTION, index PARTIEL : recherche_mt n'indexe que les lignes de « paquets » dont port = 'texte' (pas les
// positions, la télémétrie…). Les commandes FTS5 « rebuild » et « integrity-check » (avec vérification du contenu)
// sont donc INUTILISABLES sur recherche_mt : « rebuild » réindexerait tout le trafic, « integrity-check » signalerait
// un désaccord normal. En cas de doute, supprimer la table et ses déclencheurs : la migration la refait au démarrage.
//
// Les noms sont indexés à part (index « trigram » FTS5, sans majuscules ni accents, SQLite 3.34 au moins) : une
// partie de nom (« gal » trouve « Mégal », trois caractères au moins) est retrouvée sans relire toute la table des
// nœuds. Un nœud renommé est retrouvé sous son nom actuel (et, pour MeshCore, aussi sous le nom porté par le
// message). Sans tokenizer trigram, repli sur un LIKE normalisé (plus lent, mais même résultat).
//
// Écritures japonaises, chinoises, coréennes, thaïes : unicode61 ne sait pas couper ces écritures (pas d'espace entre
// les mots), un terme ne serait trouvé qu'en début de suite. Pour ces requêtes, le texte est cherché par LIKE sur
// le texte normalisé (plus lent, mais complet) ; les noms passent par l'index trigram, qui s'en accommode.
//
// Si la migration échoue (disque plein, base en lecture seule…), le serveur démarre quand même : la recherche est
// « indisponible » (disponible() = false) et la route répond 503, le reste de la carte n'est pas touché.
//
// Droits : la route appelle chercher() après le même contrôle que /api/messages et /api/mc/messages ; en
// démonstration (visiteur), seuls les canaux publics sont cherchés, jamais les messages directs.

const BROADCAST = 4294967295;
const LIMITE_NOEUDS = 500; // nœuds dont le nom correspond, au plus (une recherche trop vague reste rapide)
const RE_SANS_ESPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

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

// Requête FTS5 : chaque mot en « phrase », tous obligatoires (ET implicite). Préfixe ("chap"* trouve chapeau) à
// partir de 3 caractères seulement : "ab"* parcourrait une part énorme de l'index ; en dessous, le mot exact.
function requeteFts(mots) {
  return mots.map((m) => `"${m.replace(/"/g, '""')}"${m.length >= 3 ? '*' : ''}`).join(' ');
}
// Requête trigram (noms) : une seule phrase, la partie de nom saisie (3 caractères au moins, sinon null)
function requeteTrigram(nq) {
  return nq.length >= 3 ? `"${nq.replace(/"/g, '""')}"` : null;
}
// Écritures sans espaces entre les mots (unicode61 ne les coupe pas) : recherche du texte par LIKE
const sansEspaces = (t) => RE_SANS_ESPACES.test(t);

const echapperLike = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

// Curseur de pagination : « heure:ref » (ex. 1700000000000:mt123) — deux messages de la même milliseconde ne sont
// plus sautés. Une simple heure (ancien format) reste acceptée.
function lireCurseur(avant) {
  const s = String(avant == null ? '' : avant);
  const m = /^(\d{1,16})(?::(mt|mc)(\d{1,16}))?$/.exec(s);
  if (!m || !(Number(m[1]) > 0)) return { avant: Number.MAX_SAFE_INTEGER, curseurMt: 0, curseurId: 0 };
  return { avant: Number(m[1]), curseurMt: m[2] === 'mt' ? 1 : 0, curseurId: m[3] ? Number(m[3]) : 0 };
}

function creerRechercheMessages(db, journal = () => {}) {
  // Fonction SQL de normalisation (repli sans index trigram, écritures sans espaces)
  db.function('recherche_norm', { deterministic: true }, (t) => (t == null ? null : normaliser(t)));

  let fts = true, noms = true, indisponible = null;
  const essai = (tokenizer) => {
    db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.essai_fts5 USING fts5(x, tokenize='${tokenizer}')`).run();
    db.prepare('DROP TABLE IF EXISTS temp.essai_fts5').run();
  };
  try { essai('unicode61 remove_diacritics 2'); } catch (e) {
    fts = false; noms = false;
    journal('[Recherche] FTS5 indisponible dans cette version de SQLite, recherche plus lente (sans index) :', e.message);
  }
  if (fts) try { essai('trigram remove_diacritics 1'); } catch (e) {
    noms = false;
    journal('[Recherche] tokenizer trigram indisponible (SQLite < 3.34), recherche par nom plus lente :', e.message);
  }

  // Disque plein, base en lecture seule… : le serveur démarre, la recherche seule est indisponible
  if (fts) try { migrer(); } catch (e) {
    indisponible = e.message;
    journal('[Recherche] index impossible à créer, recherche indisponible :', e.message);
  }

  // Création des index, des déclencheurs et remplissage depuis l'historique, en une seule transaction :
  // un redémarrage pendant la migration la refait entièrement au démarrage suivant.
  function migrer() {
    const existe = (nom) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nom);
    const nouveauMt = !existe('recherche_mt'), nouveauMc = !existe('recherche_mc');
    const nouveauNoms = noms && !existe('recherche_noms_mt'), nouveauNomsMc = noms && !existe('recherche_noms_mc'), nouveauMsgNoms = noms && !existe('recherche_mc_noms');
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
        CREATE INDEX IF NOT EXISTS idx_noeuds_nom_court ON noeuds(nom_court COLLATE NOCASE);
      `);
      // idx_noeuds_nom_court : nom court exact (recherche d'un ou deux caractères, trop courts pour l'index trigram).
      // recherche_noms_mt : noms Meshtastic, index trigram à contenu externe (num = rowid de « noeuds »). Les nœuds
      //   sont créés par INSERT OR IGNORE puis UPDATE (jamais INSERT OR REPLACE, qui supprimerait sans déclencheur).
      // recherche_noms_mc : noms MeshCore ; « mc_noeuds » n'a pas de rowid stable (clé texte), l'index garde donc sa
      //   propre copie du nom, retrouvée par la clé (colonne non indexée) au renommage ou à la suppression.
      // recherche_mc_noms : noms portés par les messages MeshCore (expéditeur d'un canal, destinataire d'un direct).
      if (noms) db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS recherche_noms_mt USING fts5(nom_long, nom_court, content='noeuds', content_rowid='num', tokenize='trigram remove_diacritics 1');
        CREATE TRIGGER IF NOT EXISTS recherche_noms_mt_ai AFTER INSERT ON noeuds BEGIN
          INSERT INTO recherche_noms_mt(rowid, nom_long, nom_court) VALUES (new.num, new.nom_long, new.nom_court);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_noms_mt_ad AFTER DELETE ON noeuds BEGIN
          INSERT INTO recherche_noms_mt(recherche_noms_mt, rowid, nom_long, nom_court) VALUES ('delete', old.num, old.nom_long, old.nom_court);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_noms_mt_au AFTER UPDATE OF num, nom_long, nom_court ON noeuds
          WHEN new.num IS NOT old.num OR new.nom_long IS NOT old.nom_long OR new.nom_court IS NOT old.nom_court BEGIN
          INSERT INTO recherche_noms_mt(recherche_noms_mt, rowid, nom_long, nom_court) VALUES ('delete', old.num, old.nom_long, old.nom_court);
          INSERT INTO recherche_noms_mt(rowid, nom_long, nom_court) VALUES (new.num, new.nom_long, new.nom_court);
        END;
        CREATE VIRTUAL TABLE IF NOT EXISTS recherche_noms_mc USING fts5(cle UNINDEXED, nom, tokenize='trigram remove_diacritics 1');
        CREATE TRIGGER IF NOT EXISTS recherche_noms_mc_ai AFTER INSERT ON mc_noeuds WHEN new.nom IS NOT NULL BEGIN
          INSERT INTO recherche_noms_mc(cle, nom) VALUES (new.cle, new.nom);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_noms_mc_ad AFTER DELETE ON mc_noeuds BEGIN
          DELETE FROM recherche_noms_mc WHERE cle = old.cle;
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_noms_mc_au AFTER UPDATE OF cle, nom ON mc_noeuds WHEN new.cle IS NOT old.cle OR new.nom IS NOT old.nom BEGIN
          DELETE FROM recherche_noms_mc WHERE cle = old.cle;
          INSERT INTO recherche_noms_mc(cle, nom) SELECT new.cle, new.nom WHERE new.nom IS NOT NULL;
        END;
        CREATE VIRTUAL TABLE IF NOT EXISTS recherche_mc_noms USING fts5(nom_de, nom_vers, content='mc_messages', content_rowid='id', tokenize='trigram remove_diacritics 1');
        CREATE TRIGGER IF NOT EXISTS recherche_mc_noms_ai AFTER INSERT ON mc_messages BEGIN
          INSERT INTO recherche_mc_noms(rowid, nom_de, nom_vers) VALUES (new.id, new.nom_de, new.nom_vers);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_mc_noms_ad AFTER DELETE ON mc_messages BEGIN
          INSERT INTO recherche_mc_noms(recherche_mc_noms, rowid, nom_de, nom_vers) VALUES ('delete', old.id, old.nom_de, old.nom_vers);
        END;
        CREATE TRIGGER IF NOT EXISTS recherche_mc_noms_au AFTER UPDATE OF nom_de, nom_vers ON mc_messages WHEN new.nom_de IS NOT old.nom_de OR new.nom_vers IS NOT old.nom_vers BEGIN
          INSERT INTO recherche_mc_noms(recherche_mc_noms, rowid, nom_de, nom_vers) VALUES ('delete', old.id, old.nom_de, old.nom_vers);
          INSERT INTO recherche_mc_noms(rowid, nom_de, nom_vers) VALUES (new.id, new.nom_de, new.nom_vers);
        END;
      `);
      // Remplissage initial : seulement les messages texte (pas « rebuild », qui indexerait tout le trafic)
      if (nouveauMt) n += db.prepare("INSERT INTO recherche_mt(rowid, texte) SELECT rowid, texte FROM paquets WHERE port = 'texte' AND texte IS NOT NULL").run().changes;
      if (nouveauMc) n += db.prepare('INSERT INTO recherche_mc(rowid, texte) SELECT id, texte FROM mc_messages WHERE texte IS NOT NULL').run().changes;
      if (nouveauNoms) n += db.prepare('INSERT INTO recherche_noms_mt(rowid, nom_long, nom_court) SELECT num, nom_long, nom_court FROM noeuds').run().changes;
      if (nouveauNomsMc) n += db.prepare('INSERT INTO recherche_noms_mc(cle, nom) SELECT cle, nom FROM mc_noeuds WHERE nom IS NOT NULL').run().changes;
      if (nouveauMsgNoms) n += db.prepare('INSERT INTO recherche_mc_noms(rowid, nom_de, nom_vers) SELECT id, nom_de, nom_vers FROM mc_messages').run().changes;
    })();
    if (nouveauMt || nouveauMc || nouveauNoms || nouveauNomsMc || nouveauMsgNoms) {
      journal(`[Recherche] index des messages et des noms créé : ${n} lignes en ${Date.now() - debut} ms`);
    }
  }

  const q = {
    // Nœuds par nom : index trigram (3 caractères au moins) ; en dessous, nom court exact (index NOCASE)
    noeudsMt: db.prepare(`SELECT num FROM noeuds WHERE (@tri IS NOT NULL AND num IN (SELECT rowid FROM recherche_noms_mt WHERE recherche_noms_mt MATCH @tri))
        OR (@court IS NOT NULL AND nom_court = @court COLLATE NOCASE)
        OR (@idm IS NOT NULL AND lower(id) LIKE @idm) OR num = @num ORDER BY dernier_vu DESC LIMIT ${LIMITE_NOEUDS}`),
    noeudsMc: db.prepare(`SELECT cle FROM mc_noeuds WHERE (@tri IS NOT NULL AND cle IN (SELECT cle FROM recherche_noms_mc WHERE recherche_noms_mc MATCH @tri))
        OR (@court IS NOT NULL AND nom = @court COLLATE NOCASE) OR (@hexa IS NOT NULL AND cle LIKE @hexa)
        ORDER BY dernier_vu DESC LIMIT ${LIMITE_NOEUDS}`),
    // Repli sans index trigram : toute la table relue avec la fonction de normalisation (lent sur une grosse base)
    noeudsMtLent: db.prepare(`SELECT num FROM noeuds WHERE recherche_norm(nom_long) LIKE @motif ESCAPE '\\' OR recherche_norm(nom_court) LIKE @motif ESCAPE '\\'
        OR (@idm IS NOT NULL AND lower(id) LIKE @idm) OR num = @num ORDER BY dernier_vu DESC LIMIT ${LIMITE_NOEUDS}`),
    noeudsMcLent: db.prepare(`SELECT cle FROM mc_noeuds WHERE recherche_norm(nom) LIKE @motif ESCAPE '\\' OR (@hexa IS NOT NULL AND cle LIKE @hexa)
        ORDER BY dernier_vu DESC LIMIT ${LIMITE_NOEUDS}`),
  };
  const cache = new Map(); // requêtes préparées, une par forme (avec ou sans texte, noms trouvés, démonstration)
  const preparer = (sql) => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };

  // Page suivante : après le curseur (heure, puis Meshtastic avant MeshCore, puis identifiant décroissant)
  const apresCurseurMt = '(p.heure < @avant OR (p.heure = @avant AND @curseurMt = 1 AND p.rowid < @curseurId))';
  const apresCurseurMc = '(m.heure < @avant OR (m.heure = @avant AND (@curseurMt = 1 OR m.id < @curseurId)))';

  function chercherMt({ fts: requete, like, mots, nums, demo, publics, curseur, limite }) {
    const sources = [];
    if (requete && fts && !like) sources.push('SELECT rowid FROM recherche_mt WHERE recherche_mt MATCH @requete');
    if ((!fts || like) && mots.length) sources.push(`SELECT rowid FROM paquets WHERE port = 'texte' AND ${mots.map((_, i) => `recherche_norm(texte) LIKE @m${i} ESCAPE '\\'`).join(' AND ')}`);
    if (nums.length) {
      sources.push("SELECT rowid FROM paquets WHERE port = 'texte' AND de IN (SELECT value FROM json_each(@nums))");
      if (!demo) sources.push(`SELECT rowid FROM paquets WHERE port = 'texte' AND vers <> ${BROADCAST} AND vers IN (SELECT value FROM json_each(@nums))`);
    }
    if (!sources.length) return [];
    const sql = `SELECT p.rowid, p.de, p.vers, p.canal, p.heure, p.texte, p.id_paquet AS idPaquet, p.sauts,
      nd.nom_long AS nomLongDe, nd.nom_court AS nomCourtDe, nd.id AS idDe, nv.nom_long AS nomLongVers, nv.nom_court AS nomCourtVers, nv.id AS idVers
      FROM paquets p LEFT JOIN noeuds nd ON nd.num = p.de LEFT JOIN noeuds nv ON nv.num = p.vers
      WHERE p.rowid IN (${sources.join(' UNION ')}) AND p.port = 'texte' AND ${apresCurseurMt}
      AND (@demo = 0 OR (p.vers = ${BROADCAST} AND p.canal IN (SELECT value FROM json_each(@publics))))
      ORDER BY p.heure DESC, p.rowid DESC LIMIT @limite`;
    const params = { requete, nums: JSON.stringify(nums), publics: JSON.stringify(publics || []), demo: demo ? 1 : 0, ...curseur, limite };
    mots.forEach((m, i) => { params['m' + i] = '%' + echapperLike(m) + '%'; });
    const st = preparer(sql);
    // Paramètres nommés inutilisés refusés par better-sqlite3 : on ne passe que ceux de la requête
    const utiles = Object.fromEntries(Object.entries(params).filter(([k]) => sql.includes('@' + k)));
    const nset = new Set(nums), motsTexte = (t) => { const n = normaliser(t); return mots.length > 0 && mots.every((m) => n.includes(m)); };
    return st.all(utiles).map((m) => {
      const direct = m.vers !== BROADCAST;
      const parNomDe = nset.has(m.de), parNomVers = direct && nset.has(m.vers);
      return {
        // « ref » (pas « cle ») : en démonstration, les champs nommés « cle » sont masqués par nettoyerDemo
        reseau: 'mt', ref: 'mt' + m.rowid, rowid: m.rowid, heure: m.heure, canal: m.canal, direct, de: m.de, vers: m.vers, texte: m.texte, sauts: m.sauts, idPaquet: m.idPaquet,
        nomDe: m.nomLongDe || null, nomCourtDe: m.nomCourtDe || null, idDe: m.idDe || '!' + (m.de >>> 0).toString(16).padStart(8, '0'),
        nomVers: direct ? m.nomLongVers || null : null, nomCourtVers: direct ? m.nomCourtVers || null : null, idVers: direct ? m.idVers || '!' + (m.vers >>> 0).toString(16).padStart(8, '0') : null,
        trouve: [motsTexte(m.texte) ? 'texte' : null, parNomDe ? 'expediteur' : null, parNomVers ? 'destinataire' : null].filter(Boolean),
      };
    });
  }

  function chercherMc({ fts: requete, like, tri, motif, mots, cles, demo, curseur, limite }) {
    const sources = [];
    if (requete && fts && !like) sources.push('SELECT rowid FROM recherche_mc WHERE recherche_mc MATCH @requete');
    if ((!fts || like) && mots.length) sources.push(`SELECT id FROM mc_messages WHERE ${mots.map((_, i) => `recherche_norm(texte) LIKE @m${i} ESCAPE '\\'`).join(' AND ')}`);
    // Nom porté par le message (canaux : la seule trace de l'expéditeur), et nom actuel par la clé
    if (noms && tri) {
      sources.push('SELECT rowid FROM recherche_mc_noms WHERE recherche_mc_noms MATCH @triDe');
      if (!demo) sources.push("SELECT id FROM mc_messages WHERE genre = 'direct' AND id IN (SELECT rowid FROM recherche_mc_noms WHERE recherche_mc_noms MATCH @triVers)");
    } else if (!noms) {
      sources.push("SELECT id FROM mc_messages WHERE recherche_norm(nom_de) LIKE @motif ESCAPE '\\'");
      if (!demo) sources.push("SELECT id FROM mc_messages WHERE genre = 'direct' AND recherche_norm(nom_vers) LIKE @motif ESCAPE '\\'");
    }
    if (cles.length) {
      sources.push('SELECT id FROM mc_messages WHERE de IN (SELECT value FROM json_each(@cles))');
      if (!demo) sources.push("SELECT id FROM mc_messages WHERE genre = 'direct' AND vers IN (SELECT value FROM json_each(@cles))");
    }
    if (!sources.length) return [];
    const sql = `SELECT m.*, nd.nom AS nomActuelDe, nv.nom AS nomActuelVers FROM mc_messages m LEFT JOIN mc_noeuds nd ON nd.cle = m.de LEFT JOIN mc_noeuds nv ON nv.cle = m.vers
      WHERE m.id IN (${sources.join(' UNION ')}) AND ${apresCurseurMc}
      AND (@demo = 0 OR (m.genre = 'canal' AND (lower(m.canal) = 'public' OR m.canal LIKE '#%')))
      ORDER BY m.heure DESC, m.id DESC LIMIT @limite`;
    const params = { requete, motif, triDe: tri ? 'nom_de:' + tri : null, triVers: tri ? 'nom_vers:' + tri : null, cles: JSON.stringify(cles), demo: demo ? 1 : 0, ...curseur, limite };
    mots.forEach((m, i) => { params['m' + i] = '%' + echapperLike(m) + '%'; });
    const st = preparer(sql);
    const utiles = Object.fromEntries(Object.entries(params).filter(([k]) => sql.includes('@' + k)));
    const cset = new Set(cles), motifNu = motif.slice(1, -1).replace(/\\(.)/g, '$1');
    const nomContient = (n) => !!n && normaliser(n).includes(motifNu);
    return st.all(utiles).map((m) => {
      const direct = m.genre === 'direct';
      const nomDe = m.nom_de || m.nomActuelDe || null;
      return {
        reseau: 'mc', ref: 'mc' + m.id, id: m.id, heure: m.heure, canal: m.canal, direct, sens: m.sens, de: m.de, vers: direct ? m.vers : null, texte: m.texte, sauts: m.sauts, indexCanal: m.index_canal,
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
   * publics (noms des canaux Meshtastic publics), avant (curseur « heure:ref » de la page suivante), limite (1 à 500).
   * Résultat : { q, mots, resultats (du plus récent au plus ancien), suite (curseur pour la page suivante ou null) }.
   * Chaque résultat porte une référence « ref » (mt + rowid, mc + id), pas de champ « cle » (masqué en démonstration).
   */
  function chercher({ q: brut, demo = false, publics = [], avant, limite = 100 } = {}) {
    if (indisponible) { const e = new Error('Recherche indisponible : ' + indisponible); e.code = 'INDISPONIBLE'; throw e; }
    const texte = String(brut || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const nq = normaliser(texte);
    if (nq.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return { q: texte, mots: [], resultats: [], suite: null, tropCourt: true };
    limite = Math.min(Math.max(Number(limite) || 100, 1), 500);
    const curseur = lireCurseur(avant);
    const mots = motsRecherche(texte);
    const like = sansEspaces(nq); // japonais, chinois, coréen, thaï : texte cherché par LIKE, pas par l'index des mots
    const requete = mots.length && !like ? requeteFts(mots) : null;
    const motif = '%' + echapperLike(nq) + '%';
    const tri = requeteTrigram(nq);
    const court = nq.length < 3 ? nq : null;
    // Identifiant : « !a1b2 » (début) ou « a1b2c3d4 » (complet), numéro décimal exact ; début de clé publique MeshCore
    // (4 caractères hexadécimaux au moins : « 73 » ne doit pas ramener tous les nœuds dont l'identifiant contient 73)
    const num = /^\d{1,10}$/.test(nq) && Number(nq) <= 0xffffffff ? Number(nq) : null;
    const idm = /^![0-9a-f]{2,8}$/.test(nq) || /^[0-9a-f]{8}$/.test(nq) ? '!' + nq.replace(/^!/, '') + '%' : null;
    const hexa = /^!?[0-9a-f]{4,64}$/.test(nq) ? nq.replace(/^!/, '').toUpperCase() + '%' : null;
    const nums = (noms ? q.noeudsMt.all({ tri, court, idm, num: num ?? -1 }) : q.noeudsMtLent.all({ motif, idm, num: num ?? -1 })).map((r) => r.num);
    const cles = (noms ? q.noeudsMc.all({ tri, court, hexa }) : q.noeudsMcLent.all({ motif, hexa })).map((r) => r.cle);
    const commun = { fts: requete, like, tri, motif, mots, demo: !!demo, curseur, limite: limite + 1 };
    const l = [...chercherMt({ ...commun, nums, publics }), ...chercherMc({ ...commun, cles })]
      .sort((a, b) => b.heure - a.heure || (a.reseau !== b.reseau ? (a.reseau === 'mt' ? -1 : 1) : (b.rowid ?? b.id) - (a.rowid ?? a.id)));
    const resultats = l.slice(0, limite);
    const dernier = resultats[resultats.length - 1];
    return { q: texte, mots, resultats, suite: l.length > limite ? `${dernier.heure}:${dernier.ref}` : null };
  }

  return { chercher, fts: () => fts, noms: () => noms, disponible: () => !indisponible };
}

module.exports = { creerRechercheMessages, normaliser, motsRecherche, requeteFts, lireCurseur };
