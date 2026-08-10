import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { env } from '@/src/config/env';
import { DEMO_ROAD_PATH } from '@/src/services/demoRoute';
import {
  bearingDeg,
  haversineKm,
  isValidGpsPoint,
  normalizeHeading,
} from '@/src/services/playbackEngine';
import { getSimulatedVehicle } from './vehicleSimulator';
import { snapCoordinateToRoadSync } from './roadSnapping';
import { useAppSelector } from '@/src/store/hooks';
import type { PlaybackTrackPoint } from '@/src/types/api';
import { openSse } from './sseClient';

/**
 * Live position streaming (Phase 2). Subscribes to the backend tenant SSE
 * position stream and accumulates the incoming fixes for a single device into a
 * buffer shaped like recorded playback points, so the same truthful playback
 * interpolator drives both history and live motion.
 *
 * Nothing here fabricates motion: each buffered point is a real fix with its own
 * server timestamp, recorded speed and course.
 */

export type LivePositionEvent = {
  deviceId: number;
  vehicleId: number | null;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  ignition: boolean | null;
  gpsValid: boolean;
  state: string | null;
  address: string | null;
  deviceTime: string | null;
  serverTime: string;
  updatedAt: string;
  /** Optional future-compatible field. The current SSE DTO may omit it. */
  accuracyMeters?: number | null;
};

export type LiveGpsQuality = 'no_data' | 'good' | 'low_accuracy' | 'invalid' | 'stale';

export type LivePositionsState = {
  /** SSE transport is currently open. */
  connected: boolean;
  /** Recorded timestamp of the latest accepted fix, or null. */
  lastEventAt: number | null;
  /** Local receipt time of the latest accepted SSE fix, used for connection freshness. */
  lastReceivedAt: number | null;
  /**
   * Accepted fixes for the CURRENT trip only, ascending by time. This is the
   * live travelled route: it starts empty, grows one fix at a time, and is reset
   * to a single point whenever a new trip begins (see `tripStartedAt`). It never
   * contains recorded history or look-ahead coordinates.
   */
  points: PlaybackTrackPoint[];
  /** Recorded timestamp of the first fix of the current trip, or null. */
  tripStartedAt: number | null;
  /** Most recent raw event for this device. */
  latest: LivePositionEvent | null;
  /** Quality of the latest accepted fix. */
  quality: LiveGpsQuality;
  /** Why the most recent inbound update was rejected. Cleared by a valid fix. */
  rejectedReason: string | null;
};

// Cap the in-memory live buffer so a long-lived screen can't grow unbounded.
const MAX_LIVE_POINTS = 600;
const MAX_RECORD_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const MAX_REASONABLE_GPS_SPEED_KPH = 260;
const LOW_ACCURACY_METERS = 50;
const MAX_ACCURACY_METERS = 200;
// A gap this long between accepted fixes means the previous trip ended; the next
// fix starts a fresh live route instead of drawing a straight line across the gap.
const TRIP_RESET_GAP_MS = 4 * 60 * 1000;

const EMPTY: LivePositionsState = {
  connected: false,
  lastEventAt: null,
  lastReceivedAt: null,
  points: [],
  tripStartedAt: null,
  latest: null,
  quality: 'no_data',
  rejectedReason: null,
};

/**
 * A new fix starts a new trip (and therefore a new live route) when there is no
 * previous point, when the ignition has just been switched back on, or when the
 * GPS gap since the last accepted fix is long enough that the vehicle clearly
 * stopped and started again. Deriving this locally keeps the same backend DTO.
 */
function startsNewTrip(
  previous: PlaybackTrackPoint | undefined,
  next: PlaybackTrackPoint,
  nextRecordedAt: number
): boolean {
  if (!previous) return true;
  const ignitionCycledOn =
    (previous.ignition === false || previous.ignition == null) && next.ignition === true;
  if (ignitionCycledOn) return true;
  const previousTimeMs = Date.parse(previous.t);
  return Number.isFinite(previousTimeMs) && nextRecordedAt - previousTimeMs > TRIP_RESET_GAP_MS;
}

type JsonObject = Record<string, unknown>;

