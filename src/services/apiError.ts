import type { ApiResponse } from '@/src/types/api';

/** Extracts a user-facing message from a base query error, hiding internals. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as {
    data?: ApiResponse<unknown> | string;
    error?: string;
    originalStatus?: number;
    status?: number | string;
  };
  // Connectivity issues must never be reported as a domain error (e.g. bad code).
  if (e.status === 'FETCH_ERROR' || e.status === 'TIMEOUT_ERROR') {
    return 'Cannot reach the server. Check the backend URL and your connection.';
  }
  // A reverse proxy/tunnel commonly sends an HTML error page. fetchBaseQuery
  // cannot parse that as the expected JSON envelope and reports PARSING_ERROR;
  // falling through to a screen fallback used to turn ngrok 502 pages into
  // "Invalid company code", hiding the actual endpoint failure.
  if (e.status === 'PARSING_ERROR') {
    const httpStatus = e.originalStatus ? ` (HTTP ${e.originalStatus})` : '';
    return `The server returned an unexpected response${httpStatus}. Check the backend URL or gateway.`;
  }
  if (e.status === 'CUSTOM_ERROR') {
    return typeof e.data === 'object' ? e.data?.error?.message ?? fallback : fallback;
  }
  // A 5xx used to be reported as a bare "Server error", which discarded the
  // envelope the backend actually sent — including the correlation id needed to
  // find the failure in the server log. Prefer the real message when there is
  // one, and fall back to the generic text only when there is not.
  const serverMessage = typeof e.data === 'object' ? e.data?.error?.message : undefined;
  if (typeof e.status === 'number' && e.status >= 500) {
    const correlationId = typeof e.data === 'object' ? e.data?.correlationId : undefined;
    if (serverMessage) {
      return correlationId ? `${serverMessage} (ref ${correlationId})` : serverMessage;
    }
    return correlationId
      ? `Server error. Please try again later. (ref ${correlationId})`
      : 'Server error. Please try again later.';
  }
  if (serverMessage) return serverMessage;
  return fallback;
}

export function apiErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { data?: ApiResponse<unknown> };
  return e.data?.error?.code ?? null;
}
