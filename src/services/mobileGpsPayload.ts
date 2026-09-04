import type * as Location from 'expo-location';

import { validateGpsSample, type RawGpsPoint } from '@/src/services/gpsPipeline';

/**
 * The one place a phone GPS fix is turned into an ingest payload.
 *
 * Foreground tracking and the background task both build their body here, so the
 * two can never drift apart on units, rounding or which fields they send — which
 * is exactly how a fleet ends up with foreground speeds that read correctly and
 * background ones that are 3.6x out.
 *
 * <h3>Speed</h3>
 * Expo reports {@code coords.speed} in METRES PER SECOND, and uses a negative
 * value (or null) for "unknown". It is sent as {@code speedMps} and converted to
 * km/h once, on the server. Nothing on this side multiplies by 3.6: the client
 * has no business owning that conversion, and owning it in two places is how a
 * double conversion happens.
 *
 * <h3>Timestamps</h3>
 * {@code recordedAt} is the fix's own timestamp from the OS. It is never
 * replaced with "now": a fix buffered while the app was backgrounded or offline
 * is still a fix from when it was taken, and posting it as current corrupts the
 * speed, the route and the vehicle's reported freshness all at once.
 */

/**
 * How often a STATIONARY phone uploads anyway.
 *
 * A parked phone's fixes are drift: the pipeline holds them rather than drawing
 * them, so uploading every one costs battery and mobile data to move nothing.
 * Skipping them entirely is not an option either - they are the evidence the
 * device is still online, and without them the backend reaches its offline
 * timeout and reports a vehicle that is sitting right there as not reporting.
 *
 * Defined HERE, once, because both collectors need it and neither can import
 * the other: `phoneTracker` already imports the background task, so putting the
 * numbers there would be a cycle. The foreground collector honoured this rate
 * and the background one did not, which meant a parked phone with the app off
 * screen uploaded at the full 1 Hz sampling rate indefinitely - 93 of one test
 * device's 268 rows were stationary duplicates that should have been ten
 * seconds apart.
 */
export const HIGH_ACCURACY_HEARTBEAT_MS = 10_000;
export const BALANCED_HEARTBEAT_MS = 30_000;

/** The stationary upload interval for an accuracy mode. */
export function heartbeatIntervalMs(accuracy: 'balanced' | 'high'): number {
  return accuracy === 'high' ? HIGH_ACCURACY_HEARTBEAT_MS : BALANCED_HEARTBEAT_MS;
}

export type MobileGpsPayload = {
  latitude: number;
  longitude: number;
  /** Metres per second, exactly as the OS reported it. Omitted when unknown. */
  speedMps?: number;
  /** Degrees, 0-360. Omitted when the OS reports no course. */
  heading?: number;
  /** Metres of horizontal uncertainty. Omitted when unknown. */
  accuracyMeters?: number;
  altitude?: number;
  /** Which location source produced this fix, as far as the app can tell. */
  provider: string;
  /** The GPS fix time from the OS, never the API arrival time. */
  recordedAt: string;
};

export type MobileGpsRejectionReason =
  | 'invalid_coordinate'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'duplicate'
  | 'poor_accuracy'
  | 'impossible_jump';

export type MobileGpsValidation =
  | {
      accepted: true;
      /** The coordinate was held at the anchor rather than moved. */
      stationaryDrift: boolean;
      /**
       * The DEVICE reported a speed below the stationary threshold.
       *
       * Only this may throttle an upload. A held fix whose device reported no
       * speed at all is not evidence of a stop — Android's fused provider omits
       * the speed field routinely while driving — and throttling on it dropped a
       * moving vehicle to one upload every ten seconds.
       */
      deviceConfirmedStationary: boolean;
    }
  | { accepted: false; reason: MobileGpsRejectionReason };

export type PreviousMobileGpsFix = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

/**
 * Pipeline reasons mapped onto the wire vocabulary this collector reports.
 *
 * The collector's vocabulary is deliberately coarser than the pipeline's: the
 * phone's job is to decide whether to spend a radio transmission, and it does
 * not need to distinguish a reversed coordinate pair from an out-of-range one
 * to answer that. Every distinction is still preserved in the trace.
 */
