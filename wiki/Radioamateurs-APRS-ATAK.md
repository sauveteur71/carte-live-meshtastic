# Radioamateurs, APRS, ATAK et registre des relais

## Stations APRS (dont LoRa APRS)
La couche **Stations APRS** (menu Couches) affiche les stations APRS du secteur : traqueurs, iGates et digipeaters **LoRa APRS** (433,775 MHz) en violet, autres stations APRS (VHF 144,800 MHz, internet) en bleu. Un clic donne l'indicatif, le commentaire, l'altitude, l'iGate qui l'a relayée et un lien vers aprs.fi.

À activer dans *Réglages avancés › APRS (radioamateurs)* :
- **Afficher les stations APRS du secteur** : oui.
- **Indicatif** : le vôtre, **obligatoire** (la couche ne démarre pas sans lui).
- **Serveur** : `rotate.aprs2.net:14580` par défaut.
- **Garder seulement les stations LoRa APRS** : au choix.

La carte se connecte au réseau mondial **APRS-IS en lecture seule** (`pass -1`) : elle n'émet rien et n'a besoin d'aucun mot de passe. Elle ne demande que la zone de la carte (département et voisins). Les positions au format Mic-E (portatifs et mobiles Kenwood, Yaesu…) sont lues ; celles des messages et de la télémétrie ne le sont pas. Si vous changez de département, la zone suivie est mise à jour dans les 10 minutes.

## Nœuds en mode licencié
Un nœud Meshtastic réglé en **mode licencié** (radioamateur) porte le badge **📻 Radioamateur** dans sa fiche. En mode licencié, les messages ne sont **pas chiffrés** (le chiffrement est interdit en radioamateur) et le nœud s'identifie par son indicatif : il ne peut donc pas lire les canaux chiffrés du réseau.

Rappel : **868 MHz n'est pas une bande radioamateur** en Europe. Le LoRa radioamateur se fait en 70 cm (433,775 MHz pour LoRa APRS) ou en 13 cm (2,4 GHz), dans le respect du plan de bande du REF.

## Export pour ATAK
*Exports* (fenêtre Intégrer / exporter) :
- **Réseau pour ATAK et Google Earth (KML)** : relais et passerelles, autres nœuds actifs, liaisons radio des dernières 24 h colorées selon le SNR. Dans ATAK : *Import Manager › Local SD* (ou envoyer le fichier sur le téléphone).
- **Réseau en direct (lien KML)** : petit fichier qui recharge le réseau chaque minute. L'appareil doit pouvoir joindre la carte (même réseau local, ou Tailscale).

Les mêmes règles de confidentialité que la carte publique s'appliquent (positions des particuliers arrondies, aucun message). Si un jeton d'export est réglé, ajouter `?jeton=…` à l'adresse.

## Calculette des pertes de câble
Dans la **fiche d'installation** d'un relais et dans **Profil et bilan de liaison**, le bouton **🧮 Calculer** à côté des pertes de câble donne la perte à partir du **type de câble** (RG58, RG213, LMR-400, Aircell 7, Ecoflex…), de la **longueur**, du **nombre de connecteurs** et d'un éventuel **parafoudre**. « Utiliser » reporte la valeur dans le champ ; elle sert ensuite à la couverture, au plan et à Relier.

Valeurs typiques autour de 870 MHz ; vérifier la fiche du câble. Un câble court et épais vaut souvent mieux qu'une antenne à plus fort gain.

