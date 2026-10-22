'use strict';
// Lecture de la configuration (variables d'environnement, voir fichier .env)

function nombre(nom, defaut) {
  const v = process.env[nom];
  if (v === undefined || v === '') return defaut;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaut;
}

function texte(nom, defaut = '') {
  const v = process.env[nom];
  return v === undefined || v === '' ? defaut : v;
}

// CANAUX="Fr_Balise=AQ==;D_HauteLoir=AQ==;..."  (nom=clé base64, séparés par ; ou retour ligne)
function lireCanaux(valeur) {
  return valeur
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entree) => {
      const i = entree.indexOf('=');
      if (i < 0) return { nom: entree, cle: 'AQ==' };
      return { nom: entree.slice(0, i).trim(), cle: entree.slice(i + 1).trim() };
    });
}

const config = {
  port: nombre('PORT', 8095),
  mqtt: {
    url: texte('MQTT_URL', 'mqtt://localhost:1883'),
    utilisateur: texte('MQTT_UTILISATEUR'),
    motDePasse: texte('MQTT_MOT_DE_PASSE'),
    racine: texte('MQTT_RACINE', 'msh/EU_868').replace(/\/+$/, ''),
    // Sujets supplémentaires, séparés par des virgules (ex. flux déjà déchiffré d'un autre serveur)
    sujetsSupplementaires: texte('MQTT_SUJETS_SUPPLEMENTAIRES').split(',').map((s) => s.trim()).filter(Boolean),
  },
  canaux: lireCanaux(texte('CANAUX', 'LongFast=AQ==')),
  // Canaux dont les messages texte sont conservés (admin uniquement). Vide = tous les canaux déchiffrés.
  canauxTexte: texte('CANAUX_TEXTE').split(/[,;]/).map((s) => s.trim()).filter(Boolean),
  retentionJours: nombre('RETENTION_JOURS', 7),
  admin: {
    motDePasse: texte('ADMIN_MOT_DE_PASSE'),
    secret: texte('SECRET_SESSION', ''),
  },
  // Précision publique des positions (nombre de décimales, 3 ≈ 100 m). -1 = pas d'arrondi.
  precisionPublique: nombre('PRECISION_PUBLIQUE_DECIMALES', 3),
  noeudsSurveilles: texte('NOEUDS_SURVEILLES').split(/[,;]/).map((s) => s.trim()).filter(Boolean),
  seuils: {
    muetMinutes: nombre('SEUIL_MUET_MINUTES', 120),
    actifMinutes: nombre('SEUIL_ACTIF_MINUTES', 60),
    inactifHeures: nombre('SEUIL_INACTIF_HEURES', 6),
    tensionVolts: nombre('SEUIL_TENSION_VOLTS', 3.5),
    batteriePourcent: nombre('SEUIL_BATTERIE_POURCENT', 20),
    chargeSolaireVolts: nombre('SEUIL_CHARGE_SOLAIRE_VOLTS', 3.95),
    canalPourcent: nombre('SEUIL_CANAL_POURCENT', 25),
    canalCritiquePourcent: nombre('SEUIL_CANAL_CRITIQUE_POURCENT', 40),
    emissionPourcent: nombre('SEUIL_EMISSION_POURCENT', 8),
  },
  carte: {
    titre: texte('CARTE_TITRE', 'Carte live · Réseau Meshtastic'),
    centreLat: nombre('CARTE_CENTRE_LAT', 45.08),
    centreLon: nombre('CARTE_CENTRE_LON', 3.88),
    zoom: nombre('CARTE_ZOOM', 10),
    tuiles: {
      // Fond sombre Esri (gratuit, sans clé). Les serveurs OpenStreetMap bloquent ce type d'usage (erreur 403).
      url: texte('CARTE_TUILES_URL', 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'),
      etiquettes: texte('CARTE_TUILES_ETIQUETTES_URL', 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'),
      zoomMaxNatif: nombre('CARTE_TUILES_ZOOM_MAX', 16),
      attribution: texte('CARTE_TUILES_ATTRIBUTION', 'Fond &copy; Esri, HERE, Garmin, &copy; contributeurs OpenStreetMap'),
      sombre: texte('CARTE_TUILES_SOMBRES', 'non') === 'oui',
    },
  },
  // Connexion directe au module Meshtastic de la maison (TCP, port 4403). Vide = désactivé.
  radio: {
    hote: texte('RADIO_HOTE'),
    port: nombre('RADIO_PORT', 4403),
    // Si un autre client (appli téléphone) prend le module, la carte attend avant de reprendre la main
    pauseMinutes: nombre('RADIO_PAUSE_MINUTES', 10),
    // Traceroutes automatiques vers les relais connus du module (0 = désactivé)
    tracerouteIntervalleMinutes: nombre('TRACEROUTE_INTERVALLE_MINUTES', 180),
    tracerouteEspacementSecondes: nombre('TRACEROUTE_ESPACEMENT_SECONDES', 90),
    // Cibles explicites (!id ou nom court, virgules). Vide = relais et nœuds surveillés entendus en radio
    tracerouteCibles: texte('TRACEROUTE_CIBLES').split(/[,;]/).map((s) => s.trim()).filter(Boolean),
    // Pas de traceroute automatique si le module émet déjà plus que ce pourcentage du temps (limite légale 10 %)
    emissionMaxPourcent: nombre('TRACEROUTE_EMISSION_MAX_POURCENT', 6),
  },
  // Source complémentaire : API v1 de MeshMonitor (noms, rôles, sauts et liens vus par le nœud local)
  meshmonitor: {
    url: texte('MESHMONITOR_URL').replace(/\/+$/, ''),
    jeton: texte('MESHMONITOR_JETON'),
    sources: texte('MESHMONITOR_SOURCES').split(',').map((s) => s.trim()).filter(Boolean),
    intervalleSecondes: nombre('MESHMONITOR_INTERVALLE_SECONDES', 300),
  },
  // Zone « Haute-Loire » : sud, ouest, nord, est (degrés)
  zone: (() => {
    const v = texte('ZONE_BBOX', '44.74,3.08,45.43,4.49').split(',').map(Number);
    return v.length === 4 && v.every(Number.isFinite) ? v : [44.74, 3.08, 45.43, 4.49];
  })(),
  zoneNom: texte('ZONE_NOM', 'Haute-Loire'),
  // Client et flasheur officiels Meshtastic (vide = calculé : même machine, ports 8443/10000 en HTTPS ou 8096/8097 en HTTP)
  urlClient: texte('URL_CLIENT_MESHTASTIC'),
  urlFlasher: texte('URL_FLASHER'),
  // Au-delà de cette distance, une « liaison radio directe » est jugée impossible (erreur de position ou de relais)
  lienDistanceMaxKm: nombre('LIEN_DISTANCE_MAX_KM', 120),
  // Preset LoRa du réseau (pour le temps d'émission) si le module radio ne l'a pas communiqué
  reseauPreset: texte('RESEAU_PRESET', 'LONG_FAST'),
  fichierBase: texte('FICHIER_BASE', '/data/carte-live.db'),
  // MeshCore : flux des observateurs (meshcoretomqtt) et republication de ce que capte le companion de la carte
  meshcore: {
    actif: texte('MESHCORE', 'oui') !== 'non',
    racine: texte('MESHCORE_RACINE', 'meshcore').replace(/\/+$/, ''),
    // Code de zone des sujets (aéroport le plus proche, ex. LPY = Le Puy)
    iata: texte('MESHCORE_IATA', 'LPY').toUpperCase(),
    republier: texte('MESHCORE_REPUBLIER', 'oui') !== 'non',
    // Canaux de groupe à déchiffrer : Public, #nom (canal « hashtag ») ou nom=secret (32 caractères hexadécimaux)
    canaux: texte('MESHCORE_CANAUX', 'Public').split(/[;\n]/).map((s) => s.trim()).filter(Boolean),
    // Répéteur « muet » au-delà de ce délai (les répéteurs MeshCore s'annoncent peu : 12 h par défaut)
    muetHeures: nombre('MESHCORE_MUET_HEURES', 26),
    // Interrogation automatique de l'état des répéteurs surveillés (0 = jamais) et nombre max. par tour
    supervisionHeures: nombre('MESHCORE_SUPERVISION_HEURES', 3),
    supervisionMax: nombre('MESHCORE_SUPERVISION_MAX', 8),
  },
};

// ---- Réglages faits depuis la carte (assistant d'installation, page Réglages) ----------------
// Ils sont enregistrés dans le volume de données et priment sur le fichier .env.
const fs = require('fs');
const path = require('path');
config.departement = { code: texte('DEPARTEMENT', '43'), nom: texte('ZONE_NOM', 'Haute-Loire') };
config.inscriptions = texte('INSCRIPTIONS', 'validation'); // fermees | validation | ouvertes
config.fichierReglages = path.join(path.dirname(config.fichierBase), 'reglages.json');
config.reglages = {};
function appliquerReglages(r) {
  if (!r || typeof r !== 'object') return;
  if (r.titre) config.carte.titre = r.titre;
  if (r.departement && r.departement.code) config.departement = r.departement;
  if (Array.isArray(r.zone) && r.zone.length === 4 && r.zone.every(Number.isFinite)) config.zone = r.zone;
  if (r.zoneNom) config.zoneNom = r.zoneNom;
  if (Array.isArray(r.centre) && r.centre.length === 2) [config.carte.centreLat, config.carte.centreLon] = r.centre;
  if (Number.isFinite(r.zoom)) config.carte.zoom = r.zoom;
  if (r.mqtt) {
    for (const k of ['url', 'utilisateur', 'motDePasse', 'racine']) if (typeof r.mqtt[k] === 'string' && r.mqtt[k] !== '') config.mqtt[k] = r.mqtt[k];
    if (Array.isArray(r.mqtt.sujetsSupplementaires)) config.mqtt.sujetsSupplementaires = r.mqtt.sujetsSupplementaires;
    config.mqtt.racine = config.mqtt.racine.replace(/\/+$/, '');
  }
  if (typeof r.canaux === 'string' && r.canaux.trim()) config.canaux = lireCanaux(r.canaux);
  if (['fermees', 'validation', 'ouvertes'].includes(r.inscriptions)) config.inscriptions = r.inscriptions;
  if (Number.isInteger(r.precisionPublique)) config.precisionPublique = r.precisionPublique;
  if (Number.isInteger(r.retentionJours) && r.retentionJours > 0) config.retentionJours = r.retentionJours;
  if (r.reseauPreset) config.reseauPreset = r.reseauPreset;
  if (r.meshcore && typeof r.meshcore === 'object') {
    const m = r.meshcore;
    if (typeof m.iata === 'string' && /^[A-Z0-9]{2,8}$/i.test(m.iata)) config.meshcore.iata = m.iata.toUpperCase();
    if (typeof m.racine === 'string' && m.racine.trim()) config.meshcore.racine = m.racine.trim().replace(/\/+$/, '');
    if (typeof m.republier === 'boolean') config.meshcore.republier = m.republier;
    if (typeof m.actif === 'boolean') config.meshcore.actif = m.actif;
    if (Array.isArray(m.canaux) && m.canaux.length) config.meshcore.canaux = m.canaux.map(String);
  }
}
try {
  config.reglages = JSON.parse(fs.readFileSync(config.fichierReglages, 'utf8'));
  appliquerReglages(config.reglages);
} catch { /* pas encore de réglages */ }
config.lireCanaux = lireCanaux;

module.exports = config;
