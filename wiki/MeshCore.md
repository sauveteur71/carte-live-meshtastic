# MeshCore

La carte affiche MeshCore **seul ou superposé** à Meshtastic : répéteurs, room servers, companions, capteurs, observateurs, liaisons mesurées et déduites, analyseur de paquets en direct.

## Le companion de la carte
Onglet **MeshCore › Companion** (administrateur). Le companion sert d'**observateur** : il transmet à la carte chaque paquet entendu, avec le SNR. Pour le relier, voir [[Connecter un module]] : Wi-Fi (port 5000), USB ou Bluetooth. Le companion ne sert qu'un client à la fois.

### Outils du companion
- **📡 Qui m'entend en direct ?** : appel à 0 saut ; chaque répéteur qui l'entend répond. Tableau avec le SNR auquel **il vous entend**, celui auquel **vous l'entendez**, et la distance. Sans mot de passe, automatique toutes les 6 h.
- **📊 Bruit et statistiques** : bruit de fond, dernier SNR et RSSI, temps d'émission et de réception, erreurs, avec une **courbe du bruit sur 7 jours**. Au-dessus de −100 dBm, une source proche gêne la réception (antenne relais, alimentation…).
- **🌡️ Télémétrie** : batterie et capteurs.
- **Région par défaut** : les envois en inondation du companion ne sont relayés que par les répéteurs qui acceptent cette région.
- **Commandes sur le companion** (firmware 1.14+) et **Wi-Fi du companion** (réseau, mot de passe, activé).

## Les répéteurs
Onglet **MeshCore › Programmer** et fiche d'un répéteur :
- connexion par **mot de passe admin** (mémorisable) ;
- lecture et modification des réglages, état (batterie, bruit, émission), voisins, mise à l'heure, annonce, redémarrage, console ;
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
