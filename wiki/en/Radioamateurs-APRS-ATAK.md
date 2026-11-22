# Amateur radio, APRS, ATAK and relay register

## APRS stations (including LoRa APRS)
The **APRS stations** layer (Layers menu) shows the APRS stations in the area: **LoRa APRS** trackers, iGates and digipeaters (433.775 MHz) in purple, other APRS stations (VHF 144.800 MHz, internet) in blue. A click gives the callsign, comment, altitude, the iGate that relayed it and a link to aprs.fi.

To enable in *Advanced settings › APRS (amateur radio)*:
- **Show APRS stations in the area**: yes.
- **Callsign**: yours, **required** (the layer does not start without it).
- **Server**: `rotate.aprs2.net:14580` by default.
- **Keep only LoRa APRS stations**: your choice.

The map connects to the worldwide **APRS-IS network read-only** (`pass -1`): it transmits nothing and needs no passcode. It only asks for the map area. Mic-E positions (Kenwood, Yaesu… handhelds and mobiles) are read; positions in messages and telemetry are not. If you change department, the area followed is updated within 10 minutes.

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

### Finding a relay
The **Search** field at the top of the register filters the list as you type, ignoring accents and case: node name, identifier, site, owner, contact, notes, permission, department. The counter and the indicators (“without written permission”, “not visited for over a year”) always cover what is shown, and so does the CSV export.

The **Department** list files relays by the position they broadcast. A relay that does not give its position, or that is outside France, appears under “No department”.

Clicking a row opens the relay's page; **closing that page brings you back to the register**, with the same search and the same department. A page opened from the map or from the search closes as before.

### Ticking several relays at once
For the relays you manage, a tick box appears in front of each row. Tick several of them: a bar opens with the number of relays ticked and the **Site permission** list (“Not needed (own land)” by default). **Apply to the ticked relays** asks for confirmation, stating how many relays are involved, then writes the same permission into each page — the rest of each page is kept.

Each relay is saved separately, with the same checks as the whole page: a sector manager can only touch their own relays, and every change leaves its line in the audit log. If a relay is refused, the report says so (“✗ 1 relay not changed”), the relay stays ticked and its page is unchanged.

Relays that are ticked but hidden by the search are never changed: the confirmation says so.

### Suggested dates
On the installation page, the three date fields (commissioning, permission date, last on-site visit) **suggest today's date** as soon as you enter an empty field — it is almost always right for a visit. The suggestion is flagged under the field: keep it, change it, or clear the field (it does not come back). Nothing is saved until **Save the page** is used; a suggested date kept as is is named in the confirmation message. A date already filled in is never overwritten.

This information is entered on the node's sheet, **Installation** section › *Site*. See also [[Coverage and sites|Couverture-et-sites]]: a high point is not an authorised site.

## Nodes of a department (search by position)
*Tools › 🗂️ Relay register* only shows relays. To get **the list of every node in a department**, type the department number or name in the map's search bar (“43”, “dep 43”, “Haute-Loire”): the first suggestion is **Nodes of department 43**, with the number of nodes. The same screen opens from *Search for a feature* › “Nodes of a department (by position)”.

Filing is based on the **position each node broadcast**, not on its name: the point-in-polygon test uses the official department boundaries and runs on the server (the browser never downloads the boundary file). The result is kept for one minute.

Worth knowing:
- a node that has never sent a position cannot be filed anywhere: it is counted separately, under “No position received”;
- a node positioned outside France appears under “Position known, outside France” (departments only exist in France: on the world edition, nothing is guessed for the rest of the planet);
- a blurred or imprecise position (Meshtastic 2.8 firmware) can file a node close to a boundary under the neighbouring department; the screen says so.

The list can also be filtered by name, identifier or role, and exported as CSV. Clicking a node opens its page; closing it brings you back to the list.
