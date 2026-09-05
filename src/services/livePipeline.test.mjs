import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLiveEvent,
  applyRoadMatchEvent,
  EMPTY_LIVE_STATE,
  expirePendingRoadMatches,
  resetLiveWindow,
} from './livePipeline.ts';

const DEVICE = 7;
const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
/** ~1 m of latitude. */
const METRE = 1 / 111_320;
const T0 = Date.parse('2026-09-01T10:00:00Z');

function at(metresNorth, metresEast = 0) {
  return {
    latitude: BASE_LAT + metresNorth * METRE,
    longitude: BASE_LNG + metresEast * METRE,
  };
}

/**
 * One POSITION frame exactly as the two-stage backend now sends it: a validated
 * coordinate, its positionId, and NO road answer at all.
 */
function positionFrame({ positionId, coordinate, atMs, speedKmh = 40, ignition = true }) {
  const iso = new Date(atMs).toISOString();
  return {
    deviceId: DEVICE,
    vehicleId: 1,
    positionId,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    matchedLatitude: null,
    matchedLongitude: null,
    roadBearing: null,
    matchConfidence: null,
    matchedSource: null,
    matchedGeometry: [],
    speedKmh,
    tripDistanceKm: 1.2,
    tripStartedAt: new Date(T0).toISOString(),
    course: 0,
    accuracyMeters: 8,
    ignition,
    gpsValid: true,
    state: 'RUNNING',
    connectionState: 'ONLINE',
    address: null,
    deviceTime: iso,
    serverTime: iso,
    lastGpsTime: iso,
    lastServerReceivedTime: iso,
    updatedAt: iso,
    positionUpdate: true,
    matchStatus: 'PENDING',
  };
}

/** One ROAD_MATCH enrichment frame for a given positionId. */
function roadMatchFrame({
  positionId,
  coordinate,
  geometry = [],
  source = 'SOLVED',
  status = 'MATCHED',
  confidence = 0.92,
  atMs = T0,
}) {
  return {
    deviceId: DEVICE,
    vehicleId: 1,
    positionId,
    matchedLatitude: coordinate ? coordinate.latitude : null,
    matchedLongitude: coordinate ? coordinate.longitude : null,
    roadBearing: 0,
    matchConfidence: coordinate ? confidence : null,
    matchedSource: source,
    matchedGeometry: geometry.map((vertex) => [vertex.latitude, vertex.longitude]),
    matchStatus: status,
    gpsTime: new Date(atMs).toISOString(),
    serverTime: new Date(atMs).toISOString(),
  };
}

/**
 * Drives the pipeline through a warm-up so later fixes are validated against a
 * settled anchor rather than being held as a departure that is not yet proven.
 */
function driveTo(state, steps) {
  let next = state;
  for (const step of steps) {
    next = applyLiveEvent(
      next,
      positionFrame({
        positionId: step.positionId,
        coordinate: step.coordinate,
        atMs: step.atMs,
      }),
      step.atMs
    );
    if (step.match !== undefined) {
      next = applyRoadMatchEvent(next, step.match, step.atMs + 200);
    }
  }
  return next;
}

test.beforeEach(() => {
  resetLiveWindow();
});

// ------------------------------------------------------------- identity

test('a POSITION frame moves nothing until its own road answer arrives', () => {
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    positionFrame({ positionId: 101, coordinate: at(0), atMs: T0 }),
    T0
  );
  // The very first fix bootstraps a visible vehicle - an empty map is worse than
  // a validated coordinate - but it draws no route.
  assert.ok(state.displayPosition, 'the vehicle is on the map immediately');
  assert.equal(state.trail.length, 0, 'no road has been claimed yet');
  assert.equal(state.matchStatus, 'PENDING');
  assert.equal(state.pendingMatches.length, 1);
  assert.equal(state.pendingMatches[0].positionId, 101);

  const beforeSecond = state.displayPosition;
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 102, coordinate: at(50), atMs: T0 + 3_000 }),
    T0 + 3_000
  );
  // The marker did NOT jump to the raw coordinate: it waits for the road answer
  // so the marker and the route always agree about where fix 102 was.
  assert.deepEqual(state.displayPosition, beforeSecond);
  assert.equal(state.lastPositionId, 102);
  assert.equal(state.pendingMatches.length, 2);
});

