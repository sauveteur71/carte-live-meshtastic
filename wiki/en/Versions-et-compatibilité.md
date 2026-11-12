# Versions and compatibility

The map follows the **stable versions** of the firmware. Test versions (alpha) are decoded as soon as possible, but are not recommended on a network in service.

## Meshtastic
- **Recommended: the latest stable 2.7** (2.7.26 in November 2026). Firmware 2.5 at least for encrypted remote administration (admin keys, teams); 2.7.11 at least for **favorites between relays** (free hops, “Zero-Cost Hops”).
- **2.8 series (alpha, in test)**: the map already recognises it.
  - **Signed packets**: when the gateway receiving a packet has verified the sender's signature, the packet carries the **✍ signed** badge in the traffic list and in its details.
  - **Position private by default**: a node moved to 2.8 without setting its position may no longer appear in its place on the map. This is not a map failure: the position must be made public on the node (primary channel, position precision).
  - **New presets** known to the map (names, range and airtime computations): MediumTurbo (outside the EU_868 band), *Lite* presets of the EU_866 region and *Narrow* (62.5 kHz) of the **EU_N_868** region. NarrowSlow and NarrowFast are offered in the coverage study.
  - *Manage › Firmware* lists relays already on 2.8 separately, and only suggests the latest **stable** version by default.
  - 2.8.0 was withdrawn by Meshtastic (signing bug): don't install it, move to 2.8.1 or later if you are testing the 2.8 series.
- The map's message definitions (protobufs) are aligned with Meshtastic's of November 2026: new fields are read, old firmware is still understood.

## MeshCore
- The map reads MeshCore's radio protocol and companion protocol (repeaters, room servers, sensors) and follows stable **1.x** firmware. Versions 1.16 to 1.18 (flood control in Europe, new listen before talk, JSON configuration, sensor nodes) don't change what the map uses. They have not yet been tried one by one with the map's remote administration: if something differs, the operation log shows the repeater's answer.
- French setting kept: 869.618 MHz, 62.5 kHz, SF8, CR8 (coverage study: “MeshCore France”).

## Followed, not used yet
- TAK integration (ATAK / iTAK) of the Meshtastic iOS app.
- pyMC (MeshCore in Python on Linux), KISS modem, “Companion Repeat” mode.
- BaseUI on-device interface for nodes with a screen.

They will be taken into account when they are stable and useful to the map.
