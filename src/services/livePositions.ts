import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { traceCoord, traceGps } from '@/src/services/gpsDiagnostics';
import { alignToRoad, lerpAngle, normalizeHeading } from '@/src/services/geoMath';
import {
  acceptMatchedCoordinate,
  buildTraceRecord,
  distanceBetween,
  GPS_LIMITS,
  GpsRollingWindow,
  validateGpsSample,
  type AcceptedAnchor,
  type GpsRejectionReason,
  type GpsRejectionSeverity,
  type LatLng,
  type RawGpsPoint,
  type RoadMatchedPoint,
  type ValidatedGpsPoint,
} from '@/src/services/gpsPipeline';
import {
  appendTrail,
  travelledSegment,
  type LiveCoordinate,
} from '@/src/services/liveRouteTrail';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { livePositionReceived } from '@/src/store/liveVehiclesState';
import type { MapMatchStatus, PlaybackTrackPoint } from '@/src/types/api';
import {
  useLivePositionStream,
  type LivePositionEvent,
  type LiveStreamState,
} from './livePositionStream';

export type { LivePositionEvent } from './livePositionStream';

/**
 * Live tracking for one device.
 *
 * <h3>Four positions, kept apart on purpose</h3>
 * <ul>
 *   <li><b>raw</b> — the coordinate exactly as the device reported it. Recorded
 *       for auditing. Nothing on the map ever reads it.</li>
 *   <li><b>validated</b> — raw, after the checks in `gpsPipeline`. A fix that
 *       fails is not promoted, and the previous validated position stands.
 *       Distance, speed and bearing are measured on THIS stage only.</li>
 *   <li><b>matched</b> — where the backend placed the validated fix on the OSM
 *       road network. This is what the vehicle is actually drawn at.</li>
 *   <li><b>display</b> — matched, eased toward over a short interval so the
 *       marker glides between fixes instead of teleporting.</li>
 * </ul>
 *
 * Collapsing these is what let raw GPS noise drive the marker directly: a single
 * bad fix moved the vehicle, and the route drew a spike out to it and back.
 * Nothing here ever writes a later stage back onto an earlier one.
 *
 * <h3>Where the rules live</h3>
 * All of them are in `gpsPipeline`, which the phone's own collector, History and
 * playback use as well. This module only unpacks the wire format, keeps the
 * per-device anchor and rolling window, and records the trace.
 *
 * <h3>What never happens here</h3>
 * The coordinate is never set to null and the vehicle is never removed. A lost
 * stream, a rejected fix, a stale reading and a poor-accuracy sample all leave
 * the last good matched position exactly where it is; only its labelled
 * freshness changes.
 */

export type LiveGpsQuality = 'no_data' | 'good' | 'low_accuracy' | 'invalid' | 'stale';

export type { LiveCoordinate } from '@/src/services/liveRouteTrail';

export type PreviousAcceptedLivePoint = AcceptedAnchor & {
  /** Alias kept for existing readers. */
  recordedAt: number;
  course: number;
};

