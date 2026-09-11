import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createDestinationPassTracker,
  observeDestinationPass,
  projectPositionOnRoute,
  splitRouteAtProjection,
} =
  await import('./navigationProgress.ts');

test('projects for progress without replacing the real vehicle coordinate', () => {
  const route = [
    [77.0, 12.0],
    [77.01, 12.0],
    [77.02, 12.0],
  ];
  const vehicle = { latitude: 12.0002, longitude: 77.006 };
  const projected = projectPositionOnRoute(route, vehicle);

  assert.ok(projected);
  assert.ok(projected.distanceToRouteMeters > 15);
  assert.deepEqual(vehicle, { latitude: 12.0002, longitude: 77.006 });
  assert.equal(projected.coordinate[1], 12);
});

test('route progress is monotonic when a later sample is close to an earlier segment', () => {
  const route = [
    [77.0, 12.0],
    [77.01, 12.0],
    [77.02, 12.0],
  ];
  const first = projectPositionOnRoute(route, { latitude: 12, longitude: 77.012 });
  assert.ok(first);
  const later = projectPositionOnRoute(
    route,
    { latitude: 12, longitude: 77.005 },
    first.alongRouteMeters
  );

  assert.ok(later);
  assert.ok(later.alongRouteMeters >= first.alongRouteMeters);
});

test('splits completed and remaining overlays at the same projected point', () => {
  const route = [
    [77.0, 12.0],
    [77.01, 12.0],
    [77.02, 12.0],
  ];
  const projected = projectPositionOnRoute(route, { latitude: 12, longitude: 77.006 });
  assert.ok(projected);
  const split = splitRouteAtProjection(route, projected);

  assert.deepEqual(split.completed.at(-1), split.remaining[0]);
  assert.deepEqual(split.remaining.at(-1), route.at(-1));
});

test('arms inside 15 metres and fires once when a moving vehicle passes the destination', () => {
  let tracker = createDestinationPassTracker();
  let observation = observeDestinationPass(tracker, 14, true);
  assert.equal(observation.passed, false);
  tracker = observation.tracker;

  observation = observeDestinationPass(tracker, 21, true);
  assert.equal(observation.passed, true);
  tracker = observation.tracker;

  observation = observeDestinationPass(tracker, 35, true);
  assert.equal(observation.passed, false);
  assert.equal(observation.tracker.handled, true);
});

test('never reports a pass when the vehicle did not enter destination proximity', () => {
  let tracker = createDestinationPassTracker();
  for (const distance of [40, 32, 24, 30, 45]) {
    const observation = observeDestinationPass(tracker, distance, true);
    assert.equal(observation.passed, false);
    tracker = observation.tracker;
  }
});

test('boundary jitter and stationary drift cannot trigger destination passed', () => {
  let tracker = createDestinationPassTracker();
  for (const [distance, moving] of [[14, true], [17, true], [13, true], [22, false]]) {
    const observation = observeDestinationPass(tracker, distance, moving);
    assert.equal(observation.passed, false);
    tracker = observation.tracker;
  }
});
