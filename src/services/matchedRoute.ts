/**
 * Road geometry, as produced by the backend map matcher.
 *
 * This module deliberately contains **no routing calls**. Map matching is a
 * sequence problem solved against the OSM network on the server, where the whole
 * ordered trace, its timestamps and its accuracy radii are available and the
 * result can be cached once for every viewer. The app's job is to draw exactly
 * what came back.
 *
 * Two rules this file exists to enforce:
 *
 *  1. A route is never a list of raw GPS fixes joined together. When the backend
 *     could not match a stretch, that stretch is reported as unmatched and the
 *     UI says so — it is not silently presented as a road.
 *  2. A coverage gap is never closed. Each run is its own polyline, so a break
 *     in the data is drawn as a break rather than a diagonal through whatever
 *     lies between its ends.
 */

import { coordinateOf, type LatLng } from '@/src/services/gpsPipeline';
import { buildPlaybackTrack } from '@/src/services/playbackEngine';
import type {
  MapMatchStatus,
  PlaybackResponse,
  PlaybackRouteRun,
  PlaybackTrackPoint,
} from '@/src/types/api';

export type Coordinate = LatLng;

/** One drawable polyline plus how much to trust it. */
export type RouteRunGeometry = {
  coordinates: Coordinate[];
  matched: boolean;
  confidence: number;
  /** Inclusive range of `points` indices this run covers. */
  fromIndex: number;
  toIndex: number;
};

export type MatchedRoute = {
  /**
   * The AUTHORITATIVE road route: confident matched runs only.
   *
   * Never contains validated GPS. A stretch the engine could not place is not a
   * road, and putting it here made it indistinguishable from one - which is how
   * a single failed chunk in the middle of a good trace produced a confident
   * blue diagonal across a town centre.
   */
  runs: RouteRunGeometry[];
  /**
   * Stretches with NO road answer, as validated GPS, for a labelled overlay.
   *
   * Drawn - if at all - thin, dashed and captioned "GPS only". This is where the
   * old fallback went: it is still available, still visible, and no longer
   * pretending to be a road.
   */
  diagnosticRuns: RouteRunGeometry[];
  status: MapMatchStatus;
  confidence: number;
  /** True when at least one run came back from the routing engine. */
  hasMatchedGeometry: boolean;
};

export const EMPTY_MATCHED_ROUTE: MatchedRoute = {
  runs: [],
  diagnosticRuns: [],
  status: 'DISABLED',
  confidence: 0,
  hasMatchedGeometry: false,
};

/**
 * A history record structurally sound enough to be worth looking at.
 *
 * Deliberately structural only - it asks whether this is an object with a
 * usable coordinate and a readable timestamp, not whether the vehicle could
 * plausibly have been there. The judgement calls (duplicates, impossible jumps,
 * ordering) belong to the playback engine, which has the sequence in front of
 * it; this exists so that a single malformed row cannot crash the screen before
 * anything gets that far.
 */
export function isHistoryRecord(point: unknown): point is PlaybackTrackPoint {
  if (typeof point !== 'object' || point === null) return false;
  const record = point as Partial<PlaybackTrackPoint>;
  if (!validCoordinate(record.lat, record.lng)) return false;
  return typeof record.t === 'string' && Number.isFinite(Date.parse(record.t));
}

/**
 * The one coordinate gate, shared with every other stage of the pipeline.
 *
 * Deliberately delegates rather than re-implementing the range checks: this
 * file's own copy used to require `typeof lat === 'number'`, so a coordinate
 * that arrived from the API as a decimal STRING was silently discarded and the
 * route lost the vertex without anything reporting why.
 */
function validCoordinate(lat: unknown, lng: unknown): boolean {
  return coordinateOf(lat, lng) != null;
}

/** `[lat, lng]` pairs from the API into map coordinates, dropping anything unusable. */
export function toCoordinates(path: readonly [number, number][] | undefined): Coordinate[] {
  if (!Array.isArray(path)) return [];
  const coordinates: Coordinate[] = [];
  for (const pair of path) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const coordinate = coordinateOf(pair[0], pair[1]);
    if (!coordinate) continue;
    coordinates.push(coordinate);
  }
  return coordinates;
}

function toRun(run: PlaybackRouteRun): RouteRunGeometry | null {
  const coordinates = toCoordinates(run.path);
  if (coordinates.length < 2) return null;
  return {
    coordinates,
    matched: Boolean(run.matched),
    confidence: Number.isFinite(run.confidence) ? run.confidence : 0,
    fromIndex: Number.isFinite(run.fromIndex) ? run.fromIndex : 0,
    toIndex: Number.isFinite(run.toIndex) ? run.toIndex : -1,
  };
}