test('a road answer is applied to its own positionId and nothing else', () => {
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    positionFrame({ positionId: 101, coordinate: at(0), atMs: T0 }),
    T0
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }),
    T0 + 150
  );
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 102, coordinate: at(50), atMs: T0 + 3_000 }),
    T0 + 3_000
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({
      positionId: 102,
      coordinate: at(50, 2),
      geometry: [at(0, 2), at(25, 2), at(50, 2)],
      atMs: T0 + 3_000,
    }),
    T0 + 3_150
  );

  assert.equal(state.roadSegment.positionId, 102, 'the marker travels fix 102s segment');
  assert.deepEqual(state.displayPosition, at(50, 2), 'drawn at the MATCHED coordinate');
  assert.equal(state.trail.length, 1);
  assert.equal(state.trail[0].lastPositionId, 102, 'the route vertex is attributed to fix 102');
  assert.equal(state.trail[0].vertices.length, 3, 'the road vertices, verbatim');
  assert.equal(state.pendingMatches.length, 0);
  assert.equal(state.matchStatus, 'MATCHED');
});

test('an enrichment for a fix this client never held is dropped, not applied', () => {
  // The stale-match race, from the client side: an answer computed for an older
  // position arriving after the client has moved on.
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    positionFrame({ positionId: 101, coordinate: at(0), atMs: T0 }),
    T0
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }),
    T0 + 150
  );
  const before = state;

  // Fix 99 is older than anything pending. Applying it would move the vehicle
  // backwards to a road it has already left.
  const after = applyRoadMatchEvent(
    state,
    roadMatchFrame({ positionId: 99, coordinate: at(-500), atMs: T0 - 10_000 }),
    T0 + 400
  );

  assert.equal(after, before, 'the orphan enrichment changed nothing at all');
});

test('a superseded enrichment cannot re-open a route the vehicle has passed', () => {
  let state = driveTo(EMPTY_LIVE_STATE, [
    { positionId: 101, coordinate: at(0), atMs: T0, match: roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }) },
    {
      positionId: 102,
      coordinate: at(50),
      atMs: T0 + 3_000,
      match: roadMatchFrame({
        positionId: 102,
        coordinate: at(50, 2),
        geometry: [at(0, 2), at(50, 2)],
        atMs: T0 + 3_000,
      }),
    },
    {
      positionId: 103,
      coordinate: at(100),
      atMs: T0 + 6_000,
      match: roadMatchFrame({
        positionId: 103,
        coordinate: at(100, 2),
        geometry: [at(50, 2), at(100, 2)],
        atMs: T0 + 6_000,
      }),
    },
  ]);

  const drawnBefore = state.trail.map((run) => run.vertices.length);
  // Fix 102's answer arrives a second time, after 103 has already been applied.
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({
      positionId: 102,
      coordinate: at(50, 2),
      geometry: [at(0, 2), at(50, 2)],
      atMs: T0 + 3_000,
    }),
    T0 + 7_000
  );

  assert.deepEqual(
    state.trail.map((run) => run.vertices.length),
    drawnBefore,
    'the late duplicate did not re-append the stretch'
  );
  assert.equal(state.roadSegment.positionId, 103, 'the marker still owns the newest segment');
});

