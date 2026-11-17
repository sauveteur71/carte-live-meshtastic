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

  const [cfg, rel] = await Promise.all([lire('/api/config'), lire('/api/relief/etat')]);
  if (!cfg) { avis('Carte injoignable.'); return; }
  if (cfg.titre) document.title = `${tr('Vue 3D du réseau')} · ${cfg.titre}`;
  const e = rel && rel.emprise;
  const pret = rel && rel.mnt === 'pret' && e;
  if (!pret) avis(tr('Le relief n’est pas encore prêt sur ce serveur : il se prépare tout seul après l’installation (quelques minutes). La carte s’affiche à plat en attendant.'));

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
    sources.dem = { type: 'raster-dem', tiles: [location.origin + '/api/relief/terrain/{z}/{x}/{y}.png'], tileSize: 256, encoding: 'terrarium', minzoom: 5, maxzoom: 12, bounds: [e.ouest, e.sud, e.est, e.nord], attribution: 'Relief : IGN RGE ALTI / Copernicus' };
    sources.demOmbre = { ...sources.dem };
    couches.push({ id: 'ombrage', type: 'hillshade', source: 'demOmbre', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#ffffff' } });
  }
  const centre = cfg.centre || [45, 4];
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
