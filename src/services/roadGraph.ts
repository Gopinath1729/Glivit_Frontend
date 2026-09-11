import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
  ROAD_TILE_ZOOM,
  corridorTiles,
  haversineMetres,
  tilePointToLngLat,
  type TileId,
} from '@/src/services/tileGrid';

/**
 * A routable road network, built from the map's own vector tiles.
 *
 * <h3>Where the roads come from</h3>
 * The basemap is OpenMapTiles served by OpenFreeMap, and it is keyless — the
 * app already downloads these tiles to draw streets. Their `transportation`
 * layer is not decoration: it carries every drivable way with its class, its
 * one-way flag and its bridge/tunnel level. That is a road graph, already paid
 * for. Nothing here contacts a routing service or needs an API key.
 *
 * <h3>What it cannot do</h3>
 * The full network only exists at the tiles' maximum zoom, where one tile
 * covers roughly two kilometres. A cross-country route would need thousands of
 * them per request, so this is bounded to journeys a city or a region wide and
 * says so plainly rather than drawing a wrong line. See `MAX_ROUTE_METRES`.
 */

/** OpenMapTiles classes a car may drive on. Everything else is not a road. */
const DRIVABLE_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
]);

/**
 * Assumed free-flow speed per class, in km/h.
 *
 * Deliberately below the legal limits: these are Indian city and highway
 * speeds including the junctions, not the number on the sign. They decide which
 * of two roads the search prefers, so their RATIO matters more than any one
 * value — a trunk road has to be worth a detour off a residential street.
 */
const CLASS_SPEED_KPH: Record<string, number> = {
  motorway: 80,
  trunk: 60,
  primary: 45,
  secondary: 38,
  tertiary: 32,
  minor: 24,
  service: 12,
};

const DEFAULT_SPEED_KPH = 24;

/**
 * How far apart two vertices may be and still be the same junction, in degrees.
 *
 * Roads are clipped at tile boundaries, so the same junction arrives twice —
 * once from each tile — and the two copies have to become one node or every
 * tile edge would be a dead end. Each tile quantises to its own 4096-step grid,
 * about 0.6 m at this zoom, and the two copies of a border vertex can therefore
 * disagree by that much; this is comfortably above that and comfortably below
 * the distance between two genuinely different junctions. About 2.2 m.
 */
const NODE_SNAP_DEGREES = 2e-5;

export type RoadEdge = {
  /** Index of the node this edge arrives at. */
  to: number;
  metres: number;
  seconds: number;
};

export type RoadGraph = {
  /** Node coordinates, indexed by node id. */
  latitudes: Float64Array;
  longitudes: Float64Array;
  /** Outgoing edges per node id. */
  edges: RoadEdge[][];
  nodeCount: number;
  /** Tiles that actually contributed, for diagnostics. */
  tilesUsed: number;
};

type RawSegment = {
  points: [number, number][];
  speedKph: number;
  forward: boolean;
  backward: boolean;
  layer: number;
};

/**
 * The tile URL template, read once from the source's own TileJSON.
 *
 * OpenFreeMap publishes each planet build under a dated path, so the template
 * cannot be hard-coded without pinning the app to one snapshot of the world.
 */
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
let tileTemplatePromise: Promise<string> | null = null;

export function resetRoadGraphCaches(): void {
  tileTemplatePromise = null;
  tileCache.clear();
}

