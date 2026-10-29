'use strict';
// Modèles de programmation : un jeu de réglages par usage (relais point haut, comblement, toit, mobile…)
// appliqué en une fois à un ou plusieurs nœuds (opération « modifier »), plus l'export / import au format YAML
// de l'outil officiel en ligne de commande (`meshtastic --export-config` / `meshtastic --configure`).

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Réglages qu'un modèle peut contenir (mêmes noms que la configuration Meshtastic, en camelCase)
const SCHEMA = {
  device: ['role', 'rebroadcastMode', 'nodeInfoBroadcastSecs'],
  lora: ['hopLimit', 'configOkToMqtt', 'sx126xRxBoostedGain'],
  position: ['positionBroadcastSecs', 'positionBroadcastSmartEnabled'],
  voisinage: ['enabled', 'updateInterval', 'transmitOverLora'],
  telemetrie: ['deviceUpdateInterval', 'deviceTelemetryEnabled'],
};

const INTEGRES = [
  {
    id: 'point-haut', nom: 'Relais point haut', integre: true,
    description: 'ROUTER sur un site haut et dégagé, alimenté en continu : relaie en priorité, position fixe peu fréquente, voisinage publié sur LoRa.',
    device: { role: 'ROUTER', rebroadcastMode: 'ALL', nodeInfoBroadcastSecs: 10800 },
    lora: { hopLimit: 3, configOkToMqtt: true, sx126xRxBoostedGain: true },
    position: { positionBroadcastSecs: 43200, positionBroadcastSmartEnabled: false },
    voisinage: { enabled: true, updateInterval: 21600, transmitOverLora: true },
    telemetrie: { deviceUpdateInterval: 3600, deviceTelemetryEnabled: true },
    favoris: true,
  },
  {
    id: 'comblement', nom: 'Relais de comblement', integre: true,
    description: 'ROUTER_LATE pour un site indispensable qui ne voit pas les routeurs (fond de vallée, derrière une crête). Il réémet tout : à réserver aux sites qui en ont vraiment besoin.',
    device: { role: 'ROUTER_LATE', rebroadcastMode: 'ALL', nodeInfoBroadcastSecs: 10800 },
    lora: { hopLimit: 3, configOkToMqtt: true, sx126xRxBoostedGain: true },
    position: { positionBroadcastSecs: 43200, positionBroadcastSmartEnabled: false },
    voisinage: { enabled: true, updateInterval: 21600, transmitOverLora: true },
    telemetrie: { deviceUpdateInterval: 3600, deviceTelemetryEnabled: true },
    favoris: true,
  },
  {
    id: 'toit', nom: 'Base sur toit', integre: true,
    description: 'CLIENT_BASE pour un module de toit à la maison : relaie en priorité pour vos nœuds favoris, sinon se comporte en client. Mettre en favoris les routeurs voisins.',
    device: { role: 'CLIENT_BASE', rebroadcastMode: 'ALL', nodeInfoBroadcastSecs: 10800 },
    lora: { hopLimit: 3, configOkToMqtt: true, sx126xRxBoostedGain: true },
    position: { positionBroadcastSecs: 21600, positionBroadcastSmartEnabled: false },
    voisinage: { enabled: true, updateInterval: 21600, transmitOverLora: true },
    telemetrie: { deviceUpdateInterval: 3600, deviceTelemetryEnabled: true },
    favoris: true,
  },
  {
    id: 'mobile', nom: 'Mobile (portable, voiture)', integre: true,
    description: 'CLIENT qui se déplace : position intelligente (envoyée quand il bouge), pas de voisinage.',
    device: { role: 'CLIENT', rebroadcastMode: 'ALL', nodeInfoBroadcastSecs: 10800 },
    lora: { hopLimit: 3, configOkToMqtt: true },
    position: { positionBroadcastSecs: 900, positionBroadcastSmartEnabled: true },
    voisinage: { enabled: false },
    telemetrie: { deviceUpdateInterval: 1800, deviceTelemetryEnabled: true },
    favoris: false,
  },
  {
    id: 'client-fixe', nom: 'Client fixe', integre: true,
    description: 'CLIENT immobile (maison, bureau) : position et télémétrie toutes les heures, pas de voisinage.',
    device: { role: 'CLIENT', rebroadcastMode: 'ALL', nodeInfoBroadcastSecs: 10800 },
    lora: { hopLimit: 3, configOkToMqtt: true },
    position: { positionBroadcastSecs: 3600, positionBroadcastSmartEnabled: false },
    voisinage: { enabled: false },
    telemetrie: { deviceUpdateInterval: 3600, deviceTelemetryEnabled: true },
    favoris: false,
  },
];

