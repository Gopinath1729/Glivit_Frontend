import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Tenant-namespaced persistent storage.
 *
 * Every cached value that belongs to a tenant is written under a key containing
 * that tenant's id, so a value stored while tenant A was active can never be read
 * back while tenant B is active — even if a screen forgets to clear it. That makes
 * cross-tenant leakage through local storage a naming impossibility rather than
 * something each caller has to remember.
 *
 * `clearTenantScope` removes every namespaced key for one tenant and is called
 * during a switch, so nothing survives into the next tenant either.
 */

/** Keys whose values are tenant-owned and must be namespaced and purged. */
export const TENANT_SCOPED_KEYS = [
  'geofenceStates',
  'geofenceNotified',
  'notificationsRead',
  'mapFilters',
  'lastViewedDevice',
] as const;

export type TenantScopedKey = (typeof TENANT_SCOPED_KEYS)[number];

const PREFIX = 'glivt.t';

/** SecureStore keys must be alphanumeric plus `._-`; tenant ids and our names are. */
export function tenantScopedKey(tenantId: number | null | undefined, key: TenantScopedKey): string {
  const scope = Number.isSafeInteger(tenantId) && (tenantId as number) > 0 ? String(tenantId) : 'none';
  return `${PREFIX}${scope}.${key}`;
}

const webStore = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

async function readRaw(key: string): Promise<string | null> {
  const store = webStore();
  if (store) {
    return store.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function writeRaw(key: string, value: string | null): Promise<void> {
  const store = webStore();
  if (store) {
    if (value == null) store.removeItem(key);
    else store.setItem(key, value);
    return;
  }
  if (value == null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}

export const tenantStorage = {
  /** Reads a tenant-scoped JSON value, or the fallback when absent or corrupt. */
  async readJson<T>(tenantId: number | null | undefined, key: TenantScopedKey, fallback: T): Promise<T> {
    try {
      const raw = await readRaw(tenantScopedKey(tenantId, key));
      if (!raw) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },

  async writeJson(
    tenantId: number | null | undefined,
    key: TenantScopedKey,
    value: unknown
  ): Promise<void> {
    try {
      await writeRaw(tenantScopedKey(tenantId, key), JSON.stringify(value));
    } catch {
      // Cache writes are best-effort; a storage failure must not break the screen.
    }
  },

  /**
   * Removes every tenant-scoped value for one tenant.
   *
   * Called on the way out of a tenant during a switch, so no geofence state,
   * notification read-marker or remembered filter can be inherited by the next one.
   */
  async clearTenantScope(tenantId: number | null | undefined): Promise<void> {
    await Promise.all(
      TENANT_SCOPED_KEYS.map((key) =>
        writeRaw(tenantScopedKey(tenantId, key), null).catch(() => undefined)
      )
    );
  },
};
