import { CENTRALIZED_STATUS_COLORS } from '@/src/theme/tokens';

/**
 * One place that turns a backend {@code DeviceState} into the label an operator
 * reads. The mapping used to be copy-pasted into every row, pill, marker
 * callout and profile header, and each copy collapsed `NO_DATA` into "Offline".
 *
 * Those are different faults with different fixes:
 *
 *   - `NO_DATA`  — this device has never reported a position at all. The
 *     tracker was never installed, never powered, or never configured with the
 *     right IMEI/token. Nothing will change until someone touches the hardware.
 *   - `OFFLINE`  — it was reporting and has now gone quiet for longer than the
 *     tenant's offline timeout. Usually power, SIM data or coverage.
 *   - `EXPIRED` — administrative. The server refuses this device's telemetry,
 *     so it can never come back on its own.
 *
 * Showing all of them as "Offline" is what makes a fleet look uniformly dead
 * while hiding which vehicles an operator can actually do something about.
 */

/** Backend-calculated state, or a client-only overlay (see resolveDeviceState). */
export type DeviceStateCode = string;

const STATE_LABELS: Record<string, string> = {
  LOCATION_DISABLED: 'GPS Off',
  RUNNING: 'Running',
  MOVING: 'Running',
  // Retired current-state label. Older rows can still contain IDLE, but every
  // operator-facing surface folds it into STOPPED.
  IDLE: 'Stopped',
  STOPPED: 'Stopped',
  OFFLINE: 'Offline',
  NO_DATA: 'No Data',
  GPS_INVALID: 'GPS Error',
  POWER_DISCONNECTED: 'Power Cut',
  LOW_ACCURACY: 'Low Accuracy',
  IMMOBILISED: 'Immobilised',
  EXPIRED: 'Expired',
  INACTIVE: 'Inactive',
};

export function normalizeDeviceState(state?: string | null): string {
  return (state ?? '').trim().toUpperCase().replace(/\s+/g, '_');
}

/** Operator-facing label for a device state. */
export function formatDeviceState(state?: string | null): string {
  const normalized = normalizeDeviceState(state);
  if (!normalized) return STATE_LABELS.NO_DATA;
  const known = STATE_LABELS[normalized];
  if (known) return known;
  return normalized.charAt(0) + normalized.slice(1).toLowerCase().replace(/_/g, ' ');
}

/**
 * Why a device is not reporting, or `null` when it is. Used to explain a
 * non-reporting row instead of leaving the operator to guess.
 */
export function deviceStateHint(state?: string | null): string | null {
  switch (normalizeDeviceState(state)) {
    case 'LOCATION_DISABLED':
      return 'Location is turned off. Please enable GPS to continue tracking.';
    case 'NO_DATA':
    case '':
      return 'Never reported — check the tracker is installed and configured';
    case 'OFFLINE':
      return 'No signal since the last report — check power, SIM data or coverage';
    case 'EXPIRED':
      return 'Subscription expired — telemetry is rejected until it is renewed';
    case 'GPS_INVALID':
      return 'Reporting, but without a usable GPS fix';
    case 'POWER_DISCONNECTED':
      return 'Reporting, but external power is disconnected';
    default:
      return null;
  }
}

/** True when the device is actively reporting usable telemetry. */
export function isDeviceReporting(state?: string | null): boolean {
  const normalized = normalizeDeviceState(state);
  return (
    normalized === 'RUNNING' ||
    normalized === 'MOVING' ||
    normalized === 'IDLE' ||
    normalized === 'STOPPED' ||
    normalized === 'LOW_ACCURACY'
  );
}

/**
 * THE status calculation. Every screen renders what this returns.
 *
 * The backend already derives state from telemetry (DeviceStateCalculator) and
 * refreshes it on a timer, so that value is authoritative and is never
 * recomputed here from speed, ignition or stream connectivity. Screens used to
 * each re-derive their own answer from whatever they had to hand, which is how
 * one screen showed RUNNING off a three-hour-old fix while the list correctly
 * showed OFFLINE for the same vehicle.
 *
 * Only two things are layered on top, and both can only ever move the answer
 * toward "not reporting":
 *
 *   1. Freshness. If the fix behind the state is older than the tenant's own
 *      offline timeout, it is reported as OFFLINE. Same rule and same
 *      threshold the server uses, applied to the same timestamp — this is what
 *      stops a cached payload from being presented as live between polls.
 *   2. The phone's own location switch, for the tracker this login owns. The
 *      server cannot see that GPS was turned off; it only ever sees the
 *      silence that follows. The app can, and says so immediately.
 *
 * Stream connectivity (an open SSE socket) is deliberately not an input: it
 * says the app can reach the server, not that the vehicle is reporting.
 */
export type DeviceStateInput = {
  /** Backend-calculated state from the device list, detail, or live stream. */
  serverState?: string | null;
  /** ISO timestamp of the fix that state was derived from. */
  lastUpdate?: string | null;
  /** Tenant staleness threshold, shipped alongside the device. */
  offlineTimeoutSeconds?: number | null;
  sourceType?: string | null;
  immobilised?: boolean | null;
  locked?: boolean | null;
  /** Canonical km/h from the same fix as `lastUpdate`. */
  speedKmh?: number | null;
  ignition?: boolean | null;
  gpsValid?: boolean | null;
  accuracyMeters?: number | null;
  /** This login's own phone tracker has location switched off or denied. */
  locationDisabled?: boolean | null;
};

