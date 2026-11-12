# MeshCore

The map shows MeshCore **alone or overlaid** on Meshtastic: repeaters, room servers, companions, sensors, observers, measured and inferred links, live packet analyser.

## The map's companion
**MeshCore › Companion** tab (administrator). The companion acts as an **observer**: it passes every packet it hears to the map, with the SNR. To link it, see [[Connect a node|Connecter un module]]: Wi-Fi (port 5000), USB or Bluetooth. The companion only serves one client at a time.

### Companion tools
- **📡 Who hears me directly?**: 0-hop call; every repeater that hears it answers. Table with the SNR at which **it hears you**, the one at which **you hear it**, and the distance. No password, automatic every 6 h.
- **📊 Noise and statistics**: noise floor, last SNR and RSSI, transmit and receive time, errors, with a **7-day noise curve**. Above −100 dBm, a nearby source hampers reception (cell tower, power supply…).
- **🌡️ Telemetry**: battery and sensors.
- **Default region**: the companion's flood sends are only relayed by repeaters accepting this region.
- **Companion commands** (firmware 1.14+) and **companion Wi-Fi** (network, password, enabled).

## Repeaters
**MeshCore › Program** tab and a repeater's sheet:
- login with the **admin password** (can be remembered);
- read and change settings, status (battery, noise, transmit), neighbours, set the clock, advert, restart, console;
- **Trace**: round trip along the path with the **SNR of each hop**, no password; also done every night around 3 am for monitored repeaters;
- **Telemetry** of repeaters and sensors;
- **home region** and sending region read with the configuration;
- **targeted read**: only the ticked settings (*Targeted read*), instead of reading everything again;
- **🔑 Passwords**: change the admin password (the remembered password follows) and the guest password, or remove it. New passwords are never stored in the operations history;
- **🗺️ Regions**: read the region tree, the home region and the sending region; create (`put`), allow or block a region's floods (`allowf` / `denyf`, `*` for packets without region), set the home (`home`) and the sending region (`default`), delete (`remove`); automatic save (`region save`) and read-back;
- **📋 Templates**: standard settings (prefilled from a repeater that was read), region actions, clock setting and restart, applied to several repeaters at once. Name, position, contact and password are never part of them. A **“Répéteur de base (FR-43)”** template is provided:

  | Setting | Value |
  |---|---|
  | advert.interval | 240 |
  | flood.advert.interval | 24 |
  | agc.reset.interval | 4 |
  | multi.acks | 1 |
  | dutycycle | 10 |
  | path.hash.mode | 1 (2 bytes) |
  | loop.detect | minimal |
  | flood.max.unscoped | 3 |
  | flood.max.advert | 5 |
  | regions | `def eu fr fr-ara fr-43`, `default fr`, `home fr`, save |
  | then | set the clock and restart |

- **🚀 Commissioning** (repeater sheet): a template, the name, the position (prefilled from the map), the contact (`owner.info`) and a new admin password, in one operation;
- **Retry for 2 h**: repeaters with a temporary failure are retried every 10 min for 2 h; each node shows the time of its success or failure;
- **compliance check** and “Align with the reference”;
- automatic **monitoring** and alerts (silent, battery, transmit, interference).

Measured links (discovery, traces) show on the map and in the topology.

## Path from the companion
For each contact, the companion remembers the **path** (list of repeaters) learned at the last exchange. If this path is wrong (repeater moved, off, link down), direct messages no longer arrive although the node is reachable. The node's sheet (*Info* tab) and the right-click **🧭 Path from the companion** show:
- **Flood** (no path) or **Direct** (0 hops), or the list of repeaters with their name when known;
- **↺ Reset** (manager): clears the path, the next send goes out in flood mode and the right path is learned again on the way back, like “Reset path” in the official app;
- **Force direct**: 0 hops, if the node is within range of the companion;
- **Force a path**: IDs of the repeaters from the companion to the node, comma-separated (`A3,7F`, or `A3F1,7F02` with 2-byte IDs; all the same size). A repeater's ID is the start of its key (see its sheet).

