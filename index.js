#!/usr/bin/env node

/*
 * am43 entrypoint — version 1.2 (2026-06-16 10:18 CEST)
 *
 * v1.2 (2026-06-16 10:18 CEST):
 * - Pairs with src/am43.js v1.2 (disconnect fallback B+C; see DISCONNECT_FALLBACK_MODE)
 *
 * v1.1 (2026-06-12 12:30 CEST):
 * - Stop scan after discovery; version log, deviceTag heartbeat, noble warnings
 */

const ENTRYPOINT_VERSION = '1.2';

const readlineSync = require('readline-sync');
const noble = require('@abandonware/noble');
const log = require('debug')('am43*');
const debugLog = require('debug')('am43');
const Am43 = require('./src/am43');

debugLog(
    'am43 entrypoint v%s, driver v%s loaded from ./src/am43.js',
    ENTRYPOINT_VERSION,
    Am43.VERSION || 'unknown'
);
const moment = require('moment');

const yargs = require('yargs');
const args = yargs
    .usage('Usage: $0 MAC1 MAC2 --express-port 3000 --url [mqtt|ws][s]://yourbroker.example.com')
    .example('$0 MAC1 MAC2 --url [broker_url]', 'Connect to devices with specific IDs only, publish to MQTT')
    .options({
        'd': {
            alias: 'debug',
            describe: 'Enable debug logging',
            type: 'boolean',
        },
        'l': {
            alias: 'express-port',
            describe: 'Port for express web server (if unset, express will not startup)',
            type: 'number',
        },
        'url': {
            alias: 'mqtt-url',
            describe: 'MQTT broker URL',
        },
        'topic': {
            alias: 'mqtt-base-topic',
            describe: 'Base topic for MQTT',
            default: 'homeassistant',
        },
        'p': {
            alias: 'mqtt-password',
            describe: 'Password for MQTT (if not specified as an argument, will prompt for password at startup)',
        },
        'u': {
            alias: 'mqtt-username',
            describe: 'Username for MQTT',
        },
        'i': {
            alias: 'interval',
            describe: 'Minutes interval for device polling (default is random 10 to 20)',
            type: 'number',
            default: 0,
        },
        'f': {
            alias: 'fail-time',
            describe: 'Seconds since last successful device connection before program exit (default is never exit)',
            type: 'number',
            default: 0,
        },
    })
    .wrap(yargs.terminalWidth())
    .env('AM43');

const argv = args.argv;

if (argv.debug) {
    debugLog.enabled = true;
}

if (!argv.mqttUrl && !argv.expressPort) {
    log('ERROR: Neither --express-port or --mqtt-url supplied, nothing to do');
    yargs.showHelp();
    process.exit(-1);
}

if (argv.p === true) {
    argv.p = readlineSync.question('MQTT Password: ', { hideEchoBack: true, mask: '' });
}

/** MAC addresses from CLI args, normalized (no colons, lowercase). */
const idsToConnectTo = argv._
    .filter((name) => !name.startsWith('_'))
    .map((name) => name.replace(/:/g, '').toLowerCase());

if (idsToConnectTo.length === 0) {
    log('ERROR: No MACs defined');
    yargs.showHelp();
    process.exit(-1);
}

argv.expectedDevices = idsToConnectTo.length;

/** id → Am43 instance for all discovered configured devices. */
const devices = {};
/** Ordered list of device ids (for heartbeat iteration). */
const ids = [];
let failConnectCount = 0;
/** True after all expected devices found and scan stopped. */
let initialScanComplete = false;
/** MACs already logged as ignored during initial scan. */
const ignoredDevicesLogged = new Set();

/** Start BLE scan when adapter is powered on. */
noble.on('stateChange', (state) => {
    if (state === 'poweredOn') {
        noble.startScanning();
    }
});

if (argv.expectedDevices) {
    log('scanning for %d device(s) %o', argv.expectedDevices, idsToConnectTo);
} else {
    log('scanning for as many devices until timeout');
}

const failTime = argv.f;
const interval = argv.i;

let baseTopic = argv.topic;
if (!baseTopic.endsWith('/')) {
    baseTopic = baseTopic + '/';
}

const mqttUrl = argv.url;
const mqttBinding = require('./src/MQTTConnector');
const mqttUsername = argv.u;
const mqttPassword = argv.p;

const expressPort = argv.l;
if (expressPort) {
    const WebBinding = require('./src/WebConnector');
    new WebBinding(devices, expressPort, debugLog);
}

/** Forward noble GATT warnings to both debug channels. */
noble.on('warning', (message) => {
    log(message);
    debugLog(message);
});

/**
 * Minute heartbeat: logs time since last successful read; exits if --fail-time exceeded
 * or no device ever connected after 10 minutes.
 */
function intervalFunc() {
    const now = moment();
    let lastSuccess = null;
    let lastSuccessId = null;

    for (const id of ids) {
        if (lastSuccess == null || devices[id].successtime > lastSuccess) {
            lastSuccess = devices[id].successtime;
            lastSuccessId = id;
        }
    }

    if (lastSuccess == null) {
        failConnectCount++;
        lastSuccess = new Date();
        if (failConnectCount > 10) {
            log('Exiting since no device has every connected...');
            process.exit(-2);
        }
    }

    const secondsDiff = now.diff(lastSuccess, 'seconds');
    debugLog('Time since last successful connect: %s [%s]', Am43.deviceTag(lastSuccessId), secondsDiff);

    if (failTime > 0 && secondsDiff > failTime) {
        log('Exiting since max time since last successful connection has elapsed...');
        process.exit(-3);
    }
}

setInterval(intervalFunc, 60000);

/**
 * On BLE discover: bind configured MACs to Am43, stop scan when all expected devices
 * found, then attach MQTT/Web connectors and start polling.
 */
noble.on('discover', (peripheral) => {
    const id = peripheral.address !== undefined
        ? peripheral.address.replace(/:/g, '').toLowerCase()
        : undefined;

    if (idsToConnectTo.indexOf(id) === -1) {
        if (!initialScanComplete && !ignoredDevicesLogged.has(id)) {
            ignoredDevicesLogged.add(id);
            debugLog(
                'Found %s but will not connect as it was not specified in the list of devices %o',
                id,
                idsToConnectTo
            );
        }
        return;
    }

    if (devices[id]) {
        return;
    }

    devices[id] = new Am43(id, peripheral, noble);
    if (argv.debug) {
        devices[id].log.enabled = true;
    }

    log('discovered %s', id);
    ids.push(id);

    if (Object.keys(devices).length === argv.expectedDevices) {
        log('all expected devices connected, stopping scan');
        initialScanComplete = true;
        noble.stopScanning();

        Object.values(devices).forEach((device) => {
            if (mqttUrl) {
                new mqttBinding(device, mqttUrl, baseTopic, mqttUsername, mqttPassword);
            }
            device.am43Init(interval);
        });
    }
});


