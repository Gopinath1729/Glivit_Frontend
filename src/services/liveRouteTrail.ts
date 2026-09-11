import {
  distanceBetween,
  coordinateOf,
  GPS_LIMITS,
  matchedStepLimitFor,
  segmentConnectivity,
  type LatLng,
  type SegmentBreakReason,
} from './gpsPipeline';

/**
 * Geometry acceptance limits, shared with the rest of the pipeline.
 *
 * Overridable only so a test can state a rule in its own terms; production
 * always uses the single definition in `gpsPipeline`.
 */
export type GeometryLimits = {
  maxGeometryStepMeters: number;
  maxGeometryEndpointGapMeters: number;
  /** Longest matched-to-matched step allowed with no intermediate vertices. */
  maxMatchedSegmentStepMeters: number;
};

const DEFAULT_GEOMETRY_LIMITS: GeometryLimits = {
  maxGeometryStepMeters: GPS_LIMITS.maxGeometryStepMeters,
  maxGeometryEndpointGapMeters: GPS_LIMITS.maxGeometryEndpointGapMeters,
  maxMatchedSegmentStepMeters: GPS_LIMITS.maxMatchedSegmentStepMeters,
};

/**
 * The travelled route line, and nothing else.
 *
 * <h3>Why this is its own module</h3>
 * The route line is the piece of live tracking that kept regressing, and it kept
 * regressing because it was buried inside a React reducer that also owned the
 * stream subscription, the store dispatch and the marker animation - none of
 * which can be exercised without a device. Everything here is a pure function of
 * its arguments, so the rules below are covered by
 * `liveRouteTrail.test.mjs` and a regression fails a test rather than a drive.
 *
 * <h3>The rules</h3>
 * <ul>
 *   <li>The authoritative blue route is drawn from ROAD GEOMETRY and from
 *       nothing else. A `SOLVED` match with usable geometry extends it; every
 *       other outcome extends it by nothing at all.</li>
 *   <li>`CARRIED` (wire value `HELD`) means the matcher produced no new road.
 *       The marker may keep the carried road coordinate, but no geometry is
 *       invented for it, so the route does not grow.</li>
 *   <li>`NONE`, `UNMATCHED`, `UNAVAILABLE`, `DISABLED` and geometry that fails
 *       validation all leave the road route unextended. The stretch is offered
 *       separately as GPS-only diagnostic vertices, which the UI must render as
 *       a visibly different thin/dashed layer labelled "GPS only" - never as the
 *       road-following route.</li>
 *   <li>Held, drifting and rejected fixes extend nothing at all.</li>
 *   <li>A trip reset or a coverage gap starts a NEW run rather than closing the
 *       gap with a chord across roads nobody observed.</li>
 * </ul>
 *
 * <h3>The rule that changed, and why</h3>
 * `travelledSegment` used to fall back to `[previousDisplay, currentDisplay]`
 * whenever road geometry was absent or refused - "the vehicle demonstrably
 * travelled it, only the geometry was unusable". That reasoning is true about
 * the VEHICLE and false about the ROAD: the vehicle travelled some path between
 * those two points, and the straight line between them is not it. Drawn in the
 * same blue as matched geometry, it is indistinguishable from a road-following
 * route while being a chord through whatever lies between - the diagonal across
 * buildings, drawn by the very function that exists to prevent it. A map-
 * matching outage must produce a visible vehicle, an explicit "road matching
 * unavailable", and NO road; it must not produce a confident-looking line.
 */

export type LiveCoordinate = LatLng;

/**
 * How the backend produced the coordinate for a fix.
 *
 * `CARRIED` is the specification's name for the wire value `HELD`; both mean
 * "no new road answer, the previous road coordinate still stands" and both
 * follow the same rule here - the marker may use it, the route may not grow
 * from it.
 */
export type LiveMatchedSource =
  | 'SOLVED'
  | 'HELD_STATIONARY'
  | 'PREVIOUS_TRUSTED'
  | 'HELD'
  | 'CARRIED'
  | 'NONE';

