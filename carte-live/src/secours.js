'use strict';
// Espaces « Secours » : dispositifs prévisionnels de secours (DPS : festival, course, fête locale…) tenus par une
// association agréée de sécurité civile, et volet radio d'un plan communal de sauvegarde (PCS) tenu par une commune.
// Dans les deux cas : les interventions à faire sont pointées sur la carte, les équipes sont suivies en direct par
// le nœud LoRa qu'elles portent, et ce qui remonte du terrain par radio arrive dans la main courante.
//
// Cloisonnement — ces espaces n'ont rien de commun avec la section ADRASEC (réservée aux radioamateurs) ni avec le
// reste de la carte :
// - un espace = un fichier SQLite à lui (dossier secours/ des données) : ses comptes, ses équipes, ses interventions,
//   sa main courante. Rien n'est écrit dans la base de la carte ni dans adrasec.json, et inversement ;
// - ses comptes n'existent que dans son fichier : un secouriste ou un agent communal n'a pas de compte sur la carte,
//   donc aucun accès au réseau radio, à ses réglages ni à l'ADRASEC. Sa session est signée avec un secret propre à
//   l'espace : elle ne vaut ni pour la carte ni pour un autre espace ;
// - un espace ne voit du réseau que les nœuds que l'administrateur de la carte lui a attribués (position et messages
//   de ces nœuds-là, rien d'autre). Un nœud n'appartient qu'à un espace à la fois ;
// - l'administrateur de la carte crée l'espace, nomme son premier responsable et attribue les nœuds, mais n'entre
//   pas dedans : il ne lit ni les interventions ni la main courante.
// Les fichiers des espaces ne partent pas dans les sauvegardes de la carte (elles sont faites pour être copiées
// ailleurs) : chaque espace garde ses propres copies quotidiennes dans secours/copies/.
//
// Remontées par radio (messages texte d'un nœud attribué, porté par une équipe) :
//   « INTER chute au virage 4 »  crée une intervention à la position du nœud ;
//   « DISPO », « POSTE », « PAUSE », « INDISPO »  changent l'état de l'équipe ; « FIN » clôt son intervention en cours ;
//   tout autre message est noté dans la main courante.
// Envois vers le terrain (responsables et poste de coordination) : message direct au nœud d'une équipe, ou à chaque
// équipe l'une après l'autre ; une intervention s'envoie de la même façon (intitulé, position, code DFCI). Toujours
// en message direct, jamais sur un canal : un canal du module de la carte est lu par tout le réseau, et un point de
// passage diffusé s'afficherait sur la carte de tous. Le texte envoyé n'est pas recopié dans les messages de la carte.
//
// Organisations — dans un espace, plusieurs organisations peuvent travailler ensemble (Croix-Rouge et Protection
// Civile sur le même festival ; services techniques et réserve communale dans un PCS). C'est un rangement, pas une
// cloison : tout l'espace voit tout l'espace. Un nœud et une équipe peuvent être rattachés à une organisation.
// Nœuds en attente — un nœud pas encore allumé s'attribue par son nom court : il rejoint l'espace dès que la carte
// voit un nœud (un seul) portant ce nom.
// Options — chaque espace active ce dont il a besoin (messages-types, canal réservé, points de passage reçus,
// trajets, batterie des nœuds, alerte par e-mail, repères d'un PCS, priorités, rapport de fin, alerte radio).
// Ce que la carte reçoit des nœuds d'un espace (messages, points de passage) et tout ce qui passe sur son canal
// réservé va à l'espace et n'est pas montré aux membres de la carte (voir recu()).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { creerComptes } = require('./comptes');
const { versDfci } = require('../public/dfci.js');

const CODE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVES = new Set(['espaces', 'copies', 'corbeille', 'api', 'admin']);
const GENRES = {
  dps: {
    nom: 'Dispositif prévisionnel de secours',
    equipes: { poste: 'Poste de secours', binome: 'Équipe mobile', pc: 'Poste de coordination', vehicule: 'Véhicule' },
    organisations: [],
    macros: ['Rejoignez votre poste', 'Rendez compte de votre position', 'Renfort demandé, répondez si disponible', 'Fin du dispositif, retour au poste de coordination'],
    interventions: { malaise: 'Malaise', traumatisme: 'Chute ou traumatisme', plaie: 'Plaie ou brûlure', detresse: 'Détresse vitale', evacuation: 'Évacuation', renfort: 'Demande de renfort', autre: 'Autre' },
  },
  pcs: {
    nom: 'Plan communal de sauvegarde',
    equipes: { terrain: 'Équipe de terrain', pc: 'Poste de commandement communal', accueil: 'Centre d’accueil', vehicule: 'Véhicule' },
    organisations: ['Élus', 'Services techniques', 'Police municipale', 'Réserve communale de sécurité civile', 'CCAS', 'Sapeurs-pompiers'],
    macros: ['Rendez compte de votre position', 'Rejoignez le poste de commandement communal', 'Évacuation du secteur, rendez compte', 'Fin d’alerte, retour en mairie'],
    interventions: { personne: 'Personne isolée ou vulnérable', evacuation: 'Évacuation', route: 'Route coupée', inondation: 'Inondation', arbre: 'Arbre ou obstacle', reseau: 'Électricité, eau, téléphone', hebergement: 'Hébergement', materiel: 'Besoin de matériel', autre: 'Autre' },
  },
};
// Référentiel national des DPS : effectif de secouristes par catégorie (indicatif : le dimensionnement réel sort de
// la grille d'évaluation des risques de l'association)
const CATEGORIES_DPS = { paps: { nom: 'PAPS', min: 2, max: 2 }, pe: { nom: 'DPS-PE', min: 4, max: 12 }, me: { nom: 'DPS-ME', min: 12, max: 36 }, ge: { nom: 'DPS-GE', min: 37, max: null } };
const ETATS_EQUIPE = { disponible: 'Disponible', poste: 'En poste', intervention: 'En intervention', pause: 'En pause', indisponible: 'Indisponible' };
const STATUTS_INTER = ['a-faire', 'en-cours', 'terminee'];
const TYPES_MC = ['information', 'message-recu', 'message-emis', 'decision', 'mouvement', 'intervention', 'fin'];
const COULEURS = ['#ff8a1f', '#4cc9f0', '#b48cff', '#3ee68a', '#ff5c6c', '#ffd23f', '#e07bff', '#80ed99'];
const MOTS_RADIO = { DISPO: 'disponible', DISPONIBLE: 'disponible', POSTE: 'poste', PAUSE: 'pause', INDISPO: 'indisponible', INDISPONIBLE: 'indisponible' };
// Organisations proposées à la création (associations agréées de sécurité civile les plus courantes ; la liste des
// agréments varie selon le département : un nom libre reste possible). L'ADRASEC y figure comme participante d'un
// dispositif : cela n'ouvre rien de la section ADRASEC de la carte.
const ASSOCIATIONS = ['Croix-Rouge française', 'Protection Civile (ADPC, FNPC)', 'UDSP — sapeurs-pompiers', 'FFSS — sauvetage et secourisme', 'Croix-Blanche (SFCB)', 'SNSM', 'UNASS', 'Ordre de Malte France', 'Secouristes Sans Frontières', 'SAP — Secourir, Aider, Protéger', 'UMPS', 'UMIS', 'Terre Neuve', 'Action Prévention Alsace', 'ADRASEC'];
// Options activables par espace (genres : absents = DPS et PCS)
const OPTIONS = {
  macros: { nom: 'Messages-types', aide: 'Des messages prêts à envoyer au terrain d’un clic.', defaut: true },
  canal: { nom: 'Canal réservé', aide: '« Toutes les équipes » part en un seul message sur le canal que l’administrateur de la carte a réservé à l’espace.', defaut: true },
  points: { nom: 'Points de passage reçus', aide: 'Un point de passage envoyé par le nœud d’une équipe (application Meshtastic) crée une intervention.', defaut: true },
  trajets: { nom: 'Trajets des équipes', aide: 'Le chemin parcouru par le nœud d’une équipe se dessine sur la carte.', defaut: true },
  batterie: { nom: 'Batterie des nœuds', aide: 'Niveau de batterie du nœud de chaque équipe, signalé quand il est bas.', defaut: true },
  priorites: { nom: 'Priorités et tableau de bord', aide: 'Trois niveaux de priorité par intervention, et un résumé chiffré en tête de liste.', defaut: true },
  couches: { nom: 'Repères du PCS', aide: 'Zones à évacuer, centres d’accueil, points d’eau, accès des secours, dangers.', defaut: true, genres: ['pcs'] },
  rapport: { nom: 'Rapport de fin', aide: 'Un document figé : équipes, interventions, main courante et accusés radio.', defaut: true },
  alerteRadio: { nom: 'Alerte si la radio de la carte tombe', aide: 'Un bandeau et une entrée de main courante quand le module radio de la carte se déconnecte.', defaut: true },
  courriel: { nom: 'Alerte par e-mail', aide: 'Une intervention urgente est aussi envoyée par e-mail aux adresses choisies.', defaut: false },
};
// Repères posés sur la carte de l'espace. Le point de rassemblement existe partout ; les autres sont l'option
// « Repères du PCS ». surface : dessiné comme une zone (contour), sinon un point.
const REPERES = {
  rassemblement: { nom: 'Point de rassemblement', icone: '🟢' },
  zone: { nom: 'Zone à évacuer', icone: '⚠', surface: true, couches: true },
  accueil: { nom: 'Centre d’accueil ou d’hébergement', icone: '🏠', couches: true },
  eau: { nom: 'Point d’eau', icone: '💧', couches: true },
  acces: { nom: 'Accès des secours', icone: '🚒', couches: true },
  danger: { nom: 'Danger', icone: '⛔', couches: true },
};
const PRIORITES = { 1: 'Urgente', 2: 'Normale', 3: 'Peut attendre' };
// État apparent de la victime, tel qu'on le dit à la radio (DPS) : ni nom ni information médicale nominative
const ETATS_VICTIME = { consciente: 'consciente', 'inconsciente-respire': 'inconsciente, respire', 'ne-respire-pas': 'inconsciente, ne respire pas', saignement: 'saignement important', 'detresse-respiratoire': 'détresse respiratoire', inconnu: 'état inconnu' };
const COURRIELS_MAX = 5, COURRIELS_HEURE = 20;
const MEL = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,190}\.[a-z]{2,}$/i;
const COPIES_GARDEES = 7;
const ENVOIS_MAX = 30, ENVOIS_FENETRE = 10 * 60000; // messages radio par espace et par 10 minutes (temps d'antenne)
const ACCUSES = { envoye: 'envoyé', relaye: 'relayé', recu: 'reçu', echec: 'non remis' };
// Texte ramené à n octets (limite d'un message Meshtastic), sans couper un caractère en deux
function couper(t, n) { t = String(t || ''); while (Buffer.byteLength(t) > n) t = [...t].slice(0, -1).join(''); return t; }

