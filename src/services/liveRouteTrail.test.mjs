import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTrail,
  mergeLiveTrailHistory,
  progressLiveTrail,
  safeMatchedGeometry,
  travelledSegment,
} from './liveRouteTrail.ts';

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
/** ~1.11 m of latitude. */
const METRE = 1 / 111_320;

function at(metresNorth, metresEast = 0) {
  return {
    latitude: BASE_LAT + metresNorth * METRE,
    longitude: BASE_LNG + metresEast * METRE,
  };
}

const T0 = Date.parse('2026-09-01T10:00:00Z');

/**
 * Replays a sequence of accepted fixes exactly as the live reducer does, so the
 * assertions are about the route a driver would actually see.
 *
 * Each step advances the GPS clock by `afterMs` (default three seconds, which
 * with the ~50 m steps below is a plausible 60 km/h). The clock is not optional
 * decoration: the segment rules are about elapsed time and implied speed as
 * much as distance, and a fixture that omits it cannot exercise them.
 */
function driveRoute(steps) {
  let trail = [];
  let previousDisplay = null;
  let previousTimestampMs = null;
  let clock = T0;
  const sources = [];
  const modes = [];
  for (const step of steps) {
    clock += step.afterMs ?? 3_000;
    if (step.held) {
      // A held fix extends nothing, and does not move the drawn position.
      sources.push('held');
      modes.push('held');
      continue;
    }
    const segment = travelledSegment({
      matchedGeometry: step.matchedGeometry ?? [],
      isMatched: step.isMatched ?? false,
      previousDisplay,
      previousTimestampMs,
      currentDisplay: step.display,
      currentTimestampMs: clock,
      gapBefore: step.gapBefore ?? false,
      newTrip: step.newTrip ?? false,
    });
    sources.push(segment.source);
    modes.push(segment.mode);
    trail = appendTrail(trail, segment.vertices, segment.mode);
    previousDisplay = step.display;
    previousTimestampMs = clock;
  }
  return { trail, sources, modes };
}

test('the route line appears with no map-matching engine configured at all', () => {
  // matchedGeometry is empty on every fix, which is what a stock deployment
  // sends (app.map-matching.base-url is blank). The route must still be drawn.
  const { trail, sources } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { display: at(100) },
    { display: at(150) },
  ]);

  assert.equal(trail.length, 1, 'one continuous run');
  assert.equal(trail[0].length, 4, 'every accepted point is on the line');
  assert.deepEqual(sources, ['accepted', 'accepted', 'accepted', 'accepted']);
});

test('accepted points are appended in chronological order', () => {
  const { trail } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { display: at(100) },
  ]);
  const northings = trail[0].map((c) => Math.round((c.latitude - BASE_LAT) / METRE));
  assert.deepEqual(northings, [0, 50, 100]);
});

test('road-matched geometry is preferred and drawn verbatim', () => {
  const { trail, sources } = driveRoute([
    { display: at(0), newTrip: true },
    {
      display: at(60),
      isMatched: true,
      // A curve the straight segment would cut across.
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(20, 10).latitude, at(20, 10).longitude],
        [at(40, 10).latitude, at(40, 10).longitude],
        [at(60).latitude, at(60).longitude],
      ],
    },
  ]);

  assert.deepEqual(sources, ['accepted', 'matched']);
  // The curve's interior vertices survive, so the line follows the road.
  assert.ok(trail[0].length >= 4);
});

test('unusable matched geometry falls back to the accepted segment, never to nothing', () => {
  // Geometry that starts a kilometre from where the vehicle was: the solver put
  // it on a different road. It must be refused - and the travelled stretch must
  // still be drawn, because the vehicle demonstrably covered it.
  const { trail, sources } = driveRoute([
    { display: at(0), newTrip: true },
    {
      display: at(60),
      isMatched: true,
      matchedGeometry: [
        [BASE_LAT + 0.02, BASE_LNG + 0.02],
        [BASE_LAT + 0.021, BASE_LNG + 0.021],
      ],
    },
  ]);

  assert.deepEqual(sources, ['accepted', 'accepted']);
  assert.equal(trail[0].length, 2);
});

test('held and rejected fixes never extend the route', () => {
  const { trail } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { held: true },
    { held: true },
    { display: at(100) },
  ]);

  assert.equal(trail.length, 1);
  assert.equal(trail[0].length, 3, 'only the three accepted points are on the line');
});

