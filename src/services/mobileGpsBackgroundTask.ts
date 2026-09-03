import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { COMMON_API_HEADERS, env } from '@/src/config/env';
import { traceGps } from '@/src/services/gpsDiagnostics';
import {
  buildMobileGpsPayload,
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

    for (const location of batch) {
      const validation = validateMobileGpsLocation(location, previousBackgroundFix);
      if (!validation.accepted) {
        traceGps('rejected', 'background', {
          reason: validation.reason,
          gpsTime: new Date(location.timestamp).toISOString(),
          accuracy: location.coords.accuracy,
        });
        continue;
      }
      try {
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
        await postLocation(location, session.ingestToken, session.accuracy ?? 'balanced');
        previousBackgroundFix = validation.stationaryDrift && previousBackgroundFix
          ? { ...previousBackgroundFix, timestamp: location.timestamp }
          : {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              timestamp: location.timestamp,
            };
      } catch {
        // A transient network/API failure ends this delivery cleanly rather than
        // continuing to push the rest of the batch at a link that is not there.
        // The native location service invokes the task again with the next fix.
        return;
      }
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
        notificationColor: '#16A34A',
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
    await SecureStore.deleteItemAsync(MOBILE_GPS_SESSION_KEY).catch(() => undefined);
  }
}

/**
 * Posts one fix.
 *
 * Body construction is shared with the foreground tracker so the two cannot
 * disagree about units. In particular the speed goes out in metres per second
 * and is converted exactly once, server-side - this function used to convert to
 * km/h itself, which meant the unit contract lived in two files.
 */
async function postLocation(
  location: Location.LocationObject,
  ingestToken: string,
  accuracy: 'balanced' | 'high'
): Promise<void> {
  const response = await fetch(`${env.apiBaseUrl}/ingest/positions`, {
    body: JSON.stringify(buildMobileGpsPayload(location, accuracy)),
    headers: {
      ...COMMON_API_HEADERS,
      'Content-Type': 'application/json',
      'X-Device-Token': ingestToken,
    },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Mobile GPS background upload failed with HTTP ${response.status}`);
  }
}
