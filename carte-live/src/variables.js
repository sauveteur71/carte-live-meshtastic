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
  { nom: 'CARTE_RESEAUX', groupe: 'Affichage', libelle: 'Réseaux proposés', type: 'choix', choix: [['', '(par défaut : les deux)'], ['les-deux', 'Meshtastic et MeshCore'], ['meshtastic', 'Meshtastic seulement'], ['meshcore', 'MeshCore seulement']], aide: 'Réseaux montrés par la carte et proposés en haut du panneau. « Les deux » si vous suivez Meshtastic et MeshCore.' },
  { nom: 'CARTE_COUCHES_MASQUEES', groupe: 'Affichage', libelle: 'Couches masquées au départ', type: 'texte', aide: 'Séparées par des virgules : sommets, routiers, rf, voisinage, traceroute, animations, federation, releves.' },
  { nom: 'CARTE_TUILES_URL', groupe: 'Affichage', libelle: 'Adresse des tuiles du fond', type: 'texte', aide: 'Modèle {z}/{x}/{y}. Vide = fond Esri par défaut.' },
  { nom: 'CARTE_TUILES_ETIQUETTES_URL', groupe: 'Affichage', libelle: 'Adresse des tuiles d’étiquettes', type: 'texte', aide: 'Facultatif : tuiles transparentes posées sur le fond (noms de lieux, routes). Modèle {z}/{x}/{y}. Vide = aucune.' },
  { nom: 'CARTE_TUILES_ZOOM_MAX', groupe: 'Affichage', libelle: 'Zoom maximal des tuiles', type: 'nombre', min: 1, max: 22, defaut: 16, aide: 'Zoom le plus fort que fournit le serveur de tuiles du fond. Au-delà, la carte agrandit la dernière image. Par défaut 16.' },
  { nom: 'CARTE_TUILES_ATTRIBUTION', groupe: 'Affichage', libelle: 'Mention des sources du fond', type: 'texte', aide: 'Mention obligatoire des sources du fond choisi, affichée en bas de la carte (ex. « © contributeurs OpenStreetMap »).' },
  { nom: 'CARTE_TUILES_SOMBRES', groupe: 'Affichage', libelle: 'Tuiles déjà sombres', type: 'choix', choix: OUI_NON, aide: 'Oui : la carte ne les assombrit pas.' },
  { nom: 'URL_CLIENT_MESHTASTIC', groupe: 'Affichage', libelle: 'Lien vers le client Meshtastic', type: 'texte', aide: 'Lien proposé aux visiteurs pour régler leur module dans le navigateur. Vide = client web officiel de Meshtastic.' },
  { nom: 'URL_FLASHER', groupe: 'Affichage', libelle: 'Lien vers l’outil de flash', type: 'texte', aide: 'Lien proposé pour installer ou mettre à jour le firmware. Vide = outil de flash officiel de Meshtastic.' },
  // Seuils d'état et d'alerte
  { nom: 'SEUIL_ACTIF_MINUTES', groupe: 'Seuils et alertes', libelle: 'Nœud « actif » s’il a parlé depuis (min)', type: 'nombre', min: 1, max: 1440, defaut: 60, aide: 'Un nœud entendu depuis moins longtemps est compté « actif » (point plein sur la carte, tableau de bord). Par défaut 60 min.' },
  { nom: 'SEUIL_MUET_MINUTES', groupe: 'Seuils et alertes', libelle: 'Nœud surveillé « muet » au-delà de (min)', type: 'nombre', min: 5, max: 10080, defaut: 120, aide: 'Un relais ou nœud surveillé non entendu depuis plus longtemps déclenche l’alerte « muet ». Un relais émet sa télémétrie toutes les 30 min à 3 h : ne pas descendre trop bas. Par défaut 120 min.' },
  { nom: 'SEUIL_INACTIF_HEURES', groupe: 'Seuils et alertes', libelle: 'Nœud « inactif » au-delà de (h)', type: 'nombre', min: 1, max: 720, defaut: 6, aide: 'Au-delà, le nœud est « inactif » : masqué par défaut sur la carte (couche « Inactifs »). Par défaut 6 h.' },
  { nom: 'SEUIL_TENSION_VOLTS', groupe: 'Seuils et alertes', libelle: 'Alerte tension basse sous (V)', type: 'nombre', min: 2.5, max: 15, defaut: 3.5, aide: 'Alerte quand la tension d’un relais surveillé passe dessous. Lithium 1 cellule : 3,5 V ≈ 10 % restants. Par défaut 3,5 V.' },
  { nom: 'SEUIL_BATTERIE_POURCENT', groupe: 'Seuils et alertes', libelle: 'Alerte batterie sous (%)', type: 'nombre', min: 1, max: 99, defaut: 20, aide: 'Alerte quand le niveau de batterie annoncé par un relais surveillé passe dessous. Par défaut 20 %.' },
  { nom: 'SEUIL_CHARGE_SOLAIRE_VOLTS', groupe: 'Seuils et alertes', libelle: 'Charge solaire jugée faible sous (V)', type: 'nombre', min: 2.5, max: 15, defaut: 3.95, aide: 'En journée, une tension maximale restée sous ce seuil signale un panneau solaire trop faible, sale ou à l’ombre. Par défaut 3,95 V.' },
  { nom: 'SEUIL_CANAL_POURCENT', groupe: 'Seuils et alertes', libelle: 'Canal chargé au-delà de (%)', type: 'nombre', min: 1, max: 100, defaut: 25, aide: 'Occupation du canal radio (channel_utilization) au-delà de laquelle il est jugé chargé (orange). Par défaut 25 %.' },
  { nom: 'SEUIL_CANAL_CRITIQUE_POURCENT', groupe: 'Seuils et alertes', libelle: 'Canal saturé au-delà de (%)', type: 'nombre', min: 1, max: 100, defaut: 40, aide: 'Au-delà, le canal est saturé (rouge, alerte) : les nœuds retardent leurs envois et des paquets se perdent. Par défaut 40 %.' },
  { nom: 'SEUIL_EMISSION_POURCENT', groupe: 'Seuils et alertes', libelle: 'Temps d’émission excessif au-delà de (%)', type: 'nombre', min: 1, max: 100, defaut: 8, aide: 'Part du temps où un nœud émet (air_util_tx) au-delà de laquelle il est signalé. En Europe 868 MHz, la limite légale est de 10 % par heure. Par défaut 8 %.' },
  { nom: 'NOEUDS_SURVEILLES', groupe: 'Seuils et alertes', libelle: 'Nœuds surveillés (alerte s’ils se taisent)', type: 'texte', aide: 'Identifiants !abcd1234 séparés par des virgules.' },
  { nom: 'LIEN_DISTANCE_MAX_KM', groupe: 'Seuils et alertes', libelle: 'Liaison directe jugée impossible au-delà de (km)', type: 'nombre', min: 5, max: 1000, defaut: 120, aide: 'Une liaison directe plus longue est jugée fausse (position erronée, relais MQTT) et n’est pas tracée. Par défaut 120 km.' },
  // Messages et MQTT
  { nom: 'MESSAGES_RETENTION_JOURS', groupe: 'Messages et MQTT', libelle: 'Messages texte conservés (jours)', type: 'nombre', min: 7, max: 3650, defaut: 90, aide: 'Les messages des canaux et les messages directs restent lisibles aussi longtemps ; le reste du trafic suit la durée de conservation générale.' },
  { nom: 'CANAUX_TEXTE', groupe: 'Messages et MQTT', libelle: 'Canaux dont les messages sont conservés', type: 'texte', aide: 'Séparés par des virgules. Vide = tous les canaux déchiffrés.' },
  { nom: 'UDP_MESHTASTIC', groupe: 'Messages et MQTT', libelle: 'Écouter les modules Meshtastic du réseau local (UDP multicast)', type: 'choix', choix: OUI_NON, aide: 'Les modules en Wi-Fi réglés sur « UDP » (Réseau › Protocoles, firmware 2.6+) diffusent ce qu’ils entendent : la carte écoute sans occuper le module. Docker : réseau « host » nécessaire.' },
  { nom: 'MQTT_TLS_NON_VERIFIE', groupe: 'Messages et MQTT', libelle: 'Accepter un certificat auto-signé (mqtts, wss)', type: 'choix', choix: OUI_NON, aide: 'Déconseillé : la connexion n’est plus authentifiée.' },
  // APRS (radioamateurs)
  { nom: 'LORAWAN', groupe: 'LoRaWAN (capteurs)', libelle: 'Afficher les capteurs LoRaWAN d’une application', type: 'choix', choix: OUI_NON, aide: 'Par défaut non. La carte s’abonne en lecture seule au MQTT de votre application The Things Network (v3) ou ChirpStack (v4) : mesures des capteurs, passerelles, signal.' },
  { nom: 'LORAWAN_SERVEUR', groupe: 'LoRaWAN (capteurs)', libelle: 'Serveur MQTT', type: 'texte', defaut: 'mqtts://eu1.cloud.thethings.network:8883', aide: 'TTN Europe : mqtts://eu1.cloud.thethings.network:8883. ChirpStack : l’adresse de son broker (ex. mqtt://192.168.0.10:1883).' },
  { nom: 'LORAWAN_UTILISATEUR', groupe: 'LoRaWAN (capteurs)', libelle: 'Identifiant MQTT', type: 'texte', aide: 'TTN : « id-application@ttn » (onglet Intégrations › MQTT de l’application).' },
  { nom: 'LORAWAN_MOT_DE_PASSE', groupe: 'LoRaWAN (capteurs)', libelle: 'Clé d’API (mot de passe MQTT)', type: 'secret', aide: 'TTN : une clé d’API de l’application avec le droit de lire le trafic (« Read application traffic »).' },
  { nom: 'LORAWAN_SUJETS', groupe: 'LoRaWAN (capteurs)', libelle: 'Sujets MQTT', type: 'texte', aide: 'Par défaut v3/+/devices/+/up (TTN) et application/+/device/+/event/up (ChirpStack).' },
  { nom: 'LORAWAN_POSITIONS', groupe: 'LoRaWAN (capteurs)', libelle: 'Position des capteurs fixes', type: 'texte', aide: 'Pour les capteurs qui n’envoient pas leur position : nom=latitude;longitude, séparés par « | ». Ex. : niveau-borne=45,04;3,88 | meteo-mezenc=44,92;4,19' },
  { nom: 'LORAWAN_SEUILS', groupe: 'LoRaWAN (capteurs)', libelle: 'Seuils d’alerte', type: 'texte', aide: 'capteur.mesure > valeur ou < valeur, séparés par des points-virgules. Ex. : niveau-borne.hauteur > 150 ; batterie < 3,3 (sans nom de capteur : tous).' },
  { nom: 'LORAWAN_PUBLIC', groupe: 'LoRaWAN (capteurs)', libelle: 'Montrer les capteurs aux visiteurs', type: 'choix', choix: OUI_NON, aide: 'Par défaut non : seuls les membres connectés voient la couche.' },
  { nom: 'RIVIERES', groupe: 'Rivières (Hub’Eau)', libelle: 'Afficher les hauteurs d’eau des rivières du secteur', type: 'choix', choix: OUI_NON, aide: 'Par défaut non. La carte lit les stations hydrométriques publiques (Hub’Eau, mêmes mesures que Vigicrues) de la zone de la carte : hauteur, débit, tendance. Gratuit, sans compte ni matériel.' },
  { nom: 'RIVIERES_MONTEE_CM_H', groupe: 'Rivières (Hub’Eau)', libelle: 'Alerte de montée rapide (cm par heure)', type: 'nombre', min: 1, max: 500, defaut: 20, aide: 'Alerte « attention » quand l’eau monte au moins de cette valeur en une heure, « critique » au double.' },
  { nom: 'RIVIERES_SEUILS', groupe: 'Rivières (Hub’Eau)', libelle: 'Seuils de hauteur par station', type: 'texte', aide: 'Code de la station ou du site = hauteur en mètres, séparés par des points-virgules. Ex. : K0010020=2,5 ; K0114020=3. Le code s’affiche dans la fiche de la station.' },
  { nom: 'APRS_IS', groupe: 'APRS (radioamateurs)', libelle: 'Afficher les stations APRS du secteur', type: 'choix', choix: OUI_NON, aide: 'Par défaut non. La carte lit le réseau APRS-IS en lecture seule (sans émettre) pour la zone de la carte : stations LoRa APRS (433,775 MHz), iGates, digipeaters, traqueurs. Couche « Stations APRS ».' },
  { nom: 'APRS_INDICATIF', groupe: 'APRS (radioamateurs)', libelle: 'Indicatif utilisé pour la connexion APRS-IS', type: 'texte', aide: 'Obligatoire pour activer la couche : votre indicatif radioamateur (ex. F4XXX). Connexion en lecture seule, sans mot de passe.' },
  { nom: 'APRS_SERVEUR', groupe: 'APRS (radioamateurs)', libelle: 'Serveur APRS-IS', type: 'texte', aide: 'rotate.aprs2.net:14580 par défaut (ou euro.aprs2.net:14580).' },
  { nom: 'APRS_LORA_SEULEMENT', groupe: 'APRS (radioamateurs)', libelle: 'Garder seulement les stations LoRa APRS', type: 'choix', choix: OUI_NON, aide: 'Par défaut non : toutes les stations APRS de la zone (VHF 144,800 MHz comprise), les stations LoRa étant mises en évidence.' },
  // Domotique (Home Assistant, Node-RED)
  { nom: 'DOMOTIQUE_MQTT_URL', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Broker MQTT de la domotique', type: 'texte', aide: 'Par exemple mqtt://homeassistant.local:1883 (le broker « Mosquitto » de Home Assistant). Vide = pas de publication vers la domotique.' },
  { nom: 'DOMOTIQUE_MQTT_UTILISATEUR', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Utilisateur du broker de la domotique', type: 'texte', aide: 'Identifiant du broker MQTT de votre domotique (Home Assistant : utilisateur créé pour Mosquitto). Vide si le broker est sans compte.' },
  { nom: 'DOMOTIQUE_MQTT_MOT_DE_PASSE', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Mot de passe du broker de la domotique', type: 'secret', aide: 'Mot de passe de cet utilisateur. Enregistré comme secret, jamais réaffiché.' },
  { nom: 'DOMOTIQUE_RACINE', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Racine des sujets publiés', type: 'texte', aide: 'Par défaut carte-live : carte-live/etat, carte-live/alertes, carte-live/alerte, carte-live/noeud/…, carte-live/envoyer.' },
  { nom: 'DOMOTIQUE_DECOUVERTE', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Découverte automatique par Home Assistant', type: 'choix', choix: OUI_NON, aide: 'Par défaut oui : Home Assistant crée tout seul les capteurs, les relais et leur position.' },
  { nom: 'DOMOTIQUE_ENVOI_LORA', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Accepter les messages à envoyer en LoRa', type: 'choix', choix: OUI_NON, aide: 'Par défaut non. Un message publié sur carte-live/envoyer part par le module radio (200 octets au plus, un toutes les 20 s).' },
  { nom: 'DOMOTIQUE_CANAL_ENVOI', groupe: 'Domotique (Home Assistant, Node-RED)', libelle: 'Canal Meshtastic des messages de la domotique', type: 'nombre', min: 0, max: 7, defaut: 0, aide: 'Numéro du canal Meshtastic (0 = primaire) sur lequel partent les messages publiés par la domotique, si l’envoi est autorisé.' },
  // Module radio
  { nom: 'MDNS_MESHTASTIC', groupe: 'Module radio', libelle: 'Retrouver les modules Wi-Fi du réseau local (mDNS)', type: 'choix', choix: OUI_NON, aide: 'Par défaut oui : les modules Meshtastic en Wi-Fi qui s’annoncent sur le réseau local sont ajoutés tout seuls à la liste des modules (sans connexion).' },
  { nom: 'RADIO_PAUSE_MINUTES', groupe: 'Module radio', libelle: 'Pause de la carte quand une appli utilise le module (min)', type: 'nombre', min: 1, max: 240, defaut: 10, aide: 'Quand l’appli Meshtastic d’un téléphone se connecte au même module, la carte se retire pendant ce temps pour ne pas la gêner. Par défaut 10 min.' },
  { nom: 'TRACEROUTE_ESPACEMENT_SECONDES', groupe: 'Module radio', libelle: 'Écart entre deux traceroutes automatiques (s)', type: 'nombre', min: 30, max: 3600, defaut: 90, aide: 'Délai entre deux traceroutes d’un même cycle, pour ne pas charger le canal. 30 s au minimum. Par défaut 90 s.' },
  { nom: 'TRACEROUTE_EMISSION_MAX_POURCENT', groupe: 'Module radio', libelle: 'Pas de traceroute si le module émet plus de (%)', type: 'nombre', min: 1, max: 100, defaut: 6, aide: 'Si le module de la carte émet déjà plus que ce pourcentage du temps, le cycle de traceroutes est reporté. Par défaut 6 %.' },
  // MeshCore
  { nom: 'MESHCORE_RADIO_ATTENDUE', groupe: 'MeshCore', libelle: 'Réglage radio attendu du companion', type: 'texte', aide: 'fréquence,bande,SF,CR (ex. 869.618,62.5,8,8) ; « non » : aucun avertissement.' },
  { nom: 'MESHCORE_MUET_HEURES', groupe: 'MeshCore', libelle: 'Répéteur « muet » au-delà de (h)', type: 'nombre', min: 1, max: 720, defaut: 26, aide: 'Un répéteur MeshCore annonce sa présence (advert) environ toutes les 12 à 24 h : non entendu au-delà, il est signalé muet. Par défaut 26 h.' },
  { nom: 'MESHCORE_RETENTION_PAQUETS_JOURS', groupe: 'MeshCore', libelle: 'Paquets MeshCore conservés (jours)', type: 'nombre', min: 1, max: 90, defaut: 2, aide: 'Durée de conservation du détail des paquets MeshCore. Les répéteurs et messages sont gardés à part. Par défaut 2 jours.' },
  { nom: 'MESHCORE_SUPERVISION_MAX', groupe: 'MeshCore', libelle: 'Répéteurs interrogés au plus par relevé automatique', type: 'nombre', min: 1, max: 50, defaut: 8, aide: 'Nombre maximal de répéteurs interrogés (état, batterie) à chaque relevé automatique, pour limiter le trafic. Par défaut 8.' },
  { nom: 'MESHCORE_REGIONS', groupe: 'MeshCore', libelle: 'Régions supplémentaires à reconnaître', type: 'texte', aide: 'eu, fr, fr-ara, fr-43… sont déjà connues.' },
  // MeshMonitor
  { nom: 'MESHMONITOR_URL', groupe: 'MeshMonitor', libelle: 'Adresse de MeshMonitor', type: 'texte', aide: 'Adresse de votre MeshMonitor (ex. http://192.168.0.20:8080) pour en reprendre les nœuds et positions. Vide = non utilisé.' },
  { nom: 'MESHMONITOR_JETON', groupe: 'MeshMonitor', libelle: 'Jeton d’accès à MeshMonitor', type: 'secret', aide: 'Jeton d’API créé dans MeshMonitor (Réglages › API). Enregistré comme secret.' },
  { nom: 'MESHMONITOR_SOURCES', groupe: 'MeshMonitor', libelle: 'Sources MeshMonitor lues', type: 'texte', aide: 'Facultatif : noms des sources MeshMonitor à lire, séparés par des virgules. Vide = toutes.' },
  { nom: 'MESHMONITOR_INTERVALLE_SECONDES', groupe: 'MeshMonitor', libelle: 'Lecture toutes les (s)', type: 'nombre', min: 30, max: 86400, defaut: 300, aide: 'Fréquence de lecture de MeshMonitor. Par défaut 300 s (5 min).' },
  { nom: 'MESHMONITOR_NOEUD_LOCAL', groupe: 'MeshMonitor', libelle: 'Nœud local de MeshMonitor', type: 'texte', aide: 'Identifiant !abcd1234.' },
  // Services
  { nom: 'PASSERELLE', groupe: 'Services', libelle: 'Passerelle Meshtastic ⇄ MeshCore', type: 'choix', choix: [['', '(par défaut : activable par un administrateur)'], ['1', 'activée dès le démarrage'], ['0', 'interdite']], aide: 'Relaie les messages entre un canal Meshtastic et un canal MeshCore. Par défaut un administrateur l’active quand il veut ; « interdite » la retire.' },
  { nom: 'EXPORT_JETON', groupe: 'Services', libelle: 'Jeton exigé pour les exports (GeoJSON, GPX, Prometheus, Home Assistant)', type: 'secret', aide: 'Si renseigné, les exports (GeoJSON, GPX, Prometheus, Home Assistant) exigent ce jeton (?jeton=… ou en-tête). Vide = exports ouverts.' },
  { nom: 'LSASAF_UTILISATEUR', groupe: 'Services', libelle: 'Compte LSA SAF (feux Meteosat)', type: 'texte', aide: 'Compte gratuit sur le site LSA SAF (EUMETSAT) pour les foyers de feu Meteosat toutes les 15 min. Vide = feux NASA FIRMS seulement.' },
  { nom: 'LSASAF_MOT_DE_PASSE', groupe: 'Services', libelle: 'Mot de passe LSA SAF', type: 'secret', aide: 'Mot de passe de ce compte. Enregistré comme secret.' },
  { nom: 'POSTGRES_URL', groupe: 'Services', libelle: 'Archive PostgreSQL', type: 'secret', aide: 'postgres://utilisateur:motdepasse@serveur:5432/base' },
  { nom: 'METEOALARM_URL', groupe: 'Services', libelle: 'Flux de vigilance MeteoAlarm', type: 'texte', aide: 'Flux des vigilances météo affichées dans les alertes. Vide = flux MeteoAlarm de la France.' },
  { nom: 'RELIEF_FRANCE_URL', groupe: 'Services', libelle: 'Adresse du paquet « relief France »', type: 'texte', aide: 'Adresse de téléchargement du relief de toute la France (calcul de couverture hors ligne). Vide = adresse fournie par le projet.' },
  { nom: 'LANGUE', groupe: 'Services', libelle: 'Langue du journal du serveur', type: 'choix', choix: [['', '(par défaut)'], ['fr', 'français'], ['en', 'anglais']], aide: 'Langue des messages du journal du serveur et des alertes envoyées (domotique, radio). L’interface suit la langue de chaque visiteur.' },
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
