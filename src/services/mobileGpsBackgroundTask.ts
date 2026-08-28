import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { env } from '@/src/config/env';

export const MOBILE_GPS_TASK = 'glivt-mobile-gps-location-updates';
const MOBILE_GPS_SESSION_KEY = 'glivt.mobileGps.session.v1';

type MobileGpsSession = {
  ingestToken: string;
};

type MobileGpsTaskData = {
  locations?: Location.LocationObject[];
};

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

    // The newest fix is the authoritative one. Posting a whole deferred batch
    // after reconnecting can move the live marker backwards through stale data.
    const latest = data.locations[data.locations.length - 1];
    try {
      await postLocation(latest, session.ingestToken);
    } catch {
      // A transient network/API failure should end this delivery cleanly. The
      // native location service will invoke the task again with the next fix.
    }
  });
}

export async function startBackgroundMobileGps(
  ingestToken: string,
  accuracy: 'balanced' | 'high'
): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if (!(await TaskManager.isAvailableAsync())) return false;
    if (!(await Location.isBackgroundLocationAvailableAsync())) return false;

    const permission = await Location.requestBackgroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) return false;

    if (await TaskManager.isTaskRegisteredAsync(MOBILE_GPS_TASK)) {
      await Location.stopLocationUpdatesAsync(MOBILE_GPS_TASK);
    }
    await SecureStore.setItemAsync(
      MOBILE_GPS_SESSION_KEY,
      JSON.stringify({ ingestToken } satisfies MobileGpsSession)
    );
    await Location.startLocationUpdatesAsync(MOBILE_GPS_TASK, {
      accuracy:
        accuracy === 'high' ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced,
      activityType: Location.ActivityType.AutomotiveNavigation,
      deferredUpdatesDistance: accuracy === 'high' ? 5 : 15,
      deferredUpdatesInterval: accuracy === 'high' ? 3000 : 8000,
      distanceInterval: accuracy === 'high' ? 5 : 15,
      foregroundService: {
        notificationBody: 'Your vehicle location is being shared securely.',
        notificationColor: '#16A34A',
        notificationTitle: 'Glivt Mobile GPS is active',
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      timeInterval: accuracy === 'high' ? 3000 : 8000,
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
    await SecureStore.deleteItemAsync(MOBILE_GPS_SESSION_KEY).catch(() => undefined);
  }
}

async function postLocation(location: Location.LocationObject, ingestToken: string): Promise<void> {
  const { coords, timestamp } = location;
  const speedKph = coords.speed != null && coords.speed >= 0 ? Math.round(coords.speed * 3.6) : 0;
  const response = await fetch(`${env.apiBaseUrl}/ingest/positions`, {
    body: JSON.stringify({
      accuracyMeters: coords.accuracy != null && coords.accuracy >= 0 ? Math.round(coords.accuracy) : 0,
      heading: coords.heading != null && coords.heading >= 0 ? Math.round(coords.heading) : 0,
      ignitionOn: speedKph > 0,
      latitude: coords.latitude,
      longitude: coords.longitude,
      recordedAt: new Date(timestamp).toISOString(),
      speedKph,
    }),
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Token': ingestToken,
    },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Mobile GPS background upload failed with HTTP ${response.status}`);
  }
}