/**
 * The geometry to draw for a history range.
 *
 * When the backend supplied matched runs they are used verbatim. When it did not
 * — no routing service configured, or the engine could not place this trace —
 * the validated fixes are drawn instead, split at the same coverage gaps, and
 * the status reports that. Falling back is a visible, labelled degradation, not
 * a silent one.
 */
export function resolveMatchedRoute(playback: PlaybackResponse | undefined | null): MatchedRoute {
  if (!playback) return EMPTY_MATCHED_ROUTE;

  const parsed = (playback.route ?? [])
    .map(toRun)
    .filter((run): run is RouteRunGeometry => run !== null);
  const matched = parsed.filter((run) => run.matched && run.confidence >= 0.2);

  // ---------------------------------------------------------------------
  // Two lists, never one.
  //
  // The backend now emits a SEPARATE run wherever the engine could not place
  // the trace, instead of splicing those raw coordinates into the geometry
  // either side of them. This mirrors that split on the client: `runs` is the
  // road and only the road; everything else - unmatched runs from the backend,
  // and the reconstructed GPS runs used when the response carries no geometry
  // at all - goes to `diagnosticRuns`.
  //
  // The previous behaviour promoted the GPS fallback into `runs` whenever no
  // matched run existed, with the reasoning that "a cut corner is a worse
  // looking route; an absent route is a broken feature". That is true about
  // completeness and false about honesty: drawn identically to matched
  // geometry, the fallback is a chord across whatever lies between two fixes,
  // and it is indistinguishable from a road at a glance. The feature is not
  // absent now - the same geometry is still returned, still drawn if the screen
  // wants it, and explicitly labelled as GPS rather than road.
  // ---------------------------------------------------------------------
  const unmatched = parsed.filter((run) => !matched.includes(run));
  const diagnosticRuns = (
    unmatched.length > 0 || matched.length > 0
      ? unmatched
      : validatedRunsFrom(playback.points ?? [])
  ).filter((run) => run.coordinates.length >= 2);

  return {
    runs: matched,
    diagnosticRuns,
    status:
      playback.matchStatus ?? (matched.length > 0 ? 'PARTIAL' : 'UNMATCHED'),
    confidence: matched.length > 0 ? (playback.matchConfidence ?? 0) : 0,
    hasMatchedGeometry: matched.length > 0,
  };
}

/**
 * Validated GPS fixes as one polyline per observed run.
 *
 * Only reached when the backend returned no matched geometry. Splitting on
 * `gapBefore` is what keeps even this fallback from drawing a line across roads
 * that were never observed.
 */
export function validatedRunsFrom(
  points: readonly (PlaybackTrackPoint | null | undefined)[]
): RouteRunGeometry[] {
  // Run the same sequence validation used by the marker playback. Besides
  // filtering malformed/null rows, this sorts timestamps, removes impossible
  // jumps and derives coverage gaps when an older backend omitted gapBefore.
  // The displayed line and animated vehicle therefore consume the identical
  // accepted sequence instead of disagreeing about which ground was observed.
  const track = buildPlaybackTrack(pointsOnMatchedRoad(points));
  return track.runs
    .map((run) => ({
      coordinates: track.points
        .slice(run.start, run.end + 1)
        .map((point) => ({ latitude: point.lat, longitude: point.lng })),
      matched: false,
      confidence: 0,
      fromIndex: run.start,
      toIndex: run.end,
    }))
    .filter((run) => run.coordinates.length >= 2);
}

/**
 * The coordinate a fix should be drawn at.
 *
 * The matched coordinate when the backend placed it on a road, the reported one
 * otherwise. Nothing on the map reads `lat`/`lng` directly, so a matched fix can
 * never be rendered at its raw position by accident.
 */
export function displayCoordinateOf(point: PlaybackTrackPoint): Coordinate {
  return point.matched && validCoordinate(point.matchedLat, point.matchedLng)
    ? { latitude: point.matchedLat as number, longitude: point.matchedLng as number }
    : { latitude: point.lat, longitude: point.lng };
}

/**
 * Track points rewritten onto their matched coordinates.
 *
 * The playback engine interpolates the marker between fixes using their real
 * timestamps, so it has to be fed the road positions rather than the raw ones;
 * otherwise the polyline follows the road while the vehicle drives beside it.
 * The reported coordinate is preserved on `rawLat`/`rawLng` for auditing.
 */
