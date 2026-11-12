'use strict';
// Carte publique allégée, à intégrer dans un site (iframe) : relais, passerelles, nœuds à position approchée,
// liaisons radio, Meshtastic et MeshCore, avec l'animation en direct des paquets qui transitent.
// Aucune donnée réservée aux membres (messages, positions exactes des particuliers).
// Options d'adresse : ?reseau=meshtastic|meshcore|deux, ?animations=0, ?couverture=actuelle|sites, ?acces=voiture|4x4|pied|tous, ?fond=Plan IGN, ?clients=0 (masquer les nœuds),
// ?liens=0 (masquer les liaisons), ?titre=…, ?zone=dep|v|france|r84 (région)|d63 (département)
const params = new URLSearchParams(location.search);
const opt = { clients: params.get('clients') !== '0', liens: params.get('liens') !== '0' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const couleurSnr = (s) => (s == null ? '#7d8fa3' : s >= 5 ? '#3ee6c4' : s >= 0 ? '#a3e635' : s >= -7 ? '#facc15' : s >= -12 ? '#fb923c' : '#f87171');
const COULEUR_PORT = { position: '#4cc9f0', telemetrie: '#80ed99', texte: '#f72585', nodeinfo: '#b8b8ff', routage: '#8d99ae', traceroute: '#ffd166', voisinage: '#06d6a0', mapreport: '#a0c4ff', chiffre: '#6c757d' };
const COULEUR_MC = { ADVERT: '#22c55e', GRP_TXT: '#f72585', TXT_MSG: '#e879f9', REQ: '#60a5fa', RESPONSE: '#38bdf8', ACK: '#94a3b8', PATH: '#fb923c', TRACE: '#facc15', ANON_REQ: '#a78bfa', GRP_DATA: '#f472b6' };
const ROLES_MC_RELAIS = new Set(['repeteur', 'salon']);

// Variables globales attendues par animations.js (communes avec la carte complète)
let carte = null;
const etat = { couches: { animations: params.get('animations') !== '0' }, noeuds: new Map(), liens: [], marqueurs: new Map() };
const mcp = { noeuds: new Map(), marqueurs: new Map(), coucheNoeuds: null, coucheLiens: null };
let couche, config, vue = 'meshtastic';

function distanceKm(a, b) {
  if (a.lat == null || b.lat == null) return null;
  const r = Math.PI / 180, s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}
// Secteur affiché, au choix du visiteur : département de la carte, avec ses voisins, une région, un autre département
// ou toute la France (?zone=dep|v|r84|d63|france, retenu dans ce navigateur)
let zoneSel = 'dep', departements = [];
const regionSel = () => (/^r\d{2}$/.test(zoneSel) ? (config.regions || []).find((r) => 'r' + r.code === zoneSel) : null);
const depSel = () => (/^d(\d{2}|2A|2B)$/.test(zoneSel) ? departements.find((d) => 'd' + d.code === zoneSel) : null);
function bboxZone() {
  if (zoneSel === 'france') return null;
  if (zoneSel === 'v' && config.zoneVoisins) return config.zoneVoisins.bbox;
  const r = regionSel(); if (r) return r.bbox;
  const d = depSel(); if (d) return d.bbox;
  return config.zoneDep || config.zone;
}
function nomZone() {
  if (zoneSel === 'france') return 'France';
  if (zoneSel === 'v' && config.zoneVoisins) return `${config.zoneNom} et voisins`;
  const r = regionSel(); if (r) return r.nom;
  const d = depSel(); if (d) return d.nom;
  return config.zoneNom;
}
// Carte légère : ailleurs que dans le département de la carte, on affiche le réseau (nœuds, liaisons, animations)
// sans calcul de couverture (le relief n'est chargé que pour le département de la carte)
const depCarte = () => String((config.departement && config.departement.code) || '');
// Si l'admin l'a ouvert (« tous les départements ») : calculs sur le département choisi (relief chargé à la demande)
const franceOuverte = () => config.couverturePublique === 'france';
const couvPossible = () => zoneSel === 'dep' || zoneSel === 'v' || (depSel() && (depSel().code === depCarte() || franceOuverte()));
// « Couverture d'un point » : en mode France, partout (le département du point est choisi par le serveur)
const pointPossible = () => couvPossible() || franceOuverte();
const avecDep = (url) => { const d = depSel(); return franceOuverte() && d && d.code !== depCarte() && !/[?&](lat|dep)=/.test(url) ? url + (url.includes('?') ? '&' : '?') + 'dep=' + d.code : url; };
const zoneLarge = (n) => { const z = config && bboxZone(); return !z || (n.lat != null && n.lat >= z[0] - 0.3 && n.lat <= z[2] + 0.3 && n.lon >= z[1] - 0.3 && n.lon <= z[3] + 0.3); };
const voitMt = () => vue !== 'meshcore', voitMc = () => !!config.meshcore && vue !== 'meshtastic';
function eclair(m, sel) { const el = m && m.getElement() && m.getElement().querySelector(sel); if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
function flasher(num) { eclair(etat.marqueurs.get(num), '.mk'); }
function onde(p, couleur) {
  const o = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="onde" style="border-color:${couleur}"></div>`, iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false, pane: 'traces' }).addTo(carte);
  setTimeout(() => o.remove(), 1500);
}

async function demarrer() {
  config = await (await fetch('/api/config')).json();
  config.zoneDep = config.zone;
  try { departements = await (await fetch('/api/departements')).json(); } catch { departements = []; }
  { let z = params.get('zone'); try { if (!z) z = localStorage.getItem('publique_zone'); } catch { /* indisponible */ } if (z) zoneSel = z; }
  if (!bboxZone() && zoneSel !== 'france') zoneSel = 'dep';
  installerZone();
  majTitre();
  // Lien vers la carte complète : seulement pour un administrateur connecté (la carte publique sert à consulter)
  fetch('/api/compte').then((r) => r.json()).then((u) => { if (u && u.role === 'admin') document.getElementById('lien-complet').hidden = false; }).catch(() => {});
  carte = L.map('carte', { zoomControl: false, attributionControl: true }).setView(config.centre, config.zoom);
  carte.attributionControl.setPrefix('Carte live par F4GLD · <a href="https://www.helloasso.com/associations/radioclub-du-velay/formulaires/2" target="_blank" rel="noopener" title="Soutenir le projet (don au Radio-club du Velay)">♥ soutenir</a> · <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.control.zoom({ position: 'topright' }).addTo(carte);
  carte.createPane('couverture').style.zIndex = 405;
  carte.createPane('liens').style.zIndex = 410;
  carte.createPane('traces').style.zIndex = 420;
  installerFonds();
  recadrer();
  couche = L.layerGroup().addTo(carte);
  mcp.coucheLiens = L.layerGroup().addTo(carte);
  mcp.coucheNoeuds = L.layerGroup().addTo(carte);

  // Onglets Meshtastic / MeshCore / Les deux (MeshCore seulement s'il est activé sur cette carte)
  const demande = params.get('reseau');
  vue = config.meshcore ? (['meshtastic', 'meshcore', 'deux'].includes(demande) ? demande : 'deux') : 'meshtastic';
  const barre = document.getElementById('reseaux');
  barre.hidden = false;
  barre.querySelectorAll('[data-vue]').forEach((b) => { b.hidden = !config.meshcore; b.onclick = () => changerVue(b.dataset.vue); });
  const ba = document.getElementById('b-anim');
  ba.classList.toggle('actif', etat.couches.animations);
  ba.onclick = () => { etat.couches.animations = !etat.couches.animations; ba.classList.toggle('actif', etat.couches.animations); if (typeof dessinerAxes === 'function') dessinerAxes(); };
  changerVue(vue, true);

  await Promise.all([rafraichirMt(), config.meshcore ? rafraichirMc() : null]);
  setInterval(rafraichirMt, 60000);
  rafraichirSignalements(); setInterval(rafraichirSignalements, 60000);
  if (config.meshcore) setInterval(rafraichirMc, 90000);
  connecterWs();
  installerCouverture();
}

// ---- Fonds de carte au choix (mêmes fonds que la carte complète) ----------------------------------
function installerFonds() {
  const t = config.tuiles;
  const wmts = (c, format = 'image/png', style = 'normal') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${c}&STYLE=${style}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  const ign = '&copy; <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> Géoplateforme';
  const fonds = {
    'Sombre': L.layerGroup([
      L.tileLayer(t.url, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 19, className: t.sombre ? 'tuiles-sombres' : '', attribution: t.attribution }),
      ...(t.etiquettes ? [L.tileLayer(t.etiquettes, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 19, className: 'etiquettes-claires' })] : []),
    ]),
    'Plan IGN': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, maxNativeZoom: 19, attribution: ign }),
    'Plan IGN sombre': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, maxNativeZoom: 19, className: 'tuiles-sombres', attribution: ign }),
    'Photos aériennes IGN': L.tileLayer(wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, maxNativeZoom: 19, attribution: ign }),
    'Topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, maxNativeZoom: 17, subdomains: 'abc', attribution: 'Carte &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), données &copy; contributeurs OpenStreetMap' }),
  };
  const surcouches = { 'Relief ombré': L.tileLayer(wmts('ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW', 'image/png', 'estompage_grayscale'), { maxZoom: 19, maxNativeZoom: 15, opacity: 0.4, attribution: ign }) };
  let choix = params.get('fond') && fonds[params.get('fond')] ? params.get('fond') : 'Sombre';
  try { const c = localStorage.getItem('publique_fond'); if (!params.get('fond') && c && fonds[c]) choix = c; } catch { /* stockage indisponible */ }
  fonds[choix].addTo(carte);
  L.control.layers(fonds, surcouches, { position: 'topright', collapsed: true }).addTo(carte);
  carte.on('baselayerchange', (e) => { try { localStorage.setItem('publique_fond', e.name); } catch { /* idem */ } });
}

// ---- Couverture radio : zone couverte aujourd'hui et emplacements conseillés pour de nouveaux relais --
const couv = { hauteur: 6, dernierPoint: null, couche: null, mode: null, acces: ['voiture', '4x4', 'pied', 'tous'].includes(params.get('acces')) ? params.get('acces') : 'voiture', plan: null, imagePlan: null, siteChoisi: null };
const NOM_ACCES = { voiture: 'accessibles en voiture', '4x4': 'accessibles en 4×4 ou en voiture', pied: 'accessibles à pied, en 4×4 ou en voiture', tous: 'tous les points hauts' };
const pc = (v) => String(v).replace('.', ',');
// Plan : emplacements conseillés selon l'accès choisi ; un clic sur une épingle montre la couverture de ce site seul
async function afficherPlan(g, info) {
  const r = await fetch(avecDep(`/api/relief/plan?objectif=99&max=8&acces=${couv.acces}&realiste=1`)).then((x) => x.json());
  if (r.erreur) throw new Error(r.erreur);
  const e = r.emprise;
  couv.plan = r;
  couv.siteChoisi = null;
  couv.imagePlan = L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.55, pane: 'couverture', className: 'pixelise' }).addTo(g);
  for (const x of r.sites) {
    L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', html: `<div class="epingle"><b>${x.rang}</b></div>`, iconSize: [30, 38], iconAnchor: [15, 36] }), pane: 'traces', zIndexOffset: 900 })
      .bindTooltip(`<b>${x.rang} · ${esc(x.nom || x.commune || 'Point haut')}</b><br>${x.alt} m${x.commune ? ' · ' + esc(x.commune) : ''}<br>+${x.gainKm2} km² · couverture cumulée ${pc(x.totalPct)} %${x.acces ? '<br>' + ({ voiture: '🚗 en voiture', '4x4': '🚙 en 4×4', pied: '🥾 à pied', aucun: 'accès inconnu' }[x.acces.type] || '') : ''}${x.realisme && x.realisme.support ? '<br>🗼 ' + esc(x.realisme.support.type) + ' à proximité' : ''}<br><small>Cliquez pour voir sa couverture</small>`)
      .on('click', () => couvertureSite(x, g, info))
      .addTo(g);
  }
  infoPlan(info);
}
function infoPlan(info) {
  const r = couv.plan;
  info.innerHTML = `<b>Où poser de nouveaux relais ?</b> <select id="choix-acces" title="Accès exigé pour les sites">${Object.entries({ voiture: '🚗 En voiture', '4x4': '🚙 En 4×4', pied: '🥾 À pied', tous: 'Tous les points hauts' }).map(([k, v]) => `<option value="${k}" ${k === couv.acces ? 'selected' : ''}>${v}</option>`).join('')}</select><br>
    ${r.sites.length ? `${r.sites.length} emplacement${r.sites.length > 1 ? 's' : ''} conseillé${r.sites.length > 1 ? 's' : ''} : ${pc(r.departPct)} % → <b>${pc(r.finalPct)} %</b> ${libZone()}` : 'Aucun site utile avec cet accès (élargissez le choix).'}
    <br><small>Bleu : déjà couvert · turquoise : apporté par les nouveaux sites · rouge : non couvert. Points hauts ${NOM_ACCES[couv.acces]}, hors zones protégées. Cliquez sur un numéro pour voir la couverture de ce site.</small>`;
  document.getElementById('choix-acces').onchange = (ev) => { couv.acces = ev.target.value; couv.mode = null; basculerCouverture('sites'); };
}
async function couverturePoint(ll) {
  const info = document.getElementById('info-couv'), g = couv.couche;
  couv.dernierPoint = ll;
  const h = couv.hauteur;
  g.clearLayers();
  L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1, pane: 'traces' }).addTo(g);
  const ligne = (t) => `<b>Couverture d’un point</b> <label><small>antenne</small> <select id="h-point">${[2, 6, 10, 20, 30].map((v) => `<option value="${v}" ${v === h ? 'selected' : ''}>${v} m</option>`).join('')}</select></label><br>${t}`;
  const brancher = () => { const sel = document.getElementById('h-point'); if (sel) sel.onchange = (e) => { couv.hauteur = Number(e.target.value); couverturePoint(couv.dernierPoint); }; };
  info.innerHTML = ligne('<span class="sablier"></span> Calcul…'); brancher();
  let r;
  try { r = await fetch(avecDep(`/api/relief/couverture?lat=${ll.lat.toFixed(5)}&lon=${ll.lng.toFixed(5)}&hs=${h}`)).then((y) => y.json()); } catch (e) { r = { erreur: e.message }; }
  if (couv.mode !== 'point' || couv.dernierPoint !== ll) return;
  if (r.erreur) { info.innerHTML = ligne('Couverture indisponible : ' + esc(r.erreur)); brancher(); return; }
  const e = r.emprise;
  L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.65, pane: 'couverture', className: 'pixelise' }).addTo(g);
  info.innerHTML = ligne(`${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}${r.sol != null ? ' · sol à ' + r.sol + ' m' : ''}<br>Zone couverte : <b>${Math.round(r.surfaceKm2).toLocaleString('fr-FR')} km²</b>${r.pctZone != null ? `, soit <b>${pc(r.pctZone)} %</b> ${libZone()}` : ''}<br><small>Turquoise : bonne liaison · jaune : liaison juste · orange pâle : à la limite. Cliquez ailleurs pour un autre point.</small>`);
  brancher();
}
async function couvertureSite(x, g, info) {
  info.innerHTML = '<span class="sablier"></span> Calcul de la couverture de ce site…';
  const hs = (couv.plan.parametres && couv.plan.parametres.hs) || 6;
  let r;
  try { r = await fetch(avecDep(`/api/relief/couverture?lat=${x.lat}&lon=${x.lon}&hs=${hs}`)).then((y) => y.json()); } catch (e) { r = { erreur: e.message }; }
  if (couv.mode !== 'sites') return;
  if (r.erreur) { info.textContent = 'Couverture indisponible : ' + r.erreur; return; }
  if (couv.siteChoisi) couv.siteChoisi.remove();
  if (couv.imagePlan) couv.imagePlan.remove();
  const e = r.emprise;
  couv.siteChoisi = L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.65, pane: 'couverture', className: 'pixelise' }).addTo(g);
  info.innerHTML = `<b>${x.rang} · ${esc(x.nom || x.commune || 'Point haut')}</b>${x.commune && x.nom ? ' · ' + esc(x.commune) : ''} · ${x.alt} m<br>
    Couverture de ce site seul : <b>${Math.round(r.surfaceKm2).toLocaleString('fr-FR')} km²</b>${r.pctZone != null ? `, soit <b>${pc(r.pctZone)} %</b> ${libZone()}` : ''} · il apporte <b>+${x.gainKm2} km²</b> au réseau actuel
    <br><small>Antenne à ${hs} m du sol, rayon de calcul ${r.rayonKm} km. Turquoise : bonne liaison · jaune : liaison juste · orange pâle : à la limite.</small>
    <div style="margin-top:6px"><button class="bascule" id="retour-plan">↩ Revenir au plan</button></div>`;
  document.getElementById('retour-plan').onclick = () => {
    if (couv.siteChoisi) { couv.siteChoisi.remove(); couv.siteChoisi = null; }
    if (couv.imagePlan) couv.imagePlan.addTo(g);
    infoPlan(info);
  };
}
function installerCouverture() {
  const b = document.getElementById('b-couv'), bp = document.getElementById('b-sites');
  b.onclick = () => basculerCouverture('actuelle');
  bp.onclick = () => basculerCouverture('sites');
  document.getElementById('b-point').onclick = () => basculerCouverture('point');
  // Mode « couverture d'un point » : un clic sur la carte calcule la zone couverte depuis cet endroit
  carte.on('click', (ev) => { if (couv.mode === 'point') couverturePoint(ev.latlng); });
  const demande = params.get('couverture');
  if (demande === '1' || demande === 'actuelle') basculerCouverture('actuelle');
  else if (demande === 'sites') basculerCouverture('sites');
  else if (demande === 'point') basculerCouverture('point');
}
async function basculerCouverture(mode) {
  const info = document.getElementById('info-couv');
  if (couv.couche) { couv.couche.remove(); couv.couche = null; }
  document.getElementById('b-couv').classList.remove('actif');
  document.getElementById('b-sites').classList.remove('actif');
  document.getElementById('b-point').classList.remove('actif');
  document.body.classList.remove('mode-point');
  if (couv.mode === mode) { couv.mode = null; info.hidden = true; return; }
  couv.mode = mode;
  document.getElementById({ actuelle: 'b-couv', sites: 'b-sites', point: 'b-point' }[mode]).classList.add('actif');
  if (mode === 'point') {
    document.body.classList.add('mode-point');
    couv.couche = L.layerGroup().addTo(carte);
    info.hidden = false;
    info.innerHTML = '<b>Couverture d’un point</b><br>Cliquez n’importe où sur la carte : la zone couverte par une antenne placée à cet endroit s’affiche.<br><label><small>Hauteur de l’antenne</small> <select id="h-point">' + [2, 6, 10, 20, 30].map((h) => `<option value="${h}" ${h === couv.hauteur ? 'selected' : ''}>${h} m</option>`).join('') + '</select></label>';
    document.getElementById('h-point').onchange = (e) => { couv.hauteur = Number(e.target.value); if (couv.dernierPoint) couverturePoint(couv.dernierPoint); };
    return;
  }
  info.hidden = false;
  info.innerHTML = '<span class="sablier"></span> Calcul de la couverture…';
  const g = L.layerGroup();
  try {
    if (mode === 'actuelle') {
      const mcSeul = vue === 'meshcore';
      const r = await fetch(avecDep(`/api/relief/couverture-reseau${mcSeul ? '?reseau=meshcore' : ''}`)).then((x) => x.json());
      if (couv.mode !== mode) return;
      if (r.erreur) throw new Error(r.erreur);
      if (r.vide) { info.textContent = 'Aucun relais positionné entendu depuis 24 h.'; return; }
      const e = r.emprise;
      L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.6, pane: 'couverture', className: 'pixelise' }).addTo(g);
      info.innerHTML = `<b>Couverture ${mcSeul ? 'MeshCore' : 'Meshtastic'} estimée</b>${r.pctZone != null ? ` : <b>${String(r.pctZone).replace('.', ',')} %</b> ${libZone()}` : ''} · ${r.noeuds.length} relais et passerelles<br><small>Calcul d’après le relief (IGN) et les antennes connues, corrigé par les mesures réelles du réseau.</small>`;
    } else {
      await afficherPlan(g, info);
      if (couv.mode !== mode) return;
    }
    g.addTo(carte);
    couv.couche = g;
  } catch (e) {
    info.textContent = 'Couverture indisponible : ' + e.message;
  }
}

// Titre : le nom du réseau suit l'onglet (« Réseau Meshtastic » devient « Réseau MeshCore » sur l'onglet MeshCore)
function majTitre() {
  const base = params.get('titre') || config.titre || 'Réseau Meshtastic';
  const nomReseau = vue === 'meshcore' ? 'MeshCore' : vue === 'deux' && config.meshcore ? 'Meshtastic et MeshCore' : 'Meshtastic';
  let titre = base.replace(/Meshtastic(\s*(et|\/|&|\+)\s*MeshCore)?|MeshCore(\s*(et|\/|&|\+)\s*Meshtastic)?/i, nomReseau);
  // Le nom de la zone de la carte (ex. Haute-Loire) suit le secteur choisi
  if (config.zoneNom && zoneSel !== 'dep' && titre.includes(config.zoneNom)) titre = titre.replace(config.zoneNom, nomZone());
  document.getElementById('titre').textContent = titre;
  document.title = titre + ' · carte publique';
}
// « du département » quand la zone est un département, sinon le nom de la zone (région, zone libre)
const libZone = () => (depSel() && depSel().code !== depCarte() ? `du département (${depSel().nom})` : config.departement && config.zoneNom && config.departement.nom && config.zoneNom !== config.departement.nom ? `de la zone ${config.zoneNom}` : 'du département');
function recadrer() {
  const z = bboxZone();
  if (z) carte.fitBounds([[z[0], z[1]], [z[2], z[3]]], { padding: [10, 10] }); else carte.setView([46.6, 2.5], 6);
}
function installerZone() {
  const sel = document.getElementById('choix-zone');
  if (!sel) return;
  const o = (v, t) => `<option value="${v}">${esc(t)}</option>`;
  sel.innerHTML = o('dep', config.zoneNom || 'Département de la carte') + (config.zoneVoisins ? o('v', `${config.zoneNom} + voisins`) : '') + o('france', 'France entière')
    + ((config.regions || []).length ? `<optgroup label="Régions">${config.regions.map((r) => o('r' + r.code, r.nom)).join('')}</optgroup>` : '')
    + (departements.length ? `<optgroup label="Départements">${departements.map((d) => o('d' + d.code, `${d.code} · ${d.nom}`)).join('')}</optgroup>` : '');
  sel.value = zoneSel;
  sel.onchange = () => {
    zoneSel = sel.value;
    try { localStorage.setItem('publique_zone', zoneSel); } catch { /* indisponible */ }
    if (couv.mode) { const m = couv.mode; couv.mode = null; if (m === 'point' ? pointPossible() : couvPossible()) basculerCouverture(m); else { if (couv.couche) { couv.couche.remove(); couv.couche = null; } ['b-couv', 'b-sites', 'b-point'].forEach((id) => document.getElementById(id).classList.remove('actif')); document.body.classList.remove('mode-point'); document.getElementById('info-couv').hidden = true; } }
    majBoutonsCouv();
    majTitre();
    recadrer();
    dessinerMt();
    rafraichirMc();
  };
  majBoutonsCouv();
}
function majBoutonsCouv() {
  const ok = couvPossible();
  for (const id of ['b-couv', 'b-sites', 'b-point']) {
    const b = document.getElementById(id);
    if (b.dataset.titre == null) b.dataset.titre = b.title;
    const possible = id === 'b-point' ? pointPossible() : ok;
    b.disabled = !possible;
    b.title = possible ? b.dataset.titre : franceOuverte() ? 'Choisissez un département pour ce calcul' : `Calculs de couverture disponibles sur ${config.zoneNom || 'le département de la carte'}`;
  }
  const n = document.getElementById('note-couv');
  if (n) { n.hidden = ok; n.textContent = franceOuverte() ? 'Couverture et emplacements de relais : choisissez un département (la couverture d’un point marche partout).' : `Couverture et emplacements de relais : sur ${config.zoneNom || 'le département de la carte'} seulement.`; }
}

function changerVue(v, sansCharger) {
  vue = v;
  majTitre();
  document.body.className = 'vue-' + v;
  document.querySelectorAll('#reseaux [data-vue]').forEach((b) => b.classList.toggle('actif', b.dataset.vue === v));
  if (!sansCharger) { dessinerMt(); dessinerMc(); }
}

// ---- Signalements en cours (route inondée, arbre…) : lecture seule ---------------------------------
let coucheSig = null;
async function rafraichirSignalements() {
  let l;
  try { l = await fetch('/api/signalements/publics').then((r) => r.json()); } catch { return; }
  if (!Array.isArray(l)) return;
  if (!coucheSig) coucheSig = L.layerGroup().addTo(carte);
  coucheSig.clearLayers();
  const e = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  for (const s of l) {
    if (s.trace && s.trace.length > 1) (s.forme === 'zone' ? L.polygon(s.trace, { color: '#dc2626', weight: 3, fillOpacity: 0.18 }) : L.polyline(s.trace, { color: '#dc2626', weight: 6, opacity: 0.85 })).addTo(coucheSig);
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'sig-marqueur', html: `<span>${e(s.icone)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] }), title: s.titre, zIndexOffset: 900 })
      .bindPopup(`<b>${e(s.icone)} ${e(s.titre)}</b>${s.details ? '<br>' + e(s.details) : ''}<br><small>signalé le ${new Date(s.cree).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>`).addTo(coucheSig);
  }
}