/** A retained coordinate may move the marker neither spatially nor along a route. */
export function isHeldMatchedSource(source: LiveMatchedSource | null | undefined): boolean {
  return (
    source === 'HELD_STATIONARY' ||
    source === 'PREVIOUS_TRUSTED' ||
    source === 'HELD' ||
    source === 'CARRIED'
  );
}

/** Vertices retained across all runs before the oldest are dropped. */
export const MAX_TRAIL_VERTICES = 4000;

/** Two vertices closer than this are the same point as far as a polyline cares. */
const MIN_VERTEX_SPACING_METERS = 0.5;

/**
 * One contiguous stretch of drawn route, with the identity of the fixes behind
 * it.
 *
 * <h3>Why runs carry positionIds</h3>
 * Deciding whether a hydrated trip and the live stream are the same journey used
 * to be a distance test: if the history tail sat within ~120 m of the live head,
 * they were joined. A parallel carriageway, a service road, a flyover and the
 * street beneath it all pass that test, so reopening the screen mid-trip could
 * splice the route onto a road the vehicle was never on. Proximity is not
 * identity; a positionId is.
 */
export type LiveTrailRun = {
  vertices: LiveCoordinate[];
  /** Identity of the first fix that contributed to this run, when known. */
  firstPositionId: number | null;
  /** Identity of the last fix that contributed to this run, when known. */
  lastPositionId: number | null;
  /** GPS time of the first contributing fix, epoch ms. */
  firstTimestampMs: number | null;
  /** GPS time of the last contributing fix, epoch ms. */
  lastTimestampMs: number | null;
};

/** An empty run keyed to one fix, ready to be extended. */
function newRun(
  vertices: LiveCoordinate[],
  positionId: number | null,
  timestampMs: number | null
): LiveTrailRun {
  return {
    vertices: [...vertices],
    firstPositionId: positionId,
    lastPositionId: positionId,
    firstTimestampMs: timestampMs,
    lastTimestampMs: timestampMs,
  };
}

/** Just the coordinates, for a renderer that does not care about identity. */
export function trailCoordinates(trail: readonly LiveTrailRun[]): LiveCoordinate[][] {
  return trail.map((run) => run.vertices);
}

/** Drawable runs only: a single vertex is not a polyline. */
export function drawableRuns(trail: readonly LiveTrailRun[]): LiveCoordinate[][] {
  return trail.filter((run) => run.vertices.length >= 2).map((run) => run.vertices);
}

/**
 * How a segment joins the run before it.
 *
 * `extend` continues the current polyline; `break` starts a new one at this
 * coordinate while KEEPING everything already drawn; `reset` discards the
 * previous trip's geometry, which is what a genuine new journey means.
 */
export type TrailAppendMode = 'extend' | 'break' | 'reset';

function usable(latitude: unknown, longitude: unknown): LiveCoordinate | null {
  return coordinateOf(latitude, longitude);
}

/** Structurally valid vertices in a matcher tail. */
function countUsableVertices(
  geometry: readonly (readonly [number, number])[]
): number {
  let total = 0;
  for (const [latitude, longitude] of geometry) {
    if (usable(latitude, longitude)) total += 1;
  }
  return total;
}

/**
 * Appends the stretch covered since the previous accepted fix.
 *
 * Purely functional: the runs passed in are never mutated. An earlier version
 * copied the outer array but pushed into the SAME inner arrays, so every state
 * object the reducer had ever produced shared - and silently rewrote - one
 * another's geometry.
 */
