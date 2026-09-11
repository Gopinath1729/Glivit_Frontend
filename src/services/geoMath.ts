import { GPS_LIMITS } from '@/src/services/gpsPipeline';

const EARTH_RADIUS_KM = 6371;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const startLat = toRadians(lat1);
  const endLat = toRadians(lat2);
  const dLng = toRadians(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(endLat);
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(dLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function normalizeHeading(value: number | null | undefined, fallback = 0): number {
  const heading = Number.isFinite(value) ? Number(value) : fallback;
  return ((heading % 360) + 360) % 360;
}

export function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}

/**
 * Minimum movement between two ACCEPTED RAW fixes before their bearing may set a
 * new heading.
 *
 * Below this, the coordinate delta is dominated by GPS noise rather than travel, and
 * deriving a bearing from it makes a parked vehicle spin on the spot.
 */
export const MIN_HEADING_MOVE_METERS = 3;

/**
 * Travel needed before a two-fix course can challenge the tracker-reported
 * course. The accuracy-scaled rule below can raise this further.
 */
export const MIN_COURSE_CHECK_MOVE_METERS = 10;

/** A larger disagreement means the reported course is stale or invalid. */
export const MAX_REPORTED_COURSE_DISAGREEMENT_DEG = 55;

/** A fix less accurate than this cannot be trusted to establish a direction. */
export const MAX_HEADING_ACCURACY_METERS = 50;

/** At or below this the vehicle is parked, and its heading is held, never re-derived. */
export const STATIONARY_HEADING_SPEED_KPH = 2.5;

/**
 * Radius a parked GPS wanders within.
 *
 * Matches the stationary-drift radius the ingest pipeline and the live validator
 * both use. A device reporting no speed whose coordinate moved less than this
 * has not turned - it has drifted - and deriving a heading from that delta is
 * what makes a parked marker spin. Movement beyond the radius is real even if
 * the device still claims zero, because a phone's speedometer lags badly at
 * walking and crawling pace.
 */
export const STATIONARY_DRIFT_METERS = GPS_LIMITS.stationaryDriftMeters;

/**
 * Beyond this much disagreement, a matched road's orientation is not this
 * vehicle's heading and is not used to align it.
 */
const MAX_ROAD_ALIGNMENT_DEGREES = 45;

/**
 * How far the vehicle glyph is rotated before the compass bearing is applied.
 *
 * The marker artwork (`assets/markers/car-marker-photorealistic-v4-map-trim.png`
 * and the sprites baked from it by `scripts/build-vehicle-marker-sprites.js`)
 * draws the vehicle nose-up, so a bearing of 0 already points north and the
 * offset is zero. It exists as a named constant rather than as an implicit zero
 * because it is the one number that has to change if the artwork is ever
 * re-exported at a different orientation - and a marker rotated 90 degrees out
 * is otherwise "fixed" by sprinkling +90 through whichever call site somebody
 * noticed first, which is how two screens end up disagreeing.
 */
export const VEHICLE_MARKER_HEADING_OFFSET_DEG = 0;

/** Rotation to hand a map marker for a vehicle whose compass bearing is `heading`. */
export function markerRotationFor(heading: number | null | undefined): number {
  return normalizeHeading(normalizeHeading(heading) + VEHICLE_MARKER_HEADING_OFFSET_DEG);
}

/** Signed shortest angular difference from `a` to `b`, in (-180, 180]. */
export function angleDeltaDeg(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export type BearingInputs = {
  /**
   * Previous accepted RAW coordinate for THIS vehicle.
   *
   * Deliberately the raw validated fix, never the road-matched one. Matched
   * coordinates are a rendering convenience: two consecutive fixes can be
   * snapped onto different carriageways of a dual road, and the bearing between
   * those two snapped points is perpendicular to the direction the vehicle is
   * actually travelling. Movement maths uses raw; only drawing uses matched.
   */
  previous?: { latitude: number; longitude: number } | null;
  /** Current accepted RAW coordinate. */
  latitude: number;
  longitude: number;
  /**
   * Course the device reported for this fix, 0-360.
   *
   * On a phone this is GPS course over ground, which is both more responsive and
   * more accurate than a bearing derived from two 1 Hz coordinates, so it is
   * preferred whenever the vehicle is actually moving. It says nothing at all
   * while stationary, which is why it is gated on movement.
   */
  reportedHeading?: number | null;
  /** Canonical speed for this fix, km/h. */
  speedKmh?: number | null;
  /** Reported GPS accuracy in metres; a poor fix may not set a heading. */
  accuracyMeters?: number | null;
  /** Heading currently displayed. Held whenever nothing better is proven. */
  lastHeading?: number | null;
  /**
   * Orientation of the matched road, when the backend matched this fix.
   *
   * Only ever used to ALIGN a direction that was already established, and only
   * when the two broadly agree. A road carries traffic both ways, so taking its
   * orientation on its own renders half of all vehicles facing backwards.
   */
  roadBearing?: number | null;
  /** True when this fix was held at the previous position (drift, poor fix). */
  held?: boolean;
};

/**
 * The single source of truth for "which way is this vehicle pointing?".
 *
 * Every screen that rotates a vehicle calls this and nothing else. It used to be
 * two functions with different rules - the tracking screen aligned to the road
 * and preferred derived bearings, the fleet map refused the road outright and
 * derived its bearing from MATCHED coordinates - so the same vehicle could face
 * two different ways on two screens at the same instant, and on a dual
 * carriageway the fleet map's version could point across the road.
 *
 * In descending order of trustworthiness:
 *
 *   1. Nothing at all while stationary or held: the heading is frozen, so GPS
 *      drift can never spin a parked vehicle.
 *   2. Agreement between the device course and sustained coordinate travel.
 *      If they disagree sharply, the travelled course wins; stale `0`/`90`
 *      headings from inexpensive trackers can therefore no longer point the
 *      vehicle across the road indefinitely.
 *   3. Either moving signal on its own when there is not enough evidence to
 *      cross-check it.
 *   4. The last heading displayed, held.
 *   5. North, only when nothing whatsoever is known.
 *
 * Whatever survives is then aligned to the matched road when one is available
 * and agrees to within {@link MAX_ROAD_ALIGNMENT_DEGREES} - which is what keeps
 * the marker square with the carriageway through a curve instead of wobbling a
 * few degrees either side of it.
 *
 * @returns a compass bearing normalised to [0, 360).
 */
export function resolveVehicleBearing(params: BearingInputs): number {
  const {
    previous,
    latitude,
    longitude,
    reportedHeading,
    speedKmh,
    accuracyMeters,
    lastHeading,
    roadBearing,
    held,
  } = params;

  const heldHeading = Number.isFinite(lastHeading)
    ? normalizeHeading(lastHeading)
    : Number.isFinite(reportedHeading)
      ? normalizeHeading(reportedHeading)
      : 0;

  // A fix that was not allowed to move the vehicle may not turn it either.
  if (held) return heldHeading;

  const accuracyUsable =
    accuracyMeters == null ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters <= MAX_HEADING_ACCURACY_METERS;
  if (!accuracyUsable) return heldHeading;

  const movedMeters = previous
    ? haversineKm(previous.latitude, previous.longitude, latitude, longitude) * 1000
    : 0;
  const movingBySpeed =
    Number.isFinite(speedKmh) && (speedKmh as number) >= STATIONARY_HEADING_SPEED_KPH;
  const reportedStationary =
    Number.isFinite(speedKmh) && (speedKmh as number) < STATIONARY_HEADING_SPEED_KPH;

  // The device says it is not moving AND the coordinate barely changed. That is
  // drift, whatever course the device happens to be reporting - a stationary
  // phone's course is the last one it measured, or its compass, and neither is
  // where the vehicle is pointing.
  if (reportedStationary && movedMeters <= STATIONARY_DRIFT_METERS) return heldHeading;

  const movingByDistance = movedMeters >= MIN_HEADING_MOVE_METERS;
  if (!movingBySpeed && !movingByDistance) return heldHeading;

  const travelled =
    movingByDistance && previous
      ? bearingDeg(previous.latitude, previous.longitude, latitude, longitude)
      : null;
  const reported = Number.isFinite(reportedHeading) ? normalizeHeading(reportedHeading) : null;

  // A short coordinate delta is noisier than the tracker's course. Once the
  // vehicle has moved farther than both a physical floor and twice the fix's
  // stated accuracy, however, it becomes an independent witness. This catches
  // the common stale-course failure without replacing good headings with GPS
  // jitter at traffic lights or on one-second samples.
  const courseCheckMeters = Math.max(
    MIN_COURSE_CHECK_MOVE_METERS,
    Number.isFinite(accuracyMeters) ? Math.max(0, accuracyMeters as number) * 2 : 0
  );
  let direction = movingBySpeed && reported != null ? reported : travelled ?? reported;
  if (movingBySpeed && reported != null && travelled != null && movedMeters >= courseCheckMeters) {
    const disagreement = Math.abs(angleDeltaDeg(reported, travelled));
    if (disagreement > MAX_REPORTED_COURSE_DISAGREEMENT_DEG) {
      direction = travelled;
    } else if (disagreement > 22) {
      // Moderate disagreement is normally GPS quantisation through a bend.
      // Blend on the shortest arc instead of choosing a side and snapping.
      direction = lerpAngle(reported, travelled, 0.4);
    }
  }
  if (direction == null) return heldHeading;

  return alignToRoad(direction, roadBearing);
}

/**
 * Squares a proven direction of travel with the road it was matched to.
 *
 * The road's own orientation is ambiguous by 180 degrees, so the sense is taken
 * from the direction of travel and only the smaller correction is applied. When
 * the two disagree by more than {@link MAX_ROAD_ALIGNMENT_DEGREES} the match is
 * describing a different road - a parallel carriageway, a slip road, the street
 * under a flyover - and the travelled direction stands unaltered.
 */
export function alignToRoad(direction: number, roadBearing?: number | null): number {
  if (!Number.isFinite(roadBearing)) return normalizeHeading(direction);
  const road = normalizeHeading(roadBearing);
  const forwardDelta = Math.abs(angleDeltaDeg(direction, road));
  const reverse = normalizeHeading(road + 180);
  const reverseDelta = Math.abs(angleDeltaDeg(direction, reverse));
  const aligned = forwardDelta <= reverseDelta ? road : reverse;
  return Math.min(forwardDelta, reverseDelta) <= MAX_ROAD_ALIGNMENT_DEGREES
    ? normalizeHeading(aligned)
    : normalizeHeading(direction);
}
