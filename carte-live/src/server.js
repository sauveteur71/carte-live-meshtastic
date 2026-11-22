'use strict';
// Carte live Meshtastic — serveur : MQTT -> décodage -> SQLite -> API REST + WebSocket temps réel

// Réglages avancés faits depuis la carte : appliqués avant toute lecture de la configuration (ils priment sur le .env)
const variables = require('./variables');
variables.appliquer();

const http = require('http');
const { ecrireSur, lireJson } = require('./fichiers');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const mqtt = require('mqtt');
const { WebSocketServer } = require('ws');
// Langue du journal : LANGUE=en (ou la langue par défaut de l'édition, champ langueServeur de package.json)
const LANGUE_SERVEUR = String(process.env.LANGUE || require('../package.json').langueServeur || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
require('./traduction').installerJournal(LANGUE_SERVEUR);

// Restauration d'une sauvegarde complète préparée avant le redémarrage : appliquée avant de lire les réglages et la base
{
  const fb = (process.env.FICHIER_BASE || '/data/carte-live.db').trim();
  try { require('./restauration').appliquerSiPrete(path.dirname(fb), path.basename(fb), (...a) => console.log(new Date().toISOString(), ...a)); } catch (e) { console.log(new Date().toISOString(), '[Restauration] impossible :', e.message); }
}
const config = require('./config');
const VERSION = require('../package.json').version;
const { calculerVoisins, calculerRegions } = require('./voisins');
const { creerInstallations } = require('./installations');
const { creerAsymetrie } = require('./asymetrie');
const { creerCouvertureMesuree } = require('./couverture-mesuree');
const { creerHistorique } = require('./historique');
const { creerSauvegardes } = require('./sauvegardes');
const { creerSanteCarte, instrumenterMinuteries, chrono: chronoTache, noter: noterTache } = require('./sante-carte');
// Toutes les minuteries du serveur sont chronométrées (tableau « tâches les plus lentes » de la santé de la carte)
instrumenterMinuteries();
const { performance } = require('perf_hooks');
const { creerMaintenance } = require('./maintenance');
const { creerExports } = require('./exports');
const { creerFederation } = require('./federation');
const { creerReleves } = require('./releves');
const { creerAudit } = require('./audit');
const { creerNouveaux } = require('./nouveaux');
const { creerRapport } = require('./rapport');
const { creerSitesRoutiers } = require('./sites-routiers');
const { creerDonateurs } = require('./donateurs');
const installations = creerInstallations(path.dirname(config.fichierBase));
let federation = null; // créée une fois le réseau prêt (voir plus bas)
// Zone « département + voisins », recalculée si le département ou sa zone changent (installation, réglages)
let cacheVoisins = { cle: null, val: null };
function zoneVoisins() {
  const cle = `${config.departement.code}|${config.zone.join(',')}`;
  if (cacheVoisins.cle !== cle) cacheVoisins = { cle, val: calculerVoisins(config.departement.code, config.zone) };
  return cacheVoisins.val;
}
// Paramètre ?zone= : 1 = département, v = département + voisins, r84 = une région (code INSEE), sinon toute la carte
const bboxZone = (q) => {
  if (q === '1') return config.zone;
  if (q === 'v') return (zoneVoisins() || {}).bbox || config.zone;
  const m = /^r(\d{2})$/.exec(String(q || ''));
  if (m) { const r = calculerRegions().find((x) => x.code === m[1]); return r ? r.bbox : null; }
  return null;
};
const { decoderMessage, preparerCanaux } = require('./decodeur');
const { creerStockage } = require('./base');
const { creerReseau } = require('./reseau');
const { creerSourceMeshMonitor } = require('./meshmonitor');
const { creerSourceRadio } = require('./radio');
const { creerAnalyse } = require('./analyse');
const { creerRelief, contourDepartement, nomDepartement } = require('./relief');
const { creerReliefGrossier } = require('./relief-grossier');
const { creerCacheRelief } = require('./relief-cache');
const { creerComptes } = require('./comptes');
const { creerAdministration } = require('./administration');
const { creerAgents } = require('./agents');
const { creerReseauMc } = require('./meshcore/reseau');
const { creerCompanion } = require('./meshcore/companion');
const { lireMessageMc, creerPublicateurMc, RE_SUJET: RE_SUJET_MC } = require('./meshcore/mqtt');
const { preparerCanauxMc, decoderPaquet: decoderPaquetMc } = require('./meshcore/paquet');
const { creerAdministrationMc } = require('./meshcore/administration');
const fs = require('fs');

const journal = (...a) => console.log(new Date().toISOString(), ...a);

const stockage = creerStockage(config.fichierBase);
const reseau = creerReseau(stockage, config);
const canaux = preparerCanaux(config.canaux);
journal(`Canaux configurés : ${canaux.map((c) => `${c.nom} (hachage ${c.hachage})`).join(', ')}`);
const canauxMc = preparerCanauxMc(config.meshcore.canaux);
const reseauMc = creerReseauMc(stockage.db, config, canauxMc, (...a) => journal('[MeshCore]', ...a));
// Index plein texte des messages (créé et rempli au premier démarrage, tenu à jour par des déclencheurs SQLite)
const rechercheMessages = require('./recherche-messages').creerRechercheMessages(stockage.db, journal);
if (config.meshcore.actif) journal(`MeshCore : canaux ${canauxMc.map((c) => c.nom).join(', ') || 'aucun'}, sujets ${config.meshcore.racine}/#`);

// ---- Comptes et sessions ------------------------------------------------------
const comptes = creerComptes(stockage.db, config);
function lireCookie(req, nom) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map((x) => x.trim()).find((x) => x.startsWith(nom + '='));
  return m ? decodeURIComponent(m.slice(nom.length + 1)) : null;
}
const utilisateur = (req) => comptes.lireJeton(lireCookie(req, 'gaulix_session'));
const audit = creerAudit(stockage.db);
const courriel = require('./courriel').creerCourriel({ config, journal });
// Fréquentation (administrateurs) : compteurs par jour, sans adresse IP gardée ; pays par la base DB-IP sur place
const frequentation = require('./frequentation').creerFrequentation({ db: stockage.db, config, journal, clientsEnLigne: () => (typeof wss !== 'undefined' ? wss.clients.size : 0) });
// Mur des donateurs (HelloAsso + GitHub Sponsors) : désactivé tant qu'aucune source n'est configurée
const donateurs = creerDonateurs({ config, journal });
const nomCompte = (c) => (c ? c.indicatif ? `${c.identifiant} (${c.indicatif})` : c.identifiant : null);
// « Membre » : tout compte connecté (messages texte, positions exactes) ; « admin » : réglages et pilotage
// Démonstration (?consultation, en-tête X-Demo) : un visiteur lit en plus, en GET seulement, une liste d'écrans de
// membre ou d'administrateur ; les réponses passent par nettoyerDemo (mots de passe, clés, adresses, contacts masqués).
// Toute écriture reste refusée : un visiteur n'a aucun compte.
const estMembre = (req) => !!utilisateur(req) || !!req.demoLecture;
const estAdmin = (req) => { const u = utilisateur(req); return (!!u && u.role === 'admin') || !!req.demoLecture; };
// Gestion par secteur : l'admin gère tout, un « gestionnaire » seulement les nœuds de sa liste
const estGestion = (req) => { const u = utilisateur(req); return (!!u && (u.role === 'admin' || u.role === 'gestionnaire')) || !!req.demoLecture; };
function peutGerer(req, id) {
  if (req.demoLecture) return true;
  const u = utilisateur(req);
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.role !== 'gestionnaire') return false;
  const k = /^[0-9a-f]{64}$/i.test(String(id)) ? String(id).toUpperCase() : String(Number(id) >>> 0);
  return (u.noeuds || []).includes(k);
}
const peutGererTous = (req, ids) => (ids || []).every((x) => peutGerer(req, x));
function refuserSecteur(res) { res.status(403).json({ erreur: 'Ce nœud n’est pas dans votre secteur : demandez à un administrateur' }); return false; }
function ouvrirSession(req, res, compte) {
  const securise = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gaulix_session=${encodeURIComponent(comptes.jeton(compte))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${comptes.DUREE_SESSION / 1000}${securise}`);
}
// Adresse réelle du client (sans tenir compte des en-têtes de proxy, falsifiables)
// Une requête passée par un proxy inversé (en-têtes X-Forwarded-For…) n'est jamais considérée comme locale :
// derrière Nginx / Traefik / Cloudflare, l'adresse vue est celle du proxy, pas celle du visiteur.
function ipPrivee(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded || req.headers['cf-connecting-ip']) return false;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd]/i.test(ip);
}

const tentatives = new Map();
function limiter(ip) {
  const maintenant = Date.now();
  const t = (tentatives.get(ip) || []).filter((x) => maintenant - x < 15 * 60000);
  t.push(maintenant);
  tentatives.set(ip, t);
  return t.length > 8;
}
setInterval(() => {
  const limite = Date.now() - 15 * 60000;
  for (const [ip, t] of tentatives) if (!t.some((x) => x > limite)) tentatives.delete(ip);
}, 15 * 60000).unref();

// ---- Application web ------------------------------------------------------
const app = express();
// En-têtes X-Forwarded-* acceptés seulement s'ils viennent d'une adresse locale (proxy inversé de DSM, Tailscale) :
// un client Internet ne peut pas falsifier son adresse pour contourner la limite de tentatives
app.set('trust proxy', config.proxyConfiance);
app.disable('x-powered-by');
app.use(require('compression')({ threshold: 1024 })); // gzip : pages et API 5 à 10 fois plus légères (accès à distance)
// Corps JSON : 10 ko, sauf la restauration d'une sauvegarde
const jsonPetit = express.json({ limit: '10kb' }), jsonGros = express.json({ limit: '30mb' });
const jsonPhoto = express.json({ limit: '5mb' });
app.use((req, res, next) => (req.path === '/api/sauvegardes/restaurer' ? jsonGros : req.path === '/api/releves' ? jsonPhoto : jsonPetit)(req, res, next));
// Journal d'audit : toute action (hors lecture) d'un utilisateur connecté, avec son résultat
const SANS_AUDIT = new Set(['/api/connexion', '/api/deconnexion', '/api/installation', '/api/inscription', '/api/releves']);
// Champs masqués dans le journal d'audit pour une route donnée (le nom d'un donateur n'y a rien à faire)
const AUDIT_MASQUES = { '/api/donateurs/manuel': ['nom'] };
app.use((req, res, next) => {
  if (req.method === 'GET' || !req.path.startsWith('/api/') || SANS_AUDIT.has(req.path)) return next();
  const u = utilisateur(req);
  if (!u) return next();
  res.on('finish', () => audit.noter(nomCompte(u), req.ip, `${req.method} ${req.path}`, audit.resumer(req.body, AUDIT_MASQUES[req.path] || []), res.statusCode < 400));
  next();
});
// ---- Démonstration en lecture (lien « Explorer en détail ») ------------------------------------------------
// Écrans lisibles par un visiteur en démonstration (GET seulement) : jamais les comptes, le journal d'audit, les
// sauvegardes, les clés d'équipe, les QR de canaux, les exports YAML ni la mise à jour.
const DEMO_LECTURE = [
  /^\/api\/messages(\/\d+\/parcours|\/recherche)?$/, /^\/api\/mc\/messages$/, /^\/api\/trames\/\d+$/, /^\/api\/paquets$/,
  /^\/api\/admin-noeuds(\/(modeles|favoris|firmware|conformite-auto|v28|taches\/[\w-]+|lecture\/\d+(\/detail)?))?$/,
  /^\/api\/lorawan(\/[\w:.-]+)?$/, /^\/api\/trafic\/controle$/, /^\/api\/noeuds-nouveaux$/, /^\/api\/installations$/, /^\/api\/responsables$/,
  /^\/api\/mc\/(admin(\/modeles|\/taches\/[\w-]+)?|maintenance|audit\/(regions|collisions)|noeuds\/[0-9A-Fa-f]{64}\/chemin|capteurs\/[0-9A-Fa-f]{64}|companion\/(stats|telemetrie|decouverte))$/,
  /^\/api\/(sante-carte|reglages|diagnostic|alertes-officielles|passerelle|signalements|releves|ecoutes|fond-hors-ligne)$/,
  /^\/api\/maintenance\/[\w-]+$/, /^\/api\/envoi$/, /^\/api\/equipes$/, /^\/api\/firmware\/(info|modules)$/, /^\/api\/radio\/modules$/, /^\/rapport$/,
];
const SECRET_DEMO = /(mot_?de_?passe|motdepasse|password|^pass$|psk|secret|jeton|token|e?mail|channel_?url|urlcanal|privee|private|admin_?keys?|clesadmin|^contact$|telephone|^(hote|ip|host|adresse|url|mqttUrl|urlMqtt|utilisateur|auteur|par)$)/i;
function nettoyerDemo(v, cle = '', prof = 0) {
  if (prof > 12 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => nettoyerDemo(x, cle, prof + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_DEMO.test(k) && (typeof x === 'string' || typeof x === 'number')) { o[k] = x === '' || x == null ? x : '••••'; continue; }
      // Clé de canal (base64, pas une clé publique MeshCore de 64 caractères hexadécimaux)
      if (/^(cle|cles|key|keys)$/i.test(k) && typeof x === 'string' && !/^[0-9A-F]{64}$/i.test(x)) { o[k] = x ? '••••' : x; continue; }
      if (/^(cle|cles|key|keys)$/i.test(k) && Array.isArray(x)) { o[k] = x.map((y) => (typeof y === 'string' && !/^[0-9A-F]{64}$/i.test(y) ? '••••' : y)); continue; }
      o[k] = nettoyerDemo(x, k, prof + 1);
    }
    return o;
  }
  // Liste « nom=clé » des canaux
  if (typeof v === 'string' && /^canaux$/i.test(cle)) return v.replace(/=([^;\n]+)/g, '=••••');
  return v;
}
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.get('X-Demo') !== '1' || utilisateur(req) || !DEMO_LECTURE.some((r) => r.test(req.path))) return next();
  req.demoLecture = true;
  const json = res.json.bind(res);
  res.json = (b) => json(nettoyerDemo(b));
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), { maxAge: '7d' }));
app.use('/vendor/maplibre', express.static(path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist'), { maxAge: '7d' }));
app.use('/vendor/protomaps-leaflet', express.static(path.join(path.dirname(require.resolve('protomaps-leaflet/package.json')), 'dist'), { maxAge: '7d' }));
// Pages : jamais gardées en cache, et leurs feuilles de style et scripts portent le numéro de version
// (après une mise à jour, le navigateur charge forcément les nouveaux fichiers, sans Ctrl+F5)
const pagesVersionnees = new Map();
function pageVersionnee(fichier) {
  if (!pagesVersionnees.has(fichier)) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', fichier), 'utf8')
      .replace(/((?:href|src)="\/(?!vendor\/)[\w.-]+\.(?:css|js))"/g, `$1?v=${VERSION}"`);
    pagesVersionnees.set(fichier, html);
  }
  return pagesVersionnees.get(fichier);
}
const NOMS_PAGES = { 'index.html': 'carte', 'publique.html': 'page publique', 'rejoindre.html': 'rejoindre', 'adrasec.html': 'ADRASEC', 'terrain.html': 'lien terrain' };
const envoyerPage = (fichier) => (req, res) => {
  try { frequentation.noter(req, /CarteLiveAndroid/.test(req.get('user-agent') || '') ? 'appli Android' : NOMS_PAGES[fichier] || fichier.replace(/\.html$/, '')); } catch { /* comptage sans importance */ }
  res.set('Cache-Control', 'no-cache').type('html').send(pageVersionnee(fichier));
};
app.get('/api/frequentation', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(frequentation.resume(req.query.jours));
});
app.get(['/', '/index.html'], envoyerPage('index.html'));
app.get('/publique.html', envoyerPage('publique.html'));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m', index: false }));
// Temps bloquant de chaque route : partie synchrone du traitement, et envoi d'une réponse JSON préparée plus tard
// (après une attente). Noté dans le registre des tâches de la santé de la carte, sous « GET /api/… ». Placé après
// les fichiers statiques : de là jusqu'à la route, Express enchaîne sans attendre.
app.use((req, res, next) => {
  const t0 = performance.now();
  let retour = false;
  const nomRoute = () => `${req.method} ${req.route && typeof req.route.path === 'string' ? (req.baseUrl || '') + req.route.path : req.path.startsWith('/api/') ? req.path.replace(/\/[0-9a-f!]{4,}$/i, '/:id') : 'page ou fichier'}`;
  const json = res.json;
  res.json = function jsonChronometre(corps) {
    if (!retour) return json.call(this, corps);
    const t = performance.now();
    try { return json.call(this, corps); } finally { noterTache(nomRoute(), performance.now() - t); }
  };
  try { next(); } finally { retour = true; noterTache(nomRoute(), performance.now() - t0); }
});

// Version installée et dernière version publiée sur GitHub (vérifiée toutes les heures, et à l'ouverture de la mise à jour)
const DEPOT = process.env.DEPOT_GITHUB || 'sauveteur71/carte-live-meshtastic';
const majDispo = { version: null, url: null, verifie: 0, erreur: null };
const comparerVersions = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
async function verifierDerniereVersion() {
  if (/^(0|non|no|false|off)$/i.test(String(process.env.VERIFIER_MAJ || ''))) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${DEPOT}/releases/latest`, { headers: { 'User-Agent': 'carte-live/' + VERSION, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    majDispo.version = String(j.tag_name || '').replace(/^v/i, '') || null;
    majDispo.url = j.html_url || null;
    majDispo.erreur = null;
  } catch (e) { majDispo.erreur = e.message; }
  majDispo.verifie = Date.now();
}
setTimeout(verifierDerniereVersion, 15000);
setInterval(verifierDerniereVersion, 3600000).unref();
const infosVersion = () => ({ version: VERSION, derniere: majDispo.version, url: majDispo.url || `https://github.com/${DEPOT}/releases`, majDisponible: !!(majDispo.version && comparerVersions(majDispo.version, VERSION) > 0), verifie: majDispo.verifie || null });
app.get('/api/version', (req, res) => res.json(infosVersion()));
// Aide intégrée : pages du wiki (texte Markdown), affichées dans la carte par le bouton « ? »
const DOSSIER_AIDE = [path.join(__dirname, '..', 'wiki'), path.join(__dirname, '..', '..', 'wiki')].find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
app.get('/api/aide/:page', (req, res) => {
  const nom = String(req.params.page).normalize('NFC');
  if (!DOSSIER_AIDE || !/^[\p{L}\p{N}_-]{1,60}$/u.test(nom)) return res.status(404).json({ erreur: 'Page d’aide introuvable' });
  const f = fs.readdirSync(DOSSIER_AIDE).find((x) => x.normalize('NFC') === nom + '.md');
  if (!f) return res.status(404).json({ erreur: 'Page d’aide introuvable' });
  // Version anglaise (wiki/en/<même nom>.md) quand elle existe
  const en = req.query.langue === 'en' ? path.join(DOSSIER_AIDE, 'en', f) : null;
  if (en && fs.existsSync(en)) return res.set('Cache-Control', 'max-age=300').json({ page: nom, langue: 'en', texte: fs.readFileSync(en, 'utf8') });
  res.set('Cache-Control', 'max-age=300').json({ page: nom, langue: 'fr', texte: fs.readFileSync(path.join(DOSSIER_AIDE, f), 'utf8') });
});

app.get('/api/config', (req, res) => {
  res.json({
    fonctionsMasquees: typeof fonctionsMasquees !== 'undefined' ? masqueesEffectives() : [],
    urgence: (() => { try { return estMembre(req) ? urgence.etat() : null; } catch { return null; } })(),
    version: infosVersion(),
    freqMHz: Number(process.env.RADIO_FREQ_MHZ) || 869.525,
    titre: config.carte.titre,
    outils: { client: config.urlClient || '', flasher: config.urlFlasher || '' },
    bandeauMonde: config.bandeauMonde.actif ? { url: config.bandeauMonde.url } : null,
    centre: [config.carte.centreLat, config.carte.centreLon],
    zoom: config.carte.zoom,
    tuiles: config.carte.tuiles,
    fondHorsLigne: typeof fondsHorsLigne !== 'undefined' ? (fondsHorsLigne.etat().fond || null) : null,
    retentionJours: config.retentionJours,
    seuils: config.seuils,
    admin: estAdmin(req),
    gestion: estGestion(req),
    membre: estMembre(req),
    compte: utilisateur(req),
    passerelleMembres: passerelleMembresActive(),
    installation: comptes.installationRequise(),
    inscriptions: config.inscriptions,
    departement: config.departement,
    zone: config.zone,
    zoneVoisins: zoneVoisins(),
    regions: calculerRegions().map(({ code, nom, bbox }) => ({ code, nom, bbox })),
    zoneNom: config.zoneNom,
    radio: true,
    rejoindre: adhesion.actif(),
    meshcore: config.meshcore.actif && config.carte.reseaux !== 'meshtastic',
    reseaux: config.meshcore.actif ? config.carte.reseaux : 'meshtastic',
    mcRadioAttendue: config.meshcore.radioAttendue,
    fond: config.carte.fond,
    couchesMasquees: config.carte.couchesMasquees,
    lienDistanceMaxKm: config.lienDistanceMaxKm,
    couverturePublique: reliefPublic.couverture,
    passerelle: !!(passerelle && passerelle.active()),
    passerelleDispo: !!passerelle,
    precisionPublique: config.precisionPublique,
  });
});

// Liste complète des nœuds : des milliers avec le flux msh/EU_868 (plusieurs Mo de JSON). Elle est préparée au plus
// toutes les 10 s et la même réponse sert tous les navigateurs (une vue membre, une vue publique). ?depuis=heure :
// seulement les nœuds modifiés depuis (mise à jour incrémentale de la carte, quelques nœuds au lieu de milliers).
// L'en-tête X-Heure donne l'heure serveur de préparation de la liste : c'est le repère que le navigateur renvoie en
// ?depuis= (et non le maximum des heures des nœuds : une horloge GPS dans le futur gelait la liste incrémentale).
// Un ?depuis= trop ancien (plus de 10 min : onglet endormi) reçoit la liste complète en cache.
let cacheNoeuds = {};
function viderCacheNoeuds(ageMs = 0) { for (const k of Object.keys(cacheNoeuds)) if (Date.now() - cacheNoeuds[k].heure >= ageMs) delete cacheNoeuds[k]; }
app.get('/api/noeuds', (req, res) => {
  const admin = estMembre(req);
  const maintenant = Date.now();
  const depuis = Number(req.query.depuis) || 0;
  res.set('Cache-Control', 'private, no-cache').set('Vary', 'Cookie, Accept-Encoding').set('X-Heure', String(maintenant));
  if (depuis > 0 && maintenant - depuis < 600000) return res.set('Cache-Control', 'no-store').json({ heure: maintenant, ...reseau.noeudsDepuis(Math.min(depuis, maintenant) - 5000, admin) });
  const k = admin ? 'membre' : 'public';
  let c = cacheNoeuds[k];
  if (!c || maintenant - c.heure > 10000) {
    const corps = Buffer.from(JSON.stringify(stockage.q.noeuds.all().map((n) => reseau.vueNoeud(n, admin, maintenant))));
    // Version gzip gardée avec la liste : compressée une fois toutes les 10 s au lieu d'une fois par navigateur
    const gz = corps.length > 1024 ? zlib.gzipSync(corps, { level: 5 }) : null;
    c = cacheNoeuds[k] = { heure: maintenant, corps, gz, etag: `W/"${corps.length.toString(16)}-${crypto.createHash('sha1').update(corps).digest('base64').slice(0, 20)}"` };
  }
  res.set('ETag', c.etag).set('X-Heure', String(c.heure)).type('json');
  if (req.fresh) return res.status(304).end();
  if (c.gz && req.acceptsEncodings('gzip')) return res.set('Content-Encoding', 'gzip').send(c.gz);
  res.send(c.corps);
});

app.get('/api/noeuds/:num', (req, res) => {
  const num = Number(req.params.num) >>> 0;
  const d = reseau.detailNoeud(num, estMembre(req));
  if (!d) return res.status(404).json({ erreur: 'Nœud inconnu' });
  d.sante = analyse.sante(num);
  if (estMembre(req)) d.installation = installations.lire(num, peutGerer(req, num));
  d.gerable = peutGerer(req, num);
  res.json(d);
});
// Fiche d'installation d'un relais (antenne, hauteur, alimentation, site) : lecture membres, écriture admin
let minuterieReclassement = null;
app.put('/api/noeuds/:num/installation', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!peutGerer(req, req.params.num)) return refuserSecteur(res);
  try {
    const c = utilisateur(req);
    const r = installations.ecrire(Number(req.params.num) >>> 0, req.body || {}, c ? c.indicatif || c.identifiant : null);
    // Le classement des sites tient compte des vraies antennes du réseau : recalcul différé (plusieurs fiches de suite)
    clearTimeout(minuterieReclassement); minuterieReclassement = setTimeout(() => relief.calculerClassement(), 60000);
    res.json({ ok: true, installation: r });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/installations', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const admin = estAdmin(req), t = installations.toutes();
  res.json(Object.fromEntries(Object.keys(t).map((k) => [k, installations.lire(k, admin)])));
});

// Couverture mesurée : mesures réelles (position de l'émetteur, passerelle qui reçoit, SNR), par cellule de 500 m
let couvMesuree = null;
const mesures = () => couvMesuree || (couvMesuree = creerCouvertureMesuree(stockage));
app.get('/api/couverture-mesuree', (req, res) => {
  const jours = Math.min(Math.max(Number(req.query.jours) || 7, 1), config.retentionJours);
  const noeud = req.query.noeud ? Number(req.query.noeud) >>> 0 : null;
  res.json(mesures().calculer({ jours, noeud }));
});

// Liaisons à sens unique, déséquilibrées, et nœuds que personne n'entend
let asymetrie = null;
function obtenirAsymetrie() {
  if (!asymetrie) asymetrie = creerAsymetrie(stockage, config, {
    // Puissance d'émission : fiche d'installation, sinon configuration LoRa lue à distance (0 = défaut du matériel, inconnue)
    puissance: (num) => {
      const f = installations.radio(num);
      if (f.ptx != null) return f.ptx;
      const l = administration.detailLecture(num);
      return l && l.lora && l.lora.txPower > 0 ? l.lora.txPower : null;
    },
    seuilDemod: () => {
      const pr = presetReseau() || config.reseauPreset || 'LONG_FAST';
      const sf = (require('./analyse').PRESETS[pr] || { sf: 11 }).sf;
      return -7.5 - 2.5 * (sf - 7);
    },
  });
  return asymetrie;
}
app.get('/api/liaisons/asymetrie', (req, res) => res.json(obtenirAsymetrie().calculer()));

app.get('/api/analyse', (req, res) => {
  const heures = Math.min(Math.max(Number(req.query.heures) || 24, 1), config.retentionJours * 24);
  res.json(analyse.analyse(heures, bboxZone(req.query.zone)));
});

app.get('/api/profil', async (req, res) => {
  const nb = (v) => (v === undefined || v === '' ? undefined : Number(v));
  try {
    res.json(await analyse.profil({
      a: Number(req.query.a), b: Number(req.query.b), ha: nb(req.query.ha), hb: nb(req.query.hb),
      ptx: nb(req.query.ptx), ga: nb(req.query.ga), gb: nb(req.query.gb), pertes: nb(req.query.pertes), preset: req.query.preset,
      aLat: nb(req.query.aLat), aLon: nb(req.query.aLon), bLat: nb(req.query.bLat), bLon: nb(req.query.bLon),
      aNom: req.query.aNom ? String(req.query.aNom).slice(0, 60) : undefined, bNom: req.query.bNom ? String(req.query.bNom).slice(0, 60) : undefined,
      membre: estMembre(req),
    }));
  } catch (e) {
    res.status(400).json({ erreur: e.message });
  }
});

// ---- Relief et planification radio ----------------------------------------------
const optsRelief = (q) => {
  const nb = (v, min, max) => { const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) ? undefined : Math.min(max, Math.max(min, n)); };
  return { hs: nb(q.hs, 0, 100), ht: nb(q.ht, 0, 50), ptx: nb(q.ptx, 0, 30), marge: nb(q.marge, 0, 30), rayonKm: nb(q.rayon, 5, 60), env: nb(q.env, 0, 40), preset: q.preset, acces: ['voiture', '4x4', 'pied'].includes(q.acces) ? q.acces : undefined };
};
// Relief d'un autre département (?dep=25) : instance séparée, créée à la demande (2 au plus en mémoire)
const reliefsEtude = new Map();
// Couverture de la carte publique : département de la carte seulement, ou toute la France (choix de l'admin).
// « Préparer toute la France » télécharge à l'avance le relief et les points hauts de chaque département (sur disque),
// pour que le premier calcul d'un département soit rapide.
const fReliefPublic = path.join(path.dirname(config.fichierBase), 'relief-public.json');
let reliefPublic = { couverture: 'departement' };
try { reliefPublic = { ...reliefPublic, ...lireJson(fReliefPublic) }; } catch { /* défaut */ }
const franceOuverte = () => reliefPublic.couverture === 'france';
const precharge = { enCours: false, arret: false, total: 0, faits: 0, deja: 0, erreurs: [], courant: null, etape: null, aCompleter: [], instance: null, debut: null, fin: null };
// ---- Relief grossier mondial (≈ 9 km, NOAA ETOPO1) : affiché le temps que le relief IGN d'un département se télécharge.
// Désactivé par défaut dans l'édition France (le paquet « relief France » et le relief IGN suffisent le plus souvent) :
// à cocher dans Outils › Toute la France, ou RELIEF_MONDE=oui dans le .env.
const GROSSIER_DEFAUT = process.env.RELIEF_MONDE ? /^(oui|1|true|yes|on)$/i.test(process.env.RELIEF_MONDE) : false;
const grossierActif = () => (reliefPublic.grossier === undefined ? GROSSIER_DEFAUT : !!reliefPublic.grossier);
const reliefGrossier = creerReliefGrossier({ dossier: path.dirname(config.fichierBase), journal, minutes: Number(process.env.RELIEF_MONDE_MINUTES) || 5 });
// Téléchargé une fois, en arrière-plan, peu après le démarrage ; nouvel essai toutes les heures en cas d'échec
function lancerReliefGrossier() { if (grossierActif() && !reliefGrossier.pret()) reliefGrossier.telecharger().catch(() => { /* erreur gardée dans l'état */ }); }
setTimeout(lancerReliefGrossier, 20000).unref();
setInterval(lancerReliefGrossier, 3600000).unref();
// Cache du relief sur le disque : espace occupé, purge, plafond (zones les moins récemment utilisées d'abord)
const cacheRelief = creerCacheRelief({
  dossier: path.dirname(config.fichierBase), journal, grossier: reliefGrossier,
  verrous: () => new Set(precharge.enCours && precharge.courant ? [String(precharge.courant).toUpperCase()] : []),
  enMemoire: () => reliefsEtude,
  liberer: (code) => { const v = reliefsEtude.get(code); if (v) { try { v.arreter(); } catch { /* déjà */ } reliefsEtude.delete(code); } },
  nomZone: (code) => nomDepartement(code),
  codePrincipal: config.departement.code,
});
const plafondRelief = () => Math.max(0, Number(reliefPublic.plafondGo) || 0);
// Plafond suspendu pendant « Préparer toute la France / la zone » : sinon il supprimait les zones à peine préparées
const appliquerPlafondRelief = () => { if (precharge.enCours) return; try { cacheRelief.appliquerPlafond(plafondRelief()); } catch (e) { journal('[Relief] plafond :', e.message); } };
setInterval(appliquerPlafondRelief, 3600000).unref();
const reliefSurDisque = (code) => ['mnt-' + code + '.bin', 'sommets-osm-' + code + '.json'].every((f) => fs.existsSync(path.join(path.dirname(config.fichierBase), f)));
// Paquet « relief France » : relief IGN, points hauts, accès, sites et communes de chaque département, en un fichier
// tar.gz. Fabriqué depuis une carte qui a tout préparé (Gestion › Réglages), publié sur GitHub, installé par les autres.
const RE_FICHIER_PAQUET = /^((mnt|sommets-osm|acces-sommets|realisme)-(\d{2}|2A|2B)\.(bin|json)|communes-sommets\.json)$/;
const URL_PAQUET_FRANCE = process.env.RELIEF_FRANCE_URL || 'https://github.com/sauveteur71/carte-live-meshtastic/releases/download/relief-france/relief-france.tar.gz';
function fichiersPaquet() {
  const d = path.dirname(config.fichierBase), code = String(config.departement.code).toUpperCase();
  const l = fs.readdirSync(d).filter((f) => RE_FICHIER_PAQUET.test(f) && fs.statSync(path.join(d, f)).isFile());
  // Département de la carte : fichiers sans suffixe, renommés dans le paquet (mnt.bin → mnt-43.bin)
  const propres = ['mnt.bin', 'mnt.json', 'sommets-osm.json', 'acces-sommets.json', 'realisme.json'].filter((f) => fs.existsSync(path.join(d, f)) && !l.includes(f.replace(/\.(bin|json)$/, `-${code}.$1`)));
  return { d, code, l, propres };
}
function exporterPaquetFrance(res) {
  const { d, code, l, propres } = fichiersPaquet();
  const { spawn } = require('child_process');
  const args = ['-czf', '-', '-C', d, ...propres.map((f) => `--transform=s/^${f.replace('.', '\\.')}$/${f.replace(/\.(bin|json)$/, `-${code}.$1`)}/`), ...propres, ...l];
  const t = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  res.set('Content-Type', 'application/gzip').set('Content-Disposition', 'attachment; filename="relief-france.tar.gz"');
  t.stdout.pipe(res);
  t.stderr.on('data', (x) => journal('[Relief] paquet :', String(x).trim()));
}
async function importerPaquetFrance() {
  const d = path.dirname(config.fichierBase), tmp = path.join(d, 'relief-france.tar.gz.part');
  const r = await fetch(URL_PAQUET_FRANCE, { signal: AbortSignal.timeout(30 * 60000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const { Readable } = require('stream'), { pipeline } = require('stream/promises');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  const { execFileSync } = require('child_process');
  try {
    // Contrôle du contenu avant extraction : uniquement des fichiers de relief attendus, sans dossier
    const noms = execFileSync('tar', ['-tzf', tmp], { maxBuffer: 16 * 1024 * 1024 }).toString().split('\n').map((x) => x.replace(/^\.\//, '')).filter(Boolean);
    const mauvais = noms.filter((n) => !RE_FICHIER_PAQUET.test(n));
    if (mauvais.length) throw new Error(`contenu inattendu (${mauvais.slice(0, 3).join(', ')})`);
    // Ne remplace pas les fichiers déjà présents (un département préparé ici reste celui d'ici)
    execFileSync('tar', ['-xzf', tmp, '-C', d, '--skip-old-files', '--no-same-owner', '--no-same-permissions'], { timeout: 10 * 60000 });
    return noms.length;
  } finally { try { fs.unlinkSync(tmp); } catch { /* déjà */ } }
}
async function prechargerFrance() {
  if (precharge.enCours) return;
  const codes = listeDepartements.map((d) => d.code).filter((c) => c !== String(config.departement.code).toUpperCase());
  // Gardé sur disque : après un redémarrage de la carte (mise à jour), la préparation reprend où elle en était
  reliefPublic.preparation = true; try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch { /* lecture seule */ }
  Object.assign(precharge, { enCours: true, arret: false, total: codes.length, faits: 0, deja: 0, erreurs: [], courant: null, etape: null, aCompleter: [], debut: Date.now(), fin: null });
  journal(`[Relief] préparation de toute la France : ${codes.length} départements`);
  // D'abord le paquet « relief France » publié sur GitHub (un seul téléchargement), s'il manque des départements
  if (codes.some((c) => !reliefSurDisque(c))) {
    precharge.courant = 'paquet';
    try { const n = await importerPaquetFrance(); journal(`[Relief] paquet France : ${n} fichier(s) installé(s)`); } catch (e) { journal(`[Relief] paquet France indisponible (${e.message}) : téléchargement département par département`); if (!/HTTP 404/.test(e.message)) precharge.erreurs.push({ code: 'paquet', erreur: e.message }); }
  }
  // Premier passage sur tous les départements, puis un second (15 min plus tard) pour ceux où OpenStreetMap a manqué
  for (let passage = 1; passage <= 2 && !precharge.arret; passage++) {
  const liste = passage === 1 ? codes : codes.filter((c) => !reliefSurDisque(c));
  if (passage === 2) {
    if (!liste.length) break;
    precharge.courant = null; precharge.etape = `${liste.length} département(s) à compléter (OpenStreetMap saturé) : nouvel essai dans 15 min`;
    journal(`[Relief] ${precharge.etape}`);
    for (let t = 0; t < 180 && !precharge.arret; t++) await new Promise((ok) => setTimeout(ok, 5000));
    precharge.faits -= liste.length;
  }
  for (const code of liste) {
    if (precharge.arret) break;
    if (reliefSurDisque(code)) { if (passage === 1) precharge.deja++; precharge.faits++; continue; }
    precharge.courant = code;
    try {
      const r = reliefsEtude.get(code) || creerRelief(config, journal, { ...fournisseursRelief, envDefaut: () => null }, { code });
      precharge.instance = reliefsEtude.has(code) ? null : r;
      const debut = Date.now();
      // Relief prêt et points hauts classés (ou 20 min au plus)
      while (!precharge.arret && Date.now() - debut < 20 * 60000) {
        const e = r.etat();
        if (e.mnt === 'erreur') throw new Error(e.erreur || 'relief indisponible');
        // … et voies d'accès des points hauts évaluées (OpenStreetMap), pour le choix voiture / 4×4 / à pied
        const a = r.accesEtat ? r.accesEtat() : null;
        precharge.etape = e.mnt !== 'pret' ? `relief IGN ${e.progression || 0} %` : e.classement !== 'pret' ? 'points hauts et classement' : a && a.total ? `voies d'accès ${a.faits}/${a.total}` : 'voies d’accès';
        if (e.mnt === 'pret' && ['pret', 'erreur'].includes(e.classement) && (!a || (!a.enCours && ((a.total > 0 && a.faits >= a.total) || a.erreur || Date.now() - debut > 5 * 60000)))) break;
        await new Promise((ok) => setTimeout(ok, 5000));
      }
      if (precharge.instance) { try { r.arreter(); } catch { /* déjà */ } }
    } catch (e) { precharge.erreurs.push({ code, erreur: e.message }); journal(`[Relief] ${code} : ${e.message}`); }
    precharge.instance = null;
    precharge.etape = null;
    if (!precharge.arret) precharge.faits++;
  }
  }
  precharge.aCompleter = codes.filter((c) => !reliefSurDisque(c));
  // « Télécharger et installer » : la carte publique passe d'elle-même en « tous les départements » une fois prête
  if (!precharge.arret && reliefPublic.activerFrance) {
    reliefPublic.couverture = 'france'; reliefPublic.activerFrance = false;
    try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch { /* lecture seule */ }
    journal('[Relief] toute la France prête : la carte publique calcule maintenant dans tous les départements');
  }
  journal(`[Relief] préparation de la France ${precharge.arret ? 'arrêtée' : 'terminée'} : ${precharge.faits}/${precharge.total} (${precharge.erreurs.length} erreur(s))`);
  Object.assign(precharge, { enCours: false, courant: null, fin: Date.now() });
  if (!redemarrageEnCours) { reliefPublic.preparation = false; try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch { /* lecture seule */ } }
}
let redemarrageEnCours = false;
process.once('SIGTERM', () => { redemarrageEnCours = true; });
// Reprise d'une préparation interrompue par un redémarrage (1 min après le démarrage, le temps que la carte s'installe)
if (reliefPublic.preparation) setTimeout(() => { journal('[Relief] reprise de la préparation de toute la France'); prechargerFrance(); }, 60000).unref();
function R(req, ...pts) {
  const r = Rdep(req);
  // Un point hors du département étudié mais dans celui de la carte : on garde le relief de la carte
  if (r !== relief && pts.length) {
    const dans = (x, e) => x && Number.isFinite(x.lat) && x.lat >= e.sud && x.lat <= e.nord && x.lon >= e.ouest && x.lon <= e.est;
    const eR = r.emprise(), eC = relief.emprise();
    if (pts.some((x) => !dans(x, eR)) && pts.every((x) => dans(x, eC))) return relief;
  }
  // Point hors du relief chargé (ex. clic dans un département voisin) : relief du département de ce point
  // (chargé à la demande pour les membres connectés ; il faut quelques minutes la première fois)
  const p = pts.find((x) => x && Number.isFinite(x.lat) && !dansEmprise(x, r.emprise()));
  if (p && (estMembre(req) || franceOuverte())) {
    const dep = meilleurDepartement(p.lat, p.lon, Number(req.query.rayon) || 40);
    if (dep) return Rdep(req, dep);
  }
  return r;
}
const dansEmprise = (x, e) => x.lat >= e.sud && x.lat <= e.nord && x.lon >= e.ouest && x.lon <= e.est;
// Département contenant un point (contours nationaux, test du point dans le polygone)
let contoursDeps = null;
function departementDuPoint(lat, lon) {
  if (!contoursDeps) {
    try {
      contoursDeps = lireJson(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson')).features.map((f) => ({
        code: f.properties.code, poly: f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
      }));
    } catch { contoursDeps = []; }
  }
  const dansAnneau = (a) => { let d = false; for (let i = 0, j = a.length - 1; i < a.length; j = i++) { const [xi, yi] = a[i], [xj, yj] = a[j]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) d = !d; } return d; };
  const f = contoursDeps.find((c) => c.poly.some((pg) => dansAnneau(pg[0]) && !pg.slice(1).some(dansAnneau)));
  return f ? String(f.code).toUpperCase() : null;
}
// Parmi les départements dont le relief (rectangle + 0,2°) contient le point, celui qui contient la plus grande
// part du disque de calcul : évite une couverture tronquée par le bord du relief chargé
function meilleurDepartement(lat, lon, rayonKm) {
  departementDuPoint(lat, lon);
  const dLat = rayonKm / 111.32, dLon = rayonKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  let meilleur = null, max = -1;
  for (const c of contoursDeps) {
    if (!c.rect) {
      let s = 90, o = 180, n = -90, e = -180;
      for (const pg of c.poly) for (const [x, y] of pg[0]) { s = Math.min(s, y); n = Math.max(n, y); o = Math.min(o, x); e = Math.max(e, x); }
      c.rect = { s: s - 0.2, o: o - 0.2, n: n + 0.2, e: e + 0.2 };
    }
    const r = c.rect;
    if (lat < r.s || lat > r.n || lon < r.o || lon > r.e) continue;
    const part = Math.max(0, Math.min(r.n, lat + dLat) - Math.max(r.s, lat - dLat)) * Math.max(0, Math.min(r.e, lon + dLon) - Math.max(r.o, lon - dLon));
    if (part > max + 1e-9) { max = part; meilleur = String(c.code).toUpperCase(); }
  }
  return meilleur || departementDuPoint(lat, lon);
}
function Rdep(req, depForce) {
  // Relief d'un autre département : chargement lourd (IGN, quelques minutes), réservé aux comptes connectés
  const dep = String(depForce || (estMembre(req) || franceOuverte() ? req.query.dep || (req.body && req.body.dep) : '') || '').toUpperCase();
  if (!dep || dep === String(config.departement.code).toUpperCase() || !/^(\d{2}|2A|2B)$/.test(dep)) return relief;
  if (precharge.instance && precharge.courant === dep) return precharge.instance;
  if (!reliefsEtude.has(dep)) {
    if (!listeDepartements.some((d) => d.code === dep)) return relief;
    if (reliefsEtude.size >= 6) { const [k, v] = reliefsEtude.entries().next().value; v.arreter(); reliefsEtude.delete(k); }
    journal(`[Relief] étude du département ${dep} : chargement du relief IGN et des points hauts`);
    reliefsEtude.set(dep, creerRelief(config, journal, { ...fournisseursRelief, envDefaut: () => { const c = relief.calibration(); return c && c.perteEnvironnementDb != null ? c.perteEnvironnementDb : null; } }, { code: dep }));
  } else { const v = reliefsEtude.get(dep); reliefsEtude.delete(dep); reliefsEtude.set(dep, v); }
  cacheRelief.noterUtilisation(dep);
  return reliefsEtude.get(dep);
}

// Relief d'un département déjà préparé sur le disque : il s'ouvre en une à deux secondes. On attend qu'il soit prêt
// plutôt que de répondre « en cours de chargement » (le navigateur ne réessayait que 20 s plus tard).
// approx : le relief grossier (en attendant le précis) suffit pour ce calcul
async function reliefPret(RR, ms = 12000, approx = false) {
  const fin = Date.now() + ms;
  // Relief prêt et, pour un département préparé, ses points hauts aussi (sinon « 0 point haut évalué »)
  const fini = () => RR.pret() && (!RR.code || !reliefSurDisque(RR.code) || (RR.etat().sommets || 0) > 0);
  while (!fini() && Date.now() < fin) {
    const e = RR.etat ? RR.etat() : {};
    if (e.mnt === 'erreur' || (RR.code && !reliefSurDisque(RR.code))) break; // téléchargement IGN : plusieurs minutes, inutile d'attendre ici
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return RR.pret() || (approx && !!RR.utilisable && RR.utilisable());
}
const messageChargement = (RR) => (RR.code && reliefSurDisque(RR.code)
  ? `Relief du département ${RR.code} : ouverture en cours, quelques secondes`
  : `Relief du département ${RR.code || ''} en cours de chargement (IGN) : réessayez dans quelques minutes`);
app.get('/api/relief/france', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const surDisque = listeDepartements.filter((d) => d.code === String(config.departement.code).toUpperCase() || reliefSurDisque(d.code)).length;
  res.set('Cache-Control', 'no-store').json({ couverture: reliefPublic.couverture, surDisque, total: listeDepartements.length, precharge: { ...precharge, instance: undefined } });
});
app.get('/api/relief/france/paquet', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  journal(`[Relief] paquet France téléchargé par ${utilisateur(req).identifiant}`);
  exporterPaquetFrance(res);
});
app.post('/api/relief/france', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  if (b.couverture !== undefined) {
    if (!['departement', 'france'].includes(b.couverture)) return res.status(400).json({ erreur: 'choix invalide' });
    reliefPublic.couverture = b.couverture;
    try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch (e) { return res.status(500).json({ erreur: e.message }); }
    journal(`[Relief] couverture de la carte publique : ${b.couverture === 'france' ? 'toute la France' : 'département de la carte'} (${utilisateur(req).identifiant})`);
  }
  if (b.precharger === true) {
    if (b.activer) { reliefPublic.activerFrance = true; try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch { /* lecture seule */ } }
    prechargerFrance();
  }
  if (b.precharger === false && precharge.enCours) precharge.arret = true;
  res.json({ ok: true, couverture: reliefPublic.couverture });
});
// ---- Cache du relief (administrateur) : espace occupé, purge, plafond, relief grossier mondial -------------------
function etatCacheRelief() {
  const inv = cacheRelief.inventaire(plafondRelief());
  const g = reliefGrossier.etat();
  return { ...inv, principale: { ...inv.principale, code: String(config.departement.code).toUpperCase(), nom: config.zoneNom || null },
    grossier: { ...inv.grossier, actif: grossierActif(), defaut: GROSSIER_DEFAUT, source: g.source, minutes: g.minutes } };
}
app.get('/api/relief/cache', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(etatCacheRelief());
});
// { grossier: true|false } active ou coupe le relief grossier ; { plafondGo: N } (0 = sans plafond) ;
// { telechargerGrossier: true } relance son téléchargement ; { purger: { codes | tout | joursInactifs, grossier } }
app.post('/api/relief/cache', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {}, qui = utilisateur(req).identifiant;
  let modifie = false;
  if (b.grossier !== undefined) {
    if (typeof b.grossier !== 'boolean') return res.status(400).json({ erreur: 'choix invalide' });
    reliefPublic.grossier = b.grossier; modifie = true;
    journal(`[Relief] relief grossier mondial ${b.grossier ? 'activé' : 'désactivé'} (${qui})`);
    if (b.grossier) lancerReliefGrossier(); else reliefGrossier.arreter();
  }
  if (b.plafondGo !== undefined) {
    const n = Number(b.plafondGo);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return res.status(400).json({ erreur: 'Plafond invalide (0 à 10 000 Go, 0 = sans plafond)' });
    reliefPublic.plafondGo = Math.round(n * 10) / 10; modifie = true;
    journal(`[Relief] plafond du cache du relief : ${reliefPublic.plafondGo ? reliefPublic.plafondGo + ' Go' : 'aucun'} (${qui})`);
  }
  if (modifie) { try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch (e) { return res.status(500).json({ erreur: e.message }); } }
  if (modifie && reliefPublic.plafondGo) appliquerPlafondRelief();
  if (b.telechargerGrossier === true) {
    if (!grossierActif()) return res.status(409).json({ erreur: 'Relief grossier désactivé : activez-le d’abord' });
    lancerReliefGrossier();
  }
  let purge = null;
  if (b.purger && typeof b.purger === 'object') {
    const p = b.purger;
    const o = {
      tout: p.tout === true,
      codes: Array.isArray(p.codes) ? p.codes.slice(0, 500).map(String).filter((c) => /^((\d{2}|2A|2B)|M[NS]\d{2}[EW]\d{3})$/i.test(c)) : null,
      joursInactifs: p.joursInactifs !== undefined && Number.isFinite(Number(p.joursInactifs)) ? Math.min(3650, Math.max(0, Number(p.joursInactifs))) : null,
      grossier: p.grossier === true,
    };
    if (!o.tout && !o.codes && o.joursInactifs == null && !o.grossier) return res.status(400).json({ erreur: 'Rien à purger' });
    // Relief mondial supprimé : l'option est décochée en même temps, sinon l'essai horaire le retéléchargeait (≈ 19 Mo)
    if (o.grossier && grossierActif()) {
      reliefPublic.grossier = false; reliefGrossier.arreter();
      journal(`[Relief] relief grossier mondial désactivé avec sa suppression (${qui})`);
      try { ecrireSur(fReliefPublic, JSON.stringify(reliefPublic)); } catch (e) { return res.status(500).json({ erreur: e.message }); }
    }
    try { purge = await cacheRelief.purger(o, qui); } catch (e) { return res.status(500).json({ erreur: e.message }); }
    cacheTerrain.clear();
  }
  res.json({ ok: true, purge, ...etatCacheRelief() });
});
app.get('/api/relief/etat', (req, res) => res.json({ ...R(req).etat(), emprise: R(req).emprise() }));
app.get('/api/relief/sommets', (req, res) => {
  res.json(R(req).sommets().map((s) => ({ id: s.id, nom: s.nom, lat: s.lat, lon: s.lon, alt: s.alt, source: s.source, dominance: s.dominance, dansZone: s.dansZone, couverturePct: s.couverturePct, couvertureKm2: s.couvertureKm2, rang: s.rang, rangPlan: s.rangPlan, acces: s.acces || null })));
});
app.get('/api/relief/calibration', (req, res) => res.json(R(req).calibration()));
app.get('/api/relief/classement', (req, res) => {
  const filtre = ['voiture', '4x4', 'pied'].includes(req.query.acces) ? req.query.acces : null;
  res.json((filtre ? R(req).classementAcces(filtre) : R(req).classementAcces(null)) || R(req).classement() || { attente: true, etat: R(req).etat() });
});
app.post('/api/relief/recalculer', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  R(req).calculerClassement(optsRelief(req.body || {}));
  res.json({ ok: true });
});
app.get('/api/relief/couvrir', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ erreur: 'Point invalide' });
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  const RR = R(req, { lat, lon }); await reliefPret(RR);
  try { res.json(RR.couvrirPoint({ lat, lon }, o)); } catch (e) { res.status(503).json({ erreur: e.message }); }
});
// Un seul site pour plusieurs points : ?pts=lat,lon;lat,lon;…
app.get('/api/relief/couvrir-points', async (req, res) => {
  const cibles = String(req.query.pts || '').split(';').map((x) => x.split(',').map(Number)).filter((x) => x.length === 2 && x.every(Number.isFinite)).slice(0, 5).map(([lat, lon], i) => ({ lat, lon, nom: `Point ${i + 1}` }));
  if (cibles.length < 2) return res.status(400).json({ erreur: 'Indiquer au moins deux points' });
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  const RR = R(req, ...cibles); await reliefPret(RR);
  try { res.json(RR.couvrirPoints(cibles, o)); } catch (e) { res.status(503).json({ erreur: e.message }); }
});
// Répéteurs MeshCore positionnés et entendus depuis 24 h (relais existants pour « Relier » et « Couvrir »)
const repeteursMc = () => { const lim = Date.now() - 24 * 3600000; return reseauMc.q.noeuds.all().filter((n) => n.lat != null && ['repeteur', 'salon'].includes(n.role) && (n.dernier_vu || 0) >= lim).map((n) => ({ num: n.cle, nom: n.nom || n.cle.slice(0, 8), lat: n.lat, lon: n.lon })); };
app.get('/api/relief/relier', async (req, res) => {
  const q = req.query, n = (v) => Number(v);
  const a = { lat: n(q.aLat), lon: n(q.aLon), nom: q.aNom ? String(q.aNom).slice(0, 60) : 'Départ' }, b = { lat: n(q.bLat), lon: n(q.bLon), nom: q.bNom ? String(q.bNom).slice(0, 60) : 'Arrivée' };
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return res.status(400).json({ erreur: 'Points invalides' });
  const o = optsRelief(q);
  if (q.hA) o.hauteurA = Math.min(Math.max(Number(q.hA) || 2, 0.5), 60);
  if (q.hB) o.hauteurB = Math.min(Math.max(Number(q.hB) || 2, 0.5), 60);
  if (q.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  const RR = R(req, a, b); await reliefPret(RR, 12000, true);
  try { res.json(RR.relierPoints(a, b, o)); } catch (e) { res.status(503).json({ erreur: e.message }); }
});
const cacheCouverture = new Map();
// Calculs asynchrones : N demandes identiques simultanées (plusieurs onglets, double clic) ne lancent plus N calculs
// (mémoire × N dans un conteneur de 512 Mo) ; la promesse en cours est partagée par clé puis retirée.
const calculPartage = require('./calcul-partage').creerCalculPartage().partager;
function garderCouverture(cle, r) {
  r.id = crypto.randomBytes(6).toString('hex');
  if (!r.approximatif) cacheCouverture.set(cle, r); // relief grossier : jamais gardé comme un résultat précis
  cacheCouverture.set(r.id, r);
  if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
  return r;
}
const calculsPublics = new Map();
function limiterCalcul(ip) {
  const t = Date.now(), l = (calculsPublics.get(ip) || []).filter((x) => t - x < 15 * 60000);
  l.push(t); calculsPublics.set(ip, l);
  if (calculsPublics.size > 2000) calculsPublics.clear();
  return l.length > 20;
}
app.get('/api/relief/couverture', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ erreur: 'Point invalide' });
  const RR = R(req, { lat, lon });
  if (!dansEmprise({ lat, lon }, RR.emprise())) {
    // Hors de France : le relief de cette édition vient de l'IGN ; l'édition monde (relief Copernicus) couvre toute la planète
    const horsFrance = lat < 41.3 || lat > 51.2 || lon < -5.3 || lon > 9.7;
    return res.status(400).json({ erreur: horsFrance ? 'Cette carte calcule la couverture en France seulement (relief IGN). Pour le reste du monde, installez l’édition monde (relief Copernicus partout) : https://github.com/sauveteur71/live-mesh-map-world'
      : estMembre(req) ? 'Point hors de France métropolitaine : pas de relief disponible' : 'Point hors de la zone couverte par le modèle de relief (département et ses abords)' });
  }
  if (!(await reliefPret(RR, 12000, true))) return res.status(503).json({ erreur: messageChargement(RR) });
  const o = optsRelief(req.query);
  const cle = JSON.stringify([RR.code, lat.toFixed(4), lon.toFixed(4), o, (RR.calibration() || {}).date]);
  let r = RR.pret() ? cacheCouverture.get(cle) : null;
  if (!r) {
    // Visiteurs non connectés (carte publique) : 20 nouveaux calculs par quart d'heure au plus
    if (!estMembre(req) && limiterCalcul(req.ip)) return res.status(429).json({ erreur: 'Trop de calculs de couverture : réessayez dans quelques minutes' });
    try { r = await calculPartage(cle, async () => garderCouverture(cle, await RR.couverturePng({ lat, lon }, o))); } catch (e) { return res.status(503).json({ erreur: e.message }); }
  }
  res.json({ image: `/api/relief/couverture/${r.id}.png`, emprise: RR.emprise(), departement: RR.etat().departement, surfaceKm2: r.surfaceKm2, surfaceZoneKm2: r.surfaceZoneKm2, pctZone: r.pctZone, sol: r.sol, env: r.env, rayonKm: r.rayonKm, approximatif: !!r.approximatif, reliefApprox: r.reliefApprox || null });
});
// Couverture cumulée : ?pts=lat,lon[,hauteur];lat,lon[,hauteur];… (2 à 10 sites)
app.get('/api/relief/couverture-multi', async (req, res) => {
  const sites = String(req.query.pts || '').split(';').map((x) => x.split(',').map(Number)).filter((x) => x.length >= 2 && x.slice(0, 2).every(Number.isFinite)).slice(0, 10)
    .map(([lat, lon, h]) => ({ lat, lon, h: Number.isFinite(h) ? Math.min(Math.max(h, 0.5), 100) : undefined }));
  if (!sites.length) return res.status(400).json({ erreur: 'Aucun site' });
  const RR = R(req, ...sites);
  if (!(await reliefPret(RR, 12000, true))) return res.status(503).json({ erreur: messageChargement(RR) });
  const o = optsRelief(req.query);
  const cle = JSON.stringify(['multi', RR.code, sites, o, (RR.calibration() || {}).date]);
  let r = RR.pret() ? cacheCouverture.get(cle) : null;
  if (!r) {
    try { r = await calculPartage(cle, async () => garderCouverture(cle, await RR.couverturePngMulti(sites, o))); } catch (e) { return res.status(503).json({ erreur: e.message }); }
  }
  res.json({ image: `/api/relief/couverture/${r.id}.png`, emprise: RR.emprise(), departement: RR.etat().departement, surfaceKm2: r.surfaceKm2, surfaceZoneKm2: r.surfaceZoneKm2, pctZone: r.pctZone, sites: r.sites, env: r.env, rayonKm: r.rayonKm, approximatif: !!r.approximatif, reliefApprox: r.reliefApprox || null });
});
// Couverture actuelle du réseau (relais et passerelles détectés) : ?reseau=meshcore pour les répéteurs MeshCore
async function couvertureReseauCachee(RR, o, reseauCle) {
  const versionFiches = Object.values(installations.toutes()).reduce((m, f) => Math.max(m, f.maj || 0), 0);
  const cle = JSON.stringify(['reseau', RR.code, reseauCle, o.hn || 6, Math.floor(Date.now() / 600000), (RR.calibration() || {}).date, versionFiches]);
  let r = RR.pret() ? cacheCouverture.get(cle) : null;
  if (!r) {
    r = await calculPartage(cle, async () => { const x = await RR.couvertureReseau(o); return x.vide ? x : garderCouverture(cle, x); });
  }
  return r;
}
app.get('/api/relief/couverture-reseau', async (req, res) => {
  const RR = R(req);
  if (!(await reliefPret(RR, 12000, true))) return res.status(503).json({ erreur: messageChargement(RR) });
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  if (req.query.hn) o.hn = Math.min(Math.max(Number(req.query.hn) || 6, 0.5), 60);
  // La calibration (pertes d'environnement) fait partie de la clé : un calcul fait avant elle serait trop optimiste
  let r;
  try { r = await couvertureReseauCachee(RR, o, req.query.reseau || 'mt'); } catch (e) { return res.status(503).json({ erreur: e.message }); }
  if (r.vide) return res.json({ noeuds: [], vide: true });
  const { image, ...reste } = r;
  res.json({ ...reste, image: `/api/relief/couverture/${r.id}.png`, emprise: RR.emprise() });
});
// Principales villes d'un département (API Géo de l'État), gardées sur le disque
async function villesDepartement(code) {
  const f = path.join(path.dirname(config.fichierBase), `villes-${code}.json`);
  try { return lireJson(f); } catch { /* à télécharger */ }
  const r = await fetch(`https://geo.api.gouv.fr/departements/${encodeURIComponent(code)}/communes?fields=nom,centre,population&format=json`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('API Géo : HTTP ' + r.status);
  const l = (await r.json()).filter((c) => c.centre && c.population).sort((a, b) => b.population - a.population).slice(0, 20)
    .map((c) => ({ nom: c.nom, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0], population: c.population }));
  ecrireSur(f, JSON.stringify(l));
  return l;
}
// Déplacer des relais existants : calcul en arrière-plan (1 à 3 min), résultat gardé jusqu'au prochain classement
const optimisations = new Map(); // clé -> { etat, progression, resultat, erreur }
app.get('/api/relief/optimisation', async (req, res) => {
  const RR = R(req);
  if (!(await reliefPret(RR))) return res.status(503).json({ erreur: messageChargement(RR) });
  const rayon = Math.min(Math.max(Number(req.query.rayon) || 6, 2), 15);
  const acces = ['voiture', '4x4', 'pied'].includes(req.query.acces) ? req.query.acces : null;
  const cle = JSON.stringify([RR.code, rayon, acces, (RR.classement() || {}).date, Math.floor(Date.now() / 3600000)]);
  let o = optimisations.get(cle);
  if (!o || req.query.recalculer === '1') {
    o = { etat: 'calcul', progression: 0 };
    optimisations.set(cle, o);
    if (optimisations.size > 10) optimisations.delete(optimisations.keys().next().value);
    RR.optimiserRelais({ rayonKm: rayon, acces, progression: (f, t) => { o.progression = Math.round((f / t) * 100); } })
      .then((r) => { o.etat = 'pret'; o.resultat = r; })
      .catch((e) => { o.etat = 'erreur'; o.erreur = e.message; journal('[Relief] optimisation :', e.message); });
  }
  res.set('Cache-Control', 'no-store').json({ etat: o.etat, progression: o.progression, erreur: o.erreur, ...(o.resultat || {}) });
});
// Sites routiers (webcams du Département et de la DIR Massif Central) et leur intérêt comme sites de relais
const sitesRoutiers = creerSitesRoutiers(config, journal);
app.get('/api/sites-routiers', async (req, res) => { res.set('Cache-Control', 'public, max-age=3600').json(await sitesRoutiers.charger()); });
const evaluationsRoutiers = new Map();
app.get('/api/relief/sites-routiers', async (req, res) => {
  const RR = R(req);
  if (!(await reliefPret(RR))) return res.status(503).json({ erreur: messageChargement(RR) });
  const h = Math.min(Math.max(Number(req.query.h) || 6, 2), 30);
  const cle = JSON.stringify([RR.code, h, (RR.classement() || {}).date, Math.floor(Date.now() / 3600000)]);
  let o = evaluationsRoutiers.get(cle);
  if (!o) {
    o = { etat: 'calcul', progression: 0 };
    evaluationsRoutiers.set(cle, o);
    if (evaluationsRoutiers.size > 6) evaluationsRoutiers.delete(evaluationsRoutiers.keys().next().value);
    const d = await sitesRoutiers.charger();
    RR.evaluerEmplacements(d.sites, { h, progression: (f, t) => { o.progression = Math.round((f / t) * 100); } })
      .then((r) => { o.etat = 'pret'; o.resultat = { ...r, source: d.source, chargement: d.date }; })
      .catch((e) => { o.etat = 'erreur'; o.erreur = e.message; });
  }
  res.set('Cache-Control', 'no-store').json({ etat: o.etat, progression: o.progression, erreur: o.erreur, ...(o.resultat || {}) });
});
// Toutes les communes d'un département (centre, population), pour les habitants couverts
async function communesDepartement(code) {
  const f = path.join(path.dirname(config.fichierBase), `communes-${code}.json`);
  try { return lireJson(f); } catch { /* à télécharger */ }
  const r = await fetch(`https://geo.api.gouv.fr/departements/${encodeURIComponent(code)}/communes?fields=nom,centre,population&format=json`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('API Géo : HTTP ' + r.status);
  const l = (await r.json()).filter((c) => c.centre && c.population).map((c) => ({ nom: c.nom, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0], population: c.population }));
  ecrireSur(f, JSON.stringify(l));
  return l;
}
// Plan à budget : n relais, coûts unitaires (€) facultatifs
app.get('/api/relief/budget', async (req, res) => {
  const RR = R(req);
  let communes = [];
  try { communes = await communesDepartement(RR.code); } catch (e) { journal('[Budget] communes :', e.message); }
  const filtre = ['voiture', '4x4', 'pied'].includes(req.query.acces) ? req.query.acces : null;
  const couts = {};
  for (const k of ['secteur', 'solaire', 'mat']) if (req.query[k] !== undefined && Number.isFinite(Number(req.query[k]))) couts[k] = Math.min(Math.max(Number(req.query[k]), 0), 10000);
  const r = RR.planBudget({ n: Number(req.query.n) || 3, acces: filtre, avecReseau: req.query.reseau !== '0', realiste: req.query.realiste !== '0', communes, couts });
  if (!r) return res.status(503).json({ erreur: 'Le classement des sites est en cours de calcul, réessayez dans une minute' });
  res.json(r);
});
// Simulation « et si… » : { retirer: [num…], ajouter: [{ lat, lon, h, nom }…] }
app.post('/api/relief/simulation', async (req, res) => {
  const RR = R(req);
  if (!(await reliefPret(RR, 12000, true))) return res.status(503).json({ erreur: messageChargement(RR) });
  const b = req.body || {};
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  if (b.hn) o.hn = Math.min(Math.max(Number(b.hn) || 6, 0.5), 60);
  let villes = [];
  try { villes = await villesDepartement(RR.code); } catch (e) { journal('[Simulation] villes :', e.message); }
  try {
    const r = await RR.simuler({ retirer: Array.isArray(b.retirer) ? b.retirer.slice(0, 50) : [], ajouter: Array.isArray(b.ajouter) ? b.ajouter.slice(0, 10).map((a) => ({ lat: Number(a.lat), lon: Number(a.lon), h: a.h != null ? Math.min(Math.max(Number(a.h) || 6, 0.5), 60) : undefined, nom: a.nom ? String(a.nom).slice(0, 60) : undefined })) : [], villes }, o);
    const id = crypto.randomBytes(6).toString('hex');
    cacheCouverture.set(id, { image: r.image });
    if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
    res.json({ ...r, image: `/api/relief/couverture/${id}.png`, emprise: RR.emprise() });
  } catch (e) { res.status(503).json({ erreur: e.message }); }
});
// Plan pour couvrir le département : ?objectif=95&max=15&acces=voiture&reseau=1
app.get('/api/relief/plan', (req, res) => {
  const filtre = ['voiture', '4x4', 'pied'].includes(req.query.acces) ? req.query.acces : null;
  const RR = R(req);
  const o = { objectifPct: Number(req.query.objectif) || 95, max: Number(req.query.max) || 15, acces: filtre, avecReseau: req.query.reseau !== '0', realiste: req.query.realiste === '1' };
  // Même demande dans les 10 minutes (carte publique très consultée) : résultat déjà calculé
  const cle = JSON.stringify(['plan', RR.code, o, Math.floor(Date.now() / 600000), (RR.classement() || {}).date]);
  let rep = cacheCouverture.get(cle);
  if (!rep) {
    const r = RR.planDepartement(o);
    if (!r) return res.status(503).json({ erreur: 'Le classement des sites est en cours de calcul, réessayez dans une minute' });
    const id = crypto.randomBytes(6).toString('hex');
    cacheCouverture.set(id, { image: r.image });
    rep = { ...r, image: `/api/relief/couverture/${id}.png`, emprise: RR.emprise() };
    cacheCouverture.set(cle, rep);
    if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
  }
  res.json(rep);
});
// Plan pour couvrir une zone dessinée à la main : { polygone: [[lat, lon], …], objectif, max, acces, reseau, realiste }
let planZoneEnCours = 0;
app.post('/api/relief/plan-zone', async (req, res) => {
  const b = req.body || {};
  if (planZoneEnCours >= 2) return res.status(429).json({ erreur: 'Deux études de zone sont déjà en cours : réessayez dans un instant' });
  const filtre = ['voiture', '4x4', 'pied'].includes(b.acces) ? b.acces : null;
  const RR = R(req);
  planZoneEnCours++;
  try {
    const r = await RR.planZone({ polygone: b.polygone, polygones: b.polygones, objectifPct: Number(b.objectif) || 95, max: Number(b.max) || 10, acces: filtre, avecReseau: b.reseau !== false, realiste: !!b.realiste, hs: b.hs });
    const id = crypto.randomBytes(6).toString('hex');
    cacheCouverture.set(id, { image: r.image });
    if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
    res.json({ ...r, image: `/api/relief/couverture/${id}.png` });
  } catch (e) { res.status(400).json({ erreur: e.message }); } finally { planZoneEnCours--; }
});
app.get('/api/relief/couverture/:id.png', (req, res) => {
  const r = cacheCouverture.get(req.params.id);
  if (!r) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(r.image);
});

// ---- Recherche de lieux (OpenStreetMap via Photon + adresses IGN), avec cache ---------------
const cacheRecherche = new Map();
const sansAccents = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-']/g, ' ');
let reperes = [];
try { reperes = lireJson(path.join(__dirname, '..', 'donnees-ref', `reperes-${config.departement.code}.json`)); } catch { /* facultatif */ }
app.get('/api/reperes', (req, res) => res.json(reperes.map(({ alias, ...r }) => r)));
const distKm = (a, b) => { const r = Math.PI / 180; const s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(s)); };
app.get('/api/recherche', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json([]);
  const lat = Number(req.query.lat) || config.carte.centreLat, lon = Number(req.query.lon) || config.carte.centreLon;
  const cle = q.toLowerCase() + '|' + lat.toFixed(1) + '|' + lon.toFixed(1);
  const c = cacheRecherche.get(cle);
  if (c && Date.now() - c.t < 3600000) return res.json(c.r);
  // Points de repère locaux (avec noms usuels : « la Vierge », « le Mézenc »…)
  const mots = sansAccents(q).split(/\s+/).filter((m) => m.length > 2 && !['les', 'des', 'puy', 'sur', 'statue'].includes(m));
  const locaux = reperes.filter((r) => [r.nom, ...(r.alias || [])].some((n) => { const t = sansAccents(n); return t.includes(sansAccents(q)) || (mots.length && mots.every((m) => t.includes(m))); }))
    .map((r) => ({ type: 'Repère', nom: r.nom, detail: r.detail, lat: r.lat, lon: r.lon, alt: r.alt, zoom: 16 }));
  const ua = { 'User-Agent': 'carte-live-meshtastic/1.0 (+https://github.com/sauveteur71/carte-live-meshtastic)' };
  const [osm, ign] = await Promise.all([
    fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&limit=8&lang=fr`, { headers: ua, signal: AbortSignal.timeout(6000) }).then((r) => r.json()).catch(() => null),
    fetch(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&limit=5&index=address`, { headers: ua, signal: AbortSignal.timeout(6000) }).then((r) => r.json()).catch(() => null),
  ]);
  const TYPES = { place: 'Lieu-dit', highway: 'Rue', building: 'Bâtiment', amenity: 'Service', tourism: 'Tourisme', historic: 'Monument', natural: 'Nature', leisure: 'Loisir', shop: 'Commerce', man_made: 'Ouvrage', boundary: 'Commune', railway: 'Gare', waterway: 'Cours d’eau', landuse: 'Zone' };
  const sortie = [];
  for (const f of (osm && osm.features) || []) {
    const p = f.properties || {};
    const [x, y] = f.geometry.coordinates;
    const nom = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city;
    if (!nom) continue;
    sortie.push({ type: TYPES[p.osm_key] || 'Lieu', nom, detail: [p.city && p.city !== nom ? p.city : null, p.county].filter(Boolean).join(' · '), lat: y, lon: x, zoom: p.osm_key === 'boundary' || p.osm_value === 'city' ? 13 : 17 });
  }
  for (const f of (ign && ign.features) || []) {
    const p = f.properties || {};
    const [x, y] = f.geometry.coordinates;
    if (sortie.some((o) => Math.abs(o.lat - y) < 0.0005 && Math.abs(o.lon - x) < 0.0005)) continue;
    sortie.push({ type: p.type === 'municipality' ? 'Commune' : 'Adresse', nom: p.label || p.name, detail: p.context || '', lat: y, lon: x, zoom: p.type === 'municipality' ? 13 : 17 });
  }
  // Les résultats proches (≤ 100 km) passent devant
  const centre = { lat, lon };
  const proches = sortie.filter((o) => distKm(centre, o) <= 100), loin = sortie.filter((o) => distKm(centre, o) > 100);
  const r = [...locaux, ...proches, ...loin].filter((o, i, t) => t.findIndex((x) => Math.abs(x.lat - o.lat) < 0.0003 && Math.abs(x.lon - o.lon) < 0.0003) === i).slice(0, 10);
  cacheRecherche.set(cle, { t: Date.now(), r });
  if (cacheRecherche.size > 500) cacheRecherche.delete(cacheRecherche.keys().next().value);
  res.json(r);
});

app.get('/api/rejeu', (req, res) => {
  const fin = Number(req.query.fin) || Date.now();
  const debut = Math.max(Number(req.query.debut) || fin - 24 * 3600000, fin - 48 * 3600000);
  res.json(analyse.rejeu(debut, fin));
});

// ---- Modules Meshtastic Wi-Fi (admin) -----------------------------------------------------
const hoteValide = (h) => typeof h === 'string' && /^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9-]{1,63})*$/i.test(h) && h.length <= 253;
const portValide = (p) => { const n = Number(p ?? 4403); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };
const exigerAdmin = (req, res) => { if (estAdmin(req)) return true; res.status(401).json({ erreur: 'Connexion admin requise' }); return false; };
app.get('/api/radio/modules', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  res.json({ ...sourceRadio.modules(), etat: sourceRadio.etat(), agents: { port: agents.port, liste: agents.liste() }, ecoutes: ecoutes.liste().meshtastic });
});
// Code secret des agents (admin) et renouvellement
app.get('/api/radio/agents', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store').json({ code: agents.code(), port: agents.port, liste: agents.liste() });
});
app.post('/api/radio/agents/code', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  res.json({ code: agents.renouvelerCode() });
});
// Agent prêt à l'emploi (admin) : le programme de l'agent, avec l'adresse de cette carte et le code secret ajoutés à la
// fin du fichier. L'agent 1.7 les y lit : aucune question au premier lancement, il relie tout seul les modules branchés.
const AGENTS_PRETS = ['agent-gaulix-windows.exe', 'agent-gaulix-linux-amd64', 'agent-gaulix-raspberrypi-arm64', 'agent-gaulix-raspberrypi-armv7', 'agent-gaulix-macos-arm64'];
app.get('/api/agent/pret/:fichier', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const f = String(req.params.fichier || '');
  if (!AGENTS_PRETS.includes(f)) return res.status(404).json({ erreur: 'Agent inconnu' });
  let binaire;
  try { binaire = fs.readFileSync(path.join(__dirname, '..', 'public', 'agent', f)); } catch {
    return res.status(404).json({ erreur: 'Agent absent de cette installation (il est compilé dans l’image Docker) : prenez-le sur la page des versions GitHub' });
  }
  // Adresse par laquelle ce navigateur joint la carte (réseau local ou Tailscale), puis celles données dans AGENTS_ADRESSES
  const hotes = [String(req.hostname || ''), ...String(process.env.AGENTS_ADRESSES || '').split(',')].map((h) => h.trim()).filter((h) => /^[a-z0-9.-]+(:\d+)?$/i.test(h));
  const serveurs = [...new Set(hotes.map((h) => (/:\d+$/.test(h) ? h : `${h}:${agents.port}`)))];
  const reglages = { serveurs, code: agents.code(), carte: String(config.titre || '').slice(0, 60), role: req.query.role === 'ecoute' ? 'ecoute' : 'principal' };
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f}"`, 'Cache-Control': 'no-store' });
  res.send(Buffer.concat([binaire, Buffer.from('\nCARTE-LIVE-AGENT' + JSON.stringify(reglages) + '\n')]));
});
app.post('/api/radio/connecter', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const { hote } = req.body || {};
  const port = portValide((req.body || {}).port);
  if (!hote) { try { sourceRadio.reconnecter(); return res.json({ ok: true }); } catch (e) { return res.status(400).json({ erreur: e.message }); } }
  if (serie.cheminValide(hote)) { if (ecoutes.estRadio(hote, 0)) ecoutes.retirerRadio(hote, 0); sourceRadio.connecterA(hote, 0); return res.json({ ok: true }); }
  if (!hoteValide(hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
  if (ecoutes.estRadio(hote, port)) ecoutes.retirerRadio(hote, port); // un module n'accepte qu'un client à la fois
  sourceRadio.connecterA(hote, port);
  res.json({ ok: true });
});
app.post('/api/radio/deconnecter', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const minutes = Math.min(Math.max(Number((req.body || {}).minutes) || 0, 0), 24 * 60);
  sourceRadio.deconnecter(minutes);
  res.json({ ok: true });
});
app.post('/api/radio/modules', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const { hote, nom } = req.body || {};
  const port = portValide((req.body || {}).port);
  if (!hoteValide(hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
  res.json(sourceRadio.ajouterModule(hote, port, nom ? String(nom).slice(0, 40) : null));
});
app.delete('/api/radio/modules', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const { hote } = req.body || {};
  if (serie.cheminValide(hote)) { sourceRadio.retirerModule(hote, 0); return res.json({ ok: true }); }
  const port = portValide((req.body || {}).port);
  if (!hoteValide(hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
  sourceRadio.retirerModule(hote, port);
  res.json({ ok: true });
});
// ---- Modules en écoute (en plus des modules principaux) ---------------------------------------------
app.get('/api/ecoutes', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store').json(ecoutes.liste());
});
// Met en écoute un module déjà connu (liste des modules Meshtastic, agent, companion Wi-Fi)
app.post('/api/ecoutes', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const b = req.body || {};
  try {
    if (b.protocole === 'meshcore') {
      if (!config.meshcore.actif) throw new Error('MeshCore n’est pas activé dans cette carte');
      let c;
      if (b.type === 'agent') { if (!agents.estAgent(String(b.hote || ''))) throw new Error('Agent inconnu'); c = { type: 'agent', hote: String(b.hote) }; }
      else { const port = portValide(b.port ?? 5000); if (!hoteValide(b.hote) || !port) throw new Error('Adresse ou port invalide'); c = { type: 'tcp', hote: b.hote, port }; }
      const p = companion.etat().cible;
      if (p && ecoutes.cleCompanion(p) === ecoutes.cleCompanion(c)) throw new Error('ce companion est le companion principal');
      ecoutes.ajouterCompanion(c, b.nom ? String(b.nom).slice(0, 40) : null);
    } else {
      const port = b.hote && agents.estAgent(String(b.hote)) ? 1 : portValide(b.port);
      if (!hoteValide(b.hote) || !port) throw new Error('Adresse ou port invalide');
      const a = sourceRadio.modules().actif;
      if (a && a.hote === b.hote && a.port === port) throw new Error('ce module est le module principal');
      const m = sourceRadio.modules().modules.find((x) => x.hote === b.hote && x.port === port);
      ecoutes.ajouterRadio(b.hote, port, (m && m.nom) || (b.nom ? String(b.nom).slice(0, 40) : null));
    }
    res.json(ecoutes.liste());
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/ecoutes', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const b = req.body || {};
  // Passerelle d'un membre coupée par un administrateur : elle ne peut pas se relier de nouveau pendant 12 h
  const p = passerellesNav.get(b.protocole === 'meshcore' ? String(b.cle || '') : String(b.hote || ''));
  if (p && !p.admin) { passerellesBloquees.set(p.compteId, Date.now() + 12 * 3600000); audit.noter(nomCompte(utilisateur(req)), req.ip, 'passerelle coupée', `passerelle de ${p.compte}, refusée pendant 12 h`); }
  if (b.protocole === 'meshcore') ecoutes.retirerCompanion(String(b.cle || ''));
  else ecoutes.retirerRadio(String(b.hote || ''), Number(b.port) || 0);
  res.json(ecoutes.liste());
});
// Un module en écoute devient le module principal (l'ancien principal passe en écoute s'il le demande)
app.post('/api/ecoutes/principal', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const b = req.body || {};
  try {
    if (b.protocole === 'meshcore') {
      const e = ecoutes.liste().meshcore.find((x) => x.cle === b.cle);
      if (!e || !e.cible) throw new Error('companion en écoute introuvable (un companion relié par une page ne peut pas devenir principal)');
      const ancien = companion.etat().navigateur ? null : companion.etat().cible;
      ecoutes.retirerCompanion(e.cle);
      setTimeout(() => {
        companion.connecterA(e.cible);
        if (b.echanger && ancien) setTimeout(() => ecoutes.ajouterCompanion(ancien, null), 1500);
      }, 800);
    } else {
      const e = ecoutes.liste().meshtastic.find((x) => x.hote === b.hote && x.port === Number(b.port));
      if (!e || e.navigateur) throw new Error('module en écoute introuvable (un module relié par une page ne peut pas devenir principal)');
      const ancien = sourceRadio.modules().actif;
      ecoutes.retirerRadio(e.hote, e.port);
      setTimeout(() => {
        sourceRadio.ajouterModule(e.hote, e.port, e.nom);
        sourceRadio.connecterA(e.hote, e.port);
        if (b.echanger && ancien && !(ancien.hote === e.hote && ancien.port === e.port) && !/^agent-(bluetooth|usb)/.test(ancien.hote)) setTimeout(() => ecoutes.ajouterRadio(ancien.hote, ancien.port, null), 1500);
      }, 800);
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// ---- Module branché en USB sur la machine de la carte (port série du serveur) ----------------------------
const serie = require('./serie');
app.get('/api/connexion/ports', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const utilises = new Set([sourceRadio.modules().actif && sourceRadio.modules().actif.hote, (companion.etat().cible || {}).chemin, ...ecoutes.liste().meshtastic.map((x) => x.hote), ...ecoutes.liste().meshcore.map((x) => x.cible && x.cible.chemin)].filter(Boolean));
  res.set('Cache-Control', 'no-store').json({ ports: serie.listerPorts().map((p) => ({ chemin: p, utilise: utilises.has(p) })) });
});
app.post('/api/connexion/serie', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const chemin = String((req.body || {}).chemin || '').trim();
  const enEcoute = (req.body || {}).role === 'ecoute';
  if (!serie.cheminValide(chemin)) return res.status(400).json({ erreur: 'Port série invalide (ex. /dev/ttyACM0)' });
  // Le port est peut-être déjà utilisé par la carte : on le libère avant de le sonder
  if (sourceRadio.modules().actif && sourceRadio.modules().actif.hote === chemin) sourceRadio.deconnecter(0);
  if ((companion.etat().cible || {}).chemin === chemin) companion.deconnecter();
  if (ecoutes.estRadio(chemin, 0)) ecoutes.retirerRadio(chemin, 0);
  if (ecoutes.estCompanion({ type: 'serie', chemin })) ecoutes.retirerCompanion(chemin);
  await new Promise((ok) => setTimeout(ok, 800));
  let protocole;
  try { protocole = await serie.sonder(chemin); } catch (e) { return res.status(400).json({ erreur: e.message }); }
  if (!protocole) return res.status(404).json({ erreur: `Aucune réponse sur ${chemin} : ni module Meshtastic, ni companion MeshCore (firmware « companion USB »). Vérifiez le firmware et qu’aucun autre programme n’utilise le port.` });
  try {
    if (protocole === 'meshcore') {
      if (!config.meshcore.actif) throw new Error('MeshCore n’est pas activé dans cette carte');
      const c = { type: 'serie', chemin };
      if (enEcoute) ecoutes.ajouterCompanion(c, `MeshCore ${chemin.split('/').pop()}`); else companion.connecterA(c);
    } else if (enEcoute) ecoutes.ajouterRadio(chemin, 0, `USB ${chemin.split('/').pop()}`);
    else { sourceRadio.ajouterModule(chemin, 0, `USB du serveur ${chemin.split('/').pop()}`); sourceRadio.connecterA(chemin, 0); }
    journal(`connexion série : ${chemin} (${protocole})${enEcoute ? ' en écoute' : ''}`);
    res.json({ ok: true, protocole, texte: `${protocole === 'meshcore' ? 'Companion MeshCore' : 'Module Meshtastic'} reconnu sur ${chemin} : connexion en cours${enEcoute ? ', en écoute' : ''}.` });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// ---- Connexion d'un module par sa seule adresse IP (Meshtastic ou MeshCore, reconnu tout seul) ---------------
// 1. le serveur essaie lui-même (ports 4403 et 5000) ; 2. sinon, un agent 1.6 du même réseau sert de relais.
const ipLocaleV4 = (ip) => /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(ip) && ip.split('.').every((x) => Number(x) <= 255);
const portOuvert = (hote, port, ms = 2500) => new Promise((ok) => {
  const s = net.connect({ host: hote, port });
  const fin = (v) => { clearTimeout(t); s.destroy(); ok(v); };
  const t = setTimeout(() => fin(false), ms);
  s.once('connect', () => fin(true)); s.once('error', () => fin(false));
});
app.post('/api/connexion/ip', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const brut = String((req.body || {}).adresse || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const [ip, portDonne] = brut.split(':');
  if (!ipLocaleV4(ip)) return res.status(400).json({ erreur: 'Adresse IP du réseau local attendue (ex. 192.168.1.122)' });
  const voulu = (req.body || {}).protocole; // facultatif : 'meshtastic' ou 'meshcore' si les deux répondent
  const enEcoute = (req.body || {}).role === 'ecoute'; // en plus du module principal, pour l'écoute seulement
  const choisir = (ports) => {
    const mt = ports.includes(4403) || (portDonne && Number(portDonne) === 4403), mcp = ports.includes(5000) || (portDonne && Number(portDonne) === 5000);
    if (mt && mcp) return voulu === 'meshcore' ? 'meshcore' : 'meshtastic';
    return mcp ? 'meshcore' : mt ? 'meshtastic' : null;
  };
  const brancher = (protocole, cible) => {
    if (protocole === 'meshcore') {
      if (!config.meshcore.actif) throw new Error('MeshCore n’est pas activé dans cette carte');
      const c = cible.agent ? { type: 'agent', hote: cible.agent } : { type: 'tcp', hote: ip, port: 5000 };
      if (enEcoute) {
        const p = companion.etat().cible;
        if (p && ecoutes.cleCompanion(p) === ecoutes.cleCompanion(c) && !companion.etat().navigateur) throw new Error('ce companion est déjà le companion principal de la carte');
        ecoutes.ajouterCompanion(c, `MeshCore ${ip}`);
      } else { if (ecoutes.estCompanion(c)) ecoutes.retirerCompanion(ecoutes.cleCompanion(c)); companion.connecterA(c); }
      return;
    }
    const [h, port, nom] = cible.agent ? [cible.agent, 1, `Meshtastic ${ip}`] : [ip, 4403, null];
    if (enEcoute) {
      const a = sourceRadio.modules().actif;
      if (a && a.hote === h && a.port === port) throw new Error('ce module est déjà le module principal de la carte');
      ecoutes.ajouterRadio(h, port, nom || `Meshtastic ${ip}`);
    } else { if (ecoutes.estRadio(h, port)) ecoutes.retirerRadio(h, port); sourceRadio.ajouterModule(h, port, nom); sourceRadio.connecterA(h, port); }
  };
  try {
    // 1. Directement depuis le serveur
    const directs = (await Promise.all([4403, 5000].map((p) => portOuvert(ip, p)))).map((ok, i) => (ok ? [4403, 5000][i] : null)).filter(Boolean);
    let protocole = choisir(directs);
    if (protocole) {
      brancher(protocole, {});
      journal(`connexion par IP : ${ip} (${protocole}) joint directement`);
      return res.json({ ok: true, protocole, via: 'direct', ecoute: enEcoute, texte: `${protocole === 'meshcore' ? 'Companion MeshCore' : 'Module Meshtastic'} ${ip} trouvé : connexion en cours${enEcoute ? ', en écoute (en plus du module principal)' : ''}.` });
    }
    // 2. Par le relais du réseau local d'un agent
    const relais = agents.relaisPour(ip);
    for (const r of relais) {
      let ports;
      try { ports = await agents.sonder(r.hote, ip); } catch (e) { continue; }
      protocole = choisir(ports);
      if (!protocole) return res.status(404).json({ erreur: `L’agent « ${r.nom} » voit bien le réseau de ${ip}, mais aucun module n’y répond (ni Meshtastic port 4403, ni MeshCore port 5000). Le module est-il allumé, en Wi-Fi, et l’adresse est-elle la bonne ?` });
      const hote = agents.ajouterParIp(r.hote, ip, protocole === 'meshcore' ? 5000 : 4403, protocole);
      brancher(protocole, { agent: hote });
      journal(`connexion par IP : ${ip} (${protocole}) par le relais « ${r.nom} »`);
      return res.json({ ok: true, protocole, via: r.nom, ecoute: enEcoute, texte: `${protocole === 'meshcore' ? 'Companion MeshCore' : 'Module Meshtastic'} ${ip} trouvé par le PC « ${r.nom.replace(/ · réseau local$/, '')} » : connexion en cours${enEcoute ? ', en écoute (en plus du module principal)' : ''}.` });
    }
    const anciens = agents.liste().filter((a) => !/^1\.([6-9]|\d\d)|^[2-9]\./.test(a.version || '') && a.version !== 'navigateur');
    res.status(404).json({
      erreur: `Le serveur ne voit pas ${ip} : ce module est sur un autre réseau que la carte.`,
      conseil: relais.length ? 'Le relais de ce réseau est occupé : réessayez dans un instant.'
        : `Utilisez le Bluetooth ou l’USB depuis ce PC, ou lancez l’agent Gaulix 1.6 sur un PC de ce réseau (il sert alors de relais automatiquement).${anciens.length ? ` Agent(s) à mettre à jour : ${anciens.map((a) => `« ${a.nom} » (${a.version || '?'})`).join(', ')}.` : ''}`,
    });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

let scanEnCours = false;
// Modules Meshtastic en Wi-Fi annoncés par mDNS (_meshtastic._tcp) : ajoutés à la liste des modules (sans connexion),
// au démarrage puis toutes les 15 minutes, et à chaque « Rechercher »
const { chercherMeshtastic } = require('./mdns');
let derniersMdns = [];
async function chercherModulesMdns() {
  try {
    derniersMdns = await chercherMeshtastic();
    const connus = sourceRadio.modules().modules || [];
    for (const m of derniersMdns) {
      const ex = connus.find((x) => x.hote === m.hote && x.port === m.port);
      if (!ex) journal(`[mDNS] module Meshtastic trouvé : ${m.nom} (${m.hote}:${m.port})`);
      if (!ex || !ex.nom) sourceRadio.ajouterModule(m.hote, m.port, m.nom); // le nom choisi par l'administrateur reste
    }
  } catch (e) { journal('[mDNS]', e.message); }
  return derniersMdns;
}
if (String(process.env.MDNS_MESHTASTIC || 'oui').toLowerCase() !== 'non') {
  setTimeout(chercherModulesMdns, 20000).unref();
  setInterval(chercherModulesMdns, 15 * 60000).unref();
}
app.post('/api/radio/scanner', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const prefixe = String((req.body || {}).prefixe || '');
  // Uniquement les réseaux privés (192.168.x, 10.x, 172.16-31.x), par blocs de 254 adresses
  if (!/^(192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3})$/.test(prefixe)) return res.status(400).json({ erreur: 'Réseau privé attendu, ex. 192.168.0' });
  if (scanEnCours) return res.status(409).json({ erreur: 'Recherche déjà en cours' });
  scanEnCours = true;
  try {
    // Sondage du port 4403 et, en même temps, annonces mDNS des modules (nom du module, même sur un autre réseau Wi-Fi local)
    const [trouves, mdns] = await Promise.all([sourceRadio.scanner(prefixe), chercherModulesMdns()]);
    res.json({ trouves: [...new Set([...trouves, ...mdns.map((m) => m.hote)])], mdns, ...sourceRadio.modules() });
  } finally { scanEnCours = false; }
});

// ---- Administration des nœuds par LoRa (admin) ---------------------------------------------
const tacheDuSecteur = (req, t) => !!t && peutGererTous(req, (t.noeuds || []).map((n) => n.num));
app.get('/api/admin-noeuds', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.json({ ...administration.infos(), secteur: estAdmin(req) ? null : utilisateur(req).noeuds, taches: administration.taches().filter((t) => tacheDuSecteur(req, t)), roles: administration.ROLES, signatures: administration.SIGNATURES, presets: administration.PRESETS, rediffusions: administration.REDIFFUSIONS, regions: administration.REGIONS, elements: administration.ELEMENTS, administrables: administration.administrables(), lectures: administration.lecturesConnues() });
});
app.post('/api/admin-noeuds/taches', (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  if (!peutGererTous(req, [...(b.cibles || []), ...(b.params && b.params.reference ? [b.params.reference] : [])])) return refuserSecteur(res);
  if (String(b.type) === 'equipe') return res.status(400).json({ erreur: 'Les canaux d’équipe se gèrent dans Programmer › Équipes' });
  try { res.json(administration.lancer(String(b.type), b.cibles, b.params || {}, u.identifiant, { insister: !!b.insister })); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/admin-noeuds/lecture/:num/detail', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!peutGerer(req, req.params.num)) return refuserSecteur(res);
  res.set('Cache-Control', 'no-store').json(administration.detailLecture(Number(req.params.num)) || { aucune: true });
});
app.get('/api/admin-noeuds/lecture/:num', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!peutGerer(req, req.params.num)) return refuserSecteur(res);
  res.json(administration.etatLecture(Number(req.params.num)) || { aucune: true });
});
app.post('/api/admin-noeuds/taches/:id/relancer', (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!tacheDuSecteur(req, administration.tache(req.params.id))) return refuserSecteur(res);
  try { res.json(administration.relancer(req.params.id, u.identifiant, { insister: !!(req.body && req.body.insister) })); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/admin-noeuds/taches/:id/arreter', (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!tacheDuSecteur(req, administration.tache(req.params.id))) return refuserSecteur(res);
  try { administration.arreter(req.params.id, u.identifiant); res.json({ ok: true }); } catch (e) { res.status(404).json({ erreur: e.message }); }
});
app.get('/api/admin-noeuds/taches/:id', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const t = administration.tache(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tâche inconnue' });
  if (!tacheDuSecteur(req, t)) return refuserSecteur(res);
  res.json(t);
});

// Clés d'administration : relais par relais, modules autorisés, refus, « à faire sur place »
app.get('/api/admin-noeuds/cles', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const adm = administration.administrables();
  const z = config.zone; // relais du département (les autres ne sont listés que si on a déjà essayé de les programmer)
  const dansZ = (n) => !z || (n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]);
  const infra = stockage.q.noeuds.all().filter((n) => dansZ(n) && reseau.vueNoeud(n, true).infrastructure).map((n) => n.num >>> 0);
  const nums = [...new Set([...infra, ...Object.keys(adm).map(Number)])].filter((n) => peutGerer(req, n));
  const nomModule = (num, defaut) => { const n = stockage.q.noeud.get(num >>> 0); return (n && (n.nom_long || n.nom_court)) || defaut; };
  const etats = administration.etatCles(nums, nomModule).map((e) => {
    const n = stockage.q.noeud.get(e.num), f = installations.lire(e.num, true) || {};
    return { ...e, nom: n ? n.nom_long || n.nom_court || reseau.vueNoeud(n, true).id : '!' + e.num.toString(16), id: '!' + e.num.toString(16).padStart(8, '0'), lat: n ? n.lat : null, lon: n ? n.lon : null, dernierVu: n ? n.dernier_vu : null, aFaireNote: f.aFaire || '', site: f.site || '' };
  });
  res.set('Cache-Control', 'no-store').json({ modules: Object.entries(administration.modulesCles()).map(([num, m]) => ({ num: Number(num), nom: nomModule(num, m.nom), vu: m.vu })), noeuds: etats });
});
app.post('/api/noeuds/:num/a-faire', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!peutGerer(req, req.params.num)) return refuserSecteur(res);
  try {
    const c = utilisateur(req);
    installations.completer(Number(req.params.num) >>> 0, { aFaire: String((req.body || {}).texte || '').slice(0, 500) }, c.indicatif || c.identifiant);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// Firmware : dernières versions publiées et version du module connecté (mise à jour par Wi-Fi)
app.get('/api/admin-noeuds/firmware', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const i = sourceRadio ? sourceRadio.infos() : {}, et = sourceRadio ? sourceRadio.etat() : {};
  const ref = (maintenance.firmwares().reference) || {};
  let module = null;
  if (i.noeudLocal) {
    const n = stockage.q.noeud.get(i.noeudLocal >>> 0) || {};
    const l = administration.detailLecture(i.noeudLocal) || {};
    const m = l.materiel || {};
    module = { num: i.noeudLocal >>> 0, nom: n.nom_long || n.nom_court || null, connecte: !!i.connecte, hote: et.hote || null,
      ip: !!(et.hote && /\./.test(et.hote)), firmware: m.firmwareVersion || n.firmware || null, materiel: m.hwModel || n.materiel || null, wifi: m.hasWifi ?? null };
  }
  res.set('Cache-Control', 'no-store').json({ module, stable: ref.stable || null, test: ref.test || null });
});

// Mise à jour par Wi-Fi de n'importe quel module joignable en IP depuis le serveur (modules enregistrés ou adresse saisie)
const estIp = (h) => /^[0-9a-z-]+(\.[0-9a-z-]+)+$/i.test(String(h || '')) || agents.estAgent(String(h || ''));
app.get('/api/firmware/modules', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const ref = maintenance.firmwares().reference || {};
  const l = sourceRadio ? sourceRadio.modules().modules : [];
  // Modules Wi-Fi enregistrés, et modules Wi-Fi d'autres réseaux reliés par un agent (la mise à jour passe par l'agent)
  const parAgent = agents.liste().filter((a) => /wi-?fi|\d+\.\d+\.\d+\.\d+/i.test(a.source || '') && !/usb|com\d|\/dev\//i.test(a.source || ''))
    .map((a) => ({ hote: a.hote, nom: a.nom, agent: true, versionAgent: a.version, source: a.source, actif: a.occupe }));
  res.set('Cache-Control', 'no-store').json({ modules: [...l.filter((m) => /\./.test(m.hote)).map((m) => ({ hote: m.hote, nom: m.nom, actif: m.actif })), ...parAgent], stable: ref.stable || null, test: ref.test || null });
});
app.get('/api/firmware/info', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const hote = String(req.query.hote || '');
  if (!estIp(hote)) return res.status(400).json({ erreur: 'Adresse IP ou nom invalide' });
  const et = sourceRadio ? sourceRadio.etat() : {};
  if (et.hote === hote) {
    // Module de la carte : on ne lui ouvre pas une 2e connexion (elle couperait la carte)
    const i = sourceRadio.infos(), l = administration.detailLecture(i.noeudLocal) || {}, n = stockage.q.noeud.get(i.noeudLocal >>> 0) || {};
    return res.json({ num: i.noeudLocal, nom: n.nom_long || null, firmware: (l.materiel || {}).firmwareVersion || n.firmware || null, hwModel: (l.materiel || {}).hwModel || n.materiel || null, carte: true });
  }
  try { res.json(await administration.infoModuleIp(hote)); } catch (e) { res.status(502).json({ erreur: e.message }); }
});
app.post('/api/firmware/ota', async (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {}, hote = String(b.hote || ''), version = String(b.version || '');
  if (!estIp(hote) || !version) return res.status(400).json({ erreur: 'Adresse ou version manquante' });
  try {
    const et = sourceRadio ? sourceRadio.etat() : {};
    if (et.hote === hote) return res.json(administration.lancer('firmware', [sourceRadio.infos().noeudLocal], { version }, u.identifiant));
    const m = await administration.infoModuleIp(hote);
    res.json(administration.lancer('firmware', [m.num], { version, hote }, u.identifiant));
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// ---- Contrôle du trafic : nœuds trop bavards et paquets réinjectés depuis MQTT -----------------------
let controleTrafic = null;
const obtenirControle = () => controleTrafic || (controleTrafic = require('./trafic').creerControleTrafic({ stockage, config, administration }));
app.get('/api/trafic/controle', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(obtenirControle().analyser(Math.min(Math.max(Number(req.query.heures) || 24, 1), 168)));
});
// Corrige les nœuds administrables : intervalles de position / télémétrie / fiche, ou « Ignorer MQTT » sur les relais
app.post('/api/trafic/corriger', (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  const nums = [...new Set((b.nums || []).map((x) => Number(x) >>> 0))].filter(Boolean).slice(0, 30);
  if (!nums.length) return res.status(400).json({ erreur: 'Aucun nœud choisi' });
  if (!peutGererTous(req, nums)) return refuserSecteur(res);
  const r = b.ignorerMqtt ? null : obtenirControle().analyser(24);
  const taches = [], refus = [];
  for (const num of nums) {
    try {
      let params;
      if (b.ignorerMqtt) params = { lora: { ignoreMqtt: true } };
      else {
        const e = r.bavards.find((x) => x.num === num);
        if (!e) { refus.push({ num, raison: 'plus trop bavard sur 24 h' }); continue; }
        params = obtenirControle().correctifs(e);
      }
      taches.push(administration.lancer('modifier', [num], params, u.identifiant, { insister: true }).id);
    } catch (e) { refus.push({ num, raison: e.message }); }
  }
  res.json({ taches, refus });
});

// Nouveaux nœuds du secteur (membres : positions des particuliers arrondies comme ailleurs)
let nouveaux = null;
const obtenirNouveaux = () => (nouveaux = nouveaux || creerNouveaux(stockage, config, reseau));
app.get('/api/noeuds-nouveaux', (req, res) => {
  obtenirNouveaux();
  const r = nouveaux.lister(Number(req.query.jours) || 7);
  // Résultat partagé (gardé 4 min) : la vue publique en est une copie, positions des particuliers arrondies
  if (!estMembre(req)) return res.json({ ...r, noeuds: r.noeuds.map((n) => { const f = stockage.q.noeud.get(n.num); const v = f ? reseau.vueNoeud(f, false) : { lat: null, lon: null }; return { ...n, lat: v.lat, lon: v.lon }; }) });
  res.json(r);
});

// Conformité automatique (chaque nuit)
app.get('/api/admin-noeuds/conformite-auto', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(administration.conformite());
});
app.post('/api/admin-noeuds/conformite-auto', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try {
    const c = administration.reglerConformite(req.body || {});
    if ((req.body || {}).maintenant) { const u = utilisateur(req); return res.json({ ...c, tache: administration.lancerConformite(u.identifiant).id }); }
    res.json(c);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// ---- Favoris entre relais (sauts gratuits), modèles de programmation, YAML, firmware 2.8 ----------------------
let favorisPlan = null, modeles = null, renumerotation = null;
const obtenirFavoris = () => favorisPlan || (favorisPlan = require('./favoris').creerFavoris({ stockage, config, administration }));
const obtenirModeles = () => modeles || (modeles = require('./modeles').creerModeles(path.dirname(config.fichierBase), { ROLES: administration.ROLES, REDIFFUSIONS: administration.REDIFFUSIONS }));
const obtenirRenumerotation = () => renumerotation || (renumerotation = require('./renumerotation').creerRenumerotation({ stockage, config, installations, comptes, administration, journal, autres: () => ({ equipes, suivis, responsables, secteursAlerte }) }));
app.get('/api/admin-noeuds/favoris', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const p = obtenirFavoris().plan({ jours: Math.min(30, Math.max(1, Number(req.query.jours) || 7)) });
  p.recepteurs = p.recepteurs.filter((r) => peutGerer(req, r.num));
  res.set('Cache-Control', 'no-store').json(p);
});
app.get('/api/admin-noeuds/modeles', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.json({ modeles: obtenirModeles().liste() });
});
app.post('/api/admin-noeuds/modeles', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const u = utilisateur(req);
  try { res.json(obtenirModeles().enregistrer(req.body || {}, u.indicatif || u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/admin-noeuds/modeles/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { obtenirModeles().supprimer(req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/admin-noeuds/modeles/import', express.text({ type: '*/*', limit: '200kb' }), (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(obtenirModeles().importerYaml(typeof req.body === 'string' ? req.body : (req.body && req.body.yaml) || '')); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Applique un modèle : une opération « modifier » par nœud (et, si le modèle le prévoit, les favoris des routeurs voisins)
app.post('/api/admin-noeuds/modeles/:id/appliquer', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const u = utilisateur(req), cibles = ((req.body || {}).cibles || []).map((x) => Number(x) >>> 0).filter(Boolean);
  if (!cibles.length) return res.status(400).json({ erreur: 'Aucun nœud choisi' });
  if (cibles.length > 20) return res.status(400).json({ erreur: '20 nœuds au maximum à la fois' });
  if (!peutGererTous(req, cibles)) return refuserSecteur(res);
  try {
    const m = obtenirModeles().obtenir(req.params.id);
    const params = obtenirModeles().versParams(req.params.id);
    const taches = cibles.map((c) => administration.lancer('modifier', [c], params, u.identifiant).id);
    let favoris = null;
    if (m.favoris && (req.body || {}).favoris !== false) {
      const plan = {};
      for (const r of obtenirFavoris().plan().recepteurs) if (cibles.includes(r.num)) { const a = r.favoris.filter((f) => !f.pose).map((f) => f.num); if (a.length) plan[r.num] = { ajouter: a }; }
      // Le rôle change avec le modèle : un nœud qui devient récepteur (ROUTER, ROUTER_LATE, CLIENT_BASE) n'est pas encore dans le plan
      if (Object.keys(plan).length) favoris = administration.lancer('favoris', Object.keys(plan).map(Number), { plan }, u.identifiant).id;
    }
    res.json({ taches, favoris });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Export YAML (format `meshtastic --export-config`) de la dernière lecture d'un nœud
app.get('/api/admin-noeuds/lecture/:num/yaml', async (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const num = Number(req.params.num) >>> 0;
  if (!peutGerer(req, num)) return refuserSecteur(res);
  const d = administration.detailLecture(num);
  if (!d || !d.device) return res.status(404).json({ erreur: 'Configuration pas encore lue : lisez-la d’abord (Programmer › Lire sa configuration)' });
  let canalUrl = null;
  if (req.query.canaux === '1') { try { const q = await require('./reglages-noeuds').qr(num, {}); canalUrl = q && q.url; } catch { /* pas de canaux connus */ } }
  const n = stockage.q.noeud.get(num);
  const texte = obtenirModeles().exporterYaml(d, { canalUrl, position: n && n.lat != null ? { lat: n.lat, lon: n.lon, alt: n.alt } : null, nom: (n && (n.nom_long || n.nom_court)) || d.id, source: 'de la carte ' + (config.zoneNom || '') });
  audit.noter(nomCompte(utilisateur(req)), req.ip, 'export YAML', `${d.id}${canalUrl ? ' (avec les clés des canaux)' : ''}`, true);
  res.set('Content-Type', 'text/yaml; charset=utf-8').set('Content-Disposition', `attachment; filename="${(n && (n.nom_court || n.nom_long) || d.id).replace(/[^\w.-]+/g, '_')}-config.yaml"`).set('Cache-Control', 'no-store').send(texte);
});
// Firmware 2.8 : nœuds renumérotés (même clé publique, nouveau numéro), clés en double, réglages coupés par la 2.8
app.get('/api/admin-noeuds/v28', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json({ ...obtenirRenumerotation().detecter(), ...maintenance.v28() });
});
app.post('/api/admin-noeuds/fusion', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const u = utilisateur(req), b = req.body || {};
  try {
    const h = obtenirRenumerotation().fusionner(Number(b.ancien), Number(b.nouveau), u.identifiant, { force: b.force === true });
    viderCacheNoeuds();
    audit.noter(nomCompte(u), req.ip, 'fusion de nœuds (2.8)', `${h.idAncien} → ${h.idNouveau}${h.force ? ' (forcée)' : ''}`, true);
    res.json(h);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/admin-noeuds/fusion/annuler', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const u = utilisateur(req), b = req.body || {};
  try {
    const h = obtenirRenumerotation().annuler(Number(b.heure), Number(b.ancien), Number(b.nouveau), u.identifiant);
    viderCacheNoeuds();
    audit.noter(nomCompte(u), req.ip, 'annulation de fusion (2.8)', `${h.idAncien} ← ${h.idNouveau}`, true);
    res.json(h);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// Rapport hebdomadaire (membres) : page imprimable des 7 derniers jours, archives du lundi
let rapport = null;
function obtenirRapport() {
  if (rapport) return rapport;
  rapport = creerRapport({
    stockage, config, reseau, maintenance, journal,
    alertes: () => dernieresAlertes,
    nouveaux: obtenirNouveaux,
    asymetrie: () => obtenirAsymetrie().calculer(),
    conformite: () => administration.conformite(),
    couverture: () => { const c = relief.classement(); return c && c.reseauActuel ? { pct: c.reseauActuel.pct } : null; },
    meshcore: () => {
      if (!config.meshcore.actif) return null;
      const z = config.zone, dz = (n) => n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3];
      const l = reseauMc.q.noeuds.all().filter(dz), lim = Date.now() - 7 * 86400000;
      const rep = l.filter((n) => ['repeteur', 'salon'].includes(n.role));
      return { noeuds: l.length, repeteurs: rep.length, actifs: rep.filter((n) => (n.dernier_vu || 0) >= lim).length };
    },
  });
  return rapport;
}
app.get('/rapport', (req, res) => {
  if (!estMembre(req)) return res.status(401).send('Connexion requise : connectez-vous sur la carte puis rouvrez cette page.');
  // Démonstration (visiteur sans compte) : sans les alertes réservées aux membres (équipes, secteurs, urgence…)
  try { res.set('Cache-Control', 'no-store').type('html').send(obtenirRapport().construire({ alertes: req.demoLecture ? alertesPubliques(dernieresAlertes) : null })); } catch (e) { res.status(500).send('Rapport indisponible : ' + e.message); }
});
app.get('/api/rapports', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  res.json(obtenirRapport().liste());
});
app.get('/rapports/:nom', (req, res) => {
  if (!estMembre(req)) return res.status(401).send('Connexion requise');
  const f = obtenirRapport().fichier(String(req.params.nom));
  if (!f || !fs.existsSync(f)) return res.status(404).send('Rapport introuvable');
  res.type('html').sendFile(f);
});
setTimeout(() => { try { obtenirRapport(); } catch (e) { journal('[Rapport]', e.message); } }, 120000).unref();

// ---- QR code des réglages d'un nœud (canaux + LoRa, contient les clés : admin) ---------------
app.get('/api/noeuds/:num/qr', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const num = Number(req.params.num) >>> 0;
  const liste = (v) => (v == null ? null : String(v).split(',').filter((x) => x !== '').map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < 8));
  const indices = req.query.canaux != null && req.query.canaux !== '' ? liste(req.query.canaux) : null;
  const montants = liste(req.query.up), descendants = liste(req.query.down);
  try {
    const r = await require('./reglages-noeuds').qr(num, { indices, avecLora: req.query.lora !== '0', montants, descendants });
    if (!r) return res.status(404).json({ erreur: 'Réglages de ce nœud inconnus : lisez sa configuration par LoRa', lirePossible: sourceRadio.infos().connecte });
    res.set('Cache-Control', 'no-store').json(r);
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ---- Envoi de messages texte par le module (admin) ---------------------------------------
app.get('/api/envoi', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const i = sourceRadio.infos();
  // Nœuds dont le module de la carte connaît la clé publique : sans elle, un message direct est refusé par le module
  const cles = i.clesPubliques instanceof Map ? [...i.clesPubliques.keys()].map((n) => n >>> 0) : null;
  res.json({ connecte: i.connecte, noeudLocal: i.noeudLocal, canaux: i.canaux || [], clesConnues: cles });
});
app.post('/api/envoi', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  try {
    const r = administration.envoyerTexte(req.body || {}, u.identifiant);
    setTimeout(() => diffuser({ genre: 'statut' }), 500);
    res.json(r);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Avant un message direct : envoie la fiche du module (clé publique) au nœud, qui répond avec la sienne
app.post('/api/echanger-infos/:num', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(administration.echangerInfos(Number(req.params.num))); } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.get('/api/envoi/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.json(administration.etatEnvoi(req.params.id) || { statut: 'inconnu' });
});

// ---- Trames d'un nœud, détail d'une trame, comparaison des signaux ------------------------
const BROADCAST = 0xffffffff;
const FILTRES_TRAMES = {
  emis: 'p.de = @n',
  emis_direct: 'p.de = @n AND p.vers != @b',
  diffusion: 'p.de = @n AND p.vers = @b',
  recu: 'p.vers = @n',
  conversation: '(p.de = @n OR p.vers = @n) AND p.vers != @b',
  passerelle: 'EXISTS (SELECT 1 FROM receptions r2 WHERE r2.paquet = p.rowid AND r2.passerelle = @n)',
  tous: '(p.de = @n OR p.vers = @n OR EXISTS (SELECT 1 FROM receptions r2 WHERE r2.paquet = p.rowid AND r2.passerelle = @n))',
};
const COLONNES_RECEPTIONS = `(SELECT json_group_array(json_object('passerelle', r.passerelle, 'heure', r.heure, 'snr', r.snr, 'rssi', r.rssi, 'sauts', r.sauts, 'relais', r.relais_num, 'sujet', r.sujet))
  FROM receptions r WHERE r.paquet = p.rowid) AS receptions`;
function preparerTrame(p, membre) {
  p = reseau.vueTrame(p, membre);
  return {
    rowid: p.rowid, idPaquet: p.id_paquet, de: p.de, vers: p.vers, canal: p.canal, port: p.port, nomPort: p.nom_port, portnum: p.portnum,
    heure: p.heure, hopDepart: p.hop_depart, sauts: p.sauts, dechiffre: !!p.dechiffre, pki: !!p.pki, signe: !!p.signe, signature: p.signature ?? null, viaMqtt: !!p.via_mqtt, taille: p.taille,
    resume: p.resume, texte: membre ? p.texte : undefined, nbReceptions: p.nb_receptions,
    contenu: p.contenu ? JSON.parse(p.contenu) : null,
    receptions: JSON.parse(p.receptions || '[]').sort((a, b) => a.heure - b.heure),
  };
}
// Parcours d'un message : toutes ses réceptions (passerelles MQTT et module radio), pour tracer le chemin
app.get('/api/messages/:rowid/parcours', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const p = stockage.db.prepare(`SELECT p.rowid, p.*, ${COLONNES_RECEPTIONS} FROM paquets p WHERE p.rowid = ?`).get(Number(req.params.rowid) || 0);
  if (!p) return res.status(404).json({ erreur: 'Message introuvable' });
  res.json(preparerTrame(p, true));
});
app.get('/api/noeuds/:num/trames', (req, res) => {
  const n = Number(req.params.num) >>> 0;
  const filtre = FILTRES_TRAMES[req.query.filtre] ? req.query.filtre : 'emis';
  const taille = Math.min(Math.max(Number(req.query.taille) || 25, 5), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const port = req.query.port ? String(req.query.port).slice(0, 20) : null;
  const where = FILTRES_TRAMES[filtre] + (port ? ' AND p.port = @port' : '');
  const params = { n, b: BROADCAST, port, lim: taille, off: (page - 1) * taille };
  const total = stockage.db.prepare(`SELECT COUNT(*) AS t FROM paquets p WHERE ${where}`).get(params).t;
  const lignes = stockage.db.prepare(`SELECT p.*, ${COLONNES_RECEPTIONS} FROM paquets p WHERE ${where} ORDER BY p.heure DESC LIMIT @lim OFFSET @off`).all(params);
  const parPort = stockage.db.prepare(`SELECT p.port, COUNT(*) AS nb FROM paquets p WHERE ${FILTRES_TRAMES[filtre]} GROUP BY p.port ORDER BY nb DESC`).all(params);
  const membre = estMembre(req);
  res.json({ total, page, pages: Math.max(1, Math.ceil(total / taille)), filtre, parPort, trames: lignes.map((p) => preparerTrame(p, membre)) });
});
app.get('/api/trames/:rowid', (req, res) => {
  const p = stockage.db.prepare(`SELECT p.*, ${COLONNES_RECEPTIONS} FROM paquets p WHERE p.rowid = ?`).get(Number(req.params.rowid));
  if (!p) return res.status(404).json({ erreur: 'Trame inconnue (plus de ' + config.retentionJours + ' jours ?)' });
  res.json(preparerTrame(p, estMembre(req)));
});
app.get('/api/signal', (req, res) => {
  const de = Number(req.query.de) >>> 0, gw = Number(req.query.passerelle) >>> 0;
  const depuis = Date.now() - Math.min(Number(req.query.jours) || config.retentionJours, config.retentionJours) * 86400000;
  const points = stockage.db.prepare(`SELECT r.heure, r.snr, r.rssi, r.sauts, p.port, p.rowid FROM receptions r JOIN paquets p ON p.rowid = r.paquet
      WHERE p.de = ? AND r.passerelle = ? AND r.heure >= ? AND (r.snr IS NOT NULL OR r.rssi IS NOT NULL) ORDER BY r.heure`).all(de, gw, depuis);
  res.json({ de, passerelle: gw, points });
});
// Passerelles qui ont entendu un nœud (pour le menu « Comparer les signaux »)
// Statistiques d'un nœud : activité heure par heure (7 jours), types de paquets, SNR reçus en direct, sauts, récepteurs
app.get('/api/noeuds/:num/statistiques', (req, res) => {
  const n = Number(req.params.num) >>> 0;
  const jours = Math.min(Math.max(Number(req.query.jours) || 7, 1), config.retentionJours || 7);
  const d = Date.now() - jours * 86400000;
  const db = stockage.db;
  const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' });
  const tz = (h) => { const x = new Date(h); return { j: Math.floor((Date.now() - h) / 86400000), h: Number(fmtHeure.formatToParts(x).find((q) => q.type === 'hour').value) % 24, js: x.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit' }) }; };
  // Carte de chaleur : ligne = jour (0 = aujourd'hui), colonne = heure locale
  const chaleur = Array.from({ length: jours }, () => new Array(24).fill(0)), libJours = new Array(jours).fill('');
  for (const r of db.prepare('SELECT heure FROM paquets WHERE de = ? AND heure >= ?').iterate(n, d)) {
    const t = tz(r.heure); if (t.j < jours) { chaleur[t.j][t.h]++; libJours[t.j] = t.js; }
  }
  for (let j = 0; j < jours; j++) if (!libJours[j]) libJours[j] = new Date(Date.now() - j * 86400000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit' });
  const types = db.prepare('SELECT COALESCE(nom_port, port, \'?\') AS type, COUNT(*) AS nb FROM paquets WHERE de = ? AND heure >= ? GROUP BY 1 ORDER BY nb DESC').all(n, d);
  const sauts = db.prepare('SELECT sauts, COUNT(*) AS nb FROM paquets WHERE de = ? AND heure >= ? AND sauts IS NOT NULL GROUP BY sauts ORDER BY sauts').all(n, d);
  // SNR des réceptions directes (0 saut) par tranches de 2,5 dB
  const snr = db.prepare('SELECT CAST(FLOOR(r.snr / 2.5) * 2.5 AS REAL) AS tranche, COUNT(*) AS nb FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = ? AND r.heure >= ? AND r.sauts = 0 AND r.snr IS NOT NULL AND r.passerelle != ? GROUP BY tranche ORDER BY tranche').all(n, d, n);
  const recepteurs = db.prepare('SELECT r.passerelle AS num, COUNT(*) AS nb, ROUND(AVG(r.snr), 1) AS snr, MIN(r.sauts) AS sautsMin FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = ? AND r.heure >= ? AND r.passerelle != ? GROUP BY r.passerelle ORDER BY nb DESC LIMIT 12').all(n, d, n);
  const total = types.reduce((a, t) => a + t.nb, 0);
  res.set('Cache-Control', 'no-store').json({ jours, total, chaleur, libJours, types, sauts, snr, recepteurs });
});
app.get('/api/noeuds/:num/entendu-par', (req, res) => {
  const n = Number(req.params.num) >>> 0;
  const depuis = Date.now() - config.retentionJours * 86400000;
  res.json(stockage.db.prepare(`SELECT r.passerelle, COUNT(*) AS nb, MAX(r.heure) AS dernier, ROUND(AVG(r.snr), 2) AS snr, ROUND(AVG(r.rssi), 1) AS rssi, MIN(r.sauts) AS sautsMin,
      (SELECT p2.rowid FROM receptions r3 JOIN paquets p2 ON p2.rowid = r3.paquet WHERE p2.de = @n AND r3.passerelle = r.passerelle ORDER BY r3.heure DESC LIMIT 1) AS derniereTrame,
      (SELECT r4.snr FROM receptions r4 JOIN paquets p4 ON p4.rowid = r4.paquet WHERE p4.de = @n AND r4.passerelle = r.passerelle ORDER BY r4.heure DESC LIMIT 1) AS dernierSnr
      FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = @n AND r.heure >= @d AND r.passerelle != @n GROUP BY r.passerelle ORDER BY dernier DESC`).all({ n, d: depuis }));
});

// ---- Responsable de chaque nœud (membres : nom ; gestionnaires : contact ; modification : qui peut gérer le nœud) ----
const responsables = require('./responsables').creerResponsables({ config, comptes, journal });
app.get('/api/responsables', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  res.set('Cache-Control', 'no-store').json(responsables.liste({ avecContact: estGestion(req) }));
});
// Comptes proposables comme responsables (sans adresse mail)
app.get('/api/responsables/comptes', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  res.json(comptes.lister().filter((c) => c.statut === 'actif').map((c) => ({ id: c.id, nom: c.indicatif ? `${c.identifiant} (${c.indicatif})` : c.identifiant, role: c.role })));
});
app.post('/api/noeuds/:num/responsable', (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  if (!peutGerer(req, req.params.num)) return refuserSecteur(res);
  try {
    const r = responsables.definir(req.params.num, req.body || {}, { auteur: nomCompte(u), admin: u.role === 'admin' });
    diffuser({ genre: 'responsables' });
    res.json({ ok: true, responsable: r });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// « Pour le joindre » : par quelle station la carte peut atteindre ce nœud, et dans quel sens la liaison est prouvée.
// Une liaison a → b signifie « b a entendu a ». Entendre un nœud ne prouve pas qu'il nous entend : le retour n'est
// prouvé que par son voisinage (il nous liste), une traceroute qui revient, ou une liaison mesurée dans l'autre sens.
app.get('/api/noeuds/:num/joindre', (req, res) => {
  const n = Number(req.params.num) >>> 0;
  const depuis = Date.now() - 7 * 86400000;
  const db = stockage.db;
  const lien = db.prepare('SELECT source, snr, dernier_vu AS dernier FROM liens WHERE a = ? AND b = ? AND dernier_vu >= ? ORDER BY dernier_vu DESC');
  const nomDe = (x) => { const r = stockage.q.noeud.get(x >>> 0); return r ? r.nom_long || r.nom_court || r.id : '!' + (x >>> 0).toString(16).padStart(8, '0'); };
  const recep = db.prepare(`SELECT MIN(r.sauts) AS sautsMin, MAX(r.heure) AS dernier, COUNT(*) AS nb FROM receptions r JOIN paquets p ON p.rowid = r.paquet
      WHERE p.de = ? AND r.passerelle = ? AND r.heure >= ?`);
  const trOk = db.prepare("SELECT heure FROM traceroutes WHERE origine = ? AND cible = ? AND statut = 'repondu' AND heure >= ? ORDER BY heure DESC LIMIT 1");
  // Stations : nos modules radio (ceux qui peuvent émettre) puis les passerelles MQTT qui l'ont entendu
  const nos = new Map();
  try { const i = sourceRadio.infos(); if (i.noeudLocal) nos.set(i.noeudLocal >>> 0, { connecte: !!i.connecte, via: 'module de la carte' }); } catch { /* pas de module */ }
  try { for (const e of (ecoutes.liste().meshtastic || [])) if (e.noeud && !nos.has(e.noeud >>> 0)) nos.set(e.noeud >>> 0, { connecte: !!e.connecte, via: 'module en écoute' }); } catch { /* aucune écoute */ }
  const passerelles = db.prepare(`SELECT DISTINCT r.passerelle AS gw FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = ? AND r.heure >= ? AND r.passerelle != ?`).all(n, depuis, n).map((x) => x.gw >>> 0);
  const stations = [...nos.keys(), ...passerelles.filter((g) => !nos.has(g))];
  const lignes = stations.filter((s) => s !== n).map((s) => {
    const entend = lien.all(n, s, depuis), retour = lien.all(s, n, depuis); // s entend n ; n entend s
    const r = recep.get(n, s, depuis) || {};
    const tr = nos.has(s) ? trOk.get(s, n, depuis) : null;
    const direct = entend.length > 0 || r.sautsMin === 0;
    const retourProuve = retour.length > 0 || !!tr;
    const preuveRetour = retour.length ? `${retour[0].source === 'voisinage' ? 'il nous liste dans son voisinage' : retour[0].source === 'traceroute' ? 'traceroute' : 'liaison mesurée'}${retour[0].snr != null ? ` (${retour[0].snr} dB)` : ''}` : tr ? 'traceroute revenue' : null;
    let verdict;
    if (direct && retourProuve) verdict = 'direct, aller-retour prouvé';
    else if (direct) verdict = 'direct, sens retour non prouvé';
    else if (r.sautsMin != null) verdict = `${r.sautsMin} saut${r.sautsMin > 1 ? 's' : ''}${retourProuve ? '' : ', sens retour non prouvé'}`;
    else if (retourProuve) verdict = 'il nous entend, mais nous ne l’entendons pas';
    else verdict = 'hors de portée';
    return {
      station: s, nom: nomDe(s), emetteur: nos.has(s), via: nos.has(s) ? nos.get(s).via : 'passerelle MQTT', connecte: nos.has(s) ? nos.get(s).connecte : null,
      verdict, direct, retourProuve, preuveRetour, sautsMin: r.sautsMin ?? null, snrEntendu: entend.length ? entend[0].snr : null, dernier: Math.max(r.dernier || 0, entend.length ? entend[0].dernier : 0) || null,
    };
  });
  const rang = (x) => (x.emetteur ? 0 : 10) + (x.direct && x.retourProuve ? 0 : x.direct ? 1 : x.sautsMin != null ? 2 + x.sautsMin : 9);
  lignes.sort((a, b) => rang(a) - rang(b) || (b.dernier || 0) - (a.dernier || 0));
  res.set('Cache-Control', 'no-store').json({ num: n, lignes: lignes.slice(0, 15) });
});

app.get('/api/traceroutes', (req, res) => {
  res.json(stockage.q.trRecents.all(Math.min(Number(req.query.limite) || 50, 500)));
});

// Réglages des traceroutes automatiques (cibles clés, plage horaire, intervalle), gardés dans /data
const fTrReglages = path.join(path.dirname(config.fichierBase), 'traceroutes-reglages.json');
const cfgTrEnv = { cibles: [...config.radio.tracerouteCibles], intervalle: config.radio.tracerouteIntervalleMinutes };
function appliquerReglagesTr() {
  let r = {};
  try { r = lireJson(fTrReglages); } catch { /* aucun */ }
  config.radio.tracerouteCibles = Array.isArray(r.cibles) && r.cibles.length ? r.cibles.map(String) : cfgTrEnv.cibles;
  config.radio.tracerouteHeures = r.heures === 'nuit' ? 'nuit' : 'toujours';
  if (Number.isFinite(r.intervalle)) config.radio.tracerouteIntervalleMinutes = r.intervalle;
  return { cibles: config.radio.tracerouteCibles, heures: config.radio.tracerouteHeures, intervalle: config.radio.tracerouteIntervalleMinutes };
}
appliquerReglagesTr();
app.post('/api/traceroutes/reglages', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  const r = {
    cibles: Array.isArray(b.cibles) ? b.cibles.map((x) => String(Number(x) >>> 0)).filter((x) => x !== '0').slice(0, 40) : [],
    heures: b.heures === 'nuit' ? 'nuit' : 'toujours',
    intervalle: Math.min(Math.max(Number(b.intervalle) || 180, 0), 1440),
  };
  try { ecrireSur(fTrReglages, JSON.stringify(r)); } catch (e) { return res.status(500).json({ erreur: e.message }); }
  res.json(appliquerReglagesTr());
});
// Synthèse : pour chaque nœud tracé depuis 7 jours, dernier chemin mesuré, taux de réponse, changement de route
app.get('/api/traceroutes/synthese', (req, res) => {
  const depuis = Date.now() - 7 * 86400000;
  const lignes = stockage.db.prepare('SELECT * FROM traceroutes WHERE heure >= ? ORDER BY heure DESC').all(depuis);
  const noeuds = new Map(stockage.q.noeuds.all().map((n) => [n.num, n]));
  const nom = (x) => { const n = noeuds.get(x >>> 0); return n ? n.nom_long || n.nom_court || n.id : '!' + (x >>> 0).toString(16).padStart(8, '0'); };
  const pos = (x) => { const n = noeuds.get(x >>> 0); return n && n.lat != null ? [n.lat, n.lon] : null; };
  const chemin = (debut, liste, fin, snrs) => [debut, ...liste, fin].map((x, i) => ({ num: x >>> 0, nom: nom(x), pos: pos(x), snr: i > 0 ? (snrs[i - 1] ?? null) : null }));
  const parCible = new Map();
  for (const t of lignes) { if (!parCible.has(t.cible)) parCible.set(t.cible, []); parCible.get(t.cible).push(t); }
  const cles = new Set(config.radio.tracerouteCibles);
  const sortie = [...parCible].map(([cible, ts]) => {
    const ok = ts.filter((t) => t.statut === 'repondu' && t.aller);
    const termines = ts.filter((t) => t.statut !== 'envoye');
    const d = ok[0];
    const aller = d ? chemin(d.origine, JSON.parse(d.aller), d.cible, JSON.parse(d.snr_aller || '[]')) : null;
    const retour = d && d.retour ? chemin(d.cible, JSON.parse(d.retour), d.origine, JSON.parse(d.snr_retour || '[]')) : null;
    const signature = (t) => t.aller;
    const change = ok.length >= 2 && signature(ok[0]) !== signature(ok[1]);
    const n = noeuds.get(cible);
    return {
      cible, nom: nom(cible), cle: cles.has(String(cible)) || (n && (cles.has(n.id) || cles.has(n.nom_court))),
      essais: ts.length, reussis: ok.length, taux: termines.length ? Math.round((ok.length / termines.length) * 100) : null,
      dernier: { heure: ts[0].heure, statut: ts[0].statut, declencheur: ts[0].declencheur },
      mesure: d ? { heure: d.heure, duree: d.duree, aller, retour } : null,
      routeChangee: change, ancienAller: change ? JSON.parse(ok[1].aller).map((x) => nom(x)) : null,
    };
  }).sort((a, b) => (b.cle - a.cle) || (b.dernier.heure - a.dernier.heure));
  res.json({ reglages: { cibles: config.radio.tracerouteCibles, heures: config.radio.tracerouteHeures || 'toujours', intervalle: config.radio.tracerouteIntervalleMinutes }, radio: !!sourceRadio, cibles: sortie });
});
app.post('/api/traceroute/:num', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!peutGerer(req, req.params.num)) return refuserSecteur(res);
  if (!sourceRadio) return res.status(503).json({ erreur: 'Aucun module radio configuré (RADIO_HOTE)' });
  try {
    res.json(sourceRadio.traceroute(Number(req.params.num), 'manuel'));
  } catch (e) {
    res.status(409).json({ erreur: e.message });
  }
});

app.get('/api/liens', (req, res) => {
  const heures = Math.min(Math.max(Number(req.query.heures) || 24, 0.25), config.retentionJours * 24);
  res.json(reseau.liens(heures * 3600000));
});

// Topologie du réseau Meshtastic (vue en graphe et simulation de propagation) : nœuds et liaisons fusionnées par paire
app.get('/api/topologie', (req, res) => {
  const heures = Math.min(Math.max(Number(req.query.heures) || 72, 1), config.retentionJours * 24);
  const depuis = Date.now() - heures * 3600000;
  const sources = String(req.query.sources || 'rf,voisinage,traceroute').split(',').filter((x) => ['rf', 'voisinage', 'traceroute'].includes(x));
  const bbox = bboxZone(req.query.zone || '1');
  const dansZ = (n) => !bbox || (n.lat != null && n.lat >= bbox[0] && n.lat <= bbox[2] && n.lon >= bbox[1] && n.lon <= bbox[3]);
  const admin = estMembre(req);
  const tous = new Map(stockage.q.noeuds.all().map((n) => [n.num >>> 0, n]));
  // Paires de nœuds : a→b = « b a entendu a »
  const paires = new Map();
  for (const l of stockage.q.liens.all(depuis)) {
    if (!sources.includes(l.source)) continue;
    const a = l.a >>> 0, b = l.b >>> 0;
    if (a === b || !tous.has(a) || !tous.has(b)) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = x + '-' + y;
    const p = paires.get(k) || { a: x, b: y, ab: null, ba: null };
    const sens = a === x ? 'ab' : 'ba';
    const d = p[sens] || { snr: null, sources: [], nb: 0, dernierVu: 0 };
    if (l.snr != null && (d.snr == null || l.source !== 'traceroute')) d.snr = d.snr == null ? l.snr : Math.max(d.snr, l.snr);
    if (!d.sources.includes(l.source)) d.sources.push(l.source);
    d.nb += l.nb; d.dernierVu = Math.max(d.dernierVu, l.dernier_vu);
    p[sens] = d;
    paires.set(k, p);
  }
  // Nœuds : dans la zone et actifs sur la période, ou sans position mais reliés à un nœud de la zone
  const garde = new Set();
  for (const n of tous.values()) if ((n.dernier_vu || 0) >= depuis && n.lat != null && dansZ(n)) garde.add(n.num >>> 0);
  for (const p of paires.values()) {
    const na = tous.get(p.a), nb = tous.get(p.b);
    if (garde.has(p.a) && na.lat != null && nb.lat == null) garde.add(p.b);
    if (garde.has(p.b) && nb.lat != null && na.lat == null) garde.add(p.a);
  }
  const liens = [...paires.values()].filter((p) => garde.has(p.a) && garde.has(p.b));
  const relies = new Set(liens.flatMap((p) => [p.a, p.b]));
  const favoris = (() => { try { return administration.favoris(); } catch { return {}; } })();
  const noeuds = [...garde].filter((num) => relies.has(num) || (tous.get(num).dernier_vu || 0) >= depuis).map((num) => {
    const v = reseau.vueNoeud(tous.get(num), admin);
    return {
      num, id: v.id, nomCourt: v.nomCourt, nomLong: v.nomLong, role: v.role || 'CLIENT', materiel: v.materiel, firmware: v.firmware,
      lat: v.lat, lon: v.lon, position: v.lat != null, passerelle: v.passerelle, infrastructure: v.infrastructure, statut: v.statut,
      infra: ['ROUTER', 'ROUTER_LATE', 'CLIENT_BASE', 'REPEATER'].includes(v.role), relaie: !['CLIENT_MUTE', 'CLIENT_HIDDEN'].includes(v.role || 'CLIENT'),
      dernierVu: v.dernierVu, batterie: v.batterie, canal: v.canal, emission: v.emission,
      favoris: Object.keys(favoris[String(num)] || {}).map(Number),
    };
  });
  // Preset du module connecté ; sinon le plus fréquent parmi les nœuds affichés (rapports de carte)
  const presetMajoritaire = () => { const c = {}; for (const num of garde) { const x = tous.get(num).preset; if (x) c[x] = (c[x] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0]; };
  const preset = (sourceRadio && sourceRadio.etat().preset) || presetMajoritaire() || config.reseauPreset || 'LONG_FAST';
  const hop = (() => { try { return sourceRadio.infos().hopLimit || 3; } catch { return 3; } })();
  res.set('Cache-Control', 'no-store').json({ heures, sources, preset, hopLimit: hop, zoneNom: config.zoneNom, noeuds, liens, genere: Date.now() });
});

// Topologie MeshCore : mêmes données que /api/topologie (numéros locaux pour le graphe, clé publique en plus)
app.get('/api/mc/topologie', (req, res) => {
  if (!exigerMc(res)) return;
  const heures = Math.min(Math.max(Number(req.query.heures) || 72, 1), config.retentionJours * 24);
  const depuis = Date.now() - heures * 3600000;
  const sources = String(req.query.sources || 'rf,voisinage,trace,chemin').split(',').filter((x) => ['rf', 'voisinage', 'trace', 'chemin'].includes(x));
  const bbox = bboxZone(req.query.zone || '1');
  const dansZ = (n) => !bbox || (n.lat != null && n.lat >= bbox[0] && n.lat <= bbox[2] && n.lon >= bbox[1] && n.lon <= bbox[3]);
  const membre = estMembre(req), maintenant = Date.now();
  const tous = new Map(reseauMc.q.noeuds.all().map((n) => [n.cle, n]));
  const paires = new Map();
  for (const l of reseauMc.liens(heures * 3600000)) {
    if (!sources.includes(l.source)) continue;
    const a = l.a, b = l.b;
    if (a === b || !tous.has(a) || !tous.has(b)) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = x + '-' + y;
    const p = paires.get(k) || { a: x, b: y, ab: null, ba: null };
    const sens = a === x ? 'ab' : 'ba';
    const d = p[sens] || { snr: null, sources: [], nb: 0, dernierVu: 0 };
    if (l.snr != null) d.snr = d.snr == null ? l.snr : Math.max(d.snr, l.snr);
    if (!d.sources.includes(l.source)) d.sources.push(l.source);
    d.nb += l.nb || 1; d.dernierVu = Math.max(d.dernierVu, l.dernierVu || 0);
    p[sens] = d;
    paires.set(k, p);
  }
  const garde = new Set();
  for (const n of tous.values()) if ((n.dernier_vu || 0) >= depuis && n.lat != null && dansZ(n)) garde.add(n.cle);
  for (const p of paires.values()) {
    const na = tous.get(p.a), nb = tous.get(p.b);
    if (garde.has(p.a) && na.lat != null && nb.lat == null) garde.add(p.b);
    if (garde.has(p.b) && nb.lat != null && na.lat == null) garde.add(p.a);
  }
  const relies = new Set();
  const liensCle = [...paires.values()].filter((p) => garde.has(p.a) && garde.has(p.b));
  for (const p of liensCle) { relies.add(p.a); relies.add(p.b); }
  // Numéros locaux (le graphe et la simulation travaillent avec des nombres) ; la clé reste fournie
  const cles = [...garde].filter((c) => relies.has(c) || tous.get(c).observateur).sort();
  const num = new Map(cles.map((c, i) => [c, i + 1]));
  const noeuds = cles.map((c) => {
    const v = reseauMc.vueNoeud(tous.get(c), membre, maintenant);
    const obsActif = v.observateur && (v.observateurVu || 0) > maintenant - 3600000;
    return {
      num: num.get(c), cle: c, id: c.slice(0, 8), nomCourt: (v.nom || c.slice(0, 4)).slice(0, 12), nomLong: v.nom || c.slice(0, 8), role: v.role, roleFr: v.roleFr,
      lat: v.lat, lon: v.lon, position: v.lat != null, passerelle: obsActif, infra: v.role === 'repeteur' || v.role === 'salon', relaie: v.role === 'repeteur',
      statut: v.statut, dernierVu: v.dernierVu, favoris: [],
    };
  });
  const liens = liensCle.filter((p) => num.has(p.a) && num.has(p.b)).map((p) => { const [a, b] = [num.get(p.a), num.get(p.b)]; return a < b ? { a, b, ab: p.ab, ba: p.ba } : { a: b, b: a, ab: p.ba, ba: p.ab }; });
  res.set('Cache-Control', 'no-store').json({ reseau: 'meshcore', heures, sources, preset: 'MESHCORE_FR', hopLimit: 64, zoneNom: config.zoneNom, noeuds, liens, genere: Date.now() });
});

app.get('/api/paquets', (req, res) => {
  const admin = estMembre(req);
  const n = Math.min(Number(req.query.limite) || 200, 1000);
  res.json(
    stockage.q.paquetsRecents.all(n).map((p) => reseau.vueTrame({
      ...p,
      receptions: JSON.parse(p.receptions || '[]'),
      texte: admin ? p.texte : undefined,
    }, admin))
  );
});

app.get('/api/etat', (req, res) => {
  res.json({ stats: reseau.statistiques(), alertes: estMembre(req) ? dernieresAlertes : alertesPubliques(dernieresAlertes), meshmonitor: sourceMM ? sourceMM.etat() : null, radio: sourceRadio ? sourceRadio.etat() : null, ecoutes: resumeEcoutes() });
});

// Canaux Meshtastic publics (clé par défaut) : les seuls lisibles en démonstration (messages, recherche)
const canauxPublicsMt = () => config.canaux.filter((c) => !c.cle || c.cle === 'AQ==' || c.cle === '1PG7OiApB1nwvP+rz05pAQ==').map((c) => c.nom);
app.get('/api/messages', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  // Démonstration : canaux publics (clé par défaut) seulement, jamais les messages directs
  const publics = new Set(canauxPublicsMt());
  const garder = (m) => !req.demoLecture || (m.vers === 0xffffffff && publics.has(m.canal));
  const limite = Math.min(Number(req.query.limite) || 300, 2000);
  // ?canal=nom : un seul canal ; ?direct=1 : messages directs seulement ; sinon les derniers, tous canaux confondus
  const liste = req.query.canal ? stockage.q.messagesCanal.all(String(req.query.canal).slice(0, 40), limite)
    : req.query.direct ? stockage.q.messagesDirects.all(limite) : stockage.q.messages.all(limite);
  res.json(liste.filter(garder).map((m) => {
    const a = administration.accuseMessage(m.idPaquet, m.de);
    let entendus = [];
    try { entendus = JSON.parse(m.entendus || '[]'); } catch { /* vide */ }
    return { ...m, entendus, accuse: a ? { statut: a.statut, detail: a.detail || null, heure: a.heureAccuse || null, dest: a.dest } : null };
  }));
});

// Recherche dans les messages (Meshtastic et MeshCore) : mots du texte, nom ou identifiant de l'expéditeur (et du
// destinataire d'un message direct). Mêmes droits que /api/messages et /api/mc/messages : membres connectés ;
// démonstration : canaux publics seulement, jamais les messages directs.
// Débit : une recherche lit plusieurs index et bloque le serveur quelques millisecondes (better-sqlite3 est
// synchrone : il n'y a jamais deux recherches en même temps, mais une rafale ferait attendre tout le monde).
// Même principe que « tentatives » ci-dessus : 30 requêtes par minute et par adresse, 10 en démonstration.
const recherchesParIp = new Map();
function limiterRecherche(ip, max) {
  const maintenant = Date.now();
  const t = (recherchesParIp.get(ip) || []).filter((x) => maintenant - x < 60000);
  if (t.length >= max) { recherchesParIp.set(ip, t); return true; }
  t.push(maintenant);
  recherchesParIp.set(ip, t);
  return false;
}
setInterval(() => { const limite = Date.now() - 60000; for (const [ip, t] of recherchesParIp) if (!t.some((x) => x > limite)) recherchesParIp.delete(ip); }, 60000).unref();
app.get('/api/messages/recherche', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  if (!rechercheMessages.disponible()) return res.status(503).set('Cache-Control', 'no-store').json({ erreur: 'Recherche indisponible : index impossible à créer (disque plein ou base en lecture seule), voir le journal' });
  // Compteur séparé pour la démonstration : un visiteur derrière le même NAT ne bloque pas un membre connecté
  if (limiterRecherche((req.demoLecture ? 'demo:' : '') + req.ip, req.demoLecture ? 10 : 30)) return res.status(429).set('Retry-After', '60').json({ erreur: 'Trop de recherches, réessayez dans une minute' });
  try {
    res.set('Cache-Control', 'no-store').json(rechercheMessages.chercher({
      q: String(req.query.q || ''), demo: !!req.demoLecture, publics: canauxPublicsMt(),
      avant: String(req.query.avant || '').slice(0, 40), limite: Number(req.query.limite) || 100,
    }));
  } catch (e) {
    journal('[Recherche] échec :', e.message);
    res.status(400).json({ erreur: 'Recherche impossible : essayez d’autres mots' });
  }
});

// Notifications de l'application Android (service en arrière-plan, écran éteint) : ce qui mérite de réveiller le
// téléphone depuis « depuis » (ms) — messages directs reçus (Meshtastic et MeshCore), alertes critiques nouvelles,
// signalements nouveaux. Réservé aux membres connectés (session de l'application).
app.get('/api/notifications', (req, res) => {
  if (!estMembre(req) || req.demoLecture) return res.status(401).json({ erreur: 'Connexion requise' });
  const depuis = Math.max(Number(req.query.depuis) || 0, Date.now() - 24 * 3600000);
  // Langue du téléphone (?langue=en) : alertes et libellés traduits ; les messages reçus restent tels quels
  const tr = String(req.query.langue || '').toLowerCase().startsWith('en') ? require('./traduction').traduire : (t) => t;
  const l = [];
  try {
    const moi = sourceRadio ? sourceRadio.etat().noeudLocal : null;
    if (moi != null) for (const m of stockage.q.messages.all(200)) {
      if ((m.heure || 0) > depuis && m.vers === moi && m.de !== moi && m.texte) l.push({ id: 'mt-' + m.idPaquet, genre: 'direct', heure: m.heure, titre: `✉️ ${nomNoeudServeur(m.de)}`, texte: m.texte });
    }
  } catch { /* pas de module */ }
  try {
    for (const m of reseauMc.messages(200)) if ((m.heure || 0) > depuis && m.sens === 'recu' && m.genre === 'direct') l.push({ id: 'mc-' + m.id, genre: 'direct', heure: m.heure, titre: `✉️ ${m.nomDe || 'MeshCore'} (MeshCore)`, texte: m.texte });
  } catch { /* MeshCore absent */ }
  for (const a of dernieresAlertes) if (a.niveau === 'critique' && (a.depuis || 0) > depuis) l.push({ id: 'al-' + a.cle, genre: 'alerte', heure: a.depuis, titre: '⚠️ ' + tr('Alerte'), texte: tr(a.message) });
  try { for (const x of signalements.lister()) if (x.actif && (x.cree || 0) > depuis) l.push({ id: 'sg-' + x.id, genre: 'signalement', heure: x.cree, titre: '📍 ' + tr('Signalement'), texte: [x.titre, x.details].filter(Boolean).join(' : ') }); } catch { /* pas prêt */ }
  res.set('Cache-Control', 'no-store').json({ maintenant: Date.now(), notifications: l.sort((a, b) => a.heure - b.heure).slice(-20) });
});
function nomNoeudServeur(num) { try { const n = stockage.q.noeud.get(num >>> 0); return (n && (n.nom_long || n.nom_court)) || '!' + (num >>> 0).toString(16); } catch { return '!' + (num >>> 0).toString(16); } }

// Blocage après 3 échecs (adresse et compte), voir blocages.js
const blocages = require('./blocages').creerBlocages(config, journal);
const heureBlocage = (t) => new Date(t).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
app.post('/api/connexion', (req, res) => {
  const b0 = req.body || {};
  const bl = blocages.bloque(req.ip, b0.identifiant);
  if (bl) {
    audit.noter(String(b0.identifiant || '').slice(0, 32) || null, req.ip, 'connexion refusée', `bloqué (${bl.type === 'ip' ? 'adresse' : 'compte'}) jusqu’à ${heureBlocage(bl.jusqua)}`, false);
    return res.status(429).json({ erreur: `Trop d’échecs de connexion : ${bl.type === 'ip' ? 'cette adresse est bloquée' : 'ce compte est suspendu'} jusqu’à ${heureBlocage(bl.jusqua)}. Un administrateur peut débloquer.`, bloqueJusqua: bl.jusqua });
  }
  if (limiter(req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  try {
    const b = req.body || {};
    const c = comptes.connecter(b.identifiant, b.motDePasse, b.code);
    blocages.reussite(req.ip, b.identifiant);
    ouvrirSession(req, res, c);
    journal(`Connexion de ${c.identifiant} (${c.role})`);
    audit.noter(nomCompte(c), req.ip, 'connexion', c.deuxFacteurs ? 'avec double authentification' : null, true);
    res.json({ ok: true, compte: c });
  } catch (e) {
    const b = req.body || {};
    // Code manquant : simple étape de la connexion, pas un échec
    if (!(e.codeRequis && !b.code)) audit.noter(String(b.identifiant || '').slice(0, 32) || null, req.ip, 'connexion refusée', e.message, false);
    // Mauvais mot de passe ou mauvais code : un échec compté (un code simplement demandé ne compte pas)
    if (/incorrect/i.test(e.message)) {
      const r = blocages.echec(req.ip, b.identifiant);
      if (r.blocage) {
        audit.noter(String(b.identifiant || '').slice(0, 32) || null, req.ip, 'blocage', `${r.blocage.type === 'ip' ? 'adresse bloquée' : 'compte suspendu'} ${Math.round(r.blocage.duree / 60000)} min après ${blocages.MAX_ECHECS} échecs`, false);
        return res.status(429).json({ erreur: `${e.message}. Trop d’échecs : ${r.blocage.type === 'ip' ? 'cette adresse est bloquée' : 'ce compte est suspendu'} jusqu’à ${heureBlocage(r.blocage.jusqua)}.`, bloqueJusqua: r.blocage.jusqua });
      }
      return res.status(401).json({ erreur: `${e.message} (encore ${r.restants} essai${r.restants > 1 ? 's' : ''} avant blocage)`, codeRequis: !!e.codeRequis });
    }
    res.status(401).json({ erreur: e.message, codeRequis: !!e.codeRequis });
  }
});

app.post('/api/deconnexion', (req, res) => {
  { const u = utilisateur(req); if (u) audit.noter(nomCompte(u), req.ip, 'déconnexion', null, true); }
  res.setHeader('Set-Cookie', 'gaulix_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/inscription', (req, res) => {
  if (comptes.installationRequise()) return res.status(409).json({ erreur: 'Installation à terminer : créez d’abord le compte administrateur' });
  if (config.inscriptions === 'fermees') return res.status(403).json({ erreur: 'Les inscriptions sont fermées sur cette carte' });
  if (limiter(req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  try {
    const b = req.body || {};
    const statut = config.inscriptions === 'ouvertes' ? 'actif' : 'en_attente';
    const c = comptes.creer({ identifiant: b.identifiant, motDePasse: b.motDePasse, indicatif: b.indicatif, email: b.email }, 'membre', statut);
    journal(`Inscription de ${c.identifiant}${statut === 'en_attente' ? ' (à valider)' : ''}`);
    if (statut === 'actif') ouvrirSession(req, res, c);
    else rafraichirEtat();
    res.json({ ok: true, enAttente: statut !== 'actif' });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// ---- Mot de passe oublié ----
// Par e-mail si le serveur SMTP et l'adresse publique de la carte sont réglés (lien valable 1 h), sinon demande
// signalée aux administrateurs, qui créent un lien (24 h) et le transmettent eux-mêmes. La réponse est la même que
// le compte existe ou non, pour ne pas révéler les comptes.
app.get('/api/mot-de-passe/oubli', (req, res) => res.json({ courriel: courriel.actif() }));
app.post('/api/mot-de-passe/oubli', async (req, res) => {
  if (limiter('mdp:' + req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  const b = req.body || {}, saisi = String(b.identifiant || '').slice(0, 32) || null;
  const reponse = { ok: true, courriel: courriel.actif() };
  const c = comptes.trouverPourOubli(b.identifiant);
  if (!c) { audit.noter(saisi, req.ip, 'mot de passe oublié', 'aucun compte actif correspondant', false); return res.json(reponse); }
  if (courriel.actif() && c.email) {
    try {
      const { jeton } = comptes.creerReinit(c.id, 3600000, 'e-mail');
      const lien = `${courriel.adresseCarte()}/?reinit=${jeton}`;
      const trMail = (x) => (LANGUE_SERVEUR === 'en' ? require('./traduction').traduire(x) : x); // e-mail dans la langue du serveur
      await courriel.envoyer({ a: c.email, sujet: trMail('Carte live : nouveau mot de passe'), texte: [`Bonjour ${c.identifiant},`, '', `Une demande de nouveau mot de passe a été faite pour votre compte sur la carte ${courriel.adresseCarte()}.`, '', 'Pour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure, une seule fois) :', lien, '', 'Si vous n’avez rien demandé, ignorez ce message : votre mot de passe actuel reste valable.'].map(trMail).join('\n') });
      audit.noter(nomCompte(c), req.ip, 'mot de passe oublié', 'lien envoyé par e-mail', true);
      journal(`Mot de passe oublié : lien envoyé par e-mail à ${c.identifiant}`);
      return res.json(reponse);
    } catch (e) { journal('[e-mail] envoi impossible, demande transmise aux administrateurs :', e.message); }
  }
  comptes.noterDemandeReinit(c.id);
  audit.noter(nomCompte(c), req.ip, 'mot de passe oublié', 'demande transmise aux administrateurs', true);
  journal(`Mot de passe oublié : ${c.identifiant} demande un lien de réinitialisation (Gérer › Comptes)`);
  res.json(reponse);
});
app.post('/api/mot-de-passe/reinitialiser', (req, res) => {
  if (limiter('reinit:' + req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  try {
    const b = req.body || {};
    const c = comptes.reinitialiser(b.jeton, b.nouveau);
    audit.noter(nomCompte(c), req.ip, 'mot de passe réinitialisé', null, true);
    journal(`Mot de passe réinitialisé : ${c.identifiant}`);
    // Sans double authentification, la personne est connectée tout de suite ; avec, elle se connecte avec son code
    if (!c.deuxFacteurs) ouvrirSession(req, res, c);
    res.json({ ok: true, identifiant: c.identifiant, connecte: !c.deuxFacteurs });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/compte/email', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { comptes.changerEmail(u.id, (req.body || {}).email); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});

app.get('/api/compte', (req, res) => res.json(utilisateur(req)));
app.post('/api/compte/mot-de-passe', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try {
    comptes.changerMotDePasse(u.id, (req.body || {}).ancien, (req.body || {}).nouveau);
    ouvrirSession(req, res, u);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// Double authentification et sessions du compte connecté
app.post('/api/compte/deux-facteurs/preparer', async (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try {
    const r = comptes.preparerDeuxFacteurs(u.id);
    res.set('Cache-Control', 'no-store').json({ ...r, qr: await require('qrcode').toDataURL(r.url, { margin: 1, width: 220 }) });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/compte/deux-facteurs/activer', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { comptes.activerDeuxFacteurs(u.id, (req.body || {}).code); ouvrirSession(req, res, u); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/compte/deux-facteurs/retirer', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { comptes.retirerDeuxFacteurs(u.id, (req.body || {}).motDePasse, false); ouvrirSession(req, res, u); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/compte/deconnecter-partout', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  comptes.deconnecterPartout(u.id);
  ouvrirSession(req, res, u); // cette session reste ouverte, toutes les autres sont fermées
  res.json({ ok: true });
});
app.get('/api/securite/blocages', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(blocages.liste());
});
app.post('/api/securite/debloquer', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const cle = String((req.body || {}).cle || '');
  if (!/^(ip|compte):/.test(cle)) return res.status(400).json({ erreur: 'clé invalide' });
  const ok = blocages.debloquer(cle);
  audit.noter(nomCompte(utilisateur(req)), req.ip, 'déblocage', cle, true);
  res.json({ ok });
});
app.get('/api/audit', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(audit.liste({ compte: req.query.compte || null, action: req.query.action || null, limite: req.query.limite }));
});

// ---- Gestion des comptes (admin) ---------------------------------------------------
app.get('/api/comptes', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.json(comptes.lister());
});
app.post('/api/comptes', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try {
    const b = req.body || {};
    const c = comptes.creer(b, ['admin', 'gestionnaire'].includes(b.role) ? b.role : 'membre', 'actif');
    if (b.noeuds) comptes.changerNoeuds(c.id, b.noeuds);
    res.json(comptes.lister().find((x) => x.id === c.id) || c);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/comptes/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try {
    const id = Number(req.params.id), b = req.body || {};
    if (b.role) comptes.changerRole(id, b.role);
    if (b.statut) comptes.changerStatut(id, b.statut);
    if (b.noeuds !== undefined) comptes.changerNoeuds(id, b.noeuds);
    if (b.retirerDeuxFacteurs) comptes.retirerDeuxFacteurs(id, null, true);
    if (b.deconnecter) comptes.deconnecterPartout(id);
    if (b.identifiant !== undefined || b.indicatif !== undefined || b.email !== undefined) {
      const avant = comptes.lister().find((c) => c.id === id);
      const c = comptes.modifierFiche(id, { identifiant: b.identifiant, indicatif: b.indicatif, email: b.email });
      if (avant && avant.identifiant !== c.identifiant) journal(`Compte renommé : ${avant.identifiant} → ${c.identifiant}`);
      audit.noter(nomCompte(utilisateur(req)), req.ip, 'fiche de compte', `${c.identifiant} modifiée`, true);
    }
    // Lien de nouveau mot de passe (24 h, usage unique), que l'administrateur transmet lui-même
    if (b.lienReinit) {
      const r = comptes.creerReinit(id, 24 * 3600000, 'administrateur');
      audit.noter(nomCompte(utilisateur(req)), req.ip, 'lien de mot de passe', `créé pour le compte ${id}`, true);
      return res.json({ ok: true, jeton: r.jeton, expire: r.expire });
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/comptes/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { comptes.supprimer(Number(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// ---- Installation et réglages ---------------------------------------------------------
let listeDepartements = [];
try {
  listeDepartements = lireJson(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson')).features
    .map((f) => ({ code: f.properties.code, nom: f.properties.nom, bbox: emprise(f.geometry) })).sort((a, b) => a.code.localeCompare(b.code));
} catch { /* liste indisponible */ }
app.get('/api/departements', (req, res) => res.json(listeDepartements));

// ---- Fond de carte hors ligne (PMTiles OpenStreetMap) et relief ombré calculé sur place ----------------------
const fondsHorsLigne = require('./fonds').creerFonds({ config, departements: () => listeDepartements, journal });
app.get('/api/fond-hors-ligne', (req, res) => res.set('Cache-Control', 'no-store').json(fondsHorsLigne.etat()));
app.post('/api/fond-hors-ligne', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  if (b.action === 'arreter') { fondsHorsLigne.arreter(); return res.json(fondsHorsLigne.etat()); }
  if (b.action === 'supprimer') { fondsHorsLigne.supprimer(); return res.json(fondsHorsLigne.etat()); }
  if (fondsHorsLigne.etat().enCours.actif) return res.status(409).json({ erreur: 'Téléchargement déjà en cours' });
  fondsHorsLigne.telecharger({ zone: b.zone, maxzoom: b.maxzoom }, utilisateur(req).identifiant).catch(() => { /* erreur gardée dans l'état */ });
  setTimeout(() => res.json(fondsHorsLigne.etat()), 300);
});
app.get('/fonds/fond.pmtiles', (req, res) => {
  const f = fondsHorsLigne.fichier();
  if (!f) return res.status(404).end();
  res.sendFile(f, { acceptRanges: true, cacheControl: true, maxAge: '1d' });
});
// Altitudes pour la vue 3D (format Terrarium) : grille de 250 m, inutile au-delà du zoom 12
const cacheTerrain = new Map();
app.get('/api/relief/terrain/:z/:x/:y.png', (req, res) => {
  const [z, x, y] = ['z', 'x', 'y'].map((k) => Number(req.params[k]));
  if (![z, x, y].every(Number.isInteger) || z < 5 || z > 12) return res.status(404).end();
  const r = Rdep(req); // département étudié (?dep=) ou celui de la carte
  if (!r.pret()) return res.status(404).end();
  const cle = `${r === relief ? '' : String(req.query.dep).toUpperCase()}/${z}/${x}/${y}`;
  let t = cacheTerrain.get(cle);
  if (t === undefined) {
    try { t = r.terrainTuile(z, x, y); } catch { t = null; }
    cacheTerrain.set(cle, t);
    if (cacheTerrain.size > 600) cacheTerrain.delete(cacheTerrain.keys().next().value);
  }
  if (!t) return res.status(404).end();
  res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(t);
});
const cacheOmbrage = new Map();
app.get('/api/relief/ombrage/:z/:x/:y.png', (req, res) => {
  const [z, x, y] = ['z', 'x', 'y'].map((k) => Number(req.params[k]));
  if (![z, x, y].every(Number.isInteger) || z < 6 || z > 14) return res.status(204).end();
  const cle = `${z}/${x}/${y}`;
  let t = cacheOmbrage.get(cle);
  if (t === undefined) {
    try { t = relief.ombrageTuile(z, x, y); } catch { t = null; }
    if (!relief.pret()) return res.status(204).end(); // relief pas encore chargé : ne pas mémoriser de tuile vide
    cacheOmbrage.set(cle, t);
    if (cacheOmbrage.size > 800) cacheOmbrage.delete(cacheOmbrage.keys().next().value);
  }
  if (!t) return res.status(204).end();
  res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(t);
});

function emprise(geom) {
  let s = 90, o = 180, n = -90, e = -180;
  const parcourir = (c) => { if (typeof c[0] === 'number') { o = Math.min(o, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(parcourir); };
  parcourir(geom.coordinates);
  return [+s.toFixed(4), +o.toFixed(4), +n.toFixed(4), +e.toFixed(4)];
}

// Vérifie et complète des réglages envoyés par la carte ; renvoie l'objet à enregistrer
function preparerReglages(b, existants = {}) {
  const r = { ...existants };
  const txt = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  if (txt(b.titre)) r.titre = txt(b.titre, 80);
  if (b.departement) {
    const d = listeDepartements.find((x) => x.code === String(b.departement));
    if (!d) throw new Error('Département inconnu');
    const geom = contourDepartement(d.code);
    if (!geom) throw new Error('Contour du département introuvable');
    const z = emprise(geom);
    r.departement = d;
    r.zone = z;
    r.zoneNom = d.nom;
    r.centre = [+((z[0] + z[2]) / 2).toFixed(4), +((z[1] + z[3]) / 2).toFixed(4)];
    r.zoom = 9;
    if (!txt(b.titre) && !existants.titre) r.titre = `Réseau Meshtastic · ${d.nom}`;
  }
  if (b.mqtt) {
    const m = { ...(existants.mqtt || {}) };
    if (txt(b.mqtt.url) !== undefined) {
      if (b.mqtt.url && !/^(mqtts?|wss?):\/\/[^\s]+$/.test(b.mqtt.url.trim())) throw new Error('Adresse MQTT : mqtt://serveur:1883 attendu');
      m.url = txt(b.mqtt.url);
    }
    if (txt(b.mqtt.utilisateur, 80) !== undefined) m.utilisateur = txt(b.mqtt.utilisateur, 80);
    if (typeof b.mqtt.motDePasse === 'string' && b.mqtt.motDePasse !== '') m.motDePasse = b.mqtt.motDePasse.slice(0, 200);
    if (txt(b.mqtt.racine, 120)) m.racine = txt(b.mqtt.racine, 120);
    if (typeof b.mqtt.sujetsSupplementaires === 'string') m.sujetsSupplementaires = b.mqtt.sujetsSupplementaires.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
    // Brokers supplémentaires : une ligne « adresse » ou « adresse|racine » ; un mot de passe affiché masqué (nom:***@)
    // reprend celui déjà enregistré pour le même compte et le même serveur
    if (typeof b.mqtt.brokers === 'string') {
      const lignes = b.mqtt.brokers.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      if (lignes.length > 5) throw new Error('5 brokers supplémentaires au plus');
      m.brokers = lignes.map((l) => {
        const [u, racine] = l.split('|').map((x) => (x || '').trim());
        if (!/^(mqtts?|wss?):\/\/[^\s]+$/.test(u)) throw new Error(`Broker « ${masquerUrl(u)} » : adresse mqtt://, mqtts://, ws:// ou wss:// attendue`);
        let url = u;
        const masque = u.match(/^([a-z]+:\/\/)([^:@/]*):\*\*\*@(.+)$/i);
        if (masque) {
          const ancien = config.mqtt.brokers.find((x) => { const a = x.url.match(/^([a-z]+:\/\/)([^:@/]*):([^@/]*)@(.+)$/i); return a && a[1] === masque[1] && a[2] === masque[2] && a[4] === masque[3]; });
          if (!ancien) throw new Error(`Broker « ${u} » : mot de passe masqué inconnu, retapez-le en entier`);
          url = ancien.url;
        }
        return { url, racine: racine.replace(/\/+$/, '') };
      });
    }
    r.mqtt = m;
  }
  if (typeof b.canaux === 'string' && b.canaux.trim()) {
    const lignes = b.canaux.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
    for (const l of lignes) {
      const [nom, cle] = l.split('=').map((x) => x && x.trim());
      if (!nom || nom.length > 12) throw new Error(`Canal « ${l} » : nom de 1 à 12 caractères`);
      if (cle && !/^[A-Za-z0-9+/=]{2,64}$/.test(cle)) throw new Error(`Canal « ${nom} » : clé base64 invalide`);
    }
    r.canaux = lignes.join(';');
  }
  if (['fermees', 'validation', 'ouvertes'].includes(b.inscriptions)) r.inscriptions = b.inscriptions;
  if (b.precisionPublique !== undefined && [-1, 2, 3, 4].includes(Number(b.precisionPublique))) r.precisionPublique = Number(b.precisionPublique);
  if (b.retentionJours !== undefined) { const n = Number(b.retentionJours); if (Number.isInteger(n) && n >= 1 && n <= 90) r.retentionJours = n; }
  return r;
}
// Une valeur identique à celle du .env n'est pas gardée dans reglages.json : elle reste lue dans le .env
function sansValeursEnv(r) {
  const e = config.env;
  if (r.titre && r.titre === e.titre) delete r.titre;
  if (r.inscriptions && r.inscriptions === e.inscriptions) delete r.inscriptions;
  if (typeof r.canaux === 'string' && r.canaux.trim().replace(/\r/g, '') === e.canaux.trim()) delete r.canaux;
  if (r.mqtt) {
    for (const k of ['url', 'utilisateur', 'racine']) if (r.mqtt[k] !== undefined && String(r.mqtt[k]) === String(e.mqtt[k] || '')) delete r.mqtt[k];
    if (Array.isArray(r.mqtt.sujetsSupplementaires) && !r.mqtt.sujetsSupplementaires.length) delete r.mqtt.sujetsSupplementaires;
    if (Array.isArray(r.mqtt.brokers) && JSON.stringify(r.mqtt.brokers) === JSON.stringify(e.mqtt.brokers || [])) delete r.mqtt.brokers;
    if (!Object.keys(r.mqtt).length) delete r.mqtt;
  }
  return r;
}
function enregistrerReglagesEtRedemarrer(r, qui) {
  sansValeursEnv(r);
  // Écriture sûre (voir fichiers.js) : l'ancienne version est gardée en reglages.json.bak
  ecrireSur(config.fichierReglages, JSON.stringify(r, null, 1), { mode: 0o600 });
  journal(`Réglages enregistrés par ${qui}, redémarrage du service…`);
  setTimeout(() => process.exit(0), 1200); // Docker relance le conteneur (restart: unless-stopped)
}

// Code d'installation automatique : sans ADMIN_MOT_DE_PASSE, la première installation depuis un autre réseau
// (serveur distant, proxy, Tailscale…) se fait avec un code tiré au hasard et affiché dans le journal du serveur.
let codeInstallationAuto = null;
function preparerCodeInstallation() {
  if (config.admin.motDePasse || !comptes.installationRequise()) return;
  const f = path.join(path.dirname(config.fichierBase), 'code-installation.txt');
  try { codeInstallationAuto = fs.readFileSync(f, 'utf8').trim() || null; } catch { /* premier lancement */ }
  if (!codeInstallationAuto) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    codeInstallationAuto = [...crypto.randomBytes(8)].map((b) => A[b % A.length]).join('').replace(/(.{4})(?=.)/, '$1-');
    try { ecrireSur(f, codeInstallationAuto, { mode: 0o600 }); } catch { /* lecture seule */ }
  }
  journal('==================================================================');
  journal(`Installation : code d'installation ${codeInstallationAuto}`);
  journal('À saisir dans la carte pour créer le compte administrateur (inutile depuis le réseau local).');
  journal('==================================================================');
}
setTimeout(preparerCodeInstallation, 1500);
app.get('/api/installation', (req, res) => res.json({
  requise: comptes.installationRequise(),
  codeRequis: !!config.admin.motDePasse || !ipPrivee(req),
  codeAuto: !config.admin.motDePasse,
  reseauLocal: ipPrivee(req),
  // Configuration actuelle (fichier .env) proposée par défaut, sans secrets
  actuel: {
    titre: config.carte.titre, departement: config.departement.code,
    mqtt: { url: config.mqtt.url, racine: config.mqtt.racine, utilisateur: config.mqtt.utilisateur, motDePasseDefini: !!config.mqtt.motDePasse },
    canaux: config.canaux.map((c) => c.nom),
  },
}));
app.post('/api/installation', (req, res) => {
  if (!comptes.installationRequise()) return res.status(409).json({ erreur: 'L’installation est déjà faite : connectez-vous' });
  if (limiter(req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  const b = req.body || {};
  // Sécurité : code d'installation (ADMIN_MOT_DE_PASSE du .env) s'il existe, sinon réseau local uniquement
  if (config.admin.motDePasse) {
    const a = crypto.createHash('sha256').update(String(b.code || '')).digest(), c = crypto.createHash('sha256').update(config.admin.motDePasse).digest();
    if (!crypto.timingSafeEqual(a, c)) return res.status(403).json({ erreur: 'Code d’installation incorrect' });
  } else if (!ipPrivee(req)) {
    if (!codeInstallationAuto) preparerCodeInstallation();
    const a = crypto.createHash('sha256').update(String(b.code || '').replace(/[\s-]/g, '').toUpperCase()).digest(), c = crypto.createHash('sha256').update(String(codeInstallationAuto || crypto.randomBytes(16).toString('hex')).replace(/-/g, '')).digest();
    if (!crypto.timingSafeEqual(a, c)) return res.status(403).json({ erreur: 'Code d’installation incorrect : il est affiché dans le journal du serveur (docker compose logs carte-live | grep -i installation)' });
  }
  // Seules les valeurs réellement changées dans l'assistant sont enregistrées : celles reprises telles quelles du
  // .env restent lues dans le .env (sinon une modification ultérieure du .env serait ignorée)
  if (b.reglages && typeof b.reglages === 'object') {
    const g = b.reglages, e = config.env;
    if (g.titre && g.titre === e.titre) delete g.titre;
    if (g.departement && String(g.departement) === String(e.departement.code)) delete g.departement;
    if (g.inscriptions && g.inscriptions === e.inscriptions) delete g.inscriptions;
    if (typeof g.canaux === 'string' && g.canaux.trim().replace(/\r/g, '') === e.canaux.trim()) delete g.canaux;
    if (g.mqtt) {
      for (const k of ['url', 'utilisateur', 'racine']) if (g.mqtt[k] !== undefined && String(g.mqtt[k]).trim() === String(e.mqtt[k] || '')) delete g.mqtt[k];
      if (!g.mqtt.motDePasse) delete g.mqtt.motDePasse;
      if (!Object.keys(g.mqtt).length) delete g.mqtt;
    }
  }
  let r;
  try { r = b.reglages && Object.keys(b.reglages).length ? preparerReglages(b.reglages, config.reglages) : null; } catch (e) { return res.status(400).json({ erreur: e.message }); }
  let c;
  try { c = comptes.creer(b.compte || {}, 'admin', 'actif'); } catch (e) { return res.status(400).json({ erreur: e.message }); }
  ouvrirSession(req, res, c);
  journal(`Installation : compte administrateur « ${c.identifiant} » créé`);
  try { fs.unlinkSync(path.join(path.dirname(config.fichierBase), 'code-installation.txt')); } catch { /* aucun */ }
  codeInstallationAuto = null;
  const redemarrage = !!(r && Object.keys(b.reglages || {}).length);
  res.json({ ok: true, redemarrage });
  if (redemarrage) enregistrerReglagesEtRedemarrer(r, c.identifiant);
});

app.get('/api/reglages', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.json({
    titre: config.carte.titre,
    departement: config.departement,
    mqtt: { url: config.mqtt.url, utilisateur: config.mqtt.utilisateur, motDePasseDefini: !!config.mqtt.motDePasse, racine: config.mqtt.racine, sujetsSupplementaires: config.mqtt.sujetsSupplementaires.join(', ') },
    canaux: config.canaux.map((c) => `${c.nom}=${c.cle}`).join('\n'),
    inscriptions: config.inscriptions,
    precisionPublique: config.precisionPublique,
    retentionJours: config.retentionJours,
    // D'où viennent les valeurs : réglées ici (elles remplacent le .env) ou lues dans le .env
    depuisPage: { mqtt: !!(config.reglages.mqtt && Object.keys(config.reglages.mqtt).length), canaux: !!config.reglages.canaux, departement: !!config.reglages.departement, titre: !!config.reglages.titre, inscriptions: !!config.reglages.inscriptions },
    env: { mqtt: { url: masquerUrl(config.env.mqtt.url), utilisateur: config.env.mqtt.utilisateur, racine: config.env.mqtt.racine, motDePasseDefini: config.env.mqtt.motDePasseDefini }, departement: config.env.departement, titre: config.env.titre },
  });
});
app.post('/api/reglages', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  // « Revenir au .env » : retire des réglages de la page les valeurs choisies (mqtt, canaux…)
  if (Array.isArray((req.body || {}).revenirEnv)) {
    const r = { ...config.reglages };
    for (const k of req.body.revenirEnv) if (['mqtt', 'canaux', 'titre', 'inscriptions'].includes(k)) delete r[k];
    res.json({ ok: true, redemarrage: true });
    return enregistrerReglagesEtRedemarrer(r, u.identifiant);
  }
  let r;
  try { r = preparerReglages(req.body || {}, config.reglages); } catch (e) { return res.status(400).json({ erreur: e.message }); }
  res.json({ ok: true, redemarrage: true });
  enregistrerReglagesEtRedemarrer(r, u.identifiant);
});

// ---- Broker MQTT : état, statistiques et test d'une configuration (admin) --------------------
const masquerUrl = (u) => String(u || '').replace(/\/\/[^@/]*@/, '//***@');
app.get('/api/mqtt', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const m = Math.floor(Date.now() / 60000);
  let n10 = 0; for (let k = m - 10; k < m; k++) n10 += statsMqtt.minutes.get(k) || 0;
  const noeuds = new Map(stockage.q.noeuds.all().map((n) => [n.id, n.nom_long || n.nom_court]));
  res.set('Cache-Control', 'no-store').json({
    url: masquerUrl(config.mqtt.url), utilisateur: config.mqtt.utilisateur, motDePasseDefini: !!config.mqtt.motDePasse,
    racine: config.mqtt.racine, sujetsSupplementaires: config.mqtt.sujetsSupplementaires.join(', '), sujets,
    connecte: !!(clientMqtt && clientMqtt.connected), depuis: statsMqtt.depuis, reconnexions: statsMqtt.reconnexions, derniereErreur: statsMqtt.derniereErreur,
    brokersReglage: config.mqtt.brokers.map((b) => b.url.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:***@') + (b.racine ? '|' + b.racine : '')).join('\n'),
    brokersSupplementaires: (typeof brokersSup !== 'undefined' ? brokersSup : []).map((b) => b.etat), doublonsIgnores: compteur.doublons || 0,
    domotique: typeof domotique !== 'undefined' ? domotique.etat() : null,
    udp: typeof udpMt !== 'undefined' ? { ...udpMt.etat(), demande: String(process.env.UDP_MESHTASTIC || 'non').toLowerCase() === 'oui', noeuds: Object.fromEntries([...ipVersNoeud.entries()].map(([ip, n]) => [ip, noeuds.get('!' + n.toString(16).padStart(8, '0')) || '!' + n.toString(16).padStart(8, '0')])) } : null,
    dernierMessage: statsMqtt.dernierMessage, parMinute: +(n10 / 10).toFixed(1), ...compteur,
    passerelles: [...statsMqtt.passerelles.entries()].sort((a, b) => b[1].derniere - a[1].derniere).slice(0, 40).map(([id, e]) => ({ id, nom: noeuds.get(id) || null, ...e })),
    canaux: [...statsMqtt.canaux.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([canal, messages]) => ({ canal, messages })),
  });
});
let testMqttEnCours = false;
app.post('/api/mqtt/tester', async (req, res) => {
  // Pendant l'installation (aucun compte encore) : permis depuis le réseau local, ou avec le code d'installation
  const enInstallation = comptes.installationRequise() && (ipPrivee(req) || (() => {
    const code = String((req.body || {}).code || '');
    const attendu = config.admin.motDePasse || codeInstallationAuto;
    if (!code || !attendu) return false;
    const a = crypto.createHash('sha256').update(config.admin.motDePasse ? code : code.replace(/[\s-]/g, '').toUpperCase()).digest(), c = crypto.createHash('sha256').update(String(attendu)).digest();
    return crypto.timingSafeEqual(a, c);
  })());
  if (!estAdmin(req) && !enInstallation) return res.status(401).json({ erreur: comptes.installationRequise() ? 'Saisissez d’abord le code d’installation' : 'Connexion admin requise' });
  if (enInstallation && limiter(req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  if (testMqttEnCours) return res.status(409).json({ erreur: 'Un test est déjà en cours' });
  const b = req.body || {};
  const url = String(b.url || config.mqtt.url).trim();
  if (!/^(mqtts?|wss?):\/\/[^\s]+$/.test(url)) return res.status(400).json({ erreur: 'Adresse attendue : mqtt://serveur:1883 (ou mqtts://, ws://, wss://)' });
  const utilisateurTest = b.utilisateur != null ? String(b.utilisateur).trim() : config.mqtt.utilisateur;
  // Mot de passe vide = celui déjà enregistré (s'il s'agit du même compte)
  const mdp = b.motDePasse ? String(b.motDePasse) : (utilisateurTest === config.mqtt.utilisateur ? config.mqtt.motDePasse : '');
  const racine = String(b.racine || config.mqtt.racine).trim().replace(/\/+$/, '');
  const duree = Math.min(Math.max(Number(b.duree) || 10, 3), 30) * 1000;
  testMqttEnCours = true;
  const debut = Date.now();
  const r = { url: masquerUrl(url), racine, connecte: false, delaiConnexionMs: null, messages: 0, sujets: {}, erreur: null, abonnement: null };
  const c = mqtt.connect(url, { username: utilisateurTest || undefined, password: mdp || undefined, clientId: 'carte-live-test-' + crypto.randomBytes(3).toString('hex'), reconnectPeriod: 0, connectTimeout: 8000, rejectUnauthorized: !config.mqtt.tlsNonVerifie });
  const fin = () => new Promise((ok) => { try { c.end(true, {}, ok); } catch { ok(); } });
  try {
    await new Promise((ok, ko) => {
      c.once('connect', () => { r.connecte = true; r.delaiConnexionMs = Date.now() - debut; ok(); });
      c.once('error', (e) => ko(e));
      c.once('close', () => { if (!r.connecte) ko(new Error('connexion refusée ou fermée par le broker')); });
      setTimeout(() => ko(new Error('pas de réponse du broker en 8 s')), 8500);
    });
    await new Promise((ok) => c.subscribe(racine + '/#', { qos: 0 }, (e, g) => { r.abonnement = e ? 'refusé : ' + e.message : g && g[0] && g[0].qos === 128 ? 'refusé par le broker (droits ACL)' : 'accepté'; ok(); }));
    c.on('message', (t) => { r.messages++; const k = t.split('/').slice(0, 7).join('/'); r.sujets[k] = (r.sujets[k] || 0) + 1; });
    await new Promise((ok) => setTimeout(ok, duree));
  } catch (e) {
    r.erreur = /Not authorized|Bad username/i.test(e.message) ? 'identifiant ou mot de passe refusé par le broker' : e.message;
  } finally { await fin(); testMqttEnCours = false; }
  r.dureeEcouteS = Math.round(duree / 1000);
  r.sujets = Object.entries(r.sujets).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([sujet, n]) => ({ sujet, n }));
  res.json(r);
});

// ---- MeshCore ---------------------------------------------------------------------------------
const exigerMc = (res) => { if (config.meshcore.actif) return true; res.status(404).json({ erreur: 'MeshCore désactivé (MESHCORE=non)' }); return false; };
app.get('/api/mc/noeuds', (req, res) => {
  if (!exigerMc(res)) return;
  const membre = estMembre(req), maintenant = Date.now();
  // ?depuis=heure : seulement les nœuds modifiés depuis (le flux national compte des milliers de nœuds)
  const depuis = Number(req.query.depuis) || 0;
  res.set('Cache-Control', 'private, no-cache').set('Vary', 'Cookie').set('X-Heure', String(maintenant)); // repère pris sur l'heure serveur
  if (depuis) return res.json({ heure: maintenant, noeuds: reseauMc.q.noeudsDepuis.all(Math.min(depuis, maintenant) - 5000).map((n) => reseauMc.vueNoeud(n, membre, maintenant)) });
  res.json(reseauMc.q.noeuds.all().map((n) => reseauMc.vueNoeud(n, membre, maintenant)));
});
app.get('/api/mc/noeuds/:cle', (req, res) => {
  if (!exigerMc(res)) return;
  const d = reseauMc.detailNoeud(String(req.params.cle).slice(0, 64), estMembre(req));
  if (!d) return res.status(404).json({ erreur: 'Nœud MeshCore inconnu' });
  d.telemetrie = reseauMc.telemetrie(d.noeud.cle, Date.now() - config.retentionJours * 86400000);
  const lu = estAdmin(req) ? adminMc.lecture(d.noeud.cle) : null;
  if (lu && lu.chemin) d.chemin = lu.chemin;
  res.json(d);
});
app.get('/api/mc/liens', (req, res) => {
  if (!exigerMc(res)) return;
  const heures = Math.min(Math.max(Number(req.query.heures) || 24, 0.25), config.retentionJours * 24);
  const depuis = Number(req.query.depuis) || 0;
  if (depuis) return res.json({ heure: Date.now(), liens: reseauMc.liens(heures * 3600000, depuis - 5000) });
  res.json(reseauMc.liens(heures * 3600000));
});
app.get('/api/mc/paquets', (req, res) => {
  if (!exigerMc(res)) return;
  const type = /^[A-Z_]{2,12}$/.test(String(req.query.type || '')) ? req.query.type : null;
  res.json(reseauMc.paquets(Math.min(Number(req.query.limite) || 200, 1000), type, estMembre(req)));
});
app.get('/api/mc/paquets/:id', (req, res) => {
  if (!exigerMc(res)) return;
  const d = reseauMc.detailPaquet(req.params.id, estMembre(req));
  if (!d) return res.status(404).json({ erreur: 'Paquet inconnu (plus de ' + config.retentionJours + ' jours ?)' });
  res.json(d);
});
app.get('/api/mc/analyse', (req, res) => {
  if (!exigerMc(res)) return;
  const heures = Math.min(Math.max(Number(req.query.heures) || 24, 1), config.retentionJours * 24);
  res.json(reseauMc.analyse(heures, require('./analyse').tempsEmission, bboxZone(req.query.zone)));
});
// QR codes au format de l'appli MeshCore : contact (public) ou canal du companion (admin : contient le secret)
app.get('/api/mc/qr', async (req, res) => {
  if (!exigerMc(res)) return;
  let url, titre;
  if (req.query.canal != null) {
    if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
    const c = companion.secretsCanaux().find((x) => x.nom === String(req.query.canal));
    if (!c) return res.status(404).json({ erreur: 'Canal inconnu du companion' });
    url = `meshcore://channel/add?name=${encodeURIComponent(c.nom)}&secret=${c.secret}`; titre = 'Canal ' + c.nom;
  } else {
    const n = reseauMc.q.noeud.get(String(req.query.cle || '').toUpperCase());
    if (!n) return res.status(404).json({ erreur: 'Nœud inconnu' });
    const type = { companion: 1, repeteur: 2, salon: 3, capteur: 4 }[n.role] || 1;
    url = `meshcore://contact/add?name=${encodeURIComponent(n.nom || n.cle.slice(0, 8))}&public_key=${n.cle.toLowerCase()}&type=${type}`; titre = n.nom || n.cle.slice(0, 8);
  }
  const svg = await require('qrcode').toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#0b1d26', light: '#ffffff' } });
  res.set('Cache-Control', 'no-store').json({ url, svg, titre });
});
app.get('/api/mc/messages', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const l = reseauMc.messages(Math.min(Number(req.query.limite) || 300, 2000));
  // Démonstration : canal Public et canaux « # » (ouverts à tous) seulement, jamais les messages directs
  res.json(req.demoLecture ? l.filter((m) => m.genre === 'canal' && (/^public$/i.test(m.canal || '') || /^#/.test(m.canal || ''))) : l);
});
let alertesMc = [];
function etatMc(admin) {
  const e = { stats: reseauMc.statistiques(), alertes: alertesMc };
  const c = companion.etat();
  e.companion = { connecte: c.connecte, nom: c.nom, cle: c.cle, radio: c.radio, navigateur: c.navigateur, paquets: c.paquets, depuis: c.depuis, pret: c.pret, canaux: companion.canaux() };
  if (admin) {
    e.companion = { ...c, canaux: companion.canaux() };
    e.republication = publicateurMc.etat();
    e.reglages = { iata: config.meshcore.iata, racine: config.meshcore.racine, republier: config.meshcore.republier, canaux: config.meshcore.canaux.join('\n'), perimetre: config.meshcore.perimetre, liensOctetsMin: config.meshcore.liensOctetsMin, iataVoisins: config.meshcore.iataVoisins.join(', '), supervisionHeures: config.meshcore.supervisionHeures, plafondReleveMin: config.meshcore.plafondReleveMin, plafondLectureMin: config.meshcore.plafondLectureMin, horsPerimetre: compteurMc.horsPerimetre || 0 };
    e.agents = agents.liste();
    e.ecoutes = ecoutes.liste().meshcore;
    e.corescope = { ...corescope.etat(), texte: ecrireSourcesCs(config.meshcore.corescope.sources), connues: INSTANCES_CS };
  }
  // Crédit public : d'où viennent les données MeshCore affichées
  e.observatoires = config.meshcore.corescope.sources.map((x) => { try { return new URL(x.url).host; } catch { return x.url; } });
  return e;
}
app.get('/api/mc/etat', (req, res) => { if (!exigerMc(res)) return; res.set('Cache-Control', 'no-store').json(etatMc(estAdmin(req))); });
app.post('/api/mc/companion', (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  const b = req.body || {};
  if (b.type === 'agent') {
    if (!agents.estAgent(String(b.hote || ''))) return res.status(400).json({ erreur: 'Agent inconnu' });
    const c = { type: 'agent', hote: String(b.hote) };
    if (ecoutes.estCompanion(c)) ecoutes.retirerCompanion(ecoutes.cleCompanion(c));
    companion.connecterA(c);
  } else {
    const port = portValide(b.port ?? 5000);
    if (!hoteValide(b.hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
    const c = { type: 'tcp', hote: b.hote, port };
    if (ecoutes.estCompanion(c)) ecoutes.retirerCompanion(ecoutes.cleCompanion(c));
    companion.connecterA(c);
  }
  res.json({ ok: true });
});
// ---- Chemin vers un nœud MeshCore (contact du companion) : voir, réinitialiser, forcer ----
const cleMc = (x) => { const c = String(x || '').toUpperCase(); if (!/^[0-9A-F]{64}$/.test(c)) throw new Error('clé invalide'); return c; };
app.get('/api/mc/noeuds/:cle/chemin', async (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  try {
    const cle = cleMc(req.params.cle);
    const c = await companion.contact(cle);
    if (!c) return res.json({ contact: false });
    const relais = (c.chemin || []).map((p) => { const l = reseauMc.resoudreChemin([p], null, null)[0]; return { id: p, nom: l ? l.nom : null, cle: l ? l.cle : null }; });
    res.json({ contact: true, inondation: c.chemin == null, chemin: relais, tailleSaut: c.tailleSaut, nom: c.nom });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/mc/noeuds/:cle/chemin', async (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Réservé aux gestionnaires et administrateurs' });
  try {
    const cle = cleMc(req.params.cle), b = req.body || {};
    let r;
    if (b.action === 'reinitialiser') { await companion.reinitialiserChemin(cle); r = { ok: true }; }
    else if (b.action === 'forcer') r = await companion.forcerChemin(cle, String(b.chemin || '').split(/[\s,;>→-]+/).filter(Boolean));
    else return res.status(400).json({ erreur: 'action inconnue' });
    audit.noter(nomCompte(utilisateur(req)), req.ip, b.action === 'forcer' ? 'MeshCore : chemin forcé' : 'MeshCore : chemin réinitialisé', `${cle.slice(0, 8)}${b.action === 'forcer' ? ' · ' + (r.chemin.join(' → ') || 'direct') : ''}`, true);
    res.json(r);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// ---- Suppression d'un nœud Meshtastic qui n'existe plus (admin) : fiche, positions, télémétrie, liaisons ----
app.delete('/api/noeuds/:num', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const num = Number(req.params.num) >>> 0;
  if (!num) return res.status(400).json({ erreur: 'numéro invalide' });
  const n = stockage.q.noeud.get(num), db = stockage.db;
  const nb = db.transaction(() => {
    const k = db.prepare('DELETE FROM noeuds WHERE num = ?').run(num).changes;
    db.prepare('DELETE FROM positions WHERE num = ?').run(num);
    db.prepare('DELETE FROM telemetrie WHERE num = ?').run(num);
    db.prepare('DELETE FROM liens WHERE a = ? OR b = ?').run(num, num);
    return k;
  })();
  const nom = (n && (n.nom_long || n.nom_court)) || '!' + num.toString(16).padStart(8, '0');
  audit.noter(nomCompte(utilisateur(req)), req.ip, 'Meshtastic : nœud supprimé', `${nom} (!${num.toString(16).padStart(8, '0')})`, true);
  journal(`nœud « ${nom} » supprimé par ${nomCompte(utilisateur(req))}`);
  diffuser({ genre: 'noeud-supprime', num });
  res.json({ ok: nb > 0 });
});
// ---- Suppression d'un nœud MeshCore qui n'existe plus (admin) : carte, base et contacts du companion ----
app.delete('/api/mc/noeuds/:cle', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  let cle;
  try { cle = cleMc(req.params.cle); } catch (e) { return res.status(400).json({ erreur: e.message }); }
  const n = reseauMc.q.noeud.get(cle);
  const ok = reseauMc.supprimerNoeud(cle);
  let contact = 'absent';
  try { if (companion.etat().pret) { await companion.supprimerContact(cle); contact = 'retiré'; } else contact = 'companion non relié'; } catch (e) { contact = e.message; }
  for (const c of ecoutes.companions()) { try { if (c.etat().pret) await c.supprimerContact(cle); } catch { /* ignoré */ } }
  audit.noter(nomCompte(utilisateur(req)), req.ip, 'MeshCore : nœud supprimé', `${(n && n.nom) || cle.slice(0, 8)} (${cle.slice(0, 12)}…) · contact du companion : ${contact}`, true);
  journal(`[MeshCore] nœud « ${(n && n.nom) || cle.slice(0, 8)} » supprimé par ${nomCompte(utilisateur(req))}`);
  diffuser({ genre: 'mc-supprime', cle });
  diffuser({ genre: 'mc-noeuds' });
  res.json({ ok, contact });
});
app.post('/api/mc/companion/relancer', (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  try { companion.relancer(); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/mc/companion', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  companion.deconnecter();
  res.json({ ok: true });
});
// ---- Outils du companion (firmware MeshCore récent) ---------------------------------------------------
// Découverte des répéteurs entendus en direct : liaison mesurée dans les deux sens, sans mot de passe
let decouverteMc = null; // { heure, liste }
// Nom et infos des propriétaires (requête anonyme, demandée avec les régions aux répéteurs entendus en direct)
const fProprietairesMc = path.join(path.dirname(config.fichierBase), 'meshcore-proprietaires.json');
let proprietairesMc = {};
try { proprietairesMc = lireJson(fProprietairesMc) || {}; } catch { /* aucun */ }
const avecProprietaires = (d) => (d && d.liste ? { ...d, liste: d.liste.map((v) => (proprietairesMc[v.cle] ? { ...v, proprietaire: proprietairesMc[v.cle] } : v)) } : d);
async function decouvrirMc() {
  const moi = companion.etat();
  const liste = await companion.decouvrirVoisins(15000);
  const n0 = reseauMc.q.noeud.get(moi.cle);
  const res = liste.map((v) => {
    const n = v.complete ? reseauMc.q.noeud.get(v.cle) : null;
    if (n && moi.cle) {
      reseauMc.lierMesure(moi.cle, v.cle, 'trace', v.snrAller); // le répéteur entend le companion
      reseauMc.lierMesure(v.cle, moi.cle, 'trace', v.snrRetour); // le companion entend le répéteur
    }
    const lat = n0 && n0.lat != null ? n0.lat : moi.lat, lon = n0 && n0.lon != null ? n0.lon : moi.lon;
    const d = n && n.lat != null && lat != null ? Math.round(Math.hypot((n.lat - lat) * 111.2, (n.lon - lon) * 111.2 * Math.cos((lat * Math.PI) / 180)) * 10) / 10 : null;
    return { ...v, nom: n ? n.nom : null, lat: n ? n.lat : null, lon: n ? n.lon : null, distanceKm: d };
  });
  decouverteMc = { heure: Date.now(), companion: moi.nom, liste: res };
  journal(`[MeshCore] découverte : ${res.length} nœud(s) entendu(s) en direct par le companion`);
  planifierEtatMc(); diffuser({ genre: 'mc-noeuds' });
  return decouverteMc;
}
app.post('/api/mc/companion/decouvrir', async (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  try {
    const d = await decouvrirMc();
    res.json(avecProprietaires(d));
    if (!interrogationMc.enCours) interrogerRegionsMc().catch(() => {}); // régions et propriétaires, en arrière-plan
  } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.get('/api/mc/companion/decouverte', (req, res) => { if (!exigerAdmin(req, res)) return; res.json(avecProprietaires(decouverteMc) || { liste: null }); });
// Statistiques radio du companion (bruit, temps d'antenne) : relevées toutes les 15 min pour la courbe
async function statsCompanionMc() {
  const s = await companion.statistiques();
  const moi = companion.etat();
  if (moi.cle && reseauMc.q.noeud.get(moi.cle)) reseauMc.noterEtat(moi.cle, { batterieMv: s.batterieMv, bruitDbm: s.bruitDbm, occupationEmissionPct: s.occupationEmissionPct, recus: s.recus, emis: s.emis, allumeS: s.allumeS, dernierSnr: s.dernierSnr, fileEmission: s.file });
  return s;
}
app.get('/api/mc/companion/stats', async (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  try {
    const s = await statsCompanionMc();
    const moi = companion.etat();
    const histo = moi.cle ? reseauMc.telemetrie(moi.cle, Date.now() - 7 * 86400000).map((t) => ({ heure: t.heure, bruit: t.bruit, batterieMv: t.batterie_mv, emissionPct: t.emission_pct })) : [];
    res.json({ ...s, historique: histo });
  } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.get('/api/mc/companion/telemetrie', async (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  try { res.json({ mesures: await companion.telemetrie(null) }); } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.get('/api/mc/companion/zone', async (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  try { res.json({ zone: await companion.lireZone() }); } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.post('/api/mc/companion/zone', async (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  try { const z = await companion.definirZone((req.body || {}).zone); journal(`[MeshCore] région par défaut du companion : ${z || 'aucune'} (${utilisateur(req).identifiant})`); res.json({ zone: z }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/mc/companion/cli', async (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  const commande = String((req.body || {}).commande || '').trim();
  if (/^(erase|factory|set prv\.key|get prv\.key)/i.test(commande)) return res.status(400).json({ erreur: 'commande refusée depuis la carte' });
  try {
    const r = await companion.cliLocal(commande);
    journal(`[MeshCore] commande sur le companion par ${utilisateur(req).identifiant} : ${commande.replace(/^(set (wifi\.pwd|pin))\s+.*/i, '$1 ••••')}`);
    res.json({ reponse: /^get wifi\.pwd/i.test(commande) ? '(masqué)' : r });
  } catch (e) { res.status(409).json({ erreur: e.message }); }
});
// Relevés automatiques : statistiques toutes les 15 min, découverte et régions des répéteurs une fois par jour
setInterval(() => { if (config.meshcore.actif && companion.etat().pret) statsCompanionMc().catch(() => {}); }, 15 * 60000);
let derniereDecouverteMc = 0;
setInterval(() => {
  if (!config.meshcore.actif || !companion.etat().pret || Date.now() - derniereDecouverteMc < 24 * 3600000) return;
  derniereDecouverteMc = Date.now();
  decouvrirMc().then(() => interrogerRegionsMc().catch(() => {})).catch((e) => journal('[MeshCore] découverte automatique :', e.message));
}, 5 * 60000);

// ---- Audit MeshCore : régions déclarées / relayées par les répéteurs, collisions d'identifiants courts ----
const auditMc = require('./meshcore/audit').creerAuditMc({ db: stockage.db, config, reseauMc, journal });
let interrogationMc = { enCours: false, faits: 0, total: 0, resultats: [], heure: null };
// Demande leurs régions aux répéteurs entendus en direct par le companion (requête anonyme, un à la fois)
async function interrogerRegionsMc(cles) {
  if (interrogationMc.enCours) throw new Error('interrogation déjà en cours');
  if (!companion.etat().pret) throw new Error('aucun companion prêt');
  let liste = cles && cles.length ? cles : ((decouverteMc && decouverteMc.liste) || []).filter((v) => v.cle && v.complete).map((v) => v.cle);
  if (!liste.length) { await decouvrirMc(); liste = ((decouverteMc && decouverteMc.liste) || []).filter((v) => v.cle && v.complete).map((v) => v.cle); }
  liste = liste.filter((k) => { const n = reseauMc.q.noeud.get(k); return n && ['repeteur', 'salon'].includes(n.role); }).slice(0, 30);
  interrogationMc = { enCours: true, faits: 0, total: liste.length, resultats: [], heure: Date.now() };
  for (const k of liste) {
    const n = reseauMc.q.noeud.get(k);
    try {
      const r = await companion.regionsDeclarees({ cle: n.cle, nom: n.nom, role: n.role, lat: n.lat, lon: n.lon, horodatageAnnonce: n.horodatage_annonce });
      auditMc.noterDeclarees(k, r);
      interrogationMc.resultats.push({ cle: k, nom: n.nom, ok: true, ...r });
      await new Promise((ok) => setTimeout(ok, 2000));
      // Propriétaire : redemandé au plus une fois par semaine (chaque demande est une requête anonyme sur le réseau)
      if (!(proprietairesMc[k] && Date.now() - (proprietairesMc[k].heure || 0) < 7 * 86400000)) try {
        const pr = await companion.proprietaire({ cle: n.cle, nom: n.nom, role: n.role, lat: n.lat, lon: n.lon, horodatageAnnonce: n.horodatage_annonce });
        proprietairesMc[k] = { nom: pr.nom, infos: pr.infos, heure: Date.now() };
        ecrireSur(fProprietairesMc, JSON.stringify(proprietairesMc));
      } catch { /* firmware ancien ou pas de réponse : sans gravité */ }
    } catch (e) { interrogationMc.resultats.push({ cle: k, nom: n.nom, ok: false, erreur: e.message }); }
    interrogationMc.faits++;
    await new Promise((ok) => setTimeout(ok, 3000)); // laisser respirer le canal
  }
  interrogationMc.enCours = false;
  journal(`[MeshCore] régions demandées à ${liste.length} répéteur(s) : ${interrogationMc.resultats.filter((x) => x.ok).length} réponse(s)`);
  return interrogationMc;
}
app.get('/api/mc/audit/regions', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const jours = Math.min(Math.max(Number(req.query.jours) || 2, 1), 14);
  try { res.set('Cache-Control', 'no-store').json({ ...auditMc.auditRegions({ jours, bbox: bboxZone(req.query.zone || '1') }), interrogation: interrogationMc }); } catch (e) { res.status(500).json({ erreur: e.message }); }
});
app.post('/api/mc/audit/interroger', (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  if (interrogationMc.enCours) return res.status(409).json({ erreur: 'interrogation déjà en cours' });
  if (!companion.etat().pret) return res.status(409).json({ erreur: 'aucun companion prêt : reliez un companion' });
  const cles = Array.isArray((req.body || {}).cles) ? req.body.cles.map((x) => String(x).toUpperCase()).filter((x) => /^[0-9A-F]{64}$/.test(x)) : null;
  interrogerRegionsMc(cles).catch((e) => { interrogationMc.enCours = false; journal('[MeshCore] interrogation des régions :', e.message); });
  res.json({ ok: true });
});
app.get('/api/mc/audit/collisions', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  try { res.set('Cache-Control', 'no-store').json(auditMc.collisions({ bbox: bboxZone(req.query.zone || '1') })); } catch (e) { res.status(500).json({ erreur: e.message }); }
});

app.post('/api/mc/companion/annonce', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  try { await companion.annoncer(!!(req.body || {}).inondation); res.json({ ok: true }); } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.post('/api/mc/companion/contacts', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  try { await companion.rechargerContacts(); res.json({ ok: true }); } catch (e) { res.status(409).json({ erreur: e.message }); }
});
// Envoi d'un message (canal du companion ou message direct) — admin
app.post('/api/mc/messages', async (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  const texte = String(b.texte || '').trim();
  if (!texte) return res.status(400).json({ erreur: 'Message vide' });
  if (Buffer.byteLength(texte) > 140) return res.status(400).json({ erreur: 'Message trop long (140 octets au plus)' });
  const c = companion.etat();
  try {
    if (b.vers) {
      const n = reseauMc.q.noeud.get(String(b.vers).toUpperCase());
      if (!n) return res.status(404).json({ erreur: 'Destinataire inconnu' });
      const r = await companion.envoyerDirect({ cle: n.cle, nom: n.nom, role: n.role, lat: n.lat, lon: n.lon, horodatageAnnonce: n.horodatage_annonce }, texte);
      // Étiquette de région : celle d'envoi du companion, seulement si le message part en inondation (sinon : chemin direct)
      const regionEnvoi = c.zoneDefaut == null ? null : c.zoneDefaut || '-';
      const id = reseauMc.noterMessage({ sens: 'envoye', genre: 'direct', de: c.cle, nomDe: c.nom, vers: n.cle, nomVers: n.nom, texte, statut: 'envoye', ack: r.ack, auteur: u.identifiant, region: r.inondation ? regionEnvoi : null });
      setTimeout(() => { const m = reseauMc.messages(200).find((x) => x.id === id); if (m && m.statut === 'envoye') { reseauMc.statutMessage(id, 'sans_accuse'); diffuser({ genre: 'mc-message', confirmation: true }); } }, Math.max(r.delaiMs * 2, 30000));
      res.json({ ok: true, id, inondation: r.inondation });
    } else {
      const index = Number(b.canal);
      const canal = companion.canaux().find((x) => x.index === index);
      if (!canal) return res.status(400).json({ erreur: 'Canal inconnu du companion' });
      await companion.envoyerCanal(index, texte);
      const id = reseauMc.noterMessage({ sens: 'envoye', genre: 'canal', canal: canal.nom, indexCanal: index, de: c.cle, nomDe: c.nom, texte, statut: 'envoye', auteur: u.identifiant, region: c.zoneDefaut == null ? null : c.zoneDefaut || '-' });
      res.json({ ok: true, id });
    }
    diffuser({ genre: 'mc-message', confirmation: true });
  } catch (e) { res.status(409).json({ erreur: e.message }); }
});

// ---- Administration des répéteurs MeshCore (admin) ----
const tacheMcDuSecteur = (req, t) => !!t && peutGererTous(req, t.cles || []);
app.get('/api/mc/admin', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json({ secteur: estAdmin(req) ? null : utilisateur(req).noeuds, supervision: adminMc.supervision(), params: adminMc.PARAMS, elements: adminMc.ELEMENTS, elementsDefaut: adminMc.ELEMENTS_DEFAUT, taches: adminMc.taches().filter((t) => tacheMcDuSecteur(req, t)), memorises: adminMc.memorises().filter((k) => peutGerer(req, k)), lectures: adminMc.lectures(), companion: { connecte: companion.etat().connecte, pret: companion.etat().pret } });
});
app.get('/api/mc/admin/lecture/:cle', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!peutGerer(req, req.params.cle)) return refuserSecteur(res);
  res.set('Cache-Control', 'no-store').json({ lecture: adminMc.lecture(req.params.cle), memorise: adminMc.memorises().includes(String(req.params.cle).toUpperCase()) });
});
app.post('/api/mc/admin/taches', (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  if (!peutGererTous(req, b.cles || [])) return refuserSecteur(res);
  try { res.json(adminMc.lancer(String(b.type), b.cles, b.params || {}, u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/mc/admin/taches/:id', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const t = adminMc.tache(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tâche inconnue' });
  if (!tacheMcDuSecteur(req, t)) return refuserSecteur(res);
  res.set('Cache-Control', 'no-store').json(t);
});
app.post('/api/mc/admin/taches/:id/arreter', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  if (!tacheMcDuSecteur(req, adminMc.tache(req.params.id))) return refuserSecteur(res);
  try { adminMc.arreter(req.params.id); res.json({ ok: true }); } catch (e) { res.status(404).json({ erreur: e.message }); }
});
app.get('/api/mc/admin/modeles', (req, res) => { if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); res.json(adminMc.modeles()); });
app.post('/api/mc/admin/modeles', (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(adminMc.enregistrerModele(req.body || {}, u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/mc/admin/modeles/:id', (req, res) => { if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); adminMc.supprimerModele(req.params.id); res.json({ ok: true }); });
app.post('/api/mc/admin/mot-de-passe', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  if (!/^[0-9A-F]{64}$/i.test(String(b.cle || ''))) return res.status(400).json({ erreur: 'Clé invalide' });
  if (!peutGerer(req, b.cle)) return refuserSecteur(res);
  if (b.motDePasse == null) adminMc.oublierMotDePasse(b.cle); else adminMc.memoriserMotDePasse(b.cle, String(b.motDePasse).slice(0, 15));
  res.json({ ok: true });
});

// ---- Réglages avancés : variables du fichier .env réglables depuis la carte ----
app.get('/api/reglages/variables', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json({ variables: variables.vue() });
});
// Corps : { variables: { NOM: valeur | null } } ; null = revenir à la valeur du .env ; secret vide = inchangé
app.post('/api/reglages/variables', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = (req.body || {}).variables;
  if (!b || typeof b !== 'object') return res.status(400).json({ erreur: 'Aucun réglage' });
  const v = { ...((config.reglages || {}).variables || {}) };
  try {
    for (const [nom, val] of Object.entries(b)) {
      const def = variables.PAR_NOM.get(nom);
      if (!def) throw new Error(`Réglage inconnu : ${nom}`);
      if (val === null) { delete v[nom]; continue; }
      if (def.type === 'secret' && String(val) === '') continue;
      v[nom] = variables.valider(nom, val);
    }
  } catch (e) { return res.status(400).json({ erreur: e.message }); }
  const r = { ...config.reglages };
  if (Object.keys(v).length) r.variables = v; else delete r.variables;
  res.json({ ok: true, redemarrage: true });
  enregistrerReglagesEtRedemarrer(r, u.identifiant);
});

app.post('/api/mc/reglages', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {}, m = { ...((config.reglages || {}).meshcore || {}) };
  if (b.iata !== undefined) { if (!/^[A-Z0-9]{2,8}$/i.test(String(b.iata))) return res.status(400).json({ erreur: 'Code de zone : 2 à 8 lettres ou chiffres (ex. LPY)' }); m.iata = String(b.iata).toUpperCase(); }
  if (b.racine !== undefined) { if (!/^[A-Za-z0-9_\-/]{1,60}$/.test(String(b.racine))) return res.status(400).json({ erreur: 'Racine invalide' }); m.racine = String(b.racine); }
  if (typeof b.republier === 'boolean') m.republier = b.republier;
  if (typeof b.actif === 'boolean') m.actif = b.actif;
  if (['departement', 'voisins', 'national'].includes(b.perimetre)) m.perimetre = b.perimetre;
  if ([1, 2, 3].includes(Number(b.liensOctetsMin))) m.liensOctetsMin = Number(b.liensOctetsMin);
  if (typeof b.iataVoisins === 'string') m.iataVoisins = b.iataVoisins.split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,8}$/.test(x)).slice(0, 20);
  if (b.supervisionHeures !== undefined) { const h = Number(b.supervisionHeures); if (!Number.isInteger(h) || h < 0 || h > 48) return res.status(400).json({ erreur: 'Supervision : 0 à 48 heures' }); m.supervisionHeures = h; }
  if (b.plafondReleveMin !== undefined) { const n = Number(b.plafondReleveMin); if (!Number.isInteger(n) || n < 1 || n > 30) return res.status(400).json({ erreur: 'Délai maximal d’un relevé : 1 à 30 minutes' }); m.plafondReleveMin = n; }
  if (b.plafondLectureMin !== undefined) { const n = Number(b.plafondLectureMin); if (!Number.isInteger(n) || n < 5 || n > 240) return res.status(400).json({ erreur: 'Délai maximal d’une lecture complète : 5 à 240 minutes' }); m.plafondLectureMin = n; }
  if (typeof b.corescope === 'string') {
    const l = require('./meshcore/corescope').lireSources(b.corescope);
    const lignes = b.corescope.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
    if (l.length !== lignes.length) return res.status(400).json({ erreur: 'Observatoire CoreScope : une adresse https://… par ligne, éventuellement suivie de =CODE,CODE (5 au plus)' });
    m.corescope = { ...(m.corescope || {}), sources: l };
  }
  if (b.corescopeMax !== undefined) { const n = Number(b.corescopeMax); if (!Number.isInteger(n) || n < 5 || n > 600) return res.status(400).json({ erreur: 'Plafond CoreScope : 5 à 600 paquets par minute' }); m.corescope = { ...(m.corescope || {}), maxParMinute: n }; }
  if (b.corescopeIntervalle !== undefined) { const n = Number(b.corescopeIntervalle); if (!Number.isInteger(n) || n < 10 || n > 300) return res.status(400).json({ erreur: 'Intervalle CoreScope : 10 à 300 secondes' }); m.corescope = { ...(m.corescope || {}), intervalleS: n }; }
  if (typeof b.canaux === 'string') {
    const l = b.canaux.split(/[;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    const ok = preparerCanauxMc(l);
    if (ok.length !== l.length) return res.status(400).json({ erreur: 'Canal invalide : « Public », « #nom » ou « nom=secret » (32 caractères hexadécimaux)' });
    m.canaux = l;
  }
  res.json({ ok: true, redemarrage: true });
  enregistrerReglagesEtRedemarrer({ ...config.reglages, meshcore: m }, u.identifiant);
});

// Essai d'un observatoire CoreScope avant de l'enregistrer (débit réel, nombre de nœuds, codes de zone vus)
app.post('/api/mc/corescope/tester', async (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  const regions = String(b.regions || '').split(/[,\s]+/).filter(Boolean);
  try { res.json(await testerCoreScope(String(b.url || ''), regions)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});

app.get('/sante', (req, res) => res.json({ ok: true, mqtt: clientMqtt && clientMqtt.connected }));
// Santé de la carte elle-même (processeur, mémoire, réactivité, disque, base, MQTT)
let recusAvant = 0;
const santeCarte = creerSanteCarte({
  dossier: path.dirname(config.fichierBase), fichierBase: config.fichierBase, version: VERSION,
  sources: {
    mqtt: () => { const r = compteur.recus - recusAvant; recusAvant = compteur.recus; return { mqttParMinute: r }; },
    mqttEtat: () => ({ connecte: !!(clientMqtt && clientMqtt.connected), depuis: statsMqtt.depuis, reconnexions: statsMqtt.reconnexions, dernierMessage: statsMqtt.dernierMessage, erreurs: compteur.erreurs, horsPerimetreMc: compteurMc.horsPerimetre || 0 }),
    base: () => historique.tailleBase(),
    clients: () => wss.clients.size,
  },
});
app.get('/api/sante-carte', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  res.set('Cache-Control', 'no-store').json(santeCarte.etat());
});

const serveur = http.createServer(app);

// ---- WebSocket temps réel -------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 }); // les pages ne font qu'écouter : rien de gros à recevoir
// Module branché sur le PC de l'utilisateur (Web Serial / Web Bluetooth) : la page relaie le flux Meshtastic
const wssModule = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
// Modules reliés par une page : un « ping » toutes les 25 s garde la liaison ouverte à travers les proxys
// inversés (nginx, Traefik, Cloudflare coupent souvent une WebSocket silencieuse au bout de 60 à 100 s)
setInterval(() => { for (const ws of wssModule.clients) { try { ws.ping(); } catch { /* fermée */ } } }, 25000);
// Passerelle d'un membre : un compte validé relie sa radio depuis son navigateur. Elle n'est jamais module principal
// (pas d'envoi, pas d'administration des autres nœuds) : elle ajoute ce qu'elle entend à la carte, comme une passerelle
// MQTT. Débit limité, deux radios par compte au plus, coupure par un administrateur (refusée ensuite pendant 12 h).
const passerelleMembresActive = () => String(process.env.PASSERELLE_MEMBRES || 'oui').toLowerCase() !== 'non';
const passerellesNav = new Map(); // hôte virtuel → { compteId, compte, admin, protocole, role, source, depuis }
const passerellesBloquees = new Map(); // compte → fin du blocage
const PASSERELLES_PAR_COMPTE = 2, PASSERELLES_MAX = 30;
function refusPasserelle(req) {
  const u = utilisateur(req);
  if (!u) return 'connexion requise';
  if (u.role === 'admin') return null;
  if (!passerelleMembresActive()) return 'passerelles des membres désactivées sur cette carte';
  const b = passerellesBloquees.get(u.id);
  if (b && b > Date.now()) return 'passerelle coupée par un administrateur';
  const miennes = [...passerellesNav.values()].filter((x) => x.compteId === u.id).length;
  if (miennes >= PASSERELLES_PAR_COMPTE) return `${PASSERELLES_PAR_COMPTE} radios au plus par compte`;
  if ([...passerellesNav.values()].filter((x) => !x.admin).length >= PASSERELLES_MAX) return 'trop de passerelles reliées en ce moment';
  return null;
}
serveur.on('upgrade', (req, socket, tete) => {
  const chemin = (req.url || '').split('?')[0];
  const refus = (raison) => { socket.write(`HTTP/1.1 403 Forbidden\r\nX-Refus: ${encodeURIComponent(raison || 'refusé')}\r\n\r\n`); socket.destroy(); };
  if (chemin === '/ws') wss.handleUpgrade(req, socket, tete, (ws) => wss.emit('connection', ws, req));
  else if (chemin === '/ws/module' || (chemin === '/ws/meshcore' && config.meshcore.actif)) {
    const r = refusPasserelle(req);
    if (r) return refus(r);
    wssModule.handleUpgrade(req, socket, tete, (ws) => (chemin === '/ws/module' ? wssModule.emit('connection', ws, req) : brancherCompanionNavigateur(ws, req)));
  } else refus();
});
// Hôte, compte et rôle d'une passerelle de page : envoyés à la page (trame texte, ignorée par le relais du flux)
function noterPasserelle(ws, hote, u, protocole, role, source) {
  passerellesNav.set(hote, { compteId: u.id, compte: nomCompte(u), admin: u.role === 'admin', protocole, role, source, depuis: Date.now() });
  ws.on('close', () => { const p = passerellesNav.get(hote); if (p && p.compteId === u.id) passerellesNav.delete(hote); });
  try { ws.send(JSON.stringify({ genre: 'passerelle', hote, role })); } catch { /* fermée */ }
}
// Débit d'une passerelle de membre : au-delà, la liaison est coupée (une radio normale reste très en dessous)
function limiterDebit(ws, octetsParMinute) {
  let fenetre = Date.now(), octets = 0;
  ws.on('message', (d) => {
    if (Date.now() - fenetre > 60000) { fenetre = Date.now(); octets = 0; }
    octets += d.length || d.byteLength || 0;
    if (octets > octetsParMinute) { journal(`passerelle coupée : débit trop élevé (${Math.round(octets / 1024)} Ko/min)`); try { ws.close(1008, 'débit trop élevé'); } catch { /* déjà */ } }
  });
}
const { Duplex } = require('stream');
// Flux duplex au-dessus d'une WebSocket, avec les méthodes d'un socket TCP utilisées par le module radio
function fluxWebSocket(ws) {
  let minuterie = null, delai = 0;
  const reveil = () => { if (delai) { clearTimeout(minuterie); minuterie = setTimeout(() => f.emit('timeout'), delai); } };
  const f = new Duplex({
    read() {},
    write(morceau, enc, fait) { if (ws.readyState === 1) ws.send(morceau, { binary: true }, fait); else fait(); },
    destroy(err, fait) { clearTimeout(minuterie); try { ws.close(); } catch { /* déjà fermé */ } fait(err); },
  });
  f.setNoDelay = () => f; f.setKeepAlive = () => f;
  f.setTimeout = (ms) => { delai = ms; reveil(); return f; };
  ws.on('message', (data, binaire) => { if (!binaire) return; reveil(); f.push(Buffer.from(data)); });
  ws.on('close', () => { clearTimeout(minuterie); f.push(null); if (!f.destroyed) f.destroy(); });
  ws.on('error', (e) => f.emit('error', e));
  return f;
}
wssModule.on('connection', (ws, req) => {
  const u = utilisateur(req);
  if (!u) { ws.close(1008, 'connexion requise'); return; }
  const admin = u.role === 'admin';
  const q = new URL(req.url, 'http://x').searchParams;
  // Le nom d'une passerelle de membre porte son identifiant : elle ne peut pas prendre la place d'un autre module
  const base = (q.get('nom') || `Navigateur ${u.identifiant}`).slice(0, 40);
  const nom = admin ? base : `${base} · ${u.identifiant}`.slice(0, 60);
  const source = (q.get('source') || 'USB').slice(0, 40);
  const role = admin && q.get('role') !== 'ecoute' ? 'principal' : 'ecoute';
  if (!admin) limiterDebit(ws, 512 * 1024);
  try {
    const hote = brancherModuleFlux(fluxWebSocket(ws), nom, source + ' (navigateur)', (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), role, undefined, admin ? null : u.id, admin ? null : nomCompte(u));
    noterPasserelle(ws, hote, u, 'meshtastic', role, source);
    if (!admin) audit.noter(nomCompte(u), (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), 'passerelle reliée', `radio « ${base} » (${source})`);
  } catch (e) { journal('passerelle refusée :', e.message); try { ws.close(1008, String(e.message).slice(0, 100)); } catch { /* déjà */ } }
});
// Module Meshtastic déjà ouvert (page web ou agent 1.7 « direct ») : principal tant que le flux reste ouvert, puis
// retour au module utilisé avant ; ou passerelle d'écoute en plus du principal
function brancherModuleFlux(flux, nom, source, ip, role, version, proprietaire = null, compte = null) {
  if (role === 'ecoute') {
    const h = agents.ajouterVirtuel(nom, source, flux, ip, version, proprietaire);
    ecoutes.ajouterRadio(h, 1, nom, { navigateur: true, source, compte });
    flux.on('close', () => { ecoutes.retirerRadio(h, 1); rafraichirEtat(); diffuser({ genre: 'statut' }); });
    return h;
  }
  const precedent = sourceRadio.modules().actif;
  const hote = agents.ajouterVirtuel(nom, source, flux, ip, version);
  sourceRadio.ajouterModule(hote, 1, nom);
  sourceRadio.connecterA(hote, 1);
  // À la déconnexion du navigateur, on revient au module utilisé avant
  flux.on('close', () => {
    const m = sourceRadio.modules();
    if (m.actif && m.actif.hote === hote) {
      sourceRadio.retirerModule(hote, 1);
      if (precedent && precedent.hote !== hote) sourceRadio.connecterA(precedent.hote, precedent.port);
    } else sourceRadio.retirerModule(hote, 1);
    rafraichirEtat(); diffuser({ genre: 'statut' });
  });
  rafraichirEtat(); diffuser({ genre: 'statut' });
  return hote;
}
// Companion MeshCore branché sur le PC de l'utilisateur, relayé par la page
function brancherCompanionNavigateur(ws, req) {
  const u = utilisateur(req);
  if (!u) { ws.close(1008, 'connexion requise'); return; }
  const admin = u.role === 'admin';
  const q = new URL(req.url, 'http://x').searchParams;
  const source = q.get('source') === 'Bluetooth' ? 'Bluetooth' : 'USB';
  const base = (q.get('nom') || `${source} ${u.identifiant}`).slice(0, 40);
  const nom = admin ? base : `${base} · ${u.identifiant}`.slice(0, 60);
  const role = admin && q.get('role') !== 'ecoute' ? 'principal' : 'ecoute';
  if (!admin) limiterDebit(ws, 512 * 1024);
  try {
    brancherCompanionFlux(fluxWebSocket(ws), nom, source, role, admin ? null : nomCompte(u));
    noterPasserelle(ws, 'nav:' + nom, u, 'meshcore', role, source);
  } catch (e) { try { ws.close(1008, String(e.message).slice(0, 100)); } catch { /* déjà */ } }
}
// Companion MeshCore déjà ouvert (page web ou agent 1.7 « direct ») : principal tant que le flux reste ouvert, ou en écoute
function brancherCompanionFlux(flux, nom, source, role, compte = null) {
  if (!config.meshcore.actif) throw new Error('companion MeshCore reconnu, mais MeshCore n’est pas activé dans cette carte');
  if (role === 'ecoute') ecoutes.ajouterCompanion(null, nom, { navigateur: flux, source, compte });
  else companion.brancherNavigateur(flux, nom, source);
  diffuserEtatMc();
}
wss.on('connection', (ws, req) => {
  ws.admin = estMembre(req);
  ws.gestion = estGestion(req); // alertes des secteurs et journal de crise : gestionnaires et administrateurs seulement
  ws.vivant = true;
  ws.on('pong', () => (ws.vivant = true));
  ws.send(JSON.stringify({ genre: 'bienvenue', admin: ws.admin, mqtt: !!(clientMqtt && clientMqtt.connected) }));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.vivant) { ws.terminate(); continue; }
    ws.vivant = false;
    ws.ping();
  }
}, 30000);

let passerelle = null; // passerelle inter-réseaux (PASSERELLE=1), créée plus bas
// Messages de canal décodés : transmis à la passerelle inter-réseaux, si elle est activée
function verPasserelle(m) {
  if (!passerelle || !m) return;
  try {
    if (m.genre === 'paquet' && m.premiere && m.port === 'texte' && m.texte && m.vers == null) passerelle.recevoir({ reseau: 'mt', canal: m.canal, de: m.de, nom: passerelle.nomMt(m.de), texte: m.texte });
    else if (m.genre === 'mc-paquet' && m.premiere && m.type === 'ADVERT' && m.de && passerelle.active()) {
      // Annonce MeshCore d'un companion avec sa position : relayée si une liaison relaie les positions
      const n = reseauMc.q.noeud.get(m.de);
      if (n && n.role === 'companion' && n.lat != null) passerelle.recevoirPosition({ reseau: 'mc', de: n.cle, nom: n.nom || n.cle.slice(0, 8), lat: n.lat, lon: n.lon });
    } else if (m.genre === 'mc-paquet' && m.premiere && m.texte && m.canal) passerelle.recevoir({ reseau: 'mc', canal: m.canal, de: null, nom: m.expediteur || null, texte: m.texte });
    else if (m.genre === 'mc-message' && m.sens === 'recu' && !m.direct && !m.dejaPasserelle && m.canal && m.texte) passerelle.recevoir({ reseau: 'mc', canal: m.canal, de: null, nom: m.nomDe || null, texte: m.texte });
  } catch (e) { journal('[Passerelle]', e.message); }
}
// Paquets Meshtastic décodés (MQTT, module, agents) : positions et signalements pour la passerelle, si une liaison les relaie
function versPasserelleRadio(evt) {
  if (!passerelle || !evt || !passerelle.active()) return;
  try {
    const canal = evt.canal || evt.canalTopic, de = evt.de >>> 0;
    if (evt.port === 'position' && evt.position && evt.position.lat != null && evt.diffusion) passerelle.recevoirPosition({ reseau: 'mt', canal, de, nom: passerelle.nomMt(de), lat: evt.position.lat, lon: evt.position.lon, alt: evt.position.alt });
    else if (evt.port === 'waypoint' && evt.pointRepere && evt.pointRepere.lat != null) {
      const w = evt.pointRepere;
      passerelle.recevoirSignalement({ reseau: 'mt', canal, de, nom: passerelle.nomMt(de), idPoint: w.id, titre: String(w.nom || '').replace(/^\p{Extended_Pictographic}️?\s*/u, ''), details: w.description, icone: w.icone ? String.fromCodePoint(w.icone) : null, lat: w.lat, lon: w.lon, fin: !!(w.expire && w.expire * 1000 <= Date.now()) });
    }
  } catch (e) { journal('[Passerelle]', e.message); }
}
function diffuser(message) {
  const t0 = performance.now();
  if (message.genre === 'noeud-supprime') viderCacheNoeuds();
  verPasserelle(message);
  // Vue publique : sans texte, positions des nœuds de particuliers arrondies. Chaque vue est sérialisée une seule fois
  // (et seulement si un navigateur de ce genre est connecté), puis la même chaîne part vers tous les navigateurs
  let pub = null, adm = null;
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (ws.admin) { if (adm === null) adm = JSON.stringify(message); ws.send(adm); }
    else {
      if (pub === null) {
        const vue = message.genre === 'etat' && message.alertes ? { ...message, alertes: alertesPubliques(message.alertes) } : message;
        pub = JSON.stringify(reseau.vueTrame(vue.texte !== undefined ? { ...vue, texte: undefined } : vue, false));
      }
      ws.send(pub);
    }
  }
  noterTache(message.genre === 'etat' || message.genre === 'mc-etat' ? 'diffusion de l’état aux navigateurs' : 'diffusion d’un paquet aux navigateurs', performance.now() - t0);
}
// Message réservé aux comptes connectés (positions des intervenants, demandes d'aide, mode urgence) : rien vers le public
function diffuserMembres(message) {
  const t = JSON.stringify(message);
  const gestion = message.genre === 'secteur-alerte' || message.genre === 'urgence-evt';
  for (const ws of wss.clients) if (ws.readyState === 1 && ws.admin && (!gestion || ws.gestion)) ws.send(t);
}
// Secteurs d'alerte et mode urgence : positions reçues (un paquet vu par plusieurs passerelles compte une fois)
// et messages de détresse pendant une crise
let dernierPaquetCrise = 0, modulesCrisePrets = false; // dernier paquet Meshtastic reçu (toutes sources) ; secteurs et urgence créés
const sosVus = new Map(); // nœud -> heure du dernier message de détresse noté (un par nœud par 5 min)
// Nœud de la carte elle-même ou d'un module en écoute : ses messages (alertes envoyées par la carte) ne sont pas des détresses
function noeudDeLaCarte(num) {
  try { if (sourceRadio.infos().noeudLocal === num) return true; } catch { /* pas de module */ }
  try { return resumeEcoutes().some((x) => x.noeud === num); } catch { return false; }
}
// Nœud concerné par la carte : surveillé, dans la zone, ou membre d'une équipe → détresse « critique » ; sinon « attention »
function noeudConcerne(num) {
  try { if (equipes.estMembre(num)) return true; } catch { /* pas encore prêt */ }
  try {
    const n = stockage.q.noeud.get(num >>> 0);
    if (!n) return false;
    if (reseau.estSurveille(n)) return true;
    const z = config.zone;
    return !!(z && n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]);
  } catch { return false; }
}
function crisePaquet(evt) {
  dernierPaquetCrise = Date.now();
  try {
    if (evt.port === 'position' && evt.position && evt.position.lat != null && evt.de != null) secteursAlerte.position('mt:' + (evt.de >>> 0), { lat: evt.position.lat, lon: evt.position.lon, precision: evt.position.precision, heureFix: evt.position.heureFix || null, id: evt.idPaquet });
    if (evt.port === 'texte' && evt.texte && evt.de != null && urgence.actif() && RE_SOS.test(evt.texte)) {
      const de = evt.de >>> 0, t = Date.now();
      if (noeudDeLaCarte(de) || t - (sosVus.get(de) || 0) < 300000) return;
      sosVus.set(de, t);
      if (sosVus.size > 2000) for (const [k, v] of sosVus) { if (t - v > 300000) sosVus.delete(k); }
      const concerne = noeudConcerne(de);
      const qui = `${nomNoeudServeur(de)}${evt.canal ? ` (canal ${evt.canal})` : ''}`, txt = String(evt.texte).replace(/\u0007/g, '🔔').slice(0, 200);
      urgence.noter({ cle: `msg:${de}:${evt.idPaquet}`, type: 'message', niveau: concerne ? 'critique' : 'attention', texte: concerne ? `Message de détresse de ${qui} : ${txt}` : `Message de détresse possible de ${qui} (nœud hors zone, expéditeur non vérifiable) : ${txt}`, noeud: de });
    }
  } catch (e) { if (modulesCrisePrets || !(e instanceof ReferenceError)) journal('[Secteurs]', e.message); } // pas encore créés au démarrage
}

// ---- MQTT -----------------------------------------------------------------
let compteur = { recus: 0, decodes: 0, erreurs: 0 };
// Statistiques du broker pour la page « Broker MQTT » : passerelles (dernier segment du sujet), canaux, débit
const statsMqtt = { depuis: null, reconnexions: 0, derniereErreur: null, dernierMessage: null, minutes: new Map(), passerelles: new Map(), canaux: new Map() };
function noterMessageMqtt(topic) {
  const t = Date.now(), m = Math.floor(t / 60000);
  statsMqtt.dernierMessage = t;
  statsMqtt.minutes.set(m, (statsMqtt.minutes.get(m) || 0) + 1);
  if (statsMqtt.minutes.size > 70) statsMqtt.minutes.delete(statsMqtt.minutes.keys().next().value);
  const parts = topic.split('/');
  const gw = parts[parts.length - 1];
  if (/^![0-9a-f]{8}$/i.test(gw)) {
    const e = statsMqtt.passerelles.get(gw) || { messages: 0, sujet: parts.slice(0, -1).join('/') };
    e.messages++; e.derniere = t; statsMqtt.passerelles.set(gw, e);
    if (statsMqtt.passerelles.size > 300) statsMqtt.passerelles.delete(statsMqtt.passerelles.keys().next().value);
  }
  const i = parts.indexOf('e') >= 0 ? parts.indexOf('e') : parts.indexOf('json');
  if (i >= 0 && parts[i + 1] && parts[i + 1] !== gw) statsMqtt.canaux.set(parts[i + 1], (statsMqtt.canaux.get(parts[i + 1]) || 0) + 1);
}
const clientMqtt = mqtt.connect(config.mqtt.url, {
  username: config.mqtt.utilisateur || undefined,
  password: config.mqtt.motDePasse || undefined,
  clientId: 'carte-live-' + crypto.randomBytes(3).toString('hex'),
  reconnectPeriod: 5000,
  // Certificat du broker vérifié (mqtts://, wss://), sauf si MQTT_TLS_NON_VERIFIE=oui (certificat auto-signé)
  rejectUnauthorized: !config.mqtt.tlsNonVerifie,
});
const sujets = [config.mqtt.racine + '/#', ...config.mqtt.sujetsSupplementaires, ...(config.meshcore.actif ? [config.meshcore.racine + '/#'] : [])];
const prefixeMc = config.meshcore.racine + '/';
let compteurMc = { recus: 0, observations: 0, erreurs: 0 };
// Décision { dans, pos } : pos = vrai quand elle repose sur la position connue de l'observateur (sûre), faux quand
// elle ne repose que sur le code de zone du sujet (provisoire : la clé du sujet peut différer de l'origin_id du JSON)
function dansPerimetreMc(cleObs, iata) {
  const p = config.meshcore.perimetre;
  if (p === 'national') return { dans: true, pos: true };
  const z = p === 'voisins' ? ((zoneVoisins() || {}).bbox || config.zone) : config.zone;
  const pos = reseauMc.positionDe(cleObs);
  if (pos) return { dans: pos.lat >= z[0] - 0.05 && pos.lat <= z[2] + 0.05 && pos.lon >= z[1] - 0.05 && pos.lon <= z[3] + 0.05, pos: true };
  // Position inconnue : code de zone du sujet (le nôtre ou ceux déclarés voisins)
  const code = String(iata || '').toUpperCase();
  return { dans: code === config.meshcore.iata || config.meshcore.iataVoisins.includes(code), pos: false };
}
// Paquet MeshCore intégré ; un message de canal déchiffré depuis le paquet brut (observateur MQTT ou companion)
// part aussi comme « mc-message » : les cartes des membres le comptent dans les non-lus et rafraîchissent la liste
function diffuserSortieMc(sortie) {
  diffuser(sortie);
  if (sortie.nouveauMessage && sortie.texte) diffuser({ genre: 'mc-message', id: sortie.nouveauMessage, sens: 'recu', canal: sortie.canal, texte: sortie.texte, nomDe: sortie.expediteur, heure: Date.now(), dejaPasserelle: true });
}
// Décision de périmètre par observateur gardée 60 s : le flux national envoie des centaines de milliers de paquets
// d'observateurs lointains, rejetés d'après le sujet MQTT seul, sans lire le JSON ni chercher leur position à chaque fois
const perimetreObs = new Map();
function obsDansPerimetre(cle, iata) {
  const t = Date.now(), k = cle + '|' + iata;
  let d = perimetreObs.get(k);
  if (d && t - d.heure < 60000) return d;
  d = { ...dansPerimetreMc(cle, iata), heure: t };
  if (perimetreObs.size > 5000) perimetreObs.clear();
  perimetreObs.set(k, d);
  return d;
}
function messageMc(topic, message) {
  compteurMc.recus++;
  if (config.meshcore.perimetre !== 'national') {
    // Rejet d'après le sujet seul, uniquement quand la décision repose sur une position connue ; sinon le JSON est lu
    // (son origin_id fait foi) et la décision se prend plus bas
    const s = RE_SUJET_MC.exec(topic);
    if (s && s[4] === 'packets') { const d = obsDansPerimetre(s[3].toUpperCase(), s[2]); if (!d.dans && d.pos) { compteurMc.horsPerimetre = (compteurMc.horsPerimetre || 0) + 1; return; } }
  }
  const m = lireMessageMc(topic, message);
  if (!m) return;
  if (m.genre === 'erreur') { compteurMc.erreurs++; return; }
  const moi = companion.etat().cle;
  if (m.cle === moi) return; // nos propres republications
  if (m.genre === 'statut') { reseauMc.noterObservateur(m.cle, { nom: m.nom, etat: m.etat, details: m.details }); planifierEtatMc(); return; }
  // Filtre à la source : on ne garde que ce qu'ont capté les observateurs du périmètre choisi
  const d = obsDansPerimetre(m.cle, m.iata);
  if (!d.dans) { compteurMc.horsPerimetre = (compteurMc.horsPerimetre || 0) + 1; return; }
  if (m.nom) reseauMc.noterObservateur(m.cle, { nom: m.nom, details: { iata: m.iata } });
  const sortie = reseauMc.integrer(m.obs);
  if (sortie) { compteurMc.observations++; diffuserSortieMc(sortie); }
  // Décision provisoire (code de zone) et position de l'observateur connue depuis : la décision est reprise au prochain paquet
  if (!d.pos && reseauMc.positionDe(m.cle)) perimetreObs.delete(m.cle + '|' + m.iata);
}
clientMqtt.on('connect', () => {
  statsMqtt.depuis = Date.now();
  journal(`MQTT connecté à ${config.mqtt.url.replace(/\/\/[^@]*@/, '//')}, abonnement à ${sujets.join(', ')}`);
  clientMqtt.subscribe(sujets, { qos: 0 });
  diffuser({ genre: 'mqtt', connecte: true });
});
clientMqtt.on('close', () => { statsMqtt.depuis = null; diffuser({ genre: 'mqtt', connecte: false }); });
clientMqtt.on('reconnect', () => { statsMqtt.reconnexions++; });
clientMqtt.on('error', (e) => { statsMqtt.derniereErreur = { message: e.message, heure: Date.now() }; journal('Erreur MQTT :', e.message); });
// Le même paquet peut arriver par deux brokers (ponts entre bulles) : ignoré s'il a déjà été vu dans les 2 minutes
const vusMqtt = new Map();
function dejaVuMqtt(topic, message) {
  const k = topic + '|' + crypto.createHash('sha1').update(message).digest('base64').slice(0, 16);
  const t = Date.now(), v = vusMqtt.get(k);
  if (v && t - v < 120000) return true;
  vusMqtt.set(k, t);
  if (vusMqtt.size > 20000) { for (const [x, h] of vusMqtt) { if (t - h > 120000) vusMqtt.delete(x); } if (vusMqtt.size > 20000) vusMqtt.clear(); }
  return false;
}
clientMqtt.on('message', (topic, message) => traiterMessageMqtt(topic, message));
// Brokers supplémentaires (MQTT_BROKERS_SUPPLEMENTAIRES) : mêmes traitements que le broker principal
const brokersSup = config.mqtt.brokers.map((b) => {
  const etatB = { url: b.url.replace(/\/\/[^@]*@/, '//'), racine: b.racine || config.mqtt.racine, connecte: false, depuis: null, messages: 0, derniereErreur: null };
  const c = mqtt.connect(b.url, { clientId: 'carte-live-' + crypto.randomBytes(3).toString('hex'), reconnectPeriod: 10000, rejectUnauthorized: !config.mqtt.tlsNonVerifie });
  const sujetsB = [etatB.racine + '/#', ...(config.meshcore.actif ? [config.meshcore.racine + '/#'] : [])];
  c.on('connect', () => { Object.assign(etatB, { connecte: true, depuis: Date.now() }); journal(`MQTT supplémentaire connecté à ${etatB.url}, abonnement à ${sujetsB.join(', ')}`); c.subscribe(sujetsB, { qos: 0 }); });
  c.on('close', () => { etatB.connecte = false; etatB.depuis = null; });
  c.on('error', (e) => { etatB.derniereErreur = { message: e.message, heure: Date.now() }; });
  c.on('message', (topic, message) => { etatB.messages++; traiterMessageMqtt(topic, message); });
  return { client: c, etat: etatB };
});
// Chaque message est chronométré (décodage et écriture en base) : total et maximum par minute dans la santé de la carte
function traiterMessageMqtt(topic, message) {
  const t0 = performance.now();
  let nom = 'message MQTT Meshtastic';
  try {
    if ((brokersSup.length || config.mqtt.dedoublonner) && dejaVuMqtt(topic, message)) { compteur.doublons = (compteur.doublons || 0) + 1; nom = 'message MQTT en double'; return; }
    compteur.recus++;
    if (config.meshcore.actif && topic.startsWith(prefixeMc)) {
      compteurMc.recusMqtt = (compteurMc.recusMqtt || 0) + 1;
      const hors = compteurMc.horsPerimetre || 0;
      nom = 'message MQTT MeshCore';
      try { messageMc(topic, message); } catch (e) { compteurMc.erreurs++; journal('Erreur MeshCore :', e.message, topic); }
      if ((compteurMc.horsPerimetre || 0) !== hors) nom = 'message MeshCore hors périmètre';
      return;
    }
    noterMessageMqtt(topic);
    traiterEnveloppeMt(topic, message);
  } finally { noterTache(nom, performance.now() - t0); }
}
// Enveloppe Meshtastic (MQTT, ou paquet du réseau local remis sous forme d'enveloppe) : décodage puis carte
function traiterEnveloppeMt(topic, message) {
  try {
    const evt = decoderMessage(topic, message, canaux);
    if (!evt) return;
    if (evt.genre === 'erreur') { compteur.erreurs++; return; }
    if (evt.port === 'waypoint' && evt.pointRepere) { try { signalements.recu(evt); } catch { /* pas encore prêt */ } }
    versPasserelleRadio(evt);
    if (evt.port === 'texte' && evt.texte && /^Pager ACK/i.test(evt.texte)) { try { signalements.texteRecu(evt); } catch { /* pas encore prêt */ } } if (evt.port === 'texte' && evt.texte) { try { equipes.texteRecu(evt); } catch { /* pas encore prêt */ } } if (evt.port === 'texte' && evt.texte) { try { adrasec.texteRecu(evt); } catch { /* pas encore prêt */ } } crisePaquet(evt);
    if (evt.port === 'position' && evt.position && evt.position.lat != null) { try { const d = administration.reponsePosition(evt.de); if (d != null) diffuserMembres({ genre: 'position-reponse', num: evt.de >>> 0, lat: evt.position.lat, lon: evt.position.lon, delai: d }); } catch { /* pas encore prêt */ } }
    const sortie = reseau.integrer(evt);
    try { autresPresets.noterPaquet(evt); } catch { /* pas encore prêt */ }
    if (sortie) { compteur.decodes++; diffuser(sortie); }
  } catch (e) {
    compteur.erreurs++;
    journal('Erreur de traitement :', e.message, topic);
  }
}

// ---- Nœuds d'un autre preset que le réseau : repérés pour être invités ----------------------------------------------
const { creerAutresPresets } = require('./autres-presets');
const autresPresets = creerAutresPresets(stockage.db, (...a) => journal('[Presets]', ...a));
function presetDuReseau() {
  return presetReseau() || config.reseauPreset || 'LONG_FAST';
}
app.get('/api/autres-presets', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const reseauP = presetDuReseau();
  const sentinelles = ecoutes.liste().meshtastic.filter((m) => m.connecte && m.preset && m.preset !== reseauP).map(({ hote, port, nom, preset, noeud }) => ({ hote, port, nom, preset, noeud }));
  res.set('Cache-Control', 'no-store').json({ preset: reseauP, noeuds: autresPresets.liste(reseauP, { jours: Math.min(365, Math.max(1, Number(req.query.jours) || 30)) }), sentinelles });
});
// Invitation : message direct envoyé par un module en écoute réglé sur le preset du nœud (« sentinelle »)
app.post('/api/autres-presets/inviter', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const b = req.body || {};
  try {
    const num = Number(b.num) >>> 0;
    const n = stockage.db.prepare('SELECT num, preset, nom_long FROM noeuds WHERE num = ?').get(num);
    if (!n) throw new Error('Nœud inconnu');
    const s = ecoutes.liste().meshtastic.find((m) => m.hote === String(b.hote || '') && Number(m.port) === Number(b.port));
    if (!s || !s.connecte) throw new Error('Module sentinelle introuvable ou non connecté');
    if (n.preset && s.preset && n.preset !== s.preset) throw new Error(`Le module « ${s.nom} » est en ${s.preset}, le nœud en ${n.preset} : il ne l’entendrait pas`);
    const r = ecoutes.radio(s.hote, s.port).envoyerInvitation(num, b.texte);
    res.json({ ok: true, id: r.id });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});

// ---- Page publique « Rejoindre le réseau » (/rejoindre) ----------------------------------------------------------
const adhesion = require('./adhesion').creerAdhesion({ config, db: stockage.db, reseauMc: typeof reseauMc !== 'undefined' ? reseauMc : null, presetDuReseau, journal: (...a) => journal('[Rejoindre]', ...a) });
app.get('/rejoindre', envoyerPage('rejoindre.html'));
app.get('/api/rejoindre', async (req, res) => {
  const adresse = `${req.protocol}://${req.get('host')}/rejoindre`;
  const p = await adhesion.publique(adresse);
  if (!p) return res.status(404).json({ erreur: 'Page non publiée par l’administrateur' });
  res.set('Cache-Control', 'max-age=60').json(p);
});
app.get('/api/rejoindre/reglages', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store').json({ ...adhesion.lire(), preset: presetDuReseau() });
});
app.post('/api/rejoindre/reglages', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  try { res.json(adhesion.enregistrer(req.body || {})); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Lien du canal principal (avec les réglages LoRa) du module relié à la carte, pour remplir la page en un clic
app.get('/api/rejoindre/lien-module', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const m = adhesion.moduleCarte();
  const q = m && m.noeud ? await require('./reglages-noeuds').qr(m.noeud, { indices: [0], avecLora: true }).catch(() => null) : null;
  if (!q) return res.status(404).json({ erreur: 'Canaux du module pas encore connus : reliez un module Meshtastic à la carte' });
  res.set('Cache-Control', 'no-store').json({ lien: q.url });
});

// ---- Modules Meshtastic du réseau local, écoutés par UDP multicast (UDP_MESHTASTIC=oui) ---------------------------
// Le module qui diffuse est repéré par ses propres paquets (sans mesure radio) : il devient la « passerelle » des paquets
// qu'il entend, comme une passerelle MQTT.
const { creerUdpMeshtastic } = require('./udp-meshtastic');
const ipVersNoeud = new Map();
const udpMt = creerUdpMeshtastic({
  types: { MeshPacket: require('./decodeur').racine.lookupType('meshtastic.MeshPacket') },
  journal: (...a) => journal('[UDP]', ...a),
  surPaquet: (p, ip) => {
    const de = p.from >>> 0;
    if (!p.rxSnr && !p.rxRssi && (!p.hopStart || p.hopStart === p.hopLimit)) ipVersNoeud.set(ip, de);
    const gw = ipVersNoeud.get(ip);
    const gatewayId = gw != null ? '!' + gw.toString(16).padStart(8, '0') : undefined;
    const env = ServiceEnvelopeUdp.encode({ packet: p, gatewayId }).finish();
    compteur.udp = (compteur.udp || 0) + 1;
    traiterEnveloppeMt(`udp/2/e/LAN/${gatewayId || ip}`, Buffer.from(env));
  },
});
const ServiceEnvelopeUdp = require('./decodeur').types.ServiceEnvelope;
if (String(process.env.UDP_MESHTASTIC || 'non').toLowerCase() === 'oui') udpMt.demarrer();

// ---- Tâches périodiques ---------------------------------------------------
let dernieresAlertes = [];
// Alertes des services internes (adresses, messages d'erreur) réservées aux administrateurs
function alertesPubliques(l) {
  const lorawanPublic = (() => { try { return lorawan.etat().public; } catch { return false; } })();
  // Équipes, secteurs d'alerte et mode urgence : noms et positions d'intervenants, réservés aux comptes connectés
  return l.filter((a) => a.type !== 'service' && a.type !== 'equipe' && a.type !== 'secteur' && a.type !== 'urgence' && (a.type !== 'lorawan' || lorawanPublic));
}
// Services de fond en échec prolongé : visibles dans les alertes de la carte, pas seulement dans le journal du serveur
const enEchecDepuis = {};
function alertesServices() {
  const l = [], t = Date.now();
  const suivre = (cle, enEchec, delaiMin, message) => {
    if (!enEchec) { delete enEchecDepuis[cle]; return; }
    if (!enEchecDepuis[cle]) enEchecDepuis[cle] = t;
    if (t - enEchecDepuis[cle] >= delaiMin * 60000) l.push({ cle: 'service:' + cle, type: 'service', niveau: 'attention', depuis: enEchecDepuis[cle], message });
  };
  if (typeof alertesOff !== 'undefined') {
    const a = alertesOff.etat();
    suivre('meteo', !!a.erreur, 60, `Vigilance Météo-France illisible : ${a.erreur} (alertes et diffusions LoRa en attente)`);
  }
  if (typeof archivePg !== 'undefined' && archivePg && archivePg.etat) {
    const p = archivePg.etat();
    suivre('postgres', !!(p && p.reglages && p.reglages.actif && p.erreur), 30, `Archive PostgreSQL : ${p && p.erreur}`);
  }
  if (typeof sourceMM !== 'undefined' && sourceMM && sourceMM.etat) {
    const m = sourceMM.etat();
    suivre('meshmonitor', !!(m && m.erreur), 30, `Source MeshMonitor injoignable : ${m && m.erreur}`);
  }
  // Tâches de fond des couches en option : un échec durable remonte dans les alertes de la carte
  if (typeof rivieres !== 'undefined') { const r = rivieres.etat(); suivre('rivieres', r.actif && !!r.erreur, 60, `Rivières : relevé Hub’Eau impossible (${r.erreur})`); }
  if (typeof lorawan !== 'undefined') { const l = lorawan.etat(); suivre('lorawan', l.actif && !l.connecte, 30, `LoRaWAN : serveur MQTT injoignable${l.erreur ? ' (' + l.erreur + ')' : ''}`); }
  if (typeof aprs !== 'undefined') { const a = aprs.etat(); suivre('aprs', a.actif && a.indicatif && !a.connecte, 30, `APRS-IS injoignable${a.erreur ? ' : ' + a.erreur : ''} (couche APRS figée)`); }
  // MQTT : déjà signalé par la pastille « En direct » du bandeau (et absent volontairement sur les cartes reliées à un module seul)
  return l;
}
function rafraichirEtat() {
  viderCacheNoeuds(60000); // liste des nœuds plus demandée depuis une minute : mémoire rendue
  dernieresAlertes = chronoTache('alertes Meshtastic', () => reseau.calculerAlertes());
  try { if (typeof equipes !== 'undefined') dernieresAlertes = [...dernieresAlertes, ...equipes.alertes((n) => { const r = reqNomSig.get(n >>> 0); return r && (r.nom_long || r.nom_court); })]; } catch { /* équipes pas encore prêtes */ }
  if (passerelle) { try { dernieresAlertes = [...dernieresAlertes, ...passerelle.alertes()]; } catch (e) { journal('[Passerelle]', e.message); } }
  try { dernieresAlertes = [...dernieresAlertes, ...alertesServices()]; } catch (e) { journal('alertes des services :', e.message); }
  try { dernieresAlertes = [...dernieresAlertes, ...lorawan.alertes()]; } catch (e) { if (!(e instanceof ReferenceError)) journal('[LoRaWAN]', e.message); }
  try { dernieresAlertes = [...dernieresAlertes, ...rivieres.alertes()]; } catch (e) { if (!(e instanceof ReferenceError)) journal('[Rivières]', e.message); } // pas encore créé au démarrage
  try { if (!fonctionMasquee('feux')) dernieresAlertes = [...dernieresAlertes, ...feux.alertes()]; } catch (e) { if (!(e instanceof ReferenceError)) journal('[Feux]', e.message); } // pas encore créé au démarrage
  try { dernieresAlertes = [...dernieresAlertes, ...secteursAlerte.alertes()]; } catch (e) { if (!(e instanceof ReferenceError)) journal('[Secteurs]', e.message); }
  try {
    if (urgence.actif()) {
      const u = urgence.etat();
      dernieresAlertes = [{ cle: 'urgence:' + u.id, type: 'urgence', niveau: 'critique', depuis: u.debut, message: `Mode urgence en cours${u.motif ? ' : ' + u.motif : ''}` }, ...dernieresAlertes];
      noterAlertesCrise([...dernieresAlertes, ...(config.meshcore.actif ? alertesMc : [])]);
    }
  } catch (e) { if (!(e instanceof ReferenceError)) journal('[Urgence]', e.message); }
  diffuser({ genre: 'etat', stats: chronoTache('statistiques Meshtastic', () => reseau.statistiques()), alertes: dernieresAlertes, meshmonitor: typeof sourceMM !== 'undefined' && sourceMM ? sourceMM.etat() : null, radio: typeof sourceRadio !== 'undefined' && sourceRadio ? sourceRadio.etat() : null, ecoutes: resumeEcoutes() });
}
setInterval(rafraichirEtat, 30000);
let minuterieEtatMc = null;
function diffuserEtatMc() {
  if (!config.meshcore.actif) return;
  const c = companion.etat();
  alertesMc = chronoTache('alertes MeshCore', () => reseauMc.calculerAlertes({ administres: adminMc.memorises(), companion: { cible: c.cible || c.navigateur, connecte: c.connecte, nom: c.nom, cle: c.cle, erreur: c.erreur } }));
  try { alertesMc = [...alertesMc, ...capteursMc.alertes(nomNoeudMc)]; } catch (e) { journal('alertes des capteurs :', e.message); }
  try { if (typeof maintenanceMc !== 'undefined') alertesMc = [...alertesMc, ...maintenanceMc.alertes()]; } catch (e) { journal('alertes de maintenance :', e.message); }
  try { alertesMc = [...alertesMc, ...adminMc.alertesSupervision()]; } catch (e) { journal('alertes de supervision :', e.message); }
  diffuser({ genre: 'mc-etat', ...chronoTache('état MeshCore', () => etatMc(false)) });
}
function planifierEtatMc() { if (!minuterieEtatMc) minuterieEtatMc = setTimeout(() => { minuterieEtatMc = null; diffuserEtatMc(); }, 15000); } // statuts d'observateurs fréquents : au plus toutes les 15 s
setInterval(diffuserEtatMc, 30000);
const sourceMM = creerSourceMeshMonitor(stockage, config, () => { rafraichirEtat(); diffuser({ genre: 'statut' }); });
if (sourceMM) journal(`Source MeshMonitor activée : ${config.meshmonitor.url}`);
// Archive PostgreSQL facultative (POSTGRES_URL) : copie de tout le trafic, sans limite de durée
const archivePg = require('./postgres').creerArchivePostgres(config, stockage, journal);
app.get('/api/postgres', (req, res) => { if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); res.set('Cache-Control', 'no-store').json(archivePg.etat()); });
app.post('/api/postgres', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { const r = archivePg.configurer(req.body || {}); audit.noter(nomCompte(u), req.ip, 'archive PostgreSQL', `${r.actif ? 'activée' : 'désactivée'} · ${r.retentionJours ? r.retentionJours + ' j' : 'toujours'} · ${r.maxGo ? r.maxGo + ' Go' : 'sans limite'}`, true); res.json(archivePg.etat()); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/postgres/tester', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(await archivePg.tester(req.body || {})); } catch (e) { res.status(400).json({ erreur: 'Connexion impossible : ' + e.message }); }
});
// Agents (module USB sur un PC, ou module Wi-Fi d'un autre réseau) : ils se connectent au port 4404
const agents = creerAgents(config, {
  surArrivee: (hote, nom, protocole) => {
    if (protocole !== 'meshtastic' && typeof companion !== 'undefined' && companion) companion.agentDisponible(hote);
    if (protocole !== 'meshcore' && typeof sourceRadio !== 'undefined' && sourceRadio) { sourceRadio.agentDisponible(hote, nom); rafraichirEtat(); diffuser({ genre: 'statut' }); }
    if (typeof ecoutes !== 'undefined' && ecoutes) ecoutes.agentDisponible(hote, nom, protocole);
  },
  // Agent 1.7 : module branché sur son PC, déjà reconnu ; relié tout de suite (débranché : retour au module d'avant)
  surDirect: ({ flux, nom, source, ip, protocole, role, version }) => {
    if (protocole === 'meshcore') brancherCompanionFlux(flux, nom, source.startsWith('USB') ? 'USB' : source, role);
    else brancherModuleFlux(flux, nom, source + ' (agent)', ip, role, version);
  },
});
// Companion MeshCore (observateur de la carte) et republication sur le broker
const publicateurMc = creerPublicateurMc(config, (...a) => journal('[MeshCore]', ...a));
const companion = creerCompanion(config, {
  agents,
  journal: (...a) => journal('[MeshCore]', ...a),
  surObservation: (obs) => {
    try {
      const sortie = reseauMc.integrer(obs);
      if (sortie) diffuserSortieMc(sortie);
      const c = companion.etat();
      if (obs.observateur && config.meshcore.republier) publicateurMc.publier(obs, decoderPaquetMc(obs.brut), c);
    } catch (e) { journal('[MeshCore] observation non traitée :', e.message); }
  },
  surContacts: (liste) => { for (const ct of liste) reseauMc.importerContact(ct); planifierEtatMc(); diffuser({ genre: 'mc-noeuds' }); },
  // Canaux du companion : leurs messages sont déchiffrés aussi (en plus de ceux des réglages)
  surCanaux: () => majCanauxMc(),
  surMessage: (m) => {
    if (m.genre === 'canal') {
      // Déjà décodé depuis le paquet brut si le canal est connu ; sinon on le garde tel quel
      if (reseauMc.canaux().some((c) => c.nom === m.canal)) return;
      const i = m.texte.indexOf(': ');
      const id = reseauMc.noterMessage({ sens: 'recu', genre: 'canal', canal: m.canal, indexCanal: m.index, nomDe: i > 0 ? m.texte.slice(0, i) : null, texte: i > 0 ? m.texte.slice(i + 2) : m.texte, sauts: m.sauts, snr: m.snr });
      diffuser({ genre: 'mc-message', id, sens: 'recu', canal: m.canal, texte: i > 0 ? m.texte.slice(i + 2) : m.texte, nomDe: i > 0 ? m.texte.slice(0, i) : null, heure: Date.now() });
      return;
    }
    const c = companion.etat();
    const id = reseauMc.noterMessage({ sens: 'recu', genre: 'direct', de: m.de || null, nomDe: m.nom || m.prefixe, vers: c.cle, nomVers: c.nom, texte: m.texte, sauts: m.sauts, snr: m.snr });
    diffuser({ genre: 'mc-message', id, sens: 'recu', direct: true, de: m.de, nomDe: m.nom || m.prefixe, texte: m.texte, heure: Date.now() });
  },
  surConfirmation: ({ ack }) => { if (reseauMc.confirmerAck(ack)) diffuser({ genre: 'mc-message', confirmation: true }); },
  surEtat: () => {
    const c = companion.etat();
    if (c.cle) reseauMc.definirMoi({ cle: c.cle, nom: c.nom });
    if (c.cle) reseauMc.noterObservateur(c.cle, { nom: c.nom, role: 'companion', lat: c.lat, lon: c.lon, etat: c.connecte ? 'online' : 'offline', details: { modele: c.modele, firmware: c.firmware, radio: c.radio, iata: config.meshcore.iata, carte: true } });
    planifierEtatMc();
  },
});
// Régions reconnues dans les étiquettes des paquets : liste par défaut + MESHCORE_REGIONS + région d'envoi du companion
require('./meshcore/paquet').ajouterRegions(String(process.env.MESHCORE_REGIONS || '').split(/[,;\s]+/));
setInterval(() => { try { const z = companion.etat().zoneDefaut; if (z) require('./meshcore/paquet').ajouterRegions([z]); } catch { /* ignore */ } }, 60000);
if (config.meshcore.actif) companion.demarrer();
// Observatoires MeshCore publics (CoreScope) : paquets bruts lus sur leur API REST, traités comme un flux MQTT
const { creerCoreScope, testerCoreScope, ecrireSources: ecrireSourcesCs, INSTANCES_CONNUES: INSTANCES_CS } = require('./meshcore/corescope');
const corescope = creerCoreScope({
  ...config.meshcore.corescope,
  integrer: (obs) => { const sortie = reseauMc.integrer(obs); if (sortie) diffuserSortieMc(sortie); return sortie; },
  noterObservateur: (cle, info) => reseauMc.noterObservateur(cle, info),
  importerNoeuds: (liste) => { reseauMc.importerContacts(liste); diffuser({ genre: 'mc-noeuds' }); },
  apres: () => planifierEtatMc(),
  journal: (...a) => journal('[MeshCore]', ...a),
});
if (config.meshcore.actif) corescope.demarrer();
// Canaux MeshCore déchiffrés : ceux des réglages, plus ceux lus dans le companion principal et les companions en écoute
function majCanauxMc() {
  const tous = [...canauxMc];
  const sources = [companion, ...(typeof ecoutes !== 'undefined' && ecoutes ? ecoutes.companions() : [])];
  for (const src of sources) {
    for (const c of preparerCanauxMc(src.secretsCanaux().map((x) => ({ nom: x.nom, secret: x.secret })))) if (!tous.some((y) => y.secret === c.secret)) tous.push(c);
  }
  reseauMc.definirCanaux(tous);
}
// Companion MeshCore en écoute (en plus du principal) : observateur supplémentaire, rien n'est envoyé par lui
function fabriquerCompanionEcoute({ cible, nom }) {
  let inst = null;
  inst = creerCompanion(config, {
    agents,
    journal: (...a) => journal(`[MeshCore · écoute ${nom || ''}]`, ...a),
    surObservation: (obs) => {
      try {
        const sortie = reseauMc.integrer(obs);
        if (sortie) diffuserSortieMc(sortie);
        if (obs.observateur && config.meshcore.republier && inst) publicateurMc.publier(obs, decoderPaquetMc(obs.brut), inst.etat());
      } catch (e) { journal('[MeshCore] observation non traitée :', e.message); }
    },
    surContacts: (liste) => { for (const ct of liste) reseauMc.importerContact(ct); planifierEtatMc(); diffuser({ genre: 'mc-noeuds' }); },
    surCanaux: () => majCanauxMc(),
    surMessage: (m) => {
      if (m.genre !== 'direct' || !inst) return; // messages de canal : déjà décodés depuis les paquets bruts
      const c = inst.etat();
      const id = reseauMc.noterMessage({ sens: 'recu', genre: 'direct', de: m.de || null, nomDe: m.nom || m.prefixe, vers: c.cle, nomVers: c.nom, texte: m.texte, sauts: m.sauts, snr: m.snr });
      diffuser({ genre: 'mc-message', id, sens: 'recu', direct: true, de: m.de, nomDe: m.nom || m.prefixe, vers: c.cle, nomVers: c.nom, texte: m.texte, heure: Date.now() });
    },
    surEtat: () => {
      if (!inst) return;
      const c = inst.etat();
      if (c.cle) reseauMc.noterObservateur(c.cle, { nom: c.nom, role: 'companion', lat: c.lat, lon: c.lon, etat: c.connecte ? 'online' : 'offline', details: { modele: c.modele, firmware: c.firmware, radio: c.radio, iata: config.meshcore.iata, carte: true, ecoute: true } });
      planifierEtatMc();
    },
  }, { ecoute: { cible } });
  return inst;
}
const adminMc = creerAdministrationMc(config, companion, reseauMc, (...a) => journal('[MeshCore]', ...a), (t) => { if (['statut', 'lire', 'chemin', 'voisins', 'tracer', 'telemetrie'].includes(t.type)) { planifierEtatMc(); diffuser({ genre: 'mc-noeuds' }); } });
// Capteurs MeshCore : relevés périodiques, historique, libellés personnalisés
const reqNomMc = stockage.db.prepare('SELECT nom FROM mc_noeuds WHERE cle = ?');
function nomNoeudMc(cle) { try { const r = reqNomMc.get(cle); return r && r.nom; } catch { return null; } }
const capteursMc = require('./meshcore/capteurs').creerCapteursMc({ db: stockage.db, config, adminMc, companion, journal: (...a) => journal('[MeshCore]', ...a) });
adminMc.ecouterTelemetrie((cle, mesures) => capteursMc.noter(cle, mesures));
app.get('/api/mc/capteurs/:cle', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const cle = String(req.params.cle).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(cle)) return res.status(400).json({ erreur: 'clé invalide' });
  res.set('Cache-Control', 'no-store').json({ ...capteursMc.lire(cle, Math.min(Math.max(Number(req.query.jours) || 7, 1), 90)), peutRegler: peutGerer(req, cle) });
});
app.get('/api/mc/capteurs/:cle/csv', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const cle = String(req.params.cle).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(cle)) return res.status(400).json({ erreur: 'clé invalide' });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="capteurs-${cle.slice(0, 8)}.csv"`).send(capteursMc.csv(cle, Math.min(Math.max(Number(req.query.jours) || 90, 1), 90)));
});
app.post('/api/mc/capteurs/:cle', (req, res) => {
  const cle = String(req.params.cle).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(cle)) return res.status(400).json({ erreur: 'clé invalide' });
  if (!peutGerer(req, cle)) return refuserSecteur(res);
  try { res.json(capteursMc.regler(cle, req.body || {})); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Remise à zéro des capteurs d'un nœud (historique et/ou libellés, seuils, masquage), ou d'une seule mesure
app.post('/api/mc/capteurs/:cle/reinitialiser', (req, res) => {
  const cle = String(req.params.cle).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(cle)) return res.status(400).json({ erreur: 'clé invalide' });
  if (!peutGerer(req, cle)) return refuserSecteur(res);
  try { res.json(capteursMc.reinitialiser(cle, req.body || {})); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
const { creerMaintenanceMc } = require('./meshcore/maintenance');
const maintenanceMc = creerMaintenanceMc({ config, reseauMc, adminMc, companion, journal, auditMc });
app.get('/api/mc/maintenance', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const r = maintenanceMc.etat();
  if (!estAdmin(req)) r.noeuds = r.noeuds.filter((n) => peutGerer(req, n.cle));
  res.set('Cache-Control', 'no-store').json(r);
});
app.post('/api/mc/maintenance/configuration', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(maintenanceMc.importerConfiguration(req.body || {}, u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/mc/maintenance/conformite', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  try {
    const c = maintenanceMc.regler(req.body || {});
    if ((req.body || {}).maintenant) return res.json({ ...c, tache: maintenanceMc.lancer(u.identifiant).id });
    res.json(c);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
const sourceRadio = creerSourceRadio(stockage, config, canaux, {
  integrerEvenement: (evt) => {
    if (evt.port === 'waypoint' && evt.pointRepere) { try { signalements.recu(evt); } catch { /* pas encore prêt */ } }
    versPasserelleRadio(evt);
    if (evt.port === 'texte' && evt.texte && /^Pager ACK/i.test(evt.texte)) { try { signalements.texteRecu(evt); } catch { /* pas encore prêt */ } } if (evt.port === 'texte' && evt.texte) { try { equipes.texteRecu(evt); } catch { /* pas encore prêt */ } } if (evt.port === 'texte' && evt.texte) { try { adrasec.texteRecu(evt); } catch { /* pas encore prêt */ } } crisePaquet(evt);
    if (evt.port === 'position' && evt.position && evt.position.lat != null) { try { const d = administration.reponsePosition(evt.de); if (d != null) diffuserMembres({ genre: 'position-reponse', num: evt.de >>> 0, lat: evt.position.lat, lon: evt.position.lon, delai: d }); } catch { /* pas encore prêt */ } }
    const sortie = reseau.integrer(evt);
    try { autresPresets.noterPaquet(evt); } catch { /* pas encore prêt */ }
    if (sortie) { compteur.decodes++; diffuser({ ...sortie, viaRadio: true }); }
  },
  apresSynchro: () => { rafraichirEtat(); diffuser({ genre: 'statut' }); },
  estSurveille: (n) => reseau.estSurveille(n),
}, agents);
// Résumé public des modules Meshtastic en écoute (sources de données)
function resumeEcoutes() { try { return ecoutes.liste().meshtastic.map((x) => ({ nom: x.nom, connecte: x.connecte, paquets: x.paquets, noeud: x.noeud ?? null })); } catch { return []; } }
// Modules en écoute (Meshtastic et MeshCore), en plus des modules principaux
const { creerEcoutes } = require('./ecoutes');
let minuterieStatutEcoute = null;
const ecoutes = creerEcoutes({
  config, journal,
  fabriquerRadio: (m) => creerSourceRadio(stockage, config, canaux, {
    integrerEvenement: (evt) => {
      if (evt.port === 'waypoint' && evt.pointRepere) { try { signalements.recu(evt); } catch { /* pas encore prêt */ } }
    versPasserelleRadio(evt);
    if (evt.port === 'texte' && evt.texte && /^Pager ACK/i.test(evt.texte)) { try { signalements.texteRecu(evt); } catch { /* pas encore prêt */ } } if (evt.port === 'texte' && evt.texte) { try { equipes.texteRecu(evt); } catch { /* pas encore prêt */ } } if (evt.port === 'texte' && evt.texte) { try { adrasec.texteRecu(evt); } catch { /* pas encore prêt */ } } crisePaquet(evt);
    if (evt.port === 'position' && evt.position && evt.position.lat != null) { try { const d = administration.reponsePosition(evt.de); if (d != null) diffuserMembres({ genre: 'position-reponse', num: evt.de >>> 0, lat: evt.position.lat, lon: evt.position.lon, delai: d }); } catch { /* pas encore prêt */ } }
    const sortie = reseau.integrer(evt);
    try { autresPresets.noterPaquet(evt); } catch { /* pas encore prêt */ }
      if (sortie) { compteur.decodes++; diffuser({ ...sortie, viaRadio: true }); }
    },
    apresSynchro: () => { if (!minuterieStatutEcoute) minuterieStatutEcoute = setTimeout(() => { minuterieStatutEcoute = null; rafraichirEtat(); diffuser({ genre: 'statut' }); }, 3000); },
  }, agents, { ecoute: m }),
  fabriquerCompanion: (o) => fabriquerCompanionEcoute(o),
  surChangement: () => { diffuser({ genre: 'statut' }); if (config.meshcore.actif) { majCanauxMc(); planifierEtatMc(); } },
});
ecoutes.demarrer();
const administration = creerAdministration(sourceRadio, stockage);
// ---- Équipes : canal chiffré par équipe, posé ou retiré à distance (administrateur) ----
const reqPosEquipe = stockage.db.prepare('SELECT lat, lon, heure_position FROM noeuds WHERE num = ?');
const equipes = require('./equipes').creerEquipes({ config, administration, journal,
  diffuser: (m) => {
    if (m.genre !== 'equipe-sos') return diffuser(m);
    diffuserMembres(m);
    try { urgence.noter({ cle: `equipe-sos:${m.equipe}:${m.id}`, type: 'sos', niveau: 'critique', texte: `Demande d’aide de ${m.nom} (équipe ${m.nomEquipe}) : ${m.texte}`, noeud: m.num, lat: m.position ? m.position.lat : null, lon: m.position ? m.position.lon : null }); } catch { /* urgence pas encore prête */ }
  },
  surZone: (id, zone, auteur) => secteursAlerte.zoneEquipe(id, zone, auteur),
  secteursDe: (id) => secteursAlerte.resumeEquipe(id),
  surSuppression: (id) => { const n = secteursAlerte.equipeSupprimee(id); if (n) { journal(`[Secteurs] ${n} secteur(s) désactivé(s) : équipe supprimée`); planifierRafraichir(); } },
  nomDe: (n) => { const r = reqNomSig.get(n >>> 0); return r && (r.nom_long || r.nom_court); }, positionDe: (num) => { try { const r = reqPosEquipe.get(num >>> 0); return r && r.lat != null ? { lat: r.lat, lon: r.lon, heure: r.heure_position || 0 } : null; } catch { return null; } } });
const routeEquipe = (f) => (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.set('Cache-Control', 'no-store').json(f(req, req.body || {}, nomCompte(utilisateur(req)))); } catch (e) { res.status(400).json({ erreur: e.message }); }
};
// Démonstration (visiteur sans compte) : ni demandes d'aide, ni positions des intervenants, ni secteurs, ni zones
const equipeDemo = (e) => ({ ...e, sos: [], secteurs: [], zone: null, recherche: null, membres: e.membres.map((m) => ({ ...m, position: null, horsZone: false })) });
app.get('/api/equipes', routeEquipe((req) => ({ equipes: req.demoLecture ? equipes.liste().map(equipeDemo) : equipes.liste(), sourceCle: equipes.sourceCle(), module: administration.infos() })));
app.post('/api/equipes', routeEquipe((req, b, a) => equipes.creer(b, a)));
app.patch('/api/equipes/:id', routeEquipe((req, b, a) => equipes.modifier(req.params.id, b, a)));
app.post('/api/equipes/:id/membres', routeEquipe((req, b, a) => equipes.membres(req.params.id, b, a)));
app.post('/api/equipes/:id/reappliquer', routeEquipe((req, b, a) => equipes.reappliquer(req.params.id, a)));
app.post('/api/equipes/:id/recherche', routeEquipe((req, b, a) => equipes.recherche(req.params.id, b, a)));
app.post('/api/equipes/:id/sos/:sid', routeEquipe((req, b, a) => equipes.prendreSos(req.params.id, req.params.sid, a)));
app.post('/api/equipes/:id/nouvelle-cle', routeEquipe((req, b, a) => {
  if (b.confirmation !== 'NOUVELLE CLE') throw new Error('Confirmation manquante : tapez « NOUVELLE CLE »');
  return equipes.nouvelleCle(req.params.id, a);
}));
app.delete('/api/equipes/:id', routeEquipe((req, b, a) => equipes.supprimer(req.params.id, { retirerDesNoeuds: b.retirerDesNoeuds !== false }, a)));
app.get('/api/equipes/:id/export', routeEquipe((req, b, a) => {
  const x = equipes.exporter(req.params.id);
  audit.noter(a, req.ip, 'Équipes : clé exportée', `canal « ${x.nom} » (empreinte ${x.empreinte})`, true);
  journal(`[Équipes] clé du canal « ${x.nom} » exportée par ${a}`);
  return x;
}));
const reqNomSig = stockage.db.prepare('SELECT nom_court, nom_long FROM noeuds WHERE num = ?');
// ---- Secteurs d'alerte (géorepérage) des équipes de terrain : voir secteurs.js ----------------------------------
const { RE_SOS } = require('./equipes');
let minutRafraichir = null;
const planifierRafraichir = () => { if (!minutRafraichir) minutRafraichir = setTimeout(() => { minutRafraichir = null; rafraichirEtat(); }, 1500); };
const secteursAlerte = require('./secteurs').creerSecteurs({
  config, journal,
  diffuser: (m) => (m.genre === 'secteurs' ? diffuser(m) : diffuserMembres(m)),
  membresEquipe: (id) => equipes.membresDe(id),
  nomEquipe: (id) => equipes.nomDe(id),
  nomDe: (k) => (k.startsWith('mt:') ? nomNoeudServeur(Number(k.slice(3))) : nomNoeudMc(k.slice(3)) || null),
  positionDe: (num) => { const r = reqPosEquipe.get(num >>> 0); return r && r.lat != null ? { lat: r.lat, lon: r.lon, heure: r.heure_position || 0 } : null; },
  // Option d'un secteur : alerte courte sur un canal LoRa (module de la carte), au plus une toutes les 30 s
  envoyerLora: (texte, canal) => administration.envoyerTexte({ texte, canal }, 'secteurs'),
  suiviMinDe: (id) => equipes.suiviDe(id),
  // Dernière réception d'un paquet, toutes sources (MQTT, module radio, agents, UDP) : sans rien depuis 10 min, la
  // surveillance des pertes de contact est suspendue (c'est la carte qui n'entend plus, pas les intervenants)
  derniereReception: () => Math.max(statsMqtt.dernierMessage || 0, dernierPaquetCrise),
  // Au premier signe de sortie, position fraîche demandée au nœud (une fois par 10 min) : l'alerte n'attend pas le prochain suivi
  demanderPosition: (num, motif) => administration.demanderPosition(num, motif),
  surEvenement: (e) => {
    if ((['sortie', 'entree', 'silence'].includes(e.type) && e.alerte !== false) || ['imprecise', 'perimee', 'flux', 'flux-retour', 'desactivation'].includes(e.type)) planifierRafraichir();
    if (['creation', 'modification', 'suppression', 'imprecise', 'perimee', 'desactivation'].includes(e.type) && !urgence.actif()) return;
    const genre = e.type === 'sortie' ? 'dehors' : e.type === 'entree' ? 'dedans' : e.type;
    const noeud = e.noeud && e.noeud.startsWith('mt:') ? Number(e.noeud.slice(3)) : e.noeud ? e.noeud.slice(3) : null;
    urgence.noter({ cle: `secteur:${e.secteur}:${e.noeud}:${genre}:${e.heure}`, type: 'secteur', niveau: e.niveau, texte: e.message, noeud, lat: e.lat ?? null, lon: e.lon ?? null, auteur: e.auteur || null });
  },
});
reseauMc.ecouterPositions((p) => secteursAlerte.position('mc:' + p.cle, { lat: p.lat, lon: p.lon, heure: p.heure, id: p.id }));
// Anciennes zones de sécurité des équipes (cercle) : reprises une fois en secteurs d'alerte rattachés à l'équipe
{
  const m = equipes.zonesAMigrer();
  let ok = true;
  for (const z of m.liste) {
    try { secteursAlerte.zoneEquipe(z.id, z.zone, 'reprise automatique'); journal(`[Secteurs] zone de sécurité de l’équipe « ${z.nom} » reprise en secteur d’alerte`); } catch (e) { ok = false; journal('[Secteurs] zone de sécurité non reprise :', e.message); }
  }
  if (m.liste.length && ok && !m.valider()) journal('[Secteurs] zones de sécurité reprises, mais le fichier des équipes n’a pas pu être mis à jour : elles seront reprises de nouveau au prochain démarrage (secteur existant mis à jour, pas dupliqué)');
}
// ---- Mode urgence : configuration de crise de la carte, voir urgence.js ----------------------------------------
const urgence = require('./urgence').creerUrgence({ config, journal, diffuser: diffuserMembres });
modulesCrisePrets = true; // à partir d'ici, une ReferenceError dans crisePaquet est un vrai bug, journalisé
// Pendant une crise, l'état du réseau (alertes, compteurs) part toutes les 10 s au lieu de 30 s
setInterval(() => { try { if (urgence.actif()) rafraichirEtat(); } catch (e) { journal('[Urgence]', e.message); } }, 10000).unref();
const OUTILS_CRISE = ['signalements', 'main-courante']; // remis en service pendant une crise s'ils étaient masqués
// Alertes critiques nouvelles notées au journal de la crise (chacune une seule fois)
// Sur un gros flux (carte monde), les centaines d'alertes « muet » de nœuds lointains restent hors du journal de crise :
// seules celles des nœuds concernés (surveillés, dans la zone, membres d'équipe), des secteurs et des équipes y entrent
function noterAlertesCrise(l) {
  for (const a of l) {
    if (a.niveau !== 'critique' || a.type === 'urgence') continue;
    if (a.type !== 'secteur' && a.type !== 'equipe' && a.type !== 'service' && a.noeud != null && typeof a.noeud === 'number' && !noeudConcerne(a.noeud)) continue;
    urgence.noter({ cle: a.cle || `${a.type}:${a.noeud ?? a.num ?? a.nom}:${a.depuis || ''}`, type: a.type === 'secteur' ? 'secteur' : 'alerte', niveau: 'critique', texte: a.message, noeud: a.noeud ?? null });
  }
}
function tableauCrise() {
  let eqs = [];
  try { eqs = equipes.liste(); } catch { /* équipes illisibles */ }
  const sos = [], membres = [];
  for (const e of eqs) {
    for (const x of e.sos) if (!x.pris) sos.push({ id: x.id, num: x.num, nom: x.nom, texte: x.texte, heure: x.heure, position: x.position, equipe: e.id, nomEquipe: e.nom });
    for (const m of e.membres) if (m.etat === 'membre') membres.push({ num: m.num, nom: nomNoeudServeur(m.num), equipe: e.nom, position: m.position, sansNouvelle: m.sansNouvelle });
  }
  const secteurs = secteursAlerte.liste().filter((s) => s.actif).map((s) => ({ id: s.id, nom: s.nom, forme: s.forme, centre: s.centre, rayon: s.rayon, points: s.points, sens: s.sens, nomEquipe: s.nomEquipe, dehors: s.dehors,
    membres: s.membres.filter((m) => m.derniere || m.silence).map((m) => ({ cle: m.cle, nom: m.nom, etat: m.etat, silence: m.silence, derniere: m.derniere })) }));
  return {
    sos, membres, secteurs, alertesSecteurs: secteursAlerte.alertes(),
    critiques: [...dernieresAlertes, ...(config.meshcore.actif ? alertesMc : [])].filter((a) => a.niveau === 'critique' && a.type !== 'urgence' && a.type !== 'secteur' && a.type !== 'equipe').slice(0, 30),
    evenements: urgence.evenements(null, 150), archives: urgence.archives(),
  };
}
const routeGestion = (f, ecriture) => (req, res) => {
  const u = utilisateur(req);
  if (!estGestion(req) || (ecriture && !u)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  try { res.set('Cache-Control', 'no-store').json(f(req, req.body || {}, nomCompte(u) || 'démonstration')); } catch (e) { res.status(400).json({ erreur: e.message }); }
};
const routeAdminSecteur = (f) => (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.set('Cache-Control', 'no-store').json(f(req, req.body || {}, nomCompte(u))); } catch (e) { res.status(400).json({ erreur: e.message }); }
};
app.get('/api/secteurs', routeGestion((req) => ({ secteurs: secteursAlerte.liste(), equipes: (() => { try { return equipes.liste().map((e) => ({ id: e.id, nom: e.nom, nbMembres: e.nbMembres })); } catch { return []; } })(), modifiable: estAdmin(req) && !req.demoLecture })));
app.post('/api/secteurs', routeAdminSecteur((req, b, a) => { const s = secteursAlerte.creer(b, a); audit.noter(a, req.ip, 'secteur d’alerte créé', s.nom, true); return s; }));
app.patch('/api/secteurs/:id', routeAdminSecteur((req, b, a) => secteursAlerte.modifier(String(req.params.id), b, a)));
app.delete('/api/secteurs/:id', routeAdminSecteur((req, b, a) => { const s = secteursAlerte.secteur(String(req.params.id)); secteursAlerte.supprimer(s.id, a); audit.noter(a, req.ip, 'secteur d’alerte supprimé', s.nom, true); planifierRafraichir(); return { ok: true }; }));
app.get('/api/secteurs/journal', routeGestion((req) => ({ evenements: secteursAlerte.journal({ secteur: req.query.secteur ? String(req.query.secteur) : null, limite: req.query.limite }) })));
app.get('/api/secteurs/journal.csv', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="journal-secteurs.csv"', 'Cache-Control': 'no-store' }).send('\ufeff' + secteursAlerte.csv({ secteur: req.query.secteur ? String(req.query.secteur) : null }));
});
app.get('/api/urgence', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const e = urgence.etat();
  res.set('Cache-Control', 'no-store').json(estGestion(req) ? { ...e, tableau: tableauCrise() } : e);
});
// Activer ou terminer le mode urgence : administrateur seulement (les gestionnaires lisent le tableau et notent au journal)
app.post('/api/urgence', (req, res, suite) => { const u = utilisateur(req); if (u && u.role === 'gestionnaire') return res.status(403).json({ erreur: 'Seul un administrateur active ou termine le mode urgence' }); suite(); }, routeAdminSecteur((req, b, a) => {
  const r = b.actif ? urgence.activer({ motif: b.motif }, a) : urgence.desactiver(a);
  audit.noter(a, req.ip, b.actif ? 'mode urgence activé' : 'mode urgence terminé', b.actif ? String(b.motif || '').slice(0, 140) : `${r.derniere.nb} événement(s)`, true);
  if (b.actif) noterAlertesCrise([...dernieresAlertes, ...(config.meshcore.actif ? alertesMc : [])]); // situation au déclenchement
  diffuser({ genre: 'fonctions-masquees', masquees: masqueesEffectives() });
  rafraichirEtat();
  return r;
}));
app.post('/api/urgence/note', routeGestion((req, b, a) => urgence.note(b.texte, a), true));
app.get('/api/urgence/journal.csv', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  try {
    const x = urgence.csv(req.query.crise ? String(req.query.crise) : null);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${x.nom}"`, 'Cache-Control': 'no-store' }).send('\ufeff' + x.texte);
  } catch (e) { res.status(404).json({ erreur: e.message }); }
});
// ---- Section ADRASEC (radiogoniométrie, main courante) et Winlink par Pat ----
// Envoi radio d'un point de passage + message (diffusion de la position estimée d'une balise aux équipes)
const radioPointAdrasec = async ({ texte, canal, ...p }) => {
  signalements.envoyerPoint({ ...p, canal });
  if (texte) { await new Promise((r) => setTimeout(r, 400)); administration.envoyerTexte({ texte: signalements.couper(texte, 200), canal }, 'ADRASEC'); }
};
const adrasec = require('./adrasec').creerAdrasec({ config, journal, diffuser, radioPoint: radioPointAdrasec, nomDe: (n) => { const r = reqNomSig.get(n >>> 0); return r && (r.nom_long || r.nom_court); }, positionDe: (num) => { try { const r = reqPosEquipe.get(num >>> 0); return r && r.lat != null ? { lat: r.lat, lon: r.lon, heure: r.heure_position || 0 } : null; } catch { return null; } } });
const winlink = require('./winlink').creerWinlink({ journal });
// ADRASEC du compte (un administrateur de la carte choisit celle qu'il consulte : ?g=43) ; membre, président
// (responsable) ou administrateur de la carte, qui règle la section même désactivée
const routeAdrasec = (f, { admin = false, licencie = false } = {}) => async (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  if (!(u.role === 'admin' || adrasec.estMembre(u))) return res.status(403).json({ erreur: 'Réservé aux membres d’une ADRASEC' });
  const G = adrasec.groupePour(u, String(req.query.g || '').slice(0, 3) || null);
  if (!G) return res.status(404).json({ erreur: 'Aucune ADRASEC créée sur cette carte : créez celle du département dans l’onglet Gestion', aucune: true });
  if (admin && !G.estResponsable(u)) return res.status(403).json({ erreur: `Réservé au président et aux responsables de ${G.g.nom}` });
  if (licencie && !G.estLicencie(u)) return res.status(403).json({ erreur: 'Réservé aux radioamateurs licenciés (indicatif validé par le président ou un administrateur)' });
  try { res.set('Cache-Control', 'no-store').json(await f(req, req.body || {}, u, G)); } catch (e) { res.status(400).json({ erreur: e.message }); }
};
app.get('/adrasec', envoyerPage('adrasec.html'));
app.get('/adrasec.html', envoyerPage('adrasec.html'));
app.get('/api/adrasec/acces', (req, res) => {
  const u = utilisateur(req), dm = adrasec.demandeDe(u), mien = adrasec.groupeDe(u);
  res.set('Cache-Control', 'no-store').json({ nom: mien ? adrasec.nomGroupe(mien) : 'ADRASEC', actif: adrasec.actif(), connecte: !!u, identifiant: u ? u.identifiant : null, indicatif: u ? u.indicatif || null : null,
    demande: dm ? { heure: dm.heure, nomGroupe: dm.nomGroupe } : null, groupes: adrasec.groupes().map((x) => ({ code: x.code, nom: x.nom })), inscriptions: config.inscriptions, acces: !!u && (u.role === 'admin' || adrasec.estMembre(u)) });
});
// Demande d'adhésion : tout compte connecté de la carte peut la faire, pour l'ADRASEC de son département ; le président l'accepte
app.post('/api/adrasec/demande', (req, res) => { const u = utilisateur(req); if (!u) return res.status(401).json({ erreur: 'Connexion requise' }); try { res.json(adrasec.demander(u, req.body || {})); } catch (e) { res.status(400).json({ erreur: e.message }); } });
app.delete('/api/adrasec/demandes/:compte', routeAdrasec((req, b, u, G) => G.refuserDemande(req.params.compte, nomCompte(u)), { admin: true }));
// ADRASEC hébergées (administrateur de la carte) : création, nom, suppression
app.put('/api/adrasec/groupes/:code', (req, res) => { const u = utilisateur(req); if (!u || u.role !== 'admin') return res.status(403).json({ erreur: 'Réservé aux administrateurs de la carte' }); try { res.json(adrasec.majGroupe(req.params.code, req.body || {}, nomCompte(u))); } catch (e) { res.status(400).json({ erreur: e.message }); } });
// Case ADRASEC de la gestion des comptes de la carte (administrateur)
// ---- Jeux de canaux (carte, ADRASEC) et passerelles des membres ---------------------------------------------------
// Une communauté décrit les canaux que ses membres doivent avoir ; un membre qui relie sa radio depuis son navigateur
// les y écrit en un clic. Les clés restent sur le serveur (chiffrées) : une page n'en voit jamais que le nom.
const jeuxCanaux = require('./jeux-canaux').creerJeuxCanaux({ config, chiffreur: equipes.chiffreur, journal });
const { planifier: planifierCanaux } = require('./jeux-canaux');
function jeuxPour(u) {
  const l = [{ ...jeuxCanaux.vue('carte', u.role === 'admin'), titre: config.carte.titre || 'Carte live', modifiable: u.role === 'admin' }];
  if (adrasec.actif()) {
    const codes = u.role === 'admin' ? adrasec.groupes().map((g) => g.code) : [adrasec.groupeDe(u)].filter(Boolean);
    for (const code of codes) {
      const G = adrasec.groupePour(u, code);
      if (G) l.push({ ...jeuxCanaux.vue('adrasec:' + code, G.estResponsable(u)), titre: G.g.nom, modifiable: G.estResponsable(u) });
    }
  }
  return l.filter((j) => j.canaux.length || j.modifiable);
}
const routeCompte = (f) => async (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { res.set('Cache-Control', 'no-store').json(await f(req, req.body || {}, u)); } catch (e) { res.status(400).json({ erreur: e.message }); }
};
app.get('/api/jeux-canaux', routeCompte((req, b, u) => ({ jeux: jeuxPour(u) })));
app.put('/api/jeux-canaux/carte', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  try { res.json(jeuxCanaux.definir('carte', (req.body || {}).canaux, nomCompte(utilisateur(req)))); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/adrasec/canaux', routeAdrasec((req, b, u, G) => ({ ...jeuxCanaux.vue('adrasec:' + G.g.code, G.estResponsable(u)), modifiable: G.estResponsable(u) })));
app.put('/api/adrasec/canaux', routeAdrasec((req, b, u, G) => jeuxCanaux.definir('adrasec:' + G.g.code, b.canaux, nomCompte(u)), { admin: true }));
// Portées qu'un compte a le droit d'écrire sur sa radio
function porteesPermises(u) {
  const l = ['carte'];
  if (adrasec.actif()) { if (u.role === 'admin') l.push(...adrasec.groupes().map((g) => 'adrasec:' + g.code)); else { const c = adrasec.groupeDe(u); if (c) l.push('adrasec:' + c); } }
  return l;
}
// Radio d'une passerelle de page, si elle appartient à ce compte (un administrateur : aussi le module principal)
function radioDePasserelle(u, hote) {
  const p = passerellesNav.get(String(hote || ''));
  if (!p || p.protocole !== 'meshtastic' || (p.compteId !== u.id && u.role !== 'admin')) throw new Error('Radio introuvable : reliez-la depuis cette page (Outils › Connecter un module)');
  const a = sourceRadio.modules().actif;
  const r = p.role === 'principal' ? (a && a.hote === hote ? sourceRadio : null) : ecoutes.radio(hote, 1);
  if (!r) throw new Error('Radio déconnectée');
  return { p, r };
}
app.get('/api/passerelle/miennes', routeCompte((req, b, u) => ({
  actif: u.role === 'admin' || passerelleMembresActive(),
  refus: refusPasserelle(req),
  passerelles: [...passerellesNav.entries()].filter(([, p]) => p.compteId === u.id).map(([hote, p]) => {
    let radio = null;
    try { if (p.protocole === 'meshtastic') { const { r } = radioDePasserelle(u, hote); const e = r.etat(); radio = { connecte: !!e.connecte && e.noeudLocal != null, noeud: e.noeudLocal, nom: e.nomLocal, paquets: e.paquets || 0, canaux: e.noeudLocal != null ? r.canauxDetail() : [] }; } } catch { /* déconnectée */ }
    return { hote, protocole: p.protocole, role: p.role, source: p.source, depuis: p.depuis, radio };
  }),
})));
app.post('/api/passerelle/canaux', routeCompte(async (req, b, u) => {
  const { p, r } = radioDePasserelle(u, b.hote);
  const permises = new Set(porteesPermises(u));
  const ajouts = [];
  for (const x of Array.isArray(b.ajouter) ? b.ajouter : []) {
    if (!permises.has(String(x.portee))) throw new Error('Jeu de canaux non autorisé pour ce compte');
    const c = jeuxCanaux.canal(String(x.portee), x.id);
    if (!c) throw new Error('Canal supprimé entre-temps : rouvrez la liste');
    if (!ajouts.some((a) => a.nom === c.nom)) ajouts.push(c);
  }
  const liberer = (Array.isArray(b.liberer) ? b.liberer : []).map(Number).filter((i) => Number.isInteger(i) && i >= 1 && i <= 7);
  if (!ajouts.length && !liberer.length) throw new Error('Rien à écrire');
  const plan = planifierCanaux(r.canauxBruts(), ajouts, liberer);
  if (plan.manque) throw new Error(`Place insuffisante : libérez encore ${plan.manque} emplacement(s)`);
  if (!plan.ops.length) return { canaux: r.canauxDetail(), journal: ['canaux déjà présents : rien à écrire'], deja: plan.deja };
  const j = [];
  const canaux = await r.ecrireCanauxLocal(plan.ops, (t) => j.push(t));
  audit.noter(nomCompte(u), req.ip, 'canaux écrits sur sa radio', `${p.source} : ${ajouts.map((a) => a.nom).join(', ')}${liberer.length ? ` ; libérés ${liberer.join(', ')}` : ''}`, true);
  return { canaux, journal: j, deja: plan.deja };
}));
app.get('/api/adrasec/roles', (req, res) => { const u = utilisateur(req); if (!u || u.role !== 'admin') return res.status(403).json({ erreur: 'Réservé aux administrateurs de la carte' }); res.set('Cache-Control', 'no-store').json(adrasec.rolesComptes()); });
app.put('/api/adrasec/roles/:compte', (req, res) => { const u = utilisateur(req); if (!u || u.role !== 'admin') return res.status(403).json({ erreur: 'Réservé aux administrateurs de la carte' }); try { res.json(adrasec.roleCompte(req.params.compte, req.body || {}, nomCompte(u))); } catch (e) { res.status(400).json({ erreur: e.message }); } });
app.get('/api/adrasec', routeAdrasec((req, b, u, G) => ({ ...adrasec.vue(u, comptes.lister(), G), winlink: { configure: winlink.actif(), autorise: winlinkAutorise(u, G), adrasec: adrasec.nomGroupe(adrasecWinlink()) } })));
// Réglages : activation de la section sur la carte (administrateur) ; nom et conservation de l'ADRASEC (président)
app.put('/api/adrasec/reglages', (req, res, next) => {
  const u = utilisateur(req), b = req.body || {};
  if (b.actif === undefined) return next();
  if (!u || u.role !== 'admin') return res.status(403).json({ erreur: 'Réservé aux administrateurs de la carte' });
  const r = adrasec.reglagesGlobaux({ actif: b.actif });
  if (b.nom === undefined && b.conservationJours === undefined) return res.json(r);
  next();
}, routeAdrasec((req, b, u, G) => (b.nom !== undefined || b.conservationJours !== undefined ? G.reglages(b) : { ok: true }), { admin: true }));
app.put('/api/adrasec/membres/:compte', routeAdrasec((req, b, u, G) => G.majMembre(req.params.compte, b, nomCompte(u), u.role === 'admin'), { admin: true }));
app.post('/api/adrasec/equipes', routeAdrasec((req, b, u, G) => G.majEquipe(null, b), { admin: true }));
app.patch('/api/adrasec/equipes/:id', routeAdrasec((req, b, u, G) => G.majEquipe(req.params.id, b), { admin: true }));
app.post('/api/adrasec/main-courante', routeAdrasec((req, b, u, G) => G.ajouterMc(u, b)));
app.get('/api/adrasec/main-courante.csv', (req, res) => {
  const u = utilisateur(req);
  const G = u && (u.role === 'admin' || adrasec.estMembre(u)) ? adrasec.groupePour(u, String(req.query.g || '').slice(0, 3) || null) : null;
  if (!G) return res.status(403).json({ erreur: 'Réservé à la section' });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="main-courante-${G.g.code}-${new Date().toISOString().slice(0, 10)}.csv"`).send(G.csvMc());
});
app.post('/api/adrasec/recherches', routeAdrasec((req, b, u, G) => G.majRecherche(null, b, u)));
app.patch('/api/adrasec/recherches/:id', routeAdrasec((req, b, u, G) => G.majRecherche(req.params.id, b, u)));
app.post('/api/adrasec/releves', routeAdrasec((req, b, u, G) => G.ajouterReleve(u, b)));
app.delete('/api/adrasec/releves/:id', routeAdrasec((req, b, u, G) => G.retirerReleve(u, req.params.id)));
app.patch('/api/adrasec/releves/:id', routeAdrasec((req, b, u, G) => G.majReleve(u, req.params.id, b)));
app.get('/api/adrasec/canaux', routeAdrasec(() => { try { return signalements.canaux().mt; } catch { return { connecte: false, canaux: [] }; } }));
app.post('/api/adrasec/recherches/:id/diffuser', routeAdrasec((req, b, u, G) => G.diffuserBalise(req.params.id, b, u)));
app.get('/api/adrasec/qr', routeAdrasec(async (req) => ({ qr: await require('qrcode').toDataURL(String(req.query.u || '').slice(0, 300), { margin: 1, width: 240 }) })));
app.post('/api/adrasec/recherches/:id/lien', routeAdrasec((req, b, u, G) => G.creerLien(req.params.id, u)));
app.delete('/api/adrasec/recherches/:id/lien', routeAdrasec((req, b, u, G) => G.couperLien(req.params.id, u)));
// Lien terrain : lecture seule, sans compte (jeton secret de 128 bits, valable jusqu'à la clôture de la recherche)
app.get('/terrain/:jeton', envoyerPage('terrain.html'));
app.get('/api/terrain/:jeton', (req, res) => {
  const v = adrasec.vueTerrain(req.params.jeton);
  if (!v) return res.status(404).json({ erreur: 'Lien terrain expiré ou recherche terminée' });
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').json(v);
});
// Boîte Winlink : réservée à l'ADRASEC qui utilise la station (PAT_ADRASEC, sinon département de la carte) et aux
// administrateurs de la carte ; rédaction et sessions : radioamateurs licenciés de cette ADRASEC
const adrasecWinlink = () => String(process.env.PAT_ADRASEC || (config.departement || {}).code || '').trim().toUpperCase();
const winlinkAutorise = (u, G) => u.role === 'admin' || G.g.code === adrasecWinlink();
const gardeWinlink = (f) => (req, b, u, G) => { if (!winlinkAutorise(u, G)) throw new Error(`La station Winlink de cette carte est réservée à ${adrasec.nomGroupe(adrasecWinlink())}`); return f(req, b, u, G); };
app.get('/api/adrasec/winlink/etat', routeAdrasec(gardeWinlink(() => winlink.etat())));
app.get('/api/adrasec/winlink/boite/:nom', routeAdrasec(gardeWinlink((req) => winlink.boite(req.params.nom))));
app.get('/api/adrasec/winlink/boite/:nom/:mid', routeAdrasec(gardeWinlink((req) => winlink.message(req.params.nom, req.params.mid))));
app.get('/api/adrasec/winlink/passerelles', routeAdrasec(gardeWinlink((req) => winlink.passerelles({ mode: String(req.query.mode || '').slice(0, 20), bande: String(req.query.bande || '').slice(0, 10) }))));
app.post('/api/adrasec/winlink/envoyer', routeAdrasec(gardeWinlink(async (req, b, u, G) => {
  const r = await winlink.envoyer({ ...b, signature: `${G.signature(u)} · ${G.g.nom}` });
  G.ajouterMc(u, { texte: `Winlink : message « ${String(b.sujet || '').slice(0, 80)} » déposé pour ${String(b.a || '').slice(0, 80)}`, type: 'message-emis' });
  return r;
}), { licencie: true }));
app.post('/api/adrasec/winlink/session', routeAdrasec(gardeWinlink(async (req, b, u, G) => {
  const r = await winlink.session(b.cible, G.signature(u));
  G.ajouterMc(u, { texte: `Winlink : session ${String(b.cible).split('?')[0]} terminée${r.recus != null ? `, ${r.recus} message(s) reçu(s)` : ''}`, type: 'information' });
  return r;
}), { licencie: true }));
// Demande de position à un ou plusieurs nœuds (gestionnaire) : le nœud répond avec sa position
app.post('/api/demander-position', async (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  const nums = [...new Set((Array.isArray((req.body || {}).nums) ? req.body.nums : []).map((x) => Number(x) >>> 0))].filter(Boolean).slice(0, 60);
  if (!nums.length) return res.status(400).json({ erreur: 'Aucun nœud' });
  if (!estAdmin(req) && nums.some((n) => !peutGerer(req, n))) return refuserSecteur(res);
  try {
    administration.demanderPosition(nums[0], u.identifiant);
    // Les suivantes espacées de 3 s pour ne pas saturer le canal
    nums.slice(1).forEach((n, i) => setTimeout(() => { try { administration.demanderPosition(n, u.identifiant); } catch { /* module coupé */ } }, (i + 1) * 3000));
    res.json({ ok: true, nb: nums.length, dureeS: (nums.length - 1) * 3 });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// ---- Mise à jour de la carte en un clic (administrateur) : service « maj » du docker-compose ----
const MAJ_URL = (process.env.MAJ_URL || 'http://maj:4405').replace(/\/+$/, '');
function jetonMaj() {
  if (process.env.MAJ_JETON && process.env.MAJ_JETON.trim()) return process.env.MAJ_JETON.trim();
  try { return fs.readFileSync(path.join(path.dirname(config.fichierBase), 'maj-jeton.txt'), 'utf8').trim(); } catch { return null; }
}
async function appelMaj(methode, chemin) {
  const jeton = jetonMaj();
  if (!jeton) throw new Error('service de mise à jour non installé');
  const r = await fetch(MAJ_URL + chemin, { method: methode, headers: { Authorization: 'Bearer ' + jeton }, signal: AbortSignal.timeout(5000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erreur || 'HTTP ' + r.status);
  return j;
}
// Programmations à distance en cours (Meshtastic ou MeshCore) : une mise à jour les couperait
function tachesEnCours() {
  let n = 0;
  try { n += administration.taches().filter((t) => !t.fin).length; } catch { /* aucune */ }
  try { n += adminMc.taches().filter((t) => !t.fin && t.type !== 'telemetrie').length; } catch { /* aucune */ }
  return n;
}
// Détail des programmations en cours, pour décider de forcer ou non la mise à jour : quoi, sur quels nœuds,
// où elle en est, et si elle reprendra d'elle-même après le redémarrage de la carte
function tachesDetail() {
  const l = [];
  const nomMt = (num) => { const n = stockage.q.noeud ? stockage.q.noeud.get(num) : null; return (n && (n.nom_long || n.nom_court)) || '!' + (num >>> 0).toString(16); };
  try {
    for (const t of administration.taches().filter((x) => !x.fin)) {
      const faits = t.noeuds.filter((n) => ['ok', 'echec', 'annule'].includes(n.statut)).length, cours = t.noeuds.find((n) => n.statut === 'en_cours');
      l.push({ reseau: 'Meshtastic', nom: t.nom || t.type, auteur: t.auteur, debut: t.debut, avancement: `${faits}/${t.noeuds.length} nœud(s)`,
        courant: cours ? `${nomMt(cours.num)}${cours.detail ? ' : ' + cours.detail : ''}` : (t.noeuds.find((n) => n.statut === 'en_attente') ? 'en attente du prochain nœud' : null),
        reprise: t.type === 'firmware' ? 'non : une mise à jour de firmware interrompue est à relancer' : Date.now() - t.debut < 6 * 3600000 ? 'oui, reprend toute seule après le redémarrage' : 'non (trop ancienne)' });
    }
  } catch { /* aucune */ }
  try {
    for (const t of adminMc.taches().filter((x) => !x.fin && x.type !== 'telemetrie')) {
      const total = (t.cles || []).length, faits = Object.keys(t.resultats || {}).length;
      l.push({ reseau: 'MeshCore', nom: t.type, auteur: t.auteur, debut: t.debut || t.creee, avancement: `${faits}/${total} relais`,
        courant: t.courant ? ((t.noms || {})[t.courant] || String(t.courant).slice(0, 8)) : t.prochainEssai ? 'en attente d’un nouvel essai' : t.statut,
        reprise: t.type === 'motdepasse' ? 'non : un changement de mot de passe interrompu est à relancer' : 'oui, reprend toute seule après le redémarrage' });
    }
  } catch { /* aucune */ }
  return l;
}
app.get('/api/maj', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  // Fenêtre « Mise à jour » ouverte : on redemande la dernière version à GitHub (au plus une fois par minute)
  if (Date.now() - (majDispo.verifie || 0) > 60000) await verifierDerniereVersion();
  const v = infosVersion();
  try { res.json({ ...v, installe: true, service: await appelMaj('GET', '/etat'), taches: tachesEnCours(), tachesDetail: tachesDetail() }); } catch (e) { res.json({ ...v, installe: false, raison: e.message, taches: tachesEnCours(), tachesDetail: tachesDetail() }); }
});
app.post('/api/maj', async (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
  const n = tachesEnCours();
  if (n && !(req.body || {}).forcer) return res.status(409).json({ erreur: `${n} programmation(s) à distance en cours : attendez la fin, ou forcez (elles seront interrompues)`, taches: n });
  try {
    await appelMaj('POST', '/mettre-a-jour');
    journal(`[Mise à jour] lancée par ${u.identifiant} (v${VERSION} → ${majDispo.version || 'dernière image'})`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// ---- Diagnostic « Pourquoi ça ne marche pas ? » (administrateur) : contrôles en clair, avec la marche à suivre ----
app.get('/api/diagnostic', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const l = [];
  const ajouter = (groupe, etat, titre, detail, action) => l.push({ groupe, etat, titre, detail: detail || '', action: action || null });
  const t = Date.now();
  // Carte MeshCore seule : vue MeshCore choisie, ou aucun paquet Meshtastic depuis 7 jours et aucun module Meshtastic
  let mtAbsent = req.query.reseau === 'meshcore';
  if (!mtAbsent) { try { mtAbsent = !sourceRadio.infos().connecte && !stockage.db.prepare('SELECT 1 FROM paquets WHERE heure >= ? LIMIT 1').get(t - 7 * 86400000); } catch { /* table absente */ } }
  // MQTT
  const mqttOk = !!statsMqtt.depuis;
  if (!config.mqtt.url) ajouter('MQTT', 'info', 'Aucun serveur MQTT réglé', 'La carte ne reçoit que ce que captent ses modules.', 'mqtt');
  else if (!mqttOk) ajouter('MQTT', 'ko', 'Serveur MQTT non connecté', statsMqtt.derniereErreur ? 'Dernière erreur : ' + statsMqtt.derniereErreur.message : 'Vérifiez l’adresse, l’identifiant et le mot de passe.', 'mqtt');
  else {
    ajouter('MQTT', 'ok', 'Serveur MQTT connecté', `depuis ${Math.round((t - statsMqtt.depuis) / 60000)} min`);
    const age = statsMqtt.dernierMessage ? t - statsMqtt.dernierMessage : null;
    if ((age == null || age > 15 * 60000) && mtAbsent) ajouter('MQTT', 'info', 'Pas de trafic Meshtastic', 'Normal si cette carte ne suit que MeshCore.');
    else if (age == null || age > 15 * 60000) ajouter('MQTT', 'attention', 'Aucun message Meshtastic reçu depuis 15 min', `La carte écoute ${config.mqtt.racine}/#. Vérifiez le sujet racine, et que des passerelles publient sur ce serveur (uplink activé sur leurs canaux).`, 'mqtt');
    else ajouter('MQTT', 'ok', 'Des messages Meshtastic arrivent', `dernier il y a ${Math.round(age / 1000)} s`);
  }
  // Canaux Meshtastic : part de paquets non déchiffrés sur 1 h
  try {
    const r = stockage.db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN dechiffre = 0 THEN 1 ELSE 0 END) c FROM paquets WHERE heure >= ?').get(t - 3600000);
    if (r.n >= 20) {
      const pct = Math.round((r.c || 0) / r.n * 100);
      if (pct >= 50) ajouter('Canaux Meshtastic', 'attention', `${pct} % des paquets ne sont pas déchiffrés`, `La carte connaît ${config.canaux.map((c) => c.nom).join(', ')}. Ajoutez les canaux manquants avec leur clé (même nom et même clé que sur les nœuds). Les messages directs restent toujours illisibles.`, 'canaux');
      else ajouter('Canaux Meshtastic', 'ok', `${100 - pct} % des paquets sont déchiffrés`, `canaux : ${config.canaux.map((c) => c.nom).join(', ')}`);
    }
  } catch { /* table absente */ }
  // Module Meshtastic
  const ri = sourceRadio.infos(), re = sourceRadio.etat();
  if (mtAbsent && !ri.connecte) { /* carte MeshCore seule : rien à signaler côté Meshtastic */ } else if (ri.connecte) ajouter('Module Meshtastic', 'ok', `Module relié : ${re.nomLocal || ''}`, `canaux ${(ri.canaux || []).map((c) => c.nom || c.index).join(', ')}`);
  else ajouter('Module Meshtastic', 'info', 'Aucun module Meshtastic relié', 'Sans module : pas d’envoi de message, de signalement ni de programmation à distance. La lecture par MQTT fonctionne quand même.', 'module');
  // MeshCore
  if (config.meshcore.actif) {
    const c = companion.etat();
    if (c.pret) ajouter('MeshCore', 'ok', `Module MeshCore relié : ${c.nom || ''}`, `canaux ${(companion.canaux() || []).map((x) => x.nom).join(', ') || 'aucun'}`);
    else ajouter('MeshCore', 'info', 'Aucun module MeshCore (companion) relié', 'Sans lui : pas d’envoi MeshCore ni de passerelle. La lecture par les observateurs MQTT fonctionne quand même.', 'companion');
    const recus = compteurMc.recusMqtt || 0, hors = compteurMc.horsPerimetre || 0;
    if (mqttOk && !recus) ajouter('MeshCore', 'attention', 'Aucun paquet MeshCore reçu par MQTT', `La carte écoute ${config.meshcore.racine}/# sur le même serveur MQTT. Vérifiez que des observateurs MeshCore y publient, et la racine des sujets.`, 'meshcore');
    else if (recus && hors > 0.8 * recus) ajouter('MeshCore', 'ko', `${hors} paquets MeshCore sur ${recus} sont ignorés (hors périmètre)`, `Code de zone de la carte : ${config.meshcore.iata}. Mettez le code qu’utilisent vos observateurs, ajoutez les codes voisins, ou élargissez le périmètre.`, 'meshcore');
    else if (recus) ajouter('MeshCore', 'ok', `${compteurMc.observations || 0} paquets MeshCore gardés`, `${hors} ignorés hors périmètre · canaux déchiffrés : ${config.meshcore.canaux.join(', ')}`);
  }
  // Passerelle
  if (passerelle) {
    const v = passerelle.vue();
    if (!v.actif) ajouter('Passerelle', 'info', 'Passerelle Meshtastic ⇄ MeshCore désactivée', v.regles.length ? `${v.regles.length} liaison(s) prête(s)` : '', 'passerelle');
    else if (!v.regles.some((x) => x.actif)) ajouter('Passerelle', 'attention', 'Passerelle activée mais aucune liaison active', 'Choisissez un canal Meshtastic et un canal MeshCore à relier.', 'passerelle');
    else {
      for (const x of v.regles.filter((y) => y.actif)) {
        const mt = (v.modules.mt.canaux || []).some((k) => String(k.nom).toLowerCase() === String(x.mt.nom).toLowerCase()), mcok = (v.modules.mc.canaux || []).some((k) => String(k.nom).toLowerCase().replace(/^#/, '') === String(x.mc.nom).toLowerCase().replace(/^#/, ''));
        const lit = config.meshcore.canaux.some((k) => String(k).split('=')[0].trim().toLowerCase().replace(/^#/, '') === String(x.mc.nom).toLowerCase().replace(/^#/, ''));
        const pb = [!v.modules.mt.connecte ? 'module Meshtastic non relié' : !mt ? `le module n’a pas le canal ${x.mt.nom}` : '', !v.modules.mc.connecte ? 'module MeshCore non relié' : !mcok ? `le module MeshCore n’a pas le canal ${x.mc.nom}` : ''].filter(Boolean);
        ajouter('Passerelle', pb.length ? 'ko' : 'ok', x.libelle, pb.length ? pb.join(' ; ') : `${v.stats.mt2mc} relayés MT→MC, ${v.stats.mc2mt} MC→MT${lit ? '' : ' · le canal MeshCore n’est pas dans les canaux déchiffrés de la carte'}`, 'passerelle');
      }
    }
  }
  // Feux actifs : NASA FIRMS (sans compte) et Meteosat (compte LSA SAF gratuit)
  if (!fonctionMasquee('feux')) {
    const fe = feux.etat(1);
    if (fe.erreur && !fe.maj) ajouter('Feux actifs', 'attention', 'NASA FIRMS illisible', fe.erreur);
    else ajouter('Feux actifs', 'ok', 'NASA FIRMS lu', fe.maj ? new Date(fe.maj).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : 'première lecture en cours');
    if (!fe.meteosat.actif) ajouter('Feux actifs', 'info', 'Meteosat non configuré', 'Détection toutes les 15 min : créez un compte gratuit sur mokey.lsasvcs.ipma.pt (LSA SAF, EUMETSAT), puis mettez LSASAF_UTILISATEUR et LSASAF_MOT_DE_PASSE dans le .env.');
    else if (fe.meteosat.erreur) ajouter('Feux actifs', 'attention', 'Meteosat illisible', fe.meteosat.erreur);
    else ajouter('Feux actifs', 'ok', 'Meteosat lu', fe.meteosat.dernierFichier ? `dernière image ${fe.meteosat.dernierFichier.slice(8, 10)}:${fe.meteosat.dernierFichier.slice(10, 12)} UTC` : 'première lecture en cours');
  }
  // Mise à jour
  const iv = infosVersion();
  if (iv.majDisponible) ajouter('Mise à jour', 'attention', `Version ${iv.derniere} disponible (installée : ${iv.version})`, '', 'maj'); else ajouter('Mise à jour', 'ok', `Version ${iv.version}${iv.derniere ? ', à jour' : ''}`, majDispo.erreur ? 'GitHub injoignable : ' + majDispo.erreur : '');
  try { await appelMaj('GET', '/etat'); ajouter('Mise à jour', 'ok', 'Mise à jour en un clic disponible', ''); } catch (e) { ajouter('Mise à jour', 'info', 'Mise à jour en un clic non installée', 'Ajoutez le service « maj » au docker-compose (wiki, page Installation).', 'maj'); }
  // Données
  try { const st = fs.statSync(config.fichierBase); ajouter('Données', 'ok', `Base : ${Math.round(st.size / 1048576)} Mo`, `conservation ${config.retentionJours} jours`); } catch { /* ignoré */ }
  try { const d = fs.statfsSync(path.dirname(config.fichierBase)); const libre = d.bavail * d.bsize / 1073741824; ajouter('Données', libre < 1 ? 'ko' : libre < 3 ? 'attention' : 'ok', `Disque : ${libre.toFixed(1)} Go libres`, libre < 3 ? 'Libérez de la place : la carte s’arrête si le disque est plein.' : ''); } catch { /* ignoré */ }
  res.set('Cache-Control', 'no-store').json({ controles: l, heure: t });
});
// ---- Sauvegarde complète (administrateur) : tout le dossier de données en un fichier tar.gz ----
// Base copiée proprement (VACUUM INTO), relief et fonds de carte exclus (ils se retéléchargent tout seuls).
app.get('/api/sauvegarde-complete', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const d = path.dirname(config.fichierBase), copie = path.join(d, 'carte-live.sauvegarde.db');
  try { fs.unlinkSync(copie); } catch { /* absente */ }
  try { stockage.db.exec(`VACUUM INTO '${copie.replace(/'/g, "''")}'`); } catch (e) { return res.status(500).json({ erreur: 'copie de la base impossible : ' + e.message }); }
  const base = path.basename(config.fichierBase);
  const exclus = ['mnt*.bin', 'mnt*.json', 'sommets-osm*.json', 'acces-sommets*.json', 'communes*.json', 'realisme*.json', 'firmware', 'sauvegardes', '*.part', base, base + '-wal', base + '-shm', 'maj-jeton.txt', 'restauration-en-attente', 'avant-restauration-*', 'restauration.tar.gz', '*.tmp', '*.bak'];
  journal(`[Sauvegarde] sauvegarde complète téléchargée par ${utilisateur(req).identifiant}`);
  res.set('Content-Type', 'application/gzip').set('Content-Disposition', `attachment; filename="carte-live-complete-${new Date().toISOString().slice(0, 10)}.tar.gz"`);
  const { spawn } = require('child_process');
  // La copie de la base reprend son nom d'origine dans l'archive
  const t = spawn('tar', ['-czf', '-', '-C', d, ...exclus.map((x) => '--exclude=./' + x), '--transform', `s|^\\./carte-live\\.sauvegarde\\.db$|./${base}|`, '.']);
  t.stdout.pipe(res);
  t.stderr.on('data', (x) => journal('[Sauvegarde]', String(x).trim()));
  t.on('close', () => { try { fs.unlinkSync(copie); } catch { /* déjà */ } });
});
let restaurationEnCours = false;
// Restauration d'une sauvegarde complète envoyée depuis la page (administrateur, ou pendant l'installation sur un nouveau serveur)
app.post('/api/restauration-complete', (req, res) => {
  const enInstallation = comptes.installationRequise() && (ipPrivee(req) || (() => {
    const code = String(req.query.code || '');
    const attendu = config.admin.motDePasse || codeInstallationAuto;
    if (!code || !attendu) return false;
    const a = crypto.createHash('sha256').update(config.admin.motDePasse ? code : code.replace(/[\s-]/g, '').toUpperCase()).digest(), c = crypto.createHash('sha256').update(String(attendu)).digest();
    return crypto.timingSafeEqual(a, c);
  })());
  if (!estAdmin(req) && !enInstallation) return res.status(401).json({ erreur: comptes.installationRequise() ? 'Saisissez d’abord le code d’installation' : 'Connexion admin requise' });
  if (!estAdmin(req) && limiter(req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  const d = path.dirname(config.fichierBase), f = path.join(d, 'restauration.tar.gz');
  if (restaurationEnCours) return res.status(409).json({ erreur: 'Une restauration est déjà en cours' });
  restaurationEnCours = true;
  res.on('close', () => { restaurationEnCours = false; });
  const sortie = fs.createWriteStream(f + '.part');
  let taille = 0, fini = false;
  const echec = (code, m) => { if (fini) return; fini = true; try { sortie.destroy(); fs.unlinkSync(f + '.part'); } catch { /* déjà */ } res.status(code).json({ erreur: m }); };
  req.on('data', (b) => { taille += b.length; if (taille > 8 * 1024 ** 3) { req.destroy(); echec(413, 'fichier trop gros (8 Go au plus)'); } });
  req.pipe(sortie);
  req.on('error', () => echec(400, 'envoi interrompu'));
  sortie.on('finish', () => {
    if (fini) return;
    fini = true;
    try {
      fs.renameSync(f + '.part', f);
      const r = require('./restauration').preparer(f, d, path.basename(config.fichierBase));
      fs.unlinkSync(f);
      journal(`[Restauration] sauvegarde complète reçue (${Math.round(taille / 1048576)} Mo, ${r.fichiers} fichiers) par ${estAdmin(req) ? utilisateur(req).identifiant : 'l’installation'} : redémarrage`);
      res.json({ ok: true, fichiers: r.fichiers, redemarrage: true });
      setTimeout(() => process.exit(0), 1500); // Docker relance le conteneur, qui applique la restauration
    } catch (e) { try { fs.unlinkSync(f); } catch { /* déjà */ } res.status(400).json({ erreur: e.message }); }
  });
});
// ---- Mise à jour automatique la nuit (option, administrateur) ----
const fMajAuto = path.join(path.dirname(config.fichierBase), 'maj-auto.json');
let majAuto = { actif: false, heure: 4 };
try { majAuto = { ...majAuto, ...lireJson(fMajAuto) }; } catch { /* défaut */ }
app.get('/api/maj/auto', (req, res) => { if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); res.json(majAuto); });
app.post('/api/maj/auto', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  majAuto = { actif: !!b.actif, heure: Math.min(23, Math.max(0, Number.isFinite(Number(b.heure)) ? Math.round(Number(b.heure)) : 4)) };
  try { ecrireSur(fMajAuto, JSON.stringify(majAuto)); } catch (e) { return res.status(500).json({ erreur: e.message }); }
  journal(`[Mise à jour] automatique ${majAuto.actif ? 'activée à ' + majAuto.heure + ' h' : 'désactivée'} par ${utilisateur(req).identifiant}`);
  res.json(majAuto);
});
let dernierEssaiMajAuto = 0;
setInterval(async () => {
  if (!majAuto.actif || Date.now() - dernierEssaiMajAuto < 20 * 3600000) return;
  const h = Number(new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  if (h !== majAuto.heure) return;
  await verifierDerniereVersion();
  if (!infosVersion().majDisponible) return;
  if (tachesEnCours()) { journal('[Mise à jour] automatique reportée : programmation à distance en cours'); return; }
  dernierEssaiMajAuto = Date.now();
  try { await appelMaj('POST', '/mettre-a-jour'); journal(`[Mise à jour] automatique lancée (v${VERSION} → ${majDispo.version})`); } catch (e) { journal('[Mise à jour] automatique impossible :', e.message); }
}, 10 * 60000).unref();
// ---- Signalements : événement posé sur la carte (route inondée…) et diffusé en LoRa (membres) ----
const signalements = require('./signalements').creerSignalements({
  config, radio: sourceRadio, administration, companion, reseauMc, racine: require('./decodeur').racine,
  journal, diffuser,
  nomNoeud: (num) => { try { const r = reqNomSig.get(num >>> 0); return r && (r.nom_long || r.nom_court); } catch { return null; } },
});
// ---- Alertes officielles : vigilance Météo-France (MeteoAlarm), Vigipirate, FR-Alert relayées ----------------
// Fonctions masquées (ne garder par exemple que la vigilance météo) : FONCTIONS_MASQUEES dans le .env donne la valeur
// de départ, l'administrateur la change ensuite dans Réglages (fichier fonctions-masquees.json, sans redémarrage)
const FONCTIONS_MASQUABLES = ['signalements', 'vigipirate', 'fr-alert', 'main-courante', 'bipper', 'feux'];
const fFonctionsMasquees = path.join(path.dirname(config.fichierBase), 'fonctions-masquees.json');
let fonctionsMasquees = new Set(String(process.env.FONCTIONS_MASQUEES || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => FONCTIONS_MASQUABLES.includes(x)));
try { fonctionsMasquees = new Set(lireJson(fFonctionsMasquees).filter((x) => FONCTIONS_MASQUABLES.includes(x))); } catch { /* valeur du .env */ }
// Pendant une crise, les outils de crise masqués (signalements, main courante) reviennent ; le réglage ne change pas
function masqueesEffectives() {
  let crise = false;
  try { crise = urgence.actif(); } catch { /* pas encore créé */ }
  return [...fonctionsMasquees].filter((f) => !(crise && OUTILS_CRISE.includes(f)));
}
const fonctionMasquee = (f) => masqueesEffectives().includes(f);
app.post('/api/fonctions-masquees', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const l = Array.isArray((req.body || {}).masquees) ? req.body.masquees.filter((x) => FONCTIONS_MASQUABLES.includes(x)) : null;
  if (!l) return res.status(400).json({ erreur: 'Liste attendue' });
  fonctionsMasquees = new Set(l);
  try { ecrireSur(fFonctionsMasquees, JSON.stringify([...fonctionsMasquees])); } catch (e) { return res.status(500).json({ erreur: e.message }); }
  journal(`Fonctions masquées par ${nomCompte(utilisateur(req))} : ${l.join(', ') || 'aucune'}`);
  diffuser({ genre: 'fonctions-masquees', masquees: masqueesEffectives() });
  res.json({ masquees: [...fonctionsMasquees] });
});
const alertesOff = require('./alertes-officielles').creerAlertesOfficielles({
  config, journal, diffuser,
  // Départements suivis : ceux choisis par l'administrateur, sinon celui de la carte
  departementsSuivis: (codes) => {
    const l = (codes && codes.length ? codes : [String(config.departement.code)]).map((c) => listeDepartements.find((d) => d.code === c) || (c === String(config.departement.code) ? { code: c, nom: config.departement.nom } : null)).filter(Boolean);
    return l;
  },
  envoyerMc: async (nomCanal, texte) => {
    if (!config.meshcore.actif) throw new Error('MeshCore désactivé');
    const sans = (t) => String(t || '').toLowerCase().replace(/^#/, '');
    const c = companion.canaux().find((x) => sans(x.nom) === sans(nomCanal));
    if (!c) throw new Error(`canal « ${nomCanal} » absent du compagnon`);
    let b = Buffer.from(texte, 'utf8');
    if (b.length > 130) texte = b.subarray(0, 127).toString('utf8').replace(/\uFFFD+$/, '') + '…';
    await companion.envoyerCanal(c.index, texte);
    // Noté comme envoyé : son écho relayé par les répéteurs n'est plus compté comme un message reçu (non lu)
    const e = companion.etat();
    reseauMc.noterMessage({ sens: 'envoye', genre: 'canal', canal: c.nom, indexCanal: c.index, de: e.cle, nomDe: e.nom, texte, statut: 'envoye', auteur: 'alertes', region: e.zoneDefaut == null ? null : e.zoneDefaut || '-' });
    diffuser({ genre: 'mc-message', confirmation: true });
  },
  envoyer: async (nomCanal, texte) => {
    const i = sourceRadio.infos();
    if (!i.connecte) throw new Error('module radio non connecté');
    const c = (i.canaux || []).find((x) => String(x.nom).toLowerCase() === String(nomCanal).toLowerCase());
    if (!c) throw new Error(`canal « ${nomCanal} » absent du module`);
    let b = Buffer.from(texte, 'utf8');
    if (b.length > 200) { b = b.subarray(0, 197); texte = b.toString('utf8').replace(/\uFFFD+$/, '') + '…'; }
    return administration.envoyerTexte({ texte, canal: c.index }, 'alertes');
  },
});
app.get('/api/alertes-officielles', (req, res) => res.set('Cache-Control', 'no-store').json({ ...alertesOff.etat(), niveauxVigipirate: alertesOff.NIVEAUX_VIGIPIRATE, ...(estAdmin(req) ? { departements: listeDepartements.map((d) => ({ code: d.code, nom: d.nom })), voisins: ((zoneVoisins() || {}).departements || []).map((d) => d.code), departementCarte: String(config.departement.code), canauxMc: config.meshcore.actif ? companion.canaux().map((c) => c.nom) : [] } : {}),
  // Canaux proposés pour l'envoi à la demande (gestionnaires) : ceux du companion MeshCore et du module Meshtastic
  ...(estGestion(req) ? { envoi: (() => {
    const canauxMc2 = config.meshcore.actif ? companion.canaux().map((c) => c.nom).filter(Boolean) : [];
    let infosMt = { connecte: false, canaux: [] };
    try { infosMt = sourceRadio.infos(); } catch { /* pas de module */ }
    const canauxMt = infosMt.connecte ? (infosMt.canaux || []).map((c) => c.nom).filter(Boolean) : [];
    // Pourquoi le bouton 📡 n'apparaît pas : dit à l'écran au lieu de le cacher en silence
    const pourquoi = [];
    if (!canauxMc2.length && !canauxMt.length) {
      if (config.meshcore.actif) { let pret = false; try { pret = !!companion.etat().pret; } catch { /* */ } pourquoi.push(pret ? 'companion MeshCore relié mais sans canal nommé' : 'companion MeshCore non relié'); }
      pourquoi.push(infosMt.connecte ? 'module Meshtastic relié mais sans canal nommé' : 'module Meshtastic non relié');
    }
    return { canauxMc: canauxMc2, canauxMt, pourquoi };
  })() } : {}),
  fonctionsMasquees: [...fonctionsMasquees] }));
// ---- Feux actifs vus par satellite (NASA FIRMS) : couche de la carte, alertes sur la zone, envoi radio à la demande ----
const feux = require('./feux').creerFeux({ config, journal, diffuser });
// Couche APRS (dont LoRa APRS 433,775 MHz) : lecture seule sur APRS-IS, zone département + voisins (APRS_IS=oui)
const aprs = require('./aprs').creerAprs({ zone: () => (zoneVoisins() || {}).bbox || config.zone, journal, version: VERSION });
// Rivières : hauteurs d'eau des stations publiques Hub'Eau de la zone de la carte (ouvert à tous : données publiques)
const rivieres = require('./rivieres').creerRivieres({ zone: () => (zoneVoisins() || {}).bbox || config.zone, journal });
app.get('/api/rivieres', (req, res) => res.json({ etat: rivieres.etat(), stations: rivieres.etat().actif ? rivieres.liste() : [] }));
// Capteurs LoRaWAN (TTN v3 / ChirpStack v4, en lecture seule) : réservés aux membres sauf LORAWAN_PUBLIC=oui
const lorawan = require('./lorawan').creerLorawan({ journal });
const voirLorawan = (req) => lorawan.etat().public || estMembre(req);
app.get('/api/lorawan', (req, res) => {
  if (!voirLorawan(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const e = lorawan.etat();
  res.json({ etat: e, capteurs: e.actif ? lorawan.liste() : [], passerelles: e.actif ? lorawan.passerelles() : [] });
});
app.get('/api/lorawan/:id', (req, res) => {
  if (!voirLorawan(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const s = lorawan.serie(String(req.params.id).slice(0, 64));
  if (!s) return res.status(404).json({ erreur: 'Capteur inconnu' });
  res.json(s);
});
app.get('/api/rivieres/:code', (req, res) => {
  const s = /^[A-Z0-9]{10}$/i.test(req.params.code) ? rivieres.serie(req.params.code.toUpperCase()) : null;
  if (!s) return res.status(404).json({ erreur: 'Station inconnue' });
  res.json(s);
});
app.get('/api/aprs', (req, res) => {
  const heures = Math.min(Math.max(Number(req.query.heures) || 6, 1), 24);
  res.json({ etat: aprs.etat(), stations: aprs.etat().actif ? aprs.liste(heures) : [] });
});
app.get('/api/feux', (req, res) => {
  if (fonctionMasquee('feux')) return res.status(404).json({ erreur: 'Fonction masquée par l’administrateur' });
  res.set('Cache-Control', 'no-store').json(feux.etat(Number(req.query.heures) || 24));
});
app.post('/api/feux/envoyer', async (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  const b = req.body || {};
  try {
    const r = await alertesOff.envoyerTexte(feux.texteAlerte(String(b.cle || '')), { canaux: Array.isArray(b.canaux) ? b.canaux : [], canalMc: String(b.canalMc || '').slice(0, 32) }, u.indicatif || u.identifiant);
    alertesOff.noterEnvoi('feu|' + String(b.cle || ''), u.indicatif || u.identifiant, r.envois);
    diffuser({ genre: 'alertes-officielles' });
    res.json(r);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/alertes-officielles/envoyer', async (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  const b = req.body || {};
  try { res.json(await alertesOff.envoyerVigilance({ dep: String(b.dep || ''), phenomene: String(b.phenomene || ''), canaux: Array.isArray(b.canaux) ? b.canaux : [], canalMc: String(b.canalMc || '').slice(0, 32) }, u.indicatif || u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/alertes-officielles/reglages', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const r = alertesOff.regler(req.body || {});
  res.json(r);
});
app.post('/api/vigipirate', async (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  try { const r = await alertesOff.vigipirate((req.body || {}).niveau || null, u.indicatif || u.identifiant, !!(req.body || {}).annoncer); res.json(r); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/fr-alert', async (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  try { const r = await alertesOff.frAlert(req.body || {}, u.indicatif || u.identifiant); res.json(r); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/fr-alert/:id/fin', (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  try { res.json(alertesOff.finFrAlert(String(req.params.id), u.indicatif || u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/signalements', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  res.set('Cache-Control', 'no-store').json({ signalements: signalements.lister(), ...signalements.canaux(), alertes: signalements.listerAlertes(), genresAlerte: signalements.GENRES });
});
// Alertes Bipper / GerMaCrise (gestionnaires) : #alerte N texte #entité, puis #fin N
app.post('/api/alertes-bipper', (req, res) => {
  const u = utilisateur(req);
  if (!u || !estGestion(req)) return res.status(401).json({ erreur: 'Connexion gestionnaire requise' });
  try { res.json((req.body || {}).fin ? signalements.finAlerte(req.body.fin, u.indicatif || u.identifiant) : signalements.envoyerAlerte(req.body || {}, u.indicatif || u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Carte publique : signalements en cours, sans l'auteur ni l'état des envois
app.get('/api/signalements/publics', (req, res) => {
  res.set('Cache-Control', 'max-age=30').json(signalements.lister().filter((x) => x.actif).map((x) => ({ forme: x.forme || 'point', trace: x.trace || null, id: x.id, type: x.type, icone: x.icone, titre: x.titre, details: x.details, lat: x.lat, lon: x.lon, cree: x.cree, expire: x.expire })));
});
// Main courante : signalements des 7 derniers jours, page imprimable (membres)
app.get('/main-courante', (req, res) => {
  if (fonctionMasquee('main-courante')) return res.status(404).send('Main courante désactivée sur cette carte');
  if (!estMembre(req)) return res.status(401).send('Connexion requise');
  const e = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const h = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const lignes = [];
  const { versDfci } = require('../public/dfci.js');
  const pos = (x) => `${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}${versDfci(x.lat, x.lon) ? '<br>DFCI ' + versDfci(x.lat, x.lon) : ''}`;
  for (const x of signalements.lister()) {
    lignes.push([x.cree, `${x.icone} ${e(x.titre)}`, e(x.details), pos(x), e(x.auteur) + (x.source === 'radio' ? ' (reçu par radio)' : ''), [...(x.envois.mt || []).map((v) => `Meshtastic canal ${v.canal} : ${v.statut === 'envoye' ? 'envoyé' : 'échec'}`), x.envois.mc ? `MeshCore : ${x.envois.mc.statut === 'envoye' ? 'envoyé' : 'échec'}` : ''].filter(Boolean).join(' · ')]);
    if (x.fin) lignes.push([x.fin, `✅ Fin : ${e(x.titre)}`, '', pos(x), e(x.finPar || ''), '']);
  }
  lignes.sort((a, b) => a[0] - b[0]);
  res.set('Cache-Control', 'no-store').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Main courante · ${e(config.carte.titre)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eee}@media print{button{display:none}}</style>
<h1>Main courante · ${e(config.carte.titre)}</h1><p>Signalements des 7 derniers jours, édité le ${h(Date.now())}. <button onclick="print()">Imprimer / PDF</button></p>
<table><tr><th>Heure</th><th>Événement</th><th>Précisions</th><th>Position</th><th>Par</th><th>Diffusion</th></tr>${lignes.map((l) => `<tr><td>${h(l[0])}</td><td>${l[1]}</td><td>${l[2]}</td><td>${l[3]}</td><td>${l[4]}</td><td>${l[5]}</td></tr>`).join('') || '<tr><td colspan="6">Aucun signalement.</td></tr>'}</table></html>`);
});
app.post('/api/signalements', async (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { res.json(await signalements.creer(req.body || {}, u.indicatif || u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/signalements/:id/terminer', async (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { res.json(await signalements.terminer(String(req.params.id), u.indicatif || u.identifiant, { annoncer: (req.body || {}).annoncer !== false })); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/signalements/:id/renvoyer', async (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  try { res.json(await signalements.renvoyer(String(req.params.id))); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// ---- Passerelle inter-réseaux Meshtastic ⇄ MeshCore (activée par l'admin dans son panneau ; PASSERELLE=0 l'interdit) ----
if (!config.passerelle.interdite) {
  const reqNomMt = stockage.db.prepare('SELECT nom_court, nom_long FROM noeuds WHERE num = ?');
  passerelle = require('./passerelle').creerPasserelle({
    config, journal, audit,
    nomMt: (num) => { try { const n = reqNomMt.get(Number(num) >>> 0); return (n && (n.nom_court || n.nom_long)) || '!' + (Number(num) >>> 0).toString(16).padStart(8, '0'); } catch { return null; } },
    envoyerMt: async (index, texte) => administration.envoyerTexte({ texte, canal: index }, 'passerelle'),
    envoyerMc: async (index, texte) => {
      await companion.envoyerCanal(index, texte);
      const c = companion.etat(), canal = companion.canaux().find((x) => x.index === index);
      reseauMc.noterMessage({ sens: 'envoye', genre: 'canal', canal: canal ? canal.nom : null, indexCanal: index, de: c.cle, nomDe: c.nom, texte, statut: 'envoye', auteur: 'passerelle', region: c.zoneDefaut == null ? null : c.zoneDefaut || '-' });
      diffuser({ genre: 'mc-message', confirmation: true });
    },
    etatMt: () => { const i = sourceRadio.infos(), e = sourceRadio.etat(); return { connecte: !!i.connecte, noeudLocal: i.noeudLocal, nomLocal: e.nomLocal, canaux: i.canaux || [] }; },
    etatMc: () => { const c = companion.etat(); return { pret: !!(config.meshcore.actif && c.pret), nom: c.nom || null, canaux: config.meshcore.actif ? companion.canaux() : [] }; },
  });
}
const exigerPasserelle = (req, res) => {
  if (!passerelle) { res.status(404).json({ erreur: 'Passerelle inter-réseaux interdite sur cette carte (PASSERELLE=0 dans le .env)' }); return false; }
  if (!estAdmin(req)) { res.status(401).json({ erreur: 'Connexion admin requise' }); return false; }
  return true;
};
app.post('/api/passerelle/activation', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  const oui = !!(req.body || {}).active, qui = nomCompte(utilisateur(req));
  audit.noter(qui, req.ip, `passerelle : ${oui ? 'activée' : 'désactivée'}`, '', true);
  res.json(passerelle.activer(oui, qui));
});
app.post('/api/passerelle/essai', (req, res) => { if (!exigerPasserelle(req, res)) return; const b = req.body || {}; res.json(passerelle.essayer({ reseau: b.reseau === 'mc' ? 'mc' : 'mt', canal: String(b.canal || ''), nom: String(b.nom || 'Essai').slice(0, 30), de: null, texte: String(b.texte || '').slice(0, 300) })); });
app.post('/api/passerelle/profils', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  const b = req.body || {}, qui = nomCompte(utilisateur(req));
  try {
    if (b.action === 'charger') { audit.noter(qui, req.ip, 'passerelle : profil chargé', String(b.nom), true); return res.json(passerelle.chargerProfil(b.nom, qui)); }
    if (b.action === 'supprimer') return res.json({ profils: passerelle.supprimerProfil(b.nom) });
    res.json({ profils: passerelle.enregistrerProfil(b.nom, qui) });
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/passerelle', (req, res) => { if (exigerPasserelle(req, res)) res.set('Cache-Control', 'no-store').json(passerelle.vue()); });
app.post('/api/passerelle/regles', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  try { const r = passerelle.ajouterRegle(req.body || {}, nomCompte(utilisateur(req))); audit.noter(nomCompte(utilisateur(req)), req.ip, 'passerelle : règle créée', r.libelle, true); res.json(r); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/passerelle/regles/:id', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  try { const r = passerelle.modifierRegle(req.params.id, req.body || {}); audit.noter(nomCompte(utilisateur(req)), req.ip, 'passerelle : règle modifiée', `${r.libelle}${typeof (req.body || {}).actif === 'boolean' ? (req.body.actif ? ' · activée' : ' · suspendue') : ''}`, true); res.json(r); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/passerelle/regles/:id', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  const ok = passerelle.supprimerRegle(req.params.id); audit.noter(nomCompte(utilisateur(req)), req.ip, 'passerelle : règle supprimée', req.params.id, true); res.json({ ok });
});
app.post('/api/passerelle/reglages', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  try { const g = passerelle.regler(req.body || {}); audit.noter(nomCompte(utilisateur(req)), req.ip, 'passerelle : réglages', typeof (req.body || {}).pause === 'boolean' ? (req.body.pause ? 'mise en pause' : 'reprise') : null, true); res.json(g); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.post('/api/passerelle/liste-noire', (req, res) => {
  if (!exigerPasserelle(req, res)) return;
  const b = req.body || {};
  try {
    const r = b.retirer ? passerelle.debloquer(b.reseau, b.id) : b.modifier ? passerelle.modifierBlocage(b.reseau, b.id, b) : passerelle.bloquer(b, nomCompte(utilisateur(req)));
    audit.noter(nomCompte(utilisateur(req)), req.ip, b.retirer ? 'passerelle : retiré de la liste noire' : b.modifier ? 'passerelle : liste noire modifiée' : 'passerelle : ajouté à la liste noire', `${b.reseau === 'mt' ? 'Meshtastic' : 'MeshCore'} ${b.nom || b.id}${b.motif ? ' · ' + String(b.motif).slice(0, 60) : ''}`, true);
    res.json(r);
  } catch (e) { res.status(400).json({ erreur: e.message }); }
});
// Favoris et « mes nœuds » de chaque compte
const suivis = require('./suivis').creerSuivis(config, {
  autoAdministres: (u) => (u.role === 'admin'
    ? [...Object.entries(administration.administrables()).filter(([, e]) => e && e.ok).map(([k]) => k), ...(config.meshcore.actif ? adminMc.memorises() : [])]
    : u.role === 'gestionnaire' ? u.noeuds || [] : []),
});
app.get('/api/suivis', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  res.set('Cache-Control', 'no-store').json(suivis.lire(u));
});
app.post('/api/suivis', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  const b = req.body || {};
  try { res.json(suivis.regler(u, b.id, b.liste, !!b.valeur)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
administration.utiliserAgents(agents);
const analyse = creerAnalyse(stockage, config, reseau, () => presetReseau());
const liensMesuresNoeuds = () => fournisseursRelief.liensNoeuds(); // + mesures des nœuds mobiles (couverture mesurée)
// Preset LoRa du réseau : celui du module connecté, sinon le plus fréquent parmi les nœuds entendus depuis 7 jours
// (rapports de carte), sinon RESEAU_PRESET. Recalculé toutes les 10 minutes.
var presetReseauCache = { t: 0, v: null };
function presetReseau() {
  const radio = sourceRadio ? sourceRadio.etat().preset : null;
  if (radio) return radio;
  if (Date.now() - presetReseauCache.t > 600000) {
    const c = {}, lim = Date.now() - 7 * 86400000;
    try { for (const n of stockage.q.noeuds.all()) if (n.preset && (n.dernier_vu || 0) >= lim && reseau.estSurveille(n)) c[n.preset] = (c[n.preset] || 0) + 1; } catch { /* base indisponible */ }
    presetReseauCache = { t: Date.now(), v: Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || null };
  }
  return presetReseauCache.v;
}
const fournisseursRelief = {
  presetCourant: presetReseau,
  // Relief grossier mondial en attendant le relief précis (null si désactivé ou pas encore téléchargé)
  reliefGrossier: () => (grossierActif() ? reliefGrossier : null),
  apresTelechargement: () => setTimeout(appliquerPlafondRelief, 5000).unref(),
  // Relais / passerelles positionnés et entendus dans les dernières 24 h (un relais muet ne couvre plus rien)
  noeudsReseau: () => {
    const limite = Date.now() - 24 * 3600000;
    return stockage.q.noeuds.all()
      .filter((n) => n.lat != null && (n.vu || n.dernier_vu || 0) >= limite && reseau.estSurveille(n))
      .map((n) => ({ num: n.num, nom: n.nom_long || n.nom_court || n.id, lat: n.lat, lon: n.lon, role: n.role, passerelle: !!n.est_passerelle, ...installations.radio(n.num) }))
      .concat(federation ? federation.noeudsCalcul() : []); // relais des bulles voisines (près des limites du département)
  },
  // Liaisons radio directes avec SNR mesuré (pour calibrer le modèle)
  liensMesures: () => [...liensMesuresNoeuds(), ...(() => { try { return mesures().liensCalibration(); } catch { return []; } })()],
  liensNoeuds: () => {
    const noeuds = new Map(stockage.q.noeuds.all().filter((n) => n.lat != null).map((n) => [n.num, n]));
    return reseau.liens(config.retentionJours * 86400000)
      .filter((l) => l.snr != null && noeuds.has(l.a) && noeuds.has(l.b))
      .map((l) => {
        const a = noeuds.get(l.a), b = noeuds.get(l.b);
        return { a: { lat: a.lat, lon: a.lon }, b: { lat: b.lat, lon: b.lon }, snr: l.snr, nom: `${a.nom_court || a.id} → ${b.nom_court || b.id}` };
      });
  },
};
federation = creerFederation({ config, stockage, reseau, installations, journal, version: VERSION });
const relief = creerRelief(config, journal, fournisseursRelief);

// ---- Maintenance : charge radio, autonomie, firmwares, rôles -------------------------------------
const maintenance = creerMaintenance({ stockage, config, reseau, installations, journal });
app.get('/api/maintenance/:quoi', async (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const q = req.params.quoi;
  try {
    if (q === 'charge') return res.json(maintenance.chargeRadio());
    if (q === 'autonomie') return res.json(maintenance.autonomie());
    if (q === 'firmwares') return res.json(maintenance.firmwares());
    if (q === 'roles') {
      let couv = null;
      try { if (relief.pret()) couv = await couvertureReseauCachee(relief, optsRelief({}), 'mt'); } catch { /* relief pas prêt */ }
      return res.json({ ...maintenance.roles(couv && !couv.vide ? couv : null, relief.sommets()), relief: !!couv });
    }
    res.status(404).json({ erreur: 'Inconnu' });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ---- Fédération avec les bulles voisines ---------------------------------------------------------
// ---- Relevés de terrain (mode terrain, membres) ---------------------------------------------
const releves = creerReleves(path.dirname(config.fichierBase), journal);
app.get('/api/releves', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  res.set('Cache-Control', 'no-store').json({ types: releves.TYPES, releves: releves.liste() });
});
app.post('/api/releves', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { res.json(releves.ajouter(req.body || {}, u.indicatif || u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/releves/:id/photo', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const f = releves.photo(req.params.id);
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400').type('jpeg').sendFile(f);
});
app.delete('/api/releves/:id', (req, res) => {
  const u = utilisateur(req);
  if (!u) return res.status(401).json({ erreur: 'Connexion requise' });
  try { releves.retirer(req.params.id, u); res.json({ ok: true }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/federation', (req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.json(federation.publier()); });
app.get('/api/federation/voisins', (req, res) => res.json(federation.voisins()));
app.get('/api/federation/partenaires', (req, res) => { if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); res.json(federation.partenaires()); });
app.post('/api/federation/partenaires', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { const e = await federation.ajouter(String((req.body || {}).url || ''), (req.body || {}).nom); res.json({ ok: !e.erreur, erreur: e.erreur, relais: e.relais ? e.relais.length : 0 }); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.delete('/api/federation/partenaires', (req, res) => { if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); federation.retirer(String(req.query.url || '')); res.json({ ok: true }); });

// ---- Mur des donateurs (HelloAsso + GitHub Sponsors, voir src/donateurs.js) -------------------------------
// Public : jamais de clé, jamais d'e-mail, d'adresse ni de date, noms anonymisés et montants masqués par défaut ;
// liens « Faire un don » tirés des réglages (absents si la source est désactivée)
app.get('/api/donateurs', (req, res) => {
  try { res.set('Cache-Control', 'max-age=60').json({ liste: donateurs.liste(), liens: donateurs.liens() }); }
  catch (e) { journal('[Donateurs] liste :', e.message); res.status(500).json({ erreur: 'Mur des donateurs indisponible' }); }
});
app.get('/api/donateurs/reglages', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  res.set('Cache-Control', 'no-store').json(donateurs.etat());
});
// Un enregistrement impossible (disque plein, volume en lecture seule) répond 500 : le réglage n'est pas pris
const erreurDonateurs = (res, e) => res.status(e.code === 'SAUVEGARDE' ? 500 : 400).json({ erreur: e.message });
app.post('/api/donateurs/reglages', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(donateurs.regler(req.body || {})); } catch (e) { erreurDonateurs(res, e); }
});
app.post('/api/donateurs/manuel', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(donateurs.manuelAjouter(req.body || {})); } catch (e) { erreurDonateurs(res, e); }
});
app.delete('/api/donateurs/manuel/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { donateurs.manuelRetirer(String(req.params.id)); res.json({ ok: true }); } catch (e) { erreurDonateurs(res, e); }
});

// ---- Exports et intégrations (GeoJSON, Prometheus/Grafana, Home Assistant) ------------------------
const exportsCarte = creerExports({ config, stockage, reseau, reseauMc, maintenance, santeCarte: { etat: () => santeCarte.etat() }, relief, alertes: () => dernieresAlertes, alertesMc: () => (config.meshcore.actif ? alertesMc : []), adminMc });
const exporter = (f, type) => (req, res) => {
  if (!exportsCarte.jetonOk(req)) return res.status(401).json({ erreur: 'Jeton d’export requis (?jeton=…)' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try { const r = f(req); if (type === 'text') res.type('text/plain; version=0.0.4').send(r); else if (typeof r === 'string') { res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.path)}"`); res.type(type).send(r); } else res.type(type).send(JSON.stringify(r)); } catch (e) { res.status(500).json({ erreur: e.message }); }
};
app.get('/api/export/noeuds.geojson', exporter(() => exportsCarte.noeudsGeoJSON(), 'application/geo+json'));
app.get('/api/export/liens.geojson', exporter((req) => exportsCarte.liensGeoJSON(Math.min(Math.max(Number(req.query.heures) || 24, 1), 168)), 'application/geo+json'));
app.get('/api/export/resume.json', exporter(() => exportsCarte.resume(), 'application/json'));
app.get('/publique', envoyerPage('publique.html'));
app.get('/metrics', exporter(() => exportsCarte.metriques(), 'text'));
app.get('/api/export/relais.gpx', exporter(() => exportsCarte.relaisGpx(), 'application/gpx+xml'));
app.get('/api/export/reseau.kml', exporter((req) => exportsCarte.reseauKml({ heures: Math.min(Math.max(Number(req.query.heures) || 24, 1), 168), titre: String(config.carte.titre || 'Carte live') }), 'application/vnd.google-earth.kml+xml'));
app.get('/api/export/reseau-direct.kml', exporter((req) => {
  // Adresse vue par le navigateur (?origine=, même hôte seulement) : fiable derrière un reverse proxy https mal réglé
  let base = `${req.protocol}://${req.get('host')}`;
  try {
    const o = new URL(String(req.query.origine || ''));
    const hotes = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean).map((h) => String(h).split(',')[0].trim().toLowerCase());
    if (/^https?:$/.test(o.protocol) && hotes.includes(o.host.toLowerCase())) base = o.origin;
  } catch { /* pas d'origine : adresse de la requête */ }
  return exportsCarte.reseauKmlLive(`${base}/api/export/reseau.kml${req.query.jeton ? '?jeton=' + encodeURIComponent(String(req.query.jeton)) : ''}`);
}, 'application/vnd.google-earth.kml+xml'));

// ---- Domotique : Home Assistant et Node-RED par MQTT (DOMOTIQUE_MQTT_URL) --------------------------------------
const domotique = require('./domotique').creerDomotique({
  mqtt, version: VERSION, nomCarte: String(config.titre || 'Carte live'), journal,
  resume: () => exportsCarte.resume(),
  alertes: () => [...dernieresAlertes, ...(config.meshcore.actif ? alertesMc : [])],
  noeuds: () => {
    const t = Date.now();
    const l = stockage.q.noeuds.all().filter((n) => reseau.estSurveille(n)).map((n) => {
      const v = reseau.vueNoeud(n, false, t);
      return { id: n.id, nom: n.nom_long || n.nom_court || n.id, reseau: 'meshtastic', role: n.role, vu: n.dernier_vu, enLigne: !!n.dernier_vu && t - n.dernier_vu <= config.seuils.muetMinutes * 60000, batterie: n.batterie != null && n.batterie <= 100 ? n.batterie : null, tension: n.tension, lat: v.lat, lon: v.lon };
    });
    if (config.meshcore.actif) {
      try {
        for (const n of reseauMc.surveilles(adminMc.memorises())) l.push({ id: 'mc-' + n.cle.slice(0, 12), nom: n.nom || n.cle.slice(0, 8), reseau: 'meshcore', role: n.role, vu: n.dernier_vu, enLigne: !!n.dernier_vu && t - n.dernier_vu <= config.meshcore.muetHeures * 3600000, lat: n.lat, lon: n.lon });
      } catch (e) { journal('[Domotique]', e.message); }
    }
    return l.slice(0, 300);
  },
  envoyer: (b) => {
    const r = administration.envoyerTexte(b, 'domotique');
    setTimeout(() => diffuser({ genre: 'statut' }), 500);
    return r;
  },
});

// ---- Historique long (résumés horaires et journaliers) ---------------------------------------
const historique = creerHistorique(stockage.db, config, {
  meshtastic: () => {
    const st = reseau.statistiques(), z = config.zone, limite = Date.now() - config.seuils.actifMinutes * 60000;
    const actifsZone = stockage.q.noeuds.all().filter((n) => n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3] && (n.dernier_vu || 0) >= limite).length;
    return { mt_noeuds_actifs: st.actifs, mt_actifs_zone: actifsZone, mt_passerelles: st.passerellesEnLigne, mt_liens: st.liens, mt_paquets: st.paquetsHeure, mt_canal_moyen: st.canalMoyen, mt_canal_max: st.canalMax };
  },
  meshcore: () => {
    if (!config.meshcore.actif) return {};
    const st = reseauMc.statistiques();
    const n = stockage.db.prepare('SELECT COUNT(*) AS n FROM mc_paquets WHERE heure >= ?').get(Date.now() - 3600000).n;
    return { mc_noeuds_actifs: st.actifs, mc_paquets: n };
  },
  couverture: () => { const c = relief.classement(); return c && c.reseauActuel ? c.reseauActuel.pct : null; },
}, journal);
// ---- Sauvegardes des réglages (admin) ----------------------------------------------------------
const sauvegardes = creerSauvegardes(path.dirname(config.fichierBase), stockage.db, journal);
app.get('/api/sauvegardes', (req, res) => { if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); res.json(sauvegardes.liste()); });
app.post('/api/sauvegardes', (req, res) => { if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' }); try { res.json(sauvegardes.sauvegarder()); } catch (e) { res.status(500).json({ erreur: e.message }); } });
app.get('/api/sauvegardes/:nom', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', `attachment; filename="carte-live-${req.params.nom}"`); res.end(sauvegardes.lire(req.params.nom)); } catch (e) { res.status(404).json({ erreur: e.message }); }
});
app.post('/api/sauvegardes/restaurer', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { const r = sauvegardes.restaurer(req.body); res.json({ ok: true, ...r, redemarrage: true }); setTimeout(() => process.exit(0), 1200); } catch (e) { res.status(400).json({ erreur: e.message }); }
});
app.get('/api/historique', (req, res) => {
  const jours = Math.min(Math.max(Number(req.query.jours) || 30, 1), 400);
  res.json({ jours, ...historique.lire(jours), base: historique.tailleBase() });
});
app.post('/api/historique/compacter', (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  try { res.json(historique.compacter()); } catch (e) { res.status(500).json({ erreur: e.message }); }
});

{ const m = sourceRadio.modules(); journal(m.actif ? `Module radio actif : ${m.actif.hote}:${m.actif.port}` : 'Aucun module radio actif (choix depuis la carte, onglet Réseau)'); }
setTimeout(rafraichirEtat, 2000);

// Purge horaire : la purge Meshtastic avance par lots (la carte reste réactive), puis MeshCore et le nettoyage
async function purgeHoraire() {
  const t0 = Date.now();
  const nMt = await stockage.purger(config.retentionJours, config.messagesRetentionJours);
  const n = nMt + chronoTache('purge MeshCore', () => reseauMc.purger(config.retentionJours, config.meshcore.retentionPaquetsJours));
  chronoTache('nettoyage des liens impossibles', () => reseau.nettoyer());
  return { n, dureeS: Math.round((Date.now() - t0) / 100) / 10 };
}
setInterval(() => purgeHoraire().then(({ n, dureeS }) => {
  // Compteurs séparés : un broker peut ne porter que du MeshCore (Meshtastic « 0 traité » est alors normal)
  const mcR = compteurMc.recusMqtt || 0;
  journal(`Purge : ${n} lignes de plus de ${config.retentionJours} jours supprimées · MQTT Meshtastic : ${compteur.recus - mcR} reçus, ${compteur.decodes} traités, ${compteur.erreurs} erreurs${config.meshcore.actif ? ` · MeshCore : ${mcR} reçus, ${compteurMc.observations} observations gardées, ${compteurMc.horsPerimetre || 0} hors périmètre` : ''} (depuis le démarrage), purge en ${dureeS} s`);
}).catch((e) => journal('Purge impossible :', e.message)), 3600000);
stockage.purger(config.retentionJours, config.messagesRetentionJours).catch((e) => journal('Purge impossible :', e.message));
setTimeout(() => reseauMc.purger(config.retentionJours, config.meshcore.retentionPaquetsJours), 60000);
{
  const n = reseau.nettoyer();
  if (n.positions || n.liens) journal(`Nettoyage : ${n.positions} position(s) invalide(s), ${n.liens} lien(s) impossible(s) supprimés`);
}

serveur.listen(config.port, () => journal(`Carte live Meshtastic à l'écoute sur le port ${config.port}`));

// Filet de sécurité : une promesse rejetée sans traitement ne doit jamais arrêter la carte (elle redémarrait en boucle)
process.on('unhandledRejection', (e) => { console.error(new Date().toISOString(), '[Erreur non traitée]', e && e.stack ? e.stack : e); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    journal('Arrêt…');
    try { secteursAlerte.arreter(); urgence.arreter(); } catch { /* rien à enregistrer */ }
    publicateurMc.fermer();
    clientMqtt.end(true);
    stockage.db.close();
    process.exit(0);
  });
}
