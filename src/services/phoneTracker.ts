import * as Location from 'expo-location';
import { Platform } from 'react-native';

import { COMMON_API_HEADERS, env } from '@/src/config/env';
import { traceGps } from '@/src/services/gpsDiagnostics';
import {
  startBackgroundMobileGps,
  stopBackgroundMobileGps,
} from '@/src/services/mobileGpsBackgroundTask';
import {
  buildMobileGpsPayload,
  validateMobileGpsLocation,
  type PreviousMobileGpsFix,
} from '@/src/services/mobileGpsPayload';

/**
 * Turns this phone into a GPS tracker for one Glivt device.
 *
 * The phone posts to exactly the same endpoint a hardware tracker uses
 * (`POST /api/ingest/positions`, authenticated by `X-Device-Token`). The backend
 * identifies this device as Mobile GPS and derives movement from both speed and
 * coordinate changes without inventing an ignition signal.
 */

/**
 * A fix as the tracker screen displays it.
 *
 * `speedKmh` is derived here for the on-screen readout ONLY. What is sent to the
 * backend is the raw metres-per-second reading, converted once on the server; if
 * this value were the one posted the conversion would exist in two places and
 * one of them would eventually double up.
 */
export type TrackerFix = {
  latitude: number;
  longitude: number;
  /** Metres per second, exactly as the OS reported it. Null when unknown. */
  speedMps: number | null;
  /** Display-only km/h, derived from `speedMps`. Never posted. */
  speedKmh: number;
  heading: number;
  accuracyMeters: number;
  provider: string;
  recordedAt: string;
};

export type TrackerStats = {
  sent: number;
  rejected: number;
  lastFix: TrackerFix | null;
  lastError: string | null;
  lastAcceptedAt: number | null;
};

export type TrackerAccuracy = 'balanced' | 'high';

export type TrackingReadiness =
  | { granted: true }
  | {
      granted: false;
      reason:
        | 'services_disabled'
        | 'permission_denied'
        | 'permission_undetermined'
        | 'precise_permission_required';
      canAskAgain: boolean;
      message: string;
    };

type StartOptions = {
  ingestToken: string;
  accuracy: TrackerAccuracy;
  /** Called after every attempt, accepted or not, so the UI can show progress. */
  onStats: (stats: TrackerStats) => void;
};

const INITIAL_STATS: TrackerStats = {
  sent: 0,
  rejected: 0,
  lastFix: null,
  lastError: null,
  lastAcceptedAt: null,
};

/**
 * A single active tracking session. Deliberately module-level: two concurrent
 * watchers would double every device's position history, and the phone only
 * has one GPS.
 */
let subscription: Location.LocationSubscription | null = null;
let backgroundTracking = false;
/**
 * Serialises start/stop so two callers can never leave two watchers running.
 *
 * `startTracking` is async and awaits three times before it installs its
 * watcher. Two overlapping calls - the tracking gate reacting to a session
 * refresh while the tracker screen's own button is in flight, or an
 * AppState 'active' arriving mid-start - could therefore both reach
 * `watchPositionAsync`, and the second assignment to `subscription` orphaned
 * the first watcher: it stayed registered with the OS, kept firing, and posted
 * competing fixes for the same device from a stale validator. Every caller now
 * queues behind whatever is already running.
 */
let sessionMutex: Promise<unknown> = Promise.resolve();
/**
 * Incremented by every start and stop. A start that has been superseded checks
 * this before installing its watcher and tears its own down instead.
 */
let sessionGeneration = 0;

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const queued = sessionMutex.then(work, work);
  // Failures must not poison the queue for the next caller.
  sessionMutex = queued.catch(() => undefined);
  return queued;
}

let stats: TrackerStats = { ...INITIAL_STATS };
/** True while a POST is in flight. See {@link handleFix} for what happens next. */
let posting = false;
/**
 * The newest fix that arrived while a post was in flight.
 *
 * Exactly one is kept, and it is always the newest. Fixes used to be DROPPED
 * outright whenever a post was still running, which on a slow link threw away
 * precisely the reading the map most needed - the current one - and left the
 * vehicle sitting at whichever fix happened to win the race. An older fix never
 * replaces a newer one here, so the queue can never reorder the pipeline either.
 */
let pendingFix: Location.LocationObject | null = null;
let activeIngestToken: string | null = null;
let previousSubmittedFix: PreviousMobileGpsFix | null = null;
/** When a parked phone last sent its "still here" heartbeat. */
let lastStationaryPostAtMs = 0;

