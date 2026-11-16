# Nouveautés par version

Le texte de la section de chaque version est repris tel quel dans la note de la release GitHub.

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
