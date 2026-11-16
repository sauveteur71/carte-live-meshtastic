# Home automation and monitoring

The map can feed **Home Assistant**, **Node-RED** and **Prometheus / Grafana**, and find the Wi-Fi nodes of the local network by itself.

## Home Assistant and Node-RED (MQTT)

*Settings › Advanced settings › “Home automation (Home Assistant, Node-RED)”*:

| Setting | Purpose |
|---|---|
| Home automation MQTT broker | For example `mqtt://homeassistant.local:1883` (Home Assistant “Mosquitto broker” add-on). Empty = nothing is published. |
| User, password | A broker account (in Home Assistant: a dedicated user, e.g. `carte-live`). |
| Root of the published topics | `carte-live` by default. |
| Automatic discovery | Yes by default: Home Assistant creates the entities by itself. |
| Accept messages to send over LoRa | No by default. |
| Meshtastic channel | Channel of the node used for these messages (0 by default). |

The status shows in *Tools › MQTT broker*, “Home automation” section.

### What Home Assistant gets
A **Carte live** device with: active nodes, online gateways, packets per minute, channel utilisation, computed coverage, active alerts (list as attributes), active MeshCore nodes, and a **Critical alert** binary sensor.

Every **watched node** (relays, gateways, followed nodes, MeshCore repeaters) becomes a device: **online** (connectivity), **last packet**, **battery** and **voltage** when the node sends them, and its **position** on the Home Assistant map.

Example automation: *when “Critical alert” turns to “Problem”, send me a notification*.

### MQTT topics (Node-RED and others)
| Topic | Content |
|---|---|
| `carte-live/disponibilite` | `online` / `offline` |
| `carte-live/etat` | Network summary (JSON, retained) |
| `carte-live/alertes` | Active alerts (JSON, retained) |
| `carte-live/alerte` | Every **new** alert, when it appears (not retained): ideal for a Node-RED flow |
| `carte-live/noeud/<id>` | Status of a watched node (JSON, retained) |
| `carte-live/envoyer` | **Message to send over LoRa** (see below) |
| `carte-live/envoyer/resultat` | Reply: `{"ok":true,"id":…}` or `{"ok":false,"erreur":…}` |

Nothing is published again until something changes.

### Sending a LoRa message from home automation
With “Accept messages to send over LoRa” set to **yes**, publish on `carte-live/envoyer`:
- plain text: `Power cut at the Mézenc relay`;
- or JSON: `{"texte":"…","canal":1}` or `{"texte":"…","vers":"!a1b2c3d4"}` for a direct message.

In Home Assistant, the **Message LoRa** text entity does the same. The map's radio node must be connected. Safeguards: 200 bytes at most, one message every 20 seconds, every message logged.

## Prometheus and Grafana: watching the relays
`/metrics` (protected by the export token if set) gives, besides the network figures, **one line per watched node**:

| Metric | Meaning |
|---|---|
| `carte_noeud_en_ligne` | 1 if heard recently, 0 otherwise |
| `carte_noeud_vu_secondes` | Seconds since the last packet |
| `carte_noeud_batterie_pourcent`, `carte_noeud_tension_volts` | Power |
| `carte_meshcore_etat_lu_secondes` | Last answer of a MeshCore repeater to supervision |
| `carte_meshcore_sans_reponse` | Consecutive unanswered status requests |
| `carte_alerte_active` | One line per current alert (type, level, name) |

Example Alertmanager rule:
```yaml
- alert: RelaySilent
  expr: carte_noeud_en_ligne == 0
  for: 30m
  annotations:
    summary: "{{ $labels.nom }} is no longer heard"
```

**MeshCore supervision** (*MeshCore › Supervision*) regularly polls the repeaters' status. A repeater that does not answer **two requests in a row** raises the “no answer” alert, even if it is still heard.

## Wi-Fi nodes found automatically (mDNS)
Meshtastic Wi-Fi nodes announce themselves on the local network (`_meshtastic._tcp` service). The map looks for them **at start-up, then every 15 minutes**, and every time you click “Search” in *Connect a node*. Nodes found are **added to the list without connecting**: you still choose which one to use. A name given by an administrator is never replaced.

With Docker, the `host` network is required (as for UDP listening). To turn it off: *Advanced settings › Radio node › “Find Wi-Fi nodes on the local network (mDNS)”* set to **no**.
