# Nouveautés par version

Le texte de la section de chaque version est repris tel quel dans la note de la release GitHub.

## En préparation

## 2.39.0

### 📡 Couverture calculée sur les seuls nœuds actifs
- **Nouvelle option « Nœuds actifs uniquement »**, dans le panneau « Couverture calculée » et dans le panneau « Plan pour couvrir » (réglages des calculs). Jusqu'ici, ces deux outils comptaient tout relais ou passerelle entendu dans les dernières 24 h, même en panne ou coupé depuis des heures — ce qui gonflait le pourcentage de couverture affiché par rapport à ce que le réseau dessert réellement à l'instant T. Avec l'option cochée, seuls les nœuds considérés « actifs » par le tableau de bord (même seuil que le compteur de nœuds actifs) entrent dans le calcul, aussi bien côté Meshtastic que MeshCore.

## 2.38.0

### 🔷 Des formes en plus des couleurs pour les nœuds Meshtastic
- **Légende et marqueurs Meshtastic : une forme par catégorie**, comme c'était déjà le cas côté MeshCore. Jusqu'ici seule la couleur distinguait relais, clients, clients muets/cachés, traceurs/capteurs et inconnus — repérable difficilement pour les daltoniens ou sur un petit écran. Désormais : losange pour les relais/routeurs, rond plein pour les clients, anneau creux pour les muets/cachés, triangle pour les traceurs/capteurs, carré pour les inconnus.

## 2.37.0

