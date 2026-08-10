import { useEffect, useRef, useState, type MutableRefObject } from 'react';

import { env } from '@/src/config/env';
import { useAppSelector } from '@/src/store/hooks';
import type { DeviceSummary } from '@/src/types/api';
import { openSse } from './sseClient';
import type { LivePositionEvent } from './livePositions';

/**
 * Live positions for the WHOLE fleet, for the All Vehicles Live Map.
 *
 * Maintains a target position per device in a ref (read by the map's animation
 * loop — no re-render per update, so the map never flickers or remounts):
 *   - Real mode: subscribes to the tenant SSE position stream and updates the
 *     matching device as fixes arrive.
 *   - Dev demo mode: advances RUNNING/IDLE vehicles along their heading on a
 *     timer; STOPPED/OFFLINE stay put. Forced off in production via env.demoMode.
 *
 * Seeded from the device list so every authorised vehicle shows immediately.
 */

import { resolveTravelHeading } from '@/src/services/geoMath';
import { snapCoordinateToRoadSync } from './roadSnapping';
import { getSimulatedVehicle } from './vehicleSimulator';

export type FleetTarget = {
  deviceId: number;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number;
  state: string;
  /** True for states that should animate smoothly between fixes. */
  moving: boolean;
  updatedAt: number;
};

export type FleetLive = {
  targetsRef: MutableRefObject<Map<number, FleetTarget>>;
  connected: boolean;
  /** Bumped whenever the set of known vehicles changes (for initial fit). */
  vehicleCount: number;
};

const MOVING_STATES = new Set(['RUNNING', 'MOVING']);
const DEMO_STEP_MS = 1200;

function makeTarget(v: DeviceSummary, previous?: FleetTarget): FleetTarget | null {
  if (v.latitude == null || v.longitude == null) return null;
  const snap = snapCoordinateToRoadSync(v.latitude, v.longitude, v.course);
  const latitude = snap.snapped ? snap.latitude : v.latitude;
  const longitude = snap.snapped ? snap.longitude : v.longitude;
  return {
    deviceId: v.id,
    latitude,
    longitude,
    speed: v.speed,
    // Direction of travel, derived from movement since this vehicle's own previous
    // coordinate. Never from the snapped road bearing, which is direction-agnostic.
    heading: resolveTravelHeading({
      previous,
      latitude,
      longitude,
      reportedCourse: v.course,
      lastHeading: previous?.heading,
    }),
    state: v.state,
    moving: MOVING_STATES.has(v.state),
    updatedAt: Date.now(),
  };
}

export function useFleetLivePositions(seed: DeviceSummary[], enabled = true): FleetLive {
  const token = useAppSelector((s) => s.auth.accessToken);
  const tenantEpoch = useAppSelector((s) => s.tenant.epoch);
  const targetsRef = useRef<Map<number, FleetTarget>>(new Map());
  const [connected, setConnected] = useState(false);
  const [vehicleCount, setVehicleCount] = useState(0);

  // A tenant switch clears the marker map itself, not just the subscription. The
  // animation loop reads this ref directly, so leaving the previous tenant's targets
  // in place would keep their vehicles on the map until the new list arrived.
  useEffect(() => {
    targetsRef.current.clear();
    setVehicleCount(0);
    setConnected(false);
  }, [tenantEpoch]);

  // Seed / merge the known vehicles from the device list.
  useEffect(() => {
    const map = targetsRef.current;
    let changed = false;
    for (const v of seed) {
      const target = makeTarget(v, map.get(v.id));
      if (!target) continue;
      if (!map.has(v.id)) {
        map.set(v.id, target);
        changed = true;
      } else {
        // Keep the live-animated position, but refresh state/speed metadata.
        const cur = map.get(v.id)!;
        cur.state = v.state;
        cur.moving = MOVING_STATES.has(v.state);
      }
    }
    if (changed) setVehicleCount(map.size);
  }, [seed]);

  useEffect(() => {
    if (!enabled) return;

    // Dev demo: move running/idle vehicles along their heading with gentle turns.
    if (env.demoMode) {
      setConnected(true);
      const timer = setInterval(() => {
        const map = targetsRef.current;
        map.forEach((v, id) => {
          const sim = getSimulatedVehicle(
            id,
            v.latitude,
            v.longitude,
            v.heading,
            v.state,
            v.moving
          );
          map.set(id, {
            ...v,
            latitude: sim.latitude,
            longitude: sim.longitude,
            speed: sim.speed,
            heading: sim.heading,
            updatedAt: Date.now(),
          });
        });
      }, DEMO_STEP_MS);
      return () => clearInterval(timer);
    }

    if (!env.backendBaseUrl) return;

    const connection = openSse(`${env.apiBaseUrl}/positions/stream`, token ?? null, {
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      onEvent: (name, data) => {
        if (name !== 'POSITION') return;
        let event: LivePositionEvent;
        try {
          event = JSON.parse(data) as LivePositionEvent;
        } catch {
          return;
        }
        const map = targetsRef.current;
        const previous = map.get(event.deviceId);
        const existed = previous != null;
        const state = event.state ?? previous?.state ?? 'NO_DATA';
        const snap = snapCoordinateToRoadSync(event.latitude, event.longitude, event.course);
        const latitude = snap.snapped ? snap.latitude : event.latitude;
        const longitude = snap.snapped ? snap.longitude : event.longitude;
        map.set(event.deviceId, {
          deviceId: event.deviceId,
          latitude,
          longitude,
          speed: event.speed,
          // Bearing from this vehicle's previous fix to the new one. A fix that has
          // barely moved, or one with poor reported accuracy, holds the current
          // heading instead of turning the marker on GPS noise.
          heading: resolveTravelHeading({
            previous,
            latitude,
            longitude,
            reportedCourse: event.course,
            accuracyMeters: event.accuracyMeters ?? null,
            lastHeading: previous?.heading,
          }),
          state,
          moving: MOVING_STATES.has(state),
          updatedAt: Date.now(),
        });
        if (!existed) setVehicleCount(map.size);
      },
    });

    // Unsubscribes from the previous tenant's fleet stream on a switch, then
    // reconnects under the new tenant's token.
    return () => connection.close();
  }, [enabled, token, tenantEpoch]);

  return { targetsRef, connected, vehicleCount };
}
