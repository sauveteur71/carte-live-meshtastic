'use strict';
// Relief et planification radio : modèle numérique de terrain (IGN RGE ALTI), points hauts (OSM + MNT),
// couverture LoRa par site (balayage radial, courbure terrestre, diffraction lame de couteau),
// classement des meilleurs sites et propositions de sites pour couvrir un point.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const R_TERRE = 6371000;
const K = 4 / 3;
const FREQ = 869.525e6;
const LAMBDA = 299792458 / FREQ;
const M_PAR_DEG = 111320;
const PARAMS_LORA = {
  LONG_FAST: { sf: 11, bw: 250 }, LONG_SLOW: { sf: 12, bw: 125 }, VERY_LONG_SLOW: { sf: 12, bw: 62.5 },
  MEDIUM_SLOW: { sf: 10, bw: 250 }, MEDIUM_FAST: { sf: 9, bw: 250 }, SHORT_SLOW: { sf: 8, bw: 250 },
  SHORT_FAST: { sf: 7, bw: 250 }, LONG_MODERATE: { sf: 11, bw: 125 }, SHORT_TURBO: { sf: 7, bw: 500 }, LONG_TURBO: { sf: 11, bw: 500 },
  // MeshCore, réglage du réseau français (869,618 MHz)
  MESHCORE_FR: { sf: 8, bw: 62.5 },
};
const SNR_LIMITE = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

// Perte de diffraction lame de couteau (ITU-R P.526)
const diffraction = (v) => (v > -0.78 ? 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1) : 0);

function distanceM(a, b) {
  const r = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R_TERRE * Math.asin(Math.sqrt(s));
}

// ---- Encodeur PNG minimal (RGBA) ------------------------------------------------
const TABLE_CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function bloc(type, donnees) {
  const l = Buffer.alloc(4); l.writeUInt32BE(donnees.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), donnees]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
}
function png(largeur, hauteur, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const brut = Buffer.alloc((largeur * 4 + 1) * hauteur);
  for (let y = 0; y < hauteur; y++) {
    brut[y * (largeur * 4 + 1)] = 0;
    rgba.copy(brut, y * (largeur * 4 + 1) + 1, y * largeur * 4, (y + 1) * largeur * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bloc('IHDR', ihdr), bloc('IDAT', zlib.deflateSync(brut, { level: 6 })), bloc('IEND', Buffer.alloc(0))]);
}

// Contour d'un département : fichier détaillé s'il existe (Haute-Loire), sinon contour simplifié national
function contourDepartement(code) {
  const ref = path.join(__dirname, '..', 'donnees-ref');
  try {
    const g = JSON.parse(fs.readFileSync(path.join(ref, `departement-${code}.geojson`), 'utf8'));
    return g.geometry || g.features[0].geometry;
  } catch { /* pas de fichier détaillé */ }
  try {
    const g = JSON.parse(fs.readFileSync(path.join(ref, 'departements.geojson'), 'utf8'));
    const f = g.features.find((x) => x.properties.code === code);
    return f ? f.geometry : null;
  } catch { return null; }
}

const { creerAcces, NIVEAUX: NIVEAUX_ACCES } = require('./acces');
const { creerRealisme } = require('./realisme');

// Rectangle englobant [sud, ouest, nord, est] d'un département (contour national)
function rectangleDepartement(code) {
  const g = contourDepartement(code);
  if (!g) return null;
  const anneauxG = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  let sud = 90, ouest = 180, nord = -90, est = -180;
  for (const a of anneauxG) for (const [lon, lat] of a) { sud = Math.min(sud, lat); nord = Math.max(nord, lat); ouest = Math.min(ouest, lon); est = Math.max(est, lon); }
  return [sud, ouest, nord, est];
}
function nomDepartement(code) {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson'), 'utf8'));
    const f = g.features.find((x) => x.properties.code === code);
    return f ? f.properties.nom : null;
  } catch { return null; }
}
function listeDepartements() {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson'), 'utf8'));
    return g.features.map((f) => ({ code: f.properties.code, nom: f.properties.nom })).sort((a, b) => a.code.localeCompare(b.code));
  } catch { return []; }
}

