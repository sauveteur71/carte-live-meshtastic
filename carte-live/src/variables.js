'use strict';
// Réglages avancés : les variables du fichier .env réglables depuis la carte (Réglages › Réglages avancés).
// Les valeurs choisies sont enregistrées dans reglages.json (champ « variables ») et appliquées à process.env
// au tout début du démarrage, avant la lecture de la configuration : elles priment sur le fichier .env.
// Restent seulement dans le .env (ou docker-compose.yml) : le port, la base, le mot de passe d'installation,
// le secret de session et les proxys de confiance, qu'une erreur de saisie rendrait la carte injoignable.
const fs = require('fs');
const path = require('path');

const OUI_NON = [['', '(par défaut)'], ['oui', 'oui'], ['non', 'non']];
// type : texte | nombre | choix | secret (jamais renvoyé à la page) ; min/max pour les nombres
const CATALOGUE = [
  // Affichage de la carte
  { nom: 'CARTE_FOND', groupe: 'Affichage', libelle: 'Fond de carte par défaut', type: 'choix', choix: [['', '(par défaut : sombre)'], ['sombre', 'sombre'], ['plan', 'plan'], ['plan-sombre', 'plan sombre'], ['photos', 'photos aériennes'], ['topo', 'topographique']], aide: 'Chaque visiteur peut en changer ; son choix est gardé.' },
  { nom: 'CARTE_RESEAUX', groupe: 'Affichage', libelle: 'Réseaux proposés', type: 'choix', choix: [['', '(par défaut : les deux)'], ['les-deux', 'Meshtastic et MeshCore'], ['meshtastic', 'Meshtastic seulement'], ['meshcore', 'MeshCore seulement']] },
  { nom: 'CARTE_COUCHES_MASQUEES', groupe: 'Affichage', libelle: 'Couches masquées au départ', type: 'texte', aide: 'Séparées par des virgules : sommets, routiers, rf, voisinage, traceroute, animations, federation, releves.' },
  { nom: 'CARTE_TUILES_URL', groupe: 'Affichage', libelle: 'Adresse des tuiles du fond', type: 'texte', aide: 'Modèle {z}/{x}/{y}. Vide = fond Esri par défaut.' },
  { nom: 'CARTE_TUILES_ETIQUETTES_URL', groupe: 'Affichage', libelle: 'Adresse des tuiles d’étiquettes', type: 'texte' },
  { nom: 'CARTE_TUILES_ZOOM_MAX', groupe: 'Affichage', libelle: 'Zoom maximal des tuiles', type: 'nombre', min: 1, max: 22, defaut: 16 },
  { nom: 'CARTE_TUILES_ATTRIBUTION', groupe: 'Affichage', libelle: 'Mention des sources du fond', type: 'texte' },
  { nom: 'CARTE_TUILES_SOMBRES', groupe: 'Affichage', libelle: 'Tuiles déjà sombres', type: 'choix', choix: OUI_NON, aide: 'Oui : la carte ne les assombrit pas.' },
  { nom: 'URL_CLIENT_MESHTASTIC', groupe: 'Affichage', libelle: 'Lien vers le client Meshtastic', type: 'texte' },
  { nom: 'URL_FLASHER', groupe: 'Affichage', libelle: 'Lien vers l’outil de flash', type: 'texte' },
  // Seuils d'état et d'alerte
  { nom: 'SEUIL_ACTIF_MINUTES', groupe: 'Seuils et alertes', libelle: 'Nœud « actif » s’il a parlé depuis (min)', type: 'nombre', min: 1, max: 1440, defaut: 60 },
  { nom: 'SEUIL_MUET_MINUTES', groupe: 'Seuils et alertes', libelle: 'Nœud surveillé « muet » au-delà de (min)', type: 'nombre', min: 5, max: 10080, defaut: 120 },
  { nom: 'SEUIL_INACTIF_HEURES', groupe: 'Seuils et alertes', libelle: 'Nœud « inactif » au-delà de (h)', type: 'nombre', min: 1, max: 720, defaut: 6 },
  { nom: 'SEUIL_TENSION_VOLTS', groupe: 'Seuils et alertes', libelle: 'Alerte tension basse sous (V)', type: 'nombre', min: 2.5, max: 15, defaut: 3.5 },
  { nom: 'SEUIL_BATTERIE_POURCENT', groupe: 'Seuils et alertes', libelle: 'Alerte batterie sous (%)', type: 'nombre', min: 1, max: 99, defaut: 20 },
  { nom: 'SEUIL_CHARGE_SOLAIRE_VOLTS', groupe: 'Seuils et alertes', libelle: 'Charge solaire jugée faible sous (V)', type: 'nombre', min: 2.5, max: 15, defaut: 3.95 },
  { nom: 'SEUIL_CANAL_POURCENT', groupe: 'Seuils et alertes', libelle: 'Canal chargé au-delà de (%)', type: 'nombre', min: 1, max: 100, defaut: 25 },
  { nom: 'SEUIL_CANAL_CRITIQUE_POURCENT', groupe: 'Seuils et alertes', libelle: 'Canal saturé au-delà de (%)', type: 'nombre', min: 1, max: 100, defaut: 40 },
  { nom: 'SEUIL_EMISSION_POURCENT', groupe: 'Seuils et alertes', libelle: 'Temps d’émission excessif au-delà de (%)', type: 'nombre', min: 1, max: 100, defaut: 8 },
  { nom: 'NOEUDS_SURVEILLES', groupe: 'Seuils et alertes', libelle: 'Nœuds surveillés (alerte s’ils se taisent)', type: 'texte', aide: 'Identifiants !abcd1234 séparés par des virgules.' },
  { nom: 'LIEN_DISTANCE_MAX_KM', groupe: 'Seuils et alertes', libelle: 'Liaison directe jugée impossible au-delà de (km)', type: 'nombre', min: 5, max: 1000, defaut: 120 },
  // Messages et MQTT
  { nom: 'CANAUX_TEXTE', groupe: 'Messages et MQTT', libelle: 'Canaux dont les messages sont conservés', type: 'texte', aide: 'Séparés par des virgules. Vide = tous les canaux déchiffrés.' },
  { nom: 'UDP_MESHTASTIC', groupe: 'Messages et MQTT', libelle: 'Écouter les modules Meshtastic du réseau local (UDP multicast)', type: 'choix', choix: OUI_NON, aide: 'Les modules en Wi-Fi réglés sur « UDP » (Réseau › Protocoles, firmware 2.6+) diffusent ce qu’ils entendent : la carte écoute sans occuper le module. Docker : réseau « host » nécessaire.' },
  { nom: 'MQTT_TLS_NON_VERIFIE', groupe: 'Messages et MQTT', libelle: 'Accepter un certificat auto-signé (mqtts, wss)', type: 'choix', choix: OUI_NON, aide: 'Déconseillé : la connexion n’est plus authentifiée.' },
  // Module radio
  { nom: 'RADIO_PAUSE_MINUTES', groupe: 'Module radio', libelle: 'Pause de la carte quand une appli utilise le module (min)', type: 'nombre', min: 1, max: 240, defaut: 10 },
  { nom: 'TRACEROUTE_ESPACEMENT_SECONDES', groupe: 'Module radio', libelle: 'Écart entre deux traceroutes automatiques (s)', type: 'nombre', min: 30, max: 3600, defaut: 90 },
  { nom: 'TRACEROUTE_EMISSION_MAX_POURCENT', groupe: 'Module radio', libelle: 'Pas de traceroute si le module émet plus de (%)', type: 'nombre', min: 1, max: 100, defaut: 6 },
  // MeshCore
  { nom: 'MESHCORE_RADIO_ATTENDUE', groupe: 'MeshCore', libelle: 'Réglage radio attendu du companion', type: 'texte', aide: 'fréquence,bande,SF,CR (ex. 869.618,62.5,8,8) ; « non » : aucun avertissement.' },
  { nom: 'MESHCORE_MUET_HEURES', groupe: 'MeshCore', libelle: 'Répéteur « muet » au-delà de (h)', type: 'nombre', min: 1, max: 720, defaut: 26 },
  { nom: 'MESHCORE_RETENTION_PAQUETS_JOURS', groupe: 'MeshCore', libelle: 'Paquets MeshCore conservés (jours)', type: 'nombre', min: 1, max: 90, defaut: 2 },
  { nom: 'MESHCORE_SUPERVISION_MAX', groupe: 'MeshCore', libelle: 'Répéteurs interrogés au plus par relevé automatique', type: 'nombre', min: 1, max: 50, defaut: 8 },
  { nom: 'MESHCORE_REGIONS', groupe: 'MeshCore', libelle: 'Régions supplémentaires à reconnaître', type: 'texte', aide: 'eu, fr, fr-ara, fr-43… sont déjà connues.' },
  // MeshMonitor
  { nom: 'MESHMONITOR_URL', groupe: 'MeshMonitor', libelle: 'Adresse de MeshMonitor', type: 'texte' },
  { nom: 'MESHMONITOR_JETON', groupe: 'MeshMonitor', libelle: 'Jeton d’accès à MeshMonitor', type: 'secret' },
  { nom: 'MESHMONITOR_SOURCES', groupe: 'MeshMonitor', libelle: 'Sources MeshMonitor lues', type: 'texte' },
  { nom: 'MESHMONITOR_INTERVALLE_SECONDES', groupe: 'MeshMonitor', libelle: 'Lecture toutes les (s)', type: 'nombre', min: 30, max: 86400, defaut: 300 },
  { nom: 'MESHMONITOR_NOEUD_LOCAL', groupe: 'MeshMonitor', libelle: 'Nœud local de MeshMonitor', type: 'texte', aide: 'Identifiant !abcd1234.' },
  // Services
  { nom: 'PASSERELLE', groupe: 'Services', libelle: 'Passerelle Meshtastic ⇄ MeshCore', type: 'choix', choix: [['', '(par défaut : activable par un administrateur)'], ['1', 'activée dès le démarrage'], ['0', 'interdite']] },
  { nom: 'EXPORT_JETON', groupe: 'Services', libelle: 'Jeton exigé pour les exports (GeoJSON, GPX, Prometheus, Home Assistant)', type: 'secret' },
  { nom: 'LSASAF_UTILISATEUR', groupe: 'Services', libelle: 'Compte LSA SAF (feux Meteosat)', type: 'texte' },
  { nom: 'LSASAF_MOT_DE_PASSE', groupe: 'Services', libelle: 'Mot de passe LSA SAF', type: 'secret' },
  { nom: 'POSTGRES_URL', groupe: 'Services', libelle: 'Archive PostgreSQL', type: 'secret', aide: 'postgres://utilisateur:motdepasse@serveur:5432/base' },
  { nom: 'METEOALARM_URL', groupe: 'Services', libelle: 'Flux de vigilance MeteoAlarm', type: 'texte' },
  { nom: 'RELIEF_FRANCE_URL', groupe: 'Services', libelle: 'Adresse du paquet « relief France »', type: 'texte' },
  { nom: 'LANGUE', groupe: 'Services', libelle: 'Langue du journal du serveur', type: 'choix', choix: [['', '(par défaut)'], ['fr', 'français'], ['en', 'anglais']] },
];
const PAR_NOM = new Map(CATALOGUE.map((v) => [v.nom, v]));
// Valeurs du .env telles qu'au lancement, avant les réglages de la carte
const envOrigine = {};
const appliquees = {};

