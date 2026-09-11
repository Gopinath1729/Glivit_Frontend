import {
  MAX_ROUTE_METRES,
  loadRoadGraph,
  type RoadGraph,
} from '@/src/services/roadGraph';
import { haversineMetres } from '@/src/services/tileGrid';

/**
 * The route search.
 *
 * <h3>Dijkstra, guided</h3>
 * This is Dijkstra's algorithm with a lower-bound estimate of the remaining
 * cost added to each node's priority — A*. The estimate is the straight-line
 * time to the destination at the fastest speed any road in the graph can carry,
 * which can never exceed the true remaining cost, and an admissible heuristic
 * is exactly the condition under which A* returns the same optimal path
 * Dijkstra would while expanding a fraction of the nodes. On a city graph that
 * is the difference between a search that settles in milliseconds and one that
 * walks every street in the corridor before it looks at the destination.
 *
 * <h3>Cost</h3>
 * Edges are weighted by TIME, not distance. Weighting by distance is what makes
 * a router send a lorry through a housing estate to save two hundred metres;
 * time is what a driver is actually choosing between, and it is what makes a
 * trunk road worth the detour to reach.
 */

export type RoutePoint = { latitude: number; longitude: number };

export type PlannedRoute = {
  coordinates: RoutePoint[];
  distanceMeters: number;
  durationSeconds: number;
  /** How much of the corridor had to be read to find it. */
  tilesUsed: number;
};

export class RoutePlanningError extends Error {
  readonly code:
    | 'OUT_OF_RANGE'
    | 'NO_ROADS'
    | 'NO_ROUTE'
    | 'SAME_POINT'
    | 'NETWORK';

  constructor(code: RoutePlanningError['code'], message: string) {
    super(message);
    this.name = 'RoutePlanningError';
    this.code = code;
  }
}

/**
 * A binary min-heap keyed by estimated total cost.
 *
 * The obvious alternative — scanning an array for the cheapest open node — is
 * O(n) per step, and with tens of thousands of nodes that quadratic term is the
 * whole running time of the search.
 */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, cost: number): void {
    this.nodes.push(node);
    this.costs.push(cost);
    let index = this.nodes.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.costs[parent] <= this.costs[index]) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0];
    const lastNode = this.nodes.pop() as number;
    const lastCost = this.costs.pop() as number;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.costs[0] = lastCost;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.costs.length && this.costs[left] < this.costs[smallest]) smallest = left;
        if (right < this.costs.length && this.costs[right] < this.costs[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(smallest, index);
        index = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const node = this.nodes[a];
    this.nodes[a] = this.nodes[b];
    this.nodes[b] = node;
    const cost = this.costs[a];
    this.costs[a] = this.costs[b];
    this.costs[b] = cost;
  }
}

/**
 * The node a journey starts or ends at.
 *
 * A destination is a doorway, not a junction, so the search has to begin at
 * whichever piece of road is nearest to it. Anything further away than
 * `maxMetres` is not "the nearest road" but a different neighbourhood, and
 * silently snapping to it is how a route ends up starting on the wrong side of
 * a river.
 */
export function nearestNode(
  graph: RoadGraph,
  point: RoutePoint,
  maxMetres = 900
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let node = 0; node < graph.nodeCount; node += 1) {
    // A cheap rectangular reject before the trigonometry: at these latitudes a
    // degree is ~110 km, so this discards almost everything for free.
    const dLat = Math.abs(graph.latitudes[node] - point.latitude);
    if (dLat > 0.02) continue;
    const dLng = Math.abs(graph.longitudes[node] - point.longitude);
    if (dLng > 0.02) continue;
    const distance = haversineMetres(point, {
      latitude: graph.latitudes[node],
      longitude: graph.longitudes[node],
    });
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return bestDistance <= maxMetres ? best : -1;
}

/**
 * Which nodes can reach which, ignoring one-way rules.
 *
 * A corridor cut out of a tiled map is never one network: roads leave it and
 * are clipped, service yards sit behind gates the data does not describe, and
 * every one of those becomes its own island. Most are tiny; one holds the real
 * street network.
 */
