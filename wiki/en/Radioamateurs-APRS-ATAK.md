# Amateur radio, APRS, ATAK and relay register

## APRS stations (including LoRa APRS)
The **APRS stations** layer (Layers menu) shows the APRS stations in the area: **LoRa APRS** trackers, iGates and digipeaters (433.775 MHz) in purple, other APRS stations (VHF 144.800 MHz, internet) in blue. A click gives the callsign, comment, altitude, the iGate that relayed it and a link to aprs.fi.

To enable in *Advanced settings › APRS (amateur radio)*:
- **Show APRS stations in the area**: yes.
- **Callsign**: yours (N0CALL by default).
- **Server**: `rotate.aprs2.net:14580` by default.
- **Keep only LoRa APRS stations**: your choice.

The map connects to the worldwide **APRS-IS network read-only** (`pass -1`): it transmits nothing and needs no passcode. It only asks for the map area. Positions in messages, telemetry and the Mic-E format are not read yet.

## Nodes in licensed mode
A Meshtastic node set to **licensed mode** (amateur radio) shows the **📻 Amateur radio** badge on its sheet. In licensed mode, messages are **not encrypted** (encryption is forbidden on amateur bands) and the node identifies with its callsign: it cannot read the network's encrypted channels.

Reminder: in Europe **868 MHz is not an amateur band**. Amateur LoRa uses 70 cm (433.775 MHz for LoRa APRS) or 13 cm (2.4 GHz), following the IARU band plan and your licence.

## Export for ATAK
*Exports* (Embed / export window):
- **Network for ATAK and Google Earth (KML)**: relays and gateways, other active nodes, radio links of the last 24 h coloured by SNR. In ATAK: *Import Manager › Local SD* (or send the file to the phone).
- **Live network (KML link)**: a small file that reloads the network every minute. The device must be able to reach the map (same local network, or Tailscale).

The same privacy rules as the public map apply (private positions rounded, no messages). If an export token is set, add `?jeton=…` to the address.

## Cable loss calculator
On a relay's **installation sheet** and in **Profile and link budget**, the **🧮 Calculate** button next to the cable losses gives the loss from the **cable type** (RG58, RG213, LMR-400, Aircell 7, Ecoflex…), the **length**, the **number of connectors** and an optional **lightning arrester**. "Use" copies the value into the field; it is then used by coverage, planning and Link.

Typical values around 870 MHz; check the cable datasheet. A short, thick cable often beats a higher-gain antenna.

## Relay register
*Tools › 🗂️ Relay register* gathers, for each relay and gateway:
- the **site**, the **permission** (written agreement, signed agreement, verbal agreement, request pending, none, not needed) and its date;
- any **protected area** (surroundings of a historic monument, listed site, coastline, Natura 2000, park or reserve);
- the **last on-site visit** (orange after 6 months, red after a year);
- **power** (supply, battery, panel), **firmware** and last packet heard.

Relays without a written permission and those not visited for over a year are counted at the top. **Export the register (CSV)** opens it in a spreadsheet; the site owner and the contact are included only for an administrator.

This information is entered on the node's sheet, **Installation** section › *Site*. See also [[Coverage and sites|Couverture-et-sites]]: a high point is not an authorised site.
