import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTrail,
  drawableRuns,
  mergeLiveTrailHistory,
  safeMatchedGeometry,
  travelledSegment,
} from './liveRouteTrail.ts';
import { matchedStepLimitFor } from './gpsPipeline.ts';

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
 * Replays a sequence of accepted fixes exactly as the live pipeline does, so the
 * assertions are about the route a driver would actually see.
 *
 * Each step advances the GPS clock by `afterMs` (default three seconds, which
 * with the ~50 m steps below is a plausible 60 km/h). The clock is not optional
 * decoration: the segment rules are about elapsed time and implied speed as
 * much as distance, and a fixture that omits it cannot exercise them.
 *
 * `matchedSource` is the load-bearing input now. It is what says whether the
 * backend produced a road for this fix, and the whole point of the rewrite is
 * that only `SOLVED` road geometry may extend the authoritative line.
 */
function driveRoute(steps) {
  let trail = [];
  let diagnostic = [];
  let previousDisplay = null;
  let previousTimestampMs = null;
  let clock = T0;
  let positionId = 1000;
  // Mirrors the reducer's own bookkeeping: the drawn route is open only where
  // road geometry was actually appended. A fix with no road answer closes it,
  // so the next matched segment starts a new run rather than reaching back
  // across the stretch nobody could place.
  let roadRouteOpen = false;
  const sources = [];
  const modes = [];
  for (const step of steps) {
    clock += step.afterMs ?? 3_000;
    positionId += 1;
    if (step.held) {
      // A held fix extends nothing, and does not move the drawn position.
      sources.push('held');
      modes.push('held');
      continue;
    }
    const segment = travelledSegment({
      matchedGeometry: step.matchedGeometry ?? [],
      matchedSource: step.matchedSource ?? 'NONE',
      previousDisplay,
      previousTimestampMs,
      currentDisplay: step.display,
      currentTimestampMs: clock,
      gapBefore: step.gapBefore ?? false,
      newTrip: step.newTrip ?? false,
      roadRouteOpen,
    });
    roadRouteOpen =
      segment.source === 'carried' ? roadRouteOpen : segment.source === 'matched';
    sources.push(segment.source);
    modes.push(segment.mode);
    trail = appendTrail(trail, segment.vertices, segment.mode, {
      positionId,
      timestampMs: clock,
    });
    diagnostic = appendTrail(diagnostic, segment.diagnosticVertices, segment.diagnosticMode, {
      positionId,
      timestampMs: clock,
    });
    previousDisplay = step.display;
    previousTimestampMs = clock;
  }
  return { trail, diagnostic, sources, modes };
}

/** Coordinates only, for assertions about what is drawn. */
function drawn(trail) {
  return trail.map((run) => run.vertices);
}

// ---------------------------------------------------------------- the rules

test('a 90-degree turn is drawn as the L the matcher returned, not as a chord', () => {
  // The two fixes sit either side of a corner. The matched geometry is the L
  // that joins them; the chord between the fixes cuts through the building on
  // the inside of the turn. Only the L may be drawn.
  const { trail, sources } = driveRoute([
    { display: at(0, 0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(100, 100),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0, 0).latitude, at(0, 0).longitude],
        [at(100, 0).latitude, at(100, 0).longitude],
        [at(100, 100).latitude, at(100, 100).longitude],
      ],
    },
  ]);

  assert.deepEqual(sources, ['matched', 'matched']);
  const run = trail[trail.length - 1].vertices;
  // The corner vertex survives, which is the whole difference between an L and
  // a diagonal.
  const hasCorner = run.some(
    (vertex) =>
      Math.abs(vertex.latitude - at(100, 0).latitude) < 1e-9 &&
      Math.abs(vertex.longitude - at(100, 0).longitude) < 1e-9
  );
  assert.ok(hasCorner, 'the corner is on the drawn route');
  assert.equal(run.length, 3, 'exactly the three road vertices, no invented chord');
});

