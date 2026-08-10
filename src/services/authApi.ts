import { Platform } from 'react-native';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';

import { baseApi, unwrap } from '@/src/services/baseApi';
import { env } from '@/src/config/env';
import type { ApiResponse, TokenResponse } from '@/src/types/api';

export type LoginArgs = {
  companyCode: string;
  username: string;
  password: string;
  fcmToken?: string;
  deviceInfo?: string;
};

const DEMO_LOGIN_TIMEOUT_MS = 10000;
const DEMO_HEALTH_TIMEOUT_MS = 5000;
const DEMO_LOGIN_ATTEMPTS = 1;

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function customError(code: string, message: string): FetchBaseQueryError {
  return {
    status: 'CUSTOM_ERROR',
    error: message,
    data: {
      success: false,
      data: null,
      error: { code, message },
    },
  };
}

function networkError(message: string): FetchBaseQueryError {
  return {
    status: 'FETCH_ERROR',
    error: message,
  };
}

function timeoutError(message: string): FetchBaseQueryError {
  return {
    status: 'TIMEOUT_ERROR',
    error: message,
  };
}

function httpError(status: number, envelope?: ApiResponse<unknown>): FetchBaseQueryError {
  return {
    status,
    data:
      envelope ?? {
        success: false,
        data: null,
        error: { code: 'HTTP_ERROR', message: `Server returned HTTP ${status}` },
      },
  };
}

async function parseEnvelope<T>(response: Response): Promise<ApiResponse<T> | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return undefined;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function logDemoNetworkIssue(stage: string, detail: string) {
  if (__DEV__) {
    console.warn(`[demo-login] ${stage}: ${detail}`);
  }
}

function safeErrorMessage(error: unknown): string {
  if (isAbort(error)) return 'request timed out';
  if (error instanceof Error && error.message) return error.message;
  return 'network request failed';
}

async function healthCheck(): Promise<boolean> {
  const url = joinUrl(env.backendBaseUrl, '/actuator/health');
  logDemoNetworkIssue('config', `resolved backend URL: ${env.backendBaseUrl}`);
  logDemoNetworkIssue('health-check', `GET ${url}`);
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, DEMO_HEALTH_TIMEOUT_MS);
    logDemoNetworkIssue('health-check', `status ${response.status}`);
    if (!response.ok) {
      logDemoNetworkIssue('health-check', `HTTP ${response.status} from backend health endpoint`);
      return false;
    }
    return true;
  } catch (error) {
    logDemoNetworkIssue('health-check', safeErrorMessage(error));
    return false;
  }
}

async function superAdminDemoLoginRequest() {
  if (!env.backendBaseUrl && Platform.OS !== 'web' && !__DEV__) {
    logDemoNetworkIssue('config', 'missing EXPO_PUBLIC_BACKEND_BASE_URL');
    return { error: customError('BACKEND_URL_MISSING', 'Backend URL is not configured for this mobile build.') };
  }

  if (env.backendBaseUrl) {
    const healthy = await healthCheck();
    if (!healthy && __DEV__) {
      logDemoNetworkIssue(
        'health-check',
        'health endpoint unavailable; continuing to demo auth endpoint'
      );
    }
  }

  const endpoints = ['/auth/demo/super-admin', '/auth/demo-login'];
  let lastError: unknown = null;

  for (const endpoint of endpoints) {
    const url = joinUrl(env.apiBaseUrl, endpoint);
    try {
      logDemoNetworkIssue('demo-login', `POST ${url}`);
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        },
        DEMO_LOGIN_TIMEOUT_MS
      );
      logDemoNetworkIssue('demo-login', `status ${response.status}`);
      const envelope = await parseEnvelope<TokenResponse>(response);

      if (response.status === 404) {
        logDemoNetworkIssue('demo-login', `${endpoint} 404; trying fallback endpoint`);
        continue;
      }

      if (!response.ok) {
        logDemoNetworkIssue('demo-login', `HTTP ${response.status} from ${endpoint}`);
        return { error: httpError(response.status, envelope) };
      }

      const tokens = envelope?.data;
      if (!tokens?.accessToken || !tokens.refreshToken || !tokens.user) {
        logDemoNetworkIssue('demo-login', 'backend response did not include a valid token payload');
        return {
          error: customError('INVALID_DEMO_RESPONSE', 'Demo login returned an invalid session.'),
        };
      }
      return { data: tokens };
    } catch (error) {
      lastError = error;
      logDemoNetworkIssue('demo-login', `${safeErrorMessage(error)} on ${endpoint}`);
    }
  }

  return {
    error: isAbort(lastError)
      ? timeoutError('Demo login timed out. Check that the backend is running on port 8085.')
      : customError(
          'BACKEND_UNAVAILABLE',
          `Cannot reach backend. Verify backend is running on port 8085 and network connection is active.`
        ),
  };
}

async function roleDemoLoginRequest(role: 'admin' | 'driver') {
  if (!env.backendBaseUrl && Platform.OS !== 'web' && !__DEV__) {
    return { error: customError('BACKEND_URL_MISSING', 'Backend URL is not configured for this mobile build.') };
  }

  const endpoint = `/auth/demo/${role}`;
  const url = joinUrl(env.apiBaseUrl, endpoint);
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      },
      DEMO_LOGIN_TIMEOUT_MS
    );
    const envelope = await parseEnvelope<TokenResponse>(response);
    if (!response.ok) {
      return { error: httpError(response.status, envelope) };
    }
    const tokens = envelope?.data;
    if (!tokens?.accessToken || !tokens.refreshToken || !tokens.user) {
      return {
        error: customError('INVALID_DEMO_RESPONSE', 'Demo login returned an invalid session.'),
      };
    }
    return { data: tokens };
  } catch (error) {
    return {
      error: customError(
        'BACKEND_UNAVAILABLE',
        `Cannot reach backend. Verify backend is running on port 8085.`
      ),
    };
  }
}

export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    login: build.mutation<TokenResponse, LoginArgs>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      transformResponse: (response: ApiResponse<TokenResponse>) => unwrap(response),
    }),
    demoLogin: build.mutation<TokenResponse, void>({
      queryFn: superAdminDemoLoginRequest,
    }),
    adminDemoLogin: build.mutation<TokenResponse, void>({
      queryFn: () => roleDemoLoginRequest('admin'),
    }),
    driverDemoLogin: build.mutation<TokenResponse, void>({
      queryFn: () => roleDemoLoginRequest('driver'),
    }),
    logout: build.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
    }),
  }),
});

export const {
  useAdminDemoLoginMutation,
  useDemoLoginMutation,
  useDriverDemoLoginMutation,
  useLoginMutation,
  useLogoutMutation,
} = authApi;
