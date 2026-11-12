# Remote programming (Meshtastic)

The map reads and changes node configuration **over LoRa**, with the encrypted administration (PKI) of firmware 2.5 and later.

## Preparing the nodes
On each node to administer, add the **public key of the map's node** in *Security › Admin key*. The key is shown in the *Program* tab. **🔑 Admin keys** shows, relay by relay, the authorised nodes and what remains to be done on site.

## Reading
- **Targeted read**: tick only what you want to check (role and rebroadcast, LoRa, channels, position, name, hardware, telemetry, neighbor info, security, traffic management). Each item is a radio request (10 to 60 s depending on distance).
- **Read all**: about fifteen requests. An interrupted read **resumes** where it stopped.

## Changing
- **Settings editor**: name, role, rebroadcast, LoRa, position, channels, telemetry, traffic management (2.8), signing policy (2.8.1). Sent in a single transaction, then read back to check.
- **Templates** (*📋 Templates*): high-point relay, gap-filler relay, rooftop base, mobile, fixed client, and your own templates; YAML export and import (`meshtastic --export-config`).
- **Favorites between relays** (*⭐*, firmware 2.7.11 and later): a packet relayed between favorite routers no longer uses a hop.
- **Role advisor** (*Statistics › Maintenance*) with the “Switch to…” button.
- **Compliance check**: compare all your nodes with a reference, also every night.
- Safeguards for the **primary channel**: refused if the frequency depends on its name (you would lose contact).

## Reliable sending
- Each request is sent **up to 3 times**, with a delay suited to the distance (≈ 50 s at 1 hop, 65 s at 2 hops). The last attempt goes out with one more hop.
- A **late** answer to a previous attempt is accepted.
- **Retry**: “Retry on failure” box in the forms, or **🔁 Retry for 2 h** button on a finished operation. Failed nodes are retried **every 10 min for 2 h**, useful for a mobile or a distant relay. Real refusals (key not authorised) are not retried.
- Each node shows the **time** of its success or failure.

## Understanding a failure
| Message | Cause |
|---|---|
| node's key missing from admin keys | the node **refused**: add the key on site |
| radio link too weak or node busy (it has already accepted this node) | a **radio** problem, not a key one: try again, retry or bring the node closer |
| node out of range, or key missing, or firmware < 2.5 | no answer, and the map can't tell why |
| no ack after re-transmissions | the message never reached the node |

## Firmware
- New version flagged; **Wi-Fi update** of ESP32 nodes (2.7.18 and later) reachable by IP.
- **🆕 Firmware 2.8**: renumbered nodes spotted by their public key (history merge), duplicate keys (cloned configurations), position and telemetry off by default on public channels, 2.8.0 withdrawn. Meshtastic advises staying on 2.7 on relays while 2.8 is in alpha.
