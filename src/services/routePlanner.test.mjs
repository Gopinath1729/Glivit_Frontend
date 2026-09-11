import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRoadGraph } from '@/src/services/roadGraph';
import {
  nearestNode,
  searchRoute,
  simplifyRoute,
  turnPenaltySeconds,
} from '@/src/services/routePlanner';
import { corridorTiles, distanceToSegmentMetres, haversineMetres } from '@/src/services/tileGrid';

/**
 * A hand-built network with a known answer.
 *
 * Two ways from A to D: a slow straight one, and a longer detour on a road
 * fast enough to win. A router weighted by distance picks the first; one
 * weighted by time picks the second, which is what a driver would do.
 */
function twoWayNetwork() {
  const slow = {
    points: [
      [80.20, 13.00],
      [80.21, 13.00],
      [80.22, 13.00],
    ],
    speedKph: 10,
    forward: true,
    backward: true,
    layer: 0,
  };
  const fastDetour = {
    points: [
      [80.20, 13.00],
      [80.21, 13.01],
      [80.22, 13.00],
    ],
    speedKph: 80,
    forward: true,
    backward: true,
    layer: 0,
  };
  return buildRoadGraph([slow, fastDetour], 1);
}

test('shared vertices from different ways become one junction', () => {
  const graph = twoWayNetwork();
  // Five distinct coordinates across two three-point ways sharing both ends.
  assert.equal(graph.nodeCount, 4);
});

test('the search prefers the faster road over the shorter one', () => {
  const graph = twoWayNetwork();
  const start = nearestNode(graph, { latitude: 13.0, longitude: 80.2 });
  const goal = nearestNode(graph, { latitude: 13.0, longitude: 80.22 });
  const route = searchRoute(graph, start, goal);
  assert.ok(route, 'a route exists');
  // The detour climbs to 13.01, so taking it proves time beat distance.
  const usedDetour = route.nodes.some((node) => graph.latitudes[node] > 13.005);
  assert.equal(usedDetour, true);
});

test('a one-way street cannot be driven against', () => {
  const graph = buildRoadGraph(
    [
      {
        points: [
          [80.20, 13.00],
          [80.21, 13.00],
        ],
        speedKph: 40,
        forward: true,
        backward: false,
        layer: 0,
      },
    ],
    1
  );
  const west = nearestNode(graph, { latitude: 13.0, longitude: 80.2 });
  const east = nearestNode(graph, { latitude: 13.0, longitude: 80.21 });
  assert.ok(searchRoute(graph, west, east), 'with the flow is drivable');
  assert.equal(searchRoute(graph, east, west), null, 'against the flow is not');
});

test('a bridge is not joined to the road beneath it', () => {
  const graph = buildRoadGraph(
    [
      {
        points: [
          [80.20, 13.00],
          [80.21, 13.00],
        ],
        speedKph: 40,
        forward: true,
        backward: true,
        layer: 0,
      },
      {
        points: [
          [80.205, 12.99],
          [80.205, 13.00],
        ],
        speedKph: 40,
        forward: true,
        backward: true,
        layer: 1,
      },
    ],
    1
  );
  const onRoad = nearestNode(graph, { latitude: 13.0, longitude: 80.2 });
  const onBridge = nearestNode(graph, { latitude: 12.99, longitude: 80.205 });
  assert.equal(searchRoute(graph, onRoad, onBridge), null);
});

test('a destination with no road near it is refused rather than snapped', () => {
  const graph = twoWayNetwork();
  // Roughly 20 km away: a different neighbourhood, not the nearest junction.
  assert.equal(nearestNode(graph, { latitude: 13.2, longitude: 80.2 }), -1);
});

test('disconnected halves produce no route rather than a straight line', () => {
  const graph = buildRoadGraph(
    [
      {
        points: [
          [80.20, 13.00],
          [80.21, 13.00],
        ],
        speedKph: 40,
        forward: true,
        backward: true,
        layer: 0,
      },
      {
        points: [
          [80.30, 13.00],
          [80.31, 13.00],
        ],
        speedKph: 40,
        forward: true,
        backward: true,
        layer: 0,
      },
    ],
    1
  );
  const west = nearestNode(graph, { latitude: 13.0, longitude: 80.2 });
  const east = nearestNode(graph, { latitude: 13.0, longitude: 80.31 });
  assert.ok(west >= 0 && east >= 0);
  assert.equal(searchRoute(graph, west, east), null);
});

