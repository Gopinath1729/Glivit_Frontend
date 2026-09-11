import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptMatchedCoordinate,
  buildTraceRecord,
  checkCoordinate,
  coverageLimitsFor,
  GPS_ACQUISITION,
  GPS_LIMITS,
  GpsAcquisitionGate,
  GpsRollingWindow,
  haversineMeters,
  segmentConnectivity,
  splitOnInvalidVertices,
  toFiniteNumber,
  validateGpsSample,
} from './gpsPipeline.ts';

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
/** ~1.11 m of latitude. */
const METRE = 1 / 111_320;
const NOW = Date.parse('2026-09-01T10:00:00Z');

function at(metresNorth, metresEast = 0) {
  return {
    latitude: BASE_LAT + metresNorth * METRE,
    longitude: BASE_LNG + metresEast * METRE,
  };
}

function raw({
  metresNorth = 0,
  metresEast = 0,
  timestampMs = NOW,
  accuracyMeters = 5,
  deviceSpeedKmh = 40,
  reportedHeading = null,
  latitude,
  longitude,
} = {}) {
  const coordinate = at(metresNorth, metresEast);
  return {
    vehicleId: 7,
    timestampMs,
    latitude: latitude ?? coordinate.latitude,
    longitude: longitude ?? coordinate.longitude,
    accuracyMeters,
    deviceSpeedKmh,
    reportedHeading,
    source: 'stream',
  };
}

function anchor({ metresNorth = 0, metresEast = 0, timestampMs = NOW - 3_000, bearing = 0 } = {}) {
  const coordinate = at(metresNorth, metresEast);
  return {
    raw: coordinate,
    display: coordinate,
    timestampMs,
    bearing,
    speedKmh: 40,
    ignition: true,
  };
}

// ------------------------------------------------------------ coercion

test('coordinates arriving as strings are converted exactly once', () => {
  assert.equal(toFiniteNumber('12.9716'), 12.9716);
  assert.equal(toFiniteNumber(' 77.5946 '), 77.5946);
  assert.equal(toFiniteNumber(''), null);
  assert.equal(toFiniteNumber('not a number'), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(Number.NaN), null);
  assert.equal(toFiniteNumber(Number.POSITIVE_INFINITY), null);

  const check = checkCoordinate('12.9716', '77.5946');
  assert.equal(check.valid, true);
  assert.deepEqual(check.coordinate, { latitude: 12.9716, longitude: 77.5946 });
});

test('every malformed coordinate is refused, each with its own reason', () => {
  assert.deepEqual(checkCoordinate(null, 77), { valid: false, reason: 'missing' });
  assert.deepEqual(checkCoordinate(undefined, 77), { valid: false, reason: 'missing' });
  assert.deepEqual(checkCoordinate(Number.NaN, 77), { valid: false, reason: 'not_a_number' });
  assert.deepEqual(checkCoordinate({}, 77), { valid: false, reason: 'not_a_number' });
  assert.deepEqual(checkCoordinate(0, 0), { valid: false, reason: 'null_island' });
  assert.deepEqual(checkCoordinate(12.97, 200), { valid: false, reason: 'out_of_range' });
  assert.deepEqual(checkCoordinate(200, 300), { valid: false, reason: 'out_of_range' });
});

