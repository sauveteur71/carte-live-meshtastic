# Connect the network

## The MQTT broker
The map subscribes to `MQTT_RACINE/#` (default `msh/EU_868`) and, for MeshCore, to `meshcore/#`.
- The Meshtastic gateways of your network must publish to this broker (*MQTT module* on, channel with “uplink to MQTT”).
- The map's MQTT account must be able to **read** `msh/#` and **read and write** `meshcore/#`.
- An example Mosquitto broker (TLS, accounts, permissions) is provided in the repository's `mosquitto/` folder.

## Meshtastic channels
To read positions, messages and telemetry, the map must know each channel's key: *Manage › Settings*, or `CANAUX` in `.env`.
- Format: `ChannelName=base64Key`, separated by `;`.
- `AQ==` is the default public key (LongFast channel…).
- Private channel keys are found in the Meshtastic app (channel › share) or in the channel's QR code.

Packets encrypted with an unknown key show as “encrypted”: you see them go by, but not their content.

## What are protobufs?
Meshtastic writes all its messages (positions, telemetry, messages, configuration…) in the binary **Protocol Buffers** format. The [meshtastic/protobufs](https://github.com/meshtastic/protobufs) repository describes it. The map already embeds them and keeps them up to date: **there is nothing to install**. The MQTT module's “JSON” option is not needed (and it is incomplete).

## The map's radio node
Optional to look at the map, **essential to program nodes remotely** and to send messages. See [[Connect a node|Connecter un module]].

## MeshCore channels
See [[MeshCore]]: `Public`, `#name` for a hashtag channel (the exact name is enough), `Name=secret` for a private channel.