export type LivePositionsState = {
  /** SSE transport is currently open. Says nothing about the vehicle. */
  connected: boolean;
  /** Full transport status, including reconnect bookkeeping. */
  stream: LiveStreamState;
  /** GPS timestamp of the latest accepted fix, epoch ms, or null. */
  lastEventAt: number | null;
  /** Local receipt time of the latest accepted fix. */
  lastReceivedAt: number | null;
  /** Accepted fixes for the current trip, on their matched coordinates. */
  points: PlaybackTrackPoint[];
  /**
   * The travelled route for this trip, in chronological order, as runs.
   *
   * Every ACCEPTED movement point extends it: with the road geometry the
   * backend matched when there is some, and otherwise with the segment from the
   * previous accepted point to this one — but ONLY when the two are actually
   * connectable. Held, drifting and rejected fixes extend nothing, so the line
   * is never drawn out to a coordinate the pipeline refused, and a telemetry
   * gap opens a NEW run instead of being closed with a chord.
   *
   * This is the live trail the map draws, and it is the only thing that draws
   * it - it is deliberately independent of every UI toggle, of the marker, of
   * the follow mode and of the device's status.
   */
  trail: LiveCoordinate[][];
  /**
   * GPS time the current trip began, epoch ms.
   *
   * The backend decides when a trip resets, so its value wins; the locally
   * detected trip start is only the fallback for a backend that sends none.
   */
  tripStartedAt: number | null;
  /** Latest raw event for this device. */
  latest: LivePositionEvent | null;
  /** Authoritative anchor used to validate the next SSE fix. */
  previousAcceptedPoint: PreviousAcceptedLivePoint | null;
  /** The reported coordinate of the latest accepted fix. */
  rawPosition: LiveCoordinate | null;
  /** The latest fix that passed validation. */
  validatedPosition: LiveCoordinate | null;
  /** Where the backend road matcher put it. Null until one has been matched. */
  matchedPosition: LiveCoordinate | null;
  /** The coordinate to draw. Never null once anything has been received. */
  displayPosition: LiveCoordinate | null;
  /**
   * True when the last accepted fix broke the polyline.
   *
   * The marker is placed at the new coordinate outright rather than animated
   * across the gap: easing over it draws the vehicle through every building in
   * between at a speed it never travelled.
   */
  displayDiscontinuous: boolean;
  /** Heading to draw, 0-360, shortest-angle interpolated. */
  displayHeading: number;
  /** Canonical km/h from the backend. Never recomputed on this side. */
  speedKmh: number;
  /**
   * Backend-measured travel for the trip in progress, in km.
   *
   * This screen displays it and measures nothing itself. The drawn route is
   * road geometry and is longer than the path between fixes, and a stationary
   * phone's jitter summed on the client is what produced kilometres for a
   * vehicle that never moved.
   */
  tripDistanceKm: number;
  /** Quality of the latest accepted fix. */
  quality: LiveGpsQuality;
  /** Why the most recent inbound update was rejected. Cleared by a valid fix. */
  rejectedReason: string | null;
  /**
   * Why the live marker is, or is not, on road geometry.
   *
   * Surfaced on the Live tab exactly as History surfaces its own. Falling back
   * to raw coordinates is allowed - it is the only honest thing to draw - but
   * doing it silently is not, because a configured-and-broken router is
   * indistinguishable from a working one at a glance.
   */
  matchStatus: MapMatchStatus | null;
};

const MAX_LIVE_POINTS = 600;

/**
 * Session route cache, keyed by tenant epoch and device.
 *
 * Navigating from the fleet map into a vehicle, switching tabs, or an SSE
 * reconnect must not erase the line already travelled. The previous hook kept
 * this state only inside one component mount, so reopening Live Track began
 * with the replayed snapshot as a one-point route and the polyline disappeared.
 * The cache is bounded by the same point/trail limits as the state it stores and
 * never crosses a tenant epoch.
 */
const liveStateCache = new Map<string, LivePositionsState>();

function liveCacheKey(tenantEpoch: number, deviceId: number): string {
  return `${tenantEpoch}:${deviceId}`;
}

export const EMPTY_LIVE_STATE: LivePositionsState = {
  connected: false,
  stream: {
    status: 'idle',
    connected: false,
    connectedAt: null,
    reconnectCount: 0,
    lastMessageAt: null,
  },
  lastEventAt: null,
  lastReceivedAt: null,
  points: [],
  trail: [],
  tripStartedAt: null,
  latest: null,
  previousAcceptedPoint: null,
  rawPosition: null,
  validatedPosition: null,
  matchedPosition: null,
  displayPosition: null,
  displayDiscontinuous: false,
  displayHeading: 0,
  speedKmh: 0,
  tripDistanceKm: 0,
  quality: 'no_data',
  rejectedReason: null,
  matchStatus: null,
};

// ------------------------------------------------------------- validation

/** Human-readable text for the operator-facing rejection banner. */
const REJECTION_TEXT: Record<GpsRejectionReason, string> = {
  invalid_coordinate: 'Invalid GPS coordinates',
  coordinate_axes_reversed: 'GPS latitude and longitude are reversed',
  null_island: 'Tracker reported no GPS lock',
  invalid_timestamp: 'Malformed GPS timestamp',
  future_timestamp: 'GPS timestamp is in the future',
  stale_timestamp: 'Stale GPS timestamp',
  duplicate_timestamp: 'Duplicate GPS timestamp',
  duplicate_coordinate: 'Duplicate GPS coordinate',
  out_of_order: 'Out-of-order GPS update',
  invalid_accuracy: 'Invalid GPS accuracy',
  poor_accuracy: 'GPS accuracy is too low',
  impossible_jump: 'Impossible GPS location jump',
  implausible_step: 'GPS position moved further than the vehicle could travel',
  isolated_spike: 'Isolated GPS spike from a stationary vehicle',
};

