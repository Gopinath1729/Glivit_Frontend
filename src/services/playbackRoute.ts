import { coordinateOf, distanceBetween } from '@/src/services/gpsPipeline';
import type { PlaybackTrack } from '@/src/services/playbackEngine';

/**
 * The road a playback draws, measured once so the playhead costs nothing.
 *
 * <h3>The problem this exists to remove</h3>
 * A playing trip publishes a new position ~25 times a second. Handing the map a
 * freshly clipped copy of the travelled road each time means rebuilding every
 * vertex of it, re-validating every vertex of it, serialising every vertex of
 * it across the bridge, and asking the renderer to re-parse and re-tile a line
 * that grows to thousands of points — all for a head that moved a few
 * centimetres. It saturates the bridge, it allocates continuously, and the line
 * arrives in bursts that read as flickering and blinking rather than as growth.
 *
 * <h3>What replaces it</h3>
 * The road is geometry. For a given vehicle and day it does not change at all,
 * so it is measured once, pushed once, and never sent again. What moves is a
 * position along it, and that is two numbers: which run the vehicle is in, and
 * how far through that run it has got. The map document clips the line it
 * already holds, as a paint property, which costs no re-parse and no re-tile.
 *
 * <h3>Runs, not one line</h3>
 * A run is a stretch the tracker actually observed. The breaks between them are
 * coverage the vehicle drove through unrecorded, and they are left undrawn
 * rather than closed with a straight chord — so progress is expressed per run,
 * and the runs behind the active one are simply complete.
 */

/** One observed stretch of road, measured along its own length. */
export type PlaybackRouteRun = {
  /** [longitude, latitude] — the order the map document draws in. */
  coordinates: [number, number][];
  /** Metres from this run's first vertex, one entry per vertex. */
  cumulativeMeters: number[];
  /** Playback-clock offset (ms) of each vertex. */
  elapsedMs: number[];
  /** Length of the whole run in metres. Never zero for a run that is kept. */
  totalMeters: number;
};

/** Where the playhead is: which run, and how far along it, as a 0..1 share. */
export type RouteProgress = {
  runIndex: number;
  fraction: number;
};

/**
 * Vertices closer together than this are the same place.
 *
 * The same threshold the shared route splitter uses, so the geometry measured
 * here is the geometry every other route layer draws.
 */
const MINIMUM_SPACING_METERS = 0.5;

type Building = {
  coordinates: [number, number][];
  cumulativeMeters: number[];
  elapsedMs: number[];
};

function emptyBuilding(): Building {
  return { coordinates: [], cumulativeMeters: [], elapsedMs: [] };
}

/**
 * Measure the drawable road of a track, run by run.
 *
 * Follows the same rules as the shared route splitter: a vertex that fails
 * validation ENDS the run rather than being deleted out of the middle of it
 * (deleting it would join its neighbours with a chord across roads nobody
 * recorded), vertices within half a metre of the previous one are the same
 * place, and a run of fewer than two vertices is not a line.
 */
export function buildPlaybackRoute(track: PlaybackTrack): PlaybackRouteRun[] {
  const runs: PlaybackRouteRun[] = [];
  const { points, timeOffsetsMs } = track;

  for (const range of track.runs) {
    let current = emptyBuilding();

    const flush = () => {
      if (current.coordinates.length >= 2) {
        runs.push({
          coordinates: current.coordinates,
          cumulativeMeters: current.cumulativeMeters,
          elapsedMs: current.elapsedMs,
          totalMeters: current.cumulativeMeters[current.cumulativeMeters.length - 1],
        });
      }
      current = emptyBuilding();
    };

    for (let index = range.start; index <= range.end; index += 1) {
      const point = points[index];
      const coordinate = point ? coordinateOf(point.lat, point.lng) : null;
      if (!coordinate) {
        flush();
        continue;
      }
      const previousIndex = current.coordinates.length - 1;
      if (previousIndex >= 0) {
        const previous = current.coordinates[previousIndex];
        const step = distanceBetween(
          { latitude: previous[1], longitude: previous[0] },
          coordinate
        );
        if (step < MINIMUM_SPACING_METERS) continue;
        current.cumulativeMeters.push(current.cumulativeMeters[previousIndex] + step);
      } else {
        current.cumulativeMeters.push(0);
      }
      current.coordinates.push([coordinate.longitude, coordinate.latitude]);
      current.elapsedMs.push(timeOffsetsMs[index] ?? 0);
    }

    flush();
  }

  // A run with no length cannot express a position along itself, and dividing
  // by it would make every playhead read as NaN.
  return runs.filter((run) => run.totalMeters > 0);
}

/** Index of the last vertex at or before `elapsed`, by bisection. */
function vertexIndexAt(elapsedMs: readonly number[], elapsed: number): number {
  let low = 0;
  let high = elapsedMs.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (elapsedMs[middle] <= elapsed) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The playhead's position on the measured road, in O(log n).
 *
 * Interpolates on the SAME time fraction the vehicle marker is interpolated
 * with, so the head of the drawn line is exactly where the vehicle is drawn
 * rather than somewhere near it.
 *
 * Time spent in a coverage gap holds at the end of the run before it — which is
 * where the vehicle is held too, because nothing was recorded in between.
 */
export function routeProgressAt(
  runs: readonly PlaybackRouteRun[],
  elapsedMs: number
): RouteProgress | null {
  if (runs.length === 0) return null;
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const first = run.elapsedMs[0];
    const last = run.elapsedMs[run.elapsedMs.length - 1];

    if (elapsed < first) {
      // Before this run started: either the trip has not begun, or the vehicle
      // is inside the unrecorded stretch that precedes it.
      return index === 0 ? { runIndex: 0, fraction: 0 } : { runIndex: index - 1, fraction: 1 };
    }
    if (elapsed > last) continue;

    const vertex = Math.min(vertexIndexAt(run.elapsedMs, elapsed), run.elapsedMs.length - 2);
    if (vertex < 0) return { runIndex: index, fraction: 0 };
    const from = run.elapsedMs[vertex];
    const to = run.elapsedMs[vertex + 1];
    const step = to > from ? (elapsed - from) / (to - from) : 0;
    const metres =
      run.cumulativeMeters[vertex] +
      (run.cumulativeMeters[vertex + 1] - run.cumulativeMeters[vertex]) * step;
    return {
      runIndex: index,
      fraction: Math.max(0, Math.min(1, metres / run.totalMeters)),
    };
  }

  return { runIndex: runs.length - 1, fraction: 1 };
}
