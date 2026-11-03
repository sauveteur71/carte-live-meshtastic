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

Affichage par défaut (facultatif) :

| Variable | Rôle | Valeurs |
|---|---|---|
| `CARTE_FOND` | fond de carte au premier affichage | `sombre` (défaut), `plan`, `plan-sombre`, `photos`, `topo` |
| `CARTE_RESEAUX` | réseaux proposés | `les-deux` (défaut), `meshtastic`, `meshcore` : le choix Meshtastic / MeshCore / Les deux disparaît |
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

## 4. Mise à jour

```bash
docker compose pull && docker compose up -d
```

Les données (base, comptes, réglages, cache du relief) sont dans le volume `donnees` : sauvegardez-le. La carte sauvegarde aussi ses réglages chaque nuit (*Gestion › Sauvegardes*).

Évitez de mettre à jour pendant une programmation à distance en cours : elle reprend après le redémarrage, mais la demande en cours repart de zéro.

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