test('a structurally impossible axis swap is named on the fix alone', () => {
  // A latitude of 177 cannot be anything but a longitude in the wrong slot.
  assert.deepEqual(checkCoordinate(177.5946, 12.9716), {
    valid: false,
    reason: 'axes_reversed',
  });

  const decision = validateGpsSample({
    raw: raw({ latitude: 177.5946, longitude: 12.9716 }),
    previous: null,
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'coordinate_axes_reversed');
});

test('an in-range axis swap is named against the previous accepted fix', () => {
  // Bengaluru transposed is (77.59, 12.97) - a real coordinate in northern
  // Canada, so no range check can see it. Against a vehicle that was in
  // Bengaluru a second ago, it can only be a transposition.
  const decision = validateGpsSample({
    raw: raw({ latitude: BASE_LNG, longitude: BASE_LAT, timestampMs: NOW }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(
    decision.reason,
    'coordinate_axes_reversed',
    'reported as a transposition, not as a mysterious GPS jump'
  );
});

test('a genuine long-distance jump is still reported as a jump, not a swap', () => {
  const decision = validateGpsSample({
    // Same hemisphere, nowhere near a transposition of the previous fix.
    raw: raw({ latitude: BASE_LAT + 8, longitude: BASE_LNG + 8, timestampMs: NOW }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'impossible_jump');
});

// ------------------------------------------------------------ ordering

test('duplicate, stale and out-of-order fixes never move the vehicle', () => {
  const previous = anchor({ timestampMs: NOW });

  assert.equal(
    validateGpsSample({ raw: raw({ timestampMs: NOW }), previous, now: NOW }).reason,
    'duplicate_timestamp'
  );
  assert.equal(
    validateGpsSample({ raw: raw({ timestampMs: NOW - 1 }), previous, now: NOW }).reason,
    'out_of_order'
  );
  assert.equal(
    validateGpsSample({
      raw: raw({ timestampMs: NOW - GPS_LIMITS.maxFixAgeMs - 1 }),
      previous: null,
      now: NOW,
    }).reason,
    'stale_timestamp'
  );
  assert.equal(
    validateGpsSample({
      raw: raw({ timestampMs: NOW + GPS_LIMITS.maxFutureSkewMs + 1 }),
      previous: null,
      now: NOW,
    }).reason,
    'future_timestamp'
  );
});

test('the same coordinate arriving twice in the same instant is a duplicate', () => {
  const previous = anchor({ timestampMs: NOW - 500 });
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 0, timestampMs: NOW }),
    previous,
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'duplicate_coordinate');
});

// ------------------------------------------------------------ accuracy

test('a fix whose uncertainty covers several streets may not place a vehicle on one', () => {
  assert.equal(
    validateGpsSample({
      raw: raw({ accuracyMeters: GPS_LIMITS.maxAccuracyMeters + 1 }),
      previous: null,
      now: NOW,
    }).reason,
    'poor_accuracy'
  );
  assert.equal(
    validateGpsSample({ raw: raw({ accuracyMeters: -1 }), previous: null, now: NOW }).reason,
    'invalid_accuracy'
  );
  // Usable, but reported as degraded so the operator sees why the marker is soft.
  const low = validateGpsSample({
    raw: raw({ accuracyMeters: GPS_LIMITS.lowAccuracyMeters + 1 }),
    previous: null,
    now: NOW,
  });
  assert.equal(low.accepted, true);
  assert.equal(low.point.quality, 'low_accuracy');
});

// ------------------------------------------------------------ physics

test('an impossible jump is rejected however fast the device claims to be going', () => {
  // 400 m in one second is 1440 km/h.
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 400, timestampMs: NOW, deviceSpeedKmh: 120 }),
    previous: anchor({ timestampMs: NOW - 1_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'impossible_jump');
});

test('a device reporting a high speed cannot raise its own jump ceiling', () => {
  // The old rule was max(220, deviceSpeed * 2.2 + 40) capped at 360: a device
  // claiming 145 km/h admitted a 359 km/h chord. 250 m in 3 s is 300 km/h.
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 250, timestampMs: NOW, deviceSpeedKmh: 145 }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'impossible_jump');
});

test('a long step that arrives slowly enough to pass the speed check is still refused', () => {
  // 1 km in 60 s is 60 km/h - entirely plausible as a speed, and entirely
  // implausible as an OBSERVED stretch of road, because nothing was reported
  // in between. This is the case a speed ceiling alone cannot catch.
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 1_000, timestampMs: NOW, deviceSpeedKmh: 60 }),
    previous: anchor({ timestampMs: NOW - 60_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'implausible_step');
});

test('normal driving is accepted and measured', () => {
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 50, timestampMs: NOW, deviceSpeedKmh: 60 }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.point.held, false);
  assert.ok(Math.abs(decision.point.distanceMeters - 50) < 1);
  assert.equal(decision.point.deltaSeconds, 3);
  assert.ok(Math.abs(decision.point.calculatedSpeedKph - 60) < 2);
  // Travelling due north.
  assert.ok(decision.point.bearing < 1 || decision.point.bearing > 359);
});

