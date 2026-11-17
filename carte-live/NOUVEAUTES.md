# Nouveautés par version

Le texte de la section de chaque version est repris tel quel dans la note de la release GitHub.

## 2.28.4

### 📣 Nœuds à inviter
- **Écran refait** : une fiche par nœud avec son nom en entier (il était coupé à une lettre), son preset, sa distance et quand il a été vu ; filtre « dans le secteur de la carte », 25, 50 ou 100 km ; étapes claires (① module sentinelle pour écrire, ② choisir les nœuds) ; bouton « Inviter » expliqué tant qu'aucune sentinelle n'est reliée.

### 🤝 Page « Rejoindre le réseau »
- **Réseau MeshCore seul** : lien du canal et limite de sauts laissés vides, la page n'affiche plus la partie Meshtastic (comme la partie MeshCore quand elle est vide).

## 2.28.3

### 🛠️ Corrections
- **Messages MeshCore de la carte elle-même** (vigilances envoyées par radio, messages écrits depuis la carte) : quand ils reviennent répétés par un relais ou vus par un observateur, ils ne sont plus marqués « nouveau » ni comptés comme non lus.

### 📱 Téléphone
- **Icônes sur téléphone**, comme sur tablette : rubriques du panneau (🗺️ Réseau, 💬 Messages, 📶 Couverture, 🛠️ Gérer, ⚙️ Réglages) et barre du bas (🗂️ Couches, 📡 Couverture radio, 🧰 Outils, 👤 Connexion) avec un mot dessous. L'ordinateur garde l'affichage complet.
- **En-tête qui tient sur un téléphone** : l'état du direct devient une pastille de couleur, les alertes officielles se résument à leurs pictogrammes et à leur nombre (le détail reste au clic).
- **Barre du bas plus compacte** : sélecteur du secteur et durée des liens réduits, texte de recherche raccourci, pour moins de boutons coupés.

## 2.28.2

### 🗺️ Légende
- **Symboles des couches dans la légende** : stations APRS (LoRa APRS et autres), capteurs et passerelles LoRaWAN, stations de rivière (normale, en crue, barrage), affichés dès que la couche est activée.

## 2.28.1

### 🛠️ Corrections et confort
- **Appli Android** : la carte ne passe plus sous la barre d'état (heure, icônes) ni sous la barre de navigation sur Android 15, et le clavier ne recouvre plus la saisie.
- **Menu Couches en trois colonnes** sur ordinateur (fond de carte et repères · réseau · autour du réseau) : il tient en hauteur au lieu de déborder de l'écran.
- **Couche désactivée** (Rivières, Capteurs LoRaWAN, Stations APRS) : l'annonce reste affichée plus longtemps et, pour un administrateur, un clic ouvre les Réglages avancés sur le bon groupe.
- **Stations APRS bien distinctes des nœuds** : carré blanc marqué « A » (bord violet pour LoRa APRS, bleu pour les autres) et étiquette « APRS » devant l'indicatif.
- **Aide sous chaque réglage avancé** : les 36 réglages qui n'en avaient pas expliquent à quoi ils servent et leur valeur par défaut.
- **Courbes des rivières et des capteurs** lisibles : valeurs mini et maxi dans une marge, début et fin de la courbe en clair (« il y a 8 h » … « il y a 3 h ») ; plus aucun texte sur le tracé.

## 2.28.0

### 🌊 Rivières
- **Nouvelle couche « Rivières »** (en option) : hauteur d'eau, débit et tendance des stations hydrométriques publiques du secteur (Hub'Eau, les mêmes mesures que Vigicrues), avec la courbe sur 24 h. Gratuit, sans compte ni matériel.
- **Alertes de crue** dans la carte : montée rapide (20 cm/h par défaut, réglable) et seuils de hauteur choisis station par station.

### 📟 Capteurs LoRaWAN
- **Nouvelle couche « Capteurs LoRaWAN »** (en option) : les capteurs d'une application The Things Network (v3) ou ChirpStack (v4) sur la carte (niveau d'eau, météo, pluie…), avec leurs dernières mesures, la courbe sur 24 h, les passerelles qui les ont reçus et le signal (RSSI, SNR). Lecture seule par le MQTT de l'application ; réservée aux membres par défaut.
- **Alertes sur seuil** choisies capteur par capteur (« niveau-borne.hauteur > 150 », « batterie < 3,3 »), et alerte si le serveur MQTT reste injoignable.

### 🧰 Supervision
- **Échecs des tâches de fond visibles dans les alertes** : relevé des rivières impossible, APRS-IS injoignable.

### ✉️ Messages
- **Historique d'un canal toujours visible** : en choisissant un canal (ou les messages directs), la carte charge son propre historique. Un canal calme, comme celui d'une association, n'est plus caché par les centaines de messages des canaux bavards.
- **Messages conservés 90 jours** (réglable : *Réglages avancés › Messages et MQTT*), au lieu de la durée de conservation du trafic (7 jours par défaut).
- **Message direct impossible signalé avant l'envoi** : si le module ne connaît pas encore la clé publique du destinataire (il refuserait le message), la carte le dit, explique pourquoi (fiche NodeInfo pas encore reçue, firmware antérieur à 2.5) et propose d'écrire sur un canal à la place.
- **Bouton « Échanger les fiches avec ce nœud »** dans cet avertissement : la carte envoie la fiche de son module (avec sa clé publique) au nœud, qui répond avec la sienne ; le message direct passe ensuite.

### 🛠️ Corrections
- **Onglets du panneau** (Réseau, Messages, Couverture, Gérer, Réglages) : ils ne se chevauchent plus sur un écran d'ordinateur.
- **Interface en anglais** : les durées (« il y a 2 h »), les sauts, la télémétrie (secteur, canal, émission), les résumés du tableau de bord et les jours de la santé sur 7 jours sont traduits.
- **Registre des relais** : limité aux relais et passerelles de la zone de la carte (et non plus de toute la France), dans un panneau élargi pour que le tableau reste lisible.
- **Mode démonstration sur téléphone** : le bandeau est lisible (il s'affichait en rond au milieu de l'écran) et peut être fermé.

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
