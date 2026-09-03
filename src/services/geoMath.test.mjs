import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignToRoad,
  angleDeltaDeg,
  lerpAngle,
  markerRotationFor,
  normalizeHeading,
  resolveVehicleBearing,
} from './geoMath.ts';

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
const METRE = 1 / 111_320;

/** A point `metresNorth` / `metresEast` of the base coordinate. */
function at(metresNorth, metresEast = 0) {
  return {
    latitude: BASE_LAT + metresNorth * METRE,
    longitude:
      BASE_LNG + (metresEast * METRE) / Math.cos((BASE_LAT * Math.PI) / 180),
  };
}

const MOVING = { speedKmh: 40, accuracyMeters: 6 };

test('a valid device heading is preferred while the vehicle is moving', () => {
  // The phone says 90 (due east) and the coordinates agree it is moving. GPS
  // course over ground is more responsive than a two-point bearing, so it wins.
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(0, 60),
    reportedHeading: 90,
    ...MOVING,
    lastHeading: 0,
  });
  assert.ok(Math.abs(angleDeltaDeg(heading, 90)) < 1, `expected ~90, got ${heading}`);
});

test('without a device heading the bearing comes from the last two accepted points', () => {
  const north = resolveVehicleBearing({
    previous: at(0),
    ...at(60),
    reportedHeading: null,
    ...MOVING,
    lastHeading: 180,
  });
  assert.ok(Math.abs(angleDeltaDeg(north, 0)) < 2, `expected ~0 (north), got ${north}`);

  const east = resolveVehicleBearing({
    previous: at(0),
    ...at(0, 60),
    reportedHeading: null,
    ...MOVING,
    lastHeading: 180,
  });
  assert.ok(Math.abs(angleDeltaDeg(east, 90)) < 2, `expected ~90 (east), got ${east}`);
});

test('a stationary vehicle never rotates, however far its fix drifts', () => {
  // 12 m of wander with the device reporting 0 km/h. The marker must hold.
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(-12, 4),
    reportedHeading: 270,
    speedKmh: 0,
    accuracyMeters: 8,
    lastHeading: 45,
  });
  assert.equal(heading, 45);
});

test('a vehicle creeping in traffic still turns, even reporting zero km/h', () => {
  // A phone's speedometer lags badly at crawling pace, so "0 km/h" plus 40 m of
  // real travel is movement, not drift - and the COORDINATES are the witness,
  // not the course the stopped device is reporting.
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(0, 40),
    reportedHeading: 270,
    speedKmh: 0,
    accuracyMeters: 6,
    lastHeading: 0,
  });
  assert.ok(Math.abs(angleDeltaDeg(heading, 90)) < 2, `expected ~90 (east), got ${heading}`);
});

test('a fix held by the pipeline cannot turn the vehicle either', () => {
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(0, 200),
    reportedHeading: 90,
    speedKmh: 60,
    accuracyMeters: 5,
    lastHeading: 300,
    held: true,
  });
  assert.equal(heading, 300);
});

test('sub-3-metre movement is noise and holds the heading', () => {
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(2),
    reportedHeading: null,
    speedKmh: 0,
    accuracyMeters: 5,
    lastHeading: 120,
  });
  assert.equal(heading, 120);
});

test('a fix too imprecise to place on a road cannot set a direction', () => {
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(0, 80),
    reportedHeading: 90,
    speedKmh: 50,
    accuracyMeters: 120,
    lastHeading: 10,
  });
  assert.equal(heading, 10);
});

test('the road aligns a heading that already agrees with it', () => {
  // Travelling roughly east on a road that runs 88 degrees: square up to it.
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(2, 60),
    reportedHeading: null,
    ...MOVING,
    roadBearing: 88,
  });
  assert.equal(heading, 88);
});

test('a road running the other way is used in the direction of travel', () => {
  // Driving west (270) on a road the matcher describes as running east (90).
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(0, -60),
    reportedHeading: null,
    ...MOVING,
    roadBearing: 90,
  });
  assert.equal(heading, 270, 'aligned to the reverse sense, not flipped to 90');
});

test('a road the vehicle is plainly not on is ignored', () => {
  // Driving north; the matcher offers a road running east. Beyond the 45 degree
  // alignment limit, so the travelled direction stands.
  const heading = resolveVehicleBearing({
    previous: at(0),
    ...at(60),
    reportedHeading: null,
    ...MOVING,
    roadBearing: 90,
  });
  assert.ok(Math.abs(angleDeltaDeg(heading, 0)) < 2, `expected ~0, got ${heading}`);
});

test('alignToRoad leaves a direction alone when there is no road', () => {
  assert.equal(alignToRoad(217, null), 217);
  assert.equal(alignToRoad(217, undefined), 217);
  assert.equal(alignToRoad(-30, null), 330);
});

test('every heading comes back normalised to [0, 360)', () => {
  for (const reported of [-90, 0, 359.9, 360, 450, 720]) {
    const heading = resolveVehicleBearing({
      previous: at(0),
      ...at(0, 60),
      reportedHeading: reported,
      ...MOVING,
    });
    assert.ok(heading >= 0 && heading < 360, `${reported} -> ${heading}`);
  }
  assert.equal(normalizeHeading(-1), 359);
  assert.equal(normalizeHeading(360), 0);
  assert.equal(normalizeHeading(null, 12), 12);
});

test('a turn interpolates the short way round north', () => {
  // 350 -> 10 is a 20 degree right turn, not a 340 degree spin.
  assert.equal(lerpAngle(350, 10, 0.5), 0);
  assert.equal(lerpAngle(10, 350, 0.5), 0);
  assert.ok(Math.abs(angleDeltaDeg(lerpAngle(350, 10, 0.25), 355)) < 1e-6);
});

test('a right turn is followed through the intermediate bearings', () => {
  // North up a street, then east along the one it joins.
  let heading = resolveVehicleBearing({
    previous: at(0),
    ...at(40),
    reportedHeading: null,
    ...MOVING,
    lastHeading: 0,
  });
  assert.ok(Math.abs(angleDeltaDeg(heading, 0)) < 2);

  heading = resolveVehicleBearing({
    previous: at(40),
    ...at(60, 20),
    reportedHeading: null,
    ...MOVING,
    lastHeading: heading,
  });
  assert.ok(heading > 20 && heading < 70, `mid-turn heading was ${heading}`);

  heading = resolveVehicleBearing({
    previous: at(60, 20),
    ...at(60, 80),
    reportedHeading: null,
    ...MOVING,
    lastHeading: heading,
  });
  assert.ok(Math.abs(angleDeltaDeg(heading, 90)) < 2, `expected ~90, got ${heading}`);
});

test('the marker rotation applies the vehicle model offset once and normalises', () => {
  assert.equal(markerRotationFor(0), 0);
  assert.equal(markerRotationFor(90), 90);
  assert.equal(markerRotationFor(-90), 270);
  assert.equal(markerRotationFor(450), 90);
  assert.equal(markerRotationFor(null), 0);
});
