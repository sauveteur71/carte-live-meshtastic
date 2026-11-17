# Nouveautés par version

Le texte de la section de chaque version est repris tel quel dans la note de la release GitHub.

## 2.27.0

### 📡 Alertes envoyées par radio
- **Vigilances et foyers déjà envoyés bien visibles** : bord vert, coche « Déjà envoyée par radio », heure, auteur et canaux ; le bouton devient « Renvoyer ». Les nouvelles alertes gardent leur couleur. L'information est partagée par tous les utilisateurs et survit au redémarrage.

### 🗂️ Registre des relais
- **Nouvelle vue « Registre des relais »** (Outils) : site, autorisation, zone protégée, dernière visite, énergie, firmware et dernier paquet de chaque relais, avec les relais sans autorisation écrite ou non visités depuis plus d'un an en évidence, et export CSV.
- **Fiche d'installation complétée** : autorisation du site (accord écrit, convention, demande en cours…), date, zone protégée (monument historique, site classé, littoral, Natura 2000…) et dernière visite.

### 🏔️ Vue 3D du réseau
- **Nouvelle vue 3D** (Couverture radio) : relais, passerelles et répéteurs MeshCore posés sur le relief, liaisons des dernières 24 h colorées selon le SNR, relief exagérable, fond sombre, photos aériennes ou topographique, rotation lente.
- Elle suit le **département étudié** sur la carte.

### 📡 Radio et matériel
- **Calculette des pertes de câble** : type de câble (RG58, RG213, LMR-400, Ecoflex…), longueur, connecteurs et parafoudre ; le résultat va directement dans la fiche d'installation ou dans « Profil et bilan de liaison ».
- **Nœuds en mode licencié (radioamateur)** signalés par un badge : messages non chiffrés, indicatif, pas d'accès aux canaux chiffrés.

### 📻 Stations APRS
- **Nouvelle couche « Stations APRS »** : traqueurs, iGates et digipeaters **LoRa APRS** (433,775 MHz) du secteur en évidence, et autres stations APRS, lus sur APRS-IS en lecture seule (à activer dans Réglages avancés › APRS).
- **Positions Mic-E lues** (portatifs et mobiles Kenwood, Yaesu…), **indicatif radioamateur obligatoire** pour activer la couche, zone suivie quand le département de la carte change.

### 🛰️ Export pour ATAK
- **Export KML du réseau** (relais, nœuds, liaisons colorées selon le SNR) pour ATAK, Google Earth et QGIS, et **lien KML en direct** rechargé chaque minute.
- **Lien KML en direct fiable derrière un reverse proxy https** : il reprend l'adresse vue par le navigateur.

### ⚠ Installer un relais dans les règles
- **Avertissement sur les sites proposés** : un point haut n'est pas un site autorisé. Accord du propriétaire ou de la commune, pas de relais dans un cimetière ou un lieu de culte, avis de l'Architecte des Bâtiments de France près des monuments historiques, loi Littoral et espaces naturels protégés.

### ⚡ Page plus légère
- **Écrans d'administration chargés à la demande** : un visiteur télécharge 17 % de moins à l'ouverture de la carte ; pour un membre, ils sont préchargés en arrière-plan.

### 🔒 Sécurité
- **Failles connues des dépendances contrôlées à chaque envoi**, en plus du contrôle hebdomadaire.
- **Bibliothèque de la vue 3D mise à jour** (MapLibre 6) : corrige une faille connue de l'ancienne version.
- **Export CSV du registre** : un nom de nœud commençant comme une formule (= + - @) n'est plus exécuté par le tableur.

## 2.26.0

### 🔌 Brancher un module, sans réglage
- **Connexion automatique en USB** depuis le navigateur : on branche un module Meshtastic ou MeshCore, il est reconnu et relié tout seul ; on en change, la carte suit.
- **Agent prêt à l'emploi (1.7)** : un fichier à télécharger depuis la carte, déjà réglé (adresse du serveur, code, rôle). On le lance, il trouve le module USB et se connecte, sans aucune question.
- **Modules Wi-Fi retrouvés tout seuls (mDNS)** : les modules Meshtastic du réseau local qui s'annoncent sont ajoutés à la liste.
- **Écoute UDP du réseau local** : les paquets que les modules Meshtastic en Wi-Fi diffusent sur le réseau local (firmware 2.6 et plus) arrivent sur la carte, sans broker MQTT.

### 📣 Faire grandir le réseau
- **Nœuds à inviter** : la carte repère les nœuds du secteur réglés sur un autre preset (LongFast quand le réseau est en LongModerate, par exemple), et permet de leur envoyer un message d'invitation par un module « sentinelle ».
- **Page « Rejoindre le réseau »** (`/rejoindre`) : QR du canal, preset conseillé, rôles recommandés, limite de sauts, règles, antennes testées, relais communautaires et appel aux dons.

### 🏠 Domotique et supervision
- **Home Assistant et Node-RED** : état du réseau, alertes et relais publiés par MQTT, avec découverte automatique dans Home Assistant (capteurs, connectivité, batterie, position des relais). Un message publié par la domotique peut partir en LoRa (désactivé par défaut).
- **Prometheus / Grafana** : une mesure par relais surveillé (entendu ou non, depuis quand, batterie, tension) et une par alerte en cours, pour alerter depuis Alertmanager.
- **Supervision MeshCore** : nouvelle alerte quand un répéteur ne répond plus à deux demandes d'état de suite, même s'il est encore entendu.

### 🎨 Nouvelle identité
- **Nouveau logo**, dans l'en-tête de la carte, l'icône de l'onglet, l'application web et l'application Android.

### 📚 Documentation
- Nouvelles pages du wiki : « Domotique et supervision », agent prêt à l'emploi, connexion USB automatique et écoute UDP.
