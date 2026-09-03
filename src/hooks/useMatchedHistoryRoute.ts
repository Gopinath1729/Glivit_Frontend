import { useMemo } from 'react';

import { buildPlaybackTrack, type PlaybackTrack } from '@/src/services/playbackEngine';
import { traceGps } from '@/src/services/gpsDiagnostics';
import {
  buildRoadFollowingPoints,
  EMPTY_MATCHED_ROUTE,
  pointsOnMatchedRoad,
  resolveMatchedRoute,
  type MatchedRoute,
} from '@/src/services/matchedRoute';
import type { PlaybackResponse } from '@/src/types/api';

/**
 * The History route: road geometry to draw, and a track to animate along it.
 *
 * <p>Both come from one backend response. The server loads the complete ordered
 * history for the range, validates it, map-matches the sequence against the OSM
 * road network and returns the matched polyline. This hook does no matching,
 * issues no routing request, and never joins raw fixes into a line.
 *
 * <h3>One track, densified onto the road</h3>
 * The returned track's coordinates are the road vertices, not the fixes: each
 * real fix keeps its own GPS timestamp, and the road between two fixes is
 * inserted with timestamps interpolated by distance along it. Because
 * consecutive coordinates are always adjacent road vertices, the polyline
 * follows curves, intersections and turns, and the marker travels along the road
 * instead of cutting the chord between fixes. Coverage gaps stay unjoined.
 *
 * <h3>Caching</h3>
 * The response is cached by the query cache and the match itself by the backend, so
 * reopening a trip re-renders from cache without recomputing or re-matching
 * anything. This memo covers the remaining work — building the playback index —
 * and is keyed on the response identity, so scrubbing and tab switches never
 * rebuild it.
 */
export type MatchedHistoryRoute = {
  /** Playback timeline over road geometry. */
  track: PlaybackTrack;
  /** Polylines to draw, one per contiguously observed run. */
  route: MatchedRoute;
};

export function useMatchedHistoryRoute(
  playback: PlaybackResponse | undefined | null
): MatchedHistoryRoute {
  return useMemo(() => {
    if (!playback) {
      return { track: buildPlaybackTrack([]), route: EMPTY_MATCHED_ROUTE };
    }

    const route = resolveMatchedRoute(playback);
    const onRoad = pointsOnMatchedRoad(playback.points ?? []);
    const densified = buildRoadFollowingPoints(onRoad, route.runs);

    // The backend already validated, ordered, de-duplicated and gap-flagged
    // these points, so the client-side cleaning passes are skipped: running them
    // again would compress stops a second time and could drop a fix the server
    // deliberately kept.
    const track = buildPlaybackTrack(densified, {
      pointsAreClean: true,
      rejectedPointCount: Object.values(playback.rejectedPoints ?? {}).reduce(
        (total, count) => total + count,
        0
      ),
    });

    traceGps('matched', playback.deviceId, {
      range: `${playback.from} -> ${playback.to}`,
      status: route.status,
      engine: playback.matchEngine,
      confidence: route.confidence,
      runs: route.runs.length,
      fixes: (playback.points ?? []).length,
      roadVertices: track.points.length,
      rejected: playback.rejectedPoints,
    });

    return { track, route };
  }, [playback]);
}
