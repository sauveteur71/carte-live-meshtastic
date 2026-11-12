# Live map Meshtastic / MeshCore

Real-time map, monitoring and **remote administration** of a [Meshtastic](https://meshtastic.org) and [MeshCore](https://meshcore.co.uk) network, regional or local. Born for a network in Haute-Loire (France), it can be installed for any area.

## Where to start
1. [[Installation]]: Docker, `.env`, setup wizard.
2. [[Connect the network|Brancher le réseau]]: MQTT broker, channels.
3. [[Connect a node|Connecter un module]]: Bluetooth, USB or IP address, and the [[agent|Agent Gaulix]].
4. Discover [[the map|La carte]].

## Using the map
- [[The map|La carte]]: nodes, links, layers, message route, replay.
- [[Messages]]: sending, acks, unread, sounds, alerts.
- [[Coverage and sites|Couverture et sites]]: IGN terrain, high points, coverage plan, “what if…” simulation.
- [[Topology and simulation|Topologie et simulation]]: link graph, breaking points, packet propagation.
- [[Traffic control|Contrôle du trafic]]: overly chatty nodes, MQTT re-injection.

## Administration
- [[Remote programming|Programmation à distance]]: Meshtastic settings over LoRa, targeted read, templates, favorites, firmware 2.8.
- [[Reports|Signalements]]: flooded road, fallen tree… placed on the map and sent over LoRa (Meshtastic waypoint compatible with Bipper / GerMaCrise, MeshCore message).
- [[Teams|Équipes]]: encrypted channel per team, added or removed remotely on responders' nodes, new key, command-line equivalent.
- [[MeshCore]]: companion, repeaters, traces, regions, MQTT republishing.
- [[Accounts and security|Comptes et sécurité]]: roles, area managers, two-factor authentication, log.
- [[PostgreSQL archive|Archive PostgreSQL]]: full history, retention, maximum size.
- [[Versions and compatibility|Versions et compatibilité]]: supported firmware, Meshtastic 2.8.

## Help
- [[Troubleshooting|Dépannage]]: the most common problems and their solution.
- [Latest version](https://github.com/sauveteur71/carte-live-meshtastic/releases/latest) · [Report a problem](https://github.com/sauveteur71/carte-live-meshtastic/issues)

---
*Live map created by F4GLD · [♥ Support the project](https://www.helloasso.com/associations/radioclub-du-velay/formulaires/2) (Radio-club du Velay)*