export function appendTrail(
  trail: readonly LiveTrailRun[],
  vertices: readonly LiveCoordinate[],
  mode: TrailAppendMode = 'extend',
  identity: { positionId?: number | null; timestampMs?: number | null } = {}
): LiveTrailRun[] {
  const positionId = identity.positionId ?? null;
  const timestampMs = identity.timestampMs ?? null;

  if (mode === 'reset') {
    return vertices.length > 0 ? [newRun([...vertices], positionId, timestampMs)] : [];
  }
  if (vertices.length === 0) return trail.map((run) => run);

  const runs = trail.map((run) => run);
  if (mode === 'break') {
    // A gap. The run that was open ends here and a NEW one starts at the far
    // side, so both stretches are still drawn and the unobserved ground between
    // them is left blank rather than crossed.
    runs.push(newRun([...vertices], positionId, timestampMs));
    return trimTrail(runs);
  }

  const previous = runs.length > 0 ? runs[runs.length - 1] : null;
  const extended: LiveTrailRun = previous
    ? {
        vertices: [...previous.vertices],
        firstPositionId: previous.firstPositionId ?? positionId,
        lastPositionId: positionId ?? previous.lastPositionId,
        firstTimestampMs: previous.firstTimestampMs ?? timestampMs,
        lastTimestampMs: timestampMs ?? previous.lastTimestampMs,
      }
    : newRun([], positionId, timestampMs);
  if (previous) runs[runs.length - 1] = extended;
  else runs.push(extended);

  for (const vertex of vertices) {
    const tail = extended.vertices[extended.vertices.length - 1];
    if (tail && distanceBetween(tail, vertex) < MIN_VERTEX_SPACING_METERS) {
      continue;
    }
    extended.vertices.push(vertex);
  }

  return trimTrail(runs);
}

/**
 * The boundary between a hydrated trip and the live stream.
 *
 * @param positionId  identity of the LAST fix hydration covers
 * @param timestampMs GPS time of that fix, epoch ms
 */
export type HydrationBoundary = {
  positionId: number | null;
  timestampMs: number | null;
};

/**
 * Restores the part of the current trip recorded before Live Track mounted,
 * then continues it with the in-memory SSE trail.
 *
 * <h3>Identity, not proximity</h3>
 * The first live run attaches to history only when BOTH hold:
 * <ol>
 *   <li>its first fix's positionId is strictly greater than the boundary's -
 *       so it is genuinely the continuation of the hydrated sequence and not a
 *       point hydration already contains; and</li>
 *   <li>the step from the history tail to the live head passes the same
 *       {@link segmentConnectivity} rule every other segment does - elapsed
 *       time, step distance and implied speed - so a silence in the middle
 *       still breaks the line.</li>
 * </ol>
 * Later live runs keep their gaps verbatim. Nothing is ever joined because two
 * endpoints happen to be close.
 *
 * <p>When either side has no positionId - a legacy backend - the join is
 * refused rather than guessed. A visible break is a truthful statement about
 * missing information; a splice onto the wrong road is not.
 */
export function mergeLiveTrailHistory(
  history: readonly LiveTrailRun[],
  live: readonly LiveTrailRun[],
  boundary: HydrationBoundary | null = null
): LiveTrailRun[] {
  if (history.length === 0) return live.map((run) => ({ ...run, vertices: [...run.vertices] }));
  if (live.length === 0) return history.map((run) => ({ ...run, vertices: [...run.vertices] }));

  let merged: LiveTrailRun[] = history.map((run) => ({ ...run, vertices: [...run.vertices] }));
  live.forEach((run, index) => {
    if (run.vertices.length === 0) return;
    const attaches = index === 0 && attachesToHistory(merged, run, boundary);
    merged = appendTrail(merged, run.vertices, attaches ? 'extend' : 'break', {
      positionId: run.lastPositionId,
      timestampMs: run.lastTimestampMs,
    });
    if (!attaches) {
      // Preserve the live run's own identity on the run just created, so a
      // later merge can reason about it too.
      const last = merged[merged.length - 1];
      merged[merged.length - 1] = {
        ...last,
        firstPositionId: run.firstPositionId,
        firstTimestampMs: run.firstTimestampMs,
      };
    }
  });
  return merged;
}

