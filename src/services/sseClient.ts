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

import { COMMON_API_HEADERS } from '@/src/config/env';

export type SseHandlers = {
  onEvent: (eventName: string, data: string) => void;
  onOpen?: () => void;
  onError?: (error: unknown) => void;
  /** Called when a reconnect is scheduled, with the delay and attempt number. */
  onRetryScheduled?: (delayMs: number, attempt: number) => void;
};

/**
 * How the caller supplies credentials.
 *
 * A function is strongly preferred. Access tokens are rotated on refresh, and
 * passing a string means the caller has to tear the stream down and rebuild it
 * every time that happens - which drops live updates on a schedule and is one of
 * the ways a vehicle used to disappear from the map for minutes at a time. A
 * provider is read at connect time instead, so a rotation costs nothing and a
 * reconnect always uses the current token.
 */
export type SseTokenSource = string | null | (() => string | null);

export type SseConnection = {
  close: () => void;
};

/** First reconnect delay; doubles on each consecutive failure. */
const RETRY_MS = 3000;
/** Ceiling for the backoff, so a long outage settles at one attempt a minute. */
const MAX_RETRY_MS = 60000;
/** A rejected token gets a longer floor than a network blip. */
const AUTH_RETRY_MS = 15000;

/**
 * Recycle the connection once the buffered response reaches this size.
 *
 * `responseText` accumulates the whole stream for the life of the request — the
 * parser advances an offset through it but cannot release what it has passed.
 * On a live map that is a few hundred bytes per vehicle per fix, so an
 * all-day session grows the buffer without limit until the app is killed.
 * Reconnecting drops the buffer; the server re-sends current state on connect.
 */
const MAX_BUFFERED_BYTES = 512 * 1024;

export function openSse(
  url: string,
  token: SseTokenSource,
  handlers: SseHandlers
): SseConnection {
  const readToken = (): string | null =>
    typeof token === 'function' ? token() : token;
  let xhr: XMLHttpRequest | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let consecutiveFailures = 0;

  /** Exponential backoff with jitter, so a restarting backend is not stampeded. */
  function backoffMs(status: number): number {
    const floor = status === 401 || status === 403 ? AUTH_RETRY_MS : RETRY_MS;
    const grown = Math.min(floor * 2 ** Math.min(consecutiveFailures, 6), MAX_RETRY_MS);
    return Math.round(grown * (0.5 + Math.random() * 0.5));
  }

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

      const delay = backoffMs(status);
      consecutiveFailures += 1;
      handlers.onRetryScheduled?.(delay, consecutiveFailures);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (closed || generation !== attempt) return;
        connect();
      }, delay);
      handlers.onError?.(error ?? new Error(`SSE closed (status ${status})`));
    };

    /** Drops the grown response buffer by reconnecting straight away. */
    const recycle = () => {
      if (!isCurrentAttempt() || reconnectScheduled) return;
      reconnectScheduled = true;
      abortRequest();
      connect();
    };

    const parse = (text: string) => {
      // Both LF and CRLF are valid SSE line endings. Spring normally emits LF,
      // but reverse proxies (including tunnel/proxy combinations used by APK
      // testing) may preserve or normalise to CRLF. Looking only for `\n\n`
      // leaves a CRLF stream permanently buffered with zero POSITION events.
      const nextBoundary = () => {
        const lf = text.indexOf('\n\n', parseOffset);
        const crlf = text.indexOf('\r\n\r\n', parseOffset);
        if (lf === -1) return crlf === -1 ? null : { index: crlf, width: 4 };
        if (crlf === -1 || lf < crlf) return { index: lf, width: 2 };
        return { index: crlf, width: 4 };
      };
      let boundary = nextBoundary();
      while (boundary && isCurrentAttempt()) {
        const frame = text.slice(parseOffset, boundary.index);
        parseOffset = boundary.index + boundary.width;

        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
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
        boundary = nextBoundary();
      }
    };

    request.open('GET', url, true);
    request.setRequestHeader('Accept', 'text/event-stream');
    request.setRequestHeader('Cache-Control', 'no-cache');
    // A tunnel's interstitial would arrive as an HTML body on a stream the
    // parser expects SSE frames on, so it never opens and never errors either.
    for (const [name, value] of Object.entries(COMMON_API_HEADERS)) {
      request.setRequestHeader(name, value);
    }
    // Read at connect time, never captured: a rotated token is picked up by the
    // next reconnect without the caller having to restart the stream.
    const bearer = readToken();
    if (bearer) {
      request.setRequestHeader('Authorization', `Bearer ${bearer}`);
    }

    request.onreadystatechange = () => {
      if (!isCurrentAttempt() || reconnectScheduled) return;
      if (request.readyState === 3) {
        if (request.status === 200) {
          if (!opened) {
            opened = true;
            // A stream that reached us is not a failure, whatever came before.
            consecutiveFailures = 0;
            handlers.onOpen?.();
          }
          const text = request.responseText;
          parse(text);
          if (text.length >= MAX_BUFFERED_BYTES) {
            // Not an error: reconnect immediately to release the buffer.
            recycle();
          }
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