export type ValidatedFix =
  | {
      accepted: true;
      raw: LiveCoordinate;
      validated: LiveCoordinate;
      matched: LiveCoordinate;
      isMatched: boolean;
      snapDistanceMeters: number;
      recordedAt: number;
      speedKmh: number;
      course: number;
      quality: Exclude<LiveGpsQuality, 'no_data' | 'invalid'>;
      /** True when the fix was held at the previous position rather than moved. */
      held: boolean;
      /** True when the roads since the previous accepted fix were unobserved. */
      gapBefore: boolean;
      validatedPoint: ValidatedGpsPoint;
      matchedPoint: RoadMatchedPoint;
    }
  | {
      accepted: false;
      quality: 'invalid';
      reason: string;
      code: GpsRejectionReason;
      severity: GpsRejectionSeverity;
    };

/**
 * Turns one SSE frame into a raw pipeline sample.
 *
 * The GPS clock is preferred over every other clock on the frame. A packet
 * buffered offline is still a fix from when it was taken, and reading the
 * arrival clock instead corrupts the speed, the route and the reported
 * freshness all at once.
 */
function rawPointOf(event: LivePositionEvent): RawGpsPoint {
  const serverTimeMs = Date.parse(event.serverTime);
  const gpsTimeMs = event.lastGpsTime
    ? Date.parse(event.lastGpsTime)
    : event.deviceTime
      ? Date.parse(event.deviceTime)
      : serverTimeMs;
  return {
    vehicleId: event.deviceId,
    timestampMs: gpsTimeMs,
    latitude: event.latitude,
    longitude: event.longitude,
    accuracyMeters: event.accuracyMeters,
    deviceSpeedKmh: Number.isFinite(event.speedKmh) ? event.speedKmh : null,
    reportedHeading: Number.isFinite(event.course) ? event.course : null,
    source: 'stream',
  };
}

/**
 * Everything that must be true before a fix is allowed to move the vehicle.
 *
 * The rules themselves are in `gpsPipeline` and are shared with the phone's
 * collector, History and playback. This adds the two things only the live
 * stream knows about: whether the backend's road match may be trusted, and how
 * the matched road's orientation refines a proven direction of travel.
 */
export function validateLivePositionEvent(
  event: LivePositionEvent,
  previous: PreviousAcceptedLivePoint | null,
  now = Date.now(),
  window?: GpsRollingWindow | null
): ValidatedFix {
  const raw = rawPointOf(event);
  const decision = validateGpsSample({
    raw,
    previous,
    window,
    lastBearing: previous?.bearing ?? null,
    now,
  });

  if (!decision.accepted) {
    return {
      accepted: false,
      quality: 'invalid',
      reason: REJECTION_TEXT[decision.reason],
      code: decision.reason,
      severity: decision.severity,
    };
  }

  const validated = decision.point;
  const matched = acceptMatchedCoordinate(
    validated,
    {
      latitude: event.matchedLatitude,
      longitude: event.matchedLongitude,
      confidence: event.matchConfidence,
      source: event.matchedSource,
    },
    previous ? previous.display : null
  );

  // The road's orientation only ever REFINES a direction that was already
  // established from movement. A road carries traffic both ways, so taking its
  // orientation on its own renders half of all vehicles facing backwards.
  const course =
    matched.onRoad && !validated.held
      ? alignToRoad(validated.bearing, event.roadBearing)
      : validated.bearing;

  return {
    accepted: true,
    raw: { latitude: raw.latitude, longitude: raw.longitude },
    validated: validated.coordinate,
    matched: matched.coordinate,
    isMatched: matched.onRoad,
    snapDistanceMeters: matched.snapDistanceMeters,
    recordedAt: validated.timestampMs,
    speedKmh: validated.speedKmh,
    course,
    quality: validated.quality,
    held: validated.held,
    gapBefore: validated.gapBefore,
    validatedPoint: validated,
    matchedPoint: matched,
  };
}

