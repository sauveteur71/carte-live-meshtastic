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
| **Perte de contact** | non | Alerte si un membre ne donne plus de position pendant 10 min à 2 h. |
| **Prévenir sur un canal LoRa** | non | Message court envoyé par le module de la carte (« ⛔ Nom hors secteur X »), au plus un toutes les 30 s pour toute la carte. |

- **Positions floutées** (firmware 2.7/2.8, précision réduite sur le canal) : l'incertitude annoncée par le nœud élargit la marge. Une position plus floue que la moitié de la taille du secteur (par exemple ± 2,9 km sur un secteur de 1 km) est **ignorée** et notée une fois au journal (« position trop imprécise »). Pour suivre une équipe, partagez une **position précise** sur le canal d'équipe (case *Positions des membres* de la fiche Équipes).
- Un même paquet reçu par plusieurs passerelles ne compte qu'une fois.
- Positions MeshCore : celles des **annonces** (adverts) des nœuds. Elles sont rares (à la demande, ou toutes les quelques heures) : préférez Meshtastic pour un suivi fin.

### Où arrivent les alertes
- *Réseau › Alertes* (critique « hors du secteur », attention « sans nouvelle position »), avec la pastille des alertes ;
- gestionnaires connectés : annonce cliquable (centre la carte), son, notification du navigateur, bulle sur la carte ;
- appli Android (notifications), domotique MQTT (`<racine>/alerte`), comme les autres alertes critiques ;
- en option, un message LoRa sur le canal choisi.

Les secteurs, leurs alertes et les positions des intervenants ne sont **jamais montrés au public** (carte publique, alertes publiques).

### Journal
Chaque entrée, sortie, perte de contact, retour du contact, position ignorée, création ou modification est notée (3 000 derniers événements, fichier `secteurs.json` du dossier de données). *📜 Journal* dans la fiche, filtre par secteur, **⬇ Exporter le journal (CSV)** (heure UTC et locale, nœud, position, distance à la limite, précision).

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
- **journal horodaté de la crise** : déclenchement, demandes d'aide d'équipe, messages de détresse reçus sur les canaux (SOS, MAYDAY, 🔔, « au secours », « besoin d'aide »), entrées et sorties de secteur, alertes critiques nouvelles, **notes** ajoutées à la main (📝), fin. Export **⬇ Journal (CSV)** pendant et après la crise ; les 10 crises précédentes restent exportables.

Le mode urgence **ne change aucun réglage radio et n'envoie aucun message LoRa** : demandes de position, mode recherche et envois restent à votre main (fiche Équipes).

**⏹ Terminer le mode urgence** (administrateur) remet l'affichage habituel pour tous et propose l'export du journal.