const REASON_FOR: Record<string, MobileGpsRejectionReason> = {
  invalid_coordinate: 'invalid_coordinate',
  coordinate_axes_reversed: 'invalid_coordinate',
  null_island: 'invalid_coordinate',
  invalid_timestamp: 'invalid_timestamp',
  future_timestamp: 'invalid_timestamp',
  stale_timestamp: 'stale_timestamp',
  out_of_order: 'stale_timestamp',
  duplicate_timestamp: 'duplicate',
  duplicate_coordinate: 'duplicate',
  invalid_accuracy: 'poor_accuracy',
  poor_accuracy: 'poor_accuracy',
  impossible_jump: 'impossible_jump',
  implausible_step: 'impossible_jump',
  isolated_spike: 'impossible_jump',
};

/**
 * One Expo location object, as the pipeline's raw sample.
 *
 * Extracted so the warm-up gate and the steady-state validator are fed byte
 * for byte the same reading. Building the shape twice is how a unit or a
 * null-handling rule ends up applied at one stage and not the other.
 */
export function rawGpsPointOf(location: Location.LocationObject): RawGpsPoint {
  const { latitude, longitude, accuracy, speed } = location.coords;
  return {
    vehicleId: null,
    timestampMs: location.timestamp,
    latitude,
    longitude,
    accuracyMeters: typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null,
    // Expo reports metres per second and uses a negative value for "unknown".
    // Converting here is display-only: the wire still carries m/s and the
    // server owns the single conversion. See the speed note at the top.
    deviceSpeedKmh:
      typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed * 3.6 : null,
    reportedHeading: null,
    source: 'device',
  };
}

/**
 * Client-side collection gate.
 *
 * <h3>It no longer owns any rules</h3>
 * This used to hold its own copy of the coordinate range check, the accuracy
 * ceiling, the stationary radius and the speed ceiling. They were the same
 * NUMBERS as the live stream's by coincidence rather than by construction, and
 * they had already diverged from playback's. Every decision is now made by
 * `gpsPipeline`, which the live stream, History and playback also use, so a fix
 * the phone accepts is a fix the map is willing to draw and there is exactly one
 * place to change a threshold.
 *
 * The backend repeats these checks authoritatively. Doing them here avoids
 * spending a radio transmission on a fix the OS already says is unusable.
 */
export function validateMobileGpsLocation(
  location: Location.LocationObject,
  previous: PreviousMobileGpsFix | null,
  now = Date.now()
): MobileGpsValidation {
  const raw = rawGpsPointOf(location);

  const decision = validateGpsSample({
    raw,
    previous: previous
      ? {
          raw: { latitude: previous.latitude, longitude: previous.longitude },
          display: { latitude: previous.latitude, longitude: previous.longitude },
          timestampMs: previous.timestamp,
          bearing: 0,
          speedKmh: 0,
          ignition: null,
        }
      : null,
    now,
  });

  if (!decision.accepted) {
    return { accepted: false, reason: REASON_FOR[decision.reason] ?? 'invalid_coordinate' };
  }
  // A held fix is a parked phone's wander. It is still uploaded - it is the
  // evidence the device is online - but at the heartbeat rate rather than the
  // movement rate, and the backend holds its coordinate rather than drawing it.
  return {
    accepted: true,
    stationaryDrift: decision.point.held,
    deviceConfirmedStationary: decision.point.deviceConfirmedStationary,
  };
}

/**
 * Expo does not surface the underlying Android provider, so this reports the
 * source the app asked for. `BestForNavigation` is a satellite fix; `Balanced`
 * is the fused provider, which can be cell/Wi-Fi derived and is correspondingly
 * less able to place a vehicle on a specific road.
 */
export function providerFor(accuracy: 'balanced' | 'high'): string {
  return accuracy === 'high' ? 'gps' : 'fused';
}

/** A negative or null reading is Expo's "unknown", not a measurement of zero. */
function measured(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function buildMobileGpsPayload(
  location: Location.LocationObject,
  accuracy: 'balanced' | 'high'
): MobileGpsPayload {
  const { coords, timestamp } = location;
  const heading = measured(coords.heading);
  const altitude =
    typeof coords.altitude === 'number' && Number.isFinite(coords.altitude)
      ? coords.altitude
      : undefined;

  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    // Sent in the unit it was measured in. Omitted rather than sent as 0 when
    // unknown, so the server can fall back to a coordinate-derived speed instead
    // of recording a fabricated stop.
    speedMps: measured(coords.speed),
    heading: heading == null ? undefined : ((heading % 360) + 360) % 360,
    accuracyMeters: measured(coords.accuracy),
    altitude,
    provider: providerFor(accuracy),
    recordedAt: new Date(timestamp).toISOString(),
  };
}
