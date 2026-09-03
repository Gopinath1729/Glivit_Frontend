import { useMemo } from 'react';

import { buildPlaybackTrack, type PlaybackTrack } from '@/src/services/playbackEngine';
import type { LiveCoordinate } from '@/src/services/livePositions';
import type { PlaybackTrackPoint } from '@/src/types/api';

/**
 * The live buffer as a playback track, with no network work at all.
 *
 * <p>Every fix in the buffer has already been validated and road-matched — the
 * matching happened on the backend, once, as the fix was ingested, and the
 * result arrived with the update. So there is nothing to snap, nothing to batch
 * and nothing to wait for here: rendering is completely decoupled from the
 * network, which is what keeps live tracking smooth and stops a slow routing
 * service from ever stalling the marker.
 *
 * <p>Contrast with what this replaces: the client used to re-match the live
 * buffer itself, one rate-limited request per batch of fixes. On a fleet that
 * saturated the routing service's queue, and updates arrived minutes late or not
 * at all — which is precisely how a vehicle appeared to vanish and then come
 * back.
 *
 * @param points  accepted, already-matched fixes for the current trip
 * @param seed    the device's last known position, used before the first
 *                streamed fix arrives so the map opens on the vehicle rather
 *                than on Null Island
 */
export function useLiveRoadTrack(
  points: readonly PlaybackTrackPoint[],
  seed?: PlaybackTrackPoint | null
): PlaybackTrack {
  return useMemo(() => {
    const source = points.length > 0 ? points : seed ? [seed] : [];
    // `pointsAreClean` because validation, drift-holding and matching all
    // happened upstream. Re-running them here would compress the same stop
    // twice and could drop a fix the pipeline deliberately kept.
    return buildPlaybackTrack([...source], { pointsAreClean: true });
  }, [points, seed]);
}

/**
 * The live trail as map polylines.
 *
 * <p>These are the road vertices the backend reported as covered since each
 * previous update, accumulated into runs. They are drawn verbatim: the trail is
 * never the accepted fixes joined together, so it follows the road through
 * curves and turns and leaves a coverage gap as a gap.
 */
export function useLiveTrailSegments(trail: LiveCoordinate[][]): LiveCoordinate[][] {
  return useMemo(() => trail.filter((run) => run.length >= 2), [trail]);
}
