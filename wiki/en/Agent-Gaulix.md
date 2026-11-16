# The agent

A small program (Windows, Linux, Raspberry Pi) that links to the map:
- a node **plugged in over USB** on this PC;
- a **Wi-Fi node on another network** (another house);
- and, since version **1.6**, **any Wi-Fi node on its local network**, reached by its IP address from *Connect a node*.

## Ready-to-use agent (1.7): no questions
1. In the map, *Network › Nodes › Node via agent*: **⬇️ Ready-to-use agent** (Windows, Linux, Raspberry Pi). The downloaded file already contains the map’s address and the secret code. Download it from the map’s **Tailscale or local** address (port 4404 is never opened on the internet router).
2. Start it (on Linux: `chmod +x` first). On Windows, it installs itself at startup; Windows may warn that the program is not signed (“More info” › “Run anyway”).
3. **Plug in a node over USB**: Meshtastic or MeshCore companion, it is recognised and connected to the map right away. Unplugged, it is released and the map goes back to the previous node; the next one plugged in takes its place.

Only the USB chips of common LoRa nodes are queried (CP210x, CH340, FTDI, ESP32-S3, nRF52, RP2040…): nothing is sent to a 3D printer or an Arduino. Options: `-ecoute` (nodes listening rather than main), `-tous-ports` (query all USB serial ports), `-sans-detection`.

## Classic installation (questions at first launch)
1. Download the agent from the map: `/agent/agent-gaulix-windows.exe` (or the Linux and Raspberry Pi versions).
2. Start it. It asks for the **server address** (port 4404, over the local network or Tailscale) and the **agents code** shown in the map (*Network › Radio nodes › Node via agent*).
3. USB nodes are then recognised by plugging them in; `-configurer` adds a Wi-Fi node from another network.

On Windows, it offers to start by itself at login.

## Several nodes
The agent keeps as many connections as you want (*USB*, *Home*, *Shack*…). Each one only appears in the map **when its node is present**: USB port plugged in, or Wi-Fi node on the same network as the PC.

Options: `-configurer` (add `a`, edit `m 2`, remove `r 2`, server and code `s`), `-ajouter`, `-liste`, `-demarrage-auto`, `-sans-demarrage-auto`.

A Wi-Fi node reached through a VPN or a router (not on the PC's local network): add `"toujours": true` to its connection in `agent-gaulix.json`.

## Local network relay (1.6)
The agent also opens a “*PC name* · local network” session. When you type an IP address in *Connect a node* and the server can't see that network, the map asks this agent to **probe** the address (ports 4403 and 5000), then to **relay** the link.

Security: the agent only accepts **private addresses of the networks the PC is connected to**, and only these two ports.

## Update
Download the new version from the map and replace the old file: settings (`agent-gaulix.json`) are kept.

## Linux / Raspberry Pi as a service
```ini
[Unit]
Description=Live map agent Meshtastic
After=network-online.target
[Service]
ExecStart=/opt/agent-gaulix/agent-gaulix-raspberrypi-arm64 -config /opt/agent-gaulix/agent-gaulix.json
Restart=always
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now agent-gaulix`, after configuring the agent once by hand.

> 🔒 Port 4404 must never be open to the internet: local network or VPN only.
