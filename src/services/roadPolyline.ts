import { distanceBetween, type LatLng } from '@/src/services/gpsPipeline';

/**
 * Distance-parameterised travel along road geometry.
 *
 * <h3>The fault this exists to remove</h3>
 * The live marker used to be eased between two coordinates with a direct
 * component-wise interpolation:
 *
 * ```
 * latitude  = startLat + (endLat - startLat) * t
 * longitude = startLng + (endLng - startLng) * t
 * ```
 *
 * That is a straight line between the endpoints, and a straight line between
 * two points on a road is not the road. At a 90-degree corner the two endpoints
 * sit on either side of the junction and the marker travels the hypotenuse -
 * diagonally through the building on the inside of the turn - even though BOTH
 * endpoints were correctly matched and the backend had sent the L-shaped road
 * geometry that joins them. Around a curve the same interpolation cuts every
 * bend. No threshold change can fix it, because the geometry being drawn is
 * wrong rather than imprecise.
 *
 * <h3>What replaces it</h3>
 * The matched road vertices between the previous position and the current one
 * are a polyline. Measure its cumulative length once, then animate a single
 * monotonically increasing DISTANCE along it. At any distance the coordinate is
 * a point on the polyline itself, and the heading is the bearing of the segment
 * that point sits on. The marker therefore rides the road exactly as drawn,
 * corners included, and the route can be clipped at the same distance so the
 * blue line always ends directly behind the vehicle.
 *
 * <h3>What this deliberately does not do</h3>
 * There is no nearest-point projection over the recent route. Projection picks
 * the closest vertex, and on a loop, a U-turn or a dual carriageway the closest
 * vertex is routinely one the vehicle passed a minute ago - so the marker jumps
 * backwards onto the earlier passage. Progress here is a distance inside ONE
 * matched segment and only ever moves forward.
 */

export type RoadPolyline = {
  /** Vertices in travel order. At least one; typically the road between fixes. */
  vertices: LatLng[];
  /** Cumulative metres from `vertices[0]` to each vertex. Same length. */
  cumulativeMeters: number[];
  /** Total length in metres. Zero for a single-vertex polyline. */
  lengthMeters: number;
};

export type RoadPosition = {
  coordinate: LatLng;
  /** Bearing of the polyline segment the coordinate sits on, 0-360. */
  heading: number;
  /** Index of the vertex at or before the coordinate. */
  vertexIndex: number;
};

