import { useEffect, useRef, useState } from 'react';

import { env } from '@/src/config/env';
import { traceGps } from '@/src/services/gpsDiagnostics';
import { toFiniteNumber } from '@/src/services/gpsPipeline';
import { useAppSelector } from '@/src/store/hooks';
import type { MapMatchStatus } from '@/src/types/api';
import { openSse, type SseConnection } from './sseClient';

/**
 * The tenant's live position stream — exactly one, shared by every screen.
 *
 * <h3>Why a singleton</h3>
 * The Live Map, the vehicle tracker screen and anything else that wants live
 * positions used to each open their own SSE request. That meant N connections
 * per session, N reconnect storms after a network blip, and — because two
 * overlapping streams deliver the same device's fixes interleaved — markers that
 * jumped backwards to positions they had already left. This module opens one
 * connection per tenant session and reference-counts its consumers, so the last
 * screen to unmount closes it and a logout or tenant switch tears it down for
 * good.
 *
 * <h3>Why the token is not a dependency</h3>
 * The access token rotates on refresh. Restarting the stream each time drops
 * every fix that lands during the reconnect, which on a quiet fleet can be the
 * difference between a marker updating and a marker sitting still for minutes.
 * The token is read at connect time through a provider instead, so a rotation
 * costs nothing and the next reconnect picks up the current one.
 *
 * <h3>Two frame types</h3>
 * `POSITION` is a new validated GPS fix and goes through the client's GPS
 * validation. `ROAD_MATCH` is the road answer for one `positionId` that has
 * already been delivered, and deliberately does NOT: it repeats that fix's
 * timestamp, so the duplicate-GPS rule correctly refuses it, and refusing it is
 * how the backend's road geometry used to be thrown away on arrival. The two
 * are dispatched to separate listeners here so neither rule has to be relaxed.
 *
 * <h3>Reconnect contract</h3>
 * Reconnection is exponential with jitter (in {@link openSse}), and the server
 * replays every vehicle's current position on connect. So after any
 * interruption the map is correct within one round trip — it never has to wait
 * for the next GPS packet, and it never has to blank a vehicle to stay honest.
 */

export type LivePositionEvent = {
  deviceId: number;
  vehicleId: number | null;
  /**
   * Identity of the stored fix this frame carries.
   *
   * Every later statement about this fix names it: the ROAD_MATCH enrichment
   * that says where the road put it, the route vertex appended for it, the
   * marker drawn at it, and the hydration boundary that says where history
   * stops and the stream starts. Correlating any of those by timestamp or by
   * arrival order is what let one fix's answer be applied to another's.
   *
   * Null for a backend that predates the field.
   */
  positionId: number | null;
  /** Validated GPS coordinate exactly as reported. */
  latitude: number;
  longitude: number;
  /** Where the backend road matcher placed it, when it could. */
  matchedLatitude: number | null;
  matchedLongitude: number | null;
  /** Orientation of the matched road, 0-360, or null when unmatched. */
  roadBearing: number | null;
  /** Matching confidence in [0,1], or null when this fix was not matched. */
  matchConfidence: number | null;
  /**
   * How the backend produced `matchedLatitude`/`matchedLongitude`.
   *
   * `SOLVED` is a fresh answer from Geoapify. `HELD` keeps the exact previous
   * road coordinate because no new usable match was available. `CARRIED` is a
   * legacy-server value. `NONE` is the validated coordinate, unmodified.
   *
   * Without this distinction a client can only trust a coordinate that carries
   * a confidence, so a rate-limited router made the marker alternate between
   * the snapped position and the raw one every other fix — a saw-tooth on and
   * off the carriageway, and a large part of "the route crosses buildings".
   *
   * Null for a backend that predates the field.
   */
  matchedSource: 'SOLVED' | 'HELD' | 'CARRIED' | 'NONE' | null;
  /** Road vertices covered since the previous update, as [lat, lng] pairs. */
  matchedGeometry: [number, number][];
  /** Canonical km/h. The backend converted it exactly once, at ingest. */
  speedKmh: number;
  /**
   * Backend-measured travel for the trip in progress, in km.
   *
   * The app displays this and never derives its own. Distance is measured on
   * the server between validated GPS coordinates, so the live readout, the
   * history summary and the reports are all the same number.
   */
  tripDistanceKm: number;
  tripStartedAt: string | null;
  course: number;
  accuracyMeters: number | null;
  ignition: boolean | null;
  gpsValid: boolean;
  state: string | null;
  connectionState: string | null;
  address: string | null;
  deviceTime: string | null;
  serverTime: string;
  lastGpsTime: string | null;
  lastServerReceivedTime: string | null;
  updatedAt: string;
  /**
   * True when this frame carries a GPS fix that may move the vehicle.
   *
   * False marks a state-only refresh: the backend's health sweep re-broadcasts
   * the snapshot a client already has, with the same coordinate and the same
   * `lastGpsTime`, purely to move a status pill. Those frames used to be
   * indistinguishable from a real update, so the validator scored them as
   * duplicate GPS timestamps and the screen told the operator its GPS was
   * faulty every time a vehicle stopped. State and connection are taken from
   * them; the position never is.
   *
   * Defaults to true for a backend that predates the field, which is the
   * behaviour those clients already had.
   */
  positionUpdate: boolean;
  /**
   * Why this fix is or is not on a road.
   *
   * Live tracking used to fall back to the raw coordinate silently - only the
   * History tab ever mentioned road matching - so a router that was down showed
   * as a marker quietly drifting off the carriageway with no explanation
   * anywhere. `UNAVAILABLE` and `DISABLED` are actionable by an operator;
   * `UNMATCHED` is a property of this particular trace.
   *
   * Null for a backend that predates the field.
   */
  matchStatus: MapMatchStatus | null;
};

