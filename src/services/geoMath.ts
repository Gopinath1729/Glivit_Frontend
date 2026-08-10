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
 * Minimum movement between two fixes before they may set a new heading.
 *
 * Below this, the coordinate delta is dominated by GPS noise rather than travel, and
 * deriving a bearing from it makes a parked vehicle spin on the spot.
 */
export const MIN_HEADING_MOVE_METERS = 3;

/** A fix less accurate than this cannot be trusted to establish a direction. */
export const MAX_HEADING_ACCURACY_METERS = 50;

/**
 * The single source of truth for "which way is this vehicle pointing?".
 *
 * Direction of travel is derived from where the vehicle actually moved — the bearing
 * from the previous valid coordinate to the latest one. Everything else is a
 * fallback, in descending order of trustworthiness:
 *
 *   1. Real movement between two fixes (the only thing that proves direction).
 *   2. The last heading we displayed — held, so jitter and stops never spin the
 *      marker or flip it backwards.
 *   3. The device's own reported course.
 *   4. North, only when nothing at all is known.
 *
 * A road-matched bearing is deliberately not a candidate: a road's orientation is
 * the same for traffic in both directions, so using it renders half of all vehicles
 * facing backwards.
 *
 * @returns a compass bearing normalised to [0, 360).
 */
export function resolveTravelHeading(params: {
  /** Previous accepted coordinate for THIS vehicle, if any. */
  previous?: { latitude: number; longitude: number } | null;
  latitude: number;
  longitude: number;
  /** Course reported by the tracker, used only as a fallback. */
  reportedCourse?: number | null;
  /** Reported GPS accuracy in metres; a poor fix may not set a heading. */
  accuracyMeters?: number | null;
  /** Heading currently displayed, held when the vehicle has barely moved. */
  lastHeading?: number | null;
}): number {
  const { previous, latitude, longitude, reportedCourse, accuracyMeters, lastHeading } = params;

  const accuracyUsable =
    accuracyMeters == null ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters <= MAX_HEADING_ACCURACY_METERS;

  if (previous && accuracyUsable) {
    const movedMeters =
      haversineKm(previous.latitude, previous.longitude, latitude, longitude) * 1000;
    if (movedMeters >= MIN_HEADING_MOVE_METERS) {
      return bearingDeg(previous.latitude, previous.longitude, latitude, longitude);
    }
  }

  if (Number.isFinite(lastHeading)) {
    return normalizeHeading(lastHeading);
  }
  if (Number.isFinite(reportedCourse) && reportedCourse !== 0) {
    return normalizeHeading(reportedCourse);
  }
  return 0;
}