test('an out-of-order POSITION frame never drags the vehicle backwards', () => {
  let state = driveTo(EMPTY_LIVE_STATE, [
    { positionId: 101, coordinate: at(0), atMs: T0, match: roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }) },
    {
      positionId: 102,
      coordinate: at(50),
      atMs: T0 + 3_000,
      match: roadMatchFrame({
        positionId: 102,
        coordinate: at(50, 2),
        geometry: [at(0, 2), at(50, 2)],
        atMs: T0 + 3_000,
      }),
    },
  ]);
  const drawnAt = state.displayPosition;

  // A replayed older packet.
  const after = applyLiveEvent(
    state,
    positionFrame({ positionId: 100, coordinate: at(-200), atMs: T0 - 5_000 }),
    T0 + 4_000
  );

  assert.deepEqual(after.displayPosition, drawnAt, 'the marker did not move');
  assert.equal(after.lastPositionId, 102, 'the newest identity still stands');
});

test('a road answer that lands after the next POSITION still joins the route', () => {
  // POSITION and ROAD_MATCH travel on independent per-device queues, so a slow
  // road answer for fix N-1 can arrive after the POSITION for fix N. The segment
  // for N-1 must still start where the vehicle was actually drawn - not at a
  // coordinate captured before it moved - or the geometry fails its endpoint
  // check and a perfectly good matched stretch is thrown away.
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    positionFrame({ positionId: 201, coordinate: at(0), atMs: T0 }),
    T0
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({ positionId: 201, coordinate: at(0, 2), atMs: T0 }),
    T0 + 150
  );

  // 202 and 203 are published before either of their answers comes back.
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 202, coordinate: at(50), atMs: T0 + 3_000 }),
    T0 + 3_000
  );
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 203, coordinate: at(100), atMs: T0 + 6_000 }),
    T0 + 6_000
  );

  // Now the answers arrive, in order, but both late.
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({
      positionId: 202,
      coordinate: at(50, 2),
      geometry: [at(0, 2), at(25, 2), at(50, 2)],
      atMs: T0 + 3_000,
    }),
    T0 + 6_400
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({
      positionId: 203,
      coordinate: at(100, 2),
      geometry: [at(50, 2), at(75, 2), at(100, 2)],
      atMs: T0 + 6_000,
    }),
    T0 + 6_600
  );

  assert.equal(state.trail.length, 1, 'one continuous run, not a break per late answer');
  assert.equal(state.trail[0].lastPositionId, 203);
  assert.deepEqual(state.displayPosition, at(100, 2));
  assert.equal(state.roadRouteOpen, true);
  assert.equal(state.pendingMatches.length, 0);
});

// -------------------------------------------------------- outage handling

test('a router outage keeps the vehicle visible and draws no road', () => {
  let state = driveTo(EMPTY_LIVE_STATE, [
    { positionId: 101, coordinate: at(0), atMs: T0, match: roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }) },
    {
      positionId: 102,
      coordinate: at(50),
      atMs: T0 + 3_000,
      match: roadMatchFrame({
        positionId: 102,
        coordinate: at(50, 2),
        geometry: [at(0, 2), at(50, 2)],
        atMs: T0 + 3_000,
      }),
    },
  ]);
  const runsBefore = state.trail.length;
  const verticesBefore = state.trail[0].vertices.length;

  // The router goes down. The backend still says so, explicitly, per fix.
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 103, coordinate: at(100), atMs: T0 + 6_000 }),
    T0 + 6_000
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({
      positionId: 103,
      coordinate: null,
      source: 'NONE',
      status: 'UNAVAILABLE',
      atMs: T0 + 6_000,
    }),
    T0 + 6_200
  );

  assert.equal(state.matchStatus, 'UNAVAILABLE', 'the reason is reported, not hidden');
  assert.ok(state.displayPosition, 'the vehicle is still on the map');
  assert.equal(state.trail.length, runsBefore, 'no new road run was invented');
  assert.equal(
    state.trail[0].vertices.length,
    verticesBefore,
    'and the existing run was not extended to the unmatched fix'
  );
  assert.ok(state.diagnosticTrail.length > 0, 'the stretch is on the GPS-only layer instead');
  assert.equal(state.roadRouteOpen, false, 'the route is closed at the hole');
});

