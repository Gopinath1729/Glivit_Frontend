import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPlaybackRoute, routeProgressAt } from './playbackRoute.ts';
import { buildPlaybackTrack, routeSegments } from './playbackEngine.ts';

/**
 * The route-splitting rule, written out independently of the code under test.
 *
 * The measured road has to be the same geometry the map draws, and the drawn
 * geometry comes from the shared splitter in a .tsx module the test runner
 * cannot load. Restating the rule here is what makes this a check rather than a
 * tautology: a run breaks at an unusable vertex, vertices within half a metre
 * are the same place, and fewer than two vertices is not a line.
 */
function referenceSplit(coordinates) {
  const runs = [];
  let current = [];
  const flush = () => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };
  for (const candidate of coordinates) {
    const { latitude, longitude } = candidate ?? {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && metresBetween(previous, candidate) < 0.5) continue;
    current.push(candidate);
  }
  flush();
  return runs;
}

function metresBetween(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
/** ~1 m of latitude. */
const METRE = 1 / 111_320;
const START = Date.parse('2026-09-08T06:00:00.000Z');

/** A fix `metres` north of the origin, `seconds` into the recording. */
function fix(metres, seconds, extra = {}) {
  return {
    lat: BASE_LAT + metres * METRE,
    lng: BASE_LNG,
    t: new Date(START + seconds * 1000).toISOString(),
    speed: 20,
    course: 0,
    ignition: true,
    gpsValid: true,
    ...extra,
  };
}

function track(points) {
  return buildPlaybackTrack(points, { pointsAreClean: true });
}

test('the measured road is the same geometry every other layer draws', () => {
  // The drawn route and the measured route must not be two implementations of
  // one rule, or the clipped line stops matching the road under it.
  const built = track([fix(0, 0), fix(50, 10), fix(120, 20), fix(200, 30)]);
  const drawn = routeSegments(built).flatMap((segment) => referenceSplit(segment));
  const measured = buildPlaybackRoute(built);

  assert.equal(measured.length, drawn.length);
  measured.forEach((run, index) => {
    assert.deepEqual(
      run.coordinates,
      drawn[index].map((point) => [point.longitude, point.latitude])
    );
  });
});

test('vertices closer than half a metre are the same place', () => {
  const measured = buildPlaybackRoute(track([fix(0, 0), fix(0.2, 5), fix(60, 10)]));
  assert.equal(measured.length, 1);
  assert.equal(measured[0].coordinates.length, 2);
});

test('a coverage gap is two runs, never one line across it', () => {
  const measured = buildPlaybackRoute(
    track([fix(0, 0), fix(60, 10), fix(4000, 900, { gapBefore: true }), fix(4060, 910)])
  );
  assert.equal(measured.length, 2);
});

test('cumulative metres measure the run, and the total is its last entry', () => {
  const [run] = buildPlaybackRoute(track([fix(0, 0), fix(100, 10), fix(300, 30)]));
  assert.equal(run.cumulativeMeters[0], 0);
  assert.ok(Math.abs(run.cumulativeMeters[1] - 100) < 1);
  assert.ok(Math.abs(run.totalMeters - 300) < 1.5);
  assert.equal(run.totalMeters, run.cumulativeMeters[run.cumulativeMeters.length - 1]);
});

test('progress runs from the start of the road to the end of it', () => {
  const runs = buildPlaybackRoute(track([fix(0, 0), fix(100, 10), fix(200, 20)]));

  assert.deepEqual(routeProgressAt(runs, 0), { runIndex: 0, fraction: 0 });
  const middle = routeProgressAt(runs, 10_000);
  assert.equal(middle.runIndex, 0);
  assert.ok(Math.abs(middle.fraction - 0.5) < 0.01);
  const end = routeProgressAt(runs, 20_000);
  assert.equal(end.runIndex, 0);
  assert.ok(Math.abs(end.fraction - 1) < 1e-9);
});

test('progress interpolates between vertices rather than stepping', () => {
  const runs = buildPlaybackRoute(track([fix(0, 0), fix(200, 20)]));
  const quarter = routeProgressAt(runs, 5_000);
  assert.ok(Math.abs(quarter.fraction - 0.25) < 0.01);
});

test('time spent in a coverage gap holds at the end of the run before it', () => {
  const runs = buildPlaybackRoute(
    track([fix(0, 0), fix(100, 10), fix(5000, 600, { gapBefore: true }), fix(5100, 610)])
  );
  assert.equal(runs.length, 2);

  // Mid-gap: the vehicle is held at the last thing anyone observed.
  assert.deepEqual(routeProgressAt(runs, 300_000), { runIndex: 0, fraction: 1 });
  // And once the next run starts, progress belongs to that run.
  assert.equal(routeProgressAt(runs, 605_000).runIndex, 1);
});

test('a playhead past the end stays at the end of the last run', () => {
  const runs = buildPlaybackRoute(track([fix(0, 0), fix(100, 10)]));
  assert.deepEqual(routeProgressAt(runs, 9_999_999), { runIndex: 0, fraction: 1 });
});

test('a track with no drawable road has no progress to report', () => {
  assert.equal(routeProgressAt([], 1000), null);
  assert.deepEqual(buildPlaybackRoute(track([fix(0, 0)])), []);
});

test('progress never leaves 0..1 and never reads NaN', () => {
  const runs = buildPlaybackRoute(track([fix(0, 0), fix(80, 8), fix(160, 16)]));
  for (let elapsed = -5_000; elapsed <= 25_000; elapsed += 137) {
    const progress = routeProgressAt(runs, elapsed);
    assert.ok(Number.isFinite(progress.fraction), `fraction at ${elapsed}`);
    assert.ok(progress.fraction >= 0 && progress.fraction <= 1, `range at ${elapsed}`);
  }
});

test('progress only ever moves forward as the clock does', () => {
  const runs = buildPlaybackRoute(
    track([fix(0, 0), fix(120, 12), fix(900, 300, { gapBefore: true }), fix(1100, 320)])
  );
  let previous = -1;
  for (let elapsed = 0; elapsed <= 320_000; elapsed += 250) {
    const { runIndex, fraction } = routeProgressAt(runs, elapsed);
    const absolute = runIndex + fraction;
    assert.ok(absolute >= previous - 1e-9, `went backwards at ${elapsed}`);
    previous = absolute;
  }
});
