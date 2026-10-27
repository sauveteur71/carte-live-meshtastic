'use strict';
// Réseau MeshCore : stockage (tables mc_*), intégration des paquets observés, liens déduits des chemins, vues.
//
// Une « observation » est un paquet brut entendu par un observateur (le companion relié à la carte, ou un
// observateur publiant sur MQTT au format meshcoretomqtt), avec le SNR et le RSSI de la réception.
// Les paquets en inondation portent la liste des répéteurs traversés (1 à 3 octets du début de leur clé publique) :
// origine → r1 → r2 → … → observateur. Le dernier saut est une liaison radio mesurée (SNR) vers l'observateur.

const { decoderPaquet, resumer, ROLES_FR } = require('./paquet');
const { distanceKm } = require('../reseau');

const ROLES_RELAIS = new Set(['repeteur', 'salon']);

function creerReseauMc(db, config, canauxInitiaux, journal = () => {}) {
  let canaux = canauxInitiaux;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mc_noeuds (
      cle TEXT PRIMARY KEY, nom TEXT, role TEXT, lat REAL, lon REAL, heure_position INTEGER,
      premier_vu INTEGER, dernier_vu INTEGER, derniere_annonce INTEGER, horodatage_annonce INTEGER,
      snr REAL, rssi REAL, sauts_min INTEGER, sauts_dernier INTEGER,
      observateur INTEGER DEFAULT 0, observateur_vu INTEGER, etat_observateur TEXT, details_observateur TEXT,
      source TEXT
    );
    CREATE TABLE IF NOT EXISTS mc_paquets (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      hachage TEXT UNIQUE, heure INTEGER, type TEXT, route TEXT, de TEXT, de_prefixe TEXT, vers_prefixe TEXT,
      canal TEXT, expediteur TEXT, texte TEXT, resume TEXT, taille INTEGER, chemin TEXT, sauts INTEGER,
      nb_receptions INTEGER DEFAULT 1, brut TEXT, contenu TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mc_paquets_heure ON mc_paquets(heure);
    CREATE INDEX IF NOT EXISTS idx_mc_paquets_de ON mc_paquets(de, heure);
    CREATE TABLE IF NOT EXISTS mc_receptions (
      paquet INTEGER, observateur TEXT, heure INTEGER, snr REAL, rssi REAL, chemin TEXT, dernier_saut TEXT, via TEXT,
      PRIMARY KEY (paquet, observateur, chemin)
    );
    CREATE INDEX IF NOT EXISTS idx_mc_receptions_heure ON mc_receptions(heure);
    CREATE INDEX IF NOT EXISTS idx_mc_receptions_obs ON mc_receptions(observateur, heure);
    CREATE TABLE IF NOT EXISTS mc_liens (
      a TEXT, b TEXT, source TEXT, snr REAL, rssi REAL, nb INTEGER DEFAULT 1, premier_vu INTEGER, dernier_vu INTEGER,
      PRIMARY KEY (a, b, source)
    );
    CREATE INDEX IF NOT EXISTS idx_mc_liens_heure ON mc_liens(dernier_vu);
    -- Messages : reçus (canaux déchiffrés, messages directs du companion) et envoyés depuis la carte
    CREATE TABLE IF NOT EXISTS mc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, heure INTEGER, sens TEXT, genre TEXT, canal TEXT, index_canal INTEGER,
      de TEXT, nom_de TEXT, vers TEXT, nom_vers TEXT, texte TEXT, sauts INTEGER, snr REAL,
      statut TEXT, ack INTEGER, auteur TEXT, hachage TEXT, relais INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mc_messages_heure ON mc_messages(heure);
    -- État des répéteurs (réponses « status ») : historique pour les courbes et les alertes
    CREATE TABLE IF NOT EXISTS mc_telemetrie (
      cle TEXT, heure INTEGER, batterie_mv INTEGER, bruit INTEGER, emission_pct REAL, recus INTEGER, emis INTEGER, allume_s INTEGER, snr REAL, file INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mc_telemetrie ON mc_telemetrie(cle, heure);
  `);

  const q = {
    noeud: db.prepare('SELECT * FROM mc_noeuds WHERE cle = ?'),
    noeuds: db.prepare('SELECT * FROM mc_noeuds ORDER BY dernier_vu DESC'),
    noeudsDepuis: db.prepare('SELECT * FROM mc_noeuds WHERE MAX(COALESCE(dernier_vu, 0), COALESCE(derniere_annonce, 0), COALESCE(observateur_vu, 0), COALESCE(heure_position, 0)) >= ?'),
    creer: db.prepare('INSERT OR IGNORE INTO mc_noeuds (cle, premier_vu, dernier_vu, source) VALUES (?, ?, ?, ?)'),
    vu: db.prepare(`UPDATE mc_noeuds SET dernier_vu = MAX(COALESCE(dernier_vu, 0), @heure),
        sauts_dernier = COALESCE(@sauts, sauts_dernier),
        sauts_min = CASE WHEN @sauts IS NULL THEN sauts_min WHEN sauts_min IS NULL OR @sauts < sauts_min THEN @sauts ELSE sauts_min END,
        snr = COALESCE(@snr, snr), rssi = COALESCE(@rssi, rssi) WHERE cle = @cle`),
    annonce: db.prepare(`UPDATE mc_noeuds SET nom = COALESCE(@nom, nom), role = COALESCE(@role, role),
        derniere_annonce = @heure, horodatage_annonce = @horodatage WHERE cle = @cle`),
    position: db.prepare('UPDATE mc_noeuds SET lat = @lat, lon = @lon, heure_position = @heure WHERE cle = @cle'),
    infos: db.prepare('UPDATE mc_noeuds SET nom = COALESCE(nom, @nom), role = COALESCE(role, @role) WHERE cle = @cle'),
    observateur: db.prepare(`UPDATE mc_noeuds SET observateur = 1, observateur_vu = MAX(COALESCE(observateur_vu, 0), @heure),
        etat_observateur = COALESCE(@etat, etat_observateur), details_observateur = COALESCE(@details, details_observateur) WHERE cle = @cle`),
    paquet: db.prepare(`INSERT INTO mc_paquets (hachage, heure, type, route, de, de_prefixe, vers_prefixe, canal, expediteur, texte, resume, taille, chemin, sauts, brut, contenu)
        VALUES (@hachage, @heure, @type, @route, @de, @dePrefixe, @versPrefixe, @canal, @expediteur, @texte, @resume, @taille, @chemin, @sauts, @brut, @contenu)
        ON CONFLICT(hachage) DO UPDATE SET nb_receptions = nb_receptions + 1,
          sauts = CASE WHEN excluded.sauts IS NOT NULL AND (mc_paquets.sauts IS NULL OR excluded.sauts < mc_paquets.sauts) THEN excluded.sauts ELSE mc_paquets.sauts END,
          de = COALESCE(mc_paquets.de, excluded.de)
        RETURNING rowid, nb_receptions`),
    reception: db.prepare('INSERT OR IGNORE INTO mc_receptions (paquet, observateur, heure, snr, rssi, chemin, dernier_saut, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    lien: db.prepare(`INSERT INTO mc_liens (a, b, source, snr, rssi, nb, premier_vu, dernier_vu) VALUES (@a, @b, @source, @snr, @rssi, 1, @heure, @heure)
        ON CONFLICT(a, b, source) DO UPDATE SET
          snr = CASE WHEN excluded.snr IS NULL THEN mc_liens.snr WHEN mc_liens.snr IS NULL THEN excluded.snr ELSE ROUND(mc_liens.snr * 0.7 + excluded.snr * 0.3, 2) END,
          rssi = CASE WHEN excluded.rssi IS NULL THEN mc_liens.rssi WHEN mc_liens.rssi IS NULL THEN excluded.rssi ELSE ROUND(mc_liens.rssi * 0.7 + excluded.rssi * 0.3, 1) END,
          nb = mc_liens.nb + 1, dernier_vu = MAX(mc_liens.dernier_vu, excluded.dernier_vu)`),
    liens: db.prepare('SELECT * FROM mc_liens WHERE dernier_vu >= ?'),
    paquets: db.prepare(`SELECT p.*, (SELECT COUNT(DISTINCT r.observateur) FROM mc_receptions r WHERE r.paquet = p.rowid) AS nb_observateurs
        FROM mc_paquets p ORDER BY p.heure DESC LIMIT ?`),
    paquetsType: db.prepare(`SELECT p.*, (SELECT COUNT(DISTINCT r.observateur) FROM mc_receptions r WHERE r.paquet = p.rowid) AS nb_observateurs
        FROM mc_paquets p WHERE p.type = ? ORDER BY p.heure DESC LIMIT ?`),
    paquetRowid: db.prepare('SELECT * FROM mc_paquets WHERE rowid = ?'),
    paquetHachage: db.prepare('SELECT * FROM mc_paquets WHERE hachage = ?'),
    receptionsPaquet: db.prepare('SELECT * FROM mc_receptions WHERE paquet = ? ORDER BY heure'),
    paquetsNoeud: db.prepare(`SELECT p.* FROM mc_paquets p WHERE p.de = ? ORDER BY p.heure DESC LIMIT ?`),
    messages: db.prepare(`SELECT rowid, heure, canal, expediteur, texte, de, sauts, nb_receptions FROM mc_paquets WHERE type = 'GRP_TXT' AND texte IS NOT NULL ORDER BY heure DESC LIMIT ?`),
    compteType: db.prepare('SELECT type, COUNT(*) AS nb FROM mc_paquets WHERE heure >= ? GROUP BY type'),
    compte: db.prepare('SELECT COUNT(*) AS nb FROM mc_paquets WHERE heure >= ?'),
    receptionsObs: db.prepare('SELECT COUNT(*) AS nb FROM mc_receptions WHERE observateur = ? AND heure >= ?'),
    msgInserer: db.prepare(`INSERT INTO mc_messages (heure, sens, genre, canal, index_canal, de, nom_de, vers, nom_vers, texte, sauts, snr, statut, ack, auteur, hachage)
        VALUES (@heure, @sens, @genre, @canal, @indexCanal, @de, @nomDe, @vers, @nomVers, @texte, @sauts, @snr, @statut, @ack, @auteur, @hachage)`),
    msgListe: db.prepare('SELECT * FROM mc_messages ORDER BY heure DESC LIMIT ?'),
    msgEcho: db.prepare(`SELECT id FROM mc_messages WHERE sens = 'envoye' AND genre = 'canal' AND canal = ? AND texte = ? AND heure >= ? ORDER BY heure DESC LIMIT 1`),
    msgRelais: db.prepare('UPDATE mc_messages SET relais = relais + 1, statut = ? WHERE id = ?'),
    msgAck: db.prepare(`UPDATE mc_messages SET statut = 'confirme' WHERE ack = ? AND sens = 'envoye' AND heure >= ?`),
    msgStatut: db.prepare('UPDATE mc_messages SET statut = ? WHERE id = ?'),
    msgHachage: db.prepare('SELECT id FROM mc_messages WHERE hachage = ?'),
    telInserer: db.prepare('INSERT INTO mc_telemetrie (cle, heure, batterie_mv, bruit, emission_pct, recus, emis, allume_s, snr, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    telNoeud: db.prepare('SELECT heure, batterie_mv, bruit, emission_pct, recus, emis, allume_s, snr FROM mc_telemetrie WHERE cle = ? AND heure >= ? ORDER BY heure'),
    telDernier: db.prepare('SELECT t.* FROM mc_telemetrie t JOIN (SELECT cle, MAX(heure) AS h FROM mc_telemetrie GROUP BY cle) d ON d.cle = t.cle AND d.h = t.heure'),
  };
  // Paquets et réceptions (le gros du volume avec le flux national) : rétention courte, suppression par lots
  const purgesPaquets = [
    db.prepare('DELETE FROM mc_receptions WHERE rowid IN (SELECT rowid FROM mc_receptions WHERE heure < ? LIMIT 20000)'),
    db.prepare('DELETE FROM mc_paquets WHERE rowid IN (SELECT rowid FROM mc_paquets WHERE heure < ? LIMIT 20000)'),
  ];
  const purges = [
    db.prepare('DELETE FROM mc_liens WHERE dernier_vu < ?'),
    db.prepare('DELETE FROM mc_noeuds WHERE dernier_vu < ? AND COALESCE(observateur, 0) = 0'),
    db.prepare('DELETE FROM mc_messages WHERE heure < ?'),
    db.prepare('DELETE FROM mc_telemetrie WHERE heure < ?'),
  ];

  const assurer = (cle, heure, source) => { if (cle) q.creer.run(cle, heure, heure, source || null); };

  // Cache des nœuds (pour la résolution des préfixes de chemin), rechargé au besoin
  // + index par premier octet de la clé : la résolution d'un préfixe ne parcourt plus les milliers de nœuds
  let cache = null, cacheHeure = 0, index = new Map();
  const noeudsCache = () => {
    if (!cache || Date.now() - cacheHeure > 30000) {
      cache = q.noeuds.all(); cacheHeure = Date.now();
      index = new Map();
      for (const n of cache) { const k = n.cle.slice(0, 2); if (!index.has(k)) index.set(k, []); index.get(k).push(n); }
    }
    return cache;
  };
  const parPrefixe = (p) => { noeudsCache(); return (index.get(p.slice(0, 2)) || []).filter((n) => n.cle.startsWith(p)); };
  const invalider = () => { cache = null; };

  // Préfixe de chemin (1 à 3 octets) → clé complète d'un relais, en levant l'ambiguïté par la géographie.
  // voisin : nœud (avec position) adjacent dans le chemin et déjà résolu.
  function resoudre(prefixe, voisin) {
    const p = prefixe.toUpperCase();
    let cands = parPrefixe(p);
    if (!cands.length) return null;
    const relais = cands.filter((n) => ROLES_RELAIS.has(n.role));
    if (relais.length) cands = relais;
    if (cands.length === 1) {
      const c = cands[0];
      if (voisin && voisin.lat != null && c.lat != null && distanceKm(voisin, c) > config.lienDistanceMaxKm) return null;
      return c;
    }
    // Plusieurs candidats : on garde le plus proche du voisin connu, s'il est nettement plus proche que le suivant
    if (!voisin || voisin.lat == null) return null;
    const proches = cands.filter((c) => c.lat != null).map((c) => ({ c, d: distanceKm(voisin, c) }))
      .filter((x) => x.d <= config.lienDistanceMaxKm).sort((a, b) => a.d - b.d);
    if (!proches.length) return null;
    if (proches.length > 1 && proches[1].d < proches[0].d * 1.5) return null;
    return proches[0].c;
  }

  // Résout un chemin entier : depuis l'observateur (fin) vers l'origine, puis depuis l'origine si besoin
  function resoudreChemin(chemin, origine, observateur) {
    const res = chemin.map(() => null);
    let voisin = observateur;
    for (let k = chemin.length - 1; k >= 0; k--) {
      const n = resoudre(chemin[k], voisin);
      res[k] = n;
      voisin = n || null;
    }
    voisin = origine;
    for (let k = 0; k < chemin.length; k++) {
      if (!res[k]) res[k] = resoudre(chemin[k], voisin);
      voisin = res[k] || null;
    }
    return res;
  }

  function lier(a, b, source, snr, rssi, heure) {
    if (!a || !b || a.cle === b.cle) return false;
    if (a.lat != null && b.lat != null && distanceKm(a, b) > config.lienDistanceMaxKm) return false;
    q.lien.run({ a: a.cle, b: b.cle, source, snr: snr ?? null, rssi: rssi ?? null, heure });
    return true;
  }

  /**
   * Intègre une observation { brut, snr, rssi, observateur (clé), heure, via ('companion' | 'mqtt'), sujet }.
   * Renvoie l'événement à diffuser aux pages, ou null.
   */
  function integrer(obs) {
    const p = decoderPaquet(obs.brut, canaux);
    if (!p.valide) return null;
    const heure = obs.heure || Date.now();
    const c = p.contenu || {};
    let sortie = null;
    db.transaction(() => {
      const obsCle = obs.observateur ? String(obs.observateur).toUpperCase() : null;
      if (obsCle) {
        assurer(obsCle, heure, obs.via);
        q.observateur.run({ cle: obsCle, heure, etat: null, details: null });
      }
      // Origine du paquet
      let origine = null;
      if (p.type === 'ADVERT' && c.cle) {
        assurer(c.cle, heure, 'annonce');
        q.annonce.run({ cle: c.cle, nom: c.nom || null, role: c.role || null, heure, horodatage: c.horodatage ?? null });
        if (c.lat != null) q.position.run({ cle: c.cle, lat: c.lat, lon: c.lon, heure });
        invalider();
        origine = c.cle;
      } else if (p.type === 'ANON_REQ' && c.cleExpediteur) {
        origine = c.cleExpediteur;
        assurer(origine, heure, 'requete');
      }
      const sauts = p.route === 'FLOOD' || p.route === 'TRANSPORT_FLOOD' ? p.chemin.length : null;
      if (origine) q.vu.run({ cle: origine, heure, sauts, snr: sauts === 0 ? obs.snr ?? null : null, rssi: sauts === 0 ? obs.rssi ?? null : null });
      if (obsCle) q.vu.run({ cle: obsCle, heure, sauts: null, snr: null, rssi: null });

      const garderTexte = p.type === 'GRP_TXT' && c.dechiffre;
      const r = q.paquet.get({
        hachage: p.hachage, heure, type: p.type, route: p.route, de: origine, dePrefixe: c.de || (origine ? origine.slice(0, 2) : null), versPrefixe: c.vers || null,
        canal: c.canal || null, expediteur: c.expediteur || null, texte: garderTexte ? c.texte : null, resume: resumer(p), taille: p.taille,
        chemin: JSON.stringify(p.chemin), sauts, brut: Buffer.isBuffer(obs.brut) ? obs.brut.toString('hex').toUpperCase() : String(obs.brut).toUpperCase(),
        contenu: JSON.stringify({ ...c, texte: undefined, signature: undefined }),
      });
      const premiere = r.nb_receptions === 1;
      if (garderTexte && premiere) {
        // Notre propre message, relayé par un répéteur et réentendu : on le note comme « relayé » au lieu d'un doublon
        const echo = c.expediteur && moi && c.expediteur === moi.nom ? q.msgEcho.get(c.canal, c.texte, heure - 5 * 60000) : null;
        if (echo) q.msgRelais.run('relaye', echo.id);
        else if (!q.msgHachage.get(p.hachage)) q.msgInserer.run({ heure, sens: 'recu', genre: 'canal', canal: c.canal, indexCanal: null, de: null, nomDe: c.expediteur || null, vers: null, nomVers: null, texte: c.texte, sauts, snr: sauts === 0 ? obs.snr ?? null : null, statut: null, ack: null, auteur: null, hachage: p.hachage });
      }

      // Liens radio : uniquement pour l'inondation (le chemin y liste les relais déjà traversés)
      const noeudObs = obsCle ? q.noeud.get(obsCle) : null;
      const noeudOrig = origine ? q.noeud.get(origine) : null;
      let dernier = null; // dernier émetteur (celui que l'observateur a entendu)
      let resolu = [];
      if (sauts != null) {
        resolu = resoudreChemin(p.chemin, noeudOrig, noeudObs);
        if (p.chemin.length === 0) dernier = noeudOrig;
        else dernier = resolu[resolu.length - 1];
        if (dernier && noeudObs) lier(dernier, noeudObs, 'rf', obs.snr, obs.rssi, heure);
        const chaine = [noeudOrig, ...resolu];
        for (let k = 0; k + 1 < chaine.length; k++) if (chaine[k] && chaine[k + 1]) lier(chaine[k], chaine[k + 1], 'chemin', null, null, heure);
        for (const n of resolu) if (n) q.vu.run({ cle: n.cle, heure, sauts: null, snr: null, rssi: null });
      } else if (p.type === 'TRACE' && c.route && p.snrChemin) {
        resolu = resoudreChemin(c.route, null, null);
        for (let k = 1; k < resolu.length && k < p.snrChemin.length; k++) if (resolu[k - 1] && resolu[k]) lier(resolu[k - 1], resolu[k], 'trace', p.snrChemin[k], null, heure);
      }
      if (obsCle) q.reception.run(r.rowid, obsCle, heure, obs.snr ?? null, obs.rssi ?? null, JSON.stringify(p.chemin), dernier ? dernier.cle : null, obs.via || null);

      sortie = {
        genre: 'mc-paquet', rowid: r.rowid, hachage: p.hachage, type: p.type, cleType: p.cleType, typeFr: p.typeFr, route: p.route,
        de: origine, nom: noeudOrig ? noeudOrig.nom : c.expediteur || null, observateur: obsCle, snr: obs.snr ?? null, rssi: obs.rssi ?? null,
        chemin: p.chemin, cheminResolu: resolu.map((n) => (n ? n.cle : null)), dernier: dernier ? dernier.cle : null,
        sauts, canal: c.canal || null, expediteur: c.expediteur || null, texte: garderTexte ? c.texte : undefined,
        resume: resumer(p), premiere, heure, via: obs.via, nouveauNoeud: p.type === 'ADVERT',
      };
    })();
    return sortie;
  }

  // Contacts connus du companion (noms, types, positions) : complètent la carte sans attendre les annonces
  function importerContact(ct, heure = Date.now()) {
    if (!ct || !ct.cle) return;
    assurer(ct.cle, ct.vu || heure, 'contact');
    q.infos.run({ cle: ct.cle, nom: ct.nom || null, role: ct.role || null });
    const n = q.noeud.get(ct.cle);
    if (ct.lat != null && (Math.abs(ct.lat) > 0.0001 || Math.abs(ct.lon) > 0.0001) && (!n.heure_position || (ct.vu || 0) > n.heure_position)) {
      q.position.run({ cle: ct.cle, lat: ct.lat, lon: ct.lon, heure: ct.vu || heure });
    }
    invalider();
  }

  // État d'un observateur (companion relié ou observateur MQTT)
  function noterObservateur(cle, { nom, role, lat, lon, etat, details } = {}) {
    if (!cle) return;
    const heure = Date.now();
    cle = cle.toUpperCase();
    assurer(cle, heure, 'observateur');
    if (nom || role) q.infos.run({ cle, nom: nom || null, role: role || null });
    if (lat != null && (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001)) q.position.run({ cle, lat, lon, heure });
    q.observateur.run({ cle, heure: etat === 'offline' ? 0 : heure, etat: etat || null, details: details ? JSON.stringify(details) : null });
    invalider();
  }

  function statut(n, maintenant) {
    const age = maintenant - (n.dernier_vu || 0);
    if (age < config.seuils.actifMinutes * 60000) return 'actif';
    if (age < config.seuils.inactifHeures * 3600000) return 'recent';
    return 'inactif';
  }
  const arrondir = (v, dec) => (v == null || dec < 0 ? v : Math.round(v * 10 ** dec) / 10 ** dec);

  function vueNoeud(n, membre, maintenant = Date.now()) {
    const infra = ROLES_RELAIS.has(n.role) || !!n.observateur;
    const dec = membre || infra ? -1 : config.precisionPublique;
    let details = null;
    try { details = n.details_observateur ? JSON.parse(n.details_observateur) : null; } catch { /* ignoré */ }
    return {
      cle: n.cle, id: n.cle.slice(0, 8), nom: n.nom, role: n.role || 'inconnu', roleFr: ROLES_FR[n.role] || 'Inconnu',
      lat: arrondir(n.lat, dec), lon: arrondir(n.lon, dec), heurePosition: n.heure_position,
      premierVu: n.premier_vu, dernierVu: n.dernier_vu, derniereAnnonce: n.derniere_annonce, horodatageAnnonce: n.horodatage_annonce,
      snr: n.snr, rssi: n.rssi, sautsMin: n.sauts_min, sautsDernier: n.sauts_dernier,
      observateur: !!n.observateur, observateurVu: n.observateur_vu, etatObservateur: n.etat_observateur, detailsObservateur: details,
      infrastructure: infra, statut: statut(n, maintenant),
    };
  }

  // depuisMs : fenêtre d'affichage ; dejaVu (heure) : seulement les liens modifiés depuis (mise à jour incrémentale)
  function liens(depuisMs, dejaVu = 0) {
    return q.liens.all(Math.max(Date.now() - depuisMs, dejaVu || 0)).map((l) => ({ a: l.a, b: l.b, source: l.source, snr: l.snr, rssi: l.rssi, nb: l.nb, dernierVu: l.dernier_vu }));
  }

  function statistiques() {
    const maintenant = Date.now();
    const noeuds = noeudsCache();
    const parType = {};
    for (const r of q.compteType.all(maintenant - 3600000)) parType[r.type] = r.nb;
    const observateurs = noeuds.filter((n) => n.observateur);
    return {
      noeuds: noeuds.length,
      actifs: noeuds.filter((n) => statut(n, maintenant) === 'actif').length,
      repeteurs: noeuds.filter((n) => n.role === 'repeteur').length,
      observateurs: observateurs.length,
      observateursEnLigne: observateurs.filter((n) => n.etat_observateur !== 'offline' && maintenant - (n.observateur_vu || 0) < config.seuils.muetMinutes * 60000).length,
      liens: q.liens.all(maintenant - 24 * 3600000).length,
      paquetsMinute: Math.round((q.compte.get(maintenant - 5 * 60000).nb / 5) * 10) / 10,
      paquetsHeure: Object.values(parType).reduce((a, b) => a + b, 0),
      parType,
    };
  }

  function detailNoeud(cle, membre) {
    const n = q.noeud.get(String(cle).toUpperCase());
    if (!n) return null;
    const maintenant = Date.now();
    const depuis = maintenant - config.retentionJours * 86400000;
    const tous = q.liens.all(depuis).filter((l) => l.a === n.cle || l.b === n.cle);
    const voisins = new Map();
    for (const l of tous) {
      const autre = l.a === n.cle ? l.b : l.a;
      const v = voisins.get(autre) || { cle: autre, nb: 0, snrEntendu: null, snrEmis: null, sources: new Set(), dernierVu: 0 };
      v.nb += l.nb; v.sources.add(l.source); v.dernierVu = Math.max(v.dernierVu, l.dernier_vu);
      if (l.b === n.cle && l.snr != null) v.snrEntendu = l.snr; else if (l.a === n.cle && l.snr != null) v.snrEmis = l.snr;
      voisins.set(autre, v);
    }
    const listeVoisins = [...voisins.values()].map((v) => {
      const o = q.noeud.get(v.cle);
      return { ...v, sources: [...v.sources], nom: o ? o.nom : null, role: o ? o.role : null, distanceKm: o && n.lat != null && o.lat != null ? distanceKm(n, o) : null };
    }).sort((a, b) => b.nb - a.nb);
    // Observateurs qui l'ont entendu directement (dernier saut) ou via des relais
    const entendu = db.prepare(`SELECT r.observateur, COUNT(*) AS nb, ROUND(AVG(r.snr), 2) AS snr, ROUND(AVG(r.rssi), 1) AS rssi, MIN(p.sauts) AS sauts_min, MAX(r.heure) AS dernier
        FROM mc_receptions r JOIN mc_paquets p ON p.rowid = r.paquet WHERE p.de = ? AND r.heure >= ? GROUP BY r.observateur ORDER BY dernier DESC`).all(n.cle, depuis)
      .map((e) => { const o = q.noeud.get(e.observateur); return { ...e, nom: o ? o.nom : null }; });
    return {
      noeud: vueNoeud(n, membre, maintenant),
      voisins: listeVoisins,
      entenduPar: entendu,
      paquets: q.paquetsNoeud.all(n.cle, 40).map((p) => preparerPaquet(p, membre)),
    };
  }

  function preparerPaquet(p, membre) {
    let contenu = null;
    try { contenu = p.contenu ? JSON.parse(p.contenu) : null; } catch { /* ignoré */ }
    return {
      rowid: p.rowid, hachage: p.hachage, heure: p.heure, type: p.type, route: p.route, de: p.de, dePrefixe: p.de_prefixe, versPrefixe: p.vers_prefixe,
      canal: p.canal, expediteur: membre ? p.expediteur : (p.expediteur ? '…' : null), texte: membre ? p.texte : undefined, resume: membre ? p.resume : String(p.resume || '').replace(/ · .*$/, ''),
      taille: p.taille, chemin: JSON.parse(p.chemin || '[]'), sauts: p.sauts, nbReceptions: p.nb_receptions, nbObservateurs: p.nb_observateurs, contenu,
    };
  }

  function paquets(limite, type, membre) {
    const l = type ? q.paquetsType.all(type, limite) : q.paquets.all(limite);
    return l.map((p) => preparerPaquet(p, membre));
  }

  function detailPaquet(id, membre) {
    const p = /^[0-9A-F]{16}$/i.test(String(id)) ? q.paquetHachage.get(String(id).toUpperCase()) : q.paquetRowid.get(Number(id));
    if (!p) return null;
    const d = preparerPaquet(p, membre);
    d.brut = p.brut;
    d.decode = decoderPaquet(p.brut, membre ? canaux : []);
    if (!membre && d.decode.contenu) { delete d.decode.contenu.texte; delete d.decode.contenu.expediteur; }
    d.receptions = q.receptionsPaquet.all(p.rowid).map((r) => {
      const o = q.noeud.get(r.observateur), ds = r.dernier_saut ? q.noeud.get(r.dernier_saut) : null;
      const chemin = JSON.parse(r.chemin || '[]');
      return { observateur: r.observateur, nomObservateur: o ? o.nom : null, heure: r.heure, snr: r.snr, rssi: r.rssi, chemin, dernierSaut: r.dernier_saut, nomDernierSaut: ds ? ds.nom : null, via: r.via,
        cheminResolu: resoudreChemin(chemin, p.de ? q.noeud.get(p.de) : null, o).map((n) => (n ? { cle: n.cle, nom: n.nom } : null)) };
    });
    return d;
  }

  let moi = null; // companion de la carte (pour reconnaître nos propres messages)
  function definirMoi(m) { moi = m; }
  function messages(limite) {
    return q.msgListe.all(limite).map((m) => ({
      id: m.id, heure: m.heure, sens: m.sens, genre: m.genre, canal: m.canal, indexCanal: m.index_canal, de: m.de, nomDe: m.nom_de || (m.de ? (q.noeud.get(m.de) || {}).nom : null),
      vers: m.vers, nomVers: m.nom_vers, texte: m.texte, sauts: m.sauts, snr: m.snr, statut: m.statut, relais: m.relais, auteur: m.auteur,
    }));
  }
  function noterMessage(m) {
    const r = q.msgInserer.run({ heure: Date.now(), sens: m.sens, genre: m.genre, canal: m.canal ?? null, indexCanal: m.indexCanal ?? null, de: m.de ?? null, nomDe: m.nomDe ?? null,
      vers: m.vers ?? null, nomVers: m.nomVers ?? null, texte: m.texte, sauts: m.sauts ?? null, snr: m.snr ?? null, statut: m.statut ?? null, ack: m.ack ?? null, auteur: m.auteur ?? null, hachage: m.hachage ?? null });
    return Number(r.lastInsertRowid);
  }
  const confirmerAck = (ack) => q.msgAck.run(ack, Date.now() - 30 * 60000).changes;
  const statutMessage = (id, statut) => q.msgStatut.run(statut, id);
  // Voisins déclarés par un répéteur (commande « neighbors ») : préfixe de clé + SNR mesuré par le répéteur
  function lierVoisins(cleRepeteur, voisins) {
    const rep = q.noeud.get(cleRepeteur);
    if (!rep) return [];
    const heure = Date.now();
    return voisins.map((v) => {
      const n = resoudre(v.prefixe, rep) || (v.prefixe.length >= 8 ? parPrefixe(v.prefixe.toUpperCase())[0] : null);
      if (n) lier(n, rep, 'voisinage', v.snr, null, heure);
      return { ...v, cle: n ? n.cle : null, nom: n ? n.nom : null, role: n ? n.role : null, distanceKm: n && n.lat != null && rep.lat != null ? Math.round(distanceKm(n, rep) * 10) / 10 : null };
    });
  }
  function definirCanaux(liste) { canaux = liste; }

  function purger(jours, joursPaquets = jours) {
    const limite = Date.now() - jours * 86400000;
    let n = 0;
    db.transaction(() => { for (const st of purges) n += st.run(limite).changes; })();
    invalider();
    purgerPaquets(Date.now() - Math.min(jours, joursPaquets) * 86400000);
    return n;
  }
  // Lots de 20 000 lignes, rendus à la boucle d'événements entre deux lots (la carte reste réactive)
  let purgeEnCours = false;
  function purgerPaquets(limite) {
    if (purgeEnCours) return;
    purgeEnCours = true;
    const lot = () => {
      let n = 0;
      try { for (const st of purgesPaquets) n += st.run(limite).changes; } catch { n = 0; }
      if (n > 0) setTimeout(lot, 200); else purgeEnCours = false;
    };
    lot();
  }

  // ---- Supervision : état des répéteurs, alertes, analyse du trafic ----
  function noterEtat(cle, st) {
    q.telInserer.run(cle, Date.now(), st.batterieMv ?? null, st.bruitDbm ?? null, st.occupationEmissionPct ?? null, st.recus ?? null, st.emis ?? null, st.allumeS ?? null, st.dernierSnr ?? null, st.fileEmission ?? null);
    q.vu.run({ cle, heure: Date.now(), sauts: null, snr: null, rssi: null });
  }
  const telemetrie = (cle, depuis) => q.telNoeud.all(cle, depuis);
  const dansZone = (n) => { const z = config.zone; return n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]; };
  // Répéteurs surveillés : ceux de la zone, plus ceux qu'on administre
  function surveilles(administres = []) {
    return noeudsCache().filter((n) => ['repeteur', 'salon'].includes(n.role) && (dansZone(n) || administres.includes(n.cle)));
  }
  const alertesActives = new Map();
  function calculerAlertes({ administres = [], companion = null } = {}) {
    const maintenant = Date.now(), s = config.seuils, nouvelles = new Map();
    const ajouter = (cle, a) => { const anc = alertesActives.get(cle); nouvelles.set(cle, { cle, depuis: anc ? anc.depuis : maintenant, ...a }); };
    const muetH = config.meshcore.muetHeures;
    const derniers = new Map(q.telDernier.all().map((t) => [t.cle, t]));
    for (const n of surveilles(administres)) {
      const nom = n.nom || n.cle.slice(0, 8);
      const ageH = (maintenant - (n.dernier_vu || 0)) / 3600000;
      if (ageH > muetH) ajouter('mc-muet:' + n.cle, { noeud: n.cle, type: 'muet', niveau: 'critique', nom, message: `Répéteur MeshCore ${nom} non entendu depuis ${ageH > 48 ? Math.round(ageH / 24) + ' jours' : Math.round(ageH) + ' h'}` });
      const t = derniers.get(n.cle);
      if (t && maintenant - t.heure < 24 * 3600000) {
        if (t.batterie_mv && t.batterie_mv / 1000 < s.tensionVolts) ajouter('mc-batt:' + n.cle, { noeud: n.cle, type: 'batterie', niveau: t.batterie_mv / 1000 < s.tensionVolts - 0.2 ? 'critique' : 'attention', nom, message: `Batterie faible sur ${nom} : ${(t.batterie_mv / 1000).toFixed(2)} V` });
        if (t.emission_pct != null && t.emission_pct >= s.emissionPourcent) ajouter('mc-tx:' + n.cle, { noeud: n.cle, type: 'emission', niveau: 'attention', nom, message: `${nom} émet ${t.emission_pct} % du temps depuis son démarrage (limite 10 %)` });
        if (t.bruit != null && t.bruit > -95) ajouter('mc-bruit:' + n.cle, { noeud: n.cle, type: 'bruit', niveau: 'attention', nom, message: `Bruit de fond élevé autour de ${nom} : ${t.bruit} dBm (brouillage ?)` });
      }
    }
    if (companion && companion.cible && !companion.connecte) ajouter('mc-companion', { noeud: companion.cle, type: 'companion', niveau: 'attention', nom: companion.nom || 'companion', message: `Companion MeshCore de la carte non relié${companion.erreur ? ' (' + companion.erreur + ')' : ''}` });
    alertesActives.clear();
    for (const [k, v] of nouvelles) alertesActives.set(k, v);
    const ordre = { critique: 0, attention: 1 };
    return [...alertesActives.values()].sort((a, b) => ordre[a.niveau] - ordre[b.niveau] || a.depuis - b.depuis);
  }

  // Analyse du trafic : types, émetteurs, sauts, observateurs, temps d'antenne estimé
  function analyse(heures, tempsEmission, zoneBbox = null) {
    const depuis = Date.now() - heures * 3600000;
    const zone = Array.isArray(zoneBbox) ? zoneBbox : zoneBbox ? config.zone : null;
    const z = zone || config.zone;
    // Zone : paquets entendus par au moins un observateur situé dans la zone
    const filtre = zone ? ` AND p.rowid IN (SELECT r.paquet FROM mc_receptions r JOIN mc_noeuds o ON o.cle = r.observateur WHERE r.heure >= @d AND o.lat BETWEEN ${z[0]} AND ${z[2]} AND o.lon BETWEEN ${z[1]} AND ${z[3]})` : '';
    const P = { d: depuis };
    const parType = db.prepare(`SELECT p.type, COUNT(*) AS nb, SUM(p.taille) AS octets, SUM(p.nb_receptions) AS receptions FROM mc_paquets p WHERE p.heure >= @d${filtre} GROUP BY p.type ORDER BY nb DESC`).all(P)
      .map((r) => ({ ...r, airtimeS: Math.round(r.nb * tempsEmission(Math.round((r.octets || 0) / Math.max(r.nb, 1)), 'MESHCORE_FR') * 10) / 10 }));
    const emetteurs = db.prepare(`SELECT p.de, n.nom, n.role, COUNT(*) AS nb, SUM(p.taille) AS octets, MIN(p.sauts) AS sauts_min,
        SUM(CASE WHEN p.type = 'ADVERT' THEN 1 ELSE 0 END) AS annonces
        FROM mc_paquets p LEFT JOIN mc_noeuds n ON n.cle = p.de WHERE p.heure >= @d AND p.de IS NOT NULL${filtre} GROUP BY p.de ORDER BY nb DESC LIMIT 40`).all(P);
    const sauts = db.prepare(`SELECT p.sauts, COUNT(*) AS nb FROM mc_paquets p WHERE p.heure >= @d AND p.sauts IS NOT NULL${filtre} GROUP BY p.sauts ORDER BY p.sauts`).all(P);
    const observateurs = db.prepare(`SELECT r.observateur, n.nom, COUNT(*) AS nb, ROUND(AVG(r.snr), 1) AS snr, MAX(r.heure) AS dernier
        FROM mc_receptions r LEFT JOIN mc_noeuds n ON n.cle = r.observateur WHERE r.heure >= @d${zone ? ` AND n.lat BETWEEN ${z[0]} AND ${z[2]} AND n.lon BETWEEN ${z[1]} AND ${z[3]}` : ''} GROUP BY r.observateur ORDER BY nb DESC LIMIT 40`).all(P);
    const relais = new Map();
    for (const r of db.prepare(`SELECT p.chemin FROM mc_paquets p WHERE p.heure >= @d AND p.sauts > 0${filtre}`).all(P)) for (const h of JSON.parse(r.chemin || '[]')) relais.set(h, (relais.get(h) || 0) + 1);
    const cache = noeudsCache();
    const topRelais = [...relais.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([h, nb]) => {
      let c = cache.filter((n) => n.cle.startsWith(h) && ['repeteur', 'salon'].includes(n.role));
      if (zone && c.length > 1) { const cz = c.filter(dansZone); if (cz.length) c = cz; }
      return { prefixe: h, nb, candidats: c.slice(0, 3).map((n) => ({ cle: n.cle, nom: n.nom })) };
    });
    const parHeure = db.prepare(`SELECT (p.heure / 3600000) * 3600000 AS h, COUNT(*) AS nb FROM mc_paquets p WHERE p.heure >= @d${filtre} GROUP BY p.heure / 3600000 ORDER BY h`).all(P);
    const total = parType.reduce((t, r) => t + r.nb, 0), air = parType.reduce((t, r) => t + r.airtimeS, 0);
    return { heures, zone, total, airtimeS: Math.round(air), occupationPct: Math.round((air / (heures * 3600)) * 1000) / 10, parType, emetteurs, sauts, observateurs, topRelais, parHeure };
  }

  return { noterEtat, telemetrie, calculerAlertes, analyse, surveilles, integrer, importerContact, noterObservateur, vueNoeud, liens, statistiques, detailNoeud, paquets, detailPaquet, messages, noterMessage, confirmerAck, statutMessage, lierVoisins, definirCanaux, definirMoi, canaux: () => canaux, purger, q, resoudreChemin };
}

module.exports = { creerReseauMc };
