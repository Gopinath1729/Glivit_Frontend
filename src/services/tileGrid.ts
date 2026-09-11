/**
 * Web-Mercator tile arithmetic for the road graph.
 *
 * The router reads the same keyless OpenFreeMap vector tiles the map already
 * draws, so everything it needs to know about where a road is comes down to
 * turning coordinates into tile numbers and tile-local units back into
 * coordinates. Kept separate from the graph itself because it is pure integer
 * and trigonometric arithmetic, and is the part worth testing exhaustively.
 */

/**
 * The zoom the router reads.
 *
 * OpenMapTiles only carries the complete road network — residential streets,
 * service roads, the lot — at its maximum zoom. Anything lower drops the minor
 * roads that most journeys start and end on, so a route planned there would
 * begin by teleporting to the nearest main road.
 */
export const ROAD_TILE_ZOOM = 14;

/** MVT tile-local coordinate space. OpenMapTiles publishes 4096. */
export const TILE_EXTENT = 4096;

export type TileId = { z: number; x: number; y: number };

export function lngToTileX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * 2 ** zoom;
}

export function latToTileY(latitude: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (clamped * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** zoom
  );
}

export function tileXToLng(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

export function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Turn a tile-local MVT vertex into a coordinate.
 *
 * A vertex may land outside 0..extent: OpenMapTiles carries a buffer of
 * geometry from the neighbouring tile so lines can be drawn without a seam.
 * That overlap is useful here — it is what lets a road clipped at a tile edge
 * be matched to its continuation in the next tile.
 */
export function tilePointToLngLat(
  tile: TileId,
  localX: number,
  localY: number
): [number, number] {
  const scale = 2 ** tile.z;
  const worldX = tile.x + localX / TILE_EXTENT;
  const worldY = tile.y + localY / TILE_EXTENT;
  return [
    (worldX / scale) * 360 - 180,
    tileYToLat(worldY, tile.z),
  ];
}

/** Metres per degree of longitude at a latitude, for corridor padding. */
function metresPerLngDegree(latitude: number): number {
  return 111_320 * Math.cos((latitude * Math.PI) / 180);
}

const METRES_PER_LAT_DEGREE = 110_540;

/**
 * The tiles a journey could plausibly use.
 *
 * Not the bounding box of the two endpoints: that is a rectangle, and for a
 * long diagonal trip most of it is nowhere near any road the vehicle would
 * take. This keeps the tiles within `corridorMetres` of the straight line
 * between the endpoints, which is the shape a road network actually follows,
 * and is what keeps a 30 km trip to tens of tiles rather than hundreds.
 *
 * Tiles are returned nearest-the-line first, so a caller that has to truncate
 * at `maxTiles` loses the least useful ones.
 */
export function corridorTiles(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  corridorMetres: number,
  maxTiles: number,
  zoom: number = ROAD_TILE_ZOOM
): TileId[] {
  const midLatitude = (from.latitude + to.latitude) / 2;
  const padLat = corridorMetres / METRES_PER_LAT_DEGREE;
  const padLng = corridorMetres / Math.max(1, metresPerLngDegree(midLatitude));

  const west = Math.min(from.longitude, to.longitude) - padLng;
  const east = Math.max(from.longitude, to.longitude) + padLng;
  const south = Math.min(from.latitude, to.latitude) - padLat;
  const north = Math.max(from.latitude, to.latitude) + padLat;

  const minX = Math.floor(lngToTileX(west, zoom));
  const maxX = Math.floor(lngToTileX(east, zoom));
  // Tile Y grows southward, so the north edge produces the smaller index.
  const minY = Math.floor(latToTileY(north, zoom));
  const maxY = Math.floor(latToTileY(south, zoom));

  const span = 2 ** zoom;
  const scored: { tile: TileId; distance: number }[] = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      if (x < 0 || y < 0 || x >= span || y >= span) continue;
      const centreLng = tileXToLng(x + 0.5, zoom);
      const centreLat = tileYToLat(y + 0.5, zoom);
      const distance = distanceToSegmentMetres(
        { latitude: centreLat, longitude: centreLng },
        from,
        to
      );
      if (distance > corridorMetres) continue;
      scored.push({ tile: { z: zoom, x, y }, distance });
    }
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, maxTiles).map((entry) => entry.tile);
}

/**
 * Distance from a point to a segment, in metres.
 *
 * Flat-earth over the short spans this is used on, with longitude scaled by the
 * latitude so the two axes are comparable — without that, an east-west corridor
 * near the equator and one near the poles would be padded by different amounts.
 */
export function distanceToSegmentMetres(
  point: { latitude: number; longitude: number },
  start: { latitude: number; longitude: number },
  end: { latitude: number; longitude: number }
): number {
  const lngScale = metresPerLngDegree((start.latitude + end.latitude) / 2);
  const px = point.longitude * lngScale;
  const py = point.latitude * METRES_PER_LAT_DEGREE;
  const ax = start.longitude * lngScale;
  const ay = start.latitude * METRES_PER_LAT_DEGREE;
  const bx = end.longitude * lngScale;
  const by = end.latitude * METRES_PER_LAT_DEGREE;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Great-circle distance in metres. */
export function haversineMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const latA = toRadians(a.latitude);
  const latB = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
