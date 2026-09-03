import { COMMON_API_HEADERS, env } from '@/src/config/env';
import { authStorage } from '@/src/services/authStorage';
import {
  createFetchBaseQuery,
  type BaseQueryApi,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@/src/services/httpQuery';
import { createApiClient } from '@/src/services/queryClient';
import { normalizeCompanyCode } from '@/src/services/tenantIdentity';
import { clearSession, setCredentials, type AuthState } from '@/src/store/authState';
import { store, type AppAction, type RootState } from '@/src/store/store';
import type { ApiResponse, TokenResponse } from '@/src/types/api';

type Api = BaseQueryApi<RootState, AppAction>;

/** Header the backend compares against the tenant signed into the access token. */
const TENANT_HEADER = 'X-Tenant-Id';

/** Error surfaced when a response outlived the tenant it was requested for. */
const TENANT_CHANGED_ERROR = 'TENANT_CHANGED';

// ---------------------------------------------------------------------------
// In-flight request tracking
// ---------------------------------------------------------------------------
const inFlight = new Set<AbortController>();

/** Aborts every request currently on the wire. Called at the start of a switch. */
export function abortInFlightRequests(): void {
  const controllers = Array.from(inFlight);
  inFlight.clear();
  for (const controller of controllers) {
    try {
      controller.abort();
    } catch {
      // Already settled; nothing to cancel.
    }
  }
}

const cancellableFetch: typeof fetch = (input, init) => {
  const controller = new AbortController();
  inFlight.add(controller);

  const upstream = init?.signal;
  if (upstream) {
    if (upstream.aborted) {
      controller.abort();
    } else {
      upstream.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  return fetch(input as RequestInfo, { ...init, signal: controller.signal }).finally(() => {
    inFlight.delete(controller);
  });
};

const rawBaseQuery = createFetchBaseQuery<RootState, AppAction>({
  baseUrl: env.apiBaseUrl,
  fetchFn: cancellableFetch,
  prepareHeaders: (headers, { getState }) => {
    for (const [name, value] of Object.entries(COMMON_API_HEADERS)) {
      headers.set(name, value);
    }
    const state = getState();
    if (state.auth.accessToken) {
      headers.set('Authorization', `Bearer ${state.auth.accessToken}`);
    }
    const activeTenantId = state.auth.user?.tenantId ?? state.tenant.activeTenantId;
    if (Number.isSafeInteger(activeTenantId) && (activeTenantId as number) > 0) {
      headers.set(TENANT_HEADER, String(activeTenantId));
    }
    return headers;
  },
});

function isAuthEndpoint(args: string | FetchArgs): boolean {
  const url = typeof args === 'string' ? args : args.url;
  return url.startsWith('/auth/') || url.startsWith('/tenant/');
}

/** Tenant switching itself must not be discarded by the stale-tenant guard. */
function isTenantSwitchEndpoint(args: string | FetchArgs): boolean {
  const url = typeof args === 'string' ? args : args.url;
  return url.startsWith('/tenants');
}

type SessionSnapshot = {
  companyCode: string;
  refreshToken: string;
  tenantId: number;
};

// One refresh per tenant session; an old tenant can never refresh into a new one.
const refreshInFlight = new Map<string, Promise<boolean>>();

function sessionMatches(auth: AuthState, snapshot: SessionSnapshot): boolean {
  return (
    normalizeCompanyCode(auth.companyCode) === snapshot.companyCode &&
    auth.refreshToken === snapshot.refreshToken &&
    auth.user?.tenantId === snapshot.tenantId
  );
}

async function clearCurrentSession(api: Api, snapshot?: SessionSnapshot) {
  const auth = api.getState().auth;
  if (snapshot && !sessionMatches(auth, snapshot)) return;
  api.dispatch(clearSession());
  baseApi.util.resetApiState();
  await authStorage.clearSession().catch(() => undefined);
}

const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  RootState,
  AppAction
> = async (args, api, extraOptions) => {
  let result = await rawBaseQuery(args, api, extraOptions);

  if (result.error?.status === 401 && !isAuthEndpoint(args)) {
    const auth = api.getState().auth;
    if (!auth.accessToken || !auth.user || !auth.user.tenantId) {
      await clearCurrentSession(api);
      return result;
    }
    if (!auth.refreshToken) {
      await clearCurrentSession(api);
      return result;
    }

    const sessionCode = normalizeCompanyCode(auth.sessionCompanyCode ?? auth.companyCode);
    if (!sessionCode) {
      await clearCurrentSession(api);
      return result;
    }
    const snapshot: SessionSnapshot = {
      companyCode: sessionCode,
      refreshToken: auth.refreshToken,
      tenantId: auth.user.tenantId,
    };
    const refreshKey = `${snapshot.companyCode}:${snapshot.tenantId}:${snapshot.refreshToken}`;
    let refresh = refreshInFlight.get(refreshKey);

    if (!refresh) {
      refresh = (async () => {
        const refreshResult = await rawBaseQuery(
          { url: '/auth/refresh', method: 'POST', body: { refreshToken: snapshot.refreshToken } },
          api,
          extraOptions
        );

        if (refreshResult.error) {
          // Clear session ONLY if refresh explicitly returns 401 Unauthorized (token invalid/expired).
          // Network glitches, 5xx server errors, or timeouts do NOT destroy the user's session.
          if (refreshResult.error.status === 401) {
            await clearCurrentSession(api, snapshot);
          }
          return false;
        }

        const envelope = refreshResult.data as ApiResponse<TokenResponse> | undefined;
        const tokens = envelope?.data;
        if (
          tokens?.accessToken &&
          tokens.refreshToken &&
          tokens.user?.tenantId === snapshot.tenantId
        ) {
          try {
            await authStorage.saveSession({
              accessToken: tokens.accessToken,
              companyCode: snapshot.companyCode,
              refreshToken: tokens.refreshToken,
              user: tokens.user,
            });
          } catch {
            await clearCurrentSession(api, snapshot);
            return false;
          }
          api.dispatch(
            setCredentials({
              accessToken: tokens.accessToken,
              companyCode: snapshot.companyCode,
              refreshToken: tokens.refreshToken,
              user: tokens.user,
            })
          );
          return true;
        }
        await clearCurrentSession(api, snapshot);
        return false;
      })().finally(() => {
        refreshInFlight.delete(refreshKey);
      });
      refreshInFlight.set(refreshKey, refresh);
    }

    const refreshed = await refresh;
    if (refreshed) {
      result = await rawBaseQuery(args, api, extraOptions);
    }
  }

  return result;
};

/** Unwraps the backend ApiResponse envelope to the payload. */
export function unwrap<T>(response: ApiResponse<T>): T {
  return response.data as T;
}

const hybridBaseQuery: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  RootState,
  AppAction
> = async (args, api, extraOptions) => {
  const before = api.getState().tenant;
  const issuedEpoch = before?.epoch ?? 0;
  const issuedTenantId = before?.activeTenantId ?? null;

  const result = await baseQueryWithReauth(args, api, extraOptions);

  const after = api.getState().tenant;
  const tenantChanged =
    (after?.epoch ?? 0) !== issuedEpoch || (after?.activeTenantId ?? null) !== issuedTenantId;
  if (tenantChanged && !isTenantSwitchEndpoint(args) && !isAuthEndpoint(args)) {
    return {
      error: {
        status: 'CUSTOM_ERROR',
        error: TENANT_CHANGED_ERROR,
        data: TENANT_CHANGED_ERROR,
      },
    };
  }

  return result;
};

export const baseApi = createApiClient<RootState, AppAction>({
  baseQuery: hybridBaseQuery,
  getApi: () => ({ getState: store.getState, dispatch: store.dispatch }),
  tagTypes: [
    'Audit',
    'Command',
    'Dashboard',
    'Device',
    'Event',
    'Geofence',
    'Group',
    'Report',
    'Settings',
    'Tenant',
    'User',
    'VehicleDocument',
  ],
});