const camel = (k) => String(k).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
function normaliser(o) {
  if (Array.isArray(o)) return o.map(normaliser);
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), normaliser(v)]));
}

// Garde seulement les réglages connus, avec le bon type
function nettoyer(m, { ROLES = [], REDIFFUSIONS = [] } = {}) {
  const r = {};
  const ent = (v, min, max, lib) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${lib} : valeur hors limites (${min} à ${max})`); return n; };
  const d = m.device || {};
  if (d.role != null || d.rebroadcastMode != null || d.nodeInfoBroadcastSecs != null) {
    r.device = {};
    if (d.role != null) { if (ROLES.length && !ROLES.includes(d.role)) throw new Error(`Rôle inconnu : ${d.role}`); r.device.role = d.role; }
    if (d.rebroadcastMode != null) { if (REDIFFUSIONS.length && !REDIFFUSIONS.includes(d.rebroadcastMode)) throw new Error(`Mode de rediffusion inconnu : ${d.rebroadcastMode}`); r.device.rebroadcastMode = d.rebroadcastMode; }
    if (d.nodeInfoBroadcastSecs != null) r.device.nodeInfoBroadcastSecs = ent(d.nodeInfoBroadcastSecs, 0, 86400 * 7, 'Infos nœud');
  }
  const l = m.lora || {};
  if (l.hopLimit != null || l.configOkToMqtt != null || l.sx126xRxBoostedGain != null) {
    r.lora = {};
    if (l.hopLimit != null) r.lora.hopLimit = ent(l.hopLimit, 1, 7, 'Sauts');
    if (l.configOkToMqtt != null) r.lora.configOkToMqtt = !!l.configOkToMqtt;
    if (l.sx126xRxBoostedGain != null) r.lora.sx126xRxBoostedGain = !!l.sx126xRxBoostedGain;
  }
  const p = m.position || {};
  if (p.positionBroadcastSecs != null || p.positionBroadcastSmartEnabled != null) {
    r.position = {};
    if (p.positionBroadcastSecs != null) r.position.positionBroadcastSecs = ent(p.positionBroadcastSecs, 0, 86400 * 7, 'Intervalle des positions');
    if (p.positionBroadcastSmartEnabled != null) r.position.positionBroadcastSmartEnabled = !!p.positionBroadcastSmartEnabled;
  }
  const v = m.voisinage || {};
  if (v.enabled != null) {
    r.voisinage = { enabled: !!v.enabled };
    if (v.enabled) {
      r.voisinage.updateInterval = Math.max(14400, ent(v.updateInterval ?? 21600, 0, 86400 * 7, 'Intervalle du voisinage'));
      r.voisinage.transmitOverLora = !!v.transmitOverLora;
    }
  }
  const t = m.telemetrie || {};
  if (t.deviceUpdateInterval != null || t.deviceTelemetryEnabled != null) {
    r.telemetrie = {};
    if (t.deviceUpdateInterval != null) { const n = ent(t.deviceUpdateInterval, 0, 86400 * 7, 'Intervalle de télémétrie'); r.telemetrie.deviceUpdateInterval = n && n < 900 ? 900 : n; }
    if (t.deviceTelemetryEnabled != null) r.telemetrie.deviceTelemetryEnabled = !!t.deviceTelemetryEnabled;
  }
  return r;
}

function creerModeles(dossier, { ROLES, REDIFFUSIONS }) {
  const fichier = path.join(dossier, 'modeles-programmation.json');
  let perso = [];
  try { perso = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* aucun */ }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(perso, null, 1)); } catch { /* lecture seule */ } };

  const liste = () => [...INTEGRES, ...perso];
  const obtenir = (id) => liste().find((m) => m.id === id) || null;

  function enregistrer(b, auteur) {
    const nom = String(b.nom || '').trim().slice(0, 60);
    if (!nom) throw new Error('Donnez un nom au modèle');
    const reglages = nettoyer(b, { ROLES, REDIFFUSIONS });
    if (!Object.keys(reglages).length) throw new Error('Le modèle ne contient aucun réglage');
    const id = b.id && perso.some((m) => m.id === b.id) ? b.id : 'perso-' + Date.now().toString(36);
    const m = { id, nom, description: String(b.description || '').slice(0, 300), integre: false, ...reglages, favoris: !!b.favoris, auteur, maj: Date.now() };
    perso = perso.filter((x) => x.id !== id).concat(m);
    sauver();
    return m;
  }
  function supprimer(id) {
    if (!perso.some((m) => m.id === id)) throw new Error('Modèle intégré ou inconnu : il ne peut pas être supprimé');
    perso = perso.filter((m) => m.id !== id);
    sauver();
  }
  // Paramètres de l'opération « modifier » pour un modèle
  function versParams(id) {
    const m = obtenir(id);
    if (!m) throw new Error('Modèle inconnu');
    const p = nettoyer(m, { ROLES, REDIFFUSIONS });
    return { ...p, modele: m.nom };
  }

  // ---- YAML (format de `meshtastic --export-config`) ------------------------------------------------
  // detail : résultat de lecture d'un nœud ; canalUrl : lien des canaux (facultatif) ; position : position fixe connue
  function exporterYaml(detail, { canalUrl = null, position = null, nom = '', source = '' } = {}) {
    const o = {};
    if (detail.proprietaire && detail.proprietaire.nomLong) o.owner = detail.proprietaire.nomLong;
    if (detail.proprietaire && detail.proprietaire.nomCourt) o.owner_short = detail.proprietaire.nomCourt;
    if (canalUrl) o.channel_url = canalUrl;
    if (position && detail.position && detail.position.fixedPosition) {
      o.location = { lat: +position.lat.toFixed(7), lon: +position.lon.toFixed(7) };
      if (position.alt != null) o.location.alt = Math.round(position.alt);
    }
    const config = {};
    for (const k of ['device', 'lora', 'position']) if (detail[k]) config[k] = detail[k];
    if (Object.keys(config).length) o.config = config;
    const mc = {};
    if (detail.voisinage) mc.neighborInfo = detail.voisinage;
    if (detail.telemetrie) mc.telemetry = detail.telemetrie;
    if (detail.trafic && Object.keys(detail.trafic).length) mc.trafficManagement = detail.trafic;
    if (Object.keys(mc).length) o.module_config = mc;
    const entete = `# start of Meshtastic configure yaml\n# ${nom ? nom + ' · ' : ''}exporté ${source} le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}\n# À appliquer en USB : meshtastic --configure ce-fichier.yaml${canalUrl ? '\n# ATTENTION : contient les clés des canaux (channel_url), ne le diffusez pas' : ''}\n`;
    return entete + yaml.dump(o, { lineWidth: 200, noRefs: true });
  }
  // YAML → réglages d'un modèle (owner, channel_url et location sont ignorés : propres à un nœud)
  function importerYaml(texte) {
    let o;
    try { o = yaml.load(String(texte || ''), { schema: yaml.JSON_SCHEMA }); } catch (e) { throw new Error('YAML illisible : ' + e.message.split('\n')[0]); }
    if (!o || typeof o !== 'object') throw new Error('YAML vide');
    o = normaliser(o);
    const c = o.config || {}, mc = o.moduleConfig || {};
    const m = {
      device: c.device || {}, lora: c.lora || {}, position: c.position || {},
      voisinage: mc.neighborInfo || {}, telemetrie: mc.telemetry || {},
    };
    // Valeurs absentes de l'export = valeurs par défaut du firmware : on ne les force pas
    const reglages = nettoyer({
      device: { role: m.device.role, rebroadcastMode: m.device.rebroadcastMode, nodeInfoBroadcastSecs: m.device.nodeInfoBroadcastSecs },
      lora: { hopLimit: m.lora.hopLimit, configOkToMqtt: m.lora.configOkToMqtt, sx126xRxBoostedGain: m.lora.sx126xRxBoostedGain },
      position: { positionBroadcastSecs: m.position.positionBroadcastSecs, positionBroadcastSmartEnabled: m.position.positionBroadcastSmartEnabled },
      voisinage: { enabled: m.voisinage.enabled, updateInterval: m.voisinage.updateInterval, transmitOverLora: m.voisinage.transmitOverLora },
      telemetrie: { deviceUpdateInterval: m.telemetrie.deviceUpdateInterval, deviceTelemetryEnabled: m.telemetrie.deviceTelemetryEnabled },
    }, { ROLES, REDIFFUSIONS });
    const ignores = ['owner', 'ownerShort', 'channelUrl', 'location'].filter((k) => o[k] != null);
    return { reglages, ignores, nom: o.owner ? `Importé de ${o.owner}` : 'Modèle importé' };
  }

  return { liste, obtenir, enregistrer, supprimer, versParams, exporterYaml, importerYaml, SCHEMA };
}

module.exports = { creerModeles, nettoyer };
