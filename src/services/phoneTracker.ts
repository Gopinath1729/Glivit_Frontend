import * as Location from 'expo-location';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { COMMON_API_HEADERS, env } from '@/src/config/env';
import { traceGps } from '@/src/services/gpsDiagnostics';
import { GPS_ACQUISITION, GpsAcquisitionGate } from '@/src/services/gpsPipeline';
import {
  isForegroundCollectorActive,
  setForegroundCollectorActive,
  startBackgroundMobileGps,
  stopBackgroundMobileGps,
} from '@/src/services/mobileGpsBackgroundTask';
import {
  buildMobileGpsPayload,
  heartbeatIntervalMs,
  rawGpsPointOf,
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
  /**
   * True while the receiver is still warming up and NOTHING is being sent.
   *
   * Distinct from an error: the session is healthy, it is simply refusing to
   * publish a position it does not yet trust. See {@link GpsAcquisitionGate}.
   */
  acquiring: boolean;
  /** Agreeing fixes collected so far, out of {@link acquisitionNeeded}. */
  acquisitionSamples: number;
  acquisitionNeeded: number;
  /** Fixes waiting to be uploaded. Non-zero means HTTP is behind the sensor. */
  queueDepth: number;
  /**
   * Moving fixes discarded because the queue reached its safety limit.
   *
   * Non-zero is a COVERAGE GAP, not a rounding error: those seconds of road
   * were never uploaded, so nothing downstream may draw a line across them.
   */
  droppedFixCount: number;
  /** Fixes in the most recent upload. */
  lastBatchSize: number;
  /** Sensor-to-server latency of the most recent upload, in ms. */
  lastUploadLatencyMs: number | null;
  /** Age of the newest fix when it was uploaded, in ms. */
  lastFixAgeMs: number | null;
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
  acquiring: true,
  acquisitionSamples: 0,
  acquisitionNeeded: GPS_ACQUISITION.minSamples,
  queueDepth: 0,
  droppedFixCount: 0,
  lastBatchSize: 0,
  lastUploadLatencyMs: null,
  lastFixAgeMs: null,
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
 * Fixes waiting to be uploaded, oldest first.
 *
 * <h3>Why this is a queue and not one slot</h3>
 * It used to be a single `pendingFix` that each new arrival OVERWROTE while a
 * post was in flight. That is fine only while a round trip is faster than the
 * sampling interval. It is not on a mobile link: at 1 Hz sampling and a
 * three-second POST, two of every three fixes were silently replaced by the
 * next one and never left the phone. The fixes that get replaced are not
 * redundant - on a corner they ARE the corner, so the turn itself was the part
 * that never reached the server, and every downstream stage was then asked to
 * explain a route that jumped from one side of a junction to the other.
 *
 * Every MOVING fix now waits its turn, in GPS-timestamp order, and several are
 * uploaded per round trip through the batch endpoint. Stationary drift is still
 * throttled to the heartbeat rate - that is a deliberate rule about a parked
 * vehicle, not an accident of timing.
 */
let pendingQueue: Location.LocationObject[] = [];
/**
 * Moving fixes dropped because the queue hit its safety limit.
 *
 * Tracked and reported rather than absorbed. Each one is a second of road that
 * was never uploaded, and the honest rendering of that is a break in the line -
 * so it has to be visible somewhere, not silently smoothed over.
 */
let droppedFixCount = 0;

/**
 * Most fixes held on the phone before the OLDEST are dropped.
 *
 * Two minutes of 1 Hz sampling. Past this the link is not merely slow, it is
 * not working, and holding an unbounded backlog would trade a coverage gap for
 * an out-of-memory crash AND a marker minutes behind the vehicle. The newest
 * data is what a live map needs, so the oldest goes.
 */
const MAX_PENDING_FIXES = 120;
/**
 * Most fixes in one upload.
 *
 * The backend ingests a batch packet-by-packet in order, under the same
 * per-device lock and the same validation as a single post, so a larger batch
 * costs the server nothing extra per fix. It is capped so one upload cannot
 * take so long that the queue behind it grows faster than it drains.
 */
const MAX_UPLOAD_BATCH = 20;
let activeIngestToken: string | null = null;
let previousSubmittedFix: PreviousMobileGpsFix | null = null;
/**
 * Warm-up for THIS session's receiver.
 *
 * Module-level for the same reason the watcher is: the phone has one GPS, so
 * there is one warm-up to complete. It is replaced - never merely reset -
 * whenever a session starts, so a previous device's convergence can never
 * vouch for the next one's.
 */
let acquisition = new GpsAcquisitionGate();
/**
 * Watches which collector should own uploads.
 *
 * Installed alongside the location watcher and torn down with it. While the
 * app is on screen the foreground watcher uploads and the background task
 * stands down; the moment the app leaves the foreground they swap. Exactly one
 * of them is posting at any instant, which is what stops the same device
 * receiving two uploads per second from one phone.
 */
let appStateSubscription: { remove: () => void } | null = null;

function publishCollectorOwnership(state: AppStateStatus = AppState.currentState): void {
  setForegroundCollectorActive(subscription !== null && state === 'active');
}
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
  acquisition = new GpsAcquisitionGate();
  // Claim upload ownership before the first fix is asked for, not after the
  // watcher is installed: the immediate fix below arrives in between, and
  // without the claim it would be dropped as belonging to the background task
  // - delaying warm-up by the whole start-up sequence.
  setForegroundCollectorActive(true);

  // Ask for a fix immediately. watchPositionAsync may wait for movement before
  // its first callback, so without this a newly-created Mobile GPS device could
  // sit in NO_DATA while the phone already has a valid position.
  //
  // This fix is NOT published on its own. It is offered to the warm-up gate as
  // sample one like any other, because a cold receiver's first answer is the
  // least trustworthy reading of the whole session - and it used to become the
  // route's first vertex and the trip's origin permanently.
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
    // call owns nothing any more and must not install anything - including the
    // upload ownership it optimistically claimed above.
    if (background) await stopBackgroundMobileGps();
    publishCollectorOwnership();
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
    publishCollectorOwnership();
    return { background: false };
  }
  subscription = watcher;
  activeIngestToken = options.ingestToken;
  appStateSubscription?.remove();
  appStateSubscription = AppState.addEventListener('change', publishCollectorOwnership);
  publishCollectorOwnership();
  return { background };
}

