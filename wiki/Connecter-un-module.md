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

Exemple : le module de Saint-Vincent reste principal, le companion du Monteil est en écoute par son adresse IP, et le module de la voiture est en écoute en Bluetooth pendant un déplacement.

## Un seul client à la fois
Un module Meshtastic n'accepte qu'un client Wi-Fi, et un companion MeshCore qu'un client. Si l'appli du téléphone se connecte au même module, la carte est « évincée » et réessaie plus tard.

## Quel module choisir pour programmer ?
Le module de la carte doit **bien entendre** les nœuds à programmer. Un module mal placé (qui entend le réseau vers −15 dB) fera échouer beaucoup de demandes. Pour une intervention, le plus efficace est de relier un module **proche du nœud** : en voiture en Bluetooth, par exemple.
