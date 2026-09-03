import type { LivePositionEvent } from '@/src/services/livePositionStream';
import type { AnyAction } from '@/src/store/action';
import { CLEAR_ACTIVE_TENANT, SWITCH_SUCCEEDED } from '@/src/store/tenantState';

/**
 * Live vehicle state, keyed by the stable device id.
 *
 * <h3>Merge, never replace</h3>
 * A live packet is a partial update. Some carry an address, some do not; a
 * state-only refresh from the health sweep carries no new road geometry at all.
 * Replacing the stored object with the incoming one therefore erased whatever
 * the newest packet happened to omit — including, on a bad packet, the
 * coordinate itself, which is one of the ways a vehicle vanished from the map.
 * Every field here is merged into the existing entry, and a field is only
 * overwritten when the incoming packet actually carries a usable value.
 *
 * <h3>Update in place, never delete-and-re-add</h3>
 * Entries are addressed by device id. Nothing removes and re-inserts a vehicle
 * on update, so a marker keeps its identity across every refresh and never
 * flickers out of existence between the delete and the insert.
 *
 * <h3>Out-of-order packets</h3>
 * A delayed packet can arrive after a newer one — from a device replaying a
 * buffer, or from two briefly-overlapping streams during a reconnect. Updates
 * are accepted only when their GPS timestamp is at least as new as the stored
 * one, so a late packet can never drag a marker back to where the vehicle used
 * to be.
 */

export type LiveVehicle = {
  deviceId: number;
  vehicleId: number | null;
  /** GPS coordinate exactly as reported. Never rendered directly. */
  rawLatitude: number;
  rawLongitude: number;
  /** Road-matched coordinate when the backend could place the fix. */
  matchedLatitude: number | null;
  matchedLongitude: number | null;
  /** The coordinate to draw: matched when available, validated otherwise. */
  latitude: number;
  longitude: number;
  matchConfidence: number | null;
  roadBearing: number | null;
  speedKmh: number;
  /** Backend-measured travel for the trip in progress, in km. */
  tripDistanceKm: number;
  course: number;
  accuracyMeters: number | null;
  ignition: boolean | null;
  gpsValid: boolean;
  state: string | null;
  connectionState: string | null;
  address: string | null;
  /** GPS timestamp of the newest accepted fix, epoch ms. */
  lastGpsAt: number | null;
  /** When the server last heard anything from the device, epoch ms. */
  lastServerAt: number | null;
  /** Local receipt time of this update, epoch ms. */
  receivedAt: number;
};

export type LiveVehicleSeed = {
  deviceId: number;
  vehicleId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  speedKmh?: number | null;
  course?: number | null;
  state?: string | null;
  address?: string | null;
  lastUpdate?: string | null;
};

export type LiveVehiclesState = {
  byDeviceId: Record<number, LiveVehicle>;
  /** Bumped on every accepted update, for cheap change detection. */
  version: number;
};

const initialState: LiveVehiclesState = { byDeviceId: {}, version: 0 };

export type LiveVehiclesAction =
  | { type: 'liveVehicles/livePositionReceived'; payload: LivePositionEvent }
  | { type: 'liveVehicles/liveVehiclesSeeded'; payload: LiveVehicleSeed[] }
  | { type: 'liveVehicles/liveVehiclesCleared'; payload?: undefined };

/** One live packet. Merged into the existing entry, addressed by device id. */
export const livePositionReceived = (payload: LivePositionEvent): LiveVehiclesAction => ({
  type: 'liveVehicles/livePositionReceived',
  payload,
});

/**
 * Seeds entries from a REST device list.
 *
 * <p>Only fills in vehicles that have no live entry yet, and never downgrades
 * one that does: a periodically-refetched list is older than the stream, and
 * letting it win is how a refresh used to drag a moving marker back to its last
 * polled position.
 */
export const liveVehiclesSeeded = (payload: LiveVehicleSeed[]): LiveVehiclesAction => ({
  type: 'liveVehicles/liveVehiclesSeeded',
  payload,
});

/** Clears everything. Used on logout. */
export const liveVehiclesCleared = (): LiveVehiclesAction => ({
  type: 'liveVehicles/liveVehiclesCleared',
});

function isLiveVehiclesAction(action: AnyAction): action is LiveVehiclesAction {
  return action.type.startsWith('liveVehicles/');
}

function epochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usableCoordinate(latitude: number | null, longitude: number | null): boolean {
  return (
    latitude != null &&
    longitude != null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function distanceKm(latA: number, lngA: number, latB: number, lngB: number): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(latB - latA);
  const dLng = toRadians(lngB - lngA);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Builds the merged entry for one device from a packet and what we already had. */
function merge(existing: LiveVehicle | undefined, event: LivePositionEvent): LiveVehicle {
  const rawUsable = usableCoordinate(event.latitude, event.longitude);
  const matched =
    rawUsable &&
    usableCoordinate(event.matchedLatitude, event.matchedLongitude) &&
    event.matchConfidence != null &&
    event.matchConfidence >= 0.2 &&
    distanceKm(
      event.latitude,
      event.longitude,
      event.matchedLatitude as number,
      event.matchedLongitude as number
    ) <= 0.06;

  const rawLatitude = rawUsable ? event.latitude : existing?.rawLatitude ?? event.latitude;
  const rawLongitude = rawUsable ? event.longitude : existing?.rawLongitude ?? event.longitude;
  const matchedLatitude = matched
    ? (event.matchedLatitude as number)
    : existing?.matchedLatitude ?? null;
  const matchedLongitude = matched
    ? (event.matchedLongitude as number)
    : existing?.matchedLongitude ?? null;

  // Display coordinate preference: this packet's matched road position, then
  // this packet's validated GPS, then whatever we were already drawing. The
  // final fallback is what guarantees a vehicle is never moved to nowhere.
  const latitude = matched
    ? (event.matchedLatitude as number)
    : rawUsable
      ? event.latitude
      : existing?.latitude ?? rawLatitude;
  const longitude = matched
    ? (event.matchedLongitude as number)
    : rawUsable
      ? event.longitude
      : existing?.longitude ?? rawLongitude;

  return {
    deviceId: event.deviceId,
    vehicleId: event.vehicleId ?? existing?.vehicleId ?? null,
    rawLatitude,
    rawLongitude,
    matchedLatitude,
    matchedLongitude,
    latitude,
    longitude,
    matchConfidence: event.matchConfidence ?? existing?.matchConfidence ?? null,
    roadBearing: event.roadBearing ?? existing?.roadBearing ?? null,
    speedKmh: Number.isFinite(event.speedKmh) ? event.speedKmh : existing?.speedKmh ?? 0,
    // A trip total never goes backwards within a trip, but it DOES reset to 0
    // when a new trip starts, so this takes the packet's value rather than a
    // running maximum. The server owns when that reset happens.
    tripDistanceKm: Number.isFinite(event.tripDistanceKm)
      ? event.tripDistanceKm
      : existing?.tripDistanceKm ?? 0,
    course: Number.isFinite(event.course) ? event.course : existing?.course ?? 0,
    accuracyMeters: event.accuracyMeters ?? existing?.accuracyMeters ?? null,
    ignition: event.ignition ?? existing?.ignition ?? null,
    gpsValid: event.gpsValid,
    state: event.state ?? existing?.state ?? null,
    connectionState: event.connectionState ?? existing?.connectionState ?? null,
    // An update without an address must not blank the one already shown.
    address: event.address?.trim() ? event.address : existing?.address ?? null,
    lastGpsAt: epochMs(event.lastGpsTime ?? event.deviceTime) ?? existing?.lastGpsAt ?? null,
    lastServerAt:
      epochMs(event.lastServerReceivedTime ?? event.serverTime) ?? existing?.lastServerAt ?? null,
    receivedAt: Date.now(),
  };
}

/** Replaces one device's entry, leaving every other entry's identity intact. */
function withVehicle(
  state: LiveVehiclesState,
  deviceId: number,
  vehicle: LiveVehicle
): LiveVehiclesState {
  return {
    byDeviceId: { ...state.byDeviceId, [deviceId]: vehicle },
    version: state.version + 1,
  };
}

function applyPosition(state: LiveVehiclesState, event: LivePositionEvent): LiveVehiclesState {
  const existing = state.byDeviceId[event.deviceId];

  const incomingGpsAt = epochMs(event.lastGpsTime ?? event.deviceTime ?? event.serverTime);
  const incomingServerAt =
    epochMs(event.lastServerReceivedTime ?? event.serverTime) ?? existing?.lastServerAt ?? null;

  /**
   * Records that the device is still reachable without moving it.
   *
   * Used for every packet that may not update the position: a health-sweep
   * refresh, a rejected fix, an out-of-order one. Nothing here touches a
   * coordinate.
   */
  const connectionOnly = (): LiveVehiclesState => {
    if (!existing) return state;
    return withVehicle(state, event.deviceId, {
      ...existing,
      state: event.state ?? existing.state,
      lastServerAt: incomingServerAt,
      connectionState: event.connectionState ?? existing.connectionState,
      receivedAt: Date.now(),
    });
  };

  if (
    // A state-only refresh from the health sweep. It carries the position
    // this entry already holds; applying it again would re-stamp receivedAt
    // and make a vehicle that has not reported for minutes look fresh.
    !event.positionUpdate ||
    incomingGpsAt == null ||
    incomingGpsAt < Date.now() - 5 * 60 * 1000 ||
    event.gpsValid === false ||
    (event.accuracyMeters != null &&
      (!Number.isFinite(event.accuracyMeters) || event.accuracyMeters > 50))
  ) {
    return connectionOnly();
  }

  if (existing && existing.lastGpsAt != null && incomingGpsAt <= existing.lastGpsAt) {
    // Out of order. The stored fix is newer, so this one may not move the
    // vehicle - but it IS evidence the device is still reachable, so the
    // connection clock is allowed through.
    return connectionOnly();
  }

  if (existing) {
    const movedKm = distanceKm(
      existing.rawLatitude,
      existing.rawLongitude,
      event.latitude,
      event.longitude
    );
    const elapsedHours = Math.max(
      1 / 3_600_000,
      (incomingGpsAt - (existing.lastGpsAt ?? incomingGpsAt)) / 3_600_000
    );
    if (movedKm / elapsedHours > 220) {
      return connectionOnly();
    }
    if (event.speedKmh < 2.5 && movedKm <= 0.015) {
      // Parked. Metadata from the packet is taken, but the vehicle is pinned to
      // exactly where it already is, so a stationary marker cannot jitter
      // between neighbouring fixes.
      const held = merge(existing, event);
      return withVehicle(state, event.deviceId, {
        ...held,
        rawLatitude: existing.rawLatitude,
        rawLongitude: existing.rawLongitude,
        matchedLatitude: existing.matchedLatitude,
        matchedLongitude: existing.matchedLongitude,
        latitude: existing.latitude,
        longitude: existing.longitude,
        course: existing.course,
        speedKmh: 0,
      });
    }
  }

  return withVehicle(state, event.deviceId, merge(existing, event));
}

function applySeeds(state: LiveVehiclesState, seeds: LiveVehicleSeed[]): LiveVehiclesState {
  let byDeviceId = state.byDeviceId;
  const copyOnWrite = () => {
    if (byDeviceId === state.byDeviceId) byDeviceId = { ...state.byDeviceId };
  };

  for (const seed of seeds) {
    const existing = byDeviceId[seed.deviceId];
    if (existing) {
      // Metadata only: state and address may refresh, position may not.
      if (seed.state && seed.state !== existing.state) {
        copyOnWrite();
        byDeviceId[seed.deviceId] = { ...existing, state: seed.state };
      }
      continue;
    }
    if (!usableCoordinate(seed.latitude ?? null, seed.longitude ?? null)) continue;
    const latitude = seed.latitude as number;
    const longitude = seed.longitude as number;
    copyOnWrite();
    byDeviceId[seed.deviceId] = {
      deviceId: seed.deviceId,
      vehicleId: seed.vehicleId ?? null,
      rawLatitude: latitude,
      rawLongitude: longitude,
      matchedLatitude: null,
      matchedLongitude: null,
      latitude,
      longitude,
      matchConfidence: null,
      roadBearing: null,
      speedKmh: seed.speedKmh ?? 0,
      tripDistanceKm: 0,
      course: seed.course ?? 0,
      accuracyMeters: null,
      ignition: null,
      gpsValid: true,
      state: seed.state ?? null,
      connectionState: null,
      address: seed.address ?? null,
      lastGpsAt: epochMs(seed.lastUpdate),
      lastServerAt: epochMs(seed.lastUpdate),
      receivedAt: Date.now(),
    };
  }

  if (byDeviceId === state.byDeviceId) return state;
  return { byDeviceId, version: state.version + 1 };
}

export default function liveVehiclesReducer(
  state: LiveVehiclesState = initialState,
  action: AnyAction
): LiveVehiclesState {
  // A tenant switch invalidates every vehicle in here at once. Clearing on the
  // switch action rather than in a screen effect means the state is already
  // empty by the time any screen re-renders, so no component can momentarily
  // show the previous tenant's fleet.
  if (action.type === SWITCH_SUCCEEDED || action.type === CLEAR_ACTIVE_TENANT) {
    return state === initialState ? state : { byDeviceId: {}, version: 0 };
  }

  if (!isLiveVehiclesAction(action)) return state;

  switch (action.type) {
    case 'liveVehicles/livePositionReceived':
      return applyPosition(state, action.payload);

    case 'liveVehicles/liveVehiclesSeeded':
      return applySeeds(state, action.payload);

    case 'liveVehicles/liveVehiclesCleared':
      return state === initialState ? state : { byDeviceId: {}, version: 0 };

    default:
      return state;
  }
}
