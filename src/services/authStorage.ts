import * as SecureStore from 'expo-secure-store';

import {
  hasValidTenantSelection,
  hasValidTenantSession,
  normalizeCompanyCode,
} from '@/src/services/tenantIdentity';
import type { AuthUser, TenantConfig } from '@/src/types/api';

/**
 * Secure persistence for auth artefacts. Tokens live in the OS keystore
 * (Keychain on iOS, encrypted SharedPreferences/Keystore on Android) via
 * expo-secure-store. Never log token values.
 */
const KEYS = {
  accessToken: 'glivt.accessToken',
  refreshToken: 'glivt.refreshToken',
  sessionCompanyCode: 'glivt.sessionCompanyCode',
  user: 'glivt.user',
  companyCode: 'glivt.companyCode',
  tenantConfig: 'glivt.tenantConfig',
  // The tenant the ACCOUNT belongs to, kept separately from the tenant currently
  // being viewed so a restart after a tenant switch still knows which company code
  // the user actually signs in with.
  homeCompanyCode: 'glivt.homeCompanyCode',
  homeTenantConfig: 'glivt.homeTenantConfig',
} as const;

export type PersistedAuth = {
  accessToken: string | null;
  refreshToken: string | null;
  sessionCompanyCode: string | null;
  user: AuthUser | null;
  companyCode: string | null;
  tenantConfig: TenantConfig | null;
  homeCompanyCode: string | null;
  homeTenantConfig: TenantConfig | null;
};

