# Connecter un module

Un **module radio** relié à la carte lui permet de capter le trafic directement, d'envoyer des messages et de **programmer les nœuds à distance**. Tout se fait depuis **Outils › 🔌 Connecter un module…**. La carte reconnaît toute seule s'il s'agit d'un module **Meshtastic** ou d'un companion **MeshCore**.

## Bluetooth
1. Ouvrez la carte en **HTTPS** dans **Chrome ou Edge** (pas Firefox ni Safari).
2. Bouton **📶 Bluetooth**, puis choisissez le module.
3. Windows peut demander un **code PIN** : celui affiché par le module, sinon `123456`.

Gardez l'onglet ouvert : c'est la page qui relaie le module vers la carte.

Les pièges habituels :
- **L'appli du téléphone doit être déconnectée** : un module n'accepte qu'une liaison Bluetooth à la fois.
- **Meshtastic sur ESP32** (Heltec, T-Beam…) : le Bluetooth est coupé tant que le Wi-Fi est actif. Utilisez l'adresse IP, ou désactivez le Wi-Fi.
- En rôle ROUTER, l'économie d'énergie peut endormir le Bluetooth (*Config › Power*).
- Si la connexion échoue, appairez d'abord le module dans les réglages Bluetooth de Windows.

### Coupures du Bluetooth
Si la liaison se coupe, la page **se reconnecte toute seule** : toutes les 5 s pendant 30 s, puis toutes les 30 s pendant 15 min. Il ne faut rien faire, mais l'onglet doit rester ouvert. « Débrancher » arrête ces essais.

Pour limiter les coupures :
- fermez l'appli MeshCore ou Meshtastic du téléphone : dès qu'elle voit le module libre, elle le reprend ;
- sous Windows, dans le Gestionnaire de périphériques › Bluetooth › votre adaptateur › Gestion de l'alimentation, décochez « Autoriser l'ordinateur à éteindre ce périphérique » ;
- empêchez la mise en veille du PC pendant l'usage ;
- rapprochez le module : le Bluetooth d'un PC porte peu et le Wi-Fi 2,4 GHz le brouille ;
- pour un module fixe en Wi-Fi, préférez l'**adresse IP** : la liaison est permanente et ne dépend pas d'un onglet ouvert.

## USB
Bouton **🔌 USB**, puis choisissez le port. Fermez d'abord tout ce qui l'utilise déjà (appli, agent, autre onglet). Même conditions : HTTPS, Chrome ou Edge.

**Ensuite, plus rien à faire** : un module autorisé une fois est relié tout seul, au chargement de la page et dès qu'on le branche. Meshtastic ou companion MeshCore est reconnu automatiquement ; débranché, il est libéré, et le suivant branché prend sa place. Réglage dans *Réseau › Modules*, cadre « Module de ce PC » (« 🔁 Relier tout seul les modules USB de ce PC », comme module principal ou en écoute). Pour un PC où la page n'est pas ouverte, utilisez l'[[Agent Gaulix]] prêt à l'emploi.

## USB du serveur (module branché sur le NAS ou le Raspberry Pi)
Le module (Meshtastic ou companion MeshCore USB) est branché **sur la machine qui fait tourner la carte**, comme avec Remote Terminal for MeshCore ou MeshMonitor. Ni navigateur ni agent : la liaison est permanente et reprend seule après un redémarrage.

1. Sur la machine, repérez le port : `ls /dev/ttyACM* /dev/ttyUSB*` (ou `ls /dev/serial/by-id/`, nom stable conseillé).
2. Dans `docker-compose.yml`, décommentez et adaptez :
   ```yaml
       devices: ["/dev/ttyACM0:/dev/ttyACM0"]
       group_add: ["dialout"]
   ```
   Ces deux lignes vont dans le service `carte-live`, au même retrait que `mem_limit` (pas sous `volumes:`).
   puis `docker compose up -d`.
3. *Outils › Connecter un module › 🖥️ USB du serveur* : la carte liste les ports vus, reconnaît le type de module et le relie comme **principal** ou **en écoute**.

Le port est réglé à 115 200 bauds. Fermez tout autre programme qui utiliserait le même port sur la machine.

## Adresse IP (module en Wi-Fi)
Tapez l'adresse, par exemple `192.168.1.122`, puis **Connecter**. La carte cherche :
- un module **Meshtastic** sur le port **4403** ;
- un companion **MeshCore** sur le port **5000**.

Deux cas :
1. **Le serveur de la carte voit ce réseau** : la liaison est directe.
2. **Le module est sur un autre réseau** (autre maison, autre box) : la carte passe automatiquement par un PC de ce réseau qui fait tourner l'**[[Agent Gaulix]] 1.6 ou plus**. Rien à configurer sur l'agent.

Si aucun des deux n'est possible, la carte l'explique et propose le Bluetooth, l'USB ou l'installation de l'agent.

## Écoute du réseau local (UDP, sans occuper le module)
Les modules **Meshtastic** en Wi-Fi (firmware 2.6 ou plus) peuvent diffuser sur le réseau local tout ce qu'ils entendent. La carte les écoute sans se connecter à eux : **l'appli du téléphone reste connectée**, et chaque module de la maison alimente la carte sans agent ni réglage par module.

1. Sur chaque module : appli Meshtastic › *Réseau* › *Protocoles activés* › **UDP broadcast**.
2. Dans la carte : *Réglages › Réglages avancés › « Écouter les modules Meshtastic du réseau local »* → **oui**.
3. Avec Docker, le multicast du réseau local n'atteint le conteneur qu'en **réseau « host »** : dans `docker-compose.yml`, service `carte-live`, ajoutez `network_mode: host` et retirez la section `ports:` (la carte répond alors directement sur le port 8095 de la machine).