/**
 * The road answer for ONE already-delivered position.
 *
 * <h3>Why this is not a POSITION frame</h3>
 * It carries no new GPS reading. It repeats the timestamp of the fix it
 * describes, so feeding it to the GPS validator gets it correctly rejected as a
 * duplicate — and that rejection is what used to discard the road geometry the
 * backend had just computed, leaving the client with nothing to draw but the
 * chord between two fixes. Enrichment is routed around GPS validation entirely
 * and applied by `positionId`.
 *
 * <h3>What a client may do with it</h3>
 * - `SOLVED` with geometry: draw that road, move the marker along it.
 * - `CARRIED`/`HELD`: the previous road coordinate still stands. The marker may
 *   use it; no geometry was returned, so no route is appended.
 * - `NONE`: no road answer. The vehicle stays visible, the reason is reported,
 *   and nothing at all is appended to the road route.
 */
export type LiveRoadMatchEvent = {
  deviceId: number;
  vehicleId: number | null;
  /** The fix this answers for. Frames without one are unusable and dropped. */
  positionId: number;
  matchedLatitude: number | null;
  matchedLongitude: number | null;
  roadBearing: number | null;
  matchConfidence: number | null;
  matchedSource: 'SOLVED' | 'HELD' | 'CARRIED' | 'NONE';
  /** Road vertices travelled since the previous matched position, `[lat, lng]`. */
  matchedGeometry: [number, number][];
  matchStatus: MapMatchStatus | null;
  gpsTime: string | null;
  serverTime: string | null;
};

export type LiveStreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export type LiveStreamState = {
  status: LiveStreamStatus;
  /** True only while the transport is actually open. */
  connected: boolean;
  /** Epoch ms of the most recent successful connect. */
  connectedAt: number | null;
  /** How many times this session has had to reconnect. */
  reconnectCount: number;
  /** Epoch ms of the last frame of any kind, including heartbeats. */
  lastMessageAt: number | null;
};

type PositionListener = (event: LivePositionEvent) => void;
type RoadMatchListener = (event: LiveRoadMatchEvent) => void;
type StateListener = (state: LiveStreamState) => void;

type Shared = {
  key: string;
  connection: SseConnection;
  positionListeners: Set<PositionListener>;
  roadMatchListeners: Set<RoadMatchListener>;
  stateListeners: Set<StateListener>;
  state: LiveStreamState;
  refCount: number;
};

