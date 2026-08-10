import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import {
  hasValidTenantSelection,
  hasValidTenantSession,
  normalizeCompanyCode,
} from '@/src/services/tenantIdentity';
import type { AuthUser, TenantConfig } from '@/src/types/api';

export type AuthState = {
  /** True once persisted state has been read from secure storage. */
  bootstrapped: boolean;
  /** Company code of the tenant currently being viewed (moves with a tenant switch). */
  companyCode: string | null;
  tenantConfig: TenantConfig | null;
  /**
   * Company code the user actually signs in with — their home tenant.
   *
   * Kept separately from `companyCode` because switching tenants moves the active
   * company code, and on sign-out the login screen must return to the code the
   * account genuinely lives under, not the last tenant that was being viewed.
   */
  homeCompanyCode: string | null;
  /** Branding for the home tenant, restored on sign-out alongside its company code. */
  homeTenantConfig: TenantConfig | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** Company code that issued the current authenticated session. */
  sessionCompanyCode: string | null;
  user: AuthUser | null;
};

const initialState: AuthState = {
  bootstrapped: false,
  companyCode: null,
  tenantConfig: null,
  homeCompanyCode: null,
  homeTenantConfig: null,
  accessToken: null,
  refreshToken: null,
  sessionCompanyCode: null,
  user: null,
};

function removeSession(state: AuthState) {
  state.accessToken = null;
  state.refreshToken = null;
  state.sessionCompanyCode = null;
  state.user = null;
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    hydrate(state, action: PayloadAction<Partial<AuthState>>) {
      Object.assign(state, action.payload);
      state.bootstrapped = true;

      if (state.companyCode) {
        state.companyCode = normalizeCompanyCode(state.companyCode);
      }
      if (state.homeCompanyCode) {
        state.homeCompanyCode = normalizeCompanyCode(state.homeCompanyCode);
      }

      if (!hasValidTenantSession(state)) {
        removeSession(state);
      }
    },
    setTenant(state, action: PayloadAction<{ companyCode: string; tenantConfig: TenantConfig }>) {
      const companyCode = normalizeCompanyCode(action.payload.companyCode);
      if (!companyCode) return;

      state.companyCode = companyCode;
      state.tenantConfig = { ...action.payload.tenantConfig, companyCode };
      state.homeCompanyCode = companyCode;
      state.homeTenantConfig = state.tenantConfig;
    },
    clearTenant(state) {
      state.companyCode = null;
      state.tenantConfig = null;
      state.homeCompanyCode = null;
      state.homeTenantConfig = null;
    },
    setCredentials(
      state,
      action: PayloadAction<{
        accessToken: string;
        companyCode: string;
        refreshToken: string;
        user: AuthUser;
      }>
    ) {
      const sessionCompanyCode = normalizeCompanyCode(action.payload.companyCode);
      if (
        !sessionCompanyCode ||
        !action.payload.accessToken ||
        !action.payload.refreshToken ||
        !action.payload.user ||
        !Number.isSafeInteger(action.payload.user.tenantId) ||
        action.payload.user.tenantId <= 0
      ) {
        removeSession(state);
        return;
      }

      if (!state.companyCode || !state.tenantConfig) {
        state.companyCode = sessionCompanyCode;
        state.tenantConfig = {
          companyCode: sessionCompanyCode,
          name: action.payload.user.companyName || 'Glivt Fleet',
          appName: 'Glivt',
          primaryColor: '#0F172A',
          secondaryColor: '#1E293B',
          enabledModules: ['LIVE_TRACKING', 'REPORTS', 'ALERTS', 'GEOFENCING'],
          paymentEnabled: false,
          maxHistoryDays: 90,
          status: 'ACTIVE',
        };
      }

      const isFreshSignIn = state.user == null;

      state.accessToken = action.payload.accessToken;
      state.refreshToken = action.payload.refreshToken;
      state.sessionCompanyCode = sessionCompanyCode;
      state.user = action.payload.user;
      if (isFreshSignIn) {
        state.homeCompanyCode = sessionCompanyCode;
        state.homeTenantConfig = state.tenantConfig;
      }
    },
    /**
     * Rebinds the session to a different tenant after a successful switch.
     */
    setActiveTenantSession(
      state,
      action: PayloadAction<{
        accessToken: string;
        refreshToken: string;
        tenantConfig: TenantConfig;
        user: AuthUser;
      }>
    ) {
      const companyCode = normalizeCompanyCode(action.payload.tenantConfig.companyCode);
      if (
        !companyCode ||
        !Number.isSafeInteger(action.payload.user.tenantId) ||
        action.payload.user.tenantId <= 0
      ) {
        return;
      }
      if (!state.homeCompanyCode) {
        state.homeCompanyCode = normalizeCompanyCode(state.companyCode);
        state.homeTenantConfig = state.tenantConfig;
      }
      state.companyCode = companyCode;
      state.tenantConfig = { ...action.payload.tenantConfig, companyCode };
      state.accessToken = action.payload.accessToken;
      state.refreshToken = action.payload.refreshToken;
      state.sessionCompanyCode = companyCode;
      state.user = action.payload.user;
    },
    clearSession(state) {
      removeSession(state);
      if (state.homeCompanyCode && state.homeTenantConfig) {
        state.companyCode = state.homeCompanyCode;
        state.tenantConfig = state.homeTenantConfig;
      }
    },
  },
});

export const {
  hydrate,
  setTenant,
  clearTenant,
  setCredentials,
  setActiveTenantSession,
  clearSession,
} = authSlice.actions;
export default authSlice.reducer;
