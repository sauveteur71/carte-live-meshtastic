'use strict';
// Sites réalistes : pour chaque point haut candidat, d'après OpenStreetMap (une requête par département, 90 jours de cache)
//  - support existant à proximité (château d'eau, pylône ou mât de télécommunication, tour) : installation plus simple ;
//  - zone protégée stricte (réserve naturelle, cœur de parc national, protection forte) : site écarté des plans ;
//  - habitation la plus proche (hameau, village, maison isolée) : raccordement électrique probable ou solaire.

const fs = require('fs');
const path = require('path');

const SERVEURS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const VALIDITE = 90 * 86400000;
const RAYON_SUPPORT = 300; // m
const LIB_SUPPORT = { water_tower: 'château d’eau', mast: 'mât', tower: 'tour / pylône', communications_tower: 'pylône de télécommunication' };

function distanceM(a, b) {
  const r = Math.PI / 180, s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(s));
}
// Point dans un ensemble d'anneaux (règle pair-impair : les trous sont gérés naturellement)
function dansAnneaux(p, anneaux) {
  let dedans = false;
  for (const a of anneaux) {
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      const xi = a[i].lon, yi = a[i].lat, xj = a[j].lon, yj = a[j].lat;
      if ((yi > p.lat) !== (yj > p.lat) && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) dedans = !dedans;
    }
  }
  return dedans;
}

function creerRealisme(dossier, journal, suffixe, emprise) {
  const fichier = path.join(dossier, `realisme${suffixe}.json`);
  let donnees = null; // { date, supports, zones, habitations }
  try { donnees = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* absent */ }
  const etat = { pret: !!donnees, erreur: null, date: donnees ? donnees.date : null };
  let enCours = null;

  async function requete(q) {
    let derniere;
    for (const url of SERVEURS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'carte-live-meshtastic/1.0 (+https://github.com/sauveteur71/carte-live-meshtastic)', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(200000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return (await r.json()).elements || [];
      } catch (e) { derniere = e; }
    }
    throw derniere;
  }

  async function charger() {
    if (donnees && Date.now() - donnees.date < VALIDITE) return donnees;
    if (enCours) return enCours;
    enCours = (async () => {
      const b = `${emprise.sud},${emprise.ouest},${emprise.nord},${emprise.est}`;
      journal('[Sites] recherche des supports, zones protégées et habitations (OpenStreetMap)…');
      const supports = (await requete(`[out:json][timeout:180];(nwr["man_made"~"^(water_tower|mast|tower|communications_tower)$"](${b});nwr["tower:type"="communication"](${b}););out center tags;`))
        .map((e) => ({ lat: e.lat != null ? e.lat : e.center && e.center.lat, lon: e.lon != null ? e.lon : e.center && e.center.lon, type: e.tags && e.tags['tower:type'] === 'communication' ? 'communications_tower' : (e.tags || {}).man_made, nom: (e.tags || {}).name || null, operateur: (e.tags || {}).operator || null }))
        .filter((x) => x.lat != null && LIB_SUPPORT[x.type]);
      await new Promise((r) => setTimeout(r, 3000));
      const brut = await requete(`[out:json][timeout:180];(relation["leisure"="nature_reserve"](${b});way["leisure"="nature_reserve"](${b});relation["boundary"="national_park"](${b});relation["boundary"="protected_area"]["protect_class"~"^(1a|1b|2|4)$"](${b});way["boundary"="protected_area"]["protect_class"~"^(1a|1b|2|4)$"](${b}););out tags geom;`);
      const zones = [];
      for (const e of brut) {
        const anneaux = e.type === 'way' ? [e.geometry || []] : (e.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry);
        const inners = e.type === 'relation' ? (e.members || []).filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => m.geometry) : [];
        if (!anneaux.length) continue;
        const r = (pts) => pts.map((p) => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) }));
        const t = e.tags || {};
        zones.push({ nom: t.name || 'zone protégée', type: t.leisure === 'nature_reserve' ? 'réserve naturelle' : t.boundary === 'national_park' ? 'parc national' : 'zone protégée (classe ' + (t.protect_class || '?') + ')', anneaux: [...anneaux, ...inners].map(r) });
      }
      await new Promise((r) => setTimeout(r, 3000));
      const habitations = (await requete(`[out:json][timeout:180];node["place"~"^(city|town|village|hamlet|isolated_dwelling|farm)$"](${b});out;`))
        .map((e) => ({ lat: +e.lat.toFixed(5), lon: +e.lon.toFixed(5), nom: (e.tags || {}).name || null, type: (e.tags || {}).place }));
      donnees = { date: Date.now(), supports, zones, habitations };
      try { fs.writeFileSync(fichier, JSON.stringify(donnees)); } catch { /* lecture seule */ }
      etat.pret = true; etat.date = donnees.date; etat.erreur = null;
      journal(`[Sites] ${supports.length} supports, ${zones.length} zones protégées, ${habitations.length} lieux habités`);
      return donnees;
    })().catch((e) => { etat.erreur = e.message; journal('[Sites] OpenStreetMap indisponible :', e.message); return donnees; }).finally(() => { enCours = null; });
    return enCours;
  }

  function evaluer(p) {
    if (!donnees) return null;
    let support = null;
    for (const s of donnees.supports) {
      const d = distanceM(p, s);
      if (d <= RAYON_SUPPORT && (!support || d < support.distance)) support = { type: LIB_SUPPORT[s.type], nom: s.nom, operateur: s.operateur, distance: Math.round(d), lat: s.lat, lon: s.lon };
    }
    let protege = null;
    for (const z of donnees.zones) {
      // test rapide sur l'emprise avant le test précis
      if (dansAnneaux(p, z.anneaux)) { protege = { nom: z.nom, type: z.type }; break; }
    }
    let hab = null;
    for (const h of donnees.habitations) {
      const d = distanceM(p, h);
      if (!hab || d < hab.distance) hab = { nom: h.nom, type: h.type, distance: Math.round(d) };
    }
    const electricite = !hab ? 'inconnue' : hab.distance <= 500 ? 'secteur probable' : hab.distance <= 1500 ? 'secteur à vérifier' : 'solaire à prévoir';
    // Facteur de préférence utilisé par les plans : support existant +15 %, secteur proche +5 %, zone protégée exclue
    const facteur = protege ? 0 : (support ? 1.15 : 1) * (electricite === 'secteur probable' ? 1.05 : 1);
    return { support, protege, habitation: hab, electricite, facteur };
  }

  async function completer(points, apres) {
    const d = await charger();
    if (!d) return;
    for (const p of points) p.realisme = evaluer(p);
    if (apres) apres();
  }

  return { completer, evaluer, etat: () => ({ ...etat }), charger };
}

module.exports = { creerRealisme };