export function connectedComponents(graph: RoadGraph): Int32Array {
  const component = new Int32Array(graph.nodeCount).fill(-1);
  const neighbours: number[][] = Array.from({ length: graph.nodeCount }, () => []);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    for (const edge of graph.edges[node]) {
      neighbours[node].push(edge.to);
      neighbours[edge.to].push(node);
    }
  }
  const stack: number[] = [];
  let next = 0;
  for (let seed = 0; seed < graph.nodeCount; seed += 1) {
    if (component[seed] >= 0) continue;
    const id = next;
    next += 1;
    component[seed] = id;
    stack.push(seed);
    while (stack.length > 0) {
      const node = stack.pop() as number;
      for (const neighbour of neighbours[node]) {
        if (component[neighbour] >= 0) continue;
        component[neighbour] = id;
        stack.push(neighbour);
      }
    }
  }
  return component;
}

/** Candidate nodes near a point, nearest first. */
function nearbyNodes(
  graph: RoadGraph,
  point: RoutePoint,
  maxMetres: number
): { node: number; metres: number }[] {
  const found: { node: number; metres: number }[] = [];
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const dLat = Math.abs(graph.latitudes[node] - point.latitude);
    if (dLat > 0.02) continue;
    const dLng = Math.abs(graph.longitudes[node] - point.longitude);
    if (dLng > 0.02) continue;
    const metres = haversineMetres(point, {
      latitude: graph.latitudes[node],
      longitude: graph.longitudes[node],
    });
    if (metres <= maxMetres) found.push({ node, metres });
  }
  found.sort((a, b) => a.metres - b.metres);
  return found;
}

/**
 * The pair of nodes to actually search between.
 *
 * Snapping each end to its own nearest vertex is the obvious approach and it
 * fails constantly: the nearest vertex to a yard gate is often a stub of
 * service road that connects to nothing, and the search then correctly reports
 * that no route exists. What is wanted is the nearest pair that can reach each
 * other at all, so both ends are pulled onto the same network — at the cost of
 * a few metres of walking at the kerb, which is what the last few metres of any
 * journey are anyway.
 */
export function nearestConnectedPair(
  graph: RoadGraph,
  from: RoutePoint,
  to: RoutePoint,
  maxMetres = 1_200
): { startNode: number; goalNode: number } | null {
  const starts = nearbyNodes(graph, from, maxMetres);
  const goals = nearbyNodes(graph, to, maxMetres);
  if (starts.length === 0 || goals.length === 0) return null;

  const component = connectedComponents(graph);
  // The nearest goal candidate in each reachable component, so the scan below
  // is over components rather than over every pair.
  const bestGoalPerComponent = new Map<number, { node: number; metres: number }>();
  for (const goal of goals) {
    const id = component[goal.node];
    if (!bestGoalPerComponent.has(id)) bestGoalPerComponent.set(id, goal);
  }

  let best: { startNode: number; goalNode: number; cost: number } | null = null;
  for (const start of starts) {
    const goal = bestGoalPerComponent.get(component[start.node]);
    if (!goal) continue;
    const cost = start.metres + goal.metres;
    if (!best || cost < best.cost) {
      best = { startNode: start.node, goalNode: goal.node, cost };
    }
    // Candidates are sorted, so once the start alone costs more than the best
    // pair found, nothing later can win.
    if (best && start.metres > best.cost) break;
  }
  return best ? { startNode: best.startNode, goalNode: best.goalNode } : null;
}

/** The fastest edge speed present, for the heuristic's lower bound. */
function fastestMetresPerSecond(graph: RoadGraph): number {
  let fastest = 1;
  for (const list of graph.edges) {
    for (const edge of list) {
      if (edge.seconds <= 0) continue;
      const speed = edge.metres / edge.seconds;
      if (speed > fastest) fastest = speed;
    }
  }
  return fastest;
}

export type SearchResult = {
  nodes: number[];
  metres: number;
  seconds: number;
};

/**
 * Seconds added for turning, by how sharp the turn is.
 *
 * Without these a route through a grid of streets staircases: cutting the
 * diagonal by alternating left and right is geometrically shorter than going
 * around two sides, so a search that only counts road time takes it every
 * time. Measured on Padi to Kotturpuram, a third of the chosen route was
 * residential street taken exactly that way. A driver does not do this,
 * because turning costs time the map does not show - junctions, give-ways,
 * oncoming traffic. Charging for it is what keeps the search on the main road.
 */