export function pointsOnMatchedRoad(
  points: readonly (PlaybackTrackPoint | null | undefined)[]
): PlaybackTrackPoint[] {
  // A null or undefined entry in the history array used to throw here on
  // `point.matched`, during render, which takes the whole app down rather than
  // showing an empty day. The API is not supposed to produce one - but "not
  // supposed to" is not a guarantee a screen can rely on, and one malformed
  // record must not be able to close the app.
  return points.filter(isHistoryRecord).map((point) => {
    const coordinate = coordinateOf(point.lat, point.lng)!;
    const normalized = {
      ...point,
      lat: coordinate.latitude,
      lng: coordinate.longitude,
    };
    if (!point.matched || !validCoordinate(point.matchedLat, point.matchedLng)) {
      return normalized;
    }
    return {
      ...normalized,
      lat: point.matchedLat as number,
      lng: point.matchedLng as number,
      rawLat: point.rawLat ?? point.lat,
      rawLng: point.rawLng ?? point.lng,
      mapMatched: true,
    };
  });
}

/** A short, human-readable explanation for the route-quality indicator. */
export function describeMatchStatus(status: MapMatchStatus | undefined): string | null {
  switch (status) {
    case 'MATCHED':
      return null;
    case 'PARTIAL':
      return 'Part of this route could not be matched to a road and is drawn from GPS.';
    case 'UNMATCHED':
      return 'This route could not be matched to a road and is drawn from GPS.';
    case 'UNAVAILABLE':
      return 'The road matching service is not responding. Showing GPS positions until it recovers.';
    case 'DISABLED':
      return 'Road matching is not configured, so this route is drawn from GPS.';
    default:
      return null;
  }
}

// ------------------------------------------------------ road-following playback

/**
 * Distance in metres between two coordinates.
 *
 * Local to this module and deliberately small: the road densifier below runs
 * over a few thousand vertices per trip and must not reach for anything that
 * allocates per call.
 */
function metresBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Nearest vertex at or after `fromIndex`, so assignments stay monotonic. */
function nearestVertexIndex(
  coordinates: readonly Coordinate[],
  latitude: number,
  longitude: number,
  fromIndex: number
): number {
  let bestIndex = Math.min(Math.max(fromIndex, 0), coordinates.length - 1);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = bestIndex; index < coordinates.length; index += 1) {
    const vertex = coordinates[index];
    const distance = metresBetween(latitude, longitude, vertex.latitude, vertex.longitude);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * The playback track, densified onto the matched road.
 *
 * <p>The backend returns two things about a history range: the fixes (each with
 * its real GPS timestamp) and the road geometry they were matched onto. Drawing
 * only the fixes cuts every corner between them; drawing only the road loses the
 * timing that playback, stop dwell and the speed readout depend on. This merges
 * them: every fix keeps its own timestamp, and the road vertices between two
 * fixes are inserted with timestamps interpolated by distance along that stretch
 * of road.
 *
 * <p>The result is a single ordered point list where consecutive coordinates are
 * always adjacent road vertices, so the polyline follows curves, junctions and
 * turns, and the marker travels along the road rather than across the chord.
 *
 * <p>Runs are never joined. A fix on the far side of a coverage gap opens a new
 * run and keeps its `gapBefore` flag, so the pen is lifted there.
 */
export function buildRoadFollowingPoints(
  points: readonly PlaybackTrackPoint[],
  runs: readonly RouteRunGeometry[]
): PlaybackTrackPoint[] {
  if (points.length === 0) return [];
  if (!runs.some((run) => run.matched && run.coordinates.length >= 2)) {
    // No matched road geometry for this range. The points are returned exactly
    // as they arrived, carrying whatever coverage gaps the BACKEND actually
    // flagged.
    //
    // This used to set `gapBefore: index > 0` — marking every point after the
    // first as the start of a new coverage gap. Two things followed, and they
    // are the whole of "Playback opens but shows nothing":
    //
    //   * `buildRuns` then produced one run per point, and `routeSegments`
    //     drops every run shorter than two coordinates, so the recorded route
    //     polyline was never drawn at all — not a styling problem, there was
    //     no geometry to style.
    //   * `buildPlaybackTrack` refuses to take a bearing across a gap, so
    //     `segmentHeadings` stayed pinned to the first fix's course and the
    //     vehicle faced one fixed direction for the entire replay.
    //
    // And it fired on every range, because it is reached whenever road
    // matching returns nothing — which is every range on a deployment with no
    // routing service configured.
    //
    // Joining consecutive VALIDATED fixes is not the thing this guard was
    // protecting against: those points passed the server's pipeline, genuine
    // silences are already flagged by the backend and re-derived by
    // `resolveCoverageGaps`, and the route is reported as GPS-drawn rather
    // than road-matched by `matchStatus`.
    return points.map((point) => ({ ...point }));
  }

  const output: PlaybackTrackPoint[] = [];
  const covered = new Set<number>();

  for (const run of runs) {
    if (!run.matched || run.coordinates.length < 2) continue;
    const from = Math.max(0, run.fromIndex);
    const to = Math.min(points.length - 1, run.toIndex);
    if (to < from) continue;

    let searchFrom = 0;
    const vertexIndexFor: number[] = [];
    for (let index = from; index <= to; index += 1) {
      const point = points[index];
      const coordinate = displayCoordinateOf(point);
      const vertexIndex = nearestVertexIndex(
        run.coordinates,
        coordinate.latitude,
        coordinate.longitude,
        searchFrom
      );
      vertexIndexFor.push(vertexIndex);
      searchFrom = vertexIndex;
    }

    for (let index = from; index <= to; index += 1) {
      const point = points[index];
      covered.add(index);
      const vertexIndex = vertexIndexFor[index - from];
      const vertex = run.coordinates[vertexIndex];
      output.push({
        ...point,
        gapBefore: index === from ? output.length > 0 || Boolean(point.gapBefore) : point.gapBefore,
        lat: vertex.latitude,
        lng: vertex.longitude,
        mapMatched: true,
      });

      if (index === to) continue;
      const nextVertexIndex = vertexIndexFor[index + 1 - from];
      if (nextVertexIndex <= vertexIndex + 1) continue;

      // Cumulative distance along this stretch of road, so an interpolated
      // vertex is timestamped by how far along it sits rather than by how many
      // vertices happen to precede it. A dense curve and a long straight then
      // replay at the right relative speed.
      const cumulative: number[] = [0];
      for (let v = vertexIndex + 1; v <= nextVertexIndex; v += 1) {
        const previous = run.coordinates[v - 1];
        const current = run.coordinates[v];
        cumulative.push(
          cumulative[cumulative.length - 1] +
            metresBetween(previous.latitude, previous.longitude, current.latitude, current.longitude)
        );
      }
      const total = cumulative[cumulative.length - 1];
      const next = points[index + 1];
      const fromMs = Date.parse(point.t);
      const toMs = Date.parse(next.t);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || total <= 0) continue;

      for (let v = vertexIndex + 1; v < nextVertexIndex; v += 1) {
        const fraction = cumulative[v - vertexIndex] / total;
        const vertexAt = run.coordinates[v];
        output.push({
          ...point,
          // An interpolated vertex continues the run; only a real fix on the far
          // side of a silence may open a new one.
          gapBefore: false,
          t: new Date(fromMs + Math.round((toMs - fromMs) * fraction)).toISOString(),
          lat: vertexAt.latitude,
          lng: vertexAt.longitude,
          speed: Math.max(0, point.speed + (next.speed - point.speed) * fraction),
          speedKmh: Math.max(
            0,
            (point.speedKmh ?? point.speed) +
              ((next.speedKmh ?? next.speed) - (point.speedKmh ?? point.speed)) * fraction
          ),
          // Interpolated between the two fixes' BACKEND distances, so a road
          // vertex reports progress along the journey the server measured
          // rather than the length of the road drawn to reach it.
          distanceKm:
            point.distanceKm == null || next.distanceKm == null
              ? point.distanceKm
              : point.distanceKm + (next.distanceKm - point.distanceKm) * fraction,
          ignition: fraction < 0.5 ? point.ignition : next.ignition,
          gpsValid: point.gpsValid && next.gpsValid,
          mapMatched: true,
        });
      }
    }
  }

  // Any fix no matched run covered still belongs to the journey; it is emitted
  // at its validated coordinate so the timeline stays complete and the route
  // simply degrades to GPS across that stretch.
  if (covered.size < points.length) {
    for (let index = 0; index < points.length; index += 1) {
      if (covered.has(index)) continue;
      // Keep the timestamp/state in playback, but lift the pen on both sides:
      // there is no road geometry for this fix, so interpolation would make the
      // vehicle drive a straight chord through whatever lies between.
      output.push({ ...points[index], gapBefore: true });
    }
    output.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  }

  return output;
}
