# La carte

## Nœuds et réseaux
- Sélecteur **Meshtastic / MeshCore / Les deux** en haut du panneau. En changeant de réseau, les traces de l'autre réseau sont effacées.
- **Légende et filtres** : relais, clients, clients muets, traceurs, inconnus, inactifs, passerelles MQTT en ligne, nœuds en alerte.
- Secteur affiché (menu en haut) : le département, le département et ses voisins, une **région de France** ou toute la France. Le choix est gardé d’une visite à l’autre. On ne voit que ce que la carte reçoit : la portée de votre broker MQTT et, pour MeshCore, le réglage « Paquets conservés » (département, voisins ou national).
- Clic sur un nœud : **fiche détaillée** (informations, télémétrie, voisins, « entendu par », trames, configuration déduite, test de portée).

## Liaisons
- **Mesurées** : SNR reçu par les passerelles, voisinage (NeighborInfo), traceroutes. Couleur selon le SNR, période réglable (*Liens 24 h*).
- **Liaisons à sens unique** et **relais sourds** (*Réseau › Liaisons*) : un relais qui émet bien mais entend mal, avec l'écart estimé en dB.
- **Chemins mesurés** : traceroutes automatiques, avec le SNR de chaque saut.

## Trafic en direct
Chaque paquet est animé : une comète parcourt le trajet saut par saut, les liaisons empruntées s'allument et les axes les plus utilisés depuis 10 min sont soulignés. Quand les relais intermédiaires ne sont pas connus, le trajet le plus probable est tracé en pointillé.

## Parcours d'un message
Dans *Messages*, un clic sur l'origine d'un message (📡 / 🌐) affiche son **parcours** :
- les autres liaisons et axes sont **masqués** pour ne voir que le trajet ;
- trait épais bordé de noir, **flèche** de sens sur chaque saut, **SNR** du dernier saut vers chaque récepteur ;
- la fiche liste chaque réception (passerelle, sauts, SNR, dernier relais) ;
- **✕ Effacer le parcours** remet les liaisons.

## Alertes, maintenance, historique
- **Alertes** : nœud muet, batterie faible, canal saturé, passerelle hors ligne.
- **Statistiques › Maintenance** : charge radio des relais, autonomie, firmwares, conseils de rôles.
- **Historique** sur plus d'un an, **rejeu** des 24 dernières heures, **rapport hebdomadaire** (*Outils*).
- **Santé de la carte** (*Réseau*) : processeur, mémoire, disque, base, MQTT.

## Mode terrain et application
*Outils › Mode terrain* : relevés GPS avec mesure radio et photo, même sans réseau. La carte s'installe comme une application (« Ajouter à l'écran d'accueil », HTTPS requis).

## Page publique
Une page publique (sans messages ni position exacte des particuliers) peut être partagée : *Outils › Partager*.

## Favoris et « Mes nœuds »
Dans la fiche d'un nœud, Meshtastic ou MeshCore (compte connecté) :
- **☆ Favori** : le nœud passe en tête des listes, avec une ⭐ ;
- **🛠 J'administre** : le nœud entre dans le groupe **Mes nœuds**.

Les nœuds que vous pouvez programmer y figurent d'office :
- pour un administrateur, les nœuds Meshtastic qui acceptent le module de la carte et les répéteurs MeshCore dont le mot de passe est mémorisé ;
- pour un gestionnaire, les nœuds de son secteur.

Un clic sur « 🛠 Mes nœuds ✓ » en retire un, et il ne revient plus d'office.

Le panneau **Réseau** a une section **Mes nœuds** : administrés d'abord (les muets en premier), puis favoris, avec l'état, la batterie et le dernier contact. Les listes *Nœuds* (Meshtastic et MeshCore) ont un choix **Tous / ⭐ Favoris / 🛠 Mes nœuds**. Les choix sont propres à chaque compte et suivent d'un appareil à l'autre.

**Alerte « nœud muet »** : dans la tuile *Mes nœuds*, cochez « 🔔 Me prévenir quand un de mes nœuds se tait depuis… » et choisissez le délai (1 à 24 h). La carte ouverte (PC ou téléphone) affiche alors une notification et un encadré, une seule fois par silence. Si le nœud revient puis se tait de nouveau, vous êtes prévenu de nouveau.

## GPS figé
La carte signale dans les alertes un nœud qui continue d'envoyer sa position alors que la mesure GPS qu'il annonce date de plus de 30 min : GPS sans signal, antenne débranchée ou module en panne. Un relais à position fixe, qui n'a jamais bougé, n'est pas concerné.


## Clic droit sur un nœud
Un clic droit (ou un appui long sur téléphone) sur un nœud, dans une liste ou sur la carte, ouvre un menu :
- ouvrir la fiche, centrer la carte ;
- ☆ ajouter aux favoris, 🛠 ajouter à « Mes nœuds » (ou les retirer) ;
- ✉️ message direct, 📶 écouter en direct (Meshtastic), 📡 couverture depuis ce nœud ;
- 📍 partager sa position dans un message ;
- 📋 copier l'identifiant.

Le clic droit ailleurs sur la carte garde son menu habituel : couverture, profil, partage du point…