### 🚨 Alerter les habitants, et carte publique plus vivante
- **Espaces Secours (PCS) : alerter les habitants.** Option à activer par espace (désactivée par défaut), réservée aux responsables d'un PCS : un message part sur le **canal principal** du module (celui que tout nœud Meshtastic/MeshCore du secteur lit, à la différence du canal réservé de l'espace) pour prévenir directement la population — à réserver aux alertes qui concernent vraiment tout le monde (évacuation, danger immédiat). Limité à 3 envois par heure. Noté dans la main courante comme un message public normal (contrairement aux échanges internes de l'espace, jamais gardés par la carte).
- Mur des donateurs : le message affiché est désormais « Merci à *Nom* pour son don de *X* € ! » (au lieu de « *Nom* a donné... »). La croix qui masque le bandeau ne le coupe plus pour toujours : il réapparaît automatiquement une semaine plus tard.
- **Carte publique : badges de rôle colorés et compteur de paquets en direct.** Dans les info-bulles des nœuds, un petit badge reprend désormais la couleur et la forme du marqueur (relais, passerelle, nœud ; répéteur ou room server MeshCore), pour relier plus vite un nœud à sa légende. Le témoin « en direct » pulse maintenant à chaque paquet reçu et affiche un compteur de paquets par minute.

## 2.36.0

### 🌐 Langue par défaut corrigée, et relevés de capteurs qui ne se bloquent plus
- **Langue par défaut de l'édition France** : un visiteur dont le navigateur n'est pas réglé en fr/en/es/de/it/pt/nl/pl/cs voyait la carte démarrer en anglais au lieu du français. Corrigé (le sélecteur manuel de langue, lui, fonctionnait déjà).
- **Relevés automatiques de capteurs MeshCore** : quand un mot de passe administrateur est mémorisé pour un nœud, un échec de connexion admin avant un relevé automatique (statut, télémétrie) bloquait tout le cycle au lieu de continuer sans session — reproductible à chaque tentative sur un maillage instable. Les relevés automatiques reprennent désormais normalement même quand la session admin échoue.
- Gestion des espaces Secours : le titre et le texte d'introduction sont centrés (au lieu de rester collés à gauche sur un grand écran).
- Recherche de sites (plan pour couvrir le département, zone dessinée à la main, plan à budget) : nouveau plafond d'altitude facultatif pour écarter les propositions trop hautes, souvent au-dessus de la limite des arbres (rien où fixer une antenne) et difficiles d'accès.

## 2.35.0

### 🚨 Rubrique Opérations, et repère « où suis-je »
- **Nouvelle rubrique Opérations**, à côté de Réseau, Messages, Couverture, Gérer et Réglages : Mode urgence, Secteurs d'alerte, Espaces Secours et section ADRASEC — tout ce qui sert le jour J — ne sont plus des lignes perdues parmi 25 dans le menu Outils. La rubrique n'apparaît que si au moins une de ces fonctions est ouverte au compte ; chacune garde sa propre condition (rôle de gestion, administrateur, accès ADRASEC validé).
- **Fil de position** (« Rubrique › Onglet ») affiché en permanence sous les rubriques de la carte, cliquable pour y revenir. Les espaces Secours et la section ADRASEC ont le leur, à côté du bouton d'aide : « Espace Secours · *Nom* › *Onglet* » ou « Section ADRASEC · *Nom* › *Onglet* ».
- Ces 4 fonctions restent cherchables (Ctrl+K) une fois sorties du menu.

## 2.34.0

### 📡 Couverture : cocher des sites proposés et voir leur couverture cumulée
- Dans toutes les listes de sites proposés (plan pour couvrir le département ou une zone dessinée, **plan à budget**, **sites routiers**, déplacement de relais, relier deux lieux, couvrir un point), chaque proposition a une case **Ajouter à ma sélection**. Une barre en bas de la fiche compte les sites cochés (10 au plus) et donne la **📡 Couverture de ma sélection** : surface cumulée, part du département et apport propre de chaque site.
- **↩ Revenir à la liste** ramène à l'analyse d'origine, telle qu'elle était, cases comprises : on peut comparer plusieurs combinaisons sans relancer le calcul.
- Sites routiers : le bouton « Couverture de ce site » n'apparaît plus en double.

### 🧭 Ergonomie : même aide et mêmes fenêtres sur toutes les pages
- **Espaces Secours et section ADRASEC** : bouton **?** (aide de la page, dans une fenêtre), **🔎 recherche d'une fonction** (Ctrl+K) qui mène à l'onglet ou au bloc voulu, et **confirmations et saisies dans l'interface** à la place des boîtes du navigateur (38 remplacées). Les messages d'erreur passent par les annonces en bas d'écran.
- La recherche de ces pages se construit toute seule à partir des onglets et des titres affichés : un bloc ajouté devient cherchable sans liste à tenir.
- **Menu Outils** : chaque entrée porte son niveau d'affichage (simple, opérateur, expert) et ses mots-clés de recherche directement dans le menu. « radiogoniométrie », « point de rassemblement » ou « PCS » mènent maintenant à la bonne entrée. Registre des relais et Relier un companion MeshCore passent au niveau Opérateur.
- Envoi d'un point de rassemblement : la fenêtre du mot complémentaire donne un exemple et précise que laisser vide envoie le point seul.
- **Une seule entrée pour relier un module** : « 🔌 Connecter un module… » (Bluetooth, USB, adresse IP, et le débranchement). Les entrées « Module USB de ce PC », « Module Bluetooth » et « Relier un companion MeshCore » quittent le menu. « Topologie et simulation MeshCore » est rangée sous MeshCore.
- **Onglet Couverture sans défilement** : plan, plan à budget, sites routiers et déplacement de relais sont des blocs repliables (une ligne chacun, le plan ouvert par défaut, choix gardé sur l'appareil). Dans un espace Secours, les deux rappels « par radio » de la Gestion se replient aussi.

### 💬 Aide dans les champs et erreurs qui disent quoi faire
- **Aide dans le champ** : en entrant dans un champ qui attend une valeur précise, une bulle dit ce qui est attendu, donne un **exemple** et, **au fil de la frappe**, si la forme est bonne (« encore 5 caractères », « doit commencer par mqtt:// », « un point, pas une virgule »). Un petit « ? » au bord du champ signale cette aide. La bulle ne déplace pas la page et n'empêche pas d'enregistrer.
- Une cinquantaine de champs en profitent d'emblée : adresse du broker MQTT, sujet racine, canaux et clés, adresse IP d'un module, code de zone MeshCore, indicatif, QTH locator, gisement et incertitude, latitude et longitude, numéros de nœuds, nom court, adresse d'un espace Secours, identifiants, mots de passe, e-mails.
- Chaque notion est écrite une seule fois : la même explication partout où elle est demandée, sur la carte comme dans les espaces Secours et la section ADRASEC.
- **Messages d'erreur** : les refus les plus courants disent maintenant ce qui est attendu, avec un exemple (« Position invalide : latitude entre -90 et 90, longitude entre -180 et 180 (ex. 45.043, 3.885) », « Canal invalide : choisissez un canal du module, de 0 à 7 »…).

### 📡 Section ADRASEC : un opérateur membre de plusieurs ADRASEC
- **Un même compte peut être membre de plusieurs ADRASEC** hébergées sur la carte (un opérateur à cheval sur deux départements). Le président de la seconde ADRASEC l'intègre depuis *⚙️ Gestion › Intégrer un compte de la carte* ; ce n'est plus refusé.
- **Une fiche par ADRASEC** : l'indicatif, la qualité et le nœud porté sont repris de la première ; l'équipe, la fonction et le rôle de président sont propres à chaque ADRASEC.
- **Choix de l'ADRASEC affichée** en haut de la page, pour un membre de plusieurs ADRASEC (retenu sur l'appareil). Canaux à écrire sur sa radio et équipes des secteurs d'alerte : ceux de toutes ses ADRASEC.
- **Relevé envoyé par radio** (`GONIO 125`) par un opérateur membre de plusieurs ADRASEC : il va à l'ADRASEC dont le **canal a été utilisé** (jeu de canaux de l'ADRASEC) ; en message direct ou sur un canal commun, à toutes ses ADRASEC où une recherche est en cours.
- Gestion des comptes de la carte : un compte membre de plusieurs ADRASEC les affiche toutes ; ses fiches se règlent dans la page ADRASEC.

## 2.33.0

### ⛑️ Espaces Secours : fonds de carte, panneau élargissable, chaque espace gère ses nœuds
- **Fonds de carte au choix** dans un espace, comme sur la carte du réseau : Sombre, Plan IGN, Plan IGN sombre, Photos aériennes, Topographique (relief), OpenStreetMap, avec en surcouche le **relief ombré** et les noms des lieux. Le choix est retenu sur l'appareil.
- **Panneau de droite élargissable** : la barre entre la carte et le panneau se tire à la souris (double-clic : largeur d'origine ; flèches au clavier). La largeur est retenue sur l'appareil.
- **Mot ajouté à l'envoi d'un repère** : le bouton 📻 d'un point de rassemblement (espace Secours comme section ADRASEC) demande un mot à joindre au message avant de l'envoyer — « repas à 12 h 30 », « rassemblement avant la manœuvre ». Laisser vide envoie le repère seul.
- **Fond OpenStreetMap retiré** de la carte d'un espace : leurs serveurs refusent ce genre d'usage et renvoyaient des tuiles « Access blocked ». Les autres fonds (Sombre, Plan IGN, photos, topographique) ne sont pas concernés.
- **Chaque espace gère ses propres nœuds** : ce sont désormais les **responsables de l'espace** qui choisissent ses nœuds, dans *⚙️ Gestion › Nœuds LoRa de l'espace* (recherche dans la liste de la carte, nœud attendu par son nom court, rangement par organisation, retrait). L'administrateur de la carte crée l'espace, nomme son responsable et réserve un canal ; il peut seulement retirer un nœud. 
- **Un nœud peut servir à plusieurs entités** (le coordinateur commun à une association, au PCS, à la préfecture, membre de l'ADRASEC) : chaque espace qui l'a ajouté voit sa position et ses messages directs ; ce qu'il envoie sur le canal réservé d'un espace ne va qu'à cet espace. Sur un canal réservé, c'est désormais le canal qui décide de l'espace destinataire.
- **Page de gestion des espaces sur toute la largeur** de l'écran, les fiches côte à côte : moins de défilement.

## 2.32.0

### ⛑️ Espaces Secours : plusieurs organisations, nœuds choisis dans une liste, options
- **Plusieurs organisations dans un même espace** : Croix-Rouge et Protection Civile sur le même festival, services techniques et réserve communale dans un PCS. La liste propose les associations agréées les plus courantes (Croix-Rouge française, Protection Civile, UDSP, FFSS, Croix-Blanche, SNSM, UNASS, Ordre de Malte France…), l'ADRASEC quand elle prête son concours, et un nom libre. Chaque nœud et chaque équipe se range dans une organisation ; l'onglet Équipes se filtre par organisation. C'est un rangement : tout l'espace reste commun.
- **Nœuds choisis dans la liste de la carte** (*Outils › ⛑️ Espaces Secours*) : on cherche un nœud par son nom ou son numéro, on coche, on attribue, au lieu de taper les numéros. Un nœud **pas encore allumé** s'ajoute par son **nom court** : il rejoint l'espace dès que la carte le voit.
- **Points de rassemblement** dans tous les espaces (onglet 🚩 Repères) : posés sur la carte, vus de tous, et envoyés aux équipes par radio avec la position et le code DFCI : « tout le monde se retrouve ici ».
- **Options activables par espace** (⚙️ Gestion) : messages-types, canal réservé, points de passage Meshtastic reçus → interventions, trajets des équipes, batterie des nœuds, priorités et tableau de bord, repères du PCS (zones à évacuer, centres d'accueil, points d'eau, accès des secours, dangers), rapport de fin (page figée à garder ou imprimer), alerte quand le module radio de la carte tombe, alerte par e-mail d'une intervention urgente.
- **Message d'intervention** (bouton 📻 d'une intervention) limité à l'essentiel : **lieu précis** (repère du site saisi dans la fiche, position et code DFCI), **nature** et, pour un DPS, **état apparent** de la victime. Les précisions de la fiche ne partent plus par radio.
- **Canal réservé** : l'administrateur de la carte peut réserver un canal du module radio à un espace ; « Toutes les équipes » part alors en un seul message sur ce canal.
- **Séparation côté réception** : les messages et points de passage des nœuds d'un espace, et ce qui passe sur son canal réservé, n'apparaissent plus dans les messages de la carte (la position des nœuds reste visible sur la carte du réseau).
- Les accusés radio sont gardés dans le fichier de l'espace : ils restent affichés après un redémarrage de la carte.

### 📡 Section ADRASEC : points de rassemblement et options
- **Points de rassemblement** (onglet 👥 Équipes) : posés par tout membre, vus de toute la section, diffusés par radio (point de passage et message, avec position et code DFCI) sur le canal choisi.
- **Options de la section** (⚙️ Gestion, président) : batterie des nœuds des membres, alerte quand le module radio de la carte tombe, messages aux équipes par radio avec messages-types et accusé, trajets des membres.
- Correction : le choix du canal pour diffuser la position estimée d'une balise affichait toujours « module radio non relié ».

## 2.31.0

### ⛑️ Espaces Secours : DPS des associations de sécurité civile, volet radio du PCS des communes
- Nouveaux **espaces séparés de tout le reste de la carte**, créés par l'administrateur (*Outils › ⛑️ Espaces Secours*) : un **DPS** (dispositif prévisionnel de secours : festival, course, fête locale) pour une association de sécurité civile, ou le volet radio d'un **PCS** (plan communal de sauvegarde) pour une commune. Chaque espace a son adresse (`/secours/festival-2027`).
- Dans un espace : **interventions pointées sur la carte** (à faire, en cours, terminée, urgente), **équipes et postes** avec la **position en direct** du nœud LoRa porté par chaque équipe, **main courante** horodatée exportable en CSV. Pour un DPS, l'effectif prévu est comparé à la catégorie du dispositif (PAPS, DPS-PE, DPS-ME, DPS-GE), à titre de repère.
- **Remontées du terrain par radio** : un message `INTER chute au virage 4` envoyé par le nœud d'une équipe crée une intervention à sa position ; `FIN` la termine ; `DISPO`, `POSTE`, `PAUSE`, `INDISPO` changent l'état de l'équipe ; tout autre message est noté dans la main courante.
- **Vers le terrain, par radio** : les responsables et le poste de coordination écrivent à une équipe (ou à toutes, l'une après l'autre) depuis la main courante, et envoient une intervention avec sa position et son code DFCI. Toujours en **message direct** au nœud de l'équipe, jamais sur un canal ; l'accusé (*envoyé*, *relayé*, *reçu*, *non remis*) s'affiche dans la main courante, et le texte n'est pas recopié dans les messages de la carte.
- **Cloisonnement** : ces espaces n'ont rien de commun avec la section ADRASEC, qui reste réservée aux radioamateurs. Un espace = **un fichier à lui** sur le serveur ; ses **comptes n'existent que dans cet espace** (un secouriste ou un agent communal n'a aucun accès à la carte, au réseau radio ni à l'ADRASEC) ; il ne voit que **les nœuds que l'administrateur lui attribue**, et un nœud n'appartient qu'à un espace. L'administrateur de la carte crée l'espace et nomme son responsable, mais n'entre pas dedans.
- Les fichiers des espaces ne partent pas dans les sauvegardes de la carte : chaque espace garde ses copies quotidiennes sur le serveur (7 jours). Mode d'emploi : page **Espaces Secours** du wiki.

### 📱 Android : l'appli ne télécharge plus elle-même la mise à jour
- Une mise à jour disponible n'est plus téléchargée puis installée par l'appli : un bouton ouvre simplement sa page de version dans le navigateur. Évite le signalement « Appli dangereuse bloquée » de Play Protect, qui repérait ce comportement comme typique d'une appli installant d'autres applis.

## 2.30.1

### 🖥️ Système 64 bits : vérifié à l'installation
- Le script d'installation refuse maintenant, avec un message clair, un système **32 bits** (par exemple Raspberry Pi OS 32 bits, `armhf`), au lieu de laisser Docker échouer sur `no matching manifest`. La carte demande un Linux 64 bits (x86-64 ou ARM64). Le README, la page Installation et le Dépannage le disent en toutes lettres, avec la bonne vérification (`dpkg --print-architecture`).

### 💜 Mur des donateurs : noms HelloAsso affichés tels que saisis
- Les dons HelloAsso, ajoutés à la main par l'administrateur, s'affichent maintenant **avec le nom exactement tel qu'il a été saisi** : plus d'abréviation automatique (« 42BARBE » ne devient plus « 42B*** »). À l'administrateur de l'abréger lui-même s'il le souhaite. Les parrains GitHub Sponsors, lus automatiquement, restent abrégés.

### 🧰 Menus du haut toujours accessibles jusqu'en bas
- Sur ordinateur, le menu **Outils** (surtout avec « Les deux » réseaux affichés) pouvait être plus haut que la fenêtre : les dernières entrées (Carte publique et exports, Mode urgence, Rapport hebdomadaire…) sortaient de l'écran sans moyen de les atteindre. Les menus Outils, Couches et Couverture radio s'arrêtent maintenant en bas de la fenêtre et **défilent**.

## 2.30.0

### 🖱️ Les boutons du menu Outils marchent de nouveau
- **13 boutons ne faisaient rien quand on cliquait dessus** (🔌 Module USB de ce PC, 📶 Module Bluetooth, 📟 Client Meshtastic, ⚡ Flasher un module Meshtastic, ⚡ Flasher un module MeshCore, 🛠️ Configurer un répéteur MeshCore, 📟 Application MeshCore, 🕸️ Topologie et simulation (Meshtastic et MeshCore), ⇄ Passerelle inter-réseaux, 🛰️ Section ADRASEC, ☀️ Thème clair, 📲 Installer l'application). Le gestionnaire des **couches** de la carte était posé sur tous les boutons de même apparence, y compris ceux du menu Outils, et écrasait leur vraie action. Il ne s'applique plus qu'aux vraies bascules de couche.
- Au passage, une **clé parasite** avait pu s'enregistrer dans les couches gardées par le navigateur : elle est retirée toute seule, les choix légitimes sont gardés. Les couches **Stations APRS**, **Rivières** et **Capteurs LoRaWAN** sont enfin mémorisées d'une visite à l'autre.

### 🔌 Un clic sur USB ou Bluetooth répond toujours quelque chose
- Chrome n'ouvre l'USB (Web Serial) et le Bluetooth (Web Bluetooth) que sur une page **sécurisée** : carte en HTTPS, ou ouverte depuis la machine où elle tourne. Carte ouverte en `http://` depuis un autre PC (adresse Tailscale, par exemple), ou dans Firefox ou Safari : les boutons **🔌 Module USB de ce PC** et **📶 Module Bluetooth** sont marqués **⚠**, et un clic explique en clair ce qui manque au lieu de ne rien faire.
- Tous les chemins de connexion d'un module (Meshtastic et MeshCore, USB et Bluetooth, menu Outils et fiche « Connecter un module ») **ne sortent plus en silence** : fenêtre de choix fermée, liste vide, port déjà pris, Bluetooth refusé… chaque cas donne un message qui dit quoi faire.

### 🪟 Fenêtres plus larges, et un clic à côté pour fermer
- Sur un écran large, les fenêtres de réglages (🎚️ Fonctions de la carte, 👁️ Fonctions affichées…) s'ouvrent **plus larges** et leurs listes passent sur **deux colonnes** : tout se voit sans faire défiler, au lieu d'une colonne étroite au milieu de l'écran.
- Bouton **⤢** à côté de la croix : élargit encore (jusqu'à 1 480 px, ou 1 800 px pour les très grandes fenêtres), **une fois pour toutes les fenêtres**, et le choix est gardé pour la prochaine visite. Masqué en dessous de 1 000 px de large : téléphone et tablette ne changent pas.
- **Un clic à côté de la fenêtre la ferme**, comme la croix ✕ ou la touche Échap (plus besoin de remonter chercher la croix en haut d'une fenêtre longue). Un clic dans la fenêtre, même sur un bord ou une zone vide, ne ferme jamais, et un glissement de sélection relâché en dehors non plus. Si une **saisie est commencée**, la fenêtre reste ouverte et le dit : rien n'est perdu. La fenêtre d'installation, elle, ne se ferme pas de cette façon.

### 🧾 Opérations récentes : ce qui a vraiment été envoyé
- *Gérer › Programmer › Opérations récentes* affichait les **noms de champs du firmware** (« télémétrie · device (nodeInfoBroadcastSecs) ») et jamais les valeurs. Chaque opération montre maintenant, **réglage par réglage et en français**, ce qui est parti vers le nœud, avec les unités : « Fiche du nœud : toutes les 3 h », « Puissance d'émission : 20 dBm », « Rôle : Routeur tardif ».
- **Valeur d'avant** quand elle est réellement connue : « avant : toutes les 15 min (lu il y a 20 min) » à partir de la dernière configuration lue sur le nœud avant l'envoi. Une correction lancée depuis *🚦 Contrôle du trafic* affiche l'intervalle **mesuré** : « mesuré sur 24 h : toutes les 4 min » — c'est une mesure du trafic, pas le réglage enregistré dans le nœud. Sans lecture ni mesure, seule la valeur envoyée est affichée.
- **Aucune clé n'est affichée** : un canal modifié indique « clé envoyée (non affichée) ». Les clés d'administration, mots de passe et jetons sont masqués, y compris pour un réglage que la carte ne connaît pas encore. Les paramètres d'une opération ne sortent plus du serveur, même pour le suivi d'une modification.
- Résumé long replié sous « et N autres réglages » (rien n'est supprimé), lisible sur téléphone, valeurs en texte bien contrasté.

### 🌡️ Relevé des capteurs MeshCore : il repart tout seul
- **Un nœud qui ne répond pas ne bloque plus les autres** : chaque nœud d'une tâche MeshCore a maintenant une durée maximale, **réglable dans MeshCore › Companion › Module MeshCore** — *Délai maximal d'un relevé, par nœud* (1 à 30 min, 4 par défaut : télémétrie, état, chemin, trace) et *Délai maximal d'une lecture complète, par nœud* (5 à 240 min, 60 par défaut : lecture des réglages, programmation, mise en service) — et chaque tâche aussi. Une opération qui ne rendait jamais la main arrêtait **tous** les relevés automatiques suivants, sans rien signaler, jusqu'au redémarrage de la carte.
- **Relance rapide** : une demande de relevé restée sans réponse est retentée deux fois, à un quart d'heure d'intervalle, au lieu d'attendre l'intervalle complet (une seule tentative perdue coûtait 3 h de trou pour un relevé toutes les 3 h).
- **Plus de blocage définitif** : une tâche arrêtée depuis l'interface pendant qu'elle attendait son tour n'était jamais marquée terminée ; ses nœuds n'étaient alors plus jamais relevés automatiquement, même après un redémarrage (le fichier des tâches est réparé au démarrage). Le relevé des capteurs repart de lui-même si une tâche traîne plus d'une heure.
- **Alerte « relevés en retard »** : elle fonctionne aussi pour un nœud réglé avant l'arrivée de ce suivi et jamais relevé depuis.
- **Alertes des capteurs visibles hors de la zone** : l'alerte « relevés en retard » et celle d'une mesure hors seuil s'affichent maintenant même si le capteur est hors de la zone de la carte. Un capteur dont on a soi-même réglé le relevé est un nœud qu'on suit, où qu'il soit. Les autres alertes MeshCore (muet, batterie, canal) restent filtrées sur la zone.
- Rappel affiché dans l'onglet *Capteurs* : le nombre de relevés indiqué sous une mesure est celui de la **période affichée** (1, 7, 30 ou 90 jours), pas un total.

### 🧭 Nœuds d'un département : Meshtastic, MeshCore ou les deux
- L'écran *Nœuds d'un département* (recherche « 43 », « Haute-Loire »…) liste aussi les **nœuds MeshCore**, rangés d'après la position de leur dernière annonce. Il part du réseau affiché sur la carte (Meshtastic, MeshCore ou les deux) et un sélecteur **Meshtastic / MeshCore / Les deux** permet d'en changer sur place ; pastille **MT** / **MC** sur chaque ligne, colonne *Réseau* dans l'export CSV. Un clic sur un nœud MeshCore ouvre sa fiche MeshCore, et la fermer ramène à la liste.

### 🛰️ ADRASEC : secteurs d'alerte sur les équipes de la section, transfert avec l'historique
- **Secteurs d'alerte → équipes ADRASEC** : la liste *Équipe* d'un secteur propose maintenant, dans une rubrique « Équipes ADRASEC 43 », les équipes des sections ADRASEC auxquelles on a accès (administrateur de la carte : toutes ; membre : la sienne ; personne d'autre). Le secteur suit le **nœud porté** par chaque membre de l'équipe, au fil des changements (nouveau nœud, changement d'équipe). Le lien **Voir les équipes ADRASEC 43** ouvre la page de la section sur l'onglet *👥 Équipes*. Équipe ou section supprimée : le secteur la perd et se désactive s'il ne suivait qu'elle, comme pour une équipe de la carte. Carte sans ADRASEC : rien ne change.
- **Transfert de la section : la main courante, les recherches et les relevés partent aussi**, avec le nom de leurs auteurs. Importer deux fois le même fichier ne double rien, la durée de conservation de la carte d'arrivée est respectée, et le récapitulatif avant import annonce combien d'entrées, de recherches et de relevés seront repris. Une recherche en cours reste ouverte à l'arrivée, **sans lien terrain ni diffusion radio** (à recréer sur place). Toujours aucun compte, mot de passe, condensat ni jeton dans le fichier, pas même celui d'un lien terrain.

## 2.29.0

### 🗺️ Secteurs d'alerte (géorepérage)
- *Outils › 🗺️ Secteurs d'alerte* (lecture pour les gestionnaires, modification par les administrateurs) : un **polygone** ou un **cercle** dessiné sur la carte, rattaché à une **équipe** (ses membres du moment) et/ou à des nœuds choisis (Meshtastic, ou MeshCore par clé publique) ; alerte quand un intervenant **sort** du secteur, y **entre** (zone à éviter) ou les deux.
- **Pas de fausses alertes** : marge autour de la limite, 2 positions de suite pour changer d'état (réglable), délai minimal entre deux alertes pour un même nœud, paquet entendu par plusieurs passerelles compté une fois. Les **positions floutées** (firmware 2.7/2.8) élargissent la marge ; une position plus floue que le secteur est ignorée et notée une fois.
- **Perte de contact** en option (aucune position pendant 10 min à 2 h) et **message LoRa** court en option sur un canal (au plus un toutes les 30 s).
- Les alertes arrivent au même endroit que les autres : *Réseau › Alertes*, son et notification des gestionnaires connectés, appli Android, domotique MQTT. **Journal** des entrées, sorties et pertes de contact, filtre par secteur, **export CSV**.
- L'ancienne « zone de sécurité » (cercle) des équipes devient un secteur automatiquement. Secteurs, alertes et demandes d'aide des équipes ne partent plus vers la vue publique.

### 🚨 Mode urgence
- *Outils › 🚨 Mode urgence* (activé et terminé par un administrateur ; les gestionnaires lisent le tableau de crise et ajoutent des notes), inspiré du mode urgence de MeshWave : **bandeau rouge** et cadre rouge pour tous les comptes connectés, **carte simplifiée et contrastée** (réseau ordinaire au second plan, intervenants, demandes d'aide et secteurs devant), **tableau de crise** (demandes d'aide, alertes des secteurs, intervenants, alertes critiques), état du réseau toutes les 10 s, signalements et main courante remis en service s'ils étaient masqués.
- **Journal horodaté de la crise** : déclenchement, demandes d'aide, messages de détresse entendus sur les canaux (SOS, MAYDAY, 🔔…), événements des secteurs, alertes critiques nouvelles, notes à la main, fin ; **export CSV**, les 10 crises précédentes sont gardées. Résiste à un redémarrage.
- Le mode urgence ne change aucun réglage radio et n'envoie aucun message LoRa.

### ⚡ La carte ne se fige plus
- Le **relais** de chaque paquet est retrouvé dans un index (avant, toute la table des nœuds était relue à chaque paquet) ; la **liste des nœuds** est préparée au plus toutes les 10 s et partagée entre tous les visiteurs, qui ne reçoivent plus que les nœuds modifiés ; statistiques et alertes Meshtastic calculées par la base ; **purge horaire par petits lots** de 250 lignes ; nouveaux nœuds filtrés par zone ; paquets MeshCore hors périmètre écartés d'après le sujet MQTT.
- **Santé de la carte › Réactivité** (*Réseau*) : **gels** mesurés chaque minute (alerte « attention » au-delà de 1,5 s répétés, « critique » au-delà de 5 s), courbe des gels, **tâches les plus lentes de la dernière heure** (durée maximale, moyenne, nombre d'exécutions) et, pour chaque gel récent, la tâche suspecte. Outil `outils/banc-reactivite.js` pour mesurer une installation.
- Relief Copernicus (hors de France) décodé dans un fil séparé et tuiles lues une par une ; points de cession dans les calculs de couverture : la carte reste réactive pendant un chargement de relief.

### 🏔️ Relief approximatif et place prise par le relief
- **Relief approximatif du monde entier** (NOAA ETOPO1, ≈ 9 km, 19 Mo téléchargés une seule fois en arrière-plan) : le temps que le relief précis d'une zone se télécharge, la couverture d'un point, d'un site, de plusieurs sites ou du réseau, la simulation « et si… » et « relier deux lieux » s'affichent déjà, marquées **« ⏳ Relief approximatif »**, puis sont recalculées toutes seules sur le relief précis. Jamais gardé en cache comme s'il était précis. **Désactivé par défaut** dans l'édition France (`RELIEF_MONDE=oui`, ou *Outils › 🗺️ Toute la France › 💾 Relief téléchargé sur ce serveur*).
- **Purge du cache du relief** (administrateur, même bloc) : espace occupé, chaque zone avec sa taille et sa dernière utilisation, suppression **par zone**, des zones **inutilisées depuis N jours** ou de **tout** (avec confirmation), **plafond en Go** au-delà duquel les zones les moins récemment utilisées sont supprimées d'elles-mêmes. La zone de la carte, une zone en chargement ou utilisée il y a moins de 10 min ne sont jamais supprimées ; chaque purge est écrite dans le journal.

### 🔎 Chercher dans les messages
- Champ **« Chercher un mot, un nom ou un indicatif… »** en haut de l'onglet *Messages* : texte des messages Meshtastic et MeshCore (index plein texte SQLite, **majuscules et accents ignorés**, début de mot : « chap » trouve « chapeau »), **nom long, nom court, identifiant** (`!xxxxxxxx`, numéro, début de clé MeshCore) de l'expéditeur et du destinataire d'un message direct, sous leur **nom actuel** même si le nœud a été renommé.
- Résultats du plus récent au plus ancien, termes surlignés, raison de la correspondance (texte, expéditeur, destinataire), « Plus anciens… » ; un clic ouvre le message à sa place dans son canal.
- **Mêmes droits** que la lecture des messages : membres connectés ; en démonstration, canaux publics seulement, jamais les messages directs. L'index se construit au premier démarrage et suit la purge de rétention.

### 💜 Mur des donateurs
- *Outils › 📤 Carte publique et exports › Mur des donateurs* (administrateur) : un **bandeau discret**, en haut de la carte et de la page publique, remercie ceux qui soutiennent le projet (nom abrégé « 42BAR*** », pays, montant seulement si vous le voulez). Chaque visiteur peut le fermer pour de bon. Tout est **désactivé par défaut**.
- **HelloAsso** (dons au Radio-club du Velay) : HelloAsso ne dit pas si un donateur accepte d'être affiché, donc **aucun don n'apparaît automatiquement** : l'administrateur ajoute chaque entrée à la main, avec la case « accord du donateur » obligatoire. Les identifiants d'API servent seulement à vérifier l'accès.
- **GitHub Sponsors** : seuls les sponsors que GitHub marque **publics** sont lus (jeton côté serveur, jamais envoyé au navigateur). Réglages aussi par `.env` (`HELLOASSO_*`, `GITHUB_SPONSORS_*`, `DONATEURS_INTERVALLE_HEURES`) ; clés et jetons ne sont jamais réaffichés ni écrits dans le journal.

### 🌍 Bandeau « Switch to the world map »
- Un visiteur dont le navigateur n'est pas en français peut se voir proposer l'édition monde par un petit bandeau en anglais, sur la carte et la page publique. **Désactivé par défaut** : *Réglages › Réglages avancés › Affichage › « Proposer la carte monde aux visiteurs étrangers »* (`BANDEAU_MONDE`) et « Adresse de la carte monde » (`BANDEAU_MONDE_URL`, vide = page de l'édition monde sur GitHub). Le bandeau se place là où il ne cache rien et se ferme pour de bon d'un clic.

### 📡 Firmware Meshtastic 2.8
- **Signature des paquets** vérifiée par la carte avec la clé publique de l'expéditeur (✍ signé, ✍ ? clé inconnue, ⚠ signature invalide), badge « signe ses paquets » dans la fiche du nœud.
- **Nœuds renumérotés** (numéro dérivé de la clé en 2.8) : fusion sûre quand le numéro découle de la clé, nœuds réinitialisés proposés à la fusion (même nom et matériel), fusion étendue aux équipes, favoris et responsables, **annulation des 20 dernières fusions**.
- Fiche du nœud : « aucune position reçue » expliqué (position coupée par défaut en 2.8), position floutée montrée par un cercle. Presets TinyFast/TinySlow, LiteFast/LiteSlow, NarrowFast/NarrowSlow reconnus partout.

### 🔭 MeshCore : observatoires publics (CoreScope)
- Les observatoires communautaires [CoreScope](https://github.com/Kpa-clawbot/corescope) (France, Texas, Belgique/Pays-Bas) deviennent une **source MeshCore** sans compte ni clé : *MeshCore › Companion › Observatoires publics*, ou un clic dans le message « Aucune source MeshCore ». L'adresse est testée avant d'être ajoutée.
- API interrogée à notre rythme (toutes les 20 s), **plafond par minute**, filtre par codes de zone (`adresse=LYS,CFE`), nœuds connus importés d'un coup, observatoire crédité au pied de la carte. Variables `MESHCORE_CORESCOPE`, `MESHCORE_CORESCOPE_INTERVALLE`, `MESHCORE_CORESCOPE_MAX_MINUTE`.
- Sans source MeshCore : message clair et aide en trois choix, adresse de broker acceptée sans `mqtts://`, compteurs MeshCore masqués sur la page publique tant qu'aucun nœud n'est reçu. Wiki : **matériel minimum** (Pi 4/5 en 64 bits, NAS).

### 🛠️ Corrections
- Traductions anglaises manquantes des messages du serveur (observatoires CoreScope, fusion et annulation de fusion de nœuds 2.8) ; journal anglais : « mode urgence terminé par … » et « secteur … créé / supprimé par … » étaient à moitié traduits.
- *Connecter un module en Wi-Fi* : le bouton « Connecter » était blanc sur blanc.

## 2.28.15

### 🛠️ Corrections
- **Mise à jour en un clic** : si le moteur Docker met trop de temps à répondre à l'arrêt, la mise à jour suit l'état réel du conteneur au lieu d'abandonner, et **remet l'ancienne version en route** en cas d'échec à n'importe quelle étape (la carte ne reste plus éteinte). Si le service de mise à jour est lui-même interrompu en plein milieu, il relance la carte à son démarrage.
- **Racine MQTT** : une racine saisie avec `/#` à la fin est corrigée (la carte ajoute `/#` elle-même ; `…/#/#` était refusé par le courtier et plus aucun paquet n'arrivait).
- *Gérer › Sauvegardes* : chaque sauvegarde affiche sa **date et son heure en toutes lettres** (le nom était tronqué en « 2.. »).

## 2.28.14

### 🔧 Corrections
- **Liaison entre deux points** : les fiches du départ et de l'arrivée affichaient « antenne undefined m » ; elles montrent maintenant la hauteur d'antenne saisie.
- **Profil de relief et bilan de liaison** : la fréquence du calcul suit le réglage `RADIO_FREQ_MHZ` (869,525 MHz par défaut) au lieu d'être figée ; hors de France, si l'IGN ne donne pas d'altitude, la carte bascule sur le service mondial au lieu d'afficher une erreur.

## 2.28.13

### 📡 Passerelle des membres
- **Outils › 📡 Devenir passerelle** : un membre connecté (pas seulement l'administrateur) relie **sa radio** Meshtastic ou MeshCore depuis son navigateur, en USB ou Bluetooth, sans rien installer. Elle ajoute ce qu'elle entend à la carte, **en écoute seulement** : elle n'émet rien et ne remplace jamais le module principal.
- Nom à l'identifiant du membre, **deux radios par compte**, débit limité ; l'administrateur voit chaque passerelle dans *Modules radio* et peut la **couper** (refusée ensuite 12 h). Réglage *Module radio › Passerelles des membres*.
- USB et Bluetooth demandent la carte en **HTTPS**.

### 🎚️ Jeux de canaux (carte et ADRASEC)
- L'administrateur règle les canaux de la carte, le président ceux de son ADRASEC (*page ADRASEC › Gestion › Canaux*).
- Le membre qui a relié sa radio voit ses 8 emplacements, coche les canaux et clique **Écrire sur la radio** : écriture puis relecture de contrôle. Place insuffisante : il choisit les canaux à libérer ; le canal 0 n'est jamais touché ; avertissement pour les canaux en clair.
- **Les clés ne quittent jamais le serveur** (chiffrées, empreinte courte pour qui règle le jeu).

### 📊 Fréquentation (Gérer › Fréquentation)
- Visiteurs en ligne, visiteurs et pages par jour, **pays** (base libre DB-IP consultée sur le serveur), pages vues, **provenance** (Facebook, rtl-sdr.com…), membres ou simples visiteurs.
- **Aucune adresse IP gardée, aucun cookie**, robots ignorés ; réglages `STATS_FREQUENTATION` et `STATS_PAYS`.

### 🛠️ Corrections
- *Gérer › Comptes* : bouton **✔ Enregistrer** bien visible, Entrée enregistre, toutes les fiches ouvertes enregistrées d'un coup (les noms modifiés n'étaient pas gardés) ; crayon ✏️ affiché sans vider le cache.

## 2.28.12

### ✉️ Winlink (section ADRASEC)
- **Boîte réservée à l'ADRASEC de la station** (réglage `PAT_ADRASEC`, par défaut le département de la carte) : les membres des autres ADRASEC hébergées ne la voient plus. Rédaction et sessions : radioamateurs licenciés seulement.
- **Pat démarre du premier coup** : son dossier de données est donné à son compte avant le lancement (il redémarrait en boucle avec « permission denied »).
- **Wiki** : installation pas à pas par Internet, cas du NAS Synology (sans tunnel SSH), docker-compose personnalisé, tableau « qui a accès à quoi ».

### 🛠️ Corrections
- **Gérer › Comptes** : boîte plus large, case ADRASEC compacte, boutons qui passent à la ligne au lieu d'être coupés.
- **Écrans d'administration toujours à jour** après une mise à jour (l'ancienne version restait en cache : boutons ✏️ et 🔑 absents).

## 2.28.11

### 🔑 Comptes
- **Mot de passe oublié** : lien « Mot de passe oublié ? » sous la connexion. Avec un serveur d'envoi réglé (*Réglages › Réglages avancés › E-mail*), un lien valable 1 h arrive par e-mail ; sinon la demande s'affiche dans *Gérer › Comptes*, où le bouton **🔑 Lien** crée un lien à usage unique (24 h) à transmettre.
- **E-mail** modifiable dans *Mon compte*.
- **Identifiant « NOM Prénom »** accepté (espaces, accents, apostrophe).
- **Fiche d'un compte modifiable par l'administrateur** (✏️) : identifiant, indicatif, e-mail.

### 🛰️ ADRASEC
- **Gestion** : plusieurs comptes cochés et intégrés d'un coup (filtre, tout cocher).
- **Équipes** : **＋ Membres** pour composer chaque équipe en cochant les membres, ✕ pour en sortir ; couleur de chaque équipe au choix.
- **Nouveau relevé** : **équipe qui donne le relevé** (saisie au PC des relevés reçus par radio), position par le **nœud de l'équipe** ; équipe d'un relevé déjà enregistré corrigeable, le trait prend sa couleur.

## 2.28.10

### 🛰️ ADRASEC par département
- **Plusieurs ADRASEC sur une même carte** (43, 42, 07…) : chacune a ses membres, ses équipes, sa main courante et ses recherches ; un membre ne voit que la sienne. Les données existantes deviennent l'ADRASEC du département de la carte.
- **Case ADRASEC dans Gérer › Comptes** : un clic intègre le compte, une seconde case le nomme **président**. Le président gère son ADRASEC sans être administrateur de la carte.
- **Adhésion** : la page `/adrasec` propose de créer son compte puis de demander à rejoindre l'ADRASEC de son département, comme **radioamateur licencié** (indicatif) ou **SWL** (n° d'écouteur). Le président accepte ou refuse dans Gestion.
- **Fiches des membres** : qualité, indicatif ou n° SWL, équipe, fonction, nœud porté ; recherche ; intégration directe d'un compte existant. Les SWL font des relevés mais n'émettent pas (Winlink réservé aux licenciés).

### 📱 Téléphone et appli Android
- **Tiroir du bas** : déplié, il s'arrête sous le titre et la recherche de lieu (même avec un texte agrandi) ; bouton **▾** pour le replier, poignée plus grande.
- **Version de l'appli** affichée à côté de celle de la carte (comparer téléphone et tablette).
- **Préparation Google Play** : appli en API 36 (Android 16), paquet AAB pour le Play Store, politique de confidentialité dans le wiki.

### 🛠️ Corrections et ajouts
- **Alertes envoyées par MeshCore** : leur écho relayé par les répéteurs ne compte plus comme un message non lu.
- **Alertes officielles** : quand le bouton 📡 Envoyer manque, la raison s'affiche (module non relié, aucun canal nommé).
- **Schéma des rôles Meshtastic** (client muet, client de base, routeur, client, routeur tardif) dans *Statistiques › Rôles des nœuds* et dans le wiki.

## 2.28.9

### 🛰️ Section ADRASEC : recherche de balise
- **Diffusion aux équipes par LoRa** (zone blanche) : la position estimée part en point de passage « 🎯 Balise estimée » sur la carte de l'appli Meshtastic des équipiers, avec un message (coordonnées, locator, DFCI, taille de la zone), sur le canal choisi ; renvoi automatique quand l'estimation bouge de plus de 300 m ; point retiré à la clôture.
- **Lien terrain** (réseau mobile) : lien secret ou QR code qui ouvre la carte de la recherche sans compte, en lecture seule, avec la distance et le cap jusqu'à la balise depuis le GPS du téléphone ; éteint à la clôture (48 h au plus).
- **Relèvements bien visibles** : trait épais avec liseré, flèche, étiquette « équipe · direction · force » sur chaque point.
- **Saisie** : point de l'équipe et aperçu du gisement dès le clic sur la carte, avant l'envoi.
- **Missions** : choisies dans une liste (recherches en cours, missions des autres équipes) pour rattacher plusieurs équipes à la même mission.

## 2.28.8

### 🛠️ Corrections
- **USB et Bluetooth avec la carte ouverte sur le PC même** (`http://localhost:8095`) : « Connecter un module › USB » n'est plus grisé (il exigeait l'HTTPS, que Chrome ne demande pas en localhost).
- **Recherche Ctrl+K** : un outil du menu Outils (ex. « Module USB de ce PC ») est lancé directement, au lieu d'être seulement surligné dans le menu.

## 2.28.7

### 🎚️ Fonctions de la carte
- **Un seul écran à interrupteurs** (Outils › 🎚️ Fonctions de la carte, ou Réglages) : activer la section ADRASEC, activer Winlink en 3 étapes (Pat lancé, station réglée, adresse enregistrée), afficher ou masquer signalements, Vigipirate, FR-Alert, main courante, Bipper et feux.

### 🛰️ Section ADRASEC
- **Membres** : une fiche par compte, lisible même sur un écran étroit, avec une aide sur chaque champ ; le nœud porté sur le terrain se choisit en tapant son nom.
- **Carte** : Plan IGN par défaut (communes, lieux-dits, routes), choix du fond (topographique, photos aériennes, sombre), recherche d'un lieu, et coordonnées, locator et DFCI sous le curseur.

## 2.28.6

### 🛰️ Section ADRASEC (édition française)
- **Espace réservé** aux membres validés par un administrateur (Outils › 🛰️ Section ADRASEC) : équipes, case « radioamateur licencié » avec indicatif, nœud Meshtastic porté par chaque membre (position en direct).
- **Main courante** horodatée et signée, jamais modifiée, export CSV ; recherches, relevés et messages Winlink s'y inscrivent seuls.
- **Radiogoniométrie** : recherches de balise (121,5 / 243 / 406 MHz), relevés de gisement depuis le GPS du téléphone, le nœud du membre, un clic ou un locator, ou par radio (« GONIO 125 », « GIS 125/5 ») ; cônes d'incertitude, position la plus probable par moindres carrés avec ellipse à 95 %, relèvements aberrants (réflexions) écartés tout seuls, coordonnées, locator et DFCI.
- **Winlink** avec Pat (client libre, service « pat » du docker-compose, profil winlink) : boîtes, rédaction signée et sessions par Internet ou par radio (VARA, ARDOP, packet) réservées aux licenciés, passerelles RMS sur la carte. Le mot de passe Winlink reste dans Pat.

### 🏔️ Profil de liaison en 3D
- **Bouton « Voir ce profil en 3D »** dans le profil de relief : la liaison s'ouvre dans la vue 3D, vue de côté, sur le vrai relief. La ligne de visée est colorée tronçon par tronçon (vert dégagée, orange zone de Fresnel gênée, rouge coupée par le relief), la 1re zone de Fresnel est dessinée en volume clair, les mâts d'antenne à leur hauteur et l'obstacle principal est signalé. Les hauteurs suivent le curseur « Relief × », et la vue se tourne à la souris comme le reste de la vue 3D.

### 🛠️ Corrections
- **« Module USB de ce PC » qui ne faisait rien** : la cause s'affiche maintenant à l'écran (adresse en HTTP, navigateur sans USB, liste de ports vide : câble ou pilote CP210x / CH340, port déjà ouvert par une autre appli) et la réussite est confirmée.

## 2.28.5

### 🛠️ Corrections
- **Fond de carte hors ligne qui ne se téléchargeait pas** dans l'image Docker (« extraction interrompue (code 1) ») : l'outil d'extraction n'avait pas les certificats racines pour joindre le serveur de cartes en https. Ils sont maintenant inclus, et en cas d'échec le message dit pourquoi (certificats, serveur injoignable, disque plein).

## 2.28.4

### 📣 Nœuds à inviter
- **Écran refait** : une fiche par nœud avec son nom en entier (il était coupé à une lettre), son preset, sa distance et quand il a été vu ; filtre « dans le secteur de la carte », 25, 50 ou 100 km ; étapes claires (① module sentinelle pour écrire, ② choisir les nœuds) ; bouton « Inviter » expliqué tant qu'aucune sentinelle n'est reliée.

### 🇫🇷 MeshCore : réglages conseillés en France
- **Configurateur MeshCore France** proposé là où on installe un répéteur : page « Rejoindre », maintenance MeshCore, sites proposés pour un relais.
- **Sauvegarde du configurateur importée** dans la maintenance MeshCore (fichier .json) : matériel, firmware, date et réglages gardés pour chaque répéteur (jamais les mots de passe ni la clé privée, qui ne quittent pas le navigateur).
- **Recommandations françaises vérifiées** pour chaque répéteur, d'après ce que la carte entend : numéro de département au début du nom, position annoncée, chemins sur 2 octets (path.hash.mode 1), une annonce en inondation par jour, preset français 869,618 MHz · 62,5 kHz · SF8 · CR8.

### 🤝 Page « Rejoindre le réseau »
- **Réseau MeshCore seul** : lien du canal et limite de sauts laissés vides, la page n'affiche plus la partie Meshtastic (comme la partie MeshCore quand elle est vide).
- **Partie MeshCore complétée** : régions des répéteurs, bouton « preset français » qui remplit tout, commandes minimales d'un répéteur générées pour la page, liens vers le configurateur et les réglages conseillés.

## 2.28.3

### 🛠️ Corrections
- **Messages MeshCore de la carte elle-même** (vigilances envoyées par radio, messages écrits depuis la carte) : quand ils reviennent répétés par un relais ou vus par un observateur, ils ne sont plus marqués « nouveau » ni comptés comme non lus.

### 📱 Téléphone
- **Icônes sur téléphone**, comme sur tablette : rubriques du panneau (🗺️ Réseau, 💬 Messages, 📶 Couverture, 🛠️ Gérer, ⚙️ Réglages) et barre du bas (🗂️ Couches, 📡 Couverture radio, 🧰 Outils, 👤 Connexion) avec un mot dessous. L'ordinateur garde l'affichage complet.
- **En-tête qui tient sur un téléphone** : l'état du direct devient une pastille de couleur, les alertes officielles se résument à leurs pictogrammes et à leur nombre (le détail reste au clic).
- **Barre du bas plus compacte** : sélecteur du secteur et durée des liens réduits, texte de recherche raccourci, pour moins de boutons coupés.

## 2.28.2

### 🗺️ Légende
- **Symboles des couches dans la légende** : stations APRS (LoRa APRS et autres), capteurs et passerelles LoRaWAN, stations de rivière (normale, en crue, barrage), affichés dès que la couche est activée.

## 2.28.1

### 🛠️ Corrections et confort
- **Appli Android** : la carte ne passe plus sous la barre d'état (heure, icônes) ni sous la barre de navigation sur Android 15, et le clavier ne recouvre plus la saisie.
- **Menu Couches en trois colonnes** sur ordinateur (fond de carte et repères · réseau · autour du réseau) : il tient en hauteur au lieu de déborder de l'écran.
- **Couche désactivée** (Rivières, Capteurs LoRaWAN, Stations APRS) : l'annonce reste affichée plus longtemps et, pour un administrateur, un clic ouvre les Réglages avancés sur le bon groupe.
- **Stations APRS bien distinctes des nœuds** : carré blanc marqué « A » (bord violet pour LoRa APRS, bleu pour les autres) et étiquette « APRS » devant l'indicatif.
- **Aide sous chaque réglage avancé** : les 36 réglages qui n'en avaient pas expliquent à quoi ils servent et leur valeur par défaut.
- **Courbes des rivières et des capteurs** lisibles : valeurs mini et maxi dans une marge, début et fin de la courbe en clair (« il y a 8 h » … « il y a 3 h ») ; plus aucun texte sur le tracé.

## 2.28.0

### 🌊 Rivières
- **Nouvelle couche « Rivières »** (en option) : hauteur d'eau, débit et tendance des stations hydrométriques publiques du secteur (Hub'Eau, les mêmes mesures que Vigicrues), avec la courbe sur 24 h. Gratuit, sans compte ni matériel.
- **Alertes de crue** dans la carte : montée rapide (20 cm/h par défaut, réglable) et seuils de hauteur choisis station par station.

### 📟 Capteurs LoRaWAN
- **Nouvelle couche « Capteurs LoRaWAN »** (en option) : les capteurs d'une application The Things Network (v3) ou ChirpStack (v4) sur la carte (niveau d'eau, météo, pluie…), avec leurs dernières mesures, la courbe sur 24 h, les passerelles qui les ont reçus et le signal (RSSI, SNR). Lecture seule par le MQTT de l'application ; réservée aux membres par défaut.
- **Alertes sur seuil** choisies capteur par capteur (« niveau-borne.hauteur > 150 », « batterie < 3,3 »), et alerte si le serveur MQTT reste injoignable.

### 🧰 Supervision
- **Échecs des tâches de fond visibles dans les alertes** : relevé des rivières impossible, APRS-IS injoignable.

### ✉️ Messages
- **Historique d'un canal toujours visible** : en choisissant un canal (ou les messages directs), la carte charge son propre historique. Un canal calme, comme celui d'une association, n'est plus caché par les centaines de messages des canaux bavards.
- **Messages conservés 90 jours** (réglable : *Réglages avancés › Messages et MQTT*), au lieu de la durée de conservation du trafic (7 jours par défaut).
- **Message direct impossible signalé avant l'envoi** : si le module ne connaît pas encore la clé publique du destinataire (il refuserait le message), la carte le dit, explique pourquoi (fiche NodeInfo pas encore reçue, firmware antérieur à 2.5) et propose d'écrire sur un canal à la place.
- **Bouton « Échanger les fiches avec ce nœud »** dans cet avertissement : la carte envoie la fiche de son module (avec sa clé publique) au nœud, qui répond avec la sienne ; le message direct passe ensuite.

### 🛠️ Corrections
- **Onglets du panneau** (Réseau, Messages, Couverture, Gérer, Réglages) : ils ne se chevauchent plus sur un écran d'ordinateur.
- **Interface en anglais** : les durées (« il y a 2 h »), les sauts, la télémétrie (secteur, canal, émission), les résumés du tableau de bord et les jours de la santé sur 7 jours sont traduits.
- **Registre des relais** : limité aux relais et passerelles de la zone de la carte (et non plus de toute la France), dans un panneau élargi pour que le tableau reste lisible.
- **Mode démonstration sur téléphone** : le bandeau est lisible (il s'affichait en rond au milieu de l'écran) et peut être fermé.

## 2.27.0

### 📡 Alertes envoyées par radio
- **Vigilances et foyers déjà envoyés bien visibles** : bord vert, coche « Déjà envoyée par radio », heure, auteur et canaux ; le bouton devient « Renvoyer ». Les nouvelles alertes gardent leur couleur. L'information est partagée par tous les utilisateurs et survit au redémarrage.

### 🗂️ Registre des relais
- **Nouvelle vue « Registre des relais »** (Outils) : site, autorisation, zone protégée, dernière visite, énergie, firmware et dernier paquet de chaque relais, avec les relais sans autorisation écrite ou non visités depuis plus d'un an en évidence, et export CSV.
- **Fiche d'installation complétée** : autorisation du site (accord écrit, convention, demande en cours…), date, zone protégée (monument historique, site classé, littoral, Natura 2000…) et dernière visite.

### 🏔️ Vue 3D du réseau
- **Nouvelle vue 3D** (Couverture radio) : relais, passerelles et répéteurs MeshCore posés sur le relief, liaisons des dernières 24 h colorées selon le SNR, relief exagérable, fond sombre, photos aériennes ou topographique, rotation lente.
- Elle suit le **département étudié** sur la carte.

### 📡 Radio et matériel
- **Calculette des pertes de câble** : type de câble (RG58, RG213, LMR-400, Ecoflex…), longueur, connecteurs et parafoudre ; le résultat va directement dans la fiche d'installation ou dans « Profil et bilan de liaison ».
- **Nœuds en mode licencié (radioamateur)** signalés par un badge : messages non chiffrés, indicatif, pas d'accès aux canaux chiffrés.

### 📻 Stations APRS
- **Nouvelle couche « Stations APRS »** : traqueurs, iGates et digipeaters **LoRa APRS** (433,775 MHz) du secteur en évidence, et autres stations APRS, lus sur APRS-IS en lecture seule (à activer dans Réglages avancés › APRS).
- **Positions Mic-E lues** (portatifs et mobiles Kenwood, Yaesu…), **indicatif radioamateur obligatoire** pour activer la couche, zone suivie quand le département de la carte change.

### 🛰️ Export pour ATAK
- **Export KML du réseau** (relais, nœuds, liaisons colorées selon le SNR) pour ATAK, Google Earth et QGIS, et **lien KML en direct** rechargé chaque minute.
- **Lien KML en direct fiable derrière un reverse proxy https** : il reprend l'adresse vue par le navigateur.

### ⚠ Installer un relais dans les règles
- **Avertissement sur les sites proposés** : un point haut n'est pas un site autorisé. Accord du propriétaire ou de la commune, pas de relais dans un cimetière ou un lieu de culte, avis de l'Architecte des Bâtiments de France près des monuments historiques, loi Littoral et espaces naturels protégés.

### ⚡ Page plus légère
- **Écrans d'administration chargés à la demande** : un visiteur télécharge 17 % de moins à l'ouverture de la carte ; pour un membre, ils sont préchargés en arrière-plan.

### 🔒 Sécurité
- **Failles connues des dépendances contrôlées à chaque envoi**, en plus du contrôle hebdomadaire.
- **Bibliothèque de la vue 3D mise à jour** (MapLibre 6) : corrige une faille connue de l'ancienne version.
- **Export CSV du registre** : un nom de nœud commençant comme une formule (= + - @) n'est plus exécuté par le tableur.

## 2.26.0

### 🔌 Brancher un module, sans réglage
- **Connexion automatique en USB** depuis le navigateur : on branche un module Meshtastic ou MeshCore, il est reconnu et relié tout seul ; on en change, la carte suit.
- **Agent prêt à l'emploi (1.7)** : un fichier à télécharger depuis la carte, déjà réglé (adresse du serveur, code, rôle). On le lance, il trouve le module USB et se connecte, sans aucune question.
- **Modules Wi-Fi retrouvés tout seuls (mDNS)** : les modules Meshtastic du réseau local qui s'annoncent sont ajoutés à la liste.
- **Écoute UDP du réseau local** : les paquets que les modules Meshtastic en Wi-Fi diffusent sur le réseau local (firmware 2.6 et plus) arrivent sur la carte, sans broker MQTT.

### 📣 Faire grandir le réseau
- **Nœuds à inviter** : la carte repère les nœuds du secteur réglés sur un autre preset (LongFast quand le réseau est en LongModerate, par exemple), et permet de leur envoyer un message d'invitation par un module « sentinelle ».
- **Page « Rejoindre le réseau »** (`/rejoindre`) : QR du canal, preset conseillé, rôles recommandés, limite de sauts, règles, antennes testées, relais communautaires et appel aux dons.

### 🏠 Domotique et supervision
- **Home Assistant et Node-RED** : état du réseau, alertes et relais publiés par MQTT, avec découverte automatique dans Home Assistant (capteurs, connectivité, batterie, position des relais). Un message publié par la domotique peut partir en LoRa (désactivé par défaut).
- **Prometheus / Grafana** : une mesure par relais surveillé (entendu ou non, depuis quand, batterie, tension) et une par alerte en cours, pour alerter depuis Alertmanager.
- **Supervision MeshCore** : nouvelle alerte quand un répéteur ne répond plus à deux demandes d'état de suite, même s'il est encore entendu.

### 🎨 Nouvelle identité
- **Nouveau logo**, dans l'en-tête de la carte, l'icône de l'onglet, l'application web et l'application Android.

### 📚 Documentation
- Nouvelles pages du wiki : « Domotique et supervision », agent prêt à l'emploi, connexion USB automatique et écoute UDP.
