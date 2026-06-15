/*
 * am43 BLE driver — version 1.2 (2026-06-16 10:18 CEST)
 *
 * v1.2 (2026-06-16 10:18 CEST):
 * - Disconnect fallback B+C (default): poll until peripheral.state is disconnected;
 *   at 3s nudge disconnect() if still pending; at 5s force finish if no noble event
 * - Set DISCONNECT_FALLBACK_MODE = 'v1.1' to restore 2026-06-12 behaviour (or use src/am43.v1.1.js)
 *
 * v1.1 (2026-06-12 12:30 CEST):
 * - Multi-device stability: tryClearStaleBusy, finishReadSession, single 3s fallback
 * - Per-device poll intervals, position remap, fullMovingTime 15s, deviceTag
 */

const EventEmitter = require('events');

const serviceUUID = '0000fe5000001000800000805f9b34fb';
const am43CharUUID = '0000fe5100001000800000805f9b34fb';

const NOBLE_SERVICE_UID = "fe50";
const NOBLE_BAT_CHAR_UID = "fe51";

const AM43HANDLE = 0x000e;

const HEX_KEY_OPEN_BLINDS = "00ff00009a0d010096";
const HEX_KEY_CLOSE_BLINDS = "00ff00009a0d0164f2";
const HEX_KEY_STOP_BLINDS = "00ff00009a0a01cc5d";

const HEX_KEY_POSITION_BLINDS_PREFIX = "00ff0000";
const HEY_KEY_POSITION_BLIND_FIXED_CRC_CONTENT = "9a0d01";

const HEX_KEY_BATTERY_REQUEST = "00ff00009aa2010138";
const HEY_KEY_LIGHT_REQUEST = "00ff00009aaa010130";
const HEY_KEY_POSITION_REQUEST = "00ff00009aa701013d";

const batteryNotificationIdentifier = "a2";
const positionNotificationIdentifier = "a7";
const lightNotificationIdentifier = "aa";

//const fullMovingTime = 137000;
const fullMovingTime = 15000;

const DRIVER_VERSION = '1.2';
const INIT_STAGGER_MS = 60000;

/**
 * Missing-disconnect fallback after peripheral.disconnect():
 * - 'v1.2' (default): poll every 500ms for disconnected; 3s nudge disconnect(); 5s force finish
 * - 'v1.1': single 3s finish (2026-06-12 12:30 CEST); full file backup: src/am43.v1.1.js
 */
const DISCONNECT_FALLBACK_MODE = 'v1.2';

const MISSING_DISCONNECT_CHECK_MS = 3000;
const MISSING_DISCONNECT_PHASE1_MS = 3000;
const MISSING_DISCONNECT_PHASE2_DELAY_MS = 2000;
const DISCONNECT_STATE_POLL_MS = 500;

/** Friendly names for known device MACs (used in heartbeat logs). */
const deviceLabels = {
    '0273f40a2aa1': 'lewa',
    '0251eb6e37ca': 'prawa',
};

/**
 * Returns a short log tag for a device id ([lewa], [prawa], or [mac]).
 * @param {string} id - Normalized MAC address without colons
 */
function deviceTag(id) {
    return deviceLabels[id] ? `[${deviceLabels[id]}]` : `[${id}]`;
}

/**
 * BLE driver for AM43 blind motors. One instance per peripheral; serializes BLE access
 * across devices via static busyDevice. Emits stateChanged after successful reads/writes.
 */
class am43 extends EventEmitter {
    static VERSION = DRIVER_VERSION;
    /** Device currently holding the shared BLE connection, or null. */
    static busyDevice = null;
    /** Poll intervals already assigned so two devices never share the same timer. */
    static assignedIntervals = new Set();
    /** Increments per device at init to stagger fixed --interval polls. */
    static initSlot = 0;

    /**
     * @param {string} id - Normalized MAC address
     * @param {object} peripheral - noble Peripheral
     * @param {object} noble - noble module instance
     */
    constructor(id, peripheral, noble) {
        super();
        this.log = require('debug')(`am43:${id}`);
        this.id = id;
        this.peripheral = peripheral;
        this.noble = noble;
        this.connecttime = null;
        this.successtime = null;
        this.lastaction = null;
        this.state = null;
        this.currentRetry = 0;
        this.maxRetries = 30;
        this.success = false;
        this.batterysuccess = false;
        this.lightsuccess = false;
        this.positionsuccess = false;
        this.batterypercentage = null;
        this.lightpercentage = null;
        this.positionpercentage = null;
    }

