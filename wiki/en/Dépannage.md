# Troubleshooting

### `getaddrinfo ENOTFOUND` in the log
The broker address is misspelled (for example `mqttexample.org` instead of `mqtt.example.org`). Fix `MQTT_URL` (or *Manage › Settings*), then `docker compose up -d`.

### The MQTT broker from the `.env` is not used
- After editing the `.env`: **`docker compose up -d`** (a `docker compose restart` doesn't read the `.env` again).
- If the broker was set in the wizard or in *Manage › Settings*, that setting **replaces** the `.env`: the page says so. Fix it on the page, or click **Back to .env**.
- Since 2.11.2, the wizard no longer saves values taken as-is from the `.env`: only the ones you change replace the `.env`.

### Can't log in right after setup
- Wait for the restart that follows the wizard (about ten seconds), then reload the page.
- Username: the one typed in the wizard (case-insensitive since 2.11.2) or the callsign.
- “Too many failures… blocked until …”: 3 wrong attempts in 15 min block the address for 15 min. Wait, or unblock from another admin account (*Manage › Log*). From the local network, only the address is blocked, never the account.
- Behind a reverse proxy, check that the map sees visitors' addresses (see [[Accounts and security|Comptes et sécurité]]).

### Setup asks for a code I don't have
`docker compose logs carte-live | grep -i installation` shows the code. Or set a value in `ADMIN_MOT_DE_PASSE` (`.env`) and restart.

### “host unreachable” (EHOSTUNREACH) for a Wi-Fi node
The server is not on the same network as the node. Use *Connect a node* with **agent 1.6** running on a PC on that network, or Bluetooth or USB from the browser.

### Bluetooth doesn't find the node
Map over **HTTPS**, **Chrome or Edge**, phone app disconnected. On a Meshtastic ESP32, Bluetooth is off when Wi-Fi is on. Pair the node in Windows if needed (code shown or `123456`).

### Remote programming often fails
- Look at the message: key refused or radio problem (see [[Remote programming|Programmation à distance]]).
- Use **Retry for 2 h**.
- Program from a node that hears the target well: a badly placed map node makes many requests fail.

### I get no feedback on my messages
Look under the message: “relayed”, “received”, and the list of receivers. If no receiver reported it, the map's node reaches nobody: send from a better placed node. To check a specific contact, send them a direct message (✓✓ ack).

### A solar node disappears at night
Battery or panel too small: it only transmits in the sun. Turn on its telemetry (30 min) to follow the voltage, check the batteries and the panel's orientation.

### “kicked out by another client of the node”
Another device (often the phone app over Wi-Fi) connected to the node. A node only accepts one client at a time.

### The other network's links stay displayed
Update the map (2.0.0): switching Meshtastic ↔ MeshCore now clears the other network's traces.

## Built-in diagnostics
*Settings › 🩺 Diagnostics* (administrator, or ⚙️🔎 “diagnostics”) checks at once: MQTT server, incoming messages, share of decrypted packets, Meshtastic node, MeshCore node, ignored MeshCore packets (area code, perimeter), bridge links, update, database size and disk space. Each point to look at explains what to do and offers the button leading to the right setting.

## Hiding high points and suggested sites
*Layers ▾ › High points*: one click hides them, another shows them again. The choice is kept for the next visit. To hide them by default for the whole map: `CARTE_COUCHES_MASQUEES=sommets` in the `.env`.

## MeshCore USB companion “linked, but silent”
Opening the USB port often restarts the companion. Since 2.1.1, the map asks it for its info several times over about thirty seconds. If it stays silent:
- check it has the **companion USB** firmware (not companion BLE or repeater);
- close any other app using the port;
- **↻ Retry** button in *MeshCore › Companion*, or unplug and plug it back in.

## Node plugged in over USB: is it really linked over USB?
*MeshCore › Companion* shows the link: “linked · linked by this page… (**USB** …)” or “(**Bluetooth** …)”. A MeshCore companion has either the **companion USB** or **companion BLE** firmware: the latter doesn't answer on the cable. Since 2.1.3, *Connect a node* says so, instead of taking the node for a Meshtastic node.

The agent is **not** needed for a page's USB or Bluetooth: the page relays the node, as long as the tab stays open and the PC doesn't go to sleep. The agent is for a node that must stay linked without an open browser.

## Node linked by a page disconnects after a few minutes
Often a reverse proxy (nginx, Traefik, Cloudflare) cutting silent WebSockets. Since 2.1.3, the server sends a “ping” every 25 s and the page reconnects by itself (USB and Bluetooth). With nginx, also set `proxy_read_timeout 3600s;` and the `Upgrade` / `Connection` headers for `/ws`.
