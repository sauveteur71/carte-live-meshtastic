# Section ADRASEC

Espace **réservé** aux membres d'une ADRASEC (radiotransmetteurs au service de la sécurité civile), dans l'édition française de la carte : **main courante**, **radiogoniométrie** pour la recherche de balise, **équipes** et **Winlink**. On l'ouvre par **Outils › 🛰️ Section ADRASEC** (lien visible des seuls membres validés et des administrateurs), ou directement à l'adresse `/adrasec`.

Rien de cette section n'apparaît sur la carte publique.

## Organisation : une ADRASEC par département

Une même carte peut héberger les ADRASEC de **plusieurs départements**. Chacune est **séparée** : ses membres, son président, ses équipes, sa main courante et ses recherches de balise. Un membre appartient à une seule ADRASEC et ne voit que la sienne.

| Qui | Fait quoi |
|---|---|
| **Administrateur de la carte** | Active la section, crée les ADRASEC hébergées (43, 42, 07…), nomme leurs **présidents**. Il voit toutes les ADRASEC (liste de choix en haut à droite). |
| **Président** (ou responsable) | Accepte les demandes d'adhésion, intègre les membres, crée les équipes et les missions, règle son ADRASEC. Il n'est pas administrateur de la carte. |
| **Membre** | **Radioamateur licencié** (indicatif vérifié) ou **SWL** (écouteur) : main courante, relevés gonio, équipes. Seuls les licenciés émettent (Winlink). |

## Mise en route

**Administrateur de la carte**
1. **Outils › 🛰️ Section ADRASEC › ⚙️ Gestion** : cocher **Section ADRASEC activée sur la carte**.
2. **ADRASEC hébergées** : saisir le numéro du département et le nom (ex. *ADRASEC 43*), puis **Créer l'ADRASEC**.
3. Nommer le président : ouvrir l'ADRASEC, intégrer son compte comme membre et cocher **Président / responsable**.

**Futurs membres**
1. Ouvrir `https://votre-carte/adrasec`, cliquer **Créer mon compte** (ou **Me connecter**).
2. Revenir sur la page, choisir l'ADRASEC de son département, indiquer **radioamateur licencié** (avec l'indicatif) ou **SWL** (avec son numéro d'écouteur s'il en a un), puis **Demander à rejoindre**.

**Président**
1. **⚙️ Gestion › Demandes d'adhésion** : **Accepter** ou **Refuser**. Le bouton **Copier** donne le lien à envoyer aux membres.
2. Sur chaque fiche : **Qualité** (radioamateur licencié, SWL ou autre bénévole), équipe, fonction et, si le membre porte un nœud Meshtastic, son nom ou son numéro (`!a1b2c3d4`). Sa position s'affiche alors en direct et sert de position par défaut pour ses relevés.
3. **Radioamateur licencié** : à choisir **seulement après avoir vérifié** le certificat d'opérateur (ou l'autorisation ANFR). C'est ce choix qui ouvre la rédaction et les sessions Winlink.
4. **Intégrer un compte de la carte** : pour ajouter directement quelqu'un qui a déjà un compte.
5. **Équipes** : créer les équipes (ex. *Gonio 1*, *PC radio*) ; chacune a sa couleur et sa mission.

Si la carte valide les nouveaux comptes (**inscriptions sur validation**), l'administrateur de la carte doit d'abord valider le compte dans **Gérer › Comptes** ; la page Gestion de l'ADRASEC le signale.

> **Winlink** : le client Pat est unique sur la carte (un seul indicatif Winlink). Si plusieurs ADRASEC sont hébergées, leurs membres licenciés partagent la même boîte ; chaque message est signé de l'indicatif du membre et du nom de son ADRASEC.

## Main courante

Chaque inscription est **horodatée et signée** (indicatif du membre), avec un type (information, message reçu ou émis, décision, mouvement, incident, fin) et l'équipe concernée. Une inscription ne se modifie pas : pour corriger, on en inscrit une nouvelle. Les ouvertures et clôtures de recherche, les relevés et les messages Winlink s'y ajoutent tout seuls.

**⬇ Export CSV** : fichier ouvrable dans un tableur, pour le compte rendu.

## Radiogoniométrie (recherche de balise)

