'use strict';
// Stockage SQLite : nœuds, paquets, réceptions, télémétrie, positions, liens. Rétention configurable.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { performance } = require('perf_hooks');
const { noter: noterTache } = require('./sante-carte');

function ouvrirBase(fichier) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const db = new Database(fichier);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS noeuds (
      num INTEGER PRIMARY KEY,
      id TEXT, nom_long TEXT, nom_court TEXT, materiel TEXT, role TEXT, firmware TEXT, preset TEXT,
      lat REAL, lon REAL, alt REAL, precision_bits INTEGER, heure_position INTEGER,
      premier_vu INTEGER, dernier_vu INTEGER,
      batterie REAL, tension REAL, canal REAL, emission REAL, uptime INTEGER, heure_telemetrie INTEGER,
      temperature REAL, humidite REAL, pression REAL,
      sauts_min INTEGER, sauts_dernier INTEGER, snr_dernier REAL, rssi_dernier REAL,
      est_passerelle INTEGER DEFAULT 0, etat_passerelle TEXT, heure_etat_passerelle INTEGER,
      dernier_vu_passerelle INTEGER,
      stats_locales TEXT
    );
    CREATE TABLE IF NOT EXISTS paquets (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id_paquet INTEGER, de INTEGER, vers INTEGER, canal TEXT, port TEXT, nom_port TEXT, portnum INTEGER,
      heure INTEGER, hop_depart INTEGER, hop_restant INTEGER, sauts INTEGER, dechiffre INTEGER,
      resume TEXT, texte TEXT, nb_receptions INTEGER DEFAULT 1,
      UNIQUE(de, id_paquet)
    );
    CREATE INDEX IF NOT EXISTS idx_paquets_heure ON paquets(heure);
    CREATE INDEX IF NOT EXISTS idx_paquets_de ON paquets(de, heure);
    CREATE TABLE IF NOT EXISTS receptions (
      paquet INTEGER, passerelle INTEGER, heure INTEGER, snr REAL, rssi REAL, sauts INTEGER, relais INTEGER,
      PRIMARY KEY (paquet, passerelle)
    );
    CREATE INDEX IF NOT EXISTS idx_receptions_heure ON receptions(heure);
    CREATE TABLE IF NOT EXISTS telemetrie (
      num INTEGER, heure INTEGER, batterie REAL, tension REAL, canal REAL, emission REAL,
      temperature REAL, humidite REAL, pression REAL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetrie ON telemetrie(num, heure);
    CREATE TABLE IF NOT EXISTS positions (num INTEGER, heure INTEGER, lat REAL, lon REAL, alt REAL);
    CREATE INDEX IF NOT EXISTS idx_positions ON positions(num, heure);
    -- lien orienté : "b" a entendu "a" directement (source : rf, voisinage, traceroute)
    CREATE TABLE IF NOT EXISTS liens (
      a INTEGER, b INTEGER, source TEXT, snr REAL, rssi REAL, nb INTEGER DEFAULT 1,
      premier_vu INTEGER, dernier_vu INTEGER,
      PRIMARY KEY (a, b, source)
    );
    CREATE INDEX IF NOT EXISTS idx_liens_heure ON liens(dernier_vu);
    CREATE TABLE IF NOT EXISTS traceroutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_paquet INTEGER, origine INTEGER, cible INTEGER, heure INTEGER, statut TEXT, declencheur TEXT,
      aller TEXT, snr_aller TEXT, retour TEXT, snr_retour TEXT, duree INTEGER, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traceroutes ON traceroutes(cible, heure);
  `);
  // Migrations douces (colonnes ajoutées après la première version)
  const colonnes = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const ajouter = (table, col, type) => { if (!colonnes(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };
  ajouter('paquets', 'signe', 'INTEGER'); // firmware 2.8 : signature de l'expéditeur vérifiée
  ajouter('paquets', 'signature', 'INTEGER'); // vérification par la carte : 2 valide, 1 clé de l'expéditeur inconnue, -1 invalide
  ajouter('paquets', 'taille', 'INTEGER');
  ajouter('paquets', 'via_mqtt', 'INTEGER');
  ajouter('receptions', 'relais_num', 'INTEGER');
  ajouter('telemetrie', 'uptime', 'INTEGER');
  ajouter('paquets', 'contenu', 'TEXT');
  ajouter('paquets', 'pki', 'INTEGER');
  ajouter('receptions', 'sujet', 'TEXT');
  ajouter('noeuds', 'cle_publique', 'TEXT');
  ajouter('noeuds', 'licencie', 'INTEGER'); // mode licencié (radioamateur) : pas de chiffrement, indicatif comme nom
  db.exec('CREATE INDEX IF NOT EXISTS idx_noeuds_cle ON noeuds(cle_publique)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_paquets_vers ON paquets(vers, heure)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_receptions_gw ON receptions(passerelle, heure)');
  // Liens d'un nœud dans les deux sens (« a = ? OR b = ? ») : sans cet index, toute la table était lue à chaque fois
  db.exec('CREATE INDEX IF NOT EXISTS idx_liens_b ON liens(b)');
  // Purge horaire : « heure < limite » sur telemetrie/positions/traceroutes n'avait que des index (num, heure) ou
  // (cible, heure), donc chaque lot de 250 lignes relisait toute la table. Créés une seule fois (quelques secondes
  // sur une grosse base existante), puis la purge ne lit que les lignes à supprimer.
  db.exec('CREATE INDEX IF NOT EXISTS idx_telemetrie_heure ON telemetrie(heure)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_positions_heure ON positions(heure)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_traceroutes_heure ON traceroutes(heure)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_noeuds_dernier_vu ON noeuds(dernier_vu)');
  // Horloge de modification des nœuds (liste incrémentale ?depuis=) : « modifie » est l'heure serveur de la dernière
  // écriture, quelle qu'elle soit (synchronisation d'un module radio ou de MeshMonitor qui écrivent l'heure du module,
  // positions annulées par nettoyer(), renumérotation, presets…). Tenue par des déclencheurs : aucune écriture ne peut
  // l'oublier. Les suppressions (purge, administrateur, renumérotation) sont notées dans noeuds_supprimes.
  const nouvelleColonne = !colonnes('noeuds').includes('modifie');
  ajouter('noeuds', 'modifie', 'INTEGER');
  if (nouvelleColonne) db.exec('UPDATE noeuds SET modifie = dernier_vu'); // base existante : repère de départ
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_noeuds_modifie ON noeuds(modifie);
    CREATE TABLE IF NOT EXISTS noeuds_supprimes (num INTEGER PRIMARY KEY, heure INTEGER);
    CREATE TRIGGER IF NOT EXISTS trg_noeuds_ins AFTER INSERT ON noeuds BEGIN
      UPDATE noeuds SET modifie = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE num = NEW.num;
      DELETE FROM noeuds_supprimes WHERE num = NEW.num;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_noeuds_maj AFTER UPDATE ON noeuds WHEN NEW.modifie IS OLD.modifie BEGIN
      UPDATE noeuds SET modifie = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE num = NEW.num;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_noeuds_del AFTER DELETE ON noeuds BEGIN
      INSERT OR REPLACE INTO noeuds_supprimes (num, heure) VALUES (OLD.num, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
    END;
  `);
  return db;
}

