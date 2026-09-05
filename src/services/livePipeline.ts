import { traceCoord, traceGps } from '@/src/services/gpsDiagnostics';
import { alignToRoad, normalizeHeading } from '@/src/services/geoMath';
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
  type LiveMatchedSource,
  type LiveTrailRun,
} from '@/src/services/liveRouteTrail';
import { buildRoadPolyline, type RoadPolyline } from '@/src/services/roadPolyline';
import type { MapMatchStatus, PlaybackTrackPoint } from '@/src/types/api';
import type {
  LivePositionEvent,
  LiveRoadMatchEvent,
  LiveStreamState,
} from './livePositionStream';

export type { LivePositionEvent, LiveRoadMatchEvent } from './livePositionStream';

/**
 * The live-tracking state machine, as pure functions.
 *
 * <h3>Why this is separate from the hooks</h3>
 * Everything here is a pure function of a previous state and one inbound frame,
 * with no React, no Redux and no network. That is what makes the rules below
 * testable by `node --test` without a device, an emulator or a running backend -
 * and the rules are precisely the ones that kept regressing. `livePositions`
 * holds the hooks that drive it.
 *
 * <h3>One frame per fix</h3>
 * The backend resolves a fix completely before it publishes it - validation,
 * then road matching, then the display coordinate - and sends ONE `POSITION`
 * frame carrying all of it: the raw coordinate, the matched coordinate, the
 * display coordinate to draw, and the road geometry since the previous display
 * position. `applyLiveEvent` applies the whole thing in one step, so the marker
 * is never drawn at the raw coordinate and corrected a moment later.
 *
 * <p>It used to take two frames: a `POSITION` with the raw coordinate and
 * `matchStatus=PENDING`, then a `ROAD_MATCH` with the road answer for the same
 * `positionId`. That path is still here, in `applyRoadMatchEvent`, and is
 * selected automatically when a frame carries no display coordinate - which is
 * how this app keeps working against an older backend. Against a current one it
 * never runs.
 *
 * <p>Either way a `ROAD_MATCH` never goes through the GPS validator: it carries
 * no new reading and repeats a timestamp already seen, so the duplicate rule
 * would correctly refuse it and the road geometry would be lost.
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
 *   <li><b>display</b> — matched, travelled toward ALONG THE MATCHED ROAD so the
 *       marker follows curves and corners rather than cutting them.</li>
 * </ul>
 *
 * Collapsing these is what let raw GPS noise drive the marker directly: a single
 * bad fix moved the vehicle, and the route drew a spike out to it and back.
 * Nothing here ever writes a later stage back onto an earlier one.
 *
 * <h3>What never happens here</h3>
 * The coordinate is never set to null and the vehicle is never removed. A lost
 * stream, a rejected fix, a stale reading, a poor-accuracy sample and a road
 * matcher that is down all leave the last good position exactly where it is;
 * only its labelled freshness and its match status change. In particular a
 * matching outage never causes a straight blue line to be drawn.
 */

export type LiveGpsQuality = 'no_data' | 'good' | 'low_accuracy' | 'invalid' | 'stale';

export type { LiveCoordinate } from '@/src/services/liveRouteTrail';
export type { LiveTrailRun } from '@/src/services/liveRouteTrail';

export type PreviousAcceptedLivePoint = AcceptedAnchor & {
  /** Alias kept for existing readers. */
  recordedAt: number;
  course: number;
};

/**
 * A fix that has been published but whose road answer has not arrived.
 *
 * Everything the enrichment will need is captured here at POSITION time, so
 * applying it later is a pure function of this entry and the ROAD_MATCH frame -
 * it never has to re-read "the current state", which is what allowed a late
 * answer to be applied to a newer fix.
 */
export type PendingRoadMatch = {
  positionId: number;
  validatedPoint: ValidatedGpsPoint;
  recordedAt: number;
  /** Direction of travel from validated movement, before any road alignment. */
  bearing: number;
  gapBefore: boolean;
  newTrip: boolean;
  expectedIntervalMs: number | null;
  /** Where the vehicle was last DRAWN, i.e. the start of this segment. */
  previousDisplay: LiveCoordinate | null;
  previousTimestampMs: number | null;
  /** Local clock when the POSITION frame was applied; drives the timeout. */
  requestedAt: number;
};

/**
 * The stretch of road the marker is currently travelling.
 *
 * One segment at a time, always forward. Progress is a distance along THIS
 * polyline - never a projection onto the whole recent route, which on a loop or
 * a parallel carriageway selects a vertex the vehicle passed minutes ago.
 */
