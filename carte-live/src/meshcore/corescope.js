'use strict';
// Observatoires MeshCore publics « CoreScope » (github.com/Kpa-clawbot/corescope) comme source de paquets.
//
// MeshCore n'a pas de serveur MQTT public mondial, mais plusieurs communautés font tourner CoreScope, qui reçoit les
// paquets de leurs observateurs (meshcoretomqtt) et les republie sur une API REST ouverte en lecture :
//   GET /api/packets   paquets bruts (raw_hex), observateur, SNR, RSSI, heure — identifiant d'ingestion croissant
//   GET /api/observers observateurs (nom, position, code de zone IATA, dernier contact)
//   GET /api/nodes     nœuds connus (clé, nom, rôle, position) : la carte se remplit sans attendre les annonces
// On interroge à notre rythme (pas de flux poussé) : le volume reste maîtrisé, plafonné par source et par minute.
// Chaque paquet brut passe par le même chemin qu'un paquet MQTT (reseauMc.integrer) : nœuds, liaisons, messages.

const INSTANCES_CONNUES = [
  { url: 'https://meshstats.serveurperso.in', nom: 'France (meshstats)' },
  { url: 'https://analyzer.meshtexas.org', nom: 'Texas (MeshTexas)' },
  { url: 'https://analyzer.on8ar.eu', nom: 'Belgique, Pays-Bas (ON8AR)' },
];
const ROLES = { repeater: 'repeteur', companion: 'companion', room: 'salon', sensor: 'capteur' };
const AGENT = 'carte-live (+https://github.com/sauveteur71/carte-live-meshtastic)';
const LIMITE_PAQUETS = 200;

// « https://hote[=AUS,HOU] » par ligne (ou séparés par ;) → [{ url, regions }]
function lireSources(texte) {
  const l = Array.isArray(texte) ? texte : String(texte || '').split(/[;\n]+/);
  const sortie = [];
  for (const brut of l) {
    const e = typeof brut === 'object' && brut ? brut : null;
    const s = e ? String(e.url || '') : String(brut).trim();
    if (!s) continue;
    const [u, r] = e ? [s, (e.regions || []).join(',')] : s.split('=');
    let url = String(u).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { const x = new URL(url); if (!x.hostname.includes('.')) continue; url = x.origin + x.pathname.replace(/\/+$/, ''); } catch { continue; }
    const regions = String(r || '').split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,8}$/.test(x));
    if (!sortie.some((x) => x.url === url)) sortie.push({ url, regions });
  }
  return sortie.slice(0, 5);
}
const ecrireSources = (l) => l.map((s) => s.url + (s.regions.length ? '=' + s.regions.join(',') : '')).join('\n');

