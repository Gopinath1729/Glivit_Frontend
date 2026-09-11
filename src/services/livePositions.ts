import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { lerpAngle, normalizeHeading } from '@/src/services/geoMath';
import { drawableRuns, type LiveCoordinate, type LiveTrailRun } from '@/src/services/liveRouteTrail';
import {
  applyLiveEvent,
  applyRoadMatchEvent,
  EMPTY_LIVE_STATE,
  expirePendingRoadMatches,
  resetLiveWindow,
  type LivePositionsState,
  type LiveRoadSegment,
} from '@/src/services/livePipeline';
import { clipPolylineTail, positionAtDistance } from '@/src/services/roadPolyline';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { livePositionReceived } from '@/src/store/liveVehiclesState';
import {
  useLivePositionStream,
  type LivePositionEvent,
  type LiveRoadMatchEvent,
} from './livePositionStream';

/**
 * React bindings for the live pipeline.
 *
 * The rules themselves live in `livePipeline`, which is pure and directly
 * tested. This module only subscribes to the stream, caches per-device state
 * across mounts, and runs the marker's animation frame.
 */

export type {
  LivePositionEvent,
  LiveRoadMatchEvent,
  LiveCoordinate,
  LiveTrailRun,
  LiveGpsQuality,
  LivePositionsState,
  LiveRoadSegment,
  PendingRoadMatch,
  PreviousAcceptedLivePoint,
  ValidatedFix,
} from '@/src/services/livePipeline';
export {
  applyLiveEvent,
  applyRoadMatchEvent,
  displayGapMeters,
  EMPTY_LIVE_STATE,
  expirePendingRoadMatches,
  resetLiveWindow,
  validateLivePositionEvent,
} from '@/src/services/livePipeline';

/**
 * Session route cache, keyed by tenant epoch and device.
 *
 * Navigating from the fleet map into a vehicle, switching tabs, or an SSE
 * reconnect must not erase the line already travelled. An earlier version kept
 * this state only inside one component mount, so reopening Live Track began
 * with the replayed snapshot as a one-point route and the polyline disappeared.
 */
const liveStateCache = new Map<string, LivePositionsState>();

function liveCacheKey(tenantEpoch: number, deviceId: number): string {
  return `${tenantEpoch}:${deviceId}`;
}



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
    const cached =
      deviceId == null
        ? EMPTY_LIVE_STATE
        : (liveStateCache.get(liveCacheKey(tenantEpoch, deviceId)) ?? EMPTY_LIVE_STATE);
    stateRef.current = cached;
    setState(cached);
    // The anchor and the rolling window belong to the previous device. Carrying
    // either into a new one measures a jump between two vehicles.
    if (deviceId != null) resetLiveWindow(deviceId);
    return () => {
      if (deviceId != null) resetLiveWindow(deviceId);
    };
  }, [deviceId, tenantEpoch]);

  const commit = useCallback(
    (next: LivePositionsState) => {
      if (deviceId == null) return;
      stateRef.current = next;
      liveStateCache.set(liveCacheKey(tenantEpoch, deviceId), next);
      setState(next);
    },
    [deviceId, tenantEpoch]
  );

  const onPosition = useCallback(
    (event: LivePositionEvent) => {
      if (deviceId == null || event.deviceId !== deviceId) return;
      const previous = stateRef.current;
      const next = applyLiveEvent(previous, event);
      commit(next);
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
    [commit, dispatch, deviceId]
  );

  const onRoadMatch = useCallback(
    (event: LiveRoadMatchEvent) => {
      if (deviceId == null || event.deviceId !== deviceId) return;
      commit(applyRoadMatchEvent(stateRef.current, event));
    },
    [commit, deviceId]
  );

  const stream = useLivePositionStream(onPosition, onRoadMatch, enabled && deviceId != null);

  // The road-answer watchdog. Without it a matching outage would freeze the
  // marker at the last enriched fix for as long as the outage lasted, which
  // looks exactly like a dead tracker.
  useEffect(() => {
    if (deviceId == null || !enabled) return;
    const timer = setInterval(() => {
      const current = stateRef.current;
      if (current.pendingMatches.length === 0) return;
      const next = expirePendingRoadMatches(current, deviceId);
      if (next !== current) commit(next);
    }, 1_000);
    return () => clearInterval(timer);
  }, [commit, deviceId, enabled]);

  return useMemo(() => ({ ...state, stream, connected: stream.connected }), [state, stream]);
}

export type LiveRoadMotion = {
  /** The coordinate to draw the vehicle at this frame. */
  position: LiveCoordinate | null;
  /** Heading to draw, 0-360. */
  heading: number;
  /** Monotonic local timestamp for this rendered motion sample. */
  sourceTime: number;
  /** Metres travelled along the current segment. */
  travelledMeters: number;
  /**
   * The route to draw: complete runs, with the newest clipped at the vehicle.
   *
   * Same geometry, same distance, same frame as `position`, so the blue line
   * always ends directly behind the marker instead of running ahead of it to
   * the fix the vehicle is still travelling toward.
   */
  route: LiveCoordinate[][];
};