type ValidatedFix =
  | {
      accepted: true;
      event: LivePositionEvent;
      point: PlaybackTrackPoint;
      recordedAt: number;
      quality: Exclude<LiveGpsQuality, 'no_data' | 'invalid' | 'stale'>;
    }
  | {
      accepted: false;
      quality: 'invalid' | 'stale';
      reason: string;
    };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseLivePositionEvent(value: unknown): LivePositionEvent | null {
  if (!isJsonObject(value)) return null;

  const deviceId = finiteNumber(value.deviceId);
  const latitude = finiteNumber(value.latitude);
  const longitude = finiteNumber(value.longitude);
  const serverTime = nullableString(value.serverTime);
  const hasAccuracy =
    Object.prototype.hasOwnProperty.call(value, 'accuracyMeters') ||
    Object.prototype.hasOwnProperty.call(value, 'accuracy');
  const rawAccuracyValue = Object.prototype.hasOwnProperty.call(value, 'accuracyMeters')
    ? value.accuracyMeters
    : value.accuracy;
  if (
    deviceId == null ||
    !Number.isSafeInteger(deviceId) ||
    latitude == null ||
    longitude == null ||
    !serverTime ||
    typeof value.gpsValid !== 'boolean' ||
    (value.deviceTime != null && typeof value.deviceTime !== 'string') ||
    (value.speed != null && finiteNumber(value.speed) == null) ||
    (value.course != null && finiteNumber(value.course) == null) ||
    (hasAccuracy && rawAccuracyValue != null && finiteNumber(rawAccuracyValue) == null)
  ) {
    return null;
  }

  const rawVehicleId = finiteNumber(value.vehicleId);
  // Some tracker integrations use `accuracy`; support it without changing the
  // existing backend contract.
  const rawAccuracy = finiteNumber(rawAccuracyValue);

  return {
    deviceId,
    vehicleId: rawVehicleId != null && Number.isSafeInteger(rawVehicleId) ? rawVehicleId : null,
    latitude,
    longitude,
    speed: finiteNumber(value.speed) ?? 0,
    course: finiteNumber(value.course) ?? Number.NaN,
    ignition: typeof value.ignition === 'boolean' ? value.ignition : null,
    gpsValid: value.gpsValid,
    state: nullableString(value.state),
    address: nullableString(value.address),
    deviceTime: nullableString(value.deviceTime),
    serverTime,
    updatedAt: nullableString(value.updatedAt) ?? serverTime,
    accuracyMeters: rawAccuracy,
  };
}

function angularDistance(a: number, b: number): number {
  return Math.abs(((((b - a) % 360) + 540) % 360) - 180);
}

/**
 * Defense-in-depth validation for an already tenant-scoped SSE position.
 * Invalid updates never replace the latest accepted coordinate.
 */
