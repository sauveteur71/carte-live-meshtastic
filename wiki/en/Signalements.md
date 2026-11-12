# Reports

To report a field event (flooded road, tree on the road, accident, gathering point…) and **send it over LoRa**. For logged-in members.

## Reporting
Right-click (or long press) on the map › **🚩 Report an event here**, then:
- a **category** (Roads, Crisis, First aid, Weather, Status, Fire brigade, ADRASEC) and a **type**: they are the same as **GerMaCrise / Bipper** (F4EED), with the same emoji and icon;
- a title, details (140 characters) and a **duration** (2 h to 7 days);
- **Meshtastic**: the node's channels to send on. By default **Fr_Balise** and **Alerte**, like GerMaCrise; the map then remembers your last choice;
- **MeshCore**: a companion channel, if the companion is linked.

## Section or area
**Shape**: *A point* (default), *A section* (flooded road between two or more points) or *An area* (perimeter). For a section or an area, tap the map to place the next points (“Remove the last one” to correct). The drawing shows in red on the map and on the public map. Over LoRa, the waypoint stays at the first point; a section's text message also gives its end point.

## Bipper / GerMaCrise alerts
*Tools › 🚩 Reports*, **📟 Bipper alerts** block (managers): type (alert, rescue, watch, info), channel (default **Alerte**), text and targeted entities. The map sends `#alerte N text #entity` with an increasing number, in the format of Bipper pagers and GerMaCrise (F4EED). The pagers' **read receipts** (`Pager ACK alerte #N …`) show under the alert, with the node's name. **✅ Close** sends `#fin N`.

## What goes out over LoRa
- **Meshtastic**: a **waypoint** (port 8) on each ticked channel, 500 ms apart, alert priority, no ack (like GerMaCrise). It appears on the Meshtastic apps' map with its icon and disappears at the end of the chosen duration, and on Bipper / GerMaCrise. Optionally (ticked by default), a **text message** on the same channels: `🌊 Flooded road: RD 103… · 45.07401,3.90015 · F4GLD`.
- **MeshCore**: the same text message on the chosen channel (cut at 140 bytes).
- The status of each send (✔ sent, ⚠ failed and why) is shown on the report.

## On the map
Active reports have a red marker with their icon. A click: details, author, time, send status, and
- **✅ Done**: an end message goes out on the same channels and the waypoint is removed from the apps;
- **↻ Resend**: sends the report again (for example after linking the node).

*Tools › 🚩 Reports* lists active reports and those of the last 7 days.

## Without network
No connection when reporting (dead zone, network down): the report is **kept on the device** (dotted orange marker), then **sent by itself** when the network is back, with the time it was made. *Retry now* forces sending. The last known list of reports stays shown offline. With *Tools › Field mode*, the area's map tiles can also be prepared in advance.

## Public map and log book
- **Current** reports also show on the **public map** (`/publique`), read only: type, title, details and time, without the author.
- **📋 Log book** (*Tools › Reports*): printable page (PDF) of the last 7 days' reports, with time, position, author, broadcast and end.

## Received waypoints
Waypoints captured by the map (MQTT or node), sent by a Bipper, GerMaCrise or the Meshtastic app, also become reports (📻 received over radio), with their author. Those without a duration stay shown for 24 h; “Done” only removes them from the map.
