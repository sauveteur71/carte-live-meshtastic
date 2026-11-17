'use strict';
// Couche « Capteurs LoRaWAN » : mesures des capteurs LoRaWAN d'une application The Things Network (v3) ou ChirpStack
// (v4), reçues par leur MQTT. Lecture seule : la carte s'abonne aux remontées, n'envoie rien aux capteurs.
// Désactivée par défaut (LORAWAN=oui pour l'activer). Alertes sur seuils choisis (« niveau > 150 »…).

const LIMITE_POINTS = 600; // points gardés par mesure (24 h au moins pour un capteur toutes les 3 min)
const DUREE = 24 * 3600000;

// « capteur-1=45,04;3,88 | capteur-2=45.1,3.9 » : position fixe des capteurs qui n'envoient pas la leur
function lirePositions(texte) {
  const p = new Map();
  for (const m of String(texte || '').matchAll(/([\w.:-]+)\s*=\s*(-?\d+(?:[.,]\d+)?)\s*[;,/ ]\s*(-?\d+(?:[.,]\d+)?)/g)) {
    const lat = Number(m[2].replace(',', '.')), lon = Number(m[3].replace(',', '.'));
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) p.set(m[1].toLowerCase(), { lat, lon });
  }
  return p;
}
// « niveau-borne.hauteur > 1,5 ; station-meteo.temperature < -5 » (le nom du capteur est facultatif : « batterie < 3,3 »)
function lireSeuils(texte) {
  const l = [];
  for (const m of String(texte || '').matchAll(/(?:([\w:-]+)\.)?([\w-]+)\s*([<>])\s*(-?\d+(?:[.,]\d+)?)/g)) {
    l.push({ capteur: m[1] ? m[1].toLowerCase() : null, champ: m[2], sens: m[3], valeur: Number(m[4].replace(',', '.')) });
  }
  return l;
}

function lireReglages(env = process.env) {
  return {
    actif: String(env.LORAWAN || '').toLowerCase() === 'oui',
    url: String(env.LORAWAN_SERVEUR || 'mqtts://eu1.cloud.thethings.network:8883').trim(),
    utilisateur: String(env.LORAWAN_UTILISATEUR || '').trim(),
    motDePasse: String(env.LORAWAN_MOT_DE_PASSE || ''),
    sujets: String(env.LORAWAN_SUJETS || 'v3/+/devices/+/up, application/+/device/+/event/up').split(/[,;\s]+/).filter(Boolean),
    public: String(env.LORAWAN_PUBLIC || '').toLowerCase() === 'oui',
    positions: lirePositions(env.LORAWAN_POSITIONS),
    seuils: lireSeuils(env.LORAWAN_SEUILS),
  };
}

