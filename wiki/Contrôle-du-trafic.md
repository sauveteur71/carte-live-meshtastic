# Contrôle du trafic

*Outils › 🚦 Contrôle du trafic* ou *Programmer › 🚦*. Sert à repérer ce qui encombre le canal radio.

## Nœuds trop bavards
Intervalles médians mesurés sur 6, 24 ou 72 h, comparés à ces seuils :

| Paquet | Seuil conseillé |
|---|---|
| Position d'un relais ou d'un point fixe | ≥ 4 h |
| Position d'un autre nœud | ≥ 5 min |
| Télémétrie | ≥ 30 min |
| Fiche du nœud (NodeInfo) | ≥ 1 h |

- **Entendus en radio dans la zone** : le type de paquet trop fréquent est reçu par une autre passerelle du secteur, donc il passe vraiment sur le canal radio.
- **Hors radio** : seulement reçus par le broker (autres départements). Ils chargent la carte, pas votre canal.
- La télémétrie « locale » qu'une passerelle publie toutes les 60 s vers son appli ne passe pas en radio : elle n'est pas comptée.

**Corriger les nœuds cochés** (nœuds programmables par la carte) : position toutes les 12 h pour un relais (position fixe, sans « smart position »), 15 min pour un mobile ; télémétrie 30 min ; fiche 3 h. Pour les autres, prévenez leur propriétaire.

## Réinjection MQTT → radio
Paquets venus d'internet (drapeau « via MQTT ») puis émis en radio par une passerelle dont le canal a la **descente MQTT** activée, avec la passerelle qui les réinjecte. À faire sur ces passerelles : couper la descente sur le canal public, ou ne la garder que sur un canal privé.

## « Ignorer MQTT » sur les relais
Réglage LoRa du firmware : le nœud ne relaie plus les paquets arrivés par MQTT. Conseillé sur les ROUTER et ROUTER_LATE ; un bouton l'active sur tous les relais programmables.

## Dans le panneau Réseau
La section **Nœuds trop bavards** (onglet Réseau, réservée aux gestionnaires) donne la liste en direct sur 24 h : le nœud, son rôle, ce qu'il envoie trop souvent et le nombre de paquets par jour. Un clic sur un nœud ouvre sa fiche ; le bouton en bas ouvre le contrôle complet, avec la correction à distance. La liste est recalculée tous les quarts d'heure.

