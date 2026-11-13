# MeshCore

La carte affiche MeshCore **seul ou superposé** à Meshtastic : répéteurs, room servers, companions, capteurs, observateurs, liaisons mesurées et déduites, analyseur de paquets en direct.

## Le companion de la carte
Onglet **MeshCore › Companion** (administrateur). Le companion sert d'**observateur** : il transmet à la carte chaque paquet entendu, avec le SNR. Pour le relier, voir [[Connecter un module]] : Wi-Fi (port 5000), USB ou Bluetooth. Le companion ne sert qu'un client à la fois.

### Outils du companion
- **📡 Qui m'entend en direct ?** : appel à 0 saut ; chaque répéteur qui l'entend répond. Tableau avec le SNR auquel **il vous entend**, celui auquel **vous l'entendez**, et la distance. Sans mot de passe, automatique toutes les 6 h. Juste après, la carte demande à chaque répéteur entendu ses régions et les **infos de son propriétaire** (👤 sous son nom, si le répéteur les renseigne).
- **📊 Bruit et statistiques** : bruit de fond, dernier SNR et RSSI, temps d'émission et de réception, erreurs, avec une **courbe du bruit sur 7 jours**. Au-dessus de −100 dBm, une source proche gêne la réception (antenne relais, alimentation…).
- **🌡️ Télémétrie** : batterie et capteurs.
- **Région par défaut** : les envois en inondation du companion ne sont relayés que par les répéteurs qui acceptent cette région.
- **Commandes sur le companion** (firmware 1.14+) et **Wi-Fi du companion** (réseau, mot de passe, activé).
- **Companion en Wi-Fi** (firmware 1.18+) : le companion BLE des cartes ESP32-S3 (Heltec V3/V4, XIAO ESP32-S3…) peut aussi rejoindre votre Wi-Fi. Réglez le réseau dans l'application MeshCore (Réglages → Wi-Fi), donnez-lui une adresse fixe dans la box, puis indiquez son IP dans *Companion Wi-Fi* (port 5000).
- **Administrer un autre companion** (firmware 1.18+) : dans la fiche d'un companion, onglet **Administration**, la console et « Lire la configuration » fonctionnent sans mot de passe si son propriétaire a accordé la permission **commande à distance** au contact de la carte (application MeshCore → contact → Permissions).

## Les répéteurs
Onglet **MeshCore › Programmer** et fiche d'un répéteur :
- connexion par **mot de passe admin** (mémorisable) ;
- lecture et modification des réglages, état (batterie, bruit, émission), voisins, mise à l'heure, annonce, redémarrage, console (flèches ↑ ↓ pour rappeler les commandes déjà envoyées ; celles qui contiennent un mot de passe ne sont jamais gardées) ;
- en cas d'échec, le message donne le **nom du répéteur et le début de sa clé** ;
- **Tracer** : aller-retour le long du chemin avec le **SNR de chaque saut**, sans mot de passe ; fait aussi chaque nuit vers 3 h pour les répéteurs surveillés ;
- **Télémétrie** des répéteurs et capteurs ;
- **région d'attache** et région d'envoi lues avec la configuration ;
- **lecture ciblée** : seulement les réglages cochés (*Lecture ciblée*), au lieu de tout relire ;
- **🔑 Mots de passe** : changer le mot de passe admin (le mot de passe mémorisé suit) et le mot de passe invité, ou le retirer. Les nouveaux mots de passe ne sont jamais enregistrés dans l'historique des opérations ;
- **🗺️ Régions** : lire l'arbre des régions, la région d'attache et la région d'envoi ; créer (`put`), autoriser ou bloquer les inondations d'une région (`allowf` / `denyf`, `*` pour les paquets sans région), définir l'attache (`home`) et la région d'envoi (`default`), supprimer (`remove`) ; enregistrement (`region save`) et relecture automatiques ;
- **📋 Modèles** : réglages types (préremplis depuis un répéteur lu), actions de régions, mise à l'heure et redémarrage, appliqués à plusieurs répéteurs en une fois. Nom, position, contact et mot de passe n'en font jamais partie. Un modèle **« Répéteur de base (FR-43) »** est fourni :

  | Réglage | Valeur |
  |---|---|
  | advert.interval | 240 |
  | flood.advert.interval | 24 |
  | agc.reset.interval | 4 |
  | multi.acks | 1 |
  | dutycycle | 10 |
  | path.hash.mode | 1 (2 octets) |
  | loop.detect | minimal |
  | flood.max.unscoped | 3 |
  | flood.max.advert | 5 |
  | régions | `def eu fr fr-ara fr-43`, `default fr`, `home fr`, enregistrement |
  | puis | mise à l'heure et redémarrage |