    /** Writes a debug line prefixed with am43:{id}. */
    writeLog(pLogLine) {
        this.log(pLogLine);
    }

    /**
     * Clears busyDevice when the busy peripheral is already disconnected but noble
     * never fired disconnect (stalled session). Calls disconnect() for GATT cleanup.
     */
    static tryClearStaleBusy() {
        const busy = am43.busyDevice;
        if (busy == null) {
            return;
        }
        try {
            if (busy.peripheral.state === 'disconnected') {
                busy.writeLog(
                    'clearing stale busyDevice' +
                    ' (peripheral disconnected, no disconnect event)'
                );
                try {
                    busy.peripheral.disconnect();
                } catch (e) {
                    busy.writeLog('disconnect() on stale session failed: ' + e.message);
                }
                busy.writeLog('disconnected for data reading (stale busy cleared)');
                am43.busyDevice = null;
            }
        } catch (e) {
            // ignore
        }
    }

    /**
     * Entry point for periodic/status reads. Waits if another device holds busyDevice,
     * then delegates to performReadData.
     */
    readData() {
        am43.tryClearStaleBusy();

        if (am43.busyDevice != null) {
            this.writeLog('Connection busy for other device ' + am43.busyDevice.id + ', delaying data read...');
            setTimeout(() => {
                this.readData();
            }, 1000);
            return;
        }

        this.performReadData();
    }

