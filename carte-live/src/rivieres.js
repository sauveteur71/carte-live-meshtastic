'use strict';
// Couche « Rivières » : hauteurs d'eau et débits en direct des stations hydrométriques publiques du secteur, lus sur
// l'API Hub'Eau (eaufrance, les mêmes mesures que Vigicrues). Gratuit, sans compte et sans matériel.
// Désactivée par défaut (RIVIERES=oui pour l'activer). Alerte quand l'eau monte vite ou dépasse un seuil choisi.

const BASE = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie';
const DUREE = 24 * 3600000; // historique gardé par station
const PERIODE = 10 * 60000; // relevé toutes les 10 min (les stations publient toutes les 5 à 60 min)

// « K0010020=2,5 ; K0114020=3 » : seuil de hauteur (m) par station (code à 10 caractères) ou par site (8 caractères)
function lireSeuils(texte) {
  const s = new Map();
  for (const m of String(texte || '').matchAll(/([A-Z0-9]{8,10})\s*[=:]\s*(-?\d+(?:[.,]\d+)?)/gi)) s.set(m[1].toUpperCase(), Number(m[2].replace(',', '.')));
  return s;
}

function lireReglages(env = process.env) {
  return {
    actif: String(env.RIVIERES || '').toLowerCase() === 'oui',
    monteeCmH: Math.max(Number(env.RIVIERES_MONTEE_CM_H) || 20, 1),
    seuils: lireSeuils(env.RIVIERES_SEUILS),
  };
}