1. **＋ Nouvelle recherche** : nom, fréquence (121,5 / 243 / 406 MHz ou autre), détail.
2. Chaque équipe envoie ses **relevés** :
   - **Gisement vrai** (pas magnétique) en degrés, **incertitude** (± 5° par défaut), force du signal, note ;
   - **position de l'équipe** : 📍 GPS du téléphone, 📡 nœud du membre, 🖱 clic sur la carte, ou ⌗ QTH-locator ;
   - **par radio**, depuis le nœud associé à son compte : message `GONIO 125` ou `GIS 125/5` (gisement puis incertitude). Le relevé arrive avec la position du nœud.
3. La carte trace un **cône** par relevé et calcule la **position la plus probable** (moindres carrés pondérés) avec une **ellipse à 95 %**. Elle donne coordonnées, locator et carroyage **DFCI**.
4. Un relevé **aberrant** (réflexion sur le relief ou un bâtiment, erreur de lecture) est **écarté tout seul** quand les autres s'accordent ; il reste affiché en pointillés.

C'est une **première indication** : la localisation se confirme sur le terrain. Il faut au moins deux relevés pris de deux endroits bien séparés ; trois ou plus rendent le calcul robuste.

## Diffusion aux équipes sur le terrain

Dans l'onglet **📡 Radiogoniométrie**, bloc **Diffusion aux équipes** (recherche en cours) :

- **📡 Par radio LoRa (zone blanche)** : la carte envoie, sur le canal choisi (de préférence le canal chiffré des équipes), un **point de passage « 🎯 Balise estimée »** qui s'affiche sur la carte de l'appli Meshtastic de chaque équipier, et un **message texte** (coordonnées, locator, DFCI, taille de la zone). **Automatique** : renvoyé à chaque nouveau relevé si l'estimation bouge de plus de 300 m (au plus une fois par minute). À la clôture, le point est retiré et un message de fin part.
- **🔗 Lien terrain (réseau mobile)** : un lien secret, à envoyer par SMS ou à faire scanner (QR code), ouvre la carte de la recherche **sans compte et en lecture seule** : relèvements, position estimée, ellipse, équipes. Avec le GPS du téléphone, elle donne **la distance et le cap** jusqu'à la balise, et ouvre l'appli GPS du téléphone. Le lien s'éteint à la clôture de la recherche (48 h au plus) ou d'un clic sur « Désactiver ». La carte doit être joignable depuis le téléphone (adresse en …ts.net avec Tailscale, ou adresse publique).

## Winlink

La carte s'appuie sur **[Pat](https://getpat.io)**, client Winlink libre (licence MIT), lancé à côté d'elle.

### Installation

1. Dans le fichier `.env` de la carte : `PAT_URL=http://pat:8080` et, pour l'afficher, `PAT_INDICATIF=F4ABC` (indicatif de la station).
2. `docker compose --profile winlink up -d` (service **pat** du `docker-compose.yml`).
3. Régler la station dans Pat : sa page de réglages est ouverte **seulement sur la machine de la carte**, à `http://127.0.0.1:8081/ui/config` (depuis un autre poste : tunnel SSH). Y saisir indicatif, mot de passe Winlink et locator.

**La carte ne lit jamais le mot de passe Winlink** : il reste dans la configuration de Pat.

### Utilisation

- **Tous les membres** lisent les boîtes (reçus, à envoyer, envoyés, archives).
- **Les licenciés seulement** rédigent (le message est signé de leur indicatif et du nom de la section) et lancent une **session** :
  - `telnet` : par Internet ;
  - par radio : `varahf:///F1ABC-10?freq=7101`, `varafm:///…`, `ardop:///…` ou `ax25:///…`, selon ce que Pat sait joindre.
- **Passerelles RMS** : affichées sur la carte autour de la vue, filtrables par mode (VARA HF, VARA FM, ARDOP, packet, PACTOR).

### VARA, FLdigi, MULTIPSK

- **VARA HF / FM** (EA5HVK, logiciel propriétaire pour Windows) n'est pas fourni : il tourne sur le PC relié au poste radio. Dans les réglages de Pat, `varahf` → adresse de ce PC, port 8300 (8301 pour les données).
- **FLdigi** et **MULTIPSK** restent utilisés à côté, sur le PC radio.

## Cadre réglementaire

- Seuls les **radioamateurs licenciés** émettent sur les bandes amateurs : la carte bloque la rédaction et les sessions Winlink pour les autres membres.
- **Pas de chiffrement** sur les bandes amateurs, et pas de trafic pour le compte de tiers non licenciés : la carte ne relaie **pas** automatiquement les messages du réseau LoRa 868 MHz vers Winlink.
- **Données personnelles** (indicatifs, positions, relevés) : visibles des seuls membres, effacées au-delà de la durée de conservation choisie.
