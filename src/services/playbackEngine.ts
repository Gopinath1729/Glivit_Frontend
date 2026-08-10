import type { PlaybackTrackPoint } from '@/src/types/api';
import { snapCoordinateToRoadSync } from '@/src/services/roadSnapping';

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

import { bearingDeg, haversineKm, lerpAngle, normalizeHeading } from '@/src/services/geoMath';
export { bearingDeg, haversineKm, lerpAngle, normalizeHeading };

const MIN_BEARING_DISTANCE_KM = 0.001;
const STOPPED_JITTER_DISTANCE_KM = 0.008;
const MAX_REASONABLE_GPS_SPEED_KPH = 260;

export function isValidGpsPoint(point: PlaybackTrackPoint): boolean {
  return (
    point.gpsValid !== false &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180 &&
    !(point.lat === 0 && point.lng === 0)
  );
}

function parseTimeMs(t: string, fallback: number): number {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? fallback : ms;
}

function preparePoints(rawPoints: PlaybackTrackPoint[]): {
  points: PlaybackTrackPoint[];
  rejectedPointCount: number;
} {
  const ordered = rawPoints
    .map((point, sourceIndex) => ({
      point,
      sourceIndex,
      time: Date.parse(point.t),
    }))
    .filter(({ point, time }) => isValidGpsPoint(point) && Number.isFinite(time))
    .sort((a, b) => a.time - b.time || a.sourceIndex - b.sourceIndex);
  const accepted: PlaybackTrackPoint[] = [];
  const acceptedTimes: number[] = [];

  for (const item of ordered) {
    const previous = accepted[accepted.length - 1];
    const previousTime = acceptedTimes[acceptedTimes.length - 1];
    if (previous) {
      const distanceKm = haversineKm(previous.lat, previous.lng, item.point.lat, item.point.lng);
      const deltaMs = Math.max(item.time - previousTime, 1);
      const calculatedKph = distanceKm / (deltaMs / 3_600_000);
      const sameFix = deltaMs <= 1 && distanceKm < 0.001;
      const deviceSpeed = Number.isFinite(item.point.speed) ? Math.max(item.point.speed, 0) : 0;
      const speedLimit = Math.min(
        360,
        Math.max(MAX_REASONABLE_GPS_SPEED_KPH, deviceSpeed * 2.2 + 40)
      );
      if (sameFix || calculatedKph > speedLimit) continue;
    }
    accepted.push({
      ...item.point,
      speed: Number.isFinite(item.point.speed) ? Math.max(item.point.speed, 0) : 0,
    });
    acceptedTimes.push(item.time);
  }

  const corrected: PlaybackTrackPoint[] = [];
  accepted.forEach((point, index) => {
    // Snap raw point to valid road coordinate
    const snap = snapCoordinateToRoadSync(point.lat, point.lng, point.course);
    const lastValid = corrected[corrected.length - 1];
    const lat = snap.snapped ? snap.latitude : point.lat;
    const lng = snap.snapped ? snap.longitude : point.lng;

    // Bearing is derived from where the vehicle actually WENT, in priority order:
    //
    //   1. barely moved  -> hold the last known bearing (never spin on GPS jitter)
    //   2. next fix      -> bearing from here to the next coordinate (travel forward)
    //   3. previous fix  -> bearing from the previous coordinate to here (last point)
    //   4. recorded course from the device
    //   5. last known bearing
    //
    // The snapped ROAD bearing is deliberately absent. A road's orientation says
    // nothing about which way a vehicle is driving along it, so preferring it (as
    // this once did) rendered any vehicle travelling "against" the stored road
    // direction facing backwards.
    const next = accepted[index + 1];
    const previous = accepted[index - 1];
    const nextDistance = next ? haversineKm(lat, lng, next.lat, next.lng) : 0;
    const previousDistance = previous ? haversineKm(previous.lat, previous.lng, lat, lng) : 0;
    const previousBearing = corrected[index - 1]?.course;
    const isStopped =
      point.speed < 2 &&
      previousDistance < STOPPED_JITTER_DISTANCE_KM &&
      nextDistance < STOPPED_JITTER_DISTANCE_KM;

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

    corrected.push({
      ...point,
      lat,
      lng,
      course: derived,
    });
  });

  return {
    points: corrected,
    rejectedPointCount: rawPoints.length - corrected.length,
  };
}

