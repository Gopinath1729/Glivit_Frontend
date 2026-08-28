import * as Location from 'expo-location';

import { env } from '@/src/config/env';
import {
  startBackgroundMobileGps,
  stopBackgroundMobileGps,
} from '@/src/services/mobileGpsBackgroundTask';

/**
 * Turns this phone into a GPS tracker for one Glivt device.
 *
 * The phone posts to exactly the same endpoint a hardware tracker uses
 * (`POST /api/ingest/positions`, authenticated by `X-Device-Token`), so the
 * backend pipeline — feature derivation, state, anomaly scoring — runs on these
 * fixes identically. Nothing here is a special case downstream.
 */

export type TrackerFix = {
  latitude: number;
  longitude: number;
  speedKph: number;
  heading: number;
  accuracyMeters: number;
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
let stats: TrackerStats = { ...INITIAL_STATS };
/** Guards against overlapping posts when a fix arrives before the last returned. */
let posting = false;

export function isTracking(): boolean {
  return subscription !== null || backgroundTracking;
}

export function currentStats(): TrackerStats {
  return stats;
}

/** Foreground permission is the minimum this needs; denial is terminal. */
export async function requestTrackingPermission(): Promise<
  { granted: true } | { granted: false; message: string }
> {
  const services = await Location.hasServicesEnabledAsync();
  if (!services) {
    return { granted: false, message: 'Location services are switched off on this phone.' };
  }
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== Location.PermissionStatus.GRANTED) {
    return { granted: false, message: 'Location permission is required to send positions.' };
  }
  return { granted: true };
}

export async function startTracking(options: StartOptions): Promise<{ background: boolean }> {
  await stopTracking();
  stats = { ...INITIAL_STATS };

  // Send a fresh high-accuracy fix immediately. watchPositionAsync may wait for
  // movement before its first callback, which would leave a newly-created
  // Mobile GPS device in NO_DATA even though the phone has a valid position.
  const initial = await Location.getCurrentPositionAsync({
    accuracy:
      options.accuracy === 'high'
        ? Location.Accuracy.BestForNavigation
        : Location.Accuracy.Balanced,
    mayShowUserSettingsDialog: true,
  });
  await handleFix(initial, options);

  backgroundTracking = await startBackgroundMobileGps(options.ingestToken, options.accuracy);
  if (backgroundTracking) {
    return { background: true };
  }

  subscription = await Location.watchPositionAsync(
    {
      accuracy:
        options.accuracy === 'high'
          ? Location.Accuracy.BestForNavigation
          : Location.Accuracy.Balanced,
      // distanceInterval alone goes silent while parked, which reads downstream
      // as a dead device rather than a stationary one. timeInterval keeps it
      // ticking — on Android only, per the SDK, so iOS still reports on movement.
      distanceInterval: options.accuracy === 'high' ? 5 : 15,
      timeInterval: options.accuracy === 'high' ? 3000 : 8000,
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
  return { background: false };
}

export async function stopTracking(): Promise<void> {
  subscription?.remove();
  subscription = null;
  await stopBackgroundMobileGps();
  backgroundTracking = false;
  posting = false;
}

async function handleFix(position: Location.LocationObject, options: StartOptions): Promise<void> {
  // Drop the fix rather than queue it: a stale position posted late would be
  // scored against the wrong elapsed time.
  if (posting) return;
  posting = true;

  const { coords, timestamp } = position;
  const fix: TrackerFix = {
    latitude: coords.latitude,
    longitude: coords.longitude,
    // expo reports m/s and uses -1 for "unknown"; the API wants km/h.
    speedKph: coords.speed != null && coords.speed >= 0 ? Math.round(coords.speed * 3.6) : 0,
    heading: coords.heading != null && coords.heading >= 0 ? Math.round(coords.heading) : 0,
    accuracyMeters: coords.accuracy != null && coords.accuracy >= 0 ? Math.round(coords.accuracy) : 0,
    recordedAt: new Date(timestamp).toISOString(),
  };

  try {
    const response = await fetch(`${env.apiBaseUrl}/ingest/positions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': options.ingestToken,
      },
      body: JSON.stringify({
        ...fix,
        // A moving phone is a running vehicle as far as the pipeline is
        // concerned; there is no ignition line to read.
        ignitionOn: fix.speedKph > 0,
      }),
    });

    if (response.ok) {
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
    posting = false;
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