// ------------------------------------------------------------- accumulation

function startsNewTrip(
  previous: PreviousAcceptedLivePoint | null,
  ignition: boolean | null,
  recordedAt: number
): boolean {
  if (!previous) return true;
  const ignitionCycledOn =
    (previous.ignition === false || previous.ignition == null) && ignition === true;
  if (ignitionCycledOn) return true;
  return recordedAt - previous.timestampMs > GPS_LIMITS.tripResetGapMs;
}

/**
 * The stretch of travelled route this accepted fix contributes.
 *
 * The rules live in `liveRouteTrail`, which is pure and directly tested. This
 * only unpacks the event and records why the geometry was what it was.
 */
function travelledSegmentFor(
  event: LivePositionEvent,
  validation: Extract<ValidatedFix, { accepted: true }>,
  previousPoint: PreviousAcceptedLivePoint | null,
  newTrip: boolean,
  expectedIntervalMs: number | null
) {
  const segment = travelledSegment({
    matchedGeometry: event.matchedGeometry,
    isMatched: validation.isMatched,
    previousDisplay: previousPoint ? previousPoint.display : null,
    previousTimestampMs: previousPoint ? previousPoint.timestampMs : null,
    currentDisplay: validation.matched,
    currentTimestampMs: validation.recordedAt,
    gapBefore: validation.gapBefore,
    newTrip,
    expectedIntervalMs,
  });
  if (segment.matchedGeometryRejected) {
    traceGps('rejected', event.deviceId, {
      reason: 'invalid_matched_geometry',
      vertices: event.matchedGeometry.length,
      gpsTime: event.lastGpsTime ?? event.deviceTime,
    });
  }
  if (segment.breakReason && segment.mode === 'break') {
    // The single most useful line in the whole trace when somebody reports "a
    // long straight line appeared across the map": it names the gap that broke
    // the run, at the moment it was broken, instead of leaving the chord to be
    // discovered visually.
    traceGps('render', event.deviceId, {
      stage: 'route_break',
      reason: segment.breakReason,
      previous: previousPoint ? traceCoord(previousPoint.display.latitude, previousPoint.display.longitude) : 'none',
      current: traceCoord(validation.matched.latitude, validation.matched.longitude),
      silentMs: previousPoint ? validation.recordedAt - previousPoint.timestampMs : null,
    });
  }
  return segment;
}

/**
 * The per-device rolling window of recent accepted fixes.
 *
 * Module-scoped and keyed by device so it survives a re-render but not a
 * device change. It is never averaged into a coordinate — see
 * `GpsRollingWindow` for why averaging places vehicles inside buildings.
 */
const windows = new Map<number, GpsRollingWindow>();

function windowFor(deviceId: number): GpsRollingWindow {
  let window = windows.get(deviceId);
  if (!window) {
    window = new GpsRollingWindow();
    windows.set(deviceId, window);
  }
  return window;
}

export function resetLiveWindow(deviceId?: number): void {
  if (deviceId == null) windows.clear();
  else windows.delete(deviceId);
}