test('a run that grows one vertex at a time still reaches the map', () => {
  // Runs shorter than two points are not drawable, but they must be RETAINED:
  // discarding them threw the vertex away, so a run built a point at a time
  // could never reach two and the line stayed permanently empty.
  let trail = appendTrail([], [at(0)], 'reset');
  trail = appendTrail(trail, [at(50)], 'extend');
  assert.equal(trail.length, 1);
  assert.equal(trail[0].length, 2);
});

test('the route survives an update that carries no new geometry', () => {
  // Standing still with the matcher holding: appendTrail is called with nothing
  // to add and must return the run it already had, not an empty one.
  const first = appendTrail([], [at(0), at(50)], 'extend');
  const second = appendTrail(first, [], 'extend');
  assert.deepEqual(second, first);
});

test('a trip reset starts a new run instead of bridging the gap', () => {
  const { trail } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    // Four minutes of silence, then a fix somewhere else entirely.
    { display: at(5000), newTrip: true, afterMs: 5 * 60_000 },
    { display: at(5050) },
  ]);

  assert.equal(trail.length, 1, 'the previous trip is cleared, not joined');
  const northings = trail[0].map((c) => Math.round((c.latitude - BASE_LAT) / METRE));
  assert.deepEqual(northings, [5000, 5050]);
});

test('appending never mutates the runs it was given', () => {
  const original = appendTrail([], [at(0), at(50)], 'extend');
  const snapshot = original.map((run) => run.map((c) => ({ ...c })));

  appendTrail(original, [at(100)], 'extend');
  appendTrail(original, [at(200)], 'extend');

  assert.deepEqual(original, snapshot, 'the previous state object is untouched');
});

test('duplicate vertices are collapsed rather than stacked on the polyline', () => {
  const trail = appendTrail([], [at(0), at(0), at(0), at(50)], 'extend');
  assert.equal(trail[0].length, 2);
});

test('live progress ends at the vehicle and follows the matched road curve', () => {
  const road = [at(0), at(20, 10), at(40, 10), at(60)];
  // Halfway between the endpoints is close to the curved middle road segment.
  const progress = progressLiveTrail([road], at(30, 2));
  const drawn = progress.runs[0];
  const tail = drawn[drawn.length - 1];

  assert.ok(drawn.length < road.length, 'road ahead of the vehicle is not drawn yet');
  assert.deepEqual(tail, progress.position, 'the blue line and marker share one endpoint');
  assert.ok(Math.round((tail.longitude - BASE_LNG) / METRE) >= 9, 'marker is projected onto the curve');
});

test('clipping live progress preserves every completed run before a GPS gap', () => {
  const first = [at(0), at(20)];
  const second = [at(100), at(120), at(140)];
  const progress = progressLiveTrail([first, second], at(130));

  assert.deepEqual(progress.runs[0], first);
  assert.ok(progress.runs[1].length >= 2);
});

test('a marker far from the route is never snapped to unrelated geometry', () => {
  const runs = [[at(0), at(20)]];
  const candidate = at(20, 500);
  const progress = progressLiveTrail(runs, candidate);

  assert.equal(progress.position, candidate);
  assert.equal(progress.runs, runs);
});

test('matched geometry with an impossible hop is refused', () => {
  assert.deepEqual(
    safeMatchedGeometry(
      [
        [at(0).latitude, at(0).longitude],
        [BASE_LAT + 0.1, BASE_LNG],
      ],
      at(0),
      at(50),
      false
    ),
    []
  );
});

test('matched geometry that does not end where the vehicle is, is refused', () => {
  assert.deepEqual(
    safeMatchedGeometry(
      [
        [at(0).latitude, at(0).longitude],
        [at(30).latitude, at(30).longitude],
      ],
      at(0),
      // The fix is 500 m past the end of the geometry.
      at(500),
      false
    ),
    []
  );
});

test('the trail is bounded and keeps the newest vertices', () => {
  let trail = [];
  for (let i = 0; i < 4600; i += 1) {
    trail = appendTrail(trail, [at(i * 10)], 'extend');
  }
  const total = trail.reduce((sum, run) => sum + run.length, 0);
  assert.ok(total <= 4000, `expected at most 4000 vertices, got ${total}`);

  const last = trail[trail.length - 1];
  const newest = Math.round((last[last.length - 1].latitude - BASE_LAT) / METRE);
  assert.equal(newest, 4599 * 10, 'the most recent position is still on the line');
});

