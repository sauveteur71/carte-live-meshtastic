# Passerelle inter-réseaux Meshtastic ⇄ MeshCore

Relaie les **messages texte de canal** entre un canal Meshtastic et un canal MeshCore. C'est un **outil d'appoint** (exercice, événement, panne d'un des deux réseaux), pas une passerelle permanente : elle est **désactivée par défaut**.

## Activer
Administrateur : *Outils › ⇄ Passerelle inter-réseaux* › **⏻ Activer la passerelle** (ou ⚙️🔎 « passerelle »). Les règles peuvent être préparées avant l'activation ; **⏻ Désactiver** coupe tout en gardant les règles, **⏸ Mettre en pause** suspend le relais un moment. Le choix est gardé après un redémarrage.

Dans le `.env`, facultatif : `PASSERELLE=1` l'active au premier démarrage ; `PASSERELLE=0` l'**interdit** sur cette carte (le menu disparaît, même pour un administrateur).

Il faut un **module Meshtastic principal** et un **companion MeshCore principal** reliés à la carte : ce sont eux qui émettent les messages relayés. Les messages entrants sont ceux que la carte décode déjà (MQTT, module, companion, observateurs).

## Règles
Onglet **🔗 Liaisons (canaux)** (il s’ouvre tout seul quand on active la passerelle, ou tant qu’aucune liaison n’existe) : le **canal Meshtastic** à gauche et le **canal MeshCore** à droite, où les messages seront échangés (par exemple `ADRASEC43` ⇄ `#adrasec`), le sens (MT → MC, MC → MT ou MT ⇄ MC), puis **Créer la liaison**.
- Chaque côté liste les canaux du module (ou du companion). S'il n'est pas relié, la carte propose les canaux qu'elle connaît (réglages) ; **Autre canal** permet de taper n'importe quel nom.
- Une liaison peut donc être préparée module débranché : elle fonctionne dès que le module et le companion ont ce canal. Le canal est retrouvé par son **nom** à chaque envoi (peu importe sa place dans la liste du module) ; s'il manque, le journal l'indique. Chaque règle se suspend d'un clic, et la passerelle entière se met en pause en haut du panneau.

Par règle, des **filtres** : expéditeurs bloqués, mot requis, mots exclus (ex. `!pos`), longueur minimale, heures silencieuses (ex. `22-7`), et **Regrouper** : les messages reçus dans la fenêtre (10, 30 ou 60 s) partent en une seule émission (`[MC] Bob: salut / Alice: ça va ?`).

Le canal principal Meshtastic (canal 0) est exclu par défaut (autorisable dans les réglages).

## Essayer un message, profils
- **🧪 Essayer un message** (onglet Liaisons) : indiquez le réseau d'arrivée, le canal, l'expéditeur et un texte. La passerelle dit ce qu'elle en ferait (relayé, vers quel canal, avec quel texte, ou refusé et pourquoi). **Rien n'est envoyé.**
- **🗂️ Profils** : enregistrez la configuration actuelle (liaisons, liste noire, réglages) sous un nom (« normal », « crise »…) et rechargez-la d'un clic.

## Protections toujours actives
- **Anti-écho** : ce qu'envoient nos propres modules n'est jamais repris (sinon tout serait doublé).
- **Anti-boucle** : un texte qui commence par `[MT]` ou `[MC]` (préfixes réglables) n'est jamais retransmis.
- **Anti-doublon** : même canal, même expéditeur, même texte dans les 10 min (réglable).
- **Quotas** : 6 messages par minute par règle et par sens, 60 pour toute la passerelle, 4 s au moins entre deux émissions sur un réseau, file de 10 messages : au-delà, les plus anciens sont abandonnés (jamais de rattrapage en rafale).
- **Module hors ligne** : les messages attendent son retour (file bornée).
- Taille : 200 octets côté Meshtastic, 140 côté MeshCore (le nom du companion compris), texte tronqué au-delà.

## Liste noire
Onglet **Liste noire** : choisissez un utilisateur parmi les nœuds connus ; ses messages ne sont plus jamais relayés (il reçoit toujours ceux de son réseau). « Aussi dans l'autre réseau » bloque le même nom des deux côtés.

## Journal, messages, statistiques et alertes
- Onglet **Messages** (Meshtastic et MeshCore) : choix **⇄ Relayés par la passerelle**, et une étiquette « ⇄ passerelle » sur chaque message relayé.
- Écran **Statistiques** : messages relayés par sens et ignorés par motif.
- **Alerte « passerelle hors ligne »** quand un module émetteur d'une liaison active est injoignable ; ses messages attendent en file son retour, la liaison reprend toute seule.

Le tableau de bord compte les messages relayés par sens et les messages ignorés par motif ; le journal en direct montre chaque message reçu, relayé ou ignoré avec sa raison. Les créations, suspensions et suppressions de règles, et la liste noire, sont notées au journal d'audit. Les messages relayés n'apparaissent jamais sur la carte publique.