    /**
     * Connects, discovers the data characteristic, reads battery/light/position via
     * notifications, unsubscribes, disconnects. Retries on incomplete data.
     */
    performReadData() {
        this.batterysuccess = false;
        this.positionsuccess = false;
        this.lightsuccess = false;
        am43.busyDevice = this;

        this.peripheral.connect();
        this.peripheral.once('connect', handleDeviceConnected);
        this.peripheral.once('disconnect', disconnectMe);
        const self = this;
        let sessionEnded = false;
        let disconnectHandled = false;
        let missingDisconnectTimeout = null;
        let missingDisconnectPhase1Timeout = null;
        let missingDisconnectPhase2Timeout = null;
        let disconnectStatePollInterval = null;

        function getPeripheralState() {
            try {
                return self.peripheral.state;
            } catch (e) {
                return 'unknown';
            }
        }

        /** Cancels all missing-disconnect timers and state poll. */
        function clearMissingDisconnectCheck() {
            if (missingDisconnectTimeout) {
                clearTimeout(missingDisconnectTimeout);
                missingDisconnectTimeout = null;
            }
            if (missingDisconnectPhase1Timeout) {
                clearTimeout(missingDisconnectPhase1Timeout);
                missingDisconnectPhase1Timeout = null;
            }
            if (missingDisconnectPhase2Timeout) {
                clearTimeout(missingDisconnectPhase2Timeout);
                missingDisconnectPhase2Timeout = null;
            }
            if (disconnectStatePollInterval) {
                clearInterval(disconnectStatePollInterval);
                disconnectStatePollInterval = null;
            }
        }

        /** v1.2: finish when noble never fired disconnect but peripheral is disconnected. */
        function tryFinishWhenDisconnected() {
            if (sessionEnded) {
                return;
            }
            if (getPeripheralState() === 'disconnected') {
                finishReadSession(' (peripheral disconnected, no disconnect event)');
            }
        }

        /**
         * Arms missing-disconnect handling after disconnect().
         * v1.1: single 3s finish. v1.2: poll + 3s nudge + 5s force finish.
         */
        function scheduleMissingDisconnectCheck() {
            clearMissingDisconnectCheck();

            if (DISCONNECT_FALLBACK_MODE === 'v1.1') {
                missingDisconnectTimeout = setTimeout(() => {
                    missingDisconnectTimeout = null;
                    if (sessionEnded) {
                        return;
                    }
                    finishReadSession(' (no disconnect event, peripheral state: ' + getPeripheralState() + ')');
                }, MISSING_DISCONNECT_CHECK_MS);
                return;
            }

            disconnectStatePollInterval = setInterval(() => {
                tryFinishWhenDisconnected();
            }, DISCONNECT_STATE_POLL_MS);

            missingDisconnectPhase1Timeout = setTimeout(() => {
                missingDisconnectPhase1Timeout = null;
                if (sessionEnded) {
                    return;
                }
                const state = getPeripheralState();
                if (state === 'disconnected') {
                    tryFinishWhenDisconnected();
                    return;
                }
                self.writeLog(
                    'disconnect still pending after ' + (MISSING_DISCONNECT_PHASE1_MS / 1000) +
                    's (state: ' + state + '), nudging disconnect()'
                );
                try {
                    self.peripheral.disconnect();
                } catch (e) {
                    self.writeLog('disconnect() nudge failed: ' + e.message);
                }
                missingDisconnectPhase2Timeout = setTimeout(() => {
                    missingDisconnectPhase2Timeout = null;
                    if (sessionEnded) {
                        return;
                    }
                    const state2 = getPeripheralState();
                    if (state2 === 'disconnected') {
                        tryFinishWhenDisconnected();
                        return;
                    }
                    finishReadSession(
                        ' (no disconnect event after ' +
                        ((MISSING_DISCONNECT_PHASE1_MS + MISSING_DISCONNECT_PHASE2_DELAY_MS) / 1000) +
                        's, peripheral state: ' + state2 + ')'
                    );
                }, MISSING_DISCONNECT_PHASE2_DELAY_MS);
            }, MISSING_DISCONNECT_PHASE1_MS);
        }

        /** Requests BLE disconnect and arms the missing-disconnect fallback. */
        function requestDisconnect() {
            scheduleMissingDisconnectCheck();
            try {
                self.peripheral.disconnect();
            } catch (e) {
                self.writeLog('disconnect() failed: ' + e.message);
            }
        }

        /**
         * Ends the read session once: logs disconnect, retries or marks success,
         * clears busyDevice, emits stateChanged on full success.
         */
        function finishReadSession(logSuffix) {
            if (sessionEnded) {
                return;
            }
            sessionEnded = true;
            clearMissingDisconnectCheck();
            self.writeLog('disconnected for data reading' + logSuffix);

            if (self.batterysuccess === false || self.positionsuccess === false || self.lightsuccess === false) {
                if (self.currentRetry < self.maxRetries) {
                    self.writeLog("Reading data unsuccessful, retrying in 1 second...");
                    self.currentRetry = self.currentRetry + 1;
                    setTimeout(() => {
                        self.performReadData();
                    }, 1000);
                } else {
                    self.writeLog("Reading data unsuccessful, giving up...");
                    am43.busyDevice = null;
                    self.currentRetry = 0;
                }
            } else {
                self.writeLog("Reading data was successful");
                self.successtime = new Date();
                am43.busyDevice = null;
                self.currentRetry = 0;
                self.emit('stateChanged', self.getState());
            }
        }

        /** On connect: discover fe50/fe51 and start notification-driven read chain. */
        function handleDeviceConnected() {
            self.connecttime = new Date();
            self.writeLog('AM43 connected for data reading');
            var characteristicUUIDs = [NOBLE_BAT_CHAR_UID];
            var serviceUID = [NOBLE_SERVICE_UID];
            self.peripheral.removeAllListeners('servicesDiscover');
            self.peripheral.discoverSomeServicesAndCharacteristics(serviceUID, characteristicUUIDs, discoveryResult);
        }

        /** noble disconnect handler; delegates to finishReadSession. */
        function disconnectMe() {
            if (disconnectHandled) {
                return;
            }
            disconnectHandled = true;
            finishReadSession('');
        }

        /** Parses notification payloads (battery → light → position) and triggers disconnect when done. */
        function discoveryResult(error, services, characteristics) {
            if (error) {
                self.writeLog("ERROR retrieving characteristic");
                requestDisconnect();
            } else {
                self.writeLog('discovered data char');
                let characteristic = characteristics[0];
                characteristic.on('data', function (data, isNotification) {
                    self.writeLog('received characteristic update');
                    let bfr = Buffer.from(data, "hex");
                    let strBfr = bfr.toString("hex", 0, bfr.length);
                    self.writeLog('Notification data: ' + strBfr);
                    let notificationIdentifier = strBfr.substr(2, 2);
                    self.writeLog('Notification identifier: ' + notificationIdentifier);
                    if (batteryNotificationIdentifier === notificationIdentifier) {
                        let batteryHex = strBfr.substr(14, 2);
                        let batteryPercentage = parseInt(batteryHex, 16);
                        self.writeLog('Bat %: ' + batteryPercentage);
                        self.batterypercentage = batteryPercentage;
                        self.batterysuccess = true;

                        characteristic.write(Buffer.from(HEY_KEY_LIGHT_REQUEST, "hex"), true);
                    } else if (lightNotificationIdentifier === notificationIdentifier) {
                        let lightHex = strBfr.substr(8, 2);
                        let lightPercentage = parseInt(lightHex, 16);
                        self.writeLog('Light %: ' + lightPercentage);
                        self.lightpercentage = lightPercentage;
                        self.lightsuccess = true;

                        characteristic.write(Buffer.from(HEY_KEY_POSITION_REQUEST, "hex"), true);
                    } else if (positionNotificationIdentifier === notificationIdentifier) {
                        let positionHex = strBfr.substr(10, 2);
                        let positionPercentage = parseInt(positionHex, 16);
                        let positionPercentageOrg = positionPercentage;
                        if (positionPercentage == 99) {
                            positionPercentage = 100;
                        } else if (positionPercentage == 1) {
                            positionPercentage = 0;
                        }
                        self.writeLog('Position org %: ' + positionPercentageOrg + '. Position modified %: ' + positionPercentage);
                        self.positionpercentage = positionPercentage;
                        self.positionsuccess = true;
                        self.reevaluateState();
                    }

                    if (self.batterysuccess && self.lightsuccess && self.positionsuccess) {
                        self.writeLog("Reading data completed");
                        characteristic.unsubscribe();
                        setTimeout(() => {
                            requestDisconnect();
                        }, 1000);
                    }
                });
                characteristic.subscribe();
                characteristic.write(Buffer.from(HEX_KEY_BATTERY_REQUEST, "hex"), true);
            }
        }
    }

