import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRoadPolyline,
  clipPolylineTail,
  polylineUpTo,
  positionAtDistance,
} from './roadPolyline.ts';

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
/** ~1 m of latitude. */
const METRE = 1 / 111_320;

function at(metresNorth, metresEast = 0) {
  return {
    latitude: BASE_LAT + metresNorth * METRE,
    longitude: BASE_LNG + metresEast * (METRE / Math.cos((BASE_LAT * Math.PI) / 180)),
  };
}

/** Metres between two coordinates, independently of the module under test. */
function metres(a, b) {
  const R = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Perpendicular distance from a point to a polyline, in metres.
 *
 * This is the assertion that matters for every animation test below: "the
 * vehicle is ON the road" is exactly "its distance to the road polyline is
 * zero", and the old component-wise interpolation fails it by tens of metres at
 * a corner while passing every endpoint check.
 */
function distanceToPolyline(point, vertices) {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length - 1; index += 1) {
    const a = vertices[index];
    const b = vertices[index + 1];
    const scale = Math.cos((point.latitude * Math.PI) / 180);
    const ax = a.longitude * scale;
    const ay = a.latitude;
    const bx = b.longitude * scale;
    const by = b.latitude;
    const px = point.longitude * scale;
    const py = point.latitude;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
        : 0;
    const closest = {
      latitude: ay + dy * t,
      longitude: (ax + dx * t) / scale,
    };
    best = Math.min(best, metres(point, closest));
  }
  return best;
}

test('a 90-degree turn is driven as an L, never as the diagonal', () => {
  // The corner: 100 m north, then 100 m east. The two ENDPOINTS are both on the
  // road; the straight line between them is not - it cuts the corner by ~29 m,
  // which at a junction is the building on the inside of the turn.
  const corner = at(100, 0);
  const geometry = [at(0, 0), corner, at(100, 100)];
  const polyline = buildRoadPolyline(geometry);

  assert.ok(Math.abs(polyline.lengthMeters - 200) < 3, 'the L is ~200 m, not the ~141 m chord');

  // Every frame of the animation, at 5 % steps.
  let maxOffRoad = 0;
  let previousDistance = -1;
  for (let step = 0; step <= 20; step += 1) {
    const travelled = polyline.lengthMeters * (step / 20);
    const at_ = positionAtDistance(polyline, travelled);
    maxOffRoad = Math.max(maxOffRoad, distanceToPolyline(at_.coordinate, geometry));
    // Progress only ever moves forward.
    assert.ok(travelled >= previousDistance);
    previousDistance = travelled;
  }
  assert.ok(maxOffRoad < 0.5, `marker stayed on the road (max ${maxOffRoad.toFixed(2)} m off)`);

  // The midpoint of the L is the corner itself. Component-wise interpolation
  // would put it ~29 m inside the turn instead.
  const midpoint = positionAtDistance(polyline, polyline.lengthMeters / 2).coordinate;
  assert.ok(
    metres(midpoint, corner) < 1,
    'half way along the L is the corner, not the middle of the chord'
  );
  const chordMidpoint = {
    latitude: (geometry[0].latitude + geometry[2].latitude) / 2,
    longitude: (geometry[0].longitude + geometry[2].longitude) / 2,
  };
  assert.ok(
    metres(chordMidpoint, corner) > 25,
    'the fixture really does distinguish the two: the chord midpoint is far off the corner'
  );
});

test('the heading turns with the road rather than pointing at the destination', () => {
  const polyline = buildRoadPolyline([at(0, 0), at(100, 0), at(100, 100)]);
  const onFirstLeg = positionAtDistance(polyline, 50);
  const onSecondLeg = positionAtDistance(polyline, 150);

  assert.ok(Math.abs(onFirstLeg.heading - 0) < 2, 'heading north on the first leg');
  assert.ok(Math.abs(onSecondLeg.heading - 90) < 2, 'heading east after the corner');
});

test('a curved road is followed vertex by vertex at every sampled frame', () => {
  // A quarter-circle of radius 100 m, sampled every 5 degrees.
  const geometry = [];
  for (let degrees = 0; degrees <= 90; degrees += 5) {
    const radians = (degrees * Math.PI) / 180;
    geometry.push(at(100 * Math.sin(radians), 100 - 100 * Math.cos(radians)));
  }
  const polyline = buildRoadPolyline(geometry);

  let maxOffRoad = 0;
  for (let step = 0; step <= 60; step += 1) {
    const at_ = positionAtDistance(polyline, polyline.lengthMeters * (step / 60));
    maxOffRoad = Math.max(maxOffRoad, distanceToPolyline(at_.coordinate, geometry));
  }
  assert.ok(maxOffRoad < 0.5, `animation stayed on the curve (max ${maxOffRoad.toFixed(2)} m)`);
});

test('progress is clamped to the geometry and never extrapolates past it', () => {
  const polyline = buildRoadPolyline([at(0, 0), at(100, 0)]);
  const before = positionAtDistance(polyline, -500);
  const after = positionAtDistance(polyline, 5_000);

  assert.ok(metres(before.coordinate, at(0, 0)) < 0.5);
  assert.ok(metres(after.coordinate, at(100, 0)) < 0.5);
});

test('the drawn route is clipped to end exactly at the vehicle', () => {
  const geometry = [at(0, 0), at(100, 0), at(100, 100)];
  const polyline = buildRoadPolyline(geometry);
  const travelled = 150;

  const marker = positionAtDistance(polyline, travelled).coordinate;
  const drawn = polylineUpTo(polyline, travelled);
  const tail = drawn[drawn.length - 1];

  assert.ok(metres(marker, tail) < 0.5, 'the line ends at the marker');
  // And the untravelled remainder is genuinely absent, rather than the whole
  // road being drawn with the marker somewhere in the middle of it.
  assert.ok(metres(tail, at(100, 100)) > 40, 'the road ahead of the vehicle is not drawn');
});

test('clipping the tail removes exactly the untravelled distance', () => {
  const vertices = [at(0, 0), at(100, 0), at(100, 100)];
  const clipped = clipPolylineTail(vertices, 50);

  const total = metres(clipped[0], clipped[1]) + metres(clipped[1], clipped[2]);
  assert.ok(Math.abs(total - 150) < 1, `kept ~150 m of the 200 m road, got ${total.toFixed(1)}`);
  assert.ok(
    metres(clipped[clipped.length - 1], at(100, 50)) < 1,
    'the new end is the interpolated point, not the vertex before it'
  );
});

test('clipping never returns a fragment that could be drawn backwards', () => {
  const vertices = [at(0, 0), at(100, 0)];
  // Remove more than the polyline is long.
  const clipped = clipPolylineTail(vertices, 5_000);
  assert.ok(clipped.length <= 1, 'nothing drawable is left, rather than a reversed stub');
});

test('duplicate vertices are collapsed so no segment has an undefined bearing', () => {
  const polyline = buildRoadPolyline([at(0, 0), at(0, 0), at(0, 0), at(100, 0)]);
  assert.equal(polyline.vertices.length, 2);
  assert.ok(Math.abs(polyline.lengthMeters - 100) < 1);
});