/**
 * Precomputes per-point time offsets and cumulative distance from raw recorded
 * points. Out-of-order or duplicate timestamps are clamped to a strictly
 * increasing clock (+1ms) so the playback loop can never stall or run backwards.
 */
export function buildPlaybackTrack(points: PlaybackTrackPoint[]): PlaybackTrack {
  const prepared = preparePoints(points);
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
      totalDurationMs: 0,
      totalDistanceKm: 0,
    };
  }

  const startMs = parseTimeMs(cleanPoints[0].t, 0);
  let stableBearing = normalizeHeading(cleanPoints[0].course, 0);
  for (let i = 1; i < n; i += 1) {
    const rawOffset = parseTimeMs(cleanPoints[i].t, startMs + i) - startMs;
    timeOffsetsMs[i] = Math.max(rawOffset, timeOffsetsMs[i - 1] + 1);
    cumulativeKm[i] =
      cumulativeKm[i - 1] +
      haversineKm(
        cleanPoints[i - 1].lat,
        cleanPoints[i - 1].lng,
        cleanPoints[i].lat,
        cleanPoints[i].lng
      );
    const segmentDistance = haversineKm(
      cleanPoints[i - 1].lat,
      cleanPoints[i - 1].lng,
      cleanPoints[i].lat,
      cleanPoints[i].lng
    );
    if (segmentDistance >= MIN_BEARING_DISTANCE_KM) {
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
    totalDurationMs: timeOffsetsMs[n - 1],
    totalDistanceKm: cumulativeKm[n - 1],
  };
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
  const frac = t1 > t0 ? (clamped - t0) / (t1 - t0) : 0;
  const a = points[i];
  const b = points[i + 1];

  const latitude = a.lat + (b.lat - a.lat) * frac;
  const longitudeDelta = ((((b.lng - a.lng) % 360) + 540) % 360) - 180;
  const longitude = ((((a.lng + longitudeDelta * frac) + 180) % 360) + 360) % 360 - 180;
  const speed = Math.max(a.speed + (b.speed - a.speed) * frac, 0);
  const currentBearing = segmentHeadings[i] ?? normalizeHeading(a.course);
  const nextBearing = segmentHeadings[i + 1] ?? currentBearing;
  const turnBlend = Math.max(0, Math.min(1, (frac - 0.68) / 0.32));
  const easedTurnBlend = turnBlend * turnBlend * (3 - 2 * turnBlend);
  const heading = lerpAngle(currentBearing, nextBearing, easedTurnBlend);
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

const DEMO_AVG_KMH = 44;

/**
 * DEMO / OFFLINE ONLY. Builds a plausible track from a bare coordinate list for
 * the no-device demo screen. Real, tenant-scoped devices never reach this path
 * (the live-track screen gates them out before render), so no fabricated timing
 * is ever shown for real vehicles.
 */
export function synthesizeDemoTrack(coords: PlaybackCoordinate[]): PlaybackTrack {
  const points: PlaybackTrackPoint[] = [];
  const segmentDurationsMs = coords.slice(0, -1).map((cur, index) => {
    const next = coords[index + 1];
    return (
      (haversineKm(cur.latitude, cur.longitude, next.latitude, next.longitude) / DEMO_AVG_KMH) *
      3_600_000
    );
  });
  const totalDurationMs = segmentDurationsMs.reduce((total, duration) => total + duration, 0);
  let tMs = Date.now() - totalDurationMs;

  for (let i = 0; i < coords.length; i += 1) {
    const prev = coords[i - 1];
    const cur = coords[i];
    const next = coords[i + 1] ?? cur;
    const segKm = prev ? haversineKm(prev.latitude, prev.longitude, cur.latitude, cur.longitude) : 0;
    const dtMs = prev ? segmentDurationsMs[i - 1] ?? 0 : 0;
    tMs += dtMs;
    const speed = dtMs > 0 ? segKm / (dtMs / 3_600_000) : DEMO_AVG_KMH;
    const course = bearingDeg(cur.latitude, cur.longitude, next.latitude, next.longitude);

    points.push({
      t: new Date(tMs).toISOString(),
      lat: cur.latitude,
      lng: cur.longitude,
      speed: Math.round(speed),
      course,
      gpsValid: true,
      ignition: true,
    });
  }

  return buildPlaybackTrack(points);
}
