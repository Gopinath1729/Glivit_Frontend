import type { PlaybackTrackPoint } from '@/src/types/api';

import { bearingDeg, haversineKm, lerpAngle, normalizeHeading } from '@/src/services/geoMath';
import { GPS_LIMITS } from '@/src/services/gpsPipeline';

/**
 * Truthful playback motion engine.
 *
 * The live-track screen animates recorded GPS history. Instead of looping a
 * normalized 0..1 progress value at a fabricated speed, this engine drives the
 * marker off the points' real recorded timestamps (`t`), speed and course:
 *
 *   - position is interpolated between the two points that bracket the current
 *     playback time, proportional to the real time gap between them;
 *   - displayed speed comes from the recorded `speed` field, never synthesized;
 *   - heading comes from coordinate-derived travel bearing (shortest-angle
 *     interpolated), with recorded course used only when movement is too small.
 *
 * `elapsedMs` is a position on the recorded timeline (ms since the first fix),
 * exactly like a video scrubber — advancing it faster only fast-forwards through
 * real data, it does not invent motion.
 */

export type PlaybackTrack = {
  points: PlaybackTrackPoint[];
  /** ms offset of each point from the first fix (monotonic, non-decreasing). */
  timeOffsetsMs: number[];
  /** cumulative distance (km) travelled up to each point. */
  cumulativeKm: number[];
  totalDurationMs: number;
  totalDistanceKm: number;
  /** Travel bearing for each segment, derived from its GPS coordinates. */
  segmentHeadings: number[];
  /** Number of raw fixes discarded because they were invalid or implausible. */
  rejectedPointCount: number;
  /**
   * Inclusive index ranges of contiguous observed route, split wherever the
   * tracker lost coverage. Drawing one polyline per run is what keeps a gap
   * from being rendered as a straight line down roads nobody recorded.
   */
  runs: PlaybackRun[];
};

/** An inclusive index range into {@link PlaybackTrack.points}. */
export type PlaybackRun = {
  start: number;
  end: number;
};

export type PlaybackCoordinate = {
  latitude: number;
  longitude: number;
};

export type PlaybackSample = {
  latitude: number;
  longitude: number;
  /** km/h, recorded (interpolated between bracketing fixes). */
  speed: number;
  /** degrees, GPS-derived travel bearing (shortest-angle interpolated). */
  heading: number;
  /** km travelled from the start of the track to this sample. */
  distanceKm: number;
  ignition: boolean;
  gpsValid: boolean;
  /** Segment containing this sample; avoids rebuilding an O(n) route prefix per frame. */
  segmentIndex: number;
  /** Stable recorded vertices completed before the interpolated tail. */
  completedPointCount: number;
  atEnd: boolean;
};
export type PlaybackBuildOptions = {
  /** The points were already cleaned/map-matched and only need playback metadata rebuilt. */
  pointsAreClean?: boolean;
  rejectedPointCount?: number;
};
export { bearingDeg, haversineKm, lerpAngle, normalizeHeading };

// Every threshold below is read from the one pipeline definition, so History,
// playback, the live stream and the phone's own collector cannot drift apart on
// what counts as a stop, a spike or an impossible jump. They used to hold three
// different speed ceilings and two different drift radii between them.
/**
 * Minimum displacement before a SEGMENT's bearing is believed.
 *
 * Deliberately smaller than the live pipeline's heading gate: a playback track
 * is densified onto road vertices that can be a metre apart, and refusing a
 * bearing between two adjacent road vertices would leave the marker facing the
 * last fix's direction all the way round a curve.
 */
