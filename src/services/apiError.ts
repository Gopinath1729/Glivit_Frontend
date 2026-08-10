import type { ApiResponse } from '@/src/types/api';

/** Extracts a user-facing message from an RTK Query error, hiding internals. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as { data?: ApiResponse<unknown>; status?: number | string };
  // Connectivity issues must never be reported as a domain error (e.g. bad code).
  if (e.status === 'FETCH_ERROR' || e.status === 'TIMEOUT_ERROR') {
    return 'Cannot reach the server. Check the backend URL and your connection.';
  }
  if (e.status === 'CUSTOM_ERROR') {
    return e.data?.error?.message ?? fallback;
  }
  // A 5xx used to be reported as a bare "Server error", which discarded the
  // envelope the backend actually sent — including the correlation id needed to
  // find the failure in the server log. Prefer the real message when there is
  // one, and fall back to the generic text only when there is not.
  const serverMessage = e.data?.error?.message;
  if (typeof e.status === 'number' && e.status >= 500) {
    const correlationId = e.data?.correlationId;
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
