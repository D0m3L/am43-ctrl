/*
 * am43 BLE driver — version 1.2 (2026-06-24 17:00 CEST)
 *
 * v1.2 (2026-06-24 17:00 CEST):
 * - Disconnect fallback (DISCONNECT_FALLBACK_MODE v1.4): poll until disconnected (max 15s);
 *   safe 3s nudge; forced recovery + BLE cooldown; do not nudge while disconnecting
 *   (avoids noble HCI EALREADY crash on bindRaw)
 * - Per-device write queue; self-busy handling to avoid false "other device busy" loops
 * - Per-device read dedup window (5000ms); read defers while writeInProgress on same device
 * - Read session management: readInProgress, session token, forceReadSessionRecovery on
 *   retry give-up (10/10) and stale sessions; tryClearStaleBusy for disconnected peripherals
 * - readData: do not self-reschedule when readInProgress (breaks infinite defer loop)
 *
 * v1.1 (2026-06-12 12:30 CEST):
 * - Multi-device stability: tryClearStaleBusy, finishReadSession, single 3s fallback
 * - Per-device poll intervals, position remap, fullMovingTime 15s, deviceTag
 * - Backup: src/am43.v1.1.js
 */

const EventEmitter = require('events');

// --- BLE GATT UUIDs (full 128-bit form; legacy, not used by noble discovery path) ---
/** AM43 primary service UUID (Blind Engine / fe50). */
const serviceUUID = '0000fe5000001000800000805f9b34fb';
/** AM43 data characteristic UUID (fe51) — battery, light, position notifications. */
const am43CharUUID = '0000fe5100001000800000805f9b34fb';

// --- Short UUIDs passed to noble discoverSomeServicesAndCharacteristics ---
/** 16-bit service id for GATT discovery (fe50 → AM43 service). */
const NOBLE_SERVICE_UID = "fe50";
/** 16-bit characteristic id for GATT discovery (fe51 → notification channel). */
const NOBLE_BAT_CHAR_UID = "fe51";

// --- GATT write handle for motor commands (open/close/stop/position) ---
/** ATT handle used by peripheral.writeHandle() for blind movement commands. */
const AM43HANDLE = 0x000e;

// --- Motor command payloads (hex strings written to AM43HANDLE) ---
/** Open blinds — full travel toward open. */
const HEX_KEY_OPEN_BLINDS = "00ff00009a0d010096";
/** Close blinds — full travel toward closed. */
const HEX_KEY_CLOSE_BLINDS = "00ff00009a0d0164f2";
/** Stop blinds — halt current movement. */
const HEX_KEY_STOP_BLINDS = "00ff00009a0a01cc5d";

/** Prefix for goto-position commands; suffix is position byte + XOR CRC. */
const HEX_KEY_POSITION_BLINDS_PREFIX = "00ff0000";
/** Fixed middle bytes of position command before position hex and CRC. */
const HEY_KEY_POSITION_BLIND_FIXED_CRC_CONTENT = "9a0d01";

// --- Status read requests (hex strings written to fe51 to trigger notifications) ---
/** Request battery percentage notification. */
const HEX_KEY_BATTERY_REQUEST = "00ff00009aa2010138";
/** Request ambient light level notification. */
const HEY_KEY_LIGHT_REQUEST = "00ff00009aaa010130";
/** Request blind position notification. */
const HEY_KEY_POSITION_REQUEST = "00ff00009aa701013d";

// --- Notification payload type bytes (hex at offset 2 in notification data) ---
/** Battery response identifier in notification stream. */
const batteryNotificationIdentifier = "a2";
/** Position response identifier in notification stream. */
const positionNotificationIdentifier = "a7";
/** Light response identifier in notification stream. */
const lightNotificationIdentifier = "aa";

// --- Post-command timing ---
/** Ms to wait after a motor command before scheduling a follow-up status read.
 *  15000 ≈ typical full blind travel; upstream used 137000 (137 s). */
const fullMovingTime = 15000;

// --- Driver identity and multi-device scheduling ---
/** Semantic version string logged at device init. */
const DRIVER_VERSION = '1.2';
/** Ms added per device slot so two motors never poll on the same minute boundary.
 *  Slot 0 = +0 ms, slot 1 = +60000 ms, etc. */