async function setOrDelete(key: string, value: string | null) {
  if (value == null) {
    await SecureStore.deleteItemAsync(key);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

let mutationQueue: Promise<void> = Promise.resolve();

function mutate(task: () => Promise<void>): Promise<void> {
  const next = mutationQueue.catch(() => undefined).then(task);
  mutationQueue = next.catch(() => undefined);
  return next;
}

async function clearSessionKeys() {
  await Promise.all([
    setOrDelete(KEYS.accessToken, null),
    setOrDelete(KEYS.refreshToken, null),
    setOrDelete(KEYS.sessionCompanyCode, null),
    setOrDelete(KEYS.user, null),
  ]);
}

export const authStorage = {
  async saveSession({
    accessToken,
    companyCode,
    refreshToken,
    user,
  }: {
    accessToken: string;
    companyCode: string;
    refreshToken: string;
    user: AuthUser;
  }) {
    const normalizedCode = normalizeCompanyCode(companyCode);
    if (
      !normalizedCode ||
      !accessToken ||
      !refreshToken ||
      !Number.isSafeInteger(user.tenantId) ||
      user.tenantId <= 0
    ) {
      throw new Error('Invalid tenant session');
    }
    await mutate(async () => {
      // The company binding is the commit marker. An interrupted write cannot
      // turn partially saved credentials into a valid tenant session.
      await setOrDelete(KEYS.sessionCompanyCode, null);
      try {
        await Promise.all([
          SecureStore.setItemAsync(KEYS.accessToken, accessToken),
          SecureStore.setItemAsync(KEYS.refreshToken, refreshToken),
          SecureStore.setItemAsync(KEYS.user, JSON.stringify(user)),
        ]);
        await SecureStore.setItemAsync(KEYS.sessionCompanyCode, normalizedCode);
      } catch (error) {
        await clearSessionKeys().catch(() => undefined);
        throw error;
      }
    });
  },

  /**
   * Persists the tenant selected before login. That selection IS the home tenant,
   * so it is recorded as both the active and the home tenant.
   */
  async saveTenant(companyCode: string, tenantConfig: TenantConfig) {
    const normalizedCode = normalizeCompanyCode(companyCode);
    if (
      !normalizedCode ||
      !hasValidTenantSelection({ companyCode: normalizedCode, tenantConfig })
    ) {
      throw new Error('Invalid tenant configuration');
    }
    const payload = JSON.stringify({ ...tenantConfig, companyCode: normalizedCode });
    await mutate(async () => {
      await SecureStore.setItemAsync(KEYS.companyCode, normalizedCode);
      await SecureStore.setItemAsync(KEYS.tenantConfig, payload);
      await SecureStore.setItemAsync(KEYS.homeCompanyCode, normalizedCode);
      await SecureStore.setItemAsync(KEYS.homeTenantConfig, payload);
    });
  },

  /**
   * Persists the tenant a switch moved into, leaving the home tenant untouched.
   *
   * Kept separate from {@link saveTenant} on purpose: a switch changes which tenant
   * is being viewed, never which tenant owns the login.
   */
  async saveActiveTenant(companyCode: string, tenantConfig: TenantConfig) {
    const normalizedCode = normalizeCompanyCode(companyCode);
    if (
      !normalizedCode ||
      !hasValidTenantSelection({ companyCode: normalizedCode, tenantConfig })
    ) {
      throw new Error('Invalid tenant configuration');
    }
    await mutate(async () => {
      await SecureStore.setItemAsync(KEYS.companyCode, normalizedCode);
      await SecureStore.setItemAsync(
        KEYS.tenantConfig,
        JSON.stringify({ ...tenantConfig, companyCode: normalizedCode })
      );
    });
  },

  /** Clears session tokens + user but keeps tenant branding for the next login. */
  async clearSession() {
    await mutate(clearSessionKeys);
  },

  /** Clears everything including the remembered company code. */
  async clearAll() {
    await mutate(async () => {
      await clearSessionKeys();
      await Promise.all([
        setOrDelete(KEYS.companyCode, null),
        setOrDelete(KEYS.tenantConfig, null),
        setOrDelete(KEYS.homeCompanyCode, null),
        setOrDelete(KEYS.homeTenantConfig, null),
      ]);
    });
  },

  async load(): Promise<PersistedAuth> {
    await mutationQueue.catch(() => undefined);
    const [
      accessToken,
      refreshToken,
      sessionCompanyCode,
      userRaw,
      companyCode,
      tenantRaw,
      homeCompanyCode,
      homeTenantRaw,
    ] = await Promise.all([
      SecureStore.getItemAsync(KEYS.accessToken),
      SecureStore.getItemAsync(KEYS.refreshToken),
      SecureStore.getItemAsync(KEYS.sessionCompanyCode),
      SecureStore.getItemAsync(KEYS.user),
      SecureStore.getItemAsync(KEYS.companyCode),
      SecureStore.getItemAsync(KEYS.tenantConfig),
      SecureStore.getItemAsync(KEYS.homeCompanyCode),
      SecureStore.getItemAsync(KEYS.homeTenantConfig),
    ]);
    const persisted: PersistedAuth = {
      accessToken,
      refreshToken,
      sessionCompanyCode,
      user: safeParse<AuthUser>(userRaw),
      companyCode: normalizeCompanyCode(companyCode),
      tenantConfig: safeParse<TenantConfig>(tenantRaw),
      homeCompanyCode: normalizeCompanyCode(homeCompanyCode),
      homeTenantConfig: safeParse<TenantConfig>(homeTenantRaw),
    };

    if (!hasValidTenantSelection(persisted)) {
      await this.clearAll().catch(() => undefined);
      return {
        accessToken: null,
        refreshToken: null,
        sessionCompanyCode: null,
        user: null,
        companyCode: null,
        tenantConfig: null,
        homeCompanyCode: null,
        homeTenantConfig: null,
      };
    }

    persisted.tenantConfig = {
      ...persisted.tenantConfig!,
      companyCode: persisted.companyCode!,
    };
    if (!hasValidTenantSession(persisted)) {
      await this.clearSession().catch(() => undefined);
      persisted.accessToken = null;
      persisted.refreshToken = null;
      persisted.sessionCompanyCode = null;
      persisted.user = null;
    }
    return persisted;
  },
};

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
