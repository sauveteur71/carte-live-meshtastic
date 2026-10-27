'use strict';
// Liaisons à sens unique : « B entend A, mais A n'entend jamais B ».
// Un lien orienté (a → b) signifie que b a entendu a directement (passerelle, voisinage ou traceroute).
// On ne peut conclure que pour des nœuds qui rapportent ce qu'ils entendent (passerelles MQTT, module de la carte,
// voisinage, traceroutes) : c'est le cas de A s'il apparaît comme récepteur d'au moins un lien récent.

function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const r = Math.PI / 180, s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

function creerAsymetrie(stockage, config) {
  let cache = null, cacheHeure = 0;

  function calculer() {
    if (cache && Date.now() - cacheHeure < 60000) return cache;
    const maintenant = Date.now();
    const recent = maintenant - 24 * 3600000;
    const long = maintenant - Math.min(config.retentionJours, 7) * 86400000;
    const noeuds = new Map(stockage.q.noeuds.all().map((n) => [n.num, n]));
    const liens = stockage.q.liens.all(long);
    // Meilleure observation par sens (toutes sources confondues)
    const sens = new Map(); // "a>b" → { nb, snr, dernierVu, sources }
    const recepteurs = new Map(); // nœud → nombre d'émetteurs entendus directement depuis 24 h
    for (const l of liens) {
      if (l.a === l.b) continue;
      const k = l.a + '>' + l.b;
      const x = sens.get(k) || { a: l.a, b: l.b, nb: 0, snr: null, dernierVu: 0, sources: new Set() };
      x.nb += l.nb || 1;
      x.dernierVu = Math.max(x.dernierVu, l.dernier_vu || 0);
      if (l.snr != null && (x.snr == null || l.snr > x.snr)) x.snr = l.snr;
      x.sources.add(l.source);
      sens.set(k, x);
      if ((l.dernier_vu || 0) >= recent) recepteurs.set(l.b, (recepteurs.get(l.b) || new Set()).add(l.a));
    }
    const actif = (num) => { const n = noeuds.get(num); return n && (n.dernier_vu || n.vu || 0) >= recent; };
    const nom = (num) => { const n = noeuds.get(num); return n ? n.nom_long || n.nom_court || n.id : '!' + (num >>> 0).toString(16); };
    const pos = (num) => { const n = noeuds.get(num); return n && n.lat != null ? { lat: n.lat, lon: n.lon } : null; };
    const maxKm = config.lienDistanceMaxKm || 120;

    const sensUnique = [], desequilibres = [];
    const vus = new Set();
    for (const x of sens.values()) {
      if (x.dernierVu < recent || x.nb < 3) continue; // B entend A récemment et régulièrement
      const A = x.a, B = x.b;
      const cle = A < B ? A + '-' + B : B + '-' + A;
      const inverse = sens.get(B + '>' + A);
      const d = distanceKm(pos(A), pos(B));
      if (d != null && d > maxKm) continue;
      if (!inverse) {
        // A rapporte ce qu'il entend, et B émet : A devrait l'entendre
        if (!recepteurs.has(A) || !actif(B)) continue;
        sensUnique.push({ entend: B, entendu: A, nomEntend: nom(B), nomEntendu: nom(A), snr: x.snr, nb: x.nb, sources: [...x.sources], distanceKm: d != null ? Math.round(d * 10) / 10 : null, a: pos(A), b: pos(B) });
      } else if (!vus.has(cle) && x.snr != null && inverse.snr != null && Math.abs(x.snr - inverse.snr) >= 10 && inverse.dernierVu >= recent) {
        vus.add(cle);
        const fort = x.snr > inverse.snr ? x : inverse, faible = fort === x ? inverse : x;
        desequilibres.push({ a: fort.a, b: fort.b, nomA: nom(fort.a), nomB: nom(fort.b), snrFort: fort.snr, snrFaible: faible.snr, ecart: Math.round((fort.snr - faible.snr) * 10) / 10, distanceKm: d != null ? Math.round(d * 10) / 10 : null, posA: pos(fort.a), posB: pos(fort.b) });
      }
    }
    // Nœuds qui entendent leurs voisins mais que personne n'entend directement
    const entendus = new Set([...sens.values()].map((x) => x.a));
    const inaudibles = [];
    for (const [num, set] of recepteurs) {
      if (set.size < 2 || entendus.has(num) || !actif(num)) continue;
      inaudibles.push({ num, nom: nom(num), entend: set.size, voisins: [...set].slice(0, 8).map(nom), pos: pos(num) });
    }
    sensUnique.sort((u, v) => v.nb - u.nb);
    desequilibres.sort((u, v) => v.ecart - u.ecart);
    cache = { heure: maintenant, sensUnique: sensUnique.slice(0, 100), desequilibres: desequilibres.slice(0, 100), inaudibles };
    cacheHeure = maintenant;
    return cache;
  }
  return { calculer };
}

module.exports = { creerAsymetrie };