test('no road answer draws NO authoritative route at all', () => {
  // The exact case that used to produce a straight blue line: two perfectly
  // good fixes, and a matcher that returned nothing for them.
  const { trail, diagnostic, sources } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'NONE' },
    { display: at(50), matchedSource: 'NONE' },
    { display: at(100), matchedSource: 'NONE' },
  ]);

  assert.deepEqual(sources, ['none', 'none', 'none']);
  assert.equal(drawableRuns(trail).length, 0, 'nothing is drawn as a road');
  // The evidence is not thrown away - it is offered separately, for a layer the
  // UI must style as GPS-only.
  assert.ok(drawableRuns(diagnostic).length > 0, 'the GPS-only diagnostic still has the stretch');
});

test('a matching outage never fabricates a road between two matched stretches', () => {
  const { trail, diagnostic } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(50),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(25).latitude, at(25).longitude],
        [at(50).latitude, at(50).longitude],
      ],
    },
    // The router goes down for one fix.
    { display: at(100), matchedSource: 'NONE' },
    // ...and comes back.
    {
      display: at(150),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(100).latitude, at(100).longitude],
        [at(125).latitude, at(125).longitude],
        [at(150).latitude, at(150).longitude],
      ],
    },
  ]);

  const runs = drawableRuns(trail);
  assert.equal(runs.length, 2, 'two matched runs, separated by the outage');
  // The gap is real: the last vertex of run one and the first of run two are
  // 50 m apart and NOT joined.
  const endOfFirst = runs[0][runs[0].length - 1];
  const startOfSecond = runs[1][0];
  assert.ok(Math.abs(endOfFirst.latitude - at(50).latitude) < 1e-9);
  assert.ok(Math.abs(startOfSecond.latitude - at(100).latitude) < 1e-9);
  assert.ok(drawableRuns(diagnostic).length > 0, 'the unmatched stretch is on the GPS layer');
});

test('CARRIED keeps the marker where it is and invents no geometry', () => {
  const { trail, diagnostic, sources } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(50),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(50).latitude, at(50).longitude],
      ],
    },
    // No new road answer. The previous road coordinate stands.
    { display: at(50), matchedSource: 'CARRIED' },
    { display: at(50), matchedSource: 'HELD' },
    { display: at(50), matchedSource: 'PREVIOUS_TRUSTED' },
    { display: at(50), matchedSource: 'HELD_STATIONARY' },
  ]);

  assert.deepEqual(sources, ['matched', 'matched', 'carried', 'carried', 'carried', 'carried']);
  const runs = drawableRuns(trail);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 2, 'the carried fixes added no vertices');
  assert.equal(
    drawableRuns(diagnostic).length,
    0,
    'a carried fix is not an unmatched stretch either - it is simply no news'
  );
});

test('road-matched geometry is drawn verbatim, curves included', () => {
  const curve = [];
  for (let step = 0; step <= 10; step += 1) {
    curve.push([at(step * 5, step * step * 0.4).latitude, at(step * 5, step * step * 0.4).longitude]);
  }
  const { trail, sources } = driveRoute([
    { display: at(0, 0), newTrip: true, matchedSource: 'SOLVED' },
    { display: at(50, 40), matchedSource: 'SOLVED', matchedGeometry: curve },
  ]);

  assert.deepEqual(sources, ['matched', 'matched']);
  assert.ok(trail[0].vertices.length >= 8, 'the curve interior survives');
});

test('a one-vertex tail continues the road rather than fragmenting it', () => {
  // Observed on a real drive: roughly one fix in six comes back SOLVED with a
  // single geometry vertex, because the vehicle advanced without leaving the
  // road segment it was already on. Both ends are engine-placed road positions,
  // so the step between them IS that segment. Treating it as a failure broke the
  // line into a piece per short step.
  const { trail, sources } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(20),
      afterMs: 1_000,
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(20).latitude, at(20).longitude],
      ],
    },
    // The short tail: one vertex, 4 m of travel.
    {
      display: at(24),
      afterMs: 1_000,
      matchedSource: 'SOLVED',
      matchedGeometry: [[at(24).latitude, at(24).longitude]],
    },
    // ...and a normal tail resumes.
    {
      display: at(44),
      afterMs: 1_000,
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(24).latitude, at(24).longitude],
        [at(44).latitude, at(44).longitude],
      ],
    },
  ]);

  assert.deepEqual(sources, ['matched', 'matched', 'matched', 'matched']);
  assert.equal(drawableRuns(trail).length, 1, 'one continuous run, not three');
});