function fichierReglages() {
  return path.join(path.dirname(process.env.FICHIER_BASE || '/data/carte-live.db'), 'reglages.json');
}
function lire(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
// Au démarrage : les variables réglées depuis la carte remplacent celles du .env
function appliquer() {
  for (const v of CATALOGUE) envOrigine[v.nom] = process.env[v.nom];
  const f = fichierReglages();
  const r = lire(f) || (fs.existsSync(f) ? lire(f + '.bak') : null);
  const vars = r && r.variables && typeof r.variables === 'object' ? r.variables : {};
  for (const [nom, val] of Object.entries(vars)) {
    if (!PAR_NOM.has(nom) || val == null) continue;
    process.env[nom] = String(val);
    appliquees[nom] = true;
  }
}
// Contrôle d'une valeur saisie : renvoie la valeur à garder (texte) ou lève une erreur lisible
function valider(nom, valeur) {
  const v = PAR_NOM.get(nom);
  if (!v) throw new Error(`Réglage inconnu : ${nom}`);
  const s = String(valeur).trim();
  if (s.length > 500) throw new Error(`${v.libelle} : 500 caractères au plus`);
  if (/[\r\n]/.test(s)) throw new Error(`${v.libelle} : une seule ligne`);
  if (v.type === 'nombre') {
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n) || n < v.min || n > v.max) throw new Error(`${v.libelle} : nombre de ${v.min} à ${v.max} attendu`);
    return String(n);
  }
  if (v.type === 'choix' && !v.choix.some(([c]) => c === s)) throw new Error(`${v.libelle} : choix inconnu`);
  return s;
}
// Vue pour la page d'administration : jamais la valeur d'un secret
function vue() {
  return CATALOGUE.map((v) => {
    const val = process.env[v.nom];
    const origine = appliquees[v.nom] ? 'carte' : envOrigine[v.nom] !== undefined && envOrigine[v.nom] !== '' ? 'env' : 'defaut';
    return {
      nom: v.nom, groupe: v.groupe, libelle: v.libelle, type: v.type, aide: v.aide || null, choix: v.choix || null, min: v.min, max: v.max, defaut: v.defaut ?? null,
      origine, valeur: v.type === 'secret' ? undefined : (val ?? ''), defini: v.type === 'secret' ? !!val : undefined,
    };
  });
}

module.exports = { CATALOGUE, appliquer, valider, vue, PAR_NOM };