function creerRivieres({ zone, journal = () => {}, reglages = lireReglages(), recuperer = (u) => fetch(u, { signal: AbortSignal.timeout(30000) }) }) {
  const r = reglages;
  const stations = new Map(); // code → { code, site, nom, cours, lat, lon }
  const series = new Map(); // code → [{ t, h }] (m), triées
  const debits = new Map(); // code → { t, q } (m³/s), dernier relevé
  const etat = { actif: r.actif, erreur: null, maj: null, majStations: null, enEchecDepuis: null };
  let dernierObs = 0, bboxStations = '', minuterie = null, arret = false;

  const bbox = () => { const [sud, ouest, nord, est] = zone(); return [ouest, sud, est, nord].map((x) => (+x).toFixed(3)).join(','); };
  async function json(url) {
    const rep = await recuperer(url);
    if (!rep.ok && rep.status !== 206) throw new Error(`Hub'Eau : HTTP ${rep.status}`);
    return rep.json();
  }

  async function majStations() {
    const b = bbox();
    if (b === bboxStations && etat.majStations && Date.now() - etat.majStations < 24 * 3600000) return;
    const d = await json(`${BASE}/referentiel/stations?bbox=${b}&en_service=true&format=json&size=1000&fields=code_station,code_site,libelle_station,libelle_cours_eau,longitude_station,latitude_station`);
    stations.clear();
    for (const s of d.data || []) {
      if (s.latitude_station == null || s.longitude_station == null) continue;
      stations.set(s.code_station, { code: s.code_station, site: s.code_site, nom: s.libelle_station, cours: s.libelle_cours_eau || null, lat: +s.latitude_station, lon: +s.longitude_station });
    }
    if (b !== bboxStations) { series.clear(); debits.clear(); dernierObs = 0; }
    bboxStations = b; etat.majStations = Date.now();
  }

  async function majObservations() {
    const depuis = new Date(Math.max(dernierObs - 60000, Date.now() - DUREE)).toISOString().replace(/\.\d+Z$/, 'Z');
    let url = `${BASE}/observations_tr?bbox=${bboxStations}&date_debut_obs=${depuis}&size=20000&fields=code_station,date_obs,resultat_obs,grandeur_hydro`;
    for (let page = 0; url && page < 5; page++) {
      const d = await json(url);
      for (const o of d.data || []) {
        const t = Date.parse(o.date_obs);
        if (!Number.isFinite(t) || o.resultat_obs == null) continue;
        dernierObs = Math.max(dernierObs, t);
        if (o.grandeur_hydro === 'Q') {
          const q = debits.get(o.code_station);
          if (!q || t > q.t) debits.set(o.code_station, { t, q: o.resultat_obs / 1000 });
          continue;
        }
        const l = series.get(o.code_station) || [];
        if (!l.some((x) => x.t === t)) l.push({ t, h: o.resultat_obs / 1000 });
        series.set(o.code_station, l);
      }
      url = d.next && (d.data || []).length ? d.next : null;
    }
    const lim = Date.now() - DUREE;
    for (const [k, l] of series) { l.sort((a, b) => a.t - b.t); while (l.length && l[0].t < lim) l.shift(); if (!l.length) series.delete(k); }
  }

  async function releve() {
    if (!r.actif || arret) return;
    try {
      await majStations();
      await majObservations();
      etat.maj = Date.now(); etat.erreur = null; etat.enEchecDepuis = null;
    } catch (e) {
      etat.erreur = e.message;
      if (!etat.enEchecDepuis) { etat.enEchecDepuis = Date.now(); journal('[Rivières]', 'relevé impossible :', e.message); }
    }
  }

  // Hauteur, tendance sur la dernière heure (cm/h), maximum sur 24 h, débit
  function vue(s) {
    const l = series.get(s.code) || [];
    const d = l[l.length - 1];
    const q = debits.get(s.code);
    let tendance = null;
    if (d) {
      const avant = [...l].reverse().find((x) => d.t - x.t >= 45 * 60000);
      if (avant && d.t - avant.t <= 3 * 3600000) tendance = Math.round(((d.h - avant.h) * 100) / ((d.t - avant.t) / 3600000));
    }
    const seuil = r.seuils.get(s.code) ?? r.seuils.get(s.site) ?? null;
    // Barrage ou retenue : niveau du plan d'eau (souvent en altitude, ou manœuvres de vannes), pas une crue
    const retenue = /barrage|retenue|\blac\b/i.test(s.nom) || (d && (d.h < -5 || d.h > 60));
    return {
      ...s, h: d ? +d.h.toFixed(3) : null, heure: d ? d.t : null, tendance, seuil, retenue: !!retenue,
      max24: l.length ? +Math.max(...l.map((x) => x.h)).toFixed(3) : null, q: q ? +q.q.toFixed(3) : null,
    };
  }

  function liste() { return [...stations.values()].map(vue).filter((s) => s.h != null); }

  function alertes() {
    if (!r.actif) return [];
    const l = [];
    for (const s of liste()) {
      if (Date.now() - s.heure > 3 * 3600000) continue; // mesure trop ancienne : pas d'alerte sur une station muette
      const depasse = s.seuil != null && s.h >= s.seuil;
      const montee = !s.retenue && s.tendance != null && s.tendance >= r.monteeCmH; // un barrage : seulement sur seuil choisi
      if (!depasse && !montee) continue;
      const nom = s.nom + (s.cours && !s.nom.toLowerCase().includes(s.cours.toLowerCase()) ? ` (${s.cours})` : '');
      const parties = [];
      if (depasse) parties.push(`${s.h.toFixed(2).replace('.', ',')} m, seuil de ${String(s.seuil).replace('.', ',')} m dépassé`);
      if (montee) parties.push(`monte de ${s.tendance} cm/h`);
      l.push({
        cle: 'riviere:' + s.code, type: 'riviere', niveau: depasse || s.tendance >= 2 * r.monteeCmH ? 'critique' : 'attention',
        depuis: s.heure, lat: s.lat, lon: s.lon, message: `🌊 ${nom} : ${parties.join(', ')}`,
      });
    }
    return l;
  }

  if (r.actif) {
    setTimeout(releve, 5000).unref?.();
    minuterie = setInterval(releve, PERIODE);
    if (minuterie.unref) minuterie.unref();
  }

  return {
    etat: () => ({ actif: etat.actif, erreur: etat.erreur, maj: etat.maj, enEchecDepuis: etat.enEchecDepuis, stations: stations.size, monteeCmH: r.monteeCmH }),
    liste,
    serie: (code) => (stations.has(code) ? { station: vue(stations.get(code)), mesures: (series.get(code) || []).map((x) => [x.t, +x.h.toFixed(3)]) } : null),
    alertes,
    releve,
    arreter() { arret = true; clearInterval(minuterie); },
  };
}

module.exports = { creerRivieres, lireReglages, lireSeuils };