test('a LONG step with no geometry still breaks the line', () => {
  // The same short-tail path must not become a licence to invent a road. Past
  // the bound, the missing geometry means the road actually taken is unknown.
  const { trail, sources } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(20),
      afterMs: 1_000,
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(20).latitude, at(20).longitude],
      ],
    },
    // 200 m in one step, and the matcher offered no road for it.
    {
      display: at(220),
      afterMs: 4_000,
      matchedSource: 'SOLVED',
      matchedGeometry: [[at(220).latitude, at(220).longitude]],
    },
  ]);

  assert.deepEqual(sources, ['matched', 'matched', 'none']);
  assert.equal(drawableRuns(trail).length, 1, 'the unknown stretch is not drawn as road');
  assert.equal(trail[0].vertices.length, 2, 'the earlier matched run is untouched');
});

test('unusable matched geometry is refused and draws nothing', () => {
  // Geometry that starts a kilometre from where the vehicle was: the solver put
  // it on a different road. It must be refused - and refusing it must NOT fall
  // back to the chord, which is the fabrication this whole change removes.
  const { trail, diagnostic, sources } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(60),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [BASE_LAT + 0.02, BASE_LNG + 0.02],
        [BASE_LAT + 0.021, BASE_LNG + 0.021],
      ],
    },
  ]);

  assert.deepEqual(sources, ['matched', 'none']);
  assert.equal(drawableRuns(trail).length, 0, 'the refused stretch drew no road');
  assert.ok(drawableRuns(diagnostic).length > 0);
});

test('held and rejected fixes never extend the route', () => {
  const geometryFor = (from, to) => [
    [at(from).latitude, at(from).longitude],
    [at(to).latitude, at(to).longitude],
  ];
  const { trail } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    { display: at(50), matchedSource: 'SOLVED', matchedGeometry: geometryFor(0, 50) },
    { held: true },
    { held: true },
    { display: at(100), matchedSource: 'SOLVED', matchedGeometry: geometryFor(50, 100) },
  ]);

  assert.equal(drawableRuns(trail).length, 1);
  assert.equal(trail[0].vertices.length, 3, 'only the three matched vertices are on the line');
});

test('a trip reset starts a new run instead of bridging the gap', () => {
  const { trail, modes } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(50),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(50).latitude, at(50).longitude],
      ],
    },
    {
      display: at(5_000),
      newTrip: true,
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(5_000).latitude, at(5_000).longitude],
        [at(5_050).latitude, at(5_050).longitude],
      ],
    },
  ]);

  assert.equal(modes[2], 'reset');
  assert.equal(trail.length, 1, 'the previous journey is discarded, not joined');
});

test('a telemetry gap breaks the line instead of drawing a diagonal across it', () => {
  const { modes } = driveRoute([
    { display: at(0), newTrip: true, matchedSource: 'SOLVED' },
    {
      display: at(50),
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(0).latitude, at(0).longitude],
        [at(50).latitude, at(50).longitude],
      ],
    },
    // Ninety seconds of silence, then a fix 900 m away.
    {
      display: at(950),
      afterMs: 90_000,
      matchedSource: 'SOLVED',
      matchedGeometry: [
        [at(950).latitude, at(950).longitude],
        [at(1_000).latitude, at(1_000).longitude],
      ],
    },
  ]);

  assert.equal(modes[2], 'break');
});

