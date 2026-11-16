# Domotique et supervision

La carte peut alimenter **Home Assistant**, **Node-RED** et **Prometheus / Grafana**, et retrouver toute seule les modules Wi-Fi du réseau local.

## Home Assistant et Node-RED (MQTT)

*Réglages › Réglages avancés › « Domotique (Home Assistant, Node-RED) »* :

| Réglage | Rôle |
|---|---|
| Broker MQTT de la domotique | Par exemple `mqtt://homeassistant.local:1883` (module complémentaire « Mosquitto broker » de Home Assistant). Vide = rien n'est publié. |
| Utilisateur, mot de passe | Un compte du broker (dans Home Assistant : un utilisateur dédié, par exemple `carte-live`). |
| Racine des sujets | `carte-live` par défaut. |
| Découverte automatique | Oui par défaut : Home Assistant crée tout seul les entités. |
| Accepter les messages à envoyer en LoRa | Non par défaut. |
| Canal Meshtastic des messages | Canal du module utilisé pour ces messages (0 par défaut). |

L'état apparaît dans *Outils › Broker MQTT*, rubrique « Domotique ».

### Ce que Home Assistant reçoit
Un appareil **Carte live** avec : nœuds actifs, passerelles en ligne, paquets par minute, occupation du canal, couverture calculée, alertes actives (la liste en attributs), nœuds MeshCore actifs, et un capteur binaire **Alerte critique**.

Chaque **nœud surveillé** (relais, passerelles, nœuds suivis, répéteurs MeshCore) devient un appareil : **en ligne** (connectivité), **dernier paquet**, **batterie** et **tension** quand le nœud les envoie, et sa **position** sur la carte de Home Assistant.

Exemple d'automatisation : *quand « Alerte critique » passe à « Problème », m'envoyer une notification*.

### Sujets MQTT (Node-RED et autres)
| Sujet | Contenu |
|---|---|
| `carte-live/disponibilite` | `online` / `offline` |
| `carte-live/etat` | Résumé du réseau (JSON, conservé) |
| `carte-live/alertes` | Alertes actives (JSON, conservé) |
| `carte-live/alerte` | Chaque **nouvelle** alerte, au moment où elle apparaît (non conservé) : idéal pour un flux Node-RED |
| `carte-live/noeud/<id>` | État d'un nœud surveillé (JSON, conservé) |
| `carte-live/envoyer` | **Message à envoyer en LoRa** (voir ci-dessous) |
| `carte-live/envoyer/resultat` | Réponse : `{"ok":true,"id":…}` ou `{"ok":false,"erreur":…}` |

Rien n'est republié tant que rien ne change.

### Envoyer un message LoRa depuis la domotique
Avec « Accepter les messages à envoyer en LoRa » à **oui**, publiez sur `carte-live/envoyer` :
- un texte simple : `Coupure de courant au relais du Mézenc` ;
- ou du JSON : `{"texte":"…","canal":1}` ou `{"texte":"…","vers":"!a1b2c3d4"}` pour un message direct.

Dans Home Assistant, l'entité **Message LoRa** (zone de texte) fait la même chose. Le module radio de la carte doit être connecté. Garde-fous : 200 octets au plus, un message toutes les 20 secondes, chaque envoi noté dans le journal.

## Prometheus et Grafana : surveiller les relais
L'adresse `/metrics` (protégée par le jeton d'export s'il est réglé) donne, en plus des chiffres du réseau, **une ligne par nœud surveillé** :

| Métrique | Sens |
|---|---|
| `carte_noeud_en_ligne` | 1 si entendu récemment, 0 sinon |
| `carte_noeud_vu_secondes` | Secondes depuis le dernier paquet |
| `carte_noeud_batterie_pourcent`, `carte_noeud_tension_volts` | Énergie |
| `carte_meshcore_etat_lu_secondes` | Dernière réponse d'un répéteur MeshCore à la supervision |
| `carte_meshcore_sans_reponse` | Demandes d'état restées sans réponse de suite |
| `carte_alerte_active` | Une ligne par alerte en cours (type, niveau, nom) |

Exemple de règle Alertmanager :
```yaml
- alert: RelaisMuet
  expr: carte_noeud_en_ligne == 0
  for: 30m
  annotations:
    summary: "{{ $labels.nom }} ne s'entend plus"
```

La **supervision MeshCore** (*MeshCore › Supervision*) interroge régulièrement l'état des répéteurs. Un répéteur qui ne répond pas à **deux demandes de suite** déclenche l'alerte « pas de réponse », même s'il est encore entendu.

## Modules Wi-Fi retrouvés tout seuls (mDNS)
Les modules Meshtastic en Wi-Fi s'annoncent sur le réseau local (service `_meshtastic._tcp`). La carte les cherche **au démarrage puis toutes les 15 minutes**, et à chaque clic sur « Rechercher » dans *Connecter un module*. Les modules trouvés sont **ajoutés à la liste, sans connexion** : il reste à choisir celui à utiliser. Le nom donné par un administrateur n'est jamais remplacé.

Avec Docker, il faut le réseau `host` (comme pour l'écoute UDP). Pour arrêter : *Réglages avancés › Module radio › « Retrouver les modules Wi-Fi du réseau local (mDNS) »* à **non**.
