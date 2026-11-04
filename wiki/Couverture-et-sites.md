# Couverture et sites

Onglet **Couverture** et menu **Couverture radio**. Les calculs utilisent le modèle de terrain **IGN RGE ALTI**, calibré sur les liaisons réellement mesurées.

- **Couverture actuelle du réseau** : zone desservie par les relais détectés, part du département, ce que chaque relais est seul à couvrir.
- **Couverture d'un point** : clic sur la carte ou sur un nœud ; hauteur d'antenne réglable. Les points proches d'un autre département utilisent automatiquement son relief.
- **Couvrir un ou plusieurs points** : sites capables de desservir un lieu, ou 2 à 5 lieux avec un seul relais.
- **Relier deux lieux** : relais nécessaires et où les poser.
- **Plan pour couvrir le département** : objectif, nombre de sites, accès exigé (voiture, 4×4, à pied) ; bouton **voir la couverture** sur chaque site proposé.
- **Plan à budget** : « j'ai N relais à poser », surface et habitants gagnés.
- **Simulation « et si… »** : retirer ou ajouter des relais, villes qui ne seraient plus couvertes.
- **Profil entre deux points**, **sites routiers** (webcams du Département et de la DIR), **déplacer des relais**.
- **Fiche d'installation** de chaque relais (antenne, hauteur, gain, câble, puissance, alimentation) : utilisée par les calculs.
- **Couverture mesurée** : d'où les nœuds sont réellement reçus, relevés de terrain.
- **Bulles voisines** : les relais des cartes des départements voisins (*Outils › Partager*).

En vue MeshCore, les calculs utilisent le réglage radio français MeshCore (869,618 MHz, BW 62,5 kHz, SF8, CR8).

## Zone dessinée à la main
Dans *Couverture › Plan*, **🖊 Dessiner une zone** sert à étudier un secteur plutôt que tout le département : secteur d'intervention, vallée, massif, itinéraire de course…
1. Cliquez sur la carte pour poser les coins de la zone (3 au moins). « ↶ Point » retire le dernier.
2. Donnez-lui un nom si vous voulez, puis **Terminer et étudier**. Un double-clic ou un clic sur le premier point fait la même chose.

La carte donne, pour la seule zone :
- la part couverte aujourd'hui par le réseau ;
- les points hauts à équiper, dans l'ordre, avec le gain de surface de chacun ;
- la couverture finale (bleu : déjà couvert, turquoise : apporté, rouge : non couvert).

Les critères sont ceux du plan du département : objectif, nombre de sites, accès, réseau actuel, sites réalistes. Les points hauts candidats sont ceux de la zone et des 10 km autour. La zone doit rester dans le relief chargé (le département et ses abords). Les zones sont gardées dans ce navigateur (*Zones enregistrées…*), et le GPX des sites se télécharge.