const IDLE_STATE: LiveStreamState = {
  status: 'idle',
  connected: false,
  connectedAt: null,
  reconnectCount: 0,
  lastMessageAt: null,
};

let shared: Shared | null = null;
/**
 * Latest access token, kept outside React so the stream can read it at connect
 * time without the token being a subscription dependency.
 */
let currentToken: string | null = null;

// ---------------------------------------------------------------- parsing

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One numeric conversion for the whole wire format.
 *
 * Delegates to the pipeline's coercion so a coordinate that arrives as a JSON
 * string — which a proxy, a serialiser configured for decimal precision, or an
 * older backend can all produce — becomes a number here rather than failing
 * `Number.isFinite` and silently dropping the whole frame.
 */
function finiteNumber(value: unknown): number | null {
  return toFiniteNumber(value);
}

const MATCHED_SOURCES = ['SOLVED', 'HELD', 'CARRIED', 'NONE'] as const;

function matchedSourceOf(value: unknown): 'SOLVED' | 'HELD' | 'CARRIED' | 'NONE' | null {
  return typeof value === 'string' && (MATCHED_SOURCES as readonly string[]).includes(value)
    ? (value as 'SOLVED' | 'HELD' | 'CARRIED' | 'NONE')
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const MATCH_STATUSES: readonly MapMatchStatus[] = [
  'MATCHED',
  'PARTIAL',
  'UNMATCHED',
  'UNAVAILABLE',
  'DISABLED',
];

function matchStatusOf(value: unknown): MapMatchStatus | null {
  return typeof value === 'string' && (MATCH_STATUSES as readonly string[]).includes(value)
    ? (value as MapMatchStatus)
    : null;
}

function coordinatePairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const pairs: [number, number][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const latitude = finiteNumber(entry[0]);
    const longitude = finiteNumber(entry[1]);
    if (latitude == null || longitude == null) continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    pairs.push([latitude, longitude]);
  }
  return pairs;
}

/**
 * Parse one POSITION frame.
 *
 * Returns null for anything malformed. A malformed frame is dropped, never
 * merged: a partial object could otherwise overwrite a good coordinate with
 * undefined and take the vehicle off the map.
 */
export function parseLivePositionEvent(value: unknown): LivePositionEvent | null {
  if (!isJsonObject(value)) return null;

  const deviceId = finiteNumber(value.deviceId);
  const latitude = finiteNumber(value.latitude);
  const longitude = finiteNumber(value.longitude);
  const serverTime = nullableString(value.serverTime);
  if (
    deviceId == null ||
    !Number.isSafeInteger(deviceId) ||
    latitude == null ||
    longitude == null ||
    !serverTime ||
    typeof value.gpsValid !== 'boolean'
  ) {
    return null;
  }

  const vehicleId = finiteNumber(value.vehicleId);
  // speedKmh is the canonical field; `speed` is the legacy alias the backend
  // still emits. Reading both means an older backend keeps working, and neither
  // is ever converted again on this side.
  const speedKmh = finiteNumber(value.speedKmh) ?? finiteNumber(value.speed) ?? 0;
  const accuracy = finiteNumber(value.accuracyMeters) ?? finiteNumber(value.accuracy);

  const positionId = finiteNumber(value.positionId);

  return {
    deviceId,
    vehicleId: vehicleId != null && Number.isSafeInteger(vehicleId) ? vehicleId : null,
    positionId: positionId != null && Number.isSafeInteger(positionId) ? positionId : null,
    latitude,
    longitude,
    matchedLatitude: finiteNumber(value.matchedLatitude),
    matchedLongitude: finiteNumber(value.matchedLongitude),
    roadBearing: finiteNumber(value.roadBearing),
    matchConfidence: finiteNumber(value.matchConfidence),
    matchedSource: matchedSourceOf(value.matchedSource),
    matchedGeometry: coordinatePairs(value.matchedGeometry),
    speedKmh: Math.max(0, speedKmh),
    tripDistanceKm: Math.max(0, finiteNumber(value.tripDistanceKm) ?? 0),
    tripStartedAt: nullableString(value.tripStartedAt),
    course: finiteNumber(value.course) ?? Number.NaN,
    accuracyMeters: accuracy,
    ignition: typeof value.ignition === 'boolean' ? value.ignition : null,
    gpsValid: value.gpsValid,
    state: nullableString(value.state),
    connectionState: nullableString(value.connectionState),
    address: nullableString(value.address),
    deviceTime: nullableString(value.deviceTime),
    serverTime,
    lastGpsTime: nullableString(value.lastGpsTime) ?? nullableString(value.deviceTime),
    lastServerReceivedTime: nullableString(value.lastServerReceivedTime) ?? serverTime,
    updatedAt: nullableString(value.updatedAt) ?? serverTime,
    positionUpdate: typeof value.positionUpdate === 'boolean' ? value.positionUpdate : true,
    matchStatus: matchStatusOf(value.matchStatus),
  };
}