const INIT_STAGGER_MS = 60000;
/** Min ms between readData() entry calls for the same device; drops overlapping
 *  interval/forced reads. Internal performReadData() retries are not deduped. */
const READ_DEDUP_WINDOW_MS = 5000;
/** Max read session retries after incomplete notification data. */
const READ_MAX_RETRIES = 10;
/** Max write command retries after failed GATT write. */
const WRITE_MAX_RETRIES = 10;
/** Ms to wait when peripheral is not disconnected before a write connect. */
const WRITE_CONNECT_WAIT_MS = 500;
/** Ms to wait when peripheral is not disconnected before a read connect. */
const READ_CONNECT_WAIT_MS = 500;
/** Ms between normal failed read retries. */
const READ_RETRY_DELAY_MS = 1000;
/** Max ms a read session may hold busyDevice before forced recovery. */
const READ_SESSION_STALE_MS = 120000;

/**
 * Strategy when noble does not fire disconnect after peripheral.disconnect().
 * - 'v1.4' (default): poll until disconnected (max 15s); safe nudge at 3s; forced
 *   recovery + BLE cooldown if still not disconnected
 * - 'v1.2': poll; 3s nudge; 5s force finish (may release while disconnecting)
 * - 'v1.1': single 3s finish; backup: src/am43.v1.1.js
 */
const DISCONNECT_FALLBACK_MODE = 'v1.4';

// --- Missing-disconnect fallback timers (v1.1 / v1.2 / v1.4) ---
/** v1.1 only: ms before finishing session without a noble disconnect event. */
const MISSING_DISCONNECT_CHECK_MS = 3000;
/** v1.2/v1.4: ms after disconnect() before first nudge or state check. */
const MISSING_DISCONNECT_PHASE1_MS = 3000;
/** v1.2 only: extra ms after phase 1 before force-finishing the session. */
const MISSING_DISCONNECT_PHASE2_DELAY_MS = 2000;
/** v1.4 only: max ms to wait for peripheral.state === 'disconnected' before
 *  forced recovery (holds busyDevice, then applies BLE_RECOVERY_COOLDOWN_MS). */
const MISSING_DISCONNECT_MAX_WAIT_MS = 15000;
/** v1.4 only: ms after forced recovery during which new reads/writes are deferred
 *  so BlueZ/noble can finish tearing down the previous connection. */
const BLE_RECOVERY_COOLDOWN_MS = 3000;
/** Interval for polling peripheral.state while waiting for disconnect to complete. */
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

/** Human-readable label for a motor command hex key. */
function describeCommandKey(key) {
    if (key === HEX_KEY_OPEN_BLINDS) {
        return 'OPEN';
    }
    if (key === HEX_KEY_CLOSE_BLINDS) {
        return 'CLOSE';
    }
    if (key === HEX_KEY_STOP_BLINDS) {
        return 'STOP';
    }
    if (key.startsWith(HEX_KEY_POSITION_BLINDS_PREFIX)) {
        return 'SET_POSITION';
    }
    return 'UNKNOWN';
}

/**
 * BLE driver for AM43 blind motors. One instance per peripheral; serializes BLE access
 * across devices via static busyDevice. Emits stateChanged after successful reads/writes.
 */
