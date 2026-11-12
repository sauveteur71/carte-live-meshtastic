# Topology and simulation

*Tools › 🕸️ Topology and simulation* (Meshtastic) and *MeshCore topology and simulation*.

## Analysis
- Graph of **measured** links: free, ring or geographic layout; relays only or all nodes.
- **Breaking points**: relays whose failure would cut nodes off from any gateway.
- **Critical links**, **most traversed relays**, distance to gateways against the hop limit, islands, nodes without position.

## Simulating a packet
- **Meshtastic**, following firmware 2.7 logic: SNR-based wait, ROUTER priority, cancellation by CLIENTs, ROUTER_LATE, free hops between favorites, listen before talk, collisions.
- **MeshCore**, following repeater firmware logic: random delay based on `tx_delay_factor`, `flood.max`, collisions.
- Animated, or over 200 draws, to compare preset, hop limit, favorites and roles: share of nodes reached, number of transmissions, duration.

## Live traffic
Real packets are animated on the graph (sender → relay → gateway), with the most used paths and the latest packets feed.
