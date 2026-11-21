# Alert sectors and emergency mode

Two tools to follow field teams (emergency radio, rescue, missing person search): **alert sectors** warn you when a responder leaves an area (or enters it), **emergency mode** switches the whole map to a crisis set-up. *Tools › 🗺️ Alert sectors* and *Tools › 🚨 Emergency mode* (managers and administrators), or Ctrl+K.

## Alert sectors (geofencing)

### Create a sector (administrator)
1. *Tools › 🗺️ Alert sectors* (or a team's card › *🗺️ Define a sector*).
2. **⬠ Draw a polygon**: tap the map at each corner (at least 3), then **✔ Finish**; or **◯ Circle**: tap the centre, give the radius in metres.
3. Attach it to a **team** (all its current members) and/or to **nodes**: `!a1b2c3d4` for Meshtastic, full public key (64 characters) for MeshCore.
4. Choose the alert: **on leaving** (usual case), **on entering** (area to avoid: cliff, flood, forbidden perimeter) or both.
5. **Create the sector**. It shows on the map (dashed yellow line, orange when someone is outside).

### Settings against false alerts
| Setting | Default | Purpose |
|---|---|---|
| **Margin** | 30 m | A position closer than this to the boundary does not count (edge). |
| **Positions to confirm** | 2 | 2 positions in a row on the same side are needed to change state: a back-and-forth along the edge triggers nothing. |
| **Delay between two alerts** | 10 min | No two alerts of the same kind for the same node within this delay (the event is still logged). |
| **Loss of contact** | 30 min | Alert when a member sends no position for 10 min to 2 h (“no alert” to turn it off). |
| **Warn on a LoRa channel** | no | Short message sent by the map's radio (“⛔ Name outside sector X”). Queue: one message every 30 s, 20 per hour at most, simultaneous alerts grouped (“⛔ A, B outside sector X”), 200 bytes per message. |

### Actual delay of an alert
A confirmed exit needs *N positions in a row* outside: the alert therefore arrives **1 to 2 tracking intervals after the actual exit** (team tracking every 10 min = alert 10 to 20 min later). To shorten it, the map **immediately requests the node's position** at the first position outside the sector (once per 10 min per node, when the map's radio is connected). For a sensitive mission, tighten the team's tracking interval or use 1 position to confirm.

- **Probable exit**: a single position outside the sector followed by **silence** (no news for 10 min, or for one tracking interval if longer) is reported without waiting for confirmation: critical alert “probable exit of *Name* (one position outside the sector, no news for X min)”. The node goes back to “in the sector” as soon as positions inside arrive. A first sign of exit with no follow-up and no silence (the node keeps transmitting near the edge) is forgotten after one hour.
- **Blurred positions** (firmware 2.7/2.8, reduced precision on the public channel): the uncertainty announced by the node widens the margin and the position **is still monitored**: it is “outside” only when its whole cell is (± 3.6 km at 13 bits, ± 450 m at 16 bits, at mid latitudes). While the cell overlaps the boundary, the node is flagged “**cannot be monitored precisely: blurred position (± N m)**” (warning-level alert, in the card and in *Network › Alerts*). To follow a team, share a **precise position** on the team channel (*Member positions* box of the Teams card).
- **Stale position**: a node that lost its GPS repeats its last fix. When the announced fix is older than 15 min (or 2 tracking intervals) and no longer advances, the position is **not counted** and the node is flagged “stale position” (warning). A node with a wrong clock but a live GPS (fixes that advance) is tracked normally.
- **Feed interrupted**: if the map receives **no packet from any source** (MQTT, radio module, agents) for 10 min, it is not the responder who is silent: a single alert “feed interrupted, sector monitoring suspended” is raised, losses of contact and probable exits are suspended, and everything resumes when the feed is back. At map start-up, losses of contact wait for a grace period equal to the *Loss of contact* setting (no burst after a restart).
- The same packet received by several gateways counts once; so does a MeshCore advert without timestamp repeated by several observers.
- MeshCore positions: those of the nodes' **adverts**. They are rare (on demand, or every few hours): prefer Meshtastic for close tracking.
- Polygon: edges must not cross (refused otherwise); a sector straddling the 180° meridian is accepted; latitude 85° at most. For an entry alert, the margin must stay below half the sector.
- Shape changed: known states go back to “no position yet”; team deleted: its sectors that followed only that team are disabled (the log remains).