const MIN_BEARING_DISTANCE_KM = 0.001;
const NEAR_IDENTICAL_DISTANCE_KM = 0.002;
const STOPPED_DRIFT_RADIUS_KM = GPS_LIMITS.stationaryDriftMeters / 1000;
const ISOLATED_JUMP_DISTANCE_KM = GPS_LIMITS.spikeAwayMeters / 1000;
const ISOLATED_JUMP_RETURN_KM = GPS_LIMITS.spikeReturnMeters / 1000;
const ISOLATED_JUMP_WINDOW_MS = GPS_LIMITS.spikeWindowMs;
const STATIONARY_SPEED_KPH = GPS_LIMITS.stationarySpeedKph;
const MAX_REASONABLE_GPS_SPEED_KPH = GPS_LIMITS.maxSpeedKph;
const MAX_ACCURACY_METERS = GPS_LIMITS.maxAccuracyMeters;
/**
 * Coverage-gap rule, matching the server's.
 *
 * <h3>Why the floor moved</h3>
 * The threshold used to be `max(5 minutes, median interval * 4)`, and the five
 * minutes always won: a tracker reporting every second has a median*4 of four
 * seconds, so the effective rule was "only a five-minute silence breaks the
 * line". Every shorter dropout - a tunnel, a backgrounded app, a reconnect, a
 * lift in a car park - was therefore drawn as one straight chord between the
 * fixes either side of it.
 *
 * It is now the device's own reporting cadence, floored at
 * {@link GPS_LIMITS.segmentGapMs} so a jittery link does not shred the line.
 * There is deliberately no ceiling: a tracker that reports once every fifteen
 * minutes by design has a threshold of an hour, and capping it would flag every
 * one of its fixes as a coverage gap - which erases its route entirely.
 *
 * A break still additionally requires real displacement: a tracker that goes
 * quiet while parked has not travelled anywhere unobserved. And it is
 * deliberately NOT joined by a raw distance rule, because whether a 1.5 km step
 * is a gap or one ordinary reporting interval depends entirely on how often this
 * device reports - a two-minute-cadence tracker covers that at road speed as a
 * matter of course.
 */
const COVERAGE_GAP_MIN_MS = GPS_LIMITS.segmentGapMs;
const COVERAGE_GAP_INTERVAL_FACTOR = 4;
const COVERAGE_GAP_DISTANCE_KM = 0.3;

export function isValidGpsPoint(point: PlaybackTrackPoint | null | undefined): boolean {
  // A null or undefined entry is not a fix that failed validation - it is a
  // malformed response. Dereferencing it here threw during render, which exits
  // the app rather than showing an empty day, so it is refused first.
  if (typeof point !== 'object' || point === null) return false;
  return (
    point.gpsValid !== false &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180 &&
    !(point.lat === 0 && point.lng === 0) &&
    (point.accuracyMeters == null ||
      (Number.isFinite(point.accuracyMeters) &&
        point.accuracyMeters >= 0 &&
        point.accuracyMeters <= MAX_ACCURACY_METERS))
  );
}

function parseTimeMs(t: string, fallback: number): number {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? fallback : ms;
}

/**
 * One record with its numeric fields made safe to render.
 *
 * A NaN never crashes on its own - it propagates. `Math.round(NaN)` is NaN,
 * `NaN.toFixed(1)` is the string "NaN", and both end up on screen in the speed
 * and distance readouts. Worse, a NaN coordinate reaches the native map as a
 * marker position, and a marker at a non-numeric coordinate is a native-side
 * failure rather than a JavaScript one.
 */
function normalizedPoint(point: PlaybackTrackPoint): PlaybackTrackPoint {
  return {
    ...point,
    speed: Number.isFinite(point.speed) ? Math.max(point.speed, 0) : 0,
    speedKmh: Number.isFinite(point.speedKmh) ? Math.max(point.speedKmh as number, 0) : undefined,
    course: Number.isFinite(point.course) ? normalizeHeading(point.course) : 0,
    distanceKm: Number.isFinite(point.distanceKm)
      ? Math.max(point.distanceKm as number, 0)
      : undefined,
  };
}