export function stopTracking(): Promise<void> {
  return serialize(stopTrackingExclusive);
}

async function stopTrackingExclusive(): Promise<void> {
  sessionGeneration += 1;
  subscription?.remove();
  subscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  publishCollectorOwnership();
  await stopBackgroundMobileGps();
  backgroundTracking = false;
  activeIngestToken = null;
  posting = false;
  pendingQueue = [];
  droppedFixCount = 0;
  lastStationaryPostAtMs = 0;
  previousSubmittedFix = null;
  acquisition = new GpsAcquisitionGate();
}

/**
 * Queues one fix and drains the queue, without ever coalescing a moving fix.
 *
 * Ordering is by the OS's own GPS timestamp, never by arrival: the platform can
 * deliver a slightly older fix after a newer one, and uploading them in that
 * order makes the backend reject the older as out-of-order - losing it for a
 * reason that has nothing to do with GPS.
 */
async function handleFix(position: Location.LocationObject, options: StartOptions): Promise<void> {
  // The OS can keep this watcher firing after the app leaves the foreground,
  // where the background task is the collector in charge. Uploading here as
  // well would restore exactly the duplicate this handover removed, so the
  // watcher defers to the same predicate the task consults.
  if (!isForegroundCollectorActive()) return;

  enqueueFix(position, options);
  if (posting) return;

  posting = true;
  try {
    while (pendingQueue.length > 0) {
      const batch = pendingQueue.splice(0, MAX_UPLOAD_BATCH);
      await postBatch(batch, options);
    }
  } finally {
    posting = false;
  }
}

