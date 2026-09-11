import assert from 'node:assert/strict';
import test from 'node:test';

import { applyRouteExtensions, routeDelta } from './routeDelta.ts';

/** A run of `count` vertices marching east, as the document orders them. */
function run(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => [77.59 + (offset + i) * 0.001, 12.97]);
}

/**
 * What the map document would be left holding after `next` was published.
 *
 * The two rules have to agree or the drawn line silently stops being the
 * geometry the screen asked for, so every case checks the result of applying
 * the delta rather than only the delta itself.
 */
function drawnAfter(previous, next) {
  const delta = routeDelta(previous, next);
  return delta === null ? next : applyRouteExtensions(previous, delta);
}

test('a route that grew at the head sends only the new tail', () => {
  const previous = [run(5)];
  const next = [[...run(5), [77.595, 12.97], [77.596, 12.97]]];

  const delta = routeDelta(previous, next);
  assert.equal(delta?.length, 1);
  // The moving head vertex is resent so it is overwritten, not duplicated.
  assert.equal(delta[0].from, 4);
  assert.equal(delta[0].coords.length, 3);
  assert.deepEqual(drawnAfter(previous, next), next);
});

test('a head that merely moved sends one vertex, not the route', () => {
  const previous = [run(400)];
  const next = [[...run(399), [77.59 + 399 * 0.001, 12.9701]]];

  const delta = routeDelta(previous, next);
  assert.equal(delta?.length, 1);
  assert.equal(delta[0].coords.length, 1);
  assert.deepEqual(drawnAfter(previous, next), next);
});

test('an unchanged route sends nothing at all', () => {
  const previous = [run(6), run(4, 20)];
  const next = [run(6), run(4, 20)];

  assert.deepEqual(routeDelta(previous, next), []);
  assert.deepEqual(drawnAfter(previous, next), previous);
});

test('runs shared by reference are settled without reading a coordinate', () => {
  const shared = run(500);
  const previous = [shared, run(3, 90)];
  const next = [shared, [...run(3, 90), [77.694, 12.97]]];

  const delta = routeDelta(previous, next);
  assert.equal(delta?.length, 1);
  assert.equal(delta[0].index, 1);
  assert.deepEqual(drawnAfter(previous, next), next);
});

test('a seek backwards is not growth and forces a full push', () => {
  const previous = [run(9)];
  const next = [run(4)];

  assert.equal(routeDelta(previous, next), null);
  assert.deepEqual(drawnAfter(previous, next), next);
});

test('a vertex that changed behind the head is not growth', () => {
  const previous = [run(6)];
  const rewritten = run(8);
  rewritten[2] = [0.5, 0.5];

  assert.equal(routeDelta(previous, [rewritten]), null);
  assert.deepEqual(drawnAfter(previous, [rewritten]), [rewritten]);
});

test('a different number of runs is a different route', () => {
  assert.equal(routeDelta([run(4)], [run(4), run(4, 50)]), null);
  assert.equal(routeDelta([run(4), run(4, 50)], [run(4)]), null);
});

test('there is no delta against nothing, or against an empty route', () => {
  assert.equal(routeDelta(null, [run(4)]), null);
  assert.equal(routeDelta([], []), null);
});

test('a run too short to have a settled prefix forces a full push', () => {
  // One vertex means the head is the whole run: nothing behind it is known to
  // be unchanged, so the run cannot be extended incrementally.
  assert.equal(routeDelta([[[77.59, 12.97]]], [run(4)]), null);
});

test('a whole playback replays vertex by vertex to the same geometry', () => {
  const full = run(120);
  let previous = [full.slice(0, 2)];
  let drawn = previous;

  for (let vertices = 3; vertices <= full.length; vertices += 1) {
    // Each frame nudges the head, then occasionally commits another vertex —
    // which is exactly the shape the playback screen publishes.
    const head = [full[vertices - 1][0], full[vertices - 1][1] + 0.00001];
    const next = [[...full.slice(0, vertices - 1), head]];
    drawn = drawnAfter(drawn, next);
    assert.deepEqual(drawn, next);
    previous = next;
  }

  assert.equal(drawn[0].length, full.length);
});