function creerCoreScope({ sources = [], intervalleS = 20, maxParMinute = 60, integrer, noterObservateur, importerNoeuds, apres = () => {}, journal = () => {}, fetch: recuperer = globalThis.fetch } = {}) {
  const etats = sources.map((s) => ({
    url: s.url, hote: (() => { try { return new URL(s.url).host; } catch { return s.url; } })(), regions: s.regions || [],
    dernierId: null, recus: 0, integres: 0, ecartes: 0, horsZone: 0, manques: 0, erreurs: 0, echecsSuite: 0,
    derniereErreur: null, derniereReussite: null, dernierPaquet: null, observateurs: 0, noeuds: 0,
    fenetre: { debut: 0, nb: 0 }, minuteur: null, obsHeure: 0, noeudsHeure: 0,
  }));
  let arrete = true;

  async function lireJson(e, chemin) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await recuperer(e.url + chemin, { headers: { 'User-Agent': AGENT, Accept: 'application/json' }, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'pas de réponse en 20 s' : err.message);
    } finally { clearTimeout(t); }
  }
  const dansZone = (e, iata) => !e.regions.length || e.regions.includes(String(iata || '').toUpperCase());

  // Plafond par minute et par source : au-delà, les paquets sont écartés (comptés), jamais mis en attente
  function jeton(e) {
    const t = Date.now();
    if (t - e.fenetre.debut >= 60000) e.fenetre = { debut: t, nb: 0 };
    if (e.fenetre.nb >= maxParMinute) return false;
    e.fenetre.nb++;
    return true;
  }

  async function observateurs(e) {
    const r = await lireJson(e, '/api/observers');
    const l = (Array.isArray(r) ? r : r.observers || []).filter((o) => o && o.id && dansZone(e, o.iata));
    const t = Date.now();
    for (const o of l) {
      const vu = Date.parse(o.last_seen || o.last_packet_at || '') || 0;
      noterObservateur(String(o.id).toUpperCase(), {
        nom: o.name || null, role: ROLES[o.nodeRole] || null,
        lat: Number.isFinite(o.lat) ? o.lat : null, lon: Number.isFinite(o.lon) ? o.lon : null,
        etat: t - vu < 30 * 60000 ? 'online' : 'offline',
        details: { iata: o.iata || null, modele: o.model || null, firmware: o.firmware || null, logiciel: o.client_version || null, corescope: e.hote },
      });
    }
    e.observateurs = l.length;
  }

  // Nœuds connus de l'observatoire (positions, noms, rôles) ; filtrés sur les zones choisies quand l'observatoire les place
  async function noeuds(e) {
    const r = await lireJson(e, '/api/nodes?limit=5000');
    const liste = [];
    for (const n of r.nodes || []) {
      if (!n || !/^[0-9a-f]{64}$/i.test(n.public_key || '')) continue;
      if (e.regions.length) {
        const z = (n.region_placement && n.region_placement.regions) || [];
        if (!z.some((x) => e.regions.includes(String(x).toUpperCase()))) continue;
      }
      const vu = Date.parse(n.last_seen || n.last_heard || '') || null;
      liste.push({ cle: n.public_key.toUpperCase(), nom: n.name || null, role: ROLES[n.role] || null, lat: Number.isFinite(n.lat) ? n.lat : null, lon: Number.isFinite(n.lon) ? n.lon : null, vu });
    }
    importerNoeuds(liste); // une seule transaction pour des milliers de nœuds
    e.noeuds = liste.length;
  }

  async function paquets(e) {
    const seul = e.regions.length === 1 ? '&region=' + encodeURIComponent(e.regions[0]) : '';
    const r = await lireJson(e, `/api/packets?limit=${LIMITE_PAQUETS}&order=desc${seul}`);
    const l = (r.packets || []).filter((p) => p && Number.isFinite(p.id) && /^[0-9a-f]+$/i.test(p.raw_hex || ''));
    if (!l.length) return 0;
    const plusRecent = Math.max(...l.map((p) => p.id));
    let nouveaux;
    if (e.dernierId == null) nouveaux = l.sort((a, b) => b.id - a.id).slice(0, 30); // premier tour : un aperçu, pas tout l'historique
    else {
      nouveaux = l.filter((p) => p.id > e.dernierId);
      if (nouveaux.length === l.length && l.length >= LIMITE_PAQUETS) e.manques++; // l'intervalle est trop long pour ce débit
    }
    e.dernierId = Math.max(e.dernierId || 0, plusRecent);
    let nb = 0;
    for (const p of nouveaux.sort((a, b) => a.id - b.id)) {
      e.recus++;
      if (!dansZone(e, p.observer_iata)) { e.horsZone++; continue; }
      if (!jeton(e)) { e.ecartes++; continue; }
      const h = Date.parse(p.timestamp || p.first_seen || '');
      const tx = p.direction === 'tx';
      try {
        const sortie = integrer({
          brut: Buffer.from(p.raw_hex, 'hex'), observateur: p.observer_id ? String(p.observer_id).toUpperCase() : null,
          snr: tx || !Number.isFinite(p.snr) ? null : p.snr, rssi: tx || !Number.isFinite(p.rssi) ? null : p.rssi,
          heure: Number.isFinite(h) && Math.abs(h - Date.now()) < 6 * 3600000 ? h : Date.now(), via: 'corescope',
        });
        if (sortie) { e.integres++; nb++; e.dernierPaquet = Date.now(); }
      } catch (err) { journal(`CoreScope ${e.hote} : paquet non traité (${err.message})`); }
    }
    return nb;
  }

  async function tour(e) {
    if (arrete) return;
    let attente = intervalleS * 1000;
    try {
      const t = Date.now();
      if (t - e.obsHeure > 10 * 60000) { e.obsHeure = t; await observateurs(e); }
      if (t - e.noeudsHeure > 30 * 60000) { e.noeudsHeure = t; await noeuds(e); }
      const nb = await paquets(e);
      if (e.echecsSuite) journal(`CoreScope ${e.hote} : de nouveau joignable`);
      e.echecsSuite = 0; e.derniereReussite = Date.now();
      if (nb) apres(nb);
    } catch (err) {
      e.erreurs++; e.echecsSuite++;
      e.derniereErreur = { message: err.message, heure: Date.now() };
      if (e.echecsSuite === 1 || e.echecsSuite % 20 === 0) journal(`CoreScope ${e.hote} : ${err.message}`);
      attente = Math.min(5 * 60000, attente * 2 ** Math.min(e.echecsSuite, 4)); // panne : on espace les essais
    }
    if (!arrete) e.minuteur = setTimeout(() => tour(e), attente);
  }

  function demarrer() {
    if (!arrete || !etats.length) return;
    arrete = false;
    etats.forEach((e, i) => { e.minuteur = setTimeout(() => tour(e), 2000 + i * 3000); });
    journal(`CoreScope : ${etats.map((e) => e.hote + (e.regions.length ? ` (${e.regions.join(', ')})` : '')).join(' · ')}, toutes les ${intervalleS} s, ${maxParMinute} paquets/min au plus par source`);
  }
  function arreter() { arrete = true; for (const e of etats) clearTimeout(e.minuteur); }
  function etat() {
    return {
      intervalleS, maxParMinute,
      sources: etats.map((e) => ({
        url: e.url, hote: e.hote, regions: e.regions, recus: e.recus, integres: e.integres, ecartes: e.ecartes, horsZone: e.horsZone, manques: e.manques,
        erreurs: e.erreurs, enPanne: e.echecsSuite > 0, derniereErreur: e.derniereErreur, derniereReussite: e.derniereReussite, dernierPaquet: e.dernierPaquet,
        observateurs: e.observateurs, noeuds: e.noeuds,
      })),
    };
  }
  return { demarrer, arreter, etat, _tour: tour, _etats: etats };
}

