import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlaybackTrack,
  routeSegments,
  sampleAt,
  travelledRouteSegments,
} from './playbackEngine.ts';
import {
  buildRoadFollowingPoints,
  pointsOnMatchedRoad,
  resolveMatchedRoute,
} from './matchedRoute.ts';

/**
 * The Vehicle Details -> Playback pipeline, exactly as the screen runs it.
 *
 * `useMatchedHistoryRoute` does these four calls in this order and then renders
 * the result. Everything here therefore happens DURING RENDER, which is why a
 * throw in any of it does not show an error state - it takes the app down. The
 * malformed-payload cases below are all shapes that used to do exactly that.
 */

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;

function point(index, overrides = {}) {
  return {
    t: new Date(Date.UTC(2026, 8, 1, 8, 0, index * 10)).toISOString(),
    lat: BASE_LAT + index * 0.0005,
    lng: BASE_LNG + index * 0.0005,
    speed: 30,
    speedKmh: 30,
    course: 45,
    gpsValid: true,
    ignition: true,
    ...overrides,
  };
}

/** The screen's render path, start to finish. */
function openPlayback(payload) {
  const route = resolveMatchedRoute(payload);
  const onRoad = pointsOnMatchedRoad(payload?.points ?? []);
  const densified = buildRoadFollowingPoints(onRoad, route.runs);
  const track = buildPlaybackTrack(densified, { pointsAreClean: true });
  const midway = sampleAt(track, track.totalDurationMs / 2);
  return {
    track,
    midway,
    fullRoute: routeSegments(track),
    travelled: travelledRouteSegments(track, midway),
  };
}

const straightDrive = { points: Array.from({ length: 20 }, (_, i) => point(i)) };

test('a recorded route is actually drawable', () => {
  // THE bug behind "Playback opens and shows nothing". With no matched road
  // geometry - which is every range on a deployment with no routing service -
  // every point was flagged as the start of a coverage gap, so every run was
  // one point long and `routeSegments` dropped all of them at `length >= 2`.
  const { fullRoute } = openPlayback(straightDrive);

  assert.equal(fullRoute.length, 1, 'one continuous run, not twenty single-point runs');
  assert.equal(fullRoute[0].length, 20, 'every recorded point is on the line');
});

test('the vehicle turns during playback', () => {
  // Same root cause, second symptom: `buildPlaybackTrack` refuses to take a
  // bearing across a coverage gap, so fabricating a gap at every point pinned
  // the heading to the first fix's course for the entire replay.
  const turning = {
    points: [
      point(0, { lat: BASE_LAT, lng: BASE_LNG }),
      point(1, { lat: BASE_LAT + 0.002, lng: BASE_LNG }),
      point(2, { lat: BASE_LAT + 0.004, lng: BASE_LNG }),
      point(3, { lat: BASE_LAT + 0.004, lng: BASE_LNG + 0.002 }),
      point(4, { lat: BASE_LAT + 0.004, lng: BASE_LNG + 0.004 }),
    ],
  };

  const { track } = openPlayback(turning);
  const headings = new Set(track.segmentHeadings.map((h) => Math.round(h / 10)));
  assert.ok(headings.size >= 2, `expected the marker to turn, headings were ${[...headings]}`);
});

test('Play advances the travelled route from the first point to the last', () => {
  const { track } = openPlayback(straightDrive);

  const atStart = travelledRouteSegments(track, sampleAt(track, 0));
  const atMiddle = travelledRouteSegments(track, sampleAt(track, track.totalDurationMs / 2));
  const atEnd = travelledRouteSegments(track, sampleAt(track, track.totalDurationMs));

  const covered = (segments) => segments.reduce((total, run) => total + run.length, 0);
  assert.ok(covered(atStart) < covered(atMiddle), 'progress must grow as playback runs');
  assert.ok(covered(atMiddle) < covered(atEnd), 'progress must reach the end of the route');
  assert.equal(sampleAt(track, track.totalDurationMs)?.atEnd, true);
});

test('records are replayed in timestamp order however they arrive', () => {
  const shuffled = { points: [point(5), point(1), point(3), point(0), point(2)] };
  const { track } = openPlayback(shuffled);

  const times = track.points.map((p) => Date.parse(p.t));
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'points must be sorted by time');
});

test('duplicate timestamps are collapsed rather than replayed twice', () => {
  const { track } = openPlayback({ points: [point(0), point(0), point(1)] });
  assert.equal(track.points.length, 2);
});

/**
 * Every one of these used to throw during render, which exits the app. The
 * screen must stay open and simply have nothing to play.
 */
const MALFORMED = {
  'the whole response is null': null,
  'points is undefined': {},
  'points is null': { points: null },
  'points is empty': { points: [] },
  'a null record': { points: [point(0), null, point(2)] },
  'an undefined record': { points: [point(0), undefined, point(2)] },
  'a non-object record': { points: [point(0), 'garbage', 42, point(2)] },
  'NaN coordinates': { points: [point(0), point(1, { lat: NaN, lng: NaN }), point(2)] },
  'null coordinates': { points: [point(0), point(1, { lat: null, lng: null }), point(2)] },
  'missing coordinates': { points: [point(0), { t: point(1).t }, point(2)] },
  'an unparseable timestamp': { points: [point(0), point(1, { t: 'not-a-date' }), point(2)] },
  'a null timestamp': { points: [point(0), point(1, { t: null }), point(2)] },
  'NaN speed, bearing and distance': {
    points: [point(0), point(1, { speed: NaN, speedKmh: NaN, course: NaN, distanceKm: NaN }), point(2)],
  },
  'a corrupted GPS jump': { points: [point(0), point(1, { lat: 80, lng: -170 }), point(2)] },
  'a malformed matched route': {
    points: Array.from({ length: 5 }, (_, i) => point(i)),
    route: [{ path: null, matched: true, confidence: 0.9, fromIndex: 0, toIndex: 4 }],
    matchStatus: 'MATCHED',
  },
  'null events and stops': {
    points: Array.from({ length: 5 }, (_, i) => point(i)),
    events: null,
    stops: null,
  },
};