    /**
     * Entry point for command writes (open/close/stop/position). Waits if BLE is busy.
     */
    writeKey(handle, key) {
        am43.tryClearStaleBusy();

        if (am43.busyDevice != null) {
            this.writeLog('Connection busy for other device, waiting...');
            setTimeout(() => {
                this.writeKey(handle, key);
            }, 1000);
            return;
        }

        this.performWriteKey(handle, key);
    }

    /** Connects, writes a hex key to the given GATT handle, disconnects, retries on failure. */
    performWriteKey(handle, key) {
        this.success = false;
        am43.busyDevice = this;
        this.peripheral.connect();
        this.peripheral.once('connect', handleDeviceConnected);
        this.peripheral.once('disconnect', disconnectMe);
        const self = this;

        function handleDeviceConnected() {
            self.connecttime = new Date();
            self.writeLog('AM43 connected');
            self.peripheral.writeHandle(handle, Buffer.from(key, "hex"), true, handleWriteDone);
        }

        function disconnectMe() {
            self.writeLog('disconnected');
            if (self.success === false) {
                if (self.currentRetry < self.maxRetries) {
                    self.writeLog("Writing unsuccessful, retrying in 1 second...");
                    self.currentRetry = self.currentRetry + 1;
                    setTimeout(() => {
                        self.performWriteKey(handle, key);
                    }, 1000);
                } else {
                    self.writeLog("Writing unsuccessful, giving up...");
                    am43.busyDevice = null;
                    self.currentRetry = 0;
                }
            } else {
                self.writeLog("Writing was successful");
                am43.busyDevice = null;
                self.currentRetry = 0;
                self.emit('stateChanged', self.getState());
                self.scheduleForcedDataRead();
            }
        }

        function handleWriteDone(error) {
            if (error) {
                self.writeLog('ERROR' + error);
            } else {
                self.writeLog('key written');
                self.success = true;
            }

            setTimeout(() => {
                self.peripheral.disconnect();
            }, 1000);
        }
    }

