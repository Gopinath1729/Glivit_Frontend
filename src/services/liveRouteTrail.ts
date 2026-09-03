import {
  distanceBetween,
  coordinateOf,
  GPS_LIMITS,
  segmentConnectivity,
  type LatLng,
  type SegmentBreakReason,
} from './gpsPipeline';

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
 *   <li>Every ACCEPTED movement point extends the route, in the order the fixes
 *       were recorded.</li>
 *   <li>Road-matched geometry is used when the backend produced some, because it
 *       follows the road through curves and junctions.</li>
 *   <li>When it did not - no matching engine configured, a debounced solve, a
 *       match the confidence check refused - the segment between the previous
 *       accepted point and this one is used instead, AND ONLY IF the two are
 *       actually connectable. See below.</li>
 *   <li>Held, drifting and rejected fixes extend nothing at all.</li>
 *   <li>A trip reset or a coverage gap starts a NEW run rather than closing the
 *       gap with a chord across roads nobody observed.</li>
 * </ul>
 *
 * <h3>The rule that was missing</h3>
 * `travelledSegment` used to take no timestamps at all, so it could not tell a
 * one-second step from a ninety-second one and joined both with a straight line
 * between the two accepted coordinates. Every telemetry silence shorter than a
 * trip reset - a backgrounded app, a tunnel, an SSE reconnect, a server restart,
 * a road-matching backlog - therefore produced exactly one long diagonal chord
 * across whatever lay between the fixes either side of it. That is the diagonal
 * across the buildings, and no amount of smoothing, styling or layering could
 * remove it because the geometry itself was wrong.
 *
 * Every segment is now validated for elapsed time, step distance and implied
 * speed by {@link segmentConnectivity} before it is drawn, and a segment that
 * fails BREAKS the polyline into a new run instead of being drawn.
 */

export type LiveCoordinate = LatLng;

/** Vertices retained across all runs before the oldest are dropped. */
export const MAX_TRAIL_VERTICES = 4000;

/** Two vertices closer than this are the same point as far as a polyline cares. */
const MIN_VERTEX_SPACING_METERS = 0.5;
/** Only the recent road tail can own the current live marker. */
const LIVE_PROJECTION_TAIL_VERTICES = 64;
/** A candidate farther away than this is not on the road geometry we have. */
const MAX_LIVE_PROJECTION_METERS = 80;

export type LiveTrailProgress = {
  runs: LiveCoordinate[][];
  position: LiveCoordinate | null;
};

/** Shortest signed longitude delta, safe across the antimeridian. */
function longitudeDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Clips the newest live route run at the animated vehicle and projects the
 * vehicle onto that road tail.
 *
 * The backend appends the whole newly matched stretch as soon as a fix arrives,
 * while the marker needs roughly one second to reach that fix. Drawing the
 * uncut stretch puts the blue trail visibly ahead of the car. Projecting the
 * animation-frame coordinate onto the recent road vertices gives both layers
 * the same position: the car rides the curve and the route grows directly
 * behind it, like a navigation map.
 */
