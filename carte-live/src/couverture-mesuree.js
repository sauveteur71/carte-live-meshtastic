'use strict';
// Couverture mesurée : chaque paquet reçu par une passerelle (ou par le module de la carte) alors que l'on connaît
// la position de son émetteur est une mesure réelle « depuis ce point, la passerelle X reçoit à tel SNR ».
// Réception directe (0 saut) = la zone est couverte par X ; réception après relais = couverte par le maillage.
// Les nœuds à position volontairement floutée (précision < 16 bits, ± 360 m ou plus) sont écartés.

const PAS_LAT = 0.0045; // ≈ 500 m
function creerCouvertureMesuree(stockage) {
  const db = stockage.db;
  let cache = null;

  function points(depuis, filtreNoeud) {
    const recs = db.prepare(`SELECT r.passerelle, r.snr, r.rssi, r.sauts, r.heure, p.de
      FROM receptions r JOIN paquets p ON p.rowid = r.paquet
      WHERE r.heure >= ? AND r.passerelle != p.de AND COALESCE(p.via_mqtt, 0) = 0 ${filtreNoeud != null ? 'AND p.de = ?' : ''}`)
      .all(...(filtreNoeud != null ? [depuis, filtreNoeud] : [depuis]));
    const noeuds = new Map(stockage.q.noeuds.all().map((n) => [n.num, n]));
    const histo = new Map();
    const positionsDe = (num) => {
      if (!histo.has(num)) histo.set(num, db.prepare('SELECT heure, lat, lon FROM positions WHERE num = ? ORDER BY heure').all(num));
      return histo.get(num);
    };
    const sortie = [];
    for (const r of recs) {
      const n = noeuds.get(r.de), gw = noeuds.get(r.passerelle);
      if (!n || n.lat == null || !gw || gw.lat == null) continue;
      if (n.precision_bits != null && n.precision_bits > 0 && n.precision_bits < 16) continue;
      const h = positionsDe(r.de);
      let pos = null;
      if (h.length) {
        let lo = 0, hi = h.length - 1, k = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m].heure <= r.heure) { k = m; lo = m + 1; } else hi = m - 1; }
        pos = k >= 0 ? h[k] : h[0].heure - r.heure < 2 * 3600000 ? h[0] : null;
      } else pos = { lat: n.lat, lon: n.lon };
      if (!pos) continue;
      sortie.push({ mobile: h.length > 1, lat: pos.lat, lon: pos.lon, de: r.de, passerelle: r.passerelle, snr: r.snr, rssi: r.rssi, sauts: r.sauts, heure: r.heure, gwLat: gw.lat, gwLon: gw.lon });
    }
    return { sortie, noeuds };
  }

  function calculer({ jours = 7, noeud = null } = {}) {
    const cle = `${jours}|${noeud}`;
    if (cache && cache.cle === cle && Date.now() - cache.heure < 120000) return cache.r;
    const depuis = Date.now() - jours * 86400000;
    const { sortie, noeuds } = points(depuis, noeud);
    const nom = (x) => { const n = noeuds.get(x); return n ? n.nom_long || n.nom_court || n.id : String(x); };
    const cellules = new Map();
    for (const p of sortie) {
      const pasLon = PAS_LAT / Math.cos((p.lat * Math.PI) / 180);
      const i = Math.floor(p.lat / PAS_LAT), j = Math.floor(p.lon / pasLon);
      const k = i + ':' + j;
      let c = cellules.get(k);
      if (!c) { c = { lat: (i + 0.5) * PAS_LAT, lon: (j + 0.5) * pasLon, dLat: PAS_LAT, dLon: pasLon, n: 0, direct: 0, snrMax: null, passerelles: new Map(), emetteurs: new Set(), dernier: 0 }; cellules.set(k, c); }
      c.n++;
      c.emetteurs.add(p.de);
      c.dernier = Math.max(c.dernier, p.heure);
      if (p.sauts === 0) {
        c.direct++;
        if (p.snr != null && (c.snrMax == null || p.snr > c.snrMax)) c.snrMax = p.snr;
        const g = c.passerelles.get(p.passerelle) || { num: p.passerelle, snr: null, n: 0 };
        g.n++; if (p.snr != null && (g.snr == null || p.snr > g.snr)) g.snr = p.snr;
        c.passerelles.set(p.passerelle, g);
      }
    }
    const liste = [...cellules.values()].map((c) => ({
      lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5), dLat: c.dLat, dLon: +c.dLon.toFixed(6), n: c.n, direct: c.direct, snrMax: c.snrMax, dernier: c.dernier,
      emetteurs: [...c.emetteurs].slice(0, 5).map(nom),
      passerelles: [...c.passerelles.values()].sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99)).slice(0, 4).map((g) => ({ nom: nom(g.num), snr: g.snr, n: g.n })),
    }));
    const r = {
      jours, noeud, mesures: sortie.length, cellules: liste,
      directes: liste.filter((c) => c.direct).length, viaRelais: liste.filter((c) => !c.direct).length,
      surfaceKm2: Math.round(liste.length * 0.25),
      emetteurs: new Set(sortie.map((p) => p.de)).size,
    };
    cache = { cle, heure: Date.now(), r };
    return r;
  }

  // Mesures directes pour calibrer le modèle de relief : point mesuré → passerelle, avec le SNR reçu
  function liensCalibration(jours = 7, max = 600) {
    const { sortie, noeuds } = points(Date.now() - jours * 86400000, null);
    const meilleurs = new Map();
    for (const p of sortie) {
      if (p.sauts !== 0 || p.snr == null || !p.mobile) continue; // nœuds fixes : déjà comptés par les liaisons radio
      const k = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}>${p.passerelle}`;
      const x = meilleurs.get(k);
      if (!x || p.snr > x.snr) meilleurs.set(k, p);
    }
    return [...meilleurs.values()].slice(0, max).map((p) => {
      const g = noeuds.get(p.passerelle), e = noeuds.get(p.de);
      return { a: { lat: p.lat, lon: p.lon }, b: { lat: p.gwLat, lon: p.gwLon }, snr: p.snr, nom: `${e ? e.nom_court || e.id : p.de} → ${g ? g.nom_court || g.id : p.passerelle} (mesure)` };
    });
  }

  return { calculer, liensCalibration };
}

module.exports = { creerCouvertureMesuree };
