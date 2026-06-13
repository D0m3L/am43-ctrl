# Fork — modified am43-ctrl v1.1

## My setup

This fork is used in production on a **Raspberry Pi 4** (64-bit OS, `aarch64`) with **two AM43 blind motors** controlled over MQTT and HTTP:

| Label | MAC | Role |
|-------|-----|------|
| **lewa** | `02:73:f4:0a:2a:a1` (`0273f40a2aa1`) | Left blind |
| **prawa** | `02:51:eb:6e:37:ca` (`0251eb6e37ca`) | Right blind |

Both motors are about **10–15 meters (and two walls in betwenn)** from the Pi’s Bluetooth adapter. The controller runs in Docker on the Pi (see below) or natively; MQTT publishes to Home Assistant, HTTP API on port 5001.

### Why this fork exists (problem in upstream code)

With two devices sharing one BLE adapter, upstream [binsentsu/am43-ctrl](https://github.com/binsentsu/am43-ctrl) uses a static `busyDevice` lock so only one motor connects at a time. That works until **noble drops the link without firing a `disconnect` event** — which happened regularly here, especially on the weaker motor.

Symptoms with the original driver:

- One motor finished `Reading data completed` but never logged `disconnected for data reading` / `Reading data was successful`
- `busyDevice` stayed set on the stalled device
- The other motor logged `Connection busy for other device …, delaying data read…` indefinitely — the app looked **hung**
- Interval polls failed while startup reads sometimes still worked

**v1.1** adds `tryClearStaleBusy`, unified session teardown (`finishReadSession`), and a 3 s missing-disconnect fallback so the lock is cleared and both blinds recover.

### RF environment (RSSI)

At 10–15 meters (and two walls in betwenn), devices with the **factory BLE antenna inside the motor housing**, RSSI was around **~ -81 dBm to -85 dBm** — very weak and unstable. Connects often dropped within ~30 ms before GATT discovery; interval polls failed reliably.

**Hardware fix:** routing the BLE antenna **outside** the motor housing improved signal to **~ -77 dBm** in btmon (`LE Advertising Report`). That is still on the edge for BLE, but with **v1.1** both motors poll reliably (startup + 10–20 min intervals).

---

This repository is a fork of [binsentsu/am43-ctrl](https://github.com/binsentsu/am43-ctrl). **All original credit goes to [binsentsu](https://github.com/binsentsu) and the upstream project.** This fork keeps the same purpose: controlling AM43 blind motors over MQTT and/or HTTP.

**Notice:** Parts of this fork were modified with assistance from AI. Review the changes before production use.

## What changed in v1.1 (vs upstream)

Changes are documented in the file headers of `index.js` and `src/am43.js`. Summary:

**`src/am43.js` (BLE driver)**
- Multi-device stability when noble drops a link without firing `disconnect` (`tryClearStaleBusy`, `finishReadSession`, 3s missing-disconnect fallback)
- Unique poll interval per device (random 10–20 min, or `--interval` with 60s stagger); no shared timer collision
- Position remap 99→100 and 1→0 for Home Assistant alignment
- Shorter post-command read timing (`fullMovingTime` 15s vs upstream 137s)
- Driver version and friendly device tags in logs

**`index.js` (entrypoint)**
- Version logging at startup; noble warnings on both debug channels
- Heartbeat shows device tag for last successful device
- Less log noise during scan; duplicate discover events ignored

Upstream usage, MQTT topics, and HTTP API behaviour are unchanged — see the original README below.

---

## Docker on Raspberry Pi 4

This fork includes a Docker setup tested on **Raspberry Pi 4** with a 64-bit OS (`Linux pi4 6.1.21-v8+ … aarch64`). The image is built for **`linux/arm/v7`** (32-bit ARM). On Pi 4, Docker runs it via the `--platform linux/arm/v7` flag (see `create-docker-container.sh`).

### `Dockerfile` overview

| Item | Detail |
|------|--------|
| Base image | `node:14.15.1-alpine` (`linux/arm/v7`) |
| BLE stack | `@abandonware/noble@1.9.2-14`, `@abandonware/bluetooth-hci-socket@0.5.3-7` (pinned) |
| Build deps | `eudev-dev`, `libusb-dev`, `python3`, `make`, `g++` (native module compile) |
| Runtime | `am43ctrl` with MQTT (`--url`), HTTP API (`-l`), debug (`-d`), fail timeout (`-f`) |

**Environment variables** (defaults in `Dockerfile`, override at `docker run`):

| Variable | Purpose |
|----------|---------|
| `MAC1`, `MAC2` | BLE MAC addresses of blinds |
| `URL` | MQTT broker URL (`mqtt://…`) |
| `PORT` | HTTP API port (`-l`) |
| `TIMEO` | `-f` fail timeout (seconds since last successful read before exit) |
| `MQTTUSER`, `MQTTPWD` | MQTT credentials (defined in Dockerfile; add `-u`/`-p` to ENTRYPOINT if needed) |

**Important:** The current `Dockerfile` runs `npm install https://github.com/binsentsu/am43-ctrl`, which installs **upstream** code. To run **this fork (v1.1)**, build from a Dockerfile that copies this repository into the image (e.g. `COPY . /app/rolety/` and `npm install --legacy-peer-deps`) instead of installing from GitHub.

BLE inside Docker requires host networking and elevated privileges — the container must see the Pi’s Bluetooth adapter.

### Build and run

From this repository root:

```bash
# 1. Build the image (adjust Dockerfile first if you want v1.1 local code, not upstream npm)
docker build --platform linux/arm/v7 -t rolety:latest .

# 2. Create/start the container (edit MACs, broker URL, ports in the script first)
chmod +x create-docker-container.sh
./create-docker-container.sh
```

### `create-docker-container.sh`

Helper script that runs the container with settings suited to Pi BLE + MQTT:

- `--net=host` — host network (MQTT and BLE HCI)
- `--privileged`, `--cap-add NET_ADMIN`, `--cap-add NET_RAW` — Bluetooth access
- `-v /var/run/dbus:/var/run/dbus` — D-Bus for BlueZ
- `--restart=unless-stopped` — auto-restart on reboot
- `-e DEBUG="am43:*"` — verbose driver logging
- `-e MAC1`, `MAC2`, `URL`, `PORT`, `TIMEO` — override Dockerfile defaults

Edit the script before running (MAC addresses, MQTT broker IP, `TIMEO`, etc.). To recreate after changes:

```bash
docker stop rolety && docker rm rolety
./create-docker-container.sh
```

Logs: `docker logs -f rolety`

---

# Original README (upstream — unchanged)

# AM43 Blinds Drive Controller Util
Util for controlling a am43 Cover, either over MQTT or via a HTTP API. When used over MQTT it works together with home-assistant and performs auto disovery configuration of the cover component.
(Eg. https://nl.aliexpress.com/item/4000106179323.html)
This util should work with all blind drives which make use of the Blind Engine App. (A-OK, Zemismart,...)

# Hardware Installation
Install the blinds and configure top and bottom positions through the BlindsEngine App.
Retrieve the MacAddress of the device (for example by using nRF Connect app for android)

# Installation
Run `npm install https://github.com/binsentsu/am43-ctrl`

For making the application persistent across device reboots a possibility is to use pm2:
https://www.npmjs.com/package/pm2

Or by using native systemd:

- create file am43ctrl.service in /etc/systemd/system :
```
[Unit]
Description=AM43-ctrl
After=multi-user.target

[Service]
ExecStart=/AM43DIRECTORY/node_modules/.bin/am43ctrl MAC1 MAC12 -l 3001 -d --url mqtt://BROKERIP -u BROKERUSER -p BROKERPASS -d
Restart=always
User=root
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=/AM43DIRECTORY

[Install]
WantedBy=multi-user.target
```
Then use following commands to persist:

```
sudo systemctl daemon-reload
sudo systemctl enable am43ctrl
sudo systemctl start am43ctrl
```

You can obtain logging through:
`sudo journalctl -u am43ctrl.service`

# Usage
`sudo am43ctrl` by itself will print usage information

You need to manually specify a list of MAC addresses to connect to, e.g.: `sudo am43ctrl f5:11:7b:ee:f3:43`


You must then specify options to use either MQTT, HTTP or both

## To use with HTTP
Specify a port for the API to listen on with `-l`:
`sudo am43ctrl MACx MACy -l 3000`

## To use with MQTT
Specify a broker URL with `--url` option:
`sudo am43ctrl --url mqtt://yourbroker` (mqtt/mqtts/ws/wss accepted)

Username and password for MQTT may be specified with `-u` and `-p` option

If no password argument is supplied, you can enter it interactively

Base topic defaults to `homeassistant`, but may be configured with the `-topic` option


# MQTT
To issue commands:

OPEN: `<baseTopic>/cover/<deviceID>/set` - message: 'OPEN'

CLOSE: `<baseTopic>/cover/<deviceID>/set` - message: 'CLOSE'

STOP: `<baseTopic>/cover/<deviceID>/set` - message: 'STOP'

SET_POSITION: 
100 is closed
0 is open
`<baseTopic>/cover/<deviceID>/setposition` - message: '21'

In addition, for use with [Home Assistant MQTT Discovery](https://www.home-assistant.io/docs/mqtt/discovery/):

Three entities will be pubished to homeassistant discovery topic:

```
Cover: 

{
    "name": "MAC",
    "availability_topic": "homeassistant/cover/MACx/connection",
    "payload_available": "Online",
    "payload_not_available": "Offline",
    "command_topic": "homeassistant/cover/MACx/set",
    "position_topic": "homeassistant/cover/MACx/state",
    "set_position_topic" : "homeassistant/cover/MACx/setposition",
    "position_open": 0,
    "position_closed": 100,
    "payload_open": "OPEN",
    "payload_close": "CLOSE",
    "payload_stop": "STOP",
    "unique_id": "am43_MACx_cover",
    "value_template": '{{value_json[\'position\']}}',
    "device": {
        "identifiers": "am43_MACx",
        "name": "MACx",
        "manufacturer": "Generic AM43"
    }
}

Battery Sensor:

{
    "name": "MAC Battery",
    "availability_topic": "homeassistant/cover/MACx/connection",
    "state_topic": "homeassistant/cover/MACx/state
    "payload_available": "Online",
    "payload_not_available": "Offline",
    "device_class" : "battery",
    "unit_of_measurement": "%",
    "unique_id": "am43_MACx_battery_sensor",
    "value_template": '{{value_json[\'battery\']}}',
    "device": {
        "identifiers": "am43_MACx",
        "name": "MACx",
        "manufacturer": "Generic AM43"
    }
}

Light Sensor:

{
    "name": "MAC Battery",
    "availability_topic": "homeassistant/cover/MACx/connection",
    "state_topic": "homeassistant/cover/MACx/state
    "payload_available": "Online",
    "payload_not_available": "Offline",
    "unit_of_measurement": "%",
    "unique_id": "am43_MACx_light_sensor",
    "value_template": '{{value_json[\'light\']}}',
    "device": {
        "identifiers": "am43_MACx",
        "name": "MACx",
        "manufacturer": "Generic AM43"
    }
}

```

## Parameters

`<deviceID>` has format of the device's MAC address in lowercase, with the colon's stripped out and cannot be changed


# HTTP Endpoints

`GET /`: list devices.
Response type: `[String : Device]` - ID as String key, Device as value
```
{
   "c03dc8105277":{
      "id":"c03dc8105277",
      "lastconnect":"2019-11-23T17:39:48.949Z",
      "lastaction":"OPEN",
      "state":"OPEN",
      "battery":42,
      "light":0,
      "position":0
   }
}
```

`GET /<deviceID>`: Get individual device data (or 404 if no device by that ID).

Response type: `Device` example:
```
{
   "id":"c03dc8105277",
   "lastconnect":"2019-11-23T17:39:48.949Z",
   "lastaction":"OPEN",
   "state":"OPEN",
   "battery":42,
   "light":0,
   "position":0
}
```

`POST /<deviceID>/open`: Send OPEN command to am43. Response type: `200 - OK` or `404 - Not Found`

`POST /<deviceID>/close`: Send CLOSE command to am43. Response type: `200 - OK` or `404 - Not Found`

`POST /<deviceID>/stop`: Send STOP command to am43. Response type: `200 - OK` or `404 - Not Found`
