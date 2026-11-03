# Brancher le réseau

## Le broker MQTT
La carte s'abonne à `MQTT_RACINE/#` (par défaut `msh/EU_868`) et, pour MeshCore, à `meshcore/#`.
- Les passerelles Meshtastic de votre réseau doivent publier sur ce broker (*Module MQTT* activé, canal avec « envoi vers MQTT »).
- Le compte MQTT de la carte doit pouvoir **lire** `msh/#` et **lire et écrire** `meshcore/#`.
- Un exemple de broker Mosquitto (TLS, comptes, droits) est fourni dans le dossier `mosquitto/` du dépôt.

## Les canaux Meshtastic
Pour lire positions, messages et télémétrie, la carte doit connaître la clé de chaque canal : *Gestion › Réglages*, ou `CANAUX` dans `.env`.
- Format : `NomDuCanal=cléBase64`, séparés par `;`.
- `AQ==` désigne la clé publique par défaut (canal LongFast…).
- Les clés des canaux privés se trouvent dans l'appli Meshtastic (canal › partager) ou dans le QR code du canal.

Les paquets chiffrés avec une clé inconnue s'affichent comme « chiffrés » : on voit qu'ils passent, mais pas leur contenu.

## Les protobufs, c'est quoi ?
Meshtastic écrit tous ses messages (positions, télémétrie, messages, configuration…) dans le format binaire **Protocol Buffers**. Le dépôt [meshtastic/protobufs](https://github.com/meshtastic/protobufs) décrit ce format. La carte les embarque déjà et les tient à jour : **il n'y a rien à installer**. L'option « JSON » du module MQTT n'est pas nécessaire (et elle est incomplète).

## Le module radio de la carte
Facultatif pour regarder la carte, **indispensable pour programmer les nœuds à distance** et pour envoyer des messages. Voir [[Connecter un module]].

## Les canaux MeshCore
Voir [[MeshCore]] : `Public`, `#nom` pour un canal hashtag (le nom exact suffit), `Nom=secret` pour un canal privé.
