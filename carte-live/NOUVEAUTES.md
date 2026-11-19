# Nouveautés par version

Le texte de la section de chaque version est repris tel quel dans la note de la release GitHub.

## 2.28.13

### 📡 Passerelle des membres
- **Outils › 📡 Devenir passerelle** : un membre connecté (pas seulement l'administrateur) relie **sa radio** Meshtastic ou MeshCore depuis son navigateur, en USB ou Bluetooth, sans rien installer. Elle ajoute ce qu'elle entend à la carte, **en écoute seulement** : elle n'émet rien et ne remplace jamais le module principal.
- Nom à l'identifiant du membre, **deux radios par compte**, débit limité ; l'administrateur voit chaque passerelle dans *Modules radio* et peut la **couper** (refusée ensuite 12 h). Réglage *Module radio › Passerelles des membres*.
- USB et Bluetooth demandent la carte en **HTTPS**.

### 🎚️ Jeux de canaux (carte et ADRASEC)
- L'administrateur règle les canaux de la carte, le président ceux de son ADRASEC (*page ADRASEC › Gestion › Canaux*).
- Le membre qui a relié sa radio voit ses 8 emplacements, coche les canaux et clique **Écrire sur la radio** : écriture puis relecture de contrôle. Place insuffisante : il choisit les canaux à libérer ; le canal 0 n'est jamais touché ; avertissement pour les canaux en clair.
- **Les clés ne quittent jamais le serveur** (chiffrées, empreinte courte pour qui règle le jeu).

### 📊 Fréquentation (Gérer › Fréquentation)
- Visiteurs en ligne, visiteurs et pages par jour, **pays** (base libre DB-IP consultée sur le serveur), pages vues, **provenance** (Facebook, rtl-sdr.com…), membres ou simples visiteurs.
- **Aucune adresse IP gardée, aucun cookie**, robots ignorés ; réglages `STATS_FREQUENTATION` et `STATS_PAYS`.

### 🛠️ Corrections
- *Gérer › Comptes* : bouton **✔ Enregistrer** bien visible, Entrée enregistre, toutes les fiches ouvertes enregistrées d'un coup (les noms modifiés n'étaient pas gardés) ; crayon ✏️ affiché sans vider le cache.

## 2.28.12

### ✉️ Winlink (section ADRASEC)
- **Boîte réservée à l'ADRASEC de la station** (réglage `PAT_ADRASEC`, par défaut le département de la carte) : les membres des autres ADRASEC hébergées ne la voient plus. Rédaction et sessions : radioamateurs licenciés seulement.
- **Pat démarre du premier coup** : son dossier de données est donné à son compte avant le lancement (il redémarrait en boucle avec « permission denied »).
- **Wiki** : installation pas à pas par Internet, cas du NAS Synology (sans tunnel SSH), docker-compose personnalisé, tableau « qui a accès à quoi ».

### 🛠️ Corrections
- **Gérer › Comptes** : boîte plus large, case ADRASEC compacte, boutons qui passent à la ligne au lieu d'être coupés.
- **Écrans d'administration toujours à jour** après une mise à jour (l'ancienne version restait en cache : boutons ✏️ et 🔑 absents).

## 2.28.11

### 🔑 Comptes
- **Mot de passe oublié** : lien « Mot de passe oublié ? » sous la connexion. Avec un serveur d'envoi réglé (*Réglages › Réglages avancés › E-mail*), un lien valable 1 h arrive par e-mail ; sinon la demande s'affiche dans *Gérer › Comptes*, où le bouton **🔑 Lien** crée un lien à usage unique (24 h) à transmettre.
- **E-mail** modifiable dans *Mon compte*.
- **Identifiant « NOM Prénom »** accepté (espaces, accents, apostrophe).
- **Fiche d'un compte modifiable par l'administrateur** (✏️) : identifiant, indicatif, e-mail.

### 🛰️ ADRASEC
- **Gestion** : plusieurs comptes cochés et intégrés d'un coup (filtre, tout cocher).
- **Équipes** : **＋ Membres** pour composer chaque équipe en cochant les membres, ✕ pour en sortir ; couleur de chaque équipe au choix.
- **Nouveau relevé** : **équipe qui donne le relevé** (saisie au PC des relevés reçus par radio), position par le **nœud de l'équipe** ; équipe d'un relevé déjà enregistré corrigeable, le trait prend sa couleur.

