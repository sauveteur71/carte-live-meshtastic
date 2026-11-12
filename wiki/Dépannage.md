# Dépannage

### `getaddrinfo ENOTFOUND` dans le journal
L'adresse du broker est mal écrite (par exemple `mqttgaulix.fr` au lieu de `mqtt.gaulix.fr`). Corrigez `MQTT_URL` (ou *Gestion › Réglages*), puis `docker compose up -d`.

### Le broker MQTT du `.env` n'est pas pris en compte
- Après avoir modifié le `.env` : **`docker compose up -d`** (un `docker compose restart` ne relit pas le `.env`).
- Si le broker a été réglé dans l'assistant ou dans *Gestion › Réglages*, ce réglage **remplace** le `.env` : la page le signale. Corrigez-le sur la page, ou cliquez **Revenir au .env**.
- Depuis la 2.11.2, l'assistant n'enregistre plus les valeurs reprises telles quelles du `.env` : seules celles que vous changez remplacent le `.env`.

### Impossible de se connecter juste après l'installation
- Attendez la fin du redémarrage qui suit l'assistant (une dizaine de secondes), puis rechargez la page.
- Identifiant : celui saisi dans l'assistant (majuscules indifférentes depuis la 2.11.2) ou l'indicatif.
- « Trop d'échecs… bloqué jusqu'à … » : 3 essais faux en 15 min bloquent l'adresse 15 min. Attendez, ou débloquez depuis un autre compte admin (*Gestion › Journal*). Depuis le réseau local, seule l'adresse est bloquée, jamais le compte.
- Derrière un proxy inversé, vérifiez que la carte voit l'adresse des visiteurs (voir [[Comptes et sécurité]]).

### L'installation demande un code que je n'ai pas
`docker compose logs carte-live | grep -i installation` affiche le code. Ou mettez une valeur dans `ADMIN_MOT_DE_PASSE` (`.env`) et redémarrez.

### « hôte injoignable » (EHOSTUNREACH) pour un module Wi-Fi
Le serveur n'est pas sur le même réseau que le module. Passez par *Connecter un module* avec l'**agent 1.6** lancé sur un PC de ce réseau, ou par le Bluetooth ou l'USB depuis le navigateur.

### Le Bluetooth ne trouve pas le module
Carte en **HTTPS**, **Chrome ou Edge**, appli du téléphone déconnectée. Sur un ESP32 Meshtastic, le Bluetooth est coupé quand le Wi-Fi est activé. Appairez le module dans Windows si besoin (code affiché ou `123456`).

### La programmation à distance échoue souvent
- Regardez le message : clé refusée ou problème radio (voir [[Programmation à distance]]).
- Utilisez **Insister 2 h**.
- Programmez depuis un module qui entend bien le nœud : un module de carte mal placé fait échouer beaucoup de demandes.

### Je n'ai pas de retour à mes messages
Regardez sous le message : « relayé », « reçu », et la liste des récepteurs. Si aucun récepteur ne l'a remonté, le module de la carte n'atteint personne : envoyez depuis un module mieux placé. Pour vérifier un correspondant précis, envoyez-lui un message direct (accusé ✓✓).

### Un nœud solaire disparaît la nuit
Batterie ou panneau insuffisants : il n'émet qu'au soleil. Activez sa télémétrie (30 min) pour suivre la tension, vérifiez les accus et l'orientation du panneau.

### « évincé par un autre client du module »
Un autre appareil (souvent l'appli du téléphone en Wi-Fi) s'est connecté au module. Un module n'accepte qu'un client à la fois.

### Les liaisons de l'autre réseau restent affichées
Mettez la carte à jour (2.0.0) : la bascule Meshtastic ↔ MeshCore efface désormais les traces de l'autre réseau.

## Diagnostic intégré
*Réglages › 🩺 Diagnostic* (administrateur, ou ⚙️🔎 « diagnostic ») vérifie en une fois : serveur MQTT, arrivée des messages, part de paquets déchiffrés, module Meshtastic, module MeshCore, paquets MeshCore ignorés (code de zone, périmètre), liaisons de la passerelle, mise à jour, taille de la base et place sur le disque. Chaque point à regarder explique quoi faire et propose le bouton qui mène au bon réglage.

## Masquer les points hauts et les sites proposés
*Couches ▾ › Points hauts* : un clic les masque, un autre les réaffiche. Le choix est gardé pour la prochaine visite. Pour les masquer par défaut sur toute la carte : `CARTE_COUCHES_MASQUEES=sommets` dans le `.env`.

## Companion MeshCore en USB « relié, mais muet »
L'ouverture du port USB redémarre souvent le companion. Depuis la 2.1.1, la carte lui redemande ses informations plusieurs fois pendant une trentaine de secondes. S'il reste muet :
- vérifiez qu'il a bien le firmware **companion USB** (et non companion BLE ou répéteur) ;
- fermez toute autre appli qui utilise le port ;
- bouton **↻ Relancer** dans *MeshCore › Companion*, ou débranchez et rebranchez.

## Module branché en USB : est-il bien relié en USB ?
*MeshCore › Companion* indique la liaison : « relié · relié par cette page… (**USB** …) » ou « (**Bluetooth** …) ». Un companion MeshCore a soit le firmware **companion USB**, soit **companion BLE** : le second ne répond pas sur le câble. Depuis la 2.1.3, *Connecter un module* le dit, au lieu de prendre le module pour un module Meshtastic.

L'agent n'est **pas** nécessaire pour l'USB ou le Bluetooth d'une page : c'est la page qui relaie le module, tant que l'onglet reste ouvert et que le PC ne se met pas en veille. L'agent sert pour un module qui doit rester relié sans navigateur ouvert.

## Module relié par une page qui se déconnecte au bout de quelques minutes
Souvent un proxy inversé (nginx, Traefik, Cloudflare) qui coupe les WebSockets silencieuses. Depuis la 2.1.3, le serveur envoie un « ping » toutes les 25 s et la page se reconnecte toute seule (USB comme Bluetooth). Avec nginx, prévoyez aussi `proxy_read_timeout 3600s;` et les en-têtes `Upgrade` / `Connection` pour `/ws`.
