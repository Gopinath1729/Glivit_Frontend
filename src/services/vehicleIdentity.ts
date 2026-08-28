import type { DeviceSummary } from '@/src/types/api';

/**
 * Vehicle identity for a tracker row.
 *
 * The API lists devices, but the app presents them as vehicles, so two trackers
 * fitted to the same lorry arrived as two rows with the same registration and
 * were rendered twice with their status counted twice. The backend now resolves
 * every device onto a Vehicle, making `vehicleId` the identity; rows written
 * before that still carry a null, so registration and then the device id stand
 * in rather than collapsing every unlinked vehicle into one.
 */
function identityOf(device: DeviceSummary): string {
  // Registration comes first, not vehicleId. Where a vehicle already carried two
  // trackers the backfill could only link the earlier one, so its twin still has
  // a null vehicleId -- keying on the id would put the pair in different buckets
  // and leave exactly the duplicate rows this is meant to collapse.
  const registration = (device.vehicleName ?? device.name ?? '').trim().toUpperCase();
  if (registration) return `r:${registration}`;
  if (device.vehicleId != null) return `v:${device.vehicleId}`;
  return `d:${device.id}`;
}

/** Milliseconds since epoch, or 0 when a device has never reported. */
function reportedAt(device: DeviceSummary): number {
  if (!device.lastUpdate) return 0;
  const parsed = Date.parse(device.lastUpdate);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Whichever of two trackers on one vehicle should represent it: the one that has
 * actually reported, most recent first, falling back to the lower device id so
 * the choice is stable across refetches rather than flickering between rows.
 */
function preferred(a: DeviceSummary, b: DeviceSummary): DeviceSummary {
  const aReported = reportedAt(a);
  const bReported = reportedAt(b);
  if (aReported !== bReported) return aReported > bReported ? a : b;
  const aHasFix = a.latitude != null && a.longitude != null;
  const bHasFix = b.latitude != null && b.longitude != null;
  if (aHasFix !== bHasFix) return aHasFix ? a : b;
  // The tracker the backend actually linked to the vehicle wins over a leftover.
  const aLinked = a.vehicleId != null;
  const bLinked = b.vehicleId != null;
  if (aLinked !== bLinked) return aLinked ? a : b;
  return a.id <= b.id ? a : b;
}

/**
 * One row per vehicle, preserving input order. Use anywhere a device list is
 * presented as a list of vehicles or counted into status totals.
 */
export function dedupeByVehicle(devices: DeviceSummary[]): DeviceSummary[] {
  const chosen = new Map<string, DeviceSummary>();
  for (const device of devices) {
    if (!device) continue;
    const key = identityOf(device);
    const existing = chosen.get(key);
    chosen.set(key, existing ? preferred(existing, device) : device);
  }
  return Array.from(chosen.values());
}