## 2.28.10

### 🛰️ ADRASEC par département
- **Plusieurs ADRASEC sur une même carte** (43, 42, 07…) : chacune a ses membres, ses équipes, sa main courante et ses recherches ; un membre ne voit que la sienne. Les données existantes deviennent l'ADRASEC du département de la carte.
- **Case ADRASEC dans Gérer › Comptes** : un clic intègre le compte, une seconde case le nomme **président**. Le président gère son ADRASEC sans être administrateur de la carte.
- **Adhésion** : la page `/adrasec` propose de créer son compte puis de demander à rejoindre l'ADRASEC de son département, comme **radioamateur licencié** (indicatif) ou **SWL** (n° d'écouteur). Le président accepte ou refuse dans Gestion.
- **Fiches des membres** : qualité, indicatif ou n° SWL, équipe, fonction, nœud porté ; recherche ; intégration directe d'un compte existant. Les SWL font des relevés mais n'émettent pas (Winlink réservé aux licenciés).

### 📱 Téléphone et appli Android
- **Tiroir du bas** : déplié, il s'arrête sous le titre et la recherche de lieu (même avec un texte agrandi) ; bouton **▾** pour le replier, poignée plus grande.
- **Version de l'appli** affichée à côté de celle de la carte (comparer téléphone et tablette).
- **Préparation Google Play** : appli en API 36 (Android 16), paquet AAB pour le Play Store, politique de confidentialité dans le wiki.

### 🛠️ Corrections et ajouts
- **Alertes envoyées par MeshCore** : leur écho relayé par les répéteurs ne compte plus comme un message non lu.
- **Alertes officielles** : quand le bouton 📡 Envoyer manque, la raison s'affiche (module non relié, aucun canal nommé).
- **Schéma des rôles Meshtastic** (client muet, client de base, routeur, client, routeur tardif) dans *Statistiques › Rôles des nœuds* et dans le wiki.

## 2.28.9

### 🛰️ Section ADRASEC : recherche de balise
- **Diffusion aux équipes par LoRa** (zone blanche) : la position estimée part en point de passage « 🎯 Balise estimée » sur la carte de l'appli Meshtastic des équipiers, avec un message (coordonnées, locator, DFCI, taille de la zone), sur le canal choisi ; renvoi automatique quand l'estimation bouge de plus de 300 m ; point retiré à la clôture.
- **Lien terrain** (réseau mobile) : lien secret ou QR code qui ouvre la carte de la recherche sans compte, en lecture seule, avec la distance et le cap jusqu'à la balise depuis le GPS du téléphone ; éteint à la clôture (48 h au plus).
- **Relèvements bien visibles** : trait épais avec liseré, flèche, étiquette « équipe · direction · force » sur chaque point.
- **Saisie** : point de l'équipe et aperçu du gisement dès le clic sur la carte, avant l'envoi.
- **Missions** : choisies dans une liste (recherches en cours, missions des autres équipes) pour rattacher plusieurs équipes à la même mission.

## 2.28.8

### 🛠️ Corrections
- **USB et Bluetooth avec la carte ouverte sur le PC même** (`http://localhost:8095`) : « Connecter un module › USB » n'est plus grisé (il exigeait l'HTTPS, que Chrome ne demande pas en localhost).
- **Recherche Ctrl+K** : un outil du menu Outils (ex. « Module USB de ce PC ») est lancé directement, au lieu d'être seulement surligné dans le menu.

## 2.28.7

### 🎚️ Fonctions de la carte
- **Un seul écran à interrupteurs** (Outils › 🎚️ Fonctions de la carte, ou Réglages) : activer la section ADRASEC, activer Winlink en 3 étapes (Pat lancé, station réglée, adresse enregistrée), afficher ou masquer signalements, Vigipirate, FR-Alert, main courante, Bipper et feux.

### 🛰️ Section ADRASEC
- **Membres** : une fiche par compte, lisible même sur un écran étroit, avec une aide sur chaque champ ; le nœud porté sur le terrain se choisit en tapant son nom.
- **Carte** : Plan IGN par défaut (communes, lieux-dits, routes), choix du fond (topographique, photos aériennes, sombre), recherche d'un lieu, et coordonnées, locator et DFCI sous le curseur.