export type LiveRoadSegment = {
  positionId: number | null;
  polyline: RoadPolyline;
  /** Heading to hold once the segment is fully travelled. */
  endHeading: number;
  /**
   * The marker is PLACED at the end of this segment rather than travelling it.
   *
   * Set when the ground in between was never observed (a coverage gap, a trip
   * reset, a road answer that produced no geometry). Sliding across it draws the
   * vehicle through whatever is there at a speed it never travelled.
   */
  placeImmediately: boolean;
  /** Local clock the segment started at. */
  startedAt: number;
  /** How long the marker should take to cover it. */
  durationMs: number;
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
  /** Identity of the newest accepted fix. The join key for everything. */
  lastPositionId: number | null;
  /** Accepted fixes for the current trip, on their matched coordinates. */
  points: PlaybackTrackPoint[];
  /**
   * The AUTHORITATIVE travelled route, in chronological order, as runs.
   *
   * Extended only by road geometry the backend actually returned. A fix with no
   * road answer extends it by nothing at all - it does not fall back to the
   * chord between two coordinates, because that chord is not a road and drawing
   * it in the same blue is what put the route through buildings.
   */
  trail: LiveTrailRun[];
  /**
   * The same journey as validated GPS, for an explicitly labelled overlay.
   *
   * Populated only for stretches with no road answer. A renderer must draw this
   * thin, dashed and captioned "GPS only", or not at all. Merging it into
   * `trail` re-creates the exact fault this separation removes.
   */
  diagnosticTrail: LiveTrailRun[];
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
  /** Heading to draw, 0-360. */
  displayHeading: number;
  /** The road stretch the marker is currently travelling, if any. */
  roadSegment: LiveRoadSegment | null;
  /** Fixes published but not yet enriched, oldest first. */
  pendingMatches: PendingRoadMatch[];
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
   * `PENDING` means the answer is on its way and nothing is wrong. `UNAVAILABLE`
   * and `DISABLED` are actionable by an operator; `UNMATCHED` is a property of
   * the trace. Falling back to raw coordinates for the MARKER is allowed - it is
   * the only honest thing to draw - but doing it silently is not, and falling
   * back for the ROUTE is not allowed at all.
   */
  matchStatus: MapMatchStatus | null;
  /** True while at least one published fix is still awaiting its road answer. */
  roadMatchPending: boolean;
  /**
   * Whether the drawn road route currently ends at `displayPosition`.
   *
   * False after any fix with no road answer. The next matched segment then
   * starts a NEW run instead of extending across the stretch that was never
   * placed - because the vehicle's motion was continuous there but the ROAD
   * geometry is missing, and joining the two matched ends is a chord through
   * whatever lies between them.
   */
  roadRouteOpen: boolean;
};

const MAX_LIVE_POINTS = 600;
/** Published fixes that may be awaiting a road answer at once. */
const MAX_PENDING_MATCHES = 40;

/**
 * How long a fix waits for its road answer before the marker moves without one.
 *
 * The vehicle must never freeze because a matching provider is slow or down -
 * "the vehicle stays visible" is the whole point of the degraded path. After
 * this the validated coordinate is drawn and the status says why. The ROUTE is
 * still not extended: a visible vehicle with no line is honest, a line through
 * buildings is not.
 */
const ROAD_MATCH_TIMEOUT_MS = 6_000;

/** Marker travel time bounds for one segment. */
const MIN_SEGMENT_MS = 350;
const MAX_SEGMENT_MS = 2_500;
const DEFAULT_SEGMENT_MS = 900;

/**
 * Session route cache, keyed by tenant epoch and device.
 *
 * Navigating from the fleet map into a vehicle, switching tabs, or an SSE
 * reconnect must not erase the line already travelled. An earlier version kept
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
  lastPositionId: null,
  points: [],
  trail: [],
  diagnosticTrail: [],
  tripStartedAt: null,
  latest: null,
  previousAcceptedPoint: null,
  rawPosition: null,
  validatedPosition: null,
  matchedPosition: null,
  displayPosition: null,
  displayHeading: 0,
  roadSegment: null,
  pendingMatches: [],
  speedKmh: 0,
  tripDistanceKm: 0,
  quality: 'no_data',
  rejectedReason: null,
  matchStatus: null,
  roadMatchPending: false,
  roadRouteOpen: false,
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
 *
 * <p>On the two-stage pipeline a POSITION frame normally carries no match at
 * all, so `matched` here equals `validated`. The road answer arrives separately
 * and is applied by {@link applyRoadMatchEvent}. The match fields are still read
 * when present so an older backend - which puts them on the POSITION frame -
 * keeps working unchanged.
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
    matched.source === 'HELD' && previous
      ? previous.bearing
      : matched.onRoad && !validated.held
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

/** How long the marker should take to travel one segment. */
function segmentDurationMs(
  expectedIntervalMs: number | null,
  elapsedSincePreviousMs: number | null
): number {
  const candidate = expectedIntervalMs ?? elapsedSincePreviousMs ?? DEFAULT_SEGMENT_MS;
  return Math.min(MAX_SEGMENT_MS, Math.max(MIN_SEGMENT_MS, candidate));
}

