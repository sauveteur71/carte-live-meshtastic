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
- **Compteur** sur l'onglet *Messages* (rouge s'il y a un message direct) et sur l'onglet *MeshCore*.
- **Barre des canaux** en haut des messages : une pastille par canal, marquée **MT** (Meshtastic) ou **MC** (MeshCore). Un canal qui a reçu des messages passe **en tête**, en couleur, avec le **nombre en attente** (en jaune) et l'heure du dernier message ; il clignote quelques secondes à l'arrivée. Les messages directs sont en rouge. Un clic sur une pastille ouvre ce canal, même s'il est de l'autre réseau.
- Dans la liste, chaque message porte le **nom de son canal en couleur** (la même couleur que sa pastille), et les messages arrivés depuis la dernière lecture sont **surlignés** avec l'étiquette « NOUVEAU » pendant 3 minutes.
- **🔔 Sons** : cochez les canaux à faire sonner, chacun avec sa propre note (bouton ▶ pour écouter).
- **Message direct reçu** par le module de la carte : trois notes, un encadré « Lire / OK » et une **notification** Windows ou téléphone quand l'onglet est en arrière-plan (à autoriser une fois).

Le son ne fonctionne qu'après un premier clic dans la page (règle des navigateurs). Ces réglages sont propres à chaque navigateur.

## Étiquette de région (MeshCore)
Chaque message MeshCore envoyé en inondation peut porter une **région** (par exemple `fr-ara`). Un répéteur ne le relaie que si cette région figure dans son arbre de régions (`region def …`). Un message **sans région** n'est relayé que par les répéteurs qui l'acceptent (`flood.max.unscoped`).

Dans le fil des messages, une étiquette l'indique :
- **🏷 fr-ara** : la région portée par le message ;
- **sans région** : inondation sans étiquette ;
- **🏷 région ?** : une région que la carte ne connaît pas. Ajoutez son nom à `MESHCORE_REGIONS` dans le `.env` (séparés par des virgules).

Pour vos propres messages, c'est d'abord la région d'envoi du companion (*MeshCore › Companion › Région*), puis celle réellement constatée quand un répéteur renvoie le message. La carte reconnaît d'office `eu`, `europe`, `fr`, les régions (`fr-ara`, `fr-bfc`…) et les départements (`fr-43`, `fr-38`…), ainsi que quelques pays voisins (`ch`, `it`…). Le détail d'un paquet (*Paquets*) l'affiche aussi.

## Position partagée
Un message qui contient `meshand: 45.04312,3.88512` (le format de l'appli MeshAnd), `geo:45.04312,3.88512` ou `📍 45.04312,3.88512` devient une **épingle 📍** sur la carte. Dans le fil des messages, le bouton « 📍 Voir sur la carte » centre la carte sur la position. L'épingle donne l'itinéraire, la couverture depuis ce point et un bouton pour la retirer. Les positions reçues depuis moins de 12 h sont épinglées d'office.

Pour en envoyer une :
- **📍 Joindre le centre de la carte**, sous la zone de saisie (Meshtastic et MeshCore) ;
- ou **clic droit sur la carte › 📍 Partager ce point dans un message**.

## Choisir ce qu'on affiche
Un **seul menu *Canal*** en haut de l'onglet sert à lire et à écrire : le canal choisi est celui dont on voit les messages et celui où part le message tapé. **✉️ Mes messages directs** affiche le choix du destinataire. **Tous les canaux** et **Relayés par la passerelle** sont en lecture seule, comme un canal que le module de la carte n'a pas. Répondre à un message choisit son canal. Même fonctionnement dans MeshCore › Messages, avec les canaux du companion.

Le menu *Canal* liste aussi les canaux de l'autre réseau (groupe **MeshCore** dans les messages Meshtastic, groupe **Meshtastic** dans les messages MeshCore) : en choisir un y mène directement.

Le menu *Canal* ne montre que le nombre de **nouveaux** messages de chaque canal (« · 3 nouveaux »). **✉️ Mes messages directs** ne garde que les messages directs envoyés ou reçus par vos modules (module principal et modules en écoute reliés à la carte), pas ceux échangés entre d'autres nœuds.