// ---------------------------------------------------------------------------
// The diagonal.
//
// These are the regression tests for the fault this module was rewritten for:
// a telemetry silence being closed with one straight chord between the fixes
// either side of it. Every one of them failed before `travelledSegment` was
// given the clock.
// ---------------------------------------------------------------------------

test('a telemetry gap breaks the line instead of drawing a diagonal across it', () => {
  const { trail, modes } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { display: at(100) },
    // The app was backgrounded / the tunnel / the SSE reconnect. Forty-five
    // seconds later the vehicle is 400 m further on. Nothing observed the road
    // in between.
    { display: at(500), afterMs: 45_000 },
    { display: at(550) },
  ]);

  assert.equal(modes[3], 'break');
  assert.equal(trail.length, 2, 'two runs, not one line straight through the gap');
  assert.equal(trail[0].length, 3, 'everything drawn before the gap is KEPT');
  assert.equal(trail[1].length, 2);
  const firstRunEnd = Math.round((trail[0][2].latitude - BASE_LAT) / METRE);
  const secondRunStart = Math.round((trail[1][0].latitude - BASE_LAT) / METRE);
  assert.equal(firstRunEnd, 100);
  assert.equal(secondRunStart, 500, 'the new run starts at the far side, nothing bridges them');
});

test('a gap the pipeline already flagged breaks the line even when it is brief', () => {
  const { modes, trail } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { display: at(100), gapBefore: true },
  ]);
  assert.equal(modes[2], 'break');
  assert.equal(trail.length, 2);
});

test('a step no vehicle could have covered unobserved breaks the line', () => {
  // 2 km in 60 s is only 120 km/h, so a speed check alone lets it through -
  // and drawing it is a two-kilometre diagonal across the map.
  const { modes, trail } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { display: at(2050), afterMs: 60_000 },
  ]);
  assert.equal(modes[2], 'break');
  assert.equal(trail.length, 2);
});

test('a break keeps the run it closed, so the travelled route is never erased', () => {
  const { trail } = driveRoute([
    { display: at(0), newTrip: true },
    { display: at(50) },
    { display: at(100) },
    { display: at(600), afterMs: 30_000 },
    { display: at(650) },
    { display: at(1200), afterMs: 30_000 },
    { display: at(1250) },
  ]);
  assert.equal(trail.length, 3, 'one run per contiguously observed stretch');
  assert.deepEqual(
    trail.map((run) => run.length),
    [3, 2, 2]
  );
});

test('matched geometry is refused when it does not attach to where the vehicle was', () => {
  // The solver put this stretch on a road 300 m away. Drawing it would jump the
  // line off the carriageway and back; the accepted segment is used instead.
  const { sources, trail } = driveRoute([
    { display: at(0), newTrip: true },
    {
      display: at(50),
      isMatched: true,
      matchedGeometry: [
        [at(0, 300).latitude, at(0, 300).longitude],
        [at(50, 300).latitude, at(50, 300).longitude],
      ],
    },
  ]);
  assert.deepEqual(sources, ['accepted', 'accepted']);
  assert.equal(trail[0].length, 2);
});

test('matched geometry containing a long hop is refused', () => {
  // `appendUnmatchedChunk` on the server contributes raw GPS coordinates to a
  // run's geometry when a chunk fails to solve, so "matched" geometry can
  // legitimately arrive containing chords. A 300 m hop between two adjacent
  // road vertices is not a road.
  assert.deepEqual(
    safeMatchedGeometry(
      [
        [at(0).latitude, at(0).longitude],
        [at(300).latitude, at(300).longitude],
      ],
      at(0),
      at(300),
      false
    ),
    []
  );
});

test('a segment implying an impossible speed is broken, not drawn', () => {
  const { modes } = driveRoute([
    { display: at(0), newTrip: true },
    // 300 m in one second.
    { display: at(300), afterMs: 1_000 },
  ]);
  assert.equal(modes[1], 'break');
});

test('a remounted live screen continues the backend trip history', () => {
  const history = [[at(0), at(50), at(100)]];
  const live = [[at(100), at(150), at(200)]];

  const merged = mergeLiveTrailHistory(history, live);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], [at(0), at(50), at(100), at(150), at(200)]);
});

test('hydration never closes a telemetry gap or joins a different trip', () => {
  const history = [[at(0), at(50)]];
  const live = [[at(500), at(550)], [at(900), at(950)]];

  const merged = mergeLiveTrailHistory(history, live);

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((run) => run.length), [2, 2, 2]);
});
