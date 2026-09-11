import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { COMMON_API_HEADERS, env } from '@/src/config/env';
import { traceGps } from '@/src/services/gpsDiagnostics';
import { GpsAcquisitionGate } from '@/src/services/gpsPipeline';
import {
  buildMobileGpsPayload,
  heartbeatIntervalMs,
  rawGpsPointOf,
  validateMobileGpsLocation,
  type PreviousMobileGpsFix,
} from '@/src/services/mobileGpsPayload';

export const MOBILE_GPS_TASK = 'glivt-mobile-gps-location-updates';
const MOBILE_GPS_SESSION_KEY = 'glivt.mobileGps.session.v1';

/**
 * How often the OS is asked for a background fix.
 *
 * Matches the foreground tracker's sampling rate: a vehicle whose position is
 * only sampled every 10 to 30 seconds cannot be tracked live whichever code
 * path is running, and a phone that goes into the background mid-journey should
 * not silently drop to a tenth of the update rate.
 */
const HIGH_ACCURACY_SAMPLE_MS = 1_000;
const BALANCED_SAMPLE_MS = 1_000;

/** Most fixes posted from one task delivery. See the batching note below. */
const MAX_BACKGROUND_BATCH = 12;

type MobileGpsSession = {
  ingestToken: string;
  /**
   * The accuracy mode the session was started with, so the background task
   * reports the same provider the foreground one does. Older sessions written
   * before this field existed fall back to balanced.
   */
  accuracy?: 'balanced' | 'high';
};

type MobileGpsTaskData = {
  locations?: Location.LocationObject[];
};

let previousBackgroundFix: PreviousMobileGpsFix | null = null;
/** When this collector last sent a parked phone's "still here" heartbeat. */
let lastStationaryBackgroundPostAtMs = 0;
/**
 * Warm-up for the background collector, and the token it belongs to.
 *
 * The task body outlives any one session - the OS may invoke it after the app
 * process was recreated - so the gate is keyed by the ingest token it
 * converged for. A different token means a different vehicle's receiver, and
 * carrying the previous one's convergence across would let the new device's
 * very first cold fix straight through, which is precisely the case the gate
 * exists to catch.
 */
let backgroundAcquisition = new GpsAcquisitionGate();
let backgroundAcquisitionToken: string | null = null;

function acquisitionFor(ingestToken: string): GpsAcquisitionGate {
  if (backgroundAcquisitionToken !== ingestToken) {
    backgroundAcquisitionToken = ingestToken;
    backgroundAcquisition = new GpsAcquisitionGate();
  }
  return backgroundAcquisition;
}

/**
 * True while the foreground watcher is the collector in charge.
 *
 * <h3>Why one of the two has to stand down</h3>
 * Both collectors are registered at once on purpose - the task is what keeps
 * tracking alive once the app leaves the screen - but they were also both
 * POSTING at once, at 1 Hz each, for the same device. That is two uploads per
 * second where the product needs one, and the two are not equivalent: the task
 * drains its delivery serially, awaiting each POST, so on a slow link its
 * queue never catches up and its fixes arrive progressively later. Observed on
 * the test fleet as a device whose stored GPS time ran a steady 58 seconds
 * behind its arrival time while a second device on the same phone was current.
 *
 * That lag is the "delayed coordinates" and "GPS delayed" symptom, and it is
 * self-inflicted. Exactly one collector uploads at any moment: the foreground
 * watcher while the app is on screen, the background task the rest of the
 * time. The task stays REGISTERED throughout, so the handover costs no fixes.
 */
let foregroundCollectorActive = false;

/**
 * Declares which collector owns uploads. Called by the foreground tracker.
 *
 * @param active true while the app is in the foreground AND its own 1 Hz
 *               watcher is installed
 */
export function setForegroundCollectorActive(active: boolean): void {
  foregroundCollectorActive = active;
}

/**
 * The single predicate both collectors consult before uploading.
 *
 * Exported so the foreground tracker asks the same question rather than
 * re-deriving the answer from AppState itself. Two derivations of "who owns
 * uploads" is how both sides end up believing they do.
 */
export function isForegroundCollectorActive(): boolean {
  return foregroundCollectorActive;
}