/**
 * A segment that places the marker at one coordinate without travelling to it.
 *
 * Used whenever there is no observed ground between the previous drawn position
 * and this one.
 */
function placedSegment(
  positionId: number | null,
  coordinate: LiveCoordinate,
  heading: number,
  now: number
): LiveRoadSegment {
  return {
    positionId,
    polyline: buildRoadPolyline([coordinate]),
    endHeading: normalizeHeading(heading),
    placeImmediately: true,
    startedAt: now,
    durationMs: MIN_SEGMENT_MS,
  };
}

/**
 * Stage one: a newly validated fix.
 *
 * Advances everything that is a property of the GPS reading - anchor, speed,
 * trip distance, quality, freshness - and records a PENDING entry so the road
 * answer for this exact fix can be applied when it lands. Deliberately does NOT
 * touch the route: there is no road answer yet, and appending anything now
 * could only be the chord between two fixes.
 */
export function applyLiveEvent(
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
  // passed validation. A PENDING on the frame never downgrades a status the
  // enrichment already resolved for an earlier fix.
  const matchStatus =
    event.matchStatus && event.matchStatus !== 'PENDING'
      ? event.matchStatus
      : (previousState.matchStatus ?? event.matchStatus);

  const window = windowFor(event.deviceId);
  const validation = validateLivePositionEvent(event, previousPoint, now, window);

  if (!validation.accepted) {
    traceGps('rejected', event.deviceId, {
      ...buildTraceRecord({
        raw: rawPointOf(event),
        previous: previousPoint,
        decision: { accepted: false, reason: validation.code, severity: validation.severity },
        deviceId: event.deviceId,
        outcome: 'SKIPPED',
      }),
      positionId: event.positionId,
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
    // The anchor's DRAWN position is where the vehicle is currently drawn, not
    // where this fix was reported: the marker has not moved yet, and the road
    // answer decides where it moves to.
    display: previousState.displayPosition ?? validation.matched,
    bearing: validation.course,
    course: validation.course,
    speedKmh: validation.speedKmh,
    ignition: event.ignition,
  };

  // ONE frame, one authoritative position.
  //
  // A current backend resolves the coordinate to draw before it publishes:
  // validation, then road matching, then the display decision. There is no
  // second frame to wait for and nothing to correct afterwards, so the whole
  // fix - marker, heading and route - is applied here in one step.
  const authoritative = authoritativeDisplayOf(event);
  if (authoritative) {
    return applyResolvedFrame(previousState, event, validation, authoritative, {
      newTrip,
      expectedIntervalMs,
      previousPoint,
      backendTripStartedAt,
      matchStatus,
      now,
    });
  }

  if (validation.held) {
    traceGps('rejected', event.deviceId, {
      ...buildTraceRecord({
        raw: rawPointOf(event),
        previous: previousPoint,
        decision: { accepted: true, point: validation.validatedPoint },
        matched: validation.matchedPoint,
        rendered: previousState.displayPosition ?? validation.matched,
        deviceId: event.deviceId,
        // A held fix is real evidence the device is alive, so it advances the
        // anchor's clock - but it moves nothing and joins nothing, so it is
        // neither appended to the live line nor stored as a route point.
        outcome: 'SKIPPED',
      }),
      positionId: event.positionId,
      reason: 'stationary_drift',
    });
    return {
      ...previousState,
      connected: true,
      lastEventAt: validation.recordedAt,
      lastReceivedAt: now,
      lastPositionId: event.positionId ?? previousState.lastPositionId,
      latest: event,
      previousAcceptedPoint: nextAcceptedPoint,
      points: newTrip ? [] : previousState.points,
      trail: newTrip ? [] : previousState.trail,
      diagnosticTrail: newTrip ? [] : previousState.diagnosticTrail,
      tripStartedAt:
        backendTripStartedAt ?? (newTrip ? validation.recordedAt : previousState.tripStartedAt),
      rawPosition: validation.raw,
      validatedPosition: validation.validated,
      displayPosition: previousState.displayPosition ?? validation.matched,
      displayHeading: validation.course,
      roadSegment:
        previousState.roadSegment ??
        placedSegment(event.positionId, validation.matched, validation.course, now),
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
    positionId: event.positionId,
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

  // The pending entry. Everything the road answer will need is frozen here, so
  // applying it later cannot depend on what the state has become in between.
  const pending: PendingRoadMatch | null =
    event.positionId == null
      ? null
      : {
          positionId: event.positionId,
          validatedPoint: validation.validatedPoint,
          recordedAt: validation.recordedAt,
          bearing: validation.course,
          gapBefore: validation.gapBefore,
          newTrip,
          expectedIntervalMs,
          previousDisplay: newTrip ? null : previousState.displayPosition,
          previousTimestampMs: newTrip ? null : (previousPoint?.timestampMs ?? null),
          requestedAt: now,
        };

  const pendingMatches = pending
    ? [...(newTrip ? [] : previousState.pendingMatches), pending].slice(-MAX_PENDING_MATCHES)
    : previousState.pendingMatches;

  traceGps('store', event.deviceId, {
    stage: 'position_received',
    positionId: event.positionId,
    raw: traceCoord(validation.raw.latitude, validation.raw.longitude),
    validated: traceCoord(validation.validated.latitude, validation.validated.longitude),
    gpsTime: validation.recordedAt,
    matchStatus: event.matchStatus,
    // How far behind the GPS clock this fix reached the client. The single
    // number that answers "why is the vehicle updating late?".
    sseLatencyMs: now - validation.recordedAt,
  });

  // The marker does NOT move here when a road answer is expected. It moves when
  // the ROAD_MATCH for this positionId lands, so the marker and the route are
  // always derived from the same matched coordinate. The only exception is the
  // bootstrap below: with nothing ever drawn there is no vehicle on the map at
  // all, and a visible vehicle at its validated coordinate beats an empty map.
  const bootstrapping = previousState.displayPosition == null;
  const legacyMatchOnPositionFrame = validation.isMatched;
  const movesNow = bootstrapping || legacyMatchOnPositionFrame || pending == null;

  return {
    ...previousState,
    connected: true,
    lastEventAt: validation.recordedAt,
    lastReceivedAt: now,
    lastPositionId: event.positionId ?? previousState.lastPositionId,
    latest: event,
    previousAcceptedPoint: nextAcceptedPoint,
    points: points.length > MAX_LIVE_POINTS ? points.slice(points.length - MAX_LIVE_POINTS) : points,
    // A new trip discards the previous journey's geometry. Otherwise the route
    // is untouched until the road answer arrives.
    trail: newTrip ? [] : previousState.trail,
    diagnosticTrail: newTrip ? [] : previousState.diagnosticTrail,
    // The server owns when a trip resets, because it is the thing that resets
    // the distance total. A locally detected start is only used when it sends none.
    tripStartedAt:
      backendTripStartedAt ?? (newTrip ? validation.recordedAt : previousState.tripStartedAt),
    rawPosition: validation.raw,
    validatedPosition: validation.validated,
    matchedPosition: validation.isMatched ? validation.matched : previousState.matchedPosition,
    displayPosition: movesNow ? validation.matched : previousState.displayPosition,
    displayHeading: movesNow ? validation.course : previousState.displayHeading,
    roadSegment: movesNow
      ? placedSegment(event.positionId, validation.matched, validation.course, now)
      : previousState.roadSegment,
    pendingMatches,
    speedKmh: validation.speedKmh,
    tripDistanceKm: event.tripDistanceKm,
    quality: validation.quality,
    rejectedReason: null,
    matchStatus,
    roadMatchPending: pendingMatches.length > 0,
    roadRouteOpen: newTrip ? false : previousState.roadRouteOpen,
  };
}

/**
 * The backend's authoritative display coordinate for this fix, if it sent one.
 *
 * Returns null for a backend that predates the field, which is what selects the
 * older two-frame path below.
 */
function authoritativeDisplayOf(
  event: LivePositionEvent
): { coordinate: LiveCoordinate; bearing: number | null } | null {
  const latitude = event.displayLatitude;
  const longitude = event.displayLongitude;
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }
  const bearing = event.displayBearing;
  return {
    coordinate: { latitude, longitude },
    bearing: bearing != null && Number.isFinite(bearing) ? bearing : null,
  };
}

/**
 * Applies one fully resolved fix: marker, heading and route, in a single step.
 *
 * <h3>Why the backend's coordinate wins</h3>
 * There is exactly one place that decides where a vehicle is drawn, and it is
 * the backend - because it is the only place that has the road network, the
 * device's whole recent trace and the previous display position at once. This
 * function does not re-derive that decision; it renders it, and uses the local
 * validator only for what is genuinely local: the quality label, the movement
 * anchor, and whether this frame may be applied at all.
 *
 * <h3>What is still local</h3>
 * A frame the local validator REJECTS never reaches here. The server replays
 * every vehicle's current position on connect, so a reconnect repeats a
 * timestamp already seen; applying it would redraw the vehicle at a position it
 * has already left. That check lives in `applyLiveEvent`, upstream of this.
 */
function applyResolvedFrame(
  previousState: LivePositionsState,
  event: LivePositionEvent,
  validation: Extract<ValidatedFix, { accepted: true }>,
  authoritative: { coordinate: LiveCoordinate; bearing: number | null },
  context: {
    newTrip: boolean;
    expectedIntervalMs: number | null;
    previousPoint: PreviousAcceptedLivePoint | null;
    backendTripStartedAt: number | null;
    matchStatus: MapMatchStatus | null;
    now: number;
  }
): LivePositionsState {
  const { newTrip, expectedIntervalMs, previousPoint, backendTripStartedAt, matchStatus, now } =
    context;
  const display = authoritative.coordinate;
  const heading = normalizeHeading(authoritative.bearing ?? validation.course);
  const matchedSource: LiveMatchedSource = event.matchedSource ?? 'NONE';

  const previousDisplay = newTrip ? null : previousState.displayPosition;
  const previousTimestampMs = newTrip ? null : (previousPoint?.timestampMs ?? null);

  const segment = travelledSegment({
    matchedGeometry: event.matchedGeometry,
    matchedSource,
    previousDisplay,
    previousTimestampMs,
    currentDisplay: display,
    currentTimestampMs: validation.recordedAt,
    gapBefore: validation.gapBefore,
    newTrip,
    expectedIntervalMs,
    roadRouteOpen: previousState.roadRouteOpen,
  });

  const baseTrail = newTrip ? [] : previousState.trail;
  const trail =
    segment.vertices.length > 0
      ? appendTrail(baseTrail, segment.vertices, segment.mode, {
          positionId: event.positionId,
          timestampMs: validation.recordedAt,
        })
      : baseTrail;
  const baseDiagnosticTrail = newTrip ? [] : previousState.diagnosticTrail;
  const diagnosticTrail =
    segment.diagnosticVertices.length > 0
      ? appendTrail(baseDiagnosticTrail, segment.diagnosticVertices, segment.diagnosticMode, {
          positionId: event.positionId,
          timestampMs: validation.recordedAt,
        })
      : baseDiagnosticTrail;

  // The polyline the marker travels: the previous drawn position, the road
  // between, and this fix's display position. Because the route was extended
  // with exactly these vertices, clipping this polyline at the travelled
  // distance leaves the line ending precisely at the marker.
  const travelVertices: LiveCoordinate[] =
    segment.vertices.length >= 2
      ? [
          ...(segment.mode === 'extend' && previousDisplay ? [previousDisplay] : []),
          ...segment.vertices,
        ]
      : [display];
  const polyline = buildRoadPolyline(travelVertices);
  const placeImmediately = segment.mode !== 'extend' || polyline.vertices.length < 2;
  const elapsedSincePreviousMs =
    previousTimestampMs != null ? validation.recordedAt - previousTimestampMs : null;

  const point: PlaybackTrackPoint = {
    t: new Date(validation.recordedAt).toISOString(),
    positionId: event.positionId,
    lat: display.latitude,
    lng: display.longitude,
    rawLat: event.rawLatitude,
    rawLng: event.rawLongitude,
    matched: matchedSource !== 'NONE',
    mapMatched: matchedSource !== 'NONE',
    accuracyMeters: event.accuracyMeters,
    speed: validation.speedKmh,
    speedKmh: validation.speedKmh,
    distanceKm: event.tripDistanceKm,
    course: heading,
    ignition: event.ignition,
    gpsValid: event.gpsValid,
    gapBefore: validation.gapBefore,
  };
  const points = newTrip ? [point] : [...previousState.points, point];

  const nextAcceptedPoint: PreviousAcceptedLivePoint = {
    timestampMs: validation.recordedAt,
    recordedAt: validation.recordedAt,
    // A held fix keeps the previous RAW anchor. Promoting the drifted reading
    // would let a parked vehicle walk one drift radius per fix.
    raw: validation.held && previousPoint ? previousPoint.raw : validation.raw,
    // The marker HAS moved by the time this returns, so the anchor's drawn
    // position is this fix's display coordinate - not the previous one, which
    // is what the two-frame pipeline had to record because the marker was still
    // waiting on a second frame.
    display,
    bearing: heading,
    course: heading,
    speedKmh: validation.speedKmh,
    ignition: event.ignition,
  };

  traceGps('matched', event.deviceId, {
    stage: 'resolved_position_applied',
    positionId: event.positionId,
    raw: traceCoord(event.rawLatitude, event.rawLongitude),
    validated: traceCoord(validation.validated.latitude, validation.validated.longitude),
    matched: traceCoord(event.matchedLatitude, event.matchedLongitude),
    previousDisplay: previousDisplay
      ? traceCoord(previousDisplay.latitude, previousDisplay.longitude)
      : null,
    display: traceCoord(display.latitude, display.longitude),
    rawToDisplayMeters: distanceBetween(
      { latitude: event.rawLatitude, longitude: event.rawLongitude },
      display
    ),
    previousToDisplayMeters: previousDisplay ? distanceBetween(previousDisplay, display) : 0,
    matchedSource,
    matchStatus: event.matchStatus,
    confidence: event.matchConfidence,
    roadBearing: event.roadBearing,
    displayBearing: heading,
    geometryVertices: event.matchedGeometry.length,
    routeSource: segment.source,
    routeMode: segment.mode,
    routeAppendedVertices: segment.vertices.length,
    breakReason: segment.breakReason,
    gpsTime: validation.recordedAt,
    renderLagMs: now - validation.recordedAt,
  });

  return {
    ...previousState,
    connected: true,
    lastEventAt: validation.recordedAt,
    lastReceivedAt: now,
    lastPositionId: event.positionId ?? previousState.lastPositionId,
    latest: event,
    previousAcceptedPoint: nextAcceptedPoint,
    points: points.length > MAX_LIVE_POINTS ? points.slice(points.length - MAX_LIVE_POINTS) : points,
    trail,
    diagnosticTrail,
    tripStartedAt:
      backendTripStartedAt ?? (newTrip ? validation.recordedAt : previousState.tripStartedAt),
    rawPosition: { latitude: event.rawLatitude, longitude: event.rawLongitude },
    validatedPosition: validation.validated,
    matchedPosition:
      event.matchedLatitude != null && event.matchedLongitude != null
        ? { latitude: event.matchedLatitude, longitude: event.matchedLongitude }
        : previousState.matchedPosition,
    displayPosition: display,
    displayHeading: heading,
    roadSegment: {
      positionId: event.positionId,
      polyline,
      endHeading: heading,
      placeImmediately,
      startedAt: now,
      durationMs: segmentDurationMs(expectedIntervalMs, elapsedSincePreviousMs),
    },
    // Nothing is outstanding: this frame WAS the answer.
    pendingMatches: [],
    speedKmh: validation.speedKmh,
    tripDistanceKm: event.tripDistanceKm,
    quality: validation.quality,
    rejectedReason: null,
    matchStatus,
    roadMatchPending: false,
    roadRouteOpen:
      segment.source === 'carried' ? previousState.roadRouteOpen : segment.source === 'matched',
  };
}

/**
 * Stage two: the road answer for one already-published fix.
 *
 * <h3>The rules, in one place</h3>
 * <ul>
 *   <li><b>SOLVED with usable geometry</b> — append that geometry to the road
 *       route and travel the marker along it.</li>
 *   <li><b>CARRIED / HELD</b> — the previous road coordinate stands. The marker
 *       may use it; NO geometry is invented, so the route does not grow.</li>
 *   <li><b>NONE / UNMATCHED / UNAVAILABLE / DISABLED / refused geometry</b> — the
 *       road route is not extended at all. The stretch goes to the GPS-only
 *       diagnostic trail and the status says why.</li>
 * </ul>
 *
 * The enrichment is looked up by `positionId`. An answer for a fix this client
 * no longer holds is dropped rather than applied to whatever is current - that
 * substitution is the stale-match bug, and it is what moved a vehicle onto the
 * road it had just left.
 */
export function applyRoadMatchEvent(
  previousState: LivePositionsState,
  event: LiveRoadMatchEvent,
  now = Date.now()
): LivePositionsState {
  const index = previousState.pendingMatches.findIndex(
    (entry) => entry.positionId === event.positionId
  );
  if (index < 0) {
    traceGps('rejected', event.deviceId, {
      stage: 'road_match_orphan',
      reason: 'no_pending_position',
      positionId: event.positionId,
      matchedSource: event.matchedSource,
    });
    return previousState;
  }
  const pending = previousState.pendingMatches[index];
  /**
   * Where this segment starts: the position the vehicle is currently DRAWN at.
   *
   * Resolved now rather than captured when the POSITION frame arrived. The two
   * frames travel on independent per-device queues, so a slow road answer for
   * fix N-1 can land after the POSITION for fix N; the value captured at
   * POSITION time would then be fix N-2's coordinate, the geometry would fail
   * its endpoint check against it, and a perfectly good matched stretch would be
   * refused. Enrichments are applied in positionId order, so at this moment the
   * drawn position IS the previous fix's matched coordinate - which is exactly
   * what this segment should start from, whichever order the frames arrived in.
   */
  const previousDisplay = pending.newTrip
    ? null
    : (previousState.displayPosition ?? pending.previousDisplay);
  // Everything older than this answer is never going to be enriched: the
  // backend publishes matches in positionId order per device, so an answer for
  // N means N-1 and earlier were skipped. Dropping them keeps the queue bounded
  // and stops a stale entry being matched much later.
  const pendingMatches = previousState.pendingMatches.slice(index + 1);

  const matchedSource: LiveMatchedSource = event.matchedSource;
  const matched = acceptMatchedCoordinate(
    pending.validatedPoint,
    {
      latitude: event.matchedLatitude,
      longitude: event.matchedLongitude,
      confidence: event.matchConfidence,
      source: matchedSource,
    },
    previousDisplay
  );

  const segment = travelledSegment({
    matchedGeometry: event.matchedGeometry,
    matchedSource,
    previousDisplay,
    previousTimestampMs: pending.previousTimestampMs,
    currentDisplay: matched.coordinate,
    currentTimestampMs: pending.recordedAt,
    gapBefore: pending.gapBefore,
    newTrip: pending.newTrip,
    expectedIntervalMs: pending.expectedIntervalMs,
    roadRouteOpen: previousState.roadRouteOpen,
  });

  // The heading: the road refines a direction already proven by movement, and
  // never replaces it. A road carries traffic both ways.
  const heading =
    matched.source === 'HELD'
      ? previousState.displayHeading
      : matched.onRoad
        ? alignToRoad(pending.bearing, event.roadBearing)
        : pending.bearing;

  const trail =
    segment.vertices.length > 0
      ? appendTrail(previousState.trail, segment.vertices, segment.mode, {
          positionId: event.positionId,
          timestampMs: pending.recordedAt,
        })
      : previousState.trail;
  const diagnosticTrail =
    segment.diagnosticVertices.length > 0
      ? appendTrail(previousState.diagnosticTrail, segment.diagnosticVertices, segment.diagnosticMode, {
          positionId: event.positionId,
          timestampMs: pending.recordedAt,
        })
      : previousState.diagnosticTrail;

  // The polyline the marker travels: the previous drawn position, the road
  // between, and the newly matched position. Because the route was extended
  // with exactly these vertices, clipping this polyline at the travelled
  // distance leaves the blue line ending precisely at the marker.
  const travelVertices: LiveCoordinate[] =
    segment.vertices.length >= 2
      ? [...(segment.mode === 'extend' && previousDisplay ? [previousDisplay] : []),
         ...segment.vertices]
      : [matched.coordinate];
  const polyline = buildRoadPolyline(travelVertices);
  const placeImmediately = segment.mode !== 'extend' || polyline.vertices.length < 2;

  const elapsedSincePreviousMs =
    pending.previousTimestampMs != null ? pending.recordedAt - pending.previousTimestampMs : null;

  const roadSegment: LiveRoadSegment = {
    positionId: event.positionId,
    polyline,
    endHeading: normalizeHeading(heading),
    placeImmediately,
    startedAt: now,
    durationMs: segmentDurationMs(pending.expectedIntervalMs, elapsedSincePreviousMs),
  };

  traceGps('matched', event.deviceId, {
    stage: 'road_match_applied',
    positionId: event.positionId,
    validated: traceCoord(
      pending.validatedPoint.coordinate.latitude,
      pending.validatedPoint.coordinate.longitude
    ),
    matched: traceCoord(event.matchedLatitude, event.matchedLongitude),
    drawn: traceCoord(matched.coordinate.latitude, matched.coordinate.longitude),
    matchedSource,
    matchStatus: event.matchStatus,
    confidence: event.matchConfidence,
    roadBearing: event.roadBearing,
    geometryVertices: event.matchedGeometry.length,
    routeSource: segment.source,
    routeMode: segment.mode,
    routeAppendedVertices: segment.vertices.length,
    diagnosticVertices: segment.diagnosticVertices.length,
    matchedGeometryRejected: segment.matchedGeometryRejected,
    breakReason: segment.breakReason,
    matchLatencyMs: now - pending.requestedAt,
    renderLagMs: now - pending.recordedAt,
  });

  return {
    ...previousState,
    trail,
    diagnosticTrail,
    matchedPosition: matched.onRoad ? matched.coordinate : previousState.matchedPosition,
    displayPosition: matched.coordinate,
    displayHeading: normalizeHeading(heading),
    roadSegment,
    pendingMatches,
    matchStatus: event.matchStatus ?? previousState.matchStatus,
    roadMatchPending: pendingMatches.length > 0,
    // The route is open when this segment left the drawn line ending AT the
    // vehicle's matched position - which is exactly what `source === 'matched'`
    // means, whether that took a dozen road vertices or one. Keying this off the
    // vertex COUNT instead treated a single-vertex step as a closed route, so
    // the very next fix started a new run: a route fragmented into a piece per
    // short step, for a vehicle that never left the road.
    //
    // A CARRIED fix covered no new ground, so it neither opens nor closes it.
    roadRouteOpen:
      segment.source === 'carried'
        ? previousState.roadRouteOpen
        : segment.source === 'matched',
  };
}

/**
 * Gives up waiting for road answers older than the timeout.
 *
 * The vehicle must stay visible and keep moving when the matching provider is
 * slow or down. The validated coordinate is drawn, the marker is PLACED rather
 * than travelled - there is no road geometry to travel along - and the route is
 * left exactly as it was. A vehicle with no line behind it is an honest report
 * of "we do not know which road"; a line through buildings is not.
 */
export function expirePendingRoadMatches(
  previousState: LivePositionsState,
  deviceId: number,
  now = Date.now()
): LivePositionsState {
  if (previousState.pendingMatches.length === 0) return previousState;
  const expired = previousState.pendingMatches.filter(
    (entry) => now - entry.requestedAt >= ROAD_MATCH_TIMEOUT_MS
  );
  if (expired.length === 0) return previousState;

  const newest = expired[expired.length - 1];
  const pendingMatches = previousState.pendingMatches.filter(
    (entry) => now - entry.requestedAt < ROAD_MATCH_TIMEOUT_MS
  );

  traceGps('render', deviceId, {
    stage: 'road_match_timeout',
    positionId: newest.positionId,
    expired: expired.length,
    waitedMs: now - newest.requestedAt,
    drawn: traceCoord(
      newest.validatedPoint.coordinate.latitude,
      newest.validatedPoint.coordinate.longitude
    ),
    // Stated explicitly so the trace answers the question an operator will ask.
    routeExtended: false,
  });

  return {
    ...previousState,
    displayPosition: newest.validatedPoint.coordinate,
    displayHeading: normalizeHeading(newest.bearing),
    roadSegment: placedSegment(
      newest.positionId,
      newest.validatedPoint.coordinate,
      newest.bearing,
      now
    ),
    pendingMatches,
    // A road answer that never came IS the matcher not answering, whatever the
    // PREVIOUS fix reported. Leaving the status on the last fix's `MATCHED` told
    // the operator road matching was working while the route had silently
    // stopped growing - the exact silent degradation this pipeline removes.
    // `DISABLED` is the one status a timeout cannot improve on: it is a
    // configuration fact, and it already explains why nothing answered.
    matchStatus: previousState.matchStatus === 'DISABLED' ? 'DISABLED' : 'UNAVAILABLE',
    roadMatchPending: pendingMatches.length > 0,
    // No road was drawn for the fix that timed out, so the next matched segment
    // must start a new run rather than reach back across the untravelled hole.
    roadRouteOpen: false,
  };
}

/** Straight-line metres between two drawn coordinates. Exported for tests. */
export function displayGapMeters(a: LatLng, b: LatLng): number {
  return distanceBetween(a, b);
}