/** Adds one fix in GPS-timestamp order, dropping the OLDEST on overflow. */
function enqueueFix(position: Location.LocationObject, options: StartOptions): void {
  // A duplicate delivery of the same GPS sample carries nothing new and would
  // be rejected downstream; it is not a coalesced fix and does not count as one.
  if (pendingQueue.some((queued) => queued.timestamp === position.timestamp)) return;

  let index = pendingQueue.length;
  while (index > 0 && pendingQueue[index - 1].timestamp > position.timestamp) index -= 1;
  pendingQueue.splice(index, 0, position);

  while (pendingQueue.length > MAX_PENDING_FIXES) {
    const dropped = pendingQueue.shift();
    droppedFixCount += 1;
    // Logged with its exact range so the gap can be found in the trace rather
    // than inferred from a hole in the route. Nothing downstream is allowed to
    // connect across it.
    traceGps('rejected', options.ingestToken.slice(0, 6), {
      reason: 'upload_queue_overflow_coverage_gap',
      droppedGpsTime: dropped ? new Date(dropped.timestamp).toISOString() : null,
      droppedLat: dropped?.coords.latitude,
      droppedLng: dropped?.coords.longitude,
      oldestRetainedGpsTime: new Date(pendingQueue[0].timestamp).toISOString(),
      droppedFixCount,
      queueDepth: pendingQueue.length,
    });
  }
  stats = { ...stats, queueDepth: pendingQueue.length, droppedFixCount };
}

/**
 * Runs one fix through every collection gate.
 *
 * Returns the payload to upload, or null when the fix must not be sent. The
 * gates are identical to the ones the single-post path always applied - warm-up,
 * validation, stationary heartbeat throttling - and they run in the same order,
 * in GPS-timestamp order across a batch, so a batched upload and a series of
 * single uploads accept exactly the same fixes.
 */
function screenFix(
  position: Location.LocationObject,
  options: StartOptions
): { payload: ReturnType<typeof buildMobileGpsPayload>; fix: TrackerFix; stationary: boolean } | null {
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

  // --- warm-up -----------------------------------------------------------
  //
  // Nothing leaves the phone until the receiver has proven itself. This is the
  // stage that stops the FIRST coordinate of a session - the least trustworthy
  // reading it will ever produce - from becoming the route's first vertex, the
  // trip's origin and the stored playback record's opening point. Because the
  // gate sits before the POST, a fix refused here is never ingested, never
  // matched, never drawn live and never replayed later: Live and Playback stay
  // identical by construction rather than by two sets of rules agreeing.
  const raw = rawGpsPointOf(position);
  const warmUp = acquisition.offer(raw);
  if (warmUp.state === 'acquiring') {
    traceGps('rejected', options.ingestToken.slice(0, 6), {
      reason: warmUp.reason ? `acquiring:${warmUp.reason}` : 'acquiring',
      samples: warmUp.samples,
      needed: warmUp.needed,
      lat: payload.latitude,
      lng: payload.longitude,
      accuracy: payload.accuracyMeters,
      gpsTime: payload.recordedAt,
    });
    stats = {
      ...stats,
      lastFix: fix,
      acquiring: true,
      acquisitionSamples: warmUp.samples,
      acquisitionNeeded: warmUp.needed,
      // Warm-up is not a fault, so it does not raise one. A receiver that is
      // still converging is the pipeline working exactly as intended.
      lastError: null,
    };
    options.onStats(stats);
    return null;
  }
  if (stats.acquiring) {
    stats = { ...stats, acquiring: false, acquisitionSamples: warmUp.samples };
  }

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
    return null;
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
  //
  // This is the ONLY place a fix is dropped for being redundant, and it applies
  // to stationary drift only. A moving fix is never coalesced away.
  const heartbeatMs = heartbeatIntervalMs(options.accuracy);
  const stationary = validation.stationaryDrift && validation.deviceConfirmedStationary;
  if (
    stationary &&
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
    return null;
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
    queueDepth: pendingQueue.length,
  });

  // The anchor advances as each fix is ACCEPTED for upload, in order, so the
  // next fix in the same batch is validated against its true predecessor rather
  // than against whatever was last uploaded before the batch began.
  previousSubmittedFix =
    validation.stationaryDrift && previousSubmittedFix
      ? { ...previousSubmittedFix, timestamp: position.timestamp }
      : {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timestamp: position.timestamp,
        };

  return { payload, fix, stationary };
}