L'état (paquets reçus, modules entendus) se lit dans *Réseau › Broker MQTT*, rubrique « Modules du réseau local (UDP) ». Les paquets sont chiffrés comme sur l'air : la carte les déchiffre avec les clés de canaux qu'elle connaît.

## Plusieurs modules en même temps
Pour chaque réseau, Meshtastic et MeshCore, la carte a **un module principal**. Il écoute, envoie les messages, lance les traceroutes et sert à l'administration.

D'autres modules peuvent être reliés **en écoute**, en plus du principal. Chacun devient une passerelle supplémentaire :
- ce qu'il entend s'ajoute à la carte avec son propre SNR et son nombre de sauts ;
- les liaisons et les parcours des messages sont donc vus depuis plusieurs points ;
- un paquet entendu par plusieurs modules est compté comme un seul paquet, avec plusieurs réceptions, comme pour les passerelles MQTT.

Comment en ajouter un :
- **Connecter un module** : choisissez « 👂 en écoute, en plus » avant de cliquer sur Bluetooth, USB ou Connecter (adresse IP). Si un module principal est déjà relié, ce choix est proposé d'emblée.
- **Réseau › Modules radio** : bouton **👂 En écoute** sur un module connu.
- **MeshCore › Companion** : bouton **👂** à côté d'un agent, ou **👂 En écoute** à côté de l'adresse Wi-Fi.

Ensuite :
- **⭐ Principal** échange les rôles : le module en écoute devient principal, l'ancien principal passe en écoute.
- **Arrêter l'écoute** le retire.
- Les modules en écoute par adresse IP ou par agent sont conservés au redémarrage de la carte. Ceux d'une page (Bluetooth, USB) durent tant que l'onglet est ouvert.

Limites :
- Depuis une même page, un seul module Bluetooth ou USB par réseau. Les autres se relient par adresse IP ou par agent.
- Un PC qui sert de relais du réseau local ([[Agent Gaulix]] 1.6) ne relaie qu'un module à la fois.

Exemple : le module de Saint-Vincent reste principal, le companion de la maison est en écoute par son adresse IP, et le module de la voiture est en écoute en Bluetooth pendant un déplacement.

## Un seul client à la fois
Un module Meshtastic n'accepte qu'un client Wi-Fi, et un companion MeshCore qu'un client. Si l'appli du téléphone se connecte au même module, la carte est « évincée » et réessaie plus tard.

## Quel module choisir pour programmer ?
Le module de la carte doit **bien entendre** les nœuds à programmer. Un module mal placé (qui entend le réseau vers −15 dB) fera échouer beaucoup de demandes. Pour une intervention, le plus efficace est de relier un module **proche du nœud** : en voiture en Bluetooth, par exemple.

## Passerelle d'un membre (📡 Devenir passerelle)
Un membre connecté, même s'il n'est pas administrateur, peut relier **sa propre radio** à la carte depuis son ordinateur, sans rien installer : **Outils › 📡 Devenir passerelle…**, puis **USB** ou **Bluetooth** (Chrome ou Edge, carte en **HTTPS**). C'est utile pour un opérateur ADRASEC en mission, un membre qui habite dans un trou de couverture, ou une association qui veut faire profiter la carte de ses radios.

- La radio reste **en écoute** : elle ajoute ce qu'elle entend à la carte (avec sa mesure SNR/RSSI, comme une passerelle MQTT), mais elle n'émet rien pour la carte. Les envois de messages et l'administration des nœuds passent toujours par le module principal, réservé aux administrateurs.
- Son nom porte l'identifiant du membre (ex. « Radio USB · Paul ») : elle ne peut jamais prendre la place d'un autre module.
- **Deux radios par compte** au plus, débit limité (une radio normale reste très en dessous).
- Gardez l'onglet ouvert : le relais s'arrête si la page se ferme ou si le PC se met en veille.
- L'administrateur voit chaque passerelle dans **Modules radio** (« 📡 passerelle de Paul ») et peut la **couper** : elle est alors refusée pendant 12 h.
- Réglage : **Réglages avancés › Module radio › Passerelles des membres** (oui par défaut, « non » pour réserver le relais aux administrateurs).

> ⚠️ Sur une carte en simple **HTTP** (ex. `http://mon-serveur:8095`), les navigateurs bloquent l'USB et le Bluetooth : il faut une adresse en **HTTPS** (certificat Let's Encrypt derrière un reverse proxy, ou adresse Tailscale en …ts.net).

### Écrire les canaux de la communauté sur sa radio
Une fois la radio reliée, le panneau **🎚️ Canaux de la radio** montre ses 8 emplacements et les **jeux de canaux** proposés :
- le jeu de la **carte**, réglé par un administrateur (bouton ✏️ Régler ce jeu) ;
- celui de son **ADRASEC**, réglé par le président ou un responsable (page ADRASEC › Gestion › Canaux).

Le membre coche les canaux voulus et clique **Écrire sur la radio** ; la carte les écrit puis relit la radio pour contrôle. S'il manque de la place, la carte demande quels canaux **libérer** (aucun n'est supprimé sans être coché) ; les canaux gardés restent groupés à partir de 1, avec leurs réglages. Le canal 0 (principal, qui fixe la fréquence) n'est **jamais** touché. Un avertissement rappelle quand un canal coché est **en clair** (clé publique) : aucune donnée personnelle dessus.

**Les clés ne quittent jamais le serveur** : elles sont chiffrées sur disque (même clé maîtresse que les équipes, `CLE_EQUIPES`), une page n'en voit que le nom, et ceux qui règlent un jeu ne voient qu'une empreinte courte. Pour une clé privée, choisissez « nouvelle clé privée (aléatoire) » ou collez la clé existante (base64, 16 ou 32 octets).