// Mesures numériques d'un objet décodé, aplaties (« bme.temperature »), sans les champs de position
function mesuresDe(objet, prefixe = '', sortie = {}, prof = 0) {
  if (!objet || typeof objet !== 'object' || prof > 3) return sortie;
  for (const [k, v] of Object.entries(objet)) {
    const nom = prefixe ? `${prefixe}.${k}` : k;
    if (/^(lat|latitude|lon|lng|longitude|alt|altitude|gps)$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) sortie[nom] = v;
    else if (typeof v === 'boolean') sortie[nom] = v ? 1 : 0;
    else if (v && typeof v === 'object' && !Array.isArray(v)) mesuresDe(v, nom, sortie, prof + 1);
  }
  return sortie;
}
function positionDe(objet) {
  if (!objet || typeof objet !== 'object') return null;
  const o = objet.gps && typeof objet.gps === 'object' ? objet.gps : objet;
  const lat = Number(o.latitude ?? o.lat), lon = Number(o.longitude ?? o.lon ?? o.lng);
  return Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// Remontée TTN v3 ou ChirpStack v4 → forme commune
function lireRemontee(sujet, texte) {
  let j;
  try { j = JSON.parse(texte); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  if (j.uplink_message) { // The Things Network v3
    const u = j.uplink_message, ids = j.end_device_ids || {};
    const locs = u.locations || {};
    const pos = positionDe(u.decoded_payload) || positionDe(locs.user) || positionDe(Object.values(locs)[0]);
    return {
      source: 'ttn', id: String(ids.device_id || ids.dev_eui || '').slice(0, 64), devEui: ids.dev_eui || null,
      application: (ids.application_ids || {}).application_id || null, heure: Date.parse(j.received_at || u.received_at) || Date.now(),
      port: u.f_port ?? null, mesures: mesuresDe(u.decoded_payload), position: pos,
      passerelles: (u.rx_metadata || []).map((g) => ({
        id: String((g.gateway_ids || {}).gateway_id || (g.gateway_ids || {}).eui || '?').slice(0, 64), rssi: g.rssi ?? g.channel_rssi ?? null, snr: g.snr ?? null,
        ...(positionDe(g.location) || {}),
      })),
    };
  }
  if (j.deviceInfo || /\/event\/up$/.test(sujet)) { // ChirpStack v4
    const d = j.deviceInfo || {};
    return {
      source: 'chirpstack', id: String(d.deviceName || d.devEui || '').slice(0, 64), devEui: d.devEui || null, application: d.applicationName || null,
      heure: Date.parse(j.time) || Date.now(), port: j.fPort ?? null, mesures: mesuresDe(j.object), position: positionDe(j.object),
      passerelles: (j.rxInfo || []).map((g) => ({ id: String(g.gatewayId || '?').slice(0, 64), rssi: g.rssi ?? null, snr: g.snr ?? null, ...(positionDe(g.location) || {}) })),
    };
  }
  return null;
}

function creerLorawan({ journal = () => {}, reglages = lireReglages(), connecter = (url, o) => require('mqtt').connect(url, o) }) {
  const r = reglages;
  const capteurs = new Map(); // id → { …dernière remontée, nb, series: { champ: [[t, v]] } }
  const passerelles = new Map(); // id → { id, lat, lon, heure, nb }
  const etat = { actif: r.actif, connecte: false, erreur: null, depuis: null, remontees: 0, serveur: r.url.replace(/\/\/[^@/]*@/, '//') };
  let client = null;

  function integrer(sujet, texte) {
    const t = lireRemontee(sujet, String(texte));
    if (!t || !t.id) return null;
    etat.remontees++;
    const avant = capteurs.get(t.id) || { series: {}, nb: 0 };
    const pos = t.position || r.positions.get(t.id.toLowerCase()) || (t.devEui && r.positions.get(String(t.devEui).toLowerCase())) || avant.position || null;
    const series = avant.series;
    const lim = Date.now() - DUREE;
    for (const [k, v] of Object.entries(t.mesures)) {
      const l = series[k] || (series[k] = []);
      l.push([t.heure, v]);
      while (l.length > LIMITE_POINTS || (l.length && l[0][0] < lim)) l.shift();
    }
    capteurs.set(t.id, { ...t, position: pos, nb: avant.nb + 1, series });
    for (const g of t.passerelles) {
      const p = passerelles.get(g.id) || { id: g.id, nb: 0 };
      passerelles.set(g.id, { ...p, lat: g.lat ?? p.lat, lon: g.lon ?? p.lon, heure: t.heure, nb: p.nb + 1 });
    }
    return t;
  }

  function demarrer() {
    if (!r.actif) return;
    if (!r.utilisateur || !r.motDePasse) { etat.erreur = 'identifiant et clé d’API de l’application requis (Réglages avancés › LoRaWAN)'; journal('[LoRaWAN]', etat.erreur); return; }
    client = connecter(r.url, { username: r.utilisateur, password: r.motDePasse, clientId: 'carte-live-lorawan-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 30000, connectTimeout: 20000 });
    client.on('connect', () => {
      etat.connecte = true; etat.erreur = null; etat.depuis = etat.depuis || Date.now();
      client.subscribe(r.sujets);
      journal('[LoRaWAN]', `connecté à ${etat.serveur} (${r.sujets.join(', ')})`);
    });
    client.on('message', (sujet, msg) => { try { integrer(sujet, msg); } catch { /* remontée illisible */ } });
    client.on('close', () => { etat.connecte = false; });
    client.on('error', (e) => { etat.erreur = e.message; });
  }

  const vue = (c) => ({
    id: c.id, devEui: c.devEui, application: c.application, source: c.source, heure: c.heure, nb: c.nb, port: c.port,
    mesures: c.mesures, lat: c.position ? c.position.lat : null, lon: c.position ? c.position.lon : null,
    passerelles: c.passerelles.map((g) => ({ id: g.id, rssi: g.rssi, snr: g.snr })),
  });

  function alertes() {
    if (!r.actif) return [];
    const l = [];
    for (const c of capteurs.values()) {
      if (Date.now() - c.heure > 6 * 3600000) continue;
      for (const s of r.seuils) {
        if (s.capteur && s.capteur !== c.id.toLowerCase()) continue;
        const v = c.mesures[s.champ];
        if (typeof v !== 'number') continue;
        if (!(s.sens === '>' ? v > s.valeur : v < s.valeur)) continue;
        l.push({
          cle: `lorawan:${c.id}:${s.champ}`, type: 'lorawan', niveau: 'attention', depuis: c.heure,
          lat: c.position ? c.position.lat : null, lon: c.position ? c.position.lon : null,
          message: `📟 ${c.id} : ${s.champ} = ${String(v).replace('.', ',')} (seuil ${s.sens} ${String(s.valeur).replace('.', ',')})`,
        });
      }
    }
    return l;
  }

  demarrer();
  return {
    etat: () => ({ ...etat, capteurs: capteurs.size, passerelles: passerelles.size, public: r.public }),
    liste: () => [...capteurs.values()].map(vue).sort((a, b) => b.heure - a.heure),
    passerelles: () => [...passerelles.values()].filter((g) => g.lat != null && g.lon != null),
    serie: (id) => { const c = capteurs.get(id); return c ? { capteur: vue(c), series: c.series } : null; },
    alertes,
    integrer,
    arreter() { if (client) client.end(true); },
  };
}

module.exports = { creerLorawan, lireReglages, lireRemontee, lirePositions, lireSeuils };