/**
 * Parse one ROAD_MATCH frame.
 *
 * A frame without a usable `positionId` is dropped outright. Without it the
 * enrichment cannot be attributed to a fix, and applying it to "whatever is
 * current" is precisely the stale-match bug — a road answer computed for one
 * position moving a different one.
 */
export function parseLiveRoadMatchEvent(value: unknown): LiveRoadMatchEvent | null {
  if (!isJsonObject(value)) return null;

  const deviceId = finiteNumber(value.deviceId);
  const positionId = finiteNumber(value.positionId);
  if (
    deviceId == null ||
    !Number.isSafeInteger(deviceId) ||
    positionId == null ||
    !Number.isSafeInteger(positionId)
  ) {
    return null;
  }

  const vehicleId = finiteNumber(value.vehicleId);
  return {
    deviceId,
    vehicleId: vehicleId != null && Number.isSafeInteger(vehicleId) ? vehicleId : null,
    positionId,
    matchedLatitude: finiteNumber(value.matchedLatitude),
    matchedLongitude: finiteNumber(value.matchedLongitude),
    roadBearing: finiteNumber(value.roadBearing),
    matchConfidence: finiteNumber(value.matchConfidence),
    matchedSource: matchedSourceOf(value.matchedSource) ?? 'NONE',
    matchedGeometry: coordinatePairs(value.matchedGeometry),
    matchStatus: matchStatusOf(value.matchStatus),
    gpsTime: nullableString(value.gpsTime),
    serverTime: nullableString(value.serverTime),
  };
}

// ---------------------------------------------------------------- transport

function publishState(next: Partial<LiveStreamState>): void {
  if (!shared) return;
  shared.state = { ...shared.state, ...next };
  const snapshot = shared.state;
  shared.stateListeners.forEach((listener) => listener(snapshot));
}

function openShared(key: string): Shared {
  const url = `${env.apiBaseUrl}/positions/stream`;
  const container: Shared = {
    key,
    connection: { close: () => undefined },
    positionListeners: new Set(),
    roadMatchListeners: new Set(),
    stateListeners: new Set(),
    state: { ...IDLE_STATE, status: 'connecting' },
    refCount: 0,
  };
  shared = container;

  container.connection = openSse(url, () => currentToken, {
    onOpen: () => {
      traceGps('sse', 'stream', { event: 'open', tenantKey: key });
      publishState({
        status: 'open',
        connected: true,
        connectedAt: Date.now(),
        lastMessageAt: Date.now(),
      });
    },
    onError: (error) => {
      traceGps('sse', 'stream', { event: 'error', tenantKey: key, error: String(error) });
      // Deliberately does NOT clear any position. Losing the transport says
      // nothing about where the vehicles are; the last known position stays on
      // the map and is labelled stale by its own age.
      publishState({ status: 'reconnecting', connected: false });
    },
    onRetryScheduled: (delayMs, attempt) => {
      traceGps('sse', 'stream', { event: 'retry', delayMs, attempt });
      publishState({
        status: 'reconnecting',
        connected: false,
        reconnectCount: (shared?.state.reconnectCount ?? 0) + (attempt === 1 ? 1 : 0),
      });
    },
    onEvent: (name, data) => {
      publishState({ lastMessageAt: Date.now() });
      if (name !== 'POSITION' && name !== 'ROAD_MATCH') return;
      let raw: unknown;
      try {
        raw = JSON.parse(data) as unknown;
      } catch {
        return;
      }
      if (name === 'ROAD_MATCH') {
        const enrichment = parseLiveRoadMatchEvent(raw);
        if (!enrichment) return;
        traceGps('matched', enrichment.deviceId, {
          stage: 'sse_road_match',
          positionId: enrichment.positionId,
          matchedSource: enrichment.matchedSource,
          matchStatus: enrichment.matchStatus,
          vertices: enrichment.matchedGeometry.length,
          gpsTime: enrichment.gpsTime,
          sseLatencyMs: enrichment.gpsTime
            ? Date.now() - Date.parse(enrichment.gpsTime)
            : null,
        });
        container.roadMatchListeners.forEach((listener) => listener(enrichment));
        return;
      }
      const event = parseLivePositionEvent(raw);
      if (!event) return;
      container.positionListeners.forEach((listener) => listener(event));
    },
  });

  return container;
}

