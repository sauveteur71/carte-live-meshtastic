'use strict';
// Feux actifs vus par satellite : NASA FIRMS (VIIRS Suomi-NPP, NOAA-20, NOAA-21 et MODIS), fichiers publics
// « Europe 24 h » sans clé, relus toutes les 30 min. On garde 48 h de foyers sur la France métropolitaine et la Corse.
// Un foyer satellite n'est pas une alerte officielle : 1 à 3 h de retard, fausses détections possibles
// (torchère, brûlage agricole, toiture chaude). Données NASA FIRMS, libres d'usage avec citation de la source.
const path = require('path');
const { ecrireSur, lireJson } = require('./fichiers');
const { versDfci } = require('../public/dfci.js');

const BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/';
// Fichiers par région du monde ; la région suit le centre de la carte
const SOURCES = (region) => [
  { id: 'VIIRS NOAA-20', url: `noaa-20-viirs-c2/csv/J1_VIIRS_C2_${region}_24h.csv` },
  { id: 'VIIRS NOAA-21', url: `noaa-21-viirs-c2/csv/J2_VIIRS_C2_${region}_24h.csv` },
  { id: 'VIIRS Suomi-NPP', url: `suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_${region}_24h.csv` },
  { id: 'MODIS', url: `modis-c6.1/csv/MODIS_C6_1_${region}_24h.csv` },
];
const FRANCE = [41.2, -5.6, 51.2, 9.8]; // sud, ouest, nord, est
function regionFirms(lat, lon) {
  if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return 'Europe';
  if (lat >= 49 && lon >= -170 && lon <= -130) return 'Alaska';
  if (lat >= 41.5 && lon >= -141 && lon <= -52) return 'Canada';
  if (lat >= 15 && lat < 50 && lon >= -170 && lon <= -60) return 'USA_contiguous_and_Hawaii';
  if (lat >= 5 && lat < 33 && lon >= -120 && lon <= -60) return 'Central_America';
  if (lat < 15 && lon >= -95 && lon <= -30) return 'South_America';
  if (lat >= -5 && lat < 38 && lon >= -25 && lon <= 60) return 'Northern_and_Central_Africa';
  if (lat < -5 && lon >= 5 && lon <= 60) return 'Southern_Africa';
  if (lat <= -9 && lon >= 110) return 'Australia_NewZealand';
  if (lat < 30 && lon >= 60 && lon < 95) return 'South_Asia';
  if (lat < 30 && lon >= 95) return 'SouthEast_Asia';
  return 'Russia_Asia';
}
// Meteosat (SEVIRI, géostationnaire) : produit FRP-PIXEL du LSA SAF (EUMETSAT), une image toutes les 15 min.
// La liste des fichiers est publique ; leur téléchargement demande un compte gratuit (LSASAF_UTILISATEUR,
// LSASAF_MOT_DE_PASSE dans le .env). Pixel d'environ 4 km sur la France : position approchée. Licence CC BY 4.0.
const LSASAF = 'https://datalsasaf.lsasvcs.ipma.pt/PRODUCTS/MSG/FRP-PIXEL/HDF5/';

