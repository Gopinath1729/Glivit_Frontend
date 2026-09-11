import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import { normalizeHeading } from '@/src/services/geoMath';
import { GpsRollingWindow } from '@/src/services/gpsPipeline';
import { traceCoord, traceGps } from '@/src/services/gpsDiagnostics';
import {
  isHeldMatchedSource,
  type LiveMatchedSource,
} from '@/src/services/liveRouteTrail';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { liveVehiclesSeeded, livePositionReceived } from '@/src/store/liveVehiclesState';
import type { DeviceSummary } from '@/src/types/api';
import {
  useLivePositionStream,
  type LivePositionEvent,
  type LiveRoadMatchEvent,
  type LiveStreamState,
} from './livePositionStream';
import { validateLivePositionEvent } from './livePositions';

/**
 * Recent accepted fixes per device, used to tell a real departure from noise.
 *
 * Deliberately this screen's OWN windows rather than the tracking screen's: the
 * two hold independent anchors, and sharing one window would have both screens
 * pushing the same fix into it whenever both are mounted.
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

/**
 * Live positions for the WHOLE fleet, for the All Vehicles Live Map.
 *
 * <p>A target position per device is kept in a ref, read by the map's animation
 * loop, so the map does not re-render per fix and never flickers or remounts.
 * The same updates also go into the {@code liveVehicles} store state, which is
 * what any React-driven consumer (lists, counts, status pills) reads.
 *
 * <h3>Vehicles are added, updated, and never removed</h3>
 * A target is created once per device and mutated in place afterwards. Nothing
 * in this file deletes an entry: not a rejected fix, not a dropped stream, not a
 * device-list refetch that came back without a position. A vehicle leaves the
 * map only when the tenant changes, which clears the whole map at once. That is
 * the difference between a marker going stale and a marker disappearing.
 *
 * <h3>What is drawn</h3>
 * The backend's display coordinate, and only that. It is the road-matched
 * position for the fix when the fix was matched, and the previous valid road
 * position while a new match was still being solved - resolved on the server
 * before the frame was sent, so a marker is never drawn at the raw coordinate
 * and corrected a moment later. There is no client-side snapping: matching a
 * coordinate on its own puts adjacent fixes on different parallel roads, which
 * is what made stationary markers twitch between carriageways.
 */

export type FleetTarget = {
  deviceId: number;
  /** The coordinate to draw: road-matched where available. */
  latitude: number;
  longitude: number;
  /** The reported coordinate, kept for auditing. Never drawn. */
  rawLatitude: number;
  rawLongitude: number;
  /** True when latitude/longitude came from the road matcher. */
  matched: boolean;
  /** Road vertices for this accepted fix only, in backend [lat, lng] order. */
  matchedGeometry: [number, number][];
  /** Whether this fix has a fresh road solution, a carried point, or no match. */
  matchedSource: LiveMatchedSource | null;
  /**
   * Identity of the fix this target came from.
   *
   * The road answer arrives on its own frame, after the position, and is applied
   * to the target only when it names THIS fix. Applying "the latest match" to
   * "the latest target" is the stale-match substitution: on a moving vehicle the
   * two are routinely different fixes, and the marker gets snapped onto the road
   * it was on a second ago.
   */
  positionId: number | null;
  speedKmh: number;
  accuracyMeters: number | null;
  ignition: boolean | null;
  gpsValid: boolean;
  heading: number;
  state: string;
  /** True for states that should animate smoothly between fixes. */
  moving: boolean;
  updatedAt: number;
  /**
   * GPS timestamp of the fix this target came from, in epoch ms.
   *
   * Compared before every update so a delayed packet - from a replayed device
   * buffer, or from two briefly-overlapping streams during a reconnect - can
   * never drag a marker back to where the vehicle used to be.
   */
  sourceTime: number;
};

export type FleetLive = {
  targetsRef: MutableRefObject<Map<number, FleetTarget>>;
  connected: boolean;
  stream: LiveStreamState;
  /** Bumped whenever a target changes, so projections can invalidate. */
  vehicleCount: number;
};