const id = () => crypto.randomBytes(6).toString('hex');
const txt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const nombre = (v) => (v === null || v === '' || v === undefined ? null : Number(String(v).replace(',', '.')));
function position(b) {
  const lat = nombre(b.lat), lon = nombre(b.lon);
  if (lat == null && lon == null) return { lat: null, lon: null };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Position invalide');
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}
// Numéro de nœud Meshtastic : « !a1b2c3d4 », « a1b2c3d4 » ou nombre décimal
function numeroNoeud(v) {
  const t = String(v == null ? '' : v).trim();
  if (/^!?[0-9a-f]{8}$/i.test(t) && /[a-f!]/i.test(t)) return parseInt(t.replace('!', ''), 16) >>> 0;
  if (/^\d{1,10}$/.test(t) && Number(t) > 0 && Number(t) <= 0xffffffff) return Number(t) >>> 0;
  throw new Error(`Nœud invalide : ${t || '(vide)'} (attendu : !a1b2c3d4)`);
}
const idNoeud = (n) => '!' + (n >>> 0).toString(16).padStart(8, '0');

// ---- Un espace (un fichier) ------------------------------------------------------------------------------------
// creation : { genre, nom } à la création de l'espace (le type, DPS ou PCS, est fixé là et ne change plus : les listes
// d'équipes et d'interventions en dépendent)
function ouvrirEspace(fichier, code, ctx, creation = null) {
  const { journal, positionDe, nomDe, radio = null, espacement = 3000, santeDe = () => null, traceDe = () => [], courriel = null, radioTombee = () => false } = ctx;
  const db = new Database(fichier);
  try { fs.chmodSync(fichier, 0o600); } catch { /* système de fichiers sans chmod */ }
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT);
    CREATE TABLE IF NOT EXISTS noeuds (num INTEGER PRIMARY KEY, ajoute INTEGER, par TEXT);
    CREATE TABLE IF NOT EXISTS equipes (
      id TEXT PRIMARY KEY, nom TEXT NOT NULL, genre TEXT NOT NULL, lat REAL, lon REAL, effectif INTEGER,
      noeud INTEGER, couleur TEXT, etat TEXT NOT NULL DEFAULT 'disponible', etat_heure INTEGER, consigne TEXT, cree INTEGER
    );
    CREATE TABLE IF NOT EXISTS affectations (compte INTEGER PRIMARY KEY, equipe TEXT, fonction TEXT);
    CREATE TABLE IF NOT EXISTS interventions (
      id TEXT PRIMARY KEY, heure INTEGER NOT NULL, lat REAL, lon REAL, genre TEXT NOT NULL, titre TEXT NOT NULL, detail TEXT,
      urgente INTEGER NOT NULL DEFAULT 0, statut TEXT NOT NULL DEFAULT 'a-faire', equipe TEXT, auteur TEXT, origine TEXT,
      maj INTEGER, cloture INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_interventions_heure ON interventions(heure);
    CREATE TABLE IF NOT EXISTS main_courante (
      id TEXT PRIMARY KEY, heure INTEGER NOT NULL, auteur TEXT, type TEXT, equipe TEXT, intervention TEXT, texte TEXT NOT NULL, origine TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mc_heure ON main_courante(heure);
    CREATE TABLE IF NOT EXISTS organisations (id TEXT PRIMARY KEY, nom TEXT NOT NULL, couleur TEXT, cree INTEGER);
    CREATE TABLE IF NOT EXISTS attentes (cle TEXT PRIMARY KEY, nom TEXT NOT NULL, organisation TEXT, ajoute INTEGER, par TEXT);
    CREATE TABLE IF NOT EXISTS reperes (id TEXT PRIMARY KEY, genre TEXT NOT NULL, nom TEXT NOT NULL, detail TEXT, lat REAL, lon REAL, contour TEXT, cree INTEGER, auteur TEXT);
  `);
  // Colonnes venues après la première version (un espace créé avant les reçoit à l'ouverture)
  const colonne = (table, nom, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === nom)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${nom} ${type}`); };
  colonne('main_courante', 'envoi', 'INTEGER'); // numéro du paquet radio lié à l'entrée, pour suivre son accusé
  colonne('main_courante', 'accuse', 'TEXT'); // accusé retenu (il survit au redémarrage de la carte et au rapport de fin)
  colonne('noeuds', 'organisation', 'TEXT');
  colonne('equipes', 'organisation', 'TEXT');
  colonne('interventions', 'priorite', 'INTEGER');
  colonne('interventions', 'lieu', 'TEXT'); // lieu précis dit à la radio : repère du site, secteur, poste
  colonne('interventions', 'etat', 'TEXT'); // état apparent (DPS)
  colonne('interventions', 'point', 'INTEGER'); // identifiant du point de passage Meshtastic qui l'a créée
  db.exec('UPDATE interventions SET priorite = CASE WHEN urgente = 1 THEN 1 ELSE 2 END WHERE priorite IS NULL');
  const q = {
    reglage: db.prepare('SELECT valeur FROM reglages WHERE cle = ?'),
    ecrireReglage: db.prepare('INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur'),
    noeuds: db.prepare('SELECT num, ajoute, par, organisation FROM noeuds ORDER BY num'),
    noeud: db.prepare('SELECT num, organisation FROM noeuds WHERE num = ?'),
    rangerNoeud: db.prepare('UPDATE noeuds SET organisation = ? WHERE num = ?'),
    organisations: db.prepare('SELECT * FROM organisations ORDER BY cree'),
    organisation: db.prepare('SELECT * FROM organisations WHERE id = ?'),
    ecrireOrganisation: db.prepare('INSERT INTO organisations (id, nom, couleur, cree) VALUES (@id, @nom, @couleur, @cree) ON CONFLICT(id) DO UPDATE SET nom = excluded.nom, couleur = excluded.couleur'),
    supprimerOrganisation: db.prepare('DELETE FROM organisations WHERE id = ?'),
    attentes: db.prepare('SELECT * FROM attentes ORDER BY ajoute'),
    attendre: db.prepare('INSERT INTO attentes (cle, nom, organisation, ajoute, par) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cle) DO UPDATE SET organisation = excluded.organisation'),
    retirerAttente: db.prepare('DELETE FROM attentes WHERE cle = ?'),
    reperes: db.prepare('SELECT * FROM reperes ORDER BY cree'),
    repere: db.prepare('SELECT * FROM reperes WHERE id = ?'),
    ecrireRepere: db.prepare('INSERT INTO reperes (id, genre, nom, detail, lat, lon, contour, cree, auteur) VALUES (@id, @genre, @nom, @detail, @lat, @lon, @contour, @cree, @auteur) ON CONFLICT(id) DO UPDATE SET genre = excluded.genre, nom = excluded.nom, detail = excluded.detail, lat = excluded.lat, lon = excluded.lon, contour = excluded.contour'),
    supprimerRepere: db.prepare('DELETE FROM reperes WHERE id = ?'),
    ajouterNoeud: db.prepare('INSERT OR IGNORE INTO noeuds (num, ajoute, par) VALUES (?, ?, ?)'),
    retirerNoeud: db.prepare('DELETE FROM noeuds WHERE num = ?'),
    equipes: db.prepare('SELECT * FROM equipes ORDER BY cree'),
    equipe: db.prepare('SELECT * FROM equipes WHERE id = ?'),
    equipeDuNoeud: db.prepare('SELECT * FROM equipes WHERE noeud = ?'),
    creerEquipe: db.prepare('INSERT INTO equipes (id, nom, genre, lat, lon, effectif, noeud, couleur, etat, etat_heure, consigne, cree, organisation) VALUES (@id, @nom, @genre, @lat, @lon, @effectif, @noeud, @couleur, @etat, @etat_heure, @consigne, @cree, @organisation)'),
    majEquipe: db.prepare('UPDATE equipes SET nom=@nom, genre=@genre, lat=@lat, lon=@lon, effectif=@effectif, noeud=@noeud, couleur=@couleur, consigne=@consigne, organisation=@organisation WHERE id=@id'),
    etatEquipe: db.prepare('UPDATE equipes SET etat = ?, etat_heure = ? WHERE id = ?'),
    supprimerEquipe: db.prepare('DELETE FROM equipes WHERE id = ?'),
    libererNoeud: db.prepare('UPDATE equipes SET noeud = NULL WHERE noeud = ?'),
    affectations: db.prepare('SELECT compte, equipe, fonction FROM affectations'),
    affecter: db.prepare('INSERT INTO affectations (compte, equipe, fonction) VALUES (?, ?, ?) ON CONFLICT(compte) DO UPDATE SET equipe = excluded.equipe, fonction = excluded.fonction'),
    affectation: db.prepare('SELECT equipe, fonction FROM affectations WHERE compte = ?'),
    retirerAffectation: db.prepare('DELETE FROM affectations WHERE compte = ?'),
    detacherEquipe: db.prepare('UPDATE affectations SET equipe = NULL WHERE equipe = ?'),
    interventions: db.prepare("SELECT * FROM interventions WHERE statut <> 'terminee' OR cloture >= ? ORDER BY heure DESC LIMIT 500"),
    intervention: db.prepare('SELECT * FROM interventions WHERE id = ?'),
    interventionEnCours: db.prepare("SELECT * FROM interventions WHERE equipe = ? AND statut = 'en-cours' ORDER BY maj DESC LIMIT 1"),
    creerIntervention: db.prepare('INSERT INTO interventions (id, heure, lat, lon, genre, titre, detail, urgente, statut, equipe, auteur, origine, maj, cloture, priorite, point, lieu, etat) VALUES (@id, @heure, @lat, @lon, @genre, @titre, @detail, @urgente, @statut, @equipe, @auteur, @origine, @maj, @cloture, @priorite, @point, @lieu, @etat)'),
    majIntervention: db.prepare('UPDATE interventions SET lat=@lat, lon=@lon, genre=@genre, titre=@titre, detail=@detail, urgente=@urgente, statut=@statut, equipe=@equipe, maj=@maj, cloture=@cloture, priorite=@priorite, lieu=@lieu, etat=@etat WHERE id=@id'),
    detacherInterventions: db.prepare('UPDATE interventions SET equipe = NULL WHERE equipe = ?'),
    mainCourante: db.prepare('SELECT * FROM main_courante ORDER BY heure DESC LIMIT ?'),
    touteMainCourante: db.prepare('SELECT * FROM main_courante ORDER BY heure'),
    ajouterMc: db.prepare('INSERT INTO main_courante (id, heure, auteur, type, equipe, intervention, texte, origine, envoi) VALUES (@id, @heure, @auteur, @type, @equipe, @intervention, @texte, @origine, @envoi)'),
    purgerMc: db.prepare('DELETE FROM main_courante WHERE heure < ?'),
    noterAccuse: db.prepare('UPDATE main_courante SET accuse = ? WHERE id = ?'),
    interventionDuPoint: db.prepare('SELECT * FROM interventions WHERE point = ? ORDER BY heure DESC LIMIT 1'),
    toutesInterventions: db.prepare('SELECT * FROM interventions ORDER BY heure'),
    detacherOrgNoeuds: db.prepare('UPDATE noeuds SET organisation = NULL WHERE organisation = ?'),
    detacherOrgEquipes: db.prepare('UPDATE equipes SET organisation = NULL WHERE organisation = ?'),
    detacherOrgAttentes: db.prepare('UPDATE attentes SET organisation = NULL WHERE organisation = ?'),
    purgerInterventions: db.prepare("DELETE FROM interventions WHERE statut = 'terminee' AND cloture < ?"),
  };
  const lire = (cle, defaut = null) => { const r = q.reglage.get(cle); return r ? r.valeur : defaut; };
  const ecrire = (cle, v) => q.ecrireReglage.run(cle, v == null ? null : String(v));
  // Secret de session propre à l'espace, gardé dans son fichier : une session de la carte ou d'un autre espace,
  // signée avec un autre secret, n'est jamais acceptée ici
  if (creation) { ecrire('genre', creation.genre); ecrire('nom', creation.nom); ecrire('cree', Date.now()); }
  let secret = lire('secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); ecrire('secret', secret); }
  const comptes = creerComptes(db, { admin: { secret }, fichierBase: fichier, carte: { titre: lire('nom', code) } });
  q.compter = db.prepare('SELECT (SELECT COUNT(*) FROM comptes) AS comptes, (SELECT COUNT(*) FROM noeuds) AS noeuds, (SELECT COUNT(*) FROM equipes) AS equipes');

  const genre = () => (GENRES[lire('genre')] ? lire('genre') : 'dps');
  const G = () => GENRES[genre()];
  // Compteur de modifications : la page ne recharge l'état que s'il a bougé (rien d'écrit : il repart de l'heure du
  // démarrage, donc jamais d'un nombre déjà vu par une page restée ouverte)
  let rev = Date.now();
  const touche = () => { rev++; };

  function decrire() {
    const n = q.compter.get();
    return { code, nom: lire('nom', code), genre: genre(), cree: Number(lire('cree')) || null, comptes: n.comptes, noeuds: n.noeuds, equipes: n.equipes };
  }
  const evenement = () => ({ lieu: lire('lieu'), debut: Number(lire('debut')) || null, fin: Number(lire('fin')) || null, publicAttendu: Number(lire('public')) || null, categorie: CATEGORIES_DPS[lire('categorie')] ? lire('categorie') : null });
  function centre() {
    const lat = Number(lire('centreLat')), lon = Number(lire('centreLon'));
    return lire('centreLat') != null && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, zoom: Number(lire('centreZoom')) || 14 } : null;
  }

  // ---- Options de l'espace, messages-types, adresses d'alerte -------------------------------------------------------
  const json = (cle, defaut) => { try { const v = JSON.parse(lire(cle) || 'null'); return v == null ? defaut : v; } catch { return defaut; } };
  const optionsDuGenre = () => Object.entries(OPTIONS).filter(([, o]) => !o.genres || o.genres.includes(genre()));
  function options() { const v = json('options', {}); return Object.fromEntries(optionsDuGenre().map(([k, o]) => [k, typeof v[k] === 'boolean' ? v[k] : o.defaut])); }
  const option = (k) => !!options()[k];
  const macros = () => { const v = json('macros', null); return Array.isArray(v) ? v : G().macros; };
  const courriels = () => { const v = json('courriels', []); return Array.isArray(v) ? v : []; };
  // Canal du module de la carte réservé à l'espace par l'administrateur de la carte (son nom) ; utilisable s'il
  // existe encore sur le module
  const canalAttribue = () => lire('canal') || null;
  function canalReserve() {
    const nom = canalAttribue();
    if (!nom || !radio || !radio.canaux) return null;
    try { return radio.canaux().find((c) => c.index > 0 && String(c.nom || '').toLowerCase() === nom.toLowerCase()) || null; } catch { return null; }
  }

  function reglages(b) {
    if (b.options !== undefined) {
      const v = json('options', {});
      for (const [k] of optionsDuGenre()) if (typeof (b.options || {})[k] === 'boolean') v[k] = b.options[k];
      ecrire('options', JSON.stringify(v));
    }
    if (b.macros !== undefined) {
      const l = (Array.isArray(b.macros) ? b.macros : String(b.macros || '').split(/\r?\n/)).map((x) => couper(txt(x, 300), 200)).filter(Boolean);
      if (l.length > 12) throw new Error('12 messages-types au plus');
      ecrire('macros', JSON.stringify(l));
    }
    if (b.courriels !== undefined) {
      const l = [...new Set((Array.isArray(b.courriels) ? b.courriels : String(b.courriels || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
      if (l.length > COURRIELS_MAX) throw new Error(`${COURRIELS_MAX} adresses e-mail au plus`);
      for (const a of l) if (!MEL.test(a)) throw new Error(`Adresse e-mail invalide : ${a}`);
      ecrire('courriels', JSON.stringify(l));
    }
    if (b.nom !== undefined) { const n = txt(b.nom, 60); if (!n) throw new Error('Nom manquant'); ecrire('nom', n); }
    if (b.lieu !== undefined) ecrire('lieu', txt(b.lieu, 120) || null);
    for (const k of ['debut', 'fin']) if (b[k] !== undefined) { const t = b[k] ? Number(b[k]) : null; if (t != null && !(t > 0)) throw new Error('Date invalide'); ecrire(k, t); }
    if (b.publicAttendu !== undefined) { const n = nombre(b.publicAttendu); if (n != null && !(n >= 0 && n <= 5000000)) throw new Error('Public attendu invalide'); ecrire('public', n == null ? null : Math.round(n)); }
    if (b.categorie !== undefined) ecrire('categorie', CATEGORIES_DPS[b.categorie] ? b.categorie : null);
    if (b.conservationJours !== undefined) ecrire('conservation', Math.min(3650, Math.max(7, Math.round(Number(b.conservationJours) || 365))));
    if (b.centre !== undefined) {
      if (!b.centre) { ecrire('centreLat', null); ecrire('centreLon', null); }
      else { const p = position(b.centre); if (p.lat == null) throw new Error('Position invalide'); ecrire('centreLat', p.lat); ecrire('centreLon', p.lon); ecrire('centreZoom', Math.min(19, Math.max(3, Math.round(Number(b.centre.zoom) || 14)))); }
    }
    touche();
    return { ok: true };
  }

  // ---- Nœuds attribués par l'administrateur de la carte ---------------------------------------------------------
  const noeudsAttribues = () => q.noeuds.all().map((n) => n.num >>> 0);
  const lireListe = (liste) => (Array.isArray(liste) ? liste : String(liste || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean).map(numeroNoeud);
  const NOEUDS_MAX = 200;
  function definirNoeuds(liste, auteur) {
    const voulus = new Set(lireListe(liste));
    if (voulus.size > NOEUDS_MAX) throw new Error(`${NOEUDS_MAX} nœuds au plus par espace`);
    const avant = new Set(noeudsAttribues());
    db.transaction(() => {
      for (const n of avant) if (!voulus.has(n)) { q.retirerNoeud.run(n); q.libererNoeud.run(n); }
      for (const n of voulus) if (!avant.has(n)) q.ajouterNoeud.run(n, Date.now(), auteur || null);
    })();
    touche();
    return noeudsAttribues();
  }
  const organisationValide = (oid) => { if (oid == null || oid === '') return null; if (!q.organisation.get(oid)) throw new Error('Organisation inconnue'); return oid; };
  // Nœuds ajoutés à l'espace (ou rangés dans une autre organisation s'ils y sont déjà)
  function attribuer(liste, organisation, auteur) {
    const nums = [...new Set(lireListe(liste))], org = organisationValide(organisation);
    if (!nums.length) throw new Error('Aucun nœud choisi');
    if (new Set([...noeudsAttribues(), ...nums]).size > NOEUDS_MAX) throw new Error(`${NOEUDS_MAX} nœuds au plus par espace`);
    db.transaction(() => { for (const n of nums) { q.ajouterNoeud.run(n, Date.now(), auteur || null); q.rangerNoeud.run(org, n); } })();
    touche();
    return nums;
  }
  function retirerNoeuds(liste) {
    const nums = lireListe(liste);
    db.transaction(() => { for (const n of nums) { q.retirerNoeud.run(n); q.libererNoeud.run(n); } })();
    touche();
    return nums;
  }
  // Nœud pas encore vu par la carte, attendu par son nom court : attribué dès qu'il apparaît (voir resoudreAttentes)
  const cleNom = (nom) => txt(nom, 12).toLowerCase();
  function attendre(nom, organisation, auteur) {
    const n = txt(nom, 12);
    if (!n) throw new Error('Nom court manquant');
    if (/\s/.test(n)) throw new Error('Un nom court ne contient pas d’espace (4 caractères en général, ex. PS01)');
    if (q.attentes.all().length >= 100 && !q.attentes.all().some((a) => a.cle === cleNom(n))) throw new Error('100 nœuds en attente au plus');
    q.attendre.run(cleNom(n), n, organisationValide(organisation), Date.now(), auteur || null);
    touche();
    return { ok: true };
  }
  function retirerAttente(nom) { q.retirerAttente.run(cleNom(nom)); touche(); return { ok: true }; }
  // chercher(nom court) → numéros des nœuds de la carte qui le portent ; libre(num) → faux s'il est à un autre espace
  function resoudreAttentes(chercher, libre) {
    let n = 0;
    for (const a of q.attentes.all()) {
      let nums = [];
      try { nums = (chercher(a.nom) || []).map((x) => x >>> 0); } catch { continue; }
      if (nums.length !== 1) continue; // inconnu, ou plusieurs nœuds portent ce nom : à trancher à la main
      if (!q.noeud.get(nums[0]) && !libre(nums[0])) continue;
      db.transaction(() => { q.ajouterNoeud.run(nums[0], Date.now(), a.par || null); q.rangerNoeud.run(a.organisation && q.organisation.get(a.organisation) ? a.organisation : null, nums[0]); q.retirerAttente.run(a.cle); })();
      journal(`[Secours] nœud ${idNoeud(nums[0])} (« ${a.nom} ») attribué à l’espace ${code} : il était attendu par son nom court`);
      n++;
    }
    if (n) touche();
    return n;
  }

  // ---- Organisations de l'espace (associations d'un DPS, services d'un PCS) ------------------------------------
  function majOrganisation(oid, b) {
    if (oid && b.supprimer) {
      if (!q.organisation.get(oid)) throw new Error('Organisation inconnue');
      db.transaction(() => { q.supprimerOrganisation.run(oid); q.detacherOrgNoeuds.run(oid); q.detacherOrgEquipes.run(oid); q.detacherOrgAttentes.run(oid); })();
      touche();
      return { ok: true };
    }
    const toutes = q.organisations.all();
    const o = oid ? q.organisation.get(oid) : { id: id(), nom: '', couleur: COULEURS[toutes.length % COULEURS.length], cree: Date.now() };
    if (!o) throw new Error('Organisation inconnue');
    if (!oid && toutes.length >= 30) throw new Error('30 organisations au plus par espace');
    if (b.nom !== undefined) o.nom = txt(b.nom, 60);
    if (!o.nom) throw new Error('Nom de l’organisation manquant');
    if (toutes.some((x) => x.id !== o.id && x.nom.toLowerCase() === o.nom.toLowerCase())) throw new Error(`« ${o.nom} » existe déjà dans cet espace`);
    if (b.couleur !== undefined && /^#[0-9a-f]{6}$/i.test(b.couleur)) o.couleur = b.couleur;
    q.ecrireOrganisation.run(o);
    touche();
    return { id: o.id, nom: o.nom, couleur: o.couleur };
  }
  const organisations = () => q.organisations.all().map((o) => ({ id: o.id, nom: o.nom, couleur: o.couleur }));
  const lignesNoeuds = () => q.noeuds.all().map((n) => ({ num: n.num >>> 0, id: idNoeud(n.num), nom: nomDe(n.num >>> 0) || null, organisation: n.organisation || null }));
  const lignesAttentes = () => q.attentes.all().map((a) => ({ nom: a.nom, organisation: a.organisation || null, ajoute: a.ajoute }));

  // ---- Équipes et postes ----------------------------------------------------------------------------------------
  function ligneEquipe(e) {
    const p = e.noeud ? positionDe(e.noeud >>> 0) : null;
    const direct = p && p.lat != null ? { lat: p.lat, lon: p.lon, heure: p.heure || 0 } : null;
    let sante = null;
    if (e.noeud && option('batterie')) { try { const t = santeDe(e.noeud >>> 0); if (t && (t.batterie != null || t.tension != null)) sante = { batterie: t.batterie != null ? Math.round(t.batterie) : null, tension: t.tension != null ? +Number(t.tension).toFixed(2) : null, heure: t.heure || null }; } catch { /* pas de télémétrie */ } }
    return { id: e.id, nom: e.nom, genre: e.genre, effectif: e.effectif, couleur: e.couleur, etat: e.etat, etatHeure: e.etat_heure, consigne: e.consigne,
      organisation: e.organisation || null, sante,
      fixe: e.lat != null ? { lat: e.lat, lon: e.lon } : null,
      noeud: e.noeud ? { num: e.noeud >>> 0, id: idNoeud(e.noeud), nom: nomDe(e.noeud >>> 0) || null } : null,
      position: direct };
  }
  function majEquipe(eid, b) {
    if (eid && b.supprimer) {
      if (!q.equipe.get(eid)) throw new Error('Équipe inconnue');
      db.transaction(() => { q.supprimerEquipe.run(eid); q.detacherEquipe.run(eid); q.detacherInterventions.run(eid); })();
      touche();
      return { ok: true };
    }
    const e = eid ? q.equipe.get(eid) : { id: id(), nom: '', genre: Object.keys(G().equipes)[0], lat: null, lon: null, effectif: null, noeud: null, couleur: COULEURS[q.equipes.all().length % COULEURS.length], etat: 'disponible', etat_heure: Date.now(), consigne: null, cree: Date.now(), organisation: null };
    if (!e) throw new Error('Équipe inconnue');
    if (b.nom !== undefined) e.nom = txt(b.nom, 40);
    if (!e.nom) throw new Error('Nom manquant');
    if (b.genre !== undefined) { if (!G().equipes[b.genre]) throw new Error('Type d’équipe inconnu'); e.genre = b.genre; }
    if (b.lat !== undefined || b.lon !== undefined) Object.assign(e, position(b));
    if (b.effectif !== undefined) { const n = nombre(b.effectif); if (n != null && !(n >= 0 && n <= 500)) throw new Error('Effectif invalide'); e.effectif = n == null ? null : Math.round(n); }
    if (b.couleur !== undefined && /^#[0-9a-f]{6}$/i.test(b.couleur)) e.couleur = b.couleur;
    if (b.consigne !== undefined) e.consigne = txt(b.consigne, 200) || null;
    if (b.organisation !== undefined) e.organisation = organisationValide(b.organisation);
    if (b.noeud !== undefined) {
      if (b.noeud === null || b.noeud === '') e.noeud = null;
      else {
        const n = numeroNoeud(b.noeud);
        if (!q.noeud.get(n)) throw new Error('Ce nœud n’est pas attribué à votre espace : demandez-le à l’administrateur de la carte');
        const autre = q.equipeDuNoeud.get(n);
        if (autre && autre.id !== e.id) throw new Error(`Ce nœud est déjà porté par « ${autre.nom} »`);
        e.noeud = n;
        // L'équipe prend l'organisation de son nœud si elle n'en a pas encore
        if (!e.organisation && q.noeud.get(n).organisation && b.organisation === undefined) e.organisation = q.noeud.get(n).organisation;
      }
    }
    if (eid) q.majEquipe.run(e); else q.creerEquipe.run(e);
    touche();
    return ligneEquipe(q.equipe.get(e.id));
  }
  function changerEtat(eid, etat, auteur, origine = 'saisie') {
    const e = q.equipe.get(eid);
    if (!e) throw new Error('Équipe inconnue');
    if (!ETATS_EQUIPE[etat]) throw new Error('État inconnu');
    if (e.etat !== etat) {
      q.etatEquipe.run(etat, Date.now(), eid);
      ajouterMc({ texte: `${e.nom} : ${ETATS_EQUIPE[etat].toLowerCase()}`, type: 'mouvement', equipe: eid }, auteur, origine);
    }
    touche();
    return ligneEquipe(q.equipe.get(eid));
  }
  // Trajet du nœud d'une équipe sur les dernières heures (au plus 24 h et 400 points)
  function trace(eid, heures) {
    if (!option('trajets')) throw new Error('Les trajets ne sont pas activés dans cet espace');
    const e = q.equipe.get(eid);
    if (!e) throw new Error('Équipe inconnue');
    if (!e.noeud) return { equipe: eid, points: [] };
    const h = Math.min(24, Math.max(1, Number(heures) || 6));
    let pts = [];
    try { pts = (traceDe(e.noeud >>> 0, Date.now() - h * 3600000) || []).filter((p) => p.lat != null && p.lon != null); } catch { /* pas d'historique */ }
    const pas = Math.ceil(pts.length / 400) || 1;
    return { equipe: eid, heures: h, points: pts.filter((_, i) => i % pas === 0 || i === pts.length - 1).map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6), p.heure]) };
  }

  // ---- Interventions pointées sur la carte ------------------------------------------------------------------------
  function majIntervention(iid, b, auteur, origine = 'saisie', point = null) {
    const nouveau = !iid;
    const x = nouveau ? { id: id(), heure: Date.now(), lat: null, lon: null, genre: 'autre', titre: '', detail: null, urgente: 0, statut: 'a-faire', equipe: null, auteur, origine, maj: Date.now(), cloture: null, priorite: 2, point: point != null ? Number(point) >>> 0 : null, lieu: null, etat: null } : q.intervention.get(iid);
    if (!x) throw new Error('Intervention inconnue');
    const avant = { statut: x.statut, equipe: x.equipe, priorite: nouveau ? null : x.priorite || 2 };
    if (b.genre !== undefined) x.genre = G().interventions[b.genre] ? b.genre : 'autre';
    if (b.titre !== undefined) x.titre = txt(b.titre, 80);
    if (!x.titre) x.titre = G().interventions[x.genre];
    if (b.detail !== undefined) x.detail = txt(b.detail, 600) || null;
    if (b.lieu !== undefined) x.lieu = txt(b.lieu, 80) || null;
    if (b.etat !== undefined) x.etat = genre() === 'dps' && ETATS_VICTIME[b.etat] ? b.etat : null;
    // Priorité : 1 urgente, 2 normale, 3 peut attendre ; « urgente » (case à cocher, message radio) vaut priorité 1
    if (b.priorite !== undefined) { const p = Number(b.priorite); if (!PRIORITES[p]) throw new Error('Priorité inconnue'); x.priorite = p; }
    else if (b.urgente !== undefined) x.priorite = b.urgente ? 1 : (x.priorite === 1 || !x.priorite ? 2 : x.priorite);
    x.priorite = x.priorite || 2;
    x.urgente = x.priorite === 1 ? 1 : 0;
    if (b.lat !== undefined || b.lon !== undefined) Object.assign(x, position(b));
    if (b.equipe !== undefined) { if (b.equipe && !q.equipe.get(b.equipe)) throw new Error('Équipe inconnue'); x.equipe = b.equipe || null; }
    if (b.statut !== undefined) { if (!STATUTS_INTER.includes(b.statut)) throw new Error('Statut inconnu'); x.statut = b.statut; }
    // Une équipe engagée : l'intervention est en cours ; l'équipe passe « en intervention », puis redevient
    // disponible à la clôture si rien d'autre ne la retient
    if (x.equipe && x.equipe !== avant.equipe && x.statut === 'a-faire') x.statut = 'en-cours';
    x.maj = Date.now();
    x.cloture = x.statut === 'terminee' ? (avant.statut === 'terminee' && x.cloture ? x.cloture : Date.now()) : null;
    const nomEq = (eid) => { const e = eid && q.equipe.get(eid); return e ? e.nom : null; };
    db.transaction(() => {
      if (nouveau) q.creerIntervention.run(x); else q.majIntervention.run(x);
      if (nouveau) ajouterMc({ texte: `Intervention ouverte : ${x.titre}${x.urgente ? ' (urgente)' : ''}${x.equipe ? ' — confiée à ' + nomEq(x.equipe) : ''}`, type: 'intervention', intervention: x.id, equipe: x.equipe }, auteur, origine);
      else if (x.statut !== avant.statut || x.equipe !== avant.equipe) {
        const quoi = x.statut === 'terminee' && avant.statut !== 'terminee' ? 'terminée' : x.equipe !== avant.equipe && x.equipe ? 'confiée à ' + nomEq(x.equipe) : x.statut === 'en-cours' ? 'en cours' : 'à faire';
        ajouterMc({ texte: `Intervention « ${x.titre} » : ${quoi}`, type: x.statut === 'terminee' ? 'fin' : 'intervention', intervention: x.id, equipe: x.equipe }, auteur, origine);
      }
      if (x.equipe && x.statut === 'en-cours') q.etatEquipe.run('intervention', Date.now(), x.equipe);
      for (const eid of new Set([avant.equipe, x.equipe].filter(Boolean))) {
        const e = q.equipe.get(eid);
        if (e && e.etat === 'intervention' && !q.interventionEnCours.get(eid)) q.etatEquipe.run('disponible', Date.now(), eid);
      }
    })();
    touche();
    if (x.priorite === 1 && avant.priorite !== 1 && x.statut !== 'terminee') alerterParCourriel(x);
    return q.intervention.get(x.id);
  }
  // Intervention urgente → e-mail aux adresses de l'espace, par le serveur d'envoi de la carte (option « courriel »)
  let courrielsRecents = [];
  function alerterParCourriel(x) {
    const a = courriels();
    if (!option('courriel') || !a.length || !courriel || !courriel.actif()) return;
    courrielsRecents = courrielsRecents.filter((t) => Date.now() - t < 3600000);
    if (courrielsRecents.length >= COURRIELS_HEURE) { journal(`[Secours] alerte e-mail non envoyée (${code}) : ${COURRIELS_HEURE} par heure au plus`); return; }
    courrielsRecents.push(Date.now());
    const dfci = x.lat != null ? versDfci(x.lat, x.lon) : null, e = x.equipe && q.equipe.get(x.equipe);
    const texte = [`${lire('nom', code)} — intervention urgente`, '', x.titre, G().interventions[x.genre] || '', x.detail || null,
      x.lat != null ? `Position : ${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}${dfci ? ' (DFCI ' + dfci + ')' : ''}` : 'Position non précisée',
      x.lat != null ? `https://www.openstreetmap.org/?mlat=${x.lat.toFixed(5)}&mlon=${x.lon.toFixed(5)}#map=17/${x.lat.toFixed(5)}/${x.lon.toFixed(5)}` : null,
      e ? `Équipe engagée : ${e.nom}` : 'Aucune équipe engagée pour l’instant', `Signalée par ${x.auteur || '?'} le ${new Date(x.heure).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`,
      '', 'Message automatique de l’espace Secours : ne pas répondre.'].filter((l) => l != null).join('\n');
    Promise.resolve().then(() => courriel.envoyer({ a: a.join(', '), sujet: `[${lire('nom', code)}] Urgent : ${x.titre}`, texte }))
      .then(() => { try { ajouterMc({ texte: `Alerte e-mail envoyée (${a.length} adresse${a.length > 1 ? 's' : ''}) : ${x.titre}`, type: 'message-emis', intervention: x.id }, 'carte', 'courriel'); } catch { /* espace fermé entre-temps */ } })
      .catch((err) => { journal(`[Secours] alerte e-mail impossible (${code}) :`, err.message); try { ajouterMc({ texte: `Alerte e-mail non partie : ${x.titre}`, type: 'information', intervention: x.id }, 'carte', 'courriel'); } catch { /* espace fermé entre-temps */ } });
  }

  // ---- Main courante ----------------------------------------------------------------------------------------------
  function ajouterMc(b, auteur, origine = 'saisie', envoi = null) {
    const texte = txt(b.texte, 1000);
    if (!texte) throw new Error('Texte vide');
    const x = { id: id(), heure: Date.now(), auteur: auteur || 'radio', type: TYPES_MC.includes(b.type) ? b.type : 'information',
      equipe: b.equipe && q.equipe.get(b.equipe) ? b.equipe : null, intervention: b.intervention && q.intervention.get(b.intervention) ? b.intervention : null, texte, origine, envoi };
    q.ajouterMc.run(x);
    touche();
    return x;
  }
  function csvMc() {
    const eq = new Map(q.equipes.all().map((e) => [e.id, e.nom]));
    const c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return ['Date;Heure;Auteur;Équipe;Type;Origine;Texte'].concat(q.touteMainCourante.all().map((x) => {
      const t = new Date(x.heure);
      return [t.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }), t.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }), x.auteur, eq.get(x.equipe) || '', x.type, x.origine || '', x.texte].map(c).join(';');
    })).join('\r\n');
  }

  // ---- Remontées du terrain par radio -----------------------------------------------------------------------------
  const vus = new Map();
  const dejaVu = (cle) => {
    if (Date.now() - (vus.get(cle) || 0) < 120000) return true; // même paquet reçu par plusieurs passerelles
    vus.set(cle, Date.now());
    if (vus.size > 500) vus.delete(vus.keys().next().value);
    return false;
  };
  const surCanalReserve = (evt) => { const c = canalAttribue(); return !!c && !!evt && String(evt.canal || '').toLowerCase() === c.toLowerCase(); };
  function texteRecu(evt) {
    if (!evt || !evt.texte) return false;
    const de = evt.de >>> 0;
    if (!q.noeud.get(de)) {
      // Nœud inconnu de l'espace, mais sur son canal réservé (il en a la clé) : noté tel quel, sans effet sur les équipes
      if (!surCanalReserve(evt)) return false;
      const t = txt(evt.texte, 240);
      if (!dejaVu(`${de}:${t}`)) { try { ajouterMc({ texte: t, type: 'message-recu' }, `${nomDe(de) || idNoeud(de)} (nœud hors espace)`, 'radio'); } catch (err) { journal(`[Secours] message du canal réservé ignoré (${code}) :`, err.message); } }
      return true;
    }
    const texte = txt(evt.texte, 240);
    if (dejaVu(`${de}:${texte}`)) return true;
    const e = q.equipeDuNoeud.get(de);
    const auteur = e ? e.nom : nomDe(de) || idNoeud(de);
    try {
      const m = /^(\S+)\s*:?\s*([\s\S]*)$/.exec(texte), mot = m ? m[1].toUpperCase().replace(/[:.,;!]+$/, '') : '';
      if (mot === 'INTER' || mot === 'INTERVENTION') {
        const p = positionDe(de);
        majIntervention(null, { titre: txt(m[2], 80) || 'Intervention signalée par radio', lat: p && p.lat != null ? p.lat : null, lon: p && p.lat != null ? p.lon : null, equipe: e ? e.id : null }, auteur, 'radio');
      } else if (e && MOTS_RADIO[mot] && !m[2]) {
        changerEtat(e.id, MOTS_RADIO[mot], auteur, 'radio');
      } else if (e && mot === 'FIN' && q.interventionEnCours.get(e.id)) {
        const x = q.interventionEnCours.get(e.id);
        if (m[2]) ajouterMc({ texte: m[2], type: 'message-recu', equipe: e.id, intervention: x.id }, auteur, 'radio');
        majIntervention(x.id, { statut: 'terminee' }, auteur, 'radio');
      } else {
        ajouterMc({ texte, type: 'message-recu', equipe: e ? e.id : null }, auteur, 'radio');
      }
    } catch (err) { journal(`[Secours] message radio de ${idNoeud(de)} ignoré (${code}) :`, err.message); }
    return true;
  }
  // Point de passage Meshtastic posé par le nœud d'une équipe : une intervention à cet endroit. Le même point
  // déplacé ou renommé met l'intervention à jour ; supprimé (expiré), il la termine.
  function pointRecu(evt) {
    const w = evt && evt.pointRepere, de = evt ? evt.de >>> 0 : 0;
    if (!w || !q.noeud.get(de)) return false;
    if (!option('points') || dejaVu(`pt:${de}:${w.id}:${w.lat}:${w.lon}:${w.nom}:${w.expire}`)) return true;
    const e = q.equipeDuNoeud.get(de), auteur = e ? e.nom : nomDe(de) || idNoeud(de);
    try {
      const existante = w.id != null ? q.interventionDuPoint.get(Number(w.id) >>> 0) : null;
      const fini = !!(w.expire && w.expire * 1000 <= Date.now());
      const titre = txt(String(w.nom || '').replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''), 80) || 'Point de passage reçu par radio';
      if (fini) { if (existante && existante.statut !== 'terminee') majIntervention(existante.id, { statut: 'terminee' }, auteur, 'radio'); return true; }
      if (w.lat == null || w.lon == null) return true;
      if (existante && existante.statut !== 'terminee') majIntervention(existante.id, { titre, detail: txt(w.description, 600) || existante.detail, lat: w.lat, lon: w.lon }, auteur, 'radio');
      else majIntervention(null, { titre, detail: txt(w.description, 600), lat: w.lat, lon: w.lon, equipe: e ? e.id : null }, auteur, 'radio', w.id);
    } catch (err) { journal(`[Secours] point de passage de ${idNoeud(de)} ignoré (${code}) :`, err.message); }
    return true;
  }

  // ---- Envois vers le terrain (messages directs aux nœuds des équipes) ----------------------------------------------
  // Qui envoie : un responsable, ou un équipier affecté à un poste de coordination (PC du dispositif, PC communal)
  function peutEnvoyer(compte) {
    if (estResponsable(compte)) return true;
    const a = q.affectation.get(compte.id), e = a && a.equipe ? q.equipe.get(a.equipe) : null;
    return !!e && e.genre === 'pc';
  }
  let envoisRecents = [];
  // Accusé d'une entrée de main courante : relu auprès du module tant qu'il peut encore changer, puis retenu dans
  // le fichier de l'espace (le module oublie ses envois au bout d'un moment, et le rapport de fin en a besoin)
  function accuse(m) {
    if (m.envoi == null) return null;
    if (m.accuse === 'recu' || m.accuse === 'echec') return m.accuse;
    let a = null;
    try { const e = radio && radio.etatEnvoi(m.envoi); a = e ? e.statut : null; } catch { /* module absent */ }
    if (a && a !== m.accuse) { try { q.noterAccuse.run(a, m.id); } catch { /* espace fermé */ } }
    return a || m.accuse || null;
  }
  // b : { texte, equipe } (une équipe) ou { texte } (toutes celles qui portent un nœud, l'une après l'autre)
  function envoyer(compte, b) {
    if (!radio) throw new Error('Envoi par radio indisponible sur cette carte');
    if (!peutEnvoyer(compte)) throw new Error('Envoi par radio réservé aux responsables et au poste de coordination');
    const texte = couper(txt(b.texte, 600), 200);
    if (!texte) throw new Error('Message vide');
    const auteur = signature(compte), inter = b.intervention || null;
    // « Toutes les équipes » : un seul message sur le canal réservé à l'espace, s'il en a un et que l'option est active
    const canal = !b.equipe && option('canal') ? canalReserve() : null;
    if (canal) {
      envoisRecents = envoisRecents.filter((t) => Date.now() - t < ENVOIS_FENETRE);
      if (envoisRecents.length + 1 > ENVOIS_MAX) throw new Error(`Trop d’envois par radio : ${ENVOIS_MAX} messages au plus par 10 minutes`);
      const r = radio.envoyerTexte({ texte, canal: canal.index }, `espace Secours ${code}`);
      envoisRecents.push(Date.now());
      ajouterMc({ texte: `→ canal ${canal.nom} : ${texte}`, type: 'message-emis', intervention: inter }, auteur, 'radio', r.id);
      return { ok: true, destinataires: [`toutes les équipes (canal ${canal.nom})`], canal: canal.nom };
    }
    let cibles;
    if (b.equipe) {
      const e = q.equipe.get(b.equipe);
      if (!e) throw new Error('Équipe inconnue');
      if (!e.noeud) throw new Error(`« ${e.nom} » ne porte pas de nœud : impossible de lui écrire par radio`);
      cibles = [e];
    } else cibles = q.equipes.all().filter((e) => e.noeud);
    if (!cibles.length) throw new Error('Aucune équipe ne porte de nœud');
    envoisRecents = envoisRecents.filter((t) => Date.now() - t < ENVOIS_FENETRE);
    if (envoisRecents.length + cibles.length > ENVOIS_MAX) throw new Error(`Trop d’envois par radio : ${ENVOIS_MAX} messages au plus par 10 minutes`);
    const un = (e) => {
      const r = radio.envoyerTexte({ texte, dest: e.noeud >>> 0 }, `espace Secours ${code}`);
      envoisRecents.push(Date.now());
      ajouterMc({ texte: `→ ${e.nom} : ${texte}`, type: 'message-emis', equipe: e.id, intervention: inter }, auteur, 'radio', r.id);
    };
    un(cibles[0]); // une erreur du module (non connecté…) remonte tout de suite à celui qui envoie
    // Les suivants partent en arrière-plan, espacés : plusieurs messages d'affilée satureraient la file du module
    (async () => {
      for (const e of cibles.slice(1)) {
        await new Promise((ok) => setTimeout(ok, espacement));
        try { un(e); } catch (err) {
          journal(`[Secours] envoi radio vers ${idNoeud(e.noeud)} impossible (${code}) :`, err.message);
          try { ajouterMc({ texte: `Envoi par radio à ${e.nom} impossible : ${err.message}`, type: 'message-emis', equipe: e.id, intervention: inter }, auteur, 'radio'); } catch { /* espace fermé entre-temps */ }
        }
      }
    })();
    return { ok: true, destinataires: cibles.map((e) => e.nom) };
  }
  // Message d'intervention envoyé par radio, limité à l'essentiel : lieu précis (repère du site, puis position et
  // code DFCI), nature, état apparent. Sans lieu saisi, l'intitulé en tient lieu. À l'équipe engagée, sinon à celle
  // choisie, sinon à toutes.
  function diffuserIntervention(iid, b, compte) {
    const x = q.intervention.get(iid);
    if (!x) throw new Error('Intervention inconnue');
    const dfci = x.lat != null ? versDfci(x.lat, x.lon) : null;
    const nature = x.genre !== 'autre' ? G().interventions[x.genre] : null;
    const texte = couper([`INTER ${x.lieu || x.titre}`, x.lat != null ? `${x.lat.toFixed(5)},${x.lon.toFixed(5)}${dfci ? ' DFCI ' + dfci : ''}` : null, nature && nature.toLowerCase() !== (x.lieu || x.titre).toLowerCase() ? nature : null, x.etat ? ETATS_VICTIME[x.etat] : null].filter(Boolean).join(' · '), 200);
    return envoyer(compte, { texte, equipe: b.equipe !== undefined ? b.equipe || null : x.equipe, intervention: x.id });
  }

  // ---- Repères sur la carte : points de rassemblement (partout), repères d'un PCS (option) -------------------------
  const genresReperes = () => Object.fromEntries(Object.entries(REPERES).filter(([, r]) => !r.couches || option('couches')).map(([k, r]) => [k, { nom: r.nom, icone: r.icone, surface: !!r.surface }]));
  const ligneRepere = (r) => ({ id: r.id, genre: r.genre, nom: r.nom, detail: r.detail, lat: r.lat, lon: r.lon, contour: r.contour ? JSON.parse(r.contour) : null, auteur: r.auteur, cree: r.cree });
  const reperes = () => { const g = genresReperes(); return q.reperes.all().filter((r) => g[r.genre]).map(ligneRepere); };
  function majRepere(rid, b, auteur) {
    if (rid && b.supprimer) { if (!q.repere.get(rid)) throw new Error('Repère inconnu'); q.supprimerRepere.run(rid); touche(); return { ok: true }; }
    const r = rid ? q.repere.get(rid) : { id: id(), genre: 'rassemblement', nom: '', detail: null, lat: null, lon: null, contour: null, cree: Date.now(), auteur: auteur || null };
    if (!r) throw new Error('Repère inconnu');
    if (!rid && q.reperes.all().length >= 200) throw new Error('200 repères au plus par espace');
    if (b.genre !== undefined) { if (!genresReperes()[b.genre]) throw new Error('Type de repère inconnu'); r.genre = b.genre; }
    if (b.nom !== undefined) r.nom = txt(b.nom, 60);
    if (!r.nom) r.nom = REPERES[r.genre].nom;
    if (b.detail !== undefined) r.detail = txt(b.detail, 300) || null;
    if (REPERES[r.genre].surface) {
      if (b.contour !== undefined) {
        const c = Array.isArray(b.contour) ? b.contour.map((p) => position({ lat: p[0], lon: p[1] })) : [];
        if (c.length < 3 || c.length > 60 || c.some((p) => p.lat == null)) throw new Error('Une zone se dessine en 3 à 60 points');
        r.contour = JSON.stringify(c.map((p) => [p.lat, p.lon]));
        r.lat = +(c.reduce((t, p) => t + p.lat, 0) / c.length).toFixed(6); r.lon = +(c.reduce((t, p) => t + p.lon, 0) / c.length).toFixed(6);
      }
      if (!r.contour) throw new Error('Dessinez le contour de la zone sur la carte');
    } else {
      if (b.lat !== undefined || b.lon !== undefined) Object.assign(r, position(b));
      if (r.lat == null) throw new Error('Pointez le repère sur la carte');
      r.contour = null;
    }
    q.ecrireRepere.run(r);
    touche();
    return ligneRepere(q.repere.get(r.id));
  }
  // « Tout le monde se retrouve ici » : le repère part par radio (nom, position, code DFCI), à une équipe ou à toutes
  function diffuserRepere(rid, b, compte) {
    const r = q.repere.get(rid);
    if (!r || !genresReperes()[r.genre]) throw new Error('Repère inconnu');
    const dfci = versDfci(r.lat, r.lon);
    const tete = r.genre === 'rassemblement' ? `RASSEMBLEMENT ${r.nom}` : `${REPERES[r.genre].nom.toUpperCase()} ${r.nom}`;
    // « mot » : ce que le poste de coordination ajoute au moment de l'envoi (heure du rassemblement, consigne du jour…)
    const mot = txt(b.mot, 120);
    return envoyer(compte, { texte: [tete, `${r.lat.toFixed(5)},${r.lon.toFixed(5)}${dfci ? ' DFCI ' + dfci : ''}`, r.detail, mot].filter(Boolean).join(' · '), equipe: b.equipe || null });
  }

  // ---- Module radio de la carte : entrée de main courante quand il tombe ou revient (option « alerteRadio ») --------
  function radioChange(connecte) {
    touche();
    if (!option('alerteRadio')) return;
    try { ajouterMc({ texte: connecte ? 'Le module radio de la carte est de nouveau connecté.' : '⚠ Le module radio de la carte est déconnecté : les envois par radio ne partent plus.', type: 'information' }, 'carte', 'systeme'); } catch { /* espace fermé */ }
  }

  // ---- Rapport de fin : tout l'espace figé dans une page à garder ou à imprimer (option « rapport ») ------------------
  function rapport() {
    if (!option('rapport')) throw new Error('Le rapport de fin n’est pas activé dans cet espace');
    const h = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const quand = (t) => (t ? new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const duree = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
    const orgs = new Map(q.organisations.all().map((o) => [o.id, o.nom])), eqs = q.equipes.all(), nomEq = new Map(eqs.map((e) => [e.id, e.nom]));
    const membres = new Map(), parCompte = new Map(comptes.lister().map((c) => [c.id, c.identifiant]));
    for (const a of q.affectations.all()) if (a.equipe && parCompte.has(a.compte)) { if (!membres.has(a.equipe)) membres.set(a.equipe, []); membres.get(a.equipe).push(parCompte.get(a.compte) + (a.fonction ? ` (${a.fonction})` : '')); }
    const inters = q.toutesInterventions.all(), mc = q.touteMainCourante.all(), ev = evenement();
    const tableau = (tetes, lignes) => (lignes.length ? `<table><thead><tr>${tetes.map((t) => `<th>${h(t)}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="vide">Rien à signaler.</p>');
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(lire('nom', code))} — rapport</title>
<style>body{font:14px/1.45 system-ui,sans-serif;color:#111;background:#fff;max-width:1000px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;border-bottom:2px solid #111;padding-bottom:3px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #888;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}.vide,.note{color:#444}.chiffres{display:flex;gap:18px;flex-wrap:wrap}.chiffres b{font-size:20px;display:block}
@media print{body{margin:0}h2{break-after:avoid}tr{break-inside:avoid}}</style></head><body>
<h1>${h(lire('nom', code))}</h1>
<p class="note">${h(G().nom)}${ev.lieu ? ' · ' + h(ev.lieu) : ''}${ev.debut ? ' · du ' + h(quand(ev.debut)) : ''}${ev.fin ? ' au ' + h(quand(ev.fin)) : ''}<br>Rapport établi le ${h(quand(Date.now()))}. Document figé : il ne change plus après son téléchargement.</p>
<div class="chiffres"><div><b>${inters.length}</b>intervention${inters.length > 1 ? 's' : ''}</div><div><b>${inters.filter((x) => x.priorite === 1).length}</b>urgente${inters.filter((x) => x.priorite === 1).length > 1 ? 's' : ''}</div><div><b>${eqs.length}</b>équipe${eqs.length > 1 ? 's' : ''} et poste${eqs.length > 1 ? 's' : ''}</div><div><b>${eqs.reduce((t, e) => t + (e.effectif || 0), 0)}</b>personnes prévues</div><div><b>${mc.filter((m) => m.origine === 'radio').length}</b>messages radio</div></div>
<h2>Équipes et postes</h2>
${tableau(['Équipe', 'Type', 'Organisation', 'Effectif', 'Nœud', 'Membres', 'Dernier état'], eqs.map((e) => [h(e.nom), h(G().equipes[e.genre] || e.genre), h(orgs.get(e.organisation) || ''), e.effectif ?? '', e.noeud ? h(nomDe(e.noeud >>> 0) || idNoeud(e.noeud)) : '', h((membres.get(e.id) || []).join(', ')), h(ETATS_EQUIPE[e.etat] || e.etat)]))}
<h2>Interventions</h2>
${tableau(['Ouverte', 'Intitulé', 'Lieu et état', 'Nature', 'Priorité', 'Équipe', 'Position', 'Signalée par', 'Clôture', 'Durée'], inters.map((x) => [h(quand(x.heure)), `<b>${h(x.titre)}</b>${x.detail ? '<br>' + h(x.detail) : ''}`, h([x.lieu, x.etat ? ETATS_VICTIME[x.etat] : null].filter(Boolean).join(' · ')), h(G().interventions[x.genre] || x.genre), h(PRIORITES[x.priorite] || ''), h(nomEq.get(x.equipe) || ''), x.lat != null ? `${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}<br>DFCI ${h(versDfci(x.lat, x.lon) || '')}` : '', h(x.auteur || '') + (x.origine === 'radio' ? ' (radio)' : ''), x.cloture ? h(quand(x.cloture)) : 'non close', x.cloture ? h(duree(x.cloture - x.heure)) : '']))}
<h2>Repères</h2>
${tableau(['Repère', 'Type', 'Position', 'Précisions'], q.reperes.all().map((r) => [h(r.nom), h((REPERES[r.genre] || {}).nom || r.genre), `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`, h(r.detail || '')]))}
<h2>Main courante</h2>
${tableau(['Heure', 'Auteur', 'Type', 'Équipe', 'Texte', 'Radio'], mc.map((m) => [h(quand(m.heure)), h(m.auteur || ''), h(m.type), h(nomEq.get(m.equipe) || ''), h(m.texte), m.origine === 'radio' ? (m.envoi != null ? h(ACCUSES[accuse(m)] || 'envoyé') : 'reçu du terrain') : '']))}
</body></html>`;
    return { nom: `rapport-${code}-${new Date().toISOString().slice(0, 10)}.html`, html };
  }

  // ---- Comptes de l'espace ----------------------------------------------------------------------------------------
  const estResponsable = (c) => !!c && c.role === 'admin';
  const signature = (c) => c.identifiant;
  function listerComptes() {
    const aff = new Map(q.affectations.all().map((a) => [a.compte, a]));
    return comptes.lister().map((c) => ({ id: c.id, identifiant: c.identifiant, responsable: c.role === 'admin', statut: c.statut, derniere: c.derniere, equipe: (aff.get(c.id) || {}).equipe || null, fonction: (aff.get(c.id) || {}).fonction || null }));
  }
  function creerCompte(b, responsable = false) {
    const c = comptes.creer({ identifiant: b.identifiant, motDePasse: b.motDePasse }, responsable ? 'admin' : 'membre');
    if (b.equipe || b.fonction) affecter(c.id, b);
    touche();
    return c;
  }
  function affecter(cid, b) {
    const a = q.affectation.get(cid) || { equipe: null, fonction: null };
    if (b.equipe !== undefined) { if (b.equipe && !q.equipe.get(b.equipe)) throw new Error('Équipe inconnue'); a.equipe = b.equipe || null; }
    if (b.fonction !== undefined) a.fonction = txt(b.fonction, 40) || null;
    q.affecter.run(cid, a.equipe, a.fonction);
  }
  function majCompte(cid, b, moi) {
    cid = Number(cid);
    const c = comptes.lister().find((x) => x.id === cid);
    if (!c) throw new Error('Compte inconnu');
    if (b.supprimer) {
      if (moi && moi.id === cid) throw new Error('Vous ne pouvez pas supprimer votre propre compte');
      comptes.supprimer(cid); q.retirerAffectation.run(cid);
    } else {
      if (b.responsable !== undefined) comptes.changerRole(cid, b.responsable ? 'admin' : 'membre');
      if (b.actif !== undefined) comptes.changerStatut(cid, b.actif ? 'actif' : 'desactive');
      if (b.equipe !== undefined || b.fonction !== undefined) affecter(cid, b);
      if (b.motDePasse !== undefined) definirMotDePasse(cid, b.motDePasse);
    }
    touche();
    return { ok: true };
  }
  // Mot de passe remis par un responsable (ou par l'administrateur de la carte pour le responsable) : passe par un
  // lien à usage unique consommé aussitôt, comme une réinitialisation ; les sessions ouvertes du compte tombent
  function definirMotDePasse(cid, motDePasse) {
    const { jeton } = comptes.creerReinit(cid, 60000, 'responsable');
    comptes.reinitialiser(jeton, motDePasse);
  }
  // Responsable nommé par l'administrateur de la carte : compte créé, ou mot de passe remis s'il existe déjà
  function nommerResponsable(b) {
    const existant = comptes.lister().find((c) => c.identifiant.toLowerCase() === String(b.identifiant || '').trim().toLowerCase());
    if (!existant) return creerCompte(b, true);
    definirMotDePasse(existant.id, b.motDePasse);
    comptes.changerStatut(existant.id, 'actif');
    comptes.changerRole(existant.id, 'admin');
    return existant;
  }

  // ---- Vue d'ensemble envoyée à la page ---------------------------------------------------------------------------
  function etat(compte) {
    const aff = q.affectation.get(compte.id) || {};
    const equipes = q.equipes.all().map(ligneEquipe);
    const membres = new Map();
    const parCompte = new Map(comptes.lister().filter((c) => c.statut === 'actif').map((c) => [c.id, c.identifiant]));
    for (const a of q.affectations.all()) if (a.equipe && parCompte.has(a.compte)) { if (!membres.has(a.equipe)) membres.set(a.equipe, []); membres.get(a.equipe).push({ nom: parCompte.get(a.compte), fonction: a.fonction }); }
    for (const e of equipes) e.membres = membres.get(e.id) || [];
    const ev = evenement(), cat = ev.categorie ? CATEGORIES_DPS[ev.categorie] : null;
    const prevu = equipes.reduce((s, e) => s + (e.effectif || 0), 0);
    return {
      rev, code, nom: lire('nom', code), genre: genre(), nomGenre: G().nom,
      moi: { id: compte.id, identifiant: compte.identifiant, responsable: estResponsable(compte), equipe: aff.equipe || null },
      listes: { equipes: G().equipes, interventions: G().interventions, etats: ETATS_EQUIPE, categories: genre() === 'dps' ? CATEGORIES_DPS : null, typesMc: TYPES_MC, priorites: PRIORITES, etatsVictime: genre() === 'dps' ? ETATS_VICTIME : null, reperes: genresReperes(),
        organisations: [...G().organisations, ...ASSOCIATIONS] },
      options: options(), catalogueOptions: estResponsable(compte) ? Object.fromEntries(optionsDuGenre().map(([k, o]) => [k, { nom: o.nom, aide: o.aide }])) : undefined,
      organisations: organisations(), reperes: reperes(), macros: macros(),
      canal: { nom: canalAttribue(), utilisable: !!canalReserve() && option('canal') },
      courriel: estResponsable(compte) ? { disponible: !!courriel && courriel.actif(), adresses: courriels() } : undefined,
      evenement: ev, centre: centre(), conservationJours: Number(lire('conservation')) || 365,
      effectif: { prevu, categorie: cat, conforme: cat ? prevu >= cat.min && (cat.max == null || prevu <= cat.max) : null },
      equipes, interventions: q.interventions.all(Date.now() - 12 * 3600000),
      mainCourante: q.mainCourante.all(300).map((m) => (m.envoi != null ? { ...m, accuse: accuse(m) } : m)),
      // tombee : le module était connecté et ne l'est plus (une carte sans module radio n'affiche pas d'alerte)
      radio: { disponible: !!radio, connecte: !!radio && !!radio.connecte(), tombee: !!radioTombee(), peutEnvoyer: peutEnvoyer(compte), accuses: ACCUSES },
      noeuds: estResponsable(compte) ? lignesNoeuds() : undefined, attentes: estResponsable(compte) ? lignesAttentes() : undefined,
      comptes: estResponsable(compte) ? listerComptes() : undefined,
    };
  }

  function purger() {
    const limite = Date.now() - Math.max(7, Number(lire('conservation')) || 365) * 86400000;
    const n = q.purgerMc.run(limite).changes + q.purgerInterventions.run(limite).changes;
    if (n) touche();
  }
  // Copie quotidienne du fichier de l'espace (les sauvegardes de la carte ne l'emportent pas)
  async function copier(dossierCopies) {
    fs.mkdirSync(dossierCopies, { recursive: true, mode: 0o700 });
    const cible = path.join(dossierCopies, `${code}-${new Date().toISOString().slice(0, 10)}.db`);
    if (fs.existsSync(cible)) return null;
    await db.backup(cible);
    try { fs.chmodSync(cible, 0o600); } catch { /* système de fichiers sans chmod */ }
    const anciennes = fs.readdirSync(dossierCopies).filter((f) => /-\d{4}-\d{2}-\d{2}\.db$/.test(f) && f.slice(0, -14) === code).sort();
    for (const f of anciennes.slice(0, Math.max(0, anciennes.length - COPIES_GARDEES))) { try { fs.unlinkSync(path.join(dossierCopies, f)); } catch { /* déjà retirée */ } }
    return cible;
  }

  return {
    code, comptes, decrire, reglages, definirNoeuds, noeudsAttribues, possedeNoeud: (n) => !!q.noeud.get(n >>> 0),
    attribuer, retirerNoeuds, attendre, retirerAttente, resoudreAttentes, lignesNoeuds, lignesAttentes, majOrganisation, organisations,
    canalAttribue, definirCanal: (nom) => { ecrire('canal', txt(nom, 40) || null); touche(); }, surCanalReserve,
    majEquipe, changerEtat, trace, majIntervention: (iid, b, auteur) => majIntervention(iid, b, auteur), ajouterMc: (b, compte) => ajouterMc(b, signature(compte)), csvMc, texteRecu, pointRecu,
    envoyer, diffuserIntervention, peutEnvoyer, majRepere, diffuserRepere, radioChange, rapport, option,
    // Accusés des envois de la dernière heure : la page les relit sans recharger tout l'état
    accuses: () => q.mainCourante.all(300).filter((m) => m.envoi != null && Date.now() - m.heure < 3600000).map((m) => ({ id: m.id, accuse: accuse(m) })),
    estResponsable, signature, creerCompte, majCompte, nommerResponsable, etat, rev: () => rev, purger, copier,
    equipeDe: (compte) => (q.affectation.get(compte.id) || {}).equipe || null,
    fermer: () => { try { db.close(); } catch { /* déjà fermée */ } },
  };
}

// ---- Tous les espaces de la carte ----------------------------------------------------------------------------------
// radio : { connecte(), envoyerTexte({ texte, dest }, auteur) → { id }, etatEnvoi(id) → { statut } } ; absent : pas d'envoi
// santeDe(num) → { batterie, tension, heure } ; traceDe(num, depuis) → [{ lat, lon, heure }] ; courriel : { actif(), envoyer({ a, sujet, texte }) } ;
// noeudsCarte() → nœuds que la carte connaît [{ num, court, long, vu }], pour le sélecteur de l'administrateur
function creerSecours({ config, journal = () => {}, positionDe = () => null, nomDe = () => null, radio = null, espacement = 3000, santeDe = () => null, traceDe = () => [], courriel = null, noeudsCarte = () => [] }) {
  const dossier = path.join(path.dirname(config.fichierBase), 'secours');
  let radioConnectee = null, radioDejaVue = false;
  const ctx = { journal, positionDe, nomDe, radio, espacement, santeDe, traceDe, courriel, radioTombee: () => radioDejaVue && radioConnectee === false };
  const espaces = new Map();
  const fichierDe = (code) => path.join(dossier, code + '.db');
  const valider = (code) => { const c = String(code || '').trim().toLowerCase(); if (!CODE.test(c) || RESERVES.has(c)) throw new Error('Adresse de l’espace : 3 à 32 caractères, lettres minuscules, chiffres et tirets (ex. festival-2027)'); return c; };

  function charger() {
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch { return; } // aucun espace créé : le dossier n'existe pas encore
    for (const f of noms) {
      const m = /^([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\.db$/.exec(f);
      if (!m || espaces.has(m[1])) continue;
      try { espaces.set(m[1], ouvrirEspace(path.join(dossier, f), m[1], ctx)); } catch (e) { journal(`[Secours] espace ${m[1]} illisible :`, e.message); }
    }
  }
  charger();

  const espace = (code) => espaces.get(String(code || '').toLowerCase()) || null;
  // Nœuds en attente (nom court) : attribués dès que la carte voit un seul nœud de ce nom, libre de tout autre espace
  const possesseur = (num) => { for (const e of espaces.values()) if (e.possedeNoeud(num)) return e; return null; };
  function resoudreAttentes() {
    let connus = null;
    const chercher = (nom) => { if (!connus) { try { connus = noeudsCarte() || []; } catch { connus = []; } } const n = String(nom).toLowerCase(); return connus.filter((x) => String(x.court || '').toLowerCase() === n).map((x) => x.num >>> 0); };
    for (const e of espaces.values()) { try { e.resoudreAttentes(chercher, (num) => !possesseur(num)); } catch (err) { journal(`[Secours] nœuds en attente de l’espace ${e.code} :`, err.message); } }
  }
  const lister = () => { resoudreAttentes(); return [...espaces.values()].map((e) => ({ ...e.decrire(), noeudsAttribues: e.lignesNoeuds(), attentes: e.lignesAttentes(), organisations: e.organisations(), canal: e.canalAttribue(), responsables: e.comptes.lister().filter((c) => c.role === 'admin' && c.statut === 'actif').map((c) => c.identifiant) })).sort((a, b) => a.nom.localeCompare(b.nom)); };
  // Ce que voit le sélecteur de l'administrateur de la carte : les nœuds connus de la carte (nom, dernière écoute) et
  // l'espace qui les a déjà ; les canaux du module qu'on peut réserver ; les organisations proposées
  function selecteur() {
    let connus = [];
    try { connus = noeudsCarte() || []; } catch { /* base pas prête */ }
    const noeuds = connus.map((n) => { const e = possesseur(n.num); return { num: n.num >>> 0, id: idNoeud(n.num), court: n.court || null, long: n.long || null, vu: n.vu || null, espace: e ? e.code : null }; });
    let canaux = [];
    try { canaux = radio && radio.canaux ? radio.canaux().filter((c) => c.index > 0 && c.nom).map((c) => c.nom) : []; } catch { /* module absent */ }
    return { noeuds, canaux, associations: ASSOCIATIONS, organisations: Object.fromEntries(Object.entries(GENRES).map(([k, g]) => [k, [...g.organisations, ...ASSOCIATIONS]])) };
  }

  // Un nœud n'appartient qu'à un espace : sa position et ses messages ne vont jamais à deux organisations
  function verifierNoeuds(code, liste) {
    const nums = (Array.isArray(liste) ? liste : String(liste || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean).map(numeroNoeud);
    for (const [c, e] of espaces) if (c !== code) for (const n of nums) if (e.possedeNoeud(n)) throw new Error(`Le nœud ${idNoeud(n)} est déjà attribué à l’espace « ${e.decrire().nom} »`);
    return nums;
  }
  function creer(b, auteur) {
    const code = valider(b.code);
    if (espaces.has(code) || fs.existsSync(fichierDe(code))) throw new Error('Cette adresse est déjà prise par un autre espace');
    if (!GENRES[b.genre]) throw new Error('Type d’espace inconnu');
    const nom = txt(b.nom, 60);
    if (!nom) throw new Error('Nom manquant');
    const r = b.responsable || {};
    if (!r.identifiant || !r.motDePasse) throw new Error('Identifiant et mot de passe du premier responsable requis');
    const noeuds = verifierNoeuds(code, b.noeuds || []);
    fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
    const e = ouvrirEspace(fichierDe(code), code, ctx, { genre: b.genre, nom });
    try {
      e.creerCompte({ identifiant: r.identifiant, motDePasse: r.motDePasse }, true);
      e.definirNoeuds(noeuds, auteur);
      for (const o of Array.isArray(b.organisations) ? b.organisations.slice(0, 30) : []) if (txt(o, 60)) e.majOrganisation(null, { nom: o });
    } catch (err) {
      e.fermer();
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(fichierDe(code) + s); } catch { /* jamais écrit */ } }
      throw err;
    }
    espaces.set(code, e);
    journal(`[Secours] espace « ${nom} » (${code}, ${b.genre.toUpperCase()}) créé par ${auteur}`);
    return e.decrire();
  }
  function modifier(code, b, auteur) {
    const e = espace(code);
    if (!e) throw new Error('Espace inconnu');
    if (b.nom !== undefined) e.reglages({ nom: b.nom });
    if (b.noeuds !== undefined) { e.definirNoeuds(verifierNoeuds(e.code, b.noeuds), auteur); journal(`[Secours] nœuds de l’espace ${e.code} redéfinis par ${auteur} (${e.noeudsAttribues().length})`); }
    // Organisations de l'espace : { nom, couleur } (nouvelle), { id, nom… } ou { id, supprimer }
    let organisation = null;
    if (b.organisation) organisation = e.majOrganisation(b.organisation.id || null, b.organisation);
    // Nœuds choisis dans la liste de la carte : { noeuds, organisation } (identifiant d'organisation, ou « nouvelle »
    // pour celle créée dans le même appel)
    const org = (v) => (v === 'nouvelle' ? (organisation || {}).id || null : v || null);
    if (b.attribuer) { const n = e.attribuer(verifierNoeuds(e.code, b.attribuer.noeuds || []), org(b.attribuer.organisation), auteur); journal(`[Secours] ${n.length} nœud(s) attribué(s) à l’espace ${e.code} par ${auteur}`); }
    if (b.retirer) { const n = e.retirerNoeuds(b.retirer); journal(`[Secours] ${n.length} nœud(s) retiré(s) de l’espace ${e.code} par ${auteur}`); }
    if (b.attendre) {
      const nom = txt(b.attendre.nom, 12);
      for (const [c, autre] of espaces) if (c !== e.code && autre.lignesAttentes().some((a) => a.nom.toLowerCase() === nom.toLowerCase())) throw new Error(`« ${nom} » est déjà attendu par l’espace « ${autre.decrire().nom} »`);
      e.attendre(nom, org(b.attendre.organisation), auteur);
      resoudreAttentes();
    }
    if (b.retirerAttente) e.retirerAttente(b.retirerAttente);
    // Canal du module de la carte réservé à l'espace (un canal ne sert qu'à un espace) ; vide : plus de canal réservé
    if (b.canal !== undefined) {
      const nom = txt(b.canal, 40);
      if (nom) {
        let connus = [];
        try { connus = radio && radio.canaux ? radio.canaux() : []; } catch { /* module absent */ }
        const c = connus.find((x) => String(x.nom || '').toLowerCase() === nom.toLowerCase());
        if (!c) throw new Error(`Le module radio de la carte n’a pas de canal « ${nom} »`);
        if (c.index === 0) throw new Error('Le canal principal du module ne peut pas être réservé à un espace');
        for (const [k, autre] of espaces) if (k !== e.code && String(autre.canalAttribue() || '').toLowerCase() === nom.toLowerCase()) throw new Error(`Le canal « ${nom} » est déjà réservé à l’espace « ${autre.decrire().nom} »`);
        e.definirCanal(c.nom);
      } else e.definirCanal(null);
      journal(`[Secours] canal réservé de l’espace ${e.code} : ${nom || 'aucun'} (par ${auteur})`);
    }
    if (b.responsable) {
      if (!b.responsable.identifiant || !b.responsable.motDePasse) throw new Error('Identifiant et mot de passe du responsable requis');
      e.nommerResponsable(b.responsable);
      journal(`[Secours] responsable « ${txt(b.responsable.identifiant, 32)} » nommé dans l’espace ${e.code} par ${auteur}`);
    }
    return e.decrire();
  }
  // Suppression : le fichier part dans secours/corbeille/ (rien n'est détruit), l'adresse redevient libre
  function supprimer(code, auteur) {
    const e = espace(code);
    if (!e) return { ok: true };
    e.fermer();
    espaces.delete(e.code);
    const corbeille = path.join(dossier, 'corbeille');
    fs.mkdirSync(corbeille, { recursive: true, mode: 0o700 });
    const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
    for (const s of ['', '-wal', '-shm']) { try { fs.renameSync(fichierDe(e.code) + s, path.join(corbeille, `${e.code}-${horodatage}.db${s}`)); } catch { /* fichier annexe absent */ } }
    journal(`[Secours] espace ${e.code} supprimé par ${auteur} (fichier gardé dans secours/corbeille)`);
    return { ok: true };
  }

  // ---- Sessions : « code.jeton », lu seulement par l'espace nommé ---------------------------------------------------
  function session(valeur) {
    const m = /^([a-z0-9-]{3,32})\.(.+)$/.exec(String(valeur || ''));
    const e = m && espace(m[1]);
    const compte = e ? e.comptes.lireJeton(m[2]) : null;
    return compte ? { espace: e, compte } : null;
  }
  const jeton = (e, compte) => `${e.code}.${e.comptes.jeton(compte)}`;

  // Message texte : à l'espace qui possède le nœud ; sinon à celui dont c'est le canal réservé
  function texteRecu(evt) {
    const sien = evt && evt.de != null ? possesseur(evt.de >>> 0) : null;
    for (const e of sien ? [sien] : espaces.values()) { try { if (e.texteRecu(evt)) return true; } catch (err) { journal('[Secours] message radio :', err.message); } }
    return false;
  }
  // Paquet reçu par la carte : vrai s'il revient à un espace (message ou point de passage d'un de ses nœuds, ou
  // message sur son canal réservé). La carte ne le montre alors pas à ses membres : le serveur s'en charge.
  function recu(evt) {
    if (!evt || evt.de == null) return false;
    if (evt.port === 'texte' && evt.texte) return texteRecu(evt);
    if (evt.port === 'waypoint' && evt.pointRepere) { const e = possesseur(evt.de >>> 0); if (!e) return false; try { e.pointRecu(evt); } catch (err) { journal('[Secours] point de passage :', err.message); } return true; }
    return false;
  }
  // Le module radio de la carte tombe ou revient : chaque espace le note (bandeau, main courante)
  const veilleRadio = () => {
    if (!radio) return;
    let c = false;
    try { c = !!radio.connecte(); } catch { /* module absent */ }
    if (c) radioDejaVue = true;
    if (radioConnectee !== null && c !== radioConnectee) for (const e of espaces.values()) { try { e.radioChange(c); } catch { /* espace fermé */ } }
    radioConnectee = c;
  };
  const minuteries = [setInterval(veilleRadio, 20000), setInterval(resoudreAttentes, 60000)];
  for (const m of minuteries) m.unref();

  const entretien = () => {
    for (const e of espaces.values()) {
      try { e.purger(); } catch (err) { journal(`[Secours] purge de l’espace ${e.code} :`, err.message); }
      e.copier(path.join(dossier, 'copies')).catch((err) => journal(`[Secours] copie de l’espace ${e.code} impossible :`, err.message));
    }
  };
  setInterval(entretien, 6 * 3600000).unref();
  setTimeout(entretien, 90000).unref();

  return { espace, lister, creer, modifier, supprimer, session, jeton, texteRecu, recu, selecteur, resoudreAttentes, veilleRadio, entretien, GENRES, CATEGORIES_DPS,
    fermer: () => { for (const m of minuteries) clearInterval(m); for (const e of espaces.values()) e.fermer(); espaces.clear(); } };
}

module.exports = { creerSecours, numeroNoeud, idNoeud, GENRES, CATEGORIES_DPS, ASSOCIATIONS, OPTIONS, REPERES };
