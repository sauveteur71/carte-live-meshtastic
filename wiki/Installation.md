# Installation

Il faut une machine allumée en permanence avec **Docker** : NAS Synology (Container Manager), Unraid, Raspberry Pi 4/5, serveur Linux, machine virtuelle Proxmox…

## 1. Récupérer et lancer

```bash
git clone https://github.com/sauveteur71/carte-live-meshtastic.git
cd carte-live-meshtastic
cp .env.exemple .env      # puis adaptez au moins MQTT_URL
docker compose up -d
```

**Synology** : Container Manager › Projet › Créer, dossier `/volume1/docker/carte-live-meshtastic`, puis collez le contenu de `docker-compose.yml`.

Le `docker-compose.yml` lance aussi le **client officiel Meshtastic** (port 8096) et le **flasheur officiel** (port 8097), accessibles depuis le menu *Outils*.

## 2. Le fichier `.env`

Le minimum :

| Variable | Rôle | Exemple |
|---|---|---|
| `MQTT_URL` | adresse du broker | `mqtt://mqtt.gaulix.fr:1883` |
| `MQTT_UTILISATEUR` / `MQTT_MOT_DE_PASSE` | votre compte sur le broker | demandez-le à son administrateur |
| `MQTT_RACINE` | début des sujets Meshtastic | `msh/EU_868` |
| `CANAUX` | canaux à déchiffrer | `LongFast=AQ==;MonCanal=clé…` |

Tout le reste se règle ensuite depuis la carte (assistant, puis *Gestion › Réglages*).

> **Qui l'emporte : le `.env` ou la page Réglages ?**
> - Une valeur **changée** dans l'assistant ou dans *Gestion › Réglages* (broker, canaux, titre…) **remplace** celle du `.env`. La page l'indique (« ces valeurs remplacent celles du .env ») et propose **Revenir au .env**.
> - Une valeur laissée telle quelle reste lue dans le `.env` : vous pouvez la modifier plus tard dans le `.env`.
> - Après une modification du `.env`, lancez **`docker compose up -d`** : un simple `docker compose restart` ne relit **pas** le `.env`.

Affichage par défaut (facultatif) :

