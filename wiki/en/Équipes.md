# Teams

*Program › 👥 Teams* (administrator). For an organisation that deploys and manages its own nodes (rescue, association, island…): each team has its own **encrypted channel**, which the map's node **adds or removes remotely** on the responders' nodes. When a responder joins a team, their node receives the channel; when they leave, the channel is removed.

## How it works
- The map's node (linked over USB, Wi-Fi or by the agent) administers the nodes **over radio**, with the encrypted administration of firmware 2.5+: the **node's public key** must be in each node's **admin keys** (Program › 🔑 Admin keys). Done once, when preparing the node.
- The team channel is created with MQTT `uplink` and `downlink` **off**: the team's messages never reach the broker and stay encrypted (AES-256) between the team's nodes. The map doesn't see them: this is intended (victims' personal data).
- The map's node doesn't need to have the team channel: it only writes the nodes' configuration.

## Creating a team
Channel name (11 characters at most, no accents or spaces), description, and option **members' positions on the team channel**. The map generates an AES-256 key; you can also import an existing key (16 or 32 bytes in base64).

## Adding or removing nodes
- **➕ Add**: typed IDs (`!a1b2c3d4, !e5f6a7b8`) and/or nodes ticked in Program. For each node, the map reads its channels, adds the channel in the first free slot (or updates the one already carrying this name), then **reads back to check** the name and key.
- **Remove**: the channel is deleted and the following channels move up one slot (like `meshtastic --ch-del`), then read back.
- An absent node (off, out of range) is retried **every 10 min for 2 h**; then **↻ Resend to nodes not up to date**.
- Each node shows its status: ✔ up to date (channel slot), ⏳ waiting, ⚠ failed with the reason.

## Requesting positions
**📍 Request positions**: each team node sends back its position (one request every 3 s so as not to saturate the channel). Answers show at the bottom of the screen; a click centres the map on the node. For a single node: right-click on the node › **📍 Request its position** (manager), like “Request position” in the app. The node must have its position enabled and receive the map's node (shared primary channel, or exchanged public key).

### Automatic tracking
**Position tracking** (on demand, or every 5, 10, 15, 30 or 60 min): the map asks members for their position at this interval. Each member shows the age of its last position (“view” centres the map). A member **with no news** (position older than 3 intervals, 30 min at least) is flagged in red and in the network alerts. Each request is a radio packet: keep a reasonable interval.

## Lost or stolen node: new key
Removing a node only erases the channel **if it is reachable**. For a lost, stolen or unresponsive node: remove it from the team, then **🔑 New key** (type `NOUVELLE CLE`). All members receive the new key; the old node no longer understands anything. Until a member has received the new key, it no longer understands the others: resend it until all are up to date.

## Exporting the key
**⬇ Export the key** (recorded in the operations history):
- **`NAME.cle` file** (base64 key) for the command line;
- **channel link** for the Meshtastic app (adds the channel without touching the others), for a node prepared by hand.

## Command-line equivalent (meshtastic CLI)
From the node (`--port /dev/ttyUSB0` or `--host IP`), to a responder's node:
```
# add the channel with the team key (don't use --ch-add: it draws a random key on each node)
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --ch-index 1 \
  --ch-set name Team1 --ch-set psk base64:$(cat Team1.cle) \
  --ch-set uplink_enabled false --ch-set downlink_enabled false
# or with the exported channel link
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --ch-add-url 'https://meshtastic.org/e/?add=true#…'
# remove (the following channels move up one slot)
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --ch-index 1 --ch-del
# lock the node: only remote administration can change it
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --set security.is_managed true
```

## Key security on the server
- Team keys are **encrypted** (AES-256-GCM) in `equipes.json` with a master key: the **`CLE_EQUIPES`** variable of the `.env` (a long phrase or a random value, e.g. `openssl rand -base64 32`), otherwise a `cle-equipes.bin` file created automatically in the data folder.
- `equipes.json` is included in backups, `cle-equipes.bin` is **not**: to be able to restore teams on another installation, set `CLE_EQUIPES` **before** creating the first team and keep it separately. Changing `CLE_EQUIPES` afterwards makes the keys unreadable (the map says so: create a new key).
- The key never appears in the team list, recorded operations, logs or history; only the export (administrator) shows it.
- Configuration reads kept by the map (Program › Read) contain the channels read, keys included, as for other channels: protect the data folder.