export function validateLivePositionEvent(
  event: LivePositionEvent,
  previous: PlaybackTrackPoint | undefined,
  now = Date.now()
): ValidatedFix {
  const serverTimeMs = Date.parse(event.serverTime);
  const recordedTimeMs = event.deviceTime ? Date.parse(event.deviceTime) : serverTimeMs;
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(recordedTimeMs)) {
    return { accepted: false, quality: 'invalid', reason: 'Malformed GPS timestamp' };
  }
  if (recordedTimeMs < now - MAX_RECORD_AGE_MS) {
    return { accepted: false, quality: 'stale', reason: 'Stale GPS update' };
  }
  if (recordedTimeMs > now + MAX_FUTURE_SKEW_MS || serverTimeMs > now + MAX_FUTURE_SKEW_MS) {
    return { accepted: false, quality: 'invalid', reason: 'Invalid GPS timestamp' };
  }

  const accuracy = event.accuracyMeters;
  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0)) {
    return { accepted: false, quality: 'invalid', reason: 'Invalid GPS accuracy' };
  }
  if (accuracy != null && accuracy > MAX_ACCURACY_METERS) {
    return { accepted: false, quality: 'invalid', reason: 'GPS accuracy is too low' };
  }

  const snap = snapCoordinateToRoadSync(event.latitude, event.longitude, event.course);
  const lat = snap.snapped ? snap.latitude : event.latitude;
  const lng = snap.snapped ? snap.longitude : event.longitude;

  const rawPoint: PlaybackTrackPoint = {
    // Playback history is ordered by device time, so live points use the same
    // authoritative clock. Server time remains validated as transport metadata.
    t: event.deviceTime ?? event.serverTime,
    lat,
    lng,
    speed: Number.isFinite(event.speed) ? Math.max(0, event.speed) : 0,
    course: event.course,
    ignition: event.ignition,
    gpsValid: event.gpsValid,
  };
  if (!isValidGpsPoint(rawPoint)) {
    return { accepted: false, quality: 'invalid', reason: 'Invalid GPS coordinates' };
  }

  let course = normalizeHeading(event.course, normalizeHeading(previous?.course, 0));
  if (previous) {
    const previousTimeMs = Date.parse(previous.t);
    if (!Number.isFinite(previousTimeMs) || recordedTimeMs <= previousTimeMs) {
      return { accepted: false, quality: 'invalid', reason: 'Duplicate or out-of-order GPS update' };
    }

    const distanceKm = haversineKm(
      previous.lat,
      previous.lng,
      rawPoint.lat,
      rawPoint.lng
    );
    const deltaMs = recordedTimeMs - previousTimeMs;
    const calculatedKph = distanceKm / (deltaMs / 3_600_000);
    const speedLimit = Math.min(
      360,
      Math.max(MAX_REASONABLE_GPS_SPEED_KPH, rawPoint.speed * 2.2 + 40)
    );
    if (!Number.isFinite(calculatedKph) || calculatedKph > speedLimit) {
      return { accepted: false, quality: 'invalid', reason: 'Impossible GPS location jump' };
    }

    const distanceMeters = distanceKm * 1000;
    const isMoving = rawPoint.speed >= 2 || calculatedKph >= 3;
    if (isMoving && distanceMeters >= 1) {
      const derivedCourse = bearingDeg(previous.lat, previous.lng, rawPoint.lat, rawPoint.lng);
      // A short, low-speed GPS wobble must not flip the vehicle backwards.
      course =
        rawPoint.speed < 8 &&
        distanceMeters < 12 &&
        angularDistance(normalizeHeading(previous.course, course), derivedCourse) > 150
          ? normalizeHeading(previous.course, course)
          : derivedCourse;
    } else {
      course = normalizeHeading(previous.course, course);
    }
  }

  const point = { ...rawPoint, course };
  return {
    accepted: true,
    event: {
      ...event,
      latitude: lat,
      longitude: lng,
      course,
      speed: point.speed,
    },
    point,
    recordedAt: recordedTimeMs,
    quality: accuracy != null && accuracy > LOW_ACCURACY_METERS ? 'low_accuracy' : 'good',
  };
}

function applyLiveEvent(
  previousState: LivePositionsState,
  event: LivePositionEvent,
  now = Date.now()
): LivePositionsState {
  const validation = validateLivePositionEvent(
    event,
    previousState.points[previousState.points.length - 1],
    now
  );
  if (!validation.accepted) {
    return {
      ...previousState,
      connected: true,
      quality: previousState.latest ? previousState.quality : validation.quality,
      rejectedReason: validation.reason,
    };
  }

  const previousPoint = previousState.points[previousState.points.length - 1];
  const newTrip = startsNewTrip(previousPoint, validation.point, validation.recordedAt);
  // New trip -> discard the old temporary route and begin again from this single
  // trip-start coordinate. Otherwise append to the current trip's route.
  const points = newTrip
    ? [validation.point]
    : [...previousState.points, validation.point];
  return {
    connected: true,
    lastEventAt: validation.recordedAt,
    lastReceivedAt: now,
    latest: validation.event,
    points:
      points.length > MAX_LIVE_POINTS
        ? points.slice(points.length - MAX_LIVE_POINTS)
        : points,
    tripStartedAt: newTrip ? validation.recordedAt : previousState.tripStartedAt,
    quality: validation.quality,
    rejectedReason: null,
  };
}

