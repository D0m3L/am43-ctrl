/*
 * am43 MQTT connector — version 1.2 (2026-06-24 17:00 CEST)
 *
 * v1.2 (2026-06-24 17:00 CEST):
 * - Pairs with src/am43.js v1.2
 * - MQTT per-device command dedup window (3000ms)
 * - Verbose logging: rx topic/payload, dedup accept/drop, dispatch labels
 */

const mqtt = require('mqtt');

const coverTopic = 'cover/';
const sensorTopic = 'sensor/';
const MQTT_CONNECTOR_VERSION = '1.2';
const MQTT_DEDUP_WINDOW_MS = 3000;
const dedupStateByDevice = new Map();

class MQTTConnector {
    constructor(device, mqttUrl, baseTopic, username, password) {
        const mqttClient = mqtt.connect(mqttUrl, {
            will: {
                topic: `${baseTopic}${coverTopic}${device.id}/connection`,
                payload: 'Offline',
                retain: true
            },
            username: username,
            password: password
        });

        let deviceTopic = `${baseTopic}${coverTopic}${device.id}`;
        let deviceBatterySensorConfigTopic = `${baseTopic}${sensorTopic}${device.id}_battery`;
        let deviceLightSensorConfigTopic = `${baseTopic}${sensorTopic}${device.id}_light`;
        device.log('mqtt connector v%s, dedup window %dms', MQTT_CONNECTOR_VERSION, MQTT_DEDUP_WINDOW_MS);
        mqttClient.subscribe([`${deviceTopic}/set`]);
        mqttClient.subscribe([`${deviceTopic}/setposition`]);

        mqttClient.on('message', (topic, message) => {
            const payload = message.toString();
            device.log('mqtt rx topic=%s payload=%s', topic, payload);
            const now = Date.now();
            if ((topic.endsWith('set') || topic.endsWith('setposition')) && message.length !== 0) {
                const lastTimestamp = dedupStateByDevice.get(device.id) || 0;
                const elapsedMs = lastTimestamp > 0 ? now - lastTimestamp : 0;
                if (lastTimestamp > 0 && elapsedMs < MQTT_DEDUP_WINDOW_MS) {
                    device.log(
                        'mqtt dedup: dropped %s (elapsed %dms < window %dms)',
                        device.id,
                        elapsedMs,
                        MQTT_DEDUP_WINDOW_MS
                    );
                    return;
                }
                dedupStateByDevice.set(device.id, now);
                device.log(
                    'mqtt dedup: accepted %s (elapsed %dms, window %dms)',
                    device.id,
                    elapsedMs,
                    MQTT_DEDUP_WINDOW_MS
                );
            }
            if (topic.endsWith('set') && message.length !== 0) {
                const cmd = payload.toLowerCase();
                if (cmd === 'open') {
                    device.log('mqtt dispatch: OPEN');
                    device.am43Open();
                } else if (cmd === 'close') {
                    device.log('mqtt dispatch: CLOSE');
                    device.am43Close();
                } else if (cmd === 'stop') {
                    device.log('mqtt dispatch: STOP');
                    device.am43Stop();
                } else {
                    device.log('mqtt dispatch: ignored unknown set payload=%s', payload);
                }
            } else if (topic.endsWith('setposition') && message.length !== 0) {
                device.log('mqtt dispatch: SET_POSITION %s', payload);
                device.am43GotoPosition(parseInt(payload, 10));
            }
        });

        let deviceInfo = {
            identifiers: `am43_${device.id}`,
            name: device.id,
            manufacturer: 'Generic AM43'
        };

let coverConfig = {
    name: device.id,
    command_topic: `${deviceTopic}/set`,
    state_topic: `${deviceTopic}/state`,
    value_template: '{{value_json[\'state\']}}',
    state_open: 'OPEN',
    state_closed: 'CLOSE',
    position_topic: `${deviceTopic}/state`,
    position_template: '{{value_json[\'position\']}}',
    set_position_topic: `${deviceTopic}/setposition`,
    position_open: 0,
    position_closed: 100,
    availability_topic: `${deviceTopic}/connection`,
    payload_available: 'Online',
    payload_not_available: 'Offline',
    payload_open: 'OPEN',
    payload_close: 'CLOSE',
    payload_stop: 'STOP',
    unique_id: `am43_${device.id}_cover`,
    device: deviceInfo
};

        let batterySensorConfig = {
            name: device.id + ' Battery',
            state_topic: `${deviceTopic}/state`,
            availability_topic: `${deviceTopic}/connection`,
            payload_available: 'Online',
            payload_not_available: 'Offline',
            unique_id: `am43_${device.id}_battery_sensor`,
            device: deviceInfo,
            value_template: '{{value_json[\'battery\']}}',
            device_class: 'battery',
            unit_of_measurement: '%'
        };

        let lightSensorConfig = {
            name: device.id + ' Light',
            state_topic: `${deviceTopic}/state`,
            availability_topic: `${deviceTopic}/connection`,
            payload_available: 'Online',
            payload_not_available: 'Offline',
            unique_id: `am43_${device.id}_light_sensor`,
            device: deviceInfo,
            value_template: '{{value_json[\'light\']}}',
            unit_of_measurement: '%'
        };

        device.log(`mqtt topic ${deviceTopic}`);

        device.on('stateChanged', (data) => {
            const json = JSON.stringify(data);
            device.log('mqtt state publish: %s', json);
            mqttClient.publish(`${deviceTopic}/state`, json, {retain:true});
        });

        mqttClient.on('connect', () => {
            coverConfig.name = device.getState().id;
            coverConfig.device.name = device.getState().id;

            mqttClient.publish(`${deviceTopic}/config`, JSON.stringify(coverConfig), {retain: true});
            mqttClient.publish(`${deviceBatterySensorConfigTopic}/config`, JSON.stringify(batterySensorConfig), {retain: true});
            mqttClient.publish(`${deviceLightSensorConfigTopic}/config`, JSON.stringify(lightSensorConfig), {retain: true});
            mqttClient.publish(`${deviceTopic}/connection`, 'Online', {retain:true});
            device.log('mqtt connected (broker=%s, topic=%s)', mqttUrl, deviceTopic);
        });
        mqttClient.on('end', () => device.log('mqtt ended'));
        mqttClient.on('error', (e) => device.log('mqtt error %o', e));
        mqttClient.on('offline', () => device.log('mqtt offline'));
        mqttClient.on('close', () => device.log('mqtt close'));

    }
}

module.exports = MQTTConnector;