function releaseShared(container: Shared): void {
  container.refCount -= 1;
  if (container.refCount > 0) return;
  container.connection.close();
  container.positionListeners.clear();
  container.roadMatchListeners.clear();
  container.stateListeners.clear();
  if (shared === container) shared = null;
}

/**
 * Subscribe to the tenant's live positions.
 *
 * @param onPosition called for every parsed POSITION frame, for every device.
 *                   Filtering is the caller's job, and it must filter by device
 *                   id rather than by index or arrival order.
 */
export function useLivePositionStream(
  onPosition: PositionListener,
  onRoadMatch: RoadMatchListener,
  enabled = true
): LiveStreamState {
  const token = useAppSelector((s) => s.auth.accessToken);
  const tenantEpoch = useAppSelector((s) => s.tenant.epoch);
  const [state, setState] = useState<LiveStreamState>(IDLE_STATE);

  // The token is mirrored into module scope rather than captured, so rotating
  // it never restarts the stream (see the note at the top of this file).
  currentToken = token ?? null;

  // The handler is read through a ref so a caller that passes an inline
  // function does not resubscribe on every render - which would close and
  // reopen the stream continuously and lose fixes the whole time.
  const handlerRef = useRef(onPosition);
  handlerRef.current = onPosition;
  const roadMatchHandlerRef = useRef(onRoadMatch);
  roadMatchHandlerRef.current = onRoadMatch;

  useEffect(() => {
    if (!enabled || !env.backendBaseUrl) {
      setState(IDLE_STATE);
      return;
    }

    const key = `tenant:${tenantEpoch}`;
    // A tenant switch is a different stream entirely: close the old one rather
    // than leaking another tenant's positions into this session.
    if (shared && shared.key !== key) {
      shared.connection.close();
      shared.positionListeners.clear();
      shared.stateListeners.clear();
      shared = null;
    }
    const container = shared ?? openShared(key);
    container.refCount += 1;

    const forward: PositionListener = (event) => handlerRef.current(event);
    const forwardMatch: RoadMatchListener = (event) => roadMatchHandlerRef.current(event);
    const onState: StateListener = (next) => setState(next);
    container.positionListeners.add(forward);
    container.roadMatchListeners.add(forwardMatch);
    container.stateListeners.add(onState);
    setState(container.state);

    return () => {
      container.positionListeners.delete(forward);
      container.roadMatchListeners.delete(forwardMatch);
      container.stateListeners.delete(onState);
      releaseShared(container);
    };
  }, [enabled, tenantEpoch]);

  return state;
}

/** Closes the shared stream outright. Used on logout. */
export function closeLivePositionStream(): void {
  if (!shared) return;
  shared.connection.close();
  shared.positionListeners.clear();
  shared.roadMatchListeners.clear();
  shared.stateListeners.clear();
  shared = null;
  currentToken = null;
}