function attachesToHistory(
  history: readonly LiveTrailRun[],
  liveRun: LiveTrailRun,
  boundary: HydrationBoundary | null
): boolean {
  const tail = history[history.length - 1];
  const historyTailVertex = tail?.vertices[tail.vertices.length - 1];
  const liveHead = liveRun.vertices[0];
  if (!historyTailVertex || !liveHead) return false;

  const boundaryPositionId = boundary?.positionId ?? tail?.lastPositionId ?? null;
  const boundaryTimestampMs = boundary?.timestampMs ?? tail?.lastTimestampMs ?? null;
  if (
    boundaryPositionId == null ||
    liveRun.firstPositionId == null ||
    liveRun.firstPositionId <= boundaryPositionId
  ) {
    return false;
  }
  if (boundaryTimestampMs == null || liveRun.firstTimestampMs == null) return false;

  return segmentConnectivity({
    previousTimestampMs: boundaryTimestampMs,
    currentTimestampMs: liveRun.firstTimestampMs,
    distanceMeters: distanceBetween(historyTailVertex, liveHead),
    gapBefore: false,
    expectedIntervalMs: null,
  }).connect;
}

function trimTrail(runs: LiveTrailRun[]): LiveTrailRun[] {
  let total = runs.reduce((sum, run) => sum + run.vertices.length, 0);
  while (total > MAX_TRAIL_VERTICES && runs.length > 0) {
    const head = { ...runs[0], vertices: [...runs[0].vertices] };
    const drop = Math.min(head.vertices.length, total - MAX_TRAIL_VERTICES);
    head.vertices.splice(0, drop);
    total -= drop;
    if (head.vertices.length < 2) {
      total -= head.vertices.length;
      runs.shift();
    } else {
      runs[0] = head;
    }
  }
  // Runs with a single vertex are KEPT. They are not drawable yet - callers
  // filter to `length >= 2` at render time - but discarding them here threw the
  // vertex away, so a run that grows one point at a time could never reach two
  // and the line stayed permanently empty. Only genuinely empty runs go.
  return runs.filter((run) => run.vertices.length > 0);
}

/**
 * Refuses malformed or disconnected matcher geometry before it reaches a
 * polyline.
 *
 * A run with a long hop in it, or one whose ends do not meet the points it
 * claims to join, is describing a different journey - typically because the
 * solver put the vehicle on a parallel road. Drawing it is worse than drawing
 * nothing, because it looks authoritative.
 */
export function safeMatchedGeometry(
  geometry: readonly (readonly [number, number])[],
  previousDisplay: LiveCoordinate | null,
  current: LiveCoordinate,
  newRunStart: boolean,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS
): LiveCoordinate[] {
  const vertices = geometry
    .map(([latitude, longitude]) => usable(latitude, longitude))
    .filter((vertex): vertex is LiveCoordinate => vertex != null);
  if (vertices.length < 2) return [];

  for (let index = 1; index < vertices.length; index += 1) {
    if (distanceBetween(vertices[index - 1], vertices[index]) > limits.maxGeometryStepMeters) {
      return [];
    }
  }
  if (
    !newRunStart &&
    previousDisplay &&
    distanceBetween(previousDisplay, vertices[0]) > limits.maxGeometryEndpointGapMeters
  ) {
    return [];
  }
  const end = vertices[vertices.length - 1];
  if (distanceBetween(end, current) > limits.maxGeometryEndpointGapMeters) {
    return [];
  }
  return vertices;
}

export type TravelledSegment = {
  /**
   * Road vertices to append to the AUTHORITATIVE blue route.
   *
   * Empty whenever no usable road geometry was returned. It is never the chord
   * between two fixes: see the module header for why that fallback was removed.
   */
  vertices: LiveCoordinate[];
  /**
   * The same stretch expressed as validated GPS, for the optional "GPS only"
   * diagnostic layer.
   *
   * Populated only when there is no road answer. A renderer must draw it thin,
   * dashed and labelled, in a colour that cannot be mistaken for the road
   * route - or not draw it at all. It must never be merged into `vertices`.
   */
  diagnosticVertices: LiveCoordinate[];
  /**
   * Where the geometry came from.
   *
   * `matched` is road geometry from the backend. `carried` is a fix whose road
   * coordinate was carried over, contributing no geometry. `none` is a fix with
   * no road answer, whose stretch is diagnostic-only.
   */
  source: 'matched' | 'carried' | 'none';
  /** How this segment joins the AUTHORITATIVE road route. */
  mode: TrailAppendMode;
  /**
   * How this segment joins the GPS-only diagnostic layer.
   *
   * Deliberately separate from {@link mode}. The road route breaks wherever
   * road geometry is missing; the diagnostic layer is about the vehicle's own
   * motion and breaks only where the telemetry itself broke. Sharing one mode
   * meant a run of unmatched fixes produced one single-vertex diagnostic run per
   * fix - nothing drawable - so the very outage the layer exists to show was
   * the case it could not show.
   */
  diagnosticMode: TrailAppendMode;
  /** Why the polyline was broken here, when it was. */
  breakReason: SegmentBreakReason | null;
  /** True when matched geometry arrived but failed {@link safeMatchedGeometry}. */
  matchedGeometryRejected: boolean;
};