test('a road answer that never arrives still lets the vehicle move, with no road', () => {
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    positionFrame({ positionId: 101, coordinate: at(0), atMs: T0 }),
    T0
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }),
    T0 + 150
  );
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 102, coordinate: at(50), atMs: T0 + 3_000 }),
    T0 + 3_000
  );
  const trailBefore = state.trail;

  // Nothing answers for fix 102. Seven seconds later the watchdog gives up.
  const after = expirePendingRoadMatches(state, DEVICE, T0 + 10_000);

  assert.notDeepEqual(after.displayPosition, state.displayPosition, 'the vehicle moved on');
  assert.deepEqual(after.displayPosition, at(50), 'to its validated coordinate');
  assert.equal(after.trail, trailBefore, 'and drew no road for the stretch');
  assert.equal(after.matchStatus, 'UNAVAILABLE');
  assert.equal(after.pendingMatches.length, 0);
});

// ----------------------------------------------------- restart / refresh

test('a reconnect replaying an already-seen fix does not duplicate the route', () => {
  const seed = [
    { positionId: 101, coordinate: at(0), atMs: T0, match: roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }) },
    {
      positionId: 102,
      coordinate: at(50),
      atMs: T0 + 3_000,
      match: roadMatchFrame({
        positionId: 102,
        coordinate: at(50, 2),
        geometry: [at(0, 2), at(50, 2)],
        atMs: T0 + 3_000,
      }),
    },
  ];
  let state = driveTo(EMPTY_LIVE_STATE, seed);
  const verticesBefore = state.trail.reduce((total, run) => total + run.vertices.length, 0);

  // The server replays the current position on connect. It is the same fix.
  state = applyLiveEvent(
    state,
    positionFrame({ positionId: 102, coordinate: at(50), atMs: T0 + 3_000 }),
    T0 + 20_000
  );
  state = applyRoadMatchEvent(
    state,
    roadMatchFrame({
      positionId: 102,
      coordinate: at(50, 2),
      geometry: [at(0, 2), at(50, 2)],
      atMs: T0 + 3_000,
    }),
    T0 + 20_200
  );

  const verticesAfter = state.trail.reduce((total, run) => total + run.vertices.length, 0);
  assert.equal(verticesAfter, verticesBefore, 'the replayed fix drew nothing twice');
});

test('a state-only refresh changes liveness and never the position', () => {
  let state = driveTo(EMPTY_LIVE_STATE, [
    { positionId: 101, coordinate: at(0), atMs: T0, match: roadMatchFrame({ positionId: 101, coordinate: at(0, 2), atMs: T0 }) },
  ]);
  const drawn = state.displayPosition;

  const refresh = {
    ...positionFrame({ positionId: 101, coordinate: at(0), atMs: T0 }),
    positionUpdate: false,
    state: 'STOPPED',
  };
  const after = applyLiveEvent(state, refresh, T0 + 60_000);

  assert.deepEqual(after.displayPosition, drawn);
  assert.equal(after.latest.state, 'STOPPED');
  assert.equal(after.rejectedReason, null, 'a status change is not a GPS fault');
});


// --------------------------------------------- one authoritative frame per fix

/**
 * One POSITION frame as a current backend sends it: the fix is already
 * validated, matched and resolved to a display coordinate, so there is no
 * second frame and nothing to correct afterwards.
 */
function resolvedFrame({
  positionId,
  raw,
  display,
  matched = display,
  geometry = [],
  source = 'SOLVED',
  status = 'MATCHED',
  confidence = 0.92,
  bearing = 0,
  atMs,
  speedKmh = 40,
}) {
  return {
    ...positionFrame({ positionId, coordinate: raw, atMs, speedKmh }),
    rawLatitude: raw.latitude,
    rawLongitude: raw.longitude,
    matchedLatitude: matched ? matched.latitude : null,
    matchedLongitude: matched ? matched.longitude : null,
    displayLatitude: display.latitude,
    displayLongitude: display.longitude,
    displayBearing: bearing,
    roadBearing: bearing,
    matchConfidence: matched ? confidence : null,
    matchedSource: source,
    matchedGeometry: geometry.map((vertex) => [vertex.latitude, vertex.longitude]),
    matchStatus: status,
  };
}