for (const [label, payload] of Object.entries(MALFORMED)) {
  test(`opening Playback survives ${label}`, () => {
    const { track, midway, fullRoute, travelled } = openPlayback(payload);

    // Nothing that reaches the native map may be non-numeric: a marker at a
    // NaN coordinate fails on the native side, not in JavaScript.
    const latitude = midway?.latitude ?? track.points[0]?.lat ?? 0;
    const longitude = midway?.longitude ?? track.points[0]?.lng ?? 0;
    assert.ok(Number.isFinite(latitude) && Number.isFinite(longitude), 'marker coordinate');

    for (const run of [...fullRoute, ...travelled]) {
      for (const coordinate of run) {
        assert.ok(
          Number.isFinite(coordinate.latitude) && Number.isFinite(coordinate.longitude),
          'every polyline vertex'
        );
      }
    }

    // And nothing renders the string "NaN" into the readouts.
    assert.ok(!String(Math.round(midway?.speed ?? 0)).includes('NaN'), 'speed readout');
    assert.ok(!(midway?.distanceKm ?? 0).toFixed(1).includes('NaN'), 'distance readout');
  });
}

// ---------------------------------------------------------------------------
// The missing History route line.
// ---------------------------------------------------------------------------

test('a range the router could not match is kept, but never as the road route', () => {
  // The backend returns the validated fixes as an explicitly UNMATCHED run when
  // a chunk did not solve. That geometry is still useful - a journey with no
  // line at all is a broken screen - but it is not a road, and it used to be
  // returned in `runs` and drawn in exactly the same blue as matched geometry.
  // At a glance the two were indistinguishable, and the unmatched one is a
  // chord across whatever lies between the fixes. It now travels separately.
  const route = resolveMatchedRoute({
    points: straightDrive.points,
    matchStatus: 'UNMATCHED',
    route: [
      {
        path: straightDrive.points.map((p) => [p.lat, p.lng]),
        matched: false,
        confidence: 0,
        fromIndex: 0,
        toIndex: straightDrive.points.length - 1,
      },
    ],
  });

  assert.equal(route.runs.length, 0, 'nothing is offered as road geometry');
  assert.equal(route.diagnosticRuns.length, 1, 'the GPS-derived run is still available');
  assert.equal(route.hasMatchedGeometry, false, 'and is honestly labelled as not road-matched');
  assert.equal(route.status, 'UNMATCHED', 'so the screen can still say why');
});

test('validated points are reconstructed as a GPS-only overlay when no route is returned', () => {
  const route = resolveMatchedRoute({
    points: straightDrive.points,
    matchStatus: 'UNAVAILABLE',
  });

  assert.equal(route.runs.length, 0, 'a router that is down produces no road');
  assert.equal(route.diagnosticRuns.length, 1, 'the journey is still visible, as GPS only');
  assert.equal(route.diagnosticRuns[0].coordinates.length, straightDrive.points.length);
  assert.equal(route.hasMatchedGeometry, false);
});

test('a confident road match still wins over the GPS fallback', () => {
  const route = resolveMatchedRoute({
    points: straightDrive.points,
    matchStatus: 'MATCHED',
    matchConfidence: 0.9,
    route: [
      {
        path: straightDrive.points.map((p) => [p.lat, p.lng]),
        matched: true,
        confidence: 0.9,
        fromIndex: 0,
        toIndex: straightDrive.points.length - 1,
      },
      {
        path: straightDrive.points.map((p) => [p.lat + 0.01, p.lng]),
        matched: false,
        confidence: 0,
        fromIndex: 0,
        toIndex: 1,
      },
    ],
  });

  assert.equal(route.runs.length, 1, 'only the matched run');
  assert.equal(route.hasMatchedGeometry, true);
});

test('a coverage gap in History is still drawn as a break, not a diagonal', () => {
  const points = [
    point(0),
    point(1),
    point(2),
    // Ten minutes later, two kilometres away.
    {
      ...point(3),
      t: new Date(Date.UTC(2026, 8, 1, 8, 10, 0)).toISOString(),
      lat: BASE_LAT + 0.02,
      lng: BASE_LNG + 0.02,
    },
    {
      ...point(4),
      t: new Date(Date.UTC(2026, 8, 1, 8, 10, 10)).toISOString(),
      lat: BASE_LAT + 0.0205,
      lng: BASE_LNG + 0.0205,
    },
  ];
  const { fullRoute } = openPlayback({ points });
  assert.equal(fullRoute.length, 2, 'two runs; the unobserved ground between them is left blank');
});

test('a stationary cluster does not become route geometry', () => {
  const parked = Array.from({ length: 12 }, (_, i) => ({
    ...point(0),
    t: new Date(Date.UTC(2026, 8, 1, 8, 0, i * 10)).toISOString(),
    // Every fix wanders a few metres, as a parked phone's does.
    lat: BASE_LAT + (i % 3) * 0.00002,
    lng: BASE_LNG + (i % 2) * 0.00002,
    speed: 0,
    speedKmh: 0,
  }));
  const { track } = openPlayback({ points: parked });
  assert.equal(
    Math.round(track.totalDistanceKm * 1000),
    0,
    'a parked phone must never accumulate travelled distance'
  );
});