/**
 * How often the OS is asked for a fix.
 *
 * This is the sampling rate, NOT the upload rate. It used to be the same number
 * as the stationary heartbeat below - 10 s on high accuracy, 30 s on balanced -
 * so a moving vehicle's position could only ever be 10 to 30 seconds old before
 * it was even sent, which is most of the "the marker lags behind the phone"
 * complaint on its own. Movement is sampled at the rate a map can use; a parked
 * phone is throttled separately, so the higher rate costs nothing while parked.
 */
const HIGH_ACCURACY_SAMPLE_MS = 1_000;
// Balanced changes the sensor accuracy, not the live cadence. Keeping both
// modes at 1 Hz means choosing the lower-power provider never silently turns a
// Google-Maps-like live marker into a three-second hop.
const BALANCED_SAMPLE_MS = 1_000;

/**
 * How often a STATIONARY phone posts anyway.
 *
 * A parked phone's fixes are drift and are held rather than drawn, but they are
 * still the evidence the device is online: without them the backend reaches its
 * offline timeout and the vehicle is reported as not reporting.
 */
const HIGH_ACCURACY_HEARTBEAT_MS = 10_000;
const BALANCED_HEARTBEAT_MS = 30_000;

export function isTracking(): boolean {
  return subscription !== null || backgroundTracking;
}

export function isTrackingSession(ingestToken: string): boolean {
  return isTracking() && activeIngestToken === ingestToken;
}

export function currentStats(): TrackerStats {
  return stats;
}

/** Read-only check: never displays an OS permission or GPS dialog. */
export async function checkTrackingReadiness(): Promise<TrackingReadiness> {
  const services = await Location.hasServicesEnabledAsync();
  if (!services) {
    return {
      granted: false,
      reason: 'services_disabled',
      canAskAgain: true,
      message: 'Location is turned off. Please enable GPS to continue tracking.',
    };
  }
  const permission = await Location.getForegroundPermissionsAsync();
  if (permission.status === Location.PermissionStatus.GRANTED) {
    // Android can grant only an approximate (coarse) location while reporting
    // the permission itself as granted. A fleet marker cannot be placed on the
    // correct road from a kilometre-scale fix, so make that limitation explicit
    // instead of silently publishing it as precise GPS.
    if (Platform.OS === 'android' && permission.android?.accuracy !== 'fine') {
      return {
        granted: false,
        reason: 'precise_permission_required',
        canAskAgain: permission.canAskAgain,
        message: 'Precise location is required. Enable Precise location for Glivt in Android settings.',
      };
    }
    return { granted: true };
  }
  return {
    granted: false,
    reason:
      permission.status === Location.PermissionStatus.UNDETERMINED
        ? 'permission_undetermined'
        : 'permission_denied',
    canAskAgain: permission.canAskAgain,
    message: 'Location permission is required to send positions.',
  };
}

/** Requests permission only after the caller has confirmed a Mobile GPS registration. */
export async function requestTrackingPermission(): Promise<TrackingReadiness> {
  const readiness = await checkTrackingReadiness();
  if (readiness.granted || readiness.reason === 'services_disabled') return readiness;

  const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
  if (status !== Location.PermissionStatus.GRANTED) {
    return {
      granted: false,
      reason: 'permission_denied',
      canAskAgain,
      message: 'Location permission is required to send positions.',
    };
  }
  if (Platform.OS === 'android') {
    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.android?.accuracy !== 'fine') {
      return {
        granted: false,
        reason: 'precise_permission_required',
        canAskAgain: permission.canAskAgain,
        message: 'Precise location is required. Enable Precise location for Glivt in Android settings.',
      };
    }
  }
  return { granted: true };
}

export function startTracking(options: StartOptions): Promise<{ background: boolean }> {
  return serialize(() => startTrackingExclusive(options));
}