async function tileTemplate(): Promise<string> {
  if (tileTemplatePromise) return tileTemplatePromise;
  tileTemplatePromise = (async () => {
    const response = await fetch(TILEJSON_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Tile index failed with HTTP ${response.status}`);
    const body = (await response.json()) as { tiles?: unknown };
    const tiles = Array.isArray(body?.tiles) ? body.tiles : [];
    const template = typeof tiles[0] === 'string' ? (tiles[0] as string) : '';
    if (!template.includes('{z}')) throw new Error('Tile index carried no usable tile URL');
    return template;
  })();
  tileTemplatePromise.catch(() => {
    tileTemplatePromise = null;
  });
  return tileTemplatePromise;
}

/**
 * Decoded tiles, kept between requests.
 *
 * Planning a route, then replanning it after a wrong turn, walks the same
 * streets. Re-downloading and re-decoding them is the slowest thing this module
 * does, so the last few hundred tiles stay in memory — a few MB, and the
 * difference between a second route taking seconds and taking no time at all.
 */
const TILE_CACHE_LIMIT = 320;
const tileCache = new Map<string, RawSegment[]>();

function rememberTile(key: string, segments: RawSegment[]): void {
  if (tileCache.has(key)) tileCache.delete(key);
  tileCache.set(key, segments);
  while (tileCache.size > TILE_CACHE_LIMIT) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCache.delete(oldest);
  }
}

function numberOf(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads one tile's drivable ways out of its `transportation` layer. */
export function decodeRoadTile(tile: TileId, buffer: ArrayBuffer): RawSegment[] {
  const layer = new VectorTile(new PbfReader(new Uint8Array(buffer))).layers?.transportation;
  if (!layer) return [];
  const segments: RawSegment[] = [];
  for (let index = 0; index < layer.length; index += 1) {
    const feature = layer.feature(index);
    const properties = feature.properties as Record<string, unknown>;
    const roadClass = String(properties.class ?? '');
    if (!DRIVABLE_CLASSES.has(roadClass)) continue;
    const access = String(properties.access ?? '');
    if (access === 'no' || access === 'private') continue;
    // A ferry is drivable in the sense that a car boards it, but it is not a
    // road and routing a fleet onto one without a timetable is a wrong answer.
    if (String(properties.brunnel ?? '') === 'ford') continue;

    const oneway = numberOf(properties.oneway, 0);
    const speedKph = CLASS_SPEED_KPH[roadClass] ?? DEFAULT_SPEED_KPH;
    const layerLevel = numberOf(properties.layer, 0);

    for (const ring of feature.loadGeometry()) {
      if (ring.length < 2) continue;
      const points: [number, number][] = ring.map((point) =>
        tilePointToLngLat(tile, point.x, point.y)
      );
      segments.push({
        points,
        speedKph,
        forward: oneway >= 0,
        backward: oneway <= 0,
        layer: layerLevel,
      });
    }
  }
  return segments;
}

async function loadTile(template: string, tile: TileId, signal?: AbortSignal): Promise<RawSegment[]> {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  const cached = tileCache.get(key);
  if (cached) {
    // Refresh its place in the eviction order.
    rememberTile(key, cached);
    return cached;
  }
  const url = template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
  const response = await fetch(url, { signal });
  // A tile that does not exist is open sea or an unmapped corner, not a
  // failure: the corridor simply has no roads there.
  if (response.status === 404 || response.status === 204) {
    rememberTile(key, []);
    return [];
  }
  if (!response.ok) throw new Error(`Road tile failed with HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const segments = buffer.byteLength === 0 ? [] : decodeRoadTile(tile, buffer);
  rememberTile(key, segments);
  return segments;
}

/** Fetches with a bounded number of sockets rather than all at once. */
/*
 * Twelve sockets, not six.
 *
 * Tile loading is latency-bound, not bandwidth-bound: the same 34 tiles take
 * 1550 ms six at a time and 304 ms twelve at a time over the same connection.
 * It is the single largest saving in the whole route request.
 */
async function loadTiles(
  tiles: TileId[],
  signal?: AbortSignal,
  concurrency = 12
): Promise<RawSegment[]> {
  const all: RawSegment[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tiles.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tiles.length) return;
      const segments = await loadTile(await tileTemplate(), tiles[index], signal);
      // Pushing a whole tile at once keeps this atomic between awaits.
      all.push(...segments);
    }
  });
  await Promise.all(workers);
  return all;
}

