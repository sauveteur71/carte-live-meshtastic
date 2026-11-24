# Espaces Secours (DPS, PCS)

Des espaces **séparés de tout le reste de la carte**, pour deux usages :

- **DPS — dispositif prévisionnel de secours** : une association agréée de sécurité civile couvre un festival, une course, une fête locale. Postes de secours, équipes mobiles, interventions.
- **PCS — plan communal de sauvegarde**, pour sa partie radio : une commune, en crise, pointe sur la carte les interventions à faire, suit ses équipes et reçoit ce qui remonte du terrain en LoRa.

Dans les deux cas, on y trouve :

- les **interventions pointées sur la carte** (à faire, en cours, terminée, urgente) ;
- les **équipes et les postes**, avec la **position en direct** du nœud LoRa porté par chaque équipe ;
- une **main courante** horodatée, alimentée aussi par les **messages radio** du terrain, exportable en CSV ;
- des **points de rassemblement** posés sur la carte, à envoyer aux équipes par radio ;
- des **options** que chaque espace active selon son besoin (voir plus bas).

Ce n'est pas un logiciel de rédaction du PCS : le document officiel de la commune, validé par le maire, reste ce qu'il est. L'espace sert à s'en servir sur le terrain quand le téléphone ne passe plus.

## Séparé de la carte et de la section ADRASEC

La [[section ADRASEC|Section-ADRASEC]] reste réservée aux radioamateurs. Les espaces Secours n'ont rien de commun avec elle, ni avec le reste de la carte :

| | Ce qui est séparé |
|---|---|
| **Les données** | Un espace = **un fichier à lui** sur le serveur (dossier `secours/` des données). Rien n'est écrit dans la base de la carte ni dans les données de l'ADRASEC. |
| **Les comptes** | Les comptes d'un espace **n'existent que dans cet espace**. Un secouriste ou un agent communal n'a pas de compte sur la carte : il ne voit ni le réseau radio, ni ses réglages, ni l'ADRASEC, ni un autre espace. |
| **Les nœuds** | Chaque espace est **autonome** : ce sont ses responsables qui choisissent ses nœuds (⚙️ Gestion). Il ne voit que ceux-là (leur position, leurs messages). Un même nœud **peut servir à plusieurs espaces** : celui d'un coordinateur commun à une association, à la commune et à la préfecture, par exemple. |
| **Les messages** | Les messages et points de passage envoyés par les nœuds d'un espace, et tout ce qui passe sur son **canal réservé**, arrivent dans l'espace et **ne s'affichent pas dans les messages de la carte**. La position de ces nœuds, elle, reste visible sur la carte du réseau. |
| **L'administrateur de la carte** | Il crée l'espace, nomme le responsable et peut lui réserver un canal. Il **n'entre pas** dans l'espace : il ne lit ni les interventions ni la main courante. |

Les fichiers des espaces ne partent **pas** dans les sauvegardes de la carte (elles sont faites pour être copiées ailleurs). Chaque espace garde ses propres copies quotidiennes sur le serveur (`secours/copies/`, 7 jours).

## Mise en route

**Administrateur de la carte**
1. **Outils › ⛑️ Espaces Secours (DPS, PCS)** (ou `https://votre-carte/secours`).
2. **Créer un espace** : son nom, son type (DPS ou PCS), son **adresse** (ex. `festival-2027`), une première **organisation**, l'identifiant et le mot de passe du **premier responsable**.
3. **Organisations** : ajouter celles qui travaillent ensemble dans l'espace (voir ci-dessous).
4. **Canal réservé** (facultatif) : un canal du module radio de la carte, réservé à cet espace.
5. Donner au responsable l'adresse de l'espace (`https://votre-carte/secours/festival-2027`), son identifiant et son mot de passe.

**Responsable de l'espace** (chef de dispositif, élu ou agent chargé du PCS)
1. Ouvrir l'adresse de l'espace et se connecter.
2. **⚙️ Gestion › Nœuds LoRa de l'espace › ➕ Choisir des nœuds dans la liste de la carte** : chercher un nœud par son nom ou son numéro, cocher, choisir l'organisation où le ranger, **Attribuer**. Un nœud **pas encore allumé** s'ajoute par son **nom court** (ex. `PS01`) : il rejoint l'espace dès que la carte le voit. Un nœud qui sert aussi à un autre espace est signalé (sans dire lequel) : chacun de ses espaces voit sa position et ses **messages directs** ; ce qu'il envoie sur le **canal réservé** d'un espace ne va qu'à cet espace.
3. **⚙️ Gestion** : régler l'espace (pour un DPS : lieu, dates, public attendu, catégorie), cadrer la carte sur le site puis **Ouvrir la carte sur la vue actuelle**, créer les **comptes** des équipiers.
4. **👥 Équipes** : créer les postes et les équipes. Pour chacun : son type, son effectif prévu, un **emplacement fixe** (clic sur la carte) et/ou le **nœud LoRa** qu'il porte.

