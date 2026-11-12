# The agent

A small program (Windows, Linux, Raspberry Pi) that links to the map:
- a node **plugged in over USB** on this PC;
- a **Wi-Fi node on another network** (another house);
- and, since version **1.6**, **any Wi-Fi node on its local network**, reached by its IP address from *Connect a node*.

## Installation
1. Download the agent from the map: `/agent/agent-gaulix-windows.exe` (or the Linux and Raspberry Pi versions).
2. Start it. It asks for the **server address** (port 4404, over the local network or Tailscale) and the **agents code** shown in the map (*Network › Radio nodes › Node via agent*).
3. Add your connections: USB port (`COM5`, `/dev/ttyACM0`) or a node's Wi-Fi address.

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