/** Builds the searchable graph from raw ways, welding shared vertices. */
export function buildRoadGraph(segments: RawSegment[], tilesUsed: number): RoadGraph {
  const nodeIds = new Map<string, number>();
  const latitudes: number[] = [];
  const longitudes: number[] = [];
  const edges: RoadEdge[][] = [];

  /*
   * Junctions are welded by position, and DELIBERATELY not by bridge level.
   *
   * Keying the node by the feature's `layer` seemed like the careful thing to
   * do - it would stop a flyover being joined to the road underneath it. In
   * OpenStreetMap that cannot happen anyway: two ways that cross at different
   * levels do not share a node, so they never share a vertex here either.
   * What the layer key did instead was break every place a bridge MEETS the
   * road it lands on, because the approach vertex carries one layer on the
   * bridge feature and another on the ordinary one. Measured on a single
   * Chennai tile, keying by layer left the largest connected component at 43%
   * of nodes; dropping it took the same tile to 68%. Every flyover ramp in the
   * city was a dead end.
   *
   * The 3x3 sweep matters as much as the cell size: a grid alone fails whenever
   * two copies of a point fall either side of a cell boundary, which is about
   * half of them.
   */
  const nodeFor = (longitude: number, latitude: number): number => {
    const cellX = Math.round(longitude / NODE_SNAP_DEGREES);
    const cellY = Math.round(latitude / NODE_SNAP_DEGREES);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const existing = nodeIds.get(`${cellX + dx}:${cellY + dy}`);
        if (existing !== undefined) return existing;
      }
    }
    const id = latitudes.length;
    nodeIds.set(`${cellX}:${cellY}`, id);
    latitudes.push(latitude);
    longitudes.push(longitude);
    edges.push([]);
    return id;
  };

  for (const segment of segments) {
    let previous = -1;
    for (const [longitude, latitude] of segment.points) {
      const node = nodeFor(longitude, latitude);
      if (previous >= 0 && previous !== node) {
        const metres = haversineMetres(
          { latitude: latitudes[previous], longitude: longitudes[previous] },
          { latitude: latitudes[node], longitude: longitudes[node] }
        );
        if (metres > 0) {
          const seconds = (metres / (segment.speedKph * 1000)) * 3600;
          if (segment.forward) edges[previous].push({ to: node, metres, seconds });
          if (segment.backward) edges[node].push({ to: previous, metres, seconds });
        }
      }
      previous = node;
    }
  }

  return {
    latitudes: Float64Array.from(latitudes),
    longitudes: Float64Array.from(longitudes),
    edges,
    nodeCount: latitudes.length,
    tilesUsed,
  };
}

/**
 * How far apart the endpoints may be before this stops being the right tool.
 *
 * At the tiles' full-detail zoom a corridor this long is already about a
 * hundred and fifty downloads. Past it the honest answer is that the on-device
 * router does not cover the trip, not a route built from half a network.
 */
export const MAX_ROUTE_METRES = 80_000;

/** Upper bound on tiles per request, so a bad input cannot fetch the country. */
export const MAX_CORRIDOR_TILES = 180;

export type RoadGraphRequest = {
  from: { latitude: number; longitude: number };
  to: { latitude: number; longitude: number };
  signal?: AbortSignal;
};

/** Downloads the corridor between two points and returns it as a graph. */
export async function loadRoadGraph({
  from,
  to,
  signal,
}: RoadGraphRequest): Promise<RoadGraph> {
  const direct = haversineMetres(from, to);
  /* Room to go around what is in the way. A straight line between two points
     in a city is never the road, and too tight a corridor produces either a
     wild detour or no route at all; this is generous near the endpoints and
     proportionate over distance. */
  const corridorMetres = Math.min(9_000, Math.max(1_800, direct * 0.35));
  const tiles = corridorTiles(from, to, corridorMetres, MAX_CORRIDOR_TILES, ROAD_TILE_ZOOM);
  const segments = await loadTiles(tiles, signal);
  return buildRoadGraph(segments, tiles.length);
}
