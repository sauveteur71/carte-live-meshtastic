'use strict';
// Carte live Meshtastic — serveur : MQTT -> décodage -> SQLite -> API REST + WebSocket temps réel

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mqtt = require('mqtt');
const { WebSocketServer } = require('ws');

const config = require('./config');
const VERSION = require('../package.json').version;
const { calculerVoisins } = require('./voisins');
const { creerInstallations } = require('./installations');
const { creerAsymetrie } = require('./asymetrie');
const { creerCouvertureMesuree } = require('./couverture-mesuree');
const { creerHistorique } = require('./historique');
const { creerSauvegardes } = require('./sauvegardes');
const { creerSanteCarte } = require('./sante-carte');
const { creerMaintenance } = require('./maintenance');
const { creerExports } = require('./exports');
const { creerFederation } = require('./federation');
const { creerReleves } = require('./releves');
const { creerAudit } = require('./audit');
const { creerNouveaux } = require('./nouveaux');
const { creerRapport } = require('./rapport');
const { creerSitesRoutiers } = require('./sites-routiers');
const installations = creerInstallations(path.dirname(config.fichierBase));
let federation = null; // créée une fois le réseau prêt (voir plus bas)
// Zone « département + voisins », recalculée si le département ou sa zone changent (installation, réglages)
let cacheVoisins = { cle: null, val: null };
function zoneVoisins() {
  const cle = `${config.departement.code}|${config.zone.join(',')}`;
  if (cacheVoisins.cle !== cle) cacheVoisins = { cle, val: calculerVoisins(config.departement.code, config.zone) };
  return cacheVoisins.val;
}
// Paramètre ?zone= : 1 = département, v = département + voisins, sinon toute la carte
const bboxZone = (q) => (q === '1' ? config.zone : q === 'v' ? (zoneVoisins() || {}).bbox || config.zone : null);
const { decoderMessage, preparerCanaux } = require('./decodeur');
const { creerStockage } = require('./base');
const { creerReseau } = require('./reseau');
const { creerSourceMeshMonitor } = require('./meshmonitor');
const { creerSourceRadio } = require('./radio');
const { creerAnalyse } = require('./analyse');
const { creerRelief, contourDepartement } = require('./relief');
const { creerComptes } = require('./comptes');
const { creerAdministration } = require('./administration');
const { creerAgents } = require('./agents');
const { creerReseauMc } = require('./meshcore/reseau');
const { creerCompanion } = require('./meshcore/companion');
const { lireMessageMc, creerPublicateurMc } = require('./meshcore/mqtt');
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
const nomCompte = (c) => (c ? c.indicatif ? `${c.identifiant} (${c.indicatif})` : c.identifiant : null);
// « Membre » : tout compte connecté (messages texte, positions exactes) ; « admin » : réglages et pilotage
const estMembre = (req) => !!utilisateur(req);
const estAdmin = (req) => { const u = utilisateur(req); return !!u && u.role === 'admin'; };
// Gestion par secteur : l'admin gère tout, un « gestionnaire » seulement les nœuds de sa liste
const estGestion = (req) => { const u = utilisateur(req); return !!u && (u.role === 'admin' || u.role === 'gestionnaire'); };
function peutGerer(req, id) {
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
function ipPrivee(req) {
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
app.use((req, res, next) => {
  if (req.method === 'GET' || !req.path.startsWith('/api/') || SANS_AUDIT.has(req.path)) return next();
  const u = utilisateur(req);
  if (!u) return next();
  res.on('finish', () => audit.noter(nomCompte(u), req.ip, `${req.method} ${req.path}`, audit.resumer(req.body), res.statusCode < 400));
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

// Version installée et dernière version publiée sur GitHub (vérifiée toutes les 6 h)
const DEPOT = process.env.DEPOT_GITHUB || 'sauveteur71/carte-live-meshtastic';
const majDispo = { version: null, url: null, verifie: 0, erreur: null };
const comparerVersions = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
async function verifierDerniereVersion() {
  if (process.env.VERIFIER_MAJ === '0') return;
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
setInterval(verifierDerniereVersion, 6 * 3600000).unref();
const infosVersion = () => ({ version: VERSION, derniere: majDispo.version, url: majDispo.url || `https://github.com/${DEPOT}/releases`, majDisponible: !!(majDispo.version && comparerVersions(majDispo.version, VERSION) > 0), verifie: majDispo.verifie || null });
app.get('/api/version', (req, res) => res.json(infosVersion()));

app.get('/api/config', (req, res) => {
  res.json({
    version: infosVersion(),
    titre: config.carte.titre,
    outils: { client: config.urlClient || '', flasher: config.urlFlasher || '' },
    centre: [config.carte.centreLat, config.carte.centreLon],
    zoom: config.carte.zoom,
    tuiles: config.carte.tuiles,
    retentionJours: config.retentionJours,
    seuils: config.seuils,
    admin: estAdmin(req),
    gestion: estGestion(req),
    membre: estMembre(req),
    compte: utilisateur(req),
    installation: comptes.installationRequise(),
    inscriptions: config.inscriptions,
    departement: config.departement,
    zone: config.zone,
    zoneVoisins: zoneVoisins(),
    zoneNom: config.zoneNom,
    radio: true,
    meshcore: config.meshcore.actif,
    lienDistanceMaxKm: config.lienDistanceMaxKm,
    precisionPublique: config.precisionPublique,
  });
});

app.get('/api/noeuds', (req, res) => {
  const admin = estMembre(req);
  const maintenant = Date.now();
  res.json(stockage.q.noeuds.all().map((n) => reseau.vueNoeud(n, admin, maintenant)));
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
      const pr = (sourceRadio && sourceRadio.etat().preset) || config.reseauPreset || 'LONG_FAST';
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
  if (p && estMembre(req)) {
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
      contoursDeps = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson'), 'utf8')).features.map((f) => ({
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
  const dep = String(depForce || req.query.dep || (req.body && req.body.dep) || '').toUpperCase();
  if (!dep || dep === String(config.departement.code).toUpperCase() || !/^(\d{2}|2A|2B)$/.test(dep)) return relief;
  if (!reliefsEtude.has(dep)) {
    if (!listeDepartements.some((d) => d.code === dep)) return relief;
    if (reliefsEtude.size >= 2) { const [k, v] = reliefsEtude.entries().next().value; v.arreter(); reliefsEtude.delete(k); }
    journal(`[Relief] étude du département ${dep} : chargement du relief IGN et des points hauts`);
    reliefsEtude.set(dep, creerRelief(config, journal, { ...fournisseursRelief, envDefaut: () => { const c = relief.calibration(); return c && c.perteEnvironnementDb != null ? c.perteEnvironnementDb : null; } }, { code: dep }));
  } else { const v = reliefsEtude.get(dep); reliefsEtude.delete(dep); reliefsEtude.set(dep, v); }
  return reliefsEtude.get(dep);
}

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
app.get('/api/relief/couvrir', (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ erreur: 'Point invalide' });
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  try { res.json(R(req, { lat, lon }).couvrirPoint({ lat, lon }, o)); } catch (e) { res.status(503).json({ erreur: e.message }); }
});
// Un seul site pour plusieurs points : ?pts=lat,lon;lat,lon;…
app.get('/api/relief/couvrir-points', (req, res) => {
  const cibles = String(req.query.pts || '').split(';').map((x) => x.split(',').map(Number)).filter((x) => x.length === 2 && x.every(Number.isFinite)).slice(0, 5).map(([lat, lon], i) => ({ lat, lon, nom: `Point ${i + 1}` }));
  if (cibles.length < 2) return res.status(400).json({ erreur: 'Indiquer au moins deux points' });
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  try { res.json(R(req, ...cibles).couvrirPoints(cibles, o)); } catch (e) { res.status(503).json({ erreur: e.message }); }
});
// Répéteurs MeshCore positionnés et entendus depuis 24 h (relais existants pour « Relier » et « Couvrir »)
const repeteursMc = () => { const lim = Date.now() - 24 * 3600000; return reseauMc.q.noeuds.all().filter((n) => n.lat != null && ['repeteur', 'salon'].includes(n.role) && (n.dernier_vu || 0) >= lim).map((n) => ({ num: n.cle, nom: n.nom || n.cle.slice(0, 8), lat: n.lat, lon: n.lon })); };
app.get('/api/relief/relier', (req, res) => {
  const q = req.query, n = (v) => Number(v);
  const a = { lat: n(q.aLat), lon: n(q.aLon), nom: q.aNom ? String(q.aNom).slice(0, 60) : 'Départ' }, b = { lat: n(q.bLat), lon: n(q.bLon), nom: q.bNom ? String(q.bNom).slice(0, 60) : 'Arrivée' };
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return res.status(400).json({ erreur: 'Points invalides' });
  const o = optsRelief(q);
  if (q.hA) o.hauteurA = Math.min(Math.max(Number(q.hA) || 2, 0.5), 60);
  if (q.hB) o.hauteurB = Math.min(Math.max(Number(q.hB) || 2, 0.5), 60);
  if (q.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  try { res.json(R(req, a, b).relierPoints(a, b, o)); } catch (e) { res.status(503).json({ erreur: e.message }); }
});
const cacheCouverture = new Map();
const calculsPublics = new Map();
function limiterCalcul(ip) {
  const t = Date.now(), l = (calculsPublics.get(ip) || []).filter((x) => t - x < 15 * 60000);
  l.push(t); calculsPublics.set(ip, l);
  if (calculsPublics.size > 2000) calculsPublics.clear();
  return l.length > 20;
}
app.get('/api/relief/couverture', (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ erreur: 'Point invalide' });
  const RR = R(req, { lat, lon });
  if (!dansEmprise({ lat, lon }, RR.emprise())) return res.status(400).json({ erreur: estMembre(req) ? 'Point hors de France métropolitaine : pas de relief disponible' : 'Point hors de la zone couverte par le modèle de relief (département et ses abords)' });
  if (!RR.pret()) return res.status(503).json({ erreur: `Relief du département ${RR.code || ''} en cours de chargement (IGN) : réessayez dans quelques minutes` });
  const o = optsRelief(req.query);
  const cle = JSON.stringify([RR.code, lat.toFixed(4), lon.toFixed(4), o, (RR.calibration() || {}).date]);
  let r = cacheCouverture.get(cle);
  if (!r) {
    // Visiteurs non connectés (carte publique) : 20 nouveaux calculs par quart d'heure au plus
    if (!estMembre(req) && limiterCalcul(req.ip)) return res.status(429).json({ erreur: 'Trop de calculs de couverture : réessayez dans quelques minutes' });
    r = RR.couverturePng({ lat, lon }, o);
    r.id = crypto.randomBytes(6).toString('hex');
    cacheCouverture.set(cle, r);
    cacheCouverture.set(r.id, r);
    if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
  }
  res.json({ image: `/api/relief/couverture/${r.id}.png`, emprise: RR.emprise(), departement: RR.etat().departement, surfaceKm2: r.surfaceKm2, surfaceZoneKm2: r.surfaceZoneKm2, pctZone: r.pctZone, sol: r.sol, env: r.env, rayonKm: r.rayonKm });
});
// Couverture cumulée : ?pts=lat,lon[,hauteur];lat,lon[,hauteur];… (2 à 10 sites)
app.get('/api/relief/couverture-multi', (req, res) => {
  const sites = String(req.query.pts || '').split(';').map((x) => x.split(',').map(Number)).filter((x) => x.length >= 2 && x.slice(0, 2).every(Number.isFinite)).slice(0, 10)
    .map(([lat, lon, h]) => ({ lat, lon, h: Number.isFinite(h) ? Math.min(Math.max(h, 0.5), 100) : undefined }));
  if (!sites.length) return res.status(400).json({ erreur: 'Aucun site' });
  const RR = R(req, ...sites);
  if (!RR.pret()) return res.status(503).json({ erreur: 'Le modèle de terrain est en cours de chargement' });
  const o = optsRelief(req.query);
  const cle = JSON.stringify(['multi', RR.code, sites, o, (RR.calibration() || {}).date]);
  let r = cacheCouverture.get(cle);
  if (!r) {
    r = RR.couverturePngMulti(sites, o);
    r.id = crypto.randomBytes(6).toString('hex');
    cacheCouverture.set(cle, r); cacheCouverture.set(r.id, r);
    if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
  }
  res.json({ image: `/api/relief/couverture/${r.id}.png`, emprise: RR.emprise(), departement: RR.etat().departement, surfaceKm2: r.surfaceKm2, surfaceZoneKm2: r.surfaceZoneKm2, pctZone: r.pctZone, sites: r.sites, env: r.env, rayonKm: r.rayonKm });
});
// Couverture actuelle du réseau (relais et passerelles détectés) : ?reseau=meshcore pour les répéteurs MeshCore
function couvertureReseauCachee(RR, o, reseauCle) {
  const versionFiches = Object.values(installations.toutes()).reduce((m, f) => Math.max(m, f.maj || 0), 0);
  const cle = JSON.stringify(['reseau', RR.code, reseauCle, o.hn || 6, Math.floor(Date.now() / 600000), (RR.calibration() || {}).date, versionFiches]);
  let r = cacheCouverture.get(cle);
  if (!r) {
    r = RR.couvertureReseau(o);
    if (r.vide) return r;
    r.id = crypto.randomBytes(6).toString('hex');
    cacheCouverture.set(cle, r); cacheCouverture.set(r.id, r);
    if (cacheCouverture.size > 60) cacheCouverture.delete(cacheCouverture.keys().next().value);
  }
  return r;
}
app.get('/api/relief/couverture-reseau', (req, res) => {
  const RR = R(req);
  if (!RR.pret()) return res.status(503).json({ erreur: 'Le modèle de terrain est en cours de chargement' });
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  if (req.query.hn) o.hn = Math.min(Math.max(Number(req.query.hn) || 6, 0.5), 60);
  // La calibration (pertes d'environnement) fait partie de la clé : un calcul fait avant elle serait trop optimiste
  let r;
  try { r = couvertureReseauCachee(RR, o, req.query.reseau || 'mt'); } catch (e) { return res.status(503).json({ erreur: e.message }); }
  if (r.vide) return res.json({ noeuds: [], vide: true });
  const { image, ...reste } = r;
  res.json({ ...reste, image: `/api/relief/couverture/${r.id}.png`, emprise: RR.emprise() });
});
// Principales villes d'un département (API Géo de l'État), gardées sur le disque
async function villesDepartement(code) {
  const f = path.join(path.dirname(config.fichierBase), `villes-${code}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* à télécharger */ }
  const r = await fetch(`https://geo.api.gouv.fr/departements/${encodeURIComponent(code)}/communes?fields=nom,centre,population&format=json`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('API Géo : HTTP ' + r.status);
  const l = (await r.json()).filter((c) => c.centre && c.population).sort((a, b) => b.population - a.population).slice(0, 20)
    .map((c) => ({ nom: c.nom, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0], population: c.population }));
  fs.writeFileSync(f, JSON.stringify(l));
  return l;
}
// Déplacer des relais existants : calcul en arrière-plan (1 à 3 min), résultat gardé jusqu'au prochain classement
const optimisations = new Map(); // clé -> { etat, progression, resultat, erreur }
app.get('/api/relief/optimisation', (req, res) => {
  const RR = R(req);
  if (!RR.pret()) return res.status(503).json({ erreur: 'Le modèle de terrain est en cours de chargement' });
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
  if (!RR.pret()) return res.status(503).json({ erreur: 'Le modèle de terrain est en cours de chargement' });
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
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* à télécharger */ }
  const r = await fetch(`https://geo.api.gouv.fr/departements/${encodeURIComponent(code)}/communes?fields=nom,centre,population&format=json`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('API Géo : HTTP ' + r.status);
  const l = (await r.json()).filter((c) => c.centre && c.population).map((c) => ({ nom: c.nom, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0], population: c.population }));
  fs.writeFileSync(f, JSON.stringify(l));
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
  if (!RR.pret()) return res.status(503).json({ erreur: 'Le modèle de terrain est en cours de chargement' });
  const b = req.body || {};
  const o = optsRelief(req.query);
  if (req.query.reseau === 'meshcore') { o.noeuds = repeteursMc(); o.preset = o.preset || 'MESHCORE_FR'; }
  if (b.hn) o.hn = Math.min(Math.max(Number(b.hn) || 6, 0.5), 60);
  let villes = [];
  try { villes = await villesDepartement(RR.code); } catch (e) { journal('[Simulation] villes :', e.message); }
  try {
    const r = RR.simuler({ retirer: Array.isArray(b.retirer) ? b.retirer.slice(0, 50) : [], ajouter: Array.isArray(b.ajouter) ? b.ajouter.slice(0, 10).map((a) => ({ lat: Number(a.lat), lon: Number(a.lon), h: a.h != null ? Math.min(Math.max(Number(a.h) || 6, 0.5), 60) : undefined, nom: a.nom ? String(a.nom).slice(0, 60) : undefined })) : [], villes }, o);
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
try { reperes = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'donnees-ref', `reperes-${config.departement.code}.json`), 'utf8')); } catch { /* facultatif */ }
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
  res.json({ ...sourceRadio.modules(), etat: sourceRadio.etat(), agents: { port: agents.port, liste: agents.liste() } });
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
app.post('/api/radio/connecter', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const { hote } = req.body || {};
  const port = portValide((req.body || {}).port);
  if (!hote) { try { sourceRadio.reconnecter(); return res.json({ ok: true }); } catch (e) { return res.status(400).json({ erreur: e.message }); } }
  if (!hoteValide(hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
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
  const port = portValide((req.body || {}).port);
  if (!hoteValide(hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
  sourceRadio.retirerModule(hote, port);
  res.json({ ok: true });
});
let scanEnCours = false;
app.post('/api/radio/scanner', async (req, res) => {
  if (!exigerAdmin(req, res)) return;
  const prefixe = String((req.body || {}).prefixe || '');
  // Uniquement les réseaux privés (192.168.x, 10.x, 172.16-31.x), par blocs de 254 adresses
  if (!/^(192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3})$/.test(prefixe)) return res.status(400).json({ erreur: 'Réseau privé attendu, ex. 192.168.0' });
  if (scanEnCours) return res.status(409).json({ erreur: 'Recherche déjà en cours' });
  scanEnCours = true;
  try { res.json({ trouves: await sourceRadio.scanner(prefixe), ...sourceRadio.modules() }); } finally { scanEnCours = false; }
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

// Nouveaux nœuds du secteur (membres : positions des particuliers arrondies comme ailleurs)
let nouveaux = null;
const obtenirNouveaux = () => (nouveaux = nouveaux || creerNouveaux(stockage, config, reseau));
app.get('/api/noeuds-nouveaux', (req, res) => {
  obtenirNouveaux();
  const r = nouveaux.lister(Number(req.query.jours) || 7);
  if (!estMembre(req)) for (const n of r.noeuds) { const v = reseau.vueNoeud(stockage.q.noeud.get(n.num), false); n.lat = v.lat; n.lon = v.lon; }
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
const obtenirRenumerotation = () => renumerotation || (renumerotation = require('./renumerotation').creerRenumerotation({ stockage, config, installations, comptes, administration, journal }));
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
  try { res.json(obtenirRenumerotation().fusionner(Number(b.ancien), Number(b.nouveau), u.identifiant)); } catch (e) { res.status(400).json({ erreur: e.message }); }
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
  try { res.set('Cache-Control', 'no-store').type('html').send(obtenirRapport().construire()); } catch (e) { res.status(500).send('Rapport indisponible : ' + e.message); }
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
  res.json({ connecte: i.connecte, noeudLocal: i.noeudLocal, canaux: i.canaux || [] });
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
    heure: p.heure, hopDepart: p.hop_depart, sauts: p.sauts, dechiffre: !!p.dechiffre, pki: !!p.pki, viaMqtt: !!p.via_mqtt, taille: p.taille,
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
app.get('/api/noeuds/:num/entendu-par', (req, res) => {
  const n = Number(req.params.num) >>> 0;
  const depuis = Date.now() - config.retentionJours * 86400000;
  res.json(stockage.db.prepare(`SELECT r.passerelle, COUNT(*) AS nb, MAX(r.heure) AS dernier, ROUND(AVG(r.snr), 2) AS snr, ROUND(AVG(r.rssi), 1) AS rssi, MIN(r.sauts) AS sautsMin,
      (SELECT p2.rowid FROM receptions r3 JOIN paquets p2 ON p2.rowid = r3.paquet WHERE p2.de = @n AND r3.passerelle = r.passerelle ORDER BY r3.heure DESC LIMIT 1) AS derniereTrame,
      (SELECT r4.snr FROM receptions r4 JOIN paquets p4 ON p4.rowid = r4.paquet WHERE p4.de = @n AND r4.passerelle = r.passerelle ORDER BY r4.heure DESC LIMIT 1) AS dernierSnr
      FROM receptions r JOIN paquets p ON p.rowid = r.paquet WHERE p.de = @n AND r.heure >= @d AND r.passerelle != @n GROUP BY r.passerelle ORDER BY dernier DESC`).all({ n, d: depuis }));
});

app.get('/api/traceroutes', (req, res) => {
  res.json(stockage.q.trRecents.all(Math.min(Number(req.query.limite) || 50, 500)));
});

// Réglages des traceroutes automatiques (cibles clés, plage horaire, intervalle), gardés dans /data
const fTrReglages = path.join(path.dirname(config.fichierBase), 'traceroutes-reglages.json');
const cfgTrEnv = { cibles: [...config.radio.tracerouteCibles], intervalle: config.radio.tracerouteIntervalleMinutes };
function appliquerReglagesTr() {
  let r = {};
  try { r = JSON.parse(require('fs').readFileSync(fTrReglages, 'utf8')); } catch { /* aucun */ }
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
  try { require('fs').writeFileSync(fTrReglages, JSON.stringify(r)); } catch (e) { return res.status(500).json({ erreur: e.message }); }
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
  res.json({ stats: reseau.statistiques(), alertes: dernieresAlertes, meshmonitor: sourceMM ? sourceMM.etat() : null, radio: sourceRadio ? sourceRadio.etat() : null });
});

app.get('/api/messages', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  res.json(stockage.q.messages.all(Math.min(Number(req.query.limite) || 300, 2000)));
});

app.post('/api/connexion', (req, res) => {
  if (limiter(req.ip)) return res.status(429).json({ erreur: 'Trop de tentatives, réessayez dans 15 minutes' });
  try {
    const b = req.body || {};
    const c = comptes.connecter(b.identifiant, b.motDePasse, b.code);
    ouvrirSession(req, res, c);
    journal(`Connexion de ${c.identifiant} (${c.role})`);
    audit.noter(nomCompte(c), req.ip, 'connexion', c.deuxFacteurs ? 'avec double authentification' : null, true);
    res.json({ ok: true, compte: c });
  } catch (e) {
    const b = req.body || {};
    // Code manquant : simple étape de la connexion, pas un échec
    if (!(e.codeRequis && !b.code)) audit.noter(String(b.identifiant || '').slice(0, 32) || null, req.ip, 'connexion refusée', e.message, false);
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
  listeDepartements = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson'), 'utf8')).features
    .map((f) => ({ code: f.properties.code, nom: f.properties.nom })).sort((a, b) => a.code.localeCompare(b.code));
} catch { /* liste indisponible */ }
app.get('/api/departements', (req, res) => res.json(listeDepartements));

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
function enregistrerReglagesEtRedemarrer(r, qui) {
  fs.writeFileSync(config.fichierReglages, JSON.stringify(r, null, 1), { mode: 0o600 });
  journal(`Réglages enregistrés par ${qui}, redémarrage du service…`);
  setTimeout(() => process.exit(0), 1200); // Docker relance le conteneur (restart: unless-stopped)
}

app.get('/api/installation', (req, res) => res.json({
  requise: comptes.installationRequise(),
  codeRequis: !!config.admin.motDePasse,
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
    return res.status(403).json({ erreur: 'Première installation possible uniquement depuis le réseau local' });
  }
  let r;
  try { r = b.reglages ? preparerReglages(b.reglages, config.reglages) : null; } catch (e) { return res.status(400).json({ erreur: e.message }); }
  let c;
  try { c = comptes.creer(b.compte || {}, 'admin', 'actif'); } catch (e) { return res.status(400).json({ erreur: e.message }); }
  ouvrirSession(req, res, c);
  journal(`Installation : compte administrateur « ${c.identifiant} » créé`);
  const redemarrage = !!(r && Object.keys(b.reglages).length);
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
  });
});
app.post('/api/reglages', (req, res) => {
  const u = utilisateur(req);
  if (!u || u.role !== 'admin') return res.status(401).json({ erreur: 'Connexion admin requise' });
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
    dernierMessage: statsMqtt.dernierMessage, parMinute: +(n10 / 10).toFixed(1), ...compteur,
    passerelles: [...statsMqtt.passerelles.entries()].sort((a, b) => b[1].derniere - a[1].derniere).slice(0, 40).map(([id, e]) => ({ id, nom: noeuds.get(id) || null, ...e })),
    canaux: [...statsMqtt.canaux.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([canal, messages]) => ({ canal, messages })),
  });
});
let testMqttEnCours = false;
app.post('/api/mqtt/tester', async (req, res) => {
  if (!estAdmin(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
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
  if (depuis) return res.json({ heure: maintenant, noeuds: reseauMc.q.noeudsDepuis.all(depuis - 5000).map((n) => reseauMc.vueNoeud(n, membre, maintenant)) });
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
  res.json(reseauMc.messages(Math.min(Number(req.query.limite) || 300, 2000)));
});
let alertesMc = [];
function etatMc(admin) {
  const e = { stats: reseauMc.statistiques(), alertes: alertesMc };
  const c = companion.etat();
  e.companion = { connecte: c.connecte, nom: c.nom, cle: c.cle, radio: c.radio, navigateur: c.navigateur, paquets: c.paquets, depuis: c.depuis, pret: c.pret, canaux: companion.canaux() };
  if (admin) {
    e.companion = { ...c, canaux: companion.canaux() };
    e.republication = publicateurMc.etat();
    e.reglages = { iata: config.meshcore.iata, racine: config.meshcore.racine, republier: config.meshcore.republier, canaux: config.meshcore.canaux.join('\n'), perimetre: config.meshcore.perimetre, iataVoisins: config.meshcore.iataVoisins.join(', '), horsPerimetre: compteurMc.horsPerimetre || 0 };
    e.agents = agents.liste();
  }
  return e;
}
app.get('/api/mc/etat', (req, res) => { if (!exigerMc(res)) return; res.set('Cache-Control', 'no-store').json(etatMc(estAdmin(req))); });
app.post('/api/mc/companion', (req, res) => {
  if (!exigerAdmin(req, res) || !exigerMc(res)) return;
  const b = req.body || {};
  if (b.type === 'agent') {
    if (!agents.estAgent(String(b.hote || ''))) return res.status(400).json({ erreur: 'Agent inconnu' });
    companion.connecterA({ type: 'agent', hote: String(b.hote) });
  } else {
    const port = portValide(b.port ?? 5000);
    if (!hoteValide(b.hote) || !port) return res.status(400).json({ erreur: 'Adresse ou port invalide' });
    companion.connecterA({ type: 'tcp', hote: b.hote, port });
  }
  res.json({ ok: true });
});
app.delete('/api/mc/companion', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  companion.deconnecter();
  res.json({ ok: true });
});
app.post('/api/mc/companion/annonce', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  try { companion.annoncer(!!(req.body || {}).inondation); res.json({ ok: true }); } catch (e) { res.status(409).json({ erreur: e.message }); }
});
app.post('/api/mc/companion/contacts', (req, res) => {
  if (!exigerAdmin(req, res)) return;
  try { companion.rechargerContacts(); res.json({ ok: true }); } catch (e) { res.status(409).json({ erreur: e.message }); }
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
      const id = reseauMc.noterMessage({ sens: 'envoye', genre: 'direct', de: c.cle, nomDe: c.nom, vers: n.cle, nomVers: n.nom, texte, statut: 'envoye', ack: r.ack, auteur: u.identifiant });
      setTimeout(() => { const m = reseauMc.messages(200).find((x) => x.id === id); if (m && m.statut === 'envoye') { reseauMc.statutMessage(id, 'sans_accuse'); diffuser({ genre: 'mc-message', confirmation: true }); } }, Math.max(r.delaiMs * 2, 30000));
      res.json({ ok: true, id, inondation: r.inondation });
    } else {
      const index = Number(b.canal);
      const canal = companion.canaux().find((x) => x.index === index);
      if (!canal) return res.status(400).json({ erreur: 'Canal inconnu du companion' });
      await companion.envoyerCanal(index, texte);
      const id = reseauMc.noterMessage({ sens: 'envoye', genre: 'canal', canal: canal.nom, indexCanal: index, de: c.cle, nomDe: c.nom, texte, statut: 'envoye', auteur: u.identifiant });
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
app.post('/api/mc/admin/mot-de-passe', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const b = req.body || {};
  if (!/^[0-9A-F]{64}$/i.test(String(b.cle || ''))) return res.status(400).json({ erreur: 'Clé invalide' });
  if (!peutGerer(req, b.cle)) return refuserSecteur(res);
  if (b.motDePasse == null) adminMc.oublierMotDePasse(b.cle); else adminMc.memoriserMotDePasse(b.cle, String(b.motDePasse).slice(0, 15));
  res.json({ ok: true });
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
  if (typeof b.iataVoisins === 'string') m.iataVoisins = b.iataVoisins.split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,8}$/.test(x)).slice(0, 20);
  if (typeof b.canaux === 'string') {
    const l = b.canaux.split(/[;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    const ok = preparerCanauxMc(l);
    if (ok.length !== l.length) return res.status(400).json({ erreur: 'Canal invalide : « Public », « #nom » ou « nom=secret » (32 caractères hexadécimaux)' });
    m.canaux = l;
  }
  res.json({ ok: true, redemarrage: true });
  enregistrerReglagesEtRedemarrer({ ...config.reglages, meshcore: m }, u.identifiant);
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
const wss = new WebSocketServer({ noServer: true });
// Module branché sur le PC de l'utilisateur (Web Serial / Web Bluetooth) : la page relaie le flux Meshtastic
const wssModule = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
serveur.on('upgrade', (req, socket, tete) => {
  const chemin = (req.url || '').split('?')[0];
  if (chemin === '/ws') wss.handleUpgrade(req, socket, tete, (ws) => wss.emit('connection', ws, req));
  else if (chemin === '/ws/module' && estAdmin(req)) wssModule.handleUpgrade(req, socket, tete, (ws) => wssModule.emit('connection', ws, req));
  else if (chemin === '/ws/meshcore' && estAdmin(req) && config.meshcore.actif) wssModule.handleUpgrade(req, socket, tete, (ws) => brancherCompanionNavigateur(ws, req));
  else { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); }
});
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
  const q = new URL(req.url, 'http://x').searchParams;
  const nom = (q.get('nom') || `Navigateur ${u ? u.identifiant : ''}`).slice(0, 40);
  const source = (q.get('source') || 'USB').slice(0, 40);
  const flux = fluxWebSocket(ws);
  const precedent = sourceRadio.modules().actif;
  const hote = agents.ajouterVirtuel(nom, source + ' (navigateur)', flux, (req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
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
});
// Companion MeshCore branché sur le PC de l'utilisateur, relayé par la page
function brancherCompanionNavigateur(ws, req) {
  const u = utilisateur(req);
  const q = new URL(req.url, 'http://x').searchParams;
  const source = q.get('source') === 'Bluetooth' ? 'Bluetooth' : 'USB';
  const nom = (q.get('nom') || `${source} ${u ? u.identifiant : ''}`).slice(0, 40);
  companion.brancherNavigateur(fluxWebSocket(ws), nom, source);
  diffuserEtatMc();
}
wss.on('connection', (ws, req) => {
  ws.admin = estMembre(req);
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

function diffuser(message) {
  // Vue publique : sans texte, positions des nœuds de particuliers arrondies
  const pub = JSON.stringify(reseau.vueTrame(message.texte !== undefined ? { ...message, texte: undefined } : message, false));
  const adm = JSON.stringify(message);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(ws.admin ? adm : pub);
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
function dansPerimetreMc(cleObs, iata) {
  const p = config.meshcore.perimetre;
  if (p === 'national') return true;
  const z = p === 'voisins' ? ((zoneVoisins() || {}).bbox || config.zone) : config.zone;
  const pos = reseauMc.positionDe(cleObs);
  if (pos) return pos.lat >= z[0] - 0.05 && pos.lat <= z[2] + 0.05 && pos.lon >= z[1] - 0.05 && pos.lon <= z[3] + 0.05;
  // Position inconnue : code de zone du sujet (le nôtre ou ceux déclarés voisins)
  const code = String(iata || '').toUpperCase();
  return code === config.meshcore.iata || config.meshcore.iataVoisins.includes(code);
}
function messageMc(topic, message) {
  compteurMc.recus++;
  const m = lireMessageMc(topic, message);
  if (!m) return;
  if (m.genre === 'erreur') { compteurMc.erreurs++; return; }
  const moi = companion.etat().cle;
  if (m.cle === moi) return; // nos propres republications
  if (m.genre === 'statut') { reseauMc.noterObservateur(m.cle, { nom: m.nom, etat: m.etat, details: m.details }); planifierEtatMc(); return; }
  // Filtre à la source : on ne garde que ce qu'ont capté les observateurs du périmètre choisi
  if (!dansPerimetreMc(m.cle, m.iata)) { compteurMc.horsPerimetre = (compteurMc.horsPerimetre || 0) + 1; return; }
  if (m.nom) reseauMc.noterObservateur(m.cle, { nom: m.nom, details: { iata: m.iata } });
  const sortie = reseauMc.integrer(m.obs);
  if (sortie) { compteurMc.observations++; diffuser(sortie); }
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
clientMqtt.on('message', (topic, message) => {
  compteur.recus++;
  if (config.meshcore.actif && topic.startsWith(prefixeMc)) { try { messageMc(topic, message); } catch (e) { compteurMc.erreurs++; journal('Erreur MeshCore :', e.message, topic); } return; }
  noterMessageMqtt(topic);
  try {
    const evt = decoderMessage(topic, message, canaux);
    if (!evt) return;
    if (evt.genre === 'erreur') { compteur.erreurs++; return; }
    const sortie = reseau.integrer(evt);
    if (sortie) { compteur.decodes++; diffuser(sortie); }
  } catch (e) {
    compteur.erreurs++;
    journal('Erreur de traitement :', e.message, topic);
  }
});

// ---- Tâches périodiques ---------------------------------------------------
let dernieresAlertes = [];
function rafraichirEtat() {
  dernieresAlertes = reseau.calculerAlertes();
  diffuser({ genre: 'etat', stats: reseau.statistiques(), alertes: dernieresAlertes, meshmonitor: typeof sourceMM !== 'undefined' && sourceMM ? sourceMM.etat() : null, radio: typeof sourceRadio !== 'undefined' && sourceRadio ? sourceRadio.etat() : null });
}
setInterval(rafraichirEtat, 30000);
let minuterieEtatMc = null;
function diffuserEtatMc() {
  if (!config.meshcore.actif) return;
  const c = companion.etat();
  alertesMc = reseauMc.calculerAlertes({ administres: adminMc.memorises(), companion: { cible: c.cible || c.navigateur, connecte: c.connecte, nom: c.nom, cle: c.cle, erreur: c.erreur } });
  diffuser({ genre: 'mc-etat', ...etatMc(false) });
}
function planifierEtatMc() { if (!minuterieEtatMc) minuterieEtatMc = setTimeout(() => { minuterieEtatMc = null; diffuserEtatMc(); }, 15000); } // statuts d'observateurs fréquents : au plus toutes les 15 s
setInterval(diffuserEtatMc, 30000);
const sourceMM = creerSourceMeshMonitor(stockage, config, () => { rafraichirEtat(); diffuser({ genre: 'statut' }); });
if (sourceMM) journal(`Source MeshMonitor activée : ${config.meshmonitor.url}`);
// Agents (module USB sur un PC, ou module Wi-Fi d'un autre réseau) : ils se connectent au port 4404
const agents = creerAgents(config, { surArrivee: (hote, nom) => {
  if (typeof companion !== 'undefined' && companion) companion.agentDisponible(hote);
  if (typeof sourceRadio !== 'undefined' && sourceRadio) { sourceRadio.agentDisponible(hote, nom); rafraichirEtat(); diffuser({ genre: 'statut' }); }
} });
// Companion MeshCore (observateur de la carte) et republication sur le broker
const publicateurMc = creerPublicateurMc(config, (...a) => journal('[MeshCore]', ...a));
const companion = creerCompanion(config, {
  agents,
  journal: (...a) => journal('[MeshCore]', ...a),
  surObservation: (obs) => {
    try {
      const sortie = reseauMc.integrer(obs);
      if (sortie) diffuser(sortie);
      const c = companion.etat();
      if (obs.observateur && config.meshcore.republier) publicateurMc.publier(obs, decoderPaquetMc(obs.brut), c);
    } catch (e) { journal('[MeshCore] observation non traitée :', e.message); }
  },
  surContacts: (liste) => { for (const ct of liste) reseauMc.importerContact(ct); planifierEtatMc(); diffuser({ genre: 'mc-noeuds' }); },
  // Canaux du companion : leurs messages sont déchiffrés aussi (en plus de ceux des réglages)
  surCanaux: (liste) => {
    const tous = [...canauxMc];
    for (const c of preparerCanauxMc(liste.map((x) => ({ nom: x.nom, secret: x.secret })))) if (!tous.some((y) => y.secret === c.secret)) tous.push(c);
    reseauMc.definirCanaux(tous);
  },
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
if (config.meshcore.actif) companion.demarrer();
const adminMc = creerAdministrationMc(config, companion, reseauMc, (...a) => journal('[MeshCore]', ...a), (t) => { if (['statut', 'lire', 'chemin', 'voisins'].includes(t.type)) { planifierEtatMc(); diffuser({ genre: 'mc-noeuds' }); } });
const { creerMaintenanceMc } = require('./meshcore/maintenance');
const maintenanceMc = creerMaintenanceMc({ config, reseauMc, adminMc, companion, journal });
app.get('/api/mc/maintenance', (req, res) => {
  if (!estGestion(req)) return res.status(401).json({ erreur: 'Connexion admin requise' });
  const r = maintenanceMc.etat();
  if (!estAdmin(req)) r.noeuds = r.noeuds.filter((n) => peutGerer(req, n.cle));
  res.set('Cache-Control', 'no-store').json(r);
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
    const sortie = reseau.integrer(evt);
    if (sortie) { compteur.decodes++; diffuser({ ...sortie, viaRadio: true }); }
  },
  apresSynchro: () => { rafraichirEtat(); diffuser({ genre: 'statut' }); },
  estSurveille: (n) => reseau.estSurveille(n),
}, agents);
const administration = creerAdministration(sourceRadio, stockage);
administration.utiliserAgents(agents);
const analyse = creerAnalyse(stockage, config, reseau, () => (sourceRadio ? sourceRadio.etat().preset : null));
const liensMesuresNoeuds = () => fournisseursRelief.liensNoeuds(); // + mesures des nœuds mobiles (couverture mesurée)
const fournisseursRelief = {
  presetCourant: () => (sourceRadio ? sourceRadio.etat().preset : null),
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
app.get('/api/maintenance/:quoi', (req, res) => {
  if (!estMembre(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  const q = req.params.quoi;
  try {
    if (q === 'charge') return res.json(maintenance.chargeRadio());
    if (q === 'autonomie') return res.json(maintenance.autonomie());
    if (q === 'firmwares') return res.json(maintenance.firmwares());
    if (q === 'roles') {
      let couv = null;
      try { if (relief.pret()) couv = couvertureReseauCachee(relief, optsRelief({}), 'mt'); } catch { /* relief pas prêt */ }
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

// ---- Exports et intégrations (GeoJSON, Prometheus/Grafana, Home Assistant) ------------------------
const exportsCarte = creerExports({ config, stockage, reseau, reseauMc, maintenance, santeCarte: { etat: () => santeCarte.etat() }, relief, alertes: () => dernieresAlertes });
const exporter = (f, type) => (req, res) => {
  if (!exportsCarte.jetonOk(req)) return res.status(401).json({ erreur: 'Jeton d’export requis (?jeton=…)' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try { const r = f(req); if (type === 'text') res.type('text/plain; version=0.0.4').send(r); else if (typeof r === 'string') { res.setHeader('Content-Disposition', 'attachment; filename="relais-gaulix.gpx"'); res.type(type).send(r); } else res.type(type).send(JSON.stringify(r)); } catch (e) { res.status(500).json({ erreur: e.message }); }
};
app.get('/api/export/noeuds.geojson', exporter(() => exportsCarte.noeudsGeoJSON(), 'application/geo+json'));
app.get('/api/export/liens.geojson', exporter((req) => exportsCarte.liensGeoJSON(Math.min(Math.max(Number(req.query.heures) || 24, 1), 168)), 'application/geo+json'));
app.get('/api/export/resume.json', exporter(() => exportsCarte.resume(), 'application/json'));
app.get('/publique', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'publique.html')));
app.get('/metrics', exporter(() => exportsCarte.metriques(), 'text'));
app.get('/api/export/relais.gpx', exporter(() => exportsCarte.relaisGpx(), 'application/gpx+xml'));

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

setInterval(() => {
  const n = stockage.purger(config.retentionJours) + reseauMc.purger(config.retentionJours, config.meshcore.retentionPaquetsJours);
  reseau.nettoyer();
  journal(`Purge : ${n} lignes de plus de ${config.retentionJours} jours supprimées · MQTT reçus ${compteur.recus}, traités ${compteur.decodes}, erreurs ${compteur.erreurs}`);
}, 3600000);
stockage.purger(config.retentionJours);
setTimeout(() => reseauMc.purger(config.retentionJours, config.meshcore.retentionPaquetsJours), 60000);
{
  const n = reseau.nettoyer();
  if (n.positions || n.liens) journal(`Nettoyage : ${n.positions} position(s) invalide(s), ${n.liens} lien(s) impossible(s) supprimés`);
}

serveur.listen(config.port, () => journal(`Carte live Meshtastic à l'écoute sur le port ${config.port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    journal('Arrêt…');
    publicateurMc.fermer();
    clientMqtt.end(true);
    stockage.db.close();
    process.exit(0);
  });
}
