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
| **Loss of contact** | no | Alert when a member sends no position for 10 min to 2 h. |
| **Warn on a LoRa channel** | no | Short message sent by the map's radio (“⛔ Name outside sector X”), at most one every 30 s for the whole map. |

- **Blurred positions** (firmware 2.7/2.8, reduced precision on the channel): the uncertainty announced by the node widens the margin. A position blurrier than half the sector's size (for example ± 2.9 km on a 1 km sector) is **ignored** and logged once (“position too imprecise”). To follow a team, share a **precise position** on the team channel (*Member positions* box of the Teams card).
- The same packet received by several gateways counts once.
- MeshCore positions: those of the nodes' **adverts**. They are rare (on demand, or every few hours): prefer Meshtastic for close tracking.

### Where alerts go
- *Network › Alerts* (critical “outside the sector”, warning “no position”), with the alert badge;
- connected managers: clickable notice (centres the map), sound, browser notification, popup on the map;
- Android app (notifications), MQTT home automation (`<root>/alerte`), like other critical alerts;
- optionally, a LoRa message on the chosen channel.

Sectors, their alerts and responders' positions are **never shown to the public** (public map, public alerts).

### Log
Every entry, exit, loss of contact, contact restored, ignored position, creation or change is logged (last 3,000 events, `secteurs.json` in the data folder). *📜 Log* in the card, filter by sector, **⬇ Export the log (CSV)** (UTC and local time, node, position, distance to the boundary, precision).

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
- **time-stamped crisis log**: start, team help requests, distress messages received on the channels (SOS, MAYDAY, 🔔, “au secours”, “besoin d'aide”), sector entries and exits, new critical alerts, **notes** added by hand (📝), end. **⬇ Log (CSV)** export during and after the crisis; the 10 previous crises can still be exported.

Emergency mode **changes no radio setting and sends no LoRa message**: position requests, search mode and sending stay in your hands (Teams card).

**⏹ End emergency mode** (administrator) brings back the usual display for everyone and offers to export the log.
