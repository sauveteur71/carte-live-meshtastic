# Messages

## Envoyer
Onglet **Messages** (administrateur, module radio relié) :
- choisir un **canal**, ou **✉️ Message direct… (choisir un nœud)** : une recherche par nom, nom court ou `!identifiant`, nœuds récents en tête ;
- les **correspondants récents** sont proposés directement dans la liste ;
- un clic sur un message reçu prépare la réponse sur le bon canal (ou en direct à son auteur).

## Savoir si le message est passé
Sous chaque message envoyé depuis la carte :

| Affichage | Signification |
|---|---|
| ✓✓ Reçu par X | message direct : le destinataire a renvoyé un accusé |
| ✓ Relayé par un voisin | le module a entendu un voisin retransmettre le message : il est parti |
| ✗ aucun voisin n'a relayé | personne ne l'a repris après 3 émissions |
| ⚠ Aucun accusé reçu | rien n'est revenu |

Sous **chaque** message : **📡 Entendu par N récepteurs**, avec pour chacun la passerelle, en direct ou le nombre de sauts, le SNR et le dernier relais. Un clic ouvre le parcours sur la carte.

**Limites** : un nœud sans passerelle MQTT qui reçoit votre message ne laisse aucune trace. Sur les canaux privés, seules les passerelles qui ont l'envoi vers MQTT activé sur ce canal le remontent. Un message de canal n'a pas d'accusé de lecture : pour vérifier qu'un correspondant précis vous entend, envoyez-lui un **message direct**.

## Non lus, sons et alertes
- **Compteur** sur l'onglet *Messages* (rouge s'il y a un message direct) et sur l'onglet *MeshCore*, plus le nombre de nouveaux messages par canal dans la liste et des boutons pour y aller.
- **🔔 Sons** : cochez les canaux à faire sonner, chacun avec sa propre note (bouton ▶ pour écouter).
- **Message direct reçu** par le module de la carte : trois notes, un encadré « Lire / OK » et une **notification** Windows ou téléphone quand l'onglet est en arrière-plan (à autoriser une fois).

Le son ne fonctionne qu'après un premier clic dans la page (règle des navigateurs). Ces réglages sont propres à chaque navigateur.