class am43 extends EventEmitter {
    static VERSION = DRIVER_VERSION;
    /** Device currently holding the shared BLE connection, or null. */
    static busyDevice = null;
    /** Timestamp (ms) until which new BLE operations are deferred after forced recovery. */
    static bleCooldownUntil = 0;
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
        this.writeRetry = 0;
        this.maxRetries = READ_MAX_RETRIES;
        this.success = false;
        this.batterysuccess = false;
        this.lightsuccess = false;
        this.positionsuccess = false;
        this.batterypercentage = null;
        this.lightpercentage = null;
        this.positionpercentage = null;
        this.writeQueue = [];
        this.writeInProgress = false;
        this.lastReadStartTimestamp = 0;
        this.readInProgress = false;
        this.readSessionStartTime = 0;
        this._readSessionToken = 0;
        this.readRetryTimer = null;
    }

    /** Writes a debug line prefixed with am43:{id}. */
    writeLog(pLogLine) {
        this.log(pLogLine);
    }

    /** Returns noble peripheral.state or 'unknown' on error. */
    getPeripheralState() {
        try {
            return this.peripheral.state;
        } catch (e) {
            return 'unknown';
        }
    }

    /**
     * One-line snapshot of BLE session state for log tracing.
     * @param {string} phase - Short label, e.g. read-entry, write-attempt
     */
    logBleContext(phase) {
        const busyLabel = am43.busyDevice
            ? deviceTag(am43.busyDevice.id) + '(' + am43.busyDevice.id + ')'
            : 'none';
        const cooldown = am43.isBleCooldownActive()
            ? 'on(' + am43.getBleCooldownRemainingMs() + 'ms)'
            : 'off';
        this.writeLog(
            '[' + phase + '] peripheral=' + this.getPeripheralState() +
            ' busy=' + busyLabel +
            ' write=' + (this.writeInProgress ? 'in_progress' : 'idle') +
            ' wq=' + this.writeQueue.length +
            ' readRetry=' + this.currentRetry + '/' + READ_MAX_RETRIES +
            ' writeRetry=' + this.writeRetry + '/' + WRITE_MAX_RETRIES +
            ' cooldown=' + cooldown
        );
    }

    /** True while global BLE recovery cooldown is active. */
    static isBleCooldownActive() {
        return Date.now() < am43.bleCooldownUntil;
    }

    /** Milliseconds remaining on global BLE recovery cooldown. */
    static getBleCooldownRemainingMs() {
        return Math.max(0, am43.bleCooldownUntil - Date.now());
    }

    /** Removes connect/disconnect listeners left from a prior session. */
    cleanupPeripheralConnectDisconnectListeners() {
        const connectCount = this.peripheral.listenerCount('connect');
        const disconnectCount = this.peripheral.listenerCount('disconnect');
        this.peripheral.removeAllListeners('connect');
        this.peripheral.removeAllListeners('disconnect');
        if (connectCount + disconnectCount > 0) {
            this.writeLog(
                'listener cleanup: removed connect=' + connectCount +
                ' disconnect=' + disconnectCount
            );
        }
    }

    /** Applies global BLE recovery cooldown after noble HCI errors. */
    static applyBleRecoveryCooldown(ms = BLE_RECOVERY_COOLDOWN_MS) {
        am43.bleCooldownUntil = Date.now() + ms;
    }

    /**
     * Force-ends a stuck read session: cleanup listeners, disconnect if needed,
     * release busyDevice, reset retry state.
     * @param {string} reason - Short label for logs
     */
    forceReadSessionRecovery(reason) {
        this.writeLog(reason + ': force disconnect, releasing BLE lock');
        if (this.readRetryTimer) {
            clearTimeout(this.readRetryTimer);
            this.readRetryTimer = null;
        }
        this._readSessionToken = (this._readSessionToken || 0) + 1;
        this.cleanupPeripheralConnectDisconnectListeners();
        try {
            const state = this.getPeripheralState();
            if (state !== 'disconnected' && state !== 'disconnecting') {
                this.peripheral.disconnect();
            }
        } catch (e) {
            this.writeLog('force disconnect failed: ' + e.message);
        }
        this.readInProgress = false;
        this.readSessionStartTime = 0;
        if (am43.busyDevice === this) {
            am43.busyDevice = null;
        }
        this.currentRetry = 0;
    }

    /**
     * Clears busyDevice when the busy peripheral is already disconnected but noble
     * never fired disconnect (stalled session).
     */
    static tryClearStaleBusy() {
        const busy = am43.busyDevice;
        if (busy == null) {
            return;
        }
        if (busy.writeInProgress) {
            return;
        }
        try {
            if (busy.currentRetry >= busy.maxRetries) {
                busy.forceReadSessionRecovery('stale busy after read retries exhausted');
                return;
            }
            if (busy.readInProgress && busy.readSessionStartTime > 0 &&
                Date.now() - busy.readSessionStartTime > READ_SESSION_STALE_MS) {
                busy.forceReadSessionRecovery(
                    'stale read session after ' + (READ_SESSION_STALE_MS / 1000) + 's'
                );
                return;
            }
            if (busy.peripheral.state === 'disconnected') {
                busy.forceReadSessionRecovery(
                    'stale busy: peripheral disconnected without disconnect event'
                );
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
        this.logBleContext('read-entry');
        am43.tryClearStaleBusy();

        if (am43.isBleCooldownActive()) {
            this.writeLog(
                'read blocked: BLE recovery cooldown (' + am43.getBleCooldownRemainingMs() + 'ms remaining), retrying in 1s'
            );
            setTimeout(() => {
                this.readData();
            }, 1000);
            return;
        }

        if (am43.busyDevice != null && am43.busyDevice.id !== this.id) {
            this.writeLog(
                'Connection busy for other device ' + am43.busyDevice.id + ', delaying data read...'
            );
            setTimeout(() => {
                this.readData();
            }, 1000);
            return;
        }

        if (this.writeInProgress) {
            this.writeLog('read deferred: write in progress, retrying in 1s');
            setTimeout(() => {
                this.readData();
            }, 1000);
            return;
        }

        if (this.readInProgress) {
            this.writeLog('read deferred: read session in progress');
            return;
        }

        const now = Date.now();
        const elapsedMs = now - this.lastReadStartTimestamp;
        if (this.lastReadStartTimestamp > 0 && elapsedMs < READ_DEDUP_WINDOW_MS) {
            this.writeLog(
                'read dedup: dropped (elapsed ' + elapsedMs + 'ms < window ' + READ_DEDUP_WINDOW_MS + 'ms)'
            );
            return;
        }

        this.lastReadStartTimestamp = now;
        this.performReadData();
    }

    /**
     * Connects, discovers the data characteristic, reads battery/light/position via
     * notifications, unsubscribes, disconnects. Retries on incomplete data.
     * @param {boolean} isRetry - True when called from an in-flight retry chain.
     */
    performReadData(isRetry = false) {
        if (this.readInProgress && !isRetry) {
            this.writeLog('read session already in progress, skipping duplicate performReadData');
            return;
        }
        if (!isRetry) {
            this._readSessionToken = (this._readSessionToken || 0) + 1;
            if (this.readRetryTimer) {
                clearTimeout(this.readRetryTimer);
                this.readRetryTimer = null;
            }
            this.cleanupPeripheralConnectDisconnectListeners();
        }
        const sessionToken = this._readSessionToken;
        this.readInProgress = true;
        this.readSessionStartTime = Date.now();
        this.logBleContext('read-session-start');
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
            return self.getPeripheralState();
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
         * Calls disconnect() only when not already tearing down.
         * Re-nudging while state is disconnecting can crash noble HCI (EALREADY on bindRaw).
         */
        function safeDisconnectNudge(phaseLabel) {
            const state = getPeripheralState();
            if (state === 'disconnected') {
                tryFinishWhenDisconnected();
                return;
            }
            if (state === 'disconnecting') {
                self.writeLog(
                    phaseLabel + ': still disconnecting, waiting without nudge'
                );
                return;
            }
            self.writeLog(
                phaseLabel + ': state ' + state + ', nudging disconnect()'
            );
            try {
                self.peripheral.disconnect();
            } catch (e) {
                self.writeLog('disconnect() nudge failed: ' + e.message);
            }
        }

        /**
         * Arms missing-disconnect handling after disconnect().
         * v1.1: single 3s finish. v1.2: poll + 3s nudge + 5s force finish.
         * v1.4: poll until disconnected (max 15s); 3s nudge; forced recovery + cooldown.
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
                safeDisconnectNudge(
                    'disconnect still pending after ' + (MISSING_DISCONNECT_PHASE1_MS / 1000) + 's'
                );

                if (DISCONNECT_FALLBACK_MODE === 'v1.4') {
                    return;
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

            if (DISCONNECT_FALLBACK_MODE === 'v1.4') {
                missingDisconnectPhase2Timeout = setTimeout(() => {
                    missingDisconnectPhase2Timeout = null;
                    if (sessionEnded) {
                        return;
                    }
                    const state = getPeripheralState();
                    if (state === 'disconnected') {
                        tryFinishWhenDisconnected();
                        return;
                    }
                    safeDisconnectNudge(
                        'disconnect recovery after ' + (MISSING_DISCONNECT_MAX_WAIT_MS / 1000) +
                        's (state: ' + state + ')'
                    );
                    finishReadSession(
                        ' (forced recovery after ' + (MISSING_DISCONNECT_MAX_WAIT_MS / 1000) +
                        's, peripheral state: ' + state + ')',
                        BLE_RECOVERY_COOLDOWN_MS
                    );
                }, MISSING_DISCONNECT_MAX_WAIT_MS);
            }
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
         * @param {number} releaseDelayMs - Hold lock and defer BLE ops during recovery cooldown.
         */
        function finishReadSession(logSuffix, releaseDelayMs = 0) {
            if (sessionEnded) {
                return;
            }
            if (sessionToken !== self._readSessionToken) {
                self.writeLog('ignoring stale read session finish');
                return;
            }
            sessionEnded = true;
            clearMissingDisconnectCheck();

            const releaseSession = () => {
                if (sessionToken !== self._readSessionToken) {
                    return;
                }
                self.writeLog('disconnected for data reading' + logSuffix);

                if (self.batterysuccess === false || self.positionsuccess === false || self.lightsuccess === false) {
                    if (self.currentRetry < self.maxRetries) {
                        self.writeLog('Reading data unsuccessful, retrying in 1 second...');
                        self.currentRetry = self.currentRetry + 1;
                        if (self.readRetryTimer) {
                            clearTimeout(self.readRetryTimer);
                        }
                        self.readRetryTimer = setTimeout(() => {
                            self.readRetryTimer = null;
                            self.performReadData(true);
                        }, READ_RETRY_DELAY_MS);
                    } else {
                        self.writeLog(
                            'Reading data unsuccessful, giving up after ' + self.maxRetries + ' attempts'
                        );
                        self.forceReadSessionRecovery('read give-up');
                    }
                } else {
                    self.writeLog('Reading data was successful');
                    self.successtime = new Date();
                    self.readInProgress = false;
                    self.readSessionStartTime = 0;
                    am43.busyDevice = null;
                    self.currentRetry = 0;
                    self.emit('stateChanged', self.getState());
                }
            };

            if (releaseDelayMs > 0) {
                self.writeLog('holding BLE lock for recovery cooldown ' + releaseDelayMs + 'ms');
                am43.bleCooldownUntil = Date.now() + releaseDelayMs;
                setTimeout(releaseSession, releaseDelayMs);
            } else {
                releaseSession();
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
                        self.writeLog('Reading data completed');
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
        const command = describeCommandKey(key);
        this.writeQueue.push({ handle, key });
        this.writeLog(
            'write queued: ' + command + ' (handle=0x' + handle.toString(16) +
            ', depth=' + this.writeQueue.length + ', inProgress=' + this.writeInProgress + ')'
        );
        this.processWriteQueue();
    }

    /** Processes queued write requests one-by-one per device instance. */
    processWriteQueue() {
        if (this.writeInProgress) {
            if (this.writeQueue.length > 0) {
                this.writeLog('write queue waiting: command in progress, depth=' + this.writeQueue.length);
            }
            return;
        }

        if (this.writeQueue.length === 0) {
            return;
        }

        am43.tryClearStaleBusy();

        if (am43.isBleCooldownActive()) {
            this.writeLog(
                'write queue blocked: BLE recovery cooldown (' + am43.getBleCooldownRemainingMs() + 'ms remaining)'
            );
            setTimeout(() => {
                this.processWriteQueue();
            }, 1000);
            return;
        }

        if (am43.busyDevice != null && am43.busyDevice.id !== this.id) {
            this.writeLog(
                'write queue blocked: other device holds BLE lock ' +
                deviceTag(am43.busyDevice.id) + ' (' + am43.busyDevice.id + ')'
            );
            setTimeout(() => {
                this.processWriteQueue();
            }, 1000);
            return;
        }

        const nextWrite = this.writeQueue.shift();
        const command = describeCommandKey(nextWrite.key);
        this.writeInProgress = true;
        this.writeRetry = 0;
        this.writeLog(
            'write queue dispatch: ' + command + ' (remaining=' + this.writeQueue.length + ')'
        );
        this.performWriteKey(nextWrite.handle, nextWrite.key, () => {
            this.writeLog('write queue item finished: ' + command);
            this.writeInProgress = false;
            this.processWriteQueue();
        });
    }

    /** Connects, writes a hex key to the given GATT handle, disconnects, retries on failure. */
    performWriteKey(handle, key, onDone) {
        const command = describeCommandKey(key);
        const self = this;

        if (this.writeRetry >= WRITE_MAX_RETRIES) {
            this.writeLog('write unsuccessful, giving up after ' + WRITE_MAX_RETRIES + ' attempts');
            this.logBleContext('write-give-up');
            this.writeRetry = 0;
            am43.busyDevice = null;
            if (typeof onDone === 'function') {
                onDone();
            }
            return;
        }

        this.cleanupPeripheralConnectDisconnectListeners();
        this.logBleContext('write-attempt');
        this.writeLog(
            'write starting: ' + command + ' (handle=0x' + handle.toString(16) +
            ', attempt=' + (this.writeRetry + 1) + '/' + WRITE_MAX_RETRIES + ')'
        );
        this.success = false;
        am43.busyDevice = this;
        this.peripheral.connect();
        this.peripheral.once('connect', handleDeviceConnected);
        this.peripheral.once('disconnect', disconnectMe);

        function clearWriteSession() {
            if (am43.busyDevice === self) {
                am43.busyDevice = null;
            }
        }

        function handleDeviceConnected() {
            self.connecttime = new Date();
            self.writeLog('AM43 connected');
            self.peripheral.writeHandle(handle, Buffer.from(key, "hex"), true, handleWriteDone);
        }

        function disconnectMe() {
            self.writeLog(
                'disconnected (success=' + self.success +
                ', peripheral=' + self.getPeripheralState() + ')'
            );
            if (self.success === false) {
                if (self.writeRetry < WRITE_MAX_RETRIES) {
                    self.writeRetry = self.writeRetry + 1;
                    self.writeLog(
                        'write unsuccessful, retrying in 1s (' + self.writeRetry + '/' + WRITE_MAX_RETRIES + ')'
                    );
                    setTimeout(() => {
                        self.performWriteKey(handle, key, onDone);
                    }, 1000);
                } else {
                    self.writeLog('write unsuccessful, giving up after ' + WRITE_MAX_RETRIES + ' attempts');
                    self.logBleContext('write-give-up');
                    clearWriteSession();
                    self.writeRetry = 0;
                    if (typeof onDone === 'function') {
                        onDone();
                    }
                }
            } else {
                self.writeLog('write succeeded');
                self.logBleContext('write-success');
                clearWriteSession();
                self.writeRetry = 0;
                self.emit('stateChanged', self.getState());
                self.scheduleForcedDataRead();
                if (typeof onDone === 'function') {
                    onDone();
                }
            }
        }

        function handleWriteDone(error) {
            if (error) {
                self.writeLog('write GATT error: ' + error);
            } else {
                self.writeLog('key written');
                self.success = true;
            }

            setTimeout(() => {
                try {
                    self.peripheral.disconnect();
                } catch (e) {
                    self.writeLog('disconnect() failed: ' + e.message);
                }
            }, 1000);
        }
    }

    /**
     * Starts this device: initial read after 9s, then periodic readData on a unique interval.
     * @param {number} poll - Minutes from CLI --interval; 0 = random 10–20 min per device
     */
    am43Init(poll = 0) {
        const self = this;
        const slot = am43.initSlot++;

        this.writeLog('driver v' + DRIVER_VERSION + ', disconnect fallback ' + DISCONNECT_FALLBACK_MODE + ', read dedup ' + READ_DEDUP_WINDOW_MS + 'ms');

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
        this.writeLog('scheduling forced reads at +9s and +' + ((fullMovingTime + 10000) / 1000) + 's');
        setTimeout(() => {
            self.readData();
        }, 9000);

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
module.exports.READ_DEDUP_WINDOW_MS = READ_DEDUP_WINDOW_MS;
module.exports.BLE_RECOVERY_COOLDOWN_MS = BLE_RECOVERY_COOLDOWN_MS;


