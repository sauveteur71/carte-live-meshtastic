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

## Alertes officielles
Un bandeau en haut de la carte (🟡 / 🟠 / 🔴) signale les alertes en cours ; un clic ouvre le détail (*Outils › 🚩 Signalements*, bloc **🌦️ Alertes officielles**).
- **Vigilance Météo-France** (orages, vent, pluie-inondation, crues, neige, canicule…) pour les **départements choisis** par l'administrateur (celui de la carte par défaut, ses voisins ou n'importe quel autre). Elle est lue toutes les 10 minutes dans le flux public MeteoAlarm (aucune clé à demander).
- **Vigipirate** : le niveau (Vigilance, Sécurité renforcée – risque attentat, Urgence attentat) se règle à la main par un gestionnaire, car il n'existe pas de flux officiel lisible par un programme. Il peut être annoncé en LoRa.
- **FR-Alert** : le message reçu sur un téléphone se recopie dans la carte pour être **relayé en LoRa** aux équipes qui n'ont pas de réseau mobile. FR-Alert n'a pas de flux public fiable.

**Diffusion automatique** (administrateur, *Réglages de diffusion*) : **désactivée par défaut** ; une fois cochée, les nouvelles vigilances à partir du niveau choisi (orange par défaut) partent en message texte sur les canaux Meshtastic indiqués (par défaut `Alerte`) et, si on le choisit, sur un canal MeshCore, une seule fois par vigilance : `🟠 Vigilance orange orages · Haute-Loire · du jeu. 12 16:00 au ven. 13 06:00 (Météo-France)`.

### Envoyer une vigilance à la demande
Un gestionnaire peut envoyer tout de suite une vigilance en cours par radio, même sans diffusion automatique : dans *🌦️ Alertes officielles*, choisir le canal **MeshCore** (canaux du companion) et/ou les canaux **Meshtastic** (canaux du module), puis le bouton **📡 Envoyer** de la vigilance voulue. Le texte part tel qu'il est diffusé automatiquement, par exemple « 🟠 Vigilance orange vent violent · Haute-Loire · du jeu. 12 18:00 au ven. 13 23:00 (Météo-France) ».

## Fonctions affichées
L'administrateur peut masquer, pour tous les utilisateurs de la carte, les **signalements** (avec leur couche et « Signaler un événement ici »), **Vigipirate**, **FR-Alert**, la **main courante** les **alertes Bipper / GerMaCrise** et les **feux actifs** : *Réglages › 👁️ Fonctions affichées*. La vigilance Météo-France reste toujours affichée ; le bouton 🚩 Signalements devient alors 🌦️ Alertes météo. Valeur de départ possible dans le `.env` : `FONCTIONS_MASQUEES=signalements,vigipirate,fr-alert,main-courante,bipper` (ajoutez `feux` pour masquer aussi les feux actifs).

## Feux actifs (satellite)
La carte lit toutes les 30 min les foyers de feu détectés par les satellites **NASA FIRMS** (VIIRS et MODIS), sans clé ni inscription, sur la France métropolitaine et la Corse :
- **Couches › Feux actifs** : les foyers des dernières 24 h, rouges s'ils ont moins de 3 h, orange moins de 12 h, bruns au-delà ; la taille suit la puissance du feu. Un clic donne l'heure, le satellite, la confiance, la puissance et le **carreau DFCI** ;
- **alerte** dans l'onglet Réseau pour tout foyer des 12 dernières heures dans la zone de la carte (hors confiance faible), regroupé par carreau DFCI de 2 km ; un clic centre la carte dessus ;
- **📡 Envoyer** (gestionnaire) dans les alertes officielles, rubrique *🔥 Feux actifs*, sur les mêmes canaux Meshtastic et MeshCore que la vigilance météo.

**Meteosat** (facultatif) : le satellite géostationnaire voit l'Europe toutes les 15 min, donc un départ de feu bien plus tôt que FIRMS, mais avec un pixel d'environ 4 km. Ces foyers sont dessinés en **cercle pointillé de 2 km** (position approchée). Il faut un compte gratuit LSA SAF (EUMETSAT) : inscription sur https://mokey.lsasvcs.ipma.pt/auth/signup, puis `LSASAF_UTILISATEUR` et `LSASAF_MOT_DE_PASSE` dans le `.env`. Le *Diagnostic* indique si la lecture fonctionne.

**Vent** : la fiche d'un foyer donne le vent à 10 m sur place (Open-Meteo, modèles Météo-France) : force, rafales, d'où il vient et **vers où il pousse le feu**.

Un foyer satellite **n'est pas une alerte officielle** : il arrive avec 1 à 3 h de retard et peut être une fausse détection (brûlage agricole, torchère, toiture chaude). Masquable dans *Réglages › 👁️ Fonctions affichées*.