- **🚀 Mise en service** (fiche du répéteur) : un modèle, le nom, la position (préremplie depuis la carte), le contact (`owner.info`) et un nouveau mot de passe admin, en une seule opération ;
- **Insister 2 h** : les répéteurs en échec passager sont repris toutes les 10 min pendant 2 h ; chaque nœud affiche l'heure de sa réussite ou de son échec ;
- **vérification de conformité** et « Aligner sur la référence » ;
- **supervision** automatique et alertes (muet, batterie, émission, brouillage).

Les liaisons mesurées (découverte, traces) s'affichent sur la carte et dans la topologie.

## Chemin depuis le companion
Le companion retient, pour chaque contact, le **chemin** (liste des répéteurs) appris au dernier échange. Si ce chemin est faux (répéteur déplacé, éteint, liaison tombée), les messages directs n'arrivent plus alors que le nœud est joignable. La fiche du nœud (onglet *Infos*) et le clic droit **🧭 Chemin depuis le companion** montrent :
- **Inondation** (aucun chemin) ou **Direct** (0 saut), ou la liste des répéteurs avec leur nom quand il est connu ;
- **↺ Réinitialiser** (gestionnaire) : efface le chemin, le prochain envoi part en inondation et le bon chemin est réappris au retour, comme « Reset path » dans l'application officielle ;
- **Forcer en direct** : 0 saut, si le nœud est à portée du companion ;
- **Forcer un chemin** : identifiants des répéteurs du companion vers le nœud, séparés par des virgules (`A3,7F`, ou `A3F1,7F02` en identifiants de 2 octets ; tous de la même taille). L'identifiant d'un répéteur est le début de sa clé (voir sa fiche).

