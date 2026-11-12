# Installation

You need a machine that is always on, with **Docker**: Synology NAS (Container Manager), Unraid, Raspberry Pi 4/5, Linux server, Proxmox virtual machine…

> The interface is available in French and English (*Settings › Display › 🌐 Language*; by default it follows the browser's language). Terrain-based coverage computations use the French IGN terrain model and only work in France; everything else (live map, messages, administration, MeshCore, reports, teams) works anywhere.

## 1. Get it and start it

### In one command (Linux: Debian, Ubuntu, Raspberry Pi OS, Proxmox VM…)
```bash
curl -fsSL https://raw.githubusercontent.com/sauveteur71/carte-live-meshtastic/main/install.sh | sudo sh
```
The script installs Docker if it is missing (it asks first), creates `/opt/carte-live-meshtastic` with the `docker-compose.yml` (including the one-click update service) and a `.env` (with a random team key), downloads the images, starts the map and shows the address to open. Everything else is then set in the map: the wizard creates the admin account and sets the MQTT server, with a **🔌 Test this MQTT server** button. Then *Settings › 🩺 Diagnostics* checks that everything works.

Options: `DOSSIER=/other/folder`, `CARTE_PORT=8080`, `MISE_A_JOUR=non` (without the update service), placed before `sh`: `… | sudo DOSSIER=/srv/map sh`. Run again on an existing installation, the script only updates the image.

### By hand
```bash
git clone https://github.com/sauveteur71/carte-live-meshtastic.git
cd carte-live-meshtastic
cp .env.exemple .env      # then adapt at least MQTT_URL
docker compose up -d
```

**Synology**: Container Manager › Project › Create, folder `/volume1/docker/carte-live-meshtastic`, then paste the content of `docker-compose.yml`.

The `docker-compose.yml` also starts the **official Meshtastic client** (port 8096) and the **official flasher** (port 8097), reachable from the *Tools* menu.

## 2. The `.env` file

The minimum:

| Variable | Role | Example |
|---|---|---|
| `MQTT_URL` | broker address | `mqtt://mqtt.example.org:1883` |
| `MQTT_UTILISATEUR` / `MQTT_MOT_DE_PASSE` | your account on the broker | ask its administrator |
| `MQTT_RACINE` | start of the Meshtastic topics | `msh/EU_868` |
| `CANAUX` | channels to decrypt | `LongFast=AQ==;MyChannel=key…` |

Everything else is then set from the map (wizard, then *Manage › Settings*).

> **Which wins: the `.env` or the Settings page?**
> - A value **changed** in the wizard or in *Manage › Settings* (broker, channels, title…) **replaces** the `.env` one. The page says so (“these values replace those of the .env”) and offers **Back to .env**.
> - A value left as-is is still read from the `.env`: you can change it later in the `.env`.
> - After editing the `.env`, run **`docker compose up -d`**: a plain `docker compose restart` does **not** read the `.env` again.

Default display (optional):

| Variable | Role | Values |
|---|---|---|
| `CARTE_FOND` | base map on first display | `sombre` (default, dark), `plan`, `plan-sombre`, `photos`, `topo` |
| `CARTE_RESEAUX` | networks offered | `les-deux` (default, both), `meshtastic`, `meshcore`: the Meshtastic / MeshCore / Both choice disappears |
| `MESHCORE_RADIO_ATTENDUE` | expected radio setting of the MeshCore companion (warning if different) | `869.618,62.5,8,8` (default), or `non` to never warn |
| `CARTE_COUCHES_MASQUEES` | layers hidden at start | e.g. `sommets` (high points and suggested sites), `routiers`, `animations`… |

Each visitor can then change the base map and layers in *Layers ▾*. Their choice is kept in their browser.

> ⚠️ Check the spelling of the broker address: a typo such as `mqttexample.org` instead of `mqtt.example.org` gives a looping `getaddrinfo ENOTFOUND` error in the log.

## 3. The setup wizard

Open `http://SERVER_IP:8095`. The wizard creates the **admin account** and sets the department, the broker and the channels.

- **From the machine's local network**: no code is asked.
- **From elsewhere** (remote server, reverse proxy, Tailscale): a **setup code** is asked.
  - If you filled in `ADMIN_MOT_DE_PASSE` in `.env`, it is this value.
  - Otherwise, the map draws a random code and shows it in its log:
    ```bash
    docker compose logs carte-live | grep -i installation
    ```
    It looks like `ABCD-EFGH`. It disappears as soon as the admin account is created.

The wizard takes the values from the `.env` (broker, channels): only touch them to change them. After setup, the map restarts (about ten seconds), then you are logged in.

**Logging in**: with the chosen username (case-insensitive) or the callsign. After 3 wrong attempts in 15 min, the address is blocked for 15 min (see [[Accounts and security|Comptes et sécurité]]).

## 4. Updating

Each image is tested (service startup) before being published. GitHub versions (*Releases* page, `:latest` image) are published on demand: *Actions › Image Docker › Run workflow*, “publier” box.

### In one click (recommended)
When a new version is published, the map header shows “vX available”. An **administrator** clicks it (or ⚙️🔎 › “Update the map”) then **⬆️ Update now**: the map downloads the new image, restarts with the same settings and data (1 to 3 minutes) and the page reloads by itself. If the new version doesn't start, the old one is brought back. The update is refused during remote programming (unless “Force”).

This needs the small **`maj`** service of the `docker-compose.yml` (in the repository's file since 2.14.0). On an older installation, add this block under `services:` then run `docker compose up -d` one last time:

```yaml
  maj:
    image: ghcr.io/sauveteur71/carte-live-meshtastic:latest   # same image as the map
    container_name: carte-live-maj
    command: ["node", "src/majeur.js"]
    restart: unless-stopped
    user: "0"
    environment:
      MAJ_SERVICE: carte-live          # name of the map service in your docker-compose.yml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - donnees:/data                  # the same data volume (or folder) as the map
    healthcheck:
      disable: true
    mem_limit: 64m
```

Security: this service has access to the Docker engine (like Watchtower or Portainer) but **publishes no port**; it can only do one thing, update the map's container, and only obeys the map, with a token created in the data folder (`maj-jeton.txt`). If you don't want to give it this access, delete the block and update by hand.

### Automatically at night (option)
In the “Map update” window: tick **Update automatically at night** and choose the time. The map only updates if a new version is published and no remote programming is running.

### By hand
```bash
docker compose pull && docker compose up -d
```

Data (database, accounts, settings, terrain cache) is in the `donnees` volume: back it up.

**Full backup** (*Settings › 📦 Full backup*, administrator): a single `carte-live-complete-DATE.tar.gz` file with the database, settings, accounts, teams and reports (terrain is not included: it is downloaded again). To change server: install the map on the new one, stop it (`docker compose stop carte-live`), extract the file into its data folder (`tar -xzf carte-live-complete-DATE.tar.gz -C /path/of/the/volume`), then start it again (`docker compose up -d`). The file contains accounts and channel keys: keep it somewhere safe. The map also backs up its settings every night (*Manage › Backups*).

Avoid updating during a running remote programming job: it resumes after the restart, but the current request starts again from scratch.

## Node plugged into the server over USB

To link a node directly to the server (no browser or agent), pass its port to the container in `docker-compose.yml`:

```yaml
    devices: ["/dev/ttyACM0:/dev/ttyACM0"]
    group_add: ["dialout"]
```

These two lines go in the `carte-live` service, at the same indentation as `mem_limit`. Placed under `volumes:`, Docker answers “invalid mount path: 'dialout'”.

Then *Tools › Connect a node › Server USB*. See [[Connect a node|Connecter un module]].

## Terrain for the whole of France (optional)

The terrain of the map's department downloads by itself. For coverage computations in all departments: *Tools › 🗺️ Whole of France › ⬇ Download and install the whole of France* (also in *Manage › Settings › Public map and terrain*) (≈ 110 MB package fetched automatically from GitHub). See [[Coverage and sites|Couverture et sites]].

## 5. Access from outside and HTTPS

The simplest and safest is **Tailscale** on the server and your devices. Bluetooth and USB in the browser require **HTTPS** and **Chrome or Edge**:

```bash
tailscale serve --bg --https=443   http://127.0.0.1:8095   # map
tailscale serve --bg --https=8443  http://127.0.0.1:8096   # Meshtastic client
tailscale serve --bg --https=10000 http://127.0.0.1:8097   # flasher
```

If you publish the map on the internet, put it behind an HTTPS reverse proxy (Nginx, Traefik, DSM proxy).

> 🔒 **Never forward port 4404 (agents) on your router.** It must only be reachable from the local network or a VPN.

## Building the image yourself
In `docker-compose.yml`, replace the `image:` line with `build: .`, then `docker compose up -d --build`.
