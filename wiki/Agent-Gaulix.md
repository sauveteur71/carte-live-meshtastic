# Agent Gaulix

Petit programme (Windows, Linux, Raspberry Pi) qui relie à la carte :
- un module **branché en USB** sur ce PC ;
- un module **Wi-Fi d'un autre réseau** (autre maison) ;
- et, depuis la version **1.6**, **n'importe quel module Wi-Fi de son réseau local**, joint par son adresse IP depuis *Connecter un module*.

## Agent prêt à l'emploi (1.7) : aucune question
1. Dans la carte, *Réseau › Modules › Module par agent* : **⬇️ Agent prêt à l'emploi** (Windows, Linux, Raspberry Pi). Le fichier téléchargé contient déjà l'adresse de la carte et le code secret. Téléchargez-le depuis l'adresse **Tailscale ou locale** de la carte (le port 4404 n'est jamais ouvert sur la box).
2. Lancez-le (sous Linux : `chmod +x` d'abord). Sous Windows, il s'installe tout seul au démarrage ; Windows peut prévenir que le programme n'est pas signé (« Informations complémentaires » › « Exécuter quand même »).
3. **Branchez un module en USB** : Meshtastic ou companion MeshCore, il est reconnu et relié tout de suite à la carte. Débranché, il est libéré et la carte revient au module d'avant ; le suivant branché prend sa place.

Seules les puces USB des modules LoRa courants sont interrogées (CP210x, CH340, FTDI, ESP32-S3, nRF52, RP2040…) : rien n'est envoyé à une imprimante 3D ou à un Arduino. Options : `-ecoute` (modules en écoute plutôt que principaux), `-tous-ports` (interroger tous les ports USB-série), `-sans-detection`.

## Installation classique (questions au premier lancement)
1. Téléchargez l'agent depuis la carte : `/agent/agent-gaulix-windows.exe` (ou les versions Linux et Raspberry Pi).
2. Lancez-le. Il demande l'**adresse du serveur** (port 4404, par le réseau local ou Tailscale) et le **code des agents** affiché dans la carte (*Réseau › Modules radio › Module par agent*).
3. Les modules USB sont ensuite reconnus en les branchant ; `-configurer` permet d'ajouter un module Wi-Fi d'un autre réseau.

Sous Windows, il propose de se lancer tout seul à l'ouverture de session.

## Plusieurs modules
L'agent garde autant de connexions que vous voulez (*USB*, *Maison*, *QRA*…). Chacune n'apparaît dans la carte **que lorsque son module est présent** : port USB branché, ou module Wi-Fi sur le même réseau que le PC.

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
