// Radiogoniométrie : relevés de gisement (azimut vrai, en degrés depuis le nord, sens horaire) pris par plusieurs
// équipes, et position la plus probable de l'émetteur (balise de détresse, émission à localiser).
// - Calcul dans un plan local (projection équirectangulaire autour des relevés, exacte à mieux que 0,5 % sur 50 km).
// - Moindres carrés pondérés : point qui minimise la somme des carrés des distances perpendiculaires aux droites de
//   relèvement, chaque droite pesant 1 / (incertitude angulaire × distance)², distance recalculée en 4 passes
//   (un relèvement lointain compte moins qu'un relèvement proche à précision égale).
// - Ellipse d'erreur à 95 % tirée de la matrice de covariance ; un relèvement qui « tourne le dos » à la solution
//   (plus de 90° d'écart) est signalé et écarté, de même qu'un relèvement aberrant (plus de 3 fois son incertitude
//   de la solution des autres, réflexion probable) quand il en reste au moins deux.
// Partagé entre le serveur (Node) et les pages (window.Gonio), comme dfci.js.
(function (racine) {
  'use strict';
  const R = 6371008.8, rad = Math.PI / 180;

  // Point atteint depuis (lat, lon) à « distance » mètres dans la direction « azimut » (formule sphérique)
  function destination(lat, lon, azimut, distance) {
    const d = distance / R, t = azimut * rad, p1 = lat * rad, l1 = lon * rad;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / rad, lon: ((l2 / rad + 540) % 360) - 180 };
  }
  function distance(a, b) {
    const dl = (b.lat - a.lat) * rad, dg = (b.lon - a.lon) * rad;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dg / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function azimut(a, b) {
    const p1 = a.lat * rad, p2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
    return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / rad + 360) % 360;
  }

  // QTH-locator Maidenhead (4, 6, 8 ou 10 caractères) → centre du carré
  function depuisLocator(texte) {
    const l = String(texte || '').trim().toUpperCase();
    if (!/^[A-R]{2}(\d{2}([A-X]{2}(\d{2}([A-X]{2})?)?)?)?$/.test(l) || l.length < 4) return null;
    let lon = -180, lat = -90, dLon = 20, dLat = 10;
    lon += (l.charCodeAt(0) - 65) * dLon; lat += (l.charCodeAt(1) - 65) * dLat;
    dLon /= 10; dLat /= 10; lon += Number(l[2]) * dLon; lat += Number(l[3]) * dLat;
    if (l.length >= 6) { dLon /= 24; dLat /= 24; lon += (l.charCodeAt(4) - 65) * dLon; lat += (l.charCodeAt(5) - 65) * dLat; }
    if (l.length >= 8) { dLon /= 10; dLat /= 10; lon += Number(l[6]) * dLon; lat += Number(l[7]) * dLat; }
    if (l.length >= 10) { dLon /= 24; dLat /= 24; lon += (l.charCodeAt(8) - 65) * dLon; lat += (l.charCodeAt(9) - 65) * dLat; }
    return { lat: lat + dLat / 2, lon: lon + dLon / 2, precisionM: Math.round((dLat * 111320) / 2) };
  }
  function versLocator(lat, lon, longueur = 10) {
    let x = lon + 180, y = lat + 90, s = '';
    s += String.fromCharCode(65 + Math.floor(x / 20)) + String.fromCharCode(65 + Math.floor(y / 10));
    x %= 20; y %= 10; s += Math.floor(x / 2) + '' + Math.floor(y);
    x %= 2; y %= 1; s += String.fromCharCode(65 + Math.floor(x * 12)) + String.fromCharCode(65 + Math.floor(y * 24));
    x = (x * 12) % 1; y = (y * 24) % 1; s += Math.floor(x * 10) + '' + Math.floor(y * 10);
    x = (x * 10) % 1; y = (y * 10) % 1; s += String.fromCharCode(65 + Math.floor(x * 24)) + String.fromCharCode(65 + Math.floor(y * 24));
    return s.slice(0, longueur).replace(/^(.{4})(..)/, (m, a, b) => a + b.toLowerCase()).replace(/^(.{8})(..)$/, (m, a, b) => a + b.toLowerCase());
  }

  // Intersection de deux relèvements (null si parallèles ou si le point est derrière l'un des deux)
  function croisement(r1, r2, proj) {
    const p1 = proj.vers(r1), p2 = proj.vers(r2);
    const d1 = [Math.sin(r1.gisement * rad), Math.cos(r1.gisement * rad)], d2 = [Math.sin(r2.gisement * rad), Math.cos(r2.gisement * rad)];
    const det = d1[0] * -d2[1] - d1[1] * -d2[0];
    if (Math.abs(det) < 1e-6) return null;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const t1 = (dx * -d2[1] - dy * -d2[0]) / det, t2 = (d1[0] * dy - d1[1] * dx) / det;
    if (t1 <= 0 || t2 <= 0) return null;
    return proj.depuis([p1[0] + t1 * d1[0], p1[1] + t1 * d1[1]]);
  }

  // releves : [{ lat, lon, gisement (°), incertitude (° ; 5 par défaut), id }]
  function localiser(releves) {
    const l = (releves || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && Number.isFinite(r.gisement));
    const res = { nb: l.length, estimation: null, ellipse: null, croisements: [], ecartes: [], residus: {} };
    if (l.length < 2) return res;
    const lat0 = l.reduce((s, r) => s + r.lat, 0) / l.length, lon0 = l.reduce((s, r) => s + r.lon, 0) / l.length;
    const kx = R * rad * Math.cos(lat0 * rad), ky = R * rad;
    const proj = { vers: (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky], depuis: (xy) => ({ lat: lat0 + xy[1] / ky, lon: lon0 + xy[0] / kx }) };
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) { const c = croisement(l[i], l[j], proj); if (c) res.croisements.push({ ...c, a: l[i].id, b: l[j].id }); }

    // Écart angulaire entre un relèvement et la direction réelle d'un point (degrés, 0 à 180)
    const ecartEn = (r, xy) => { const p = proj.vers(r); const az = Math.atan2(xy[0] - p[0], xy[1] - p[1]) / rad; return Math.abs(((az - r.gisement + 540) % 360) - 180); };
    const tolere = (r) => Math.max(10, 3 * (Number(r.incertitude) || 5));
    // Moindres carrés pondérés à partir d'un point de départ (4 passes : le poids dépend de la distance)
    function resoudre(liste, depart) {
      let xy = depart, M = null;
      for (let passe = 0; passe < 4; passe++) {
        let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
        for (const r of liste) {
          const p = proj.vers(r), t = r.gisement * rad, n = [Math.cos(t), -Math.sin(t)];
          const dist = Math.max(200, Math.hypot(xy[0] - p[0], xy[1] - p[1]));
          const sigma = Math.max(0.5, Number(r.incertitude) || 5) * rad * dist;
          const w = 1 / (sigma * sigma);
          a11 += w * n[0] * n[0]; a12 += w * n[0] * n[1]; a22 += w * n[1] * n[1];
          const np = n[0] * p[0] + n[1] * p[1];
          b1 += w * n[0] * np; b2 += w * n[1] * np;
        }
        const det = a11 * a22 - a12 * a12;
        if (!(Math.abs(det) > 1e-30)) return null;
        xy = [(a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det];
        M = { a11, a12, a22, det };
      }
      return { x: xy, A: M };
    }
    // Robustesse (relèvement réfléchi par le relief, erreur de lecture) : chaque croisement de deux relèvements est
    // essayé comme solution ; on garde celui qu'approuvent le plus de relèvements (à 3 incertitudes près, 10° au moins),
    // puis le calcul final se fait sur ces seuls relèvements. Les autres sont signalés comme écartés.
    let actifs = l.slice(), depart = [0, 0];
    if (l.length >= 3 && res.croisements.length) {
      let meilleur = null;
      for (const c of res.croisements) {
        const xy = proj.vers(c);
        const accord = l.filter((r) => ecartEn(r, xy) <= tolere(r));
        const cout = accord.reduce((s2, r) => s2 + (ecartEn(r, xy) / (Number(r.incertitude) || 5)) ** 2, 0);
        if (!meilleur || accord.length > meilleur.accord.length || (accord.length === meilleur.accord.length && cout < meilleur.cout)) meilleur = { xy, accord, cout };
      }
      if (meilleur && meilleur.accord.length >= 2) { actifs = meilleur.accord; depart = meilleur.xy; }
    } else if (res.croisements.length) depart = proj.vers(res.croisements[0]);
    let sol = resoudre(actifs, depart);
    // Relèvements qui tournent encore le dos à la solution : écartés, puis nouveau calcul
    if (sol) {
      const dos = actifs.filter((r) => ecartEn(r, sol.x) > 90);
      if (dos.length && actifs.length - dos.length >= 2) { actifs = actifs.filter((r) => !dos.includes(r)); sol = resoudre(actifs, sol.x); }
    }
    // Solution derrière un relèvement retenu (deux relèvements qui divergent) : pas d'estimation
    if (sol && actifs.some((r) => ecartEn(r, sol.x) > 90)) sol = null;
    res.ecartes = l.filter((r) => !actifs.includes(r)).map((r) => r.id);
    const x = sol && sol.x, A = sol && sol.A;
    if (!x || !A) return res;
    res.estimation = proj.depuis(x);
    // Covariance = A⁻¹ ; demi-axes de l'ellipse à 95 % (khi² à 2 degrés : 5,991)
    const c11 = A.a22 / A.det, c22 = A.a11 / A.det, c12 = -A.a12 / A.det;
    const tr = c11 + c22, dif = Math.sqrt(((c11 - c22) / 2) ** 2 + c12 * c12);
    const l1 = Math.max(0, tr / 2 + dif), l2 = Math.max(0, tr / 2 - dif);
    const k = Math.sqrt(5.991);
    const angle = (Math.atan2(l1 - c11, c12 || 1e-12) / rad + 360) % 180; // orientation du grand axe (depuis l'est)
    res.ellipse = { grandAxeM: Math.round(k * Math.sqrt(l1)), petitAxeM: Math.round(k * Math.sqrt(l2)), azimutGrandAxe: Math.round((90 - angle + 360) % 180) };
    for (const r of l) {
      const p = proj.vers(r), az = Math.atan2(x[0] - p[0], x[1] - p[1]) / rad;
      res.residus[r.id] = { ecartDeg: +(((az - r.gisement + 540) % 360) - 180).toFixed(1), distanceM: Math.round(Math.hypot(x[0] - p[0], x[1] - p[1])) };
    }
    res.utilises = actifs.length;
    return res;
  }

  // Contour d'une ellipse (pour l'afficher) : centre, demi-axes en mètres, azimut du grand axe
  function contourEllipse(centre, grandAxeM, petitAxeM, azimutGrandAxe, n = 48) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = (2 * Math.PI * i) / n, u = grandAxeM * Math.cos(t), v = petitAxeM * Math.sin(t);
      const az = azimutGrandAxe * rad;
      const est = u * Math.sin(az) + v * Math.cos(az), nord = u * Math.cos(az) - v * Math.sin(az);
      pts.push([centre.lat + nord / (R * rad), centre.lon + est / (R * rad * Math.cos(centre.lat * rad))]);
    }
    return pts;
  }
  // Cône d'un relèvement : sommet + deux bords à ± incertitude, longueur en mètres
  function cone(r, longueurM) {
    const inc = Math.max(0.5, Number(r.incertitude) || 5), pts = [[r.lat, r.lon]];
    for (let a = -inc; a <= inc + 1e-9; a += inc / 4) { const p = destination(r.lat, r.lon, r.gisement + a, longueurM); pts.push([p.lat, p.lon]); }
    pts.push([r.lat, r.lon]);
    return pts;
  }
  // Message radio « GONIO 125 », « GIS 125/5 », « GONIO 125 ±3 » (gisement puis incertitude facultative)
  function lireMessage(texte) {
    const m = /^\s*(?:GONIO|GIS|GISEMENT|RLV|QTE)\s*[:=]?\s*(\d{1,3}(?:[.,]\d)?)\s*(?:°|DEG)?\s*(?:(?:\/|±|\+-|\+\/-|A)\s*(\d{1,2}(?:[.,]\d)?))?/i.exec(String(texte || ''));
    if (!m) return null;
    const g = Number(m[1].replace(',', '.'));
    if (!(g >= 0 && g <= 360)) return null;
    return { gisement: g % 360, incertitude: m[2] ? Number(m[2].replace(',', '.')) : null };
  }

  const api = { localiser, destination, distance, azimut, depuisLocator, versLocator, contourEllipse, cone, lireMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else racine.Gonio = api;
})(typeof window !== 'undefined' ? window : globalThis);
