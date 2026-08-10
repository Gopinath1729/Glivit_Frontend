/**
 * Minimal Server-Sent Events client for React Native / Expo.
 *
 * The browser `EventSource` is unavailable in RN and cannot send an
 * `Authorization` header anyway, so this reads the stream over `XMLHttpRequest`
 * (which RN supports incrementally at readyState 3) and parses SSE frames from
 * the growing `responseText`. It reconnects automatically with a backoff that
 * is longer on auth failures so a bad token never hammers the server.
 *
 * No external dependency — keeps the native footprint unchanged.
 */

export type SseHandlers = {
  onEvent: (eventName: string, data: string) => void;
  onOpen?: () => void;
  onError?: (error: unknown) => void;
};

export type SseConnection = {
  close: () => void;
};

const RETRY_MS = 3000;
const AUTH_RETRY_MS = 15000;

export function openSse(url: string, token: string | null, handlers: SseHandlers): SseConnection {
  let xhr: XMLHttpRequest | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  function connect() {
    if (closed) return;

    const attempt = ++generation;
    const request = new XMLHttpRequest();
    let opened = false;
    let parseOffset = 0;
    let reconnectScheduled = false;
    xhr = request;

    const isCurrentAttempt = () =>
      !closed && generation === attempt && xhr === request;

    const clearRequest = () => {
      request.onreadystatechange = null;
      request.onerror = null;
    };

    const abortRequest = () => {
      clearRequest();
      try {
        request.abort();
      } catch {
        // The request may already be complete or unavailable.
      }
      if (xhr === request) xhr = null;
    };

    const scheduleReconnect = (status: number, error?: unknown) => {
      if (!isCurrentAttempt() || reconnectScheduled) return;
      reconnectScheduled = true;
      abortRequest();

      const delay = status === 401 || status === 403 ? AUTH_RETRY_MS : RETRY_MS;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (closed || generation !== attempt) return;
        connect();
      }, delay);
      handlers.onError?.(error ?? new Error(`SSE closed (status ${status})`));
    };

    const parse = (text: string) => {
      let boundary = text.indexOf('\n\n', parseOffset);
      while (boundary !== -1 && isCurrentAttempt()) {
        const frame = text.slice(parseOffset, boundary);
        parseOffset = boundary + 2;

        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue; // comment / keep-alive
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
        }
        if (dataLines.length > 0) {
          handlers.onEvent(eventName, dataLines.join('\n'));
        }
        boundary = text.indexOf('\n\n', parseOffset);
      }
    };

    request.open('GET', url, true);
    request.setRequestHeader('Accept', 'text/event-stream');
    request.setRequestHeader('Cache-Control', 'no-cache');
    if (token) {
      request.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    request.onreadystatechange = () => {
      if (!isCurrentAttempt() || reconnectScheduled) return;
      if (request.readyState === 3) {
        if (request.status === 200) {
          if (!opened) {
            opened = true;
            handlers.onOpen?.();
          }
          parse(request.responseText);
        }
      } else if (request.readyState === 4) {
        scheduleReconnect(request.status);
      }
    };
    request.onerror = () => {
      scheduleReconnect(request.status);
    };

    try {
      request.send();
    } catch (err) {
      scheduleReconnect(0, err);
    }
  }

  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const request = xhr;
      xhr = null;
      if (!request) return;
      request.onreadystatechange = null;
      request.onerror = null;
      try {
        request.abort();
      } catch {
        // ignore abort errors
      }
    },
  };
}
