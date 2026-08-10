import { tenantStorage } from '@/src/services/tenantStorage';

/**
 * Persistence for the geofence monitor's inside/outside state and its alert
 * dedup markers.
 *
 * Both are keyed by `<geofenceId>:<deviceId>` — ids that belong to one tenant — so
 * every value is written under a tenant-namespaced storage key. Without that, a
 * geofence in tenant B whose numeric id happened to match one in tenant A would
 * inherit A's inside/outside state and could suppress or fabricate an alert.
 *
 * A per-tenant in-memory mirror keeps reads cheap and still correct after a switch:
 * a tenant that has not been loaded yet simply starts empty.
 */
export type GeofenceOccupancy = 'INSIDE' | 'OUTSIDE';

type TenantKey = string;

const memoryStates = new Map<TenantKey, Record<string, GeofenceOccupancy>>();
const memoryNotified = new Map<TenantKey, Record<string, boolean>>();

function scope(tenantId: number | null | undefined): TenantKey {
  return Number.isSafeInteger(tenantId) && (tenantId as number) > 0 ? String(tenantId) : 'none';
}

export async function loadGeofenceStatesFromStorage(
  tenantId: number | null | undefined
): Promise<Record<string, GeofenceOccupancy>> {
  const loaded = await tenantStorage.readJson<Record<string, GeofenceOccupancy>>(
    tenantId,
    'geofenceStates',
    memoryStates.get(scope(tenantId)) ?? {}
  );
  memoryStates.set(scope(tenantId), loaded);
  return loaded;
}

export async function saveGeofenceStatesToStorage(
  tenantId: number | null | undefined,
  states: Record<string, GeofenceOccupancy>
): Promise<void> {
  memoryStates.set(scope(tenantId), { ...states });
  await tenantStorage.writeJson(tenantId, 'geofenceStates', states);
}

export async function loadGeofenceNotifiedKeys(
  tenantId: number | null | undefined
): Promise<Record<string, boolean>> {
  const loaded = await tenantStorage.readJson<Record<string, boolean>>(
    tenantId,
    'geofenceNotified',
    memoryNotified.get(scope(tenantId)) ?? {}
  );
  memoryNotified.set(scope(tenantId), loaded);
  return loaded;
}

export async function saveGeofenceNotifiedKeys(
  tenantId: number | null | undefined,
  keys: Record<string, boolean>
): Promise<void> {
  memoryNotified.set(scope(tenantId), { ...keys });
  await tenantStorage.writeJson(tenantId, 'geofenceNotified', keys);
}

/** Drops the in-memory mirror for a tenant; called when leaving it. */
export function forgetGeofenceMemory(tenantId: number | null | undefined): void {
  memoryStates.delete(scope(tenantId));
  memoryNotified.delete(scope(tenantId));
}
