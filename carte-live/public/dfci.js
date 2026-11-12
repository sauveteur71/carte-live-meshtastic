// Carroyage DFCI (Défense des forêts contre l'incendie), utilisé par les sapeurs-pompiers en France métropolitaine.
// Grille définie en Lambert II étendu (NTF, méridien de Paris) :
//   2 lettres  : carré de 100 km (abscisse puis ordonnée ; A à N sans I ni J ; ordonnée A = 1 500 km)
//   2 chiffres : carré de 20 km (chiffres pairs 0 à 8, abscisse puis ordonnée)
//   lettre + chiffre : carreau de 2 km (abscisse A à L sans I ni J, ordonnée 0 à 9) → ex. KD42F7
//   .1 à .5    : zone dans le carreau : 1 nord-ouest, 2 nord-est, 3 sud-est, 4 sud-ouest, 5 centre (carré de 1 km)
// Règle vérifiée sur les grilles officielles (data.gouv.fr, carroyage DFCI 2 km et zones de 1 km).
// Conversions WGS84 ⇄ NTF : translation à 3 paramètres de l'IGN (précision de quelques mètres).
(function (racine) {
  'use strict';
  const LETTRES = 'ABCDEFGHKLMN';
  const LETTRES_2KM = 'ABCDEFGHKL';
  // Ellipsoïdes et Lambert II étendu
  const WGS = { a: 6378137, f: 1 / 298.257223563 };
  const CLARKE = { a: 6378249.2, b: 6356515.0 };
  const E_CLARKE = Math.sqrt(1 - (CLARKE.b * CLARKE.b) / (CLARKE.a * CLARKE.a));
  const L2E = { n: 0.7289686274, c: 11745793.39, xs: 600000, ys: 8199695.768, lon0: (2 + 20 / 60 + 14.025 / 3600) * Math.PI / 180 };
  const T = [168, 60, -320]; // WGS84 → NTF (opposé de NTF → WGS84 : −168, −60, +320)
  const rad = Math.PI / 180;

  function versCartesien(lat, lon, h, a, e2) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    return [(N + h) * Math.cos(lat) * Math.cos(lon), (N + h) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h) * Math.sin(lat)];
  }
  function versGeographique(x, y, z, a, e2) {
    const p = Math.hypot(x, y);
    const lon = Math.atan2(y, x);
    let lat = Math.atan2(z, p * (1 - e2));
    for (let i = 0; i < 6; i++) { const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2); lat = Math.atan2(z + e2 * N * Math.sin(lat), p); }
    return [lat, lon];
  }
  const e2W = WGS.f * (2 - WGS.f), e2C = E_CLARKE * E_CLARKE;
  function wgsVersNtf(lat, lon) {
    const [x, y, z] = versCartesien(lat * rad, lon * rad, 0, WGS.a, e2W);
    return versGeographique(x + T[0], y + T[1], z + T[2], CLARKE.a, e2C);
  }
  function ntfVersWgs(latR, lonR) {
    const [x, y, z] = versCartesien(latR, lonR, 0, CLARKE.a, e2C);
    const [la, lo] = versGeographique(x - T[0], y - T[1], z - T[2], WGS.a, e2W);
    return [la / rad, lo / rad];
  }
  const latIso = (phi, e) => Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
  // WGS84 (degrés) → Lambert II étendu (mètres)
  function versLambert2e(lat, lon) {
    const [phi, lam] = wgsVersNtf(lat, lon);
    const R = L2E.c * Math.exp(-L2E.n * latIso(phi, E_CLARKE)), g = L2E.n * (lam - L2E.lon0);
    return [L2E.xs + R * Math.sin(g), L2E.ys - R * Math.cos(g)];
  }
  // Lambert II étendu (mètres) → WGS84 (degrés)
  function depuisLambert2e(X, Y) {
    const dx = X - L2E.xs, dy = L2E.ys - Y;
    const R = Math.hypot(dx, dy), g = Math.atan2(dx, dy);
    const lam = L2E.lon0 + g / L2E.n, L = -Math.log(R / L2E.c) / L2E.n;
    let phi = 2 * Math.atan(Math.exp(L)) - Math.PI / 2;
    for (let i = 0; i < 10; i++) {
      const es = E_CLARKE * Math.sin(phi);
      phi = 2 * Math.atan((((1 + es) / (1 - es)) ** (E_CLARKE / 2)) * Math.exp(L)) - Math.PI / 2;
    }
    return ntfVersWgs(phi, lam);
  }

  // Code DFCI d'un point (précision : carreau de 2 km, avec la zone .1 à .5 si zone = true). null hors de la grille.
  function versDfci(lat, lon, zone = true) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 40 || lat > 52.5 || lon < -6.5 || lon > 11) return null;
    const [X, Y0] = versLambert2e(lat, lon);
    const Y = Y0 - 1500000;
    if (X < 0 || Y < 0 || X >= 1200000 || Y >= 1200000) return null;
    let c = LETTRES[Math.floor(X / 100000)] + LETTRES[Math.floor(Y / 100000)]
      + Math.floor((X % 100000) / 20000) * 2 + Math.floor((Y % 100000) / 20000) * 2
      + LETTRES_2KM[Math.floor((X % 20000) / 2000)] + Math.floor((Y % 20000) / 2000);
    if (zone) {
      const x = X % 2000, y = Y % 2000;
      const z = x >= 500 && x < 1500 && y >= 500 && y < 1500 ? 5 : y >= 1000 ? (x < 1000 ? 1 : 2) : (x < 1000 ? 4 : 3);
      c += '.' + z;
    }
    return c;
  }
  // Coin sud-ouest et taille (mètres, Lambert II étendu) d'un code DFCI partiel ou complet
  function emprise(code) {
    const m = /^\s*([A-HK-N])([A-HK-N])(?:\s*([02468])([02468])(?:\s*([A-HK-L])\s*(\d)(?:\s*[.,]\s*([1-5]))?)?)?\s*$/i.exec(String(code || ''));
    if (!m) return null;
    const u = (s) => s.toUpperCase();
    let X = LETTRES.indexOf(u(m[1])) * 100000, Y = LETTRES.indexOf(u(m[2])) * 100000 + 1500000, cote = 100000, zone = null;
    if (m[3] != null) { X += Number(m[3]) * 10000; Y += Number(m[4]) * 10000; cote = 20000; }
    if (m[5] != null) { X += LETTRES_2KM.indexOf(u(m[5])) * 2000; Y += Number(m[6]) * 2000; cote = 2000; }
    if (m[7] != null) {
      zone = Number(m[7]);
      if (zone === 5) { X += 500; Y += 500; cote = 1000; } else { if (zone === 2 || zone === 3) X += 1000; if (zone === 1 || zone === 2) Y += 1000; cote = 1000; }
    }
    const norm = u(m[1]) + u(m[2]) + (m[3] != null ? m[3] + m[4] : '') + (m[5] != null ? u(m[5]) + m[6] : '') + (zone ? '.' + zone : '');
    return { X, Y, cote, code: norm };
  }
  // Polygone (WGS84) et centre d'un code DFCI
  function depuisDfci(code) {
    const e = emprise(code);
    if (!e) return null;
    const p = (dx, dy) => depuisLambert2e(e.X + dx, e.Y + dy);
    const n = 8, contour = [];
    for (let i = 0; i <= n; i++) contour.push(p((e.cote * i) / n, 0));
    for (let i = 1; i <= n; i++) contour.push(p(e.cote, (e.cote * i) / n));
    for (let i = n - 1; i >= 0; i--) contour.push(p((e.cote * i) / n, e.cote));
    for (let i = n - 1; i > 0; i--) contour.push(p(0, (e.cote * i) / n));
    // Zones 1 à 4 : quart du carreau sans le carré central (zone 5) → point au milieu de la partie extérieure
    const z = Number((e.code.split('.')[1]) || 0);
    const [fx, fy] = z === 1 ? [0.25, 0.75] : z === 2 ? [0.75, 0.75] : z === 3 ? [0.75, 0.25] : z === 4 ? [0.25, 0.25] : [0.5, 0.5];
    const [lat, lon] = p(e.cote * fx, e.cote * fy);
    return { code: e.code, lat, lon, cote: e.cote, contour };
  }
  const estCodeDfci = (t) => !!emprise(t) && /\d/.test(String(t));
  const api = { versDfci, depuisDfci, estCodeDfci, versLambert2e, depuisLambert2e, emprise };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else racine.DFCI = api;
})(typeof window !== 'undefined' ? window : globalThis);
