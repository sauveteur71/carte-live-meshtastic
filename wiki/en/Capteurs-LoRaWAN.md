# LoRaWAN sensors

**Optional** layer showing on the map the LoRaWAN sensors of a **The Things Network (v3)** or **ChirpStack (v4)** application: latest readings, 24 h curve, gateways that received them and signal quality. The map **subscribes read-only** to the application's MQTT: it sends nothing to the sensors.

LoRaWAN and Meshtastic use the same LoRa modulation but do not talk to each other: a LoRaWAN sensor goes through a gateway and a network server (TTN, ChirpStack), not through the mesh. This layer brings both onto the same map, for example a river level probe, a weather station or a rain gauge next to the Meshtastic relays.

## Without hardware?

You need at least **a TTN application receiving sensors**. A TTN account and application are free, but without a sensor there is nothing to show. To see river levels without hardware, use the [[Rivers|Rivières-et-alerte-crue]] layer instead.

## Getting started (The Things Network)

1. In the TTN console, open the application › **Integrations › MQTT**: note the username (`my-app@ttn`).
2. **API keys** › add a key with the **“Read application traffic”** right only. Copy the key (`NNSXS.…`), it is shown only once.
3. In the map: **Advanced settings › LoRaWAN (sensors)**:
   - *Show the LoRaWAN sensors*: yes;
   - *MQTT server*: `mqtts://eu1.cloud.thethings.network:8883` (default);
   - *MQTT username*: `my-app@ttn`;
   - *API key*: the key you created (stored as a secret, never shown again).
4. Sensors appear at their next uplink (**LoRaWAN sensors** button on the map).

Readings come from the application's **payload formatter**: without it, the popup says “No decoded reading”.

## ChirpStack

MQTT server: the address of ChirpStack's broker (e.g. `mqtt://192.168.0.10:1883`), with its username and password. Topics `application/+/device/+/event/up` are listened to by default. Readings come from the application codec.

## Sensor position

A sensor sending `latitude`/`longitude` in its readings, or whose position is set in TTN, is placed automatically. For the others, setting *Position of fixed sensors*:

```
level-post=45.04;3.88 | weather-mezenc=44.92;4.19
```

## Alerts

Setting *Alert thresholds*: `sensor.reading > value` or `< value`, separated by semicolons. Without a sensor name, the threshold applies to all.

```
level-post.height > 150 ; battery < 3.3
```

An alert shows in the map (and in Home Assistant / Prometheus if connected) while the latest reading, less than 6 h old, crosses the threshold. An “MQTT server unreachable” alert shows after 30 min of outage.

## Who sees the layer

By default, **signed-in members only**. Setting *Show sensors to visitors*: yes to open it to everyone.
