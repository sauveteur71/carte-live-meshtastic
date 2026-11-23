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
    interventions: { malaise: 'Malaise', traumatisme: 'Chute ou traumatisme', plaie: 'Plaie ou brûlure', detresse: 'Détresse vitale', evacuation: 'Évacuation', renfort: 'Demande de renfort', autre: 'Autre' },
  },
  pcs: {
    nom: 'Plan communal de sauvegarde',
    equipes: { terrain: 'Équipe de terrain', pc: 'Poste de commandement communal', accueil: 'Centre d’accueil', vehicule: 'Véhicule' },
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
  const { journal, positionDe, nomDe, radio = null, espacement = 3000 } = ctx;
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
  `);
  // Envoi radio lié à une entrée de main courante : numéro du paquet, pour suivre son accusé de réception
  if (!db.prepare('PRAGMA table_info(main_courante)').all().some((c) => c.name === 'envoi')) db.exec('ALTER TABLE main_courante ADD COLUMN envoi INTEGER');
  const q = {
    reglage: db.prepare('SELECT valeur FROM reglages WHERE cle = ?'),
    ecrireReglage: db.prepare('INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur'),
    noeuds: db.prepare('SELECT num, ajoute, par FROM noeuds ORDER BY num'),
    noeud: db.prepare('SELECT num FROM noeuds WHERE num = ?'),
    ajouterNoeud: db.prepare('INSERT OR IGNORE INTO noeuds (num, ajoute, par) VALUES (?, ?, ?)'),
    retirerNoeud: db.prepare('DELETE FROM noeuds WHERE num = ?'),
    equipes: db.prepare('SELECT * FROM equipes ORDER BY cree'),
    equipe: db.prepare('SELECT * FROM equipes WHERE id = ?'),
    equipeDuNoeud: db.prepare('SELECT * FROM equipes WHERE noeud = ?'),
    creerEquipe: db.prepare('INSERT INTO equipes (id, nom, genre, lat, lon, effectif, noeud, couleur, etat, etat_heure, consigne, cree) VALUES (@id, @nom, @genre, @lat, @lon, @effectif, @noeud, @couleur, @etat, @etat_heure, @consigne, @cree)'),
    majEquipe: db.prepare('UPDATE equipes SET nom=@nom, genre=@genre, lat=@lat, lon=@lon, effectif=@effectif, noeud=@noeud, couleur=@couleur, consigne=@consigne WHERE id=@id'),
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
    creerIntervention: db.prepare('INSERT INTO interventions (id, heure, lat, lon, genre, titre, detail, urgente, statut, equipe, auteur, origine, maj, cloture) VALUES (@id, @heure, @lat, @lon, @genre, @titre, @detail, @urgente, @statut, @equipe, @auteur, @origine, @maj, @cloture)'),
    majIntervention: db.prepare('UPDATE interventions SET lat=@lat, lon=@lon, genre=@genre, titre=@titre, detail=@detail, urgente=@urgente, statut=@statut, equipe=@equipe, maj=@maj, cloture=@cloture WHERE id=@id'),
    detacherInterventions: db.prepare('UPDATE interventions SET equipe = NULL WHERE equipe = ?'),
    mainCourante: db.prepare('SELECT * FROM main_courante ORDER BY heure DESC LIMIT ?'),
    touteMainCourante: db.prepare('SELECT * FROM main_courante ORDER BY heure'),
    ajouterMc: db.prepare('INSERT INTO main_courante (id, heure, auteur, type, equipe, intervention, texte, origine, envoi) VALUES (@id, @heure, @auteur, @type, @equipe, @intervention, @texte, @origine, @envoi)'),
    purgerMc: db.prepare('DELETE FROM main_courante WHERE heure < ?'),
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

  function reglages(b) {
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
  function definirNoeuds(liste, auteur) {
    const voulus = new Set((Array.isArray(liste) ? liste : String(liste || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean).map(numeroNoeud));
    if (voulus.size > 200) throw new Error('200 nœuds au plus par espace');
    const avant = new Set(noeudsAttribues());
    db.transaction(() => {
      for (const n of avant) if (!voulus.has(n)) { q.retirerNoeud.run(n); q.libererNoeud.run(n); }
      for (const n of voulus) if (!avant.has(n)) q.ajouterNoeud.run(n, Date.now(), auteur || null);
    })();
    touche();
    return noeudsAttribues();
  }

  // ---- Équipes et postes ----------------------------------------------------------------------------------------
  function ligneEquipe(e) {
    const p = e.noeud ? positionDe(e.noeud >>> 0) : null;
    const direct = p && p.lat != null ? { lat: p.lat, lon: p.lon, heure: p.heure || 0 } : null;
    return { id: e.id, nom: e.nom, genre: e.genre, effectif: e.effectif, couleur: e.couleur, etat: e.etat, etatHeure: e.etat_heure, consigne: e.consigne,
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
    const e = eid ? q.equipe.get(eid) : { id: id(), nom: '', genre: Object.keys(G().equipes)[0], lat: null, lon: null, effectif: null, noeud: null, couleur: COULEURS[q.equipes.all().length % COULEURS.length], etat: 'disponible', etat_heure: Date.now(), consigne: null, cree: Date.now() };
    if (!e) throw new Error('Équipe inconnue');
    if (b.nom !== undefined) e.nom = txt(b.nom, 40);
    if (!e.nom) throw new Error('Nom manquant');
    if (b.genre !== undefined) { if (!G().equipes[b.genre]) throw new Error('Type d’équipe inconnu'); e.genre = b.genre; }
    if (b.lat !== undefined || b.lon !== undefined) Object.assign(e, position(b));
    if (b.effectif !== undefined) { const n = nombre(b.effectif); if (n != null && !(n >= 0 && n <= 500)) throw new Error('Effectif invalide'); e.effectif = n == null ? null : Math.round(n); }
    if (b.couleur !== undefined && /^#[0-9a-f]{6}$/i.test(b.couleur)) e.couleur = b.couleur;
    if (b.consigne !== undefined) e.consigne = txt(b.consigne, 200) || null;
    if (b.noeud !== undefined) {
      if (b.noeud === null || b.noeud === '') e.noeud = null;
      else {
        const n = numeroNoeud(b.noeud);
        if (!q.noeud.get(n)) throw new Error('Ce nœud n’est pas attribué à votre espace : demandez-le à l’administrateur de la carte');
        const autre = q.equipeDuNoeud.get(n);
        if (autre && autre.id !== e.id) throw new Error(`Ce nœud est déjà porté par « ${autre.nom} »`);
        e.noeud = n;
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

  // ---- Interventions pointées sur la carte ------------------------------------------------------------------------
  function majIntervention(iid, b, auteur, origine = 'saisie') {
    const nouveau = !iid;
    const x = nouveau ? { id: id(), heure: Date.now(), lat: null, lon: null, genre: 'autre', titre: '', detail: null, urgente: 0, statut: 'a-faire', equipe: null, auteur, origine, maj: Date.now(), cloture: null } : q.intervention.get(iid);
    if (!x) throw new Error('Intervention inconnue');
    const avant = { statut: x.statut, equipe: x.equipe };
    if (b.genre !== undefined) x.genre = G().interventions[b.genre] ? b.genre : 'autre';
    if (b.titre !== undefined) x.titre = txt(b.titre, 80);
    if (!x.titre) x.titre = G().interventions[x.genre];
    if (b.detail !== undefined) x.detail = txt(b.detail, 600) || null;
    if (b.urgente !== undefined) x.urgente = b.urgente ? 1 : 0;
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
    return q.intervention.get(x.id);
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
  function texteRecu(evt) {
    if (!evt || !evt.texte) return false;
    const de = evt.de >>> 0;
    if (!q.noeud.get(de)) return false;
    const texte = txt(evt.texte, 240);
    const cle = `${de}:${texte}`;
    if (Date.now() - (vus.get(cle) || 0) < 120000) return true; // même message reçu par plusieurs passerelles
    vus.set(cle, Date.now());
    if (vus.size > 500) vus.delete(vus.keys().next().value);
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

  // ---- Envois vers le terrain (messages directs aux nœuds des équipes) ----------------------------------------------
  // Qui envoie : un responsable, ou un équipier affecté à un poste de coordination (PC du dispositif, PC communal)
  function peutEnvoyer(compte) {
    if (estResponsable(compte)) return true;
    const a = q.affectation.get(compte.id), e = a && a.equipe ? q.equipe.get(a.equipe) : null;
    return !!e && e.genre === 'pc';
  }
  let envoisRecents = [];
  const accuse = (n) => { if (n == null || !radio) return null; const e = radio.etatEnvoi(n); return e ? e.statut : null; };
  // b : { texte, equipe } (une équipe) ou { texte } (toutes celles qui portent un nœud, l'une après l'autre)
  function envoyer(compte, b) {
    if (!radio) throw new Error('Envoi par radio indisponible sur cette carte');
    if (!peutEnvoyer(compte)) throw new Error('Envoi par radio réservé aux responsables et au poste de coordination');
    const texte = couper(txt(b.texte, 600), 200);
    if (!texte) throw new Error('Message vide');
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
    const auteur = signature(compte), inter = b.intervention || null;
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
  // Intervention envoyée par radio : intitulé, position (et code DFCI), précisions ; à l'équipe engagée, sinon à
  // celle choisie, sinon à toutes
  function diffuserIntervention(iid, b, compte) {
    const x = q.intervention.get(iid);
    if (!x) throw new Error('Intervention inconnue');
    const dfci = x.lat != null ? versDfci(x.lat, x.lon) : null;
    const texte = [`INTER ${x.titre}${x.urgente ? ' (URGENT)' : ''}`, x.lat != null ? `${x.lat.toFixed(5)},${x.lon.toFixed(5)}${dfci ? ' DFCI ' + dfci : ''}` : null, x.detail].filter(Boolean).join(' · ');
    return envoyer(compte, { texte, equipe: b.equipe !== undefined ? b.equipe || null : x.equipe, intervention: x.id });
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
      listes: { equipes: G().equipes, interventions: G().interventions, etats: ETATS_EQUIPE, categories: genre() === 'dps' ? CATEGORIES_DPS : null, typesMc: TYPES_MC },
      evenement: ev, centre: centre(), conservationJours: Number(lire('conservation')) || 365,
      effectif: { prevu, categorie: cat, conforme: cat ? prevu >= cat.min && (cat.max == null || prevu <= cat.max) : null },
      equipes, interventions: q.interventions.all(Date.now() - 12 * 3600000),
      mainCourante: q.mainCourante.all(300).map((m) => (m.envoi != null ? { ...m, accuse: accuse(m.envoi) } : m)),
      radio: { disponible: !!radio, connecte: !!radio && !!radio.connecte(), peutEnvoyer: peutEnvoyer(compte), accuses: ACCUSES },
      noeuds: estResponsable(compte) ? noeudsAttribues().map((n) => ({ num: n, id: idNoeud(n), nom: nomDe(n) || null })) : undefined,
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
    majEquipe, changerEtat, majIntervention, ajouterMc: (b, compte) => ajouterMc(b, signature(compte)), csvMc, texteRecu,
    envoyer, diffuserIntervention, peutEnvoyer,
    // Accusés des envois de la dernière heure : la page les relit sans recharger tout l'état
    accuses: () => q.mainCourante.all(300).filter((m) => m.envoi != null && Date.now() - m.heure < 3600000).map((m) => ({ id: m.id, accuse: accuse(m.envoi) })),
    estResponsable, signature, creerCompte, majCompte, nommerResponsable, etat, rev: () => rev, purger, copier,
    equipeDe: (compte) => (q.affectation.get(compte.id) || {}).equipe || null,
    fermer: () => { try { db.close(); } catch { /* déjà fermée */ } },
  };
}

// ---- Tous les espaces de la carte ----------------------------------------------------------------------------------
// radio : { connecte(), envoyerTexte({ texte, dest }, auteur) → { id }, etatEnvoi(id) → { statut } } ; absent : pas d'envoi
function creerSecours({ config, journal = () => {}, positionDe = () => null, nomDe = () => null, radio = null, espacement = 3000 }) {
  const dossier = path.join(path.dirname(config.fichierBase), 'secours');
  const ctx = { journal, positionDe, nomDe, radio, espacement };
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
  const lister = () => [...espaces.values()].map((e) => ({ ...e.decrire(), noeudsAttribues: e.noeudsAttribues().map((n) => ({ num: n, id: idNoeud(n), nom: nomDe(n) || null })), responsables: e.comptes.lister().filter((c) => c.role === 'admin' && c.statut === 'actif').map((c) => c.identifiant) })).sort((a, b) => a.nom.localeCompare(b.nom));

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

  function texteRecu(evt) { for (const e of espaces.values()) { try { if (e.texteRecu(evt)) return; } catch (err) { journal('[Secours] message radio :', err.message); } } }

  const entretien = () => {
    for (const e of espaces.values()) {
      try { e.purger(); } catch (err) { journal(`[Secours] purge de l’espace ${e.code} :`, err.message); }
      e.copier(path.join(dossier, 'copies')).catch((err) => journal(`[Secours] copie de l’espace ${e.code} impossible :`, err.message));
    }
  };
  setInterval(entretien, 6 * 3600000).unref();
  setTimeout(entretien, 90000).unref();

  return { espace, lister, creer, modifier, supprimer, session, jeton, texteRecu, entretien, GENRES, CATEGORIES_DPS,
    fermer: () => { for (const e of espaces.values()) e.fermer(); espaces.clear(); } };
}

module.exports = { creerSecours, numeroNoeud, idNoeud, GENRES, CATEGORIES_DPS };
