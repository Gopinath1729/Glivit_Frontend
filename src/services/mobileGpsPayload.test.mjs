import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BALANCED_HEARTBEAT_MS,
  HIGH_ACCURACY_HEARTBEAT_MS,
  heartbeatIntervalMs,
  validateMobileGpsLocation,
} from './mobileGpsPayload.ts';

const NOW = Date.parse('2026-09-01T10:00:00Z');
const BASE = { latitude: 12.9716, longitude: 77.5946, timestamp: NOW - 30_000 };

function location({
  latitude = BASE.latitude,
  longitude = BASE.longitude,
  timestamp = NOW,
  accuracy = 5,
  speed = 0,
} = {}) {
  return {
    coords: {
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude,
      longitude,
      speed,
    },
    mocked: false,
    timestamp,
  };
}

test('accepts a current accurate fix', () => {
  assert.deepEqual(validateMobileGpsLocation(location(), null, NOW), {
    accepted: true,
    stationaryDrift: false,
    deviceConfirmedStationary: true,
  });
});

test('rejects stale and duplicate device timestamps', () => {
  assert.deepEqual(
    validateMobileGpsLocation(location({ timestamp: NOW - 6 * 60_000 }), null, NOW),
    { accepted: false, reason: 'stale_timestamp' }
  );
  assert.deepEqual(
    validateMobileGpsLocation(location({ timestamp: BASE.timestamp }), BASE, NOW),
    { accepted: false, reason: 'duplicate' }
  );
  assert.deepEqual(
    validateMobileGpsLocation(location({ timestamp: BASE.timestamp - 1 }), BASE, NOW),
    { accepted: false, reason: 'stale_timestamp' }
  );
});

test('rejects fixes whose accuracy cannot identify a road', () => {
  assert.deepEqual(validateMobileGpsLocation(location({ accuracy: 51 }), null, NOW), {
    accepted: false,
    reason: 'poor_accuracy',
  });
});

test('holds stationary drift instead of adding a route vertex', () => {
  const oneMetreNorth = BASE.latitude + 1 / 111_320;
  assert.deepEqual(
    validateMobileGpsLocation(location({ latitude: oneMetreNorth, speed: 0 }), BASE, NOW),
    { accepted: true, stationaryDrift: true, deviceConfirmedStationary: true }
  );
});

/**
 * "The phone did not tell me its speed" is not "the vehicle is parked".
 *
 * Android's fused provider omits `coords.speed` routinely while driving - it
 * needs a Doppler lock the handset may not have - and a moving vehicle's early
 * fixes are inside the anchor radius until it has covered twenty metres. Reading
 * the two together as a stop threw away the distinction the collector uses to
 * decide whether to spend a radio transmission, so a car pulling away uploaded
 * once every ten seconds at exactly the moment the map most needed it.
 */
test('an unknown device speed is never reported as a confirmed stop', () => {
  const tenMetresNorth = BASE.latitude + 10 / 111_320;
  const decision = validateMobileGpsLocation(
    location({ latitude: tenMetresNorth, speed: null, timestamp: BASE.timestamp + 1_000 }),
    BASE,
    NOW
  );

  assert.equal(decision.accepted, true);
  // Still held: ten metres is inside the anchor radius, and the coordinate may
  // not move the vehicle until it leaves.
  assert.equal(decision.stationaryDrift, true);
  // But nothing here says the vehicle is stopped, so nothing may be throttled.
  assert.equal(decision.deviceConfirmedStationary, false);
});

test('a device reporting real movement is neither held nor called stationary', () => {
  const thirtyMetresNorth = BASE.latitude + 30 / 111_320;
  const decision = validateMobileGpsLocation(
    location({ latitude: thirtyMetresNorth, speed: 30 / 3.6, timestamp: BASE.timestamp + 3_000 }),
    BASE,
    NOW
  );

  assert.deepEqual(decision, {
    accepted: true,
    stationaryDrift: false,
    deviceConfirmedStationary: false,
  });
});

test('rejects a physically impossible jump', () => {
  assert.deepEqual(
    validateMobileGpsLocation(location({ latitude: BASE.latitude + 0.1, speed: 30 }), BASE, NOW),
    { accepted: false, reason: 'impossible_jump' }
  );
});

// --------------------------------------------------------------- heartbeat

test('both collectors read the stationary heartbeat from one place', () => {
  // The foreground tracker honoured this rate and the background task did not,
  // so a parked phone with the app off screen uploaded at the full 1 Hz
  // sampling rate. Sharing one definition is what stops the two drifting again.
  assert.equal(heartbeatIntervalMs('high'), HIGH_ACCURACY_HEARTBEAT_MS);
  assert.equal(heartbeatIntervalMs('balanced'), BALANCED_HEARTBEAT_MS);
});

test('a parked phone uploads far less often than it samples', () => {
  // Sampling is 1 Hz in both modes. Whatever the heartbeat is, it has to be a
  // large multiple of that or the throttle is not doing anything.
  const SAMPLE_MS = 1_000;
  assert.ok(heartbeatIntervalMs('high') >= SAMPLE_MS * 5);
  assert.ok(heartbeatIntervalMs('balanced') >= heartbeatIntervalMs('high'));
});
