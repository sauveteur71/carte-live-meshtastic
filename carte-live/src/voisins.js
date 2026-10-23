'use strict';
// Départements voisins du département configuré (à partir du contour des 96 départements métropolitains)
// → zone « département + voisins » : codes, noms et rectangle englobant.
const fs = require('fs');
const path = require('path');

function anneaux(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}
function rectangle(f) {
  let s = 90, o = 180, n = -90, e = -180;
  for (const a of anneaux(f.geometry)) for (const [lon, lat] of a) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < o) o = lon; if (lon > e) e = lon; }
  return [s, o, n, e];
}

function calculerVoisins(code, zoneDep) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'donnees-ref', 'departements.geojson'), 'utf8')); } catch { return null; }
  const feats = d.features || [];
  const dep = feats.find((f) => String(f.properties.code) === String(code));
  if (!dep) return null;
  const rDep = rectangle(dep);
  // Points du contour du département, sur une grille de ~1 km pour comparer vite
  const cle = (lon, lat) => `${Math.round(lon * 100)},${Math.round(lat * 100)}`;
  const grille = new Set();
  for (const a of anneaux(dep.geometry)) for (const [lon, lat] of a) grille.add(cle(lon, lat));
  const touche = (f) => {
    for (const a of anneaux(f.geometry)) for (const [lon, lat] of a) {
      const x = Math.round(lon * 100), y = Math.round(lat * 100);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (grille.has(`${x + i},${y + j}`)) return true;
    }
    return false;
  };
  const voisins = feats.filter((f) => {
    if (f === dep) return false;
    const r = rectangle(f);
    if (r[0] > rDep[2] + 0.05 || r[2] < rDep[0] - 0.05 || r[1] > rDep[3] + 0.05 || r[3] < rDep[1] - 0.05) return false;
    return touche(f);
  });
  const bbox = [...(zoneDep || rDep)];
  for (const f of voisins) { const r = rectangle(f); bbox[0] = Math.min(bbox[0], r[0]); bbox[1] = Math.min(bbox[1], r[1]); bbox[2] = Math.max(bbox[2], r[2]); bbox[3] = Math.max(bbox[3], r[3]); }
  return {
    bbox: bbox.map((v) => Math.round(v * 1000) / 1000),
    departements: voisins.map((f) => ({ code: String(f.properties.code), nom: f.properties.nom })).sort((a, b) => a.code.localeCompare(b.code)),
  };
}

module.exports = { calculerVoisins };