const STRAIGHT_ON_DEGREES = 25;
const TURN_SECONDS = 4;
const SHARP_TURN_DEGREES = 100;
const SHARP_TURN_SECONDS = 9;
/** A U-turn is almost never what was meant; it stays legal but expensive. */
const U_TURN_SECONDS = 45;

function bearingDegrees(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cost of swinging from one heading onto another, in seconds. */
export function turnPenaltySeconds(fromBearing: number, toBearing: number): number {
  const change = Math.abs(((toBearing - fromBearing + 540) % 360) - 180);
  if (change <= STRAIGHT_ON_DEGREES) return 0;
  if (change >= 175) return U_TURN_SECONDS;
  if (change >= SHARP_TURN_DEGREES) return SHARP_TURN_SECONDS;
  return TURN_SECONDS;
}

/**
 * A* over the road graph, returning the cheapest path in time.
 *
 * The search state is the EDGE just driven, not the junction reached. It has
 * to be: what it costs to leave a junction depends on the direction you
 * arrived from, and a node-keyed search cannot represent that, so it cannot
 * charge for a turn without sometimes charging the wrong one. A road network
 * has only about twice as many edges as nodes, so this costs little and is
 * what makes the turn penalties above correct rather than approximate.
 *
 * Exported on its own so the search can be tested against a hand-built graph
 * with a known answer, without a network in the way.
 */
export function searchRoute(
  graph: RoadGraph,
  startNode: number,
  goalNode: number
): SearchResult | null {
  if (startNode < 0 || goalNode < 0) return null;
  if (startNode === goalNode) return { nodes: [startNode], metres: 0, seconds: 0 };

  // Flatten the adjacency into edge records the search can key on.
  const edgeTail: number[] = [];
  const edgeHead: number[] = [];
  const edgeSeconds: number[] = [];
  const edgeMetres: number[] = [];
  const outgoing: number[][] = Array.from({ length: graph.nodeCount }, () => []);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    for (const edge of graph.edges[node]) {
      const id = edgeTail.length;
      edgeTail.push(node);
      edgeHead.push(edge.to);
      edgeSeconds.push(edge.seconds);
      edgeMetres.push(edge.metres);
      outgoing[node].push(id);
    }
  }

  const edgeCount = edgeTail.length;
  if (edgeCount === 0) return null;
  const edgeBearing = new Float64Array(edgeCount);
  for (let id = 0; id < edgeCount; id += 1) {
    edgeBearing[id] = bearingDegrees(
      graph.latitudes[edgeTail[id]],
      graph.longitudes[edgeTail[id]],
      graph.latitudes[edgeHead[id]],
      graph.longitudes[edgeHead[id]]
    );
  }

  const bestSeconds = new Float64Array(edgeCount).fill(Number.POSITIVE_INFINITY);
  const bestMetres = new Float64Array(edgeCount);
  const cameFrom = new Int32Array(edgeCount).fill(-1);
  const settled = new Uint8Array(edgeCount);

  const goal = {
    latitude: graph.latitudes[goalNode],
    longitude: graph.longitudes[goalNode],
  };
  const ceilingSpeed = fastestMetresPerSecond(graph);
  const heuristic = (node: number): number =>
    haversineMetres(
      { latitude: graph.latitudes[node], longitude: graph.longitudes[node] },
      goal
    ) / ceilingSpeed;

  const open = new MinHeap();
  for (const id of outgoing[startNode]) {
    bestSeconds[id] = edgeSeconds[id];
    bestMetres[id] = edgeMetres[id];
    open.push(id, bestSeconds[id] + heuristic(edgeHead[id]));
  }

  let arrival = -1;
  while (open.size > 0) {
    const edge = open.pop();
    if (settled[edge]) continue;
    settled[edge] = 1;
    if (edgeHead[edge] === goalNode) {
      arrival = edge;
      break;
    }
    for (const next of outgoing[edgeHead[edge]]) {
      if (settled[next]) continue;
      // Never immediately retrace the edge just driven.
      if (edgeHead[next] === edgeTail[edge] && edgeTail[next] === edgeHead[edge]) continue;
      const seconds =
        bestSeconds[edge] +
        edgeSeconds[next] +
        turnPenaltySeconds(edgeBearing[edge], edgeBearing[next]);
      if (seconds >= bestSeconds[next]) continue;
      bestSeconds[next] = seconds;
      bestMetres[next] = bestMetres[edge] + edgeMetres[next];
      cameFrom[next] = edge;
      open.push(next, seconds + heuristic(edgeHead[next]));
    }
  }

  if (arrival < 0) return null;

  const nodes: number[] = [edgeHead[arrival]];
  for (let edge = arrival; edge >= 0; edge = cameFrom[edge]) {
    nodes.push(edgeTail[edge]);
  }
  nodes.reverse();
  if (nodes[0] !== startNode) return null;
  return { nodes, metres: bestMetres[arrival], seconds: bestSeconds[arrival] };
}