test('a resolved frame draws the display coordinate, never the raw one', () => {
  const state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    resolvedFrame({
      positionId: 201,
      raw: at(0, 0),
      display: at(0, 8),
      atMs: T0,
    }),
    T0
  );

  assert.deepEqual(state.displayPosition, at(0, 8), 'the marker is on the road');
  assert.deepEqual(state.rawPosition, at(0, 0), 'the raw fix is kept for diagnostics');
  assert.equal(state.pendingMatches.length, 0, 'nothing is outstanding');
  assert.equal(state.roadMatchPending, false);
  assert.equal(state.matchStatus, 'MATCHED');
});

test('a moving vehicle is never drawn at a raw coordinate, on any frame', () => {
  const frames = [
    resolvedFrame({ positionId: 301, raw: at(0, 0), display: at(0, 8), atMs: T0 }),
    resolvedFrame({
      positionId: 302,
      raw: at(20, 0),
      display: at(20, 8),
      geometry: [at(0, 8), at(20, 8)],
      atMs: T0 + 1_000,
    }),
    resolvedFrame({
      positionId: 303,
      raw: at(40, 0),
      display: at(40, 8),
      geometry: [at(20, 8), at(40, 8)],
      atMs: T0 + 2_000,
    }),
  ];

  let state = EMPTY_LIVE_STATE;
  for (const frame of frames) {
    state = applyLiveEvent(state, frame, Date.parse(frame.lastGpsTime));
    assert.equal(
      state.displayPosition.longitude,
      frame.displayLatitude === null ? null : frame.displayLongitude,
      'the drawn position is this frame’s display coordinate'
    );
    assert.notEqual(
      state.displayPosition.longitude,
      frame.rawLongitude,
      'and never its raw coordinate'
    );
  }

  const vertices = state.trail.reduce((total, run) => total + run.vertices.length, 0);
  assert.ok(vertices >= 2, 'the route was extended from the road geometry');
});

test('a HELD frame keeps the marker on its road and appends no route', () => {
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    resolvedFrame({
      positionId: 401,
      raw: at(0, 0),
      display: at(0, 8),
      geometry: [],
      atMs: T0,
    }),
    T0
  );
  const drawn = state.displayPosition;
  const verticesBefore = state.trail.reduce((total, run) => total + run.vertices.length, 0);

  // The backend could not solve this fix, so it kept the previous road position
  // and said so. It reports no matched coordinate for THIS fix.
  state = applyLiveEvent(
    state,
    resolvedFrame({
      positionId: 402,
      raw: at(12, 0),
      display: at(0, 8),
      matched: null,
      source: 'HELD',
      atMs: T0 + 1_000,
    }),
    T0 + 1_000
  );

  assert.deepEqual(state.displayPosition, drawn, 'the vehicle stays on its road');
  assert.equal(
    state.trail.reduce((total, run) => total + run.vertices.length, 0),
    verticesBefore,
    'no road was travelled, so none is invented'
  );
});

test('the road geometry between two display positions is what the route draws', () => {
  let state = applyLiveEvent(
    EMPTY_LIVE_STATE,
    resolvedFrame({ positionId: 501, raw: at(0, 0), display: at(0, 0), atMs: T0 }),
    T0
  );
  state = applyLiveEvent(
    state,
    resolvedFrame({
      positionId: 502,
      raw: at(30, 30),
      display: at(30, 30),
      // An L around a corner, which is what a road does and a chord does not.
      geometry: [at(0, 0), at(30, 0), at(30, 30)],
      atMs: T0 + 2_000,
    }),
    T0 + 2_000
  );

  const drawn = state.trail.flatMap((run) => run.vertices);
  assert.ok(
    drawn.some((vertex) => Math.abs(vertex.latitude - at(30, 0).latitude) < 1e-9
      && Math.abs(vertex.longitude - at(30, 0).longitude) < 1e-9),
    'the corner vertex is on the drawn route, so the line follows the road'
  );
});