function correctHeadings(points: readonly PlaybackTrackPoint[]): PlaybackTrackPoint[] {
  const corrected: PlaybackTrackPoint[] = [];
  points.forEach((point, index) => {
    const lat = point.lat;
    const lng = point.lng;
    // A fix on the far side of a coverage gap says nothing about which way the
    // vehicle was pointing here, so it may not set this point's bearing.
    const next = points[index + 1]?.gapBefore ? undefined : points[index + 1];
    const previous = point.gapBefore ? undefined : points[index - 1];
    const nextDistance = next ? haversineKm(lat, lng, next.lat, next.lng) : 0;
    const previousDistance = previous ? haversineKm(previous.lat, previous.lng, lat, lng) : 0;
    const previousBearing = corrected[index - 1]?.course;
    const isStopped =
      point.speed < STATIONARY_SPEED_KPH &&
      previousDistance < STOPPED_DRIFT_RADIUS_KM &&
      nextDistance < STOPPED_DRIFT_RADIUS_KM;

    const derived =
      isStopped && Number.isFinite(previousBearing)
        ? normalizeHeading(previousBearing)
        : next && nextDistance >= MIN_BEARING_DISTANCE_KM
          ? bearingDeg(lat, lng, next.lat, next.lng)
          : previous && previousDistance >= MIN_BEARING_DISTANCE_KM
            ? bearingDeg(previous.lat, previous.lng, lat, lng)
            : Number.isFinite(point.course) && point.course !== 0
              ? normalizeHeading(point.course)
              : normalizeHeading(previousBearing, 0);

    corrected.push({ ...point, lat, lng, course: derived });
  });
  return corrected;
}

/**
 * Marks every point that opens a new run of observed route.
 *
 * The server already flags these for recorded history; this fills them in for
 * points that arrived without the flag (the demo route, the live buffer) using
 * the same rule, so one code path handles both. A break needs a long silence
 * AND a real displacement: a tracker that goes quiet while parked has not moved.
 */
function resolveCoverageGaps(points: PlaybackTrackPoint[]): PlaybackTrackPoint[] {
  if (points.length < 2) return points;
  const intervals: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    intervals.push(Date.parse(points[i].t) - Date.parse(points[i - 1].t));
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  const threshold = Math.max(COVERAGE_GAP_MIN_MS, median * COVERAGE_GAP_INTERVAL_FACTOR);

  return points.map((point, index) => {
    if (index === 0) return point.gapBefore ? { ...point, gapBefore: false } : point;
    if (point.gapBefore) return point;
    const previous = points[index - 1];
    const silent = intervals[index - 1] > threshold;
    const moved =
      haversineKm(previous.lat, previous.lng, point.lat, point.lng) > COVERAGE_GAP_DISTANCE_KM;
    return silent && moved ? { ...point, gapBefore: true } : point;
  });
}

/** Contiguous index ranges between coverage gaps. */
function buildRuns(points: readonly PlaybackTrackPoint[]): PlaybackRun[] {
  if (points.length === 0) return [];
  const runs: PlaybackRun[] = [];
  let start = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].gapBefore) {
      runs.push({ start, end: i - 1 });
      start = i;
    }
  }
  runs.push({ start, end: points.length - 1 });
  return runs;
}