// ---- Meshtastic ----------------------------------------------------------------------------------
let mtNoeuds = [], mtLiens = [];
async function rafraichirMt() {
  try {
    [mtNoeuds, mtLiens] = await Promise.all([fetch('/api/noeuds').then((r) => r.json()), opt.liens ? fetch('/api/liens?heures=24').then((r) => r.json()) : []]);
  } catch { return; }
  // Pour les animations : tous les nœuds positionnés (positions publiques, approchées pour les particuliers) et liaisons
  etat.noeuds = new Map(mtNoeuds.filter((n) => n.lat != null).map((n) => [n.num, n]));
  etat.liens = mtLiens;
  dessinerMt();
}
function dessinerMt() {
  couche.clearLayers();
  etat.marqueurs = new Map();
  const vis = mtNoeuds.filter((n) => n.lat != null && zoneLarge(n) && n.statut !== 'inactif');
  let relais = 0, gw = 0;
  for (const n of vis) { if (n.infrastructure) relais++; if (n.passerelle) gw++; }
  document.getElementById('n-relais').textContent = relais;
  document.getElementById('n-gw').textContent = gw;
  document.getElementById('n-actifs').textContent = vis.filter((n) => n.statut === 'actif').length;
  if (!voitMt()) return;
  const pos = new Map(vis.map((n) => [n.num, n]));
  for (const l of mtLiens) {
    const a = pos.get(l.a), b = pos.get(l.b);
    if (!a || !b || !(a.infrastructure || a.passerelle) || !(b.infrastructure || b.passerelle)) continue;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { pane: 'liens', color: couleurSnr(l.snr), weight: 2, opacity: 0.7, dashArray: l.source === 'rf' ? null : '5 5' }).addTo(couche);
  }
  for (const n of vis) {
    const infra = n.infrastructure || n.passerelle;
    if (!infra && !opt.clients) continue;
    const icon = L.divIcon({ className: '', html: `<div class="mk ${infra ? (n.passerelle ? 'gw' : '') : 'cl'} ${n.statut}"><div class="c"></div></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    const m = L.marker([n.lat, n.lon], { icon, zIndexOffset: infra ? 500 : 0 }).bindTooltip(`<b>${esc(n.nomLong || n.id)}</b> <small>Meshtastic</small><br>${esc(n.roleFr || n.role || '')}${n.passerelle ? ' · passerelle MQTT' : ''}<br><small>vu ${n.dernierVu ? new Date(n.dernierVu).toLocaleString('fr-FR') : '–'}</small>`).addTo(couche);
    etat.marqueurs.set(n.num, m);
  }
}
function animerMt(p) {
  if (!voitMt() || !etat.couches.animations) return;
  const gw = etat.noeuds.get(p.passerelle), src = etat.noeuds.get(p.de);
  if (!gw || gw.lat == null || (!zoneLarge(gw) && !(src && zoneLarge(src)))) return;
  const couleur = COULEUR_PORT[p.port] || '#c9a7eb';
  flasher(p.de);
  if (typeof animerPaquetMt === 'function') animerPaquetMt(p, couleur);
  onde(gw, couleur);
}

// ---- MeshCore ------------------------------------------------------------------------------------
let mcLiens = [];
async function rafraichirMc() {
  try {
    const [n, l] = await Promise.all([fetch('/api/mc/noeuds').then((r) => r.json()), opt.liens ? fetch('/api/mc/liens?heures=24').then((r) => r.json()) : []]);
    mcp.noeuds = new Map(n.filter((x) => x.lat != null && zoneLarge(x)).map((x) => [x.cle, x]));
    mcLiens = l;
  } catch { return; }
  dessinerMc();
}
function dessinerMc() {
  mcp.coucheNoeuds.clearLayers(); mcp.coucheLiens.clearLayers();
  mcp.marqueurs = new Map();
  const vis = [...mcp.noeuds.values()].filter((n) => n.statut !== 'inactif');
  document.getElementById('n-mc-rep').textContent = vis.filter((n) => ROLES_MC_RELAIS.has(n.role)).length;
  document.getElementById('n-mc-actifs').textContent = vis.filter((n) => n.statut === 'actif').length;
  if (!voitMc()) return;
  // Liaisons mesurées entre répéteurs (les plus observées d'abord)
  const fusion = new Map();
  for (const l of mcLiens) {
    if (l.source === 'chemin') continue;
    const a = mcp.noeuds.get(l.a), b = mcp.noeuds.get(l.b);
    if (!a || !b || !ROLES_MC_RELAIS.has(a.role) || !ROLES_MC_RELAIS.has(b.role)) continue;
    const d = distanceKm(a, b);
    if (d != null && d > 150) continue;
    const k = l.a < l.b ? l.a + l.b : l.b + l.a;
    const f = fusion.get(k);
    if (!f) fusion.set(k, { a, b, snr: l.snr, nb: l.nb });
    else { f.nb += l.nb; if (l.snr != null && (f.snr == null || l.snr > f.snr)) f.snr = l.snr; }
  }
  for (const f of [...fusion.values()].sort((x, y) => y.nb - x.nb).slice(0, 300)) {
    L.polyline([[f.a.lat, f.a.lon], [f.b.lat, f.b.lon]], { pane: 'liens', color: couleurSnr(f.snr), weight: 2, opacity: 0.6, dashArray: '2 4' }).addTo(mcp.coucheLiens);
  }
  for (const n of vis) {
    const relais = ROLES_MC_RELAIS.has(n.role);
    if (!relais && !opt.clients) continue;
    const cls = n.role === 'salon' ? 'salon' : relais ? '' : 'autre';
    const m = L.marker([n.lat, n.lon], { icon: L.divIcon({ className: '', html: `<div class="mkc ${cls}"><div class="c"></div></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: relais ? 450 : 0 })
      .bindTooltip(`<b>${esc(n.nom || n.id)}</b> <small>MeshCore</small><br>${esc(n.roleFr || n.role || '')}<br><small>vu ${n.dernierVu ? new Date(n.dernierVu).toLocaleString('fr-FR') : '–'}</small>`).addTo(mcp.coucheNoeuds);
    mcp.marqueurs.set(n.cle, m);
  }
}
// Trajet : origine (si connue) → répéteurs identifiés → observateur
function animerMc(p) {
  if (!voitMc() || !etat.couches.animations || typeof animerTrajet !== 'function') return;
  const pt = (cle) => { const n = cle && mcp.noeuds.get(cle); return n && n.lat != null ? { lat: n.lat, lon: n.lon, cle } : null; };
  const cles = [];
  if (p.chemin && p.chemin.length && p.cheminResolu) { if (p.de) cles.push(p.de); cles.push(...p.cheminResolu); }
  else if (p.sauts === 0 && p.de) cles.push(p.de);
  cles.push(p.observateur);
  const pts = cles.map(pt), connus = pts.filter(Boolean);
  if (!connus.length) return;
  const coul = COULEUR_MC[p.type] || '#fdba74';
  eclair(mcp.marqueurs.get(connus[0].cle), '.mkc');
  if (connus.length >= 2) animerTrajet(connus, { couleur: coul, estime: pts.some((x) => !x), auFil: (i) => eclair(mcp.marqueurs.get(connus[i].cle), '.mkc') });
  onde(connus[connus.length - 1], coul);
}

// ---- Direct (WebSocket public : sans texte, positions des particuliers arrondies) ----------------
function connecterWs() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const temoin = document.getElementById('temoin');
  ws.onopen = () => (temoin.className = 'direct ok');
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.genre === 'paquet') {
      const n = etat.noeuds.get(m.de);
      if (n) n.dernierVu = m.heure || Date.now();
      animerMt(m);
    } else if (m.genre === 'mc-paquet') animerMc(m);
  };
  ws.onclose = () => { temoin.className = 'direct'; setTimeout(connecterWs, 5000); };
}

demarrer().catch((e) => { document.getElementById('sous').textContent = 'Carte indisponible : ' + e.message; });
