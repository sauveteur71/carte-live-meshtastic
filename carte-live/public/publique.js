'use strict';
// Carte publique allégée, à intégrer dans un site (iframe) : relais, passerelles, nœuds à position approchée,
// liaisons radio. Aucune donnée réservée aux membres (messages, positions exactes des particuliers).
// Options d'adresse : ?clients=0 (masquer les nœuds), ?liens=0 (masquer les liaisons), ?titre=…
const params = new URLSearchParams(location.search);
const opt = { clients: params.get('clients') !== '0', liens: params.get('liens') !== '0' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const couleurSnr = (s) => (s == null ? '#7d8fa3' : s >= 5 ? '#3ee6c4' : s >= 0 ? '#a3e635' : s >= -7 ? '#facc15' : s >= -12 ? '#fb923c' : '#f87171');
let carte, couche, premier = true;

async function demarrer() {
  const c = await (await fetch('/api/config')).json();
  document.getElementById('titre').textContent = params.get('titre') || c.titre || 'Réseau Meshtastic';
  document.title = (params.get('titre') || c.titre || 'Réseau Meshtastic') + ' · carte publique';
  carte = L.map('carte', { zoomControl: true, attributionControl: true }).setView(c.centre, c.zoom);
  const t = c.tuiles;
  L.tileLayer(t.url, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 19, attribution: t.attribution }).addTo(carte);
  if (t.etiquettes) L.tileLayer(t.etiquettes, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 19 }).addTo(carte);
  if (c.zone && premier) carte.fitBounds([[c.zone[0], c.zone[1]], [c.zone[2], c.zone[3]]], { padding: [10, 10] });
  couche = L.layerGroup().addTo(carte);
  await rafraichir(c);
  setInterval(() => rafraichir(c), 60000);
}

async function rafraichir(c) {
  const [noeuds, liens] = await Promise.all([fetch('/api/noeuds').then((r) => r.json()), opt.liens ? fetch('/api/liens?heures=24').then((r) => r.json()) : []]);
  const z = c.zone, dansZone = (n) => !z || (n.lat >= z[0] - 0.3 && n.lat <= z[2] + 0.3 && n.lon >= z[1] - 0.3 && n.lon <= z[3] + 0.3);
  const vis = noeuds.filter((n) => n.lat != null && dansZone(n) && n.statut !== 'inactif');
  const pos = new Map(vis.map((n) => [n.num, n]));
  couche.clearLayers();
  for (const l of liens) {
    const a = pos.get(l.a), b = pos.get(l.b);
    if (!a || !b || !(a.infrastructure || a.passerelle) || !(b.infrastructure || b.passerelle)) continue;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: couleurSnr(l.snr), weight: 2, opacity: 0.7, dashArray: l.source === 'rf' ? null : '5 5' }).addTo(couche);
  }
  let relais = 0, gw = 0;
  for (const n of vis) {
    const infra = n.infrastructure || n.passerelle;
    if (infra) { relais += n.infrastructure ? 1 : 0; gw += n.passerelle ? 1 : 0; }
    else if (!opt.clients) continue;
    const icon = infra ? L.divIcon({ className: '', html: `<div class="mk ${n.passerelle ? 'gw' : ''} ${n.statut}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }) : L.divIcon({ className: '', html: '<div class="cl"></div>', iconSize: [8, 8], iconAnchor: [4, 4] });
    L.marker([n.lat, n.lon], { icon }).bindTooltip(`<b>${esc(n.nomLong || n.id)}</b><br>${esc(n.roleFr || n.role || '')}${n.passerelle ? ' · passerelle MQTT' : ''}<br><small>vu ${n.dernierVu ? new Date(n.dernierVu).toLocaleString('fr-FR') : '–'}</small>`).addTo(couche);
  }
  document.getElementById('n-relais').textContent = relais;
  document.getElementById('n-gw').textContent = gw;
  document.getElementById('n-actifs').textContent = vis.filter((n) => n.statut === 'actif').length;
  premier = false;
}
demarrer().catch((e) => { document.getElementById('sous').textContent = 'Carte indisponible : ' + e.message; });