// options.code : étudier un autre département que celui de la carte (relief, sites, plan), avec ses propres fichiers en cache
function creerRelief(config, journal, fournisseurs, options = {}) {
  const dossier = path.dirname(config.fichierBase);
  const codeDep = String(options.code || (config.departement && config.departement.code) || '43');
  const suffixe = options.code ? '-' + codeDep : '';
  const fMnt = path.join(dossier, `mnt${suffixe}.bin`);
  const fMntInfo = path.join(dossier, `mnt${suffixe}.json`);
  const fSommets = path.join(dossier, `sommets-osm${suffixe}.json`);
  const acces = creerAcces(dossier, journal, suffixe);
  const minuteries = [];
  const niveauMin = (filtre) => NIVEAUX_ACCES[filtre] || 0; // tous = 0
  const accessible = (s, min) => !min || (s.acces && s.acces.niveau >= min);
  const marge = 0.2; // degrés autour de la zone
  const z0 = options.code ? rectangleDepartement(codeDep) : config.zone; // [sud, ouest, nord, est]
  if (!z0) throw new Error(`Département ${codeDep} inconnu`);
  const emprise = { sud: z0[0] - marge, ouest: z0[1] - marge, nord: z0[2] + marge, est: z0[3] + marge };
  const pasLat = 250 / M_PAR_DEG;
  const latMoy = ((emprise.sud + emprise.nord) / 2) * (Math.PI / 180);
  const pasLon = 250 / (M_PAR_DEG * Math.cos(latMoy));
  const nLat = Math.round((emprise.nord - emprise.sud) / pasLat) + 1;
  const nLon = Math.round((emprise.est - emprise.ouest) / pasLon) + 1;
  const aireCelleKm2 = 0.0625;

  const realisme = creerRealisme(dossier, journal, suffixe, emprise);
  const etat = { mnt: 'absent', progression: 0, erreur: null, sommets: 0, classement: 'absent', calculEnCours: false, maj: null };
  let Z = null; // Float32Array nLat*nLon, ligne 0 = sud
  let masque = null; // Uint8Array : 1 si la cellule est dans le département
  let indexZone = null; // Int32Array : index compact dans la zone, -1 sinon
  let nbZone = 0;
  let sommets = [];
  let classement = null;

  // ---- Contour du département -----------------------------------------------------
  let anneaux = [];
  try {
    const geom = contourDepartement(codeDep);
    if (!geom) throw new Error('contour inconnu');
    anneaux = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  } catch {
    anneaux = [[[z0[1], z0[0]], [z0[3], z0[0]], [z0[3], z0[2]], [z0[1], z0[2]], [z0[1], z0[0]]]];
  }
  function dansDepartement(lat, lon) {
    let dedans = false;
    for (const a of anneaux) {
      for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
        const [xi, yi] = a[i], [xj, yj] = a[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dedans = !dedans;
      }
    }
    return dedans;
  }

  // ---- Modèle numérique de terrain ------------------------------------------------
  const latDe = (i) => emprise.sud + i * pasLat;
  const lonDe = (j) => emprise.ouest + j * pasLon;
  function alt(lat, lon) {
    const fi = (lat - emprise.sud) / pasLat, fj = (lon - emprise.ouest) / pasLon;
    const i = Math.floor(fi), j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= nLat - 1 || j >= nLon - 1) return NaN;
    const di = fi - i, dj = fj - j;
    const a = Z[i * nLon + j], b = Z[i * nLon + j + 1], c = Z[(i + 1) * nLon + j], d = Z[(i + 1) * nLon + j + 1];
    return a * (1 - di) * (1 - dj) + b * (1 - di) * dj + c * di * (1 - dj) + d * di * dj;
  }
  const celle = (lat, lon) => {
    const i = Math.round((lat - emprise.sud) / pasLat), j = Math.round((lon - emprise.ouest) / pasLon);
    return i < 0 || j < 0 || i >= nLat || j >= nLon ? -1 : i * nLon + j;
  };

  async function telechargerMnt() {
    etat.mnt = 'chargement';
    const total = nLat * nLon;
    const z = new Float32Array(total).fill(NaN);
    const TAILLE = 4900;
    journal(`[Relief] téléchargement du MNT IGN : ${nLat} × ${nLon} points (pas 250 m)…`);
    for (let debut = 0; debut < total; debut += TAILLE) {
      const lats = [], lons = [];
      for (let k = debut; k < Math.min(total, debut + TAILLE); k++) {
        lats.push(latDe(Math.floor(k / nLon)).toFixed(5));
        lons.push(lonDe(k % nLon).toFixed(5));
      }
      let ok = false;
      for (let essai = 0; essai < 4 && !ok; essai++) {
        try {
          const r = await fetch('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lon: lons.join('|'), lat: lats.join('|'), resource: 'ign_rge_alti_wld', zonly: 'true', delimiter: '|' }),
            signal: AbortSignal.timeout(90000),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          (j.elevations || []).forEach((v, k) => { z[debut + k] = v > -1000 ? v : NaN; });
          ok = true;
        } catch (e) {
          journal(`[Relief] bloc ${debut} : ${e.message}, nouvel essai`);
          await new Promise((res) => setTimeout(res, 3000 * (essai + 1)));
        }
      }
      if (!ok) throw new Error('Service altimétrique IGN indisponible');
      etat.progression = Math.round(((debut + TAILLE) / total) * 100);
    }
    // Comble les trous (mer, absence de données) par la moyenne des voisins
    for (let passe = 0; passe < 3; passe++) {
      for (let k = 0; k < total; k++) {
        if (!Number.isNaN(z[k])) continue;
        let s = 0, n = 0;
        for (const v of [z[k - 1], z[k + 1], z[k - nLon], z[k + nLon]]) if (v !== undefined && !Number.isNaN(v)) { s += v; n++; }
        if (n) z[k] = s / n;
      }
    }
    for (let k = 0; k < total; k++) if (Number.isNaN(z[k])) z[k] = 0;
    fs.writeFileSync(fMnt, Buffer.from(z.buffer));
    fs.writeFileSync(fMntInfo, JSON.stringify({ emprise, pasLat, pasLon, nLat, nLon, source: 'IGN RGE ALTI', date: Date.now() }));
    return z;
  }

  async function chargerMnt() {
    try {
      const info = JSON.parse(fs.readFileSync(fMntInfo, 'utf8'));
      if (info.nLat === nLat && info.nLon === nLon && Math.abs(info.emprise.sud - emprise.sud) < 1e-6 && Math.abs(info.emprise.ouest - emprise.ouest) < 1e-6) {
        const b = fs.readFileSync(fMnt);
        Z = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
        journal(`[Relief] MNT chargé depuis le disque (${nLat} × ${nLon})`);
      }
    } catch { /* pas de cache */ }
    if (!Z) Z = await telechargerMnt();
    masque = new Uint8Array(nLat * nLon);
    indexZone = new Int32Array(nLat * nLon).fill(-1);
    nbZone = 0;
    for (let i = 0; i < nLat; i++) {
      // Intersections de la ligne de latitude avec le contour (règle pair-impair)
      const lat = latDe(i), x = [];
      for (const a of anneaux) for (let p = 0, q = a.length - 1; p < a.length; q = p++) {
        const [xi, yi] = a[p], [xj, yj] = a[q];
        if (yi > lat !== yj > lat) x.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      }
      x.sort((u, v) => u - v);
      for (let k = 0; k + 1 < x.length; k += 2) {
        const j0 = Math.max(0, Math.ceil((x[k] - emprise.ouest) / pasLon)), j1 = Math.min(nLon - 1, Math.floor((x[k + 1] - emprise.ouest) / pasLon));
        for (let j = j0; j <= j1; j++) masque[i * nLon + j] = 1;
      }
      for (let j = 0; j < nLon; j++) if (masque[i * nLon + j]) indexZone[i * nLon + j] = nbZone++;
    }
    etat.mnt = 'pret';
    etat.progression = 100;
    journal(`[Relief] MNT prêt : ${nbZone} cellules dans le département (${Math.round(nbZone * aireCelleKm2)} km²)`);
  }

  // ---- Points hauts ---------------------------------------------------------------
  async function sommetsOsm() {
    try {
      const q = `[out:json][timeout:60];node["natural"="peak"](${emprise.sud},${emprise.ouest},${emprise.nord},${emprise.est});out body;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'User-Agent': 'carte-live-meshtastic/1.0 (+https://github.com/sauveteur71/carte-live-meshtastic)', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const liste = j.elements.map((e) => ({ lat: e.lat, lon: e.lon, nom: e.tags && e.tags.name ? e.tags.name : null, ele: e.tags && e.tags.ele ? parseFloat(String(e.tags.ele).replace(',', '.')) : null }));
      fs.writeFileSync(fSommets, JSON.stringify({ date: Date.now(), liste }));
      return liste;
    } catch (e) {
      journal('[Relief] sommets OSM indisponibles (' + e.message + '), utilisation du cache');
      try { return JSON.parse(fs.readFileSync(fSommets, 'utf8')).liste; } catch { return []; }
    }
  }

  // Commune de chaque point haut (API Géo de l'État), mise en cache sur disque
  const fCommunes = path.join(dossier, 'communes-sommets.json');
  async function nommerCommunes(liste) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(fCommunes, 'utf8')); } catch { /* vide */ }
    let nouveaux = 0;
    for (const s of liste) {
      const cle = s.lat.toFixed(3) + ',' + s.lon.toFixed(3);
      if (cache[cle] === undefined) {
        try {
          const r = await fetch(`https://geo.api.gouv.fr/communes?lat=${s.lat.toFixed(5)}&lon=${s.lon.toFixed(5)}&fields=nom,codeDepartement`, { signal: AbortSignal.timeout(10000) });
          const j = r.ok ? await r.json() : [];
          cache[cle] = j[0] ? `${j[0].nom} (${j[0].codeDepartement})` : null;
          nouveaux++;
          await new Promise((res) => setTimeout(res, 120));
        } catch { break; }
      }
      s.commune = cache[cle] || null;
    }
    if (nouveaux) { try { fs.writeFileSync(fCommunes, JSON.stringify(cache)); } catch { /* ignore */ } journal(`[Relief] communes des points hauts : ${nouveaux} recherchées`); }
  }

  function dominance(i, j, rayon) {
    const z = Z[i * nLon + j];
    let s = 0, n = 0;
    for (let di = -rayon; di <= rayon; di += 2) for (let dj = -rayon; dj <= rayon; dj += 2) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nLat || jj >= nLon) continue;
      s += Z[ii * nLon + jj]; n++;
    }
    return n ? z - s / n : 0;
  }

  async function calculerSommets() {
    const osm = await sommetsOsm();
    const liste = [];
    // Sommets OpenStreetMap (nommés en priorité)
    for (const p of osm) {
      const k = celle(p.lat, p.lon);
      if (k < 0) continue;
      const i = Math.floor(k / nLon), j = k % nLon;
      liste.push({ lat: p.lat, lon: p.lon, nom: p.nom, alt: p.ele || Math.round(alt(p.lat, p.lon)), altMnt: Math.round(alt(p.lat, p.lon)), source: 'osm', dominance: Math.round(dominance(i, j, 12)) });
    }
    // Bosses dominantes détectées dans le MNT (maximum local sur 1,5 km, au moins 40 m au-dessus des environs à 3 km)
    const R1 = 6;
    for (let i = R1; i < nLat - R1; i += 2) for (let j = R1; j < nLon - R1; j += 2) {
      const z = Z[i * nLon + j];
      let max = true;
      for (let di = -R1; di <= R1 && max; di++) for (let dj = -R1; dj <= R1; dj++) {
        if (Z[(i + di) * nLon + j + dj] > z) { max = false; break; }
      }
      if (!max) continue;
      const dom = dominance(i, j, 12);
      if (dom < 40) continue;
      const lat = latDe(i), lon = lonDe(j);
      if (liste.some((s) => distanceM(s, { lat, lon }) < 700)) continue;
      liste.push({ lat, lon, nom: null, alt: Math.round(z), altMnt: Math.round(z), source: 'mnt', dominance: Math.round(dom) });
    }
    liste.forEach((s, k) => { s.id = k; s.dansZone = dansDepartement(s.lat, s.lon); });
    sommets = liste;
    nommerCommunes(liste); // en arrière-plan
    acces.completer(liste.filter((x) => x.dansZone || distanceAuDepartement(x) < 10000)).catch((e) => journal('[Accès] erreur :', e.message));
    realisme.completer(liste.filter((x) => x.dansZone || distanceAuDepartement(x) < 10000)).catch((e) => journal('[Sites] erreur :', e.message));
    etat.sommets = liste.length;
    journal(`[Relief] ${liste.length} points hauts (${osm.length} sommets OSM, ${liste.filter((s) => s.source === 'mnt').length} détectés dans le relief)`);
  }

  // ---- Modèle de propagation ------------------------------------------------------
  let calibration = null;
  /** Compare le modèle aux SNR réellement mesurés entre nœuds positionnés : pertes d'environnement (végétation, bâti) */
  function calibrer() {
    const liens = (fournisseurs.liensMesures ? fournisseurs.liensMesures() : []).filter((l) => celle(l.a.lat, l.a.lon) >= 0 && celle(l.b.lat, l.b.lon) >= 0);
    const P = parametres({ env: 0, marge: 0 });
    const bruit = P.seuil - SNR_LIMITE[PARAMS_LORA[P.preset].sf];
    const ecarts = [];
    for (const l of liens) {
      const D = distanceM(l.a, l.b);
      if (D < 1000 || D > 80000) continue;
      const r = liaison(l.a, l.b, P, 3, 3);
      if (!r) continue;
      const snrPredit = P.ptx + P.gains - P.pertes - fspl(D) - r.diffraction - bruit;
      // Le SNR lu par un module LoRa plafonne vers +10 dB : on compare dans la plage mesurable
      const comparable = Math.min(snrPredit, 10);
      if (comparable >= 9 && l.snr >= 8) continue;
      ecarts.push({ ecart: comparable - l.snr, nom: l.nom, km: +(D / 1000).toFixed(1), snr: l.snr, predit: +snrPredit.toFixed(1) });
    }
    ecarts.sort((x, y) => x.ecart - y.ecart);
    const med = ecarts.length ? ecarts[Math.floor(ecarts.length / 2)].ecart : null;
    calibration = {
      liaisons: ecarts.length,
      ecartMedianDb: med == null ? null : +med.toFixed(1),
      // Le SNR mesuré ne descend pas sous la sensibilité : l'écart est sous-estimé, on garde la médiane bornée
      perteEnvironnementDb: ecarts.length >= 5 ? Math.round(Math.min(30, Math.max(4, med))) : null,
      exemples: ecarts.slice(0, 40),
      date: Date.now(),
    };
    journal(`[Relief] calibration : ${ecarts.length} liaisons mesurées, écart médian modèle − mesure ${med == null ? '?' : med.toFixed(1)} dB → pertes d'environnement ${calibration.perteEnvironnementDb ?? 'par défaut'} dB`);
  }

  function parametres(opts = {}) {
    const preset = PARAMS_LORA[opts.preset] ? opts.preset : fournisseurs.presetCourant() || config.reseauPreset || 'LONG_FAST';
    const p = PARAMS_LORA[preset] || PARAMS_LORA.LONG_FAST;
    const bruit = -174 + 10 * Math.log10(p.bw * 1000) + 6;
    return {
      preset,
      hs: opts.hs ?? 6, // antenne du site (m)
      ht: opts.ht ?? 2, // antenne du point desservi (m)
      ptx: opts.ptx ?? 27,
      gains: (opts.ga ?? 2.15) + (opts.gb ?? 2.15),
      pertes: opts.pertes ?? 1.5,
      margeSecurite: opts.marge ?? 6, // évanouissements
      env: opts.env ?? (calibration && calibration.perteEnvironnementDb != null ? calibration.perteEnvironnementDb : (fournisseurs.envDefaut && fournisseurs.envDefaut()) ?? 12), // végétation, bâti (autre département : calibration de la carte)
      seuil: bruit + SNR_LIMITE[p.sf], // sensibilité
      rayonMax: (opts.rayonKm ?? 40) * 1000,
    };
  }
  const fspl = (d) => 20 * Math.log10(d / 1000) + 20 * Math.log10(FREQ / 1e6) + 32.44;

  /** Balayage radial depuis un site : appelle rappel(indexCellule, marge dB, distance m) */
  function balayer(site, P, nbRayons, pas, rappel) {
    const zs = alt(site.lat, site.lon);
    if (Number.isNaN(zs)) return;
    const hS = zs + P.hs;
    const cosLat = Math.cos((site.lat * Math.PI) / 180);
    const budget = P.ptx + P.gains - P.pertes - P.seuil - P.margeSecurite - P.env;
    const nPas = Math.floor(P.rayonMax / pas);
    for (let r = 0; r < nbRayons; r++) {
      const az = (2 * Math.PI * r) / nbRayons;
      const dLat = Math.cos(az) / M_PAR_DEG, dLon = Math.sin(az) / (M_PAR_DEG * cosLat);
      let thetaMax = -Infinity, dObs = 0;
      for (let k = 1; k <= nPas; k++) {
        const d = k * pas;
        const lat = site.lat + d * dLat, lon = site.lon + d * dLon;
        const z = alt(lat, lon);
        if (Number.isNaN(z)) break;
        const ze = z - (d * d) / (2 * K * R_TERRE);
        const thetaCible = (ze + P.ht - hS) / d;
        let perte = 0;
        if (dObs > 0) {
          const h = (thetaMax - thetaCible) * dObs;
          const v = h * Math.sqrt((2 * d) / (LAMBDA * dObs * (d - dObs)));
          perte = diffraction(v);
        }
        const m = budget - fspl(d) - perte;
        rappel(celle(lat, lon), m, d);
        const thetaSol = (ze - hS) / d;
        if (thetaSol > thetaMax) { thetaMax = thetaSol; dObs = d; }
      }
    }
  }

  /** Liaison point à point sur le profil direct (pas 100 m) */
  // Paramètres corrigés par la fiche d'installation des nœuds d'une liaison (gain d'antenne, pertes de câble,
  // puissance : on garde le sens le plus défavorable). Valeurs absentes = valeurs par défaut du modèle.
  function Pinstallation(P, ...noeuds) {
    let gains = P.gains, pertes = P.pertes, ptx = P.ptx, hs = P.hs;
    for (const n of noeuds) {
      if (!n) continue;
      if (n.gain != null) gains += n.gain - 2.15;
      if (n.pertes != null) pertes += n.pertes - 0.75;
      if (n.ptx != null) ptx = Math.min(ptx, n.ptx);
    }
    if (noeuds[0] && noeuds[0].h != null) hs = noeuds[0].h;
    return gains === P.gains && pertes === P.pertes && ptx === P.ptx && hs === P.hs ? P : { ...P, gains, pertes, ptx, hs };
  }
  function liaison(a, b, P, ha, hb) {
    const D = distanceM(a, b);
    if (D < 50) return { marge: 99, distance: D, obstacle: null };
    const za = alt(a.lat, a.lon), zb = alt(b.lat, b.lon);
    if (Number.isNaN(za) || Number.isNaN(zb)) return null;
    const hA = za + ha, hB = zb + hb;
    const n = Math.max(10, Math.ceil(D / 100));
    let pire = { v: -Infinity, d: 0, h: 0 };
    for (let k = 1; k < n; k++) {
      const f = k / n, d = D * f;
      const z = alt(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
      if (Number.isNaN(z)) continue;
      const ze = z - (d * (D - d)) / (2 * K * R_TERRE);
      const visee = hA + (hB - hA) * f;
      const h = ze - visee;
      const v = h * Math.sqrt((2 * D) / (LAMBDA * d * (D - d)));
      if (v > pire.v) pire = { v, d, h };
    }
    const perte = diffraction(pire.v);
    const m = P.ptx + P.gains - P.pertes - P.seuil - P.margeSecurite - P.env - fspl(D) - perte;
    return { marge: +m.toFixed(1), distance: Math.round(D), diffraction: +perte.toFixed(1), obstacle: pire.h > 0 ? { distanceKm: +(pire.d / 1000).toFixed(1), hauteur: Math.round(pire.h) } : null };
  }

  // ---- Couverture d'un site --------------------------------------------------------
  // 1080 rayons au pas de 250 m : à 40 km, deux rayons voisins restent à moins d'une cellule (sinon la couverture est sous-estimée)
  function couvertureZone(site, P, nbRayons = 1080, pas = 250) {
    const bits = new Uint32Array(Math.ceil(nbZone / 32));
    let n = 0;
    balayer(site, P, nbRayons, pas, (k, m) => {
      if (k < 0 || m < 0) return;
      const z = indexZone[k];
      if (z < 0) return;
      const w = z >>> 5, b = 1 << (z & 31);
      if (!(bits[w] & b)) { bits[w] |= b; n++; }
    });
    return { bits, n };
  }

  function couverturePng(site, opts) {
    const P = parametres(opts);
    const marges = new Float32Array(nLat * nLon).fill(-Infinity);
    balayer(site, P, 1440, 150, (k, m) => { if (k >= 0 && m > marges[k]) marges[k] = m; });
    const rgba = Buffer.alloc(nLat * nLon * 4);
    let couvert = 0, couvertZone = 0;
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
      const m = marges[i * nLon + j];
      const o = ((nLat - 1 - i) * nLon + j) * 4; // ligne 0 de l'image = nord
      let c = null;
      if (m >= 10) c = [62, 230, 196, 150];
      else if (m >= 0) c = [244, 211, 94, 135];
      else if (m >= -8) c = [243, 154, 74, 38];
      if (m >= 0) { couvert++; if (masque[i * nLon + j]) couvertZone++; }
      if (c) { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3]; }
    }
    return {
      image: png(nLon, nLat, rgba),
      surfaceKm2: Math.round(couvert * aireCelleKm2),
      surfaceZoneKm2: Math.round(couvertZone * aireCelleKm2),
      pctZone: +((couvertZone / nbZone) * 100).toFixed(1),
      sol: Number.isNaN(alt(site.lat, site.lon)) ? null : Math.round(alt(site.lat, site.lon)),
      env: P.env,
      rayonKm: P.rayonMax / 1000,
    };
  }

  // ---- Classement des sites ----------------------------------------------------------
  const pause = () => new Promise((r) => setImmediate(r));
  async function calculerClassement(opts = {}) {
    if (etat.calculEnCours || etat.mnt !== 'pret') return;
    etat.calculEnCours = true;
    etat.classement = 'calcul';
    const debut = Date.now();
    try { calibrer(); } catch (e) { journal('[Relief] calibration impossible :', e.message); }
    const P = parametres(opts);
    try {
      // Sites candidats : points hauts dans le département ou à moins de 10 km
      const candidats = sommets.filter((s) => s.dansZone || anneaux.length === 0 || distanceAuDepartement(s) < 10000);
      const couvertures = [];
      for (const s of candidats) {
        couvertures.push({ s, ...couvertureZone(s, P) });
        await pause();
      }
      // Couverture actuelle des relais du réseau
      const existants = fournisseurs.noeudsReseau().filter((n) => celle(n.lat, n.lon) >= 0);
      const deja = new Uint32Array(Math.ceil(nbZone / 32));
      for (const n of existants) {
        const c = couvertureZone(n, Pinstallation(P, n), 1440, 150); // réseau existant : même précision que la carte, avec sa fiche d'installation
        for (let w = 0; w < deja.length; w++) deja[w] |= c.bits[w];
        await pause();
      }
      const nDeja = compter(deja);
      dernierCalcul = { couvertures, deja, existants, nDeja };
      const choisis = planGlouton(couvertures, deja, existants, 0);
      const individuels = couvertures.map((c) => ({ id: c.s.id, n: c.n })).sort((a, b) => b.n - a.n);
      const rang = new Map(individuels.map((x, k) => [x.id, k + 1]));
      for (const s of sommets) {
        const c = couvertures.find((x) => x.s.id === s.id);
        s.couverturePct = c ? +((c.n / nbZone) * 100).toFixed(1) : null;
        s.couvertureKm2 = c ? Math.round(c.n * aireCelleKm2) : null;
        s.rang = rang.get(s.id) || null;
        s.rangPlan = null;
      }
      choisis.forEach((c, k) => { c.s.rangPlan = k + 1; });
      classement = {
        date: Date.now(),
        parametres: { preset: P.preset, hs: P.hs, ht: P.ht, ptx: P.ptx, margeSecurite: P.margeSecurite, env: P.env, rayonKm: P.rayonMax / 1000 },
        calibration,
        surfaceDepartementKm2: Math.round(nbZone * aireCelleKm2),
        reseauActuel: { relais: existants.map((n) => n.nom), pct: +((nDeja / nbZone) * 100).toFixed(1), km2: Math.round(nDeja * aireCelleKm2) },
        plan: choisis.map((c, k) => ({
          rang: k + 1, id: c.s.id, nom: c.s.nom, commune: c.s.commune, lat: c.s.lat, lon: c.s.lon, alt: c.s.alt,
          gainKm2: Math.round(c.gain * aireCelleKm2), totalPct: +((c.total / nbZone) * 100).toFixed(1),
        })),
        meilleursIndividuels: individuels.slice(0, 15).map((x) => {
          const s = sommets[x.id];
          return { id: s.id, nom: s.nom, commune: s.commune, lat: s.lat, lon: s.lon, alt: s.alt, km2: Math.round(x.n * aireCelleKm2), pct: +((x.n / nbZone) * 100).toFixed(1) };
        }),
        candidats: candidats.length,
        dureeSecondes: Math.round((Date.now() - debut) / 1000),
      };
      etat.classement = 'pret';
      etat.maj = Date.now();
      journal(`[Relief] classement de ${candidats.length} sites en ${classement.dureeSecondes} s : réseau actuel ${classement.reseauActuel.pct} %, plan de ${choisis.length} sites → ${choisis.length ? classement.plan[choisis.length - 1].totalPct : classement.reseauActuel.pct} %`);
    } catch (e) {
      etat.classement = 'erreur';
      etat.erreur = e.message;
      journal('[Relief] erreur de classement :', e.message);
    } finally {
      etat.calculEnCours = false;
    }
  }

  // Sélection gloutonne : à chaque étape, le site qui ajoute le plus de surface nouvelle
  // (min = niveau d'accès minimal des sites retenus : 0 tous, 1 à pied, 2 en 4×4, 3 en voiture)
  let dernierCalcul = null;
  const compter = (b) => { let n = 0; for (let w = 0; w < b.length; w++) { let x = b[w]; while (x) { x &= x - 1; n++; } } return n; };
  // realiste : zones protégées écartées, préférence pour les supports existants et le secteur proche (facteur de realisme.js)
  const facteurRealisme = (s, realiste) => (!realiste || !s.realisme ? 1 : s.realisme.facteur);
  function planGlouton(couvertures, deja, existants, min, { max = 12, cible = Infinity, gainMin = 40, realiste = false } = {}) {
    const choisis = [];
    const cumul = Uint32Array.from(deja);
    for (let etape = 0; etape < max; etape++) {
      if (compter(cumul) >= cible) break;
      let meilleur = null, gainMax = 0, frMeilleur = 1;
      for (const c of couvertures) {
        if (!accessible(c.s, min)) continue;
        const fr = facteurRealisme(sommets[c.s.id] || c.s, realiste);
        if (!fr) continue;
        if (choisis.some((x) => distanceM(x.s, c.s) < 4000) || existants.some((n) => distanceM(n, c.s) < 2000)) continue;
        let g = 0;
        for (let w = 0; w < cumul.length; w++) { let x = c.bits[w] & ~cumul[w]; while (x) { x &= x - 1; g++; } }
        if (g * fr > gainMax * frMeilleur) { gainMax = g; meilleur = c; frMeilleur = fr; }
      }
      if (!meilleur || gainMax < gainMin) break;
      for (let w = 0; w < cumul.length; w++) cumul[w] |= meilleur.bits[w];
      choisis.push({ s: meilleur.s, gain: gainMax, total: compter(cumul) });
    }
    return choisis;
  }
  // Plan pour couvrir le département : objectif en %, nombre maximal de sites, niveau d'accès exigé
  function planDepartement({ objectifPct = 95, max = 15, acces: filtre = null, avecReseau = true, realiste = false } = {}) {
    if (!dernierCalcul) return null;
    const min = niveauMin(filtre);
    const deja = avecReseau ? dernierCalcul.deja : new Uint32Array(dernierCalcul.deja.length);
    const depart = compter(deja);
    const cible = Math.ceil((Math.min(100, Math.max(10, objectifPct)) / 100) * nbZone);
    const choisis = planGlouton(dernierCalcul.couvertures, deja, avecReseau ? dernierCalcul.existants : [], min, { max: Math.min(40, Math.max(1, max)), cible, gainMin: 8, realiste });
    const finale = choisis.length ? choisis[choisis.length - 1].total : depart;
    // Image : déjà couvert par le réseau (bleu), apporté par les nouveaux sites (turquoise), non couvert (rouge pâle)
    const cumul = Uint32Array.from(deja);
    for (const c of choisis) { const cs = dernierCalcul.couvertures.find((x) => x.s.id === c.s.id); if (cs) for (let w = 0; w < cumul.length; w++) cumul[w] |= cs.bits[w]; }
    const rgba = Buffer.alloc(nLat * nLon * 4);
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
      const z = indexZone[i * nLon + j];
      if (z < 0) continue;
      const w = z >>> 5, b = 1 << (z & 31);
      const o = ((nLat - 1 - i) * nLon + j) * 4;
      const c = deja[w] & b ? [96, 165, 250, 95] : cumul[w] & b ? [62, 230, 196, 140] : [255, 92, 108, 70];
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
    }
    const candidats = dernierCalcul.couvertures.filter((c) => accessible(c.s, min)).length;
    return {
      objectifPct, max, filtreAcces: filtre || 'tous', avecReseau, realiste, realismeEtat: realisme.etat(), candidats, accesEtat: acces.etat(),
      surfaceDepartementKm2: Math.round(nbZone * aireCelleKm2),
      departPct: +((depart / nbZone) * 100).toFixed(1),
      finalPct: +((finale / nbZone) * 100).toFixed(1),
      atteint: finale >= cible,
      reseau: avecReseau ? dernierCalcul.existants.map((n) => ({ nom: n.nom, lat: n.lat, lon: n.lon })) : [],
      sites: choisis.map((c, k) => {
        const sm = sommets[c.s.id] || c.s;
        return { rang: k + 1, id: c.s.id, nom: c.s.nom, commune: sm.commune || c.s.commune, lat: c.s.lat, lon: c.s.lon, alt: c.s.alt, acces: sm.acces || null, realisme: sm.realisme || null,
          gainKm2: Math.round(c.gain * aireCelleKm2), totalPct: +((c.total / nbZone) * 100).toFixed(1) };
      }),
      parametres: classement ? classement.parametres : null,
      image: png(nLon, nLat, rgba),
    };
  }

  // ---- Plan à budget : « j'ai N relais à poser » -------------------------------------------------------------
  // Choisit les N sites qui apportent le plus de surface (sites réalistes par défaut), puis chiffre chaque étape :
  // surface et habitants gagnés (communes dont le bourg devient couvert), coût estimé (solaire ou secteur, mât si aucun support).
  function planBudget({ n = 3, acces: filtre = null, avecReseau = true, realiste = true, communes = [], couts = {} } = {}) {
    if (!dernierCalcul) return null;
    const cout = { secteur: 120, solaire: 220, mat: 90, ...couts };
    const min = niveauMin(filtre);
    const deja = avecReseau ? dernierCalcul.deja : new Uint32Array(dernierCalcul.deja.length);
    const choisis = planGlouton(dernierCalcul.couvertures, deja, avecReseau ? dernierCalcul.existants : [], min, { max: Math.min(15, Math.max(1, n)), gainMin: 4, realiste });
    const bit = (b, lat, lon) => { const k = celle(lat, lon); if (k < 0) return false; const z = indexZone[k]; return z >= 0 && !!(b[z >>> 5] & (1 << (z & 31))); };
    const cs = communes.filter((c) => { const k = celle(c.lat, c.lon); return k >= 0 && indexZone[k] >= 0; });
    const popTotale = cs.reduce((t, c) => t + (c.population || 0), 0);
    const couvertes = (b) => cs.filter((c) => bit(b, c.lat, c.lon));
    const cumul = Uint32Array.from(deja);
    let avant = couvertes(cumul), totalCout = 0;
    const popDepart = avant.reduce((t, c) => t + c.population, 0);
    const sites = choisis.map((c, k) => {
      const cv = dernierCalcul.couvertures.find((x) => x.s.id === c.s.id);
      for (let w = 0; w < cumul.length; w++) cumul[w] |= cv.bits[w];
      const apres = couvertes(cumul);
      const deja2 = new Set(avant);
      const nouvelles = apres.filter((x) => !deja2.has(x));
      avant = apres;
      const sm = sommets[c.s.id] || c.s, re = sm.realisme || null;
      const solaire = !re || re.electricite !== 'secteur probable';
      const prix = (solaire ? cout.solaire : cout.secteur) + (re && re.support ? 0 : cout.mat);
      totalCout += prix;
      return {
        rang: k + 1, id: c.s.id, nom: c.s.nom, commune: sm.commune || c.s.commune, lat: c.s.lat, lon: c.s.lon, alt: c.s.alt, acces: sm.acces || null, realisme: re,
        gainKm2: Math.round(c.gain * aireCelleKm2), totalPct: +((c.total / nbZone) * 100).toFixed(1),
        habitantsGagnes: nouvelles.reduce((t, x) => t + x.population, 0), communesGagnees: nouvelles.sort((a, b) => b.population - a.population).slice(0, 6).map((x) => x.nom), nbCommunesGagnees: nouvelles.length,
        alimentation: solaire ? 'solaire' : 'secteur', cout: prix, coutCumule: totalCout,
      };
    });
    const popFinale = avant.reduce((t, c) => t + c.population, 0);
    return {
      n, filtreAcces: filtre || 'tous', avecReseau, realiste, couts: cout, realismeEtat: realisme.etat(),
      surfaceDepartementKm2: Math.round(nbZone * aireCelleKm2),
      departPct: +((compter(deja) / nbZone) * 100).toFixed(1),
      finalPct: sites.length ? sites[sites.length - 1].totalPct : +((compter(deja) / nbZone) * 100).toFixed(1),
      population: { totale: popTotale, depart: popDepart, finale: popFinale, communes: cs.length },
      coutTotal: totalCout, sites,
      parametres: classement ? classement.parametres : null,
    };
  }

  // ---- Simulation « et si… » : retirer ou ajouter des relais ------------------------------------
  // Couverture de chaque site mise en cache (bits des cellules du département couvertes), puis unions avant / après.
  const cacheSites = new Map();
  function bitsSite(site, P) {
    const Pi = Pinstallation({ ...P, hs: site.h ?? P.hs }, site);
    const cle = [site.lat.toFixed(5), site.lon.toFixed(5), Pi.hs, Pi.gains, Pi.pertes, Pi.ptx, Pi.env, Pi.preset].join('|');
    if (!cacheSites.has(cle)) {
      if (cacheSites.size > 400) cacheSites.delete(cacheSites.keys().next().value);
      cacheSites.set(cle, couvertureZone(site, Pi, 1440, 150).bits);
    }
    return cacheSites.get(cle);
  }
  function simuler({ retirer = [], ajouter = [], villes = [] } = {}, opts = {}) {
    if (etat.mnt !== 'pret') throw new Error('Le modèle de terrain est en cours de chargement');
    const P = parametres(opts);
    const hDefaut = opts.hn ?? 6;
    const base = (opts.noeuds || fournisseurs.noeudsReseau()).filter((n) => celle(n.lat, n.lon) >= 0).map((n) => ({ ...n, h: n.h ?? hDefaut }));
    const ret = new Set(retirer.map(String));
    const ajout = ajouter.filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon) && celle(a.lat, a.lon) >= 0).map((a, i) => ({ num: 'ajout-' + i, nom: a.nom || `Nouveau relais ${i + 1}`, lat: a.lat, lon: a.lon, h: a.h ?? P.hs, nouveau: true }));
    const avant = base, apres = [...base.filter((n) => !ret.has(String(n.num))), ...ajout];
    const W = Math.ceil(nbZone / 32);
    const union = (sites) => { const u = new Uint32Array(W); for (const s of sites) { const b = bitsSite(s, P); for (let w = 0; w < W; w++) u[w] |= b[w]; } return u; };
    const uA = union(avant), uB = union(apres);
    const nA = compter(uA), nB = compter(uB);
    // Image : perdu (rouge), gagné (vert), inchangé (turquoise pâle)
    const rgba = Buffer.alloc(nLat * nLon * 4);
    let perdu = 0, gagne = 0;
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
      const z = indexZone[i * nLon + j];
      if (z < 0) continue;
      const w = z >>> 5, b = 1 << (z & 31), a = uA[w] & b, c = uB[w] & b;
      if (!a && !c) continue;
      const o = ((nLat - 1 - i) * nLon + j) * 4;
      const col = a && !c ? [255, 92, 108, 170] : !a && c ? [74, 222, 128, 170] : [62, 230, 196, 55];
      if (a && !c) perdu++; else if (!a && c) gagne++;
      rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; rgba[o + 3] = col[3];
    }
    // Graphe des relais (liaisons calculées) et nombre de relais traversés entre les principales villes
    const graphe = (sites) => {
      const adj = sites.map(() => []);
      for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
        if (distanceM(sites[i], sites[j]) > P.rayonMax) continue;
        const l = liaison(sites[i], sites[j], Pinstallation(P, sites[i], sites[j]), sites[i].h, sites[j].h);
        if (l && l.marge >= 0) { adj[i].push(j); adj[j].push(i); }
      }
      return adj;
    };
    const entrees = (sites, v) => sites.map((s, i) => {
      if (distanceM(s, v) > P.rayonMax) return -1;
      const l = liaison(v, s, Pinstallation(P, s), P.ht, s.h);
      return l && l.marge >= 0 ? i : -1;
    }).filter((i) => i >= 0);
    const relaisEntre = (adj, A, B) => {
      if (!A.length || !B.length) return null;
      const dist = new Array(adj.length).fill(-1), file = [];
      for (const a of A) { dist[a] = 1; file.push(a); }
      const cibles = new Set(B);
      for (let k = 0; k < file.length; k++) {
        const u = file[k];
        if (cibles.has(u)) return dist[u];
        for (const v of adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; file.push(v); }
      }
      return null;
    };
    const vs = villes.filter((v) => celle(v.lat, v.lon) >= 0).slice(0, 12);
    const gA = graphe(avant), gB = graphe(apres);
    const eA = vs.map((v) => entrees(avant, v)), eB = vs.map((v) => entrees(apres, v));
    const paires = [];
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      const a = relaisEntre(gA, eA[i], eA[j]), b = relaisEntre(gB, eB[i], eB[j]);
      paires.push({ de: vs[i].nom, vers: vs[j].nom, avant: a, apres: b });
    }
    const pct = (n) => +((n / nbZone) * 100).toFixed(1);
    return {
      avant: { relais: avant.length, pct: pct(nA), km2: Math.round(nA * aireCelleKm2) },
      apres: { relais: apres.length, pct: pct(nB), km2: Math.round(nB * aireCelleKm2) },
      perduKm2: Math.round(perdu * aireCelleKm2), gagneKm2: Math.round(gagne * aireCelleKm2),
      retires: base.filter((n) => ret.has(String(n.num))).map((n) => ({ num: n.num, nom: n.nom, lat: n.lat, lon: n.lon })),
      ajoutes: ajout.map((a) => ({ nom: a.nom, lat: a.lat, lon: a.lon, h: a.h })),
      villes: vs.map((v, i) => ({ nom: v.nom, lat: v.lat, lon: v.lon, population: v.population, couverteAvant: eA[i].length > 0, couverteApres: eB[i].length > 0 })),
      paires,
      reseau: base.map((n) => ({ num: n.num, nom: n.nom, lat: n.lat, lon: n.lon })),
      image: png(nLon, nLat, rgba),
      parametres: { preset: P.preset, hs: P.hs, ht: P.ht, env: P.env },
    };
  }

  // ---- Déplacer des relais existants : pour chaque relais, les points hauts proches où il couvrirait plus -------
  // Gain net d'un déplacement = surface nouvellement couverte au nouvel endroit − surface que lui seul couvre aujourd'hui.
  // On vérifie aussi qu'au nouvel endroit il reste relié par radio à au moins un autre relais ou passerelle.
  const ROLES_DEPLACABLES = new Set(['ROUTER', 'ROUTER_LATE', 'REPEATER', 'ROUTER_CLIENT']);
  async function optimiserRelais({ rayonKm = 6, acces: filtre = null, progression = null } = {}) {
    if (etat.mnt !== 'pret') throw new Error('Le modèle de terrain est en cours de chargement');
    if (!sommets.length) throw new Error('Points hauts pas encore calculés');
    const P = parametres({});
    const min = niveauMin(filtre);
    const W = Math.ceil(nbZone / 32);
    const reseau = fournisseurs.noeudsReseau().filter((n) => celle(n.lat, n.lon) >= 0 && !n.voisin).slice(0, 60).map((n) => ({ ...n, h: n.h ?? 6 }));
    const bits = [];
    for (const n of reseau) { bits.push(bitsSite(n, P)); await pause(); }
    // Masques : couvert par au moins un relais (tous), par exactement un (seul)
    const tous = new Uint32Array(W), deux = new Uint32Array(W);
    for (const b of bits) for (let w = 0; w < W; w++) { deux[w] |= tous[w] & b[w]; tous[w] |= b[w]; }
    const pop = (x) => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
    const nTous = compter(tous);
    const mobiles = reseau.map((n, i) => ({ n, i })).filter(({ n }) => ROLES_DEPLACABLES.has(n.role) && !n.passerelle);
    const propositions = [], bilan = [];
    let fait = 0;
    for (const { n, i } of mobiles) {
      const b = bits[i];
      let propre = 0;
      for (let w = 0; w < W; w++) propre += pop(b[w] & ~deux[w]);
      // Candidats : points hauts à moins de rayonKm, plus hauts que l'emplacement actuel ou dominants, accessibles si demandé
      const altActuelle = alt(n.lat, n.lon);
      const cands = sommets.filter((s) => distanceM(s, n) <= rayonKm * 1000 && distanceM(s, n) >= 300 && accessible(s, min) && !(s.realisme && s.realisme.protege))
        .sort((a, c) => c.alt - a.alt).slice(0, 10);
      const essais = [];
      for (const s of cands) {
        const site = { lat: s.lat, lon: s.lon, h: n.h, gain: n.gain, pertes: n.pertes, ptx: n.ptx };
        const c = bitsSite(site, P);
        let nouveau = 0, perdu = 0;
        for (let w = 0; w < W; w++) { nouveau += pop(c[w] & ~tous[w]); perdu += pop(b[w] & ~deux[w] & ~c[w]); }
        const net = nouveau - perdu;
        // Liaison radio avec le reste du réseau depuis le nouvel endroit
        let liaisons = 0;
        for (let k = 0; k < reseau.length && liaisons < 3; k++) {
          if (k === i || distanceM(site, reseau[k]) > P.rayonMax) continue;
          const l = liaison(site, reseau[k], Pinstallation(P, site, reseau[k]), site.h, reseau[k].h);
          if (l && l.marge >= 0) liaisons++;
        }
        essais.push({ s, net, nouveau, perdu, liaisons });
        await pause();
      }
      let actuellesLiaisons = 0;
      for (let k = 0; k < reseau.length && actuellesLiaisons < 3; k++) {
        if (k === i || distanceM(n, reseau[k]) > P.rayonMax) continue;
        const l = liaison(n, reseau[k], Pinstallation(P, n, reseau[k]), n.h, reseau[k].h);
        if (l && l.marge >= 0) actuellesLiaisons++;
      }
      const km2 = (x) => Math.round(x * aireCelleKm2);
      const meilleurs = essais.filter((e) => e.net * aireCelleKm2 >= 10 && e.liaisons > 0).sort((a, c) => c.net - a.net).slice(0, 3);
      bilan.push({ num: n.num, nom: n.nom, propreKm2: km2(propre), altitude: Math.round(altActuelle), hauteur: n.h, liaisons: actuellesLiaisons, candidats: cands.length, propositions: meilleurs.length });
      for (const e of meilleurs) {
        const sm = e.s;
        propositions.push({
          num: n.num, nom: n.nom, de: { lat: n.lat, lon: n.lon, alt: Math.round(altActuelle) },
          vers: { id: sm.id, nom: sm.nom, commune: sm.commune, lat: sm.lat, lon: sm.lon, alt: sm.alt, acces: sm.acces || null, realisme: sm.realisme || null },
          distanceKm: +(distanceM(n, sm) / 1000).toFixed(1), hauteur: n.h,
          gainNetKm2: km2(e.net), nouveauKm2: km2(e.nouveau), perduKm2: km2(e.perdu), propreKm2: km2(propre),
          apresPct: +(((nTous + e.net) / nbZone) * 100).toFixed(1), liaisons: e.liaisons,
        });
      }
      fait++;
      if (progression) progression(fait, mobiles.length);
    }
    propositions.sort((a, c) => c.gainNetKm2 - a.gainNetKm2);
    return {
      date: Date.now(), rayonKm, filtreAcces: filtre || 'tous', actuelPct: +((nTous / nbZone) * 100).toFixed(1),
      relaisEtudies: mobiles.length, bilan: bilan.sort((a, c) => a.propreKm2 - c.propreKm2), propositions: propositions.slice(0, 20),
      parametres: { preset: P.preset, env: P.env, rayonKm: P.rayonMax / 1000 },
    };
  }

  // Couverture actuelle du réseau : relais et passerelles détectés (entendus depuis 24 h) et positionnés dans la zone
  function couvertureReseau(opts = {}) {
    if (etat.mnt !== 'pret') throw new Error('Le modèle de terrain est en cours de chargement');
    const noeuds = (opts.noeuds || fournisseurs.noeudsReseau()).filter((n) => celle(n.lat, n.lon) >= 0).slice(0, 60);
    if (!noeuds.length) return { noeuds: [], vide: true };
    // Hauteur, gain, câble et puissance : fiche d'installation du relais, sinon la hauteur supposée
    const r = couverturePngMulti(noeuds.map((n) => ({ lat: n.lat, lon: n.lon, h: n.h ?? opts.hn ?? 6, gain: n.gain, pertes: n.pertes, ptx: n.ptx })), opts);
    return { ...r, noeuds: noeuds.map((n, i) => ({ num: n.num, nom: n.nom, lat: n.lat, lon: n.lon, hauteur: n.h ?? opts.hn ?? 6, fiche: n.h != null || n.gain != null, ...r.sites[i] })), sites: undefined, surfaceDepartementKm2: Math.round(nbZone * aireCelleKm2) };
  }

  // Couverture cumulée de plusieurs sites (2 à 10) : image commune (meilleure marge par cellule),
  // surface totale et apport propre de chaque site (ce qu'il est seul à couvrir)
  function couverturePngMulti(sites, opts) {
    const P = parametres(opts);
    const N = nLat * nLon;
    const marges = new Float32Array(N).fill(-Infinity);
    const nbCouvrants = new Uint8Array(N), seulPar = new Int8Array(N).fill(-1);
    const parSite = sites.map((site, idx) => {
      const m = new Float32Array(N).fill(-Infinity);
      const Ps = Pinstallation(site.h != null ? parametres({ ...opts, hs: site.h }) : P, { ...site, h: site.h });
      balayer(site, Ps, 1440, 150, (k, v) => { if (k >= 0 && v > m[k]) m[k] = v; });
      let couvert = 0, zone = 0;
      for (let k = 0; k < N; k++) {
        if (m[k] > marges[k]) marges[k] = m[k];
        if (m[k] >= 0) { couvert++; if (masque[k]) zone++; nbCouvrants[k]++; seulPar[k] = nbCouvrants[k] === 1 ? idx : -1; }
      }
      return { km2: Math.round(couvert * aireCelleKm2), pctZone: +((zone / nbZone) * 100).toFixed(1) };
    });
    const propre = new Array(sites.length).fill(0);
    const rgba = Buffer.alloc(N * 4);
    let couvert = 0, couvertZone = 0;
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
      const k = i * nLon + j, m = marges[k];
      const o = ((nLat - 1 - i) * nLon + j) * 4;
      let c = null;
      if (m >= 10) c = [62, 230, 196, 150];
      else if (m >= 0) c = [244, 211, 94, 135];
      else if (m >= -8) c = [243, 154, 74, 38];
      if (m >= 0) { couvert++; if (masque[k]) { couvertZone++; if (nbCouvrants[k] === 1 && seulPar[k] >= 0) propre[seulPar[k]]++; } }
      if (c) { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3]; }
    }
    return {
      image: png(nLon, nLat, rgba),
      surfaceKm2: Math.round(couvert * aireCelleKm2),
      surfaceZoneKm2: Math.round(couvertZone * aireCelleKm2),
      pctZone: +((couvertZone / nbZone) * 100).toFixed(1),
      sites: sites.map((st, i) => ({ ...parSite[i], propreKm2: Math.round(propre[i] * aireCelleKm2), sol: Number.isNaN(alt(st.lat, st.lon)) ? null : Math.round(alt(st.lat, st.lon)) })),
      env: P.env, rayonKm: P.rayonMax / 1000,
    };
  }

  // Classement filtré par accès (calcul rapide : les couvertures sont déjà en mémoire)
  function classementAcces(filtre) {
    const min = niveauMin(filtre);
    if (!classement) return null;
    const avecCommune = (p) => ({ ...p, commune: sommets[p.id] ? sommets[p.id].commune : p.commune, acces: sommets[p.id] ? sommets[p.id].acces || null : null });
    const base = { ...classement, filtreAcces: filtre || 'tous', acces: acces.etat(),
      meilleursIndividuels: classement.meilleursIndividuels.map(avecCommune) };
    if (!min || !dernierCalcul) return { ...base, plan: classement.plan.map(avecCommune), meilleursIndividuels: !min ? base.meilleursIndividuels : base.meilleursIndividuels };
    const choisis = planGlouton(dernierCalcul.couvertures, dernierCalcul.deja, dernierCalcul.existants, min);
    const indiv = dernierCalcul.couvertures.filter((c) => accessible(c.s, min)).sort((a, b) => b.n - a.n).slice(0, 15);
    return {
      ...base,
      plan: choisis.map((c, k) => avecCommune({ rang: k + 1, id: c.s.id, nom: c.s.nom, lat: c.s.lat, lon: c.s.lon, alt: c.s.alt, gainKm2: Math.round(c.gain * aireCelleKm2), totalPct: +((c.total / nbZone) * 100).toFixed(1) })),
      meilleursIndividuels: indiv.map((c) => avecCommune({ id: c.s.id, nom: c.s.nom, lat: c.s.lat, lon: c.s.lon, alt: c.s.alt, km2: Math.round(c.n * aireCelleKm2), pct: +((c.n / nbZone) * 100).toFixed(1) })),
      candidatsAcces: dernierCalcul.couvertures.filter((c) => accessible(c.s, min)).length,
    };
  }

  function distanceAuDepartement(p) {
    if (dansDepartement(p.lat, p.lon)) return 0;
    let min = Infinity;
    for (const a of anneaux) for (let k = 0; k < a.length; k += 10) min = Math.min(min, distanceM(p, { lat: a[k][1], lon: a[k][0] }));
    return min;
  }

  // ---- Relier deux lieux : relais nécessaires ------------------------------------------------
  // Chemin le moins coûteux entre A et B à travers les relais existants (gratuits) et les points hauts
  // (chaque nouveau relais coûte cher) ; chaque bond doit avoir une marge >= 0 dB après marge de sécurité
  // et pertes d'environnement. Les liaisons sont calculées à la demande (Dijkstra) et mises en cache.
  function relierPoints(a, b, opts = {}) {
    if (etat.mnt !== 'pret') throw new Error('Le modèle de terrain est en cours de chargement');
    for (const p of [a, b]) if (Number.isNaN(alt(p.lat, p.lon))) throw new Error('Point hors de la zone du modèle de relief (département et ses abords)');
    const P = parametres(opts);
    const ha = opts.hauteurA ?? P.ht, hb = opts.hauteurB ?? P.ht;
    const min = niveauMin(opts.acces);
    const dAB = distanceM(a, b);
    const direct = liaison(a, b, P, ha, hb);
    const base = { a: { ...a, alt: Math.round(alt(a.lat, a.lon)) }, b: { ...b, alt: Math.round(alt(b.lat, b.lon)) }, distanceKm: +(dAB / 1000).toFixed(1), direct, parametres: { preset: P.preset, hs: P.hs, ht: P.ht, margeSecurite: P.margeSecurite, env: P.env, rayonKm: P.rayonMax / 1000 }, filtreAcces: opts.acces || 'tous' };
    if (direct && direct.marge >= 0) return { ...base, possible: true, nouveaux: 0, chemin: [{ type: 'depart', ...base.a }, { type: 'arrivee', ...base.b }], bonds: [direct], alternatives: [] };
    // Nœuds du graphe : départ, arrivée, relais existants, points hauts dans un couloir autour de A-B
    const marge = Math.max(15000, Math.min(P.rayonMax, dAB * 0.5));
    const dansCouloir = (p) => distanceM(a, p) + distanceM(p, b) <= dAB + 2 * marge;
    const existants = (opts.noeuds || fournisseurs.noeudsReseau()).filter((n) => !Number.isNaN(alt(n.lat, n.lon)) && dansCouloir(n));
    let candidats = sommets.filter((s) => accessible(s, min) && dansCouloir(s) && !existants.some((n) => distanceM(n, s) < 300));
    if (candidats.length > 260) candidats = candidats.sort((x, y) => (y.dominance || 0) - (x.dominance || 0)).slice(0, 260);
    const noeuds = [
      { type: 'depart', ...base.a, h: ha }, { type: 'arrivee', ...base.b, h: hb },
      ...existants.map((n) => ({ type: 'existant', num: n.num, nom: n.nom, lat: n.lat, lon: n.lon, h: n.h ?? 4, gain: n.gain, pertes: n.pertes, ptx: n.ptx })),
      ...candidats.map((s) => ({ type: 'nouveau', id: s.id, nom: s.nom, commune: s.commune, lat: s.lat, lon: s.lon, alt: s.alt, acces: s.acces || null, h: P.hs })),
    ];
    const cache = new Map();
    const lien = (i, j) => {
      const k = i < j ? i + ':' + j : j + ':' + i;
      if (!cache.has(k)) {
        const x = noeuds[i], y = noeuds[j];
        cache.set(k, distanceM(x, y) > P.rayonMax ? null : liaison(x, y, Pinstallation(P, x, y), x.h, y.h));
      }
      return cache.get(k);
    };
    const coutNoeud = (n) => (n.type === 'nouveau' ? 100 : n.type === 'existant' ? 3 : 0);
    const coutBond = (l) => 1 + Math.max(0, 8 - l.marge) * 0.8 + l.distance / 20000; // préfère les bonds confortables
    const MAX_NOUVEAUX = 4;
    const dist = new Array(noeuds.length).fill(Infinity), prec = new Array(noeuds.length).fill(-1), nb = new Array(noeuds.length).fill(0);
    const vu = new Uint8Array(noeuds.length);
    dist[0] = 0;
    const debut = Date.now();
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < noeuds.length; i++) if (!vu[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === 1) break;
      vu[u] = 1;
      if (Date.now() - debut > 25000) break; // garde-fou
      for (let v = 0; v < noeuds.length; v++) {
        if (vu[v] || v === u || v === 0) continue;
        const nvNouveaux = nb[u] + (noeuds[v].type === 'nouveau' ? 1 : 0);
        if (nvNouveaux > MAX_NOUVEAUX) continue;
        if (dist[u] + 1 >= dist[v]) continue; // inutile de calculer la liaison
        const l = lien(u, v);
        if (!l || l.marge < 0) continue;
        const c = dist[u] + coutBond(l) + coutNoeud(noeuds[v]);
        if (c < dist[v]) { dist[v] = c; prec[v] = u; nb[v] = nvNouveaux; }
      }
    }
    if (prec[1] < 0) return { ...base, possible: false, nouveaux: null, chemin: [], bonds: [], alternatives: [], evalues: candidats.length + existants.length, raison: `Aucun chemin trouvé avec au plus ${MAX_NOUVEAUX} nouveaux relais${min ? ' accessibles' : ''} (rayon ${P.rayonMax / 1000} km par bond).` };
    const ordre = [];
    for (let v = 1; v >= 0; v = prec[v]) ordre.unshift(v);
    const chemin = ordre.map((i) => { const n = noeuds[i]; const { h, ...reste } = n; return { ...reste, hauteur: h, alt: n.alt ?? Math.round(alt(n.lat, n.lon)) }; });
    const bonds = ordre.slice(1).map((v, k) => ({ ...lien(ordre[k], v), de: k, vers: k + 1 }));
    // Autres emplacements possibles pour chaque nouveau relais (mêmes voisins dans le chemin)
    const alternatives = [];
    ordre.forEach((i, k) => {
      if (noeuds[i].type !== 'nouveau') return;
      const avant = ordre[k - 1], apres = ordre[k + 1];
      const liste = [];
      for (let j = 0; j < noeuds.length; j++) {
        if (noeuds[j].type !== 'nouveau' || j === i) continue;
        const l1 = lien(avant, j), l2 = lien(j, apres);
        if (l1 && l2 && l1.marge >= 0 && l2.marge >= 0) liste.push({ id: noeuds[j].id, nom: noeuds[j].nom, commune: noeuds[j].commune, lat: noeuds[j].lat, lon: noeuds[j].lon, alt: noeuds[j].alt, acces: noeuds[j].acces, margeMin: Math.min(l1.marge, l2.marge) });
      }
      alternatives.push({ etape: k, options: liste.sort((x, y) => y.margeMin - x.margeMin).slice(0, 4) });
    });
    return { ...base, possible: true, nouveaux: chemin.filter((c) => c.type === 'nouveau').length, chemin, bonds, alternatives, evalues: candidats.length + existants.length, liaisonsCalculees: cache.size, dureeMs: Date.now() - debut };
  }

  // ---- Propositions pour couvrir un point -------------------------------------------------
  function couvrirPoint(cible, opts = {}) {
    if (etat.mnt !== 'pret') throw new Error('Le modèle de terrain est en cours de chargement');
    const P = parametres(opts);
    const reseau = opts.noeuds || fournisseurs.noeudsReseau();
    const candidats = [];
    const min = niveauMin(opts.acces);
    for (const s of sommets) {
      if (!accessible(s, min)) continue;
      const d = distanceM(s, cible);
      if (d > P.rayonMax || d < 300) continue;
      const l = liaison(s, cible, P, P.hs, P.ht);
      if (!l) continue;
      // Raccordement au réseau existant : meilleur relais joignable depuis le site
      let raccord = null;
      for (const n of reseau) {
        const dn = distanceM(s, n);
        if (dn > P.rayonMax || dn < 200) continue;
        const ln = liaison(s, n, Pinstallation(P, n), P.hs, n.h ?? 4);
        if (ln && (!raccord || ln.marge > raccord.marge)) raccord = { nom: n.nom, num: n.num, lat: n.lat, lon: n.lon, marge: ln.marge, distanceKm: +(ln.distance / 1000).toFixed(1) };
      }
      const score = l.marge + (raccord ? Math.min(raccord.marge, 15) * 0.6 : -10) + (s.couverturePct || 0) * 0.2;
      candidats.push({ ...s, liaison: l, raccord, score });
    }
    candidats.sort((a, b) => b.score - a.score);
    const choisis = [];
    for (const c of candidats) {
      if (choisis.length >= 4) break;
      if (choisis.some((x) => distanceM(x, c) < 3000)) continue;
      choisis.push(c);
    }
    const zc = alt(cible.lat, cible.lon);
    return {
      cible: { ...cible, alt: Number.isNaN(zc) ? null : Math.round(zc), dansZone: dansDepartement(cible.lat, cible.lon) },
      parametres: { preset: P.preset, hs: P.hs, ht: P.ht, margeSecurite: P.margeSecurite, env: P.env },
      propositions: choisis.map((c) => ({
        id: c.id, nom: c.nom, commune: c.commune, lat: c.lat, lon: c.lon, alt: c.alt, source: c.source,
        distanceKm: +(c.liaison.distance / 1000).toFixed(1), marge: c.liaison.marge, diffraction: c.liaison.diffraction,
        obstacle: c.liaison.obstacle, raccord: c.raccord, couverturePct: c.couverturePct, acces: c.acces || null,
      })),
      filtreAcces: opts.acces || 'tous',
      evalues: candidats.length,
    };
  }

  // ---- Un seul site pour couvrir plusieurs points (2 à 5) ----------------------------------
  // Chaque point haut est évalué vers tous les points ; on classe par nombre de points couverts (marge >= 0),
  // puis par la plus faible des marges (le point le plus difficile). Si aucun site ne les couvre tous,
  // on propose la meilleure paire de sites qui se partagent les points.
  function couvrirPoints(cibles, opts = {}) {
    if (etat.mnt !== 'pret') throw new Error('Le modèle de terrain est en cours de chargement');
    for (const c of cibles) if (Number.isNaN(alt(c.lat, c.lon))) throw new Error('Un des points est hors de la zone du modèle de relief (département et ses abords)');
    const P = parametres(opts);
    const reseau = opts.noeuds || fournisseurs.noeudsReseau();
    const min = niveauMin(opts.acces);
    const evalues = [];
    for (const s of sommets) {
      if (!accessible(s, min)) continue;
      const liens = cibles.map((c) => {
        const d = distanceM(s, c);
        if (d > P.rayonMax || d < 300) return null;
        return liaison(s, c, P, P.hs, P.ht);
      });
      const marges = liens.map((l) => (l ? l.marge : -99));
      const couverts = marges.filter((m) => m >= 0).length;
      if (!couverts) continue;
      evalues.push({ s, liens, marges, couverts, margeMin: Math.min(...marges) });
    }
    const raccord = (s) => {
      let r = null;
      for (const n of reseau) {
        const dn = distanceM(s, n);
        if (dn > P.rayonMax || dn < 200) continue;
        const ln = liaison(s, n, Pinstallation(P, n), P.hs, n.h ?? 4);
        if (ln && (!r || ln.marge > r.marge)) r = { nom: n.nom, num: n.num, lat: n.lat, lon: n.lon, marge: ln.marge, distanceKm: +(ln.distance / 1000).toFixed(1) };
      }
      return r;
    };
    const fiche = (e) => ({
      id: e.s.id, nom: e.s.nom, commune: e.s.commune, lat: e.s.lat, lon: e.s.lon, alt: e.s.alt, acces: e.s.acces || null, couverturePct: e.s.couverturePct,
      couverts: e.couverts, margeMin: e.margeMin,
      liaisons: e.liens.map((l) => (l ? { marge: l.marge, distanceKm: +(l.distance / 1000).toFixed(1), obstacle: l.obstacle } : null)),
      raccord: raccord(e.s),
    });
    evalues.sort((a, b) => b.couverts - a.couverts || b.margeMin - a.margeMin || (b.s.couverturePct || 0) - (a.s.couverturePct || 0));
    const choisis = [];
    for (const e of evalues) {
      if (choisis.length >= 4) break;
      if (choisis.some((x) => distanceM(x.s, e.s) < 3000)) continue;
      choisis.push(e);
    }
    const complet = !!(choisis[0] && choisis[0].couverts === cibles.length);
    // Pas de site unique : meilleure paire (les deux sites se partagent les points)
    let paire = null;
    if (!complet && cibles.length > 1) {
      const top = evalues.slice(0, 150);
      for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
        const m = cibles.map((_, k) => Math.max(top[i].marges[k], top[j].marges[k]));
        if (m.some((x) => x < 0)) continue;
        const score = Math.min(...m);
        if (!paire || score > paire.score) paire = { score, a: top[i], b: top[j] };
      }
      if (paire) paire = { margeMin: paire.score, sites: [fiche(paire.a), fiche(paire.b)], liaison: (() => { const l = liaison(paire.a.s, paire.b.s, P, P.hs, P.hs); return l ? { marge: l.marge, distanceKm: +(l.distance / 1000).toFixed(1) } : null; })() };
    }
    return {
      cibles: cibles.map((c) => { const z = alt(c.lat, c.lon); return { ...c, alt: Number.isNaN(z) ? null : Math.round(z) }; }),
      parametres: { preset: P.preset, hs: P.hs, ht: P.ht, margeSecurite: P.margeSecurite, env: P.env, rayonKm: P.rayonMax / 1000 },
      complet, propositions: choisis.map(fiche), paire,
      filtreAcces: opts.acces || 'tous', evalues: evalues.length,
    };
  }

  // ---- Démarrage ---------------------------------------------------------------------
  async function demarrer() {
    try {
      await chargerMnt();
      await calculerSommets();
      await calculerClassement();
    } catch (e) {
      etat.mnt = etat.mnt === 'pret' ? 'pret' : 'erreur';
      etat.erreur = e.message;
      journal('[Relief] erreur :', e.message);
    }
  }
  minuteries.push(setTimeout(demarrer, options.code ? 100 : 5000));
  // Classement recalculé chaque nuit (le réseau existant évolue)
  minuteries.push(setInterval(() => { if (new Date().getHours() === 4) { calculerClassement(); const l = sommets.filter((x) => x.dansZone || distanceAuDepartement(x) < 10000); acces.completer(l).catch(() => {}); realisme.completer(l).catch(() => {}); } }, 3600000));

  return {
    code: codeDep,
    arreter: () => { for (const m of minuteries) { clearTimeout(m); clearInterval(m); } },
    etat: () => ({ ...etat, departement: { code: codeDep, nom: options.nom || (options.code ? nomDepartement(codeDep) : config.zoneNom) }, zone: z0, grille: { nLat, nLon, pasM: 250 }, calibration: calibration && { liaisons: calibration.liaisons, ecartMedianDb: calibration.ecartMedianDb, perteEnvironnementDb: calibration.perteEnvironnementDb } }),
    calibration: () => calibration,
    emprise: () => ({ sud: emprise.sud - pasLat / 2, ouest: emprise.ouest - pasLon / 2, nord: emprise.sud + (nLat - 0.5) * pasLat, est: emprise.ouest + (nLon - 0.5) * pasLon }),
    sommets: () => sommets,
    classement: () => classement && {
      ...classement,
      plan: classement.plan.map((p) => ({ ...p, commune: sommets[p.id] ? sommets[p.id].commune : p.commune })),
      meilleursIndividuels: classement.meilleursIndividuels.map((p) => ({ ...p, commune: sommets[p.id] ? sommets[p.id].commune : p.commune })),
    },
    couverturePng,
    couverturePngMulti,
    couvertureReseau,
    simuler,
    planDepartement,
    planBudget,
    optimiserRelais,
    etatRealisme: () => realisme.etat(),
    couvrirPoint,
    couvrirPoints,
    relierPoints,
    calculerClassement,
    classementAcces,
    etatAcces: () => acces.etat(),
    pret: () => etat.mnt === 'pret',
  };
}

module.exports = { listeDepartements, nomDepartement, creerRelief, contourDepartement };