## Registre des relais
*Outils › 🗂️ Registre des relais* rassemble, pour chaque relais et passerelle :
- le **site**, l'**autorisation** (accord écrit, convention, accord oral, demande en cours, aucune, pas nécessaire) et sa date ;
- la **zone protégée** éventuelle (abords d'un monument historique, site classé, littoral, Natura 2000, parc ou réserve) ;
- la **dernière visite** sur place (orange au-delà de 6 mois, rouge au-delà d'un an) ;
- l'**énergie** (alimentation, batterie, panneau), le **firmware** et le dernier paquet entendu.

Les relais sans autorisation écrite et ceux non visités depuis plus d'un an sont comptés en tête. **Exporter le registre (CSV)** l'ouvre dans un tableur ; le propriétaire du site et le contact n'y figurent que pour un administrateur.

### Retrouver un relais
Le champ **Chercher** en haut du registre filtre la liste au fur et à mesure de la frappe, sans tenir compte des accents ni des majuscules : nom du nœud, identifiant, site, propriétaire, contact, notes, autorisation, département. Le compteur et les indicateurs (« sans autorisation écrite », « sans visite depuis plus d'un an ») portent toujours sur ce qui est affiché, et l'export CSV aussi.

La liste **Département** range les relais d'après la position qu'ils ont retransmise. Un relais qui ne donne pas sa position, ou qui est hors de France, se trouve sous « Sans département ».

Cliquer sur une ligne ouvre la fiche du relais ; **en fermant la fiche, on revient au registre**, avec la même recherche et le même département. Une fiche ouverte depuis la carte ou depuis la recherche se ferme comme avant.

### Cocher plusieurs relais d'un coup
Pour les relais que l'on gère, une case apparaît devant chaque ligne. Cochez-en plusieurs : une barre s'ouvre avec le nombre de relais cochés et la liste **Autorisation du site** (« Pas nécessaire (terrain à soi) » par défaut). **Appliquer aux relais cochés** demande confirmation, en disant combien de relais sont concernés, puis écrit la même autorisation dans chaque fiche — le reste de chaque fiche est gardé.

Chaque relais est enregistré séparément, avec les mêmes contrôles que la fiche entière : un gestionnaire de secteur ne peut toucher que ses relais, et chaque modification laisse sa ligne dans le journal d'audit. Si un relais est refusé, le compte rendu le dit (« ✗ 1 relais non modifié »), le relais reste coché et sa fiche est inchangée.

Les relais cochés mais masqués par la recherche ne sont jamais modifiés : la confirmation le rappelle.

### Dates proposées
Dans la fiche d'installation, les trois champs de date (mise en service, date de l'autorisation, dernière visite sur place) **proposent la date du jour** dès qu'on entre dans un champ vide — c'est presque toujours la bonne pour une visite. La proposition est signalée sous le champ : gardez-la, changez-la, ou videz le champ (elle ne revient pas). Rien n'est enregistré tant que le bouton **Enregistrer la fiche** n'a pas été utilisé ; une date du jour gardée telle quelle est nommée dans le message de confirmation. Une date déjà saisie n'est jamais remplacée.

Ces informations se saisissent dans la fiche du nœud, rubrique **Installation** › *Site*. Voir aussi [[Couverture et sites]] : un point haut n'est pas un site autorisé.

## Nœuds d'un département (recherche par position)
*Outils › 🗂️ Registre des relais* ne montre que les relais. Pour avoir **la liste de tous les nœuds d'un département**, tapez le numéro ou le nom du département dans la barre de recherche de la carte (« 43 », « dep 43 », « Haute-Loire ») : la première proposition est **Nœuds du département 43**, avec le nombre de nœuds. Le même écran s'ouvre depuis *Chercher une fonction* › « Nœuds d'un département (par position) ».

Le classement se fait sur la **position que chaque nœud a retransmise**, pas sur son nom : le test du point dans le polygone utilise les contours officiels des départements et il est fait sur le serveur (le navigateur ne télécharge pas le fichier des contours). Le résultat est gardé une minute.

À savoir :
- un nœud qui n'a jamais envoyé de position ne peut être rangé nulle part : il est compté à part, sous « Sans position reçue » ;
- un nœud positionné hors de France apparaît sous « Position connue, hors de France » (les départements n'existent qu'en France : sur l'édition monde, rien n'est deviné pour le reste de la planète) ;
- une position floutée ou imprécise (firmware Meshtastic 2.8) peut ranger un nœud proche d'une limite dans le département voisin ; l'écran le rappelle.

La liste se filtre aussi par nom, identifiant ou rôle, et s'exporte en CSV. Cliquer sur un nœud ouvre sa fiche ; en la fermant, on revient à la liste.

**Meshtastic, MeshCore ou les deux.** La liste suit le réseau affiché sur la carte (bouton *Réseau* en haut du panneau) : Meshtastic seul, MeshCore seul, ou les deux. Un petit sélecteur **Meshtastic / MeshCore / Les deux** en haut de l'écran permet d'en changer sans toucher à la carte ; une pastille **MT** ou **MC** indique le réseau de chaque nœud. Un nœud MeshCore est rangé d'après la position de sa **dernière annonce** (advert), avec les mêmes contours ; une annonce à 0, 0 compte comme « sans position ». Cliquer sur un nœud MeshCore ouvre sa fiche MeshCore ; en la fermant, on revient à la liste, sur le même réseau. Une carte limitée à un seul réseau (ou sans MeshCore) n'affiche pas le sélecteur.