test('simplify keeps the corners and drops the noise', () => {
  const straightWithWobble = [
    { latitude: 13.0, longitude: 80.2 },
    { latitude: 13.000001, longitude: 80.2005 },
    { latitude: 13.0, longitude: 80.201 },
    { latitude: 13.01, longitude: 80.201 },
  ];
  const simplified = simplifyRoute(straightWithWobble);
  assert.equal(simplified.length, 3, 'the sub-metre wobble goes, the turn stays');
  assert.deepEqual(simplified[0], straightWithWobble[0]);
  assert.deepEqual(simplified[2], straightWithWobble[3]);
});

test('the corridor follows the line rather than the bounding box', () => {
  const from = { latitude: 13.0, longitude: 80.2 };
  const to = { latitude: 13.1, longitude: 80.3 };
  const tiles = corridorTiles(from, to, 1_500, 500, 14);
  assert.ok(tiles.length > 0, 'the corridor covers something');
  // Every tile has to be near the line: the far corner of the bounding box is
  // what this exists to exclude.
  const corner = { latitude: 13.1, longitude: 80.2 };
  assert.ok(distanceToSegmentMetres(corner, from, to) > 1_500);
  const coversCorner = tiles.some(
    (tile) => tile.x === Math.floor(((80.2 + 180) / 360) * 2 ** 14)
      && tile.y === 0
  );
  assert.equal(coversCorner, false);
});

test('the tile budget is never exceeded', () => {
  const tiles = corridorTiles(
    { latitude: 13.0, longitude: 80.0 },
    { latitude: 13.5, longitude: 80.5 },
    9_000,
    40,
    14
  );
  assert.equal(tiles.length, 40);
});

test('haversine agrees with a known distance', () => {
  // One degree of latitude is close to 111 km anywhere.
  const metres = haversineMetres(
    { latitude: 13.0, longitude: 80.0 },
    { latitude: 14.0, longitude: 80.0 }
  );
  assert.ok(Math.abs(metres - 111_195) < 500, `got ${metres}`);
});

test('turning costs nothing when carrying straight on', () => {
  assert.equal(turnPenaltySeconds(90, 90), 0);
  assert.equal(turnPenaltySeconds(0, 350), 0, 'a slight drift is still straight on');
  assert.equal(turnPenaltySeconds(355, 15), 0, 'and it wraps past north');
});

test('a turn costs more the sharper it is, and a U-turn costs most', () => {
  const gentle = turnPenaltySeconds(0, 45);
  const sharp = turnPenaltySeconds(0, 120);
  const uTurn = turnPenaltySeconds(0, 180);
  assert.ok(gentle > 0, 'a real turn is not free');
  assert.ok(sharp > gentle, `sharp ${sharp} should cost more than gentle ${gentle}`);
  assert.ok(uTurn > sharp * 2, `a U-turn ${uTurn} should dominate ${sharp}`);
});

test('turn cost is symmetric between left and right', () => {
  assert.equal(turnPenaltySeconds(0, 90), turnPenaltySeconds(0, 270));
});

test('the search will not immediately double back on itself', () => {
  // A dead-end spur hanging off a through road. Reaching the far end of the
  // road must not be done by driving into the spur and reversing out.
  const graph = buildRoadGraph(
    [
      {
        points: [
          [80.20, 13.00],
          [80.21, 13.00],
          [80.22, 13.00],
        ],
        speedKph: 40,
        forward: true,
        backward: true,
        layer: 0,
      },
      {
        points: [
          [80.21, 13.00],
          [80.21, 13.01],
        ],
        speedKph: 40,
        forward: true,
        backward: true,
        layer: 0,
      },
    ],
    1
  );
  const west = nearestNode(graph, { latitude: 13.0, longitude: 80.2 });
  const east = nearestNode(graph, { latitude: 13.0, longitude: 80.22 });
  const route = searchRoute(graph, west, east);
  assert.ok(route, 'the through road is drivable');
  const enteredSpur = route.nodes.some((node) => graph.latitudes[node] > 13.005);
  assert.equal(enteredSpur, false, 'the spur is not part of the path');
});
