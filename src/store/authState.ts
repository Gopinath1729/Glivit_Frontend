import {
  hasValidTenantSession,
  normalizeCompanyCode,
} from '@/src/services/tenantIdentity';
import type { AnyAction } from '@/src/store/action';
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

export type AuthAction =
  | { type: 'auth/hydrate'; payload: Partial<AuthState> }
  | { type: 'auth/setTenant'; payload: { companyCode: string; tenantConfig: TenantConfig } }
  | { type: 'auth/clearTenant'; payload?: undefined }
  | {
      type: 'auth/setCredentials';
      payload: {
        accessToken: string;
        companyCode: string;
        refreshToken: string;
        user: AuthUser;
      };
    }
  | {
      type: 'auth/setActiveTenantSession';
      payload: {
        accessToken: string;
        refreshToken: string;
        tenantConfig: TenantConfig;
        user: AuthUser;
      };
    }
  | { type: 'auth/clearSession'; payload?: undefined };

export const hydrate = (payload: Partial<AuthState>): AuthAction => ({
  type: 'auth/hydrate',
  payload,
});

export const setTenant = (payload: {
  companyCode: string;
  tenantConfig: TenantConfig;
}): AuthAction => ({ type: 'auth/setTenant', payload });

export const clearTenant = (): AuthAction => ({ type: 'auth/clearTenant' });

export const setCredentials = (payload: {
  accessToken: string;
  companyCode: string;
  refreshToken: string;
  user: AuthUser;
}): AuthAction => ({ type: 'auth/setCredentials', payload });

/** Rebinds the session to a different tenant after a successful switch. */
export const setActiveTenantSession = (payload: {
  accessToken: string;
  refreshToken: string;
  tenantConfig: TenantConfig;
  user: AuthUser;
}): AuthAction => ({ type: 'auth/setActiveTenantSession', payload });

export const clearSession = (): AuthAction => ({ type: 'auth/clearSession' });

function isAuthAction(action: AnyAction): action is AuthAction {
  return action.type.startsWith('auth/');
}

/**
 * Drops the authenticated session, keeping the tenant selection.
 *
 * Returns the state unchanged when there is no session to drop, so repeating a
 * sign-out — which the logout flow does, defensively — cannot churn every
 * subscriber for no reason.
 */
function withoutSession(state: AuthState): AuthState {
  if (
    state.accessToken === null &&
    state.refreshToken === null &&
    state.sessionCompanyCode === null &&
    state.user === null
  ) {
    return state;
  }
  return {
    ...state,
    accessToken: null,
    refreshToken: null,
    sessionCompanyCode: null,
    user: null,
  };
}

function isUsableTenantId(user: AuthUser | null | undefined): boolean {
  return Boolean(user && Number.isSafeInteger(user.tenantId) && user.tenantId > 0);
}

export default function authReducer(
  state: AuthState = initialState,
  action: AnyAction
): AuthState {
  if (!isAuthAction(action)) return state;

  switch (action.type) {
    case 'auth/hydrate': {
      const merged: AuthState = { ...state, ...action.payload, bootstrapped: true };
      const normalized: AuthState = {
        ...merged,
        companyCode: merged.companyCode ? normalizeCompanyCode(merged.companyCode) : merged.companyCode,
        homeCompanyCode: merged.homeCompanyCode
          ? normalizeCompanyCode(merged.homeCompanyCode)
          : merged.homeCompanyCode,
      };
      // A restored session that no longer hangs together — a token without a
      // matching company code, a user without a tenant — is not a session.
      return hasValidTenantSession(normalized) ? normalized : withoutSession(normalized);
    }

    case 'auth/setTenant': {
      const companyCode = normalizeCompanyCode(action.payload.companyCode);
      if (!companyCode) return state;
      const tenantConfig: TenantConfig = { ...action.payload.tenantConfig, companyCode };
      return {
        ...state,
        companyCode,
        tenantConfig,
        homeCompanyCode: companyCode,
        homeTenantConfig: tenantConfig,
      };
    }

    case 'auth/clearTenant':
      return {
        ...state,
        companyCode: null,
        tenantConfig: null,
        homeCompanyCode: null,
        homeTenantConfig: null,
      };

    case 'auth/setCredentials': {
      const { accessToken, refreshToken, user } = action.payload;
      const sessionCompanyCode = normalizeCompanyCode(action.payload.companyCode);
      if (
        !sessionCompanyCode ||
        !accessToken ||
        !refreshToken ||
        !user ||
        !isUsableTenantId(user)
      ) {
        return withoutSession(state);
      }

      // Signing in without a resolved tenant (a direct login, or a restored
      // session whose branding was lost) still needs something to render, so a
      // minimal configuration is derived from the session itself.
      let companyCode = state.companyCode;
      let tenantConfig = state.tenantConfig;
      if (!companyCode || !tenantConfig) {
        companyCode = sessionCompanyCode;
        tenantConfig = {
          companyCode: sessionCompanyCode,
          name: user.companyName || 'Glivt Fleet',
          appName: 'Glivt',
          primaryColor: '#0F172A',
          secondaryColor: '#1E293B',
          enabledModules: ['LIVE_TRACKING', 'REPORTS', 'ALERTS', 'GEOFENCING'],
          paymentEnabled: false,
          maxHistoryDays: 90,
          status: 'ACTIVE',
        };
      }

      // Only a genuinely new sign-in re-homes the account. A token refresh
      // arrives here too, and it must not move the home tenant of a user who is
      // currently viewing a different one.
      const isFreshSignIn = state.user == null;

      return {
        ...state,
        companyCode,
        tenantConfig,
        accessToken,
        refreshToken,
        sessionCompanyCode,
        user,
        homeCompanyCode: isFreshSignIn ? sessionCompanyCode : state.homeCompanyCode,
        homeTenantConfig: isFreshSignIn ? tenantConfig : state.homeTenantConfig,
      };
    }

    case 'auth/setActiveTenantSession': {
      const { accessToken, refreshToken, user } = action.payload;
      const companyCode = normalizeCompanyCode(action.payload.tenantConfig.companyCode);
      if (!companyCode || !isUsableTenantId(user)) return state;

      // The first switch of a session is what establishes where "home" was.
      const hasHome = Boolean(state.homeCompanyCode);
      const tenantConfig: TenantConfig = { ...action.payload.tenantConfig, companyCode };

      return {
        ...state,
        homeCompanyCode: hasHome ? state.homeCompanyCode : normalizeCompanyCode(state.companyCode),
        homeTenantConfig: hasHome ? state.homeTenantConfig : state.tenantConfig,
        companyCode,
        tenantConfig,
        accessToken,
        refreshToken,
        sessionCompanyCode: companyCode,
        user,
      };
    }

    case 'auth/clearSession': {
      const cleared = withoutSession(state);
      // Sign-out returns to the tenant the account actually belongs to, not
      // whichever one was last being viewed.
      if (state.homeCompanyCode && state.homeTenantConfig) {
        if (
          cleared.companyCode === state.homeCompanyCode &&
          cleared.tenantConfig === state.homeTenantConfig
        ) {
          return cleared;
        }
        return {
          ...cleared,
          companyCode: state.homeCompanyCode,
          tenantConfig: state.homeTenantConfig,
        };
      }
      return cleared;
    }

    default:
      return state;
  }
}
