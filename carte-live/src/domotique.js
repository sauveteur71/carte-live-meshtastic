'use strict';
// Domotique : publication vers Home Assistant et Node-RED par MQTT (DOMOTIQUE_MQTT_URL).
// - <racine>/etat : résumé du réseau (nœuds actifs, passerelles, débit, canal, alertes…), conservé par le broker
// - <racine>/alertes : alertes actives ; <racine>/alerte : chaque nouvelle alerte, au moment où elle apparaît
// - <racine>/noeud/<id> : état de chaque nœud surveillé (relais, passerelles, nœuds suivis)
// - <racine>/envoyer : message reçu de la domotique, envoyé en LoRa par le module (si DOMOTIQUE_ENVOI_LORA=oui)
// Avec la découverte automatique (DOMOTIQUE_DECOUVERTE, activée par défaut), Home Assistant crée tout seul les
// capteurs, les relais (connectivité, batterie, position sur la carte) et la zone de saisie « Message LoRa ».

const INTERVALLE = 60000;
const ENVOI_MIN_MS = 20000; // au plus un message LoRa toutes les 20 s depuis la domotique

function lireReglages(env = process.env) {
  const oui = (v, def) => (v == null || v === '' ? def : String(v).toLowerCase() === 'oui');
  return {
    url: String(env.DOMOTIQUE_MQTT_URL || '').trim(),
    utilisateur: String(env.DOMOTIQUE_MQTT_UTILISATEUR || '').trim(),
    motDePasse: String(env.DOMOTIQUE_MQTT_MOT_DE_PASSE || ''),
    racine: String(env.DOMOTIQUE_RACINE || 'carte-live').trim().replace(/^\/+|\/+$/g, '') || 'carte-live',
    decouverte: oui(env.DOMOTIQUE_DECOUVERTE, true),
    prefixeDecouverte: String(env.DOMOTIQUE_PREFIXE_DECOUVERTE || 'homeassistant').trim() || 'homeassistant',
    envoi: oui(env.DOMOTIQUE_ENVOI_LORA, false),
    canal: Math.min(Math.max(Number(env.DOMOTIQUE_CANAL_ENVOI) || 0, 0), 7),
  };
}

const idSur = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');

