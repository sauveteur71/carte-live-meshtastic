# Secteurs d'alerte et mode urgence

Deux outils pour suivre des équipes de terrain (ADRASEC, secours, recherche de personne) : les **secteurs d'alerte** préviennent quand un intervenant sort d'une zone (ou y entre), le **mode urgence** met toute la carte en configuration de crise. Menu *Outils › 🗺️ Secteurs d'alerte* et *Outils › 🚨 Mode urgence* (gestionnaires et administrateurs), ou Ctrl+K.

## Secteurs d'alerte (géorepérage)

### Créer un secteur (administrateur)
1. *Outils › 🗺️ Secteurs d'alerte* (ou fiche d'une équipe › *🗺️ Définir un secteur*).
2. **⬠ Dessiner un polygone** : touchez la carte à chaque sommet (3 au moins), puis **✔ Terminer** ; ou **◯ Cercle** : touchez le centre, donnez le rayon en mètres.
3. Rattachez-le à une **équipe** (tous ses membres du moment) et/ou à des **nœuds** : `!a1b2c3d4` pour Meshtastic, clé publique complète (64 caractères) pour MeshCore.
4. Choisissez l'alerte : **à la sortie** (cas courant), **à l'entrée** (zone à éviter : falaise, crue, périmètre interdit) ou les deux.
5. **Créer le secteur**. Il se voit sur la carte (trait jaune pointillé, orange quand quelqu'un est dehors).

### Réglages contre les fausses alertes
| Réglage | Par défaut | Rôle |
|---|---|---|
| **Marge** | 30 m | Une position à moins de cette distance de la limite ne compte pas (bordure). |
| **Positions pour confirmer** | 2 | Il faut 2 positions de suite du même côté pour changer d'état : un aller-retour en bordure ne déclenche rien. |
| **Délai entre deux alertes** | 10 min | Pas deux alertes du même genre pour le même nœud avant ce délai (l'événement reste noté au journal). |
| **Perte de contact** | 30 min | Alerte si un membre ne donne plus de position pendant 10 min à 2 h (« pas d'alerte » pour la couper). |
| **Prévenir sur un canal LoRa** | non | Message court envoyé par le module de la carte (« ⛔ Nom hors secteur X »). File d'attente : un message toutes les 30 s, 20 par heure au plus, alertes simultanées regroupées (« ⛔ A, B hors secteur X »), 200 octets par message. |

### Délai réel d'une alerte
Une sortie confirmée demande *N positions de suite* dehors : l'alerte arrive donc **1 à 2 intervalles de suivi après la sortie réelle** (suivi d'équipe toutes les 10 min = alerte 10 à 20 min après). Pour raccourcir ce délai, la carte **demande aussitôt sa position** au nœud dès la première position hors secteur (une fois par 10 min et par nœud, si le module de la carte est relié). Pour une mission sensible, resserrez l'intervalle de suivi de l'équipe ou passez à 1 position pour confirmer.

- **Sortie probable** : une seule position hors secteur suivie d'un **silence** (plus de nouvelles depuis 10 min, ou depuis un intervalle de suivi s'il est plus long) est signalée sans attendre la confirmation : alerte critique « sortie probable de *Nom* (une position hors secteur, plus de nouvelles depuis X min) ». Le nœud repasse « dans le secteur » dès que des positions dedans arrivent. Un premier signe de sortie sans suite ni silence (le nœud continue d'émettre en bordure) est oublié au bout d'une heure.
- **Positions floutées** (firmware 2.7/2.8, précision réduite sur le canal public) : l'incertitude annoncée par le nœud élargit la marge, et la position **reste surveillée** : elle est « dehors » seulement quand toute sa maille l'est (± 3,6 km à 13 bits, ± 450 m à 16 bits, à nos latitudes). Tant que la maille chevauche la limite, le nœud est signalé « **non surveillable précisément : position floutée (± N m)** » (alerte de niveau attention, visible dans la fiche et dans *Réseau › Alertes*). Pour suivre une équipe, partagez une **position précise** sur le canal d'équipe (case *Positions des membres* de la fiche Équipes).
- **Position périmée** : un nœud qui a perdu le GPS répète sa dernière mesure. Quand la mesure annoncée date de plus de 15 min (ou de 2 intervalles de suivi) et n'avance plus, la position n'est **pas comptée** et le nœud est signalé « position périmée » (attention). Un nœud dont l'horloge est fausse mais dont le GPS vit (mesures qui avancent) reste suivi normalement.
- **Flux interrompu** : si la carte ne reçoit **plus aucun paquet d'aucune source** (MQTT, module radio, agents) depuis 10 min, ce n'est pas l'intervenant qui se tait : une seule alerte « flux interrompu, surveillance des secteurs suspendue » est émise, les pertes de contact et sorties probables sont suspendues, et tout reprend au retour du flux. Au démarrage de la carte, les pertes de contact attendent un délai de grâce égal au réglage *Perte de contact* (pas de rafale après un redémarrage).
- Un même paquet reçu par plusieurs passerelles ne compte qu'une fois ; une annonce MeshCore sans horodatage répétée par plusieurs observateurs non plus.
- Positions MeshCore : celles des **annonces** (adverts) des nœuds. Elles sont rares (à la demande, ou toutes les quelques heures) : préférez Meshtastic pour un suivi fin.
- Polygone : les côtés ne doivent pas se croiser (refusé sinon) ; un secteur à cheval sur le méridien 180° est accepté ; latitude 85° au plus. Pour une alerte à l'entrée, la marge doit rester inférieure à la moitié du secteur.
- Forme modifiée : les états connus repartent à « pas encore de position » ; équipe supprimée : ses secteurs qui ne suivaient qu'elle sont désactivés (le journal reste).

### Où arrivent les alertes
- *Réseau › Alertes* (critique « hors du secteur » ou « sortie probable », attention « sans nouvelle position », « non surveillable précisément », « position périmée », « flux interrompu »), avec la pastille des alertes ;
- gestionnaires connectés : annonce cliquable (centre la carte), son, notification du navigateur, bulle sur la carte ;
- appli Android (notifications), domotique MQTT (`<racine>/alerte`), comme les autres alertes critiques ;
- en option, un message LoRa sur le canal choisi.

Les secteurs, leurs alertes et les positions des intervenants ne sont **jamais montrés au public** (carte publique, alertes publiques, rapport et fiche Équipes en mode démonstration, réponses aux demandes de position). Les alertes en direct des secteurs et le journal de crise ne vont qu'aux gestionnaires et administrateurs connectés.

### Journal
Chaque entrée, sortie (confirmée ou probable), perte de contact, retour du contact, position floutée ou périmée, coupure du flux, création ou modification est notée (3 000 derniers événements, fichier `secteurs.json` du dossier de données). *📜 Journal* dans la fiche, filtre par secteur, **⬇ Exporter le journal (CSV)** (heure UTC et locale, nœud, position, distance à la limite, précision, état de l'envoi LoRa). Dans les exports CSV, une cellule qui commence par `=`, `+`, `-` ou `@` (nom de nœud choisi pour piéger un tableur) est précédée d'une apostrophe : le tableur l'affiche comme texte, sans exécuter de formule.

### Ancienne « zone de sécurité » des équipes
Le cercle de sécurité d'une équipe (versions précédentes) est repris **automatiquement** en secteur « Zone de sécurité *équipe* » au premier démarrage, avec une marge de 100 m.

## Mode urgence
Inspiré du mode urgence de l'application MeshWave, adapté à une carte de supervision. Un administrateur l'active (*Outils › 🚨 Mode urgence › Activer*, motif facultatif) ; il reste actif après un redémarrage, jusqu'à ce qu'un administrateur le termine. Les gestionnaires voient le tableau de crise et ajoutent des notes au journal.

Pendant la crise :
- **bandeau rouge « URGENCE »** (durée, motif) dans l'en-tête et cadre rouge autour de l'écran, pour **tous les comptes connectés** ; rien n'est montré au public ;
- **carte simplifiée et contrastée** : le réseau ordinaire passe au second plan ; les intervenants des équipes (étiquette blanche), les membres hors secteur ou sans nouvelle (orange), les **demandes d'aide** (🆘 rouge clignotant) et les secteurs restent nets ; compteurs du haut masqués ;
- **tableau de crise** (clic sur le bandeau) : demandes d'aide en attente (✔ Pris en compte), alertes des secteurs, intervenants et âge de leur position, alertes critiques du réseau, journal ; rafraîchi toutes les 15 s et à chaque événement ;
- **état du réseau rafraîchi toutes les 10 s** au lieu de 30 s ;
- **signalements et main courante** remis en service s'ils étaient masqués (le réglage des fonctions masquées n'est pas modifié) ;
- **journal horodaté de la crise** : déclenchement, demandes d'aide d'équipe, messages de détresse reçus sur les canaux, entrées et sorties de secteur, alertes critiques nouvelles des nœuds concernés (surveillés, dans la zone, membres d'équipe : sur une carte à gros flux, les centaines de « muet » lointains n'y entrent pas), **notes** ajoutées à la main (📝), fin. Export **⬇ Journal (CSV)** pendant et après la crise ; les 10 crises précédentes restent exportables.

**Messages de détresse** : un message contenant 🔔 (cloche Meshtastic), SOS ou S.O.S, MAYDAY, « à l'aide », « aidez-moi », « au secours », « help » ou « besoin d'aide » (mots entiers : « sosie » ne compte pas) est noté :
- en **critique** s'il vient d'un membre d'équipe, d'un nœud surveillé ou d'un nœud de la zone ;
- en **attention** (« message de détresse possible ») s'il vient d'un autre nœud : sur un canal public, **l'expéditeur n'est pas vérifiable** (n'importe qui peut émettre sous un numéro de nœud quelconque) ; vérifiez avant d'engager des moyens ;
- jamais s'il vient du module de la carte elle-même (ses propres alertes LoRa ne sont pas des détresses) ; au plus un par nœud toutes les 5 min.
Les demandes d'aide d'équipe (fiche Équipes) gardent leur traitement propre.

Le mode urgence **ne change aucun réglage radio et n'envoie aucun message LoRa** : demandes de position, mode recherche et envois restent à votre main (fiche Équipes).

**⏹ Terminer le mode urgence** (administrateur) remet l'affichage habituel pour tous et propose l'export du journal.
