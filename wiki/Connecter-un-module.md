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

## USB
Bouton **🔌 USB**, puis choisissez le port. Fermez d'abord tout ce qui l'utilise déjà (appli, agent, autre onglet). Même conditions : HTTPS, Chrome ou Edge.

## Adresse IP (module en Wi-Fi)
Tapez l'adresse, par exemple `192.168.1.122`, puis **Connecter**. La carte cherche :
- un module **Meshtastic** sur le port **4403** ;
- un companion **MeshCore** sur le port **5000**.

Deux cas :
1. **Le serveur de la carte voit ce réseau** : la liaison est directe.
2. **Le module est sur un autre réseau** (autre maison, autre box) : la carte passe automatiquement par un PC de ce réseau qui fait tourner l'**[[Agent Gaulix]] 1.6 ou plus**. Rien à configurer sur l'agent.

Si aucun des deux n'est possible, la carte l'explique et propose le Bluetooth, l'USB ou l'installation de l'agent.

## Un seul client à la fois
Un module Meshtastic n'accepte qu'un client Wi-Fi, et un companion MeshCore qu'un client. Si l'appli du téléphone se connecte au même module, la carte est « évincée » et réessaie plus tard.

## Quel module choisir pour programmer ?
Le module de la carte doit **bien entendre** les nœuds à programmer. Un module mal placé (qui entend le réseau vers −15 dB) fera échouer beaucoup de demandes. Pour une intervention, le plus efficace est de relier un module **proche du nœud** : en voiture en Bluetooth, par exemple.