/** Shortest signed longitude delta, safe across the antimeridian. */
function longitudeDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function wrapLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function bearingBetween(a: LatLng, b: LatLng): number {
  const phi1 = (a.latitude * Math.PI) / 180;
  const phi2 = (b.latitude * Math.PI) / 180;
  const deltaLambda = (longitudeDelta(a.longitude, b.longitude) * Math.PI) / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return ((((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360;
}

/**
 * Builds the travel polyline for one matched segment.
 *
 * Consecutive duplicate vertices are dropped: they contribute no length and
 * would give a zero-length segment whose bearing is undefined.
 */
export function buildRoadPolyline(vertices: readonly LatLng[]): RoadPolyline {
  const kept: LatLng[] = [];
  for (const vertex of vertices) {
    if (
      !Number.isFinite(vertex?.latitude) ||
      !Number.isFinite(vertex?.longitude) ||
      Math.abs(vertex.latitude) > 90 ||
      Math.abs(vertex.longitude) > 180
    ) {
      continue;
    }
    const tail = kept[kept.length - 1];
    if (tail && distanceBetween(tail, vertex) < 0.05) continue;
    kept.push({ latitude: vertex.latitude, longitude: vertex.longitude });
  }
  if (kept.length === 0) {
    return { vertices: [], cumulativeMeters: [], lengthMeters: 0 };
  }
  const cumulativeMeters: number[] = [0];
  for (let index = 1; index < kept.length; index += 1) {
    cumulativeMeters.push(
      cumulativeMeters[index - 1] + distanceBetween(kept[index - 1], kept[index])
    );
  }
  return {
    vertices: kept,
    cumulativeMeters,
    lengthMeters: cumulativeMeters[cumulativeMeters.length - 1],
  };
}

/** Largest vertex index whose cumulative distance is <= `meters`. */
function vertexIndexAt(cumulativeMeters: readonly number[], meters: number): number {
  let low = 0;
  let high = cumulativeMeters.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (cumulativeMeters[mid] <= meters) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The coordinate and heading at a travelled distance along the polyline.
 *
 * Clamped at both ends: before the start the vehicle is at the first vertex,
 * past the end it is at the last. It never extrapolates beyond the geometry,
 * because past the end of the matched road there is no evidence of where the
 * vehicle went.
 */
export function positionAtDistance(
  polyline: RoadPolyline,
  meters: number,
  fallbackHeading = 0
): RoadPosition | null {
  const { vertices, cumulativeMeters, lengthMeters } = polyline;
  if (vertices.length === 0) return null;
  if (vertices.length === 1) {
    return { coordinate: vertices[0], heading: fallbackHeading, vertexIndex: 0 };
  }

  const clamped = Math.min(Math.max(meters, 0), lengthMeters);
  const index = Math.min(vertexIndexAt(cumulativeMeters, clamped), vertices.length - 2);
  const a = vertices[index];
  const b = vertices[index + 1];
  const segmentMeters = cumulativeMeters[index + 1] - cumulativeMeters[index];
  const fraction = segmentMeters > 0 ? (clamped - cumulativeMeters[index]) / segmentMeters : 0;

  return {
    coordinate: {
      latitude: a.latitude + (b.latitude - a.latitude) * fraction,
      longitude: wrapLongitude(
        a.longitude + longitudeDelta(a.longitude, b.longitude) * fraction
      ),
    },
    // The heading of the segment being travelled, not of the whole polyline.
    // A vehicle mid-way round a bend is pointing along the bend, and taking the
    // start-to-end bearing instead is what made markers face the wrong way for
    // the whole of a turn.
    heading: bearingBetween(a, b),
    vertexIndex: index,
  };
}

/**
 * The polyline clipped at a travelled distance.
 *
 * This is the route line behind the vehicle. Because the same polyline and the
 * same distance produce both this and the marker coordinate, the blue line ends
 * exactly where the vehicle is - not at the fix the vehicle is still travelling
 * toward, which is what put the route visibly ahead of the car.
 */
export function polylineUpTo(polyline: RoadPolyline, meters: number): LatLng[] {
  const { vertices, cumulativeMeters, lengthMeters } = polyline;
  if (vertices.length === 0) return [];
  if (vertices.length === 1) return [vertices[0]];

  const clamped = Math.min(Math.max(meters, 0), lengthMeters);
  const index = Math.min(vertexIndexAt(cumulativeMeters, clamped), vertices.length - 2);
  const head = vertices.slice(0, index + 1);
  const at = positionAtDistance(polyline, clamped);
  if (at) {
    const tail = head[head.length - 1];
    if (!tail || distanceBetween(tail, at.coordinate) >= 0.5) {
      head.push(at.coordinate);
    }
  }
  return head;
}

/**
 * Removes `metersToRemove` from the END of a polyline.
 *
 * This is how the drawn route is kept from running ahead of the vehicle. The
 * backend appends the whole newly-matched stretch the moment it is solved, while
 * the marker needs a second to travel it; trimming the untravelled remainder off
 * the tail leaves the blue line ending exactly at the marker, because both are
 * derived from the same distance along the same geometry.
 *
 * <p>Contrast with the projection this replaces, which searched the recent route
 * for the vertex nearest the animated marker. On a loop or a dual carriageway the
 * nearest vertex is routinely one the vehicle passed earlier, so the route was
 * clipped back to a previous passage and the line visibly retreated.
 */
export function clipPolylineTail(
  vertices: readonly LatLng[],
  metersToRemove: number
): LatLng[] {
  if (vertices.length === 0) return [];
  if (metersToRemove <= 0) return vertices.map((vertex) => ({ ...vertex }));

  let remaining = metersToRemove;
  const kept = vertices.map((vertex) => ({ ...vertex }));
  while (kept.length >= 2) {
    const last = kept[kept.length - 1];
    const previous = kept[kept.length - 2];
    const segment = distanceBetween(previous, last);
    if (segment <= remaining) {
      kept.pop();
      remaining -= segment;
      continue;
    }
    // The removal ends inside this segment: replace the final vertex with the
    // interpolated point rather than dropping the whole segment, so the line
    // ends at the vehicle and not at the vertex before it.
    const fraction = segment > 0 ? (segment - remaining) / segment : 0;
    kept[kept.length - 1] = {
      latitude: previous.latitude + (last.latitude - previous.latitude) * fraction,
      longitude: wrapLongitude(
        previous.longitude + longitudeDelta(previous.longitude, last.longitude) * fraction
      ),
    };
    return kept;
  }
  return kept;
}