/**
 * The stretch of route to append for one accepted movement point.
 *
 * @param matchedSource        how the backend produced this fix's coordinate
 * @param matchedGeometry      road vertices the matcher returned, `[lat, lng]`
 * @param previousDisplay      the coordinate the vehicle was last DRAWN at, or
 *                             null when this is the first point of a run
 * @param previousTimestampMs  GPS time of that previously drawn fix
 * @param currentDisplay       the coordinate this fix will be drawn at
 * @param currentTimestampMs   GPS time of this fix
 * @param gapBefore            the pipeline already flagged a coverage gap here
 * @param newTrip              this fix starts a new journey
 * @param expectedIntervalMs   how often this device actually reports, so a slow
 *                             hardware tracker's normal step is not read as a
 *                             coverage gap on every fix
 */
export function travelledSegment(params: {
  matchedGeometry: readonly (readonly [number, number])[];
  matchedSource: LiveMatchedSource | null;
  previousDisplay: LiveCoordinate | null;
  previousTimestampMs: number | null;
  currentDisplay: LiveCoordinate;
  currentTimestampMs: number;
  gapBefore?: boolean;
  newTrip?: boolean;
  expectedIntervalMs?: number | null;
  /**
   * Whether the AUTHORITATIVE route currently ends at `previousDisplay`.
   *
   * False after any fix that contributed no road geometry. GPS connectivity and
   * ROUTE continuity are different questions, and conflating them is a chord:
   * a vehicle can drive continuously - so the segment rule says `extend` -
   * across a stretch the matcher could not place, and the drawn line has a hole
   * in it there. Extending the same run over that hole joins the last matched
   * vertex straight to the next one, which is exactly the diagonal this module
   * exists to prevent, re-created one level up.
   *
   * Defaults to true, which is the ordinary case of one matched fix following
   * another.
   */
  roadRouteOpen?: boolean;
  limits?: GeometryLimits;
}): TravelledSegment {
  const {
    matchedGeometry,
    matchedSource,
    previousDisplay,
    previousTimestampMs,
    currentDisplay,
    currentTimestampMs,
    gapBefore = false,
    newTrip = false,
    expectedIntervalMs = null,
    roadRouteOpen = true,
    limits = DEFAULT_GEOMETRY_LIMITS,
  } = params;

  // Every segment is judged BEFORE any geometry is chosen, so the same rule
  // applies whether the stretch would have been drawn from road vertices or
  // reported as a GPS-only diagnostic.
  const connectivity =
    newTrip || !previousDisplay || previousTimestampMs == null
      ? ({ connect: false, reason: newTrip ? 'new_trip' : 'telemetry_gap' } as const)
      : segmentConnectivity({
          previousTimestampMs,
          currentTimestampMs,
          distanceMeters: distanceBetween(previousDisplay, currentDisplay),
          gapBefore,
          expectedIntervalMs,
        });

  // Two conditions, both required, before this segment may continue the ROAD
  // route already drawn: the vehicle's own motion has to be continuous AND the
  // route has to still be open where that motion started.
  const mode: TrailAppendMode = newTrip
    ? 'reset'
    : connectivity.connect && roadRouteOpen
      ? 'extend'
      : 'break';
  // The diagnostic layer only cares about the first of those. It is a record of
  // where the vehicle reported being, so it breaks where the TELEMETRY broke and
  // nowhere else.
  const diagnosticMode: TrailAppendMode = newTrip
    ? 'reset'
    : connectivity.connect
      ? 'extend'
      : 'break';
  const breakReason = connectivity.connect
    ? roadRouteOpen
      ? null
      : 'unmatched_stretch'
    : connectivity.reason;
  // A broken run starts AT this coordinate; there is no previous point to draw
  // from, and inventing one is the whole fault this is here to prevent.
  const startsRun = mode !== 'extend';

  const diagnostic =
    diagnosticMode !== 'extend'
      ? [currentDisplay]
      : [previousDisplay as LiveCoordinate, currentDisplay];

  // CARRIED / HELD: the matcher produced no new road. The marker keeps the
  // carried coordinate; the route grows by nothing, because inventing the road
  // between two carried points is exactly the fabrication being removed.
  if (isHeldMatchedSource(matchedSource)) {
    return {
      vertices: [],
      diagnosticVertices: [],
      source: 'carried',
      mode,
      diagnosticMode,
      breakReason,
      matchedGeometryRejected: false,
    };
  }

  if (matchedSource === 'SOLVED') {
    const geometry = safeMatchedGeometry(
      matchedGeometry,
      previousDisplay,
      currentDisplay,
      startsRun,
      limits
    );
    if (geometry.length >= 2) {
      return {
        vertices: geometry,
        diagnosticVertices: [],
        source: 'matched',
        mode,
        diagnosticMode,
        breakReason,
        matchedGeometryRejected: false,
      };
    }

    // A SHORT TAIL, not a failure.
    //
    // The matcher reports the road vertices travelled since the previous match.
    // A vehicle that advances without leaving its current road segment produces
    // a tail of one vertex or none, because there is no new vertex to report -
    // on a real drive that is roughly one fix in six. Both ends of this step are
    // still coordinates the routing engine placed on the road, so the line
    // between them lies along that segment; refusing it fragments the route of a
    // vehicle that never left the road.
    //
    // Bounded on purpose. Past `maxMatchedSegmentStepMeters` the missing
    // geometry means the road actually taken is unknown, and then this is the
    // invented chord the pipeline exists to prevent - so it breaks instead.
    const usable = countUsableVertices(matchedGeometry);
    const shortTail = usable < 2;
    const step =
      previousDisplay == null ? 0 : distanceBetween(previousDisplay, currentDisplay);
    // Scaled to this device's cadence rather than a flat 30 m. A 1 Hz phone
    // steps ~6 m at 20 km/h, but one multipath sample displaces a fix by 30 m
    // without the vehicle doing anything unusual, and the flat bound turned
    // that single noisy sample into a visible hole in a continuous road.
    // Until the device's cadence is known the caller's floor is the whole rule,
    // so a test can still state a tighter bound in its own terms.
    const stepLimit =
      expectedIntervalMs == null
        ? limits.maxMatchedSegmentStepMeters
        : Math.max(limits.maxMatchedSegmentStepMeters, matchedStepLimitFor(expectedIntervalMs));
    if (shortTail && (startsRun || step <= stepLimit)) {
      return {
        vertices: startsRun
          ? [currentDisplay]
          : [previousDisplay as LiveCoordinate, currentDisplay],
        diagnosticVertices: [],
        source: 'matched',
        mode,
        diagnosticMode,
        breakReason,
        matchedGeometryRejected: false,
      };
    }

    // Geometry arrived and was genuinely refused - a hop inside it, or ends that
    // do not meet the positions it claims to join. The vehicle travelled the
    // stretch, but this is not the road it travelled, and the straight line
    // between the two fixes is not the road either. The road route stays
    // unextended; the stretch is offered as an explicitly GPS-only diagnostic.
    return {
      vertices: [],
      diagnosticVertices: diagnostic,
      source: 'none',
      mode,
      diagnosticMode,
      breakReason,
      matchedGeometryRejected: !shortTail,
    };
  }

  // NONE, or SOLVED with no geometry at all: no road answer for this stretch.
  return {
    vertices: [],
    diagnosticVertices: diagnostic,
    source: 'none',
    mode,
    diagnosticMode,
    breakReason,
    matchedGeometryRejected: false,
  };
}
