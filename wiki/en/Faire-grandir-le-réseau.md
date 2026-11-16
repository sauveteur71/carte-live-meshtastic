# Growing the network

Two tools to bring new nodes into the network: spot the ones set up differently, and give them a clear page to join you.

## Nodes to invite (other preset)

*Tools › Network › 📣 Nodes to invite* (administrator).

A node set to another preset than yours (for example LongFast while the network uses LongModerate) does not hear the network, and the network does not hear it. The map still knows it through MQTT: from its map report (exact preset) or from the name of its primary channel (deduced preset).

- On the map, these nodes have a **dashed orange ring**; their sheet shows a preset badge.
- The panel lists the nodes seen in the last 30 days, nearest first.
- **Invite**: a small node set to their preset, connected to the map **as a listener** (a “sentinel”, *Tools › Connect a node › listening, in addition*), sends them a direct message that you review first (200 bytes at most). When the “Join the network” page is published, the invitation offers its address.

## “Join the network” page

*Tools › Network › 🤝 “Join the network” page* (administrator). The public page opens at `/rejoindre` on your map, without an account. It is designed for newcomers and for printing (poster, flyer), inspired by the Mesh Hessen page.

It shows, in order:

1. **The Meshtastic channel**: QR code to scan in the app, “Open in the Meshtastic app” button on phones, region, network preset (shown automatically) and recommended hop limit.
2. **Recommended roles**: by default CLIENT, CLIENT_MUTE, and ROUTER only at high sites with agreement.
3. **MeshCore settings** (frequency, bandwidth, SF, CR), if you fill them in.
4. **Network rules**, one per line.
5. **Antennas tested** on the network.
6. **Relays in the area** heard in the last 7 days (Meshtastic ROUTER / REPEATER, MeshCore repeaters and room servers), with a link to the public map.
7. **Contact and donations**: your text and a button to your donation page.
8. A **QR code of the page itself**, for printing.

The **📡 Use the primary channel of the map’s node** button fills in the channel link (with the LoRa settings) from the node connected to the map. You can also paste a `https://meshtastic.org/e/#…` link copied from the Meshtastic app.

> ⚠️ The channel link contains the **channel key**: once the page is published, that key is public. That is the point for a welcome channel, but do not publish a private channel this way.

The page is visible only once **Page published** is ticked. The public map then shows an orange **🤝 Join the network** button.