/**
 * Removes vertices that carry no shape.
 *
 * Tile geometry is dense — every kerb wobble is a vertex — and the route is
 * pushed to the map, redrawn on every playback frame and stored on shared
 * trips. Douglas-Peucker at a couple of metres keeps every turn while dropping
 * most of the points that only describe the width of the tarmac.
 */
export function simplifyRoute(points: RoutePoint[], toleranceMetres = 2.5): RoutePoint[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let furthest = -1;
    let furthestDistance = toleranceMetres;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularMetres(points[index], points[first], points[last]);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthest = index;
      }
    }
    if (furthest > 0) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }

  const simplified: RoutePoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index]) simplified.push(points[index]);
  }
  return simplified;
}

function perpendicularMetres(point: RoutePoint, start: RoutePoint, end: RoutePoint): number {
  const latScale = 110_540;
  const lngScale = 111_320 * Math.cos((start.latitude * Math.PI) / 180);
  const px = point.longitude * lngScale;
  const py = point.latitude * latScale;
  const ax = start.longitude * lngScale;
  const ay = start.latitude * latScale;
  const bx = end.longitude * lngScale;
  const by = end.latitude * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export type PlanRouteRequest = {
  from: RoutePoint;
  to: RoutePoint;
  signal?: AbortSignal;
};

/**
 * Plan a drivable route between two points, using no routing service at all.
 */
export async function planRoute({
  from,
  to,
  signal,
}: PlanRouteRequest): Promise<PlannedRoute> {
  const direct = haversineMetres(from, to);
  if (direct < 25) {
    throw new RoutePlanningError('SAME_POINT', 'Pick two different places to route between.');
  }
  if (direct > MAX_ROUTE_METRES) {
    throw new RoutePlanningError(
      'OUT_OF_RANGE',
      `On-device routing covers journeys up to ${Math.round(MAX_ROUTE_METRES / 1000)} km. ` +
        `These points are ${Math.round(direct / 1000)} km apart in a straight line.`
    );
  }

  let graph: RoadGraph;
  try {
    graph = await loadRoadGraph({ from, to, signal });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    throw new RoutePlanningError(
      'NETWORK',
      'Road data could not be downloaded. Check the connection and try again.'
    );
  }

  if (graph.nodeCount === 0) {
    throw new RoutePlanningError('NO_ROADS', 'No mapped roads were found around these points.');
  }

  const pair = nearestConnectedPair(graph, from, to);
  if (!pair) {
    const reachedStart = nearestNode(graph, from) >= 0;
    throw new RoutePlanningError(
      'NO_ROADS',
      reachedStart
        ? 'No road near the destination connects to the road network around the start.'
        : 'No road was found near the starting point.'
    );
  }

  const found = searchRoute(graph, pair.startNode, pair.goalNode);
  if (!found) {
    throw new RoutePlanningError(
      'NO_ROUTE',
      'No connected road was found between these two points.'
    );
  }

  const coordinates = found.nodes.map((node) => ({
    latitude: graph.latitudes[node],
    longitude: graph.longitudes[node],
  }));

  return {
    coordinates: simplifyRoute(coordinates),
    distanceMeters: found.metres,
    durationSeconds: found.seconds,
    tilesUsed: graph.tilesUsed,
  };
}