function applyLiveEvent(
  previousState: LivePositionsState,
  event: LivePositionEvent,
  now = Date.now()
): LivePositionsState {
  const previousPoint = previousState.previousAcceptedPoint;

  // A state-only refresh carries the coordinate and GPS time the client already
  // has; the backend sent it purely to move a status pill. It updates liveness
  // and nothing else. Scoring it against the GPS validator - which is all a
  // client could do before the backend flagged these - rejected it as a
  // duplicate timestamp and reported a GPS fault every time a vehicle stopped.
  if (!event.positionUpdate) {
    traceGps('store', event.deviceId, {
      stage: 'state_refresh',
      state: event.state,
      connectionState: event.connectionState,
      gpsTime: event.lastGpsTime ?? event.deviceTime,
    });
    return {
      ...previousState,
      connected: true,
      lastReceivedAt: now,
      latest: event,
    };
  }

  // Reported for every inbound frame, accepted or not: whether road matching is
  // working is a property of the SERVICE, not of whether this particular fix
  // passed validation.
  const matchStatus = event.matchStatus ?? previousState.matchStatus;

  const window = windowFor(event.deviceId);
  const validation = validateLivePositionEvent(event, previousPoint, now, window);

  if (!validation.accepted) {
    traceGps('rejected', event.deviceId, {
      ...buildTraceRecord({
        raw: rawPointOf(event),
        previous: previousPoint,
        decision: { accepted: false, reason: validation.code, severity: validation.severity },
      }),
      serverTime: event.serverTime,
    });
    // The vehicle stays exactly where it was. A rejected fix is a reason to
    // distrust the update, never a reason to stop drawing the vehicle.
    //
    // Only a `warning` reaches `rejectedReason`, which is what the screen shows
    // the operator. A duplicate or out-of-order frame is normal - the server
    // replays every vehicle's current position on connect, so one arrives on
    // every token rotation and every stream recycle - and surfacing those as GPS
    // faults trained operators to ignore the ones that matter.
    return {
      ...previousState,
      connected: true,
      quality: previousState.displayPosition ? previousState.quality : validation.quality,
      rejectedReason:
        validation.severity === 'warning' ? validation.reason : previousState.rejectedReason,
      matchStatus,
    };
  }

  const newTrip = startsNewTrip(previousPoint, event.ignition, validation.recordedAt);
  if (newTrip) window.clear();
  const expectedIntervalMs = window.typicalIntervalMs();
  window.push(validation.raw, validation.recordedAt, validation.speedKmh);

  const parsedTripStart = event.tripStartedAt ? Date.parse(event.tripStartedAt) : Number.NaN;
  const backendTripStartedAt = Number.isFinite(parsedTripStart) ? parsedTripStart : null;
  const nextAcceptedPoint: PreviousAcceptedLivePoint = {
    timestampMs: validation.recordedAt,
    recordedAt: validation.recordedAt,
    // A held fix keeps the previous RAW anchor. Promoting the drifted reading
    // would let a parked vehicle walk one drift radius per fix.
    raw: validation.held && previousPoint ? previousPoint.raw : validation.raw,
    display: validation.matched,
    bearing: validation.course,
    course: validation.course,
    speedKmh: validation.speedKmh,
    ignition: event.ignition,
  };

  if (validation.held) {
    traceGps('rejected', event.deviceId, {
      ...buildTraceRecord({
        raw: rawPointOf(event),
        previous: previousPoint,
        decision: { accepted: true, point: validation.validatedPoint },
        matched: validation.matchedPoint,
        rendered: previousState.displayPosition ?? validation.matched,
      }),
      reason: 'stationary_drift',
    });
    return {
      ...previousState,
      connected: true,
      lastEventAt: validation.recordedAt,
      lastReceivedAt: now,
      latest: event,
      previousAcceptedPoint: nextAcceptedPoint,
      points: newTrip ? [] : previousState.points,
      trail: newTrip ? [] : previousState.trail,
      tripStartedAt:
        backendTripStartedAt ??
        (newTrip ? validation.recordedAt : previousState.tripStartedAt),
      rawPosition: validation.raw,
      validatedPosition: validation.validated,
      displayPosition: previousState.displayPosition ?? validation.matched,
      displayDiscontinuous: false,
      displayHeading: validation.course,
      speedKmh: 0,
      tripDistanceKm: event.tripDistanceKm,
      quality: validation.quality,
      // A parked vehicle whose fix wandered is the pipeline working, not a
      // fault. It is in the trace and it is visible as a STOPPED status pill;
      // raising it as an operator-facing GPS warning made parking look broken.
      rejectedReason: null,
      matchStatus,
    };
  }

  const point: PlaybackTrackPoint = {
    t: new Date(validation.recordedAt).toISOString(),
    lat: validation.matched.latitude,
    lng: validation.matched.longitude,
    rawLat: validation.raw.latitude,
    rawLng: validation.raw.longitude,
    matched: validation.isMatched,
    mapMatched: validation.isMatched,
    accuracyMeters: event.accuracyMeters,
    speed: validation.speedKmh,
    speedKmh: validation.speedKmh,
    // The server's running trip total at this fix. Carried onto the point so the
    // playback engine reads distance rather than measuring coordinate deltas.
    distanceKm: event.tripDistanceKm,
    course: validation.course,
    ignition: event.ignition,
    gpsValid: event.gpsValid,
    gapBefore: validation.gapBefore,
  };

  const points = newTrip ? [point] : [...previousState.points, point];
  // Every accepted movement point extends the travelled route, in the order the
  // fixes were recorded. Held and rejected points extend nothing.
  // The cadence is read BEFORE this fix joins the window, so a device coming
  // back from a silence is judged on how often it normally reports rather than
  // on the silence itself.
  const segment = travelledSegmentFor(
    event,
    validation,
    previousPoint,
    newTrip,
    expectedIntervalMs
  );

  traceGps('matched', event.deviceId, {
    ...buildTraceRecord({
      raw: rawPointOf(event),
      previous: previousPoint,
      decision: { accepted: true, point: validation.validatedPoint },
      matched: validation.matchedPoint,
      rendered: validation.matched,
    }),
    matchSource: validation.matchedPoint.source,
    confidence: event.matchConfidence,
    roadBearing: event.roadBearing,
    routeSource: segment.source,
    routeMode: segment.mode,
    routeVertices: segment.vertices.length,
    serverTime: event.serverTime,
    // How far behind the GPS clock this fix reached the renderer. The single
    // number that answers "why is the vehicle updating late?".
    renderLagMs: now - validation.recordedAt,
  });

  return {
    ...previousState,
    connected: true,
    lastEventAt: validation.recordedAt,
    lastReceivedAt: now,
    latest: event,
    previousAcceptedPoint: nextAcceptedPoint,
    points: points.length > MAX_LIVE_POINTS ? points.slice(points.length - MAX_LIVE_POINTS) : points,
    trail: appendTrail(previousState.trail, segment.vertices, segment.mode),
    // The server owns when a trip resets, because it is the thing that resets
    // the distance total. A locally detected start is only used when it sends none.
    tripStartedAt: backendTripStartedAt ?? (newTrip ? validation.recordedAt : previousState.tripStartedAt),
    rawPosition: validation.raw,
    validatedPosition: validation.validated,
    matchedPosition: validation.isMatched ? validation.matched : previousState.matchedPosition,
    // The display position follows the matched one. The easing toward it happens
    // in the animation hook below, which is deliberately separate from this
    // reducer so rendering never waits on the network.
    displayPosition: validation.matched,
    // A broken run means the ground between the two coordinates was never
    // observed. Sliding the marker across it draws the vehicle through whatever
    // is there; it is placed at the new position instead.
    displayDiscontinuous: segment.mode !== 'extend' && previousState.displayPosition != null,
    displayHeading: validation.course,
    speedKmh: validation.speedKmh,
    tripDistanceKm: event.tripDistanceKm,
    quality: validation.quality,
    rejectedReason: null,
    matchStatus,
  };
}