**Affichage** : le bouton en haut à droite de la carte donne le choix du fond (**Sombre**, Plan IGN, **Plan IGN sombre**, Photos aériennes, **Topographique (relief)**) et deux surcouches (**Relief ombré**, Noms des lieux). La barre entre la carte et le panneau se **tire à la souris** pour élargir ou rétrécir le panneau (double-clic : largeur d'origine ; au clavier, flèches gauche et droite). Ces choix sont retenus sur l'appareil.

**Équipiers** : ils ouvrent la même adresse avec leur compte, sur téléphone ou ordinateur. Ils voient la carte, les interventions, les équipes et la main courante ; ils changent l'état de **leur** équipe.

## Plusieurs organisations dans un même espace

Sur un festival, la Croix-Rouge et la Protection Civile tiennent souvent le dispositif ensemble ; dans un PCS, les services techniques, la police municipale et la réserve communale travaillent côte à côte. Un espace accueille donc plusieurs **organisations** :

- la liste propose les associations agréées les plus courantes (Croix-Rouge française, Protection Civile, UDSP, FFSS, Croix-Blanche, SNSM, UNASS, Ordre de Malte France, Secouristes Sans Frontières, SAP, UMPS, UMIS, Terre Neuve…), l'**ADRASEC** quand elle prête son concours au dispositif, et pour un PCS les services de la commune ; **Autre…** permet un nom libre ;
- chaque **nœud** et chaque **équipe** se range dans une organisation ; une équipe prend celle de son nœud ;
- l'onglet Équipes se **filtre** par organisation et donne l'effectif de chacune.

C'est un rangement, pas une séparation : tous les membres de l'espace voient toutes les équipes et toutes les interventions, comme autour d'un même poste de coordination. Deux organisations qui ne doivent rien partager ont chacune leur espace. Inscrire l'ADRASEC comme organisation d'un dispositif n'ouvre rien de la section ADRASEC de la carte.

## Au quotidien

- **📍 Interventions** : *Nouvelle intervention*, sa nature, un intitulé court, **📍 Pointer sur la carte**. Désigner une équipe la passe *en cours* et l'équipe *en intervention* ; **✓ Terminée** libère l'équipe. N'écrivez ni nom de victime ni information médicale nominative.
- **👥 Équipes** : état de chaque équipe (disponible, en poste, en intervention, en pause, indisponible) et âge de sa dernière position. Un rond = position reçue du nœud ; un carré = emplacement fixe.
- **🚩 Repères** : **🟢 Nouveau point de rassemblement**, son nom, **📍 Pointer sur la carte**. Tout l'espace le voit ; son bouton **📻 Envoyer aux équipes** le transmet par radio avec sa position et son code DFCI : « tout le monde se retrouve ici ». Au moment de l'envoi, un **mot à ajouter** est demandé (facultatif) : « repas à 12 h 30 », « rassemblement avant la relève ». Les responsables et le poste de coordination posent les repères.
- **🗒️ Main courante** : faits, décisions, messages. Les entrées ne se modifient pas ; l'export **CSV** sert de trace après l'événement.

Pour un **DPS**, l'onglet Équipes compare l'effectif prévu à la catégorie choisie (PAPS : 2 · DPS-PE : 4 à 12 · DPS-ME : 12 à 36 · DPS-GE : plus de 36 secouristes). C'est un **repère** : le dimensionnement réel sort de la grille d'évaluation des risques de l'association.

## Options de l'espace

Dans **⚙️ Gestion › Options de l'espace**, le responsable active ce dont son dispositif a besoin ; le reste disparaît de l'écran.

| Option | Ce qu'elle apporte |
|---|---|
| **Messages-types** | Des messages prêts à envoyer au terrain d'un clic (liste modifiable, 12 au plus). |
| **Canal réservé** | « Toutes les équipes » part en **un seul message** sur le canal que l'administrateur de la carte a réservé à l'espace, au lieu d'un message par équipe. |
| **Points de passage reçus** | Un point de passage posé dans l'application Meshtastic par le nœud d'une équipe crée une **intervention** à cet endroit ; déplacé, il la met à jour ; supprimé, il la termine. |
| **Trajets des équipes** | Bouton **〰 Trajet** d'une équipe : le chemin de son nœud sur les 12 dernières heures. |
| **Batterie des nœuds** | Niveau de batterie du nœud de chaque équipe ; à 20 % ou moins, il passe en rouge. |
| **Priorités et tableau de bord** | Trois priorités (urgente, normale, peut attendre) et, en tête des interventions, les chiffres du moment : urgentes à faire, sans équipe, en cours, équipes libres. |
| **Repères du PCS** *(PCS seulement)* | En plus des points de rassemblement : zones à évacuer (dessinées sur la carte), centres d'accueil, points d'eau, accès des secours, dangers. |
| **Rapport de fin** | **⬇ Rapport de fin** : une page figée, à garder ou à imprimer, avec les équipes, les interventions (durées, positions), la main courante et les accusés radio. |
| **Alerte si la radio de la carte tombe** | Un bandeau rouge et une ligne de main courante quand le module radio de la carte se déconnecte, puis quand il revient. |
| **Alerte par e-mail** | Une intervention **urgente** est aussi envoyée par e-mail aux adresses choisies (5 au plus). Il faut que l'envoi d'e-mails soit réglé sur la carte (Réglages avancés › E-mail). La carte n'envoie pas de SMS : utilisez l'adresse e-mail-vers-SMS de votre opérateur ou de votre service d'alerte s'il en propose une. |

Les points de rassemblement, eux, existent dans tous les espaces.

## Depuis le terrain, par radio

Un message texte envoyé par le nœud d'une équipe (application Meshtastic, sur un canal que la carte reçoit) arrive dans l'espace :

| Message | Effet |
|---|---|
| `INTER chute au virage 4` | crée une intervention **à la position du nœud**, confiée à l'équipe |
| `FIN` (ou `FIN victime remise aux pompiers`) | termine l'intervention en cours de l'équipe |
| `DISPO` · `POSTE` · `PAUSE` · `INDISPO` | change l'état de l'équipe |
| un point de passage (option) | crée une intervention à l'endroit du point |
| tout autre message | est noté dans la main courante, marqué 📻 |

Seuls les messages des nœuds attribués à l'espace sont pris en compte ; ceux des autres nœuds du réseau n'y entrent jamais. Exception : sur le **canal réservé** de l'espace, le message d'un nœud inconnu (il a la clé du canal) est noté dans la main courante, marqué « nœud hors espace », sans effet sur les équipes.

## Vers le terrain, par radio

Les **responsables** et les équipiers du **poste de coordination** (PC du dispositif, poste de commandement communal) écrivent aux équipes sans passer par le téléphone :

- **🗒️ Main courante › 📻 Écrire au terrain par radio** : choisir une équipe, ou *Toutes les équipes qui portent un nœud*, saisir un message court (200 caractères au plus), **Envoyer**.
- **📍 Interventions › bouton 📻 Envoyer** d'une intervention : le **message d'intervention** part à l'équipe engagée (à toutes si aucune n'est désignée). Il se limite à l'essentiel : le **lieu précis** (le repère saisi dans la fiche, ex. « Point B, près de la scène principale », puis la position et le **code DFCI**), la **nature** de l'intervention et, pour un DPS, l'**état apparent** (consciente, inconsciente et respire, ne respire pas, saignement important, détresse respiratoire). Exemple : `INTER Point B, près de la scène principale · 45.04320,3.88530 DFCI KD68F4.2 · Malaise · consciente`. Les précisions de la fiche et la priorité ne partent pas par radio.