Le nœud doit être dans les contacts du companion (lui avoir écrit, ou l'avoir administré). Chaque changement est inscrit dans l'historique des opérations.

## Supprimer un nœud disparu
Clic droit sur le nœud › **🗑 Supprimer ce nœud** (administrateur) : il est effacé de la carte et de la base (télémétrie, capteurs, liaisons) et retiré des contacts du companion. S'il émet de nouveau, il réapparaîtra.

## Capteurs : relevés périodiques et courbes
Fiche d'un répéteur, salon ou capteur, onglet **Capteurs** :
- **Relever toutes les…** : 15 min, 30 min, 1 h, 3 h, 6 h, 12 h ou 24 h (ou jamais). La carte lance elle-même la tâche « télémétrie » par le companion. Le nœud doit autoriser la télémétrie (mot de passe invité ou admin mémorisé, ou télémétrie ouverte). Chaque relevé envoie un paquet : 1 h ou plus suffit pour un abri ou une batterie ;
- **Relever maintenant** ;
- une **courbe par mesure** (tension, température, humidité, pression, courant…) sur 1, 7, 30 ou 90 jours, avec dernier, minimum et maximum ;
- **✏️ libellé** : renommez chaque mesure (« Batterie », « Abri », « Panneau solaire ») au lieu de « tension 1 » ;
- **🔔 Alerte** : un seuil bas et/ou haut par mesure. Quand le dernier relevé en sort, une alerte MeshCore s'affiche (onglet Réseau) et le navigateur envoie une notification si la carte est ouverte ;
- **🙈 Masquer** : retire de l'affichage une mesure non pertinente (voie non câblée à 0 V…). Elle reste enregistrée et dans l'export CSV, sans alerte ; *Mesures masquées* permet de la réafficher ;
- **⬇ CSV** : export des relevés de la période affichée (séparateur « ; », virgule décimale, pour un tableur).
- **🗑** (sur une mesure) : efface cette mesure, tout son historique, son nom et son alerte ; elle revient au prochain relevé si le capteur l'envoie encore ;
- **♻ Remettre à zéro** (en bas de l'onglet) : après un renommage, un recâblage ou une mise à jour du capteur, les canaux peuvent changer de sens et les anciens noms ne correspondent plus. Au choix : effacer tout l'historique, seulement les relevés antérieurs à une date, ou le garder ; et effacer les noms des mesures, les alertes et le masquage. L'intervalle de relevé est gardé.

Les relevés faits à la main depuis l'administration alimentent aussi les courbes. L'historique est gardé 90 jours.

## Republication MQTT et canaux
- **Republier les paquets du companion** : publiés sur votre broker sous `meshcore/IATA/CLÉ/packets` (format meshcoretomqtt), pour les autres cartes.
- **Code de zone (IATA)** : 3 lettres, par exemple `LPY` pour le Puy.
- **Paquets conservés** : département, département et voisins, ou national (lourd).
- **Codes de zone voisins** : pour accepter des observateurs sans position (ex. `CFE, LYS, EBU`).
- **Canaux à déchiffrer**, un par ligne :

| Ligne | Canal |
|---|---|
| `Public` | canal public par défaut |
| `#haute-loire` | canal hashtag : le nom exact suffit, # compris |
| `ADRASEC=0123…cdef` | canal privé : son secret de 32 caractères hexadécimaux |

Les canaux déjà présents dans le companion relié sont déchiffrés automatiquement.

## Topologie et simulation MeshCore
*Outils › Topologie et simulation MeshCore* : voir [[Topologie et simulation]].

## Audit des régions et collisions d'identifiants
Dans *MeshCore › Programmer* :

**🏷 Audit des régions.** Pour chaque répéteur de la zone, la carte compare deux choses :
- **Déclare** : les régions réglées sur le répéteur. Il les annonce sans mot de passe à un companion qui l'entend en direct, avec le bouton « 📡 Demander leurs régions… ». La demande est aussi refaite toutes les 6 h, après la découverte automatique.
- **Relaie** : les étiquettes de région des paquets en inondation dont le chemin passe par lui (1, 2 ou 7 jours).

Un écart est signalé en orange :
- une région déclarée mais jamais relayée ;
- une région relayée mais pas déclarée ;
- des messages sans région relayés alors qu'il ne les accepte pas.

C'est l'outil pour vérifier une mise en service, par exemple avec le modèle « Répéteur de base (FR-43) ».

**🔀 Collisions d'identifiants.** Dans un chemin, chaque relais n'est noté que par le début de sa clé : 1 octet par défaut. Deux répéteurs proches qui commencent pareil rendent le parcours ambigu. Le tableau liste ces répéteurs, avec la distance entre les plus proches, et la part des chemins encore à 1 octet. Le remède : `set path.hash.mode 1` (2 octets).

**Taille des hachages de chaque répéteur.** Sous les collisions, la carte lit la taille de hachage que chaque répéteur utilise dans ses propres annonces (14 jours) et signale ceux qui diffèrent de la majorité, avec la commande à passer (`set path.hash.mode N`). Un répéteur en retard d'une taille coupe les chemins des autres. L'écart est aussi remonté dans les alertes MeshCore.

## Alertes de maintenance MeshCore
Dans l'onglet **Réseau**, avec les autres alertes MeshCore, la carte signale d'elle-même (à partir des versions lues par « Lire la configuration », commandes `ver` et `board`) :
- un **avis connu** sur un nœud : firmware à problème (1.17.0 sur Heltec T096, qui n'émet pas correctement : passer en 1.17.1) ou matériel sous avis du fabricant (Elecrow ThinkNode M9 : avis sur la carte SD) ;
- un **room server encore en mode répéteur** (`repeat on`) : ce mode est abandonné depuis le firmware 1.18, mettez `set repeat off` et un répéteur dédié pour relayer ;
- une **nouvelle version MeshCore publiée** (moins de 3 semaines) alors que des répéteurs ou room servers de la zone sont en retard, avec leurs noms ;
- un **répéteur dont la taille de hachage diffère** du reste du réseau.

## Courbes de puissance
Quand un capteur envoie une tension et un courant sur la même voie, la carte ajoute une courbe **Puissance (calculée U × I)** si le capteur ne donne pas de puissance, ou si la puissance qu'il donne s'écarte de plus de 10 % du calcul.

**Liaisons déduites des chemins et taille des hachages.** La carte lit chaque chemin avec sa vraie taille (1, 2 ou 3 octets) : un chemin en 2 octets est résolu sur 2 octets. Mais la taille est choisie par l'émetteur du paquet (réglage de son application ou companion), donc beaucoup de paquets circulent encore en 1 octet, où deux répéteurs peuvent partager le même préfixe. Par défaut, seules les liaisons tirées de chemins en **2 octets ou plus** sont tracées ; les liaisons directes (0 saut), mesurées et tracées ne changent pas. Réglage : *MeshCore › Companion › Liaisons déduites des chemins*, ou `MESHCORE_LIENS_OCTETS_MIN` (1, 2 ou 3).