// ------------------------------------------------------------- hooks

/**
 * Live state for one device.
 *
 * @param deviceId the device to follow. Changing it resets the buffer; it never
 *                 opens a second stream, because the stream is shared.
 */
export function useLivePositions(deviceId?: number, enabled = true): LivePositionsState {
  const dispatch = useAppDispatch();
  const tenantEpoch = useAppSelector((s) => s.tenant.epoch);
  const [state, setState] = useState<LivePositionsState>(EMPTY_LIVE_STATE);
  const stateRef = useRef<LivePositionsState>(EMPTY_LIVE_STATE);

  useEffect(() => {
    const cached = deviceId == null
      ? EMPTY_LIVE_STATE
      : liveStateCache.get(liveCacheKey(tenantEpoch, deviceId)) ?? EMPTY_LIVE_STATE;
    stateRef.current = cached;
    setState(cached);
    // The anchor and the rolling window belong to the previous device. Carrying
    // either into a new one measures a jump between two vehicles.
    if (deviceId != null) resetLiveWindow(deviceId);
    return () => {
      if (deviceId != null) resetLiveWindow(deviceId);
    };
  }, [deviceId, tenantEpoch]);

  const onPosition = useCallback(
    (event: LivePositionEvent) => {
      if (deviceId == null || event.deviceId !== deviceId) return;
      const previous = stateRef.current;
      const next = applyLiveEvent(previous, event);
      stateRef.current = next;
      liveStateCache.set(liveCacheKey(tenantEpoch, deviceId), next);
      setState(next);
      // Rejected packets never reach shared vehicle state. In particular an old
      // SSE replay cannot overwrite a newer REST/SSE position elsewhere.
      //
      // A state-only refresh IS forwarded: the reducer knows to take only the
      // status and connection clock from it. Dropping it here left the shared
      // fleet state showing RUNNING for a vehicle this screen had already moved
      // to STOPPED, whenever this was the only screen mounted.
      if (!event.positionUpdate || next.previousAcceptedPoint !== previous.previousAcceptedPoint) {
        dispatch(livePositionReceived(event));
      }
    },
    [dispatch, deviceId, tenantEpoch]
  );

  const stream = useLivePositionStream(onPosition, enabled && deviceId != null);

  return useMemo(
    () => ({ ...state, stream, connected: stream.connected }),
    [state, stream]
  );
}

