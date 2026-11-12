# Connect a node

A **radio node** linked to the map lets it capture traffic directly, send messages and **program nodes remotely**. Everything is done from **Tools › 🔌 Connect a node…**. The map detects by itself whether it is a **Meshtastic** node or a **MeshCore** companion.

## Bluetooth
1. Open the map over **HTTPS** in **Chrome or Edge** (not Firefox or Safari).
2. **📶 Bluetooth** button, then choose the node.
3. Windows may ask for a **PIN code**: the one shown by the node, otherwise `123456`.

Keep the tab open: the page relays the node to the map.

Usual pitfalls:
- **The phone app must be disconnected**: a node only accepts one Bluetooth link at a time.
- **Meshtastic on ESP32** (Heltec, T-Beam…): Bluetooth is off while Wi-Fi is on. Use the IP address, or turn Wi-Fi off.
- In the ROUTER role, power saving may put Bluetooth to sleep (*Config › Power*).
- If the connection fails, first pair the node in the Windows Bluetooth settings.

### Bluetooth dropouts
If the link drops, the page **reconnects by itself**: every 5 s for 30 s, then every 30 s for 15 min. Nothing to do, but the tab must stay open. “Unplug” stops these attempts.

To limit dropouts:
- close the MeshCore or Meshtastic phone app: as soon as it sees the node free, it takes it back;
- on Windows, in Device Manager › Bluetooth › your adapter › Power Management, untick “Allow the computer to turn off this device”;
- prevent the PC from sleeping during use;
- bring the node closer: a PC's Bluetooth has little range and 2.4 GHz Wi-Fi interferes with it;
- for a fixed Wi-Fi node, prefer the **IP address**: the link is permanent and doesn't depend on an open tab.

## USB
**🔌 USB** button, then choose the port. First close anything already using it (app, agent, other tab). Same conditions: HTTPS, Chrome or Edge.

## Server USB (node plugged into the NAS or Raspberry Pi)
The node (Meshtastic or MeshCore USB companion) is plugged **into the machine running the map**, as with Remote Terminal for MeshCore or MeshMonitor. No browser or agent: the link is permanent and resumes by itself after a restart.

1. On the machine, find the port: `ls /dev/ttyACM* /dev/ttyUSB*` (or `ls /dev/serial/by-id/`, stable name recommended).
2. In `docker-compose.yml`, uncomment and adapt:
   ```yaml
       devices: ["/dev/ttyACM0:/dev/ttyACM0"]
       group_add: ["dialout"]
   ```
   These two lines go in the `carte-live` service, at the same indentation as `mem_limit` (not under `volumes:`).
   then `docker compose up -d`.
3. *Tools › Connect a node › 🖥️ Server USB*: the map lists the ports it sees, detects the node type and links it as **main** or **listening**.

The port is set to 115,200 baud. Close any other program that would use the same port on the machine.

## IP address (node on Wi-Fi)
Type the address, for example `192.168.1.122`, then **Connect**. The map looks for:
- a **Meshtastic** node on port **4403**;
- a **MeshCore** companion on port **5000**.

Two cases:
1. **The map's server can see this network**: the link is direct.
2. **The node is on another network** (another house, another router): the map automatically goes through a PC on that network running the **[[agent|Agent Gaulix]] 1.6 or later**. Nothing to configure on the agent.

If neither is possible, the map explains it and suggests Bluetooth, USB or installing the agent.

## Several nodes at the same time
For each network, Meshtastic and MeshCore, the map has **one main node**. It listens, sends messages, starts traceroutes and is used for administration.

Other nodes can be linked as **listening**, in addition to the main one. Each one becomes an extra gateway:
- what it hears is added to the map with its own SNR and hop count;
- links and message routes are therefore seen from several points;
- a packet heard by several nodes counts as a single packet, with several receptions, as for MQTT gateways.

How to add one:
- **Connect a node**: choose “👂 listening, in addition” before clicking Bluetooth, USB or Connect (IP address). If a main node is already linked, this choice is offered straight away.
- **Network › Radio nodes**: **👂 Listening** button on a known node.
- **MeshCore › Companion**: **👂** button next to an agent, or **👂 Listening** next to the Wi-Fi address.

Then:
- **⭐ Main** swaps the roles: the listening node becomes main, the old main switches to listening.
- **Stop listening** removes it.
- Listening nodes by IP address or by agent are kept when the map restarts. Those of a page (Bluetooth, USB) last as long as the tab is open.

Limits:
- From a single page, only one Bluetooth or USB node per network. The others are linked by IP address or by agent.
- A PC acting as a local network relay ([[agent|Agent Gaulix]] 1.6) only relays one node at a time.

Example: the home node stays main, the companion at another house listens through its IP address, and the car's node listens over Bluetooth during a trip.

## One client at a time
A Meshtastic node only accepts one Wi-Fi client, and a MeshCore companion only one client. If the phone app connects to the same node, the map is “kicked out” and tries again later.

## Which node to use for programming?
The map's node must **hear the nodes to program well**. A badly placed node (hearing the network around −15 dB) will make many requests fail. For an intervention, the most effective is to link a node **close to the target**: in the car over Bluetooth, for example.
