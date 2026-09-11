import { haversineKm } from '@/src/services/geoMath';

/** GeoJSON / MapLibre coordinate order. */
export type RouteCoordinate = [longitude: number, latitude: number];

export type NavigationPosition = { latitude: number; longitude: number };

export type RouteProjection = {
  coordinate: RouteCoordinate;
  distanceToRouteMeters: number;
  segmentIndex: number;
  segmentFraction: number;
  alongRouteMeters: number;
};

/** A destination must be entered before moving away can count as an overshoot. */
export type DestinationPassTracker = {
  enteredProximity: boolean;
  closestDistanceMeters: number | null;
  previousDistanceMeters: number | null;
  handled: boolean;
};

export const DESTINATION_PROXIMITY_METERS = 15;
const DESTINATION_PASS_EXIT_METERS = 20;
const DESTINATION_PASS_MIN_INCREASE_METERS = 4;

export function createDestinationPassTracker(): DestinationPassTracker {
  return {
    enteredProximity: false,
    closestDistanceMeters: null,
    previousDistanceMeters: null,
    handled: false,
  };
}

/**
 * Detects a genuine pass using only consecutive, already-validated fixes.
 *
 * Entering the 15 m arrival circle arms the tracker. It fires once only after
 * a moving vehicle exits beyond 20 m and is at least 4 m farther away than both
 * its previous sample and closest approach. Those hysteresis checks reject GPS
 * wobble around the boundary without delaying a real overshoot by extra fixes.
 */
export function observeDestinationPass(
  tracker: DestinationPassTracker,
  distanceMeters: number,
  moving: boolean
): { tracker: DestinationPassTracker; passed: boolean } {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return { tracker, passed: false };
  }

  const enteredProximity =
    tracker.enteredProximity || distanceMeters <= DESTINATION_PROXIMITY_METERS;
  const closestDistanceMeters =
    tracker.closestDistanceMeters == null
      ? distanceMeters
      : Math.min(tracker.closestDistanceMeters, distanceMeters);
  const increasingFromPrevious =
    tracker.previousDistanceMeters != null &&
    distanceMeters >= tracker.previousDistanceMeters + DESTINATION_PASS_MIN_INCREASE_METERS;
  const increasingFromClosest =
    distanceMeters >= closestDistanceMeters + DESTINATION_PASS_MIN_INCREASE_METERS;
  const passed =
    !tracker.handled &&
    enteredProximity &&
    moving &&
    distanceMeters >= DESTINATION_PASS_EXIT_METERS &&
    increasingFromPrevious &&
    increasingFromClosest;

  return {
    passed,
    tracker: {
      enteredProximity,
      closestDistanceMeters,
      previousDistanceMeters: distanceMeters,
      handled: tracker.handled || passed,
    },
  };
}

function validRouteCoordinate(value: RouteCoordinate | undefined): value is RouteCoordinate {
  return Boolean(
    value &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1]) &&
      Math.abs(value[0]) <= 180 &&
      Math.abs(value[1]) <= 90
  );
}

/**
 * Locates an accepted vehicle position along a planned route.
 *
 * The returned coordinate is used only to split the route visualization. The
 * vehicle marker remains at the backend's authoritative display coordinate;
 * this projection is never written back into GPS, telemetry, speed or bearing.
 */
export function projectPositionOnRoute(
  route: readonly RouteCoordinate[],
  position: NavigationPosition,
  minimumAlongRouteMeters = 0
): RouteProjection | null {
  if (
    route.length < 2 ||
    !Number.isFinite(position.latitude) ||
    !Number.isFinite(position.longitude)
  ) {
    return null;
  }

  const metresPerDegreeLat = 111_320;
  const metresPerDegreeLng = Math.max(
    1,
    metresPerDegreeLat * Math.cos((position.latitude * Math.PI) / 180)
  );
  let cumulative = 0;
  let best: RouteProjection | null = null;

  for (let index = 0; index < route.length - 1; index += 1) {
    const a = route[index];
    const b = route[index + 1];
    if (!validRouteCoordinate(a) || !validRouteCoordinate(b)) continue;

    const segmentMeters = haversineKm(a[1], a[0], b[1], b[0]) * 1000;
    const ax = (a[0] - position.longitude) * metresPerDegreeLng;
    const ay = (a[1] - position.latitude) * metresPerDegreeLat;
    const bx = (b[0] - position.longitude) * metresPerDegreeLng;
    const by = (b[1] - position.latitude) * metresPerDegreeLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const rawFraction =
      lengthSquared <= 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    const minimumFraction =
      segmentMeters <= 0
        ? 0
        : Math.max(0, Math.min(1, (minimumAlongRouteMeters - cumulative) / segmentMeters));
    const fraction = Math.max(rawFraction, minimumFraction);
    const along = cumulative + segmentMeters * fraction;
    if (cumulative + segmentMeters + 0.5 < minimumAlongRouteMeters) {
      cumulative += segmentMeters;
      continue;
    }
    const x = ax + dx * fraction;
    const y = ay + dy * fraction;
    const distance = Math.hypot(x, y);
    if (!best || distance < best.distanceToRouteMeters) {
      best = {
        coordinate: [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction],
        distanceToRouteMeters: distance,
        segmentIndex: index,
        segmentFraction: fraction,
        alongRouteMeters: along,
      };
    }
    cumulative += segmentMeters;
  }
  return best;
}

/** Splits only the route overlay; it never changes the vehicle coordinate. */
export function splitRouteAtProjection(
  route: readonly RouteCoordinate[],
  projection: RouteProjection
): { completed: RouteCoordinate[]; remaining: RouteCoordinate[] } {
  if (route.length < 2) return { completed: [], remaining: [...route] };
  const completed = [...route.slice(0, projection.segmentIndex + 1), projection.coordinate];
  const remaining = [projection.coordinate, ...route.slice(projection.segmentIndex + 1)];
  return {
    completed: dedupeAdjacent(completed),
    remaining: dedupeAdjacent(remaining),
  };
}

export function routeLengthMeters(route: readonly RouteCoordinate[]): number {
  let total = 0;
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1];
    const b = route[index];
    if (!validRouteCoordinate(a) || !validRouteCoordinate(b)) continue;
    total += haversineKm(a[1], a[0], b[1], b[0]) * 1000;
  }
  return total;
}

function dedupeAdjacent(route: RouteCoordinate[]): RouteCoordinate[] {
  return route.filter((point, index) => {
    const previous = route[index - 1];
    return !previous || previous[0] !== point[0] || previous[1] !== point[1];
  });
}