function creerDomotique({ mqtt, resume, alertes, noeuds, envoyer, journal = () => {}, version = '', nomCarte = 'Carte live', reglages = lireReglages() }) {
  const r = reglages;
  const etat = { actif: !!r.url, connecte: false, erreur: null, depuis: null, publies: 0, noeuds: 0, envoi: r.envoi, racine: r.racine, decouverte: r.decouverte, recus: 0, dernierEnvoi: null };
  if (!r.url) return { etat: () => etat, arreter() {} };

  const R = r.racine, uid = idSur(R);
  const dispo = `${R}/disponibilite`;
  let client = null, minuterie = null, dernierEnvoi = 0;
  const alertesVues = new Set();
  const decouvertes = new Set();
  const derniers = new Map(); // sujet -> charge déjà publiée (pour ne republier que ce qui change)

  function publier(sujet, charge, { garder = true, toujours = false } = {}) {
    if (!client || !etat.connecte) return;
    const texte = typeof charge === 'string' ? charge : JSON.stringify(charge);
    if (!toujours && garder && derniers.get(sujet) === texte) return;
    derniers.set(sujet, texte);
    client.publish(sujet, texte, { retain: garder, qos: 0 });
    etat.publies++;
  }

  const appareil = { identifiers: [`${uid}_carte`], name: nomCarte, manufacturer: 'carte-live-meshtastic', model: 'Carte live', sw_version: version };
  function decouvrir(type, objet, config) {
    if (!r.decouverte) return;
    const sujet = `${r.prefixeDecouverte}/${type}/${uid}/${objet}/config`;
    if (decouvertes.has(sujet)) return;
    decouvertes.add(sujet);
    publier(sujet, { availability_topic: dispo, ...config }, { toujours: true });
  }

  function decouverteCarte() {
    const capteur = (objet, nom, champ, extra = {}) => decouvrir('sensor', objet, {
      name: nom, unique_id: `${uid}_${objet}`, object_id: `${uid}_${objet}`, state_topic: `${R}/etat`, value_template: `{{ value_json.${champ} }}`, device: appareil, ...extra,
    });
    capteur('noeuds_actifs', 'Nœuds actifs', 'noeudsActifs', { state_class: 'measurement', icon: 'mdi:access-point-network' });
    capteur('passerelles', 'Passerelles en ligne', 'passerellesEnLigne', { state_class: 'measurement', icon: 'mdi:router-wireless' });
    capteur('paquets_minute', 'Paquets par minute', 'paquetsMinute', { state_class: 'measurement', unit_of_measurement: 'paquets/min', icon: 'mdi:swap-vertical' });
    capteur('canal_moyen', 'Occupation du canal', 'canalMoyen', { state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:chart-bell-curve' });
    capteur('couverture', 'Couverture calculée', 'couverturePct', { state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:map-marker-radius' });
    capteur('alertes', 'Alertes actives', 'alertes', { state_class: 'measurement', icon: 'mdi:alert', json_attributes_topic: `${R}/alertes` });
    capteur('meshcore_actifs', 'Nœuds MeshCore actifs', 'meshcoreActifs', { state_class: 'measurement', icon: 'mdi:access-point' });
    decouvrir('binary_sensor', 'alerte_critique', {
      name: 'Alerte critique', unique_id: `${uid}_alerte_critique`, object_id: `${uid}_alerte_critique`, device_class: 'problem',
      state_topic: `${R}/etat`, value_template: "{{ 'ON' if (value_json.alertesCritiques | int(0)) > 0 else 'OFF' }}", device: appareil,
    });
    if (r.envoi) {
      decouvrir('text', 'message_lora', {
        name: 'Message LoRa', unique_id: `${uid}_message_lora`, object_id: `${uid}_message_lora`, icon: 'mdi:message-text',
        command_topic: `${R}/envoyer`, max: 200, mode: 'text', device: appareil,
      });
    }
  }

  function decouverteNoeud(n) {
    const o = `noeud_${idSur(n.id)}`;
    const dev = { identifiers: [`${uid}_${o}`], name: n.nom, model: n.role || n.reseau, manufacturer: n.reseau === 'meshcore' ? 'MeshCore' : 'Meshtastic', via_device: `${uid}_carte` };
    const st = `${R}/noeud/${idSur(n.id)}`;
    decouvrir('binary_sensor', `${o}_en_ligne`, { name: 'En ligne', unique_id: `${uid}_${o}_en_ligne`, device_class: 'connectivity', state_topic: st, value_template: "{{ 'ON' if value_json.enLigne else 'OFF' }}", json_attributes_topic: st, device: dev });
    decouvrir('sensor', `${o}_vu`, { name: 'Dernier paquet', unique_id: `${uid}_${o}_vu`, device_class: 'timestamp', state_topic: st, value_template: '{{ value_json.vu }}', device: dev });
    if (n.batterie != null) decouvrir('sensor', `${o}_batterie`, { name: 'Batterie', unique_id: `${uid}_${o}_batterie`, device_class: 'battery', unit_of_measurement: '%', state_class: 'measurement', state_topic: st, value_template: '{{ value_json.batterie }}', device: dev });
    if (n.tension != null) decouvrir('sensor', `${o}_tension`, { name: 'Tension', unique_id: `${uid}_${o}_tension`, device_class: 'voltage', unit_of_measurement: 'V', state_class: 'measurement', state_topic: st, value_template: '{{ value_json.tension }}', device: dev });
    if (n.lat != null) decouvrir('device_tracker', o, { name: 'Position', unique_id: `${uid}_${o}_position`, json_attributes_topic: st, json_attributes_template: '{{ {"latitude": value_json.lat, "longitude": value_json.lon, "gps_accuracy": 50} | tojson }}', source_type: 'gps', device: dev });
  }

  function cycle() {
    try {
      const s = resume();
      publier(`${R}/etat`, s);
      const l = alertes();
      publier(`${R}/alertes`, { nombre: l.length, critiques: l.filter((a) => a.niveau === 'critique').length, liste: l.slice(0, 50).map((a) => ({ type: a.type, niveau: a.niveau, nom: a.nom, message: a.message, depuis: a.depuis ? new Date(a.depuis).toISOString() : null })) });
      // Nouvelles alertes : un message par alerte, non conservé (déclencheur d'automatisation / flux Node-RED)
      const cles = new Set();
      for (const a of l) {
        const c = a.cle || `${a.type}:${a.num || a.noeud || a.nom}`;
        cles.add(c);
        if (!alertesVues.has(c) && etat.depuis && Date.now() - etat.depuis > 90000) publier(`${R}/alerte`, { type: a.type, niveau: a.niveau, nom: a.nom, message: a.message, heure: new Date().toISOString() }, { garder: false });
      }
      alertesVues.clear(); for (const c of cles) alertesVues.add(c);
      decouverteCarte();
      const ns = noeuds();
      etat.noeuds = ns.length;
      for (const n of ns) {
        decouverteNoeud(n);
        publier(`${R}/noeud/${idSur(n.id)}`, { id: n.id, nom: n.nom, reseau: n.reseau, role: n.role || null, enLigne: !!n.enLigne, vu: n.vu ? new Date(n.vu).toISOString() : null, batterie: n.batterie ?? null, tension: n.tension ?? null, lat: n.lat ?? null, lon: n.lon ?? null });
      }
    } catch (e) { journal('[Domotique]', e.message); }
  }

  function recevoir(sujet, message) {
    if (sujet !== `${R}/envoyer`) return;
    etat.recus++;
    const repondre = (x) => publier(`${R}/envoyer/resultat`, { ...x, heure: new Date().toISOString() }, { garder: false });
    if (!r.envoi) return repondre({ ok: false, erreur: 'Envoi LoRa depuis la domotique désactivé (DOMOTIQUE_ENVOI_LORA)' });
    if (Date.now() - dernierEnvoi < ENVOI_MIN_MS) return repondre({ ok: false, erreur: 'Trop rapproché : un message toutes les 20 s au plus' });
    let b;
    const brut = message.toString('utf8').trim();
    try { b = brut.startsWith('{') ? JSON.parse(brut) : { texte: brut }; } catch { return repondre({ ok: false, erreur: 'JSON invalide' }); }
    try {
      const res = envoyer({ texte: b.texte, canal: b.canal != null ? Number(b.canal) : r.canal, dest: b.vers != null ? b.vers : undefined });
      dernierEnvoi = Date.now();
      etat.dernierEnvoi = dernierEnvoi;
      repondre({ ok: true, id: res && res.id });
    } catch (e) { repondre({ ok: false, erreur: e.message }); }
  }

  client = mqtt.connect(r.url, {
    username: r.utilisateur || undefined, password: r.motDePasse || undefined,
    clientId: `${uid}-domotique-${Math.random().toString(16).slice(2, 8)}`, reconnectPeriod: 10000,
    will: { topic: dispo, payload: 'offline', retain: true, qos: 0 },
  });
  client.on('connect', () => {
    etat.connecte = true; etat.erreur = null; etat.depuis = etat.depuis || Date.now();
    derniers.clear(); decouvertes.clear();
    client.publish(dispo, 'online', { retain: true });
    client.subscribe(`${R}/envoyer`);
    journal('[Domotique]', `connectée à ${r.url.replace(/\/\/[^@/]*@/, '//')} (sujets ${R}/…)`);
    cycle();
  });
  client.on('message', recevoir);
  client.on('close', () => { etat.connecte = false; });
  client.on('error', (e) => { etat.erreur = e.message; });
  minuterie = setInterval(cycle, INTERVALLE);
  if (minuterie.unref) minuterie.unref();

  return {
    etat: () => etat,
    cycle,
    arreter() { clearInterval(minuterie); if (client) { try { client.publish(dispo, 'offline', { retain: true }); } catch { /* ignoré */ } client.end(); } },
  };
}

module.exports = { creerDomotique, lireReglages };