export function useLivePositions(deviceId?: number, initialState?: string, enabled = true): LivePositionsState {
  const token = useAppSelector((s) => s.auth.accessToken);
  // Device ids are tenant-owned, so a tenant switch invalidates the whole buffer:
  // the accumulated live route, the last fix and the connection all belong to the
  // previous tenant and must not be drawn under the new one.
  const tenantEpoch = useAppSelector((s) => s.tenant.epoch);
  const [state, setState] = useState<LivePositionsState>(EMPTY);

  // Reset accumulation whenever the target device or the active tenant changes.
  useEffect(() => {
    setState(EMPTY);
  }, [deviceId, tenantEpoch]);

  useEffect(() => {
    if (!enabled || deviceId == null) {
      return;
    }

    // Dev-only offline demo: march the device along a demo path in real time so
    // the LIVE/follow features are testable without a backend. Forced off in
    // production because `env.demoMode` is gated behind `__DEV__`.
    if (env.demoMode) {
      return startDemoSimulator(deviceId, initialState, setState);
    }

    if (!env.backendBaseUrl) {
      return;
    }

    const url = `${env.apiBaseUrl}/positions/stream`;
    const connection = openSse(url, token ?? null, {
      onOpen: () => setState((prev) => ({ ...prev, connected: true })),
      onError: () => setState((prev) => ({ ...prev, connected: false })),
      onEvent: (name, data) => {
        if (name !== 'POSITION') return;
        let raw: unknown;
        try {
          raw = JSON.parse(data) as unknown;
        } catch {
          return;
        }
        if (!isJsonObject(raw) || finiteNumber(raw.deviceId) !== deviceId) return;
        const event = parseLivePositionEvent(raw);
        if (!event) {
          setState((prev) => ({
            ...prev,
            connected: true,
            quality: prev.latest ? prev.quality : 'invalid',
            rejectedReason: 'Malformed GPS update',
          }));
          return;
        }
        setState((prev) => applyLiveEvent(prev, event));
      },
    });

    // Closing on tenantEpoch change is what unsubscribes from the previous tenant's
    // GPS stream; the effect then reopens it with the new tenant's token.
    return () => connection.close();
  }, [enabled, deviceId, token, tenantEpoch, initialState]);

  return state;
}

// Demo-only route is densified so each 1.5-second fix remains road-aligned and
// physically plausible instead of jumping between sparse route vertices.
const DEMO_LIVE_PATH = densifyDemoPath(DEMO_ROAD_PATH, 16);

function densifyDemoPath(path: [number, number][], maxStepMeters: number): [number, number][] {
  if (path.length < 2) return path;
  const result: [number, number][] = [path[0]];
  for (let index = 1; index < path.length; index += 1) {
    const [fromLng, fromLat] = path[index - 1];
    const [toLng, toLat] = path[index];
    const distanceMeters = haversineKm(fromLat, fromLng, toLat, toLng) * 1000;
    const steps = Math.max(1, Math.ceil(distanceMeters / maxStepMeters));
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      result.push([
        fromLng + (toLng - fromLng) * fraction,
        fromLat + (toLat - fromLat) * fraction,
      ]);
    }
  }
  return result;
}

function demoBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/**
 * DEV/DEMO ONLY. Emits a fresh timestamped fix every 1.5s, looping along the
 * demo path, so the live UI (LIVE badge, follow mode, real-time marker) can be
 * exercised offline. Each fix carries a real server timestamp + recorded-style
 * speed/course, so the truthful interpolator has genuine fields to render.
 */
function startDemoSimulator(
  deviceId: number,
  initialState: string | undefined,
  setState: Dispatch<SetStateAction<LivePositionsState>>
): () => void {
  const isMoving = initialState === 'RUNNING' || initialState === 'MOVING' || !initialState;

  const emit = () => {
    const defaultLng = DEMO_LIVE_PATH[DEMO_LIVE_PATH.length - 1][0];
    const defaultLat = DEMO_LIVE_PATH[DEMO_LIVE_PATH.length - 1][1];

    const sim = getSimulatedVehicle(
      deviceId,
      defaultLat,
      defaultLng,
      0,
      initialState || 'RUNNING',
      isMoving
    );

    const now = new Date().toISOString();
    const event: LivePositionEvent = {
      deviceId,
      vehicleId: deviceId,
      latitude: sim.latitude,
      longitude: sim.longitude,
      speed: isMoving ? Math.round(sim.speed * 10) / 10 : 0,
      course: sim.heading,
      ignition: isMoving,
      gpsValid: true,
      state: sim.state,
      address: 'Demo live location, Bengaluru',
      deviceTime: now,
      serverTime: now,
      updatedAt: now,
    };
    setState((prev) => applyLiveEvent(prev, event));
  };

  emit();
  if (!isMoving) {
    return () => {};
  }
  const timer = setInterval(emit, 1500);
  return () => clearInterval(timer);
}
