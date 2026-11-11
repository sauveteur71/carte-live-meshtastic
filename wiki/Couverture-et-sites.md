# Couverture et sites

Onglet **Couverture** et menu **Couverture radio**. Les calculs utilisent le modèle de terrain **IGN RGE ALTI**, calibré sur les liaisons réellement mesurées.

- **Couverture actuelle du réseau** : zone desservie par les relais détectés, part du département, ce que chaque relais est seul à couvrir.
- **Couverture d'un point** : clic sur la carte ou sur un nœud ; hauteur d'antenne réglable. Les points proches d'un autre département utilisent automatiquement son relief.
- **Couvrir un ou plusieurs points** : sites capables de desservir un lieu, ou 2 à 5 lieux avec un seul relais.
- **Relier deux lieux** : relais nécessaires et où les poser.
- **Plan pour couvrir le département** : objectif, nombre de sites, accès exigé (voiture, 4×4, à pied) ; bouton **voir la couverture** sur chaque site proposé.
- **Plan à budget** : « j'ai N relais à poser », surface et habitants gagnés.
- **Simulation « et si… »** : retirer ou ajouter des relais, villes qui ne seraient plus couvertes.
- **Profil entre deux points** : hauteur de chaque antenne **au-dessus du sol** (mât dessiné sur le profil, altitude du sol et de l'antenne affichées), **sites routiers** (webcams du Département et de la DIR), **déplacer des relais**.
- **Fiche d'installation** de chaque relais (antenne, hauteur, gain, câble, puissance, alimentation) : utilisée par les calculs.
- **Couverture mesurée** : d'où les nœuds sont réellement reçus, relevés de terrain.
- **Bulles voisines** : les relais des cartes des départements voisins (*Outils › Partager*).

En vue MeshCore, les calculs utilisent le réglage radio français MeshCore (869,618 MHz, BW 62,5 kHz, SF8, CR8).

## Zone dessinée à la main
Dans *Couverture › Plan*, **🖊 Dessiner une zone** sert à étudier un secteur plutôt que tout le département : secteur d'intervention, vallée, massif, itinéraire de course…
1. Cliquez sur la carte pour poser les coins de la zone (3 au moins). « ↶ Point » retire le dernier. Un point qui ferait croiser le contour est refusé.
2. **➕ Autre zone** ferme la zone et en commence une autre (10 au plus) : toutes sont étudiées ensemble.
3. Donnez un nom si vous voulez, puis **Terminer et étudier**. Un double-clic ou un clic sur le premier point fait la même chose.

La carte donne, pour la seule zone :
- la part couverte aujourd'hui par le réseau ;
- les points hauts à équiper, dans l'ordre, avec le gain de surface de chacun ;
- pour chacun, **d'autres emplacements possibles** (1a, 1b, 1c) d'apport proche, si le site proposé n'est pas utilisable ;
- la couverture finale (bleu : déjà couvert, turquoise : apporté, rouge : non couvert).

**Antenne (m au-dessus du sol)** : hauteur des antennes des sites proposés pour la zone dessinée (6 m par défaut, de 1 à 60 m) ; elle est rappelée dans le résultat. Le plan du département utilise la hauteur fixée par le classement des points hauts (6 m), indiquée dans son résultat.

Les critères sont ceux du plan du département : objectif, nombre de sites, accès (modifiable dans le résultat : voiture, 4×4, à pied, tous), réseau actuel, sites réalistes. Les points hauts candidats sont ceux de la zone et des 10 km autour. La zone doit rester dans le relief chargé (le département et ses abords). Les zones sont gardées dans ce navigateur (*Zones enregistrées…*), et le GPX des sites se télécharge.

## Toute la France : relief des autres départements
Par défaut, les calculs de couverture portent sur le département de la carte, dont le relief est téléchargé à l'installation. Pour calculer ailleurs :

- **Comptes connectés** : *Couverture › Département étudié* ; le relief du département choisi est téléchargé au premier calcul (quelques minutes), puis gardé sur le serveur.
- **Carte publique** : l'administrateur choisit dans *Gestion › Réglages › Carte publique et relief* entre « département de la carte seulement » (léger, par défaut) et « tous les départements de France ».

### Télécharger et installer toute la France
*Outils › 🗺️ Toute la France › ⬇ Télécharger et installer toute la France* (aussi dans *Gestion › Réglages › Carte publique et relief*) met sur le serveur le relief de tous les départements, pour que chaque calcul soit immédiat. **Rien à télécharger à la main** :

1. la carte télécharge d'abord le **paquet « relief France »** publié sur GitHub (version `relief-france`, ≈ 110 Mo) et l'installe : quelques minutes ;
2. elle complète ensuite, département par département, ce qui manquerait (IGN, OpenStreetMap) ;
3. l'avancement s'affiche (département en cours, durée restante) ; la préparation continue page fermée, reprend toute seule après un redémarrage, et s'arrête d'un clic. Les départements déjà prêts sont sautés.

Une fois tout installé, la carte publique passe **d'elle-même** en « tous les départements » : n'importe quel visiteur peut alors calculer la couverture partout en France.

Comptez ≈ 250 Mo sur le disque. Sans le paquet (réseau qui bloque GitHub…), la préparation complète prend plusieurs heures.

Autre adresse du paquet (miroir, réseau local) : `RELIEF_FRANCE_URL=https://…/relief-france.tar.gz` dans le `.env`.

Installation sans Internet : copiez `relief-france.tar.gz` dans le volume de données, puis
```bash
docker compose exec carte-live tar -xzf /data/relief-france.tar.gz -C /data --skip-old-files
```

### Mettre à jour le paquet (mainteneur)
Une fois par an environ (nouvelles routes, sommets, pylônes dans OpenStreetMap) :
1. sur une carte qui a tout préparé : **📦 Fabriquer le paquet « relief France »** (même écran) ;
2. sur GitHub, *Releases › relief-france › Edit* : supprimer l'ancien `relief-france.tar.gz`, joindre le nouveau dans le cadre **« Attach binaries »** (la zone de texte refuse plus de 25 Mo), laisser la case *pre-release* cochée.

Sources : relief IGN RGE ALTI (Licence Ouverte Etalab 2.0) ; points hauts, voies d'accès et sites © contributeurs OpenStreetMap (ODbL).
