# Messages

## Sending
**Messages** tab (administrator, radio node linked):
- choose a **channel**, or **✉️ Direct message… (choose a node)**: search by name, short name or `!id`, recent nodes first;
- **recent contacts** are offered directly in the list;
- clicking a received message prepares the reply on the right channel (or directly to its author).

## Knowing whether the message got through
Under each message sent from the map:

| Shown | Meaning |
|---|---|
| ✓✓ Received by X | direct message: the recipient sent back an ack |
| ✓ Relayed by a neighbour | the node heard a neighbour re-transmit the message: it went out |
| ✗ no neighbour relayed | nobody picked it up after 3 transmissions |
| ⚠ No ack received | nothing came back |

Under **every** message: **📡 Heard by N receivers**, with for each one the gateway, direct or the hop count, the SNR and the last relay. A click opens the route on the map.

**Limits**: a node without an MQTT gateway that receives your message leaves no trace. On private channels, only gateways with uplink to MQTT on that channel report it. A channel message has no read receipt: to check that a specific contact hears you, send them a **direct message**.

## Unread, sounds and alerts
- **Counter** on the *Messages* tab (red if there is a direct message) and on the *MeshCore* tab.
- **Channel bar** at the top of the messages: one pill per channel, marked **MT** (Meshtastic) or **MC** (MeshCore). A channel that received messages moves **to the front**, in colour, with the **number waiting** (in yellow) and the time of the last message; it pulses for a few seconds when a message arrives. Direct messages are in red. Clicking a pill opens that channel, even if it belongs to the other network.
- In the list, each message carries its **channel name in colour** (the same colour as its pill), and messages that arrived since the last read are **highlighted** with a “NEW” label for 3 minutes.
- **🔔 Sounds**: tick the channels that should ring, each with its own note (▶ button to listen).
- **Direct message received** by the map's node: three notes, a “Read / OK” box and a Windows or phone **notification** when the tab is in the background (to allow once).

Sound only works after a first click in the page (browser rule). These settings belong to each browser.

## Region label (MeshCore)
Each MeshCore message sent in flood mode can carry a **region** (for example `fr-ara`). A repeater only relays it if this region is in its region tree (`region def …`). A message **without region** is only relayed by repeaters that accept it (`flood.max.unscoped`).

In the message list, a label shows it:
- **🏷 fr-ara**: the region carried by the message;
- **no region**: flood without label;
- **🏷 region?**: a region the map doesn't know. Add its name to `MESHCORE_REGIONS` in the `.env` (comma-separated).

For your own messages, it is first the companion's sending region (*MeshCore › Companion › Region*), then the one actually seen when a repeater sends the message back. The map recognises `eu`, `europe`, `fr`, French regions (`fr-ara`, `fr-bfc`…) and departments (`fr-43`, `fr-38`…), as well as a few neighbouring countries (`ch`, `it`…). A packet's details (*Packets*) show it too.

## Shared position
A message containing `meshand: 45.04312,3.88512` (the MeshAnd app format), `geo:45.04312,3.88512` or `📍 45.04312,3.88512` becomes a **📍 pin** on the map. In the message list, the “📍 View on the map” button centres the map on the position. The pin gives the route, the coverage from this point and a button to remove it. Positions received less than 12 h ago are pinned automatically.

To send one:
- **📍 Attach the map centre**, under the input area (Meshtastic and MeshCore);
- or **right-click on the map › 📍 Share this point in a message**.

## Choosing what is shown
A **single *Channel* menu** at the top of the tab is used to read and write: the chosen channel is the one whose messages you see and the one the typed message goes to. **✉️ My direct messages** shows the recipient choice. **All channels** and **Relayed by the bridge** are read only, like a channel the map's node doesn't have. Replying to a message selects its channel. Same behaviour in MeshCore › Messages, with the companion's channels.

The *Channel* menu also lists the other network's channels (**MeshCore** group in Meshtastic messages, **Meshtastic** group in MeshCore messages): choosing one takes you there directly.

**✉️ My direct messages** only keeps direct messages sent or received by your nodes (main node and listening nodes linked to the map), not those exchanged between other nodes.
