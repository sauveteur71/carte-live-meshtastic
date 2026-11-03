# Programmation à distance (Meshtastic)

La carte lit et modifie la configuration des nœuds **par LoRa**, avec l'administration chiffrée (PKI) du firmware 2.5 et plus.

## Préparer les nœuds
Sur chaque nœud à administrer, ajoutez la **clé publique du module de la carte** dans *Sécurité › Clé d'administration*. La clé est affichée dans l'onglet *Programmer*. **🔑 Clés d'administration** montre, relais par relais, les modules autorisés et ce qu'il reste à faire sur place.

## Lire
- **Lecture ciblée** : cochez seulement ce que vous voulez vérifier (rôle et rediffusion, LoRa, canaux, position, nom, matériel, télémétrie, voisinage, sécurité, gestion du trafic). Chaque élément est une demande radio (10 à 60 s selon la distance).
- **Tout lire** : une quinzaine de demandes. Une lecture interrompue **reprend** là où elle s'était arrêtée.

## Modifier
- **Éditeur de réglages** : nom, rôle, rediffusion, LoRa, position, canaux, télémétrie, gestion du trafic (2.8), politique de signature (2.8.1). Envoi en une seule transaction, puis relecture pour contrôle.
- **Modèles** (*📋 Modèles*) : relais point haut, relais de comblement, base sur toit, mobile, client fixe, et vos propres modèles ; export et import YAML (`meshtastic --export-config`).
- **Favoris entre relais** (*⭐*, firmware 2.7.11 et plus) : un paquet relayé entre routeurs favoris ne consomme plus de saut.
- **Conseiller de rôle** (*Statistiques › Maintenance*) avec le bouton « Passer en… ».
- **Vérification de conformité** : comparer tous vos nœuds à une référence, aussi chaque nuit.
- Garde-fous pour le **canal principal** : refus si la fréquence dépend de son nom (vous perdriez le contact).

## Fiabilité des envois
- Chaque demande part **jusqu'à 3 fois**, avec un délai adapté à la distance (≈ 50 s à 1 saut, 65 s à 2 sauts). Le dernier essai part avec un saut de plus.
- Une réponse **tardive** à un essai précédent est acceptée.
- **Insister** : case « Insister en cas d'échec » dans les formulaires, ou bouton **🔁 Insister 2 h** sur une opération terminée. Les nœuds en échec sont repris **toutes les 10 min pendant 2 h**, utile pour un mobile ou un relais lointain. Les vrais refus (clé non autorisée) ne sont pas retentés.
- Chaque nœud affiche l'**heure** de sa réussite ou de son échec.

## Comprendre un échec
| Message | Cause |
|---|---|
| clé du module absente des clés d'administration | le nœud a **refusé** : ajoutez la clé sur place |
| liaison radio trop faible ou nœud occupé (il a déjà accepté ce module) | problème **radio**, pas de clé : réessayez, insistez ou rapprochez le module |
| nœud hors de portée, ou clé absente, ou firmware < 2.5 | aucune réponse, et la carte ne sait pas pourquoi |
| aucun accusé après réémissions | le message n'a jamais atteint le nœud |

## Firmware
- Nouvelle version signalée ; **mise à jour par le Wi-Fi** des ESP32 (2.7.18 et plus) joignables en IP.
- **🆕 Firmware 2.8** : nœuds renumérotés repérés par leur clé publique (fusion de l'historique), clés en double (configurations clonées), position et télémétrie coupées par défaut sur les canaux publics, 2.8.0 retirée. Meshtastic conseille de rester en 2.7 sur les relais tant que la 2.8 est en alpha.
