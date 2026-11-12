# Signalements

Pour signaler un événement de terrain (route inondée, arbre sur la route, accident, point de rassemblement…) et le faire **remonter en LoRa**. Réservé aux membres connectés.

## Signaler
Clic droit (ou appui long) sur la carte › **🚩 Signaler un événement ici**, puis :
- une **catégorie** (Routes, Crise, Secourisme, Météo, Statut, SDIS, ADRASEC) et un **type** : ce sont les mêmes que **GerMaCrise / Bipper** (F4EED), avec le même emoji et la même icône ;
- un titre, des précisions (140 caractères) et une **durée** (2 h à 7 jours) ;
- **Meshtastic** : les canaux du module où envoyer. Par défaut **Fr_Balise** et **Alerte**, comme GerMaCrise ; la carte retient ensuite votre dernier choix ;
- **MeshCore** : un canal du companion, si le companion est relié.

## Tronçon ou zone
**Forme** : *Un point* (par défaut), *Un tronçon* (route inondée entre deux points ou plus) ou *Une zone* (périmètre). Pour un tronçon ou une zone, touchez la carte pour poser les points suivants (« Retirer le dernier » pour corriger). Le tracé s'affiche en rouge sur la carte et sur la carte publique. En LoRa, le point de passage reste au premier point ; le message texte d'un tronçon donne aussi son point d'arrivée.

## Alertes Bipper / GerMaCrise
*Outils › 🚩 Signalements*, bloc **📟 Alertes Bipper** (gestionnaires) : type (alerte, secours, vigilance, info), canal (par défaut **Alerte**), texte et entités visées. La carte envoie `#alerte N texte #entité` avec un numéro qui s'incrémente, au format des pagers Bipper et de GerMaCrise (F4EED). Les **accusés de lecture** des pagers (`Pager ACK alerte #N …`) s'affichent sous l'alerte, avec le nom du nœud. **✅ Clôturer** envoie `#fin N`.

## Ce qui part en LoRa
- **Meshtastic** : un **point de passage** (*waypoint*, port 8) sur chaque canal coché, 500 ms d'écart, priorité alerte, sans accusé (comme GerMaCrise). Il apparaît sur la carte des applis Meshtastic avec son icône et disparaît à la fin de la durée choisie, et sur les Bipper / GerMaCrise. En option (coché par défaut), un **message texte** sur les mêmes canaux : `🌊 Axe inondé : RD 103… · 45.07401,3.90015 · F4GLD`.
- **MeshCore** : le même message texte sur le canal choisi (coupé à 140 octets).
- L'état de chaque envoi (✔ envoyé, ⚠ échec et sa raison) est affiché sur le signalement.

## Sur la carte
Les signalements actifs ont un marqueur rouge avec leur icône. Un clic : détails, auteur, heure, état des envois, et
- **✅ Terminé** : un message de fin part sur les mêmes canaux et le point de passage est retiré des applis ;
- **↻ Renvoyer** : renvoie le signalement (par exemple après avoir relié le module).

*Outils › 🚩 Signalements* liste les signalements actifs et ceux des 7 derniers jours.

## Sans réseau
Pas de connexion au moment de signaler (zone blanche, réseau coupé) : le signalement est **gardé sur l'appareil** (marqueur orange en pointillés), puis **envoyé tout seul** au retour du réseau, avec l'heure à laquelle il a été fait. *Réessayer maintenant* force l'envoi. La dernière liste de signalements connue reste affichée hors connexion. Avec *Outils › Mode terrain*, les fonds de carte du secteur peuvent aussi être préparés à l'avance.

## Carte publique et main courante
- Les signalements **en cours** s'affichent aussi sur la **carte publique** (`/publique`), en lecture seule : type, titre, précisions et heure, sans l'auteur.
- **📋 Main courante** (*Outils › Signalements*) : page imprimable (PDF) des signalements des 7 derniers jours, avec heure, position, auteur, diffusion et fin.

## Points de passage reçus
Les points de passage captés par la carte (MQTT ou module), envoyés par un Bipper, GerMaCrise ou l'appli Meshtastic, deviennent aussi des signalements (📻 reçu par radio), avec leur auteur. Ceux sans durée restent affichés 24 h ; « Terminé » les retire seulement de la carte.