/**
 * Eases the drawn position and heading toward the latest matched fix.
 *
 * Rendering is kept entirely separate from the network: this runs off an
 * animation frame over values that are already in memory, so a slow or failed
 * routing call can stall the next update without ever stalling the animation.
 * Heading uses shortest-angle interpolation, so a vehicle crossing north turns
 * through 350 -> 10 rather than spinning the long way round.
 *
 * <h3>One animation at a time, always forward</h3>
 * A newer fix cancels the animation in progress and re-eases from wherever the
 * marker currently is. Two overlapping eases - or a completion callback from a
 * cancelled one - are what let an old async frame write a position the vehicle
 * had already left, which reads as the marker jumping backwards.
 *
 * @param discontinuous the last accepted fix broke the route. The marker is
 *                      placed rather than eased, because there is no observed
 *                      ground between the two coordinates to travel over.
 */
export function useSmoothedLivePosition(
  target: LiveCoordinate | null,
  targetHeading: number,
  /** How long the marker takes to cover the distance to a new fix. */
  durationMs = 900,
  discontinuous = false
): { position: LiveCoordinate | null; heading: number } {
  const [rendered, setRendered] = useState<{ position: LiveCoordinate | null; heading: number }>({
    position: target,
    heading: normalizeHeading(targetHeading),
  });
  const fromRef = useRef<{ position: LiveCoordinate | null; heading: number }>(rendered);
  const frameRef = useRef<number | null>(null);
  /**
   * Monotonic id of the animation that owns the marker.
   *
   * A frame scheduled by a superseded animation checks this before writing, so
   * a callback that was already in flight when a newer fix arrived cannot move
   * the marker back to the older target.
   */
  const generationRef = useRef(0);

  useEffect(() => {
    if (!target) return;
    const generation = (generationRef.current += 1);
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const from = fromRef.current;
    // First fix, or a break in the route: appear at the right place rather than
    // flying in from nowhere or driving through the buildings in between.
    if (!from.position || discontinuous) {
      const placed = { position: target, heading: normalizeHeading(targetHeading) };
      fromRef.current = placed;
      setRendered(placed);
      return;
    }

    const start = Date.now();
    const startPosition = from.position;
    const startHeading = from.heading;
    const endHeading = normalizeHeading(targetHeading);

    const tick = () => {
      if (generationRef.current !== generation) return;
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / Math.max(1, durationMs));
      // GPS fixes normally arrive at 1 Hz. A start/stop easing curve on every
      // fix makes the car visibly accelerate and brake once per second; linear
      // interpolation preserves constant road motion between measurements.
      const eased = t;
      const next = {
        position: {
          latitude: startPosition.latitude + (target.latitude - startPosition.latitude) * eased,
          longitude: startPosition.longitude + (target.longitude - startPosition.longitude) * eased,
        },
        heading: lerpAngle(startHeading, endHeading, eased),
      };
      fromRef.current = next;
      setRendered(next);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      // Invalidate before cancelling: a frame already dispatched by the browser
      // will still run its callback, and the generation check is what stops it.
      generationRef.current += 1;
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [discontinuous, durationMs, target, targetHeading]);

  return rendered;
}

/** Straight-line metres between two drawn coordinates. Exported for tests. */
export function displayGapMeters(a: LatLng, b: LatLng): number {
  return distanceBetween(a, b);
}