if (Platform.OS !== 'web' && !TaskManager.isTaskDefined(MOBILE_GPS_TASK)) {
  TaskManager.defineTask<MobileGpsTaskData>(MOBILE_GPS_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const rawSession = await SecureStore.getItemAsync(MOBILE_GPS_SESSION_KEY);
    if (!rawSession) return;

    let session: MobileGpsSession;
    try {
      session = JSON.parse(rawSession) as MobileGpsSession;
    } catch {
      return;
    }
    if (!session.ingestToken) return;

    if (foregroundCollectorActive) {
      // The foreground watcher already has this fix, from the same sensor, and
      // will post it without the batch drain's latency. Posting it here as well
      // is a duplicate upload of the same GPS sample.
      traceGps('rejected', 'background', {
        reason: 'foreground_collector_owns_uploads',
        batchSize: data.locations.length,
      });
      return;
    }

    // Oldest first, and every fix in the batch.
    //
    // This used to keep ONLY the newest of a delivery and discard the rest,
    // which kept the marker current but tore holes in the travelled route: on
    // any delivery carrying more than one fix, every intermediate coordinate was
    // thrown away and the route jumped straight from one end of the batch to the
    // other. Posting them in recorded order gives the backend the whole path AND
    // still finishes on the newest fix, so the marker ends up in the same place
    // either way. Each fix carries its own GPS timestamp, so the server can
    // still tell a late delivery from a current position.
    //
    // The batch is capped so a long offline replay cannot delay the current
    // position behind minutes of history: past the cap the OLDEST are dropped,
    // never the newest.
    const ordered = [...data.locations].sort((a, b) => a.timestamp - b.timestamp);
    const batch = ordered.slice(Math.max(0, ordered.length - MAX_BACKGROUND_BATCH));
    if (batch.length < ordered.length) {
      // Past the cap the OLDEST go, and that is a coverage gap: those fixes were
      // never uploaded, so nothing downstream may draw a line across the ground
      // they covered. Logged with its range rather than absorbed silently.
      traceGps('rejected', 'background', {
        reason: 'background_batch_overflow_coverage_gap',
        droppedFixCount: ordered.length - batch.length,
        droppedFromGpsTime: new Date(ordered[0].timestamp).toISOString(),
        droppedToGpsTime: new Date(
          ordered[ordered.length - batch.length - 1].timestamp
        ).toISOString(),
        oldestRetainedGpsTime: new Date(batch[0].timestamp).toISOString(),
      });
    }

    const gate = acquisitionFor(session.ingestToken);
    // Screened here, uploaded once below. Posting them one at a time and
    // awaiting each round trip is what made the background collector fall
    // progressively further behind on a slow link - a device on the test fleet
    // ran a steady 58 seconds late while a second device on the same phone was
    // current. The whole delivery now costs ONE round trip.
    const payloads: ReturnType<typeof buildMobileGpsPayload>[] = [];
    let newestStationary = false;
    for (const location of batch) {
      // Warm-up first, and before any network work. A refused fix is never
      // posted, so it never becomes a stored position, a live coordinate or a
      // playback point - the same guarantee the foreground collector gives,
      // enforced by the same gate rather than by a second copy of the rules.
      const warmUp = gate.offer(rawGpsPointOf(location));
      if (warmUp.state === 'acquiring') {
        traceGps('rejected', 'background', {
          reason: warmUp.reason ? `acquiring:${warmUp.reason}` : 'acquiring',
          samples: warmUp.samples,
          needed: warmUp.needed,
          gpsTime: new Date(location.timestamp).toISOString(),
          accuracy: location.coords.accuracy,
        });
        continue;
      }
      const validation = validateMobileGpsLocation(location, previousBackgroundFix);
      if (!validation.accepted) {
        traceGps('rejected', 'background', {
          reason: validation.reason,
          gpsTime: new Date(location.timestamp).toISOString(),
          accuracy: location.coords.accuracy,
        });
        continue;
      }

      // A parked phone uploads at the heartbeat rate, not the sampling rate -
      // the same rule the foreground collector has always applied. Throttled
      // only when the DEVICE reported a stop, never merely because the fix was
      // held: a phone that reports no speed at all does that routinely while
      // driving, and throttling on that alone would cut a moving vehicle to one
      // upload every ten seconds exactly as it pulled away.
      const heartbeatMs = heartbeatIntervalMs(session.accuracy ?? 'balanced');
      if (
        validation.stationaryDrift &&
        validation.deviceConfirmedStationary &&
        lastStationaryBackgroundPostAtMs > 0 &&
        Date.now() - lastStationaryBackgroundPostAtMs < heartbeatMs
      ) {
        traceGps('rejected', 'background', {
          reason: 'stationary_heartbeat_throttled',
          gpsTime: new Date(location.timestamp).toISOString(),
          accuracy: location.coords.accuracy,
        });
        continue;
      }

      traceGps('raw', 'background', {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        accuracy: location.coords.accuracy,
        speedMps: location.coords.speed,
        heading: location.coords.heading,
        gpsTime: new Date(location.timestamp).toISOString(),
        fixAgeMs: Date.now() - location.timestamp,
        batchSize: batch.length,
      });
      payloads.push(buildMobileGpsPayload(location, session.accuracy ?? 'balanced'));
      newestStationary =
        validation.stationaryDrift && validation.deviceConfirmedStationary;
      // The anchor advances per ACCEPTED fix, in order, so the next fix in this
      // delivery is validated against its true predecessor.
      previousBackgroundFix = validation.stationaryDrift && previousBackgroundFix
        ? { ...previousBackgroundFix, timestamp: location.timestamp }
        : {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            timestamp: location.timestamp,
          };
    }

    if (payloads.length === 0) return;
    const newest = batch[batch.length - 1];
    try {
      await postPayloads(payloads, session.ingestToken);
      lastStationaryBackgroundPostAtMs = newestStationary ? Date.now() : 0;
      traceGps('validated', 'background', {
        gpsTime: payloads[payloads.length - 1].recordedAt,
        uploadLatencyMs: Date.now() - newest.timestamp,
        fixAgeMs: Date.now() - newest.timestamp,
        batchSize: payloads.length,
      });
    } catch {
      // A transient network/API failure ends this delivery cleanly rather than
      // retrying at a link that is not there. The native location service
      // invokes the task again with the next fix.
      traceGps('rejected', 'background', {
        reason: 'background_upload_failed',
        batchSize: payloads.length,
        gpsTime: payloads[payloads.length - 1].recordedAt,
      });
    }
  });
}