Ce qu'il faut savoir :

- Sans canal réservé, c'est toujours un **message direct au nœud de l'équipe**, jamais un message sur un canal public : un canal du module de la carte est lu par tout le réseau. Avec des nœuds en firmware 2.5 ou plus, un message direct est chiffré de bout en bout.
- Avec un **canal réservé** (créé avec sa propre clé sur le module de la carte et sur les nœuds des équipes) et l'option active, « Toutes les équipes » part en un seul message sur ce canal. Un message à une équipe précise reste un message direct.
- L'envoi passe par le **module radio de la carte** : il doit être connecté (sinon le bouton est grisé et le motif affiché).
- Chaque envoi est noté dans la main courante, avec son **accusé** : *envoyé*, *relayé*, puis *reçu* quand le nœud de l'équipe a répondu, ou *non remis*.
- « Toutes les équipes » envoie un message par équipe, l'un après l'autre (quelques secondes entre deux). Limite : 30 messages par 10 minutes et par espace, pour ménager le temps d'antenne.
- Le texte envoyé n'est **pas** recopié dans les messages de la carte.
- Pas de point de passage sur la carte de l'application Meshtastic : un point de passage se diffuse sur un canal et s'afficherait chez tout le monde. La position part en texte (coordonnées et DFCI).

## Questions fréquentes

- **Le responsable a perdu son mot de passe** : l'administrateur de la carte en remet un par **Nommer un responsable / remettre son mot de passe** (même identifiant). Pour un équipier, c'est le responsable de l'espace qui le fait (⚙️ Gestion › Comptes).
- **Supprimer un espace** : ses membres n'y ont plus accès ; son fichier est gardé dans `secours/corbeille/` sur le serveur.
- **Combien de temps les données sont-elles gardées ?** Réglable par le responsable (365 jours par défaut, 7 au minimum) : la main courante et les interventions terminées plus anciennes sont effacées.
- **Le nœud attendu par son nom court n'arrive pas** : la carte ne l'a pas encore vu, ou plusieurs nœuds portent ce nom court (rien n'est alors attribué : choisissez-le dans la liste). Le nom court est celui réglé sur le nœud (4 caractères en général).
- **Une équipe n'apparaît pas sur la carte** : elle n'a ni emplacement fixe ni position reçue. Vérifier que son nœud est attribué à l'espace, choisi dans la fiche de l'équipe, et qu'il envoie sa position.
