'use strict';
// Accessibilité des points hauts d'après OpenStreetMap : voie la plus proche par type
// (route carrossable, piste 4×4, chemin pédestre). Résultats gardés sur disque (90 jours).

const fs = require('fs');
const path = require('path');

const SERVEURS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RAYON = 400; // m : recherche des voies autour de chaque point
const PROCHE = 150; // m : un point est « accessible » si la voie passe à moins de 150 m
const VALIDITE = 90 * 86400000;
const NIVEAUX = { voiture: 3, '4x4': 2, pied: 1, aucun: 0 };

const ROUTES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street', 'road',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const SENTIERS = new Set(['path', 'footway', 'bridleway', 'steps', 'pedestrian', 'cycleway', 'via_ferrata']);
const INTERDIT = new Set(['no', 'private']);

// Classe d'une voie OSM : voiture, 4x4, pied (ou null si non praticable)
function classeVoie(t) {
  const h = t.highway;
  const interditVehicule = INTERDIT.has(t.motor_vehicle) || INTERDIT.has(t.motorcar) || INTERDIT.has(t.vehicle) || (INTERDIT.has(t.access) && !['yes', 'designated', 'permissive', 'destination'].includes(t.motor_vehicle));
  const interditPieton = INTERDIT.has(t.foot) || (INTERDIT.has(t.access) && !['yes', 'designated', 'permissive'].includes(t.foot));
  if (ROUTES.has(h)) {
    if (!interditVehicule) return { classe: 'voiture', prive: false };
    return interditPieton ? { classe: 'voiture', prive: true } : { classe: 'pied', prive: false };
  }
  if (h === 'track') {
    if (interditVehicule) return interditPieton ? { classe: '4x4', prive: true } : { classe: 'pied', prive: false };
    // Piste revêtue ou empierrée (grade1) : praticable en voiture
    return { classe: t.tracktype === 'grade1' ? 'voiture' : '4x4', prive: false };
  }
  if (SENTIERS.has(h)) return interditPieton ? null : { classe: 'pied', prive: false };
  return null;
}

// Distance (m) d'un point à une polyligne, projection locale équirectangulaire
function distancePolyligne(p, geom) {
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180), ky = 110540;
  let min = Infinity;
  for (let i = 0; i < geom.length; i++) {
    const ax = (geom[i].lon - p.lon) * kx, ay = (geom[i].lat - p.lat) * ky;
    if (i === 0) { min = Math.min(min, Math.hypot(ax, ay)); continue; }
    const bx = (geom[i - 1].lon - p.lon) * kx, by = (geom[i - 1].lat - p.lat) * ky;
    const dx = ax - bx, dy = ay - by, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(bx * dx + by * dy) / l2)) : 0;
    min = Math.min(min, Math.hypot(bx + t * dx, by + t * dy));
  }
  return min;
}

function evaluer(p, voies) {
  const r = { voiture: null, '4x4': null, pied: null, prive: null, nomVoie: null };
  for (const v of voies) {
    const c = classeVoie(v.tags || {});
    if (!c || !v.geometry) continue;
    const d = Math.round(distancePolyligne(p, v.geometry));
    if (d > RAYON) continue;
    if (c.prive) { if (r.prive == null || d < r.prive) r.prive = d; continue; }
    if (r[c.classe] == null || d < r[c.classe]) { r[c.classe] = d; if (c.classe === 'voiture' && v.tags.name) r.nomVoie = v.tags.name; }
  }
  // Un niveau supérieur suffit pour les niveaux inférieurs (une route est aussi praticable à pied)
  const d4 = [r.voiture, r['4x4']].filter((x) => x != null);
  const dp = [r.voiture, r['4x4'], r.pied].filter((x) => x != null);
  const dist = { voiture: r.voiture, '4x4': d4.length ? Math.min(...d4) : null, pied: dp.length ? Math.min(...dp) : null };
  const type = dist.voiture != null && dist.voiture <= PROCHE ? 'voiture' : dist['4x4'] != null && dist['4x4'] <= PROCHE ? '4x4' : dist.pied != null && dist.pied <= PROCHE ? 'pied' : 'aucun';
  return { type, niveau: NIVEAUX[type], distances: dist, prive: r.prive, nomVoie: r.nomVoie };
}

function creerAcces(dossier, journal, suffixe = '') {
  const fichier = path.join(dossier, `acces-sommets${suffixe}.json`);
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* vide */ }
  const cle = (p) => p.lat.toFixed(4) + ',' + p.lon.toFixed(4);
  let enCours = false;
  const etat = { total: 0, faits: 0, erreur: null };

  async function requete(lot) {
    const q = `[out:json][timeout:120];(${lot.map((p) => `way(around:${RAYON},${p.lat.toFixed(5)},${p.lon.toFixed(5)})[highway];`).join('')});out tags geom;`;
    let derniere;
    for (const url of SERVEURS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'carte-live-meshtastic/1.0 (+https://github.com/sauveteur71/carte-live-meshtastic)', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(150000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return (await r.json()).elements || [];
      } catch (e) { derniere = e; }
    }
    throw derniere;
  }

  // Complète les points sans accès connu (en arrière-plan, par lots, avec pauses pour ménager Overpass)
  async function completer(points, apres) {
    if (enCours) return;
    enCours = true;
    try {
      for (const p of points) { const c = cache[cle(p)]; if (c && Date.now() - c.date < VALIDITE) p.acces = c.acces; }
      const manquants = points.filter((p) => !p.acces);
      etat.total = points.length; etat.faits = points.length - manquants.length; etat.erreur = null;
      if (!manquants.length) return;
      journal(`[Accès] recherche des voies d'accès de ${manquants.length} point(s) haut(s)…`);
      for (let k = 0; k < manquants.length; k += 25) {
        const lot = manquants.slice(k, k + 25);
        let voies;
        try { voies = await requete(lot); } catch (e) {
          etat.erreur = e.message;
          journal(`[Accès] Overpass indisponible (${e.message}), nouvel essai dans 10 min`);
          setTimeout(() => completer(points, apres).catch(() => {}), 10 * 60000);
          break;
        }
        for (const p of lot) { p.acces = evaluer(p, voies); cache[cle(p)] = { date: Date.now(), acces: p.acces }; }
        etat.faits += lot.length;
        try { fs.writeFileSync(fichier, JSON.stringify(cache)); } catch { /* lecture seule */ }
        if (apres) apres();
        await new Promise((r) => setTimeout(r, 4000));
      }
      const n = (t) => points.filter((p) => p.acces && p.acces.type === t).length;
      journal(`[Accès] ${etat.faits}/${points.length} points évalués : voiture ${n('voiture')}, 4×4 ${n('4x4')}, à pied ${n('pied')}, hors chemin ${n('aucun')}`);
    } finally { enCours = false; }
  }

  return { completer, etat: () => ({ ...etat, enCours }), NIVEAUX };
}

module.exports = { creerAcces, classeVoie, evaluer, NIVEAUX };
