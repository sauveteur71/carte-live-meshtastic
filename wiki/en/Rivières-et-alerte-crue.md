# Rivers and flood alerts

The **Rivers** layer (Layers menu) shows the public gauging stations in the area: water height, flow and trend, updated every 10 minutes. The data comes from the public **Hub'Eau** API (eaufrance), the same measurements as Vigicrues (France). Free, no account and no hardware.

![Rivers layer](images/apercu/en/18-rivieres.jpg)

## Enable
*Advanced settings › Rivers (Hub'Eau)*:
- **Show river levels in the area**: yes.
- **Fast rise alert**: 20 cm per hour by default (“warning”); twice that gives a “critical” alert.
- **Height thresholds per station**: e.g. `K0010020=2.5 ; K0114020=3` (site or station code = height in metres). The code is shown on the station page.

## On the map
- Each station shows its height and a trend arrow (↗ rising, ↘ falling), and turns orange or red when an alert is active.
- A click opens the station: height, trend, flow, last 24 hours curve (with the threshold if set), links to Vigicrues and the official station page.
- Alerts appear with the map's other alerts (dashboard, Home Assistant, Prometheus).

## Limits
- Hub'Eau covers France only.
- Stations publish every 5 to 60 minutes: a very sudden rise may appear with some delay.
- The map does not replace official flood warnings: always follow Vigicrues and the authorities.