test('appending never mutates the runs it was given', () => {
  const original = appendTrail([], [at(0), at(10)], 'extend', { positionId: 1, timestampMs: T0 });
  const snapshot = drawn(original).map((run) => run.map((vertex) => ({ ...vertex })));
  appendTrail(original, [at(20)], 'extend', { positionId: 2, timestampMs: T0 + 1000 });
  assert.deepEqual(drawn(original), snapshot);
});

test('duplicate vertices are collapsed rather than stacked on the polyline', () => {
  const trail = appendTrail([], [at(0), at(0), at(0), at(10)], 'extend', {
    positionId: 1,
    timestampMs: T0,
  });
  assert.equal(trail[0].vertices.length, 2);
});

test('geometry containing an impossible hop is refused', () => {
  const refused = safeMatchedGeometry(
    [
      [at(0).latitude, at(0).longitude],
      [BASE_LAT + 0.05, BASE_LNG + 0.05],
      [at(50).latitude, at(50).longitude],
    ],
    at(0),
    at(50),
    false
  );
  assert.deepEqual(refused, []);
});

test('geometry that does not end where the vehicle is, is refused', () => {
  const refused = safeMatchedGeometry(
    [
      [at(0).latitude, at(0).longitude],
      [at(20).latitude, at(20).longitude],
    ],
    at(0),
    at(500),
    false
  );
  assert.deepEqual(refused, []);
});

// ------------------------------------------------- hydration and identity

/** One hydrated run, as Live Track builds them from the playback response. */
function historyRun(vertices, firstPositionId, lastPositionId, firstMs, lastMs) {
  return {
    vertices,
    firstPositionId,
    lastPositionId,
    firstTimestampMs: firstMs,
    lastTimestampMs: lastMs,
  };
}

test('a remounted live screen continues the backend trip by positionId', () => {
  const history = [historyRun([at(0), at(50), at(100)], 900, 902, T0, T0 + 6_000)];
  const live = [historyRun([at(100), at(150), at(200)], 903, 905, T0 + 9_000, T0 + 15_000)];

  const merged = mergeLiveTrailHistory(history, live, {
    positionId: 902,
    timestampMs: T0 + 6_000,
  });

  assert.equal(merged.length, 1, 'the two halves are one journey');
  assert.deepEqual(drawn(merged)[0], [at(0), at(50), at(100), at(150), at(200)]);
});

test('a live run already contained in hydration is never appended twice', () => {
  const history = [historyRun([at(0), at(50), at(100)], 900, 905, T0, T0 + 15_000)];
  // The stream replayed a fix hydration already covers: same positionId range.
  const live = [historyRun([at(100), at(150)], 904, 905, T0 + 12_000, T0 + 15_000)];

  const merged = mergeLiveTrailHistory(history, live, {
    positionId: 905,
    timestampMs: T0 + 15_000,
  });

  // It may not EXTEND the hydrated run - that would draw the same ground twice
  // and, on a loop, close a circle the vehicle never drove.
  assert.equal(merged.length, 2, 'the duplicate opens a separate run rather than extending');
  assert.deepEqual(drawn(merged)[0], [at(0), at(50), at(100)]);
});

test('proximity alone never joins history to the stream', () => {
  // The classic false positive: the live head is 30 m from the history tail -
  // well inside the old ~120 m rule - but it is a DIFFERENT road, and its
  // positionId proves it is not the continuation of this sequence.
  const history = [historyRun([at(0), at(100)], 900, 901, T0, T0 + 3_000)];
  const live = [historyRun([at(100, 30), at(150, 30)], 880, 881, T0 - 60_000, T0 - 57_000)];

  const merged = mergeLiveTrailHistory(history, live, {
    positionId: 901,
    timestampMs: T0 + 3_000,
  });

  assert.equal(merged.length, 2, 'nearby is not the same journey');
});

test('hydration refuses to join when either side carries no identity', () => {
  const history = [historyRun([at(0), at(100)], null, null, T0, T0 + 3_000)];
  const live = [historyRun([at(100), at(150)], 903, 904, T0 + 6_000, T0 + 9_000)];

  const merged = mergeLiveTrailHistory(history, live, { positionId: null, timestampMs: null });

  assert.equal(merged.length, 2, 'a visible break beats a guessed splice');
});