export type ResolvedDeviceState = {
  /** Canonical code to render and colour by. */
  state: DeviceStateCode;
  label: string;
  /** The device is not currently reporting usable telemetry. */
  offline: boolean;
};

/** Fallback threshold, matching TelemetrySettings.defaults() on the server. */
const DEFAULT_OFFLINE_TIMEOUT_SECONDS = 900;

export function resolveDeviceState(input: DeviceStateInput): ResolvedDeviceState {
  const server = normalizeDeviceState(input.serverState);

  const decide = (): DeviceStateCode => {
    // Expiry outranks telemetry: the server refuses an expired device's
    // packets, so freshness is not the story to tell about it.
    if (server === 'EXPIRED') return server;

    // The phone knows its own location switch before any silence reaches the
    // server, so this is reported ahead of the staleness that would follow.
    if (input.locationDisabled) return 'LOCATION_DISABLED';

    if (input.immobilised || input.locked) return 'IMMOBILISED';

    if (!server || server === 'NO_DATA') return 'NO_DATA';

    const lastMs = input.lastUpdate ? Date.parse(input.lastUpdate) : Number.NaN;
    if (!Number.isFinite(lastMs)) {
      // A state with no timestamp behind it cannot be shown as live movement.
      return server === 'RUNNING' || server === 'IDLE' || server === 'STOPPED'
        ? 'OFFLINE'
        : server;
    }
    const timeoutMs =
      Math.max(60, input.offlineTimeoutSeconds || DEFAULT_OFFLINE_TIMEOUT_SECONDS) * 1000;
    if (Date.now() - lastMs > timeoutMs) return 'OFFLINE';

    // Never preserve a cached/default RUNNING label over contradictory fresh
    // telemetry. The backend owns the primary calculation, but the APK can
    // receive a state refresh and its adjacent position frame in either order
    // across an SSE reconnect. A fresh zero-speed fix is the newer evidence.
    if (input.gpsValid === false) return 'GPS_INVALID';
    if (
      input.accuracyMeters != null &&
      Number.isFinite(input.accuracyMeters) &&
      input.accuracyMeters > 50
    ) {
      return 'LOW_ACCURACY';
    }
    if (input.speedKmh != null && Number.isFinite(input.speedKmh)) {
      // The speed belongs to the same fresh fix as the state. It therefore wins
      // over a state-only SSE frame that arrived immediately before/after it.
      if (
        (server === 'RUNNING' || server === 'IDLE' || server === 'STOPPED') &&
        input.speedKmh < 2.5
      ) {
        return 'STOPPED';
      }
      if ((server === 'STOPPED' || server === 'IDLE') && input.speedKmh >= 3) {
        return 'RUNNING';
      }
    }

    // IDLE is no longer an operator-facing current state. Keep accepting the
    // legacy wire/database value during rolling upgrades, but render it as the
    // requested two-state movement model: Running or Stopped.
    if (server === 'IDLE') return 'STOPPED';
    return server;
  };

  const state = decide();
  return {
    state,
    label: formatDeviceState(state),
    offline: !isDeviceReporting(state),
  };
}

/**
 * Status colour for a state code, from the one shared palette.
 *
 * Screens that hand-rolled their own colour ladders drifted apart from the
 * labels; both now come from the same place.
 */
export function stateColorFor(state?: string | null): string {
  const normalized = normalizeDeviceState(state);
  const alias =
    normalized === 'ENGINE_CUT' || normalized === 'LOCKED'
      ? 'IMMOBILISED'
      : normalized === 'GPS_ERROR'
        ? 'GPS_INVALID'
        : normalized === 'POWER_CUT'
          ? 'POWER_DISCONNECTED'
          : normalized === 'GPS_OFF'
            ? 'LOCATION_DISABLED'
            : normalized === 'IDLE'
              ? 'STOPPED'
              : normalized;
  return (
    (CENTRALIZED_STATUS_COLORS as Record<string, string>)[alias] ??
    CENTRALIZED_STATUS_COLORS.NO_DATA
  );
}

/** The fields any device record must expose for {@link resolveDeviceRecordState}. */
export type DeviceStateRecord = {
  id?: number | null;
  state?: string | null;
  lastUpdate?: string | null;
  offlineTimeoutSeconds?: number | null;
  sourceType?: string | null;
  immobilised?: boolean | null;
  locked?: boolean | null;
  speed?: number | null;
  ignition?: boolean | null;
  gpsValid?: boolean | null;
  accuracyMeters?: number | null;
};

/**
 * Convenience wrapper for a device row/record. Screens call this instead of
 * reading `device.state` directly, so a list, a marker callout and a detail
 * header can never disagree about the same vehicle.
 */
export function resolveDeviceRecordState(
  device: DeviceStateRecord,
  readiness?: { deviceId: number | null; locationDisabled: boolean }
): ResolvedDeviceState {
  return resolveDeviceState({
    serverState: device.state,
    lastUpdate: device.lastUpdate,
    offlineTimeoutSeconds: device.offlineTimeoutSeconds,
    sourceType: device.sourceType,
    immobilised: device.immobilised,
    locked: device.locked,
    speedKmh: device.speed,
    ignition: device.ignition,
    gpsValid: device.gpsValid,
    accuracyMeters: device.accuracyMeters,
    locationDisabled:
      readiness != null &&
      readiness.locationDisabled &&
      device.id != null &&
      readiness.deviceId === device.id,
  });
}