// Lecture d'un fichier « ListProduct » (HDF5, parfois compressé en bzip2) : un foyer par ligne
async function lireListeMeteosat(buf, heure, emprise = FRANCE) {
  if (buf.slice(0, 3).toString() === 'BZh') buf = Buffer.from(require('seek-bzip').decode(buf));
  const h5 = await import('h5wasm/node');
  await h5.ready;
  const nom = '/frp-' + process.pid + '-' + Date.now() + '.h5';
  h5.FS.writeFile(nom, buf);
  const f = new h5.File(nom, 'r');
  try {
    const cles = f.keys();
    const trouver = (re) => cles.find((k) => re.test(k));
    const lire = (k) => {
      if (!k) return null;
      const d = f.get(k), v = Array.from(d.value || []);
      const a = d.attrs || {};
      const sf = Number((a.SCALING_FACTOR || a.scale_factor || {}).value) || 1;
      const off = Number((a.OFFSET || a.add_offset || {}).value) || 0;
      return v.map((x) => (Number(x) - off) / sf);
    };
    const lat = lire(trouver(/^LATITUDE$/i)), lon = lire(trouver(/^LONGITUDE$/i));
    if (!lat || !lon) throw new Error('jeux de données inattendus : ' + cles.join(', '));
    const frp = lire(trouver(/^FRP$/i)), conf = lire(trouver(/CONFIDENCE/i));
    const l = [];
    for (let i = 0; i < lat.length; i++) {
      const la = lat[i], lo = lon[i];
      if (!(la >= emprise[0] && la <= emprise[2] && lo >= emprise[1] && lo <= emprise[3])) continue;
      const c = conf ? conf[i] : null;
      l.push({ lat: Math.round(la * 1e4) / 1e4, lon: Math.round(lo * 1e4) / 1e4, heure, source: 'Meteosat SEVIRI', geo: true,
        confiance: c == null ? 'normale' : (c > 1 ? c / 100 : c) >= 0.8 ? 'haute' : (c > 1 ? c / 100 : c) >= 0.5 ? 'normale' : 'faible',
        frp: frp && Number.isFinite(frp[i]) ? Math.round(frp[i] * 10) / 10 : null, nuit: null });
    }
    return l;
  } finally { try { f.close(); } catch { /* déjà fermé */ } try { h5.FS.unlink(nom); } catch { /* absent */ } }
}
const GARDE_MS = 48 * 3600000;

// Confiance : VIIRS donne low/nominal/high (ou l/n/h), MODIS un pourcentage
function confiance(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 80 ? 'haute' : n >= 30 ? 'normale' : 'faible'; }
  return { h: 'haute', high: 'haute', n: 'normale', nominal: 'normale', l: 'faible', low: 'faible' }[s] || 'normale';
}

function lireCsv(txt, source, emprise = FRANCE) {
  const lignes = txt.split(/\r?\n/).filter(Boolean);
  if (lignes.length < 1) return [];
  const t = lignes[0].split(',');
  const i = (n) => t.indexOf(n);
  const [iLat, iLon, iDate, iHeure, iConf, iFrp, iJN] = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp', 'daynight'].map(i);
  if (iLat < 0 || iLon < 0 || iDate < 0) throw new Error('format inattendu');
  const l = [];
  for (const ligne of lignes.slice(1)) {
    const c = ligne.split(',');
    const lat = Number(c[iLat]), lon = Number(c[iLon]);
    if (!(lat >= emprise[0] && lat <= emprise[2] && lon >= emprise[1] && lon <= emprise[3])) continue;
    const h = String(c[iHeure] || '0').padStart(4, '0');
    const heure = Date.parse(`${c[iDate]}T${h.slice(0, 2)}:${h.slice(2)}:00Z`);
    if (!heure) continue;
    l.push({ lat, lon, heure, source, confiance: confiance(c[iConf]), frp: iFrp >= 0 ? Number(c[iFrp]) || null : null, nuit: iJN >= 0 ? c[iJN] === 'N' : null });
  }
  return l;
}

