'use strict';
// Vue 3D du réseau : relief calculé par la carte (tuiles d'altitude « Terrarium » servies par /api/relief/terrain),
// relais Meshtastic et répéteurs MeshCore posés sur le terrain, liaisons des dernières 24 h colorées selon le SNR.
(async () => {
  const $ = (s) => document.querySelector(s);
  const tr = (t) => (window.tr ? window.tr(t) : t);
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const lire = async (url) => { try { const r = await fetch(url, { credentials: 'same-origin' }); return r.ok ? r.json() : null; } catch { return null; } };
  const avis = (html) => { const a = $('#avis'); a.innerHTML = html; a.hidden = !html; };
  const memo = (k, v) => { try { if (v === undefined) return localStorage.getItem('relief3d-' + k); localStorage.setItem('relief3d-' + k, v); } catch { return null; } return null; };

  // Département étudié sur la carte (?dep=), sinon celui de la carte
  const dep = (new URLSearchParams(location.search).get('dep') || '').toUpperCase().replace(/[^0-9AB]/g, '').slice(0, 3);
  const q = dep ? `?dep=${dep}` : '';
  const [cfg, rel] = await Promise.all([lire('/api/config'), lire('/api/relief/etat' + q)]);
  if (!cfg) { avis(tr('Carte injoignable.')); return; }
  if (cfg.titre) document.title = `${tr('Vue 3D du réseau')} · ${cfg.titre}`;
  const e = rel && rel.emprise;
  const pret = rel && rel.mnt === 'pret' && e;
  if (!pret) avis(dep ? tr('Le relief de ce département se prépare (quelques minutes la première fois) : rechargez la page ensuite. La carte s’affiche à plat en attendant.')
    : tr('Le relief n’est pas encore prêt sur ce serveur : il se prépare tout seul après l’installation (quelques minutes). La carte s’affiche à plat en attendant.'));
  if (dep && rel && rel.departement && rel.departement.nom) $('h1').innerHTML = `${esc(tr('Vue 3D du réseau'))} · <span translate="no">${esc(dep)} ${esc(rel.departement.nom)}</span>`;

  const ign = 'Fond &copy; <a href="https://www.ign.fr" target="_blank" rel="noopener">IGN</a>';
  const wmts = (couche, format) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${couche}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  const FONDS = {
    sombre: { tiles: [cfg.tuiles.url], maxzoom: cfg.tuiles.zoomMaxNatif || 16, attribution: cfg.tuiles.attribution },
    photos: { tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg')], maxzoom: 19, attribution: ign },
    topo: { tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), maxzoom: 17, attribution: 'Carte &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), données &copy; contributeurs OpenStreetMap' },
  };
  const fondChoisi = FONDS[memo('fond')] ? memo('fond') : 'sombre';
  $('#fond').value = fondChoisi;
  const exaInit = Number(memo('exa')) || 1.5;
  $('#exa').value = exaInit;
  $('#val-exa').textContent = Number(exaInit).toLocaleString('fr-FR');

  const sources = { fond: { type: 'raster', tileSize: 256, ...FONDS[fondChoisi] } };
  const couches = [{ id: 'fond', type: 'raster', source: 'fond' }];
  if (pret) {
    sources.dem = { type: 'raster-dem', tiles: [location.origin + '/api/relief/terrain/{z}/{x}/{y}.png' + q], tileSize: 256, encoding: 'terrarium', minzoom: 5, maxzoom: 12, bounds: [e.ouest, e.sud, e.est, e.nord], attribution: 'Relief : IGN RGE ALTI / Copernicus' };
    sources.demOmbre = { ...sources.dem };
    couches.push({ id: 'ombrage', type: 'hillshade', source: 'demOmbre', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#ffffff' } });
  }
  const centre = dep && pret ? [(e.sud + e.nord) / 2, (e.ouest + e.est) / 2] : cfg.centre || [45, 4];
  const carte = new maplibregl.Map({
    container: 'carte3d',
    style: { version: 8, sources, layers: couches },
    center: [centre[1], centre[0]], zoom: Math.max((cfg.zoom || 9) - 0.3, 6), pitch: 62, bearing: -18, maxPitch: 80,
    attributionControl: { compact: true },
  });
  carte.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  carte.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  if (pret) carte.addControl(new maplibregl.TerrainControl({ source: 'dem', exaggeration: exaInit }), 'top-right');

  await new Promise((ok) => carte.on('load', ok));
  if (pret) carte.setTerrain({ source: 'dem', exaggeration: exaInit });

  // ---- Fond de carte et exagération du relief ---------------------------------------------------------------
  $('#fond').onchange = () => {
    const f = FONDS[$('#fond').value];
    memo('fond', $('#fond').value);
    carte.removeLayer('fond'); carte.removeSource('fond');
    carte.addSource('fond', { type: 'raster', tileSize: 256, ...f });
    carte.addLayer({ id: 'fond', type: 'raster', source: 'fond' }, carte.getLayer('ombrage') ? 'ombrage' : carte.getStyle().layers[0] && carte.getStyle().layers[0].id);
  };
  $('#exa').oninput = () => {
    const v = Number($('#exa').value);
    $('#val-exa').textContent = v.toLocaleString('fr-FR');
    memo('exa', v);
    if (pret && carte.getTerrain()) carte.setTerrain({ source: 'dem', exaggeration: v });
  };

  // ---- Nœuds et liaisons ------------------------------------------------------------------------------------
  const dedans = (n) => n.lat != null && n.lon != null && (!e || (n.lat >= e.sud - 0.3 && n.lat <= e.nord + 0.3 && n.lon >= e.ouest - 0.3 && n.lon <= e.est + 0.3));
  const marqueurs = [];
  let noeuds = [];
  const ilYa = (t) => {
    if (!t) return '—';
    const m = (Date.now() - t) / 60000;
    return m < 60 ? `${Math.max(1, Math.round(m))} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} j`;
  };
  function couleur(n) {
    if (n.statut && n.statut !== 'actif') return 'var(--eteint)';
    if (n.reseau === 'mc') return 'var(--mc)';
    if (n.passerelle) return 'var(--passerelle)';
    return n.infrastructure ? 'var(--infra)' : 'var(--client)';
  }
  function popup(n) {
    const h = pret ? carte.queryTerrainElevation([n.lon, n.lat], { exaggerated: false }) : null;
    const alt = n.alt != null ? n.alt : h;
    return `<b translate="no">${esc(n.nom)}</b><br>${esc(tr(n.roleFr || n.role || ''))}${n.passerelle ? ' · ' + esc(tr('passerelle MQTT')) : ''}<br>`
      + `${alt != null && Number.isFinite(alt) ? `<span>${tr('Altitude :')}</span> <span translate="no">${Math.round(alt)} m</span><br>` : ''}`
      + `<span>${tr('Dernier paquet :')}</span> <span translate="no">${esc(ilYa(n.dernierVu))}</span>${n.reseau === 'mc' ? '<br>MeshCore' : ''}`;
  }
  function dessinerNoeuds() {
    for (const m of marqueurs) m.remove();
    marqueurs.length = 0;
    const clients = $('#voir-clients').checked;
    for (const n of noeuds) {
      if (!n.infrastructure && !n.passerelle && !clients) continue;
      const el = document.createElement('div');
      el.className = `pt3d${n.infrastructure || n.passerelle ? ' infra' : ''}${n.reseau === 'mc' ? ' mc' : ''}`;
      el.innerHTML = `<span class="rond" style="background:${couleur(n)}"></span><span class="nom" translate="no">${esc(n.nomCourt || n.nom)}</span>`;
      el.title = n.nom;
      const m = new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -9] })
        .setLngLat([n.lon, n.lat])
        .setPopup(new maplibregl.Popup({ offset: 14, closeButton: true }).setHTML(popup(n)))
        .addTo(carte);
      el.addEventListener('click', () => m.getPopup().setHTML(popup(n)));
      marqueurs.push(m);
    }
  }
  async function charger() {
    const [mt, liensMt, mc, liensMc] = await Promise.all([lire('/api/noeuds'), lire('/api/liens?heures=24'), lire('/api/mc/noeuds'), lire('/api/mc/liens?heures=24')]);
    const l = [];
    for (const n of mt || []) if (dedans(n)) l.push({ ...n, cle: 'mt' + n.num, reseau: 'mt', nom: n.nomLong || n.nomCourt || n.id });
    for (const n of Array.isArray(mc) ? mc : []) if (n.infrastructure && dedans(n)) l.push({ ...n, cle: 'mc' + n.cle, reseau: 'mc', nom: n.nom || n.id, nomCourt: (n.nom || n.id || '').slice(0, 14) });
    noeuds = l;
    const pos = new Map(l.map((n) => [n.cle, n]));
    const traits = [];
    const ajouter = (liste, prefixe) => {
      for (const x of liste || []) {
        const a = pos.get(prefixe + x.a), b = pos.get(prefixe + x.b);
        if (!a || !b) continue;
        traits.push({ type: 'Feature', properties: { snr: x.snr == null ? null : Number(x.snr), mc: prefixe === 'mc' }, geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } });
      }
    };
    ajouter(liensMt, 'mt');
    ajouter(Array.isArray(liensMc) ? liensMc : [], 'mc');
    const donnees = { type: 'FeatureCollection', features: traits };
    if (carte.getSource('liens')) carte.getSource('liens').setData(donnees);
    else {
      carte.addSource('liens', { type: 'geojson', data: donnees });
      carte.addLayer({ id: 'liens-halo', type: 'line', source: 'liens', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0b1117', 'line-width': 6, 'line-opacity': 0.6 } });
      const teinte = ['case', ['==', ['get', 'snr'], null], '#c3d0dc', ['interpolate', ['linear'], ['get', 'snr'], -15, '#ff5c6c', -7, '#ffb547', 0, '#e9f56b', 6, '#3ee68a']];
      carte.addLayer({ id: 'liens', type: 'line', source: 'liens', filter: ['!', ['get', 'mc']], layout: { 'line-cap': 'round' }, paint: { 'line-width': 3, 'line-color': teinte } });
      // MeshCore en pointillés
      carte.addLayer({ id: 'liens-mc', type: 'line', source: 'liens', filter: ['get', 'mc'], paint: { 'line-width': 3, 'line-color': teinte, 'line-dasharray': [2, 1.5] } });
    }
    const vis = $('#voir-liens').checked ? 'visible' : 'none';
    for (const c of ['liens', 'liens-mc', 'liens-halo']) carte.setLayoutProperty(c, 'visibility', vis);
    dessinerNoeuds();
  }
  await charger();
  setInterval(charger, 120000);

  // ---- Profil de liaison en 3D (?profil=1&a=…&b=… ou aLat/aLon/bLat/bLon, mêmes réglages que le profil 2D) --
  // Visée et 1re zone de Fresnel dessinées en volumes (extrusions) découpés en tronçons : MapLibre pose chaque
  // tronçon sur le relief à l'altitude de son centre, la hauteur est donc le dégagement au-dessus du sol (× relief).
  const prm = new URLSearchParams(location.search);
  if (prm.get('profil')) {
    const qp = new URLSearchParams();
    for (const k of ['a', 'b', 'aLat', 'aLon', 'bLat', 'bLon', 'aNom', 'bNom', 'ha', 'hb', 'ptx', 'ga', 'gb', 'pertes', 'preset']) if (prm.get(k) != null) qp.set(k, prm.get(k));
    const pr = await lire('/api/profil?' + qp);
    if (!pr || !pr.serie) avis(tr('Profil impossible à calculer pour ces deux points.'));
    else dessinerProfil(pr);
  }
  function dessinerProfil(pr) {
    const s = pr.serie, D = s[s.length - 1].d || 1, A = pr.a, B = pr.b;
    const mLat = 111320, mLon = 111320 * Math.cos(((A.lat + B.lat) / 2) * Math.PI / 180);
    // Axe A→B en mètres locaux, et sa normale pour donner une largeur aux volumes
    const dx = (B.lon - A.lon) * mLon, dy = (B.lat - A.lat) * mLat, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L;
    const pos = (d) => [A.lon + (B.lon - A.lon) * d / D, A.lat + (B.lat - A.lat) * d / D];
    const quad = (d1, d2, demiLargeur) => {
      const [x1, y1] = pos(d1), [x2, y2] = pos(d2);
      const ox = (nx * demiLargeur) / mLon, oy = (ny * demiLargeur) / mLat;
      return [[[x1 + ox, y1 + oy], [x2 + ox, y2 + oy], [x2 - ox, y2 - oy], [x1 - ox, y1 - oy], [x1 + ox, y1 + oy]]];
    };
    const etatPt = (p) => { const c = p.visee - p.solCourbe; return c < 0 ? 'bloque' : c < 0.6 * p.fresnel ? 'partiel' : 'libre'; };
    const COUL = { libre: '#3ee68a', partiel: '#ffb547', bloque: '#ff5c6c' };
    const largeurVisee = Math.max(8, D / 500), epaisseur = Math.max(2, D / 1500); // trait de visée épaissi pour rester visible
    function donnees(ex) {
      // ex : exagération du relief affiché, ou null sans relief (hauteurs absolues au-dessus du niveau de la mer)
      const fres = [], visee = [], mats = [];
      for (let i = 0; i < s.length - 1; i++) {
        const p = s[i], q2 = s[i + 1];
        const c = ((p.visee - p.solCourbe) + (q2.visee - q2.solCourbe)) / 2, F = (p.fresnel + q2.fresnel) / 2;
        const sol = (p.sol + q2.sol) / 2, et = c < 0 ? 'bloque' : c < 0.6 * F ? 'partiel' : 'libre';
        const h = (z) => Math.max(0, ex == null ? sol + z : z * ex);
        if (F > 0.5) fres.push({ type: 'Feature', properties: { b: h(c - F), h: h(c + F), c: COUL[et] }, geometry: { type: 'Polygon', coordinates: quad(p.d, q2.d, F) } });
        visee.push({ type: 'Feature', properties: c < 0 ? { b: h(0), h: h(6), c: COUL.bloque } : { b: h(c - epaisseur), h: h(c + epaisseur), c: COUL[et] }, geometry: { type: 'Polygon', coordinates: quad(p.d, q2.d, largeurVisee) } });
      }
      for (const [x, ant] of [[0, A.antenne], [D, B.antenne]]) {
        const sol = x ? s[s.length - 1].sol : s[0].sol;
        mats.push({ type: 'Feature', properties: { b: ex == null ? sol : 0, h: ex == null ? sol + ant : ant * ex, c: '#f1f5f9' }, geometry: { type: 'Polygon', coordinates: quad(Math.max(0, x - 3), Math.min(D, x + 3), 3) } });
      }
      return { fres: { type: 'FeatureCollection', features: fres }, visee: { type: 'FeatureCollection', features: [...visee, ...mats] } };
    }
    const exaActuelle = () => (carte.getTerrain() ? carte.getTerrain().exaggeration ?? 1 : null);
    const d0 = donnees(exaActuelle());
    carte.addSource('profil-fresnel', { type: 'geojson', data: d0.fres });
    carte.addSource('profil-visee', { type: 'geojson', data: d0.visee });
    carte.addSource('profil-trace', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [pos(0), pos(D)] } } });
    carte.addLayer({ id: 'profil-trace', type: 'line', source: 'profil-trace', paint: { 'line-color': '#f1f5f9', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } });
    carte.addLayer({ id: 'profil-fresnel', type: 'fill-extrusion', source: 'profil-fresnel', paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.3 } });
    carte.addLayer({ id: 'profil-visee', type: 'fill-extrusion', source: 'profil-visee', paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.95 } });
    const maj = () => { const d = donnees(exaActuelle()); carte.getSource('profil-fresnel').setData(d.fres); carte.getSource('profil-visee').setData(d.visee); };
    $('#exa').addEventListener('input', () => setTimeout(maj, 0));
    carte.on('terrain', maj);

    // Étiquettes : antennes A et B, obstacle principal
    const etiquette = (lngLat, html, classe, dessus) => {
      // dessus : étiquette au-dessus du point (obstacle), pour ne pas chevaucher celles des antennes
      const el = document.createElement('div');
      el.className = 'pt3d etiq-profil ' + (classe || '') + (dessus ? ' dessus' : '');
      el.innerHTML = dessus ? `<span class="nom">${html}</span><span class="rond"></span>` : `<span class="rond"></span><span class="nom">${html}</span>`;
      return new maplibregl.Marker({ element: el, anchor: dessus ? 'bottom' : 'top', offset: [0, dessus ? 9 : -9] }).setLngLat(lngLat).addTo(carte);
    };
    const m = (v) => `${Math.round(v)} m`;
    etiquette(pos(0), `A · <span translate="no">${esc(A.nom)}</span> · ${esc(tr('antenne'))} ${m(A.antenne)}`, 'ant');
    etiquette(pos(D), `B · <span translate="no">${esc(B.nom)}</span> · ${esc(tr('antenne'))} ${m(B.antenne)}`, 'ant');
    const iOb = s.reduce((k, p, i) => (i > 0 && i < s.length - 1 && (p.visee - p.solCourbe) / (p.fresnel || 1) < (s[k].visee - s[k].solCourbe) / (s[k].fresnel || 1) ? i : k), Math.floor(s.length / 2));
    const ob = pr.obstacle;
    etiquette(pos(s[iOb].d), `${esc(tr('Obstacle principal'))} · ${ob.degagementM >= 0 ? esc(tr('dégagement')) + ' ' + m(ob.degagementM) : esc(tr('dépasse la visée de')) + ' ' + m(-ob.degagementM)}`, etatPt(s[iOb]), true);

    // Bandeau de synthèse et légende propre au profil
    document.body.classList.add('mode-profil');
    document.title = `${tr('Profil 3D')} · ${A.nom} → ${B.nom}`;
    $('h1').innerHTML = `${esc(tr('Profil 3D'))} · <span translate="no">${esc(A.nom)} → ${esc(B.nom)}</span>`;
    const coul = pr.bilan.marge >= 10 ? COUL.libre : pr.bilan.marge >= 0 ? COUL.partiel : COUL.bloque;
    const bandeau = document.createElement('div');
    bandeau.id = 'profil-info';
    bandeau.innerHTML = `<b>${esc(tr(pr.verdict))}</b><br><span translate="no">${pr.distanceKm.toLocaleString('fr-FR')} km · ${esc(pr.preset)}</span> · ${esc(tr('marge'))} <b style="color:${coul}" translate="no">${pr.bilan.marge.toLocaleString('fr-FR')} dB</b> · ${esc(tr('SNR estimé'))} <span translate="no">${pr.bilan.snrEstime.toLocaleString('fr-FR')} dB</span>`;
    $('#carte3d').appendChild(bandeau);
    $('#legende').innerHTML = `<div><b class="ligne" style="background:${COUL.libre}"></b> ${esc(tr('Visée dégagée'))}</div>`
      + `<div><b class="ligne" style="background:${COUL.partiel}"></b> ${esc(tr('Zone de Fresnel gênée'))}</div>`
      + `<div><b class="ligne" style="background:${COUL.bloque}"></b> ${esc(tr('Visée coupée par le relief'))}</div>`
      + `<div><i style="background:rgba(62,230,138,.35)"></i> ${esc(tr('1re zone de Fresnel (volume clair)'))}</div>`
      + `<div class="note">${esc(tr('Hauteurs multipliées comme le relief. Végétation et bâti non modélisés.'))}</div>`;
    // Liaisons du réseau masquées pour la lisibilité (case à cocher pour les remettre)
    $('#voir-liens').checked = false;
    for (const c of ['liens', 'liens-mc', 'liens-halo']) if (carte.getLayer(c)) carte.setLayoutProperty(c, 'visibility', 'none');

    // Vue de côté : la liaison traverse l'écran de gauche à droite, le relief au premier plan
    const azimut = Math.atan2(dx, dy) * 180 / Math.PI;
    const cam = carte.cameraForBounds([[Math.min(A.lon, B.lon), Math.min(A.lat, B.lat)], [Math.max(A.lon, B.lon), Math.max(A.lat, B.lat)]], { padding: 80, bearing: azimut - 90 });
    carte.jumpTo({ center: cam.center, zoom: Math.min((cam.zoom || 12) + 0.6, 15), bearing: azimut - 90, pitch: 72 });
  }

  $('#voir-liens').onchange = () => { const v = $('#voir-liens').checked ? 'visible' : 'none'; for (const c of ['liens', 'liens-mc', 'liens-halo']) carte.setLayoutProperty(c, 'visibility', v); };
  $('#voir-noms').onchange = () => document.body.classList.toggle('sans-noms', !$('#voir-noms').checked);
  $('#voir-clients').onchange = dessinerNoeuds;

  // ---- Rotation lente autour du centre, vue de dessus -------------------------------------------------------
  let tourne = false, image = null;
  const pas = () => { if (!tourne) return; carte.setBearing(carte.getBearing() + 0.12); image = requestAnimationFrame(pas); };
  const arreter = () => { tourne = false; cancelAnimationFrame(image); $('#tourner').setAttribute('aria-pressed', 'false'); };
  $('#tourner').onclick = () => { if (tourne) return arreter(); tourne = true; $('#tourner').setAttribute('aria-pressed', 'true'); pas(); };
  carte.on('mousedown', arreter); carte.on('touchstart', arreter); carte.on('wheel', arreter);
  $('#dessus').onclick = () => { arreter(); carte.easeTo({ pitch: carte.getPitch() > 5 ? 0 : 62, bearing: 0, duration: 900 }); };
  window.carte3d = carte; // essais
})();