export function progressLiveTrail(
  runs: LiveCoordinate[][],
  candidate: LiveCoordinate | null
): LiveTrailProgress {
  if (!candidate || runs.length === 0) return { runs, position: candidate };
  const lastRunIndex = runs.length - 1;
  const run = runs[lastRunIndex];
  if (run.length < 2) return { runs, position: candidate };

  const startIndex = Math.max(0, run.length - LIVE_PROJECTION_TAIL_VERTICES);
  const longitudeScale = Math.max(0.01, Math.cos((candidate.latitude * Math.PI) / 180));
  let best:
    | { segmentIndex: number; position: LiveCoordinate; distanceMeters: number }
    | null = null;

  for (let index = startIndex; index < run.length - 1; index += 1) {
    const a = run[index];
    const b = run[index + 1];
    const dx = longitudeDelta(a.longitude, b.longitude) * longitudeScale;
    const dy = b.latitude - a.latitude;
    const px = longitudeDelta(a.longitude, candidate.longitude) * longitudeScale;
    const py = candidate.latitude - a.latitude;
    const lengthSquared = dx * dx + dy * dy;
    const fraction =
      lengthSquared > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
    const position = {
      latitude: a.latitude + dy * fraction,
      longitude: ((((a.longitude + longitudeDelta(a.longitude, b.longitude) * fraction) + 180) % 360) + 360) % 360 - 180,
    };
    const distanceMeters = distanceBetween(candidate, position);
    if (!best || distanceMeters < best.distanceMeters) {
      best = { segmentIndex: index, position, distanceMeters };
    }
  }

  if (!best || best.distanceMeters > MAX_LIVE_PROJECTION_METERS) {
    return { runs, position: candidate };
  }

  const clippedLast = run.slice(0, best.segmentIndex + 1);
  const tail = clippedLast[clippedLast.length - 1];
  if (!tail || distanceBetween(tail, best.position) >= MIN_VERTEX_SPACING_METERS) {
    clippedLast.push(best.position);
  }
  return {
    runs: [...runs.slice(0, lastRunIndex), clippedLast],
    position: best.position,
  };
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

/**
 * Appends the stretch covered since the previous accepted fix.
 *
 * Purely functional: the runs passed in are never mutated. The previous version
 * copied the outer array but pushed into the SAME inner arrays, so every state
 * object the reducer had ever produced shared - and silently rewrote - one
 * another's geometry.
 */
export function appendTrail(
  trail: LiveCoordinate[][],
  vertices: LiveCoordinate[],
  mode: TrailAppendMode = 'extend'
): LiveCoordinate[][] {
  if (mode === 'reset') return vertices.length > 0 ? [[...vertices]] : [];
  if (vertices.length === 0) return trail;

  const runs = trail.map((run) => run);
  if (mode === 'break') {
    // A gap. The run that was open ends here and a NEW one starts at the far
    // side, so both stretches are still drawn and the unobserved ground between
    // them is left blank rather than crossed.
    runs.push([...vertices]);
    return trimTrail(runs);
  }

  const last = runs.length > 0 ? [...runs[runs.length - 1]] : [];
  if (runs.length > 0) runs[runs.length - 1] = last;
  else runs.push(last);

  for (const vertex of vertices) {
    const tail = last[last.length - 1];
    if (tail && distanceBetween(tail, vertex) < MIN_VERTEX_SPACING_METERS) {
      continue;
    }
    last.push(vertex);
  }

  return trimTrail(runs);
}

/**
 * Restores the part of the current trip recorded before Live Track mounted,
 * then continues it with the in-memory SSE trail.
 *
 * A process restart used to reduce every live route to the one replayed current
 * position: the backend still held the travelled trip, but this screen never
 * asked for it. Only the first live run may attach to history, and only when its
 * first vertex is close enough to the history tail to be the same observed
 * road. Later live runs retain their gaps verbatim.
 */
export function mergeLiveTrailHistory(
  history: LiveCoordinate[][],
  live: LiveCoordinate[][]
): LiveCoordinate[][] {
  if (history.length === 0) return live.map((run) => [...run]);
  if (live.length === 0) return history.map((run) => [...run]);

  let merged = history.map((run) => [...run]);
  live.forEach((run, index) => {
    if (run.length === 0) return;
    const lastHistoryRun = merged[merged.length - 1];
    const historyTail = lastHistoryRun?.[lastHistoryRun.length - 1];
    const liveHead = run[0];
    const attaches =
      index === 0 &&
      historyTail != null &&
      distanceBetween(historyTail, liveHead) <= GPS_LIMITS.maxGeometryEndpointGapMeters;
    merged = appendTrail(merged, run, attaches ? 'extend' : 'break');
  });
  return merged;
}

function trimTrail(runs: LiveCoordinate[][]): LiveCoordinate[][] {
  let total = runs.reduce((sum, run) => sum + run.length, 0);
  while (total > MAX_TRAIL_VERTICES && runs.length > 0) {
    const head = [...runs[0]];
    const drop = Math.min(head.length, total - MAX_TRAIL_VERTICES);
    head.splice(0, drop);
    total -= drop;
    if (head.length < 2) {
      total -= head.length;
      runs.shift();
    } else {
      runs[0] = head;
    }
  }
  // Runs with a single vertex are KEPT. They are not drawable yet - callers
  // filter to `length >= 2` at render time - but discarding them here threw the
  // vertex away, so a run that grows one point at a time could never reach two
  // and the line stayed permanently empty. Only genuinely empty runs go.
  return runs.filter((run) => run.length > 0);
}

/**
 * Refuses malformed or disconnected matcher geometry before it reaches a
 * polyline.
 *
 * A run with a long hop in it, or one whose ends do not meet the points it
 * claims to join, is describing a different journey - typically because the
 * solver put the vehicle on a parallel road, or because a failed chunk
 * contributed raw GPS chords to what is presented as road geometry. Drawing it
 * is worse than drawing nothing, because it looks authoritative.
 *
 * The per-vertex hop limit is {@link GPS_LIMITS.maxGeometryStepMeters}. It used
 * to be one kilometre, which admits a diagonal right across a town centre
 * inside geometry the client is told is a road.
 */
export function safeMatchedGeometry(
  geometry: readonly (readonly [number, number])[],
  previousDisplay: LiveCoordinate | null,
  current: LiveCoordinate,
  newRun: boolean
): LiveCoordinate[] {
  const vertices = geometry
    .map(([latitude, longitude]) => usable(latitude, longitude))
    .filter((vertex): vertex is LiveCoordinate => vertex != null);
  if (vertices.length < 2) return [];

  for (let index = 1; index < vertices.length; index += 1) {
    if (
      distanceBetween(vertices[index - 1], vertices[index]) > GPS_LIMITS.maxGeometryStepMeters
    ) {
      return [];
    }
  }
  if (
    !newRun &&
    previousDisplay &&
    distanceBetween(previousDisplay, vertices[0]) > GPS_LIMITS.maxGeometryEndpointGapMeters
  ) {
    return [];
  }
  const end = vertices[vertices.length - 1];
  if (distanceBetween(end, current) > GPS_LIMITS.maxGeometryEndpointGapMeters) {
    return [];
  }
  return vertices;
}

export type TravelledSegment = {
  vertices: LiveCoordinate[];
  /**
   * Where the geometry came from, for the diagnostic trace.
   *
   * `matched` is road geometry from the backend; `accepted` is the segment
   * between two validated points, used when no usable road geometry arrived.
   */
  source: 'matched' | 'accepted';
  /** How this segment joins what is already drawn. */
  mode: TrailAppendMode;
  /** Why the polyline was broken here, when it was. */
  breakReason: SegmentBreakReason | null;
  /** True when matched geometry arrived but failed {@link safeMatchedGeometry}. */
  matchedGeometryRejected: boolean;
};

/**
 * The stretch of route to append for one accepted movement point.
 *
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
  isMatched: boolean;
  previousDisplay: LiveCoordinate | null;
  previousTimestampMs: number | null;
  currentDisplay: LiveCoordinate;
  currentTimestampMs: number;
  gapBefore?: boolean;
  newTrip?: boolean;
  /** This device's typical gap between accepted fixes. */
  expectedIntervalMs?: number | null;
}): TravelledSegment {
  const {
    matchedGeometry,
    isMatched,
    previousDisplay,
    previousTimestampMs,
    currentDisplay,
    currentTimestampMs,
    gapBefore = false,
    newTrip = false,
    expectedIntervalMs = null,
  } = params;

  // Every segment is judged BEFORE any geometry is chosen, so the same rule
  // applies whether the stretch would have been drawn from road vertices or
  // from the chord between two fixes.
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

  const mode: TrailAppendMode = newTrip
    ? 'reset'
    : connectivity.connect
      ? 'extend'
      : 'break';
  const breakReason = connectivity.connect ? null : connectivity.reason;
  // A broken run starts AT this coordinate; there is no previous point to draw
  // from, and inventing one is the whole fault this is here to prevent.
  const startsRun = mode !== 'extend';

  if (isMatched && matchedGeometry.length > 0) {
    const geometry = safeMatchedGeometry(
      matchedGeometry,
      previousDisplay,
      currentDisplay,
      startsRun
    );
    if (geometry.length >= 2) {
      return {
        vertices: geometry,
        source: 'matched',
        mode,
        breakReason,
        matchedGeometryRejected: false,
      };
    }
    // Fall through to the accepted-point segment rather than losing the stretch
    // entirely: the vehicle demonstrably travelled it, only the road geometry
    // for it was unusable.
    return {
      vertices: startsRun ? [currentDisplay] : [previousDisplay as LiveCoordinate, currentDisplay],
      source: 'accepted',
      mode,
      breakReason,
      matchedGeometryRejected: true,
    };
  }

  return {
    vertices: startsRun ? [currentDisplay] : [previousDisplay as LiveCoordinate, currentDisplay],
    source: 'accepted',
    mode,
    breakReason,
    matchedGeometryRejected: false,
  };
}