export async function startBackgroundMobileGps(
  ingestToken: string,
  accuracy: 'balanced' | 'high'
): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    previousBackgroundFix = null;
    lastStationaryBackgroundPostAtMs = 0;
    backgroundAcquisitionToken = null;
    backgroundAcquisition = new GpsAcquisitionGate();
    if (!(await TaskManager.isAvailableAsync())) return false;
    if (!(await Location.isBackgroundLocationAvailableAsync())) return false;

    const permission = await Location.requestBackgroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) return false;

    if (await TaskManager.isTaskRegisteredAsync(MOBILE_GPS_TASK)) {
      await Location.stopLocationUpdatesAsync(MOBILE_GPS_TASK);
    }
    await SecureStore.setItemAsync(
      MOBILE_GPS_SESSION_KEY,
      JSON.stringify({ ingestToken, accuracy } satisfies MobileGpsSession)
    );
    const sampleMs = accuracy === 'high' ? HIGH_ACCURACY_SAMPLE_MS : BALANCED_SAMPLE_MS;
    await Location.startLocationUpdatesAsync(MOBILE_GPS_TASK, {
      accuracy:
        accuracy === 'high' ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced,
      activityType: Location.ActivityType.AutomotiveNavigation,
      // A distance filter suppresses callbacks while a phone is parked. The
      // backend then reaches its offline timeout even though tracking is still
      // enabled. Time-based fixes are the Mobile GPS online heartbeat.
      deferredUpdatesDistance: 0,
      // Deferred updates are an explicit request that the OS HOLD fixes and
      // hand them over in a batch later. It was set to the heartbeat interval,
      // which asked the platform to delay every position by up to 10-30 seconds
      // before the app had even seen it - a delay no amount of downstream tuning
      // could recover. Zero means deliver each fix as it is produced.
      deferredUpdatesInterval: 0,
      distanceInterval: 0,
      foregroundService: {
        notificationBody: 'Your vehicle location is being shared securely.',
        notificationColor: '#1B66C9',
        notificationTitle: 'Glivt Mobile GPS is active',
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      timeInterval: sampleMs,
    });
    return true;
  } catch {
    await SecureStore.deleteItemAsync(MOBILE_GPS_SESSION_KEY).catch(() => undefined);
    return false;
  }
}

export async function stopBackgroundMobileGps(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (
      (await TaskManager.isAvailableAsync()) &&
      (await TaskManager.isTaskRegisteredAsync(MOBILE_GPS_TASK))
    ) {
      await Location.stopLocationUpdatesAsync(MOBILE_GPS_TASK);
    }
  } catch {
    // A missing native background service must not prevent a foreground
    // Mobile GPS session from starting or stopping cleanly.
  } finally {
    previousBackgroundFix = null;
    lastStationaryBackgroundPostAtMs = 0;
    backgroundAcquisitionToken = null;
    backgroundAcquisition = new GpsAcquisitionGate();
    await SecureStore.deleteItemAsync(MOBILE_GPS_SESSION_KEY).catch(() => undefined);
  }
}

/**
 * Posts one delivery's worth of fixes, oldest first.
 *
 * Body construction is shared with the foreground tracker so the two cannot
 * disagree about units. In particular the speed goes out in metres per second
 * and is converted exactly once, server-side.
 *
 * <p>A single fix still uses the single endpoint, so a one-fix delivery is
 * byte-for-byte what it always was; two or more go to the batch endpoint, which
 * ingests them individually and in order on the server.
 */
async function postPayloads(
  payloads: ReturnType<typeof buildMobileGpsPayload>[],
  ingestToken: string
): Promise<void> {
  const single = payloads.length === 1;
  const response = await fetch(
    single ? `${env.apiBaseUrl}/ingest/positions` : `${env.apiBaseUrl}/ingest/positions/batch`,
    {
      body: JSON.stringify(single ? payloads[0] : { positions: payloads }),
      headers: {
        ...COMMON_API_HEADERS,
        'Content-Type': 'application/json',
        'X-Device-Token': ingestToken,
      },
      method: 'POST',
    }
  );
  if (!response.ok) {
    throw new Error(`Mobile GPS background upload failed with HTTP ${response.status}`);
  }
}
