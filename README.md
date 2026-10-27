# Carte live Meshtastic

[![Dernière version](https://img.shields.io/github/v/release/sauveteur71/carte-live-meshtastic?label=derni%C3%A8re%20version)](https://github.com/sauveteur71/carte-live-meshtastic/releases/latest)

**Version actuelle : 1.3.0** — [nouveautés](https://github.com/sauveteur71/carte-live-meshtastic/releases/latest) · [toutes les versions](https://github.com/sauveteur71/carte-live-meshtastic/releases)

Carte en temps réel, supervision et **administration à distance** d'un réseau [Meshtastic](https://meshtastic.org) — et désormais [MeshCore](https://meshcore.co.uk) — local ou départemental : elle écoute votre broker MQTT et/ou un module radio, décode les paquets, garde l'historique et permet de programmer vos nœuds par LoRa.

Né pour le réseau **Gaulix** en Haute-Loire (43), le programme s'installe pour n'importe quel département : tout se règle depuis l'assistant d'installation.

> 🇬🇧 *English summary at the end of this page.*

---

## Ce qu'il fait

**Carte et supervision**
- Nœuds en direct (relais, clients, passerelles MQTT…), légende et filtres façon MeshCore, couches IGN (plan, photos, relief ombré, toponymes) ou OpenStreetMap
- Liaisons radio mesurées (SNR, voisinage, traceroutes), trajets GPS, télémétrie (batterie, tension, occupation du canal…)
- Secteur affiché au choix : votre département, le département et ses voisins (calculés automatiquement d'après le département choisi à l'installation), ou toute la France
- Paquets animés en direct : une comète parcourt le trajet saut par saut (émetteur → relais → récepteur), une par récepteur ; les liaisons empruntées s'allument et les axes les plus utilisés depuis 10 min sont soulignés. Pour Meshtastic, quand les relais intermédiaires ne sont pas connus, le trajet le plus probable est déduit des liaisons observées (tracé en pointillé)
- Fiche détaillée de chaque nœud : informations, télémétries, voisins (« entendu par »), configuration déduite, toutes les trames avec filtres
- Alertes : nœud muet, batterie faible, canal saturé, passerelle hors ligne…
- Analyse du trafic, rejeu de l'historique, profils radio entre deux points quelconques

**Relief et sites**
- **Plan pour couvrir le département** : objectif (%), nombre maximal de sites et accès exigé (voiture, 4×4, à pied) → liste des emplacements avec leur accès, la surface apportée et la carte de ce qui reste à couvrir
- **Couverture totale de plusieurs sites** (jusqu'à 10) : surface cumulée et apport propre de chaque site
- Modèle de terrain IGN (RGE ALTI), couverture estimée d'un nœud ou de n'importe quel point de la carte, calibrée sur les liaisons réellement mesurées
- Points hauts du département, classement des **meilleurs sites à ajouter**, « couvrir un point » (4 sites capables de le desservir) ou **plusieurs points (2 à 5) avec un seul site relais** — à défaut, la meilleure paire de sites
- **Accès aux sites** d'après OpenStreetMap : en voiture, en 4×4, à pied ou hors chemin
- Export GPX, coordonnées GPS et liens Géoportail / Google Maps pour chaque point

**Administration des nœuds (PKI, firmware 2.5 et plus)**
- Connexion à un module en **Wi-Fi** (TCP 4403), ou en **USB / sur un autre réseau** grâce à l'**agent** (Windows, Linux, Raspberry Pi) relié par Tailscale ou le réseau local
- **Éditeur de réglages** complet (nom, rôle, rediffusion, LoRa, position, 8 canaux) envoyé en une seule transaction et relu pour contrôle
- Lecture de configuration **reprenable**, opérations multi-nœuds, arrêt et « réessayer », garde-fous pour le canal principal
- **Vérification de conformité** : comparer tous vos nœuds à une référence (canaux, précision, fréquence, preset, rediffusion…)
- QR code des réglages d'un nœud, messages directs ou sur un canal (un clic sur un message bascule sur son canal pour répondre)
- Client et flasheur officiels Meshtastic intégrés (menu *Outils*)

**MeshCore**
- Carte MeshCore à part entière, **seule ou superposée** à Meshtastic (sélecteur *Réseau* en haut du panneau) : répéteurs, room servers, companions, capteurs, observateurs
- Liens radio : mesurés (dernier saut vers un observateur, avec SNR), déduits des chemins des paquets (préfixes de clé rapprochés par la géographie) et des traces
- **Analyseur de paquets** en direct : annonces, messages de canal (déchiffrés pour le canal Public et les canaux « #nom » configurés), messages directs, requêtes, accusés, traces… avec le chemin de relais identifiés et le détail octet par octet
- Le **companion** de la carte sert d'observateur (Wi-Fi, USB par l'agent, ou USB / Bluetooth depuis le navigateur) ; ses paquets sont republiés sur votre broker au format **meshcoretomqtt** (`meshcore/IATA/CLÉ/packets`), et la carte lit aussi les autres observateurs publiés sur le broker
- Couverture et profils de relief avec le réglage radio français (869,618 MHz, BW 62,5 kHz, SF8, CR8)
- **Messages** : envoi sur les canaux du companion et en direct (accusé de réception, « relayé » quand un répéteur a répété votre message), réception des messages directs ; un clic sur un message prépare la réponse
- **Administration à distance des répéteurs et room servers** (onglet *MeshCore › Gestion* et fiche du nœud) : connexion par mot de passe admin (mémorisable), lecture et modification des réglages (nom, radio, puissance, répétition, sauts max., intervalles d'annonce, délais…), état (batterie, bruit de fond, temps d'émission), voisins déclarés (ajoutés à la carte), mise à l'heure, annonce, redémarrage, console CLI
- **Vérification de conformité** de plusieurs répéteurs par rapport à une référence, avec « Aligner sur la référence »
- *Relier* et *Couvrir* utilisent les répéteurs MeshCore et le réglage radio MeshCore en vue « MeshCore »
- **Supervision** : état des répéteurs de la zone interrogé automatiquement (toutes les 3 h par défaut, `MESHCORE_SUPERVISION_HEURES`), courbes de tension, d'émission et de bruit de fond ; **alertes** MeshCore (répéteur muet depuis `MESHCORE_MUET_HEURES`, batterie faible, émission excessive, brouillage, companion déconnecté)
- **Tester la liaison** vers un nœud (découverte du chemin aller et retour), **analyse du trafic** (types, temps d'antenne, sauts, émetteurs, répéteurs les plus traversés, observateurs), chaleur d'activité
- **QR codes** au format de l'appli MeshCore : contact de n'importe quel nœud, canaux du companion (admin)

**Comptes** : administrateur créé à l'installation, inscriptions (fermées, sur validation ou ouvertes), précision des positions réduite pour le public.

---

## Installation (Docker)

Il faut une machine allumée en permanence avec Docker : NAS Synology (Container Manager), Unraid, Raspberry Pi 4/5, serveur Linux…

```bash
git clone https://github.com/sauveteur71/carte-live-meshtastic.git
cd carte-live-meshtastic
cp .env.exemple .env      # puis adaptez au moins MQTT_URL
docker compose up -d
```

Ouvrez ensuite `http://IP_DU_SERVEUR:8095` : l'**assistant d'installation** crée le compte administrateur et règle le département, le broker MQTT et les canaux. Sans `ADMIN_MOT_DE_PASSE` dans `.env`, l'installation n'est possible que depuis le réseau local.

**Synology** : Container Manager › Projet › Créer, dossier `/volume1/docker/carte-live-meshtastic`, en collant le contenu de `docker-compose.yml`.

### Mise à jour

```bash
docker compose pull && docker compose up -d
```

Les données (base, comptes, réglages, cache du relief) sont dans le volume `donnees` : pensez à le sauvegarder.

### Construire l'image soi-même

Dans `docker-compose.yml`, remplacez la ligne `image:` par `build: .`, puis `docker compose up -d --build`.

---

## Brancher le réseau

- **MQTT** : la carte s'abonne à `MQTT_RACINE/#` (par défaut `msh/EU_868`). Un exemple de broker Mosquitto (TLS, comptes, droits) est fourni dans [`mosquitto/`](mosquitto/).
- **Canaux** : ajoutez vos canaux (nom + clé) dans l'assistant ou dans `.env` (`CANAUX=MonCanal=AQ==;Autre=clé…`) pour déchiffrer leurs paquets.
- **Module radio** (facultatif mais nécessaire pour l'administration) : *Réseau › Modules radio*
  - **module branché en USB (ou en Bluetooth) sur le PC qui affiche la carte** : bouton *🔌 Brancher en USB* — la page relaie le module, rien à installer (Chrome ou Edge, carte en HTTPS) ;
  - module Wi-Fi joignable depuis le serveur : son adresse IP ;
  - module USB sur un PC, ou module d'un autre réseau : téléchargez l'**agent** depuis cette même page, lancez-le et donnez-lui l'adresse du serveur (port 4404) et le code affiché. **Ne redirigez jamais le port 4404 sur votre box** : utilisez le réseau local ou un VPN comme [Tailscale](https://tailscale.com).
- **Administration à distance** : sur chaque nœud, ajoutez la clé publique du module (affichée dans l'onglet *Gestion*) dans *Sécurité › Clé d'administration*.

### MeshCore

Onglet **MeshCore › Companion** (admin) : reliez un companion MeshCore, qui devient l'**observateur** de la carte.
- **Wi-Fi** : firmware « companion Wi-Fi », adresse IP et port (5000 par défaut) ;
- **USB sur ce PC** (firmware « companion USB ») ou **Bluetooth** (firmware « companion BLE ») : boutons de la page, Chrome ou Edge, carte en HTTPS ;
- **USB sur un autre PC** : l'agent (même programme que pour Meshtastic), choisi ensuite dans la liste des agents.

Le companion ne sert qu'un client à la fois : l'appli MeshCore du téléphone est déconnectée pendant ce temps.

Le compte MQTT de la carte doit pouvoir **lire et écrire** `meshcore/#` (voir [`mosquitto/config/acl.exemple`](mosquitto/config/acl.exemple)). Réglages (`.env` ou onglet Companion) : `MESHCORE_IATA` (code de zone, ex. `LPY`), `MESHCORE_CANAUX` (`Public`, `#nom`, `nom=secret`), `MESHCORE_REPUBLIER`.

Essai sans matériel : `node outils/simulateur-meshcore.js`, puis *Companion › Wi-Fi* `127.0.0.1` port `5000`.

### Client et flasheur officiels (menu *Outils*)

Le `docker-compose.yml` lance aussi, à côté de la carte :
- le **client officiel Meshtastic** ([meshtastic/web](https://github.com/meshtastic/web)) sur le port 8096 : gérer un module en USB, Bluetooth ou HTTP depuis le navigateur ;
- le **flasheur officiel** ([meshtastic/web-flasher](https://github.com/meshtastic/web-flasher)) sur le port 8097 : installer ou mettre à jour le firmware d'un module branché en USB (le firmware est téléchargé depuis les serveurs Meshtastic).

L'USB et le Bluetooth dans un navigateur exigent **Chrome ou Edge** et une page en **HTTPS**. Avec Tailscale (HTTPS activé dans la console, rubrique DNS), sur le serveur :

```bash
tailscale serve --bg --https=443   http://127.0.0.1:8095   # carte
tailscale serve --bg --https=8443  http://127.0.0.1:8096   # client
tailscale serve --bg --https=10000 http://127.0.0.1:8097   # flasheur
```

La carte devient `https://MACHINE.TAILNET.ts.net` et le menu *Outils* pointe tout seul vers le client (`:8443`) et le flasheur (`:10000`). Autres adresses : variables `URL_CLIENT_MESHTASTIC` et `URL_FLASHER` dans `.env`.

### Plusieurs modules pour un même agent

L'agent garde en mémoire autant de connexions que vous voulez (ex. *USB* sur `COM5`, *Le Monteil* sur `192.168.1.83`, *QRA* sur `192.168.0.50`). Chacune apparaît dans *Réseau › Modules* sous son nom, **seulement quand son module est présent** : port USB branché, ou module Wi-Fi sur le même réseau local que le PC. Emportez le portable d'une maison à l'autre : la bonne connexion apparaît toute seule.

- `-configurer` : menu pour ajouter (`a`), modifier (`m 2`), retirer (`r 2`) une connexion ou changer le serveur et le code (`s`)
- `-ajouter` : ajouter une connexion d'un coup ; `-liste` : voir les connexions et leur état
- module Wi-Fi joint par un VPN ou un routeur (pas sur le réseau local du PC) : ajoutez `"toujours": true` à sa connexion dans `agent-gaulix.json`

Les réglages d'un agent 1.3 ou antérieur sont repris automatiquement.

### Agent lancé automatiquement

- **Windows** : à la première configuration, l'agent propose de se lancer tout seul à chaque ouverture de session (fenêtre réduite). Options : `-demarrage-auto`, `-sans-demarrage-auto`, `-configurer`, `-ajouter`, `-liste`.
- **Linux / Raspberry Pi** : service systemd, par exemple `/etc/systemd/system/agent-gaulix.service` :

```ini
[Unit]
Description=Agent carte live Meshtastic
After=network-online.target
[Service]
ExecStart=/opt/agent-gaulix/agent-gaulix-raspberrypi-arm64 -config /opt/agent-gaulix/agent-gaulix.json
Restart=always
[Install]
WantedBy=multi-user.target
```
puis `sudo systemctl enable --now agent-gaulix` (configurez d'abord l'agent une fois à la main).

### Accès depuis l'extérieur

Le plus simple et le plus sûr est **Tailscale** (gratuit pour un usage personnel) sur le serveur et vos appareils. Si vous publiez la carte sur Internet, placez-la derrière un reverse proxy HTTPS.

---

## Développement

```bash
cd carte-live && npm install && node src/server.js     # carte sur http://localhost:8095
node outils/simulateur.js mqtt://IP:1883               # trafic Meshtastic simulé
cd agent && go build .                                  # agent
```

- `carte-live/src` : serveur Node.js (MQTT, décodage protobuf, SQLite, API, administration LoRa, relief)
- `carte-live/public` : interface (Leaflet, sans étape de compilation)
- `agent/` : agent en Go (USB/série ou Wi-Fi → serveur)

Les contributions sont bienvenues : ouvrez une *issue* pour proposer une idée ou signaler un problème.

---

## Licence et données

- Code sous licence **GNU GPL v3** (voir [LICENSE](LICENSE)), comme le projet Meshtastic.
- Protobufs : [meshtastic/protobufs](https://github.com/meshtastic/protobufs) (GPL v3).
- Format des paquets MeshCore : documentation de [meshcore-dev/MeshCore](https://github.com/meshcore-dev/MeshCore) (MIT) ; format MQTT de [meshcoretomqtt](https://github.com/Cisien/meshcoretomqtt).
- Fonds et relief : © IGN Géoplateforme (licence ouverte Etalab) · OpenStreetMap © contributeurs (ODbL) · communes : API Géo de l'État.
- Meshtastic® est une marque déposée de Meshtastic LLC. Ce projet n'est pas affilié à Meshtastic LLC.

---

## 🇬🇧 English summary

**Carte live Meshtastic** is a self-hosted live map, monitoring and **remote administration** tool for a local Meshtastic mesh (interface in French). It listens to your MQTT broker and/or a radio module (Wi-Fi, or USB through a small Go *agent*), stores history in SQLite, shows nodes, measured RF links, telemetry, alerts and packet details, estimates coverage from the French IGN terrain model, ranks the best hilltop sites (with road / 4×4 / footpath access from OpenStreetMap), and lets you read and edit node settings over LoRa (PKI admin, firmware ≥ 2.5), check that all your nodes share the same configuration, and generate channel QR codes. It also maps **MeshCore** networks (alone or overlaid on Meshtastic): repeaters, room servers, companions, links deduced from packet paths, a live packet analyzer, a companion radio used as observer (Wi-Fi, USB or Bluetooth), and meshcoretomqtt-compatible MQTT ingest and republishing.

Quick start: `cp .env.exemple .env && docker compose up -d`, then open `http://SERVER_IP:8095` and follow the setup wizard. Multi-arch images (amd64/arm64) are published on GitHub Container Registry. Licensed under GPL-3.0.