test('hydration never closes a telemetry gap between live runs', () => {
  const history = [historyRun([at(0), at(50)], 900, 901, T0, T0 + 3_000)];
  const live = [
    historyRun([at(60), at(110)], 902, 903, T0 + 6_000, T0 + 9_000),
    historyRun([at(900), at(950)], 910, 911, T0 + 300_000, T0 + 303_000),
  ];

  const merged = mergeLiveTrailHistory(history, live, {
    positionId: 901,
    timestampMs: T0 + 3_000,
  });

  assert.equal(merged.length, 2, 'the first live run joins; the one after the gap does not');
  assert.deepEqual(
    drawn(merged).map((run) => run.length),
    [4, 2]
  );
});

/*
 * Regression: a 1 Hz drive on a continuous road, broken by one noisy sample.
 *
 * Taken from a real trip (device 14, 2026-09-10 09:02:46Z). The tracker reports
 * every second and steps 5.8-8.0 m per fix at ~20 km/h; one multipath sample
 * displaced a single fix by 30.9 m, then the next returned to 10.5 m and the
 * one after that to 7.8 m. That lone 30.9 m step crossed the flat 30 m bound,
 * so the road route broke and the same two points were redrawn as an amber
 * "GPS only" chord - a visible hole in a road with no junction on it.
 */
test('a single noisy 1 Hz sample does not break a continuous road', () => {
  const previousDisplay = at(0);
  const segment = travelledSegment({
    // A vehicle that has not left its road segment reports no new vertex.
    matchedGeometry: [],
    matchedSource: 'SOLVED',
    previousDisplay,
    previousTimestampMs: T0,
    currentDisplay: at(30.9),
    currentTimestampMs: T0 + 1_000,
    expectedIntervalMs: 1_000,
    roadRouteOpen: true,
  });

  assert.equal(segment.source, 'matched', 'both ends are engine-matched road positions');
  assert.equal(segment.mode, 'extend', 'the blue route continues through the noisy sample');
  assert.deepEqual(segment.diagnosticVertices, [], 'nothing is offered as GPS-only');
  assert.equal(segment.vertices.length, 2);
});

test('a step past what the cadence allows still breaks the road route', () => {
  // Ten seconds of missing fixes from a 1 Hz device, covered at a perfectly
  // ordinary 72 km/h. Telemetry never broke, so the vehicle's motion is
  // continuous - but 200 m of road with no reported vertex can hide a turn,
  // which is the case this bound exists for.
  const segment = travelledSegment({
    matchedGeometry: [],
    matchedSource: 'SOLVED',
    previousDisplay: at(0),
    previousTimestampMs: T0,
    currentDisplay: at(200),
    currentTimestampMs: T0 + 10_000,
    expectedIntervalMs: 1_000,
    roadRouteOpen: true,
  });

  assert.equal(segment.mode, 'extend', 'the vehicle itself never stopped reporting');
  assert.equal(segment.source, 'none', 'the road taken across 200 m is genuinely unknown');
  assert.equal(segment.vertices.length, 0, 'the blue route is not extended');
  assert.equal(segment.diagnosticVertices.length, 2, 'the stretch is offered as GPS-only');
});

test('the matched-step bound scales with the device cadence', () => {
  // Nothing known about the device yet: the conservative floor.
  assert.equal(matchedStepLimitFor(null), 30);
  assert.equal(matchedStepLimitFor(0), 30);

  // A 1 Hz phone: the distance reachable in a second at the network ceiling.
  assert.ok(
    matchedStepLimitFor(1_000) > 30.9,
    'clears the real 30.9 m sample that produced the reported hole'
  );
  assert.equal(Math.round(matchedStepLimitFor(1_000)), 56);

  // A hardware tracker reporting every two minutes could cover kilometres, but
  // a turn can hide in any of them, so the bound stops at the geometry limit.
  assert.equal(matchedStepLimitFor(120_000), 120);
});
