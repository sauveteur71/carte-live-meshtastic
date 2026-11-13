'use strict';
// Feux actifs vus par satellite : NASA FIRMS (VIIRS Suomi-NPP, NOAA-20, NOAA-21 et MODIS), fichiers publics
// « Europe 24 h » sans clé, relus toutes les 30 min. On garde 48 h de foyers sur la France métropolitaine et la Corse.
// Un foyer satellite n'est pas une alerte officielle : 1 à 3 h de retard, fausses détections possibles
// (torchère, brûlage agricole, toiture chaude). Données NASA FIRMS, libres d'usage avec citation de la source.
const path = require('path');
const { ecrireSur, lireJson } = require('./fichiers');
const { versDfci } = require('../public/dfci.js');

const BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/';
const SOURCES = [
  { id: 'VIIRS NOAA-20', url: 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv' },
  { id: 'VIIRS NOAA-21', url: 'noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv' },
  { id: 'VIIRS Suomi-NPP', url: 'suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv' },
  { id: 'MODIS', url: 'modis-c6.1/csv/MODIS_C6_1_Europe_24h.csv' },
];
const FRANCE = [41.2, -5.6, 51.2, 9.8]; // sud, ouest, nord, est
const GARDE_MS = 48 * 3600000;

// Confiance : VIIRS donne low/nominal/high (ou l/n/h), MODIS un pourcentage
function confiance(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 80 ? 'haute' : n >= 30 ? 'normale' : 'faible'; }
  return { h: 'haute', high: 'haute', n: 'normale', nominal: 'normale', l: 'faible', low: 'faible' }[s] || 'normale';
}

function lireCsv(txt, source) {
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
    if (!(lat >= FRANCE[0] && lat <= FRANCE[2] && lon >= FRANCE[1] && lon <= FRANCE[3])) continue;
    const h = String(c[iHeure] || '0').padStart(4, '0');
    const heure = Date.parse(`${c[iDate]}T${h.slice(0, 2)}:${h.slice(2)}:00Z`);
    if (!heure) continue;
    l.push({ lat, lon, heure, source, confiance: confiance(c[iConf]), frp: iFrp >= 0 ? Number(c[iFrp]) || null : null, nuit: iJN >= 0 ? c[iJN] === 'N' : null });
  }
  return l;
}

function creerFeux({ config, journal = () => {}, diffuser = () => {} }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'feux.json');
  let foyers = [], maj = null, erreur = null;
  try { const d = lireJson(fichier); foyers = Array.isArray(d.foyers) ? d.foyers : []; maj = d.maj || null; } catch { /* aucun */ }

  async function lire() {
    const nouveaux = [], erreurs = [];
    for (const s of SOURCES) {
      try {
        const r = await fetch(BASE + s.url, { headers: { 'User-Agent': 'carte-live-meshtastic' }, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        nouveaux.push(...lireCsv(await r.text(), s.id));
      } catch (e) { erreurs.push(`${s.id} : ${e.message}`); }
    }
    if (erreurs.length === SOURCES.length) { erreur = erreurs.join(' · '); journal('[Feux] lecture impossible :', erreur); return; }
    erreur = erreurs.length ? erreurs.join(' · ') : null;
    // Fusion : un même foyer (même satellite, même passage, même point) n'est gardé qu'une fois
    const cle = (f) => `${f.source}|${f.heure}|${f.lat.toFixed(4)}|${f.lon.toFixed(4)}`;
    const vus = new Map(foyers.map((f) => [cle(f), f]));
    for (const f of nouveaux) vus.set(cle(f), f);
    const lim = Date.now() - GARDE_MS;
    foyers = [...vus.values()].filter((f) => f.heure >= lim).sort((a, b) => b.heure - a.heure);
    maj = Date.now();
    try { ecrireSur(fichier, JSON.stringify({ maj, foyers })); } catch { /* lecture seule */ }
    cacheAlertes = null;
    diffuser({ genre: 'feux', maj, nb: foyers.length });
  }
  setTimeout(() => lire().catch((e) => journal('[Feux]', e.message)), 20000).unref();
  setInterval(() => lire().catch((e) => journal('[Feux]', e.message)), 30 * 60000).unref();

  const avecDfci = (f) => { try { return { ...f, dfci: versDfci(f.lat, f.lon) || null }; } catch { return f; } };
  function etat(heures = 24) {
    const lim = Date.now() - Math.min(Math.max(Number(heures) || 24, 1), 48) * 3600000;
    return { maj, erreur, source: 'NASA FIRMS (VIIRS, MODIS)', foyers: foyers.filter((f) => f.heure >= lim).map(avecDfci) };
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
    return `🔥 Foyer satellite${g.nb > 1 ? ` (${g.nb} détections)` : ''}${g.dfci ? ` carreau DFCI ${g.dfci}` : ''} ${g.lat.toFixed(4)}, ${g.lon.toFixed(4)} · vu à ${h} (${g.source}) · non confirmé`;
  }
  // Texte court pour l'envoi radio à la demande
  function texteAlerte(cle) {
    const a = alertes().find((x) => x.cle === cle);
    if (!a) throw new Error('Foyer terminé ou inconnu : rechargez la liste');
    return a.message;
  }

  return { etat, alertes, texteAlerte, lire };
}

module.exports = { creerFeux, lireCsv, confiance };
