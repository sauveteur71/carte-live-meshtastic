# Traffic control

*Tools › 🚦 Traffic control* or *Program › 🚦*. Used to spot what clutters the radio channel.

## Overly chatty nodes
Median intervals measured over 6, 24 or 72 h, compared with these thresholds:

| Packet | Recommended threshold |
|---|---|
| Position of a relay or fixed point | ≥ 4 h |
| Position of another node | ≥ 5 min |
| Telemetry | ≥ 30 min |
| Node info (NodeInfo) | ≥ 1 h |

- **Heard over radio in the area**: the too-frequent packet type is received by another gateway in the area, so it really goes over the radio channel.
- **Off radio**: only received by the broker (other areas). They load the map, not your channel.
- The “local” telemetry a gateway publishes every 60 s to its app doesn't go over radio: it is not counted.

**Fix ticked nodes** (nodes the map can program): position every 12 h for a relay (fixed position, no “smart position”), 15 min for a mobile; telemetry 30 min; node info 3 h. For the others, notify their owner.

## MQTT → radio re-injection
Packets from the internet (“via MQTT” flag) then transmitted over radio by a gateway whose channel has **MQTT downlink** on, with the gateway re-injecting them. To do on these gateways: turn off downlink on the public channel, or only keep it on a private channel.

## “Ignore MQTT” on relays
Firmware LoRa setting: the node no longer relays packets that arrived via MQTT. Recommended on ROUTER and ROUTER_LATE; a button enables it on all programmable relays.

## In the Network panel
The **Overly chatty nodes** section (Network tab, for managers) gives the live list over 24 h: the node, its role, what it sends too often and the number of packets per day. Clicking a node opens its sheet; the button at the bottom opens the full control, with remote fixing. The list is recomputed every quarter of an hour.
