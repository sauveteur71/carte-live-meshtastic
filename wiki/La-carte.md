# La carte

## S'y retrouver
- **5 rubriques** en haut du panneau : **Réseau** (vue d'ensemble, nœuds, trafic, statistiques, MeshCore), **Messages** (Meshtastic et MeshCore), **Couverture**, **Gérer** (programmation Meshtastic et MeshCore, équipes, clés, firmware) et **Réglages**. Les sous-rubriques s'affichent juste dessous.
- **Accueil « Que voulez-vous faire ? »** : de grandes tuiles (voir le réseau, lire et écrire, signaler, étudier la couverture, gérer mes nœuds, régler la carte). Le tableau de bord complet est replié dessous.
- **Niveau d'affichage** (accueil, ou Réglages) : **Simple** montre l'essentiel, **Opérateur** ajoute la couverture avancée, le trafic et les outils de terrain, **Expert** montre tout. Par défaut : simple pour un visiteur ou un membre, opérateur pour un gestionnaire, expert pour un administrateur. Les droits ne changent pas : seul l'affichage est allégé.
- **Réglages** : tout est rangé au même endroit (affichage, compte, modules et réseaux, carte, MQTT, comptes, sauvegardes, mise à jour, toute la France, passerelle, équipes).
- **Une seule recherche** : le champ au-dessus de la carte trouve un lieu, un nœud, des coordonnées… et aussi une **fonction** ou un réglage (« mqtt », « équipes », « mise à jour »). ⚙️🔎 ou Ctrl+K ouvre la recherche des fonctions ; l'étoile ☆ d'un résultat l'ajoute à **⭐ Mes raccourcis** sur l'accueil, et les fonctions récentes sont proposées en premier.
- **Bouton ＋** sur la carte : touchez ＋ puis un point de la carte pour signaler un événement, voir la couverture depuis ce point, le partager ou tracer un profil (sans clic droit, pratique sur téléphone).
- **« ? »** à droite des rubriques : l'aide de l'écran affiché s'ouvre dans la carte (pages de ce wiki). **Visite guidée** à la première visite, à revoir dans Réglages.
- **Confort et accessibilité** : confirmations et messages dans l'interface (plus de fenêtres du navigateur), option **Grand texte**, thème clair, navigation au clavier (Tab, Entrée, Échap), étiquettes pour lecteurs d'écran, boutons plus grands sur écran tactile.

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
Une page publique (sans messages ni position exacte des particuliers) peut être partagée : *Outils › Partager*. Elle sert à consulter le réseau, sans rien pouvoir modifier.
- Chaque visiteur choisit le **secteur** affiché : département de la carte, avec ses voisins, une région, n'importe quel département ou la France entière. Nœuds, liaisons, chiffres et animations suivent. Par défaut, les calculs de couverture (couverture, où poser des relais, couverture d'un point) restent sur le département de la carte : ailleurs, la carte publique est une carte légère du réseau. L'administrateur peut les ouvrir à **tous les départements** (*Gestion › Réglages › Carte publique et relief*) : le relief d'un département est alors chargé au premier calcul, ou à l'avance avec **Outils › 🗺️ Toute la France › ⬇ Télécharger et installer** (arrêt possible à tout moment, ≈ 250 Mo sur le disque). La préparation installe d'abord le paquet « relief France » publié sur GitHub (version `relief-france`, ≈ 110 Mo), puis complète département par département. **📦 Fabriquer le paquet** produit ce fichier depuis une carte qui a tout préparé. Sources : relief IGN RGE ALTI (Licence Ouverte Etalab), points hauts, accès et sites © contributeurs OpenStreetMap (ODbL).
- Le titre suit le réseau et le secteur choisis. Le lien vers la carte complète n'apparaît qu'aux administrateurs connectés.

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
- 📍 **demander sa position** (gestionnaire, Meshtastic) : le nœud renvoie sa position, la réponse s'affiche en bas de l'écran ;
- 📋 copier l'identifiant ;
- 🧭 chemin depuis le companion (MeshCore, membre) : voir [[MeshCore]] ;
- 🗑 **supprimer ce nœud** (administrateur) : pour un nœud qui n'existe plus. Il disparaît de la carte et de la base (positions, télémétrie, liaisons) ; un nœud MeshCore est aussi retiré des contacts du companion. S'il émet encore, il réapparaîtra à sa prochaine annonce.

Le clic droit ailleurs sur la carte garde son menu habituel : couverture, profil, partage du point…

## Liste des nœuds
La liste Meshtastic, comme celle de MeshCore, peut être rangée **par type** (▦ Par type) : relais, clients, clients muets, traceurs, inconnus, chaque groupe se repliant d'un clic. L'état est gardé dans le navigateur.

## Sur téléphone et tablette
- **Panneau en tiroir** (téléphone, tablette en hauteur) : poignée à tirer ou à toucher, trois hauteurs (onglets seuls, moitié, plein). En paysage, le panneau passe sur le côté.
- **Fiche d'un nœud en tiroir** : toucher la poignée pour l'agrandir, la glisser vers le bas pour la fermer.
- **◎ Ma position** (en haut à droite de la carte) : point bleu et précision, suivi tant que le bouton est allumé (la carte doit être en HTTPS).
- **Appui long sur la carte** : couverture depuis ce point, relier, profil, partager le point, copier les coordonnées.
- Barre d'outils sur une ligne qui défile au doigt, boutons et menus agrandis pour le doigt.
- Noms des nœuds affichés seulement en zoomant ; aux faibles zooms, les nœuds proches (hors relais et passerelles) sont **regroupés** en une pastille « 12 » qu'un toucher agrandit.
- **☀️ Thème clair** (Outils › Affichage) : interface claire à fort contraste pour le plein soleil.
- **📲 Installer l'application** (Outils, quand le navigateur le propose) : icône sur l'écran d'accueil, plein écran, dernière carte connue affichée sans réseau (nœuds, liaisons, MeshCore).
- **Économie** : animations coupées par défaut sur mobile et en mode économie de données ; flux en direct mis en pause après 2 min en arrière-plan, repris au retour ; lignes dessinées en canevas.

## Chercher un réglage
Le bouton **⚙️🔎** en haut (ou **Ctrl+K**) ouvre une recherche dans les réglages et fonctions de la carte : tapez « MQTT », « mot de passe », « IATA », « équipes », « firmware »… puis Entrée. La carte ouvre le bon onglet ou la bonne fenêtre et met le réglage en évidence. Seuls les réglages permis par votre compte sont proposés.
