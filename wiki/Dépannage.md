# Dépannage

### `getaddrinfo ENOTFOUND` dans le journal
L'adresse du broker est mal écrite (par exemple `mqttgaulix.fr` au lieu de `mqtt.gaulix.fr`). Corrigez `MQTT_URL` (ou *Gestion › Réglages*), puis `docker compose up -d`.

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
