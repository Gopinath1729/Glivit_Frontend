import { useSyncExternalStore } from 'react';

/**
 * The phone's own location readiness, published for the whole app.
 *
 * Only the device this login owns can be in this state, and only the app can
 * observe it: when location services are switched off the tracker simply stops
 * posting, so all the server ever sees is silence that looks identical to a
 * flat battery. MobileGpsTrackingGate already performs the readiness checks, so
 * it publishes the result here and any screen showing that vehicle's status can
 * say "GPS Off" immediately instead of waiting out the offline timeout to say
 * "Offline".
 *
 * Deliberately its own module store rather than the app store or context: it is written
 * from one place, read by several, and must not re-render the tree on every
 * readiness poll that changes nothing.
 */
export type MobileGpsReadiness = {
  /** The owned tracker's device id, or null when this login has none. */
  deviceId: number | null;
  /** Location services are off, or permission is denied. */
  locationDisabled: boolean;
};

const EMPTY: MobileGpsReadiness = { deviceId: null, locationDisabled: false };

let current: MobileGpsReadiness = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function setMobileGpsReadiness(next: MobileGpsReadiness): void {
  if (
    current.deviceId === next.deviceId &&
    current.locationDisabled === next.locationDisabled
  ) {
    return;
  }
  current = next;
  emit();
}

export function clearMobileGpsReadiness(): void {
  setMobileGpsReadiness(EMPTY);
}

export function getMobileGpsReadiness(): MobileGpsReadiness {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMobileGpsReadiness(): MobileGpsReadiness {
  return useSyncExternalStore(subscribe, getMobileGpsReadiness, getMobileGpsReadiness);
}

/** True when this specific device is the owned tracker and its GPS is off. */
export function useLocationDisabledFor(deviceId?: number | null): boolean {
  const readiness = useMobileGpsReadiness();
  if (deviceId == null || readiness.deviceId == null) return false;
  return readiness.deviceId === deviceId && readiness.locationDisabled;
}