async function startTrackingExclusive(options: StartOptions): Promise<{ background: boolean }> {
  await stopTrackingExclusive();
  const generation = (sessionGeneration += 1);
  stats = { ...INITIAL_STATS };
  previousSubmittedFix = null;

  // Send a fresh high-accuracy fix immediately. watchPositionAsync may wait for
  // movement before its first callback, which would leave a newly-created
  // Mobile GPS device in NO_DATA even though the phone has a valid position.
  const initial = await Location.getCurrentPositionAsync({
    accuracy:
      options.accuracy === 'high'
        ? Location.Accuracy.BestForNavigation
        : Location.Accuracy.Balanced,
    // On Android this asks for the system's improved-accuracy mode only when it
    // is disabled. BestForNavigation without that provider setting can quietly
    // degrade to cell/Wi-Fi fixes even though the app requested precise GPS.
    mayShowUserSettingsDialog: true,
  });
  await handleFix(initial, options);

  const background = await startBackgroundMobileGps(options.ingestToken, options.accuracy);
  if (generation !== sessionGeneration) {
    // A stop or a newer start won the race while the OS was answering. This
    // call owns nothing any more and must not install anything.
    if (background) await stopBackgroundMobileGps();
    return { background };
  }
  backgroundTracking = background;

  // Keep the foreground watcher even when the background task registered.
  // Expo's background task is allowed to batch or throttle delivery; using it
  // as the only collector while this app was open produced 5-10 second marker
  // jumps. watchPositionAsync is the foreground 1 Hz path, while the task keeps
  // tracking alive after the app leaves the foreground. Identical callbacks
  // share the OS timestamp and are deduplicated by the backend.
  const watcher = await Location.watchPositionAsync(
    {
      accuracy:
        options.accuracy === 'high'
          ? Location.Accuracy.BestForNavigation
          : Location.Accuracy.Balanced,
      // Stationary fixes are online heartbeats. A non-zero distance filter can
      // keep the OS silent while parked until the server marks the phone Offline.
      distanceInterval: 0,
      mayShowUserSettingsDialog: true,
      timeInterval:
        options.accuracy === 'high' ? HIGH_ACCURACY_SAMPLE_MS : BALANCED_SAMPLE_MS,
    },
    (position) => {
      void handleFix(position, options);
    },
    // Without this the watch can fail silently and the UI sits on "waiting for
    // the first fix" forever with nothing to explain it.
    (reason) => {
      stats = { ...stats, lastError: reason || 'Location updates stopped.' };
      options.onStats(stats);
    }
  );
  if (generation !== sessionGeneration) {
    // Same race, on the foreground path. Removing the watcher we just created
    // is the whole point: leaving it registered is what produced two live
    // subscriptions posting interleaved fixes for one device.
    watcher.remove();
    return { background: false };
  }
  subscription = watcher;
  activeIngestToken = options.ingestToken;
  return { background };
}

export function stopTracking(): Promise<void> {
  return serialize(stopTrackingExclusive);
}

async function stopTrackingExclusive(): Promise<void> {
  sessionGeneration += 1;
  subscription?.remove();
  subscription = null;
  await stopBackgroundMobileGps();
  backgroundTracking = false;
  activeIngestToken = null;
  posting = false;
  pendingFix = null;
  lastStationaryPostAtMs = 0;
  previousSubmittedFix = null;
}

/**
 * Serialises uploads without ever throwing away the newest reading.
 *
 * While a POST is in flight, an arriving fix is parked in {@link pendingFix} -
 * replacing whatever was parked there only if it is newer - and sent the moment
 * the current upload finishes. The previous behaviour discarded it outright,
 * which on a slow or flaky link is the difference between the map showing where
 * the phone is now and the map showing where it was several fixes ago.
 */
async function handleFix(position: Location.LocationObject, options: StartOptions): Promise<void> {
  if (posting) {
    if (!pendingFix || position.timestamp > pendingFix.timestamp) {
      pendingFix = position;
    }
    return;
  }

  posting = true;
  try {
    let next: Location.LocationObject | null = position;
    while (next) {
      await postFix(next, options);
      next = pendingFix;
      pendingFix = null;
    }
  } finally {
    posting = false;
  }
}