// ------------------------------------------------------- stationary drift

test('a parked vehicle wandering inside the drift radius contributes no distance', () => {
  const previous = anchor({ timestampMs: NOW - 10_000 });
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 8, metresEast: 6, timestampMs: NOW, deviceSpeedKmh: 0 }),
    previous,
    now: NOW,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.point.held, true, 'held at the previous coordinate');
  assert.equal(decision.point.distanceMeters, 0, 'a held fix adds no travelled distance');
  assert.equal(decision.point.speedKmh, 0);
  assert.deepEqual(decision.point.coordinate, previous.raw, 'drawn where it was, not where it drifted');
});

test('a held fix never turns the vehicle', () => {
  const previous = anchor({ timestampMs: NOW - 10_000, bearing: 90 });
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 10, timestampMs: NOW, deviceSpeedKmh: 0, reportedHeading: 270 }),
    previous,
    now: NOW,
  });
  assert.equal(decision.point.bearing, 90, 'the heading is frozen, so drift cannot spin a parked marker');
});

test('a settled vehicle needs more than one sample to be believed about a departure', () => {
  const window = new GpsRollingWindow();
  const parked = at(0);
  for (let i = 5; i >= 1; i -= 1) {
    // Five consecutive fixes inside the drift radius, all reporting zero.
    window.push(at(i % 3), NOW - i * 1_000, 0);
  }
  assert.equal(window.isSettled(), true);
  assert.ok(window.spreadMeters() <= GPS_LIMITS.stationaryDriftMeters);

  const decision = validateGpsSample({
    // 100 m in 3 s is 120 km/h - inside every physical limit, so nothing but
    // the window's own evidence can refuse it - while the device still reports
    // a stopped vehicle.
    raw: raw({ metresNorth: 100, timestampMs: NOW, deviceSpeedKmh: 0 }),
    previous: { ...anchor({ timestampMs: NOW - 3_000 }), raw: parked, display: parked },
    window,
    now: NOW,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'isolated_spike');
});

test('pulling away from rest at a crawl is accepted immediately', () => {
  const window = new GpsRollingWindow();
  for (let i = 5; i >= 1; i -= 1) window.push(at(0), NOW - i * 1_000, 0);

  const decision = validateGpsSample({
    // 20 m in 3 s is 24 km/h with the device now reporting movement.
    raw: raw({ metresNorth: 20, timestampMs: NOW, deviceSpeedKmh: 20 }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    window,
    now: NOW,
  });
  assert.equal(decision.accepted, true, 'a vehicle moving off must never be shown as parked');
  assert.equal(decision.point.held, false);
});

// -------------------------------------------------------- coverage gaps

test('a fix after a telemetry silence is flagged so the polyline can break', () => {
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 300, timestampMs: NOW, deviceSpeedKmh: 40 }),
    previous: anchor({ timestampMs: NOW - 45_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, true, 'the fix itself is fine; only the line between is unknown');
  assert.equal(decision.point.gapBefore, true);
});

test('a parked vehicle going quiet does not open a coverage gap', () => {
  const decision = validateGpsSample({
    raw: raw({ metresNorth: 3, timestampMs: NOW, deviceSpeedKmh: 0 }),
    previous: anchor({ timestampMs: NOW - 120_000 }),
    now: NOW,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.point.held, true);
  assert.equal(decision.point.gapBefore, false, 'nothing was missed - it did not move');
});

// ------------------------------------------------- segment connectivity

test('a segment across a telemetry silence is never drawn', () => {
  assert.deepEqual(
    segmentConnectivity({
      previousTimestampMs: NOW - 45_000,
      currentTimestampMs: NOW,
      distanceMeters: 300,
    }),
    { connect: false, reason: 'telemetry_gap' }
  );
});

test('a segment longer than any observed stretch of road is never drawn', () => {
  assert.deepEqual(
    segmentConnectivity({
      previousTimestampMs: NOW - 15_000,
      currentTimestampMs: NOW,
      distanceMeters: GPS_LIMITS.maxStepMeters + 1,
    }),
    { connect: false, reason: 'excessive_step' }
  );
});

test('a segment implying an impossible speed is never drawn', () => {
  assert.deepEqual(
    segmentConnectivity({
      previousTimestampMs: NOW - 1_000,
      currentTimestampMs: NOW,
      distanceMeters: 100,
    }),
    { connect: false, reason: 'impossible_speed' }
  );
});

test('ordinary consecutive fixes are joined', () => {
  assert.deepEqual(
    segmentConnectivity({
      previousTimestampMs: NOW - 3_000,
      currentTimestampMs: NOW,
      distanceMeters: 50,
    }),
    { connect: true }
  );
});

test('an unusable vertex breaks a run instead of joining its neighbours', () => {
  const runs = splitOnInvalidVertices([
    at(0),
    at(50),
    { latitude: Number.NaN, longitude: Number.NaN },
    at(400),
    at(450),
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 2);
  assert.equal(runs[1].length, 2);
});

// ---------------------------------------------------------- road matching

test('a low-confidence or distant snap is refused and the reported fix stands', () => {
  const validated = validateGpsSample({
    raw: raw({ metresNorth: 50, timestampMs: NOW }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  }).point;

  const lowConfidence = acceptMatchedCoordinate(
    validated,
    { ...at(50, 10), confidence: 0.05, source: 'SOLVED' },
    null
  );
  assert.equal(lowConfidence.onRoad, false);
  assert.deepEqual(lowConfidence.coordinate, validated.coordinate);

  const tooFar = acceptMatchedCoordinate(
    validated,
    { ...at(50, GPS_LIMITS.maxSnapDistanceMeters + 20), confidence: 0.9, source: 'SOLVED' },
    null
  );
  assert.equal(tooFar.onRoad, false, 'the nearest road is not necessarily this vehicle’s road');
});

test('a carried correction keeps the line on the road while the router is throttled', () => {
  const validated = validateGpsSample({
    raw: raw({ metresNorth: 50, timestampMs: NOW }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  }).point;

  // The backend applied the previous solve's offset. It carries no confidence,
  // because it is not a new measurement - but it IS road-continuous, and the
  // old client dropped back to the raw fix here, which is the saw-tooth.
  const carried = acceptMatchedCoordinate(
    validated,
    { ...at(50, 8), confidence: null, source: 'CARRIED' },
    null
  );
  assert.equal(carried.onRoad, true);
  assert.equal(carried.confidence, null);
  assert.ok(carried.snapDistanceMeters > 0);

  // ...but only while it still describes this stretch of road.
  const stretched = acceptMatchedCoordinate(
    validated,
    { ...at(50, GPS_LIMITS.maxCarriedSnapMeters + 10), confidence: null, source: 'CARRIED' },
    null
  );
  assert.equal(stretched.onRoad, false);
});

test('a failed match holds the exact previous road position', () => {
  const previousDisplay = at(0, 6);
  const validated = validateGpsSample({
    raw: raw({ metresNorth: 50, timestampMs: NOW }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  }).point;

  const held = acceptMatchedCoordinate(
    validated,
    { ...previousDisplay, confidence: 0.92, source: 'HELD' },
    previousDisplay
  );

  assert.equal(held.onRoad, true);
  assert.equal(held.source, 'HELD');
  assert.deepEqual(held.coordinate, previousDisplay);
});

test('sustained travel corrects a stale tracker course', () => {
  const decision = validateGpsSample({
    raw: raw({ metresEast: 50, timestampMs: NOW, deviceSpeedKmh: 60, reportedHeading: 0 }),
    previous: anchor({ timestampMs: NOW - 3_000, bearing: 0 }),
    now: NOW,
  });
  assert.equal(decision.accepted, true);
  assert.ok(
    Math.abs(decision.point.bearing - 90) < 2,
    `expected eastbound coordinate course, got ${decision.point.bearing}`
  );
});

test('a short GPS delta cannot overrule a valid tracker course', () => {
  const decision = validateGpsSample({
    raw: raw({ metresEast: 7, timestampMs: NOW, deviceSpeedKmh: 10, reportedHeading: 15 }),
    previous: anchor({ timestampMs: NOW - 3_000, bearing: 15 }),
    now: NOW,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.point.bearing, 15);
});

test('HELD_STATIONARY is an authoritative freeze even if packet coordinates drift', () => {
  const previousDisplay = at(0, 6);
  const validated = validateGpsSample({
    raw: raw({ metresNorth: 18, timestampMs: NOW, deviceSpeedKmh: 0 }),
    previous: anchor({ timestampMs: NOW - 10_000 }),
    now: NOW,
  }).point;

  const held = acceptMatchedCoordinate(
    validated,
    { ...at(70, 40), confidence: 0.92, source: 'HELD_STATIONARY' },
    previousDisplay
  );

  assert.equal(held.onRoad, true);
  assert.equal(held.source, 'HELD_STATIONARY');
  assert.deepEqual(held.coordinate, previousDisplay);
});

test('a held fix is drawn where it was held, never moved by a road match', () => {
  const previousDisplay = at(0, 4);
  const validated = validateGpsSample({
    raw: raw({ metresNorth: 6, timestampMs: NOW, deviceSpeedKmh: 0 }),
    previous: anchor({ timestampMs: NOW - 10_000 }),
    now: NOW,
  }).point;

  const matched = acceptMatchedCoordinate(
    validated,
    { ...at(30), confidence: 0.9, source: 'SOLVED' },
    previousDisplay
  );
  assert.deepEqual(matched.coordinate, previousDisplay);
  assert.equal(matched.onRoad, false);
});

test('a backend that predates matchedSource still works', () => {
  const validated = validateGpsSample({
    raw: raw({ metresNorth: 50, timestampMs: NOW }),
    previous: anchor({ timestampMs: NOW - 3_000 }),
    now: NOW,
  }).point;

  const solved = acceptMatchedCoordinate(
    validated,
    { ...at(50, 8), confidence: 0.8, source: null },
    null
  );
  assert.equal(solved.onRoad, true, 'a confidence with no source is read as a solve');

  const none = acceptMatchedCoordinate(
    validated,
    { ...at(50, 8), confidence: null, source: null },
    null
  );
  assert.equal(none.onRoad, false, 'no confidence and no source is not a match');
});

// ------------------------------------------------------------- diagnostics

test('the trace record carries every field needed to locate a bad coordinate', () => {
  const previous = anchor({ timestampMs: NOW - 1_000 });
  const badRaw = raw({ metresNorth: 400, timestampMs: NOW, deviceSpeedKmh: 0 });
  const decision = validateGpsSample({ raw: badRaw, previous, now: NOW });
  const record = buildTraceRecord({ raw: badRaw, previous, decision });

  for (const field of [
    'vehicleId',
    'timestamp',
    'rawLat',
    'rawLng',
    'accuracy',
    'deviceSpeed',
    'previousAcceptedPoint',
    'distanceMeters',
    'deltaSeconds',
    'calculatedSpeed',
    'bearing',
    'validationResult',
    'rejectionReason',
    'roadMatchedLatLng',
    'snapDistance',
    'finalRenderedLatLng',
    'deviceId',
    'outcome',
    'pipeline',
  ]) {
    assert.ok(field in record, `trace record is missing ${field}`);
  }
  assert.equal(record.validationResult, 'rejected');
  assert.equal(record.rejectionReason, 'impossible_jump');
  assert.ok(record.distanceMeters > 390);
  assert.equal(record.deltaSeconds, 1);
  assert.ok(record.calculatedSpeed > 1_000);
  assert.equal(record.outcome, 'SKIPPED');
  assert.match(record.pipeline, /^RAW .* -> REJECTED -> impossible_jump -> UNMATCHED -> SKIPPED$/);
});

test('the one-line pipeline summary names every stage of an accepted fix', () => {
  const previous = anchor({ timestampMs: NOW - 1_000 });
  const goodRaw = raw({ metresNorth: 12, timestampMs: NOW, deviceSpeedKmh: 43 });
  const decision = validateGpsSample({ raw: goodRaw, previous, now: NOW });
  assert.equal(decision.accepted, true);
  const matched = acceptMatchedCoordinate(
    decision.point,
    { ...at(12, 3), confidence: 0.9, source: 'SOLVED' },
    previous.display
  );
  const record = buildTraceRecord({
    raw: goodRaw,
    previous,
    decision,
    matched,
    deviceId: 42,
    outcome: 'LIVE_APPENDED',
  });
  assert.equal(record.deviceId, 42);
  assert.match(record.pipeline, /^RAW .* -> ACCEPTED -> MATCHED\(SOLVED\) .* -> LIVE_APPENDED$/);
});

test('a held fix is reported as accepted but appended to nothing', () => {
  const previous = anchor({ timestampMs: NOW - 1_000, speedKmh: 0 });
  // Inside the drift radius, with the device reporting a stop: parked wander.
  const drift = raw({ metresNorth: 3, timestampMs: NOW, deviceSpeedKmh: 0 });
  const decision = validateGpsSample({ raw: drift, previous, now: NOW });
  assert.equal(decision.accepted, true);
  assert.equal(decision.point.held, true);
  const record = buildTraceRecord({ raw: drift, previous, decision, outcome: 'SKIPPED' });
  assert.equal(record.validationResult, 'accepted_held');
  assert.match(record.pipeline, /ACCEPTED -> held_stationary_drift .* -> SKIPPED$/);
});

test('haversine agrees with a known short distance', () => {
  // 100 m of latitude, measured through the same function every stage uses.
  assert.ok(Math.abs(haversineMeters(BASE_LAT, BASE_LNG, at(100).latitude, BASE_LNG) - 100) < 0.5);
});

// ---------------------------------------------------------------------------
// Cadence.
//
// A phone samples at 1 Hz; a hardware tracker can report once every two
// minutes by design. The rules for "has coverage been lost?" and "is this step
// too long to have been observed?" mean completely different numbers for the
// two, and applying the phone's numbers to the tracker breaks its route at
// every single fix - which is not a smaller bug than the diagonal, it is the
// same bug with the sign flipped.
// ---------------------------------------------------------------------------

test('a slow-reporting tracker is judged on its own cadence, not a phone\'s', () => {
  const phone = coverageLimitsFor(1_000);
  assert.equal(phone.gapMs, GPS_LIMITS.segmentGapMs, 'a 1 Hz phone keeps the 20 s floor');
  assert.equal(phone.stepMeters, GPS_LIMITS.maxStepMeters);

  const tracker = coverageLimitsFor(120_000);
  assert.equal(tracker.gapMs, 480_000, 'two-minute cadence tolerates an eight-minute silence');
  assert.ok(
    tracker.stepMeters > 6_000,
    'and a step of however far it could have driven in two minutes'
  );
});

test('an unknown cadence falls back to the phone-scale floors', () => {
  const unknown = coverageLimitsFor(null);
  assert.equal(unknown.gapMs, GPS_LIMITS.segmentGapMs);
  assert.equal(unknown.stepMeters, GPS_LIMITS.maxStepMeters);
});

test('a two-minute tracker\'s ordinary step is not treated as a coverage gap', () => {
  // 1.5 km in 120 s is 45 km/h: this device's normal resolution, not a gap.
  assert.deepEqual(
    segmentConnectivity({
      previousTimestampMs: NOW - 120_000,
      currentTimestampMs: NOW,
      distanceMeters: 1_500,
      expectedIntervalMs: 120_000,
    }),
    { connect: true }
  );

  // The SAME step from a device that normally reports every second is a gap.
  assert.deepEqual(
    segmentConnectivity({
      previousTimestampMs: NOW - 120_000,
      currentTimestampMs: NOW,
      distanceMeters: 1_500,
      expectedIntervalMs: 1_000,
    }),
    { connect: false, reason: 'telemetry_gap' }
  );
});

test('a slow tracker that misses several of its own reports still breaks the line', () => {
  assert.deepEqual(
    segmentConnectivity({
      // Twenty minutes of silence from a two-minute tracker.
      previousTimestampMs: NOW - 1_200_000,
      currentTimestampMs: NOW,
      distanceMeters: 4_000,
      expectedIntervalMs: 120_000,
    }),
    { connect: false, reason: 'telemetry_gap' }
  );
});

test('the rolling window learns the cadence from the fixes themselves', () => {
  const window = new GpsRollingWindow();
  assert.equal(window.typicalIntervalMs(), null, 'nothing is claimed before there is evidence');
  for (let i = 4; i >= 0; i -= 1) window.push(at(i * 40), NOW - i * 30_000, 50);
  assert.equal(window.typicalIntervalMs(), 30_000);
});

test('a validated fix on a slow tracker is not flagged as following a gap', () => {
  const window = new GpsRollingWindow();
  for (let i = 5; i >= 1; i -= 1) window.push(at(i * 1_000), NOW - i * 120_000, 45);

  const decision = validateGpsSample({
    // 500 m on from the previous fix, two minutes later: its normal step.
    raw: raw({ metresNorth: 500, timestampMs: NOW, deviceSpeedKmh: 45 }),
    previous: anchor({ timestampMs: NOW - 120_000 }),
    window,
    now: NOW,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.point.gapBefore, false);
});

// ------------------------------------------------------------- acquisition

/** A raw fix for the warm-up gate, at `metresNorth`/`metresEast` from base. */
function warmupFix(offsetMs, metresNorth = 0, metresEast = 0, accuracyMeters = 8) {
  const coordinate = at(metresNorth, metresEast);
  return {
    vehicleId: 7,
    timestampMs: NOW + offsetMs,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    accuracyMeters,
    deviceSpeedKmh: null,
    reportedHeading: null,
    source: 'device',
  };
}

test('the warm-up gate refuses the first fix and every fix before the run is complete', () => {
  const gate = new GpsAcquisitionGate();
  for (let i = 0; i < GPS_ACQUISITION.minSamples - 1; i += 1) {
    const verdict = gate.offer(warmupFix(i * 1_000), NOW + i * 1_000);
    assert.equal(verdict.state, 'acquiring', `sample ${i} must not complete warm-up`);
    assert.equal(gate.isAcquired, false);
  }
  const last = GPS_ACQUISITION.minSamples - 1;
  const final = gate.offer(warmupFix(last * 1_000), NOW + last * 1_000);
  assert.equal(final.state, 'acquired');
  assert.equal(gate.isAcquired, true);
});

test('once acquired the gate never gates again', () => {
  const gate = new GpsAcquisitionGate();
  for (let i = 0; i < GPS_ACQUISITION.minSamples; i += 1) {
    gate.offer(warmupFix(i * 1_000), NOW + i * 1_000);
  }
  // A fix that would have failed warm-up outright still passes now: after
  // acquisition the steady-state validator owns the decision, and running two
  // sets of rules over one fix is what the shared pipeline exists to prevent.
  const after = gate.offer(warmupFix(10_000, 0, 0, 999), NOW + 10_000);
  assert.equal(after.state, 'acquired');
});

test('a cold receiver reporting poor accuracy never completes warm-up', () => {
  const gate = new GpsAcquisitionGate();
  for (let i = 0; i < 10; i += 1) {
    const verdict = gate.offer(
      warmupFix(i * 1_000, 0, 0, GPS_ACQUISITION.maxAccuracyMeters + 5),
      NOW + i * 1_000
    );
    assert.equal(verdict.state, 'acquiring');
    assert.equal(verdict.reason, 'poor_accuracy');
  }
  assert.equal(gate.isAcquired, false);
});

test('one disagreeing sample resets the run rather than counting toward it', () => {
  const gate = new GpsAcquisitionGate();
  gate.offer(warmupFix(0), NOW);
  gate.offer(warmupFix(1_000), NOW + 1_000);
  assert.equal(gate.sampleCount, 2);
  // 5 km sideways in one second: the classic cold-start excursion.
  const spike = gate.offer(warmupFix(2_000, 5_000), NOW + 2_000);
  assert.equal(spike.state, 'acquiring');
  assert.equal(spike.reason, 'implausible_step');
  assert.equal(gate.sampleCount, 0, 'the run restarts, it does not merely skip the bad sample');
});

test('warm-up completes for a phone that starts tracking in a moving car', () => {
  const gate = new GpsAcquisitionGate();
  // 100 km/h is ~27.8 m per second. No fixed movement threshold is involved:
  // the rule is a speed, so walking, cycling and driving all satisfy it.
  let verdict;
  for (let i = 0; i < GPS_ACQUISITION.minSamples; i += 1) {
    verdict = gate.offer(warmupFix(i * 1_000, i * 27.8), NOW + i * 1_000);
  }
  assert.equal(verdict.state, 'acquired');
});

test('warm-up completes at walking pace just as readily', () => {
  const gate = new GpsAcquisitionGate();
  let verdict;
  for (let i = 0; i < GPS_ACQUISITION.minSamples; i += 1) {
    // ~5 km/h.
    verdict = gate.offer(warmupFix(i * 1_000, i * 1.4), NOW + i * 1_000);
  }
  assert.equal(verdict.state, 'acquired');
});

test('a stale buffered reading is not evidence the receiver is working now', () => {
  const gate = new GpsAcquisitionGate();
  const verdict = gate.offer(
    warmupFix(0),
    NOW + GPS_ACQUISITION.maxSampleAgeMs + 1_000
  );
  assert.equal(verdict.state, 'acquiring');
  assert.equal(verdict.reason, 'stale_sample');
});

test('an out-of-order fix resets the run', () => {
  const gate = new GpsAcquisitionGate();
  gate.offer(warmupFix(2_000), NOW + 2_000);
  const backwards = gate.offer(warmupFix(1_000), NOW + 2_100);
  assert.equal(backwards.reason, 'out_of_order');
  assert.equal(gate.sampleCount, 0);
});

test('null island and NaN coordinates are refused during warm-up', () => {
  const gate = new GpsAcquisitionGate();
  const nullIsland = gate.offer(
    { ...warmupFix(0), latitude: 0, longitude: 0 },
    NOW
  );
  assert.equal(nullIsland.reason, 'invalid_coordinate');
  const notANumber = gate.offer({ ...warmupFix(1_000), latitude: Number.NaN }, NOW + 1_000);
  assert.equal(notANumber.reason, 'invalid_coordinate');
  assert.equal(gate.isAcquired, false);
});

test('the accuracy ceiling relaxes to the steady-state one, and no further', () => {
  const gate = new GpsAcquisitionGate();
  // Start the warm-up clock with a sample that is refused on accuracy.
  const tooLoose = GPS_ACQUISITION.maxAccuracyMeters + 5;
  assert.equal(gate.offer(warmupFix(0, 0, 0, tooLoose), NOW).reason, 'poor_accuracy');

  const late = NOW + GPS_ACQUISITION.maxWarmupMs;
  let verdict;
  for (let i = 0; i < GPS_ACQUISITION.minSamples; i += 1) {
    const at = late + i * 1_000;
    verdict = gate.offer({ ...warmupFix(0, 0, 0, tooLoose), timestampMs: at }, at);
  }
  assert.equal(verdict.state, 'acquired', 'a persistently 40 m receiver still starts eventually');

  const strict = new GpsAcquisitionGate();
  const beyondSteadyState = GPS_LIMITS.maxAccuracyMeters + 1;
  const veryLate = NOW + GPS_ACQUISITION.maxWarmupMs * 4;
  const refused = strict.offer(
    { ...warmupFix(0, 0, 0, beyondSteadyState), timestampMs: veryLate },
    veryLate
  );
  assert.equal(refused.reason, 'poor_accuracy', 'relaxing never goes past the steady-state ceiling');
});

test('reset returns the gate to its cold state', () => {
  const gate = new GpsAcquisitionGate();
  for (let i = 0; i < GPS_ACQUISITION.minSamples; i += 1) {
    gate.offer(warmupFix(i * 1_000), NOW + i * 1_000);
  }
  assert.equal(gate.isAcquired, true);
  gate.reset();
  assert.equal(gate.isAcquired, false);
  assert.equal(gate.sampleCount, 0);
  assert.equal(gate.offer(warmupFix(0), NOW).state, 'acquiring');
});
