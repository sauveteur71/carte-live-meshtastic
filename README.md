# Carte live Meshtastic

Carte en temps réel, supervision et **administration à distance** d'un réseau [Meshtastic](https://meshtastic.org) local ou départemental : elle écoute votre broker MQTT et/ou un module radio, décode les paquets, garde l'historique et permet de programmer vos nœuds par LoRa.

Né pour le réseau **Gaulix** en Haute-Loire (43), le programme s'installe pour n'importe quel département : tout se règle depuis l'assistant d'installation.

> 🇬🇧 *English summary at the end of this page.*

---

## Ce qu'il fait

**Carte et supervision**
- Nœuds en direct (relais, clients, passerelles MQTT…), légende et filtres façon MeshCore, couches IGN (plan, photos, relief ombré, toponymes) ou OpenStreetMap
- Liaisons radio mesurées (SNR, voisinage, traceroutes), trajets GPS, télémétrie (batterie, tension, occupation du canal…)
- Fiche détaillée de chaque nœud : informations, télémétries, voisins (« entendu par »), configuration déduite, toutes les trames avec filtres
- Alertes : nœud muet, batterie faible, canal saturé, passerelle hors ligne…
- Analyse du trafic, rejeu de l'historique, profils radio entre deux points quelconques

**Relief et sites**
- Modèle de terrain IGN (RGE ALTI), couverture estimée d'un nœud ou de n'importe quel point de la carte, calibrée sur les liaisons réellement mesurées
- Points hauts du département, classement des **meilleurs sites à ajouter**, « couvrir un point » (4 sites capables de le desservir)
- **Accès aux sites** d'après OpenStreetMap : en voiture, en 4×4, à pied ou hors chemin
- Export GPX, coordonnées GPS et liens Géoportail / Google Maps pour chaque point

**Administration des nœuds (PKI, firmware 2.5 et plus)**
- Connexion à un module en **Wi-Fi** (TCP 4403), ou en **USB / sur un autre réseau** grâce à l'**agent** (Windows, Linux, Raspberry Pi) relié par Tailscale ou le réseau local
- **Éditeur de réglages** complet (nom, rôle, rediffusion, LoRa, position, 8 canaux) envoyé en une seule transaction et relu pour contrôle
- Lecture de configuration **reprenable**, opérations multi-nœuds, arrêt et « réessayer », garde-fous pour le canal principal
- **Vérification de conformité** : comparer tous vos nœuds à une référence (canaux, précision, fréquence, preset, rediffusion…)
- QR code des réglages d'un nœud, messages directs ou sur un canal

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
  - module Wi-Fi joignable depuis le serveur : son adresse IP ;
  - module USB sur un PC, ou module d'un autre réseau : téléchargez l'**agent** depuis cette même page, lancez-le et donnez-lui l'adresse du serveur (port 4404) et le code affiché. **Ne redirigez jamais le port 4404 sur votre box** : utilisez le réseau local ou un VPN comme [Tailscale](https://tailscale.com).
- **Administration à distance** : sur chaque nœud, ajoutez la clé publique du module (affichée dans l'onglet *Gestion*) dans *Sécurité › Clé d'administration*.

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
- Fonds et relief : © IGN Géoplateforme (licence ouverte Etalab) · OpenStreetMap © contributeurs (ODbL) · communes : API Géo de l'État.
- Meshtastic® est une marque déposée de Meshtastic LLC. Ce projet n'est pas affilié à Meshtastic LLC.

---

## 🇬🇧 English summary

**Carte live Meshtastic** is a self-hosted live map, monitoring and **remote administration** tool for a local Meshtastic mesh (interface in French). It listens to your MQTT broker and/or a radio module (Wi-Fi, or USB through a small Go *agent*), stores history in SQLite, shows nodes, measured RF links, telemetry, alerts and packet details, estimates coverage from the French IGN terrain model, ranks the best hilltop sites (with road / 4×4 / footpath access from OpenStreetMap), and lets you read and edit node settings over LoRa (PKI admin, firmware ≥ 2.5), check that all your nodes share the same configuration, and generate channel QR codes.

Quick start: `cp .env.exemple .env && docker compose up -d`, then open `http://SERVER_IP:8095` and follow the setup wizard. Multi-arch images (amd64/arm64) are published on GitHub Container Registry. Licensed under GPL-3.0.