/**
 * Travels the marker along the current matched road segment.
 *
 * <h3>The single live motion clock</h3>
 * This is the ONLY thing that moves the live vehicle. Live Track used to run
 * two independent mechanisms at once - a recorded-timeline `sampleAt(track,
 * elapsedMs)` clock and a separate marker ease - plus a projection of one onto
 * the other, so three components could each claim a different position for the
 * same instant and the marker visibly fought itself. Recorded playback keeps its
 * own clock on the playback screen, where it belongs.
 *
 * <h3>Distance, not component interpolation</h3>
 * Progress is a monotonically increasing distance along the segment's polyline.
 * The coordinate at that distance is ON the polyline, so a 90-degree turn is
 * driven as an L and a curve is driven as a curve. Interpolating latitude and
 * longitude between the endpoints instead - which is what this replaces - cuts
 * every corner, through whatever building is on the inside of it.
 */
export function useLiveRoadMotion(
  segment: LiveRoadSegment | null,
  trail: readonly LiveTrailRun[],
  fallback: LiveCoordinate | null,
  fallbackHeading = 0
): LiveRoadMotion {
  type MotionFrame = {
    segmentKey: string;
    sourceTime: number;
    travelledMeters: number;
  };
  const [frame, setFrame] = useState<MotionFrame>({
    segmentKey: '',
    sourceTime: 0,
    travelledMeters: 0,
  });
  const frameRef = useRef<number | null>(null);
  /**
   * Monotonic id of the animation that owns the marker. A frame scheduled by a
   * superseded animation checks this before writing, so a callback already in
   * flight when a newer segment arrived cannot drag the marker backwards.
   */
  const generationRef = useRef(0);
  const headingRef = useRef(normalizeHeading(fallbackHeading));
  const segmentKey = segment ? `${segment.positionId ?? 'none'}:${segment.startedAt}` : '';

  /**
   * React publishes targets at 20 Hz; the map interpolates those targets on its
   * own animation frame. Rendering this entire screen at display refresh rate
   * sent a marker command and a changing route across the WebView bridge sixty
   * times a second, starving the camera loop it was meant to animate.
   */
  const MOTION_PUBLISH_INTERVAL_MS = 50;

  useEffect(() => {
    const generation = (generationRef.current += 1);
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (!segment) {
      setFrame({ segmentKey: '', sourceTime: 0, travelledMeters: 0 });
      return;
    }
    const total = segment.polyline.lengthMeters;
    if (segment.placeImmediately || total <= 0) {
      // No observed ground to travel over: appear at the end of the segment
      // rather than sliding across roads nobody saw the vehicle take.
      setFrame({ segmentKey, sourceTime: Date.now(), travelledMeters: total });
      return;
    }

    setFrame({ segmentKey, sourceTime: segment.startedAt, travelledMeters: 0 });
    const startedAt = Date.now();
    let lastPublishedAt = startedAt;
    const tick = () => {
      if (generationRef.current !== generation) return;
      const now = Date.now();
      const fraction = Math.min(1, (now - startedAt) / Math.max(1, segment.durationMs));
      // Linear in DISTANCE. GPS fixes arrive at a steady cadence, so an
      // ease-in-out on every segment makes the vehicle visibly accelerate and
      // brake once per fix; constant progress along the road is what real
      // motion looks like.
      if (fraction >= 1 || now - lastPublishedAt >= MOTION_PUBLISH_INTERVAL_MS) {
        lastPublishedAt = now;
        setFrame({ segmentKey, sourceTime: now, travelledMeters: total * fraction });
      }
      if (fraction < 1) {
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
  }, [segment, segmentKey]);

  return useMemo(() => {
    const runs = drawableRuns(trail);
    if (!segment) {
      return {
        position: fallback,
        heading: normalizeHeading(fallbackHeading),
        sourceTime: 0,
        travelledMeters: 0,
        route: runs,
      };
    }

    // A changed segment renders once before its effect resets progress. Keying
    // the value prevents the previous segment's completed distance from being
    // applied to the new geometry for that frame (end -> start -> drive).
    const travelledMeters = segment.placeImmediately
      ? segment.polyline.lengthMeters
      : frame.segmentKey === segmentKey
        ? frame.travelledMeters
        : 0;
    const at = positionAtDistance(segment.polyline, travelledMeters, segment.endHeading);
    const position = at?.coordinate ?? fallback;
    // Turn through the shortest angle toward the segment's direction of travel,
    // so a vehicle crossing north goes 350 -> 10 rather than the long way round.
    const heading = at
      ? lerpAngle(headingRef.current, at.heading, 0.35)
      : normalizeHeading(fallbackHeading);
    headingRef.current = heading;

    // The untravelled remainder of the current segment is trimmed off the end of
    // the newest run, so the drawn route stops exactly at the marker.
    const remaining = Math.max(0, segment.polyline.lengthMeters - travelledMeters);
    if (remaining <= 0.5 || runs.length === 0) {
      return {
        position,
        heading,
        sourceTime: frame.segmentKey === segmentKey ? frame.sourceTime : segment.startedAt,
        travelledMeters,
        route: runs,
      };
    }
    const clippedLast = clipPolylineTail(runs[runs.length - 1], remaining);
    const route =
      clippedLast.length >= 2
        ? [...runs.slice(0, runs.length - 1), clippedLast]
        : runs.slice(0, runs.length - 1);
    return {
      position,
      heading,
      sourceTime: frame.segmentKey === segmentKey ? frame.sourceTime : segment.startedAt,
      travelledMeters,
      route,
    };
  }, [fallback, fallbackHeading, frame, segment, segmentKey, trail]);
}