## 2.28.6

### 🛰️ Section ADRASEC (édition française)
- **Espace réservé** aux membres validés par un administrateur (Outils › 🛰️ Section ADRASEC) : équipes, case « radioamateur licencié » avec indicatif, nœud Meshtastic porté par chaque membre (position en direct).
- **Main courante** horodatée et signée, jamais modifiée, export CSV ; recherches, relevés et messages Winlink s'y inscrivent seuls.
- **Radiogoniométrie** : recherches de balise (121,5 / 243 / 406 MHz), relevés de gisement depuis le GPS du téléphone, le nœud du membre, un clic ou un locator, ou par radio (« GONIO 125 », « GIS 125/5 ») ; cônes d'incertitude, position la plus probable par moindres carrés avec ellipse à 95 %, relèvements aberrants (réflexions) écartés tout seuls, coordonnées, locator et DFCI.
- **Winlink** avec Pat (client libre, service « pat » du docker-compose, profil winlink) : boîtes, rédaction signée et sessions par Internet ou par radio (VARA, ARDOP, packet) réservées aux licenciés, passerelles RMS sur la carte. Le mot de passe Winlink reste dans Pat.

### 🏔️ Profil de liaison en 3D
- **Bouton « Voir ce profil en 3D »** dans le profil de relief : la liaison s'ouvre dans la vue 3D, vue de côté, sur le vrai relief. La ligne de visée est colorée tronçon par tronçon (vert dégagée, orange zone de Fresnel gênée, rouge coupée par le relief), la 1re zone de Fresnel est dessinée en volume clair, les mâts d'antenne à leur hauteur et l'obstacle principal est signalé. Les hauteurs suivent le curseur « Relief × », et la vue se tourne à la souris comme le reste de la vue 3D.

### 🛠️ Corrections
- **« Module USB de ce PC » qui ne faisait rien** : la cause s'affiche maintenant à l'écran (adresse en HTTP, navigateur sans USB, liste de ports vide : câble ou pilote CP210x / CH340, port déjà ouvert par une autre appli) et la réussite est confirmée.

## 2.28.5

### 🛠️ Corrections
- **Fond de carte hors ligne qui ne se téléchargeait pas** dans l'image Docker (« extraction interrompue (code 1) ») : l'outil d'extraction n'avait pas les certificats racines pour joindre le serveur de cartes en https. Ils sont maintenant inclus, et en cas d'échec le message dit pourquoi (certificats, serveur injoignable, disque plein).

## 2.28.4

### 📣 Nœuds à inviter
- **Écran refait** : une fiche par nœud avec son nom en entier (il était coupé à une lettre), son preset, sa distance et quand il a été vu ; filtre « dans le secteur de la carte », 25, 50 ou 100 km ; étapes claires (① module sentinelle pour écrire, ② choisir les nœuds) ; bouton « Inviter » expliqué tant qu'aucune sentinelle n'est reliée.

### 🇫🇷 MeshCore : réglages conseillés en France
- **Configurateur MeshCore France** proposé là où on installe un répéteur : page « Rejoindre », maintenance MeshCore, sites proposés pour un relais.
- **Sauvegarde du configurateur importée** dans la maintenance MeshCore (fichier .json) : matériel, firmware, date et réglages gardés pour chaque répéteur (jamais les mots de passe ni la clé privée, qui ne quittent pas le navigateur).
- **Recommandations françaises vérifiées** pour chaque répéteur, d'après ce que la carte entend : numéro de département au début du nom, position annoncée, chemins sur 2 octets (path.hash.mode 1), une annonce en inondation par jour, preset français 869,618 MHz · 62,5 kHz · SF8 · CR8.

### 🤝 Page « Rejoindre le réseau »
- **Réseau MeshCore seul** : lien du canal et limite de sauts laissés vides, la page n'affiche plus la partie Meshtastic (comme la partie MeshCore quand elle est vide).
- **Partie MeshCore complétée** : régions des répéteurs, bouton « preset français » qui remplit tout, commandes minimales d'un répéteur générées pour la page, liens vers le configurateur et les réglages conseillés.

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