function creerFeux({ config, journal = () => {}, diffuser = () => {} }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'feux.json');
  // Emprise gardée : la France métropolitaine si la carte y est, sinon sa zone élargie de 3°
  const z = config.zone || FRANCE, cLat = (z[0] + z[2]) / 2, cLon = (z[1] + z[3]) / 2;
  const enFrance = cLat >= FRANCE[0] && cLat <= FRANCE[2] && cLon >= FRANCE[1] && cLon <= FRANCE[3];
  const emprise = enFrance ? FRANCE : [z[0] - 3, z[1] - 3, z[2] + 3, z[3] + 3];
  const region = regionFirms(cLat, cLon);
  let foyers = [], maj = null, erreur = null;
  const msg = { actif: !!(process.env.LSASAF_UTILISATEUR && process.env.LSASAF_MOT_DE_PASSE), dernier: null, maj: null, erreur: null };
  try { const d = lireJson(fichier); foyers = Array.isArray(d.foyers) ? d.foyers : []; maj = d.maj || null; msg.dernier = d.meteosatDernier || null; } catch { /* aucun */ }

  async function lire() {
    const nouveaux = [], erreurs = [];
    const sources = SOURCES(region);
    for (const s of sources) {
      try {
        const r = await fetch(BASE + s.url, { headers: { 'User-Agent': 'carte-live-meshtastic' }, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        nouveaux.push(...lireCsv(await r.text(), s.id, emprise));
      } catch (e) { erreurs.push(`${s.id} : ${e.message}`); }
    }
    if (erreurs.length === sources.length) { erreur = erreurs.join(' · '); journal('[Feux] lecture impossible :', erreur); return; }
    erreur = erreurs.length ? erreurs.join(' · ') : null;
    // Fusion : un même foyer (même satellite, même passage, même point) n'est gardé qu'une fois
    const cle = (f) => `${f.source}|${f.heure}|${f.lat.toFixed(4)}|${f.lon.toFixed(4)}`;
    const vus = new Map(foyers.map((f) => [cle(f), f]));
    for (const f of nouveaux) vus.set(cle(f), f);
    const lim = Date.now() - GARDE_MS;
    foyers = [...vus.values()].filter((f) => f.heure >= lim).sort((a, b) => b.heure - a.heure);
    maj = Date.now();
    enregistrer();
  }
  function enregistrer() {
    try { ecrireSur(fichier, JSON.stringify({ maj, foyers, meteosatDernier: msg.dernier })); } catch { /* lecture seule */ }
    cacheAlertes = null;
    diffuser({ genre: 'feux', maj, nb: foyers.length });
  }

  // Meteosat : les images de la dernière heure pas encore lues (4 au plus par passage)
  async function lireMeteosat() {
    if (!msg.actif) return;
    const auth = 'Basic ' + Buffer.from(`${process.env.LSASAF_UTILISATEUR}:${process.env.LSASAF_MOT_DE_PASSE}`).toString('base64');
    try {
      const noms = [];
      for (const j of [0, 1]) { // aujourd'hui et hier (passage de minuit UTC)
        const d = new Date(Date.now() - j * 86400000);
        const dossier = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/`;
        const r = await fetch(LSASAF + dossier, { headers: { 'User-Agent': 'carte-live-meshtastic' }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        for (const m of (await r.text()).matchAll(/HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_(\d{12})(\.bz2)?/g)) noms.push({ dossier, nom: m[0], ts: m[1] });
      }
      const heureDe = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
      const lim = Date.now() - 3600000;
      const aLire = [...new Map(noms.map((x) => [x.ts, x])).values()].filter((x) => x.ts > (msg.dernier || '') && heureDe(x.ts) >= lim).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-4);
      for (const x of aLire) {
        const r = await fetch(LSASAF + x.dossier + x.nom, { headers: { Authorization: auth, 'User-Agent': 'carte-live-meshtastic' }, signal: AbortSignal.timeout(60000) });
        if (r.status === 401 || r.status === 403) throw new Error('identifiants LSA SAF refusés (LSASAF_UTILISATEUR, LSASAF_MOT_DE_PASSE)');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const l = await lireListeMeteosat(Buffer.from(await r.arrayBuffer()), heureDe(x.ts), emprise);
        const vus = new Set(foyers.map((f) => `${f.source}|${f.heure}|${f.lat}|${f.lon}`));
        for (const f of l) if (!vus.has(`${f.source}|${f.heure}|${f.lat}|${f.lon}`)) foyers.push(f);
        msg.dernier = x.ts;
      }
      msg.maj = Date.now(); msg.erreur = null;
      if (aLire.length) {
        foyers = foyers.filter((f) => f.heure >= Date.now() - GARDE_MS).sort((a, b) => b.heure - a.heure);
        enregistrer();
      }
    } catch (e) { msg.erreur = e.message; journal('[Feux] Meteosat :', e.message); }
  }
  if (msg.actif) {
    setTimeout(() => lireMeteosat(), 40000).unref();
    setInterval(() => lireMeteosat(), 5 * 60000).unref();
  }
  setTimeout(() => lire().catch((e) => journal('[Feux]', e.message)), 20000).unref();
  setInterval(() => lire().catch((e) => journal('[Feux]', e.message)), 30 * 60000).unref();

  const avecDfci = (f) => { try { return { ...f, dfci: versDfci(f.lat, f.lon) || null }; } catch { return f; } };
  function etat(heures = 24) {
    const lim = Date.now() - Math.min(Math.max(Number(heures) || 24, 1), 48) * 3600000;
    return { maj, erreur, source: 'NASA FIRMS (VIIRS, MODIS)' + (msg.actif ? ' et Meteosat (EUMETSAT LSA SAF)' : ''),
      meteosat: { actif: msg.actif, maj: msg.maj, erreur: msg.erreur, dernierFichier: msg.dernier }, foyers: foyers.filter((f) => f.heure >= lim).map(avecDfci) };
  }

  // Alertes : foyers des 12 dernières heures dans la zone de la carte (hors confiance faible), regroupés par carreau DFCI de 2 km
  let cacheAlertes = null;
  function alertes() {
    if (cacheAlertes && Date.now() - cacheAlertes.heure < 5 * 60000) return cacheAlertes.l;
    const z = config.zone, lim = Date.now() - 12 * 3600000;
    const groupes = new Map();
    for (const f of foyers) {
      if (f.heure < lim || f.confiance === 'faible') continue;
      if (!(f.lat >= z[0] - 0.02 && f.lat <= z[2] + 0.02 && f.lon >= z[1] - 0.02 && f.lon <= z[3] + 0.02)) continue;
      const g = avecDfci(f), k = g.dfci ? g.dfci.split('.')[0] : `${f.lat.toFixed(2)},${f.lon.toFixed(2)}`; // carreau de 2 km
      const x = groupes.get(k) || { ...g, nb: 0, premier: f.heure, dernier: f.heure };
      x.nb++; x.premier = Math.min(x.premier, f.heure); x.dernier = Math.max(x.dernier, f.heure);
      groupes.set(k, x);
    }
    const l = [...groupes.entries()].map(([k, g]) => ({
      cle: 'feu:' + k, type: 'feu', niveau: g.confiance === 'haute' || g.nb > 1 ? 'critique' : 'attention', depuis: g.premier, lat: g.lat, lon: g.lon, dfci: g.dfci || null,
      message: texte(g),
    }));
    cacheAlertes = { heure: Date.now(), l };
    return l;
  }
  function texte(g) {
    const h = new Date(g.dernier || g.heure).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    if (g.geo) return `🔥 Foyer Meteosat${g.nb > 1 ? ` (${g.nb} détections)` : ''}${g.dfci ? ` carreau DFCI ${g.dfci}` : ''} ${g.lat.toFixed(3)}, ${g.lon.toFixed(3)} (±3 km) · vu à ${new Date(g.dernier || g.heure).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })} · non confirmé`;
    return `🔥 Foyer satellite${g.nb > 1 ? ` (${g.nb} détections)` : ''}${g.dfci ? ` carreau DFCI ${g.dfci}` : ''} ${g.lat.toFixed(4)}, ${g.lon.toFixed(4)} · vu à ${h} (${g.source}) · non confirmé`;
  }
  // Texte court pour l'envoi radio à la demande
  function texteAlerte(cle) {
    const a = alertes().find((x) => x.cle === cle);
    if (!a) throw new Error('Foyer terminé ou inconnu : rechargez la liste');
    return a.message;
  }

  return { etat, alertes, texteAlerte, lire, lireMeteosat };
}

module.exports = { creerFeux, lireCsv, confiance, lireListeMeteosat };