The node must be in the companion's contacts (you wrote to it, or administered it). Each change is recorded in the operations history.

## Deleting a node that disappeared
Right-click on the node › **🗑 Delete this node** (administrator): it is erased from the map and the database (telemetry, sensors, links) and removed from the companion's contacts. If it transmits again, it will reappear.

## Sensors: periodic readings and curves
Sheet of a repeater, room or sensor, **Sensors** tab:
- **Read every…**: 15 min, 30 min, 1 h, 3 h, 6 h, 12 h or 24 h (or never). The map starts the “telemetry” task through the companion itself. The node must allow telemetry (remembered guest or admin password, or open telemetry). Each reading sends a packet: 1 h or more is enough for a shelter or a battery;
- **Read now**;
- one **curve per measurement** (voltage, temperature, humidity, pressure, current…) over 1, 7, 30 or 90 days, with last, minimum and maximum;
- **✏️ label**: rename each measurement (“Battery”, “Shelter”, “Solar panel”) instead of “voltage 1”;
- **🔔 Alert**: a low and/or high threshold per measurement. When the last reading goes outside, a MeshCore alert shows (Network tab) and the browser sends a notification if the map is open;
- **🙈 Hide**: removes an irrelevant measurement from the display (unwired input at 0 V…). It stays recorded and in the CSV export, without alert; *Hidden measurements* shows it again;
- **⬇ CSV**: export of the readings of the displayed period (“;” separator, decimal comma, for a spreadsheet).
- **🗑** (on a measurement): erases this measurement, its whole history, its name and its alert; it comes back at the next reading if the sensor still sends it;
- **♻ Reset** (bottom of the tab): after a rename, rewiring or sensor update, channels may change meaning and the old names no longer match. Choose: erase the whole history, only readings before a date, or keep it; and erase measurement names, alerts and hiding. The reading interval is kept.

Readings made by hand from the administration also feed the curves. History is kept 90 days.

## MQTT republishing and channels
- **Republish the companion's packets**: published to your broker under `meshcore/IATA/KEY/packets` (meshcoretomqtt format), for other maps.
- **Area code (IATA)**: 3 letters, for example `LPY` for Le Puy.
- **Packets kept**: department, department and neighbours, or national (heavy).
- **Neighbouring area codes**: to accept observers without position (e.g. `CFE, LYS, EBU`).
- **Channels to decrypt**, one per line:

| Line | Channel |
|---|---|
| `Public` | default public channel |
| `#haute-loire` | hashtag channel: the exact name is enough, # included |
| `ADRASEC=0123…cdef` | private channel: its 32 hex character secret |

Channels already present in the linked companion are decrypted automatically.

## MeshCore topology and simulation
*Tools › MeshCore topology and simulation*: see [[Topology and simulation|Topologie et simulation]].

## Region audit and ID collisions
In *MeshCore › Program*:

**🏷 Region audit.** For each repeater in the area, the map compares two things:
- **Declares**: the regions set on the repeater. It announces them without password to a companion hearing it directly, with the “📡 Ask for their regions…” button. The request is also repeated every 6 h, after automatic discovery.
- **Relays**: region labels of flood packets whose path goes through it (1, 2 or 7 days).

A difference is flagged in orange:
- a region declared but never relayed;
- a region relayed but not declared;
- messages without region relayed although it doesn't accept them.

This is the tool to check a commissioning, for example with the “Répéteur de base (FR-43)” template.

**🔀 ID collisions.** In a path, each relay is only noted by the start of its key: 1 byte by default. Two nearby repeaters starting the same way make the route ambiguous. The table lists these repeaters, with the distance between the closest ones, and the share of paths still on 1 byte. The fix: `set path.hash.mode 1` (2 bytes).
