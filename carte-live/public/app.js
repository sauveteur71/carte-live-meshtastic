/* Carte live Meshtastic — interface */
'use strict';

const PORTS = {
  position: { nom: 'Position', couleur: 'var(--p-position)', hex: '#4cc9f0' },
  telemetrie: { nom: 'Télémétrie', couleur: 'var(--p-telemetrie)', hex: '#80ed99' },
  texte: { nom: 'Texte', couleur: 'var(--p-texte)', hex: '#f72585' },
  nodeinfo: { nom: 'Infos nœud', couleur: 'var(--p-nodeinfo)', hex: '#b8b8ff' },
  routage: { nom: 'Routage / ACK', couleur: 'var(--p-routage)', hex: '#8d99ae' },
  traceroute: { nom: 'Traceroute', couleur: 'var(--p-traceroute)', hex: '#ffd166' },
  voisinage: { nom: 'Voisinage', couleur: 'var(--p-voisinage)', hex: '#06d6a0' },
  mapreport: { nom: 'Rapport carte', couleur: 'var(--p-mapreport)', hex: '#a0c4ff' },
  chiffre: { nom: 'Chiffré', couleur: 'var(--p-chiffre)', hex: '#6c757d' },
  autre: { nom: 'Autre', couleur: 'var(--p-autre)', hex: '#c9a7eb' },
};
const portInfo = (p) => PORTS[p] || PORTS.autre;

// Qualité de liaison LoRa selon le SNR (LongFast démodule jusqu'à ≈ -17,5 dB)
const SNR = [
  { min: 5, nom: 'Excellent', hex: '#3ee6c4' },
  { min: 0, nom: 'Bon', hex: '#9be36b' },
  { min: -7, nom: 'Correct', hex: '#f4d35e' },
  { min: -13, nom: 'Faible', hex: '#f39a4a' },
  { min: -Infinity, nom: 'Limite', hex: '#ff5c6c' },
];
const couleurSnr = (snr) => (snr == null ? '#7d8fa3' : SNR.find((s) => snr >= s.min).hex);

const etat = {
  config: null,
  admin: false,
  noeuds: new Map(),
  marqueurs: new Map(),
  liens: [],
  coucheLiens: null,
  alertes: [],
  stats: null,
  couches: { rf: true, voisinage: true, traceroute: true, inactifs: false, animations: true, sommets: true, federation: true, releves: true },
  filtresPorts: new Set(Object.keys(PORTS)),
  selection: null,
  trajet: null,
  // Secteur : 'dep' (département configuré), 'voisins' (département + limitrophes) ou 'france'
  zoneMode: (() => { try { const v = localStorage.getItem('gaulix_zone'); return v === 'france' || v === 'voisins' ? v : 'dep'; } catch { return 'dep'; } })(),
  zone: (() => { try { return localStorage.getItem('gaulix_zone') !== 'france'; } catch { return true; } })(),
  radio: null,
  modeProfil: null,
  coucheCouverture: null,
  rejeu: null,
  sommets: [],
  coucheSommets: null,
  classement: null,
  modeCarte: null,
  coucheCouvrir: null,
};

// ---- Utilitaires -----------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, d = 1, u = '') => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d).replace('.', ',') + u);
const idHex = (num) => '!' + (num >>> 0).toString(16).padStart(8, '0');
const nomNoeud = (num) => {
  const n = etat.noeuds.get(num);
  return n ? n.nomLong || n.nomCourt || n.id : idHex(num);
};
const nomCourt = (num) => {
  const n = etat.noeuds.get(num);
  return n ? n.nomCourt || (n.nomLong || n.id).slice(0, 6) : idHex(num).slice(-4);
};
function ilYa(t) {
  if (!t) return 'jamais';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
const heure = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function duree(sec) {
  if (sec == null) return '–';
  const j = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return j ? `${j} j ${h} h` : `${h} h ${Math.floor((sec % 3600) / 60)} min`;
}
async function api(url, opts) {
  // Relief, sites, plan : département étudié (peut différer de celui de la carte)
  if (etat.depEtude && url.startsWith('/api/relief') && !/[?&]dep=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'dep=' + etat.depEtude;
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw Object.assign(new Error(d.erreur || r.statusText), { statut: r.status, donnees: d }); }
  return r.json();
}
// ---- Coordonnées GPS -----------------------------------------------------------
function dms(v, pos, neg) {
  const a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), sec = (mf - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${sec.toFixed(1).padStart(4, '0').replace('.', ',')}″${v >= 0 ? pos : neg}`;
}
function blocCoords(lat, lon, opts = {}) {
  if (lat == null || lon == null) return '';
  const dec = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const sexa = `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'O')}`;
  return `<div class="coords">
    <div class="coords-l"><span>GPS</span><b class="mono">${dec}</b><button class="mini" data-copier="${dec}" title="Copier les coordonnées décimales">Copier</button></div>
    <div class="coords-l"><span>DMS</span><b class="mono">${sexa}</b><button class="mini" data-copier="${sexa}" title="Copier en degrés, minutes, secondes">Copier</button></div>
    <div class="coords-l liens-carto">${opts.alt != null ? `<span>Alt.</span><b>${Math.round(opts.alt)} m</b>` : ''}
      <a href="https://www.geoportail.gouv.fr/carte?c=${lon.toFixed(5)},${lat.toFixed(5)}&z=16&l0=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2::GEOPORTAIL:OGC:WMTS(1)&permalink=yes" target="_blank" rel="noopener">Géoportail</a>
      <a href="https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}" target="_blank" rel="noopener">Google Maps</a>
      <a href="geo:${lat.toFixed(6)},${lon.toFixed(6)}">GPS du téléphone</a></div>
    ${opts.approx ? '<div class="note">Position publique arrondie (≈ 100 m) : connectez-vous pour la position exacte.</div>' : ''}
  </div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copier]');
  if (!b) return;
  e.stopPropagation();
  const t = b.dataset.copier;
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  const ancien = b.textContent; b.textContent = 'Copié ✓'; setTimeout(() => (b.textContent = ancien), 1200);
}, true);

// Fichier GPX (points de passage) pour un GPS ou une appli de randonnée
function telechargerGpx(nomFichier, points) {
  const x = (t) => String(t ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const wpt = points.map((p) => `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.alt != null ? `<ele>${Math.round(p.alt)}</ele>` : ''}<name>${x(p.nom)}</name>${p.desc ? `<desc>${x(p.desc)}</desc>` : ''}</wpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Carte live Meshtastic" xmlns="http://www.topografix.com/GPX/1/1">\n${wpt}\n</gpx>\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = nomFichier;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const numAlerte = () => new Set(etat.alertes.map((a) => a.num));

// ---- Carte -----------------------------------------------------------------
let carte;
function initCarte() {
  carte = L.map('carte', { zoomControl: false, preferCanvas: false, worldCopyJump: true }).setView(etat.config.centre, etat.config.zoom);
  L.control.zoom({ position: 'bottomleft' }).addTo(carte);
  const t = etat.config.tuiles;
  const wmts = (couche, format = 'image/png', style = 'normal') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${couche}&STYLE=${style}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
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
  const surcouches = {
    'Relief ombré': L.tileLayer(wmts('ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW', 'image/png', 'estompage_grayscale'), { maxZoom: 19, maxNativeZoom: 15, opacity: 0.4, attribution: ign }),
    'Noms des lieux': L.tileLayer(wmts('GEOGRAPHICALNAMES.NAMES'), { maxZoom: 19, maxNativeZoom: 18, className: 'noms-ign', attribution: ign }),
    'Points de repère': L.layerGroup(),
  };
  // Repères remarquables (Vierge du Puy, Mézenc…) avec leur nom toujours affiché
  api('/api/reperes').then((liste) => {
    for (const r of liste) {
      L.marker([r.lat, r.lon], { icon: L.divIcon({ className: 'repere', html: `<i></i><span>${esc(r.nom)}</span>`, iconSize: [10, 10], iconAnchor: [5, 5] }), pane: 'sommets' })
        .on('click', () => placerLieu({ ...r, zoom: 15 }))
        .addTo(surcouches['Points de repère']);
    }
  }).catch(() => {});
  let surcouchesMemo = null;
  try { surcouchesMemo = JSON.parse(localStorage.getItem('gaulix_surcouches') || 'null'); } catch { /* idem */ }
  if (!surcouchesMemo) surcouches['Points de repère'].addTo(carte);
  let choix = 'Sombre';
  try { const c = localStorage.getItem('gaulix_fond'); if (c && fonds[c]) choix = c; } catch { /* stockage indisponible */ }
  fonds[choix].addTo(carte);
  // Fond sombre : les surcouches de texte (noms IGN) passent en clair pour rester lisibles
  const majFondSombre = () => document.body.classList.toggle('fond-sombre', /sombre/i.test(choix));
  majFondSombre();
  for (const n of surcouchesMemo || []) if (surcouches[n]) surcouches[n].addTo(carte);
  carte.attributionControl.addAttribution('Meshtastic® est une marque de Meshtastic LLC');
  // Choix du fond et des surcouches dans le menu « Couches »
  const menu = document.querySelector('.menu-couches .menu');
  menu.insertAdjacentHTML('afterbegin', `<div class="titre-menu">Fond de carte</div>${Object.keys(fonds).map((n) => `<button data-fond="${n}" class="${n === choix ? 'actif' : ''}">${n}</button>`).join('')}
    <div class="titre-menu">Repères</div>${Object.keys(surcouches).map((n) => `<button data-surcouche="${n}" class="${carte.hasLayer(surcouches[n]) ? 'actif' : ''}">${n}</button>`).join('')}
    <div class="titre-menu">Réseau</div>`);
  menu.querySelectorAll('[data-fond]').forEach((b) => (b.onclick = () => {
    fonds[choix].remove(); choix = b.dataset.fond; fonds[choix].addTo(carte); majFondSombre();
    menu.querySelectorAll('[data-fond]').forEach((x) => x.classList.toggle('actif', x === b));
    try { localStorage.setItem('gaulix_fond', choix); } catch { /* idem */ }
  }));
  menu.querySelectorAll('[data-surcouche]').forEach((b) => (b.onclick = () => {
    const c = surcouches[b.dataset.surcouche];
    if (carte.hasLayer(c)) c.remove(); else c.addTo(carte);
    b.classList.toggle('actif', carte.hasLayer(c));
    try { localStorage.setItem('gaulix_surcouches', JSON.stringify(Object.keys(surcouches).filter((n) => carte.hasLayer(surcouches[n])))); } catch { /* idem */ }
  }));
  carte.createPane('liens').style.zIndex = 410;
  carte.createPane('traces').style.zIndex = 420;
  carte.createPane('couverture').style.zIndex = 405;
  carte.createPane('sommets').style.zIndex = 450;
  etat.coucheLiens = L.layerGroup().addTo(carte);
  carte.on('zoomend', () => document.body.classList.toggle('zoom-proche', carte.getZoom() >= 11));
  document.body.classList.toggle('zoom-proche', carte.getZoom() >= 11);
}

// Vue « Haute-Loire » : rectangle de la zone, ou nom commençant par 43 pour les nœuds sans position
function dansZone(n) {
  if (!etat.zone || !n) return true;
  const z = etat.config.zone;
  if (n.lat != null && n.lon != null) return n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3];
  if (etat.radio && n.num === etat.radio.noeudLocal) return true;
  return /^43/.test(n.nomLong || n.nomCourt || '');
}
const dansZoneNum = (num) => { const n = etat.noeuds.get(num); return n ? dansZone(n) : !etat.zone; };

// ---- Catégories de nœuds (légende interactive, façon MeshCore) ----------------------------------
const CATEGORIES = [
  { cle: 'relais', nom: 'Relais / routeurs', couleur: '#3b82f6', roles: ['ROUTER', 'ROUTER_LATE', 'REPEATER', 'ROUTER_CLIENT'] },
  { cle: 'client', nom: 'Clients', couleur: '#a855f7', roles: ['CLIENT', 'CLIENT_BASE'] },
  { cle: 'discret', nom: 'Clients muets / cachés', couleur: '#ec4899', roles: ['CLIENT_MUTE', 'CLIENT_HIDDEN'] },
  { cle: 'traceur', nom: 'Traceurs / capteurs', couleur: '#f59e0b', roles: ['TRACKER', 'TAK', 'TAK_TRACKER', 'SENSOR', 'LOST_AND_FOUND'] },
  { cle: 'inconnu', nom: 'Inconnus', couleur: '#9ca3af', roles: [] },
];
const categorie = (n) => CATEGORIES.find((c) => c.roles.includes(n.role)) || CATEGORIES[CATEGORIES.length - 1];
const passerelleEnLigne = (n) => n.passerelle && n.etatPasserelle !== 'offline' && Date.now() - (n.dernierVuPasserelle || 0) < 5 * 60000;
etat.legende = (() => {
  const defaut = { cat: Object.fromEntries(CATEGORIES.map((c) => [c.cle, true])), seulMqtt: false, chaleur: true, alertes: true };
  try { return { ...defaut, ...JSON.parse(localStorage.getItem('gaulix_legende') || '{}') }; } catch { return defaut; }
})();
const memoLegende = () => { try { localStorage.setItem('gaulix_legende', JSON.stringify(etat.legende)); } catch { /* stockage indisponible */ } };

function visible(n) {
  if (etat.vueReseau === 'meshcore') return false;
  const lg = etat.legende;
  if (n.lat != null && !lg.cat[categorie(n).cle]) return false;
  if (lg.seulMqtt && !passerelleEnLigne(n)) return false;
  if (n.lat == null || n.lon == null) return false;
  if (!dansZone(n)) return false;
  return etat.couches.inactifs || n.statut !== 'inactif' || n.infrastructure || n.passerelle;
}

function iconeNoeud(n, alerte) {
  const classes = ['mk', n.statut];
  if (n.infrastructure) classes.push('infra');
  if (n.passerelle) classes.push(passerelleEnLigne(n) ? 'passerelle' : 'passerelle-hs');
  if (alerte && etat.legende.alertes) classes.push('alerte');
  const coul = categorie(n).couleur;
  const montrerNom = n.infrastructure || n.passerelle || carte.getZoom() >= 11;
  return L.divIcon({
    className: '',
    html: `<div class="${classes.join(' ')}" style="--cat:${coul}"><div class="c"></div>${montrerNom ? `<div class="lbl">${esc(n.nomCourt || n.id.slice(-4))}</div>` : ''}</div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function dessinerNoeuds() {
  const alertes = numAlerte();
  for (const [num, m] of etat.marqueurs) {
    const n = etat.noeuds.get(num);
    if (!n || !visible(n)) { m.remove(); etat.marqueurs.delete(num); }
  }
  for (const n of etat.noeuds.values()) {
    if (!visible(n)) continue;
    let m = etat.marqueurs.get(n.num);
    const icone = iconeNoeud(n, alertes.has(n.num));
    if (!m) {
      m = L.marker([n.lat, n.lon], { icon: icone, riseOnHover: true, zIndexOffset: n.infrastructure ? 500 : 0 });
      m.on('click', () => {
        if (etat.modeProfil) { choisirPointProfil({ lat: n.lat, lon: n.lon, nom: n.nomLong || n.nomCourt || n.id, num: n.num, h: n.infrastructure ? 6 : 3 }); return; }
        ouvrirFiche(n.num);
      });
      m.bindTooltip('', { className: 'info', direction: 'top', offset: [0, -8] });
      m.addTo(carte);
      etat.marqueurs.set(n.num, m);
    } else {
      m.setLatLng([n.lat, n.lon]);
      m.setIcon(icone);
    }
    m.setTooltipContent(
      `<b>${esc(n.nomLong || n.id)}</b><br>${esc(n.roleFr)} · ${ilYa(n.dernierVu)}` +
        (n.tension ? `<br>${fmt(n.tension, 2, ' V')}` : '') +
        (n.canal != null ? ` · canal ${fmt(n.canal, 1, ' %')}` : '')
    );
  }
}

function dessinerLiens() {
  etat.coucheLiens.clearLayers();
  if (etat.vueReseau === 'meshcore') return;
  const maintenant = Date.now();
  const fenetre = Number($('#fenetre').value) * 3600000;
  // Fusion des liens a<->b par source : on garde le plus récent et le meilleur SNR
  const fusion = new Map();
  for (const l of etat.liens) {
    if (!etat.couches[l.source]) continue;
    const noeudA = etat.noeuds.get(l.a), noeudB = etat.noeuds.get(l.b);
    if (!noeudA || !noeudB || noeudA.lat == null || noeudB.lat == null) continue;
    if (etat.zone && !dansZone(noeudA) && !dansZone(noeudB)) continue;
    if (distanceKm(noeudA, noeudB) > (etat.config.lienDistanceMaxKm || 120)) continue;
    const cle = [Math.min(l.a, l.b), Math.max(l.a, l.b), l.source].join(':');
    const f = fusion.get(cle);
    if (!f) fusion.set(cle, { ...l, noeudA, noeudB });
    else {
      f.nb += l.nb;
      f.dernierVu = Math.max(f.dernierVu, l.dernierVu);
      if (l.snr != null && (f.snr == null || l.snr > f.snr)) f.snr = l.snr;
    }
  }
  for (const l of fusion.values()) {
    const age = (maintenant - l.dernierVu) / fenetre;
    const opacite = Math.max(0.18, 0.85 - age * 0.7);
    const style = {
      pane: 'liens',
      color: couleurSnr(l.snr),
      weight: Math.min(1 + Math.log2(1 + l.nb) * 0.6, 4),
      opacity: opacite,
      dashArray: l.source === 'voisinage' ? '6 5' : l.source === 'traceroute' ? '2 5' : null,
    };
    const ligne = L.polyline([[l.noeudA.lat, l.noeudA.lon], [l.noeudB.lat, l.noeudB.lon]], style);
    const dist = distanceKm(l.noeudA, l.noeudB);
    ligne.bindTooltip(
      `<b>${esc(nomNoeud(l.a))} ↔ ${esc(nomNoeud(l.b))}</b><br>` +
        `${{ rf: 'Liaison radio directe', voisinage: 'Voisinage déclaré', traceroute: 'Traceroute' }[l.source]}` +
        `<br>SNR ${fmt(l.snr, 1, ' dB')}${l.rssi != null ? ' · RSSI ' + fmt(l.rssi, 0, ' dBm') : ''}` +
        `<br>${l.nb} observation${l.nb > 1 ? 's' : ''} · ${dist != null ? fmt(dist, 1, ' km') : ''} · ${ilYa(l.dernierVu)}`,
      { className: 'info', sticky: true }
    );
    ligne.addTo(etat.coucheLiens);
  }
}

function distanceKm(a, b) {
  if (a.lat == null || b.lat == null) return null;
  const R = 6371, r = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Animation d'un paquet reçu : trace de l'émetteur (ou du relais) vers la passerelle
function animerPaquet(p, depuisRejeu) {
  if (!etat.couches.animations || !etat.filtresPorts.has(p.port) || etat.vueReseau === 'meshcore') return;
  if (etat.rejeu && etat.rejeu.actif && !depuisRejeu) return;
  if (etat.zone && !dansZoneNum(p.passerelle) && !dansZoneNum(p.de)) return;
  flasher(p.de);
  const gw = etat.noeuds.get(p.passerelle);
  if (!gw || gw.lat == null) return;
  const couleur = portInfo(p.port).hex;
  // Comète émetteur → relais → passerelle (une par passerelle qui a entendu le paquet : effet d'éventail)
  if (typeof animerPaquetMt === 'function') animerPaquetMt(p, couleur);
  const onde = L.marker([gw.lat, gw.lon], {
    icon: L.divIcon({ className: '', html: `<div class="onde" style="border-color:${couleur}"></div>`, iconSize: [10, 10], iconAnchor: [5, 5] }),
    interactive: false, pane: 'traces',
  }).addTo(carte);
  setTimeout(() => onde.remove(), 1500);
}
function flasher(num) {
  const m = etat.marqueurs.get(num);
  const el = m && m.getElement() && m.getElement().querySelector('.mk');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// Version installée, et la dernière publiée sur GitHub si elle est plus récente
function afficherVersion(v) {
  const el = $('#version');
  if (!el || !v || !v.version) return;
  el.hidden = false;
  el.href = v.url;
  el.classList.toggle('maj', !!v.majDisponible);
  el.textContent = v.majDisponible ? `v${v.version} · v${v.derniere} disponible` : `v${v.version}${v.derniere ? ' · à jour' : ''}`;
  el.title = v.majDisponible ? `Nouvelle version v${v.derniere} publiée sur GitHub : cliquez pour voir les nouveautés. Mise à jour : docker compose pull && docker compose up -d` : v.derniere ? `Version installée v${v.version} — c'est la dernière publiée sur GitHub` : `Version installée v${v.version}`;
}
function resumeAlertes(a) {
  const c = a.filter((x) => x.niveau === 'critique').length, w = a.length - c;
  return a.length ? [c ? `${c} critique${c > 1 ? 's' : ''}` : '', w ? `${w} attention` : ''].filter(Boolean).join(' · ') : 'aucune';
}
// Menus dépliants des alertes : fermés par défaut, état retenu dans ce navigateur
document.querySelectorAll('details.pli-alertes').forEach((d) => {
  try { d.open = localStorage.getItem('pli-' + d.dataset.pli) === '1'; } catch { /* stockage indisponible */ }
  d.addEventListener('toggle', () => { try { localStorage.setItem('pli-' + d.dataset.pli, d.open ? '1' : '0'); } catch { /* ignoré */ } });
});

// ---- Santé de la carte (processeur, mémoire, réactivité, disque, base, MQTT) ---------------------------
async function chargerSanteCarte() {
  if (!etat.membre) return;
  let r;
  try { r = await api('/api/sante-carte'); } catch { return; }
  $('#bloc-sante').hidden = false;
  const e = r.dernier || {};
  const p = $('#nb-sante');
  p.textContent = r.alertes.length || '✓';
  p.className = 'pastille' + (r.niveau === 'critique' ? ' critique' : r.niveau === 'attention' ? ' attention' : ' ok');
  $('#resume-sante').textContent = r.alertes.length ? r.alertes[0].message.slice(0, 40) + (r.alertes[0].message.length > 40 ? '…' : '') : `processeur ${fmt(e.cpuPct, 0, ' %')} · ${e.memMo ?? '–'} Mo`;
  const m = (l, v, alerte) => `<div class="mesure"><span>${l}</span><b${alerte ? ' style="color:var(--attention)"' : ''}>${v}</b></div>`;
  const dureeDepuis = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' j'; };
  $('#sante-carte').innerHTML = `
    ${r.alertes.map((a) => `<div class="liste-alertes"><div class="alerte ${a.niveau}">${esc(a.message)}</div></div>`).join('')}
    <div class="grille">
      ${m('Processeur', fmt(e.cpuPct, 0, ' %'), e.cpuPct > 80)}
      ${m('Mémoire', `${e.memMo ?? '–'}${r.limiteMemMo ? ' / ' + r.limiteMemMo : ''} Mo`, r.limiteMemMo && e.memMo > r.limiteMemMo * 0.85)}
      ${m('Réactivité (pire)', e.latenceP99 != null ? e.latenceP99 + ' ms' : '–', e.latenceP99 > 500)}
      ${m('Messages MQTT', (e.mqttParMinute ?? '–') + ' / min')}
      ${m('Base de données', r.base ? `${r.base.totalMo} Mo` : '–', r.base && r.base.totalMo > 2048)}
      ${m('Disque libre', r.disque ? `${r.disque.libreGo} Go` : '–', r.disque && r.disque.libreGo / r.disque.totalGo < 0.1)}
      ${m('Navigateurs connectés', r.clients ?? '–')}
      ${m('En marche depuis', dureeDepuis(r.demarrage))}
      ${m('Version', esc(r.version))}
    </div>
    ${courbe(r.historique, 'latenceP99', 'Réactivité (retard maximal par minute)', ' ms', 0, 500) || ''}
    ${courbe(r.historique, 'cpuPct', 'Processeur', ' %', 0) || ''}
    ${courbe(r.historique, 'memMo', 'Mémoire', ' Mo', 0, r.limiteMemMo ? Math.round(r.limiteMemMo * 0.85) : null) || ''}
    <p class="note">MQTT ${r.mqtt.connecte ? 'connecté' : '<b>déconnecté</b>'}${r.mqtt.reconnexions ? ` · ${r.mqtt.reconnexions} reconnexion(s)` : ''}${r.mqtt.horsPerimetreMc ? ` · ${r.mqtt.horsPerimetreMc} paquets MeshCore hors périmètre ignorés` : ''}${r.base && r.base.walMo ? ` · journal de la base ${r.base.walMo} Mo` : ''}. Courbes : 3 dernières heures, un point par minute.</p>`;
}

// ---- Chemins mesurés (traceroutes automatiques) -----------------------------------------------------
async function chargerChemins() {
  let r;
  try { r = await api('/api/traceroutes/synthese'); } catch { return; }
  etat.chemins = r;
  const z = $('#chemins');
  if (!z) return;
  const changees = r.cibles.filter((c) => c.routeChangee).length, echecs = r.cibles.filter((c) => c.dernier.statut !== 'repondu' && c.dernier.statut !== 'envoye').length;
  $('#resume-chemins').textContent = r.cibles.length ? `${r.cibles.length} nœud${r.cibles.length > 1 ? 's' : ''}${changees ? ` · ${changees} route${changees > 1 ? 's' : ''} changée${changees > 1 ? 's' : ''}` : ''}${echecs ? ` · ${echecs} sans réponse` : ''}` : 'aucun';
  const st = { repondu: ['✔', 'var(--ok)'], echec: ['✖', 'var(--critique)'], sans_reponse: ['✖', 'var(--critique)'], envoye: ['…', 'var(--attention)'] };
  const resume = (c) => {
    if (!c.mesure) return 'jamais de réponse';
    const relais = c.mesure.aller.slice(1, -1);
    return relais.length ? `via ${relais.map((x) => esc(x.nom)).join(' → ')} (${relais.length} saut${relais.length > 1 ? 's' : ''})` : 'en direct';
  };
  z.innerHTML = (etat.admin ? `<div class="reglages-tr">
      <label>Quand <select id="tr-heures"><option value="toujours">à toute heure</option><option value="nuit">la nuit (1 h – 6 h)</option></select></label>
      <label>Tous les <select id="tr-intervalle">${[[60, '1 h'], [180, '3 h'], [360, '6 h'], [720, '12 h'], [1440, '24 h'], [0, 'jamais']].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
    </div><p class="note">★ = nœud clé : s’il y en a, seuls les nœuds clés sont tracés automatiquement ; sinon, tous les relais entendus par le module.${r.radio ? '' : ' <b>Aucun module radio connecté : pas de traceroute automatique.</b>'}</p>` : '')
    + (r.cibles.length ? r.cibles.map((c, i) => `<div class="ligne" data-chemin="${i}"><span style="color:${(st[c.dernier.statut] || st.envoye)[1]}">${(st[c.dernier.statut] || st.envoye)[0]}</span><span class="titre">${etat.admin ? `<button class="mini etoile ${c.cle ? 'on' : ''}" data-cle="${c.cible}" title="Nœud clé">${c.cle ? '★' : '☆'}</button> ` : ''}${esc(c.nom)}${c.routeChangee ? ' <span class="pastille attention" title="Le chemin a changé depuis la mesure précédente">route changée</span>' : ''}<small>${resume(c)} · ${c.taux != null ? c.taux + ' % de réponses' : ''} · ${ilYa(c.dernier.heure)}</small></span>${etat.admin && r.radio ? `<button class="mini" data-tracer="${c.cible}" title="Lancer un traceroute maintenant">↻</button>` : ''}</div>`).join('')
      : '<div class="vide">Aucun traceroute depuis 7 jours.</div>');
  if (etat.admin) {
    const h = $('#tr-heures'), iv = $('#tr-intervalle');
    h.value = r.reglages.heures; iv.value = String(r.reglages.intervalle);
    const sauver = async (cibles) => { try { await postJson('/api/traceroutes/reglages', { cibles: cibles ?? r.reglages.cibles.filter((x) => /^\d+$/.test(x)), heures: h.value, intervalle: Number(iv.value) }); chargerChemins(); } catch (e) { alert(e.message); } };
    h.onchange = () => sauver(); iv.onchange = () => sauver();
    z.querySelectorAll('[data-cle]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const actuelles = new Set(r.reglages.cibles.filter((x) => /^\d+$/.test(x)));
      if (actuelles.has(b.dataset.cle)) actuelles.delete(b.dataset.cle); else actuelles.add(b.dataset.cle);
      sauver([...actuelles]);
    }));
    z.querySelectorAll('[data-tracer]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation(); b.disabled = true; b.textContent = '…';
      try { await api('/api/traceroute/' + b.dataset.tracer, { method: 'POST' }); b.textContent = '✓'; setTimeout(chargerChemins, 90000); } catch (err) { alert(err.message); b.textContent = '↻'; b.disabled = false; }
    }));
  }
  z.querySelectorAll('[data-chemin]').forEach((el) => (el.onclick = () => montrerChemin(r.cibles[Number(el.dataset.chemin)])));
}
function montrerChemin(c) {
  if (!c.mesure) return;
  if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
  const g = L.layerGroup().addTo(carte);
  etat.coucheCouvrir = g;
  $('#btn-effacer').hidden = false;
  const pts = [];
  const tracer = (ch, couleur, decal, lib) => {
    for (let i = 1; i < ch.length; i++) {
      const a = ch[i - 1], b = ch[i];
      if (!a.pos || !b.pos) continue;
      pts.push(a.pos, b.pos);
      L.polyline([a.pos, b.pos], { color: couleur, weight: 4, opacity: 0.9, dashArray: decal ? '8 6' : null, pane: 'traces' })
        .bindTooltip(`${lib} : ${esc(a.nom)} → ${esc(b.nom)}${b.snr != null ? ` · SNR ${fmt(b.snr, 1, ' dB')}` : ''}`, { className: 'info', sticky: true }).addTo(g);
      const m = [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2];
      if (b.snr != null) L.marker(m, { icon: L.divIcon({ className: 'etiquette-snr', html: `<span style="border-color:${couleur}">${fmt(b.snr, 1)} dB</span>`, iconSize: [50, 18], iconAnchor: decal ? [25, -4] : [25, 22] }), pane: 'traces', interactive: false }).addTo(g);
    }
  };
  tracer(c.mesure.aller, '#3ee6c4', false, 'Aller');
  if (c.mesure.retour) tracer(c.mesure.retour, '#c084fc', true, 'Retour');
  if (pts.length) carte.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 12 });
}

// ---- Liaisons à sens unique ----------------------------------------------------------------
async function chargerAsymetrie() {
  let r;
  try { r = await api('/api/liaisons/asymetrie'); } catch { return; }
  etat.asymetrie = r;
  const z = $('#asym');
  if (!z) return;
  const dz = (p) => !etat.zone || (p && dansZone(p));
  const sd = (r.sourds || []).filter((x) => dz(x.pos));
  const su = r.sensUnique.filter((x) => dz(x.a) || dz(x.b)), de = r.desequilibres.filter((x) => dz(x.posA) || dz(x.posB)), ia = r.inaudibles.filter((x) => dz(x.pos));
  const n = sd.length + su.length + de.length + ia.length;
  const p = $('#nb-asym'); p.textContent = n; p.className = 'pastille' + (sd.length || ia.length || su.length ? ' attention' : '');
  $('#resume-asym').textContent = n ? [sd.length ? `${sd.length} relais sourd${sd.length > 1 ? 's' : ''}` : '', ia.length ? `${ia.length} non entendu${ia.length > 1 ? 's' : ''}` : '', su.length ? `${su.length} à sens unique` : '', de.length ? `${de.length} déséquilibrée${de.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') : 'aucune';
  const ligne = (i, titre, sous, meta) => `<div class="ligne" data-asym="${i}"><span class="point alerte"></span><span class="titre">${titre}<small>${sous}</small></span><span class="meta">${meta}</span></div>`;
  const items = [];
  z.innerHTML = (n ? '' : '<div class="vide">Aucune anomalie : les liaisons observées fonctionnent dans les deux sens.</div>')
    + (sd.length ? '<h4>Relais « sourds » : émettent bien, entendent mal</h4>' + sd.map((x) => { items.push({ type: 'sd', x }); return ligne(items.length - 1, `${esc(x.nom)} <span class="pastille attention">≈ ${fmt(x.ecartDb, 0, ' dB')}</span>`, `entend environ ${fmt(x.ecartDb, 0, ' dB')} moins bien que ses voisins ne l’entendent (${x.nbConcordants} voisins sur ${x.nbVoisins})${x.puissanceConnue ? '' : ' · puissance d’émission inconnue : renseignez-la dans la fiche d’installation'}`, 'détail ›'); }).join('') + '<p class="note">Causes probables, de la plus fréquente à la plus rare : émetteurs puissants sur le site (téléphonie, FM, TNT, réseaux pros) qui saturent le récepteur → filtre passe-bande 868 MHz, antenne éloignée des autres ; « RX boosted gain » désactivé ; bruit local (alimentation à découpage, panneau solaire, régulateur, écran) ; étage d’entrée du module endommagé. Un câble ou une antenne défectueux pénalisent l’émission autant que la réception : ils ne créent pas cet écart.</p>' : '')
    + (ia.length ? '<h4>Entendent leurs voisins, mais personne ne les entend</h4>' + ia.map((x) => { items.push({ type: 'ia', x }); return ligne(items.length - 1, esc(x.nom), `entend ${x.entend} nœud${x.entend > 1 ? 's' : ''} en direct (${esc(x.voisins.slice(0, 3).join(', '))}${x.voisins.length > 3 ? '…' : ''}), mais aucun ne le reçoit`, '📡✖'); }).join('') : '')
    + (su.length ? '<h4>À sens unique</h4>' + su.map((x) => { items.push({ type: 'su', x }); return ligne(items.length - 1, `${esc(x.nomEntendu)} n’entend pas ${esc(x.nomEntend)}`, `${x.preuve === 'voisinage' ? 'd’après son rapport de voisinage · ' : ''}alors que ${esc(x.nomEntend)} l’entend (${x.nb} fois${x.snr != null ? ', SNR ' + fmt(x.snr, 1, ' dB') : ''})${x.distanceKm != null ? ' · ' + fmt(x.distanceKm, 1, ' km') : ''}`, '→ ✖'); }).join('') : '')
    + (de.length ? '<h4>Déséquilibrées (écart ≥ 10 dB)</h4>' + de.map((x) => { items.push({ type: 'de', x }); return ligne(items.length - 1, `${esc(x.nomA)} ↔ ${esc(x.nomB)}`, `${fmt(x.snrFort, 1, ' dB')} dans un sens, ${fmt(x.snrFaible, 1, ' dB')} dans l’autre`, `${fmt(x.ecart, 0, ' dB')}`); }).join('') : '')
    + (n ? '<p class="note">Causes fréquentes : relais sur un point haut plus bruité (il entend moins bien), puissances ou antennes différentes, antenne mal accordée, câble abîmé. Un nœud « que personne n’entend » émet probablement trop faiblement ou trop bas pour ses voisins. Seuls les nœuds qui disent ce qu’ils entendent sont jugés : passerelles MQTT et nœuds dont le module Voisinage est actif (avec « Envoyer aussi en LoRa » pour un relais sans MQTT).</p>' : '');
  z.querySelectorAll('[data-asym]').forEach((el) => (el.onclick = () => montrerAsymetrie(items[Number(el.dataset.asym)])));
}
function montrerAsymetrie(it) {
  if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
  const g = L.layerGroup().addTo(carte);
  etat.coucheCouvrir = g;
  $('#btn-effacer').hidden = false;
  const x = it.x;
  if (it.type === 'sd') {
    if (!x.pos) return;
    const pts = [[x.pos.lat, x.pos.lon]];
    L.circleMarker([x.pos.lat, x.pos.lon], { radius: 14, color: '#ffb547', weight: 3, fillOpacity: 0.15, pane: 'traces' }).bindTooltip(`${esc(x.nom)} : entend ≈ ${fmt(x.ecartDb, 0, ' dB')} moins bien`, { permanent: true, direction: 'top', className: 'info' }).addTo(g);
    for (const m of x.mesures) {
      const pn = etat.noeuds.get(m.partenaire);
      if (!pn || pn.lat == null) continue;
      pts.push([pn.lat, pn.lon]);
      L.polyline([[x.pos.lat, x.pos.lon], [pn.lat, pn.lon]], { color: m.ecart >= 8 ? '#ffb547' : '#3ee6c4', weight: 3, dashArray: m.borne ? '4 8' : null, pane: 'traces' })
        .bindTooltip(`${esc(m.nomPartenaire)} entend ${esc(x.nom)} à ${fmt(m.entenduChezPartenaire, 1, ' dB')} · ${esc(x.nom)} l’entend ${m.entenduChezLui != null ? 'à ' + fmt(m.entenduChezLui, 1, ' dB') : 'jamais (sous son seuil)'}<br>écart ${m.borne ? '≥ ' : ''}${fmt(m.ecart, 1, ' dB')}${m.corrige ? ' (puissances déduites)' : ''}`, { className: 'info', sticky: true }).addTo(g);
    }
    carte.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 12 });
    return;
  }
  if (it.type === 'ia') {
    if (!x.pos) return;
    L.circleMarker([x.pos.lat, x.pos.lon], { radius: 14, color: '#ff5c6c', weight: 3, fillOpacity: 0.15, pane: 'traces' }).bindTooltip(`${esc(x.nom)} : personne ne l’entend`, { permanent: true, direction: 'top', className: 'info' }).addTo(g);
    carte.flyTo([x.pos.lat, x.pos.lon], Math.max(carte.getZoom(), 11));
    return;
  }
  const a = it.type === 'su' ? x.b : x.posA, b = it.type === 'su' ? x.a : x.posB; // a = celui qui entend, b = celui qui est entendu (su)
  if (!a || !b) return;
  if (it.type === 'su') {
    // Deux traits parallèles légèrement décalés, avec une flèche au milieu : le sens qui passe et celui qui ne passe pas
    const dx = a.lon - b.lon, dy = a.lat - b.lat, lg = Math.hypot(dx, dy) || 1, k = lg * 0.012;
    const ox = (-dy / lg) * k, oy = (dx / lg) * k;
    const fleche = (de, vers, coul) => {
      const m = [(de[0] + vers[0]) / 2, (de[1] + vers[1]) / 2];
      const ang = (-Math.atan2(vers[0] - de[0], vers[1] - de[1]) * 180) / Math.PI; // ➤ pointe vers l’est ; rotation horaire en CSS
      L.marker(m, { icon: L.divIcon({ className: 'fleche-sens', html: `<span style="color:${coul};transform:rotate(${ang}deg)">➤</span>`, iconSize: [20, 20], iconAnchor: [10, 10] }), pane: 'traces', interactive: false }).addTo(g);
    };
    const ok1 = [b.lat + oy, b.lon + ox], ok2 = [a.lat + oy, a.lon + ox], ko1 = [a.lat - oy, a.lon - ox], ko2 = [b.lat - oy, b.lon - ox];
    L.polyline([ok1, ok2], { color: '#3ee6c4', weight: 4, pane: 'traces' }).bindTooltip(`✔ ${esc(x.nomEntend)} entend ${esc(x.nomEntendu)}${x.snr != null ? ' (SNR ' + fmt(x.snr, 1, ' dB') + ')' : ''}`, { className: 'info', sticky: true }).addTo(g);
    L.polyline([ko1, ko2], { color: '#ff5c6c', weight: 3, dashArray: '4 8', pane: 'traces' }).bindTooltip(`✖ ${esc(x.nomEntendu)} n’entend jamais ${esc(x.nomEntend)}`, { className: 'info', sticky: true }).addTo(g);
    fleche(ok1, ok2, '#3ee6c4'); fleche(ko1, ko2, '#ff5c6c');
  } else {
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#ffb547', weight: 4, pane: 'traces' }).bindTooltip(`${fmt(x.snrFort, 1, ' dB')} / ${fmt(x.snrFaible, 1, ' dB')}`, { className: 'info', sticky: true }).addTo(g);
  }
  carte.fitBounds(L.latLngBounds([[a.lat, a.lon], [b.lat, b.lon]]), { padding: [80, 80], maxZoom: 12 });
}

// ---- Panneau : réseau --------------------------------------------------------
function rendreReseau() {
  const a = etat.alertes.filter((x) => dansZoneNum(x.num));
  const pastille = $('#nb-alertes');
  pastille.textContent = a.length;
  pastille.className = 'pastille' + (a.some((x) => x.niveau === 'critique') ? ' critique' : a.length ? ' attention' : '');
  $('#resume-alertes').textContent = resumeAlertes(a);
  $('#alertes').innerHTML = a.length
    ? a.map((x) => `<div class="alerte ${x.niveau}" data-num="${x.num}">${esc(x.message)}<small>${x.niveau === 'critique' ? 'Critique' : 'Attention'} · depuis ${ilYa(x.depuis).replace('il y a ', '')}</small></div>`).join('')
    : '<div class="vide">Aucune alerte, le réseau est en bonne santé.</div>';

  const tous = [...etat.noeuds.values()].filter(dansZone);
  const passerelles = tous.filter((n) => n.passerelle).sort((x, y) => (y.dernierVuPasserelle || 0) - (x.dernierVuPasserelle || 0));
  const seuilMuet = etat.config.seuils.muetMinutes * 60000;
  const gwEnLigne = (n) => n.etatPasserelle !== 'offline' && Date.now() - (n.dernierVuPasserelle || 0) < seuilMuet;
  const nbGw = passerelles.filter(gwEnLigne).length;
  $('#resume-passerelles').innerHTML = passerelles.length ? `${nbGw}/${passerelles.length} en ligne` : 'aucune';
  $('#passerelles').innerHTML = passerelles.length
    ? passerelles.map((n) => {
        const enLigne = gwEnLigne(n);
        return ligneNoeud(n, enLigne ? 'actif' : 'alerte', `${enLigne ? 'En ligne' : 'Hors ligne'} · ${ilYa(n.dernierVuPasserelle)}`);
      }).join('')
    : '<div class="vide">Aucune passerelle n’a encore publié sur le broker.</div>';

  const infra = tous.filter((n) => n.infrastructure && !n.passerelle).sort((x, y) => (x.nomLong || '').localeCompare(y.nomLong || ''));
  const alertes = numAlerte();
  const nbInfraAlerte = infra.filter((n) => alertes.has(n.num)).length;
  $('#resume-infra').textContent = infra.length ? `${infra.length}${nbInfraAlerte ? ` · ${nbInfraAlerte} ⚠` : ''}` : 'aucun';
  $('#infra').innerHTML = infra.length
    ? infra.map((n) => ligneNoeud(n, alertes.has(n.num) ? 'alerte' : n.statut, ilYa(n.dernierVu), true)).join('')
    : '<div class="vide">Aucun relais identifié (rôle ROUTER, REPEATER, CLIENT_BASE ou liste NOEUDS_SURVEILLES).</div>';

  const parPort = (etat.stats && etat.stats.parPort) || {};
  const total = Object.values(parPort).reduce((x, y) => x + y, 0);
  const max = Math.max(1, ...Object.values(parPort));
  $('#repartition').innerHTML = total
    ? Object.entries(parPort).sort((x, y) => y[1] - x[1]).map(([p, nb]) =>
        `<div class="barre-port"><span>${esc(portInfo(p).nom)}</span><div class="piste"><i style="width:${(nb / max) * 100}%;background:${portInfo(p).couleur}"></i></div><span class="nb">${nb}</span></div>`).join('')
    : '<div class="vide">Pas encore de trafic.</div>';
}

function jauge(v, seuilA, seuilC, inverse) {
  if (v == null) return '';
  const pct = Math.max(0, Math.min(100, v));
  const niveau = inverse ? (v <= seuilC ? 'critique' : v <= seuilA ? 'attention' : '') : (v >= seuilC ? 'critique' : v >= seuilA ? 'attention' : '');
  return `<span class="jauge"><i class="${niveau}" style="width:${pct}%"></i></span>`;
}

function ligneNoeud(n, point, meta, details) {
  const s = etat.config.seuils;
  const sous = details
    ? `<div class="sous-ligne">${n.tension ? `<span>${fmt(n.tension, 2, ' V')}</span>` : ''}${n.batterie != null && n.batterie <= 100 ? `<span>Batt. ${n.batterie} %${jauge(n.batterie, 40, s.batteriePourcent, true)}</span>` : n.batterie > 100 ? '<span>Secteur</span>' : ''}${n.canal != null ? `<span>Canal ${fmt(n.canal, 0, ' %')}${jauge(n.canal, s.canalPourcent, s.canalCritiquePourcent)}</span>` : ''}</div>`
    : '';
  return `<div class="ligne" data-num="${n.num}"><span class="point ${point}"></span><span class="titre">${esc(n.nomLong || n.id)}<small>${esc(n.nomCourt || '')}</small></span><span class="meta">${esc(meta)}</span>${sous}</div>`;
}

// ---- Panneau : nœuds -----------------------------------------------------------
function rendreNoeuds() {
  const filtre = $('#recherche').value.trim().toLowerCase();
  const tri = $('#tri').value;
  let liste = [...etat.noeuds.values()].filter((n) => dansZone(n) && (
    !filtre || [n.nomLong, n.nomCourt, n.id].some((x) => x && x.toLowerCase().includes(filtre))));
  const cmp = {
    vu: (a, b) => (b.dernierVu || 0) - (a.dernierVu || 0),
    nom: (a, b) => (a.nomLong || a.id).localeCompare(b.nomLong || b.id),
    sauts: (a, b) => (a.sautsMin ?? 99) - (b.sautsMin ?? 99),
    snr: (a, b) => (b.snr ?? -99) - (a.snr ?? -99),
  }[tri];
  liste.sort(cmp);
  const alertes = numAlerte();
  $('#noeuds').innerHTML = liste.length
    ? liste.slice(0, 400).map((n) => {
        const sauts = n.sautsMin == null ? '' : n.sautsMin === 0 ? 'direct · ' : `${n.sautsMin} saut${n.sautsMin > 1 ? 's' : ''} · `;
        return ligneNoeud(n, alertes.has(n.num) ? 'alerte' : n.statut, sauts + ilYa(n.dernierVu));
      }).join('')
    : '<div class="vide">Aucun nœud.</div>';
}

// ---- Panneau : trafic ------------------------------------------------------------
function rendreFiltres() {
  $('#filtres').innerHTML = Object.entries(PORTS).map(([cle, p]) =>
    `<button data-port="${cle}" class="${etat.filtresPorts.has(cle) ? 'actif' : ''}"><i style="background:${p.couleur}"></i>${esc(p.nom)}</button>`).join('');
}
function lignePaquet(p, nouveau) {
  const info = portInfo(p.port);
  const de = esc(nomNoeud(p.de));
  const vers = p.vers && p.vers !== 0xffffffff ? ` → ${esc(nomNoeud(p.vers))}` : '';
  const gw = p.passerelle != null ? `reçu par ${esc(nomCourt(p.passerelle))}` : '';
  const radio = [
    p.sauts == null ? null : p.sauts === 0 ? 'direct' : `${p.sauts} saut${p.sauts > 1 ? 's' : ''}`,
    p.relais != null ? `via ${esc(nomCourt(p.relais))}` : null,
    p.snr != null ? `SNR ${fmt(p.snr, 1)} dB` : null,
    p.rssi != null ? `RSSI ${p.rssi} dBm` : null,
  ].filter(Boolean).join(' · ');
  const texte = p.texte ? `<div class="corps">💬 ${esc(p.texte)}</div>` : `<div class="corps">${esc(p.resume || '')}</div>`;
  return `<div class="paquet${nouveau ? ' nouveau' : ''}" data-num="${p.de}" data-port="${p.port}">
    <div class="entete"><span class="heure">${heure(p.heure)}</span><span class="tag"><i style="background:${info.couleur}"></i>${esc(info.nom)}</span><span>${esc(p.canal || '')}</span></div>
    <div class="corps"><b>${de}</b>${vers} <span class="radio">${gw}</span></div>${texte}
    ${radio ? `<div class="radio">${radio}</div>` : ''}</div>`;
}
function ajouterAuFlux(p) {
  if (!p.premiere || !etat.filtresPorts.has(p.port)) return;
  if (etat.zone && !dansZoneNum(p.de) && !dansZoneNum(p.passerelle)) return;
  const flux = $('#flux');
  flux.insertAdjacentHTML('afterbegin', lignePaquet(p, true));
  while (flux.children.length > 300) flux.lastElementChild.remove();
}
async function chargerActiviteInitiale() {
  try {
    const liste = await api('/api/paquets?limite=1000');
    const limite = Date.now() - 10 * 60000;
    liste.filter((p) => p.heure >= limite).sort((a, b) => a.heure - b.heure).forEach((p) => noterActivite(p.de, p.heure));
    dessinerChaleur();
  } catch { /* ignore */ }
}
async function chargerFlux() {
  const paquets = await api('/api/paquets?limite=200');
  $('#flux').innerHTML = paquets.filter((p) => etat.filtresPorts.has(p.port)).map((p) => {
    const r = (p.receptions || [])[0] || {};
    if (etat.zone && !dansZoneNum(p.de) && !dansZoneNum(r.passerelle)) return '';
    return lignePaquet({ ...p, passerelle: r.passerelle, snr: r.snr, rssi: r.rssi }, false);
  }).join('') || '<div class="vide">En attente de paquets…</div>';
}
// ---- Envoi de messages par le module (admin) ---------------------------------------------
const envoi = { dest: null, suivis: new Map() };
async function preparerEnvoi(dest) {
  const f = $('#form-envoi');
  if (!etat.admin || !f) return;
  let i;
  try { i = await api('/api/envoi'); } catch { return; }
  f.hidden = false;
  if (dest !== undefined) envoi.dest = dest;
  const n = envoi.dest != null ? etat.noeuds.get(envoi.dest) : null;
  envoi.canaux = i.canaux;
  f.vers.innerHTML = i.canaux.map((c) => `<option value="c${c.index}" data-nom="${esc(c.nom)}">📢 Canal ${esc(c.nom)}</option>`).join('')
    + (n ? `<option value="d${n.num}" selected>✉️ Direct → ${esc(n.nomLong || n.id)}</option>` : '')
    + '<option value="choisir">✉️ Message direct… (choisir un nœud)</option>';
  f.querySelector('button[type=submit]').disabled = !i.connecte;
  $('#retour-envoi').textContent = i.connecte ? '' : 'Module radio non connecté : connectez-le dans Réseau › Modules Wi-Fi.';
  f.vers.onchange = () => {
    if (f.vers.value !== 'choisir') return;
    const nom = prompt('Nom, nom court ou !identifiant du nœud :');
    if (!nom) { f.vers.selectedIndex = 0; return; }
    const t = nom.toLowerCase().trim();
    const trouve = [...etat.noeuds.values()].find((x) => [x.nomLong, x.nomCourt, x.id].some((v) => v && v.toLowerCase() === t))
      || [...etat.noeuds.values()].find((x) => [x.nomLong, x.nomCourt, x.id].some((v) => v && v.toLowerCase().includes(t)));
    if (!trouve) { alert('Nœud introuvable'); f.vers.selectedIndex = 0; return; }
    preparerEnvoi(trouve.num);
  };
  const maj = () => { const o = new TextEncoder().encode(f.texte.value).length; $('#compteur-envoi').textContent = `${o}/200`; $('#compteur-envoi').classList.toggle('trop', o > 200); };
  f.texte.oninput = maj; maj();
  f.texte.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = f.vers.value;
    const corps = { texte: f.texte.value };
    if (v.startsWith('d')) corps.dest = Number(v.slice(1)); else corps.canal = Number(v.slice(1));
    const r$ = $('#retour-envoi');
    try {
      const r = await postJson('/api/envoi', corps);
      f.texte.value = ''; maj();
      r$.textContent = corps.dest != null ? 'Envoyé… en attente de l’accusé du destinataire' : 'Envoyé… en attente d’un relais';
      suivreEnvoi(r.id, corps.dest != null);
      setTimeout(chargerMessages, 800);
    } catch (x) { r$.textContent = x.message; }
  };
}
function suivreEnvoi(id, direct) {
  let n = 0;
  const t = setInterval(async () => {
    n++;
    let e;
    try { e = await api('/api/envoi/' + id); } catch { return; }
    const r$ = $('#retour-envoi');
    if (e.statut === 'recu') { r$.innerHTML = '<span class="succes">✓ Reçu par le destinataire</span>'; clearInterval(t); }
    else if (e.statut === 'relaye') { r$.innerHTML = `<span class="succes">✓ ${direct ? 'Relayé par un voisin, en route' : 'Émis et relayé par un voisin'}</span>`; if (!direct) clearInterval(t); }
    else if (e.statut === 'echec') { r$.innerHTML = `<span class="erreur">✗ Échec : ${esc(e.detail || '')}</span>`; clearInterval(t); }
    if (n > 45) { if (e.statut === 'envoye') r$.textContent = direct ? 'Aucun accusé reçu (destinataire hors de portée ?)' : 'Aucun relais entendu'; clearInterval(t); }
  }, 2000);
}

// Comment le message est arrivé : par LoRa sur mon module, par le broker MQTT (passerelles), et s'il a transité par internet
function origineMessage(m) {
  const local = etat.radio ? etat.radio.noeudLocal : null;
  const b = [];
  if (local != null && m.de === local) b.push('<span class="orig lora" title="Message émis par votre module radio">📡 Émis par mon module</span>');
  else if (m.radio) b.push(`<span class="orig lora" title="Reçu en radio LoRa par votre module${m.sautsRadio != null ? ' après ' + m.sautsRadio + ' saut(s)' : ''}">📻 LoRa${m.sautsRadio === 0 ? ' direct' : m.sautsRadio != null ? ' · ' + m.sautsRadio + ' saut' + (m.sautsRadio > 1 ? 's' : '') : ''}${m.snrRadio != null ? ' · ' + fmt(m.snrRadio, 1, ' dB') : ''}</span>`);
  if (m.mqtt) b.push(`<span class="orig mqtt" title="Publié sur le broker MQTT par ${m.mqtt} passerelle(s) qui l’ont entendu">🌐 MQTT · ${m.mqtt} passerelle${m.mqtt > 1 ? 's' : ''}</span>`);
  if (m.viaMqtt) b.push('<span class="orig internet" title="Le message a été réinjecté sur le maillage par une passerelle MQTT : il a traversé internet avant d’arriver en radio (pont, autre région…)">⚠ Passé par internet</span>');
  return b.length ? `<div class="origines">${b.join('')}</div>` : '';
}
// Parcours d'un message : pour chaque réception, émetteur → relais (connu ou probable) → passerelle / module
async function afficherParcours(rowid) {
  let t;
  try { t = await api(`/api/messages/${rowid}/parcours`); } catch (e) { return; }
  const local = etat.radio ? etat.radio.noeudLocal : null;
  const pt = (num) => { const n = etat.noeuds.get(num); return n && n.lat != null ? n : null; };
  if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
  const g = L.layerGroup().addTo(carte);
  etat.coucheCouvrir = g;
  $('#btn-effacer').hidden = false;
  const pts = [];
  const src = pt(t.de);
  if (src) { pts.push([src.lat, src.lon]); L.marker([src.lat, src.lon], { icon: L.divIcon({ className: 'sommet plan', html: '<span>E</span>', iconSize: [22, 22], iconAnchor: [11, 11] }), pane: 'traces', zIndexOffset: 900 }).bindTooltip(`<b>Émetteur</b> · ${esc(nomNoeud(t.de))}`, { className: 'info' }).addTo(g); }
  const lignes = t.receptions.map((r, i) => {
    const gw = pt(r.passerelle);
    const radio = /^radio/.test(r.sujet || '');
    const propre = r.passerelle === t.de;
    let chemin = null, estime = false;
    if (!propre && r.sauts != null) {
      if (r.sauts === 0) chemin = [t.de, r.passerelle];
      else if (r.relais != null && r.sauts === 1) chemin = [t.de, r.relais, r.passerelle];
      else {
        const avant = r.relais != null ? cheminProbableMt(t.de, r.relais, r.sauts) : cheminProbableMt(t.de, r.passerelle, r.sauts + 1);
        chemin = avant ? (r.relais != null ? [...avant, r.passerelle] : avant) : (r.relais != null ? [t.de, r.relais, r.passerelle] : null);
        estime = true;
      }
    }
    const couleur = radio ? '#3ee6c4' : '#60a5fa';
    if (chemin && chemin.every((n) => pt(n))) {
      const ll = chemin.map((n) => { const x = pt(n); return [x.lat, x.lon]; });
      ll.forEach((x) => pts.push(x));
      L.polyline(ll, { color: couleur, weight: 4, opacity: 0.9, dashArray: estime ? '6 7' : null, pane: 'traces' }).bindTooltip(`Vers ${esc(nomNoeud(r.passerelle))}${estime ? ' (trajet probable)' : ''}`, { className: 'info', sticky: true }).addTo(g);
      chemin.slice(1, -1).forEach((n) => { const x = pt(n); L.circleMarker([x.lat, x.lon], { radius: 7, color: '#fff', weight: 2, fillColor: couleur, fillOpacity: 1, pane: 'traces' }).bindTooltip(`<b>Relais</b> · ${esc(nomNoeud(n))}`, { className: 'info' }).addTo(g); });
    } else if (gw && src && !propre) {
      pts.push([gw.lat, gw.lon]);
      L.polyline([[src.lat, src.lon], [gw.lat, gw.lon]], { color: couleur, weight: 2, opacity: 0.6, dashArray: '2 8', pane: 'traces' }).addTo(g);
    }
    if (gw) L.marker([gw.lat, gw.lon], { icon: L.divIcon({ className: 'sommet plan existant-relier', html: `<span>${i + 1}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }), pane: 'traces', zIndexOffset: 800 }).bindTooltip(`<b>${radio ? 'Mon module' : 'Passerelle'}</b> · ${esc(nomNoeud(r.passerelle))}`, { className: 'info' }).addTo(g);
    const etapes = chemin ? chemin.slice(1, -1).map((n) => esc(nomNoeud(n))).join(' → ') : '';
    return `<div class="proposition etape-relier ${radio ? 'depart' : 'existant'}">
      <div class="entete-prop"><span class="lettre">${i + 1}</span><b>${esc(nomNoeud(r.passerelle))}</b><span class="marge">${radio ? '📻 Mon module (LoRa)' : propre ? '🌐 Publié par l’émetteur' : '🌐 Passerelle MQTT'}</span></div>
      <div class="meta-longue">${propre ? 'L’émetteur est lui-même passerelle : il a publié son propre message sur MQTT, ce qui ne prouve pas qu’il a été entendu en radio.' : `${r.sauts == null ? 'sauts inconnus' : r.sauts === 0 ? 'Reçu <b>en direct</b> (aucun relais)' : `<b>${r.sauts} saut${r.sauts > 1 ? 's' : ''}</b>`}${r.snr != null ? ` · SNR ${fmt(r.snr, 1, ' dB')}` : ''}${r.rssi != null ? ` · RSSI ${fmt(r.rssi, 0, ' dBm')}` : ''}`}</div>
      ${!propre && r.sauts > 0 ? `<div class="meta-longue">Dernier relais : <b>${r.relais != null ? esc(nomNoeud(r.relais)) : 'non identifié'}</b>${etapes ? `<br>${estime ? 'Trajet probable' : 'Trajet'} : ${esc(nomNoeud(t.de))} → ${etapes} → ${esc(nomNoeud(r.passerelle))}` : ''}</div>` : ''}
    </div>`;
  });
  const autres = t.receptions.filter((r) => r.passerelle !== t.de);
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `<h2>Parcours du message</h2>
    <div class="ident">${esc(nomNoeud(t.de))} · ${heure(t.heure)} · ${esc(t.canal || (t.vers !== 0xffffffff ? 'Direct' : ''))}${t.hopDepart != null ? ` · limite de sauts au départ : ${t.hopDepart}` : ''}</div>
    ${t.texte ? `<div class="texte-parcours">« ${esc(t.texte)} »</div>` : ''}
    ${t.viaMqtt ? '<div class="alerte attention">⚠ Ce message a traversé internet : une passerelle MQTT l’a réinjecté en radio.</div>' : ''}
    ${!autres.length ? `<div class="alerte attention">Aucun récepteur autre que l’émetteur ne l’a remonté : ${t.de === local ? 'ton message n’a été entendu en LoRa par aucune passerelle du réseau.' : 'pas de preuve de réception radio.'}</div>` : ''}
    ${lignes.join('')}
    <p class="note">Meshtastic ne transmet que le nombre de sauts et le dernier octet du dernier relais : les relais intermédiaires sont déduits des liaisons déjà observées (tracé en pointillé, « trajet probable »). Vert = reçu par ton module, bleu = passerelle MQTT.</p>`;
  if (pts.length) carte.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 12 });
}
async function chargerMessages() {
  if (!etat.membre) return;
  if (etat.admin && ($('#form-envoi').hidden || !$('#form-envoi').vers.querySelector('option[data-nom]'))) preparerEnvoi();
  const msgs = await api('/api/messages?limite=300');
  $('#messages').innerHTML = msgs.length
    ? msgs.map((m) => `<div class="message${etat.radio && m.de === etat.radio.noeudLocal ? ' moi' : ''}${etat.admin ? ' cliquable' : ''}" data-rowid="${m.rowid}" data-de="${m.de}" data-vers="${m.vers}" data-canal="${esc(m.canal || '')}" title="${etat.admin ? 'Cliquer pour répondre dans ce canal' : ''}"><div class="entete">${heure(m.heure)} · ${new Date(m.heure).toLocaleDateString('fr-FR')} · <b>${m.vers !== 0xffffffff ? '✉️ Direct' : esc(m.canal || '')}</b> · ${esc(nomNoeud(m.de))}${m.vers !== 0xffffffff ? ' → ' + esc(nomNoeud(m.vers)) : ''}</div><div class="texte">${esc(m.texte || '(non conservé)')}</div>${origineMessage(m)}</div>`).join('')
    : '<div class="vide">Aucun message texte sur la période.</div>';
  if (etat.admin) $('#messages').querySelectorAll('.message[data-de]').forEach((el) => (el.onclick = () => repondreA(el)));
  $('#messages').querySelectorAll('.origines').forEach((el) => {
    el.title = 'Voir le parcours du message sur la carte';
    el.onclick = (e) => { e.stopPropagation(); afficherParcours(Number(el.closest('.message').dataset.rowid)); };
  });
}

// Clic sur un message : le formulaire bascule sur le bon canal (ou en direct vers l'expéditeur) pour répondre
async function repondreA(el) {
  const f = $('#form-envoi');
  if (!f) return;
  const de = Number(el.dataset.de) >>> 0, vers = Number(el.dataset.vers) >>> 0, canal = el.dataset.canal;
  const local = etat.radio ? etat.radio.noeudLocal : null;
  const r$ = $('#retour-envoi');
  if (vers !== 0xffffffff) {
    await preparerEnvoi(de === local ? vers : de); // message direct : on répond à l'autre
  } else {
    if (f.hidden || !f.vers.querySelector('option[data-nom]')) await preparerEnvoi();
    const opt = [...f.vers.options].find((o) => o.dataset.nom === canal) || [...f.vers.options].find((o) => (o.dataset.nom || '').toLowerCase() === canal.toLowerCase());
    if (opt) { f.vers.value = opt.value; r$.textContent = ''; }
    else { r$.textContent = `Le canal « ${canal} » n’est pas configuré sur le module connecté : impossible d’y répondre.`; return; }
  }
  $('#messages').querySelectorAll('.message.choisi').forEach((x) => x.classList.remove('choisi'));
  el.classList.add('choisi');
  f.vers.classList.remove('flash'); void f.vers.offsetWidth; f.vers.classList.add('flash');
  f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  f.texte.focus();
}

// ---- Fiche nœud ------------------------------------------------------------------
function courbe(points, cle, lib, unite, dec, seuil) {
  const pts = points.filter((p) => p[cle] != null);
  if (pts.length < 2) return '';
  const vals = pts.map((p) => p[cle]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (seuil != null) { min = Math.min(min, seuil); max = Math.max(max, seuil); }
  if (max - min < 1e-6) { max += 1; min -= 1; }
  const t0 = pts[0].heure, t1 = pts[pts.length - 1].heure || t0 + 1;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * 300;
  const y = (v) => 42 - ((v - min) / (max - min)) * 38;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.heure).toFixed(1)},${y(p[cle]).toFixed(1)}`).join('');
  const ligneSeuil = seuil != null ? `<line x1="0" x2="300" y1="${y(seuil)}" y2="${y(seuil)}" stroke="#ffb547" stroke-dasharray="3 4" stroke-width="1" opacity=".7"/>` : '';
  return `<div class="courbe"><div class="lib"><span>${lib}</span><span>dernier ${fmt(vals[vals.length - 1], dec, unite)} · min ${fmt(Math.min(...vals), dec)} · max ${fmt(Math.max(...vals), dec)}</span></div>
    <svg viewBox="0 0 300 46" preserveAspectRatio="none">${ligneSeuil}<path d="${d}" fill="none" stroke="#3ee6c4" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg></div>`;
}

// ---- Fiche d'installation d'un relais (antenne, hauteur, alimentation, site) -----------------------
const LIB_ALIM = { secteur: 'Secteur', solaire: 'Solaire', batterie: 'Batterie seule', 'secteur+batterie': 'Secteur + batterie', 'solaire+batterie': 'Solaire + batterie', autre: 'Autre' };
function htmlInstallation(n, f) {
  f = f || {};
  const v = (k) => (f[k] != null ? esc(String(f[k])) : '');
  if (!gerable(n.num)) {
    if (!Object.keys(f).length) return '<div class="vide">Aucune fiche d’installation pour ce nœud.</div>';
    const l = [['Hauteur d’antenne', f.hauteur != null ? f.hauteur + ' m' : null], ['Antenne', f.antenne], ['Gain', f.gain != null ? f.gain + ' dBi' : null], ['Pertes câble', f.pertesCable != null ? f.pertesCable + ' dB' : null], ['Puissance', f.puissance != null ? f.puissance + ' dBm' : null], ['Alimentation', LIB_ALIM[f.alimentation]], ['Batterie', f.batterieAh != null ? f.batterieAh + ' Ah' : null], ['Panneau', f.panneauW != null ? f.panneauW + ' W' : null], ['Site', f.site], ['Mise en service', f.miseEnService]];
    return `<div class="grille">${l.filter((x) => x[1] != null && x[1] !== '').map(([a, b]) => `<div class="mesure"><span>${a}</span><b>${esc(String(b))}</b></div>`).join('')}</div>${f.notes ? `<p class="note">${esc(f.notes)}</p>` : ''}`;
  }
  return `<form id="f-install" class="form-edit">
    <h4>Antenne et radio</h4><div class="grille-edit">
      <label>Hauteur au-dessus du sol (m) <input name="hauteur" type="number" step="0.5" min="0.5" max="120" value="${v('hauteur')}" placeholder="ex. 8"></label>
      <label>Antenne (modèle, type) <input name="antenne" maxlength="80" value="${v('antenne')}" placeholder="ex. colinéaire 868 MHz 5,8 dBi"></label>
      <label>Gain (dBi) <input name="gain" type="number" step="0.1" min="-5" max="15" value="${v('gain')}" placeholder="2,15 par défaut"></label>
      <label>Pertes câble + connecteurs (dB) <input name="pertesCable" type="number" step="0.1" min="0" max="20" value="${v('pertesCable')}" placeholder="ex. 1,5"></label>
      <label>Puissance d’émission (dBm) <input name="puissance" type="number" step="1" min="0" max="30" value="${v('puissance')}" placeholder="27 par défaut"></label></div>
    <h4>Alimentation</h4><div class="grille-edit">
      <label>Type <select name="alimentation"><option value="">–</option>${Object.entries(LIB_ALIM).map(([k, t]) => `<option value="${k}" ${f.alimentation === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Batterie (Ah) <input name="batterieAh" type="number" step="0.1" min="0" value="${v('batterieAh')}"></label>
      <label>Panneau solaire (W) <input name="panneauW" type="number" step="1" min="0" value="${v('panneauW')}"></label></div>
    <h4>Site</h4><div class="grille-edit">
      <label>Site (lieu, support) <input name="site" maxlength="120" value="${v('site')}" placeholder="ex. château d’eau, mât 6 m"></label>
      <label>Mise en service <input name="miseEnService" type="date" value="${v('miseEnService')}"></label>
      <label>Propriétaire du site <input name="proprietaire" maxlength="120" value="${v('proprietaire')}"></label>
      <label>Contact <input name="contact" maxlength="160" value="${v('contact')}"></label></div>
    <label>Notes <textarea name="notes" rows="3" maxlength="1000">${v('notes')}</textarea></label>
    <div class="actions-prop"><button type="submit" class="principal">Enregistrer la fiche</button></div>
    <p class="note">La hauteur, le gain, les pertes et la puissance remplacent les valeurs supposées (6 m, 2,15 dBi, 27 dBm) dans la couverture du réseau, le plan et Relier. Propriétaire et contact ne sont visibles que des administrateurs.${f.maj ? ` Dernière mise à jour ${ilYa(f.maj)}${f.par ? ' par ' + esc(f.par) : ''}.` : ''}</p>
    <p class="erreur" id="install-retour"></p>
  </form>`;
}
function brancherInstallation(n) {
  const fo = $('#f-install');
  if (!fo) return;
  fo.onsubmit = async (e) => {
    e.preventDefault();
    const nums = ['hauteur', 'gain', 'pertesCable', 'puissance', 'batterieAh', 'panneauW'];
    const corps = Object.fromEntries([...new FormData(fo).entries()].map(([k, x]) => [k, nums.includes(k) ? String(x).replace(',', '.').trim() : String(x).trim()]));
    try { await postJson(`/api/noeuds/${n.num}/installation`, corps, 'PUT'); $('#install-retour').textContent = '✔ Fiche enregistrée.'; $('#install-retour').classList.add('ok'); }
    catch (err) { $('#install-retour').textContent = err.message; }
  };
}
async function ouvrirFiche(num) {
  etat.selection = num;
  const fiche = $('#fiche');
  fiche.hidden = false;
  $('#fiche-contenu').innerHTML = '<div class="vide">Chargement…</div>';
  let d;
  try { d = await api('/api/noeuds/' + num); } catch (e) { $('#fiche-contenu').innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (etat.selection !== num) return;
  const n = d.noeud;
  const s = etat.config.seuils;
  const mesures = [
    ['Dernier entendu', ilYa(n.dernierVu)],
    ['Sauts', n.sautsDernier == null ? '–' : n.sautsDernier === 0 ? 'Direct' : n.sautsDernier],
    ['SNR', fmt(n.snr, 1, ' dB')],
    ['RSSI', fmt(n.rssi, 0, ' dBm')],
    ['Batterie', n.batterie == null ? '–' : n.batterie > 100 ? 'Secteur' : n.batterie + ' %'],
    ['Tension', fmt(n.tension, 2, ' V')],
    ['Occupation canal', fmt(n.canal, 1, ' %')],
    ['Temps d’émission', fmt(n.emission, 2, ' %')],
    ['Altitude', n.alt != null ? n.alt + ' m' : '–'],
    ['Allumé depuis', duree(n.uptime)],
    ['Matériel', n.materiel || '–'],
    ['Firmware', n.firmware || '–'],
  ];
  if (n.temperature != null) mesures.push(['Température', fmt(n.temperature, 1, ' °C')]);
  if (n.humidite != null) mesures.push(['Humidité', fmt(n.humidite, 0, ' %')]);
  if (n.pression != null) mesures.push(['Pression', fmt(n.pression, 0, ' hPa')]);
  if (n.statsLocales) {
    const st = n.statsLocales;
    mesures.push(['Nœuds en ligne', st.enLigne ?? '–'], ['Paquets relayés', st.relais ?? '–'], ['Bruit de fond', st.bruit != null ? st.bruit + ' dBm' : '–']);
  }
  const alertesNoeud = etat.alertes.filter((a) => a.num === num);
  const voisins = d.voisins.slice(0, 30).map((v) => `<tr data-num="${v.num}">
      <td><span style="color:${couleurSnr(v.snrEntendu ?? v.snrEmis)}">●</span> ${esc(v.nom)}</td>
      <td class="num">${fmt(v.snrEntendu, 1)}</td><td class="num">${fmt(v.snrEmis, 1)}</td>
      <td class="num">${v.distanceKm != null ? fmt(v.distanceKm, 1) : '–'}</td><td class="num">${fmt(v.part, 1, ' %')}</td>
      <td class="num">${n.lat != null && etat.noeuds.get(v.num) && etat.noeuds.get(v.num).lat != null ? `<button class="mini" data-profil="${v.num}" title="Profil de relief et bilan de liaison">⛰</button>` : ''}</td></tr>`).join('');
  const receptions = d.receptions.map((r) => `<tr data-num="${r.passerelle}"><td>${esc(r.nom)}</td><td class="num">${r.nb}</td><td class="num">${fmt(r.snr, 1)}</td><td class="num">${fmt(r.rssi, 0)}</td><td class="num">${r.sauts_min ?? '–'}</td></tr>`).join('');

  $('#fiche-contenu').innerHTML = `
    <h2>${esc(n.nomLong || n.id)}</h2>
    <div class="ident">${esc(n.nomCourt || '')} · ${esc(n.id)} · ${n.num}</div>
    ${blocCoords(n.lat, n.lon, { alt: n.alt, approx: !etat.membre && !n.infrastructure && etat.config.precisionPublique >= 0 })}
    <div class="badges">
      <span class="badge ${n.statut}">${{ actif: 'Actif', recent: 'Récent', inactif: 'Inactif' }[n.statut]}</span>
      <span class="badge ${n.infrastructure ? 'infra' : ''}">${esc(n.roleFr)}</span>
      ${n.passerelle ? `<span class="badge passerelle">Passerelle MQTT · ${n.etatPasserelle === 'offline' ? 'hors ligne' : 'en ligne'}</span>` : ''}
      ${n.preset ? `<span class="badge">${esc(n.preset)}</span>` : ''}
      ${[...new Set(d.paquets.map((p) => p.canal).filter(Boolean))].slice(0, 4).map((c) => `<span class="badge canal">${esc(c)}</span>`).join('')}
      ${n.materiel ? `<span class="badge">${esc(n.materiel)}</span>` : ''}
    </div>
    <nav class="onglets-fiche">
      <button data-of="infos" class="actif">Informations</button><button data-of="telem">Télémétries</button><button data-of="voisins">Voisins</button><button data-of="config">Configuration</button>${etat.membre ? `<button data-of="install">Installation${d.installation ? ' ✓' : ''}</button>` : ''}<button data-of="trames">Trames</button>
    </nav>
    <div data-pf="infos">
    ${alertesNoeud.map((a) => `<div class="liste-alertes"><div class="alerte ${a.niveau}">${esc(a.message)}</div></div>`).join('')}
    <div class="grille">${mesures.map(([l, v]) => `<div class="mesure"><span>${l}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="boutons">
      ${n.lat != null ? '<button id="centrer">Centrer sur la carte</button>' : ''}
      ${d.trajet.length > 1 ? `<button id="trajet">Afficher le trajet (${d.trajet.length} points)</button>` : ''}
      ${n.infrastructure && n.lat != null ? '<button id="simu-retrait" title="Que perdrait-on si ce relais tombait en panne ?">🧪 Et s’il tombait en panne ?</button>' : ''}
      ${n.lat != null ? '<button id="mes-noeud" title="D’où ce nœud a réellement été reçu, par quelles passerelles et avec quel SNR">📶 Couverture mesurée de ce nœud</button>' : ''}
      ${n.lat != null && d.voisins.length ? '<button id="couverture">Liaisons mesurées</button>' : ''}
      ${n.lat != null ? `<button id="couv-relief">Couverture selon le relief</button><label class="champ-mini">antenne <input id="h-relief" type="number" min="0.5" max="80" step="0.5" value="${d.installation && d.installation.hauteur ? d.installation.hauteur : n.infrastructure ? 6 : 2}"> m</label>` : ''}
      ${gerable(n.num) && etat.config.radio && (!etat.radio || etat.radio.noeudLocal !== n.num) ? '<button id="tester">Tester (traceroute)</button>' : ''}
      ${gerable(n.num) ? '<button id="modifier-reglages">✏️ Modifier ses réglages</button><button id="administrer">Programmer ce nœud</button>' : ''}${etat.admin ? '<button id="ecrire">✉️ Message direct</button><button data-qr-reglages>🔳 QR code des réglages</button>' : ''}
    </div>
    <div id="retour-test" class="vide" hidden></div>
    </div>
    <div data-pf="telem" hidden>
    ${rendreSante(d.sante, n)}
    <h4>Évolution sur ${etat.config.retentionJours} jours</h4>
    ${courbe(d.telemetrie, 'tension', 'Tension', ' V', 2, s.tensionVolts) || ''}
    ${courbe(d.telemetrie, 'batterie', 'Batterie', ' %', 0) || ''}
    ${courbe(d.telemetrie, 'canal', 'Occupation du canal', ' %', 1, s.canalPourcent) || ''}
    ${courbe(d.telemetrie, 'emission', 'Temps d’émission', ' %', 2) || ''}
    ${courbe(d.telemetrie, 'temperature', 'Température', ' °C', 1) || ''}
    ${d.telemetrie.length < 2 ? '<div class="vide">Pas encore assez de télémétrie.</div>' : ''}
    </div>
    <div data-pf="voisins" hidden>
    <h4>Entendu par</h4>
    <div id="entendu-par"><div class="vide">Chargement…</div></div>
    <h4>Voisins radio (${d.voisins.length})</h4>
    ${voisins ? `<table class="voisins"><thead><tr><th>Nœud</th><th class="num">SNR reçu</th><th class="num">SNR émis</th><th class="num">km</th><th class="num">Part</th><th></th></tr></thead><tbody>${voisins}</tbody></table>` : '<div class="vide">Aucun lien direct connu.</div>'}
    </div>
    <div data-pf="config" hidden>
    <div class="grille">
      ${[['Rôle', n.roleFr], ['Matériel', n.materiel], ['Firmware', n.firmware], ['Preset LoRa', n.preset],
        ['Sauts au départ', d.paquets.find((p) => p.hop_depart) ? d.paquets.find((p) => p.hop_depart).hop_depart : null],
        ['Canaux utilisés', [...new Set(d.paquets.map((p) => p.canal).filter(Boolean))].join(', ')],
        ['Passerelle MQTT', n.passerelle ? (n.etatPasserelle === 'offline' ? 'oui, hors ligne' : 'oui, en ligne') : 'non'],
        ['Messages chiffrés PKI', d.paquets.some((p) => p.pki) ? 'oui (firmware ≥ 2.5)' : '–'],
        ['Vu la première fois', n.premierVu ? new Date(n.premierVu).toLocaleString('fr-FR') : null],
        ['Dernière position', n.heurePosition ? ilYa(n.heurePosition) : null]].map(([l, v]) => `<div class="mesure"><span>${l}</span><b>${esc(v ?? '–')}</b></div>`).join('')}
    </div>
    <p class="note">Valeurs déduites des trames entendues. Pour la configuration complète lue dans le nœud lui-même : onglet Programmer › Lire sa configuration (admin).</p>
    ${etat.admin ? '<div class="boutons"><button data-qr-reglages class="principal">🔳 QR code des réglages (canaux + radio)</button></div><p class="note">Le QR code reprend les canaux et le réglage LoRa du nœud : scanné par un autre module, il lui donne exactement la même configuration de canaux.</p>' : ''}
    </div>
    ${etat.membre ? `<div data-pf="install" hidden>${htmlInstallation(n, d.installation)}</div>` : ''}
    <div data-pf="trames" hidden>
    <div class="boutons"><button id="toutes-trames">📋 Toutes les trames, avec filtres</button></div>
    <div class="flux">${d.paquets.slice(0, 25).map((p) => lignePaquet({ ...p, passerelle: null }, false)).join('') || '<div class="vide">Aucun paquet.</div>'}</div>
    </div>`;
  $('#fiche-contenu').querySelectorAll('[data-of]').forEach((b) => (b.onclick = () => {
    $('#fiche-contenu').querySelectorAll('[data-of]').forEach((x) => x.classList.toggle('actif', x === b));
    $('#fiche-contenu').querySelectorAll('[data-pf]').forEach((x) => (x.hidden = x.dataset.pf !== b.dataset.of));
  }));
  $('#toutes-trames').onclick = () => ouvrirTrames(n.num);
  brancherInstallation(n, d.installation);
  chargerEntenduPar(n);
  $('#fiche-contenu').querySelectorAll('[data-qr-reglages]').forEach((b) => (b.onclick = () => ouvrirQr(n)));

  const centrer = $('#centrer');
  if (centrer) centrer.onclick = () => carte.flyTo([n.lat, n.lon], Math.max(carte.getZoom(), 12));
  const bmn = $('#mes-noeud'); if (bmn) bmn.onclick = () => couvertureMesuree(null, n.num);
  const bsr = $('#simu-retrait'); if (bsr) bsr.onclick = () => { etat.simu = { retirer: new Set([String(n.num)]), ajouter: [] }; simulation(); };
  const btnTrajet = $('#trajet');
  if (btnTrajet) btnTrajet.onclick = () => {
    if (etat.trajet) etat.trajet.remove();
    etat.trajet = L.polyline(d.trajet.map((p) => [p.lat, p.lon]), { color: '#ffd166', weight: 2.5, opacity: 0.9 }).addTo(carte);
    carte.fitBounds(etat.trajet.getBounds(), { padding: [60, 60] });
  };
  $('#fiche-contenu').querySelectorAll('tr[data-num]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('[data-profil]')) ouvrirFiche(Number(tr.dataset.num)); }));
  $('#fiche-contenu').querySelectorAll('[data-profil]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); ouvrirProfil(n.num, Number(b.dataset.profil)); }));
  const btnCouv = $('#couverture');
  if (btnCouv) btnCouv.onclick = () => afficherCouverture(n, d.voisins);
  const btnEcrire = $('#ecrire');
  if (btnEcrire) btnEcrire.onclick = () => {
    $('#panneau').classList.remove('replie'); $('#deplier').hidden = true;
    document.querySelector('.onglets button[data-onglet="messages"]').click();
    preparerEnvoi(n.num).then(() => $('#form-envoi').texte.focus());
  };
  const btnMod = $('#modifier-reglages');
  if (btnMod) btnMod.onclick = () => editeurReglages(n.num);
  const btnAdm = $('#administrer');
  if (btnAdm) btnAdm.onclick = () => {
    gestion.selection = new Set([n.num]);
    gestion.filtre = '';
    $('#panneau').classList.remove('replie'); $('#deplier').hidden = true;
    document.querySelector('.onglets button[data-onglet="gestion"]').click();
  };
  const btnRelief = $('#couv-relief');
  if (btnRelief) btnRelief.onclick = async () => {
    await voirCouvertureSite({ lat: n.lat, lon: n.lon }, n.nomLong || n.nomCourt || n.id, Number($('#h-relief').value) || 2, { cadrer: true });
    ajouterLiaisonsMesurees(n, d.voisins);
  };
  const btnTest = $('#tester');
  if (btnTest) btnTest.onclick = async () => {
    btnTest.disabled = true;
    const zoneRetour = $('#retour-test');
    zoneRetour.hidden = false;
    try {
      await api('/api/traceroute/' + n.num, { method: 'POST' });
      zoneRetour.textContent = 'Traceroute envoyé par le module de la maison. Réponse attendue sous 1 à 3 minutes…';
      let essais = 0;
      const suivi = setInterval(async () => {
        essais++;
        if (etat.selection !== num || essais > 12) return clearInterval(suivi);
        const dd = await api('/api/noeuds/' + num).catch(() => null);
        const t = dd && dd.sante && dd.sante.traceroutes[0];
        if (t && t.statut !== 'envoye') { clearInterval(suivi); ouvrirFiche(num); }
      }, 15000);
    } catch (err) {
      zoneRetour.textContent = 'Impossible : ' + err.message;
      btnTest.disabled = false;
    }
  };
}

// ---- Santé d'un nœud -------------------------------------------------------------
function rendreSante(sa, n) {
  if (!sa) return '';
  const pr = sa.prevision;
  const autonomie = pr && pr.heuresAvantSeuil != null ? (pr.heuresAvantSeuil > 72 ? `${Math.round(pr.heuresAvantSeuil / 24)} j` : `${pr.heuresAvantSeuil} h`) : '–';
  const tendance = pr ? { secteur: 'Secteur', charge: '↗ en charge', 'décharge': '↘ décharge', stable: '→ stable' }[pr.tendance] : '–';
  const jours = sa.jours.length
    ? `<table class="voisins"><thead><tr><th>Jour</th><th class="num">Min</th><th class="num">Max</th><th class="num">Recharge</th></tr></thead><tbody>${sa.jours.map((j) =>
        `<tr><td>${esc(j.jour)}</td><td class="num" style="color:${j.min < etat.config.seuils.tensionVolts ? 'var(--critique)' : 'inherit'}">${fmt(j.min, 2)}</td><td class="num" style="color:${j.max < etat.config.seuils.chargeSolaireVolts ? 'var(--attention)' : 'inherit'}">${fmt(j.max, 2)}</td><td class="num">${fmt(j.recharge, 2, ' V')}</td></tr>`).join('')}</tbody></table>`
    : '';
  const statuts = { repondu: ['✔', 'var(--ok)', 'répondu'], echec: ['✖', 'var(--critique)', 'échec'], sans_reponse: ['✖', 'var(--critique)', 'sans réponse'], envoye: ['…', 'var(--attention)', 'en attente'] };
  const trs = sa.traceroutes.length
    ? sa.traceroutes.slice(0, 8).map((t) => {
        const [ic, col, lib] = statuts[t.statut] || statuts.envoye;
        const chemin = t.chemin ? t.chemin.map((c, i) => `${i ? `<span class="snr" style="color:${couleurSnr(c.snr)}">${c.snr != null ? fmt(c.snr, 1) : '?'} dB →</span> ` : ''}${esc(c.nom)}`).join(' ') : esc(t.detail || lib);
        return `<div class="tr"><span style="color:${col}">${ic}</span> <small>${new Date(t.heure).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${t.declencheur === 'auto' ? 'auto' : 'manuel'}${t.duree ? ' · ' + Math.round(t.duree / 1000) + ' s' : ''}</small><div>${chemin}</div></div>`;
      }).join('')
    : '<div class="vide">Aucun traceroute pour l’instant.</div>';
  return `
    <h4>Santé sur 7 jours</h4>
    <div class="grille">
      <div class="mesure"><span>Disponibilité</span><b style="color:${sa.disponibilite < 80 ? 'var(--attention)' : 'inherit'}">${sa.disponibilite} %</b></div>
      <div class="mesure"><span>Redémarrages</span><b>${sa.redemarrages}</b></div>
      <div class="mesure"><span>Tendance tension</span><b>${tendance}</b></div>
      <div class="mesure"><span>Pente</span><b>${pr ? fmt(pr.penteVoltsParJour, 2, ' V/j') : '–'}</b></div>
      <div class="mesure"><span>Autonomie avant 3,3 V</span><b>${autonomie}</b></div>
      <div class="mesure"><span>Traceroutes réussis</span><b>${sa.tauxReponseTraceroute != null ? sa.tauxReponseTraceroute + ' %' : '–'}</b></div>
    </div>
    ${jours}
    <h4>Traceroutes</h4>
    <div class="traceroutes">${trs}</div>`;
}

// ---- Couverture radio d'un nœud ------------------------------------------------------
function afficherCouverture(n, voisins) {
  if (etat.coucheCouverture) { etat.coucheCouverture.remove(); etat.coucheCouverture = null; }
  const groupe = L.layerGroup();
  const pts = [[n.lat, n.lon]];
  for (const v of voisins) {
    const o = etat.noeuds.get(v.num);
    if (!o || o.lat == null) continue;
    const snr = v.snrEntendu ?? v.snrEmis;
    pts.push([o.lat, o.lon]);
    L.polyline([[n.lat, n.lon], [o.lat, o.lon]], { color: couleurSnr(snr), weight: 2, opacity: 0.8, pane: 'traces' }).addTo(groupe);
    L.circleMarker([o.lat, o.lon], { radius: 9, color: couleurSnr(snr), weight: 2, fillOpacity: 0.35, pane: 'traces' })
      .bindTooltip(`<b>${esc(v.nom)}</b><br>${v.distanceKm != null ? fmt(v.distanceKm, 1, ' km') : ''} · SNR ${fmt(snr, 1, ' dB')}`, { className: 'info' })
      .addTo(groupe);
  }
  const enveloppe = enveloppeConvexe(pts);
  if (enveloppe.length >= 3) L.polygon(enveloppe, { color: '#3ee6c4', weight: 1, dashArray: '4 4', fillOpacity: 0.06, pane: 'liens' }).addTo(groupe);
  groupe.addTo(carte);
  etat.coucheCouverture = groupe;
  carte.fitBounds(L.latLngBounds(pts), { padding: [80, 80] });
  $('#btn-effacer').hidden = false;
}
function enveloppeConvexe(points) {
  const p = points.map(([a, b]) => [b, a]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (p.length < 3) return points;
  const croix = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const bas = [], haut = [];
  for (const pt of p) { while (bas.length >= 2 && croix(bas[bas.length - 2], bas[bas.length - 1], pt) <= 0) bas.pop(); bas.push(pt); }
  for (const pt of p.slice().reverse()) { while (haut.length >= 2 && croix(haut[haut.length - 2], haut[haut.length - 1], pt) <= 0) haut.pop(); haut.push(pt); }
  return bas.slice(0, -1).concat(haut.slice(0, -1)).map(([x, y]) => [y, x]);
}

// ---- Profil de relief et bilan de liaison ---------------------------------------------
async function ouvrirProfil(a, b) {
  const dlg = $('#dlg-profil');
  const f = $('#form-profil');
  f.dataset.a = a;
  f.dataset.b = b;
  delete f.dataset.coords;
  const na = etat.noeuds.get(a), nb = etat.noeuds.get(b);
  f.ha.value = na && na.infrastructure ? 6 : 3;
  f.hb.value = nb && nb.infrastructure ? 6 : 3;
  if (etat.radio && etat.radio.preset) f.preset.value = etat.radio.preset;
  if (!dlg.open) dlg.showModal();
  await calculerProfil();
}
async function calculerProfil() {
  const f = $('#form-profil');
  const sortie = $('#profil-resultat');
  sortie.innerHTML = '<div class="vide">Calcul du profil (altitudes IGN)…</div>';
  const ext = f.dataset.coords ? JSON.parse(f.dataset.coords) : { a: f.dataset.a, b: f.dataset.b };
  const qs = new URLSearchParams({ ...ext, ha: f.ha.value, hb: f.hb.value, ptx: f.ptx.value, ga: f.ga.value, gb: f.ga.value, pertes: f.pertes.value, preset: f.preset.value });
  let r;
  try { r = await api('/api/profil?' + qs); } catch (e) { sortie.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const b = r.bilan;
  const coul = b.marge >= 10 ? 'var(--ok)' : b.marge >= 0 ? 'var(--attention)' : 'var(--critique)';
  const mes = (m) => (m ? `${fmt(m.snr, 1, ' dB')} <small>(${m.source === 'rf' ? 'radio' : m.source}, ${m.nb} obs.)</small>` : '–');
  sortie.innerHTML = `
    <div class="profil-titre"><b>${esc(r.a.nom)}</b> → <b>${esc(r.b.nom)}</b> · ${fmt(r.distanceKm, 2, ' km')} · ${esc(r.preset)}</div>
    ${graphiqueProfil(r)}
    <div class="verdict" style="border-color:${coul}">${esc(r.verdict)}</div>
    <div class="grille">
      <div class="mesure"><span>Affaiblissement espace libre</span><b>${fmt(b.fspl, 1, ' dB')}</b></div>
      <div class="mesure"><span>Perte de diffraction</span><b>${fmt(b.diffraction, 1, ' dB')}</b></div>
      <div class="mesure"><span>Puissance reçue estimée</span><b>${fmt(b.puissanceRecue, 1, ' dBm')}</b></div>
      <div class="mesure"><span>Sensibilité (${esc(r.preset)})</span><b>${fmt(b.sensibilite, 1, ' dBm')}</b></div>
      <div class="mesure"><span>SNR estimé</span><b>${fmt(b.snrEstime, 1, ' dB')}</b></div>
      <div class="mesure"><span>Marge de liaison</span><b style="color:${coul}">${fmt(b.marge, 1, ' dB')}</b></div>
      ${r.a.num != null && r.b.num != null ? `<div class="mesure"><span>SNR mesuré ${esc(r.a.nom.slice(0, 10))} → ${esc(r.b.nom.slice(0, 10))}</span><b>${mes(r.mesure.aVersB)}</b></div>
      <div class="mesure"><span>SNR mesuré ${esc(r.b.nom.slice(0, 10))} → ${esc(r.a.nom.slice(0, 10))}</span><b>${mes(r.mesure.bVersA)}</b></div>` : ''}
      <div class="mesure"><span>Obstacle principal</span><b>à ${fmt(r.obstacle.distanceKm, 1, ' km')} · ${r.obstacle.degagementM >= 0 ? `dégagement ${fmt(r.obstacle.degagementM, 0, ' m')}` : `dépasse la visée de ${fmt(-r.obstacle.degagementM, 0, ' m')}`}</b></div>
    </div>
    <p class="note">Survolez le profil pour lire l’altitude ; cliquez pour voir l’endroit sur la carte.</p>
    <p class="note">Altitudes : ${esc(r.sourceAltitude)} · terre à 4/3 du rayon réel · 1re zone de Fresnel à ${r.parametres.frequenceMHz} MHz · diffraction lame de couteau (ITU-R P.526) · bruit −174 dBm/Hz + 6 dB. Estimation indicative : la végétation et le bâti ne sont pas modélisés.</p>`;
  brancherCurseurProfil(r);
}
function graphiqueProfil(r) {
  const W = 640, H = 220, m = { g: 44, d: 10, h: 10, b: 24 };
  const s = r.serie, D = s[s.length - 1].d || 1;
  const zmin = Math.min(...s.map((p) => Math.min(p.solCourbe, p.visee - p.fresnel))) - 20;
  const zmax = Math.max(...s.map((p) => Math.max(p.solCourbe, p.visee))) + 30;
  const x = (d) => m.g + (d / D) * (W - m.g - m.d);
  const y = (z) => H - m.b - ((z - zmin) / (zmax - zmin)) * (H - m.h - m.b);
  const sol = `M${x(0)},${H - m.b} ` + s.map((p) => `L${x(p.d).toFixed(1)},${y(p.solCourbe).toFixed(1)}`).join(' ') + ` L${x(D)},${H - m.b} Z`;
  const visee = `M${x(0)},${y(s[0].visee)} L${x(D)},${y(s[s.length - 1].visee)}`;
  const fres = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.visee - p.fresnel).toFixed(1)}`).join(' ');
  const fres60 = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.visee - 0.6 * p.fresnel).toFixed(1)}`).join(' ');
  const ob = s.reduce((a, p) => (p.visee - p.solCourbe < a.visee - a.solCourbe ? p : a), s[Math.floor(s.length / 2)]);
  const grad = [];
  const pas = Math.pow(10, Math.floor(Math.log10(zmax - zmin))) / 2 || 50;
  for (let z = Math.ceil(zmin / pas) * pas; z <= zmax; z += pas) grad.push(`<line x1="${m.g}" x2="${W - m.d}" y1="${y(z)}" y2="${y(z)}" class="grille-svg"/><text x="${m.g - 4}" y="${y(z) + 3}" text-anchor="end">${Math.round(z)}</text>`);
  const kms = [];
  const pasKm = D > 20000 ? 5000 : D > 8000 ? 2000 : 1000;
  for (let d = 0; d <= D; d += pasKm) kms.push(`<text x="${x(d)}" y="${H - 8}" text-anchor="middle">${d / 1000} km</text>`);
  return `<svg class="profil" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil de relief">
    ${grad.join('')}${kms.join('')}
    <path d="${sol}" class="sol"/>
    <path d="${fres}" class="fresnel"/><path d="${fres60}" class="fresnel60"/>
    <path d="${visee}" class="visee"/>
    <circle cx="${x(0)}" cy="${y(s[0].visee)}" r="4" class="ant"/><circle cx="${x(D)}" cy="${y(s[s.length - 1].visee)}" r="4" class="ant"/>
    <circle cx="${x(ob.d)}" cy="${y(ob.solCourbe)}" r="4" class="obstacle"/>
    <g class="curseur-profil" visibility="hidden"><line y1="${m.h}" y2="${H - m.b}"/><circle r="4"/><rect class="fond-info" rx="4" height="30"/><text class="info-l1"></text><text class="info-l2"></text></g>
    <rect class="zone-profil" x="${m.g}" y="${m.h}" width="${W - m.g - m.d}" height="${H - m.h - m.b}" fill="transparent"/>
  </svg>`;
}

// Survol et clic sur le profil : altitude du point, puis localisation sur la carte
function brancherCurseurProfil(r) {
  const svg = document.querySelector('#profil-resultat svg.profil');
  if (!svg) return;
  const W = 640, H = 220, m = { g: 44, d: 10, h: 10, b: 24 };
  const s = r.serie, D = s[s.length - 1].d || 1;
  const zmin = Math.min(...s.map((p) => Math.min(p.solCourbe, p.visee - p.fresnel))) - 20;
  const zmax = Math.max(...s.map((p) => Math.max(p.solCourbe, p.visee))) + 30;
  const x = (d) => m.g + (d / D) * (W - m.g - m.d);
  const y = (z) => H - m.b - ((z - zmin) / (zmax - zmin)) * (H - m.h - m.b);
  const g = svg.querySelector('.curseur-profil'), zone = svg.querySelector('.zone-profil');
  const point = (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const v = pt.matrixTransform(svg.getScreenCTM().inverse());
    const d = Math.max(0, Math.min(D, ((v.x - m.g) / (W - m.g - m.d)) * D));
    let k = 0; while (k < s.length - 1 && s[k + 1].d < d) k++;
    const p = s[Math.min(k + (d - s[k].d > (s[Math.min(k + 1, s.length - 1)].d - d) ? 1 : 0), s.length - 1)];
    const f = p.d / D;
    return { ...p, f, lat: r.a.lat + (r.b.lat - r.a.lat) * f, lon: r.a.lon + (r.b.lon - r.a.lon) * f };
  };
  zone.addEventListener('mousemove', (ev) => {
    const p = point(ev);
    const px = x(p.d), py = y(p.solCourbe);
    g.setAttribute('visibility', 'visible');
    g.querySelector('line').setAttribute('x1', px); g.querySelector('line').setAttribute('x2', px);
    g.querySelector('circle').setAttribute('cx', px); g.querySelector('circle').setAttribute('cy', py);
    const deg = p.visee - p.solCourbe;
    const l1 = `${(p.d / 1000).toFixed(2).replace('.', ',')} km · sol ${Math.round(p.sol)} m`;
    const l2 = deg >= 0 ? `visée ${Math.round(deg)} m au-dessus` : `relief ${Math.round(-deg)} m au-dessus de la visée`;
    const larg = Math.max(l1.length, l2.length) * 5.6 + 12;
    const bx = px + larg + 8 > W ? px - larg - 6 : px + 6;
    const fond = g.querySelector('.fond-info');
    fond.setAttribute('x', bx); fond.setAttribute('y', m.h + 2); fond.setAttribute('width', larg);
    const t1 = g.querySelector('.info-l1'), t2 = g.querySelector('.info-l2');
    t1.setAttribute('x', bx + 6); t1.setAttribute('y', m.h + 14); t1.textContent = l1;
    t2.setAttribute('x', bx + 6); t2.setAttribute('y', m.h + 26); t2.textContent = l2;
    t2.setAttribute('class', 'info-l2' + (deg < 0 ? ' mauvais' : ''));
  });
  zone.addEventListener('mouseleave', () => g.setAttribute('visibility', 'hidden'));
  zone.addEventListener('click', (ev) => {
    const p = point(ev);
    $('#dlg-profil').close();
    if (etat.coucheProfil) etat.coucheProfil.remove();
    const grp = L.layerGroup().addTo(carte);
    etat.coucheProfil = grp;
    L.polyline([[r.a.lat, r.a.lon], [r.b.lat, r.b.lon]], { color: '#3ee6c4', weight: 2.5, dashArray: '6 6', pane: 'traces' }).addTo(grp);
    for (const [q, nom] of [[r.a, 'A'], [r.b, 'B']]) L.circleMarker([q.lat, q.lon], { radius: 6, color: '#3ee6c4', weight: 2, fillOpacity: 0.6, pane: 'traces' }).bindTooltip(`${nom} · ${esc(q.nom)}`, { className: 'info' }).addTo(grp);
    const deg = p.visee - p.solCourbe;
    const div = document.createElement('div');
    div.className = 'popup-lieu';
    div.innerHTML = `<b>${(p.d / 1000).toFixed(2).replace('.', ',')} km depuis A</b>
      <div class="meta-longue">Sol ${Math.round(p.sol)} m · ${deg >= 0 ? `visée ${Math.round(deg)} m au-dessus du relief` : `<span style="color:var(--critique)">relief ${Math.round(-deg)} m au-dessus de la visée</span>`}</div>
      ${blocCoords(p.lat, p.lon, { alt: p.sol })}
      <div class="menu-contexte"><button data-a="retour">↩ Revenir au profil</button><button data-a="effacer">Effacer le tracé</button></div>`;
    div.onclick = (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      if (b.dataset.a === 'retour') { carte.closePopup(); $('#dlg-profil').showModal(); }
      else { grp.remove(); etat.coucheProfil = null; }
    };
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces', zIndexOffset: 1000 })
      .addTo(grp).bindPopup(div, { className: 'popup-contexte', maxWidth: 340, minWidth: 280 }).openPopup();
    carte.fitBounds(L.latLngBounds([[r.a.lat, r.a.lon], [r.b.lat, r.b.lon]]), { padding: [60, 60] });
    setTimeout(() => carte.flyTo([p.lat, p.lon], Math.max(carte.getZoom(), 13), { duration: 0.8 }), 600);
  });
}

// ---- Analyse du trafic -----------------------------------------------------------------
// ---- Maintenance : charge radio, autonomie, firmwares, rôles (onglet Statistiques) ----------------------
const ROLES_LIB = { CLIENT: 'Client', CLIENT_MUTE: 'Client muet', CLIENT_HIDDEN: 'Client caché', CLIENT_BASE: 'Client de base', ROUTER: 'Routeur', ROUTER_LATE: 'Routeur tardif', REPEATER: 'Répéteur', ROUTER_CLIENT: 'Routeur-client (obsolète)', TRACKER: 'Traceur', SENSOR: 'Capteur', TAK: 'TAK', TAK_TRACKER: 'TAK traceur', LOST_AND_FOUND: 'Objet perdu', inconnu: 'Inconnu' };
async function chargerMaintenance(quoi) {
  if (!etat.membre) { $('#m-' + quoi).innerHTML = '<div class="vide">Connexion requise.</div>'; return; }
  const z = $('#m-' + quoi), r$ = $('#r-m-' + quoi);
  z.innerHTML = '<div class="vide">Chargement…</div>';
  let r;
  try { r = await api('/api/maintenance/' + quoi); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const pt = (niv) => `<span class="point ${niv === 'critique' ? 'alerte' : niv === 'attention' ? 'attention' : 'actif'}"></span>`;
  const clic = () => z.querySelectorAll('[data-fiche]').forEach((el) => (el.onclick = () => ouvrirFiche(Number(el.dataset.fiche))));
  if (quoi === 'charge') {
    const pb = r.filter((x) => x.niveau !== 'ok').length;
    r$.textContent = r.length ? `${r.length} relais${pb ? ` · ${pb} à surveiller` : ''}` : 'aucune donnée';
    z.innerHTML = r.length ? r.map((x) => `<div class="ligne maint-ligne" data-fiche="${x.num}">${pt(x.niveau)}<span class="titre">${esc(x.nom)}<small>émission ${fmt(x.emission24, 2, ' %')} en moyenne sur 24 h (max ${fmt(x.emissionMax24, 1, ' %')}) · canal ${fmt(x.canal24, 1, ' %')} (max ${fmt(x.canalMax24, 1, ' %')})${x.joursAvantLimite != null ? ` · <b style="color:var(--attention)">atteindrait 10 % d’émission dans ~${x.joursAvantLimite} j</b>` : x.tendanceEmission > 0.05 ? ` · en hausse (+${fmt(x.tendanceEmission, 2)} %/j)` : ''}</small></span><span class="meta">${fmt(x.emission, 1, ' %')}</span>
      <span class="sous-ligne">${courbe(x.serie, 'emission', 'Temps d’émission (7 j)', ' %', 1, 10) || ''}</span></div>`).join('')
      + `<p class="note">Temps d’émission : part du temps où le relais émet ; la limite réglementaire est de 10 % par heure dans la sous-bande 869,4–869,65 MHz. Occupation du canal : part du temps où le relais entend quelqu’un émettre (au-delà de ${etat.config.seuils.canalPourcent} %, les collisions augmentent). Tendance calculée sur 7 jours.</p>`
      : '<div class="vide">Aucune télémétrie des relais de la zone.</div>';
  } else if (quoi === 'autonomie') {
    const pb = r.filter((x) => x.etat === 'critique' || x.etat === 'attention').length;
    r$.textContent = r.length ? `${r.length} relais${pb ? ` · ${pb} à surveiller` : ''}` : 'aucune donnée';
    const lib = { secteur: '🔌 secteur', solaire: '☀️ solaire', batterie: '🔋 batterie', 'secteur+batterie': '🔌 + 🔋', 'solaire+batterie': '☀️ + 🔋', autre: 'autre' };
    z.innerHTML = r.length ? r.map((x) => `<div class="ligne" data-fiche="${x.num}">${pt(x.etat === 'secteur' || x.etat === 'inconnu' ? 'ok' : x.etat === 'ok' ? 'ok' : x.etat)}<span class="titre">${esc(x.nom)}<small>${x.alimentation ? lib[x.alimentation] || esc(x.alimentation) : 'alimentation non renseignée'}${x.tension != null ? ` · ${fmt(x.tension, 2, ' V')}` : ''}${x.dechargeVparJour != null ? ` · décharge ${fmt(x.dechargeVparJour, 3, ' V/j')}` : ''}${x.rechargeV != null ? ` · recharge ${fmt(x.rechargeV, 2, ' V/j')}` : ''}${x.pasDeCharge ? ' · <b style="color:var(--attention)">ne se recharge plus</b>' : ''}</small></span><span class="meta">${x.etat === 'secteur' ? '∞' : x.joursSansSoleil != null ? `<b>${fmt(x.joursSansSoleil, 1)} j</b>` : '–'}</span></div>`).join('')
      + '<p class="note">« Jours sans soleil » : temps avant 3,3 V si le panneau ne charge plus, d’après la décharge mesurée la nuit (21 h – 6 h) sur 7 jours. Renseignez l’alimentation dans la fiche Installation de chaque relais.</p>'
      : '<div class="vide">Aucune télémétrie de tension pour les relais de la zone.</div>';
  } else if (quoi === 'firmwares') {
    const ref = r.reference && r.reference.stable;
    const ret = r.noeuds.filter((x) => x.etat === 'ancien' || x.etat === 'retard').length;
    r$.textContent = ref ? `référence ${ref.v.join('.')}${ret ? ` · ${ret} en retard` : ''}` : `${r.noeuds.length} nœuds`;
    const lib = { 'a-jour': ['✔', 'à jour'], retard: ['↻', 'en retard'], ancien: ['⚠', 'ancien'], connu: ['?', 'référence indisponible'], inconnu: ['–', 'version inconnue'] };
    z.innerHTML = `${ref ? `<p class="note">Dernière version stable : <a href="${esc(ref.url)}" target="_blank" rel="noopener">${esc(ref.tag)}</a> (${new Date(ref.date).toLocaleDateString('fr-FR')})${r.reference.test && r.reference.test.tag !== ref.tag ? ` · en test : ${esc(r.reference.test.tag)}` : ''}.</p>` : '<p class="note">Version de référence indisponible (GitHub injoignable).</p>'}
      <div class="rang">${Object.entries(r.parVersion).sort((a, b) => b[1] - a[1]).map(([v, n]) => `<span class="pastille">${esc(v)} : ${n}</span>`).join(' ')}</div>
      ${r.noeuds.map((x) => `<div class="ligne" data-fiche="${x.num}"><span class="etat-fw ${x.etat}">${lib[x.etat][0]}</span><span class="titre">${esc(x.nom)}<small>${esc(x.materiel || '')}${x.version ? ' · ' + esc(x.version) : ''}${x.retard ? ' · ' + esc(x.retard) + ' de retard' : ''}</small></span><span class="meta">${lib[x.etat][1]}</span></div>`).join('')}
      <p class="note">La version vient des annonces des nœuds (rapport de carte) ou d’une lecture de configuration. Un firmware Meshtastic ne se met pas à jour par LoRa : il faut passer sur place (USB, ou Wi-Fi/Bluetooth selon le modèle) avec le flasheur (menu Outils). Les fiches Installation donnent l’accès et le contact de chaque site.</p>`;
  } else if (quoi === 'roles') {
    r$.textContent = r.conseils.length ? `${r.conseils.length} conseil${r.conseils.length > 1 ? 's' : ''}` : 'rien à signaler';
    z.innerHTML = `<div class="rang">${Object.entries(r.repartition).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="pastille">${esc(ROLES_LIB[k] || k)} : ${n}</span>`).join(' ')}</div>
      ${r.conseils.map((c) => `<div class="proposition conseil-role ${c.niveau}" data-fiche="${c.num}"><div class="entete-prop"><b>${esc(c.nom)}</b><span class="marge">${esc(ROLES_LIB[c.role] || c.role)} → <b>${esc(c.conseil)}</b></span></div><div class="meta-longue">${esc(c.raison)}</div></div>`).join('') || '<div class="vide">Aucun conseil : les rôles paraissent cohérents.</div>'}
      <p class="note">Conseils calculés d’après la couverture de chaque relais (relief)${r.relief ? '' : ' — <b>relief pas encore prêt : conseils partiels</b>'}, la densité de routeurs et les meilleurs points hauts. Pour changer un rôle : fiche du nœud › Modifier ses réglages, ou onglet Programmer.</p>`;
  }
  clic();
}
document.addEventListener('toggle', (e) => { const d = e.target; if (d.matches && d.matches('details.maint') && d.open) chargerMaintenance(d.dataset.maint); }, true);

// ---- Historique long (résumés horaires / journaliers) ------------------------------------------------
async function chargerHistorique() {
  const z = $('#historique');
  if (!z) return;
  const jours = Number(localStorage.getItem('gaulix_histo_jours')) || 30;
  let r;
  try { r = await api('/api/historique?jours=' + jours); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const p = r.points;
  const dernier = p[p.length - 1] || {};
  $('#resume-historique').textContent = p.length ? `${jours} j · ${p.length} point${p.length > 1 ? 's' : ''}` : 'en cours de constitution';
  const s = etat.config.seuils;
  const unite = r.pas === 'jour' ? 'jour' : 'heure';
  const c = (cle, lib, u, dec, seuil) => courbe(p, cle, lib, u, dec, seuil) || '';
  z.innerHTML = `<div class="parametres compact"><label>Période <select id="histo-jours">${[[2, '48 h'], [7, '7 jours'], [30, '30 jours'], [90, '3 mois'], [365, '1 an']].map(([v, t]) => `<option value="${v}" ${v === jours ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    ${p.length < 2 ? '<div class="vide">L’historique se constitue : un point par heure. Les courbes apparaissent après quelques heures.</div>' : `
    ${c('mt_actifs_zone', `Nœuds Meshtastic actifs (${esc(etat.config.zoneNom)})`, '', 0)}
    ${c('mt_passerelles', 'Passerelles MQTT en ligne', '', 0)}
    ${c('mt_paquets', `Paquets Meshtastic par ${unite}`, '', 0)}
    ${c('mt_canal_moyen', 'Occupation moyenne du canal', ' %', 1, s.canalPourcent)}
    ${c('couverture_pct', 'Couverture calculée du département', ' %', 1)}
    ${c('mc_noeuds_actifs', 'Nœuds MeshCore actifs', '', 0)}
    ${c('mc_paquets', `Paquets MeshCore par ${unite}`, '', 0)}`}
    <p class="note">Un résumé par heure, et par jour au-delà de 7 jours, conservé plus d’un an (les données détaillées, elles, sont purgées après ${etat.config.retentionJours} jours). Base de données : ${r.base.totalMo} Mo, dont ${r.base.libreMo} Mo de place libérée ; compactage automatique le dimanche vers 4 h quand c’est utile.</p>
    ${etat.admin && r.base.libreMo > 50 ? `<div class="actions-prop"><button id="histo-compacter">Compacter la base maintenant (${r.base.libreMo} Mo à récupérer)</button></div>` : ''}`;
  $('#histo-jours').onchange = (e) => { try { localStorage.setItem('gaulix_histo_jours', e.target.value); } catch { /* ignoré */ } chargerHistorique(); };
  const bc = $('#histo-compacter');
  if (bc) bc.onclick = async () => {
    if (!confirm('Compacter la base ? La carte ne répond plus pendant quelques minutes (selon la taille).')) return;
    bc.disabled = true; bc.textContent = 'Compactage en cours…';
    try { const x = await postJson('/api/historique/compacter', {}); alert(`Base compactée : ${x.avantMo} → ${x.apresMo} Mo en ${x.dureeS} s`); } catch (err) { alert(err.message); }
    chargerHistorique();
  };
}
async function chargerAnalyse() {
  const zone = $('#analyse');
  zone.innerHTML = '<div class="vide">Analyse en cours…</div>';
  let r;
  try { r = await api(`/api/analyse?heures=${$('#analyse-periode').value}&zone=${etat.zoneMode === 'voisins' ? 'v' : etat.zone ? 1 : 0}`); } catch (e) { zone.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const max = Math.max(1, ...r.sauts.map((x) => x.nb));
  const signalements = r.noeuds.filter((n) => n.alertes.length);
  zone.innerHTML = `
    <div class="grille">
      <div class="mesure"><span>Paquets d’origine</span><b>${r.totalPaquets}</b></div>
      <div class="mesure"><span>Occupation estimée</span><b>${fmt(r.occupationEstimeePct, 2, ' %')}</b></div>
      <div class="mesure"><span>Preset</span><b>${esc(r.preset)}</b></div>
      <div class="mesure"><span>Temps d’une trame de 50 o</span><b>${fmt(r.tempsTrame50Octets * 1000, 0, ' ms')}</b></div>
      <div class="mesure"><span>Paramètres</span><b>SF${r.parametres.sf} · ${r.parametres.bw} kHz · 4/${r.parametres.cr}</b></div>
      <div class="mesure"><span>Signalements</span><b style="color:${r.nbAlertes ? 'var(--attention)' : 'inherit'}">${r.nbAlertes}</b></div>
    </div>
    <p class="note">Temps d’émission estimé pour la seule émission d’origine (les réémissions des relais s’y ajoutent), d’après la taille réelle des paquets reçus.</p>
    <h3>Signalements</h3>
    ${signalements.length ? signalements.map((n) => `<div class="alerte ${n.alertes.some((a) => a.niveau === 'critique') ? 'critique' : ''}" data-num="${n.num}"><b>${esc(n.nom)}</b>${n.alertes.map((a) => `<small>• ${esc(a.texte)}</small>`).join('')}</div>`).join('') : '<div class="vide">Aucun réglage suspect détecté.</div>'}
    <h3>Plus gros émetteurs</h3>
    <table class="voisins analyse"><thead><tr><th>Nœud</th><th class="num">Pq/h</th><th class="num">Canal</th><th class="num">Sauts max</th><th class="num">Récept.</th></tr></thead><tbody>
    ${r.noeuds.slice(0, 25).map((n) => `<tr data-num="${n.num}"><td>${esc(n.nom)}<small> ${esc(n.role || '')}</small></td><td class="num">${fmt(n.parHeure, 1)}</td><td class="num">${fmt(n.airtimePct, 2, ' %')}</td><td class="num" style="color:${n.hopMax > 3 ? 'var(--attention)' : 'inherit'}">${n.hopMax || '–'}</td><td class="num">${n.redondance ?? '–'}</td></tr>`).join('')}
    </tbody></table>
    <h3>Répartition par nombre de sauts</h3>
    <div class="repartition">${r.sauts.sort((a, b) => (a.sauts ?? 99) - (b.sauts ?? 99)).map((x) => `<div class="barre-port"><span>${x.sauts == null ? 'inconnu' : x.sauts === 0 ? 'direct' : x.sauts + ' saut' + (x.sauts > 1 ? 's' : '')}</span><div class="piste"><i style="width:${(x.nb / max) * 100}%;background:#4cc9f0"></i></div><span class="nb">${x.nb}</span></div>`).join('')}</div>
    <h3>Canaux</h3>
    <table class="voisins"><thead><tr><th>Canal</th><th class="num">Paquets</th><th class="num">Déchiffrés</th></tr></thead><tbody>
    ${r.canaux.map((c) => `<tr><td>${esc(c.canal || '?')}</td><td class="num">${c.nb}</td><td class="num">${c.nb ? Math.round((c.dechiffres / c.nb) * 100) : 0} %</td></tr>`).join('')}
    </tbody></table>`;
  zone.querySelectorAll('tr[data-num]').forEach((tr) => (tr.onclick = () => ouvrirFiche(Number(tr.dataset.num))));
}

// ---- Rejeu des dernières 24 h ------------------------------------------------------------
async function demarrerRejeu() {
  const barre = $('#rejeu');
  barre.hidden = false;
  $('#rejeu-heure').textContent = 'Chargement…';
  const fin = Date.now(), debut = fin - 24 * 3600000;
  const evts = await api(`/api/rejeu?debut=${debut}&fin=${fin}`);
  etat.rejeu = { actif: false, evts, debut, fin, t: debut, index: 0, minuterie: null };
  $('#rejeu-curseur').min = debut;
  $('#rejeu-curseur').max = fin;
  $('#rejeu-curseur').value = debut;
  $('#rejeu-info').textContent = `${evts.length} réceptions sur 24 h`;
  majRejeu();
  lireRejeu(true);
}
function majRejeu() {
  const r = etat.rejeu;
  if (!r) return;
  $('#rejeu-heure').textContent = new Date(r.t).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  $('#rejeu-curseur').value = r.t;
  $('#rejeu-lecture').textContent = r.actif ? '❚❚' : '▶';
}
function placerRejeu(t) {
  const r = etat.rejeu;
  r.t = t;
  let i = 0;
  while (i < r.evts.length && r.evts[i].heure < t) i++;
  r.index = i;
  majRejeu();
}
function lireRejeu(lecture) {
  const r = etat.rejeu;
  if (!r) return;
  r.actif = lecture;
  clearInterval(r.minuterie);
  if (lecture) {
    r.minuterie = setInterval(() => {
      const pas = Number($('#rejeu-vitesse').value) * 0.2 * 1000;
      const t2 = Math.min(r.t + pas, r.fin);
      let n = 0;
      while (r.index < r.evts.length && r.evts[r.index].heure <= t2) {
        if (n++ < 40) animerPaquet(r.evts[r.index], true);
        r.index++;
      }
      r.t = t2;
      if (t2 >= r.fin) lireRejeu(false);
      majRejeu();
    }, 200);
  }
  majRejeu();
}
function fermerRejeu() {
  if (etat.rejeu) clearInterval(etat.rejeu.minuterie);
  etat.rejeu = null;
  $('#rejeu').hidden = true;
}

// ---- Relief : points hauts, meilleurs sites, couverture d'un point -------------------------------
const nomSommet = (s) => s.nom || (s.commune ? `Point haut · ${s.commune}` : `Point haut ${s.alt} m`);
const couleurMarge = (m) => (m >= 10 ? 'var(--ok)' : m >= 0 ? 'var(--attention)' : 'var(--critique)');
const hexMarge = (m) => (m >= 10 ? '#3ee6c4' : m >= 0 ? '#f4d35e' : '#ff5c6c');

// ---- Accès aux points hauts (OSM : route, piste 4×4, sentier) ----------------------------
const ACCES = {
  voiture: { icone: '🚗', nom: 'en voiture' }, '4x4': { icone: '🚙', nom: 'en 4×4 (piste)' }, pied: { icone: '🥾', nom: 'à pied (sentier)' }, aucun: { icone: '⛰️', nom: 'hors chemin' },
};
const NIV_ACCES = { tous: 0, pied: 1, '4x4': 2, voiture: 3 };
etat.filtreAcces = (() => { try { return localStorage.getItem('gaulix_acces') || 'tous'; } catch { return 'tous'; } })();
// Numéros des sites recommandés sur la carte : ceux du plan affiché (filtré ou non par l'accès)
function appliquerPlan() {
  const rangs = new Map(((etat.classement && etat.classement.plan) || []).map((p) => [p.id, p.rang]));
  for (const s of etat.sommets || []) s.rangPlan = rangs.get(s.id) || null;
}
const accesOk = (s) => etat.filtreAcces === 'tous' || (s.acces && s.acces.niveau >= NIV_ACCES[etat.filtreAcces]);
const badgeAcces = (s) => (s.acces ? `<span class="acces-badge" title="Accès ${esc(ACCES[s.acces.type].nom)}">${ACCES[s.acces.type].icone}</span>` : '');
// Site réaliste : support existant, zone protégée, électricité (OpenStreetMap)
function texteRealisme(re) {
  if (!re) return 'non évalué (recherche OpenStreetMap en cours ou indisponible)';
  const parts = [];
  if (re.protege) parts.push(`⛔ dans « ${esc(re.protege.nom)} » (${esc(re.protege.type)}) : autorisation difficile`);
  if (re.support) parts.push(`🗼 ${esc(re.support.type)}${re.support.nom ? ' « ' + esc(re.support.nom) + ' »' : ''} à ${re.support.distance} m${re.support.operateur ? ' (' + esc(re.support.operateur) + ')' : ''} : support possible`);
  parts.push(`⚡ ${re.electricite === 'secteur probable' ? 'secteur probable' : re.electricite === 'secteur à vérifier' ? 'secteur à vérifier' : 'solaire à prévoir'}${re.habitation ? ` (${re.habitation.nom ? esc(re.habitation.nom) + ' à ' : 'habitation à '}${re.habitation.distance < 1000 ? re.habitation.distance + ' m' : fmt(re.habitation.distance / 1000, 1, ' km')})` : ''}`);
  return parts.join(' · ');
}
function texteAcces(a) {
  if (!a) return 'non évalué (recherche OpenStreetMap en cours ou indisponible)';
  const d = a.distances, m = (x) => (x < 1000 ? x + ' m' : fmt(x / 1000, 1, ' km'));
  const parts = [];
  if (d.voiture != null) parts.push(`route à ${m(d.voiture)}${a.nomVoie ? ' (' + esc(a.nomVoie) + ')' : ''}`);
  if (d['4x4'] != null && d['4x4'] !== d.voiture) parts.push(`piste à ${m(d['4x4'])}`);
  if (d.pied != null && d.pied !== d['4x4']) parts.push(`sentier à ${m(d.pied)}`);
  if (a.prive != null) parts.push(`voie privée à ${m(a.prive)}`);
  return `<b>${ACCES[a.type].icone} ${ACCES[a.type].nom}</b>${parts.length ? ' · ' + parts.join(' · ') : ' · aucune voie à moins de 400 m'}`;
}

etat.depEtude = (() => { try { return localStorage.getItem('gaulix_dep_etude') || null; } catch { return null; } })();
let jetonRelief = 0;
async function chargerRelief(recadrer) {
  const jeton = ++jetonRelief;
  clearTimeout(etat.minuterieRelief);
  let e;
  try { e = await api('/api/relief/etat'); } catch { return; }
  if (jeton !== jetonRelief) return;
  etat.relief = e;
  if (recadrer && e.zone) carte.fitBounds([[e.zone[0], e.zone[1]], [e.zone[2], e.zone[3]]], { padding: [20, 20] });
  if (e.mnt !== 'pret' || e.classement !== 'pret') etat.minuterieRelief = setTimeout(() => chargerRelief(), e.mnt === 'pret' ? 15000 : 5000);
  else if (etat.classement && etat.classement.acces && etat.classement.acces.enCours) etat.minuterieRelief = setTimeout(() => chargerRelief(), 30000);
  if (e.mnt === 'pret') {
    const [sommets, classement] = await Promise.all([api('/api/relief/sommets'), api('/api/relief/classement?acces=' + etat.filtreAcces)]).catch(() => [[], null]);
    if (jeton !== jetonRelief) return;
    etat.sommets = sommets;
    etat.classement = classement && !classement.attente ? classement : null;
    appliquerPlan();
    dessinerSommets();
  }
  rendreSites();
}

function iconeSommet(s) {
  if (s.rangPlan) return L.divIcon({ className: 'sommet plan', html: `<span>${s.rangPlan}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  const fort = s.rang && s.rang <= 15;
  return L.divIcon({ className: 'sommet' + (fort ? ' fort' : '') + (s.source === 'mnt' ? ' mnt' : ''), html: '▲', iconSize: [12, 12], iconAnchor: [6, 8] });
}
function infoSommet(s) {
  return `<b>${esc(nomSommet(s))}</b><br>${s.alt} m${s.dominance != null ? ` · domine de ${s.dominance} m` : ''}` +
    (s.couverturePct != null ? `<br>Couverture seule : ${fmt(s.couverturePct, 1, ' %')} du département (${s.couvertureKm2} km²)` : '') +
    (s.rangPlan ? `<br><b style="color:#f4c542">Site recommandé n° ${s.rangPlan}</b>` : s.rang && s.rang <= 15 ? `<br>Classement individuel : ${s.rang}ᵉ` : '') +
    (s.acces ? `<br>Accès : ${ACCES[s.acces.type].icone} ${ACCES[s.acces.type].nom}` : '') +
    `<br><small>${s.source === 'osm' ? 'Sommet OpenStreetMap' : 'Détecté dans le relief IGN'}</small>`;
}
function dessinerSommets() {
  if (etat.coucheSommets) etat.coucheSommets.remove();
  etat.coucheSommets = null;
  if (!etat.couches.sommets || !etat.sommets.length) return;
  const g = L.layerGroup();
  const proche = carte.getZoom() >= 10;
  for (const s of etat.sommets) {
    if (etat.zone && !s.dansZone && !s.rangPlan) continue;
    if (!accesOk(s) && !s.rangPlan) continue;
    // À petite échelle : seulement les sites remarquables
    if (!proche && !s.rangPlan && !(s.rang && s.rang <= 15) && !(s.nom && s.dominance >= 120)) continue;
    L.marker([s.lat, s.lon], { icon: iconeSommet(s), pane: 'sommets', zIndexOffset: s.rangPlan ? 500 : 0 })
      .bindTooltip(infoSommet(s), { className: 'info' })
      .on('click', () => (etat.modeProfil ? choisirPointProfil({ lat: s.lat, lon: s.lon, nom: nomSommet(s), h: 6 }) : ficheSommet(s)))
      .addTo(g);
  }
  g.addTo(carte);
  etat.coucheSommets = g;
}

async function voirCouvertureSite(p, titre, hauteur, opts = {}) {
  const hs = hauteur ?? ($('#relief-hs') ? $('#relief-hs').value : 6);
  let r;
  try { r = await api(`/api/relief/couverture?lat=${p.lat}&lon=${p.lon}&hs=${hs}${opts.preset ? '&preset=' + opts.preset : ''}`); } catch (e) { alert(e.message); return; }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const e = r.emprise;
  const g = L.layerGroup();
  L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.75, pane: 'couverture', className: 'pixelise' }).addTo(g);
  L.circleMarker([p.lat, p.lon], { radius: 7, color: '#f4c542', weight: 3, fillOpacity: 0.2, pane: 'traces' })
    .bindTooltip(`<b>${esc(titre || nomSommet(p))}</b><br>Couverture estimée : ${r.surfaceKm2} km² · ${fmt(r.pctZone, 1, ' %')} du département<br><small>antenne à ${hs} m · ≥ 10 dB de marge en turquoise, 0 à 10 dB en jaune, limite en orange</small>`, { className: 'info', permanent: false })
    .addTo(g);
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  if (!titre) carte.flyTo([p.lat, p.lon], Math.min(carte.getZoom(), 10), { duration: 0.6 });
  if (opts.cadrer) carte.fitBounds(L.latLng(p.lat, p.lon).toBounds(2 * 1000 * (r.rayonKm || 40)), { padding: [30, 30] });
  const info = $('#couverture-info');
  if (info) info.innerHTML = `<b>${esc(titre || nomSommet(p))}</b> : ${r.surfaceKm2} km² couverts, dont ${fmt(r.pctZone, 1, ' %')} du département.`;
  return r;
}

// Fiche d'un point haut : coordonnées, couverture, actions
async function ficheSommet(s) {
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<div class="vide">Calcul de la couverture…</div>';
  const r = await voirCouvertureSite(s);
  $('#fiche-contenu').innerHTML = `
    <h2>${esc(nomSommet(s))}</h2>
    <div class="ident">${s.commune ? esc(s.commune) + ' · ' : ''}${s.source === 'osm' ? 'Sommet OpenStreetMap' : 'Détecté dans le relief IGN'}${s.rangPlan ? ` · <b style="color:#f4c542">site recommandé n° ${s.rangPlan}</b>` : ''}</div>
    ${blocCoords(s.lat, s.lon, { alt: s.alt })}
    <div class="acces-ligne">Accès : ${texteAcces(s.acces)}</div>
    <div class="grille">
      <div class="mesure"><span>Domine les environs de</span><b>${s.dominance != null ? s.dominance + ' m' : '–'}</b></div>
      <div class="mesure"><span>Surface couverte</span><b>${r ? r.surfaceKm2 + ' km²' : '–'}</b></div>
      <div class="mesure"><span>Part du département</span><b>${r ? fmt(r.pctZone, 1, ' %') : '–'}</b></div>
      ${s.rang ? `<div class="mesure"><span>Classement individuel</span><b>${s.rang}ᵉ</b></div>` : ''}
    </div>
    <div class="actions-prop"><button id="sommet-couvrir">Couvrir ce point (4 points hauts)</button><button id="sommet-ajout-couv" class="principal">${etat.sitesCouv && etat.sitesCouv.length ? `＋ Ajouter à la couverture totale (${etat.sitesCouv.length + 1} sites)` : '＋ Ajouter un site (couverture totale)'}</button></div>
    <p class="note">Couverture calculée avec une antenne à ${$('#relief-hs') ? $('#relief-hs').value : 6} m (réglable dans l'onglet Couverture).</p>`;
  $('#sommet-couvrir').onclick = () => couvrirPoint(L.latLng(s.lat, s.lon));
  $('#sommet-ajout-couv').onclick = () => {
    const h = Number($('#relief-hs') ? $('#relief-hs').value : 6) || 6;
    if (etat.sitesCouv && etat.sitesCouv.length) couvertureMulti([...etat.sitesCouv, { lat: s.lat, lon: s.lon, h, nom: nomSommet(s) }].slice(0, 10));
    else { etat.sitesCouv = [{ lat: s.lat, lon: s.lon, h, nom: nomSommet(s) }]; basculerMode('couv-plus'); }
  };
}

// Superpose aux zones calculées les liaisons réellement mesurées du nœud
function ajouterLiaisonsMesurees(n, voisins) {
  if (!etat.coucheCouverture) return;
  for (const v of voisins || []) {
    const o = etat.noeuds.get(v.num);
    if (!o || o.lat == null) continue;
    const snr = v.snrEntendu ?? v.snrEmis;
    L.polyline([[n.lat, n.lon], [o.lat, o.lon]], { color: couleurSnr(snr), weight: 2, opacity: 0.9, pane: 'traces' }).addTo(etat.coucheCouverture);
    L.circleMarker([o.lat, o.lon], { radius: 7, color: couleurSnr(snr), weight: 2, fillOpacity: 0.35, pane: 'traces' })
      .bindTooltip(`<b>${esc(v.nom)}</b><br>Liaison mesurée · SNR ${fmt(snr, 1, ' dB')}${v.distanceKm != null ? ' · ' + fmt(v.distanceKm, 1, ' km') : ''}`, { className: 'info' })
      .addTo(etat.coucheCouverture);
  }
}

// Couverture depuis un point quelconque de la carte
async function couvertureIci(latlng, hauteur) {
  const h = hauteur ?? 6;
  const p = { lat: +latlng.lat.toFixed(5), lon: +latlng.lng.toFixed(5) };
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<div class="vide">Calcul de la couverture depuis ce point…</div>';
  const r = await voirCouvertureSite(p, 'Point choisi', h, { cadrer: true, preset: etat.vueReseau === 'meshcore' ? 'MESHCORE_FR' : undefined });
  if (!r) { $('#fiche-contenu').innerHTML = '<div class="vide">Calcul impossible.</div>'; return; }
  $('#fiche-contenu').innerHTML = `
    <h2>Couverture depuis ce point</h2>
    ${blocCoords(p.lat, p.lon, { alt: r.sol })}
    <div class="grille">
      <div class="mesure"><span>Surface couverte</span><b>${r.surfaceKm2} km²</b></div>
      <div class="mesure"><span>Part du département</span><b>${fmt(r.pctZone, 1, ' %')}</b></div>
      <div class="mesure"><span>Antenne</span><b>${h} m</b></div>
    </div>
    <div class="parametres compact">
      <label>Hauteur d'antenne (m) <input id="h-ici" type="number" min="0.5" max="80" step="0.5" value="${h}"></label>
    </div>
    <div class="actions-prop">
      <button id="recalc-ici">Recalculer</button>
      <button id="couvrir-ici">Trouver 4 points hauts pour couvrir ce point</button>
      <button id="ajout-site-couv" class="principal">＋ Ajouter un site (couverture totale)</button>
    </div>
    <p class="note">Turquoise : liaison confortable (≥ 10 dB de marge) · jaune : probable (0 à 10 dB) · orange : en limite. Le point desservi est supposé à 2 m du sol. ${r.env != null ? `Pertes de végétation et bâti : ${r.env} dB.` : ''}</p>`;
  $('#recalc-ici').onclick = () => couvertureIci(latlng, Number($('#h-ici').value) || 6);
  $('#couvrir-ici').onclick = () => couvrirPoint(latlng);
  $('#ajout-site-couv').onclick = () => { etat.sitesCouv = [{ lat: p.lat, lon: p.lon, h: Number($('#h-ici').value) || h, nom: 'Point choisi' }]; basculerMode('couv-plus'); };
}

// ---- Couverture totale de plusieurs sites -----------------------------------------------------
async function couvertureMulti(sites) {
  etat.sitesCouv = sites;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `<h2>Couverture de ${sites.length} site${sites.length > 1 ? 's' : ''}</h2><div class="alerte info-lecture"><span class="sablier"></span> Calcul de la couverture cumulée…</div>`;
  const q = sites.map((x) => `${x.lat.toFixed(5)},${x.lon.toFixed(5)},${x.h}`).join(';');
  let r;
  try { r = await api(`/api/relief/couverture-multi?pts=${q}${etat.vueReseau === 'meshcore' ? '&preset=MESHCORE_FR' : ''}`); } catch (e) { $('#fiche-contenu').innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const e = r.emprise, g = L.layerGroup();
  L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.75, pane: 'couverture', className: 'pixelise' }).addTo(g);
  sites.forEach((x, i) => L.marker([x.lat, x.lon], { icon: L.divIcon({ className: 'sommet plan', html: `<span>${i + 1}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }), pane: 'traces', zIndexOffset: 900 })
    .bindTooltip(`<b>${i + 1} · ${esc(x.nom || 'Site')}</b><br>antenne ${x.h} m · ${r.sites[i].km2} km² · apport propre ${r.sites[i].propreKm2} km²`, { className: 'info' }).addTo(g));
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  carte.fitBounds(L.latLngBounds(sites.map((x) => [x.lat, x.lon])).pad(0.6), { maxZoom: 11 });
  $('#fiche-contenu').innerHTML = `<h2>Couverture de ${sites.length} site${sites.length > 1 ? 's' : ''}</h2>
    <div class="grille">
      <div class="mesure"><span>Surface couverte</span><b>${r.surfaceKm2} km²</b></div>
      <div class="mesure"><span>Part du département</span><b>${fmt(r.pctZone, 1, ' %')}</b></div>
      <div class="mesure"><span>Sites</span><b>${sites.length}</b></div>
    </div>
    <div class="liste-cibles">${sites.map((x, i) => `<div class="ligne-cible"><span class="cible-multi petit"><span>${i + 1}</span></span><span>${esc(x.nom || 'Site')} <small class="mono">${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}</small><br><small>antenne <input class="mini-h" data-h="${i}" type="number" min="0.5" max="80" step="0.5" value="${x.h}"> m · ${r.sites[i].km2} km² seul · <b>${r.sites[i].propreKm2} km²</b> qu’il est seul à couvrir dans le département</small></span>${sites.length > 1 ? `<button class="mini" data-retirer-site="${i}" title="Retirer ce site">✕</button>` : ''}</div>`).join('')}</div>
    <div class="actions-prop">${sites.length < 10 ? '<button id="ajout-site-multi" class="principal">＋ Ajouter un site</button>' : ''}<button id="recalc-multi">Recalculer</button><button id="gpx-couv-multi">Télécharger (GPX)</button></div>
    <p class="note">Cliquez « Ajouter un site » puis un point de la carte (ou clic droit → « Ajouter à la couverture totale »). Un site qui couvre peu de surface à lui seul fait doublon avec les autres. Turquoise : ≥ 10 dB de marge · jaune : 0 à 10 dB · orange : en limite.</p>`;
  const ba = $('#ajout-site-multi'); if (ba) ba.onclick = () => basculerMode('couv-plus');
  $('#recalc-multi').onclick = () => { $('#fiche-contenu').querySelectorAll('[data-h]').forEach((el) => { sites[Number(el.dataset.h)].h = Number(el.value) || 6; }); couvertureMulti(sites); };
  $('#fiche-contenu').querySelectorAll('[data-retirer-site]').forEach((b) => (b.onclick = () => couvertureMulti(sites.filter((_, i) => i !== Number(b.dataset.retirerSite)))));
  $('#gpx-couv-multi').onclick = () => telechargerGpx('couverture-sites.gpx', sites.map((x, i) => ({ lat: x.lat, lon: x.lon, alt: r.sites[i].sol, nom: `${i + 1} - ${x.nom || 'Site'}`, desc: `Antenne ${x.h} m, ${r.sites[i].km2} km²` })));
}
function ajouterSiteCouverture(latlng) {
  const lieu = nomLieu(latlng);
  const h = Number($('#relief-hs') ? $('#relief-hs').value : 6) || 6;
  couvertureMulti([...(etat.sitesCouv || []), { lat: lieu.lat, lon: lieu.lon, h, nom: lieu.nom }].slice(0, 10));
}

// ---- Couverture actuelle du réseau (relais et passerelles détectés) ----------------------------------
async function couvertureReseau() {
  const hn = Number(localStorage.getItem('gaulix_hn')) || 6;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<h2>Couverture actuelle du réseau</h2><div class="alerte info-lecture"><span class="sablier"></span> Calcul de la zone couverte par les relais et passerelles détectés…</div>';
  let r;
  try { r = await api(`/api/relief/couverture-reseau?hn=${hn}${etat.vueReseau === 'meshcore' ? '&reseau=meshcore' : ''}`); } catch (e) { $('#fiche-contenu').innerHTML = `<h2>Couverture actuelle du réseau</h2><div class="vide">${esc(e.message)}</div>`; return; }
  const dep = etat.relief && etat.relief.departement ? etat.relief.departement.nom : 'le département';
  if (r.vide) { $('#fiche-contenu').innerHTML = `<h2>Couverture actuelle du réseau</h2><div class="vide">Aucun relais ni passerelle ${etat.vueReseau === 'meshcore' ? 'MeshCore ' : ''}positionné et entendu depuis 24 h dans ${esc(dep)}.</div>`; return; }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const e = r.emprise, g = L.layerGroup();
  L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.75, pane: 'couverture', className: 'pixelise' }).addTo(g);
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  carte.fitBounds(L.latLngBounds(r.noeuds.map((n) => [n.lat, n.lon])).pad(0.4), { maxZoom: 11 });
  const tries = [...r.noeuds].sort((a, b) => b.propreKm2 - a.propreKm2);
  $('#fiche-contenu').innerHTML = `<h2>Couverture actuelle du réseau</h2>
    <div class="ident">${esc(dep)} · ${r.noeuds.length} relais et passerelles ${etat.vueReseau === 'meshcore' ? 'MeshCore ' : ''}détectés (positionnés, entendus depuis 24 h)</div>
    <div class="grille">
      <div class="mesure"><span>Part du département</span><b>${fmt(r.pctZone, 1, ' %')}</b></div>
      <div class="mesure"><span>Dans le département</span><b>${r.surfaceZoneKm2} km²</b></div>
      <div class="mesure"><span>Surface totale</span><b>${r.surfaceKm2} km²</b></div>
    </div>
    <div class="barre-couv"><i style="width:${r.pctZone}%" class="actuel"></i></div>
    <div class="parametres compact"><label>Hauteur supposée des relais sans fiche (m) <input id="hn-reseau" type="number" min="1" max="60" step="1" value="${hn}"></label><button id="hn-recalc">Recalculer</button></div>
    <h3>Apport de chaque relais</h3>
    <p class="note">« Seul à couvrir » : surface du département que ce relais est le seul à desservir. Un relais à 0 km² fait doublon avec les autres ; un relais à forte valeur est un point critique (s’il tombe, cette zone n’est plus couverte).</p>
    ${tries.map((n) => `<div class="ligne" data-ouvrir-noeud="${esc(String(n.num))}"><span class="point ${n.propreKm2 > 0 ? 'actif' : 'inactif'}"></span><span class="titre">${esc(n.nom || String(n.num))}<small>${n.km2} km² au total · antenne ${n.hauteur} m ${n.fiche ? '<span title="Valeurs de la fiche d’installation">📋</span>' : '(supposée)'}</small></span><span class="meta"><b>${n.propreKm2} km²</b> seul</span></div>`).join('')}
    <div class="actions-prop"><button id="couv-vers-plan" class="principal">🗺️ Où ajouter des relais ? (plan)</button></div>
    <p class="note">Turquoise : ≥ 10 dB de marge · jaune : 0 à 10 dB · orange : en limite. Hypothèse : antennes à ${hn} m, nœud desservi à 2 m du sol. ${r.env != null ? `Pertes de végétation et bâti : ${r.env} dB.` : ''}</p>`;
  $('#hn-recalc').onclick = () => { try { localStorage.setItem('gaulix_hn', $('#hn-reseau').value); } catch { /* ignoré */ } couvertureReseau(); };
  $('#couv-vers-plan').onclick = () => allerPlan();
  $('#fiche-contenu').querySelectorAll('[data-ouvrir-noeud]').forEach((el) => (el.onclick = () => {
    const n = r.noeuds.find((x) => String(x.num) === el.dataset.ouvrirNoeud);
    if (n) carte.flyTo([n.lat, n.lon], 12, { duration: 0.6 });
  }));
}
// ---- Couverture mesurée (positions réelles des émetteurs + réceptions des passerelles) ------------------
async function couvertureMesuree(jours, noeud) {
  jours = jours || Number(localStorage.getItem('gaulix_mes_jours')) || 7;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<h2>Couverture mesurée</h2><div class="alerte info-lecture"><span class="sablier"></span> Regroupement des mesures…</div>';
  let r, cal = null;
  try { r = await api(`/api/couverture-mesuree?jours=${jours}${noeud != null ? '&noeud=' + noeud : ''}`); } catch (e) { $('#fiche-contenu').innerHTML = `<h2>Couverture mesurée</h2><div class="vide">${esc(e.message)}</div>`; return; }
  try { cal = await api('/api/relief/calibration'); } catch { /* facultatif */ }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const g = L.layerGroup();
  for (const c of r.cellules) {
    const b = [[c.lat - c.dLat / 2, c.lon - c.dLon / 2], [c.lat + c.dLat / 2, c.lon + c.dLon / 2]];
    const coul = c.direct ? couleurSnr(c.snrMax) : '#8fa3b8';
    L.rectangle(b, { color: coul, weight: 0.6, fillColor: coul, fillOpacity: c.direct ? 0.5 : 0.25, pane: 'couverture' })
      .bindTooltip(`<b>${c.direct ? 'Reçu en direct' : 'Reçu via des relais seulement'}</b> · ${c.n} mesure${c.n > 1 ? 's' : ''}<br>${c.passerelles.map((p) => `${esc(p.nom)}${p.snr != null ? ' : ' + fmt(p.snr, 1, ' dB') : ''}`).join('<br>')}${c.passerelles.length ? '<br>' : ''}<small>émetteur${c.emetteurs.length > 1 ? 's' : ''} : ${esc(c.emetteurs.join(', '))} · ${ilYa(c.dernier)}</small>`, { className: 'info', sticky: true }).addTo(g);
  }
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  if (r.cellules.length) carte.fitBounds(L.latLngBounds(r.cellules.map((c) => [c.lat, c.lon])).pad(0.1), { maxZoom: 12 });
  const nomN = noeud != null ? nomNoeud(noeud) : null;
  $('#fiche-contenu').innerHTML = `<h2>Couverture mesurée${nomN ? ' · ' + esc(nomN) : ''}</h2>
    <div class="ident">${r.mesures} mesures · ${r.emetteurs} émetteur${r.emetteurs > 1 ? 's' : ''} positionné${r.emetteurs > 1 ? 's' : ''} · ${jours} dernier${jours > 1 ? 's' : ''} jour${jours > 1 ? 's' : ''}</div>
    <div class="grille">
      <div class="mesure"><span>Zones reçues en direct</span><b>${r.directes}</b></div>
      <div class="mesure"><span>Via relais seulement</span><b>${r.viaRelais}</b></div>
      <div class="mesure"><span>Surface mesurée</span><b>≈ ${r.surfaceKm2} km²</b></div>
    </div>
    <div class="parametres compact"><label>Période <select id="mes-jours">${[1, 3, 7, 14, 30].map((j) => `<option value="${j}" ${j === jours ? 'selected' : ''}>${j} jour${j > 1 ? 's' : ''}</option>`).join('')}</select></label>${noeud != null ? '<button id="mes-tous">Tous les nœuds</button>' : ''}</div>
    <p class="note">Chaque carré de 500 m est un endroit d’où un nœud a réellement été reçu. Couleur = meilleur SNR reçu en direct par une passerelle (vert excellent → rouge limite) ; gris = reçu seulement grâce à des relais. Les nœuds dont la position est volontairement floutée et les messages passés par internet sont écartés.</p>
    ${cal && cal.liaisons != null ? `<p class="note">Le modèle de relief est recalé sur <b>${cal.liaisons}</b> liaisons mesurées (dont les relevés des nœuds mobiles) : pertes d’environnement retenues ${cal.perteEnvironnementDb != null ? cal.perteEnvironnementDb + ' dB' : 'par défaut'}${cal.ecartMedianDb != null ? `, écart médian modèle − mesure ${fmt(cal.ecartMedianDb, 1, ' dB')}` : ''}.</p>` : ''}
    <details class="aide-cle"><summary>Faire un relevé de terrain</summary>
      <ol class="note">
        <li>Sur un module mobile (voiture, sac à dos) : position <b>toutes les 30 s</b>, « position intelligente » désactivée, précision de position <b>« précise »</b> sur le canal utilisé.</li>
        <li>Parcourez la zone à étudier (routes, villages, fonds de vallée).</li>
        <li>Ouvrez sa fiche, puis « Couverture mesurée de ce nœud » : chaque position reçue apparaît, avec la passerelle qui l’a entendue et le SNR.</li>
        <li>Le modèle de relief se recale automatiquement avec ces mesures au prochain calcul (chaque nuit, ou « Recalculer » côté admin).</li>
      </ol></details>`;
  $('#mes-jours').onchange = () => { try { localStorage.setItem('gaulix_mes_jours', $('#mes-jours').value); } catch { /* ignoré */ } couvertureMesuree(Number($('#mes-jours').value), noeud); };
  const mt = $('#mes-tous'); if (mt) mt.onclick = () => couvertureMesuree(jours, null);
}
// ---- Simulation « et si… » : retirer ou ajouter des relais --------------------------------------------
etat.simu = { retirer: new Set(), ajouter: [] };
async function simulation() {
  const sm = etat.simu;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<h2>Simulation « et si… »</h2><div class="alerte info-lecture"><span class="sablier"></span> Calcul de la couverture et des liaisons entre les villes…</div>';
  let r;
  try { r = await postJson('/api/relief/simulation' + (etat.vueReseau === 'meshcore' ? '?reseau=meshcore' : ''), { retirer: [...sm.retirer], ajouter: sm.ajouter }); } catch (e) { $('#fiche-contenu').innerHTML = `<h2>Simulation « et si… »</h2><div class="vide">${esc(e.message)}</div>`; return; }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const e = r.emprise, g = L.layerGroup();
  L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.8, pane: 'couverture', className: 'pixelise' }).addTo(g);
  for (const n of r.retires) L.marker([n.lat, n.lon], { icon: L.divIcon({ className: 'simu-retire', html: '✖', iconSize: [22, 22], iconAnchor: [11, 11] }), pane: 'traces', zIndexOffset: 900 }).bindTooltip(`Retiré : ${esc(n.nom)}`, { className: 'info' }).addTo(g);
  r.ajoutes.forEach((a, i) => L.marker([a.lat, a.lon], { icon: L.divIcon({ className: 'relais-a-installer', html: `<div class="epingle"><b>+${i + 1}</b></div>`, iconSize: [34, 44], iconAnchor: [17, 42] }), pane: 'traces', zIndexOffset: 950 }).bindTooltip(`Ajouté : ${esc(a.nom)} · antenne ${a.h} m`, { className: 'info' }).addTo(g));
  for (const v of r.villes) L.circleMarker([v.lat, v.lon], { radius: 5, color: v.couverteApres ? '#e8eef5' : '#ff5c6c', weight: 2, fillColor: v.couverteApres ? '#3ee6c4' : '#ff5c6c', fillOpacity: 0.9, pane: 'traces' }).bindTooltip(`${esc(v.nom)} · ${v.population.toLocaleString('fr-FR')} hab.${v.couverteApres ? '' : ' · <b>non couverte</b>'}`, { className: 'info' }).addTo(g);
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  const delta = r.apres.pct - r.avant.pct;
  const changees = r.paires.filter((p) => p.avant !== p.apres);
  const libRelais = (x) => (x == null ? '<b style="color:var(--critique)">✖ impossible</b>' : `${x} relais`);
  const villesPerdues = r.villes.filter((v) => v.couverteAvant && !v.couverteApres), villesGagnees = r.villes.filter((v) => !v.couverteAvant && v.couverteApres);
  $('#fiche-contenu').innerHTML = `<h2>Simulation « et si… »</h2>
    <div class="grille">
      <div class="mesure"><span>Couverture avant</span><b>${fmt(r.avant.pct, 1, ' %')}</b></div>
      <div class="mesure"><span>Après</span><b style="color:${delta < -0.05 ? 'var(--critique)' : delta > 0.05 ? 'var(--ok)' : 'inherit'}">${fmt(r.apres.pct, 1, ' %')}</b></div>
      <div class="mesure"><span>Écart</span><b>${delta >= 0 ? '+' : ''}${fmt(delta, 1, ' pt')}</b></div>
      <div class="mesure"><span>Zone perdue</span><b style="color:${r.perduKm2 ? 'var(--critique)' : 'inherit'}">${r.perduKm2} km²</b></div>
      <div class="mesure"><span>Zone gagnée</span><b style="color:${r.gagneKm2 ? 'var(--ok)' : 'inherit'}">${r.gagneKm2} km²</b></div>
      <div class="mesure"><span>Relais</span><b>${r.avant.relais} → ${r.apres.relais}</b></div>
    </div>
    ${villesPerdues.length ? `<div class="alerte critique">Villes qui ne seraient plus couvertes : <b>${villesPerdues.map((v) => esc(v.nom)).join(', ')}</b></div>` : ''}
    ${villesGagnees.length ? `<div class="alerte info-lecture">Villes nouvellement couvertes : <b>${villesGagnees.map((v) => esc(v.nom)).join(', ')}</b></div>` : ''}
    <h3>Liaisons entre les principales villes</h3>
    ${changees.length ? `<table class="voisins"><thead><tr><th>Entre</th><th class="num">Avant</th><th class="num">Après</th></tr></thead><tbody>${changees.map((p) => `<tr><td>${esc(p.de)} ↔ ${esc(p.vers)}</td><td class="num">${libRelais(p.avant)}</td><td class="num">${libRelais(p.apres)}</td></tr>`).join('')}</tbody></table>` : `<p class="note">Aucun changement entre les ${r.villes.length} plus grandes villes (${r.paires.filter((p) => p.apres != null).length} liaisons possibles sur ${r.paires.length}).</p>`}
    <h3>Modifier la simulation</h3>
    <h4>Retirer des relais existants</h4>
    <div class="liste-simu">${r.reseau.map((n) => `<label class="case"><input type="checkbox" data-retirer="${esc(String(n.num))}" ${sm.retirer.has(String(n.num)) ? 'checked' : ''}> ${esc(n.nom)}</label>`).join('') || '<div class="vide">Aucun relais détecté.</div>'}</div>
    <h4>Ajouter des relais</h4>
    ${sm.ajouter.map((a, i) => `<div class="ligne-cible"><span class="cible-multi petit"><span>+${i + 1}</span></span>${esc(a.nom)} <small class="mono">${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}</small> · antenne <input class="mini-h" data-h-ajout="${i}" type="number" min="0.5" max="60" step="0.5" value="${a.h}"> m<button class="mini" data-suppr-ajout="${i}">✕</button></div>`).join('') || '<p class="note">Aucun pour l’instant.</p>'}
    <div class="actions-prop"><button id="simu-ajout">＋ Ajouter un relais sur la carte</button><button id="simu-lancer" class="principal">Recalculer</button><button id="simu-raz">Tout remettre à zéro</button></div>
    <p class="note">Rouge : zone qui ne serait plus couverte · vert : zone gagnée · turquoise pâle : inchangée. « N relais » = nombre de relais traversés par un message entre deux nœuds situés dans ces villes (calculé d’après le relief, antennes des fiches Installation, sinon 6 m). Villes : les ${r.villes.length} communes les plus peuplées du département.</p>`;
  $('#fiche-contenu').querySelectorAll('[data-retirer]').forEach((c) => (c.onchange = () => { if (c.checked) sm.retirer.add(c.dataset.retirer); else sm.retirer.delete(c.dataset.retirer); }));
  $('#fiche-contenu').querySelectorAll('[data-h-ajout]').forEach((c) => (c.onchange = () => { sm.ajouter[Number(c.dataset.hAjout)].h = Number(c.value) || 6; }));
  $('#fiche-contenu').querySelectorAll('[data-suppr-ajout]').forEach((b) => (b.onclick = () => { sm.ajouter.splice(Number(b.dataset.supprAjout), 1); simulation(); }));
  $('#simu-ajout').onclick = () => basculerMode('simu-ajout');
  $('#simu-lancer').onclick = () => simulation();
  $('#simu-raz').onclick = () => { etat.simu = { retirer: new Set(), ajouter: [] }; simulation(); };
}
function ajouterRelaisSimulation(latlng) {
  const lieu = nomLieu(latlng);
  etat.simu.ajouter.push({ lat: lieu.lat, lon: lieu.lon, h: Number($('#relief-hs') ? $('#relief-hs').value : 6) || 6, nom: lieu.nom });
  simulation();
}
// ---- Mode terrain : application installable, relevés hors connexion, fonds de carte gardés -------------
const terrain = { liste: [], types: {}, gps: null, suivi: null, photo: null };
const CLE_ATTENTE = 'terrain-attente';
function lireAttente() { try { return JSON.parse(localStorage.getItem(CLE_ATTENTE) || '[]'); } catch { return []; } }
function ecrireAttente(l) { try { localStorage.setItem(CLE_ATTENTE, JSON.stringify(l)); return true; } catch { return false; } }
function majBandeauTerrain() {
  const b = $('#bandeau-terrain'), n = lireAttente().length;
  if (!b) return;
  const hors = !navigator.onLine;
  b.hidden = !hors && !n;
  b.className = hors ? 'hors' : '';
  b.innerHTML = `${hors ? '📴 Hors connexion : carte et fonds déjà vus' : '📤 Relevés à envoyer'}${n ? ` · <b>${n}</b> relevé${n > 1 ? 's' : ''} en attente` : ''}${!hors && n ? ' <button class="mini" id="terrain-envoyer">Envoyer</button>' : ''}`;
  const be = $('#terrain-envoyer');
  if (be) be.onclick = () => synchroniserReleves(true);
}
async function synchroniserReleves(manuel) {
  if (terrain.envoi || !navigator.onLine || !etat.membre) { majBandeauTerrain(); return; }
  terrain.envoi = true;
  let l = lireAttente(), envoyes = 0;
  try {
    while (l.length) {
      const r = await fetch('/api/releves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(l[0]) });
      if (r.status >= 500 || r.status === 401) break; // serveur injoignable ou session expirée : on réessaiera
      if (!r.ok) { const e = await r.json().catch(() => ({})); console.warn('Relevé refusé :', e.erreur); }
      l.shift(); ecrireAttente(l); envoyes++;
    }
  } catch { /* réseau coupé */ }
  terrain.envoi = false;
  majBandeauTerrain();
  if (envoyes) { chargerReleves(); if (manuel || $('#terrain-retour')) { const z = $('#terrain-retour'); if (z) z.textContent = `✔ ${envoyes} relevé(s) envoyé(s).`; } }
}
async function chargerReleves() {
  if (!etat.membre) return;
  try { const r = await api('/api/releves'); terrain.liste = r.releves; terrain.types = r.types; } catch { /* hors connexion */ }
  dessinerReleves();
}
const ICONE_RELEVE = { site: '📡', point_haut: '⛰️', test: '📶', probleme: '⚠️', installation: '✅', autre: '📝' };
function dessinerReleves() {
  if (etat.coucheReleves) etat.coucheReleves.remove();
  etat.coucheReleves = null;
  if (!etat.couches.releves || !etat.membre) return;
  const g = L.layerGroup();
  const tous = [...terrain.liste, ...lireAttente().map((r) => ({ ...r, attente: true }))];
  for (const r of tous) {
    const m = L.marker([r.lat, r.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-releve${r.attente ? ' attente' : ''}">${ICONE_RELEVE[r.type] || '📝'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 400 });
    m.bindPopup(() => `<div class="popup-releve"><b>${esc(terrain.types[r.type] || r.type)}</b>${r.attente ? ' <span class="pastille attention">pas encore envoyé</span>' : ''}<br><small>${new Date(r.heure).toLocaleString('fr-FR')}${r.auteur ? ' · ' + esc(r.auteur) : ''}${r.precision ? ' · GPS ±' + Math.round(r.precision) + ' m' : ''}${r.alt != null ? ' · ' + Math.round(r.alt) + ' m' : ''}</small>
      ${r.noeud || r.snr != null || r.rssi != null ? `<div>📶 ${esc(r.noeud || '')}${r.snr != null ? ' · SNR ' + r.snr + ' dB' : ''}${r.rssi != null ? ' · RSSI ' + r.rssi + ' dBm' : ''}</div>` : ''}
      ${r.note ? `<p>${esc(r.note).replace(/\n/g, '<br>')}</p>` : ''}
      ${r.photo === true ? `<a href="/api/releves/${r.id}/photo" target="_blank"><img src="/api/releves/${r.id}/photo" alt="photo du relevé" loading="lazy"></a>` : typeof r.photo === 'string' ? `<img src="${r.photo}" alt="photo du relevé">` : ''}
      <div class="boutons"><button class="mini" data-couv-releve="${r.lat},${r.lon}">Couverture depuis ce point</button>${!r.attente && (etat.admin || (etat.config.compte && r.auteur === (etat.config.compte.indicatif || etat.config.compte.identifiant))) ? `<button class="mini" data-suppr-releve="${r.id}">Supprimer</button>` : ''}</div></div>`, { maxWidth: 300 });
    m.on('popupopen', (e) => {
      const el = e.popup.getElement();
      const bc = el.querySelector('[data-couv-releve]');
      if (bc) bc.onclick = () => { carte.closePopup(); voirCouvertureSite({ lat: r.lat, lon: r.lon }, terrain.types[r.type] || 'Relevé', 6, { cadrer: true }); };
      const bs = el.querySelector('[data-suppr-releve]');
      if (bs) bs.onclick = async () => { if (!confirm('Supprimer ce relevé ?')) return; await api('/api/releves/' + r.id, { method: 'DELETE' }); carte.closePopup(); chargerReleves(); };
    });
    m.addTo(g);
  }
  g.addTo(carte);
  etat.coucheReleves = g;
}
// Photo réduite à 1280 px, JPEG ~70 % (quelques centaines de ko au plus) : supportable en 4G faible et dans la file locale
function compresserPhoto(fichier) {
  return new Promise((ok, ko) => {
    const img = new Image(), url = URL.createObjectURL(fichier);
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('Photo illisible')); };
    img.src = url;
  });
}
function arreterGps() { if (terrain.suivi != null) navigator.geolocation.clearWatch(terrain.suivi); terrain.suivi = null; }
function ficheTerrain() {
  $('#fiche').hidden = false;
  etat.selection = null;
  const attente = lireAttente();
  const relais = [...etat.noeuds.values()].filter((n) => n.infrastructure).sort((a, b) => (a.nomLong || a.id).localeCompare(b.nomLong || b.id));
  const types = Object.keys(terrain.types).length ? terrain.types : { site: 'Site relais possible', point_haut: 'Point haut', test: 'Test de couverture', probleme: 'Problème / panne', installation: 'Installation réalisée', autre: 'Autre' };
  const installable = !!terrain.invite;
  $('#fiche-contenu').innerHTML = `<h2>📍 Mode terrain</h2>
    ${!etat.membre ? '<div class="alerte attention">Connectez-vous (compte membre) pour enregistrer des relevés.</div>' : `
    <form id="f-releve" class="form-edit">
      <div class="gps-terrain" id="gps-terrain">📡 Recherche de la position GPS…</div>
      <label>Type <select name="type">${Object.entries(types).map(([k, v]) => `<option value="${k}">${ICONE_RELEVE[k] || ''} ${esc(v)}</option>`).join('')}</select></label>
      <label>Note <textarea name="note" rows="3" placeholder="Accès, propriétaire, alimentation, dégagement, ce que vous recevez…"></textarea></label>
      <details><summary>Mesure radio (facultatif)</summary>
        <label>Nœud entendu <input name="noeud" list="relais-terrain" placeholder="nom du relais"></label>
        <datalist id="relais-terrain">${relais.map((n) => `<option value="${esc(n.nomLong || n.id)}">`).join('')}</datalist>
        <div class="deux"><label>SNR (dB) <input name="snr" type="number" step="0.25" min="-40" max="30"></label><label>RSSI (dBm) <input name="rssi" type="number" step="1" min="-150" max="0"></label></div>
      </details>
      <label class="bouton-photo">📷 Photo <input name="photo" type="file" accept="image/*" capture="environment"></label>
      <div id="apercu-photo"></div>
      <div class="actions-prop"><button type="submit" class="principal">Enregistrer le relevé</button></div>
      <p class="erreur" id="terrain-retour"></p>
    </form>`}
    ${attente.length ? `<p class="note">${attente.length} relevé(s) en attente d’envoi (envoyés automatiquement au retour du réseau).</p>` : ''}
    <h3>Préparer une sortie sans réseau</h3>
    <p class="note">Cadrez la carte sur le secteur de la sortie puis enregistrez ses fonds de carte : ils resteront affichés sans réseau (jusqu’au zoom 16, 3000 tuiles au plus). L’application elle-même s’ouvre hors connexion dès la deuxième visite.</p>
    <div class="actions-prop"><button id="terrain-tuiles">🗺️ Garder les fonds de carte de cette vue</button>${installable ? '<button id="terrain-installer">📲 Installer l’application</button>' : ''}</div>
    <p class="note" id="terrain-tuiles-retour"></p>
    ${!installable ? '<p class="note">Pour l’avoir comme une application sur le téléphone : menu du navigateur › « Ajouter à l’écran d’accueil » (la carte doit être ouverte en HTTPS).</p>' : ''}
    ${terrain.liste.length ? `<h3>Derniers relevés</h3>${terrain.liste.slice(-15).reverse().map((r) => `<div class="ligne cliquable" data-aller-releve="${r.lat},${r.lon}"><span>${ICONE_RELEVE[r.type] || '📝'}</span><span class="titre">${esc(terrain.types[r.type] || r.type)}<small>${esc((r.note || '').slice(0, 60))} · ${esc(r.auteur || '')} · ${ilYa(r.heure)}${r.photo ? ' · 📷' : ''}</small></span></div>`).join('')}` : ''}`;
  document.querySelectorAll('[data-aller-releve]').forEach((el) => (el.onclick = () => { const [a, b] = el.dataset.allerReleve.split(',').map(Number); carte.setView([a, b], Math.max(carte.getZoom(), 14)); }));
  $('#terrain-tuiles').onclick = prechargerTuiles;
  const bi = $('#terrain-installer');
  if (bi) bi.onclick = async () => { terrain.invite.prompt(); await terrain.invite.userChoice.catch(() => {}); terrain.invite = null; bi.remove(); };
  const f = $('#f-releve');
  if (!f) return;
  // Position : suivi GPS tant que la fiche est ouverte (la précision s'affine en quelques secondes)
  arreterGps();
  const zg = $('#gps-terrain');
  if (!navigator.geolocation) zg.textContent = '⚠️ Pas de GPS dans ce navigateur : le relevé prendra le centre de la carte.';
  else terrain.suivi = navigator.geolocation.watchPosition((p) => {
    terrain.gps = { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude, precision: p.coords.accuracy, heure: p.timestamp };
    const z = $('#gps-terrain');
    if (!z) return arreterGps();
    z.className = 'gps-terrain ' + (p.coords.accuracy <= 20 ? 'bon' : p.coords.accuracy <= 100 ? 'moyen' : 'faible');
    z.innerHTML = `📍 ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)} · ±${Math.round(p.coords.accuracy)} m${p.coords.altitude != null ? ' · ' + Math.round(p.coords.altitude) + ' m' : ''}`;
  }, (e) => { const z = $('#gps-terrain'); if (z) z.textContent = `⚠️ GPS indisponible (${e.message}) : le relevé prendra le centre de la carte.`; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  terrain.photo = null;
  f.photo.onchange = async () => {
    const fi = f.photo.files[0];
    if (!fi) return;
    try { terrain.photo = await compresserPhoto(fi); $('#apercu-photo').innerHTML = `<img src="${terrain.photo}" alt="aperçu"><small>${Math.round(terrain.photo.length * 0.75 / 1024)} ko</small>`; } catch (e) { $('#terrain-retour').textContent = e.message; }
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const c = carte.getCenter(), g = terrain.gps && Date.now() - terrain.gps.heure < 120000 ? terrain.gps : null;
    const nombre = (v) => (v === '' || v == null ? null : Number(v));
    const r = { id: (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).toLowerCase(), lat: g ? g.lat : c.lat, lon: g ? g.lon : c.lng, alt: g ? g.alt : null, precision: g ? g.precision : null, type: f.type.value, note: f.note.value.trim(), noeud: f.noeud.value.trim(), snr: nombre(f.snr.value), rssi: nombre(f.rssi.value), heure: Date.now(), photo: terrain.photo };
    const l = lireAttente(); l.push(r);
    if (!ecrireAttente(l)) { l.pop(); r.photo = null; l.push(r); if (!ecrireAttente(l)) { $('#terrain-retour').textContent = 'Mémoire du téléphone pleine : envoyez d’abord les relevés en attente.'; return; } $('#terrain-retour').textContent = 'Mémoire pleine : relevé gardé sans sa photo.'; }
    else $('#terrain-retour').textContent = navigator.onLine ? 'Envoi…' : '✔ Relevé gardé sur le téléphone : il partira au retour du réseau.';
    f.reset(); terrain.photo = null; $('#apercu-photo').innerHTML = '';
    dessinerReleves(); majBandeauTerrain(); synchroniserReleves(true);
  };
}
function tuilesVue(couche, zMax) {
  const b = carte.getBounds(), urls = [];
  const o = couche.options, sd = typeof o.subdomains === 'string' ? o.subdomains.split('') : o.subdomains || [];
  const tx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const ty = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
  for (let z = Math.max(6, carte.getZoom() - 2); z <= zMax; z++) {
    for (let x = tx(b.getWest(), z); x <= tx(b.getEast(), z); x++)
      for (let y = ty(b.getNorth(), z); y <= ty(b.getSouth(), z); y++)
        urls.push(L.Util.template(couche._url, L.extend({ r: '', s: sd.length ? sd[Math.abs(x + y) % sd.length] : '', x, y, z }, o)));
  }
  return urls;
}
async function prechargerTuiles() {
  const z = $('#terrain-tuiles-retour');
  const reg = navigator.serviceWorker && (await navigator.serviceWorker.ready.catch(() => null));
  if (!reg || !reg.active) { z.textContent = 'Fonction indisponible : la carte doit être ouverte en HTTPS (ou en local) dans un navigateur récent.'; return; }
  const couches = [];
  carte.eachLayer((l) => { if (l instanceof L.TileLayer && l._url && /^https?:/.test(l._url)) couches.push(l); });
  if (!couches.length) { z.textContent = 'Aucun fond de carte à enregistrer.'; return; }
  let zMax = Math.min(16, Math.max(carte.getZoom() + 3, 12)), urls;
  do { urls = couches.flatMap((c) => tuilesVue(c, Math.min(zMax, c.options.maxNativeZoom || 19))); zMax--; } while (urls.length > 3000 && zMax > carte.getZoom());
  if (urls.length > 3000) { z.textContent = 'Zone trop grande : rapprochez-vous (zoomez) puis recommencez.'; return; }
  z.textContent = `Enregistrement de ${urls.length} tuiles…`;
  const canal = new MessageChannel();
  canal.port1.onmessage = (e) => { const d = e.data; z.textContent = d.fini ? `✔ ${d.fait - d.erreurs} tuiles gardées (jusqu’au zoom ${zMax + 1})${d.erreurs ? `, ${d.erreurs} en échec` : ''}. Ce secteur s’affichera sans réseau.` : `Enregistrement… ${d.fait} / ${d.total}`; };
  reg.active.postMessage({ type: 'prechargerTuiles', urls }, [canal.port2]);
}
function demarrerTerrain() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker :', e.message));
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); terrain.invite = e; });
  window.addEventListener('online', () => { majBandeauTerrain(); synchroniserReleves(); });
  window.addEventListener('offline', majBandeauTerrain);
  document.querySelectorAll('.seul-membre').forEach((b) => (b.hidden = !etat.membre));
  majBandeauTerrain();
  chargerReleves();
  synchroniserReleves();
  setInterval(() => { if (lireAttente().length) synchroniserReleves(); }, 60000);
  // La fiche se ferme : on coupe le GPS (batterie)
  const fe = document.querySelector('#fiche .fermer, #fermer-fiche');
  if (fe) fe.addEventListener('click', arreterGps);
}

// ---- Bulles voisines (cartes fédérées) -----------------------------------------------------------------
async function chargerFederation() {
  try { etat.federation = await api('/api/federation/voisins'); } catch { etat.federation = []; }
  dessinerFederation();
}
function dessinerFederation() {
  if (etat.coucheFederation) etat.coucheFederation.remove();
  etat.coucheFederation = null;
  if (!etat.couches.federation || !(etat.federation || []).length) return;
  const g = L.layerGroup();
  for (const b of etat.federation) {
    const pos = new Map(b.relais.map((r) => [r.num, r]));
    for (const l of b.liens) {
      const a = pos.get(l.a), c = pos.get(l.b);
      if (a && c) L.polyline([[a.lat, a.lon], [c.lat, c.lon]], { color: couleurSnr(l.snr), weight: 1.5, opacity: 0.55, dashArray: '3 6', pane: 'liens', interactive: false }).addTo(g);
    }
    for (const r of b.relais) {
      L.marker([r.lat, r.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-federation ${r.passerelle ? 'gw' : ''}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }), zIndexOffset: 300 })
        .bindTooltip(`<b>${esc(r.nom)}</b> <small>bulle voisine</small><br>${esc(b.nom)}${b.departement ? ' (' + esc(b.departement.code) + ')' : ''}<br>${esc(r.role || '')}${r.passerelle ? ' · passerelle MQTT' : ''}${r.hauteur ? ' · antenne ' + r.hauteur + ' m' : ''}<br><small>vu ${ilYa(r.dernierVu)}${b.perime ? ' · données anciennes (bulle injoignable)' : ''}</small>`, { className: 'info' }).addTo(g);
    }
  }
  g.addTo(carte);
  etat.coucheFederation = g;
}

// ---- Partager : carte publique intégrable et exports ---------------------------------------------------
async function rendreFederationAdmin() {
  const z = $('#liste-federation');
  if (!z) return;
  let l = [];
  try { l = await api('/api/federation/partenaires'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  z.innerHTML = l.map((p) => `<div class="ligne"><span class="point ${p.erreur ? (p.relais ? 'attention' : 'alerte') : 'actif'}"></span><span class="titre">${esc(p.nom || p.url)}<small>${esc(p.url)}${p.departement ? ' · ' + esc(p.departement.code + ' ' + (p.departement.nom || '')) : ''} · ${p.relais} relais, ${p.liens} liaisons${p.heure ? ' · ' + ilYa(p.heure) : ''}${p.erreur ? ' · <b style="color:var(--attention)">' + esc(p.erreur) + '</b>' : ''}</small></span><span class="meta"><button class="mini" data-retirer-fed="${esc(p.url)}">✕</button></span></div>`).join('') || '<div class="vide">Aucune bulle voisine déclarée.</div>';
  z.querySelectorAll('[data-retirer-fed]').forEach((b) => (b.onclick = async () => { if (!confirm('Retirer cette bulle voisine ?')) return; await api('/api/federation/partenaires?url=' + encodeURIComponent(b.dataset.retirerFed), { method: 'DELETE' }); rendreFederationAdmin(); chargerFederation(); }));
}
function fichePartager() {
  const base = location.origin;
  const iframe = `<iframe src="${base}/publique" width="100%" height="520" style="border:0;border-radius:8px" title="Carte du réseau" loading="lazy"></iframe>`;
  const ha = `rest:\n  - resource: ${base}/api/export/resume.json\n    scan_interval: 120\n    sensor:\n      - name: "Gaulix nœuds actifs"\n        value_template: "{{ value_json.noeudsActifs }}"\n      - name: "Gaulix couverture"\n        unit_of_measurement: "%"\n        value_template: "{{ value_json.couverturePct }}"\n      - name: "Gaulix alertes critiques"\n        value_template: "{{ value_json.alertesCritiques }}"`;
  const lien = (url, lib, desc) => `<div class="ligne"><span class="titre"><a href="${url}" target="_blank" rel="noopener">${lib}</a><small>${desc}</small></span><span class="meta"><button class="mini" data-copier="${esc(url)}">Copier</button></span></div>`;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `<h2>Carte publique et exports</h2>
    <h3>Carte publique allégée</h3>
    <p class="note">Relais, passerelles, nœuds à position approchée et liaisons, mise à jour chaque minute. Aucun message ni position exacte de particulier. Onglets Meshtastic / MeshCore / Les deux et animation en direct des paquets. Options : <span class="mono">?reseau=meshtastic</span> (ou <span class="mono">meshcore</span>, <span class="mono">deux</span>), <span class="mono">?animations=0</span>, <span class="mono">?couverture=actuelle</span> (ou <span class="mono">point</span> : couverture du point cliqué, ou <span class="mono">sites</span> : où poser des relais, avec <span class="mono">&acces=4x4</span>, <span class="mono">pied</span> ou <span class="mono">tous</span>), <span class="mono">?fond=Plan IGN</span>, <span class="mono">?clients=0</span> (relais seuls), <span class="mono">?liens=0</span>, <span class="mono">?titre=…</span></p>
    ${lien(base + '/publique', base + '/publique', 'à ouvrir ou à intégrer')}
    <label class="bloc-code">Code à coller dans une page (gaulix.fr…)<textarea readonly rows="3">${esc(iframe)}</textarea></label>
    <p class="note">La page doit être joignable depuis internet (par exemple via Tailscale Funnel ou un reverse proxy) pour être vue par les visiteurs d’un site.</p>
    <h3>Exports</h3>
    ${lien(base + '/api/export/relais.gpx', 'Relais et passerelles (GPX)', 'pour OsmAnd, un GPS de randonnée ou une tournée de maintenance')}
    ${lien(base + '/api/export/noeuds.geojson', 'Nœuds (GeoJSON)', 'QGIS, uMap, sites web')}
    ${lien(base + '/api/export/liens.geojson', 'Liaisons radio 24 h (GeoJSON)', 'QGIS, uMap ; ?heures=168 pour 7 jours')}
    ${lien(base + '/api/export/resume.json', 'Résumé (JSON)', 'Home Assistant, scripts, tableaux de bord')}
    ${lien(base + '/metrics', 'Métriques Prometheus', 'à ajouter comme cible dans Prometheus, puis tableaux Grafana')}
    <h3>Home Assistant</h3>
    <label class="bloc-code">Dans configuration.yaml<textarea readonly rows="11">${esc(ha)}</textarea></label>
    ${etat.admin ? `<h3>Bulles voisines (fédération)</h3>
    <p class="note">Déclarez les cartes live des départements voisins : leurs relais s’affichent (couche « Bulles voisines ») et comptent dans les calculs de couverture près des limites. Votre propre carte publie ses relais à l’adresse <span class="mono">${esc(base)}/api/federation</span> : donnez votre adresse aux autres bulles.</p>
    <div id="liste-federation"><div class="vide">Chargement…</div></div>
    <form id="f-federation" class="parametres compact"><label>Adresse de la carte voisine <input name="url" placeholder="https://carte-42.exemple.fr" required></label><label>Nom (facultatif) <input name="nom" placeholder="Loire"></label><button type="submit" class="principal">Ajouter</button></form>
    <p class="erreur" id="federation-retour"></p>` : ''}
    <p class="note">Ces exports suivent les mêmes règles de confidentialité que la carte publique. Pour les protéger, définissez <span class="mono">EXPORT_JETON</span> dans le fichier .env : il faut alors ajouter <span class="mono">?jeton=…</span> aux adresses (ou l’en-tête « Authorization: Bearer … »).</p>`;
  if (etat.admin) {
    rendreFederationAdmin();
    $('#f-federation').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      $('#federation-retour').textContent = 'Connexion à la carte voisine…';
      try { const r = await postJson('/api/federation/partenaires', { url: f.url.value.trim(), nom: f.nom.value.trim() }); $('#federation-retour').textContent = r.erreur ? `Ajoutée, mais injoignable pour l’instant : ${r.erreur}` : `✔ Ajoutée : ${r.relais} relais récupérés.`; f.reset(); rendreFederationAdmin(); chargerFederation(); } catch (err) { $('#federation-retour').textContent = err.message; }
    };
  }
}
function allerPlan() {
  const b = document.querySelector('.onglets button[data-onglet="sites"]');
  if (b) b.click();
  setTimeout(() => { const bp = $('#bloc-plan'); if (bp) { bp.scrollIntoView({ behavior: 'smooth', block: 'start' }); bp.classList.add('surbrillance'); setTimeout(() => bp.classList.remove('surbrillance'), 1500); } }, 300);
}

// ---- Plan pour couvrir le département ------------------------------------------------------------
async function planDepartement() {
  const objectif = Number($('#plan-objectif').value) || 95, max = Number($('#plan-max').value) || 15;
  const acces = $('#plan-acces').value, reseau = $('#plan-reseau').checked;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<h2>Plan de couverture</h2><div class="alerte info-lecture"><span class="sablier"></span> Recherche des sites…</div>';
  let r;
  try { r = await api(`/api/relief/plan?objectif=${objectif}&max=${max}&acces=${acces}&reseau=${reseau ? 1 : 0}&realiste=${$('#plan-realiste').checked ? 1 : 0}`); } catch (e) { $('#fiche-contenu').innerHTML = `<h2>Plan de couverture</h2><div class="vide">${esc(e.message)}</div>`; return; }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const e = r.emprise, g = L.layerGroup();
  L.imageOverlay(r.image, [[e.sud, e.ouest], [e.nord, e.est]], { opacity: 0.7, pane: 'couverture', className: 'pixelise' }).addTo(g);
  r.sites.forEach((x) => L.marker([x.lat, x.lon], { icon: L.divIcon({ className: 'relais-a-installer', html: `<div class="epingle"><b>${x.rang}</b></div>`, iconSize: [34, 44], iconAnchor: [17, 42] }), pane: 'traces', zIndexOffset: 900 })
    .bindTooltip(`<b>${x.rang} · ${esc(nomSommet(x))}</b><br>${x.alt} m${x.commune ? ' · ' + esc(x.commune) : ''}<br>+${x.gainKm2} km² · cumul ${fmt(x.totalPct, 1, ' %')}<br>${x.acces ? ACCES[x.acces.type].icone + ' ' + ACCES[x.acces.type].nom : 'accès non évalué'}`, { className: 'info' }).addTo(g));
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  if (r.sites.length) carte.fitBounds(L.latLngBounds(r.sites.map((x) => [x.lat, x.lon])).pad(0.3), { maxZoom: 11 });
  const nomAcces = { tous: 'tous les points hauts', voiture: 'accessibles en voiture', '4x4': 'accessibles en 4×4 ou voiture', pied: 'accessibles à pied, en 4×4 ou voiture' }[r.filtreAcces];
  $('#fiche-contenu').innerHTML = `<h2>Plan pour couvrir le département</h2>
    <div class="ident">Objectif ${r.objectifPct} % · au plus ${r.max} sites · ${esc(nomAcces)} · ${r.avecReseau ? `en complément du réseau actuel (${r.reseau.length} relais)` : 'sans tenir compte du réseau actuel'}</div>
    <div class="barre-couv"><i style="width:${r.departPct}%" class="actuel"></i><i style="width:${Math.max(0, r.finalPct - r.departPct)}%" class="ajout"></i></div>
    <div class="alerte ${r.atteint ? 'info-lecture' : 'attention'}">${r.atteint ? `✔ Objectif atteint avec <b>${r.sites.length} site${r.sites.length > 1 ? 's' : ''}</b> : ${fmt(r.departPct, 1, ' %')} → <b>${fmt(r.finalPct, 1, ' %')}</b> du département.` : `Objectif non atteint : ${fmt(r.departPct, 1, ' %')} → <b>${fmt(r.finalPct, 1, ' %')}</b> avec ${r.sites.length} site${r.sites.length > 1 ? 's' : ''}. ${r.sites.length >= r.max ? 'Augmentez le nombre de sites' : 'Les sites restants n’apportent presque rien'}${r.filtreAcces !== 'tous' ? ' ou élargissez l’accès' : ''}.`}</div>
    ${r.filtreAcces !== 'tous' && r.accesEtat && r.accesEtat.faits < r.accesEtat.total ? `<div class="alerte attention">Accès aux sites en cours d’évaluation (OpenStreetMap) : ${r.accesEtat.faits}/${r.accesEtat.total} points. ${r.candidats ? 'Le plan ne porte que sur les sites déjà évalués.' : 'Aucun site évalué pour l’instant : choisissez « Tous les points hauts » ou réessayez dans quelques minutes.'}</div>` : ''}
    ${r.sites.map((x) => `<div class="proposition etape-relier nouveau">
      <div class="entete-prop"><span class="lettre">${x.rang}</span><b>${esc(nomSommet(x))}</b><span class="marge">+${x.gainKm2} km² · ${fmt(x.totalPct, 1, ' %')}</span></div>
      <div class="meta-longue">${x.alt} m${x.commune ? ' · ' + esc(x.commune) : ''}</div>
      <div class="meta-longue">Accès : ${texteAcces(x.acces)}</div>
      <div class="meta-longue">Site : ${texteRealisme(x.realisme)}</div>
      ${blocCoords(x.lat, x.lon, { alt: x.alt })}
    </div>`).join('') || '<div class="vide">Aucun site ne répond à ces critères.</div>'}
    ${r.realiste && r.realismeEtat && !r.realismeEtat.pret ? '<div class="alerte attention">Données OpenStreetMap des sites (supports, zones protégées, habitations) pas encore chargées : le plan n’a pas pu en tenir compte. Réessayez dans quelques minutes.</div>' : ''}
    <div class="actions-prop"><button id="plan-gpx">Télécharger les sites (GPX)</button>${r.sites.length >= 2 && r.sites.length <= 10 ? '<button id="plan-couv">Couverture détaillée (marges)</button>' : ''}</div>
    <p class="note">Bleu : déjà couvert par le réseau · turquoise : apporté par les nouveaux sites · rouge : reste non couvert. Chaque site est choisi pour couvrir le plus de surface encore non desservie. ${r.candidats} points hauts candidats.${r.parametres ? ` Antennes ${r.parametres.hs} m, ${esc(r.parametres.preset)}, marge ${r.parametres.margeSecurite} dB + ${r.parametres.env} dB de pertes d’environnement.` : ''}</p>`;
  $('#plan-gpx').onclick = () => telechargerGpx('plan-couverture.gpx', r.sites.map((x) => ({ lat: x.lat, lon: x.lon, alt: x.alt, nom: `${x.rang} - ${nomSommet(x)}`, desc: `+${x.gainKm2} km², cumul ${x.totalPct} %${x.acces ? ', accès ' + ACCES[x.acces.type].nom : ''}` })));
  const pc = $('#plan-couv'); if (pc) pc.onclick = () => couvertureMulti(r.sites.map((x) => ({ lat: x.lat, lon: x.lon, h: (r.parametres && r.parametres.hs) || 6, nom: nomSommet(x) })));
}

// ---- Plan à budget -------------------------------------------------------------------------------------
async function planBudget(o) {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<h2>💶 Plan à budget</h2><div class="alerte info-lecture"><span class="sablier"></span> Recherche des meilleurs emplacements…</div>';
  let r;
  try { r = await api(`/api/relief/budget?n=${encodeURIComponent(o.n)}&acces=${encodeURIComponent(o.acces)}&secteur=${encodeURIComponent(o.secteur)}&solaire=${encodeURIComponent(o.solaire)}&mat=${encodeURIComponent(o.mat)}`); } catch (e) { z.innerHTML = `<h2>💶 Plan à budget</h2><div class="vide">${esc(e.message)}</div>`; return; }
  if (etat.coucheCouverture) etat.coucheCouverture.remove();
  const g = L.layerGroup();
  r.sites.forEach((x) => L.marker([x.lat, x.lon], { icon: L.divIcon({ className: 'relais-a-installer', html: `<div class="epingle"><b>${x.rang}</b></div>`, iconSize: [34, 44], iconAnchor: [17, 42] }), pane: 'traces', zIndexOffset: 900 })
    .bindTooltip(`<b>${x.rang} · ${esc(nomSommet(x))}</b><br>+${x.gainKm2} km² · +${x.habitantsGagnes.toLocaleString('fr-FR')} hab.<br>${x.alimentation} · ≈ ${x.cout} €`, { className: 'info' }).addTo(g));
  g.addTo(carte);
  etat.coucheCouverture = g;
  $('#btn-effacer').hidden = false;
  if (r.sites.length) carte.fitBounds(L.latLngBounds(r.sites.map((x) => [x.lat, x.lon])).pad(0.3), { maxZoom: 11 });
  const pop = r.population, pct = (v) => (pop.totale ? fmt((v / pop.totale) * 100, 1, ' %') : '–');
  z.innerHTML = `<h2>💶 Plan à budget : ${r.sites.length} relais</h2>
    <div class="grille">
      <div class="mesure"><span>Surface couverte</span><b>${fmt(r.departPct, 1, ' %')} → ${fmt(r.finalPct, 1, ' %')}</b></div>
      <div class="mesure"><span>Habitants (bourg couvert)</span><b>${pct(pop.depart)} → ${pct(pop.finale)}</b></div>
      <div class="mesure"><span>Coût estimé</span><b>≈ ${r.coutTotal.toLocaleString('fr-FR')} €</b></div>
    </div>
    ${r.sites.length < Number(r.n) ? `<div class="alerte attention">Seulement ${r.sites.length} site(s) utile(s) avec ces critères : les suivants n’apporteraient presque rien${r.filtreAcces !== 'tous' ? ' (ou élargissez l’accès exigé)' : ''}.</div>` : ''}
    ${r.sites.map((x) => `<div class="proposition etape-relier nouveau">
      <div class="entete-prop"><span class="lettre">${x.rang}</span><b>${esc(nomSommet(x))}</b><span class="marge">≈ ${x.cout} € · cumul ${x.coutCumule} €</span></div>
      <div class="meta-longue">+${x.gainKm2} km² (cumul ${fmt(x.totalPct, 1, ' %')}) · <b>+${x.habitantsGagnes.toLocaleString('fr-FR')} habitants</b>${x.nbCommunesGagnees ? ` dans ${x.nbCommunesGagnees} commune(s) : ${esc(x.communesGagnees.join(', '))}${x.nbCommunesGagnees > x.communesGagnees.length ? '…' : ''}` : ''}</div>
      <div class="meta-longue">${x.alt} m${x.commune ? ' · ' + esc(x.commune) : ''} · alimentation ${x.alimentation}</div>
      <div class="meta-longue">Accès : ${texteAcces(x.acces)}</div>
      <div class="meta-longue">Site : ${texteRealisme(x.realisme)}</div>
      ${blocCoords(x.lat, x.lon, { alt: x.alt })}
    </div>`).join('') || '<div class="vide">Aucun site ne répond à ces critères.</div>'}
    <div class="actions-prop"><button id="budget-gpx">Télécharger les sites (GPX)</button>${r.sites.length >= 2 ? '<button id="budget-couv">Couverture détaillée</button>' : ''}</div>
    <p class="note">Ordre de pose conseillé : chaque relais est celui qui apporte le plus de surface nouvelle${r.realiste ? ' (sites en zone protégée écartés, préférence aux châteaux d’eau, pylônes et au secteur proche)' : ''}. Habitants : population des communes dont le bourg passe en zone couverte (${pop.communes} communes, ${pop.totale.toLocaleString('fr-FR')} habitants). Coût : relais ${r.couts.secteur} € (secteur) ou ${r.couts.solaire} € (solaire), + ${r.couts.mat} € de mât s’il n’y a pas de support existant ; hors main-d’œuvre et convention avec le propriétaire.</p>`;
  $('#budget-gpx').onclick = () => telechargerGpx('plan-budget.gpx', r.sites.map((x) => ({ lat: x.lat, lon: x.lon, alt: x.alt, nom: `${x.rang} - ${nomSommet(x)}`, desc: `+${x.gainKm2} km², +${x.habitantsGagnes} hab., ${x.alimentation}, ~${x.cout} €` })));
  const bc = $('#budget-couv'); if (bc) bc.onclick = () => couvertureMulti(r.sites.map((x) => ({ lat: x.lat, lon: x.lon, h: (r.parametres && r.parametres.hs) || 6, nom: nomSommet(x) })));
}

// Département étudié (relief, points hauts, plan) : celui de la carte ou n'importe quel autre
async function htmlChoixDepartement() {
  if (!etat.listeDeps) { try { etat.listeDeps = await api('/api/departements'); } catch { etat.listeDeps = []; } }
  const carteDep = etat.config.departement && etat.config.departement.code;
  const actuel = etat.depEtude || carteDep;
  return `<div class="choix-dep"><label>Département étudié <select id="dep-etude">${etat.listeDeps.map((d) => `<option value="${d.code}" ${d.code === actuel ? 'selected' : ''}>${d.code} · ${esc(d.nom)}${d.code === carteDep ? ' (carte)' : ''}</option>`).join('')}</select></label>${etat.depEtude ? '<button class="mini" id="dep-retour" title="Revenir au département de la carte">↩ département de la carte</button>' : ''}</div>`;
}
function brancherChoixDepartement() {
  const sel = $('#dep-etude');
  if (!sel) return;
  const changer = (code) => {
    const carteDep = etat.config.departement && etat.config.departement.code;
    etat.depEtude = code === carteDep ? null : code;
    try { if (etat.depEtude) localStorage.setItem('gaulix_dep_etude', etat.depEtude); else localStorage.removeItem('gaulix_dep_etude'); } catch { /* ignoré */ }
    etat.sommets = []; etat.classement = null; etat.relief = null;
    if (etat.coucheCouverture) { etat.coucheCouverture.remove(); etat.coucheCouverture = null; }
    dessinerSommets();
    $('#sites').innerHTML = '<div class="vide">Chargement du département…</div>';
    chargerRelief(true);
  };
  sel.onchange = () => changer(sel.value);
  const r = $('#dep-retour'); if (r) r.onclick = () => changer(etat.config.departement.code);
}
async function rendreSites() {
  const z = $('#sites');
  if (!z) return;
  const e = etat.relief;
  const choix = await htmlChoixDepartement();
  if (!e) { z.innerHTML = choix + '<div class="vide">Modèle de relief indisponible.</div>'; brancherChoixDepartement(); return; }
  const nomDep = e.departement ? `${e.departement.nom || ''} (${e.departement.code})` : '';
  if (e.mnt !== 'pret') {
    z.innerHTML = choix + `<div class="vide">${e.mnt === 'erreur' ? 'Erreur : ' + esc(e.erreur) : `Chargement du relief IGN ${esc(nomDep)}… ${e.progression || 0} %`}<br><small>Premier chargement d’un département : quelques minutes (relief IGN, points hauts OpenStreetMap, puis classement des sites). Ensuite il est gardé sur le disque.</small></div>`;
    brancherChoixDepartement();
    return;
  }
  const c = etat.classement;
  const avecCoords = (s, sous) => `${sous || ''} · <span class="mono">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</span>`;
  const ligneSite = (s, droite, sous, badge, or) => `<div class="ligne site" data-site="${s.id}"><span class="rang-site${or ? ' or' : ''}">${badge ?? ''}</span><span class="titre">${esc(nomSommet(s))} ${badgeAcces(s)}<small>${s.alt} m${s.commune && s.nom ? ' · ' + esc(s.commune) : ''}</small></span><span class="meta">${droite}</span><span class="sous-ligne meta-longue">${avecCoords(s, sous)}</span></div>`;
  const parId = new Map(etat.sommets.map((s) => [s.id, s]));
  let h = choix + `<div class="bloc-plan bloc-actuel">
      <h3>📡 Couverture actuelle du réseau</h3>
      <p class="note">Zone desservie aujourd’hui par les relais et passerelles détectés${c && c.reseauActuel ? ` : <b>${fmt(c.reseauActuel.pct, 1, ' %')}</b> du département avec ${c.reseauActuel.relais.length} relais` : ''}.</p>
      <div class="actions-prop"><button id="sites-couv-reseau" class="principal">Couverture calculée</button><button id="sites-couv-mesuree">📶 Couverture mesurée</button></div>
    </div>
    <div class="bloc-plan" id="bloc-plan">
      <h3>🎯 Plan pour couvrir ${e.departement ? esc(e.departement.nom || 'le département') : 'le département'}</h3>
      <div class="parametres compact">
        <label>Objectif (%) <input id="plan-objectif" type="number" min="10" max="100" step="1" value="95"></label>
        <label>Sites au plus <input id="plan-max" type="number" min="1" max="40" step="1" value="15"></label>
        <label>Accès exigé <select id="plan-acces"><option value="voiture">🚗 En voiture</option><option value="4x4">🚙 En 4×4 ou voiture</option><option value="pied">🥾 À pied ou mieux</option><option value="tous">Tous les points hauts</option></select></label>
      </div>
      <label class="case"><input type="checkbox" id="plan-reseau" checked> En complément du réseau actuel</label>
      <label class="case"><input type="checkbox" id="plan-realiste" checked> Sites réalistes : zones protégées écartées, châteaux d’eau et pylônes privilégiés, électricité</label>
      <div class="actions-prop"><button id="plan-calculer" class="principal">Donner les emplacements</button></div>
    </div>
    <div class="bloc-plan" id="bloc-budget">
      <h3>💶 Plan à budget</h3>
      <p class="note">« J’ai de quoi poser N relais : où les mettre ? » Gain de surface et d’habitants à chaque relais, coût estimé.</p>
      <div class="parametres compact">
        <label>Relais à poser <input id="budget-n" type="number" min="1" max="15" step="1" value="3"></label>
        <label>Accès exigé <select id="budget-acces"><option value="voiture">🚗 En voiture</option><option value="4x4">🚙 En 4×4 ou voiture</option><option value="pied">🥾 À pied ou mieux</option><option value="tous">Tous les points hauts</option></select></label>
        <label>Relais secteur (€) <input id="budget-secteur" type="number" min="0" step="10" value="120"></label>
        <label>Relais solaire (€) <input id="budget-solaire" type="number" min="0" step="10" value="220"></label>
        <label>Mât + fixations (€) <input id="budget-mat" type="number" min="0" step="10" value="90"></label>
      </div>
      <div class="actions-prop"><button id="budget-calculer" class="principal">Où poser mes relais ?</button></div>
    </div>
    <h3>🧭 Outils sur la carte</h3>
    <div class="outils-couv">
      <button data-outil="btn-couv-ici">📍 Couverture depuis un point<small>zone couverte par une antenne placée où vous cliquez (puis ＋ d’autres sites)</small></button>
      <button data-outil="btn-couvrir">🎯 Couvrir un ou plusieurs points<small>les points hauts capables de desservir le ou les lieux cliqués</small></button>
      <button data-outil="btn-relier">🔗 Relier deux lieux<small>faut-il des relais entre A et B, et où ?</small></button>
      <button data-outil="btn-profil">⛰️ Profil entre deux points<small>relief et dégagement de la liaison</small></button>
      <button data-outil="btn-simulation">🧪 Simulation « et si… »<small>retirer ou ajouter des relais : couverture et liaisons entre les villes</small></button>
    </div>
    <h3>Réglages des calculs</h3>
    <div class="parametres compact">
      <label>Antenne des sites (m) <input id="relief-hs" type="number" min="1" max="60" step="1" value="${c ? c.parametres.hs : 6}"></label>
      <label>Antenne à couvrir (m) <input id="relief-ht" type="number" min="0.5" max="20" step="0.5" value="${c ? c.parametres.ht : 2}"></label>
      <label>Accès aux sites <select id="filtre-acces">
        <option value="tous">Tous les points hauts</option>
        <option value="voiture">🚗 En voiture</option>
        <option value="4x4">🚙 En 4×4 ou voiture</option>
        <option value="pied">🥾 À pied, en 4×4 ou voiture</option>
      </select></label>
    </div>
    ${c && c.acces ? `<p class="note">${c.acces.enCours || c.acces.faits < c.acces.total ? `Recherche des voies d’accès (OpenStreetMap) : ${c.acces.faits}/${c.acces.total} points${c.acces.erreur ? ' · ' + esc(c.acces.erreur) + ', nouvel essai plus tard' : '…'}` : `Accès évalués pour ${c.acces.faits} points : voie à moins de 150 m.`}${etat.filtreAcces !== 'tous' && c.candidatsAcces != null ? ` <b>${c.candidatsAcces}</b> site(s) retenu(s) avec ce filtre.` : ''}</p>` : ''}`;
  if (!c) {
    h += `<div class="vide">${e.classement === 'erreur' ? 'Erreur : ' + esc(e.erreur) : 'Classement des sites en cours…'}</div>`;
  } else {
    const dernier = c.plan.length ? c.plan[c.plan.length - 1].totalPct : c.reseauActuel.pct;
    h += `<h3>Couverture du département</h3>
      <div class="barre-couv"><i style="width:${c.reseauActuel.pct}%" class="actuel"></i><i style="width:${Math.max(0, dernier - c.reseauActuel.pct)}%" class="ajout"></i></div>
      <p class="note">Réseau actuel (${c.reseauActuel.relais.length} relais et passerelles positionnés) : <b>${fmt(c.reseauActuel.pct, 1, ' %')}</b> de ${c.surfaceDepartementKm2} km². Avec les ${c.plan.length} sites ci-dessous : <b>${fmt(dernier, 1, ' %')}</b>.</p>
      <h3>Meilleurs sites à ajouter <span class="pastille or">${c.plan.length}</span></h3>
      <p class="note">Ordre de priorité : chaque site est celui qui couvre le plus de surface encore non desservie.</p>
      ${c.plan.map((p) => ligneSite(parId.get(p.id) || p, `+${p.gainKm2} km²`, `cumul ${fmt(p.totalPct, 1, ' %')}`, p.rang, true)).join('')}
      <h3>Plus fortes couvertures individuelles</h3>
      ${c.meilleursIndividuels.slice(0, 10).map((p, i) => ligneSite(parId.get(p.id) || p, fmt(p.pct, 1, ' %'), `${p.km2} km²`, i + 1, false)).join('')}
      <p class="note">Modèle : relief IGN RGE ALTI au pas de 250 m, terre 4/3, diffraction lame de couteau, ${esc(c.parametres.preset)}, ${c.parametres.ptx} dBm, antennes 2,15 dBi, marge ${c.parametres.margeSecurite} dB + pertes d'environnement ${c.parametres.env} dB${c.calibration && c.calibration.perteEnvironnementDb != null ? ` (calibrées sur ${c.calibration.liaisons} liaisons mesurées)` : ' (valeur par défaut)'}, rayon ${c.parametres.rayonKm} km. ${c.candidats} sites évalués en ${c.dureeSecondes} s · ${ilYa(c.date)}.</p>`;
  }
  if (c) h += `<div class="actions-prop"><button id="gpx-sites">Télécharger les sites recommandés (GPX)</button><button id="gpx-sommets">Tous les points hauts (GPX)</button></div>`;
  h += `<div id="couverture-info" class="note"></div>`;
  z.innerHTML = h;
  brancherChoixDepartement();
  const bcr = $('#sites-couv-reseau'); if (bcr) bcr.onclick = couvertureReseau;
  const bcm = $('#sites-couv-mesuree'); if (bcm) bcm.onclick = () => couvertureMesuree();
  z.querySelectorAll('[data-outil]').forEach((b) => (b.onclick = () => { const t = $('#' + b.dataset.outil); if (t) t.click(); }));
  const bb = $('#budget-calculer');
  if (bb) {
    try { const v = localStorage.getItem('gaulix_budget'); if (v) { const o = JSON.parse(v); for (const k of ['n', 'acces', 'secteur', 'solaire', 'mat']) if (o[k] != null) $('#budget-' + k).value = o[k]; } } catch { /* ignoré */ }
    bb.onclick = () => {
      const o = Object.fromEntries(['n', 'acces', 'secteur', 'solaire', 'mat'].map((k) => [k, $('#budget-' + k).value]));
      try { localStorage.setItem('gaulix_budget', JSON.stringify(o)); } catch { /* ignoré */ }
      planBudget(o);
    };
  }
  const pc = $('#plan-calculer');
  if (pc) {
    try { const v = localStorage.getItem('gaulix_plan'); if (v) { const o = JSON.parse(v); $('#plan-objectif').value = o.objectif; $('#plan-max').value = o.max; $('#plan-acces').value = o.acces; $('#plan-reseau').checked = o.reseau; } } catch { /* ignoré */ }
    pc.onclick = () => {
      try { localStorage.setItem('gaulix_plan', JSON.stringify({ objectif: $('#plan-objectif').value, max: $('#plan-max').value, acces: $('#plan-acces').value, reseau: $('#plan-reseau').checked })); } catch { /* ignoré */ }
      planDepartement();
    };
  }
  const fa = $('#filtre-acces');
  if (fa) {
    fa.value = etat.filtreAcces;
    fa.onchange = async () => {
      etat.filtreAcces = fa.value;
      try { localStorage.setItem('gaulix_acces', fa.value); } catch { /* indisponible */ }
      try { const c2 = await api('/api/relief/classement?acces=' + fa.value); if (!c2.attente) { etat.classement = c2; appliquerPlan(); } } catch { /* ignore */ }
      dessinerSommets();
      rendreSites();
    };
  }
  const g1 = $('#gpx-sites'), g2 = $('#gpx-sommets');
  if (g1) g1.onclick = () => telechargerGpx(`sites-recommandes-${(e.departement && e.departement.code) || ''}.gpx`, c.plan.map((p) => {
    const s = parId.get(p.id) || p;
    return { lat: s.lat, lon: s.lon, alt: s.alt, nom: `${p.rang} - ${nomSommet(s)}`, desc: `+${p.gainKm2} km², cumul ${p.totalPct} %` };
  }));
  if (g2) g2.onclick = () => telechargerGpx(`points-hauts-${(e.departement && e.departement.code) || ''}.gpx`, etat.sommets.filter((s) => s.dansZone && accesOk(s)).map((s) => ({ lat: s.lat, lon: s.lon, alt: s.alt, nom: nomSommet(s), desc: [s.couverturePct != null ? `Couverture ${s.couverturePct} %` : '', s.acces ? 'Accès ' + ACCES[s.acces.type].nom : ''].filter(Boolean).join(' · ') })));
  z.querySelectorAll('[data-site]').forEach((el) => (el.onclick = () => {
    const s = parId.get(Number(el.dataset.site));
    if (s) ficheSommet(s);
  }));
}

// ---- Relier deux lieux : faut-il des relais, et où ? -----------------------------------------
function nomLieu(latlng) {
  // Un nœud ou un point haut à moins de 400 m donne son nom au point cliqué
  let meilleur = null, dmin = 400;
  for (const n of etat.noeuds.values()) if (n.lat != null) { const d = carte.distance(latlng, [n.lat, n.lon]); if (d < dmin) { dmin = d; meilleur = { nom: n.nomLong || n.nomCourt || n.id, lat: n.lat, lon: n.lon, noeud: true }; } }
  for (const s of etat.sommets || []) { const d = carte.distance(latlng, [s.lat, s.lon]); if (d < dmin) { dmin = d; meilleur = { nom: nomSommet(s), lat: s.lat, lon: s.lon }; } }
  return meilleur || { nom: `Point ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`, lat: latlng.lat, lon: latlng.lng };
}
function choisirPointRelier(latlng) {
  const p = nomLieu(latlng);
  if (!etat.relierA) {
    etat.relierA = p;
    if (etat.repereRelier) etat.repereRelier.remove();
    etat.repereRelier = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#2dd4bf', weight: 3, fillOpacity: 0.3, pane: 'traces' }).bindTooltip('Départ : ' + p.nom, { permanent: true, direction: 'top', className: 'info' }).addTo(carte);
    basculerMode('relier');
    return;
  }
  const a = etat.relierA;
  etat.relierA = null;
  basculerMode(null);
  relierPoints(a, p);
}
async function relierPoints(a, b, opts = {}) {
  const hs = $('#relief-hs') ? $('#relief-hs').value : 6;
  const hA = opts.hA ?? 2, hB = opts.hB ?? 2;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `<h2>Relier deux lieux</h2><div class="alerte info-lecture"><span class="sablier"></span> Recherche du chemin radio entre <b>${esc(a.nom)}</b> et <b>${esc(b.nom)}</b> (relais existants et points hauts)…</div>`;
  const q = new URLSearchParams({ aLat: a.lat.toFixed(5), aLon: a.lon.toFixed(5), bLat: b.lat.toFixed(5), bLon: b.lon.toFixed(5), aNom: a.nom, bNom: b.nom, hs, hA, hB, acces: etat.filtreAcces || 'tous', ...(etat.vueReseau === 'meshcore' ? { reseau: 'meshcore', preset: 'MESHCORE_FR' } : {}) });
  let r;
  try { r = await api('/api/relief/relier?' + q); } catch (e) { $('#fiche-contenu').innerHTML = `<h2>Relier deux lieux</h2><div class="vide">${esc(e.message)}</div>`; return; }
  if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
  const g = L.layerGroup().addTo(carte);
  etat.coucheCouvrir = g;
  $('#btn-effacer').hidden = false;
  const ICONES = { depart: '🅰', arrivee: '🅱', existant: '📡', nouveau: '🆕' };
  const pts = [[r.a.lat, r.a.lon], [r.b.lat, r.b.lon]];
  if (r.possible) {
    r.bonds.forEach((l, k) => {
      const x = r.chemin[k], y = r.chemin[k + 1];
      L.polyline([[x.lat, x.lon], [y.lat, y.lon]], { color: hexMarge(l.marge), weight: 4, opacity: 0.9, pane: 'traces' })
        .bindTooltip(`Bond ${k + 1} : ${fmt(l.distance / 1000, 1, ' km')} · marge ${l.marge >= 0 ? '+' : ''}${fmt(l.marge, 1, ' dB')}`, { className: 'info', sticky: true }).addTo(g);
    });
    r.chemin.forEach((c, k) => {
      pts.push([c.lat, c.lon]);
      const nouveau = c.type === 'nouveau';
      const lettre = k === 0 ? 'A' : k === r.chemin.length - 1 ? 'B' : k;
      if (nouveau) {
        // Emplacement du relais à installer : zone de recherche (~400 m), épingle bien visible et étiquette permanente
        L.circle([c.lat, c.lon], { radius: 400, color: '#ff6bd6', weight: 2, dashArray: '5 5', fillColor: '#ff6bd6', fillOpacity: 0.12, pane: 'couverture', interactive: false, className: 'zone-relais' }).addTo(g);
        // Autres emplacements possibles pour ce relais : petits repères creux reliés au site principal
        const alt = (r.alternatives || []).find((x) => x.etape === k);
        (alt ? alt.options : []).forEach((o, j) => {
          L.polyline([[c.lat, c.lon], [o.lat, o.lon]], { color: '#ff6bd6', weight: 1.2, opacity: 0.6, dashArray: '2 6', pane: 'traces', interactive: false }).addTo(g);
          L.marker([o.lat, o.lon], { icon: L.divIcon({ className: 'relais-alt', html: `<span>${lettre}${String.fromCharCode(97 + j)}</span>`, iconSize: [20, 20], iconAnchor: [10, 10] }), pane: 'traces', zIndexOffset: 700 })
            .bindTooltip(`<b>Variante ${lettre}${String.fromCharCode(97 + j)} pour le relais ${lettre}</b><br>${esc(o.nom || nomSommet(o))} · ${o.alt} m${o.commune ? ' · ' + esc(o.commune) : ''}<br>marge mini ${fmt(o.margeMin, 1, ' dB')}${o.acces ? ' · ' + ACCES[o.acces.type].nom : ''}`, { className: 'info' }).addTo(g);
        });
        L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'relais-a-installer', html: `<div class="epingle"><b>${lettre}</b></div><i class="pulsation"></i>`, iconSize: [34, 44], iconAnchor: [17, 42] }), pane: 'traces', zIndexOffset: 900 })
          .bindTooltip(`<b>Relais ${lettre} à installer</b> · ${esc(c.nom || nomSommet(c))}<br>${c.alt} m · antenne ${c.hauteur} m${c.acces ? ' · ' + texteAcces(c.acces) : ''}`, { className: 'info etiquette-relais', permanent: true, direction: 'top', offset: [0, -46] })
          .on('click', () => { const el = document.querySelector(`.etape-relier[data-etape="${k}"]`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('surbrillance'); setTimeout(() => el.classList.remove('surbrillance'), 1500); } })
          .addTo(g);
        return;
      }
      L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'sommet plan existant-relier', html: `<span>${lettre}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }), pane: 'traces', zIndexOffset: 800 })
        .bindTooltip(`<b>${esc(c.nom || nomSommet(c))}</b><br>${{ depart: 'Départ', arrivee: 'Arrivée', existant: 'Relais existant', nouveau: 'Relais à installer' }[c.type]} · ${c.alt} m`, { className: 'info' }).addTo(g);
    });
  } else {
    L.polyline(pts, { color: '#ff5c6c', weight: 2, dashArray: '6 6', pane: 'traces' }).addTo(g);
  }
  carte.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 12 });
  const ligneEtape = (c, k) => {
    const l = k > 0 ? r.bonds[k - 1] : null;
    const titre = { depart: 'Départ', arrivee: 'Arrivée', existant: 'Relais existant', nouveau: 'Nouveau relais à installer' }[c.type];
    const alt = (r.alternatives || []).find((x) => x.etape === k);
    return `${l ? `<div class="bond-relier" style="border-color:${couleurMarge(l.marge)}">↓ ${fmt(l.distance / 1000, 1, ' km')} · marge <b style="color:${couleurMarge(l.marge)}">${l.marge >= 0 ? '+' : ''}${fmt(l.marge, 1, ' dB')}</b> · ${l.obstacle ? `obstacle à ${fmt(l.obstacle.distanceKm, 1, ' km')}` : 'visibilité directe'}</div>` : ''}
      <div class="proposition etape-relier ${c.type}" data-etape="${k}" data-lat="${c.lat}" data-lon="${c.lon}">
        <div class="entete-prop"><span class="lettre">${k === 0 ? 'A' : k === r.chemin.length - 1 ? 'B' : k}</span><b>${esc(c.nom || nomSommet(c))}</b><span class="marge">${titre}</span></div>
        <div class="meta-longue">${c.alt} m${c.commune ? ' · ' + esc(c.commune) : ''} · antenne ${c.hauteur} m${c.type === 'nouveau' ? ` · Accès : ${texteAcces(c.acces)}` : ''}</div>
        ${c.type === 'nouveau' ? blocCoords(c.lat, c.lon, { alt: c.alt }) : ''}
        ${alt && alt.options.length ? `<details class="alt-relier"><summary>Autres emplacements possibles (${alt.options.length})</summary>${alt.options.map((o, j) => `<div class="ligne-alt" data-lat="${o.lat}" data-lon="${o.lon}"><b class="repere-alt">${k}${String.fromCharCode(97 + j)}</b> ${esc(o.nom || nomSommet(o))} · ${o.alt} m${o.commune ? ' · ' + esc(o.commune) : ''} · marge mini ${fmt(o.margeMin, 1, ' dB')} ${o.acces ? ACCES[o.acces.type].icone : ''}</div>`).join('')}</details>` : ''}
      </div>`;
  };
  $('#fiche-contenu').innerHTML = `<h2>Relier ${esc(a.nom)} → ${esc(b.nom)}</h2>
    <div class="ident">${fmt(r.distanceKm, 1, ' km')} à vol d’oiseau · ${esc(r.parametres.preset)} · antennes : relais ${r.parametres.hs} m, extrémités ${hA} / ${hB} m${r.filtreAcces !== 'tous' ? ` · sites ${esc(ACCES[r.filtreAcces] ? ACCES[r.filtreAcces].nom : r.filtreAcces)}` : ''}</div>
    ${!r.possible ? `<div class="alerte attention">✖ ${esc(r.raison)}</div><p class="note">Essayez des antennes plus hautes aux extrémités, ou retirez le filtre d’accès (onglet Couverture).</p>`
      : r.nouveaux === 0 && r.chemin.length === 2 ? `<div class="alerte info-lecture">✔ <b>Liaison directe possible</b> sans relais (marge ${r.direct.marge >= 0 ? '+' : ''}${fmt(r.direct.marge, 1, ' dB')}).</div>`
      : `<div class="alerte ${r.nouveaux ? 'attention' : 'info-lecture'}">${r.nouveaux ? `⚠ Il faut <b>${r.nouveaux} nouveau${r.nouveaux > 1 ? 'x' : ''} relais</b>` : '✔ Possible avec les relais existants'}${r.chemin.some((c) => c.type === 'existant') ? `, en passant par ${r.chemin.filter((c) => c.type === 'existant').map((c) => esc(c.nom)).join(', ')}` : ''}.</div>
         <p class="note">Liaison directe impossible : marge ${r.direct ? fmt(r.direct.marge, 1, ' dB') : '–'}${r.direct && r.direct.obstacle ? `, relief à ${fmt(r.direct.obstacle.distanceKm, 1, ' km')} (${r.direct.obstacle.hauteur} m au-dessus de la visée)` : ''}.</p>`}
    <div class="parametres compact">
      <label>Antenne au départ (m) <input id="relier-ha" type="number" min="0.5" max="60" step="0.5" value="${hA}"></label>
      <label>Antenne à l’arrivée (m) <input id="relier-hb" type="number" min="0.5" max="60" step="0.5" value="${hB}"></label>
      <button id="relier-recalc">Recalculer</button>
    </div>
    ${r.possible ? r.chemin.map(ligneEtape).join('') : ''}
    ${r.possible && r.nouveaux ? '<div class="actions-prop"><button id="gpx-relier">Télécharger les points (GPX)</button></div>' : ''}
    <p class="note">Chaque bond doit garder au moins 0 dB de marge après ${r.parametres.margeSecurite} dB de marge de sécurité et ${r.parametres.env} dB de pertes de végétation et bâti (calibrées sur vos liaisons mesurées). Le chemin privilégie les relais existants, puis le moins de nouveaux sites possible, puis les bonds les plus confortables.${r.evalues ? ` ${r.evalues} sites évalués${r.dureeMs ? ' en ' + fmt(r.dureeMs / 1000, 1, ' s') : ''}.` : ''}</p>`;
  $('#relier-recalc').onclick = () => relierPoints(a, b, { hA: Number($('#relier-ha').value) || 2, hB: Number($('#relier-hb').value) || 2 });
  $('#fiche-contenu').querySelectorAll('.ligne-alt').forEach((el) => (el.onclick = () => carte.flyTo([Number(el.dataset.lat), Number(el.dataset.lon)], 14)));
  // Clic sur une étape « relais à installer » : la carte se centre sur l'emplacement
  $('#fiche-contenu').querySelectorAll('.etape-relier.nouveau .entete-prop').forEach((el) => { el.style.cursor = 'pointer'; el.title = 'Centrer la carte sur cet emplacement'; el.onclick = () => { const d = el.closest('.etape-relier').dataset; carte.flyTo([Number(d.lat), Number(d.lon)], 14); }; });
  const gx = $('#gpx-relier');
  if (gx) gx.onclick = () => telechargerGpx('relier.gpx', r.chemin.map((c, k) => ({ lat: c.lat, lon: c.lon, alt: c.alt, nom: `${k === 0 ? 'A' : k === r.chemin.length - 1 ? 'B' : k} - ${c.nom || nomSommet(c)}`, desc: c.type === 'nouveau' ? 'Relais à installer' : c.type === 'existant' ? 'Relais existant' : '' })));
}

async function couvrirPoint(latlng) {
  const hs = $('#relief-hs') ? $('#relief-hs').value : 6, ht = $('#relief-ht') ? $('#relief-ht').value : 2;
  if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
  const g = L.layerGroup().addTo(carte);
  etat.coucheCouvrir = g;
  $('#btn-effacer').hidden = false;
  L.marker(latlng, { icon: L.divIcon({ className: 'cible-couvrir', html: '✚', iconSize: [24, 24], iconAnchor: [12, 12] }), pane: 'traces' }).addTo(g);
  const fiche = $('#fiche');
  fiche.hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = '<div class="vide">Recherche des points hauts capables de couvrir ce point…</div>';
  let r;
  try { r = await api(`/api/relief/couvrir?lat=${latlng.lat.toFixed(5)}&lon=${latlng.lng.toFixed(5)}&hs=${hs}&ht=${ht}&acces=${etat.filtreAcces}${etat.vueReseau === 'meshcore' ? '&reseau=meshcore&preset=MESHCORE_FR' : ''}`); } catch (e) { $('#fiche-contenu').innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const pts = [latlng];
  r.propositions.forEach((p, i) => {
    pts.push([p.lat, p.lon]);
    L.polyline([latlng, [p.lat, p.lon]], { color: hexMarge(p.marge), weight: 3, opacity: 0.9, dashArray: p.marge >= 0 ? null : '6 6', pane: 'traces' }).addTo(g);
    if (p.raccord) L.polyline([[p.lat, p.lon], [p.raccord.lat, p.raccord.lon]], { color: hexMarge(p.raccord.marge), weight: 1.5, opacity: 0.7, dashArray: '2 6', pane: 'traces' }).addTo(g);
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'sommet propose', html: `<span>${String.fromCharCode(65 + i)}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }), pane: 'traces' })
      .bindTooltip(`<b>${String.fromCharCode(65 + i)} · ${esc(nomSommet(p))}</b><br>${p.alt} m · ${fmt(p.distanceKm, 1, ' km')} · marge ${fmt(p.marge, 1, ' dB')}`, { className: 'info' })
      .addTo(g);
  });
  carte.fitBounds(L.latLngBounds(pts), { padding: [90, 90], maxZoom: 12 });
  const c = r.cible;
  const carteProp = (p, i) => {
    const lettre = String.fromCharCode(65 + i);
    const obst = p.obstacle ? `obstacle à ${fmt(p.obstacle.distanceKm, 1, ' km')} (${p.obstacle.hauteur} m au-dessus de la visée), diffraction ${fmt(p.diffraction, 1, ' dB')}` : 'visibilité directe';
    return `<div class="proposition" style="border-left-color:${couleurMarge(p.marge)}">
      <div class="entete-prop"><span class="lettre">${lettre}</span><b>${esc(nomSommet(p))}</b><span class="marge" style="color:${couleurMarge(p.marge)}">${p.marge >= 0 ? '+' : ''}${fmt(p.marge, 1, ' dB')}</span></div>
      <div class="meta-longue">${p.alt} m${p.nom && p.commune ? ' · ' + esc(p.commune) : ''} · à ${fmt(p.distanceKm, 1, ' km')} · ${obst}</div>
      <div class="meta-longue">Accès : ${texteAcces(p.acces)}</div>
      <div class="meta-longue">${p.raccord ? `Raccord au réseau : <b>${esc(p.raccord.nom)}</b> à ${fmt(p.raccord.distanceKm, 1, ' km')}, marge <span style="color:${couleurMarge(p.raccord.marge)}">${fmt(p.raccord.marge, 1, ' dB')}</span>` : '<span style="color:var(--critique)">Aucun relais existant joignable depuis ce site</span>'}${p.couverturePct != null ? ` · couvre seul ${fmt(p.couverturePct, 1, ' %')} du département` : ''}</div>
      ${blocCoords(p.lat, p.lon)}
      <div class="actions-prop"><button data-couv="${i}">Voir la couverture</button><button data-prof="${i}">⛰ Profil</button></div>
    </div>`;
  };
  $('#fiche-contenu').innerHTML = `
    <h2>Couvrir ce point</h2>
    ${blocCoords(c.lat, c.lon, { alt: c.alt })}
    <div class="meta-longue">antenne à ${r.parametres.ht} m · sites à ${r.parametres.hs} m · ${esc(r.parametres.preset)}</div>
    <div class="actions-prop"><button id="ajout-cible" class="principal">＋ Ajouter un autre point à couvrir</button></div>
    <p class="note">Ajoutez 1 à 4 autres points : la carte cherche alors <b>un seul site relais</b> qui les couvre tous.</p>
    ${r.propositions.length ? r.propositions.map(carteProp).join('') + '<div class="actions-prop"><button id="gpx-couvrir">Télécharger les 5 points (GPX)</button></div>' : '<div class="vide">Aucun point haut à portée.</div>'}
    <p class="note">Classement : marge de liaison vers le point, puis qualité du raccord à un relais existant, puis couverture générale du site. ${r.evalues} points hauts évalués. La marge inclut ${r.parametres.margeSecurite} dB de sécurité et ${r.parametres.env} dB de pertes d'environnement : au-dessus de 0 dB la liaison est probable, au-dessus de 10 dB elle est confortable.</p>`;
  $('#ajout-cible').onclick = () => { etat.ciblesMulti = [{ lat: c.lat, lon: c.lon }]; basculerMode('couvrir-plus'); };
  const bg = $('#gpx-couvrir');
  if (bg) bg.onclick = () => telechargerGpx('couvrir-point.gpx', [
    { lat: c.lat, lon: c.lon, alt: c.alt, nom: 'Point à couvrir' },
    ...r.propositions.map((p, i) => ({ lat: p.lat, lon: p.lon, alt: p.alt, nom: `${String.fromCharCode(65 + i)} - ${nomSommet(p)}`, desc: `Marge ${p.marge} dB, ${p.distanceKm} km` })),
  ]);
  $('#fiche-contenu').querySelectorAll('[data-couv]').forEach((b) => (b.onclick = () => { const p = r.propositions[Number(b.dataset.couv)]; voirCouvertureSite(p, nomSommet(p)); }));
  $('#fiche-contenu').querySelectorAll('[data-prof]').forEach((b) => (b.onclick = () => {
    const p = r.propositions[Number(b.dataset.prof)];
    ouvrirProfilCoords({ lat: p.lat, lon: p.lon, nom: nomSommet(p), h: Number(hs) }, { lat: c.lat, lon: c.lon, nom: 'Point à couvrir', h: Number(ht) });
  }));
}

// ---- Un seul site relais pour couvrir plusieurs points (2 à 5) ---------------------------------
function ajouterCible(latlng) {
  etat.ciblesMulti = [...(etat.ciblesMulti || []), { lat: latlng.lat, lon: latlng.lng }].slice(0, 5);
  couvrirPoints(etat.ciblesMulti);
}
async function couvrirPoints(cibles) {
  const hs = $('#relief-hs') ? $('#relief-hs').value : 6, ht = $('#relief-ht') ? $('#relief-ht').value : 2;
  if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
  const g = L.layerGroup().addTo(carte);
  etat.coucheCouvrir = g;
  $('#btn-effacer').hidden = false;
  const marqueCible = (c, i) => L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'cible-multi', html: `<span>${i + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }), pane: 'traces', zIndexOffset: 900 })
    .bindTooltip(`Point ${i + 1} à couvrir`, { className: 'info' }).addTo(g);
  cibles.forEach(marqueCible);
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `<h2>Couvrir ${cibles.length} points</h2><div class="alerte info-lecture"><span class="sablier"></span> Recherche d’un site relais qui couvre les ${cibles.length} points…</div>`;
  const q = new URLSearchParams({ pts: cibles.map((c) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`).join(';'), hs, ht, acces: etat.filtreAcces || 'tous', ...(etat.vueReseau === 'meshcore' ? { reseau: 'meshcore', preset: 'MESHCORE_FR' } : {}) });
  let r;
  try { r = await api('/api/relief/couvrir-points?' + q); } catch (e) { $('#fiche-contenu').innerHTML = `<h2>Couvrir ${cibles.length} points</h2><div class="vide">${esc(e.message)}</div>`; return; }
  const pts = cibles.map((c) => [c.lat, c.lon]);
  const tracer = (site, lettre, principal) => {
    pts.push([site.lat, site.lon]);
    site.liaisons.forEach((l, k) => {
      if (!l) return;
      L.polyline([[site.lat, site.lon], [r.cibles[k].lat, r.cibles[k].lon]], { color: hexMarge(l.marge), weight: principal ? 3.5 : 1.5, opacity: principal ? 0.95 : 0.5, dashArray: l.marge >= 0 ? null : '6 6', pane: 'traces' })
        .bindTooltip(`${lettre} → point ${k + 1} : ${fmt(l.distanceKm, 1, ' km')} · marge ${l.marge >= 0 ? '+' : ''}${fmt(l.marge, 1, ' dB')}`, { className: 'info', sticky: true }).addTo(g);
    });
    if (principal && site.raccord) L.polyline([[site.lat, site.lon], [site.raccord.lat, site.raccord.lon]], { color: hexMarge(site.raccord.marge), weight: 1.5, opacity: 0.7, dashArray: '2 6', pane: 'traces' }).addTo(g);
    L.marker([site.lat, site.lon], { icon: principal ? L.divIcon({ className: 'relais-a-installer', html: `<div class="epingle"><b>${lettre}</b></div><i class="pulsation"></i>`, iconSize: [34, 44], iconAnchor: [17, 42] }) : L.divIcon({ className: 'sommet propose', html: `<span>${lettre}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }), pane: 'traces', zIndexOffset: principal ? 950 : 700 })
      .bindTooltip(`<b>${lettre} · ${esc(nomSommet(site))}</b><br>${site.alt} m · couvre ${site.couverts}/${r.cibles.length} points · marge mini ${fmt(site.margeMin, 1, ' dB')}`, { className: 'info' + (principal ? ' etiquette-relais' : ''), permanent: principal, direction: 'top', offset: principal ? [0, -46] : [0, -12] }).addTo(g);
  };
  if (r.complet) r.propositions.forEach((p, i) => tracer(p, String.fromCharCode(65 + i), i === 0));
  else if (r.paire) r.paire.sites.forEach((p, i) => tracer(p, String(i + 1), true));
  else if (r.propositions[0]) tracer(r.propositions[0], 'A', true);
  carte.fitBounds(L.latLngBounds(pts), { padding: [90, 90], maxZoom: 12 });

  const ligneLiaisons = (site) => site.liaisons.map((l, k) => `<span class="pastille-point" style="border-color:${l ? couleurMarge(l.marge) : 'var(--critique)'}">${k + 1} : ${l ? `${l.marge >= 0 ? '+' : ''}${fmt(l.marge, 1, ' dB')} · ${fmt(l.distanceKm, 1, ' km')}` : 'hors portée'}</span>`).join('');
  const carteSite = (p, lettre, titre) => `<div class="proposition" style="border-left-color:${couleurMarge(p.margeMin)}">
      <div class="entete-prop"><span class="lettre">${lettre}</span><b>${esc(nomSommet(p))}</b><span class="marge" style="color:${couleurMarge(p.margeMin)}">${titre || `${p.couverts}/${r.cibles.length} points`}</span></div>
      <div class="meta-longue">${p.alt} m${p.commune ? ' · ' + esc(p.commune) : ''} · marge du point le plus difficile : <b style="color:${couleurMarge(p.margeMin)}">${p.margeMin >= 0 ? '+' : ''}${fmt(p.margeMin, 1, ' dB')}</b></div>
      <div class="points-couverts">${ligneLiaisons(p)}</div>
      <div class="meta-longue">Accès : ${texteAcces(p.acces)}</div>
      <div class="meta-longue">${p.raccord ? `Raccord au réseau : <b>${esc(p.raccord.nom)}</b> à ${fmt(p.raccord.distanceKm, 1, ' km')}, marge <span style="color:${couleurMarge(p.raccord.marge)}">${fmt(p.raccord.marge, 1, ' dB')}</span>` : '<span style="color:var(--critique)">Aucun relais existant joignable depuis ce site</span>'}</div>
      ${blocCoords(p.lat, p.lon, { alt: p.alt })}
    </div>`;
  const listeCibles = r.cibles.map((c, i) => `<div class="ligne-cible"><span class="cible-multi petit"><span>${i + 1}</span></span><span class="mono">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</span>${c.alt != null ? ` · ${c.alt} m` : ''}${cibles.length > 2 ? `<button class="mini" data-retirer="${i}" title="Retirer ce point">✕</button>` : ''}</div>`).join('');
  $('#fiche-contenu').innerHTML = `<h2>Couvrir ${r.cibles.length} points avec un seul site</h2>
    <div class="liste-cibles">${listeCibles}</div>
    <div class="actions-prop">${cibles.length < 5 ? '<button id="ajout-cible-multi">＋ Ajouter un point</button>' : ''}<button id="gpx-multi">Télécharger (GPX)</button></div>
    <div class="meta-longue">antenne ${r.parametres.ht} m aux points · site à ${r.parametres.hs} m · ${esc(r.parametres.preset)}${r.filtreAcces !== 'tous' ? ` · sites ${esc(ACCES[r.filtreAcces] ? ACCES[r.filtreAcces].nom : r.filtreAcces)}` : ''}</div>
    ${r.complet ? `<div class="alerte info-lecture">✔ <b>${esc(nomSommet(r.propositions[0]))}</b> couvre les ${r.cibles.length} points à lui seul.</div>${r.propositions.map((p, i) => carteSite(p, String.fromCharCode(65 + i), i === 0 ? 'Meilleur site' : null)).join('')}`
      : r.paire ? `<div class="alerte attention">Aucun site unique ne couvre les ${r.cibles.length} points. Meilleure solution : <b>2 sites</b> qui se partagent les points${r.paire.liaison ? ` (liaison entre eux : marge ${fmt(r.paire.liaison.marge, 1, ' dB')})` : ''}.</div>${r.paire.sites.map((p, i) => carteSite(p, String(i + 1), `Site ${i + 1} sur 2`)).join('')}${r.propositions.length ? `<details class="alt-relier"><summary>Meilleurs sites uniques (couverture partielle)</summary>${r.propositions.map((p, i) => carteSite(p, String.fromCharCode(65 + i))).join('')}</details>` : ''}`
      : r.propositions.length ? `<div class="alerte attention">Aucun site, ni seul ni à deux, ne couvre tous les points. Meilleure couverture partielle :</div>${r.propositions.map((p, i) => carteSite(p, String.fromCharCode(65 + i))).join('')}`
      : '<div class="vide">Aucun point haut ne couvre ces points.</div>'}
    <p class="note">Classement : nombre de points couverts, puis marge du point le plus difficile (au-dessus de 0 dB la liaison est probable, au-dessus de 10 dB confortable). ${r.evalues} points hauts évalués, rayon ${r.parametres.rayonKm} km. Marge de sécurité ${r.parametres.margeSecurite} dB et pertes d’environnement ${r.parametres.env} dB incluses.</p>`;
  const ba = $('#ajout-cible-multi');
  if (ba) ba.onclick = () => basculerMode('couvrir-plus');
  $('#fiche-contenu').querySelectorAll('[data-retirer]').forEach((b) => (b.onclick = () => { etat.ciblesMulti = cibles.filter((_, i) => i !== Number(b.dataset.retirer)); couvrirPoints(etat.ciblesMulti); }));
  $('#gpx-multi').onclick = () => {
    const sites = r.complet ? r.propositions.slice(0, 1) : r.paire ? r.paire.sites : r.propositions.slice(0, 1);
    telechargerGpx('couvrir-points.gpx', [...r.cibles.map((c, i) => ({ lat: c.lat, lon: c.lon, alt: c.alt, nom: `Point ${i + 1}` })), ...sites.map((p, i) => ({ lat: p.lat, lon: p.lon, alt: p.alt, nom: `Relais ${i + 1} - ${nomSommet(p)}`, desc: `Marge mini ${p.margeMin} dB` }))]);
  };
}

async function ouvrirProfilCoords(a, b, preset) {
  const dlg = $('#dlg-profil');
  const f = $('#form-profil');
  f.dataset.coords = JSON.stringify({ aLat: a.lat, aLon: a.lon, aNom: a.nom, bLat: b.lat, bLon: b.lon, bNom: b.nom });
  f.ha.value = a.h;
  f.hb.value = b.h;
  if (etat.radio && etat.radio.preset) f.preset.value = etat.radio.preset;
  if (preset) f.preset.value = preset;
  if (!dlg.open) dlg.showModal();
  await calculerProfil();
}

// Modes de clic sur la carte : « couvrir » (4 points hauts) ou « ici » (couverture depuis le point)
// Consigne affichée en haut de la carte tant qu'un mode attend un clic
const CONSIGNES = {
  couvrir: 'Cliquez le lieu à couvrir', 'couvrir-plus': () => `Cliquez le point ${(etat.ciblesMulti || []).length + 1} à couvrir`,
  ici: 'Cliquez l’emplacement de l’antenne', 'couv-plus': () => `Cliquez le site ${(etat.sitesCouv || []).length + 1} à ajouter à la couverture`,
  relier: () => (etat.relierA ? 'Cliquez le point d’arrivée' : 'Cliquez le point de départ'),
  'simu-ajout': 'Cliquez l’emplacement du relais à ajouter dans la simulation',
};
function majConsigne(texte) {
  const c = $('#consigne-mode');
  if (!c) return;
  c.hidden = !texte;
  if (texte) c.querySelector('span').textContent = texte;
}
function basculerMode(mode) {
  etat.modeCarte = mode;
  const mr = $('#menu-radio'); if (mr) mr.open = false;
  const cs = mode && CONSIGNES[mode];
  majConsigne(cs ? (typeof cs === 'function' ? cs() : cs) : (etat.modeProfil ? (etat.modeProfil.a ? 'Profil : cliquez le point B' : 'Profil : cliquez le point A') : null));
  $('#btn-couvrir').classList.toggle('actif', mode === 'couvrir');
  $('#btn-couvrir').classList.toggle('actif', mode === 'couvrir' || mode === 'couvrir-plus');
  $('#btn-couvrir').textContent = '🎯 Couvrir un ou plusieurs points';
  $('#btn-couv-ici').classList.toggle('actif', mode === 'ici');
  $('#btn-couv-ici').classList.toggle('actif', mode === 'ici' || mode === 'couv-plus');
  $('#btn-couv-ici').textContent = '📍 Couverture depuis un point';
  $('#btn-relier').classList.toggle('actif', mode === 'relier');
  $('#btn-relier').textContent = '🔗 Relier deux lieux';
  if (mode !== 'relier') { etat.relierA = null; if (etat.repereRelier) { etat.repereRelier.remove(); etat.repereRelier = null; } }
  document.body.classList.toggle('mode-viseur', !!mode);
}

// ---- Modules Meshtastic Wi-Fi (admin) ---------------------------------------------------------
const heureCourte = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
let signatureModules = '';
const REDIFFUSION_FR = {
  ALL: 'ALL · relaie tout (conseillé pour un relais)', ALL_SKIP_DECODING: 'ALL_SKIP_DECODING · relaie tout sans déchiffrer', LOCAL_ONLY: 'LOCAL_ONLY · seulement ses canaux',
  KNOWN_ONLY: 'KNOWN_ONLY · seulement les nœuds connus', NONE: 'NONE · ne relaie rien', CORE_PORTNUMS_ONLY: 'CORE_PORTNUMS_ONLY · types de base seulement',
};
let ouvertAgents = false;
async function rendreModules(force) {
  const zone = $('#modules-radio');
  if (!etat.admin || !zone) return;
  if (!force && zone.contains(document.activeElement)) return; // saisie en cours
  let r;
  try { r = await api('/api/radio/modules'); } catch (e) { zone.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const e = r.etat;
  const sig = JSON.stringify([r, e.connecte, e.evince, e.nomLocal]);
  if (!force && sig === signatureModules) return;
  signatureModules = sig;
  const prefixe = (r.actif && !r.actif.hote.startsWith('agent-') ? r.actif.hote : '192.168.0.1').split('.').slice(0, 3).join('.');
  const agentsEnLigne = new Map(((r.agents && r.agents.liste) || []).map((a) => [a.hote, a]));
  const ligne = (m) => {
    let statut, cls, boutons;
    const estAgent = m.hote.startsWith('agent-'), ag = agentsEnLigne.get(m.hote);
    const sousTitre = estAgent ? `agent · ${ag ? esc(ag.source) + ' · ' + esc(ag.ip) : 'hors ligne'}` : `${esc(m.hote)}${m.port !== 4403 ? ':' + m.port : ''}`;
    if (m.actif && e.connecte) { statut = `connecté · ${e.paquets} paquets${e.nomLocal ? '' : ' · configuration…'}`; cls = 'actif'; boutons = `${e.noeudLocal != null ? `<button data-mod-edit="${e.noeudLocal}" class="principal">✏️ Réglages</button>` : ''}<button data-mod-off="0">Déconnecter</button><button data-mod-off="30" title="Laisser le module à l'appli du téléphone pendant 30 min">Libérer 30 min</button>`; }
    else if (m.actif && e.arret && e.repriseAuto) { statut = `libéré · reprise à ${heureCourte(e.repriseAuto)}`; cls = 'recent'; boutons = `<button data-mod-on="${esc(m.hote)}" data-port="${m.port}">Reprendre maintenant</button>`; }
    else if (m.actif && e.evince) { statut = `pris par un autre client · nouvel essai à ${heureCourte(e.reprise)}`; cls = 'recent'; boutons = `<button data-mod-on="${esc(m.hote)}" data-port="${m.port}">Forcer la connexion</button><button data-mod-off="0">Déconnecter</button>`; }
    else if (m.actif && !e.arret) { statut = `connexion…${e.erreur ? ' (' + esc(e.erreur) + ')' : ''}`; cls = 'alerte'; boutons = `<button data-mod-off="0">Annuler</button>`; }
    else if (estAgent && !ag) { statut = 'agent hors ligne : lancez l’agent sur le PC du module'; cls = 'inactif'; boutons = `<button data-mod-on="${esc(m.hote)}" data-port="${m.port}" title="La connexion se fera dès que l’agent sera lancé">Choisir</button><button data-mod-del="${esc(m.hote)}" data-port="${m.port}" title="Retirer de la liste">✕</button>`; }
    else { statut = 'non connecté'; cls = 'inactif'; boutons = `<button data-mod-on="${esc(m.hote)}" data-port="${m.port}">Connecter</button><button data-mod-del="${esc(m.hote)}" data-port="${m.port}" title="Retirer de la liste">✕</button>`; }
    return `<div class="ligne module"><span class="point ${cls}"></span><span class="titre">${esc(m.nom || 'Module inconnu')}${estAgent ? ' <span class="badge">agent</span>' : ''}<small>${sousTitre}</small></span><span class="meta"></span>
      <span class="sous-ligne meta-longue">${statut}</span><span class="sous-ligne boutons-module">${boutons}</span></div>`;
  };
  zone.innerHTML = blocUsbNavigateur() + (r.modules.filter((m) => !(moduleNav.hote && m.hote === moduleNav.hote)).length ? r.modules.filter((m) => !(moduleNav.hote && m.hote === moduleNav.hote)).map(ligne).join('') : '<div class="vide">Aucun module enregistré.</div>') + `
    <form id="form-module" class="parametres compact">
      <label>Adresse IP <input name="hote" placeholder="192.168.1.50" required></label>
      <label>Nom (facultatif) <input name="nom" placeholder="Maison"></label>
      <button type="submit">Ajouter</button>
    </form>
    <div class="actions-prop"><button id="btn-scanner">Rechercher sur ${esc(prefixe)}.x</button></div>
    <p class="note">Un module ne peut servir qu'un client à la fois : se connecter ici déconnecte l'appli du téléphone, et « Libérer » lui rend la main. Seuls les modules joignables depuis le NAS (même réseau ou VPN) peuvent être connectés.</p>
    <div id="retour-modules" class="note"></div>
    <details id="bloc-agents" ${ouvertAgents ? 'open' : ''}><summary>Module par agent : USB sur un PC, ou module d’un autre réseau</summary>
      <p class="note">L’agent est un petit programme lancé sur le PC où le module est branché en USB (ou sur un appareil du réseau où se trouve un module Wi-Fi, ex. Le Monteil). Il se connecte au NAS par Tailscale et relaie le module : la carte l’utilise comme les autres.</p>
      <ol class="note etapes-agent">
        <li>Téléchargez l’agent : <a href="/agent/agent-gaulix-windows.exe" download>Windows</a> · <a href="/agent/agent-gaulix-linux-amd64" download>Linux</a> · <a href="/agent/agent-gaulix-raspberrypi-arm64" download>Raspberry Pi 64 bits</a> · <a href="/agent/agent-gaulix-raspberrypi-armv7" download>Raspberry Pi 32 bits</a></li>
        <li>Lancez-le et répondez aux questions : adresse du serveur <b class="mono">${esc(location.hostname)}:${(r.agents && r.agents.port) || 4404}</b> (ou son adresse Tailscale), le code ci-dessous, un nom (ex. Voiture), le port USB (COM5…) ou l’adresse du module Wi-Fi.</li>
        <li>Le module apparaît ici avec le badge « agent » : cliquez sur Connecter.</li>
      </ol>
      <p class="note"><b>Plusieurs modules</b> (ex. USB, Le Monteil, QRA) : relancez l’agent avec <span class="mono">-configurer</span> puis <b>a</b> pour ajouter une connexion. Chacune apparaît ici sous son nom quand son module est présent (port USB branché, ou PC sur le réseau du module Wi-Fi).</p>
      <div class="code-agent">Code secret : <b class="mono" id="code-agent">••••-••••-••••</b> <button type="button" id="voir-code">Afficher</button> <button type="button" id="nouveau-code" title="Les agents déjà configurés devront recevoir le nouveau code">Nouveau code</button></div>
      <p class="note">Fermez l’appli Meshtastic du PC pendant ce temps (un port USB ne sert qu’un programme). Pour administrer vos nœuds avec ce module, sa clé publique doit figurer dans leurs clés d’administration.</p>
    </details>`;
  $('#bloc-agents').ontoggle = (ev) => { ouvertAgents = ev.target.open; };
  $('#voir-code').onclick = async () => { try { const c = await api('/api/radio/agents'); $('#code-agent').textContent = c.code; } catch (err) { retour(err.message); } };
  $('#nouveau-code').onclick = async () => {
    if (!confirm('Créer un nouveau code ? Les agents déjà configurés devront être reconfigurés avec ce code.')) return;
    try { const c = await postJson('/api/radio/agents/code', {}); $('#code-agent').textContent = c.code; } catch (err) { retour(err.message); }
  };
  const retour = (t) => { const z = $('#retour-modules'); if (z) z.textContent = t; };
  const action = async (url, corps, methode = 'POST') => {
    try { await api(url, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }); }
    catch (err) { retour(err.message); return; }
    setTimeout(() => rendreModules(true), 600);
    setTimeout(() => { rendreModules(true); chargerEtat().catch(() => {}); }, 4000);
  };
  zone.querySelectorAll('[data-mod-on]').forEach((b) => (b.onclick = () => { b.disabled = true; action('/api/radio/connecter', { hote: b.dataset.modOn, port: Number(b.dataset.port) }); }));
  brancherBoutonsUsb(zone);
  zone.querySelectorAll('[data-mod-edit]').forEach((b) => (b.onclick = () => editeurReglages(Number(b.dataset.modEdit))));
  zone.querySelectorAll('[data-mod-off]').forEach((b) => (b.onclick = () => { b.disabled = true; action('/api/radio/deconnecter', { minutes: Number(b.dataset.modOff) }); }));
  zone.querySelectorAll('[data-mod-del]').forEach((b) => (b.onclick = () => action('/api/radio/modules', { hote: b.dataset.modDel, port: Number(b.dataset.port) }, 'DELETE')));
  $('#form-module').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    action('/api/radio/modules', { hote: f.hote.value.trim(), nom: f.nom.value.trim() || null, port: 4403 });
  };
  $('#btn-scanner').onclick = async () => {
    const b = $('#btn-scanner');
    b.disabled = true; b.textContent = 'Recherche en cours (≈ 5 s)…';
    try {
      const res = await api('/api/radio/scanner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixe }) });
      signatureModules = '';
      await rendreModules(true);
      retour(res.trouves.length ? `${res.trouves.length} module(s) trouvé(s) : ${res.trouves.join(', ')}` : 'Aucun module Meshtastic trouvé sur ce réseau.');
    } catch (err) { retour(err.message); b.disabled = false; }
  };
}

// ---- Recherche d'un lieu (nœuds, points hauts, lieux et adresses) ------------------------------
let marqueurRecherche = null;
function placerLieu(l) {
  if (marqueurRecherche) marqueurRecherche.remove();
  const ll = L.latLng(l.lat, l.lon);
  carte.flyTo(ll, Math.max(carte.getZoom(), l.zoom || 15), { duration: 0.8 });
  const div = document.createElement('div');
  div.className = 'popup-lieu';
  div.innerHTML = `<b>${esc(l.nom)}</b>${l.detail ? `<div class="meta-longue">${esc(l.detail)}</div>` : ''}
    ${blocCoords(l.lat, l.lon, { alt: l.alt })}
    <div class="menu-contexte"><button data-a="ici">Couverture depuis ici</button><button data-a="couvrir">Couvrir ce point (4 points hauts)</button>${etat.sitesCouv && etat.sitesCouv.length && etat.sitesCouv.length < 10 ? `<button data-a="couv-plus">Ajouter à la couverture totale (${etat.sitesCouv.length + 1} sites)</button>` : ''}${etat.ciblesMulti && etat.ciblesMulti.length && etat.ciblesMulti.length < 5 ? `<button data-a="couvrir-plus">Ajouter aux points à couvrir (${etat.ciblesMulti.length + 1})</button>` : ''}${l.num != null ? '<button data-a="fiche">Fiche du nœud</button>' : ''}</div>`;
  div.onclick = (ev) => {
    const a = ev.target.closest('button[data-a]');
    if (!a) return;
    carte.closePopup();
    if (a.dataset.a === 'ici') couvertureIci(ll, Number($('#relief-hs') ? $('#relief-hs').value : 6) || 6);
    else if (a.dataset.a === 'couvrir') couvrirPoint(ll);
    else ouvrirFiche(l.num);
  };
  marqueurRecherche = L.marker(ll, { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces', zIndexOffset: 1000 })
    .addTo(carte)
    .bindPopup(div, { className: 'popup-contexte', maxWidth: 340, minWidth: 280 })
    .openPopup();
}
function brancherRecherche() {
  const champ = $('#recherche-lieu'), liste = $('#resultats-lieu');
  let minuterie = null, resultats = [], index = -1, demande = 0;
  const fermer = () => { liste.hidden = true; index = -1; };
  const afficher = () => {
    liste.innerHTML = resultats.length
      ? resultats.map((r, i) => `<li data-i="${i}" class="${i === index ? 'actif' : ''}"><span class="type-lieu">${esc(r.type)}</span><b>${esc(r.nom)}</b>${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</li>`).join('')
      : '<li class="vide">Aucun résultat</li>';
    liste.hidden = false;
  };
  const choisir = (i) => { const r = resultats[i]; if (!r) return; fermer(); champ.value = r.nom; placerLieu(r); };
  async function chercher(q) {
    const n = ++demande;
    const t = q.toLowerCase();
    // Résultats locaux immédiats : nœuds et points hauts
    const locaux = [];
    for (const nd of etat.noeuds.values()) {
      if (nd.lat == null) continue;
      if ([nd.nomLong, nd.nomCourt, nd.id].some((x) => x && x.toLowerCase().includes(t))) locaux.push({ type: 'Nœud', nom: nd.nomLong || nd.nomCourt || nd.id, detail: nd.roleFr, lat: nd.lat, lon: nd.lon, alt: nd.alt, num: nd.num, zoom: 13 });
    }
    for (const sm of etat.sommets) if (sm.nom && sm.nom.toLowerCase().includes(t)) locaux.push({ type: 'Sommet', nom: sm.nom, detail: `${sm.alt} m${sm.commune ? ' · ' + sm.commune : ''}`, lat: sm.lat, lon: sm.lon, alt: sm.alt, zoom: 14 });
    resultats = locaux.slice(0, 6); index = -1; afficher();
    try {
      const c = carte.getCenter();
      const r = await api(`/api/recherche?q=${encodeURIComponent(q)}&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`);
      if (n !== demande) return;
      resultats = [...locaux.slice(0, 4), ...r].slice(0, 10);
      afficher();
    } catch { /* recherche externe indisponible */ }
  }
  champ.oninput = () => {
    clearTimeout(minuterie);
    const q = champ.value.trim();
    if (q.length < 2) { fermer(); return; }
    // Coordonnées saisies directement : « 45.0473, 3.8852 »
    const m = q.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (m) {
      const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.'));
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { resultats = [{ type: 'GPS', nom: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon, zoom: 15 }]; index = 0; afficher(); return; }
    }
    minuterie = setTimeout(() => chercher(q), 300);
  };
  champ.onkeydown = (e) => {
    if (liste.hidden) return;
    if (e.key === 'ArrowDown') { index = Math.min(resultats.length - 1, index + 1); afficher(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { index = Math.max(0, index - 1); afficher(); e.preventDefault(); }
    else if (e.key === 'Enter') { choisir(index < 0 ? 0 : index); e.preventDefault(); }
    else if (e.key === 'Escape') fermer();
  };
  liste.onmousedown = (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choisir(Number(li.dataset.i)); } };
  champ.onblur = () => setTimeout(fermer, 150);
  champ.onfocus = () => { if (resultats.length && champ.value.trim().length >= 2) afficher(); };
}

// ---- Profil entre deux points quelconques (nœuds, sommets ou lieux cliqués) ---------------------
function choisirPointProfil(p) {
  const m = etat.modeProfil;
  if (!m) return;
  if (!m.a) {
    m.a = p;
    majConsigne('Profil : cliquez le point B');
    etat.repereProfil = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces' })
      .addTo(carte).bindTooltip(`A · ${esc(p.nom)}`, { className: 'info', permanent: true, direction: 'top' });
    return;
  }
  const a = m.a;
  etat.modeProfil = null;
  majConsigne(null);
  $('#btn-profil').classList.remove('actif');
  document.body.classList.remove('mode-viseur');
  if (etat.repereProfil) { etat.repereProfil.remove(); etat.repereProfil = null; }
  if (Math.abs(a.lat - p.lat) < 1e-5 && Math.abs(a.lon - p.lon) < 1e-5) return;
  // Deux nœuds : profil classique (avec le SNR mesuré) ; sinon profil entre coordonnées
  if (a.num != null && p.num != null) ouvrirProfil(a.num, p.num);
  else ouvrirProfilCoords(a, p);
}

// ---- Trames, détail d'une trame, comparaison des signaux (façon MQTT Explorer) ------------------
const FILTRES_TRAMES = [
  ['emis', 'En tant qu’expéditeur'], ['emis_direct', 'Messages directs envoyés'], ['diffusion', 'Diffusions'],
  ['recu', 'En tant que destinataire'], ['conversation', 'Expéditeur et destinataire'], ['passerelle', 'En tant que passerelle'], ['tous', 'Tous'],
];
const lienNoeud = (num) => num === 0xffffffff ? '<span class="mono">!ffffffff</span> <small>tout le monde</small>'
  : `<a href="#" data-noeud="${num}"><span class="mono">${idHex(num)}</span> ${esc(nomCourt(num))} <small>${esc(nomNoeud(num) !== idHex(num) ? nomNoeud(num) : '')}</small></a>`;
const distanceNoeuds = (a, b) => { const x = etat.noeuds.get(a), y = etat.noeuds.get(b); return x && y && x.lat != null && y.lat != null ? distanceKm(x, y) : null; };
function lignesRx(t) {
  if (!t.receptions.length) return '<span class="vide">–</span>';
  return t.receptions.map((r) => {
    const dist = distanceNoeuds(t.de, r.passerelle);
    return `<div class="rx">${r.sauts === 0 ? '<b class="rx-direct">En direct</b>' : r.sauts != null ? `${r.sauts} saut${r.sauts > 1 ? 's' : ''}` : '?'}${dist != null ? ` · ${fmt(dist, 2)} km` : ''}${r.snr != null ? ` · <span style="color:${couleurSnr(r.snr)}">${fmt(r.snr, 2)}</span>` : ''}${r.rssi != null ? ` · ${r.rssi}` : ''}</div>`;
  }).join('');
}
function jsonJoli(o) { return esc(JSON.stringify(o, null, 2)); }
const etatTrames = { num: null, filtre: 'emis', page: 1, port: '' };
async function ouvrirTrames(num, filtre) {
  if (num != null) { etatTrames.num = num; etatTrames.page = 1; etatTrames.port = ''; }
  if (filtre) { etatTrames.filtre = filtre; etatTrames.page = 1; }
  const dlg = $('#dlg-trames'), z = $('#trames-contenu');
  if (!dlg.open) dlg.showModal();
  z.innerHTML = '<div class="vide">Chargement…</div>';
  const e = etatTrames;
  let r;
  try { r = await api(`/api/noeuds/${e.num}/trames?filtre=${e.filtre}&page=${e.page}&taille=20${e.port ? '&port=' + e.port : ''}`); } catch (x) { z.innerHTML = `<div class="vide">${esc(x.message)}</div>`; return; }
  const pagesListe = [];
  for (let p = 1; p <= r.pages; p++) if (p === 1 || p === r.pages || Math.abs(p - r.page) <= 2) pagesListe.push(p); else if (pagesListe[pagesListe.length - 1] !== '…') pagesListe.push('…');
  z.innerHTML = `
    <h2>Liste des trames <small class="compteur-trames">${r.total} trame${r.total > 1 ? 's' : ''} enregistrée${r.total > 1 ? 's' : ''} (${etat.config.retentionJours} jours)</small></h2>
    <div class="ident">${esc(nomNoeud(e.num))} · ${esc(nomCourt(e.num))} · ${idHex(e.num)}</div>
    <div class="filtres-trames">${FILTRES_TRAMES.map(([k, l]) => `<button data-ft="${k}" class="${k === e.filtre ? 'actif' : ''}">${l}</button>`).join('')}</div>
    <div class="filtres-trames ports"><button data-fp="" class="${!e.port ? 'actif' : ''}">Tous les types</button>${r.parPort.map((x) => `<button data-fp="${x.port}" class="${x.port === e.port ? 'actif' : ''}"><i style="background:${portInfo(x.port).couleur}"></i>${esc(portInfo(x.port).nom)} <small>${x.nb}</small></button>`).join('')}</div>
    <div class="table-defile"><table class="trames">
      <thead><tr><th>ID</th><th>Expéditeur</th><th>Destinataire</th><th>Passerelle</th><th>Date</th><th>RX <small>sauts · km · SNR · RSSI</small></th><th>MQTT</th><th>Type</th></tr></thead>
      <tbody>${r.trames.map((t) => `<tr>
        <td><a href="#" data-trame="${t.rowid}" class="mono">${t.idPaquet}</a></td>
        <td>${lienNoeud(t.de)}</td>
        <td>${lienNoeud(t.vers)}</td>
        <td>${t.receptions.map((x) => `<div class="rx">${lienNoeud(x.passerelle)}</div>`).join('') || '–'}</td>
        <td class="nowrap">${new Date(t.heure).toLocaleDateString('fr-FR')}<br>${heure(t.heure)}</td>
        <td class="nowrap">${lignesRx(t)}</td>
        <td>${t.receptions.map((x) => `<div class="rx mono petit">${esc(x.sujet || '')}</div>`).join('') || esc(t.canal || '')}</td>
        <td><b><i class="pt" style="background:${portInfo(t.port).couleur}"></i>${esc(t.nomPort || t.port)}</b>${t.pki ? ' <span class="badge">PKI</span>' : ''}
          <div class="petit">${esc(t.texte ? '💬 ' + t.texte : t.resume || '')}${t.reprises ? ' · <span class="pastille">reprise après redémarrage</span>' : ''}</div>
          ${t.contenu ? `<details><summary>JSON</summary><pre class="json">${jsonJoli(t.contenu)}</pre></details>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="vide">Aucune trame pour ce filtre.</td></tr>'}</tbody>
    </table></div>
    <div class="pagination">${pagesListe.map((p) => p === '…' ? '<span>…</span>' : `<button data-pg="${p}" class="${p === r.page ? 'actif' : ''}">${p}</button>`).join('')}</div>`;
  z.querySelectorAll('[data-ft]').forEach((b) => (b.onclick = () => ouvrirTrames(null, b.dataset.ft)));
  z.querySelectorAll('[data-fp]').forEach((b) => (b.onclick = () => { etatTrames.port = b.dataset.fp; etatTrames.page = 1; ouvrirTrames(); }));
  z.querySelectorAll('[data-pg]').forEach((b) => (b.onclick = () => { etatTrames.page = Number(b.dataset.pg); ouvrirTrames(); }));
  brancherLiensTrames(z);
}
function brancherLiensTrames(z) {
  z.querySelectorAll('[data-trame]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); ouvrirTrame(Number(a.dataset.trame)); }));
  z.querySelectorAll('[data-noeud]').forEach((a) => (a.onclick = (ev) => {
    ev.preventDefault();
    const num = Number(a.dataset.noeud);
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    const n = etat.noeuds.get(num);
    if (n && n.lat != null) carte.flyTo([n.lat, n.lon], Math.max(carte.getZoom(), 11), { duration: 0.6 });
    ouvrirFiche(num);
  }));
  z.querySelectorAll('[data-signal]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); const [de, gw] = a.dataset.signal.split(':').map(Number); ouvrirSignal(de, gw); }));
}
async function ouvrirTrame(rowid) {
  const dlg = $('#dlg-trame'), z = $('#trame-contenu');
  if (!dlg.open) dlg.showModal();
  z.innerHTML = '<div class="vide">Chargement…</div>';
  let t;
  try { t = await api('/api/trames/' + rowid); } catch (x) { z.innerHTML = `<div class="vide">${esc(x.message)}</div>`; return; }
  const lig = (k, v) => `<div class="mesure"><span>${k}</span><b>${v ?? '–'}</b></div>`;
  z.innerHTML = `
    <h2>Trame ${t.idPaquet} <small>${esc(t.nomPort || t.port)}</small></h2>
    <div class="grille">
      ${lig('Expéditeur', lienNoeud(t.de))}${lig('Destinataire', lienNoeud(t.vers))}${lig('Date', new Date(t.heure).toLocaleString('fr-FR'))}
      ${lig('Canal', esc(t.canal || '–'))}${lig('Sauts au départ', t.hopDepart || '–')}${lig('Chiffrement', t.pki ? 'PKI (message direct)' : t.dechiffre ? 'clé de canal, déchiffrée' : 'non déchiffrée')}
      ${lig('Taille', t.taille != null ? t.taille + ' octets' : '–')}${lig('Réceptions', t.receptions.length)}${lig('Via MQTT', t.viaMqtt ? 'oui' : 'non')}
    </div>
    ${t.texte ? `<div class="encadre-texte">💬 ${esc(t.texte)}</div>` : `<p>${esc(t.resume || '')}</p>`}
    <h4>Reçue par</h4>
    <table class="voisins"><thead><tr><th>Passerelle</th><th>Heure</th><th class="num">Sauts</th><th>Dernier relais</th><th class="num">km</th><th class="num">SNR</th><th class="num">RSSI</th><th>Source</th><th></th></tr></thead><tbody>
    ${t.receptions.map((r) => `<tr><td>${lienNoeud(r.passerelle)}</td><td>${heure(r.heure)}</td><td class="num">${r.sauts === 0 ? 'direct' : r.sauts ?? '?'}</td><td>${r.relais != null ? lienNoeud(r.relais) : '–'}</td>
      <td class="num">${fmt(distanceNoeuds(t.de, r.passerelle), 1)}</td><td class="num" style="color:${couleurSnr(r.snr)}">${fmt(r.snr, 2)}</td><td class="num">${r.rssi ?? '–'}</td><td class="mono petit">${esc(r.sujet || '')}</td>
      <td><a href="#" data-signal="${t.de}:${r.passerelle}" title="Comparer les signaux">📈</a></td></tr>`).join('')}
    </tbody></table>
    ${t.contenu ? `<h4>Contenu décodé</h4><pre class="json">${jsonJoli(t.contenu)}</pre>` : ''}`;
  brancherLiensTrames(z);
}
async function ouvrirSignal(de, gw) {
  const dlg = $('#dlg-signal'), z = $('#signal-contenu');
  if (!dlg.open) dlg.showModal();
  z.innerHTML = '<div class="vide">Chargement…</div>';
  let r, autres = [];
  try { [r, autres] = await Promise.all([api(`/api/signal?de=${de}&passerelle=${gw}`), api(`/api/noeuds/${de}/entendu-par`)]); } catch (x) { z.innerHTML = `<div class="vide">${esc(x.message)}</div>`; return; }
  const pts = r.points;
  const dist = distanceNoeuds(de, gw);
  const stat = (k) => { const v = pts.map((p) => p[k]).filter((x) => x != null); return v.length ? { min: Math.min(...v), max: Math.max(...v), moy: v.reduce((a, b) => a + b, 0) / v.length } : null; };
  const sS = stat('snr'), sR = stat('rssi');
  z.innerHTML = `
    <h2>Comparer les signaux</h2>
    <div class="ident">${esc(nomNoeud(de))} → entendu par ${esc(nomNoeud(gw))}${dist != null ? ` · ${fmt(dist, 1)} km` : ''}</div>
    <label class="choix-gw">Passerelle <select id="choix-gw">${autres.map((a) => `<option value="${a.passerelle}" ${a.passerelle === gw ? 'selected' : ''}>${esc(nomNoeud(a.passerelle))} (${a.nb})</option>`).join('')}</select></label>
    ${pts.length < 2 ? '<div class="vide">Pas assez de mesures pour un graphique.</div>' : graphiqueSignal(pts)}
    <div class="grille">
      <div class="mesure"><span>Mesures</span><b>${pts.length}</b></div>
      <div class="mesure"><span>SNR moyen</span><b>${sS ? fmt(sS.moy, 1, ' dB') : '–'}</b></div>
      <div class="mesure"><span>SNR min / max</span><b>${sS ? `${fmt(sS.min, 1)} / ${fmt(sS.max, 1)}` : '–'}</b></div>
      <div class="mesure"><span>RSSI moyen</span><b>${sR ? fmt(sR.moy, 0, ' dBm') : '–'}</b></div>
      <div class="mesure"><span>RSSI min / max</span><b>${sR ? `${sR.min} / ${sR.max}` : '–'}</b></div>
      <div class="mesure"><span>Reçu en direct</span><b>${pts.length ? Math.round((pts.filter((p) => p.sauts === 0).length / pts.length) * 100) + ' %' : '–'}</b></div>
    </div>
    <p class="note">Points pleins : reçus en direct ; points creux : après un ou plusieurs relais (le SNR est alors celui du dernier saut). Ligne pointillée rouge : limite de réception du preset LONG_MODERATE (−17,5 dB).</p>`;
  $('#choix-gw').onchange = (e) => ouvrirSignal(de, Number(e.target.value));
}
function graphiqueSignal(pts) {
  const W = 660, H = 240, m = { g: 40, d: 44, h: 12, b: 26 };
  const t0 = pts[0].heure, t1 = pts[pts.length - 1].heure || t0 + 1;
  const snrs = pts.map((p) => p.snr).filter((v) => v != null), rssis = pts.map((p) => p.rssi).filter((v) => v != null);
  const sMin = Math.min(-20, ...snrs) - 1, sMax = Math.max(12, ...snrs) + 1;
  const rMin = Math.min(-130, ...rssis) - 2, rMax = Math.max(-40, ...rssis) + 2;
  const x = (t) => m.g + ((t - t0) / (t1 - t0 || 1)) * (W - m.g - m.d);
  const yS = (v) => H - m.b - ((v - sMin) / (sMax - sMin)) * (H - m.h - m.b);
  const yR = (v) => H - m.b - ((v - rMin) / (rMax - rMin)) * (H - m.h - m.b);
  const lignesS = pts.filter((p) => p.snr != null);
  const lignesR = pts.filter((p) => p.rssi != null);
  const chemin = (l, f, k) => l.map((p, i) => `${i ? 'L' : 'M'}${x(p.heure).toFixed(1)},${f(p[k]).toFixed(1)}`).join(' ');
  const gradS = []; for (let v = Math.ceil(sMin / 5) * 5; v <= sMax; v += 5) gradS.push(`<line x1="${m.g}" x2="${W - m.d}" y1="${yS(v)}" y2="${yS(v)}" class="grille-svg"/><text x="${m.g - 4}" y="${yS(v) + 3}" text-anchor="end" class="t-snr">${v}</text>`);
  const gradR = []; for (let v = Math.ceil(rMin / 10) * 10; v <= rMax; v += 10) gradR.push(`<text x="${W - m.d + 4}" y="${yR(v) + 3}" class="t-rssi">${v}</text>`);
  const jours = []; const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
  for (let d = d0.getTime() + 86400000; d < t1; d += 86400000) jours.push(`<line x1="${x(d)}" x2="${x(d)}" y1="${m.h}" y2="${H - m.b}" class="grille-svg"/><text x="${x(d)}" y="${H - 8}" text-anchor="middle">${new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}</text>`);
  return `<svg class="profil signal" viewBox="0 0 ${W} ${H}">
    ${gradS.join('')}${gradR.join('')}${jours.join('')}
    <line x1="${m.g}" x2="${W - m.d}" y1="${yS(-17.5)}" y2="${yS(-17.5)}" stroke="#ff5c6c" stroke-dasharray="4 4" stroke-width="1"/>
    <path d="${chemin(lignesR, yR, 'rssi')}" class="c-rssi"/>
    <path d="${chemin(lignesS, yS, 'snr')}" class="c-snr"/>
    ${lignesS.map((p) => `<circle cx="${x(p.heure).toFixed(1)}" cy="${yS(p.snr).toFixed(1)}" r="2.6" class="${p.sauts === 0 ? 'p-direct' : 'p-relais'}"><title>${new Date(p.heure).toLocaleString('fr-FR')} · SNR ${p.snr} dB · RSSI ${p.rssi ?? '?'} dBm · ${p.sauts === 0 ? 'direct' : (p.sauts ?? '?') + ' saut(s)'}</title></circle>`).join('')}
    <text x="${m.g}" y="${m.h - 2}" class="t-snr">SNR (dB)</text><text x="${W - m.d}" y="${m.h - 2}" class="t-rssi" text-anchor="end">RSSI (dBm)</text>
  </svg>`;
}
async function chargerEntenduPar(n) {
  const z = $('#entendu-par');
  if (!z) return;
  let l;
  try { l = await api(`/api/noeuds/${n.num}/entendu-par`); } catch { z.innerHTML = '<div class="vide">Indisponible.</div>'; return; }
  z.innerHTML = l.length ? `<table class="voisins"><thead><tr><th>Passerelle</th><th class="num">km</th><th class="num">Dernier SNR</th><th class="num">Trames</th><th>Dernière</th><th></th></tr></thead><tbody>
    ${l.map((g) => `<tr><td>${lienNoeud(g.passerelle)}</td><td class="num">${fmt(distanceNoeuds(n.num, g.passerelle), 1)}</td><td class="num" style="color:${couleurSnr(g.dernierSnr)}">${fmt(g.dernierSnr, 2)}</td><td class="num">${g.nb}</td><td class="nowrap">${ilYa(g.dernier)}</td>
      <td class="nowrap"><a href="#" data-trame="${g.derniereTrame}" title="Voir la trame">🔎</a> <a href="#" data-signal="${n.num}:${g.passerelle}" title="Comparer les signaux">📈</a></td></tr>`).join('')}</tbody></table>`
    : '<div class="vide">Aucune passerelle ne l’a entendu sur la période.</div>';
  brancherLiensTrames(z);
}

// ---- Gestion des nœuds par LoRa (admin) ------------------------------------------------------
const gestion = { selection: new Set(), info: null, suivi: null, filtre: '', marqueurPos: null };
const STATUTS_TACHE = { en_attente: 'en attente', en_cours: 'en cours…', ok: 'réussi', echec: 'échec', annule: 'arrêté' };
const ROLES_FR_ADMIN = { CLIENT: 'Client', CLIENT_MUTE: 'Client muet', CLIENT_HIDDEN: 'Client caché', CLIENT_BASE: 'Client de base', ROUTER: 'Routeur', ROUTER_LATE: 'Routeur tardif', ROUTER_CLIENT: 'Routeur-client', REPEATER: 'Répéteur', TRACKER: 'Traceur', SENSOR: 'Capteur', TAK: 'TAK', TAK_TRACKER: 'TAK traceur', LOST_AND_FOUND: 'Objet perdu' };

// Nœud programmable par l'utilisateur connecté : tous pour l'admin, ceux de son secteur pour un gestionnaire
function gerable(id) {
  if (etat.admin) return true;
  if (!etat.gestion) return false;
  const k = /^[0-9a-f]{64}$/i.test(String(id)) ? String(id).toUpperCase() : String(Number(id) >>> 0);
  return (etat.secteur || []).includes(k);
}
// ---- Clés d'administration : relais par relais ------------------------------------------------------
async function ficheCles() {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<h2>🔑 Clés d’administration</h2><div class="vide">Chargement…</div>';
  let r;
  try { r = await api('/api/admin-noeuds/cles'); } catch (e) { z.innerHTML = `<h2>🔑 Clés d’administration</h2><div class="vide">${esc(e.message)}</div>`; return; }
  const seulement = etat.clesFiltre !== false;
  const aTraiter = (n) => n.aFaire.length || n.aFaireNote;
  const liste = r.noeuds.filter((n) => !seulement || aTraiter(n)).sort((a, b) => (aTraiter(b) ? 1 : 0) - (aTraiter(a) ? 1 : 0) || a.nom.localeCompare(b.nom));
  const puce = (m) => m.autorise === true ? `<span class="badge actif" title="${m.dansCles ? 'clé présente dans ses clés d’administration' : 'a accepté une commande'}${m.essai ? ' · ' + new Date(m.essai.heure).toLocaleString('fr-FR') : ''}">✔ ${esc(m.nom)}</span>`
    : m.autorise === false ? `<span class="badge refus" title="${m.dansCles === false ? 'clé absente de ses clés d’administration' : 'a refusé une commande'}${m.essai ? ' · ' + new Date(m.essai.heure).toLocaleString('fr-FR') : ''}">⛔ ${esc(m.nom)}</span>`
    : `<span class="badge attente" title="jamais essayé depuis ce module">? ${esc(m.nom)}</span>`;
  const texteVisite = r.noeuds.filter(aTraiter).map((n) => `• ${n.nom}${n.site ? ' (' + n.site + ')' : ''} : ${[...n.aFaire, n.aFaireNote].filter(Boolean).join(' ; ')}`).join('\n');
  z.innerHTML = `<h2>🔑 Clés d’administration</h2>
    <p class="note">Un relais n’accepte les ordres que des modules dont la clé publique figure dans ses <b>clés d’administration</b> (3 emplacements). ✔ autorisé · ⛔ refusé · ? jamais essayé. « Lire les clés » interroge le relais par LoRa pour connaître exactement ses clés.</p>
    <p class="note">Modules de la carte : ${r.modules.map((m) => `<b>${esc(m.nom)}</b>`).join(', ') || 'aucun encore (connectez un module)'}.</p>
    <div class="actions-prop"><label class="case"><input type="checkbox" id="cles-filtre" ${seulement ? 'checked' : ''}> Seulement les relais avec quelque chose à faire</label>${texteVisite ? '<button class="mini" id="cles-copier">📋 Copier la liste pour la prochaine visite</button>' : ''}</div>
    ${liste.map((n) => `<div class="carte-cle" data-num="${n.num}">
      <div class="ligne-cle"><b>${esc(n.nom)}</b> <small>${esc(n.id)}${n.site ? ' · ' + esc(n.site) : ''}${n.dernierVu ? ' · vu ' + ilYa(n.dernierVu) : ''}</small></div>
      <div class="puces-cle">${n.modules.map(puce).join(' ')}</div>
      <div class="note">${n.securite ? `${n.securite.nbCles} clé(s) enregistrée(s), ${n.securite.libres} emplacement(s) libre(s)${n.securite.inconnues ? `, dont ${n.securite.inconnues} d’un autre appareil (téléphone, autre carte…)` : ''}${n.securite.gere ? ' · <b>mode géré</b> (réglages verrouillés hors administration)' : ''} · lu ${ilYa(n.securite.lu)}` : 'clés jamais lues'} <button class="mini" data-lire-cles="${n.num}">Lire les clés</button></div>
      ${n.aFaire.length ? `<ul class="a-faire">${n.aFaire.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <label class="note-site">À faire sur place <textarea rows="2" data-note="${n.num}" placeholder="ex. changer le connecteur N, poser un filtre 868…">${esc(n.aFaireNote)}</textarea></label>
    </div>`).join('') || '<div class="vide">Rien à signaler : tous les relais connus acceptent au moins un module de la carte.</div>'}
    <p class="erreur" id="cles-retour"></p>`;
  $('#cles-filtre').onchange = (e) => { etat.clesFiltre = e.target.checked; ficheCles(); };
  const bcp = $('#cles-copier');
  if (bcp) bcp.onclick = async () => { try { await navigator.clipboard.writeText('À faire sur place :\n' + texteVisite); bcp.textContent = '✔ Copié'; } catch { $('#cles-retour').textContent = texteVisite; } };
  z.querySelectorAll('[data-lire-cles]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Lecture lancée…';
    try { await postJson('/api/admin-noeuds/taches', { type: 'lire', cibles: [Number(b.dataset.lireCles)], params: { sections: ['securite'] } }); $('#cles-retour').textContent = 'Lecture lancée : suivez-la dans Programmer, puis rouvrez cette vue.'; } catch (e) { $('#cles-retour').textContent = e.message; b.disabled = false; b.textContent = 'Lire les clés'; }
  }));
  z.querySelectorAll('[data-note]').forEach((t) => (t.onchange = async () => {
    try { await postJson(`/api/noeuds/${t.dataset.note}/a-faire`, { texte: t.value }); $('#cles-retour').textContent = '✔ Note enregistrée (elle figure aussi dans la fiche d’installation).'; } catch (e) { $('#cles-retour').textContent = e.message; }
  }));
}
async function rendreGestion() {
  const z = $('#gestion');
  if (!etat.gestion || !z) return;
  try { gestion.info = await api('/api/admin-noeuds'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const i = gestion.info;
  const cles = new Set(i.clesConnues);
  const t = gestion.filtre.toLowerCase();
  const limite = Date.now() - 7 * 86400000;
  const liste = [...etat.noeuds.values()]
    .filter((n) => (etat.admin ? (n.dernierVu || 0) > limite && dansZone(n) : gerable(n.num)))
    .filter((n) => !t || [n.nomLong, n.nomCourt, n.id].some((x) => x && x.toLowerCase().includes(t)))
    .sort((a, b) => (b.num === i.noeudLocal) - (a.num === i.noeudLocal) || (b.infrastructure - a.infrastructure) || (a.nomLong || a.id).localeCompare(b.nomLong || b.id));
  const sel = [...gestion.selection];
  const un = sel.length === 1 ? etat.noeuds.get(sel[0]) : null;
  // Positions de défilement conservées (cocher un nœud ne doit pas remonter en haut de la liste)
  const anc = z.querySelector('.liste-gestion');
  const defil = { liste: anc ? anc.scrollTop : 0, panneaux: [...document.querySelectorAll('#panneau, #panneau .contenu-onglet, #gestion')].map((el) => [el, el.scrollTop]) };
  z.innerHTML = `
    ${!etat.admin ? `<div class="alerte">Compte gestionnaire : vous programmez les ${(etat.secteur || []).length} nœud(s) de votre secteur. Le module radio est géré par les administrateurs.</div>` : ''}
    <div class="titre-programmer"><b>Nœuds Meshtastic</b><button class="mini" id="voir-cles" title="Quels modules peuvent programmer quel relais, et ce qu'il reste à faire sur place">🔑 Clés d’administration</button>${etat.config.meshcore ? '<button class="mini" id="vers-prog-mc">Répéteurs MeshCore →</button>' : ''}</div>
    ${!i.connecte ? '<div class="alerte attention">Le module radio n’est pas connecté : connectez-le dans l’onglet Réseau, section Modules Wi-Fi.</div>' : ''}
    <details class="aide-cle"${i.clePublique ? '' : ' open'}>
      <summary>Autoriser le module à programmer vos nœuds</summary>
      <p>Sur chaque nœud à gérer (appli Meshtastic, firmware 2.5 ou plus récent) : <b>Réglages › Sécurité › Clé d’administration</b>, collez la clé publique du module :</p>
      ${i.clePublique ? `<div class="coords-l"><b class="mono cle">${esc(i.clePublique)}</b><button class="mini" data-copier="${esc(i.clePublique)}">Copier</button></div>` : '<p class="vide">Clé publique pas encore reçue (module non connecté).</p>'}
      <p class="note">🔑 = le module connaît la clé publique du nœud (indispensable). 🛡️ = le nœud a déjà accepté une commande du module (sa clé est dans ses clés d’administration) ; ⛔ = il l’a refusée. Les ordres partent en LoRa, chiffrés, un nœud à la fois ; comptez 10 à 60 s par nœud.</p>
    </details>
    <div class="recherche"><input id="filtre-gestion" type="search" placeholder="Filtrer les nœuds…" value="${esc(gestion.filtre)}"><button class="mini" id="tout-select" title="Cocher tous les nœuds affichés">Tous</button><button class="mini" id="tout-deselect">Aucun</button></div>
    <div class="liste-gestion">${liste.map((n) => `<label class="ligne-gestion ${gestion.selection.has(n.num) ? 'choisi' : ''}">
      <input type="checkbox" data-num="${n.num}" ${gestion.selection.has(n.num) ? 'checked' : ''}>
      <span class="titre">${esc(n.nomLong || n.id)} <small>${esc(n.nomCourt || '')} · ${esc(n.id)}${n.num === i.noeudLocal ? ' · module local' : ` · ${ilYa(n.dernierVu)}${n.sautsDernier === 0 ? ' · direct' + (n.snr != null ? ' ' + fmt(n.snr, 1, ' dB') : '') : n.sautsDernier != null ? ' · ' + n.sautsDernier + ' saut(s)' : ''}`}</small></span>
      <span class="meta">${(i.administrables || {})[n.num] ? ((i.administrables || {})[n.num].ok ? '<span title="A déjà accepté les commandes du module">🛡️</span>' : '<span title="A refusé : clé du module absente de ses clés d’administration">⛔</span>') : ''}${n.num === i.noeudLocal ? '🏠' : cles.has(n.num) ? '🔑' : '<span title="Clé publique inconnue du module">–</span>'} ${n.infrastructure ? '◆' : ''}</span></label>`).join('') || '<div class="vide">Aucun nœud.</div>'}</div>
    <h3>Actions ${sel.length ? `<span class="pastille">${sel.length} nœud${sel.length > 1 ? 's' : ''}</span>` : ''}</h3>
    ${!sel.length ? '<div class="vide">Cochez un ou plusieurs nœuds.</div>' : `
    <div class="actions-gestion">
      ${un ? '<button data-act="editer" class="principal">✏️ Modifier ses réglages…</button><button data-act="lire">Lire sa configuration</button>' : ''}
      <button data-act="canal">Canaux (0 à 7)…</button>
      <button data-act="config">Rôle, sauts, balises…</button>
      ${un ? '<button data-act="nom">Renommer…</button><button data-act="position">Position fixe…</button>' : ''}
      <button data-act="redemarrer">Redémarrer</button>
      <button data-act="echanger" title="Envoie le nom et la clé publique du module au nœud (indispensable pour qu'il accepte les ordres)">Envoyer la fiche du module</button>
    </div>
    <div id="form-action"></div>`}
    <h3>Conformité</h3>
    <div class="actions-gestion"><button id="btn-verif" class="principal">✔ Vérifier que mes nœuds ont la même configuration…</button></div>
    <div id="form-verif"></div>
    <h3>Opérations récentes</h3>
    <div id="taches-gestion">${rendreTaches(i.taches)}</div>`;
  $('#btn-verif').onclick = () => formulaireVerif();
  $('#filtre-gestion').oninput = (e) => { gestion.filtre = e.target.value; clearTimeout(gestion.minFiltre); gestion.minFiltre = setTimeout(() => { rendreGestion().then(() => { const f = $('#filtre-gestion'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }); }, 250); };
  { const bc = $('#voir-cles'); if (bc) bc.onclick = ficheCles; }
  const vp = $('#vers-prog-mc');
  if (vp) vp.onclick = () => {
    if (etat.vueReseau === 'meshtastic') { const b = document.querySelector('[data-reseau="les-deux"]'); if (b) b.click(); }
    setTimeout(() => { const o = document.querySelector('.onglets button[data-onglet="meshcore"]'); if (o) o.click(); const g = document.querySelector('.sous-onglets-mc button[data-mc-vue="gestion"]'); if (g) g.click(); }, 100);
  };
  $('#tout-deselect').onclick = () => { gestion.selection.clear(); rendreGestion(); };
  $('#tout-select').onclick = () => { liste.forEach((n) => gestion.selection.add(n.num)); rendreGestion(); };
  const nl = z.querySelector('.liste-gestion');
  if (nl) nl.scrollTop = defil.liste;
  for (const [el, v] of defil.panneaux) el.scrollTop = v;
  z.querySelectorAll('input[data-num]').forEach((c) => (c.onchange = () => { const n = Number(c.dataset.num); c.checked ? gestion.selection.add(n) : gestion.selection.delete(n); rendreGestion(); }));
  z.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => formulaireAction(b.dataset.act)));
  z.querySelectorAll('[data-voir-tache]').forEach((b) => (b.onclick = () => voirTache(b.dataset.voirTache)));
  brancherArrets();
  if (i.taches.some((t) => !t.fin)) suivreTaches();
}

function rendreTaches(liste) {
  if (!liste || !liste.length) return '<div class="vide">Aucune.</div>';
  return liste.slice(0, 8).map((t) => `<div class="tache">
    <div class="entete-tache"><b>${esc(t.nom)}</b><small>${heure(t.debut)} · ${esc(t.auteur)}${t.fin ? '' : ' · en cours'}</small>${!t.fin && !t.arret ? `<button class="mini arreter" data-arreter-tache="${t.id}" title="Arrêter cette opération">■ Arrêter</button>` : ''}${t.fin && t.noeuds.some((x) => x.statut === 'echec' || x.statut === 'annule') ? `<button class="mini" data-relancer-tache="${t.id}" data-resume="${esc(t.resume || '')}" data-nb="${t.noeuds.filter((x) => x.statut === 'echec' || x.statut === 'annule').length}" title="Relancer avec les mêmes réglages, sur les nœuds en échec">↻ Réessayer</button>` : ''}${(t.type === 'verifier' || (t.type === 'lire' && (!t.fin || t.noeuds.some((x) => x.statut === 'ok' || x.partiel)))) ? `<button class="mini" data-voir-tache="${t.id}">${t.fin ? 'Voir' : 'Suivre'}</button>` : ''}</div>
    ${t.resume ? `<div class="resume-tache">${esc(t.resume)}</div>` : ''}
    ${t.noeuds.map((n) => `<div class="etape ${n.statut}"><span>${esc(nomNoeud(n.num))}</span><span>${STATUTS_TACHE[n.statut]}${n.detail && n.statut !== 'ok' ? ' · ' + esc(n.detail) : ''}</span></div>`).join('')}
  </div>`).join('');
}

function brancherArrets() {
  $('#taches-gestion').querySelectorAll('[data-relancer-tache]').forEach((b) => (b.onclick = async () => {
    const principal = /\(principal\)/.test(b.dataset.resume || '');
    if (principal && !confirm(`Réessayer « ${b.dataset.resume} » sur ${b.dataset.nb} nœud(s) ?\nLe canal PRINCIPAL sera réécrit (mêmes garde-fous : contrôle de fréquence et vérification).`)) return;
    b.disabled = true; b.textContent = '↻ …';
    try {
      const t = await postJson(`/api/admin-noeuds/taches/${b.dataset.relancerTache}/relancer`, {});
      if (t && (t.type === 'lire' || t.type === 'verifier')) { gestion.lectureSuivie = t.id; voirTache(t.id); }
      const i = await api('/api/admin-noeuds');
      $('#taches-gestion').innerHTML = rendreTaches(i.taches);
      brancherArrets();
      suivreTaches();
    } catch (e) { alert(e.message); b.disabled = false; b.textContent = '↻ Réessayer'; }
  }));
  $('#taches-gestion').querySelectorAll('[data-arreter-tache]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'arrêt…';
    try { await postJson(`/api/admin-noeuds/taches/${b.dataset.arreterTache}/arreter`, {}); } catch (e) { alert(e.message); }
  }));
}
function suivreTaches() {
  clearInterval(gestion.suivi);
  gestion.suivi = setInterval(async () => {
    if (!$('[data-vue="gestion"]').classList.contains('actif')) return;
    try {
      const i = await api('/api/admin-noeuds');
      $('#taches-gestion').innerHTML = rendreTaches(i.taches);
      $('#taches-gestion').querySelectorAll('[data-voir-tache]').forEach((b) => (b.onclick = () => voirTache(b.dataset.voirTache)));
      brancherArrets();
      // Lecture suivie dans le panneau de droite : mise à jour au fur et à mesure
      const suivie = gestion.lectureSuivie && i.taches.find((t) => t.id === gestion.lectureSuivie);
      if (suivie && !$('#fiche').hidden && $('#fiche-contenu').dataset.tache === suivie.id) {
        if (suivie.fin && gestion.editerApres && gestion.editerApres.tache === suivie.id) { const num = gestion.editerApres.num; gestion.editerApres = null; gestion.lectureSuivie = null; editeurReglages(num); }
        else { voirTache(suivie.id); if (suivie.fin) gestion.lectureSuivie = null; }
      }
      if (!i.taches.some((t) => !t.fin) && !gestion.lectureSuivie) clearInterval(gestion.suivi);
    } catch { /* ignore */ }
  }, 3000);
}

async function lancerTache(type, params, cibles = [...gestion.selection]) {
  const zone = $('#retour-action');
  try {
    const t = await postJson('/api/admin-noeuds/taches', { type, cibles, params });
    if ((type === 'lire' || type === 'verifier') && t && t.id) { gestion.lectureSuivie = t.id; voirTache(t.id); }
    if (zone) zone.textContent = 'Opération lancée : suivez-la ci-dessous.';
    const i = await api('/api/admin-noeuds');
    $('#taches-gestion').innerHTML = rendreTaches(i.taches);
    brancherArrets();
    suivreTaches();
  } catch (e) { if (zone) zone.textContent = e.message; else alert(e.message); }
}

async function formulaireAction(act) {
  const f = $('#form-action');
  const num = [...gestion.selection][0];
  const n = etat.noeuds.get(num);
  const pied = '<p class="erreur" id="retour-action"></p>';
  if (act === 'editer') { f.innerHTML = pied; editeurReglages(num); return; }
  if (act === 'lire') {
    let l = null;
    try { l = await api('/api/admin-noeuds/lecture/' + num); } catch { /* ignore */ }
    if (l && !l.aucune && !l.complete) {
      f.innerHTML = `<div class="alerte attention">Lecture précédente incomplète (${ilYa(l.heure)}).<br>
        Déjà lu : ${esc(l.faites.join(', ') || 'rien')}${l.nbCanaux ? ` + ${l.nbCanaux} canal(aux)` : ''}.<br>Manque : <b>${esc(l.manquantes.join(', '))}</b>.</div>
        <div class="actions-prop"><button id="lire-reprendre" class="principal">Reprendre (seulement ce qui manque)</button><button id="lire-tout">Tout relire</button></div>${pied}`;
      $('#lire-reprendre').onclick = () => lancerTache('lire', { reprendre: true });
      $('#lire-tout').onclick = () => lancerTache('lire', {});
      return;
    }
    f.innerHTML = pied; lancerTache('lire', {}); return;
  }
  if (act === 'echanger') { f.innerHTML = pied; lancerTache('echanger', {}); return; }
  if (act === 'redemarrer') {
    f.innerHTML = `<p>Redémarrer ${gestion.selection.size} nœud(s) ?</p><div class="actions-prop"><button id="ok-action" class="principal">Redémarrer</button></div>${pied}`;
    $('#ok-action').onclick = () => lancerTache('redemarrer', {});
    return;
  }
  if (act === 'canal') {
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <label>Emplacement <select name="index"><option value="0">Canal 0 · principal ⚠️</option>${[1, 2, 3, 4, 5, 6, 7].map((k) => `<option value="${k}" ${k === 1 ? 'selected' : ''}>Canal ${k}</option>`).join('')}</select></label>
      <div class="garde-principal" hidden>
        <div class="alerte attention"><b>Canal principal :</b> le nœud y envoie sa fiche, sa position et sa télémétrie. Garde-fous appliqués à chaque nœud :
          relecture de son réglage LoRa (refus si sa fréquence dépend du nom du canal 0), écriture, puis relecture 20 s après pour vérifier qu’il répond toujours.
          Compter 1 à 2 minutes par nœud.</div>
        <label>Pour confirmer, tapez <b>CANAL 0</b> <input name="confirmation" autocomplete="off" placeholder="CANAL 0"></label>
      </div>
      <label>Nom (11 car. max) <input name="nom" maxlength="11" required></label>
      <label>Clé <select name="typeCle"><option value="defaut">Clé publique par défaut (AQ==)</option><option value="aleatoire">Nouvelle clé aléatoire (AES-256)</option><option value="saisie">Saisir une clé base64…</option></select></label>
      <label class="cle-saisie" hidden>Clé base64 <input name="psk" placeholder="ex. 1PG7OiApB1nwvP+rz05pAQ=="></label>
      <label>Précision de la position sur ce canal <select name="precision">
        ${[[32, 'précise'], [19, '≈ 45 m'], [18, '≈ 91 m'], [17, '≈ 182 m'], [16, '≈ 364 m'], [15, '≈ 729 m'], [14, '≈ 1,5 km'], [13, '≈ 2,9 km'], [0, 'pas de position']].map(([v, t]) => `<option value="${v}" ${v === 17 ? 'selected' : ''}>${t}${v && v < 32 ? ` (${v} bits)` : ''}</option>`).join('')}</select></label>
      <label class="case"><input type="checkbox" name="montant"> Envoi vers MQTT (montant)</label>
      <label class="case"><input type="checkbox" name="descendant"> Réception depuis MQTT (descendant)</label>
      <div class="actions-prop"><button type="submit" class="principal">Appliquer à ${gestion.selection.size} nœud(s)</button><button type="button" id="suppr-canal">Supprimer ce canal</button></div>
      <p class="note">Pour un canal privé partagé, choisissez « Nouvelle clé » une fois puis réutilisez la même clé (affichée ici après application) sur les autres nœuds et votre module.</p>
      ${pied}</form>`;
    const fo = $('#f-act');
    fo.typeCle.onchange = () => (fo.querySelector('.cle-saisie').hidden = fo.typeCle.value !== 'saisie');
    const majPrincipal = () => {
      const p = fo.index.value === '0';
      fo.querySelector('.garde-principal').hidden = !p;
      $('#suppr-canal').hidden = p;
    };
    fo.index.onchange = majPrincipal;
    fo.onsubmit = (e) => {
      e.preventDefault();
      let psk = 'AQ==';
      if (fo.typeCle.value === 'aleatoire') { const b = new Uint8Array(32); crypto.getRandomValues(b); psk = btoa(String.fromCharCode(...b)); }
      if (fo.typeCle.value === 'saisie') psk = fo.psk.value.trim();
      if (!/^[A-Za-z0-9+/=]{2,64}$/.test(psk)) { $('#retour-action').textContent = 'Clé invalide'; return; }
      fo.typeCle.value = 'saisie'; fo.psk.value = psk; fo.querySelector('.cle-saisie').hidden = false; // garde la clé pour les autres nœuds
      const index = Number(fo.index.value);
      if (index === 0) {
        if (fo.confirmation.value.trim().toUpperCase() !== 'CANAL 0') { $('#retour-action').textContent = 'Tapez « CANAL 0 » pour confirmer le changement du canal principal'; fo.confirmation.focus(); return; }
        if (!confirm(`Changer le canal PRINCIPAL en « ${fo.nom.value} » sur ${gestion.selection.size} nœud(s) ?`)) return;
      }
      lancerTache('canal', { index, nom: fo.nom.value, psk, precision: Number(fo.precision.value), montant: fo.montant.checked, descendant: fo.descendant.checked, role: index === 0 ? 'PRIMARY' : 'SECONDARY', confirmation: index === 0 ? 'CANAL 0' : undefined });
      if (index === 0) fo.confirmation.value = '';
    };
    $('#suppr-canal').onclick = () => { if (confirm(`Supprimer le canal ${fo.index.value} sur ${gestion.selection.size} nœud(s) ?`)) lancerTache('canal', { index: Number(fo.index.value), role: 'DISABLED' }); };
    return;
  }
  if (act === 'config') {
    const i = gestion.info;
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <p class="note">Laissez « inchangé » ce que vous ne voulez pas modifier. Le nœud redémarre après une modification de rôle ou de LoRa.</p>
      <label>Rôle <select name="role"><option value="">inchangé</option>${i.roles.map((r) => `<option value="${r}">${ROLES_FR_ADMIN[r] || r}</option>`).join('')}</select></label>
      <label>Rediffusion (rebroadcast) <select name="rebroadcastMode"><option value="">inchangé</option>${(i.rediffusions || []).map((r) => `<option value="${r}">${REDIFFUSION_FR[r] || r}</option>`).join('')}</select></label>
      <label>Nombre de sauts (hop limit) <select name="hopLimit"><option value="">inchangé</option>${[1, 2, 3, 4, 5, 6, 7].map((k) => `<option value="${k}">${k}${k === 3 ? ' (conseillé)' : ''}</option>`).join('')}</select></label>
      <label>Intervalle des positions (s) <input name="positionBroadcastSecs" type="number" min="0" placeholder="inchangé"></label>
      <label>Intervalle des infos nœud (s) <input name="nodeInfoBroadcastSecs" type="number" min="0" placeholder="inchangé"></label>
      <label>Module Voisinage (NeighborInfo) <select name="voisinage"><option value="">inchangé</option><option value="lora-21600">activé, toutes les 6 h, aussi sur LoRa (conseillé pour les relais)</option><option value="lora-43200">activé, toutes les 12 h, aussi sur LoRa</option><option value="mqtt-14400">activé, toutes les 4 h, sans LoRa (passerelles MQTT)</option><option value="off">désactivé</option></select></label>
      <div class="actions-prop"><button type="submit" class="principal">Appliquer à ${gestion.selection.size} nœud(s)</button></div>${pied}</form>`;
    $('#f-act').onsubmit = async (e) => {
      e.preventDefault();
      const fo = e.target;
      const ops = [];
      const dev = {}; if (fo.role.value) dev.role = fo.role.value; if (fo.rebroadcastMode.value) dev.rebroadcastMode = fo.rebroadcastMode.value; if (fo.nodeInfoBroadcastSecs.value) dev.nodeInfoBroadcastSecs = Number(fo.nodeInfoBroadcastSecs.value);
      if (Object.keys(dev).length) ops.push({ section: 'device', valeurs: dev });
      if (fo.hopLimit.value) ops.push({ section: 'lora', valeurs: { hopLimit: Number(fo.hopLimit.value) } });
      if (fo.positionBroadcastSecs.value) ops.push({ section: 'position', valeurs: { positionBroadcastSecs: Number(fo.positionBroadcastSecs.value) } });
      if (fo.voisinage.value) {
        const [mode, iv] = fo.voisinage.value.split('-');
        ops.push({ section: 'voisinage', valeurs: mode === 'off' ? { enabled: false } : { enabled: true, updateInterval: Number(iv), transmitOverLora: mode === 'lora' } });
      }
      if (!ops.length) { $('#retour-action').textContent = 'Rien à modifier'; return; }
      for (const o of ops) await lancerTache('config', o);
    };
    return;
  }
  if (act === 'nom') {
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <label>Nom long <input name="nomLong" maxlength="39" value="${esc(n ? n.nomLong || '' : '')}"></label>
      <label>Nom court (4 car.) <input name="nomCourt" maxlength="4" value="${esc(n ? n.nomCourt || '' : '')}"></label>
      <div class="actions-prop"><button type="submit" class="principal">Renommer</button></div>${pied}</form>`;
    $('#f-act').onsubmit = (e) => { e.preventDefault(); lancerTache('nom', { nomLong: e.target.nomLong.value, nomCourt: e.target.nomCourt.value }); };
    return;
  }
  if (act === 'position') {
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <div class="grille-2"><label>Latitude <input name="lat" required value="${n && n.lat != null ? n.lat.toFixed(6) : ''}"></label><label>Longitude <input name="lon" required value="${n && n.lon != null ? n.lon.toFixed(6) : ''}"></label></div>
      <label>Altitude (m, facultatif) <input name="alt" type="number" value="${n && n.alt != null ? n.alt : ''}"></label>
      <div class="actions-prop"><button type="button" id="choisir-pos">📍 Choisir sur la carte</button><button type="submit" class="principal">Définir la position fixe</button><button type="button" id="retirer-pos">Retirer la position fixe</button></div>
      <p class="note">Le nœud passe en position fixe : il diffuse ces coordonnées au lieu de celles de son GPS. Astuce : la barre de recherche et le clic droit donnent les coordonnées d’un lieu.</p>${pied}</form>`;
    const fo = $('#f-act');
    const marquer = () => {
      const lat = Number(String(fo.lat.value).replace(',', '.')), lon = Number(String(fo.lon.value).replace(',', '.'));
      if (gestion.marqueurPos) gestion.marqueurPos.remove();
      if (Number.isFinite(lat) && Number.isFinite(lon)) gestion.marqueurPos = L.marker([lat, lon], { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces' }).addTo(carte).bindTooltip('Nouvelle position', { className: 'info', permanent: true, direction: 'top' });
    };
    fo.lat.oninput = fo.lon.oninput = marquer;
    $('#choisir-pos').onclick = () => {
      $('#choisir-pos').textContent = 'Cliquez sur la carte…';
      document.body.classList.add('mode-viseur');
      carte.once('click', (ev) => {
        document.body.classList.remove('mode-viseur');
        fo.lat.value = ev.latlng.lat.toFixed(6); fo.lon.value = ev.latlng.lng.toFixed(6); fo.alt.value = '';
        $('#choisir-pos').textContent = '📍 Choisir sur la carte';
        marquer();
      });
    };
    fo.onsubmit = (e) => {
      e.preventDefault();
      const lat = Number(String(fo.lat.value).replace(',', '.')), lon = Number(String(fo.lon.value).replace(',', '.'));
      if (!confirm(`Définir la position fixe de ${n ? n.nomLong || n.id : 'ce nœud'} à ${lat.toFixed(5)}, ${lon.toFixed(5)} ?`)) return;
      lancerTache('position', { lat, lon, alt: fo.alt.value });
    };
    $('#retirer-pos').onclick = () => { if (confirm('Retirer la position fixe (le nœud reprendra son GPS) ?')) lancerTache('position', { retirer: true }); };
    marquer();
  }
}

function formulaireVerif() {
  const i = gestion.info, z = $('#form-verif');
  const adm = Object.entries(i.administrables || {}).filter(([, v]) => v.ok).map(([k]) => Number(k)).filter((k) => k !== i.noeudLocal);
  const sel = [...gestion.selection].filter((k) => k !== i.noeudLocal);
  const refs = [...new Set([i.noeudLocal, ...(i.lectures || []).filter((l) => l.complete).map((l) => l.num)])].filter((k) => k != null);
  const defaut = ['canaux', 'precision', 'frequence', 'preset', 'rediffusion'];
  z.innerHTML = `<form id="f-verif" class="form-gestion">
    <label>Référence (la bonne configuration) <select name="reference">${refs.map((k) => `<option value="${k}">${esc(nomNoeud(k))}${k === i.noeudLocal ? ' · module connecté' : ' · lecture complète'}</option>`).join('')}</select></label>
    <fieldset class="elements-verif"><legend>Éléments à comparer</legend>
      ${Object.entries(i.elements || {}).map(([k, nom]) => `<label class="case"><input type="checkbox" name="el" value="${k}" ${defaut.includes(k) ? 'checked' : ''}> ${esc(nom)}</label>`).join('')}
      <p class="note">Le rôle, le nom, la position… ne sont jamais comparés.</p></fieldset>
    <fieldset><legend>Nœuds à vérifier</legend>
      <label class="case"><input type="radio" name="quels" value="admin" ${sel.length ? '' : 'checked'}> Détectés automatiquement : ceux qui acceptent déjà les commandes du module 🛡️ (${adm.length})</label>
      <small class="note">${adm.length ? esc(adm.map(nomNoeud).join(', ')) : 'Aucun encore : un nœud est détecté dès qu’il a répondu à une lecture ou une commande.'}</small>
      <label class="case"><input type="radio" name="quels" value="sel" ${sel.length ? 'checked' : ''}> Les nœuds cochés dans la liste (${sel.length})</label>
    </fieldset>
    <label class="ligne-age">Réutiliser les lectures de moins de <input name="age" type="number" min="0" max="168" value="24"> h <small>(0 = tout relire par LoRa)</small></label>
    <div class="actions-prop"><button type="submit" class="principal">Lancer la vérification</button><button type="button" id="annuler-verif">Fermer</button></div>
    <p class="erreur" id="retour-verif"></p>
    <p class="note">Seuls les éléments nécessaires sont lus (ex. canaux + LoRa), nœud par nœud. Le rapport s’affiche à droite au fur et à mesure.</p>
  </form>`;
  $('#annuler-verif').onclick = () => (z.innerHTML = '');
  $('#f-verif').onsubmit = async (e) => {
    e.preventDefault();
    const fo = e.target;
    const elements = [...fo.querySelectorAll('input[name="el"]:checked')].map((x) => x.value);
    const cibles = fo.quels.value === 'sel' ? sel : adm;
    if (!elements.length) { $('#retour-verif').textContent = 'Cochez au moins un élément'; return; }
    if (!cibles.length) { $('#retour-verif').textContent = 'Aucun nœud à vérifier'; return; }
    try {
      const t = await postJson('/api/admin-noeuds/taches', { type: 'verifier', cibles, params: { reference: Number(fo.reference.value), elements, ageMaxHeures: Number(fo.age.value) || 0 } });
      gestion.lectureSuivie = t.id; voirTache(t.id);
      const i2 = await api('/api/admin-noeuds');
      $('#taches-gestion').innerHTML = rendreTaches(i2.taches); brancherArrets(); suivreTaches();
    } catch (err) { $('#retour-verif').textContent = err.message; }
  };
}
const NOMS_ECARTS = { canaux: 'Canaux', precision: 'Précision', mqtt: 'MQTT', frequence: 'Fréquence', preset: 'Preset', sauts: 'Sauts', puissance: 'Puissance', rediffusion: 'Rediffusion' };
function rapportVerif(t) {
  const defil = [$('#fiche').scrollTop, $('#fiche-contenu').scrollTop];
  const [ref, ...autres] = t.noeuds;
  const conf = autres.filter((n) => n.statut === 'ok' && n.resultat && n.resultat.conforme).length;
  const ecart = autres.filter((n) => n.statut === 'ok' && n.resultat && !n.resultat.conforme).length;
  const ko = autres.filter((n) => n.statut === 'echec' || n.statut === 'annule').length;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `
    <h2>Vérification de conformité</h2><div class="ident">${esc(t.resume || '')}</div>
    ${!t.fin ? `<div class="alerte info-lecture"><span class="sablier"></span> Vérification en cours… <small>(${autres.filter((n) => n.statut !== 'en_attente' && n.statut !== 'en_cours').length}/${autres.length} nœuds)</small> <button class="mini arreter" data-arreter-tache="${t.id}">■ Arrêter</button></div>` : ''}
    <div class="bilan-verif"><span class="ok">✔ ${conf} conforme(s)</span><span class="ecart">⚠ ${ecart} avec écarts</span><span class="ko">✖ ${ko} non vérifié(s)</span></div>
    <div class="ligne-verif ref"><b>Référence : ${esc(nomNoeud(ref.num))}</b><span>${esc(STATUTS_TACHE[ref.statut])}${ref.statut !== 'ok' && ref.detail ? ' · ' + esc(ref.detail) : ''}</span></div>
    ${autres.map((n) => {
      const r = n.resultat;
      const etatTxt = n.statut === 'ok' ? (r.conforme ? '<span class="ok">✔ conforme</span>' : `<span class="ecart">⚠ ${r.ecarts.length} écart(s)</span>`) : n.statut === 'en_cours' ? `<span class="sablier"></span> ${esc(n.detail || '')}` : n.statut === 'en_attente' ? 'en attente' : `<span class="ko">✖ ${esc(STATUTS_TACHE[n.statut])}</span>`;
      return `<div class="ligne-verif"><b data-ouvrir="${n.num}">${esc(nomNoeud(n.num))}</b><span>${etatTxt}</span>
        ${n.statut === 'ok' && !r.conforme ? `<table class="ecarts"><tr><th></th><th>Attendu</th><th>Trouvé</th></tr>${r.ecarts.map((e) => `<tr><td>${esc(NOMS_ECARTS[e.element] || e.element)} · ${esc(e.objet)}</td><td>${esc(e.attendu)}</td><td class="ecart">${esc(e.trouve)}</td></tr>`).join('')}</table>` : ''}
        ${(n.statut === 'echec' || n.statut === 'annule') && n.detail ? `<small class="note">${esc(n.detail.slice(0, 160))}</small>` : ''}</div>`;
    }).join('')}
    ${t.fin && ko ? '<p class="note">Les nœuds non vérifiés peuvent être relancés avec « ↻ Réessayer » dans Opérations récentes.</p>' : ''}`;
  $('#fiche-contenu').dataset.tache = t.id;
  $('#fiche').scrollTop = defil[0]; $('#fiche-contenu').scrollTop = defil[1];
  $('#fiche-contenu').querySelectorAll('[data-ouvrir]').forEach((b) => (b.onclick = () => ouvrirFiche(Number(b.dataset.ouvrir))));
  const ba = $('#fiche-contenu').querySelector('[data-arreter-tache]');
  if (ba) ba.onclick = async () => { ba.disabled = true; ba.textContent = 'arrêt…'; try { await postJson(`/api/admin-noeuds/taches/${t.id}/arreter`, {}); } catch (e) { alert(e.message); } };
  if (!t.fin) { gestion.lectureSuivie = t.id; suivreTaches(); }
}
// ---- Éditeur des réglages d'un nœud (module connecté ou nœud distant) ---------------------------
const PRECISIONS = [[32, 'précise'], [19, '≈ 45 m'], [18, '≈ 91 m'], [17, '≈ 182 m'], [16, '≈ 364 m'], [15, '≈ 729 m'], [14, '≈ 1,5 km'], [13, '≈ 2,9 km'], [0, 'pas de position']];
async function editeurReglages(num) {
  const i = gestion.info || await api('/api/admin-noeuds');
  const local = num === i.noeudLocal;
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.dataset.tache = '';
  z.innerHTML = '<div class="vide">Chargement…</div>';
  let r;
  try { r = await api(`/api/admin-noeuds/lecture/${num}/detail`); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const lireDabord = async (reprendre) => {
    try {
      const t = await postJson('/api/admin-noeuds/taches', { type: 'lire', cibles: [num], params: reprendre ? { reprendre: true } : {} });
      gestion.editerApres = { num, tache: t.id }; gestion.lectureSuivie = t.id; voirTache(t.id); suivreTaches();
    } catch (e) { alert(e.message); }
  };
  if (r.aucune || !r.complet || !r.lora || !r.device || !r.position) {
    z.innerHTML = `<h2>Modifier les réglages · ${esc(nomNoeud(num))}</h2>
      <p>${r.aucune ? 'Sa configuration n’a pas encore été lue.' : 'La dernière lecture est incomplète.'} Le programme la lit d’abord${local ? ' (module connecté : quelques secondes)' : ' par LoRa (1 à 3 min)'}, puis ouvre l’éditeur tout seul.</p>
      <div class="actions-prop"><button id="ed-lire" class="principal">Lire la configuration</button>${!r.aucune ? '<button id="ed-reprendre">Reprendre la lecture</button>' : ''}</div>`;
    $('#ed-lire').onclick = () => lireDabord(false);
    if ($('#ed-reprendre')) $('#ed-reprendre').onclick = () => lireDabord(true);
    return;
  }
  const lo = r.lora, d = r.device, po = r.position;
  const vo = r.voisinage;
  const nPos = etat.noeuds.get(num);
  const posActuelle = nPos && nPos.lat != null ? { lat: nPos.lat, lon: nPos.lon, alt: nPos.alt ?? null } : null;
  const opt = (liste, v, fr = {}) => liste.map((x) => `<option value="${x}" ${x === v ? 'selected' : ''}>${esc(fr[x] || x)}</option>`).join('');
  const parIndex = new Map(r.canaux.map((c) => [c.index, c]));
  const dernierCanal = Math.max(0, ...r.canaux.map((c) => c.index));
  const ligneCanal = (k) => {
    const c = parIndex.get(k);
    return `<tr data-canal="${k}" class="${c ? '' : 'vide-canal'}"><td>${k}${k === 0 ? '<br><small>principal</small>' : ''}</td>
      <td><input name="nom" maxlength="11" value="${esc(c ? c.nom || '' : '')}" placeholder="${k === 0 ? 'nom du preset' : c ? '' : '(libre)'}"></td>
      <td><input name="psk" class="mono" value="${esc(c ? c.psk || '' : 'AQ==')}" title="Clé en base64 : AQ== = clé par défaut"></td>
      <td><select name="precision">${PRECISIONS.map(([v, t]) => `<option value="${v}" ${(c ? c.precision || 0 : 17) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input type="checkbox" name="montant" ${c && c.montant ? 'checked' : ''}></td><td><input type="checkbox" name="descendant" ${c && c.descendant ? 'checked' : ''}></td>
      <td>${k > 0 && c && k === dernierCanal ? '<input type="checkbox" name="supprimer" title="Supprimer ce canal (seul le dernier peut l’être, pour ne pas laisser de trou)">' : ''}</td></tr>`;
  };
  z.innerHTML = `<h2>✏️ ${esc(r.proprietaire ? r.proprietaire.nomLong : nomNoeud(num))}</h2>
    <div class="ident">${esc(r.id)} · ${local ? 'module connecté' : 'nœud distant (LoRa)'} · configuration lue ${ilYa(r.heure)} <button class="mini" id="ed-relire">Relire</button></div>
    ${Date.now() - r.heure > 3600000 ? '<div class="alerte attention">Lecture de plus d’une heure : relisez avant de modifier si quelqu’un a pu changer ce nœud entre-temps.</div>' : ''}
    <form id="f-edit" class="form-edit">
      <h4>Nom</h4><div class="grille-edit">
        <label>Nom long <input name="nomLong" maxlength="39" value="${esc(r.proprietaire.nomLong || '')}"></label>
        <label>Nom court <input name="nomCourt" maxlength="4" value="${esc(r.proprietaire.nomCourt || '')}"></label></div>
      <h4>Appareil</h4><div class="grille-edit">
        <label>Rôle <select name="role">${opt(i.roles, d.role, ROLES_FR_ADMIN)}</select></label>
        <label>Rediffusion <select name="rebroadcastMode">${opt(i.rediffusions || [], d.rebroadcastMode, REDIFFUSION_FR)}</select></label>
        <label>Infos nœud toutes les (s) <input name="nodeInfoBroadcastSecs" type="number" min="0" value="${d.nodeInfoBroadcastSecs || 0}"></label></div>
      <h4>LoRa</h4><div class="grille-edit">
        <label>Région <select name="region">${opt(i.regions || [lo.region], lo.region)}</select></label>
        <label>Preset <select name="modemPreset">${opt(i.presets, lo.modemPreset)}</select></label>
        <label>Slot (0 = auto) <input name="channelNum" type="number" min="0" max="200" value="${lo.channelNum || 0}"></label>
        <label>Fréquence forcée MHz (0 = non) <input name="overrideFrequency" type="number" step="0.0001" min="0" value="${lo.overrideFrequency ? Number(lo.overrideFrequency).toFixed(4) : 0}"></label>
        <label>Sauts <select name="hopLimit">${opt([1, 2, 3, 4, 5, 6, 7], lo.hopLimit)}</select></label>
        <label>Puissance dBm (0 = défaut) <input name="txPower" type="number" min="0" max="30" value="${lo.txPower || 0}"></label>
        <label class="case"><input type="checkbox" name="sx126xRxBoostedGain" ${lo.sx126xRxBoostedGain ? 'checked' : ''}> Réception boostée (SX126x)</label>
        <label class="case"><input type="checkbox" name="configOkToMqtt" ${lo.configOkToMqtt ? 'checked' : ''}> Autoriser l’envoi vers MQTT</label></div>
      <h4>Position</h4><div class="grille-edit">
        <label>Intervalle (s) <input name="positionBroadcastSecs" type="number" min="0" value="${po.positionBroadcastSecs || 0}"></label>
        <label class="case"><input type="checkbox" name="positionBroadcastSmartEnabled" ${po.positionBroadcastSmartEnabled ? 'checked' : ''}> Mode intelligent</label></div>
      <div class="bloc-position-fixe">
        <div class="ident">Position fixe ${po.fixedPosition ? '<b>activée</b>' : 'désactivée (GPS ou aucune)'} · position connue : ${posActuelle ? `${posActuelle.lat.toFixed(5)}, ${posActuelle.lon.toFixed(5)}${posActuelle.alt != null ? ' · ' + posActuelle.alt + ' m' : ''}` : 'aucune'}</div>
        <div class="grille-edit">
          <label>Latitude <input name="pfLat" inputmode="decimal" placeholder="45.12345" value=""></label>
          <label>Longitude <input name="pfLon" inputmode="decimal" placeholder="3.98765" value=""></label>
          <label>Altitude (m, facultatif) <input name="pfAlt" type="number" value=""></label>
        </div>
        <div class="actions-prop"><button type="button" id="pf-carte">📍 Choisir sur la carte</button><button type="button" id="pf-actuelle" ${posActuelle ? '' : 'disabled'}>Reprendre la position connue</button>${po.fixedPosition ? '<label class="case"><input type="checkbox" name="pfRetirer"> Retirer la position fixe (reprendre le GPS)</label>' : ''}</div>
        <p class="note">Laisser vide pour ne pas toucher à la position. Renseignée, elle est envoyée comme position fixe : le nœud diffuse ces coordonnées au lieu de celles de son GPS.</p>
      </div>
      <h4>Voisinage (NeighborInfo)</h4>
      ${vo ? `<div class="grille-edit">
        <label class="case"><input type="checkbox" name="voisEnabled" ${vo.enabled ? 'checked' : ''}> Publier la liste des nœuds entendus directement</label>
        <label>Toutes les <select name="voisInterval">${[[14400, '4 h'], [21600, '6 h'], [43200, '12 h'], [86400, '24 h']].map(([v, t]) => `<option value="${v}" ${(vo.updateInterval || 0) === v ? 'selected' : ''}>${t}</option>`).join('')}${vo.updateInterval && ![14400, 21600, 43200, 86400].includes(vo.updateInterval) ? `<option value="${Math.max(14400, vo.updateInterval)}" selected>${Math.round(vo.updateInterval / 3600)} h</option>` : ''}</select></label>
        <label class="case"><input type="checkbox" name="voisLora" ${vo.transmitOverLora ? 'checked' : ''}> Envoyer aussi sur LoRa</label></div>
        <p class="note">Indispensable pour savoir ce qu’entend un relais qui n’est pas passerelle MQTT (liaisons à sens unique, SNR de chaque voisin). « Envoyer aussi sur LoRa » est nécessaire pour un nœud sans MQTT ; le firmware l’ignore sur un canal principal à clé et nom par défaut, et impose au moins 4 h entre deux envois.</p>`
      : '<p class="note">Réglage du module Voisinage non encore lu : « Relire » ci-dessus le récupère (firmware récent).</p>'}
      <h4>Canaux</h4>
      <div class="defil-canaux"><table class="canaux-edit"><thead><tr><th>#</th><th>Nom</th><th>Clé</th><th>Position</th><th>↑</th><th>↓</th><th>🗑</th></tr></thead><tbody>
        ${[0, 1, 2, 3, 4, 5, 6, 7].map(ligneCanal).join('')}</tbody></table></div>
      <p class="note">Pour ajouter un canal, remplissez une ligne libre. AQ== = clé publique par défaut. Seuls les champs modifiés sont envoyés, en une seule fois ; le nœud enregistre puis redémarre si besoin, et le programme relit pour contrôler.</p>
      <div id="ed-resume" class="note"></div>
      <div class="actions-prop"><button type="submit" class="principal">Appliquer les modifications</button><button type="button" id="ed-annuler">Annuler</button></div>
      <p class="erreur" id="ed-retour"></p>
    </form>`;
  $('#ed-relire').onclick = () => lireDabord(false);
  $('#ed-annuler').onclick = () => { if (gestion.marqueurPos) { gestion.marqueurPos.remove(); gestion.marqueurPos = null; } editeurReglages(num); };
  const fo = $('#f-edit');
  // Position fixe : repère sur la carte, choix au clic
  const marquerPf = () => {
    const lat = Number(String(fo.pfLat.value).replace(',', '.')), lon = Number(String(fo.pfLon.value).replace(',', '.'));
    if (gestion.marqueurPos) { gestion.marqueurPos.remove(); gestion.marqueurPos = null; }
    if (fo.pfLat.value.trim() && Number.isFinite(lat) && Number.isFinite(lon)) gestion.marqueurPos = L.marker([lat, lon], { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces' }).addTo(carte).bindTooltip(`Nouvelle position de ${esc(nomNoeud(num))}`, { className: 'info', permanent: true, direction: 'top' });
  };
  fo.pfLat.addEventListener('input', marquerPf); fo.pfLon.addEventListener('input', marquerPf);
  $('#pf-carte').onclick = () => {
    $('#pf-carte').textContent = 'Cliquez sur la carte…';
    document.body.classList.add('mode-viseur');
    carte.once('click', (ev) => {
      document.body.classList.remove('mode-viseur');
      fo.pfLat.value = ev.latlng.lat.toFixed(6); fo.pfLon.value = ev.latlng.lng.toFixed(6); fo.pfAlt.value = '';
      $('#pf-carte').textContent = '📍 Choisir sur la carte';
      marquerPf(); majResume();
    });
  };
  $('#pf-actuelle').onclick = () => { if (!posActuelle) return; fo.pfLat.value = posActuelle.lat.toFixed(6); fo.pfLon.value = posActuelle.lon.toFixed(6); fo.pfAlt.value = posActuelle.alt ?? ''; marquerPf(); majResume(); };
  const diff = () => {
    const p = {}, chg = [];
    const val = (n) => fo.elements[n];
    if (val('nomLong').value.trim() !== (r.proprietaire.nomLong || '') || val('nomCourt').value.trim() !== (r.proprietaire.nomCourt || '')) { p.nom = { nomLong: val('nomLong').value.trim(), nomCourt: val('nomCourt').value.trim() }; chg.push('nom'); }
    const sec = (nom, champs, src) => {
      const o = {};
      for (const [k, type] of champs) {
        const el = val(k); let v = type === 'bool' ? el.checked : type === 'num' ? Number(el.value) : el.value;
        const avant = type === 'bool' ? !!src[k] : type === 'num' ? Number(src[k] || 0) : src[k];
        if (type === 'num' && k === 'overrideFrequency' ? Math.abs(v - avant) > 0.00005 : v !== avant) { o[k] = v; chg.push(k); }
      }
      if (Object.keys(o).length) p[nom] = o;
    };
    sec('device', [['role', 'txt'], ['rebroadcastMode', 'txt'], ['nodeInfoBroadcastSecs', 'num']], d);
    sec('lora', [['region', 'txt'], ['modemPreset', 'txt'], ['channelNum', 'num'], ['overrideFrequency', 'num'], ['hopLimit', 'num'], ['txPower', 'num'], ['sx126xRxBoostedGain', 'bool'], ['configOkToMqtt', 'bool']], lo);
    sec('position', [['positionBroadcastSecs', 'num'], ['positionBroadcastSmartEnabled', 'bool']], po);
    if (vo) {
      const v = {};
      if (val('voisEnabled').checked !== !!vo.enabled) { v.enabled = val('voisEnabled').checked; chg.push(v.enabled ? 'voisinage activé' : 'voisinage désactivé'); }
      if (Number(val('voisInterval').value) !== (vo.updateInterval || 0) && (val('voisEnabled').checked || vo.enabled)) { v.updateInterval = Number(val('voisInterval').value); chg.push('intervalle du voisinage'); }
      if (val('voisLora').checked !== !!vo.transmitOverLora) { v.transmitOverLora = val('voisLora').checked; chg.push(v.transmitOverLora ? 'voisinage sur LoRa' : 'voisinage hors LoRa'); }
      if (Object.keys(v).length) p.voisinage = v;
    }
    const nb = (x) => Number(String(x || '').trim().replace(',', '.'));
    if (val('pfRetirer') && val('pfRetirer').checked) { p.positionFixe = { retirer: true }; chg.push('retrait de la position fixe'); }
    else if (val('pfLat').value.trim() || val('pfLon').value.trim()) {
      const lat = nb(val('pfLat').value), lon = nb(val('pfLon').value);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { p.positionFixe = { lat, lon, alt: val('pfAlt').value }; chg.push(`position fixe ${lat.toFixed(5)}, ${lon.toFixed(5)}`); }
      else chg.push('position invalide');
    }
    p.canaux = [];
    fo.querySelectorAll('tr[data-canal]').forEach((tr) => {
      const k = Number(tr.dataset.canal), c = parIndex.get(k), q = (n) => tr.querySelector(`[name="${n}"]`);
      const now = { index: k, nom: q('nom').value.trim(), psk: q('psk').value.trim() || 'AQ==', precision: Number(q('precision').value), montant: q('montant').checked, descendant: q('descendant').checked, supprimer: q('supprimer') ? q('supprimer').checked : false };
      if (!c) { if (now.nom) { p.canaux.push(now); chg.push('nouveau canal ' + k); } return; }
      if (now.supprimer) { p.canaux.push({ index: k, supprimer: true }); chg.push('suppression canal ' + k); return; }
      if (now.nom !== (c.nom || '') || now.psk !== (c.psk || '') || now.precision !== (c.precision || 0) || now.montant !== !!c.montant || now.descendant !== !!c.descendant) { p.canaux.push(now); chg.push('canal ' + k); }
    });
    return { p, chg };
  };
  const majResume = () => { const { chg } = diff(); $('#ed-resume').textContent = chg.length ? 'Modifié : ' + chg.join(', ') : 'Aucune modification.'; };
  fo.oninput = majResume; fo.onchange = majResume; majResume();
  fo.onsubmit = async (e) => {
    e.preventDefault();
    const { p, chg } = diff();
    if (!chg.length) { $('#ed-retour').textContent = 'Aucune modification'; return; }
    if (chg.includes('position invalide')) { $('#ed-retour').textContent = 'Coordonnées de position invalides'; return; }
    if (p.canaux.some((c) => c.psk && !/^[A-Za-z0-9+/=]{2,64}$/.test(c.psk))) { $('#ed-retour').textContent = 'Clé invalide (base64)'; return; }
    if (p.canaux.some((c) => c.index === 0)) {
      const t = prompt(`Le canal PRINCIPAL (0) va changer${local ? '' : ' sur un nœud distant'}.\nTapez CANAL 0 pour confirmer :`);
      if ((t || '').trim().toUpperCase() !== 'CANAL 0') return;
      p.confirmation = 'CANAL 0';
    }
    if (p.lora && (p.lora.region || p.lora.modemPreset || p.lora.channelNum != null || p.lora.overrideFrequency != null) && !local
      && !confirm('Vous changez la radio (région, preset, slot ou fréquence) d’un nœud DISTANT : s’il ne parle plus comme les autres, vous perdrez le contact. Continuer ?')) return;
    if (!confirm(`Appliquer à ${nomNoeud(num)} : ${chg.join(', ')} ?`)) return;
    try {
      // La position fixe est une opération à part (message d'administration dédié), mise en file après les réglages
      const pos = p.positionFixe; delete p.positionFixe;
      const autres = chg.filter((x) => !/position fixe/.test(x));
      let t = null;
      if (autres.length) t = await postJson('/api/admin-noeuds/taches', { type: 'modifier', cibles: [num], params: p });
      if (pos) { const tp = await postJson('/api/admin-noeuds/taches', { type: 'position', cibles: [num], params: pos }); if (!t) t = tp; }
      gestion.lectureSuivie = t.id; voirTache(t.id); suivreTaches();
    } catch (err) { $('#ed-retour').textContent = err.message; }
  };
}
function suiviModif(t) {
  const n = t.noeuds[0] || {};
  const defil = $('#fiche').scrollTop;
  $('#fiche').hidden = false;
  $('#fiche-contenu').innerHTML = `<h2>Modification · ${esc(nomNoeud(n.num))}</h2><div class="ident">${esc(t.resume || '')}</div>
    ${!t.fin ? `<div class="alerte info-lecture"><span class="sablier"></span> ${esc(n.detail || 'en cours…')} <button class="mini arreter" data-arreter-tache="${t.id}">■ Arrêter</button></div>` : n.statut === 'ok' ? '<div class="alerte info-lecture">✔ Modifications appliquées et relues.</div>' : `<div class="alerte attention">✖ ${esc(STATUTS_TACHE[n.statut])} : ${esc(n.detail || '')}</div>`}
    <ol class="etapes-modif">${(n.etapes || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ol>
    ${t.fin ? `<div class="actions-prop"><button id="ed-retour-editeur" class="principal">Revenir à l’éditeur</button></div>` : ''}`;
  $('#fiche-contenu').dataset.tache = t.id;
  $('#fiche').scrollTop = defil;
  const ba = $('#fiche-contenu').querySelector('[data-arreter-tache]');
  if (ba) ba.onclick = async () => { ba.disabled = true; try { await postJson(`/api/admin-noeuds/taches/${t.id}/arreter`, {}); } catch (e) { alert(e.message); } };
  const br = $('#ed-retour-editeur');
  if (br) br.onclick = () => editeurReglages(n.num);
  if (!t.fin) { gestion.lectureSuivie = t.id; suivreTaches(); }
}
async function voirTache(id) {
  let t;
  try { t = await api('/api/admin-noeuds/taches/' + id); } catch (e) { alert(e.message); return; }
  if (t.type === 'verifier') return rapportVerif(t);
  if (t.type === 'modifier') return suiviModif(t);
  const n0 = t.noeuds[0] || {};
  const enCours = !t.fin;
  if (enCours) gestion.lectureSuivie = id;
  const r0 = n0.resultat || (enCours ? { num: n0.num, id: '!' + (n0.num >>> 0).toString(16).padStart(8, '0'), heure: Date.now(), complet: false, canaux: [], canauxComplets: false } : null);
  if (!r0) return;
  const defil = [$('#fiche').scrollTop, $('#fiche-contenu').scrollTop];
  // Lecture partielle : une section pas encore lue s'affiche « … » (en cours) ou « – » (non lue)
  const att = enCours ? '…' : '–';
  const sec = (o, f) => (o ? f(o) : att);
  const nom = r0.proprietaire || { nomLong: nomNoeud(r0.num), nomCourt: '' };
  $('#fiche').hidden = false;
  etat.selection = null;
  const lig = (k, v) => `<div class="mesure${v === '…' ? ' attente' : ''}"><span>${k}</span><b>${esc(v ?? '–')}</b></div>`;
  const { materiel: m, device: d, lora: lo, position: po } = r0;
  $('#fiche-contenu').innerHTML = `
    <h2>${esc(nom.nomLong)}</h2><div class="ident">${esc(nom.nomCourt)} · ${esc(r0.id)} · ${enCours ? 'lecture en cours' : 'lu ' + ilYa(r0.heure)}</div>
    ${enCours ? `<div class="alerte info-lecture"><span class="sablier"></span> Lecture en cours… <b>${esc(n0.detail || 'demande envoyée')}</b><br><small>Les valeurs s’affichent dès qu’elles arrivent.</small> <button class="mini arreter" data-arreter-tache="${t.id}">■ Arrêter</button></div>` : ''}
    ${!enCours && r0.complet === false ? `<div class="alerte attention">Lecture incomplète : les valeurs « – » n’ont pas été lues${r0.canauxComplets ? '' : ', liste des canaux incomplète'}. </div><div class="actions-prop"><button class="principal" id="reprendre-lecture" data-num="${r0.num}">↻ Reprendre la lecture</button><span class="note">ne redemande que ce qui manque</span></div>` : ''}
    <h4>Matériel</h4><div class="grille">${lig('Firmware', sec(m, (x) => x.firmwareVersion))}${lig('Matériel', sec(m, (x) => x.hwModel))}${lig('Rôle', sec(d, (x) => ROLES_FR_ADMIN[x.role] || x.role))}</div>
    <h4>LoRa</h4><div class="grille">${lig('Preset', sec(lo, (x) => x.modemPreset))}${lig('Région', sec(lo, (x) => x.region))}${lig('Sauts', sec(lo, (x) => x.hopLimit))}${lig('Puissance', sec(lo, (x) => (x.txPower ? x.txPower + ' dBm' : 'défaut')))}${lig('Emission', sec(lo, (x) => (x.txEnabled ? 'active' : 'coupée')))}${lig('Slot', sec(lo, (x) => x.channelNum || 'auto'))}${lig('Fréquence forcée', sec(lo, (x) => (x.overrideFrequency ? x.overrideFrequency.toFixed(4) + ' MHz' : 'non')))}</div>
    <h4>Position</h4><div class="grille">${lig('Position fixe', sec(po, (x) => (x.fixedPosition ? 'oui' : 'non')))}${lig('Intervalle', sec(po, (x) => x.positionBroadcastSecs + ' s'))}${lig('Mode intelligent', sec(po, (x) => (x.positionBroadcastSmartEnabled ? 'oui' : 'non')))}${lig('GPS', sec(po, (x) => x.gpsMode))}</div>
    <h4>Canaux ${r0.canauxComplets ? `(${r0.canaux.length})` : enCours ? '<small>(lecture…)</small>' : '<small>(incomplet)</small>'}</h4>
    <table class="voisins"><thead><tr><th>#</th><th>Nom</th><th>Rôle</th><th>Clé</th><th>Position</th><th>MQTT</th></tr></thead><tbody>
    ${(r0.canaux || []).map((c) => `<tr><td>${c.index}</td><td>${esc(c.nom || '(défaut)')}</td><td>${c.role === 'PRIMARY' ? 'principal' : 'secondaire'}</td><td class="mono">${esc((c.psk || '').length > 6 ? c.psk.slice(0, 6) + '…' : c.psk || 'aucune')}</td><td>${esc(typeof precisionTexte === 'function' ? precisionTexte(c.precision || 0) : c.precision)}</td><td>${c.montant ? '↑' : ''}${c.descendant ? '↓' : ''}</td></tr>`).join('')}
    ${!r0.canauxComplets ? `<tr><td colspan="6" class="vide">${enCours ? 'canaux suivants en cours de lecture…' : 'canaux suivants non lus'}</td></tr>` : ''}
    </tbody></table>
    <h4>Appareil</h4><div class="grille">${lig('Infos nœud toutes les', sec(d, (x) => x.nodeInfoBroadcastSecs + ' s'))}${lig('Retransmission', sec(d, (x) => x.rebroadcastMode))}</div>`;
  $('#fiche-contenu').dataset.tache = id;
  $('#fiche').scrollTop = defil[0]; $('#fiche-contenu').scrollTop = defil[1];
  const ba = $('#fiche-contenu').querySelector('[data-arreter-tache]');
  if (ba) ba.onclick = async () => { ba.disabled = true; ba.textContent = 'arrêt…'; try { await postJson(`/api/admin-noeuds/taches/${id}/arreter`, {}); } catch (e) { alert(e.message); } };
  if (enCours) suivreTaches();
}

// ---- Vue zone ----------------------------------------------------------------------------
function appliquerZone(recadrer) {
  const v = etat.config.zoneVoisins;
  if (!etat.config.zoneDep) etat.config.zoneDep = etat.config.zone;
  if (etat.zoneMode === 'voisins' && !v) etat.zoneMode = 'dep';
  etat.zone = etat.zoneMode !== 'france';
  // Le reste de l'application lit etat.config.zone : on y place le rectangle du secteur choisi
  etat.config.zone = etat.zoneMode === 'voisins' ? v.bbox : etat.config.zoneDep;
  try { localStorage.setItem('gaulix_zone', etat.zoneMode); } catch { /* stockage indisponible */ }
  const b = $('#sel-zone');
  const nom = etat.config.zoneNom;
  b.options[0].textContent = nom;
  b.options[1].textContent = `${nom} + voisins`;
  b.options[1].title = v ? v.departements.map((d) => `${d.code} ${d.nom}`).join(', ') : '';
  b.options[1].hidden = !v;
  b.value = etat.zoneMode;
  b.title = etat.zoneMode === 'voisins' && v ? `${nom} et départements voisins : ${v.departements.map((d) => d.nom).join(', ')}` : 'Secteur affiché : votre département, avec ses voisins, ou toute la France';
  b.classList.toggle('actif', etat.zone);
  if (recadrer) {
    const z = etat.config.zone;
    if (etat.zone) carte.fitBounds([[z[0], z[1]], [z[2], z[3]]], { padding: [20, 20] });
    else carte.setView([46.6, 2.5], 6);
  }
  dessinerNoeuds();
  dessinerLiens();
  dessinerSommets();
  if (typeof mcRedessiner === 'function') { mcRedessiner(); mcMajKpis(); }
  rendreNoeuds();
  if (etat.stats) majEtat({ stats: etat.stats, alertes: etat.alertes, radio: etat.radio, meshmonitor: null });
  chargerFlux().catch(() => {});
  if ($('[data-vue="analyse"]').classList.contains('actif')) chargerAnalyse();
}

// ---- Légende ---------------------------------------------------------------------
// Tous les liens (Meshtastic et MeshCore) d'un seul clic
const CLES_LIENS_MT = ['rf', 'voisinage', 'traceroute'];
function liensAffiches() { return CLES_LIENS_MT.some((k) => etat.couches[k]) || (typeof mc !== 'undefined' && Object.values(mc.couches).some(Boolean)); }
function boutonLiens() { const on = liensAffiches(); return `<button class="pilule tout${on ? '' : ' on'}" data-tous-liens title="Masquer ou réafficher toutes les lignes de liaison des deux réseaux">${on ? 'Masquer tous les liens' : 'Réafficher les liens'}</button>`; }
function basculerTousLiens() {
  const val = !liensAffiches();
  for (const k of CLES_LIENS_MT) { etat.couches[k] = val; const b = document.querySelector(`.bascule[data-couche="${k}"]`); if (b) b.classList.toggle('actif', val); }
  if (typeof mc !== 'undefined') { for (const k of Object.keys(mc.couches)) mc.couches[k] = val; if (typeof mcDessinerLiens === 'function') mcDessinerLiens(); }
  dessinerLiens();
  rendreLegende();
}
function rendreLegende() {
  const lg = etat.legende;
  const tous = CATEGORIES.every((c) => lg.cat[c.cle]);
  const nb = (c) => [...etat.noeuds.values()].filter((n) => n.lat != null && dansZone(n) && categorie(n).cle === c.cle && (etat.couches.inactifs || n.statut !== 'inactif' || n.infrastructure || n.passerelle)).length;
  const nbMqtt = [...etat.noeuds.values()].filter((n) => dansZone(n) && passerelleEnLigne(n)).length;
  const bouton = (actif, attr, txt) => `<button class="pilule ${actif ? 'on' : ''}" ${attr}>${txt}</button>`;
  const mcSeul = etat.vueReseau === 'meshcore';
  const htmlMc = typeof mcHtmlLegende === 'function' ? mcHtmlLegende() : '';
  $('#legende').innerHTML = `
    <details class="leg-pli" ${lg.replie ? '' : 'open'}>
      <summary>Légende et filtres</summary>
      ${mcSeul ? `<div class="leg-ligne"><span class="pastille-leg chaleur"></span><span class="leg-nom">Activité (10 dernières min)</span>${bouton(lg.chaleur, 'data-leg="chaleur"', lg.chaleur ? 'Affiché' : 'Masqué')}</div>` + htmlMc.replace('<div class="leg-sep"></div>', '') + `<div class="leg-ligne"><span class="pastille-leg inactif"></span><span class="leg-nom">Inactifs (plus de ${etat.config.seuils.inactifHeures} h)</span>${bouton(etat.couches.inactifs, 'data-leg="inactifs"', etat.couches.inactifs ? 'Affiché' : 'Masqué')}</div><div class="leg-ligne">${boutonLiens()}</div><div class="rang">Liens (SNR) : ${SNR.map((x) => `<span><i class="trait" style="background:${x.hex}"></i>${x.nom}</span>`).join('')}</div>` : `
      <div class="leg-ligne"><span class="pastille-leg chaleur"></span><span class="leg-nom">Activité (10 dernières min)</span>${bouton(lg.chaleur, 'data-leg="chaleur"', lg.chaleur ? 'Affiché' : 'Masqué')}</div>
      <div class="leg-ligne"><span class="pastille-leg anneau"></span><span class="leg-nom">Passerelles MQTT en ligne (5 min) <small>${nbMqtt}</small></span>${bouton(lg.seulMqtt, 'data-leg="seulMqtt"', 'Seules')}</div>
      ${CATEGORIES.map((c) => {
        const seul = lg.cat[c.cle] && CATEGORIES.every((x) => x.cle === c.cle || !lg.cat[x.cle]);
        return `<div class="leg-ligne"><span class="pastille-leg" style="background:${c.couleur}"></span><span class="leg-nom">${c.nom} <small>${nb(c)}</small></span>
          <button class="pilule seul ${seul ? 'on' : ''}" data-seul="${c.cle}" title="N’afficher que cette catégorie">Seul</button>${bouton(lg.cat[c.cle], `data-cat="${c.cle}"`, lg.cat[c.cle] ? 'Affiché' : 'Masqué')}</div>`;
      }).join('')}
      <div class="leg-ligne"><span class="pastille-leg inactif"></span><span class="leg-nom">Inactifs (plus de ${etat.config.seuils.inactifHeures} h)</span>${bouton(etat.couches.inactifs, 'data-leg="inactifs"', etat.couches.inactifs ? 'Affiché' : 'Masqué')}</div>
      <div class="leg-ligne"><span class="pastille-leg alerte"></span><span class="leg-nom">Nœuds en alerte</span>${bouton(lg.alertes, 'data-leg="alertes"', lg.alertes ? 'Signalés' : 'Normaux')}</div>
      <div class="leg-ligne">${tous ? '' : '<button class="pilule tout" data-tout>Tout réafficher</button>'}${boutonLiens()}</div>
      <div class="leg-sep"></div>
      <div class="rang">◆ relais · ● nœud · halo = actif, pâle = inactif</div>
      <div class="rang">Liens (SNR) : ${SNR.map((x) => `<span><i class="trait" style="background:${x.hex}"></i>${x.nom}</span>`).join('')}</div>
      <div class="rang">— radio · - - voisinage · ··· traceroute</div>${htmlMc}`}
    </details>`;
  const appliquer = () => { memoLegende(); dessinerNoeuds(); dessinerLiens(); dessinerChaleur(); if (typeof mcRedessiner === 'function') { mcRedessiner(); mcDessinerChaleur(); } rendreLegende(); };
  const z = $('#legende');
  if (typeof mcBrancherLegende === 'function') mcBrancherLegende(z);
  z.querySelector('details').ontoggle = (e) => { lg.replie = !e.target.open; memoLegende(); };
  z.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { lg.cat[b.dataset.cat] = !lg.cat[b.dataset.cat]; appliquer(); }));
  z.querySelectorAll('[data-seul]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.seul;
    const dejaSeul = lg.cat[k] && CATEGORIES.every((x) => x.cle === k || !lg.cat[x.cle]);
    for (const c of CATEGORIES) lg.cat[c.cle] = dejaSeul ? true : c.cle === k;
    appliquer();
  }));
  z.querySelectorAll('[data-leg]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.leg;
    if (k === 'inactifs') { etat.couches.inactifs = !etat.couches.inactifs; const bb = document.querySelector('.bascule[data-couche="inactifs"]'); if (bb) bb.classList.toggle('actif', etat.couches.inactifs); }
    else lg[k] = !lg[k];
    appliquer();
  }));
  const tl = z.querySelector('[data-tous-liens]');
  if (tl) tl.onclick = () => basculerTousLiens();
  const t = z.querySelector('[data-tout]');
  if (t) t.onclick = () => { for (const c of CATEGORIES) lg.cat[c.cle] = true; lg.seulMqtt = false; appliquer(); };
}

// ---- Carte de chaleur de l'activité (paquets des 10 dernières minutes) ----------------------
const activite = []; // { num, heure }
let minuterieChaleur = null;
function noterActivite(num, heure = Date.now()) {
  if (num == null) return;
  activite.push({ num, heure });
  if (!minuterieChaleur && typeof carte !== 'undefined' && carte) minuterieChaleur = setTimeout(() => { minuterieChaleur = null; dessinerChaleur(); }, 3000);
}
function dessinerChaleur() {
  if (!etat.coucheChaleur) etat.coucheChaleur = L.layerGroup().addTo(carte);
  etat.coucheChaleur.clearLayers();
  const limite = Date.now() - 10 * 60000;
  while (activite.length && activite[0].heure < limite) activite.shift();
  if (!etat.legende.chaleur || etat.vueReseau === 'meshcore') return;
  const compte = new Map();
  for (const a of activite) compte.set(a.num, (compte.get(a.num) || 0) + 1);
  for (const [num, c] of compte) {
    const n = etat.noeuds.get(num);
    if (!n || n.lat == null || !dansZone(n)) continue;
    const f = Math.min(1, c / 12);
    // Trois disques concentriques : effet de « chaleur » qui s'additionne entre voisins
    for (const [r, o] of [[4500, 0.06], [2600, 0.1], [1200, 0.16]]) {
      L.circle([n.lat, n.lon], { radius: r * (0.7 + f * 0.6), stroke: false, fillColor: f > 0.6 ? '#ff3b3b' : f > 0.25 ? '#ff8a3b' : '#ffd23b', fillOpacity: o + f * 0.08, pane: 'couverture', interactive: false }).addTo(etat.coucheChaleur);
    }
  }
}
setInterval(() => { if (carte) dessinerChaleur(); }, 20000);

// ---- Chargement & temps réel -------------------------------------------------------
async function chargerNoeuds() {
  const liste = await api('/api/noeuds');
  etat.noeuds = new Map(liste.map((n) => [n.num, n]));
  dessinerNoeuds();
  if (etat.config) rendreLegende();
  rendreNoeuds();
}
async function chargerLiens() {
  etat.liens = await api('/api/liens?heures=' + $('#fenetre').value);
  dessinerLiens();
  if (etat.zone) $('#k-liens').textContent = etat.liens.filter((l) => dansZoneNum(l.a) || dansZoneNum(l.b)).length;
}
async function chargerEtat() {
  const e = await api('/api/etat');
  majEtat(e);
}
function majEtat(e) {
  // Module radio (re)connecté ou changé : la liste des canaux du formulaire d'envoi est relue
  const sig = e.radio ? `${e.radio.connecte}:${e.radio.noeudLocal}` : '';
  if (etat.admin && sig !== etat.sigRadio) { etat.sigRadio = sig; if ($('#form-envoi') && !$('#form-envoi').hidden) setTimeout(() => preparerEnvoi(), 1500); }
  etat.stats = e.stats;
  etat.alertes = e.alertes || [];
  etat.radio = e.radio || null;
  const s = e.stats;
  if (etat.zone) {
    const z = [...etat.noeuds.values()].filter(dansZone);
    const seuilMuet = etat.config.seuils.muetMinutes * 60000;
    const gw = z.filter((n) => n.passerelle);
    const enLigne = gw.filter((n) => n.etatPasserelle !== 'offline' && Date.now() - (n.dernierVuPasserelle || 0) < seuilMuet).length;
    $('#k-actifs').textContent = `${z.filter((n) => n.statut === 'actif').length}/${z.length}`;
    $('#k-passerelles').textContent = `${enLigne}/${gw.length}`;
    $('#k-liens').textContent = etat.liens.filter((l) => dansZoneNum(l.a) || dansZoneNum(l.b)).length;
  } else {
    $('#k-actifs').textContent = `${s.actifs}/${s.noeuds}`;
    $('#k-passerelles').textContent = `${s.passerellesEnLigne}/${s.passerelles}`;
    $('#k-liens').textContent = s.liens;
  }
  $('#k-debit').textContent = fmt(s.paquetsMinute, 1);
  $('#k-canal').textContent = s.canalMoyen == null ? '–' : fmt(s.canalMoyen, 1, ' %');
  const mm = e.meshmonitor;
  const ok = document.querySelector('#direct').classList.contains('ok');
  $('#sources').innerHTML =
    `<div class="ligne${etat.admin ? ' cliquable' : ''}" id="ligne-broker" title="${etat.admin ? 'État, réglages et test du broker' : ''}"><span class="point ${ok ? 'actif' : 'alerte'}"></span><span class="titre">Broker MQTT</span><span class="meta">${ok ? 'connecté' : 'déconnecté'}${etat.admin ? ' ›' : ''}</span></div>` +
    (e.radio
      ? `<div class="ligne"><span class="point ${e.radio.connecte ? 'actif' : e.radio.evince ? 'recent' : 'alerte'}"></span><span class="titre">Module radio${e.radio.nomLocal ? `<small>${esc(e.radio.nomLocal)}</small>` : ''}</span><span class="meta"></span><span class="sous-ligne meta-longue">${e.radio.connecte ? `connecté · ${e.radio.paquets} paquets${e.radio.prochainCycle ? ` · traceroutes ${e.radio.cycleEnCours ? 'en cours' : 'à ' + new Date(e.radio.prochainCycle).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (${e.radio.ciblesAuto} relais)` : ''}` : e.radio.arret ? esc(e.radio.repriseAuto ? 'libéré pour un autre client · reprise ' + new Date(e.radio.repriseAuto).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : e.radio.hote ? 'déconnecté à la demande' : 'aucun module choisi') : e.radio.evince ? esc('laissé à un autre client · reprise ' + new Date(e.radio.reprise).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })) : esc('déconnecté' + (e.radio.erreur ? ' (' + e.radio.erreur + ')' : ''))}</span></div>`
      : '') +
    (mm
      ? `<div class="ligne"><span class="point ${mm.ok ? 'actif' : 'alerte'}"></span><span class="titre">MeshMonitor${mm.sources && mm.sources[0] ? `<small>${esc(mm.sources.map((x) => x.nom).join(', '))}</small>` : ''}</span><span class="meta">${mm.ok ? `${mm.noeuds} nœuds · ${ilYa(mm.derniere)}` : esc(mm.erreur || 'en attente')}</span></div>`
      : '');
  const lb = $('#ligne-broker');
  if (lb && etat.admin) lb.onclick = () => ouvrirBroker();
  if (typeof mcMajSource === 'function') mcMajSource();
  rendreReseau();
  if (etat.admin) rendreModules();
}

// ---- Page du broker MQTT : état, passerelles entendues, réglages et test ----------------------
let suiviBroker = null;
async function ouvrirBroker() {
  const dlg = $('#dlg-mqtt'), z = $('#mqtt-contenu');
  if (!dlg.open) dlg.showModal();
  dlg.onclose = () => { clearInterval(suiviBroker); suiviBroker = null; };
  let m;
  try { m = await api('/api/mqtt'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const formOuvert = z.querySelector('#f-broker');
  const etatHtml = `
    <div class="grille">
      <div class="mesure"><span>État</span><b class="${m.connecte ? 'ok' : 'ko'}">${m.connecte ? '● connecté' : '● déconnecté'}</b></div>
      <div class="mesure"><span>Connecté depuis</span><b>${m.depuis ? ilYa(m.depuis).replace('il y a ', '') : '–'}</b></div>
      <div class="mesure"><span>Dernier message</span><b>${m.dernierMessage ? ilYa(m.dernierMessage) : '–'}</b></div>
      <div class="mesure"><span>Messages / min (10 min)</span><b>${fmt(m.parMinute, 1)}</b></div>
      <div class="mesure"><span>Reçus · décodés · erreurs</span><b>${m.recus} · ${m.decodes} · ${m.erreurs}</b></div>
      <div class="mesure"><span>Reconnexions</span><b>${m.reconnexions}</b></div>
    </div>
    ${m.derniereErreur ? `<div class="alerte attention">Dernière erreur (${ilYa(m.derniereErreur.heure)}) : ${esc(m.derniereErreur.message)}</div>` : ''}
    <p class="note">Abonnement : <span class="mono">${esc(m.sujets.join(', '))}</span></p>
    <h4>Passerelles entendues par le broker (${m.passerelles.length})</h4>
    ${m.passerelles.length ? `<div class="defil-gw"><table class="voisins"><thead><tr><th>Passerelle</th><th>Sujet</th><th class="num">Messages</th><th>Dernier</th></tr></thead><tbody>
      ${m.passerelles.map((g) => `<tr><td>${esc(g.nom || g.id)}<br><small class="mono">${esc(g.id)}</small></td><td class="mono petit">${esc(g.sujet)}</td><td class="num">${g.messages}</td><td>${ilYa(g.derniere)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="vide">Aucune passerelle depuis le démarrage.</div>'}
    ${m.canaux.length ? `<p class="note">Canaux vus : ${m.canaux.map((c) => `${esc(c.canal)} (${c.messages})`).join(' · ')}</p>` : ''}`;
  if (formOuvert) { $('#broker-etat').innerHTML = etatHtml; return; }
  z.innerHTML = `<h3>Broker MQTT</h3><div class="ident">${esc(m.url)}</div>
    <div id="broker-etat">${etatHtml}</div>
    <h4>Réglages</h4>
    <form id="f-broker" class="form-edit">
      <div class="grille-edit">
        <label>Adresse <input name="url" value="${esc(m.url.includes('***') ? '' : m.url)}" placeholder="mqtt://serveur:1883 ou mqtts://serveur:8883"></label>
        <label>Racine des sujets <input name="racine" value="${esc(m.racine)}" placeholder="msh/EU_868"></label>
        <label>Utilisateur <input name="utilisateur" value="${esc(m.utilisateur || '')}" autocomplete="off"></label>
        <label>Mot de passe <input name="motDePasse" type="password" placeholder="${m.motDePasseDefini ? '(inchangé)' : ''}" autocomplete="new-password"></label>
        <label style="grid-column: 1 / -1">Sujets supplémentaires (séparés par des virgules) <input name="sujetsSupplementaires" value="${esc(m.sujetsSupplementaires || '')}"></label>
      </div>
      <div class="actions-prop"><button type="button" id="broker-tester">🔌 Tester ces réglages (10 s)</button><button type="submit" class="principal">Enregistrer et redémarrer</button></div>
      <div id="broker-test"></div>
      <p class="note">Le test se connecte avec ces réglages <b>sans toucher</b> à la connexion actuelle, s’abonne à la racine et compte les messages reçus pendant 10 s. Mot de passe vide = celui déjà enregistré.</p>
    </form>`;
  const fo = $('#f-broker');
  const valeurs = () => ({ url: fo.url.value.trim() || undefined, racine: fo.racine.value.trim(), utilisateur: fo.utilisateur.value.trim(), motDePasse: fo.motDePasse.value, sujetsSupplementaires: fo.sujetsSupplementaires.value });
  $('#broker-tester').onclick = async () => {
    const b = $('#broker-tester'), zt = $('#broker-test');
    b.disabled = true; zt.innerHTML = '<div class="alerte info-lecture"><span class="sablier"></span> Test en cours (connexion puis 10 s d’écoute)…</div>';
    try {
      const r = await postJson('/api/mqtt/tester', valeurs());
      zt.innerHTML = r.connecte
        ? `<div class="alerte info-lecture">✔ Connecté en ${r.delaiConnexionMs} ms · abonnement ${esc(r.abonnement || '?')} · <b>${r.messages}</b> message(s) en ${r.dureeEcouteS} s${r.erreur ? ' · ' + esc(r.erreur) : ''}</div>
           ${r.messages ? `<table class="voisins petit"><thead><tr><th>Sujet</th><th class="num">Messages</th></tr></thead><tbody>${r.sujets.map((x) => `<tr><td class="mono">${esc(x.sujet)}</td><td class="num">${x.n}</td></tr>`).join('')}</tbody></table>` : '<p class="note">Connexion correcte mais aucun message : vérifiez la racine, les droits (ACL) du compte et que des passerelles publient.</p>'}`
        : `<div class="alerte attention">✖ Échec : ${esc(r.erreur || 'connexion impossible')}</div>`;
    } catch (e) { zt.innerHTML = `<div class="alerte attention">${esc(e.message)}</div>`; }
    b.disabled = false;
  };
  fo.onsubmit = async (e) => {
    e.preventDefault();
    if (!confirm('Enregistrer ces réglages ? Le service redémarre (quelques secondes) et se reconnecte au broker.')) return;
    const v = valeurs();
    const corps = { mqtt: { racine: v.racine, utilisateur: v.utilisateur, motDePasse: v.motDePasse, sujetsSupplementaires: v.sujetsSupplementaires } };
    if (v.url) corps.mqtt.url = v.url;
    try { await postJson('/api/reglages', corps); $('#broker-test').innerHTML = '<div class="alerte info-lecture">Enregistré : redémarrage du service… la page se recharge.</div>'; setTimeout(() => location.reload(), 9000); }
    catch (err) { $('#broker-test').innerHTML = `<div class="alerte attention">${esc(err.message)}</div>`; }
  };
  clearInterval(suiviBroker);
  suiviBroker = setInterval(() => { if ($('#dlg-mqtt').open) ouvrirBroker(); }, 5000);
}

let rafraichir = null;
function planifierRafraichissement() {
  if (rafraichir) return;
  rafraichir = setTimeout(async () => {
    rafraichir = null;
    await Promise.all([chargerNoeuds(), chargerLiens()]).catch(() => {});
    rendreReseau();
  }, 4000);
}

function connecterWs() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const temoin = $('#direct');
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.genre === 'bienvenue' || m.genre === 'mqtt') {
      const ok = m.genre === 'bienvenue' ? m.mqtt : m.connecte;
      temoin.className = 'direct ' + (ok ? 'ok' : 'ko');
      temoin.querySelector('b').textContent = ok ? 'En direct' : 'Broker déconnecté';
    } else if (m.genre === 'paquet') {
      if (!etat.noeuds.has(m.de) || (m.passerelle != null && !etat.noeuds.has(m.passerelle))) planifierRafraichissement();
      else {
        const n = etat.noeuds.get(m.de);
        n.dernierVu = m.heure;
        if (n.statut !== 'actif') { n.statut = 'actif'; dessinerNoeuds(); }
        if (['position', 'nodeinfo', 'telemetrie', 'voisinage', 'traceroute', 'mapreport'].includes(m.port)) planifierRafraichissement();
      }
      animerPaquet(m);
      ajouterAuFlux(m);
      noterActivite(m.de, m.heure || Date.now());
      if (m.texte && etat.membre) chargerMessages();
    } else if (m.genre === 'etat') {
      majEtat(m);
      dessinerNoeuds();
    } else if (m.genre === 'statut') {
      planifierRafraichissement();
    } else if (m.genre && m.genre.startsWith('mc-') && typeof mcRecevoir === 'function') {
      mcRecevoir(m);
    }
  };
  ws.onclose = () => {
    temoin.className = 'direct ko';
    temoin.querySelector('b').textContent = 'Reconnexion…';
    setTimeout(connecterWs, 4000);
  };
}

// ---- Interactions --------------------------------------------------------------------
function brancherInterface() {
  document.querySelectorAll('.onglets button[data-onglet]').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.onglets button').forEach((x) => x.classList.toggle('actif', x === b));
    document.querySelectorAll('.vue').forEach((v) => v.classList.toggle('actif', v.dataset.vue === b.dataset.onglet));
    if (b.dataset.onglet === 'messages') chargerMessages();
    if (b.dataset.onglet === 'analyse') { chargerAnalyse(); chargerHistorique(); document.querySelectorAll('details.maint[open]').forEach((d) => chargerMaintenance(d.dataset.maint)); }
    if (b.dataset.onglet === 'sites') rendreSites();
    if (b.dataset.onglet === 'gestion') { rendreGestion(); suivreTaches(); }
  }));
  $('#replier').onclick = () => { $('#panneau').classList.add('replie'); $('#deplier').hidden = false; document.body.classList.add('panneau-replie'); };
  $('#deplier').onclick = () => { $('#panneau').classList.remove('replie'); $('#deplier').hidden = true; document.body.classList.remove('panneau-replie'); };
  $('#fermer-fiche').onclick = () => { $('#fiche').hidden = true; etat.selection = null; if (etat.trajet) { etat.trajet.remove(); etat.trajet = null; } };
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('.ligne[data-num], .alerte[data-num], .paquet[data-num]');
    if (!el || el.closest('#fiche')) return;
    const num = Number(el.dataset.num);
    const n = etat.noeuds.get(num);
    if (n && n.lat != null) carte.flyTo([n.lat, n.lon], Math.max(carte.getZoom(), 11), { duration: 0.6 });
    ouvrirFiche(num);
  });
  $('#recherche').oninput = rendreNoeuds;
  $('#tri').onchange = rendreNoeuds;
  $('#fenetre').onchange = chargerLiens;
  document.querySelectorAll('.bascule').forEach((b) => (b.onclick = () => {
    const c = b.dataset.couche;
    etat.couches[c] = !etat.couches[c];
    b.classList.toggle('actif', etat.couches[c]);
    if (c === 'inactifs') { dessinerNoeuds(); rendreLegende(); } else if (c === 'sommets') dessinerSommets(); else if (c === 'animations') { if (typeof dessinerAxes === 'function') dessinerAxes(); } else if (c === 'federation') dessinerFederation(); else if (c === 'releves') dessinerReleves(); else dessinerLiens();
  }));
  $('#filtres').onclick = (e) => {
    const b = e.target.closest('button[data-port]');
    if (!b) return;
    const p = b.dataset.port;
    etat.filtresPorts.has(p) ? etat.filtresPorts.delete(p) : etat.filtresPorts.add(p);
    rendreFiltres();
    chargerFlux();
  };
  carte.on('zoomend', () => { dessinerNoeuds(); dessinerSommets(); });
  $('#btn-couvrir').onclick = () => { basculerMode(etat.modeCarte === 'couvrir' ? null : 'couvrir'); if (etat.modeProfil) $('#btn-profil').click(); };
  $('#btn-couv-ici').onclick = () => { basculerMode(etat.modeCarte === 'ici' ? null : 'ici'); if (etat.modeProfil) $('#btn-profil').click(); };
  $('#btn-relier').onclick = () => { etat.relierA = null; basculerMode(etat.modeCarte === 'relier' ? null : 'relier'); if (etat.modeProfil) $('#btn-profil').click(); };
  carte.on('click', (e) => {
    const m = etat.modeCarte;
    if (!m) return;
    if (m === 'relier') { choisirPointRelier(e.latlng); return; }
    if (m === 'couvrir-plus') { basculerMode(null); ajouterCible(e.latlng); return; }
    if (m === 'couv-plus') { basculerMode(null); ajouterSiteCouverture(e.latlng); return; }
    if (m === 'simu-ajout') { basculerMode(null); ajouterRelaisSimulation(e.latlng); return; }
    basculerMode(null);
    if (m === 'couvrir') { etat.ciblesMulti = null; couvrirPoint(e.latlng); } else couvertureIci(e.latlng, Number($('#relief-hs') ? $('#relief-hs').value : 6) || 6);
  });
  // Clic droit : menu rapide sur n'importe quel lieu
  carte.on('contextmenu', (e) => {
    const div = L.DomUtil.create('div', 'menu-contexte');
    const lat = e.latlng.lat, lon = e.latlng.lng;
    div.innerHTML = `<div class="ctx-coords"><b class="mono">${lat.toFixed(5)}, ${lon.toFixed(5)}</b><button class="mini" data-copier="${lat.toFixed(5)}, ${lon.toFixed(5)}">Copier</button></div><button data-a="ici">Couverture depuis ici</button><button data-a="couvrir">Couvrir ce point (4 points hauts)</button><button data-a="relier">${etat.modeCarte === 'relier' && etat.relierA ? 'Relier jusqu’ici (arrivée)' : 'Relier depuis ici (relais nécessaires)'}</button><button data-a="profil">${etat.modeProfil && etat.modeProfil.a ? 'Profil jusqu’ici (point B)' : 'Profil depuis ici (point A)'}</button>`;
    const pop = L.popup({ closeButton: false, className: 'popup-contexte' }).setLatLng(e.latlng).setContent(div).openOn(carte);
    div.onclick = (ev) => {
      const a = ev.target.closest('button');
      if (!a) return;
      carte.closePopup(pop);
      if (a.dataset.a === 'profil') {
        if (!etat.modeProfil) $('#btn-profil').click();
        choisirPointProfil({ lat: e.latlng.lat, lon: e.latlng.lng, nom: `Point ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`, h: 3 });
      } else if (a.dataset.a === 'relier') { if (etat.modeCarte !== 'relier') { etat.relierA = null; basculerMode('relier'); } choisirPointRelier(e.latlng); }
      else if (a.dataset.a === 'couvrir-plus') ajouterCible(e.latlng);
      else if (a.dataset.a === 'couv-plus') ajouterSiteCouverture(e.latlng);
      else if (a.dataset.a === 'ici') couvertureIci(e.latlng, 6); else { etat.ciblesMulti = null; couvrirPoint(e.latlng); }
    };
  });
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (etat.modeCarte) basculerMode(null); else if (etat.modeProfil) $('#btn-profil').click(); });
  $('#sel-zone').onchange = (e) => { etat.zoneMode = e.target.value; appliquerZone(true); if (typeof mcRedessiner === 'function') { mc.vue = null; mcRedessiner(); mcMajAlertes(); } };
  $('#aller-plan').onclick = allerPlan;
  const ocm = $('#outil-companion-mc');
  if (ocm) ocm.onclick = () => { const m = document.querySelector('.menu-outils'); if (m) m.open = false; const o = document.querySelector('.onglets button[data-onglet="meshcore"]'); if (o) o.click(); const c = document.querySelector('.sous-onglets-mc button[data-mc-vue="companion"]'); if (c) c.click(); };
  $('#aller-couv-reseau').onclick = couvertureReseau;
  $('#btn-couv-reseau').onclick = () => { const mr = $('#menu-radio'); if (mr) mr.open = false; couvertureReseau(); };
  $('#btn-couv-mesuree').onclick = () => { const mr = $('#menu-radio'); if (mr) mr.open = false; couvertureMesuree(); };
  $('#outil-terrain').onclick = () => { const m = document.querySelector('.menu-outils'); if (m) m.open = false; ficheTerrain(); };
  $('#outil-partager').onclick = () => { const m = document.querySelector('.menu-outils'); if (m) m.open = false; fichePartager(); };
  $('#btn-simulation').onclick = () => { const mr = $('#menu-radio'); if (mr) mr.open = false; simulation(); };
  $('#btn-plan-menu').onclick = () => { const mr = $('#menu-radio'); if (mr) mr.open = false; allerPlan(); };
  $('#consigne-annuler').onclick = () => { if (etat.modeCarte) basculerMode(null); if (etat.modeProfil) $('#btn-profil').click(); };
  $('#btn-profil').onclick = () => {
    const actif = !etat.modeProfil;
    if (actif && etat.modeCarte) basculerMode(null);
    etat.modeProfil = actif ? { a: null } : null;
    $('#btn-profil').classList.toggle('actif', actif);
    majConsigne(actif ? 'Profil : cliquez le point A' : null);
    const mr = $('#menu-radio'); if (mr) mr.open = false;
    document.body.classList.toggle('mode-viseur', actif);
    if (!actif && etat.repereProfil) { etat.repereProfil.remove(); etat.repereProfil = null; }
  };
  // En mode profil, un clic n'importe où sur la carte choisit un point (ni nœud ni sommet nécessaire)
  carte.on('click', (e) => {
    if (!etat.modeProfil) return;
    choisirPointProfil({ lat: e.latlng.lat, lon: e.latlng.lng, nom: `Point ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`, h: 3 });
  });
  $('#btn-rejeu').onclick = () => (etat.rejeu ? fermerRejeu() : demarrerRejeu().catch((e) => alert(e.message)));
  $('#rejeu-lecture').onclick = () => lireRejeu(!etat.rejeu.actif);
  $('#rejeu-fermer').onclick = fermerRejeu;
  $('#rejeu-curseur').oninput = (e) => placerRejeu(Number(e.target.value));
  $('#btn-effacer').onclick = () => {
    etat.ciblesMulti = null;
    etat.sitesCouv = null;
    if (etat.coucheCouverture) etat.coucheCouverture.remove();
    if (etat.coucheCouvrir) etat.coucheCouvrir.remove();
    etat.coucheCouverture = null; etat.coucheCouvrir = null; $('#btn-effacer').hidden = true;
  };
  $('#analyse-periode').onchange = chargerAnalyse;
  $('#fermer-profil').onclick = () => $('#dlg-profil').close();
  $('#form-profil').onsubmit = (e) => { e.preventDefault(); calculerProfil(); };

  brancherComptes();
  document.querySelectorAll('dialog [data-fermer]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
}

// ---- Comptes : connexion, inscription, gestion, installation --------------------------------
const postJson = (url, corps, methode = 'POST') => api(url, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps || {}) });
// ---- Sauvegardes des réglages (admin) ----------------------------------------------------------
async function rendreSauvegardes() {
  const z = $('#pan-sauvegardes');
  let l = [];
  try { l = await api('/api/sauvegardes'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  z.innerHTML = `<p class="note">Chaque nuit vers 3 h 30, la carte sauvegarde ses réglages : comptes, réglages généraux, fiches d’installation des relais, modules radio, configurations lues des nœuds, mots de passe d’administration MeshCore, traceroutes. Les 14 dernières sont gardées sur le NAS. Les données radio (paquets, liens) ne sont pas sauvegardées : elles se reconstituent toutes seules.</p>
    <p class="note"><b>Fichier sensible</b> (clés des canaux, mots de passe d’administration MeshCore) : gardez la copie téléchargée en lieu sûr.</p>
    <div class="actions-prop"><button id="sv-maintenant" class="principal">Sauvegarder maintenant</button></div>
    <div class="liste">${l.map((x) => `<div class="ligne"><span class="titre">${esc(x.nom.replace('sauvegarde-', '').replace('.json', ''))}<small>${Math.round(x.taille / 1024)} ko · ${new Date(x.date).toLocaleString('fr-FR')}</small></span><span class="meta"><a class="bouton-lien" href="/api/sauvegardes/${encodeURIComponent(x.nom)}">Télécharger</a></span></div>`).join('') || '<div class="vide">Aucune sauvegarde pour l’instant.</div>'}</div>
    <h4>Restaurer</h4>
    <p class="note">Choisissez un fichier de sauvegarde téléchargé : les réglages et les comptes sont remplacés (l’état actuel est d’abord mis de côté), puis la carte redémarre.</p>
    <input type="file" id="sv-fichier" accept=".json,application/json"><button id="sv-restaurer" disabled>Restaurer ce fichier</button>
    <p class="erreur" id="sv-retour"></p>`;
  $('#sv-maintenant').onclick = async () => { try { await postJson('/api/sauvegardes', {}); rendreSauvegardes(); } catch (e) { $('#sv-retour').textContent = e.message; } };
  const fi = $('#sv-fichier'), br = $('#sv-restaurer');
  fi.onchange = () => { br.disabled = !fi.files.length; };
  br.onclick = async () => {
    const f = fi.files[0];
    if (!f) return;
    let s;
    try { s = JSON.parse(await f.text()); } catch { $('#sv-retour').textContent = 'Fichier illisible'; return; }
    if (s.format !== 'carte-live-sauvegarde') { $('#sv-retour').textContent = 'Ce fichier n’est pas une sauvegarde de la carte'; return; }
    if (!confirm(`Restaurer la sauvegarde du ${new Date(s.date).toLocaleString('fr-FR')} ? Les réglages et les comptes actuels seront remplacés et la carte redémarrera.`)) return;
    try { await postJson('/api/sauvegardes/restaurer', s); attendreRedemarrage('Sauvegarde restaurée'); } catch (e) { $('#sv-retour').textContent = e.message; }
  };
}
function ongletsDialogue(dlg) {
  dlg.querySelectorAll('[data-dlg]').forEach((b) => (b.onclick = () => {
    dlg.querySelectorAll('[data-dlg]').forEach((x) => x.classList.toggle('actif', x === b));
    dlg.querySelectorAll('[data-pan]').forEach((p) => (p.hidden = p.dataset.pan !== b.dataset.dlg));
    if (b.dataset.dlg === 'comptes') rendreComptes();
    if (b.dataset.dlg === 'journal') rendreJournal();
    if (b.dataset.dlg === 'sauvegardes') rendreSauvegardes();
    if (b.dataset.dlg === 'reglages') rendreReglages();
  }));
}
async function attendreRedemarrage(message) {
  document.body.insertAdjacentHTML('beforeend', `<div class="voile-redemarrage"><div><b>${esc(message)}</b><br><small>Le service redémarre, la page se rechargera toute seule.</small></div></div>`);
  await new Promise((r) => setTimeout(r, 4000));
  for (let k = 0; k < 60; k++) {
    try { const r = await fetch('/sante', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  location.reload();
}

function brancherComptes() {
  const dlgC = $('#dlg-compte'), dlgG = $('#dlg-gestion');
  ongletsDialogue(dlgC);
  ongletsDialogue(dlgG);
  $('#fermer-compte').onclick = () => dlgC.close();
  $('#fermer-gestion').onclick = () => dlgG.close();
  $('#btn-admin').onclick = () => {
    if (etat.membre) { ouvrirGestion(); return; }
    dlgC.querySelectorAll('.erreur').forEach((x) => (x.textContent = ''));
    const insc = etat.config.inscriptions;
    $('#onglet-inscription').hidden = insc === 'fermees';
    $('#note-inscription').textContent = insc === 'validation' ? 'Votre compte sera actif après validation par un administrateur de la carte.' : 'Votre compte sera actif immédiatement.';
    dlgC.showModal();
    $('#form-connexion').identifiant.focus();
  };
  $('#form-connexion').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await postJson('/api/connexion', { identifiant: f.identifiant.value, motDePasse: f.motDePasse.value, code: f.code.value || undefined }); location.reload(); }
    catch (err) {
      // Double authentification : le code à 6 chiffres est demandé après le mot de passe
      if (err.donnees && err.donnees.codeRequis) { $('#champ-code').hidden = false; f.code.required = true; f.code.focus(); f.querySelector('.erreur').textContent = f.code.value ? err.message : ''; }
      else f.querySelector('.erreur').textContent = err.message;
    }
  };
  $('#form-inscription').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, err = f.querySelector('.erreur');
    if (f.motDePasse.value !== f.confirmation.value) { err.textContent = 'Les deux mots de passe sont différents'; return; }
    try {
      const r = await postJson('/api/inscription', { identifiant: f.identifiant.value, indicatif: f.indicatif.value, email: f.email.value, motDePasse: f.motDePasse.value });
      if (r.enAttente) { f.innerHTML = '<p class="succes">Inscription enregistrée ✓<br>Un administrateur doit valider votre compte ; vous pourrez ensuite vous connecter.</p>'; }
      else location.reload();
    } catch (x) { err.textContent = x.message; }
  };
}

// Bouton « Reprendre la lecture » d'une lecture de configuration incomplète
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#reprendre-lecture');
  if (!b) return;
  b.disabled = true; b.textContent = 'Reprise…';
  try {
    const t = await postJson('/api/admin-noeuds/taches', { type: 'lire', cibles: [Number(b.dataset.num)], params: { reprendre: true } });
    gestion.lectureSuivie = t.id; voirTache(t.id); suivreTaches();
  } catch (err) { b.disabled = false; b.textContent = '↻ Reprendre la lecture'; alert(err.message); }
});
function ouvrirGestion() {
  const dlg = $('#dlg-gestion');
  dlg.querySelectorAll('.seul-admin').forEach((b) => (b.hidden = !etat.admin));
  const c = etat.config.compte;
  $('#pan-moncompte').innerHTML = `
    <div class="grille">
      <div class="mesure"><span>Identifiant</span><b>${esc(c.identifiant)}</b></div>
      <div class="mesure"><span>Rôle</span><b>${ROLES_COMPTE[c.role] || c.role}</b></div>
      <div class="mesure"><span>Double authentification</span><b>${c.deuxFacteurs ? '✔ activée' : 'non'}</b></div>
      <div class="mesure"><span>Indicatif</span><b>${esc(c.indicatif || '–')}</b></div>
    </div>
    <h3>Changer de mot de passe</h3>
    <form id="form-mdp" class="parametres compact">
      <label>Actuel <input name="ancien" type="password" autocomplete="current-password" required></label>
      <label>Nouveau <input name="nouveau" type="password" autocomplete="new-password" required minlength="8"></label>
      <button type="submit">Changer</button>
    </form>
    <p class="erreur" id="retour-mdp"></p>
    <h3>Double authentification</h3>
    <div id="zone-2fa">${c.deuxFacteurs ? `<p class="note">Un code de votre application d’authentification est demandé à chaque connexion.</p>
      <form id="form-2fa-retirer" class="parametres compact"><label>Mot de passe <input name="motDePasse" type="password" autocomplete="current-password" required></label><button type="submit">Désactiver</button></form>`
      : `<p class="note">Recommandée pour les comptes qui programment les relais : en plus du mot de passe, un code à 6 chiffres donné par une application (Google Authenticator, Aegis, FreeOTP, 2FAS…).</p><button id="btn-2fa">Activer la double authentification</button>`}</div>
    <p class="erreur" id="retour-2fa"></p>
    <h3>Sessions</h3>
    <p class="note">Vous êtes resté connecté sur un appareil perdu ou partagé ? Fermez toutes vos autres sessions (celle-ci reste ouverte).</p>
    <div class="actions"><button id="btn-deco-partout">Déconnecter mes autres appareils</button><button id="btn-deconnexion">Se déconnecter</button></div>`;
  const r2 = (t) => ($('#retour-2fa').textContent = t);
  const b2 = $('#btn-2fa');
  if (b2) b2.onclick = async () => {
    try {
      const r = await postJson('/api/compte/deux-facteurs/preparer');
      $('#zone-2fa').innerHTML = `<p class="note">1. Scannez ce QR code avec l’application (ou saisissez la clé). 2. Tapez le code à 6 chiffres affiché.</p>
        <div class="qr-2fa"><img src="${r.qr}" alt="QR code"><span class="mono">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</span></div>
        <form id="form-2fa" class="parametres compact"><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label><button type="submit" class="principal">Activer</button></form>`;
      $('#form-2fa').onsubmit = async (e) => { e.preventDefault(); try { await postJson('/api/compte/deux-facteurs/activer', { code: e.target.code.value }); etat.config.compte.deuxFacteurs = true; ouvrirGestion(); r2('✔ Double authentification activée.'); } catch (x) { r2(x.message); } };
    } catch (x) { r2(x.message); }
  };
  const f2 = $('#form-2fa-retirer');
  if (f2) f2.onsubmit = async (e) => { e.preventDefault(); try { await postJson('/api/compte/deux-facteurs/retirer', { motDePasse: e.target.motDePasse.value }); etat.config.compte.deuxFacteurs = false; ouvrirGestion(); } catch (x) { r2(x.message); } };
  $('#btn-deco-partout').onclick = async () => { try { await postJson('/api/compte/deconnecter-partout'); r2('✔ Toutes vos autres sessions sont fermées.'); } catch (x) { r2(x.message); } };
  $('#form-mdp').onsubmit = async (e) => {
    e.preventDefault();
    try { await postJson('/api/compte/mot-de-passe', { ancien: e.target.ancien.value, nouveau: e.target.nouveau.value }); $('#retour-mdp').textContent = 'Mot de passe changé ✓'; e.target.reset(); }
    catch (x) { $('#retour-mdp').textContent = x.message; }
  };
  $('#btn-deconnexion').onclick = async () => { await postJson('/api/deconnexion'); location.reload(); };
  dlg.querySelector('[data-dlg="moncompte"]').click();
  dlg.showModal();
}

const ROLES_COMPTE = { membre: 'Membre', gestionnaire: 'Gestionnaire de secteur', admin: 'Administrateur' };
// Choix des nœuds d'un gestionnaire : relais Meshtastic connus et répéteurs MeshCore, ou saisie libre (!a1b2c3d4, clé MeshCore)
function editerSecteur(c, fini) {
  const z = $('#edition-secteur');
  const choisis = new Set(c.noeuds || []);
  const mt = [...etat.noeuds.values()].filter((n) => n.infrastructure || choisis.has(String(n.num))).map((n) => ({ id: String(n.num), nom: n.nomLong || n.id, info: n.id + (n.role ? ' · ' + n.role : '') }));
  const mcl = (typeof mc !== 'undefined' && mc.noeuds ? [...mc.noeuds.values()] : []).filter((n) => ['repeteur', 'salon'].includes(n.role) || choisis.has(String(n.cle).toUpperCase())).map((n) => ({ id: String(n.cle).toUpperCase(), nom: n.nom || n.cle.slice(0, 8), info: 'MeshCore · ' + n.cle.slice(0, 8) }));
  const tous = [...mt, ...mcl].sort((a, b) => a.nom.localeCompare(b.nom));
  const connus = new Set(tous.map((x) => x.id));
  const autres = [...choisis].filter((x) => !connus.has(x));
  z.innerHTML = `<h3>Secteur de ${esc(c.identifiant)}</h3>
    <div class="recherche"><input id="filtre-secteur" type="search" placeholder="Filtrer…"></div>
    <div class="liste-gestion" style="max-height:260px">${tous.map((x) => `<label class="ligne-gestion" data-nom="${esc((x.nom + ' ' + x.info).toLowerCase())}"><input type="checkbox" value="${x.id}" ${choisis.has(x.id) ? 'checked' : ''}><span class="titre">${esc(x.nom)} <small>${esc(x.info)}</small></span></label>`).join('') || '<div class="vide">Aucun relais connu.</div>'}</div>
    <label class="champ-libre">Autres nœuds (identifiants !xxxxxxxx ou clés MeshCore, séparés par des virgules) <input id="secteur-autres" value="${esc(autres.join(', '))}"></label>
    <div class="actions-prop"><button class="principal" id="secteur-ok">Enregistrer le secteur</button><button id="secteur-annuler">Annuler</button></div>`;
  z.scrollIntoView({ block: 'nearest' });
  $('#filtre-secteur').oninput = (e) => { const t = e.target.value.toLowerCase(); z.querySelectorAll('[data-nom]').forEach((l) => (l.hidden = t && !l.dataset.nom.includes(t))); };
  $('#secteur-annuler').onclick = () => (z.innerHTML = '');
  $('#secteur-ok').onclick = async () => {
    const l = [...z.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value).concat($('#secteur-autres').value.split(/[\s,;]+/).filter(Boolean));
    try { await postJson(`/api/comptes/${c.id}`, { noeuds: l }); z.innerHTML = ''; fini(); } catch (e) { $('#retour-comptes').textContent = e.message; }
  };
}
const ACTIONS_AUDIT = [
  [/admin-noeuds\/taches\/[^/]+\/relancer/, 'Programmation relancée'], [/admin-noeuds\/taches\/[^/]+\/arreter/, 'Programmation arrêtée'], [/admin-noeuds\/taches$/, 'Programmation à distance (Meshtastic)'],
  [/mc\/admin\/taches/, 'Administration MeshCore'], [/mc\/admin\/mot-de-passe/, 'Mot de passe MeshCore mémorisé'], [/compte\/deux-facteurs\/activer/, 'Double authentification activée'],
  [/compte\/deux-facteurs\/retirer/, 'Double authentification retirée'], [/compte\/deux-facteurs\/preparer/, 'Double authentification : QR code affiché'], [/compte\/deconnecter-partout/, 'Autres sessions fermées'],
  [/compte\/mot-de-passe/, 'Mot de passe changé'], [/^DELETE \/api\/comptes/, 'Compte supprimé'], [/\/api\/comptes\/\d+/, 'Compte modifié'], [/\/api\/comptes$/, 'Compte créé'],
  [/installation$/, 'Fiche d’installation'], [/a-faire$/, 'Note « à faire sur place »'], [/sauvegardes\/restaurer/, 'Sauvegarde restaurée'], [/\/api\/sauvegardes$/, 'Sauvegarde manuelle'],
  [/traceroute\//, 'Traceroute manuel'], [/\/api\/envoi/, 'Message envoyé'], [/mc\/messages/, 'Message MeshCore envoyé'], [/federation/, 'Bulles voisines'], [/releves/, 'Relevé de terrain'],
  [/radio\/(connecter|deconnecter|modules|scanner|agents)/, 'Module radio'], [/reglages|mqtt|config/, 'Réglages'],
];
const libelleAudit = (a) => { for (const [re, l] of ACTIONS_AUDIT) if (re.test(a)) return `${l} <small class="mono">${esc(a)}</small>`; return esc(a); };
async function rendreJournal(filtre) {
  const z = $('#pan-journal');
  let l;
  try { l = await api('/api/audit?limite=500' + (filtre ? '&action=' + encodeURIComponent(filtre) : '')); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  z.innerHTML = `<p class="note">Qui a fait quoi : connexions (et refus), programmation des nœuds, réglages, comptes, sauvegardes… Les mots de passe, clés et codes n’y figurent jamais. Gardé 180 jours.</p>
    <div class="recherche"><input id="filtre-journal" type="search" placeholder="Filtrer (ex. connexion, admin-noeuds, comptes)…" value="${esc(filtre || '')}"></div>
    <table class="voisins journal-audit"><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Détail</th></tr></thead><tbody>
    ${l.map((x) => `<tr class="${x.ok ? '' : 'refus'}"><td title="${new Date(x.heure).toLocaleString('fr-FR')}">${new Date(x.heure).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(x.compte || '?')}<br><small>${esc(x.ip || '')}</small></td><td>${x.ok ? '' : '⛔ '}${libelleAudit(x.action)}</td><td><small>${esc(x.detail || '')}</small></td></tr>`).join('') || '<tr><td colspan="4" class="vide">Rien pour l’instant.</td></tr>'}
    </tbody></table>`;
  const fi = $('#filtre-journal');
  fi.onchange = () => rendreJournal(fi.value.trim());
}
async function rendreComptes() {
  const z = $('#pan-comptes');
  let liste;
  try { liste = await api('/api/comptes'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const STATUTS = { actif: 'Actif', en_attente: 'À valider', desactive: 'Désactivé' };
  z.innerHTML = `
    <table class="voisins comptes"><thead><tr><th>Identifiant</th><th>Indicatif</th><th>Rôle</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead><tbody>
    ${liste.map((c) => `<tr data-id="${c.id}">
      <td><b>${esc(c.identifiant)}</b>${c.email ? `<br><small>${esc(c.email)}</small>` : ''}</td><td>${esc(c.indicatif || '–')}</td>
      <td><select data-role>${['membre', 'gestionnaire', 'admin'].map((r) => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${ROLES_COMPTE[r]}</option>`).join('')}</select>${c.role === 'gestionnaire' ? `<br><button class="mini" data-secteur>Secteur : ${(c.noeuds || []).length} nœud(s)…</button>` : ''}</td>
      <td><span class="badge ${c.statut === 'actif' ? 'actif' : c.statut === 'en_attente' ? 'attente' : 'inactif'}">${STATUTS[c.statut] || c.statut}</span>${c.deuxFacteurs ? ' <span class="badge actif" title="Double authentification activée">2FA</span>' : ''}</td>
      <td>${c.derniere ? ilYa(c.derniere) : 'jamais'}</td>
      <td class="actions-ligne">${c.statut === 'en_attente' ? '<button data-statut="actif" class="principal">Valider</button>' : c.statut === 'actif' ? '<button data-statut="desactive">Désactiver</button>' : '<button data-statut="actif">Réactiver</button>'}${c.deuxFacteurs ? '<button data-retirer-2fa title="Téléphone perdu : retirer la double authentification de ce compte">Retirer 2FA</button>' : ''}<button data-deco title="Fermer toutes les sessions ouvertes de ce compte">Déconnecter</button><button data-suppr title="Supprimer">✕</button></td>
    </tr>`).join('')}
    </tbody></table>
    <h3>Ajouter un compte</h3>
    <form id="form-ajout-compte" class="parametres compact">
      <label>Identifiant <input name="identifiant" required minlength="3"></label>
      <label>Indicatif <input name="indicatif"></label>
      <label>Mot de passe provisoire <input name="motDePasse" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Rôle <select name="role"><option value="membre">Membre</option><option value="gestionnaire">Gestionnaire de secteur</option><option value="admin">Administrateur</option></select></label>
      <button type="submit">Créer</button>
    </form>
    <p class="erreur" id="retour-comptes"></p>
    <div id="edition-secteur"></div>
    <p class="note">Un <b>membre</b> voit les messages texte et les positions exactes. Un <b>gestionnaire de secteur</b> programme à distance, remplit la fiche d’installation et teste (traceroute) les seuls nœuds de son secteur, Meshtastic ou MeshCore. Un <b>administrateur</b> gère en plus les comptes, les réglages, les modules et tous les nœuds.</p>`;
  const retour = (t) => ($('#retour-comptes').textContent = t);
  const action = async (fn) => { try { await fn(); rendreComptes(); } catch (e) { retour(e.message); } };
  z.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-role]').onchange = (e) => action(() => postJson(`/api/comptes/${id}`, { role: e.target.value }));
    const bs = tr.querySelector('[data-statut]');
    if (bs) bs.onclick = () => action(() => postJson(`/api/comptes/${id}`, { statut: bs.dataset.statut }));
    tr.querySelector('[data-suppr]').onclick = () => { if (confirm('Supprimer ce compte ?')) action(() => postJson(`/api/comptes/${id}`, {}, 'DELETE')); };
    const b2f = tr.querySelector('[data-retirer-2fa]');
    if (b2f) b2f.onclick = () => { if (confirm('Retirer la double authentification de ce compte ?')) action(() => postJson(`/api/comptes/${id}`, { retirerDeuxFacteurs: true })); };
    tr.querySelector('[data-deco]').onclick = () => action(() => postJson(`/api/comptes/${id}`, { deconnecter: true }));
    const bsec = tr.querySelector('[data-secteur]');
    if (bsec) bsec.onclick = () => editerSecteur(liste.find((c) => String(c.id) === id), () => rendreComptes());
  });
  $('#form-ajout-compte').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    action(() => postJson('/api/comptes', { identifiant: f.identifiant.value, indicatif: f.indicatif.value, motDePasse: f.motDePasse.value, role: f.role.value }));
  };
}

async function optionsDepartements(select, code) {
  const liste = await api('/api/departements').catch(() => []);
  select.innerHTML = liste.map((d) => `<option value="${d.code}" ${d.code === code ? 'selected' : ''}>${d.code} · ${esc(d.nom)}</option>`).join('');
}

async function rendreReglages() {
  const z = $('#pan-reglages');
  let r;
  try { r = await api('/api/reglages'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  z.innerHTML = `
    <form id="form-reglages">
      <div class="grille-form">
        <label>Nom de la carte <input name="titre" value="${esc(r.titre)}" maxlength="80"></label>
        <label>Département <select name="departement"></select><small>Fixe la zone, le contour et le centrage de la carte</small></label>
        <label>Serveur MQTT <input name="mqttUrl" value="${esc(r.mqtt.url)}"></label>
        <label>Sujet racine <input name="mqttRacine" value="${esc(r.mqtt.racine)}"></label>
        <label>Utilisateur MQTT <input name="mqttUtilisateur" value="${esc(r.mqtt.utilisateur)}" autocomplete="off"></label>
        <label>Mot de passe MQTT <input name="mqttMotDePasse" type="password" placeholder="${r.mqtt.motDePasseDefini ? '•••••• (inchangé)' : ''}" autocomplete="new-password"></label>
        <label>Sujets supplémentaires <input name="mqttSujets" value="${esc(r.mqtt.sujetsSupplementaires)}" placeholder="séparés par des virgules"></label>
        <label>Inscriptions <select name="inscriptions">${[['validation', 'Sur validation de l’admin'], ['ouvertes', 'Ouvertes à tous'], ['fermees', 'Fermées']].map(([v, l]) => `<option value="${v}" ${r.inscriptions === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Positions publiques <select name="precisionPublique">${[[3, 'Arrondies à ≈ 100 m'], [2, 'Arrondies à ≈ 1 km'], [4, 'Arrondies à ≈ 10 m'], [-1, 'Exactes']].map(([v, l]) => `<option value="${v}" ${r.precisionPublique === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Conservation (jours) <input name="retentionJours" type="number" min="1" max="90" value="${r.retentionJours}"></label>
        <label class="large-col">Canaux à déchiffrer <textarea name="canaux" rows="5">${esc(r.canaux)}</textarea><small>Un canal par ligne : nom=clé en base64</small></label>
      </div>
      <p class="erreur" id="retour-reglages"></p>
      <div class="actions"><button type="submit" class="principal">Enregistrer et redémarrer</button></div>
      <p class="note">L’enregistrement redémarre le service (une dizaine de secondes). Un changement de département retélécharge le relief IGN (quelques minutes).</p>
    </form>`;
  optionsDepartements(z.querySelector('[name=departement]'), r.departement.code);
  $('#form-reglages').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const corps = {
      titre: f.titre.value, inscriptions: f.inscriptions.value, precisionPublique: Number(f.precisionPublique.value), retentionJours: Number(f.retentionJours.value), canaux: f.canaux.value,
      mqtt: { url: f.mqttUrl.value, racine: f.mqttRacine.value, utilisateur: f.mqttUtilisateur.value, motDePasse: f.mqttMotDePasse.value, sujetsSupplementaires: f.mqttSujets.value },
    };
    if (f.departement.value !== r.departement.code) corps.departement = f.departement.value;
    try { await postJson('/api/reglages', corps); $('#dlg-gestion').close(); attendreRedemarrage('Réglages enregistrés'); }
    catch (x) { $('#retour-reglages').textContent = x.message; }
  };
}

async function installation() {
  const info = await api('/api/installation');
  if (!info.requise) return false;
  const dlg = $('#dlg-installation'), f = $('#form-installation');
  $('#champ-code').hidden = !info.codeRequis;
  if (!info.codeRequis && !info.reseauLocal) {
    f.innerHTML = '<p class="erreur">Cette carte n’est pas encore installée. Ouvrez-la depuis le réseau local de la machine qui l’héberge pour créer le compte administrateur.</p>';
  } else {
    const a = info.actuel;
    await optionsDepartements(f.departement, a.departement);
    f.titre.value = a.titre || '';
    f.mqttUrl.value = a.mqtt.url || '';
    f.mqttRacine.value = a.mqtt.racine || 'msh/EU_868';
    f.mqttUtilisateur.value = a.mqtt.utilisateur || '';
    if (a.mqtt.motDePasseDefini) f.mqttMotDePasse.placeholder = '•••••• (inchangé)';
    f.canaux.placeholder = a.canaux.length ? `Laisser vide pour garder : ${a.canaux.join(', ')}` : 'LongFast=AQ==';
    if (!a.canaux.length) f.canaux.value = 'LongFast=AQ==';
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('.erreur');
      if (f.motDePasse.value !== f.confirmation.value) { err.textContent = 'Les deux mots de passe sont différents'; return; }
      const reglages = { departement: f.departement.value, canaux: f.canaux.value, inscriptions: f.inscriptions.value, mqtt: { url: f.mqttUrl.value, racine: f.mqttRacine.value, utilisateur: f.mqttUtilisateur.value, motDePasse: f.mqttMotDePasse.value } };
      if (f.titre.value.trim()) reglages.titre = f.titre.value.trim();
      if (!f.mqttUrl.value.trim()) delete reglages.mqtt.url;
      try {
        const r = await postJson('/api/installation', { compte: { identifiant: f.identifiant.value, indicatif: f.indicatif.value, motDePasse: f.motDePasse.value }, code: f.code.value, reglages });
        dlg.close();
        if (r.redemarrage) attendreRedemarrage('Installation terminée ✓'); else location.reload();
      } catch (x) { err.textContent = x.message; }
    };
  }
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // non refermable tant que l'installation n'est pas faite
  dlg.showModal();
  return true;
}

async function demarrer() {
  etat.config = await api('/api/config');
  etat.admin = etat.config.admin;
  etat.gestion = !!etat.config.gestion;
  etat.secteur = etat.admin ? null : (etat.config.compte && etat.config.compte.noeuds) || [];
  etat.membre = etat.config.membre;
  document.title = etat.config.titre;
  // Liens vers le client et le flasheur officiels (Web Serial / Web Bluetooth : HTTPS et Chrome ou Edge obligatoires)
  {
    const o = etat.config.outils || {}, https = location.protocol === 'https:';
    const auto = (portHttps, portHttp) => `${location.protocol}//${location.hostname}:${https ? portHttps : portHttp}/`;
    const lc = $('#lien-client'), lf = $('#lien-flasher'), note = $('#note-outils');
    if (lc) lc.href = o.client || auto(8443, 8096);
    if (lf) lf.href = o.flasher || auto(10000, 8097);
    const chromium = !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /Chrom|Edge/i.test(b.brand)));
    if (note) note.textContent = !https ? 'USB et Bluetooth demandent la carte en HTTPS (voir README).' : !('serial' in navigator) && !chromium ? 'USB et Bluetooth : utilisez Chrome ou Edge.' : '';
  }
  const nomMarque = document.querySelector('.marque .nom');
  if (nomMarque) nomMarque.textContent = etat.config.titre.split(' · ')[0];
  const marque = document.querySelector('.marque .sous');
  if (marque) marque.textContent = `Carte live · ${etat.config.zoneNom}`;
  afficherVersion(etat.config.version);
  setInterval(() => fetch('/api/version').then((r) => r.json()).then(afficherVersion).catch(() => {}), 3600000);
  if (etat.membre) {
    const c = etat.config.compte;
    $('#btn-admin').textContent = `${c.indicatif || c.identifiant}${etat.admin ? ' · admin' : etat.gestion ? ' · gestionnaire' : ''}`;
    $('#btn-admin').classList.add('connecte');
    $('#onglet-messages').hidden = false;
  }
  if (etat.admin) $('#bloc-modules').hidden = false;
  if (etat.gestion) $('#onglet-gestion').hidden = false;
  initCarte();
  rendreFiltres();
  rendreLegende();
  brancherInterface();
  brancherRecherche();
  await chargerNoeuds();
  appliquerZone(etat.zone);
  await Promise.all([chargerLiens(), chargerEtat(), chargerFlux()]);
  connecterWs();
  if (typeof demarrerMeshcore === 'function') demarrerMeshcore();
  chargerRelief();
  chargerAsymetrie(); setInterval(chargerAsymetrie, 120000);
  chargerChemins(); setInterval(chargerChemins, 300000);
  chargerSanteCarte(); setInterval(chargerSanteCarte, 60000);
  chargerFederation(); setInterval(chargerFederation, 600000);
  demarrerTerrain();
  chargerActiviteInitiale();
  setInterval(rendreLegende, 60000);
  if (etat.config.installation) installation();
  setInterval(() => { rendreNoeuds(); rendreReseau(); }, 30000);
  setInterval(() => chargerLiens().catch(() => {}), 120000);
}

demarrer().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 0 50% 0;text-align:center;color:#ff5c6c">Erreur de chargement : ${esc(e.message)}</div>`);
});

// ---- QR code des réglages d'un nœud (ChannelSet meshtastic.org/e/#…) -------------------------
const precisionTexte = (bits) => {
  if (!bits) return 'pas de position';
  if (bits >= 32) return 'exacte';
  const m = 23300 / 2 ** (bits - 10);
  return m >= 1000 ? `≈ ${(m / 1000).toFixed(1).replace('.', ',')} km` : `≈ ${Math.round(m)} m`;
};
async function ouvrirQr(n, choix = {}) {
  const dlg = $('#dlg-qr'), z = $('#qr-contenu');
  const nom = n.nomLong || n.nomCourt || n.id;
  if (!dlg.open) dlg.showModal();
  if (!z.querySelector('.qr-image')) z.innerHTML = '<div class="vide">Chargement…</div>';
  const q = new URLSearchParams();
  if (choix.canaux) q.set('canaux', choix.canaux.join(','));
  if (choix.lora === false) q.set('lora', '0');
  if (choix.up) q.set('up', choix.up.join(','));
  if (choix.down) q.set('down', choix.down.join(','));
  const estLocal = etat.radio && etat.radio.noeudLocal === n.num;
  let r;
  try { r = await api(`/api/noeuds/${n.num}/qr?${q}`); } catch (e) {
    z.innerHTML = `<h3>QR code des réglages · ${esc(nom)}</h3>
      <div class="vide">${esc(e.message)}</div>
      ${e.statut === 404 ? `<p class="note">Le programme connaît d’office les réglages du module connecté en Wi-Fi. Pour un autre nœud, il faut d’abord lire sa configuration par LoRa (le nœud doit avoir la clé du module dans ses clés d’administration).</p>
      <div class="boutons"><button id="qr-lire" class="principal">📡 Lire sa configuration par LoRa</button></div><div id="qr-suivi" class="note"></div>` : ''}`;
    const b = $('#qr-lire');
    if (b) b.onclick = () => lireAvantQr(n, b);
    return;
  }
  const lora = r.lora;
  z.innerHTML = `<h3>QR code des réglages · ${esc(nom)}</h3>
    <div class="ident">${esc(n.id)} · ${r.source === 'module' ? 'réglages du module connecté' : 'configuration lue par LoRa'} ${esc(ilYa(r.heure))}</div>
    <div class="qr-zone">
      <div>
        <div class="qr-image">${r.svg}</div>
        <div class="boutons centre"><button id="qr-png">⬇️ PNG</button><button id="qr-copier">📋 Copier le lien</button><button id="qr-imprimer">🖨️ Imprimer</button></div>
      </div>
      <div class="qr-choix">
        <h4>Canaux inclus</h4>
        ${r.canaux.map((c) => `<div class="qr-canal"><label class="qr-nom"><input type="checkbox" data-qr-canal="${c.index}" ${c.inclus ? 'checked' : ''} ${c.principal ? 'disabled' : ''}>
          <span><b>${c.index} · ${esc(c.nom || '(sans nom)')}</b>${c.principal ? ' <span class="badge canal">principal</span>' : ''}<br>
          <small>clé ${esc(c.cle)} · position ${esc(precisionTexte(c.precision))}</small></span></label>
          <span class="qr-mqtt" title="MQTT : montant = envoyé au serveur, descendant = réémis en LoRa depuis le serveur">
            <label><input type="checkbox" data-qr-up="${c.index}" ${c.montant ? 'checked' : ''}>↑</label>
            <label><input type="checkbox" data-qr-down="${c.index}" ${c.descendant ? 'checked' : ''}>↓</label></span></div>`).join('')}
        <div class="boutons qr-raccourcis"><small>MQTT :</small>
          <button data-qr-mqtt="zero">↑↓ canal 0 seulement</button><button data-qr-mqtt="up">↑ partout, ↓ nulle part</button><button data-qr-mqtt="aucun">aucun</button><button data-qr-mqtt="noeud">comme le nœud</button></div>
        ${r.canaux.some((c) => c.montant !== c.montantNoeud || c.descendant !== c.descendantNoeud) ? '<div class="note">MQTT modifié par rapport au nœud d’origine.</div>' : ''}
        <h4>Réglage radio</h4>
        ${lora ? `<label class="qr-canal"><input type="checkbox" id="qr-lora" ${lora.inclus ? 'checked' : ''}>
          <span><b>Inclure le réglage LoRa</b><br><small>${esc([lora.region, lora.preset, lora.frequence ? lora.frequence.toFixed(4).replace('.', ',') + ' MHz' : (lora.slot ? 'slot ' + lora.slot : null), lora.sauts ? lora.sauts + ' sauts' : null, lora.puissance ? lora.puissance + ' dBm' : 'puissance par défaut'].filter(Boolean).join(' · '))}</small></span></label>`
          : '<div class="vide">Réglage LoRa non connu (seuls les canaux sont dans le QR).</div>'}
        <div class="alerte attention">Ce QR code contient les clés des canaux : ne le donnez qu’à des personnes de confiance.</div>
        <p class="note">Sur le module à configurer : appli Meshtastic › Canaux › scanner, puis <b>Remplacer</b>. Le rôle, le nom, la position, le Wi-Fi/MQTT et les clés d’administration ne changent pas.</p>
        ${!estLocal ? '<div class="boutons"><button id="qr-relire">📡 Relire par LoRa</button></div><div id="qr-suivi" class="note"></div>' : ''}
      </div>
    </div>
    <input class="qr-lien" readonly value="${esc(r.url)}">`;
  const coches = (attr) => [...z.querySelectorAll(`[${attr}]`)].filter((x) => x.checked).map((x) => Number(x.getAttribute(attr)));
  const relancer = (mqtt) => ouvrirQr(n, {
    canaux: coches('data-qr-canal').concat(r.canaux.filter((c) => c.principal).map((c) => c.index)),
    lora: $('#qr-lora') ? $('#qr-lora').checked : true,
    ...(mqtt || { up: coches('data-qr-up'), down: coches('data-qr-down') }),
  });
  z.querySelectorAll('[data-qr-canal], #qr-lora, [data-qr-up], [data-qr-down]').forEach((x) => (x.onchange = () => relancer()));
  z.querySelectorAll('[data-qr-mqtt]').forEach((b) => (b.onclick = () => {
    const tous = r.canaux.map((c) => c.index);
    relancer({ zero: { up: [0], down: [0] }, up: { up: tous, down: [] }, aucun: { up: [], down: [] }, noeud: {} }[b.dataset.qrMqtt]);
  }));
  $('#qr-copier').onclick = async () => { try { await navigator.clipboard.writeText(r.url); $('#qr-copier').textContent = '✔ Copié'; } catch { z.querySelector('.qr-lien').select(); } };
  const fichier = `QR-reglages-${(n.nomCourt || n.id).replace(/[^\w-]+/g, '') || n.num}`;
  $('#qr-png').onclick = () => {
    const img = new Image();
    const u = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 1024;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1024, 1024); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, 1024, 1024);
      URL.revokeObjectURL(u);
      c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = fichier + '.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
    };
    img.src = u;
  };
  $('#qr-imprimer').onclick = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    const inclus = r.canaux.filter((c) => c.inclus).map((c) => esc(c.nom)).join(', ');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(fichier)}</title><style>body{font-family:sans-serif;text-align:center;margin:20mm}svg{width:110mm;height:110mm}p{font-size:12pt}small{word-break:break-all;color:#555}</style>
      <h2>Réglages de ${esc(nom)}</h2>${r.svg}<p><b>Canaux :</b> ${inclus}</p>${lora && lora.inclus ? `<p><b>Radio :</b> ${esc([lora.region, lora.preset, lora.sauts + ' sauts'].join(' · '))}</p>` : ''}
      <p>Appli Meshtastic › Canaux › scanner › <b>Remplacer</b></p><small>${esc(r.url)}</small><script>onload=()=>print()<\/script>`);
    w.document.close();
  };
  const br = $('#qr-relire');
  if (br) br.onclick = () => lireAvantQr(n, br);
}
async function lireAvantQr(n, bouton) {
  const suivi = $('#qr-suivi');
  bouton.disabled = true;
  let t;
  try { t = await postJson('/api/admin-noeuds/taches', { type: 'lire', cibles: [n.num], params: {} }); } catch (e) { suivi.textContent = e.message; bouton.disabled = false; return; }
  suivi.textContent = 'Lecture en cours par LoRa (compter 30 s à 2 min)…';
  for (let i = 0; i < 120; i++) {
    await new Promise((ok) => setTimeout(ok, 2500));
    try { t = await api('/api/admin-noeuds/taches/' + t.id); } catch { continue; }
    const x = t.noeuds[0];
    if (x && x.detail) suivi.textContent = x.detail;
    if (t.fin) {
      if (x.statut === 'ok') { $('#qr-contenu').innerHTML = ''; return ouvrirQr(n); }
      suivi.textContent = 'Échec : ' + (x.detail || 'pas de réponse');
      bouton.disabled = false;
      return;
    }
  }
  bouton.disabled = false;
}

// ---- Largeur des panneaux gauche et droite (glisser la poignée, double-clic pour élargir) ------------
(function panneauxRedimensionnables() {
  const regles = { panneau: { var: '--l-panneau', defaut: 360, large: 620, sens: 1 }, fiche: { var: '--l-fiche', defaut: 400, large: 720, sens: -1 } };
  const appliquer = (cle, l) => {
    const r = regles[cle];
    const max = Math.max(r.defaut, Math.round(window.innerWidth * 0.6));
    l = Math.max(280, Math.min(max, Math.round(l)));
    document.documentElement.style.setProperty(r.var, l + 'px');
    try { localStorage.setItem('gaulix_l_' + cle, l); } catch { /* indisponible */ }
    if (typeof carte !== 'undefined') carte.invalidateSize();
    return l;
  };
  for (const cle of Object.keys(regles)) {
    let memo = null;
    try { memo = Number(localStorage.getItem('gaulix_l_' + cle)); } catch { /* indisponible */ }
    if (memo) appliquer(cle, memo);
    const el = document.getElementById(cle);
    if (!el) continue;
    const p = document.createElement('div');
    p.className = 'poignee';
    p.title = 'Glisser pour élargir · double-clic : large / normal';
    // Le panneau de droite défile et floute son fond : sa poignée est placée juste à côté, hors du panneau
    if (cle === 'fiche') { p.classList.add('poignee-fiche'); el.after(p); } else el.prepend(p);
    p.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      p.setPointerCapture(e.pointerId);
      p.classList.add('active'); document.body.classList.add('redim');
      const x0 = e.clientX, l0 = el.getBoundingClientRect().width || regles[cle].defaut;
      const bouger = (ev) => appliquer(cle, l0 + regles[cle].sens * (ev.clientX - x0));
      const fin = () => { p.classList.remove('active'); document.body.classList.remove('redim'); p.removeEventListener('pointermove', bouger); p.removeEventListener('pointerup', fin); p.removeEventListener('pointercancel', fin); };
      p.addEventListener('pointermove', bouger);
      p.addEventListener('pointerup', fin);
      p.addEventListener('pointercancel', fin);
    });
    p.addEventListener('dblclick', () => {
      const actuelle = el.getBoundingClientRect().width;
      appliquer(cle, actuelle < regles[cle].large - 20 ? regles[cle].large : regles[cle].defaut);
    });
  }
})();

// ---- Module branché sur ce PC (USB ou Bluetooth), relayé par la page ---------------------------
// La page ouvre le port USB (Web Serial) ou la liaison Bluetooth (Web Bluetooth) et transmet le flux
// Meshtastic au serveur par une WebSocket : le module devient celui de la carte, sans agent à installer.
const moduleNav = { etat: 'aucun', ws: null, port: null, lecteur: null, ble: null, hote: null, nom: null, type: null, erreur: null };
const ENTETE_MT = [0x94, 0xc3];
const BLE_SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd', BLE_TORADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7', BLE_FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002', BLE_FROMNUM = 'ed9da18c-a800-4f66-a670-aa7547e34453';
function blocUsbNavigateur() {
  const https = location.protocol === 'https:';
  const m = moduleNav;
  const sousTitre = m.etat === 'relie' ? `relié par cette page (${m.type === 'ble' ? 'Bluetooth' : 'USB'}) · gardez cet onglet ouvert` : m.etat === 'connexion' ? 'connexion…' : m.erreur ? esc(m.erreur) : 'module branché sur ce PC';
  return `<div class="bloc-usb ${m.etat}">
    <div class="titre-usb"><span class="point ${m.etat === 'relie' ? 'actif' : m.etat === 'connexion' ? 'recent' : 'inactif'}"></span><b>${m.etat === 'relie' ? esc(m.nom || 'Module de ce PC') : 'Module de ce PC'}</b><small>${sousTitre}</small></div>
    ${!https ? '<p class="note">USB et Bluetooth demandent la carte en <b>HTTPS</b> (adresse en …ts.net) et Chrome ou Edge.</p>'
      : m.etat === 'relie' || m.etat === 'connexion' ? '<div class="actions-prop"><button data-usb="stop">Débrancher</button></div>'
      : `<div class="actions-prop"><button data-usb="usb" class="principal-usb">🔌 Brancher en USB</button><button data-usb="ble">📶 Bluetooth</button></div>`}
  </div>`;
}
function brancherBoutonsUsb(zone) {
  zone.querySelectorAll('[data-usb]').forEach((b) => (b.onclick = () => {
    if (b.dataset.usb === 'usb') brancherUsb(); else if (b.dataset.usb === 'ble') brancherBle(); else debrancherModuleNav();
  }));
}
function majModuleNav(etatNouveau, erreur) {
  moduleNav.etat = etatNouveau; moduleNav.erreur = erreur || null;
  signatureModules = '';
  if (typeof rendreModules === 'function') rendreModules(true);
  const o = $('#outil-usb'); if (o) o.textContent = moduleNav.etat === 'relie' && moduleNav.type === 'usb' ? '🔌 Débrancher le module USB' : '🔌 Module USB de ce PC';
}
function ouvrirWsModule(nom, source, envoyerAuModule) {
  return new Promise((ok, ko) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/module?nom=${encodeURIComponent(nom)}&source=${encodeURIComponent(source)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ok(ws);
    ws.onerror = () => ko(new Error('connexion au serveur refusée (êtes-vous connecté en admin ?)'));
    ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) envoyerAuModule(new Uint8Array(e.data)); };
    ws.onclose = () => { if (moduleNav.ws === ws) debrancherModuleNav('liaison avec le serveur fermée'); };
  });
}
async function brancherUsb() {
  if (!('serial' in navigator)) { alert('Ce navigateur ne gère pas l’USB : utilisez Chrome ou Edge, sur la carte en HTTPS.'); return; }
  let port;
  try { port = await navigator.serial.requestPort({}); } catch { return; } // fenêtre de choix annulée
  moduleNav.type = 'usb'; majModuleNav('connexion');
  try {
    await port.open({ baudRate: 115200 });
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* pas géré */ }
    moduleNav.port = port;
    const info = port.getInfo ? port.getInfo() : {};
    const nom = `USB ${etat.compte ? etat.compte.identifiant : ''}`.trim();
    const ecrivain = port.writable.getWriter();
    moduleNav.ecrivain = ecrivain;
    // Laisse au module le temps de démarrer s'il a redémarré à l'ouverture du port
    await new Promise((r) => setTimeout(r, 1500));
    moduleNav.ws = await ouvrirWsModule(nom, 'USB' + (info.usbVendorId ? ' ' + info.usbVendorId.toString(16) + ':' + (info.usbProductId || 0).toString(16) : ''), (octets) => ecrivain.write(octets).catch(() => {}));
    moduleNav.nom = 'Module USB de ce PC';
    moduleNav.hote = 'agent-' + nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    majModuleNav('relie');
    // Module → serveur
    (async () => {
      const lecteur = port.readable.getReader();
      moduleNav.lecteur = lecteur;
      try {
        for (;;) {
          const { value, done } = await lecteur.read();
          if (done) break;
          if (value && moduleNav.ws && moduleNav.ws.readyState === 1) moduleNav.ws.send(value);
        }
      } catch { /* port débranché */ }
      if (moduleNav.port === port) debrancherModuleNav('module débranché');
    })();
  } catch (e) {
    try { await port.close(); } catch { /* déjà fermé */ }
    majModuleNav('aucun', e.message.includes('open') || e.name === 'NetworkError' ? 'port déjà utilisé (fermez l’appli Meshtastic ou l’agent)' : e.message);
  }
}
async function brancherBle() {
  if (!navigator.bluetooth) { alert('Ce navigateur ne gère pas le Bluetooth : utilisez Chrome ou Edge, sur la carte en HTTPS.'); return; }
  let appareil;
  try { appareil = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] }); } catch { return; }
  moduleNav.type = 'ble'; majModuleNav('connexion');
  try {
    const gatt = await appareil.gatt.connect();
    const svc = await gatt.getPrimaryService(BLE_SERVICE);
    const toRadio = await svc.getCharacteristic(BLE_TORADIO), fromRadio = await svc.getCharacteristic(BLE_FROMRADIO), fromNum = await svc.getCharacteristic(BLE_FROMNUM);
    moduleNav.ble = { appareil, gatt };
    // Bluetooth : une trame par lecture/écriture ; on ajoute ou retire l'en-tête du flux série (0x94 0xC3 + longueur)
    let lecture = false;
    const vider = async () => {
      if (lecture) return; lecture = true;
      try {
        for (;;) {
          const v = await fromRadio.readValue();
          if (!v.byteLength) break;
          const t = new Uint8Array(4 + v.byteLength);
          t.set(ENTETE_MT); t[2] = v.byteLength >> 8; t[3] = v.byteLength & 255; t.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), 4);
          if (moduleNav.ws && moduleNav.ws.readyState === 1) moduleNav.ws.send(t);
        }
      } catch { /* liaison interrompue */ }
      lecture = false;
    };
    let tampon = new Uint8Array(0);
    const versModule = async (octets) => {
      const n = new Uint8Array(tampon.length + octets.length); n.set(tampon); n.set(octets, tampon.length); tampon = n;
      for (;;) {
        let i = 0; while (i + 1 < tampon.length && !(tampon[i] === 0x94 && tampon[i + 1] === 0xc3)) i++;
        if (i + 4 > tampon.length) { tampon = tampon.slice(Math.max(0, i)); return; }
        const lg = (tampon[i + 2] << 8) | tampon[i + 3];
        if (i + 4 + lg > tampon.length) { tampon = tampon.slice(i); return; }
        const trame = tampon.slice(i + 4, i + 4 + lg); tampon = tampon.slice(i + 4 + lg);
        try { await toRadio.writeValue(trame); } catch { /* ignoré */ }
        setTimeout(vider, 50);
      }
    };
    await fromNum.startNotifications();
    fromNum.addEventListener('characteristicvaluechanged', vider);
    appareil.addEventListener('gattserverdisconnected', () => { if (moduleNav.ble && moduleNav.ble.appareil === appareil) debrancherModuleNav('Bluetooth déconnecté'); });
    const nom = `Bluetooth ${appareil.name || ''}`.trim();
    moduleNav.ws = await ouvrirWsModule(nom, 'Bluetooth', versModule);
    moduleNav.nom = appareil.name || 'Module Bluetooth';
    moduleNav.hote = 'agent-' + nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    majModuleNav('relie');
    vider();
  } catch (e) {
    try { appareil.gatt.disconnect(); } catch { /* déjà */ }
    majModuleNav('aucun', 'Bluetooth : ' + e.message);
  }
}
async function debrancherModuleNav(raison) {
  const m = moduleNav;
  const ws = m.ws; m.ws = null;
  try { if (ws) ws.close(); } catch { /* déjà */ }
  try { if (m.lecteur) await m.lecteur.cancel(); } catch { /* déjà */ }
  try { if (m.ecrivain) m.ecrivain.releaseLock(); } catch { /* déjà */ }
  const port = m.port; m.port = null; m.lecteur = null; m.ecrivain = null;
  try { if (port) await port.close(); } catch { /* déjà */ }
  try { if (m.ble) m.ble.gatt.disconnect(); } catch { /* déjà */ }
  m.ble = null; m.hote = null;
  majModuleNav('aucun', typeof raison === 'string' ? raison : null);
  setTimeout(() => { if (typeof chargerEtat === 'function') chargerEtat().catch(() => {}); }, 1500);
}
window.addEventListener('beforeunload', (e) => { if (moduleNav.etat === 'relie') { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('DOMContentLoaded', () => {
  const o = $('#outil-usb'), b = $('#outil-ble');
  if (o) o.onclick = () => { document.querySelector('.menu-outils').open = false; moduleNav.etat === 'relie' && moduleNav.type === 'usb' ? debrancherModuleNav() : brancherUsb(); };
  if (b) b.onclick = () => { document.querySelector('.menu-outils').open = false; brancherBle(); };
});