/**
 * Uploads a batch of screened fixes in one request.
 *
 * <h3>Why a batch</h3>
 * The phone samples at 1 Hz. On a link where a round trip takes three seconds,
 * one-fix-per-request can never keep up, and the queue in front of it grows
 * without bound - so every fix reaches the server later than the last, and the
 * marker settles into a permanent, growing lag behind the vehicle. Sending the
 * whole queue in one request makes the upload rate independent of the sampling
 * rate: the backlog drains in a single round trip instead of one per fix.
 *
 * <h3>What the batch does NOT change</h3>
 * The backend ingests the packets individually and in order, under the same
 * per-device lock, the same validation and the same one-transaction-per-packet
 * rule as single posts. Trip distance in particular is accumulated in arrival
 * order, so the packets must stay oldest-first.
 */
async function postBatch(
  batch: Location.LocationObject[],
  options: StartOptions
): Promise<void> {
  const screened = batch
    .map((position) => ({ position, screened: screenFix(position, options) }))
    .filter(
      (entry): entry is { position: Location.LocationObject; screened: NonNullable<ReturnType<typeof screenFix>> } =>
        entry.screened !== null
    );
  if (screened.length === 0) return;

  const positions = screened.map((entry) => entry.screened.payload);
  const newest = screened[screened.length - 1];
  const single = positions.length === 1;
  const url = single
    ? `${env.apiBaseUrl}/ingest/positions`
    : `${env.apiBaseUrl}/ingest/positions/batch`;
  const body = single ? positions[0] : { positions };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...COMMON_API_HEADERS,
        'Content-Type': 'application/json',
        'X-Device-Token': options.ingestToken,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      lastStationaryPostAtMs = newest.screened.stationary ? Date.now() : 0;
      const uploadLatencyMs = Date.now() - newest.position.timestamp;
      traceGps('validated', options.ingestToken.slice(0, 6), {
        lat: newest.screened.payload.latitude,
        lng: newest.screened.payload.longitude,
        gpsTime: newest.screened.payload.recordedAt,
        // Sensor-to-server latency for the newest fix, measured on the device.
        uploadLatencyMs,
        fixAgeMs: uploadLatencyMs,
        batchSize: positions.length,
        queueDepth: pendingQueue.length,
        droppedFixCount,
      });
      stats = {
        ...stats,
        sent: stats.sent + positions.length,
        lastFix: newest.screened.fix,
        lastError: null,
        lastAcceptedAt: Date.now(),
        queueDepth: pendingQueue.length,
        droppedFixCount,
        lastBatchSize: positions.length,
        lastUploadLatencyMs: uploadLatencyMs,
        lastFixAgeMs: uploadLatencyMs,
      };
    } else {
      stats = {
        ...stats,
        rejected: stats.rejected + positions.length,
        lastFix: newest.screened.fix,
        lastError: await describeFailure(response),
        queueDepth: pendingQueue.length,
        droppedFixCount,
        lastBatchSize: positions.length,
      };
    }
  } catch (error) {
    stats = {
      ...stats,
      rejected: stats.rejected + positions.length,
      lastFix: newest.screened.fix,
      lastError: error instanceof Error ? error.message : 'Network request failed',
      queueDepth: pendingQueue.length,
      droppedFixCount,
      lastBatchSize: positions.length,
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