async function postFix(position: Location.LocationObject, options: StartOptions): Promise<void> {
  const payload = buildMobileGpsPayload(position, options.accuracy);
  const fix: TrackerFix = {
    latitude: payload.latitude,
    longitude: payload.longitude,
    speedMps: payload.speedMps ?? null,
    // Display only. The wire carries metres per second; the server owns the
    // single conversion to km/h.
    speedKmh: payload.speedMps == null ? 0 : Math.round(payload.speedMps * 3.6),
    heading: Math.round(payload.heading ?? 0),
    accuracyMeters: Math.round(payload.accuracyMeters ?? 0),
    provider: payload.provider,
    recordedAt: payload.recordedAt,
  };

  const validation = validateMobileGpsLocation(position, previousSubmittedFix);
  if (!validation.accepted) {
    traceGps('rejected', options.ingestToken.slice(0, 6), {
      reason: validation.reason,
      lat: payload.latitude,
      lng: payload.longitude,
      accuracy: payload.accuracyMeters,
      gpsTime: payload.recordedAt,
    });
    stats = {
      ...stats,
      rejected: stats.rejected + 1,
      lastFix: fix,
      lastError: `GPS fix rejected: ${validation.reason.replaceAll('_', ' ')}`,
    };
    options.onStats(stats);
    return;
  }

  // A parked phone samples at the movement rate but only uploads at the
  // heartbeat rate. Its fixes are drift, held rather than drawn, so uploading
  // every one of them costs battery and mobile data to move nothing; skipping
  // them entirely would let the backend time the device out as offline.
  //
  // Throttled only when the DEVICE reported a stop, never merely because the fix
  // was held. A phone that reports no speed at all — which Android's fused
  // provider does routinely while driving — has its early fixes held until they
  // leave the anchor radius, and throttling on that alone cut a moving vehicle
  // to one upload every ten seconds at exactly the moment it pulled away.
  const heartbeatMs =
    options.accuracy === 'high' ? HIGH_ACCURACY_HEARTBEAT_MS : BALANCED_HEARTBEAT_MS;
  if (
    validation.stationaryDrift &&
    validation.deviceConfirmedStationary &&
    lastStationaryPostAtMs > 0 &&
    Date.now() - lastStationaryPostAtMs < heartbeatMs
  ) {
    traceGps('rejected', options.ingestToken.slice(0, 6), {
      reason: 'stationary_heartbeat_throttled',
      lat: payload.latitude,
      lng: payload.longitude,
      accuracy: payload.accuracyMeters,
      gpsTime: payload.recordedAt,
    });
    stats = { ...stats, lastFix: fix };
    options.onStats(stats);
    return;
  }

  traceGps('raw', options.ingestToken.slice(0, 6), {
    lat: payload.latitude,
    lng: payload.longitude,
    speedMps: payload.speedMps,
    accuracy: payload.accuracyMeters,
    heading: payload.heading,
    provider: payload.provider,
    gpsTime: payload.recordedAt,
    // How stale the reading already was when the phone decided to send it.
    fixAgeMs: Date.now() - position.timestamp,
    stationaryDrift: validation.stationaryDrift,
  });

  try {
    const response = await fetch(`${env.apiBaseUrl}/ingest/positions`, {
      method: 'POST',
      headers: {
        ...COMMON_API_HEADERS,
        'Content-Type': 'application/json',
        'X-Device-Token': options.ingestToken,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      lastStationaryPostAtMs =
        validation.stationaryDrift && validation.deviceConfirmedStationary ? Date.now() : 0;
      traceGps('validated', options.ingestToken.slice(0, 6), {
        lat: payload.latitude,
        lng: payload.longitude,
        gpsTime: payload.recordedAt,
        // Sensor-to-server latency for this fix, measured on the device.
        uploadLatencyMs: Date.now() - position.timestamp,
      });
      previousSubmittedFix = validation.stationaryDrift && previousSubmittedFix
        ? { ...previousSubmittedFix, timestamp: position.timestamp }
        : {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            timestamp: position.timestamp,
          };
      stats = {
        ...stats,
        sent: stats.sent + 1,
        lastFix: fix,
        lastError: null,
        lastAcceptedAt: Date.now(),
      };
    } else {
      stats = {
        ...stats,
        rejected: stats.rejected + 1,
        lastFix: fix,
        lastError: await describeFailure(response),
      };
    }
  } catch (error) {
    stats = {
      ...stats,
      rejected: stats.rejected + 1,
      lastFix: fix,
      lastError: error instanceof Error ? error.message : 'Network request failed',
    };
  } finally {
    // `posting` is owned by handleFix, which keeps it set for the whole drain
    // loop so a fix arriving mid-drain is queued rather than starting a second
    // concurrent upload.
    options.onStats(stats);
  }
}

async function describeFailure(response: Response): Promise<string> {
  if (response.status === 401) return 'Token rejected — reissue it for this device.';
  if (response.status === 400) return 'Backend rejected the coordinates as invalid.';
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message || body.error || `Backend returned ${response.status}.`;
  } catch {
    return `Backend returned ${response.status}.`;
  }
}