function preparePoints(rawPoints: PlaybackTrackPoint[]): {
  points: PlaybackTrackPoint[];
  rejectedPointCount: number;
} {
  const ordered = rawPoints
    // Structural validation before anything reads `.t`, so a null entry in the
    // response is rejected rather than throwing mid-render.
    .filter(isValidGpsPoint)
    .map((point, sourceIndex) => ({
      point,
      sourceIndex,
      time: Date.parse(point.t),
    }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time || a.sourceIndex - b.sourceIndex);
  const plausible: PlaybackTrackPoint[] = [];
  const acceptedTimes: number[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const previous = plausible[plausible.length - 1];
    const previousTime = acceptedTimes[acceptedTimes.length - 1];
    if (previous) {
      const distanceKm = haversineKm(previous.lat, previous.lng, item.point.lat, item.point.lng);
      const deltaMs = item.time - previousTime;
      if (deltaMs <= 0) continue;
      const calculatedKph = distanceKm / (deltaMs / 3_600_000);
      const deviceSpeed = Number.isFinite(item.point.speed) ? Math.max(item.point.speed, 0) : 0;
      // A FIXED ceiling. Raising it in proportion to the device's own reported
      // speed - which is what `max(220, speed * 1.5 + 30)` did - means a device
      // reporting 120 km/h admits a 210 km/h chord, and the faster the vehicle
      // claims to be going the further a spike is allowed to throw it.
      if (!Number.isFinite(calculatedKph) || calculatedKph > MAX_REASONABLE_GPS_SPEED_KPH) continue;

      // A single low-speed point that jumps away and immediately returns is a
      // classic GPS multipath spike. Reject it before it can form a triangle.
      const next = ordered[index + 1];
      if (
        next &&
        deviceSpeed < 5 &&
        distanceKm >= ISOLATED_JUMP_DISTANCE_KM &&
        next.time > item.time &&
        next.time - previousTime <= ISOLATED_JUMP_WINDOW_MS &&
        haversineKm(previous.lat, previous.lng, next.point.lat, next.point.lng) <=
          ISOLATED_JUMP_RETURN_KM
      ) {
        continue;
      }
    }
    plausible.push(normalizedPoint(item.point));
    acceptedTimes.push(item.time);
  }

  // Collapse a stopped cluster to its first and final timestamp at one stable
  // coordinate. Playback therefore waits at the stop instead of drawing every
  // accuracy wobble, while retaining the real stop duration.
  //
  // Both ends are kept deliberately. Collapsing to the final timestamp alone
  // leaves one long segment running from the last moving fix straight to the
  // end of the stop, and everything interpolated across it is then wrong for
  // the whole stop: the speed readout eases down from road speed over half an
  // hour, and the heading blend rotates a parked vehicle on the spot.
  const compressed: PlaybackTrackPoint[] = [];
  let stationaryEnd: PlaybackTrackPoint | null = null;
  let restMarked = false;
  for (const point of plausible) {
    const anchor = compressed[compressed.length - 1];
    if (!anchor) {
      compressed.push(point);
      continue;
    }
    if (point.gapBefore) {
      // A gap ends the stationary cluster; the fixes either side of it belong
      // to different runs and must not be collapsed onto one coordinate.
      if (stationaryEnd && Date.parse(stationaryEnd.t) > Date.parse(anchor.t)) {
        compressed.push(stationaryEnd);
      }
      stationaryEnd = null;
      restMarked = false;
      compressed.push(point);
      continue;
    }
    const distanceKm = haversineKm(anchor.lat, anchor.lng, point.lat, point.lng);
    // Only the incoming fix has to be idle. Requiring the anchor to be idle too
    // meant the first fix after the vehicle came to rest was always admitted as
    // a new vertex — and since that fix is itself a random drift sample, the
    // route stepped off the road at every stop and the marker span round to face
    // the step. The vehicle now parks at the last coordinate it was trusted at.
    const stationary =
      distanceKm <= NEAR_IDENTICAL_DISTANCE_KM ||
      (point.speed < STATIONARY_SPEED_KPH && distanceKm <= STOPPED_DRIFT_RADIUS_KM);
    if (stationary) {
      const atRest = {
        ...point,
        lat: anchor.lat,
        lng: anchor.lng,
        speed: 0,
        course: anchor.course,
      };
      // The first genuinely idle fix is kept as the moment the vehicle came to
      // rest, so speed drops to zero on arrival rather than over the stop.
      if (!restMarked && point.speed < STATIONARY_SPEED_KPH) {
        compressed.push(atRest);
        restMarked = true;
        stationaryEnd = null;
      } else {
        stationaryEnd = atRest;
      }
      continue;
    }
    if (stationaryEnd && Date.parse(stationaryEnd.t) > Date.parse(anchor.t)) {
      compressed.push(stationaryEnd);
    }
    stationaryEnd = null;
    restMarked = false;
    compressed.push(point);
  }
  const last = compressed[compressed.length - 1];
  if (stationaryEnd && last && Date.parse(stationaryEnd.t) > Date.parse(last.t)) {
    compressed.push(stationaryEnd);
  }

  // Network map matching happens before the pointsAreClean playback rebuild.
  // This pure correction step never dispatches network requests during render.
  const corrected = correctHeadings(resolveCoverageGaps(compressed));

  return {
    points: corrected,
    rejectedPointCount: rawPoints.length - corrected.length,
  };
}

/** Defensive ordering/deduplication for points the backend already validated. */
function prepareCleanPoints(
  rawPoints: PlaybackTrackPoint[],
  upstreamRejected: number
): { points: PlaybackTrackPoint[]; rejectedPointCount: number } {
  const ordered = rawPoints
    // `isValidGpsPoint` runs FIRST, and it is what makes reading `.t` safe on
    // the next line: a null entry would otherwise throw before any validation
    // happened at all.
    .filter(isValidGpsPoint)
    .map((point, sourceIndex) => ({ point, sourceIndex, time: Date.parse(point.t) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time || a.sourceIndex - b.sourceIndex);
  const strict: PlaybackTrackPoint[] = [];
  let lastTime = Number.NEGATIVE_INFINITY;
  for (const item of ordered) {
    if (item.time <= lastTime) continue;
    strict.push(normalizedPoint(item.point));
    lastTime = item.time;
  }
  return {
    points: correctHeadings(resolveCoverageGaps(strict)),
    rejectedPointCount: upstreamRejected + (rawPoints.length - strict.length),
  };
}

/**
 * Precomputes per-point time offsets and cumulative distance from raw recorded
 * points. Out-of-order or duplicate timestamps were rejected before this stage,
 * so the clock remains strictly increasing without fabricating time.
 */
export function buildPlaybackTrack(
  points: PlaybackTrackPoint[],
  options: PlaybackBuildOptions = {}
): PlaybackTrack {
  const prepared = options.pointsAreClean
    ? prepareCleanPoints(points, options.rejectedPointCount ?? 0)
    : preparePoints(points);
  const cleanPoints = prepared.points;
  const n = cleanPoints.length;
  const timeOffsetsMs = new Array<number>(n).fill(0);
  const cumulativeKm = new Array<number>(n).fill(0);
  const segmentHeadings = new Array<number>(Math.max(0, n - 1)).fill(0);

  if (n === 0) {
    return {
      points: cleanPoints,
      timeOffsetsMs,
      cumulativeKm,
      segmentHeadings,
      rejectedPointCount: prepared.rejectedPointCount,
      runs: [],
      totalDurationMs: 0,
      totalDistanceKm: 0,
    };
  }

  const startMs = parseTimeMs(cleanPoints[0].t, 0);
  let stableBearing = normalizeHeading(cleanPoints[0].course, 0);
  // The backend measures distance; this only carries its numbers.
  //
  // Every point that has been through the server pipeline arrives with the
  // confirmed travel up to it, so cumulative distance is read rather than
  // computed. Summing coordinate deltas here would reintroduce the exact bug
  // this pipeline exists to remove -- a parked phone's jitter accumulating into
  // kilometres -- and, now that the route follows road geometry, would also
  // measure every curve the vehicle drove rather than the distance it covered.
  //
  // The Haversine fallback below is only for tracks with no backend distance at
  // all (the offline demo route), and is clamped to be non-decreasing either way.
  const backendDistanceBase = Number.isFinite(cleanPoints[0].distanceKm)
    ? (cleanPoints[0].distanceKm as number)
    : null;
  for (let i = 1; i < n; i += 1) {
    const rawOffset = parseTimeMs(cleanPoints[i].t, startMs + i) - startMs;
    timeOffsetsMs[i] = rawOffset;
    const reported = cleanPoints[i].distanceKm;
    const stepKm = haversineKm(
      cleanPoints[i - 1].lat,
      cleanPoints[i - 1].lng,
      cleanPoints[i].lat,
      cleanPoints[i].lng
    );
    // The fallback sum applies the same stationary rule the rest of the
    // pipeline does. Without it a track with no backend distance accumulates a
    // parked vehicle's jitter one wobble at a time - which is the original
    // "3 km for a vehicle that never moved", reappearing on whichever path
    // happens to lack a server-measured total.
    const driftOnly =
      cleanPoints[i].speed < STATIONARY_SPEED_KPH && stepKm <= STOPPED_DRIFT_RADIUS_KM;
    cumulativeKm[i] = Number.isFinite(reported)
      ? Math.max(cumulativeKm[i - 1], (reported as number) - (backendDistanceBase ?? 0))
      : cumulativeKm[i - 1] + (driftOnly ? 0 : stepKm);
    const segmentDistance = stepKm;
    // The chord across a coverage gap is not a direction of travel, so it may
    // not turn the vehicle; the last observed bearing is held across it.
    if (!cleanPoints[i].gapBefore && segmentDistance >= MIN_BEARING_DISTANCE_KM) {
      stableBearing = bearingDeg(
        cleanPoints[i - 1].lat,
        cleanPoints[i - 1].lng,
        cleanPoints[i].lat,
        cleanPoints[i].lng
      );
    }
    segmentHeadings[i - 1] = stableBearing;
  }

  return {
    points: cleanPoints,
    timeOffsetsMs,
    cumulativeKm,
    segmentHeadings,
    rejectedPointCount: prepared.rejectedPointCount,
    runs: buildRuns(cleanPoints),
    totalDurationMs: timeOffsetsMs[n - 1],
    totalDistanceKm: cumulativeKm[n - 1],
  };
}

function toCoordinate(point: PlaybackTrackPoint): PlaybackCoordinate {
  return { latitude: point.lat, longitude: point.lng };
}

/**
 * The complete recorded route, as one polyline per observed run.
 *
 * Returning runs rather than a single coordinate list is the whole point: a
 * flat list forces the map to close every coverage gap with a straight line
 * across roads the vehicle was never recorded on.
 */
export function routeSegments(track: PlaybackTrack): PlaybackCoordinate[][] {
  return track.runs
    .map((run) => track.points.slice(run.start, run.end + 1).map(toCoordinate))
    .filter((segment) => segment.length >= 2);
}

/** Exactly the route already travelled, split at coverage gaps like {@link routeSegments}. */
export function travelledRouteSegments(
  track: PlaybackTrack,
  sample: PlaybackSample | null
): PlaybackCoordinate[][] {
  if (!sample || track.points.length === 0) return [];
  const completed = sample.completedPointCount;
  const segments: PlaybackCoordinate[][] = [];
  for (const run of track.runs) {
    if (run.start >= completed) break;
    const end = Math.min(run.end, completed - 1);
    const segment = track.points.slice(run.start, end + 1).map(toCoordinate);
    // The interpolated marker position extends the run it is currently inside.
    if (end === completed - 1 && sample.segmentIndex >= run.start && sample.segmentIndex <= run.end) {
      const current = { latitude: sample.latitude, longitude: sample.longitude };
      const last = segment[segment.length - 1];
      if (
        !last ||
        haversineKm(last.latitude, last.longitude, current.latitude, current.longitude) >= 0.0005
      ) {
        segment.push(current);
      }
    }
    if (segment.length >= 2) segments.push(segment);
  }
  return segments;
}

/** Elapsed offset (ms) of an absolute recorded timestamp on this track. */
export function elapsedMsForTime(track: PlaybackTrack, iso: string | null | undefined): number {
  if (!iso || track.points.length === 0) return 0;
  const target = Date.parse(iso);
  const start = Date.parse(track.points[0].t);
  if (!Number.isFinite(target) || !Number.isFinite(start)) return 0;
  return Math.min(Math.max(target - start, 0), track.totalDurationMs);
}

/** Distance over which the marker eases through a change of direction. */
const TURN_BLEND_KM = 0.025;
/** Never spend more than this share of a segment turning. */
const MAX_TURN_BLEND_FRACTION = 0.35;

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Displayed heading inside one segment.
 *
 * Each vertex is eased symmetrically: the tail of the incoming segment turns
 * halfway toward the outgoing bearing and the head of the outgoing segment
 * completes the turn, so the two sides meet at the same value and the marker
 * never snaps through a corner. The ease is measured in metres travelled, not
 * in a share of the segment, so a turn looks the same whether it sits between
 * two fixes 30 m apart or 3 km apart.
 *
 * A segment with no displacement is a parked vehicle: its heading is held
 * outright, because rotating on the spot toward a direction it has not started
 * travelling in is exactly the artifact this avoids.
 */
function headingAt(
  segmentKm: number,
  frac: number,
  previousBearing: number,
  currentBearing: number,
  nextBearing: number
): number {
  if (segmentKm < MIN_BEARING_DISTANCE_KM) {
    return normalizeHeading(currentBearing);
  }
  const blend = Math.min(MAX_TURN_BLEND_FRACTION, TURN_BLEND_KM / segmentKm);
  if (blend <= 0) {
    return normalizeHeading(currentBearing);
  }
  if (frac < blend) {
    const entry = lerpAngle(previousBearing, currentBearing, 0.5);
    return lerpAngle(entry, currentBearing, smoothstep(frac / blend));
  }
  if (frac > 1 - blend) {
    const exit = lerpAngle(currentBearing, nextBearing, 0.5);
    return lerpAngle(currentBearing, exit, smoothstep((frac - (1 - blend)) / blend));
  }
  return normalizeHeading(currentBearing);
}

/** Largest index whose time offset is <= elapsed (binary search). */
function findSegmentIndex(timeOffsetsMs: number[], elapsedMs: number): number {
  let lo = 0;
  let hi = timeOffsetsMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeOffsetsMs[mid] <= elapsedMs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Samples the vehicle state at a position on the recorded timeline. */
export function sampleAt(track: PlaybackTrack, elapsedMs: number): PlaybackSample | null {
  const { points, timeOffsetsMs, cumulativeKm, segmentHeadings, totalDurationMs } = track;
  const n = points.length;
  if (n === 0) {
    return null;
  }

  if (n === 1) {
    const p = points[0];
    return {
      latitude: p.lat,
      longitude: p.lng,
      speed: Math.max(p.speed, 0),
      heading: normalizeHeading(p.course),
      distanceKm: 0,
      ignition: Boolean(p.ignition),
      gpsValid: p.gpsValid,
      segmentIndex: 0,
      completedPointCount: 1,
      atEnd: true,
    };
  }

  const clamped = Math.min(Math.max(elapsedMs, 0), totalDurationMs);
  const i = Math.min(findSegmentIndex(timeOffsetsMs, clamped), n - 2);
  const t0 = timeOffsetsMs[i];
  const t1 = timeOffsetsMs[i + 1];
  const rawFrac = t1 > t0 ? (clamped - t0) / (t1 - t0) : 0;
  const a = points[i];
  const b = points[i + 1];

  // Nothing was recorded across a coverage gap, so the vehicle waits at the
  // last observed fix rather than gliding down a road nobody saw it take.
  const frac = b.gapBefore ? 0 : rawFrac;

  const latitude = a.lat + (b.lat - a.lat) * frac;
  const longitudeDelta = ((((b.lng - a.lng) % 360) + 540) % 360) - 180;
  const longitude = ((((a.lng + longitudeDelta * frac) + 180) % 360) + 360) % 360 - 180;
  const speed = Math.max(a.speed + (b.speed - a.speed) * frac, 0);
  const currentBearing = segmentHeadings[i] ?? normalizeHeading(a.course);
  const previousBearing = segmentHeadings[i - 1] ?? currentBearing;
  const nextBearing = points[i + 2]?.gapBefore
    ? currentBearing
    : segmentHeadings[i + 1] ?? currentBearing;
  const segmentKm = cumulativeKm[i + 1] - cumulativeKm[i];
  const heading = headingAt(
    segmentKm,
    frac,
    previousBearing,
    currentBearing,
    nextBearing
  );
  const distanceKm = cumulativeKm[i] + (cumulativeKm[i + 1] - cumulativeKm[i]) * frac;

  const nearest = frac < 0.5 ? a : b;
  const atEnd = clamped >= totalDurationMs;
  return {
    latitude,
    longitude,
    speed,
    heading,
    distanceKm,
    ignition: Boolean(nearest.ignition),
    gpsValid: nearest.gpsValid,
    segmentIndex: i,
    completedPointCount: atEnd ? n : i + 1,
    atEnd,
  };
}