| Variable | Rôle | Valeurs |
|---|---|---|
| `CARTE_FOND` | fond de carte au premier affichage | `sombre` (défaut), `plan`, `plan-sombre`, `photos`, `topo` |
| `CARTE_RESEAUX` | réseaux proposés | `les-deux` (défaut), `meshtastic`, `meshcore` : le choix Meshtastic / MeshCore / Les deux disparaît |
| `MESHCORE_RADIO_ATTENDUE` | réglage radio attendu du companion MeshCore (avertissement s'il diffère) | `869.618,62.5,8,8` (défaut), ou `non` pour ne jamais avertir |
| `CARTE_COUCHES_MASQUEES` | couches masquées au départ | ex. `sommets` (points hauts et sites proposés), `routiers`, `animations`… |

Chaque visiteur peut ensuite changer de fond et de couches dans *Couches ▾*. Son choix est gardé dans son navigateur.

> ⚠️ Vérifiez l'orthographe de l'adresse du broker : `mqttgaulix.fr` au lieu de `mqtt.gaulix.fr` donne une erreur `getaddrinfo ENOTFOUND` en boucle dans le journal.

## 3. L'assistant d'installation

Ouvrez `http://IP_DU_SERVEUR:8095`. L'assistant crée le **compte administrateur** et règle le département, le broker et les canaux.

- **Depuis le réseau local** de la machine : aucun code n'est demandé.
- **Depuis ailleurs** (serveur distant, proxy inversé, Tailscale) : un **code d'installation** est demandé.
  - Si vous avez rempli `ADMIN_MOT_DE_PASSE` dans `.env`, c'est cette valeur.
  - Sinon, la carte tire un code au hasard et l'affiche dans son journal :
    ```bash
    docker compose logs carte-live | grep -i installation
    ```
    Il ressemble à `ABCD-EFGH`. Il disparaît dès que le compte administrateur est créé.

L'assistant reprend les valeurs du `.env` (broker, canaux) : ne les retouchez que pour les changer. Après l'installation, la carte redémarre (une dizaine de secondes), puis vous êtes connecté.

**Se connecter** : avec l'identifiant choisi (majuscules indifférentes) ou l'indicatif. Après 3 essais faux en 15 min, l'adresse est bloquée 15 min (voir [[Comptes et sécurité]]).

## 4. Mise à jour

Chaque image est essayée (démarrage du service) avant d'être publiée. Les versions GitHub (page *Releases*, image `:latest`) sont publiées à la demande : *Actions › Image Docker › Run workflow*, case « publier ».

### En un clic (conseillé)
Quand une nouvelle version est publiée, l'en-tête de la carte affiche « vX disponible ». Un **administrateur** clique dessus (ou ⚙️🔎 › « Mettre à jour la carte ») puis **⬆️ Mettre à jour maintenant** : la carte télécharge la nouvelle image, redémarre avec les mêmes réglages et données (1 à 3 minutes) et la page se recharge toute seule. Si la nouvelle version ne démarre pas, l'ancienne est remise en route. La mise à jour est refusée pendant une programmation à distance (sauf « Forcer »).

Il faut pour cela le petit service **`maj`** du `docker-compose.yml` (présent dans le fichier du dépôt depuis la 2.14.0). Sur une installation plus ancienne, ajoutez ce bloc sous `services:` puis faites une dernière fois `docker compose up -d` :

```yaml
  maj:
    image: ghcr.io/sauveteur71/carte-live-meshtastic:latest   # même image que la carte
    container_name: carte-live-maj
    command: ["node", "src/majeur.js"]
    restart: unless-stopped
    user: "0"
    environment:
      MAJ_SERVICE: carte-live          # nom du service de la carte dans votre docker-compose.yml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - donnees:/data                  # le même volume (ou dossier) de données que la carte
    healthcheck:
      disable: true
    mem_limit: 64m
```

Sécurité : ce service a accès au moteur Docker (comme Watchtower ou Portainer) mais **ne publie aucun port** ; il ne sait faire qu'une chose, mettre à jour le conteneur de la carte, et n'obéit qu'à la carte, avec un jeton créé dans le dossier de données (`maj-jeton.txt`). Si vous ne voulez pas lui donner cet accès, supprimez le bloc et mettez à jour à la main.

### Automatique la nuit (option)
Dans la fenêtre « Mise à jour de la carte » : cochez **Mettre à jour automatiquement la nuit** et choisissez l'heure. La carte ne se met à jour que si une nouvelle version est publiée et qu'aucune programmation à distance n'est en cours.

### À la main
```bash
docker compose pull && docker compose up -d
```

Les données (base, comptes, réglages, cache du relief) sont dans le volume `donnees` : sauvegardez-le.

**Sauvegarde complète** (*Réglages › 📦 Sauvegarde complète*, administrateur) : un seul fichier `carte-live-complete-DATE.tar.gz` avec la base, les réglages, les comptes, les équipes et les signalements (le relief n'y est pas : il se retélécharge). Pour changer de serveur : installez la carte sur le nouveau, arrêtez-la (`docker compose stop carte-live`), décompressez le fichier dans son dossier de données (`tar -xzf carte-live-complete-DATE.tar.gz -C /chemin/du/volume`), puis relancez (`docker compose up -d`). Le fichier contient les comptes et les clés des canaux : gardez-le en lieu sûr. La carte sauvegarde aussi ses réglages chaque nuit (*Gestion › Sauvegardes*).

Évitez de mettre à jour pendant une programmation à distance en cours : elle reprend après le redémarrage, mais la demande en cours repart de zéro.

## Module branché en USB sur le serveur

Pour relier un module directement au serveur (sans navigateur ni agent), transmettez son port au conteneur dans `docker-compose.yml` :

```yaml
    devices: ["/dev/ttyACM0:/dev/ttyACM0"]
    group_add: ["dialout"]
```

Ces deux lignes vont dans le service `carte-live`, au même retrait que `mem_limit`. Placées sous `volumes:`, Docker répond « invalid mount path: 'dialout' ».

Puis *Outils › Connecter un module › USB du serveur*. Voir [[Connecter un module]].

## Relief de toute la France (facultatif)

Le relief du département de la carte se télécharge tout seul. Pour les calculs de couverture dans tous les départements : *Outils › 🗺️ Toute la France › ⬇ Télécharger et installer toute la France* (aussi dans *Gestion › Réglages › Carte publique et relief*) (paquet de ≈ 110 Mo récupéré automatiquement sur GitHub). Voir [[Couverture et sites]].

## 5. Accès depuis l'extérieur et HTTPS

Le plus simple et le plus sûr est **Tailscale** sur le serveur et vos appareils. Le Bluetooth et l'USB dans le navigateur exigent **HTTPS** et **Chrome ou Edge** :

```bash
tailscale serve --bg --https=443   http://127.0.0.1:8095   # carte
tailscale serve --bg --https=8443  http://127.0.0.1:8096   # client Meshtastic
tailscale serve --bg --https=10000 http://127.0.0.1:8097   # flasheur
```

Si vous publiez la carte sur Internet, placez-la derrière un proxy inversé HTTPS (Nginx, Traefik, proxy de DSM).

> 🔒 **Ne redirigez jamais le port 4404 (agents) sur votre box.** Il ne doit être joignable que par le réseau local ou un VPN.

## Construire l'image soi-même
Dans `docker-compose.yml`, remplacez la ligne `image:` par `build: .`, puis `docker compose up -d --build`.