// Lecture de toutes les fiches de nœuds (des milliers avec le flux msh/EU_868) : lignes brutes transformées par un
// constructeur de forme fixe, deux à trois fois plus rapide que des objets remplis champ par champ par SQLite, et
// des objets plus rapides à parcourir ensuite. Reconstruit si les colonnes changent (migration).
function lectureRapide(st) {
  st.raw(true);
  let cles = '', construire = null;
  return {
    source: st.source,
    all(...params) {
      const cols = st.columns().map((c) => c.name);
      const k = cols.join(',');
      if (k !== cles) { cles = k; construire = new Function('r', `return {${cols.map((c, i) => `${JSON.stringify(c)}: r[${i}]`).join(', ')}};`); }
      return st.all(...params).map(construire);
    },
  };
}

function creerStockage(fichier) {
  const db = ouvrirBase(fichier);

  const q = {
    noeud: db.prepare('SELECT * FROM noeuds WHERE num = ?'),
    creerNoeud: db.prepare('INSERT OR IGNORE INTO noeuds (num, id, premier_vu, dernier_vu) VALUES (?, ?, ?, ?)'),
    vu: db.prepare(`UPDATE noeuds SET dernier_vu = MAX(COALESCE(dernier_vu,0), @heure),
        sauts_dernier = COALESCE(@sauts, sauts_dernier),
        sauts_min = CASE WHEN @sauts IS NULL THEN sauts_min WHEN sauts_min IS NULL OR @sauts < sauts_min THEN @sauts ELSE sauts_min END,
        snr_dernier = COALESCE(@snr, snr_dernier), rssi_dernier = COALESCE(@rssi, rssi_dernier)
        WHERE num = @num`),
    infos: db.prepare(`UPDATE noeuds SET nom_long = COALESCE(@nomLong, nom_long), nom_court = COALESCE(@nomCourt, nom_court),
        materiel = COALESCE(@materiel, materiel), role = COALESCE(@role, role),
        firmware = COALESCE(@firmware, firmware), preset = COALESCE(@preset, preset) WHERE num = @num`),
    position: db.prepare(`UPDATE noeuds SET lat=@lat, lon=@lon, alt=@alt, precision_bits=@precision, heure_position=@heure WHERE num=@num`),
    histoPosition: db.prepare('INSERT INTO positions (num, heure, lat, lon, alt) VALUES (?, ?, ?, ?, ?)'),
    derniereHistoPosition: db.prepare('SELECT lat, lon FROM positions WHERE num = ? ORDER BY heure DESC LIMIT 1'),
    telemetrie: db.prepare(`UPDATE noeuds SET batterie=COALESCE(@batterie,batterie), tension=COALESCE(@tension,tension),
        canal=COALESCE(@canal,canal), emission=COALESCE(@emission,emission), uptime=COALESCE(@uptime,uptime),
        heure_telemetrie=@heure WHERE num=@num`),
    environnement: db.prepare(`UPDATE noeuds SET temperature=COALESCE(@temperature,temperature),
        humidite=COALESCE(@humidite,humidite), pression=COALESCE(@pression,pression) WHERE num=@num`),
    statsLocales: db.prepare('UPDATE noeuds SET stats_locales = ? WHERE num = ?'),
    histoTelemetrie: db.prepare(`INSERT INTO telemetrie (num, heure, batterie, tension, canal, emission, temperature, humidite, pression, uptime)
        VALUES (@num, @heure, @batterie, @tension, @canal, @emission, @temperature, @humidite, @pression, @uptime)`),
    passerelle: db.prepare('UPDATE noeuds SET est_passerelle = 1, dernier_vu_passerelle = MAX(COALESCE(dernier_vu_passerelle,0), ?) WHERE num = ?'),
    etatPasserelle: db.prepare('UPDATE noeuds SET est_passerelle = 1, etat_passerelle = ?, heure_etat_passerelle = ? WHERE num = ?'),
    insererPaquet: db.prepare(`INSERT INTO paquets (id_paquet, de, vers, canal, port, nom_port, portnum, heure, hop_depart, hop_restant, sauts, dechiffre, resume, texte, taille, via_mqtt, contenu, pki, signe, signature)
        VALUES (@idPaquet, @de, @vers, @canal, @port, @nomPort, @portnum, @heure, @hopDepart, @hopRestant, @sauts, @dechiffre, @resume, @texte, @taille, @viaMqtt, @contenu, @pki, @signe, @signature)
        ON CONFLICT(de, id_paquet) DO UPDATE SET nb_receptions = nb_receptions + 1, signe = MAX(COALESCE(paquets.signe, 0), COALESCE(excluded.signe, 0)),
          signature = CASE WHEN paquets.signature IS NULL OR (paquets.signature = 1 AND excluded.signature IS NOT NULL) THEN excluded.signature ELSE paquets.signature END,
          sauts = CASE WHEN excluded.sauts IS NOT NULL AND (paquets.sauts IS NULL OR excluded.sauts < paquets.sauts) THEN excluded.sauts ELSE paquets.sauts END
        RETURNING rowid, nb_receptions`),
    reception: db.prepare(`INSERT OR REPLACE INTO receptions (paquet, passerelle, heure, snr, rssi, sauts, relais, relais_num, sujet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    lien: db.prepare(`INSERT INTO liens (a, b, source, snr, rssi, nb, premier_vu, dernier_vu) VALUES (@a, @b, @source, @snr, @rssi, 1, @heure, @heure)
        ON CONFLICT(a, b, source) DO UPDATE SET
          snr = CASE WHEN excluded.snr IS NULL THEN liens.snr WHEN liens.snr IS NULL THEN excluded.snr ELSE ROUND(liens.snr * 0.7 + excluded.snr * 0.3, 2) END,
          rssi = CASE WHEN excluded.rssi IS NULL THEN liens.rssi WHEN liens.rssi IS NULL THEN excluded.rssi ELSE ROUND(liens.rssi * 0.7 + excluded.rssi * 0.3, 1) END,
          nb = liens.nb + 1, dernier_vu = MAX(liens.dernier_vu, excluded.dernier_vu)`),
    noeuds: lectureRapide(db.prepare('SELECT * FROM noeuds ORDER BY dernier_vu DESC')),
    licencie: db.prepare('UPDATE noeuds SET licencie = ? WHERE num = ?'),
    clePublique: db.prepare('UPDATE noeuds SET cle_publique = ? WHERE num = ? AND cle_publique IS NOT ?'),
    liens: db.prepare('SELECT * FROM liens WHERE dernier_vu >= ?'),
    paquetsRecents: db.prepare(`SELECT p.*, (SELECT json_group_array(json_object('passerelle', r.passerelle, 'snr', r.snr, 'rssi', r.rssi, 'sauts', r.sauts))
        FROM receptions r WHERE r.paquet = p.rowid) AS receptions FROM paquets p ORDER BY p.heure DESC LIMIT ?`),
    histoTelemetrieNoeud: db.prepare('SELECT heure, batterie, tension, canal, emission, temperature FROM telemetrie WHERE num = ? AND heure >= ? ORDER BY heure'),
    histoPositionsNoeud: db.prepare('SELECT heure, lat, lon, alt FROM positions WHERE num = ? AND heure >= ? ORDER BY heure'),
    paquetsNoeud: db.prepare('SELECT * FROM paquets WHERE de = ? ORDER BY heure DESC LIMIT ?'),
    receptionsNoeud: db.prepare(`SELECT r.passerelle, COUNT(*) AS nb, AVG(r.snr) AS snr, AVG(r.rssi) AS rssi, MIN(r.sauts) AS sauts_min, MAX(r.heure) AS dernier
        FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = ? AND r.heure >= ? GROUP BY r.passerelle ORDER BY nb DESC`),
    tension24h: db.prepare('SELECT MIN(tension) AS min, MAX(tension) AS max, COUNT(tension) AS nb FROM telemetrie WHERE num = ? AND heure >= ? AND tension > 0'),
    compteParPort: db.prepare('SELECT port, COUNT(*) AS nb FROM paquets WHERE heure >= ? GROUP BY port'),
    compteMinute: db.prepare('SELECT COUNT(*) AS nb FROM paquets WHERE heure >= ?'),
    trInserer: db.prepare(`INSERT INTO traceroutes (id_paquet, origine, cible, heure, statut, declencheur) VALUES (?, ?, ?, ?, 'envoye', ?)`),
    trMaj: db.prepare(`UPDATE traceroutes SET statut=@statut, aller=@aller, snr_aller=@snrAller, retour=@retour, snr_retour=@snrRetour, duree=@duree, detail=@detail WHERE id_paquet=@idPaquet AND statut='envoye'`),
    trExpirer: db.prepare(`UPDATE traceroutes SET statut='sans_reponse' WHERE statut='envoye' AND heure < ?`),
    trNoeud: db.prepare('SELECT * FROM traceroutes WHERE cible = ? ORDER BY heure DESC LIMIT ?'),
    trRecents: db.prepare('SELECT * FROM traceroutes ORDER BY heure DESC LIMIT ?'),
    telemetrieUptime: db.prepare('SELECT heure, uptime, tension FROM telemetrie WHERE num = ? AND heure >= ? ORDER BY heure'),
    heuresActives: db.prepare(`SELECT COUNT(DISTINCT heure / 3600000) AS n FROM paquets WHERE de = ? AND heure >= ?`),
    rejeu: db.prepare(`SELECT p.de, p.port, p.heure, p.sauts, r.passerelle, r.relais_num AS relais, r.snr
        FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE r.heure >= ? AND r.heure < ? ORDER BY r.heure LIMIT 30000`),
    analyse: db.prepare(`SELECT de, port, COUNT(*) AS nb, SUM(COALESCE(taille, 0)) AS octets, MAX(hop_depart) AS hop_max,
        SUM(nb_receptions) AS receptions, SUM(CASE WHEN via_mqtt = 1 THEN 1 ELSE 0 END) AS via_mqtt
        FROM paquets WHERE heure >= ? GROUP BY de, port`),
    histoSauts: db.prepare(`SELECT sauts, COUNT(*) AS nb FROM paquets WHERE heure >= ? GROUP BY sauts`),
    histoCanaux: db.prepare(`SELECT canal, COUNT(*) AS nb, SUM(dechiffre) AS dechiffres FROM paquets WHERE heure >= ? GROUP BY canal ORDER BY nb DESC`),
    positionsNoeud24h: db.prepare('SELECT lat, lon FROM positions WHERE num = ? AND heure >= ?'),
    messages: db.prepare(`SELECT p.rowid, p.de, p.vers, p.canal, p.heure, p.texte, p.sauts, p.via_mqtt AS viaMqtt,
        (SELECT COUNT(*) FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%') AS radio,
        (SELECT r.snr FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%' LIMIT 1) AS snrRadio,
        (SELECT r.sauts FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%' LIMIT 1) AS sautsRadio,
        (SELECT COUNT(*) FROM receptions r WHERE r.paquet = p.rowid AND (r.sujet IS NULL OR r.sujet NOT LIKE 'radio%')) AS mqtt,
        p.id_paquet AS idPaquet,
        (SELECT json_group_array(json_object('g', r.passerelle, 's', r.sauts, 'snr', r.snr, 'rel', r.relais_num, 'h', r.heure))
          FROM receptions r WHERE r.paquet = p.rowid AND r.passerelle <> p.de) AS entendus
      FROM paquets p WHERE p.port = 'texte' ORDER BY p.heure DESC LIMIT ?`),
    // Historique d'un seul canal (diffusion) ou des seuls messages directs : un canal calme n'est pas noyé par les bavards
    messagesCanal: db.prepare(`SELECT p.rowid, p.de, p.vers, p.canal, p.heure, p.texte, p.sauts, p.via_mqtt AS viaMqtt,
        (SELECT COUNT(*) FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%') AS radio,
        (SELECT r.snr FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%' LIMIT 1) AS snrRadio,
        (SELECT r.sauts FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%' LIMIT 1) AS sautsRadio,
        (SELECT COUNT(*) FROM receptions r WHERE r.paquet = p.rowid AND (r.sujet IS NULL OR r.sujet NOT LIKE 'radio%')) AS mqtt,
        p.id_paquet AS idPaquet,
        (SELECT json_group_array(json_object('g', r.passerelle, 's', r.sauts, 'snr', r.snr, 'rel', r.relais_num, 'h', r.heure))
          FROM receptions r WHERE r.paquet = p.rowid AND r.passerelle <> p.de) AS entendus
      FROM paquets p WHERE p.port = 'texte' AND p.canal = ? AND p.vers = 4294967295 ORDER BY p.heure DESC LIMIT ?`),
    messagesDirects: db.prepare(`SELECT p.rowid, p.de, p.vers, p.canal, p.heure, p.texte, p.sauts, p.via_mqtt AS viaMqtt,
        (SELECT COUNT(*) FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%') AS radio,
        (SELECT r.snr FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%' LIMIT 1) AS snrRadio,
        (SELECT r.sauts FROM receptions r WHERE r.paquet = p.rowid AND r.sujet LIKE 'radio%' LIMIT 1) AS sautsRadio,
        (SELECT COUNT(*) FROM receptions r WHERE r.paquet = p.rowid AND (r.sujet IS NULL OR r.sujet NOT LIKE 'radio%')) AS mqtt,
        p.id_paquet AS idPaquet,
        (SELECT json_group_array(json_object('g', r.passerelle, 's', r.sauts, 'snr', r.snr, 'rel', r.relais_num, 'h', r.heure))
          FROM receptions r WHERE r.paquet = p.rowid AND r.passerelle <> p.de) AS entendus
      FROM paquets p WHERE p.port = 'texte' AND p.vers <> 4294967295 ORDER BY p.heure DESC LIMIT ?`),
  };

  // Purge par petits lots (250 lignes), avec une pause entre deux lots : un seul gros DELETE sur une base de
  // plusieurs centaines de Mo (flux msh/EU_868) bloquait la carte plusieurs secondes chaque heure.
  // Chaque requête prend ses paramètres (limite générale, limite des messages) et supprime au plus un lot.
  // Les messages texte suivent leur propre durée (MESSAGES_RETENTION_JOURS, 90 jours), le reste du trafic
  // RETENTION_JOURS (7 jours). Une seule requête « heure < limite AND (non texte OR heure < limiteMessages) »
  // relisait à chaque lot tous les textes conservés avant d'atteindre les lignes à supprimer (mesuré : 213 lots
  // × 26 ms sur 200 000 textes). D'où deux requêtes : tout ce qui précède la limite des messages, puis les non-textes
  // à partir d'un curseur avancé à l'heure de la dernière ligne supprimée (chaque texte n'est relu qu'une fois).
  const LOT_PURGE = 250;
  const purges = [
    ['paquets', db.prepare('DELETE FROM paquets WHERE rowid IN (SELECT rowid FROM paquets WHERE heure < @limiteMessages ORDER BY heure LIMIT @lot)')],
    ['paquets', db.prepare("DELETE FROM paquets WHERE rowid IN (SELECT rowid FROM paquets WHERE heure >= @curseur AND heure < @limite AND port IS NOT 'texte' ORDER BY heure LIMIT @lot) RETURNING heure"), 'curseur'],
    ['receptions', db.prepare('DELETE FROM receptions WHERE rowid IN (SELECT rowid FROM receptions WHERE heure < @limite LIMIT @lot)')],
    ['telemetrie', db.prepare('DELETE FROM telemetrie WHERE rowid IN (SELECT rowid FROM telemetrie WHERE heure < @limite LIMIT @lot)')],
    ['positions', db.prepare('DELETE FROM positions WHERE rowid IN (SELECT rowid FROM positions WHERE heure < @limite LIMIT @lot)')],
    ['liens', db.prepare('DELETE FROM liens WHERE rowid IN (SELECT rowid FROM liens WHERE dernier_vu < @limite LIMIT @lot)')],
    ['traceroutes', db.prepare('DELETE FROM traceroutes WHERE rowid IN (SELECT rowid FROM traceroutes WHERE heure < @limite LIMIT @lot)')],
    ['noeuds', db.prepare('DELETE FROM noeuds WHERE num IN (SELECT num FROM noeuds WHERE dernier_vu < @limite AND COALESCE(est_passerelle,0) = 0 LIMIT @lot)')],
  ];

  function assurerNoeud(num, heure) {
    q.creerNoeud.run(num, '!' + (num >>> 0).toString(16).padStart(8, '0'), heure, heure);
  }

  // Purge asynchrone : promesse du nombre de lignes supprimées. Un deuxième appel pendant une purge en cours
  // reçoit la même promesse (pas deux purges en parallèle).
  let purgeEnCours = null;
  const pause = () => new Promise((ok) => setImmediate(ok));
  function purger(retentionJours, retentionMessagesJours = retentionJours, { lot = LOT_PURGE } = {}) {
    if (purgeEnCours) return purgeEnCours;
    const p = { limite: Date.now() - retentionJours * 86400000, limiteMessages: Date.now() - Math.max(retentionMessagesJours, retentionJours) * 86400000, lot };
    purgeEnCours = (async () => {
      let n = 0;
      for (const [, st, mode] of purges) {
        // Curseur de la 2e requête « paquets » : heure de la dernière ligne supprimée (les lignes sont prises par heure
        // croissante, donc tout ce qui précède a déjà été traité ou est un texte à garder)
        let curseur = 0;
        for (;;) {
          let c = 0;
          const t0 = performance.now();
          try {
            if (mode === 'curseur') {
              const lignes = st.all({ limite: p.limite, lot, curseur });
              c = lignes.length;
              if (c) curseur = Math.max(curseur, ...lignes.map((l) => l.heure || 0));
            } else {
              c = st.run(st.source.includes('@limiteMessages') ? { limiteMessages: p.limiteMessages, lot } : { limite: p.limite, lot }).changes;
            }
          } catch (e) { if (/locked|busy/i.test(e.message)) { await new Promise((ok) => setTimeout(ok, 1000)); continue; } throw e; }
          n += c;
          noterTache('purge Meshtastic (un lot)', performance.now() - t0);
          await pause();
          if (c < lot) break;
        }
      }
      // Nœuds supprimés notés par le déclencheur : utiles 10 min (liste incrémentale), gardés une heure
      try { db.prepare('DELETE FROM noeuds_supprimes WHERE heure < ?').run(Date.now() - 3600000); } catch { /* base occupée */ }
      // Checkpoint passif (le journal WAL est recopié dans la base sans attendre) ; le fichier n'est tronqué que s'il a
      // beaucoup grossi, car la troncature recopie tout d'un coup
      try {
        const wal = fs.existsSync(fichier + '-wal') ? fs.statSync(fichier + '-wal').size : 0;
        db.pragma(wal > 64 * 1048576 ? 'wal_checkpoint(TRUNCATE)' : 'wal_checkpoint(PASSIVE)');
      } catch { /* base occupée : le checkpoint automatique s'en chargera */ }
      return n;
    })().finally(() => { purgeEnCours = null; });
    return purgeEnCours;
  }

  return { db, q, assurerNoeud, purger, transaction: (fn) => db.transaction(fn) };
}

module.exports = { creerStockage, lectureRapide };
