'use strict';
// Service worker du mode terrain : l'application s'ouvre sans réseau (dernière version connue)
// et les fonds de carte déjà vus (ou préparés) restent affichés hors connexion.
const APPLI = 'appli-v1';
const TUILES = 'tuiles-v1';
const MAX_TUILES = 4000;
const COQUILLE = ['/', '/index.html', '/style.css', '/app.js', '/meshcore.js', '/animations.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js', '/manifest.webmanifest', '/icone-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APPLI).then((c) => c.addAll(COQUILLE)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((l) => Promise.all(l.filter((k) => ![APPLI, TUILES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const estTuile = (u) => /tile|wmts|\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)/i.test(u.href) && u.origin !== self.location.origin;
let compteur = 0;
async function elaguer() {
  const c = await caches.open(TUILES);
  const k = await c.keys();
  for (let i = 0; i < k.length - MAX_TUILES; i++) await c.delete(k[i]);
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  // Fonds de carte : cache d'abord (hors connexion), réseau sinon
  if (estTuile(u)) {
    e.respondWith(caches.open(TUILES).then(async (c) => {
      const m = await c.match(r, { ignoreVary: true });
      if (m) return m;
      try {
        const rep = await fetch(r);
        if (rep.ok || rep.type === 'opaque') { c.put(r, rep.clone()); if (++compteur % 200 === 0) elaguer(); }
        return rep;
      } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (u.origin !== self.location.origin) return;
  // API : toujours le réseau (données en direct) ; quelques listes gardées pour l'affichage hors connexion
  if (u.pathname.startsWith('/api/')) {
    if (!['/api/config', '/api/noeuds', '/api/liens', '/api/releves'].includes(u.pathname)) return;
    e.respondWith(fetch(r).then((rep) => { if (rep.ok) { const cl = rep.clone(); caches.open(APPLI).then((c) => c.put(r, cl)); } return rep; }).catch(() => caches.match(r).then((m) => m || new Response(JSON.stringify({ erreur: 'Hors connexion' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  if (u.pathname.startsWith('/ws')) return;
  // Application : réseau d'abord (toujours la dernière version), cache si pas de réseau
  e.respondWith(fetch(r).then((rep) => { if (rep.ok && rep.type === 'basic') { const cl = rep.clone(); caches.open(APPLI).then((c) => c.put(r, cl)); } return rep; })
    .catch(() => caches.match(r, { ignoreSearch: u.pathname === '/' }).then((m) => m || caches.match('/'))));
});

// Préparation hors connexion : la page envoie la liste des tuiles de la zone à garder
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'prechargerTuiles' || !Array.isArray(d.urls)) return;
  const port = e.ports && e.ports[0];
  (async () => {
    const c = await caches.open(TUILES);
    let fait = 0, erreurs = 0;
    const file = d.urls.slice(0, 3000);
    const travail = async () => {
      while (file.length) {
        const url = file.shift();
        try {
          if (!(await c.match(url, { ignoreVary: true }))) { const rep = await fetch(url, { mode: 'no-cors' }); await c.put(url, rep); }
        } catch { erreurs++; }
        fait++;
        if (port && fait % 25 === 0) port.postMessage({ fait, total: d.urls.length, erreurs });
      }
    };
    await Promise.all([travail(), travail(), travail(), travail()]);
    await elaguer();
    if (port) port.postMessage({ fait, total: d.urls.length, erreurs, fini: true });
  })();
});
