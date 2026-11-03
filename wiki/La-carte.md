# La carte

## Nœuds et réseaux
- Sélecteur **Meshtastic / MeshCore / Les deux** en haut du panneau. En changeant de réseau, les traces de l'autre réseau sont effacées.
- **Légende et filtres** : relais, clients, clients muets, traceurs, inconnus, inactifs, passerelles MQTT en ligne, nœuds en alerte.
- Secteur affiché : le département, le département et ses voisins, ou toute la France.
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