    /**
     * Starts this device: initial read after 5s, then periodic readData on a unique interval.
     * @param {number} poll - Minutes from CLI --interval; 0 = random 10–20 min per device
     */
    am43Init(poll = 0) {
        const self = this;
        const slot = am43.initSlot++;

        this.writeLog('driver v' + DRIVER_VERSION + ', disconnect fallback ' + DISCONNECT_FALLBACK_MODE);

        setTimeout(() => {
            self.readData();
        }, 5000);

        let intervalMS;
        if (poll > 0) {
            intervalMS = poll * 60 * 1000 + slot * INIT_STAGGER_MS;
        } else {
            let attempts = 0;
            do {
                intervalMS = this.randomIntMinutes(10, 20);
                attempts++;
            } while (am43.assignedIntervals.has(intervalMS) && attempts < 50);
        }

        while (am43.assignedIntervals.has(intervalMS)) {
            this.writeLog('interval collision with other device, adding ' + INIT_STAGGER_MS + 'ms stagger');
            intervalMS += INIT_STAGGER_MS;
        }
        am43.assignedIntervals.add(intervalMS);

        const otherIntervals = [...am43.assignedIntervals].filter((v) => v !== intervalMS);
        this.writeLog(
            'interval: ' + intervalMS + 'ms (' + Math.round(intervalMS / 60000) + 'min)' +
            ', other device intervals: ' + (otherIntervals.length ? otherIntervals.join(',') : 'none')
        );
        setInterval(() => {
            self.readData();
        }, intervalMS);
    }

    /** Schedules extra reads after a motor command (early + after movement time). */
    scheduleForcedDataRead() {
        const self = this;
        setTimeout(() => {
            self.readData();
        }, 5000);

        setTimeout(() => {
            self.readData();
        }, fullMovingTime + 10000);
    }

    /** Random poll interval in milliseconds between min and max minutes (inclusive). */
    randomIntMinutes(min, max) {
        return 1000 * 60 * (Math.floor(Math.random() * (max - min + 1) + min));
    }

    /** Sets OPEN/CLOSED state from positionpercentage (100 = closed). */
    reevaluateState() {
        if (this.positionpercentage === 100) {
            this.state = 'CLOSED';
        } else {
            this.state = 'OPEN';
        }
    }

    /** Sends open command and updates local state. */
    am43Open() {
        this.writeKey(AM43HANDLE, HEX_KEY_OPEN_BLINDS);
        this.lastaction = 'OPEN';
        this.state = 'OPEN';
    }

    /** Sends close command and updates local state. */
    am43Close() {
        this.writeKey(AM43HANDLE, HEX_KEY_CLOSE_BLINDS);
        this.lastaction = 'CLOSE';
        this.state = 'CLOSED';
    }

    /** Sends stop command and updates local state. */
    am43Stop() {
        this.writeKey(AM43HANDLE, HEX_KEY_STOP_BLINDS);
        this.lastaction = 'STOP';
        this.state = 'OPEN';
    }

    /** Sends goto-position command with XOR CRC; updates local state. */
    am43GotoPosition(position) {
        var positionHex = position.toString(16);
        if (positionHex.length === 1) {
            positionHex = "0" + positionHex;
        }
        var buffer = Buffer.from(HEY_KEY_POSITION_BLIND_FIXED_CRC_CONTENT + positionHex, "hex");
        var crc = buffer[0];
        for (var i = 1; i < buffer.length; i++) {
            crc = crc ^ buffer[i];
        }

        this.writeKey(AM43HANDLE, HEX_KEY_POSITION_BLINDS_PREFIX + HEY_KEY_POSITION_BLIND_FIXED_CRC_CONTENT + positionHex + crc.toString(16));
        this.lastaction = 'SET_POSITION';
        if (position === 100) {
            this.state = 'CLOSED';
        } else {
            this.state = 'OPEN';
        }
    }

    /** Snapshot of device id, timestamps, state, battery, light, and position for MQTT/UI. */
    getState() {
        return {
            id: this.id,
            lastconnect: this.connecttime,
            lastsuccess: this.successtime,
            lastaction: this.lastaction,
            state: this.state,
            battery: this.batterypercentage,
            light: this.lightpercentage,
            position: this.positionpercentage
        };
    }
}

module.exports = am43;
module.exports.deviceTag = deviceTag;
module.exports.DISCONNECT_FALLBACK_MODE = DISCONNECT_FALLBACK_MODE;