### Where alerts go
- *Network › Alerts* (critical “outside the sector” or “probable exit”, warning “no position”, “cannot be monitored precisely”, “stale position”, “feed interrupted”), with the alert badge;
- connected managers: clickable notice (centres the map), sound, browser notification, popup on the map;
- Android app (notifications), MQTT home automation (`<root>/alerte`), like other critical alerts;
- optionally, a LoRa message on the chosen channel.

Sectors, their alerts and responders' positions are **never shown to the public** (public map, public alerts, report and Teams card in demo mode, replies to position requests). Live sector alerts and the crisis log only go to connected managers and administrators.

### Log
Every entry, exit (confirmed or probable), loss of contact, contact restored, blurred or stale position, feed outage, creation or change is logged (last 3,000 events, `secteurs.json` in the data folder). *📜 Log* in the card, filter by sector, **⬇ Export the log (CSV)** (UTC and local time, node, position, distance to the boundary, precision, LoRa send status). In CSV exports, a cell starting with `=`, `+`, `-` or `@` (a node name chosen to trap a spreadsheet) is prefixed with an apostrophe: the spreadsheet shows it as text and runs no formula.

### Former team “safety zone”
A team's safety circle (previous versions) is **automatically** turned into a “Zone de sécurité *team*” sector at the first start, with a 100 m margin.

## Emergency mode
Inspired by the emergency mode of the MeshWave app, adapted to a supervision map. An administrator turns it on (*Tools › 🚨 Emergency mode › Turn on*, optional reason); it stays on after a restart until an administrator ends it. Managers see the crisis board and add notes to the log.

During the crisis:
- **red “EMERGENCY” banner** (duration, reason) in the header and a red frame around the screen, for **every connected account**; nothing is shown to the public;
- **simplified, high-contrast map**: the ordinary network fades into the background; team responders (white label), members outside their sector or without news (orange), **help requests** (blinking red 🆘) and sectors stay sharp; top counters hidden;
- **crisis board** (click the banner): pending help requests (✔ Acknowledged), sector alerts, responders and the age of their position, critical network alerts, log; refreshed every 15 s and at each event;
- **network status refreshed every 10 s** instead of 30 s;
- **reports and incident log** brought back if they were hidden (the hidden-features setting is not changed);
- **time-stamped crisis log**: start, team help requests, distress messages received on the channels, sector entries and exits, new critical alerts of relevant nodes (monitored, in the area, team members: on a map with a large feed, hundreds of distant “silent” alerts stay out), **notes** added by hand (📝), end. **⬇ Log (CSV)** export during and after the crisis; the 10 previous crises can still be exported.

**Distress messages**: a message containing 🔔 (Meshtastic bell), SOS or S.O.S, MAYDAY, “à l'aide”, “aidez-moi”, “au secours”, “help” or “besoin d'aide” (whole words: “sosie” does not count) is logged:
- as **critical** when it comes from a team member, a monitored node or a node in the area;
- as **warning** (“possible distress message”) when it comes from any other node: on a public channel, **the sender cannot be verified** (anyone can transmit under any node number); check before committing resources;
- never when it comes from the map's own radio (its own LoRa alerts are not distress calls); at most one per node every 5 min.
Team help requests (Teams card) keep their own handling.

Emergency mode **changes no radio setting and sends no LoRa message**: position requests, search mode and sending stay in your hands (Teams card).

**⏹ End emergency mode** (administrator) brings back the usual display for everyone and offers to export the log.
