# Agent Gaulix

Petit programme (Windows, Linux, Raspberry Pi) qui relie à la carte :
- un module **branché en USB** sur ce PC ;
- un module **Wi-Fi d'un autre réseau** (autre maison) ;
- et, depuis la version **1.6**, **n'importe quel module Wi-Fi de son réseau local**, joint par son adresse IP depuis *Connecter un module*.

## Installation
1. Téléchargez l'agent depuis la carte : `/agent/agent-gaulix-windows.exe` (ou les versions Linux et Raspberry Pi).
2. Lancez-le. Il demande l'**adresse du serveur** (port 4404, par le réseau local ou Tailscale) et le **code des agents** affiché dans la carte (*Réseau › Modules radio › Module par agent*).
3. Ajoutez vos connexions : port USB (`COM5`, `/dev/ttyACM0`) ou adresse Wi-Fi d'un module.

Sous Windows, il propose de se lancer tout seul à l'ouverture de session.

## Plusieurs modules
L'agent garde autant de connexions que vous voulez (*USB*, *Le Monteil*, *QRA*…). Chacune n'apparaît dans la carte **que lorsque son module est présent** : port USB branché, ou module Wi-Fi sur le même réseau que le PC.

Options : `-configurer` (ajouter `a`, modifier `m 2`, retirer `r 2`, serveur et code `s`), `-ajouter`, `-liste`, `-demarrage-auto`, `-sans-demarrage-auto`.

Un module Wi-Fi joint par un VPN ou un routeur (pas sur le réseau local du PC) : ajoutez `"toujours": true` à sa connexion dans `agent-gaulix.json`.

## Relais du réseau local (1.6)
L'agent ouvre en plus une session « *nom du PC* · réseau local ». Quand vous tapez une adresse IP dans *Connecter un module* et que le serveur ne voit pas ce réseau, la carte demande à cet agent de **sonder** l'adresse (ports 4403 et 5000), puis de **relayer** la liaison.

Sécurité : l'agent n'accepte que les **adresses privées des réseaux auxquels le PC est branché**, et seulement ces deux ports.

## Mise à jour
Téléchargez la nouvelle version depuis la carte et remplacez l'ancien fichier : les réglages (`agent-gaulix.json`) sont conservés.

## Linux / Raspberry Pi en service
```ini
[Unit]
Description=Agent carte live Meshtastic
After=network-online.target
[Service]
ExecStart=/opt/agent-gaulix/agent-gaulix-raspberrypi-arm64 -config /opt/agent-gaulix/agent-gaulix.json
Restart=always
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now agent-gaulix`, après avoir configuré l'agent une fois à la main.

> 🔒 Le port 4404 ne doit jamais être ouvert sur Internet : réseau local ou VPN uniquement.