const MOVING_STATES = new Set(['RUNNING', 'MOVING']);
/**
 * How long accepted frames are allowed to pile up before React is invalidated.
 *
 * Positions are written to the target map immediately regardless; this only
 * decides how often the screens that read them re-render.
 */
const RENDER_COALESCE_MS = 200;
/** Below this the vehicle is parked and its coordinate is held, not followed. */

function usable(latitude: number | null | undefined, longitude: number | null | undefined): boolean {
  return (
    latitude != null &&
    longitude != null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(latitude === 0 && longitude === 0)
  );
}

/** Epoch ms of a timestamp, or 0 when it carries none. */
function epochMs(timestamp?: string | null): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Seed a target from the device list.
 *
 * Only used for a vehicle the stream has not reported yet. An existing target is
 * refreshed for its metadata but never for its position: the list is a
 * periodically-refetched snapshot and is older than the stream, so letting it
 * write a coordinate would drag a moving marker backwards on every refetch.
 */
function seedTarget(device: DeviceSummary): FleetTarget | null {
  if (!usable(device.latitude, device.longitude)) return null;
  const latitude = device.latitude as number;
  const longitude = device.longitude as number;
  return {
    deviceId: device.id,
    latitude,
    longitude,
    rawLatitude: latitude,
    rawLongitude: longitude,
    matched: false,
    matchedGeometry: [],
    matchedSource: null,
    // A seeded target has no live fix behind it yet, so no road answer may be
    // applied to it. The first POSITION frame supplies the identity.
    positionId: null,
    speedKmh: device.speed ?? 0,
    accuracyMeters: null,
    ignition: device.ignition ?? null,
    gpsValid: device.gpsValid,
    heading: normalizeHeading(device.course, 0),
    state: device.state,
    moving: MOVING_STATES.has(device.state),
    updatedAt: Date.now(),
    sourceTime: epochMs(device.lastUpdate),
  };
}

