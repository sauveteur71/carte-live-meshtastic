# Section ADRASEC

Espace **réservé** aux membres d'une ADRASEC (radiotransmetteurs au service de la sécurité civile), dans l'édition française de la carte : **main courante**, **radiogoniométrie** pour la recherche de balise, **équipes** et **Winlink**. On l'ouvre par **Outils › 🛰️ Section ADRASEC** (lien visible des seuls membres validés et des administrateurs), ou directement à l'adresse `/adrasec`.

Rien de cette section n'apparaît sur la carte publique.

## Organisation : une ADRASEC par département

Une même carte peut héberger les ADRASEC de **plusieurs départements**. Chacune est **séparée** : ses membres, son président, ses équipes, sa main courante et ses recherches de balise. Un membre ne voit que son ADRASEC.

**Opérateur à cheval sur deux départements** : un même compte peut être membre de **plusieurs ADRASEC** de la carte. Le président de la seconde l'intègre comme n'importe quel compte (**⚙️ Gestion › Intégrer un compte de la carte**, où il apparaît avec la mention *aussi membre de…*). Il a alors **une fiche dans chaque ADRASEC** : son indicatif, sa qualité et son nœud sont repris de la première ; l'équipe, la fonction et le rôle de président sont propres à chacune. En haut de la page, une liste lui permet de **choisir l'ADRASEC affichée** (le choix est retenu sur l'appareil). La position de son nœud est visible dans ses deux ADRASEC. Un relevé qu'il envoie par radio (`GONIO 125`) va à l'ADRASEC dont il a utilisé le **canal** (un canal du jeu de canaux de cette ADRASEC, voir plus bas) ; en message direct ou sur un canal commun, il va à ses deux ADRASEC, là où une recherche est en cours.

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

> **Winlink** : le client Pat est unique sur la carte (une station, un indicatif). Sa boîte est réservée à **une** ADRASEC (`PAT_ADRASEC`, par défaut celle du département de la carte) : les membres des autres ADRASEC hébergées ne la voient pas. Chaque message est signé de l'indicatif du membre et du nom de son ADRASEC.

## Transférer la section vers une autre carte

Pour installer la même section sur une autre carte (celle d'un collègue, un second serveur) sans tout ressaisir : **Gestion › 🔄 Transférer la section vers une autre carte** (président, responsable ou administrateur de la carte).

1. **Sur la carte de départ** : **⬇ Exporter la section (fichier .json)**. Le fichier contient le **nom de la section**, les **équipes** (nom, couleur, mission), pour chaque membre sa **fiche métier** (indicatif, qualité radioamateur licencié / SWL, n° SWL, équipe, fonction et nœud porté sur le terrain), puis la **main courante**, les **recherches** et les **relevés**.
2. **Sur la carte d'arrivée** : **📥 Importer un fichier…**. Un **récapitulatif** s'affiche avant toute écriture : combien de membres rattachés à un compte existant, combien de fiches en attente, combien d'équipes créées, combien d'entrées ignorées et pourquoi. Rien n'est enregistré tant que vous n'avez pas cliqué **✔ Appliquer l'import**.

**L'historique part aussi** : la **main courante**, les **recherches** et leurs **relevés** de gisement (relevés retirés du calcul compris), avec le nom de leurs auteurs en texte (indicatif ou nom signé). À l'import :
- les entrées sont rattachées aux équipes de la carte d'arrivée (même nom = même équipe) et remises dans l'ordre des heures ;
- **importer deux fois le même fichier ne double rien** : chaque entrée garde son identifiant, et ce qui est déjà là est reconnu (le récapitulatif l'indique : « 12 déjà ici ») ;
- ce qui dépasse la **durée de conservation** de la carte d'arrivée n'entre pas ;
- une recherche **en cours** sur la carte d'origine reste **ouverte** sur la carte d'arrivée (les équipes peuvent continuer à y envoyer leurs relevés), mais **sans lien terrain ni diffusion radio** : rien n'émet tant qu'un membre de la carte d'arrivée ne l'a pas décidé. Recréez le lien terrain et relancez la diffusion sur place si besoin, et clôturez la recherche sur l'une des deux cartes pour éviter les doubles saisies.

Le récapitulatif avant import annonce le nombre d'entrées de main courante, de recherches et de relevés repris, et ce qui est ignoré (déjà là, trop ancien, illisible).

**Ce que le fichier ne contient pas** : aucun compte, aucun mot de passe, aucun condensat, aucun jeton de session, ni le **jeton d'un lien terrain** (il donne accès sans compte) ni l'état de la diffusion radio (point Meshtastic, canal). Les comptes **ne se transfèrent pas** d'une carte à l'autre : ce serait une faille. Une carte d'une version plus ancienne lit le fichier et ignore simplement l'historique.

**Comment les personnes sont rattachées** : par leur **indicatif**, et par lui seul.

| Cas | Ce qui se passe |
|---|---|
| Un seul compte **actif** de la carte d'arrivée porte cet indicatif | Le membre est **rattaché** à ce compte, avec son équipe, sa fonction et son nœud. |
| Plusieurs comptes portent le même indicatif | **Ignoré** et signalé : à rattacher à la main (la carte ne choisit pas au hasard). |
| Aucun compte ne porte cet indicatif (ou membre SWL sans indicatif) | Une **fiche en attente** est créée. La personne crée elle-même son compte avec le lien d'invitation `https://votre-carte/adrasec`, demande à rejoindre la section, et **sa fiche se rattache toute seule** quand le président accepte. |
| Membre déjà présent sur la carte d'arrivée | **Ignoré** : l'import n'écrase jamais une fiche existante. |
| Membre sans indicatif ni n° SWL | **Ignoré** : rien ne permet de le reconnaître sur l'autre carte. |

Le rôle de **président** n'est **jamais** importé : seul un administrateur de la carte d'arrivée peut le donner (le récapitulatif signale combien de présidents figuraient dans le fichier). Une équipe dont le nom existe déjà est **réutilisée**, pas dupliquée (accents et majuscules ignorés). L'import est **non destructeur** : il n'enlève rien et ne modifie aucun membre déjà là ; le réimporter deux fois ne crée pas de doublon. Export et import sont notés au **journal d'audit** des deux cartes, et l'import est inscrit à la **main courante** de la section d'arrivée.

Les fiches en attente apparaissent dans **Gestion › Fiches en attente d'un compte**, avec un bouton **Rattacher à ce compte** quand un compte au même indicatif existe déjà, et un bouton **Retirer la fiche**.

## Canaux de l'ADRASEC
Dans **Gestion › 🎚️ Canaux**, le président (ou un responsable) décrit les canaux Meshtastic que les membres doivent avoir : nom, clé (privée tirée au hasard, publique, ou collée) et partage des positions, 7 au plus. Un membre qui relie sa radio à la carte (**Outils › 📡 Devenir passerelle**) les y écrit en un clic, en choisissant au besoin les canaux à libérer. Les clés restent sur le serveur, chiffrées : personne ne les voit, pas même le président (une empreinte courte permet de les reconnaître). Voir [[Connecter un module|Connecter-un-module]].

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

## Points de rassemblement

Onglet **👥 Équipes › 🟢 Points de rassemblement** : **Nouveau point de rassemblement**, son nom, **📍 Pointer sur la carte**, Enregistrer. Tout membre de la section peut en poser un (un chef d'équipe sur le terrain n'attend pas le président) ; tous les membres le voient sur la carte.

**📻 Diffuser** l'envoie aux équipes par radio, sur le canal choisi : un point de passage (il s'affiche dans l'application Meshtastic des équipes) et un message avec la position et le code DFCI : « tout le monde se retrouve ici ». Au moment de l'envoi, un **mot à ajouter** est demandé (facultatif). L'envoi est noté dans la main courante. Tous les nœuds qui ont ce canal le reçoivent : choisissez le canal chiffré de la section plutôt que le canal public.

## Options de la section

Dans **⚙️ Gestion › Options**, le président active ce dont sa section a besoin :

| Option | Ce qu'elle apporte |
|---|---|
| **Batterie des nœuds** | Niveau de batterie du nœud de chaque membre (onglet Équipes) ; à 20 % ou moins, il est signalé. |
| **Alerte si la radio de la carte tombe** | Un bandeau rouge et une ligne de main courante quand le module radio de la carte se déconnecte, puis quand il revient. |
| **Messages aux équipes par radio** | Dans la main courante, un bloc **📻 Écrire aux équipes par radio** : canal, message court ou message-type (liste modifiable). L'accusé (envoyé, relayé, reçu, non remis) s'affiche sur la ligne. |
| **Trajets des membres** | Bouton **〰** d'un membre : le chemin de son nœud sur les 12 dernières heures. |

Les points de rassemblement sont toujours disponibles.

## Secteurs d'alerte et mode urgence

Sur la carte principale (gestionnaires et administrateurs), deux outils complètent la section pendant une activation :
- **🗺️ Secteurs d'alerte** : un polygone ou un cercle dessiné sur la carte, rattaché à une équipe ou aux nœuds des membres ; alerte quand un équipier sort du secteur (ou y entre), perte de contact en option, journal exportable.
- **🚨 Mode urgence** (activé par un administrateur) : bandeau rouge pour tous les comptes connectés, carte simplifiée (équipes, demandes d'aide, secteurs devant), tableau de crise et journal horodaté exportable. Aucun réglage radio n'est changé.

Détails : [[Secteurs d’alerte et mode urgence|Secteurs-et-mode-urgence]].

## Winlink

La carte s'appuie sur **[Pat](https://getpat.io)**, client Winlink libre (licence MIT), lancé à côté d'elle.

### Installation pas à pas (Winlink par Internet)

Pas besoin de radio ni de VARA pour commencer : Pat se relie aux serveurs Winlink par Internet (session `telnet`). Il faut un compte Winlink (créé sur winlink.org ou au premier lancement d'un client Winlink) : indicatif et mot de passe.

**1. Lancer Pat** (en SSH sur le serveur, dans le dossier de la carte, celui qui contient `docker-compose.yml`) :
```
docker compose --profile winlink up -d
```
Pour retrouver ce dossier : `docker ps --format "{{.Names}}  {{.Label \"com.docker.compose.project.working_dir\"}}"`. Sur un NAS Synology, préfixer les commandes par `sudo`.

**2. Régler la station dans Pat.** Sa page de réglages n'est ouverte **que sur le serveur lui-même** (`127.0.0.1:8081`), jamais sur le réseau. Deux façons de l'atteindre depuis un autre poste :
- **Tunnel SSH** : `ssh -L 8081:127.0.0.1:8081 compte@adresse-du-serveur`, puis ouvrir `http://localhost:8081/ui/config`.
- **NAS Synology** (son SSH refuse les tunnels : « administratively prohibited ») : passerelle **temporaire** sur le réseau local, à refermer aussitôt après :
  ```
  sudo docker run --rm -it --network <projet>_default -p 8082:8080 alpine/socat tcp-listen:8080,fork,reuseaddr tcp-connect:carte-live-pat:8080
  ```
  (`<projet>_default` : voir `sudo docker network ls`). Ouvrir `http://adresse-du-NAS:8082/ui/config`, régler, puis **Ctrl+C** pour fermer la passerelle.

Dans la page de Pat : **Callsign** (indicatif), **Password** (mot de passe Winlink), **Locator**, puis **Save**. Pat se recharge tout seul ; son journal (`docker logs --tail 5 carte-live-pat`) ne doit plus afficher « Missing mycall ».

**3. Activer Winlink dans la carte** : **Réglages › 🎚️ Fonctions de la carte › Winlink**, adresse `http://pat:8080` (ou `http://127.0.0.1:8081` si la carte tourne en `network_mode: host`) et indicatif de la station, puis **Activer Winlink**. La carte redémarre en quelques secondes.

**4. Tester** : **Section ADRASEC › ✉️ Winlink** affiche « Pat joignable · station F4ABC ». Cible `telnet`, **Lancer la session** : les messages « À envoyer » partent, les messages en attente arrivent dans « Reçus ». Pour un premier essai, écrire à sa propre adresse e-mail, relancer une session et vérifier sa boîte mail.

> **Docker-compose personnalisé ou ancien** (sans service `pat`) : ajouter le service `pat` (image `la5nta/pat:1.0.1`, volume `pat:/app/pat`, port `127.0.0.1:8081:8080`) et le volume `pat:` à la section `volumes:`, en gardant une copie du fichier. Pat tourne sous le compte 65534 : si son journal affiche `config.json: permission denied` (Pat redémarre en boucle), donner le volume à ce compte : `docker run --rm -v <projet>_pat:/d alpine:3.20 chown -R 65534:65534 /d`, puis `docker restart carte-live-pat`. Le `docker-compose.yml` fourni le fait tout seul (service `pat-droits`).
>
> **Un indicatif par carte** : un message Winlink n'est livré qu'une fois, à la première station qui se connecte. Deux cartes avec le même indicatif se « volent » le courrier : sur une seconde carte, utiliser l'indicatif de son opérateur ou une **adresse tactique** (créée sur winlink.org).

### Qui a accès à quoi (sécurité)

| | Visiteur, membre de la carte | Membre d'une autre ADRASEC | Membre de l'ADRASEC de la station (SWL compris) | Radioamateur licencié de cette ADRASEC | Administrateur de la carte |
|---|---|---|---|---|---|
| Voir les boîtes (reçus, envoyés…) | ✗ | ✗ | ✔ | ✔ | ✔ |
| Rédiger, lancer une session | ✗ | ✗ | ✗ | ✔ | ✔ si licencié |

- L'**ADRASEC de la station** est réglée par `PAT_ADRASEC` (Réglages avancés › Services) ; par défaut, celle du département de la carte.
- Le **mot de passe Winlink** reste dans Pat : la carte ne le lit jamais, il ne transite pas par le navigateur des membres.
- **Pat n'est jamais ouvert sur le réseau** : son port n'écoute que sur le serveur (`127.0.0.1`), seule la carte lui parle. Ne pas publier ce port, ni le port 8082 de la passerelle temporaire.
- Chaque message déposé et chaque session sont **inscrits en main courante** (indicatif de l'auteur, heure).
- Les messages Winlink circulent **en clair** sur les ondes : c'est la règle radioamateur (pas de chiffrement). Ne rien y écrire de confidentiel (données personnelles de victimes, codes d'accès).
- Pour protéger la boîte : comptes de la carte avec mots de passe solides, **double authentification** pour les administrateurs et présidents (Mon compte), adresse en **https** si la carte est publiée sur Internet.

**La carte ne lit jamais le mot de passe Winlink** : il reste dans la configuration de Pat.

### Utilisation

- **Les membres de l'ADRASEC de la station** lisent les boîtes (reçus, à envoyer, envoyés, archives).
- **Les licenciés seulement** rédigent (le message est signé de leur indicatif et du nom de l'ADRASEC) et lancent une **session** :
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