// Essai d'une adresse avant de l'enregistrer : l'API répond-elle, combien de nœuds, quel débit (paquets/min) ?
async function testerCoreScope(url, regions = [], recuperer = globalThis.fetch) {
  const [s] = lireSources([{ url, regions }]);
  if (!s) throw new Error('Adresse invalide (ex. https://analyzer.on8ar.eu)');
  const lire = async (chemin) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await recuperer(s.url + chemin, { headers: { 'User-Agent': AGENT, Accept: 'application/json' }, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) { throw new Error(err.name === 'AbortError' ? 'pas de réponse en 15 s' : err.message); } finally { clearTimeout(t); }
  };
  let statut;
  try { statut = await lire('/api/nodes/network-status'); } catch (e) { throw new Error(`${s.url} ne répond pas comme un CoreScope (${e.message})`); }
  const r = await lire('/api/packets?limit=300&order=desc' + (s.regions.length === 1 ? '&region=' + encodeURIComponent(s.regions[0]) : ''));
  const l = (r.packets || []).filter((p) => !s.regions.length || s.regions.includes(String(p.observer_iata || '').toUpperCase()));
  const heures = l.map((p) => Date.parse(p.timestamp || '')).filter(Number.isFinite).sort((a, b) => a - b);
  const minutes = heures.length > 1 ? (heures[heures.length - 1] - heures[0]) / 60000 : 0;
  const zones = {};
  for (const p of r.packets || []) if (p.observer_iata) zones[p.observer_iata] = (zones[p.observer_iata] || 0) + 1;
  return {
    url: s.url, regions: s.regions, noeuds: statut.total ?? null, actifs: statut.active ?? null,
    paquetsMinute: minutes > 0 ? Math.round((l.length / minutes) * 10) / 10 : null,
    zones: Object.entries(zones).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([code, nb]) => ({ code, nb })),
  };
}

module.exports = { creerCoreScope, testerCoreScope, lireSources, ecrireSources, INSTANCES_CONNUES };