export function useFleetLivePositions(seed: DeviceSummary[], enabled = true): FleetLive {
  const dispatch = useAppDispatch();
  const tenantEpoch = useAppSelector((s) => s.tenant.epoch);
  const targetsRef = useRef<Map<number, FleetTarget>>(new Map());
  const [vehicleCount, setVehicleCount] = useState(0);

  /**
   * Coalesced render invalidation.
   *
   * Every accepted frame used to call `setVehicleCount` directly, so a fleet of
   * N vehicles reporting once a second re-rendered the whole Live Map N times a
   * second - and that screen recomputes its located set, its live set, its
   * status counts and its entire marker payload on every render. With a few
   * dozen trackers the JS thread never came back up for air, which is the whole
   * of "the live map lags and hangs".
   *
   * The targets themselves are still written the instant a frame lands - the
   * map's animation loop reads the ref directly and so stays perfectly current.
   * Only the React invalidation is batched, at a rate no eye can tell apart
   * from per-frame, and one that no longer scales with fleet size.
   */
  const bumpPendingRef = useRef(false);
  const bumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpVersion = useCallback(() => {
    if (bumpPendingRef.current) return;
    bumpPendingRef.current = true;
    bumpTimerRef.current = setTimeout(() => {
      bumpPendingRef.current = false;
      bumpTimerRef.current = null;
      setVehicleCount((count) => count + 1);
    }, RENDER_COALESCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (bumpTimerRef.current) clearTimeout(bumpTimerRef.current);
      bumpPendingRef.current = false;
    },
    []
  );

  // A tenant switch clears the marker map itself, not just the subscription. The
  // animation loop reads this ref directly, so leaving the previous tenant's
  // targets in place would keep their vehicles on the map until the new list
  // arrived. This is the ONLY thing in this hook that removes a target.
  useEffect(() => {
    targetsRef.current.clear();
    if (bumpTimerRef.current) clearTimeout(bumpTimerRef.current);
    bumpTimerRef.current = null;
    bumpPendingRef.current = false;
    setVehicleCount(0);
  }, [tenantEpoch]);

  // Seed / merge the known vehicles from the device list.
  useEffect(() => {
    const map = targetsRef.current;
    let changed = false;
    for (const device of seed) {
      const existing = map.get(device.id);
      if (existing) {
        // The polled roster is older than SSE. It may refresh names and other
        // metadata in the React record, but it must never overwrite a fresher
        // live state here (STOPPED -> stale RUNNING was visible every poll).
        continue;
      }
      const target = seedTarget(device);
      if (!target) continue;
      map.set(device.id, target);
      changed = true;
    }
    if (changed) setVehicleCount((count) => count + 1);

    dispatch(
      liveVehiclesSeeded(
        seed.map((device) => ({
          deviceId: device.id,
          vehicleId: device.vehicleId ?? null,
          latitude: device.latitude ?? null,
          longitude: device.longitude ?? null,
          speedKmh: device.speed ?? null,
          course: device.course ?? null,
          state: device.state ?? null,
          address: device.address ?? null,
          lastUpdate: device.lastUpdate ?? null,
        }))
      )
    );
  }, [dispatch, seed]);

  const onPosition = useCallback(
    (event: LivePositionEvent) => {
      const map = targetsRef.current;
      const previous = map.get(event.deviceId);

      // A state-only refresh moves the status pill and nothing else. It carries
      // the coordinate and GPS time this target already holds, so putting it
      // through the GPS validator only ever produced a duplicate-timestamp
      // rejection - and the status change was discarded with it.
      if (!event.positionUpdate) {
        if (previous && event.state) {
          previous.state = event.state;
          previous.moving = MOVING_STATES.has(event.state);
          bumpVersion();
        }
        dispatch(livePositionReceived(event));
        return;
      }

      const validation = validateLivePositionEvent(
        event,
        previous
          ? {
              timestampMs: previous.sourceTime,
              recordedAt: previous.sourceTime,
              raw: {
                latitude: previous.rawLatitude,
                longitude: previous.rawLongitude,
              },
              display: { latitude: previous.latitude, longitude: previous.longitude },
              bearing: previous.heading,
              course: previous.heading,
              speedKmh: previous.speedKmh,
              ignition: null,
            }
          : null,
        Date.now(),
        windowFor(event.deviceId)
      );

      if (!validation.accepted) {
        traceGps('rejected', event.deviceId, {
          reason: validation.reason,
          raw: traceCoord(event.latitude, event.longitude),
          accuracy: event.accuracyMeters,
          gpsTime: event.lastGpsTime ?? event.deviceTime,
        });
        return;
      }
      dispatch(livePositionReceived(event));

      // The backend's display coordinate when it sent one, which it now always
      // does: it is the single place that decides where a vehicle is drawn, and
      // it decided before this frame was sent. `validation.matched` is the older
      // two-frame path, kept for an older backend.
      const authoritative = usable(event.displayLatitude, event.displayLongitude)
        ? { latitude: event.displayLatitude as number, longitude: event.displayLongitude as number }
        : null;
      const retained = isHeldMatchedSource(event.matchedSource);
      const stationaryHeld = event.matchedSource === 'HELD_STATIONARY';
      const matched = authoritative ? event.matchedSource !== 'NONE' : validation.isMatched;
      // Defense in depth: a retained source is a command to keep the prior
      // pixels, not merely a hint about matching confidence. This prevents an
      // old or partially-deployed backend from moving a frozen marker with a
      // mismatched display field.
      const latitude = retained && previous
        ? previous.latitude
        : authoritative
          ? authoritative.latitude
          : validation.matched.latitude;
      const longitude = retained && previous
        ? previous.longitude
        : authoritative
          ? authoritative.longitude
          : validation.matched.longitude;
      const state = stationaryHeld
        ? event.state === 'IDLE' ? 'IDLE' : 'STOPPED'
        : event.state ?? previous?.state ?? 'NO_DATA';
      const rawLatitude = (validation.held || retained) && previous
        ? previous.rawLatitude
        : event.latitude;
      const rawLongitude = (validation.held || retained) && previous
        ? previous.rawLongitude
        : event.longitude;

      if (!stationaryHeld) {
        windowFor(event.deviceId).push(
          { latitude: rawLatitude, longitude: rawLongitude },
          validation.recordedAt,
          validation.speedKmh
        );
      }

      map.set(event.deviceId, {
        deviceId: event.deviceId,
        latitude,
        longitude,
        rawLatitude,
        rawLongitude,
        matched,
        matchedGeometry: retained ? [] : event.matchedGeometry,
        matchedSource: event.matchedSource,
        positionId: event.positionId,
        speedKmh: stationaryHeld
          ? 0
          : Number.isFinite(event.speedKmh) ? event.speedKmh : previous?.speedKmh ?? 0,
        accuracyMeters: event.accuracyMeters,
        ignition: event.ignition,
        gpsValid: event.gpsValid,
        // The bearing the pipeline already resolved for this fix.
        //
        // It used to be re-derived here with a second call to the shared
        // resolver over separately-assembled inputs, which is a second
        // implementation in everything but name: the two could - and did -
        // disagree, so the same vehicle faced different ways on the fleet map
        // and the tracking screen at the same instant. One fix, one bearing,
        // taken from the stage that measured it.
        // The heading the backend resolved for this fix, which is the validated
        // direction of travel refined by the matched road and already
        // rate-limited so the model turns rather than snapping. Falling back to
        // the local one keeps an older backend working.
        heading:
          retained && previous
            ? previous.heading
            : event.displayBearing != null && Number.isFinite(event.displayBearing)
            ? event.displayBearing
            : validation.course,
        state,
        moving: stationaryHeld ? false : MOVING_STATES.has(state),
        updatedAt: Date.now(),
        sourceTime: validation.recordedAt,
      });

      traceGps('store', event.deviceId, {
        raw: traceCoord(event.latitude, event.longitude),
        matched: traceCoord(event.matchedLatitude, event.matchedLongitude),
        drawn: traceCoord(latitude, longitude),
        speedKmh: event.speedKmh,
        state,
        connectionState: event.connectionState,
      });

      bumpVersion();
    },
    [bumpVersion, dispatch]
  );

  /**
   * The road answer for one fleet marker.
   *
   * Applied only when it names the fix the target currently holds. A `SOLVED`
   * match moves the marker onto the road; `CARRIED`/`HELD` leaves it exactly
   * where it is; `NONE` leaves the validated coordinate showing and says so.
   * Nothing here draws a route - the fleet map shows markers, and the road
   * geometry belongs to the per-vehicle tracking screen.
   */
  const onRoadMatch = useCallback((event: LiveRoadMatchEvent) => {
    const target = targetsRef.current.get(event.deviceId);
    if (!target || target.positionId == null || target.positionId !== event.positionId) {
      return;
    }
    if (
      event.matchedSource !== 'SOLVED' ||
      !usable(event.matchedLatitude, event.matchedLongitude)
    ) {
      return;
    }
    target.latitude = event.matchedLatitude as number;
    target.longitude = event.matchedLongitude as number;
    target.matched = true;
    target.matchedGeometry = event.matchedGeometry;
    target.matchedSource = event.matchedSource;
    target.updatedAt = Date.now();
    traceGps('matched', event.deviceId, {
      stage: 'fleet_road_match',
      positionId: event.positionId,
      drawn: traceCoord(target.latitude, target.longitude),
      raw: traceCoord(target.rawLatitude, target.rawLongitude),
      matchStatus: event.matchStatus,
    });
    bumpVersion();
  }, [bumpVersion]);

  const stream = useLivePositionStream(onPosition, onRoadMatch, enabled);

  return useMemo(
    () => ({ targetsRef, connected: stream.connected, stream, vehicleCount }),
    [stream, vehicleCount]
  );
}
