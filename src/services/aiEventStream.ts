/**
 * Real-time AI incident stream.
 *
 * A single SSE connection per logged-in session, shared by every subscriber.
 * The connection is reference-counted, so mounting the command centre, the map
 * and a notification badge at the same time still opens exactly ONE stream —
 * opening several would multiply notifications and server-side emitters.
 *
 * The connection carries the JWT, reconnects with backoff (handled inside
 * `openSse`), closes on logout, and resets when the tenant changes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { env } from '@/src/config/env';
import { aiApi, type AiEventDto } from '@/src/services/aiApi';
import { openSse, type SseConnection } from '@/src/services/sseClient';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';

/** How many recent incidents are kept in memory for the badge/list. */
const MAX_BUFFERED_EVENTS = 100;

export type AiStreamState = {
  connected: boolean;
  events: AiEventDto[];
  unreadCount: number;
};

type Listener = (state: AiStreamState) => void;

type SharedStream = {
  key: string;
  connection: SseConnection | null;
  refCount: number;
  listeners: Set<Listener>;
  state: AiStreamState;
  /** Incident ids already delivered, so a reconnect cannot duplicate alerts. */
  seen: Set<number>;
  readIds: Set<number>;
};

const EMPTY_STATE: AiStreamState = { connected: false, events: [], unreadCount: 0 };

let shared: SharedStream | null = null;

function notify(stream: SharedStream) {
  for (const listener of stream.listeners) listener(stream.state);
}

function setState(stream: SharedStream, next: Partial<AiStreamState>) {
  stream.state = { ...stream.state, ...next };
  notify(stream);
}

function parseEvent(data: string): AiEventDto | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<AiEventDto>;
    if (typeof candidate.id !== 'number' || typeof candidate.eventType !== 'string') {
      return null;
    }
    return candidate as AiEventDto;
  } catch {
    return null;
  }
}

function teardown() {
  if (!shared) return;
  shared.connection?.close();
  shared.connection = null;
  shared = null;
}

/**
 * Subscribe to the tenant's AI incident stream.
 *
 * @param enabled pass false to keep the stream closed (e.g. logged out)
 */
export function useAiEventStream(enabled = true): AiStreamState & {
  markAllRead: () => void;
  markRead: (id: number) => void;
} {
  const dispatch = useAppDispatch();
  const token = useAppSelector((s) => s.auth.accessToken);
  const tenantEpoch = useAppSelector((s) => s.tenant.epoch);
  const activeTenantId = useAppSelector(
    (s) => s.auth.user?.tenantId ?? s.tenant.activeTenantId
  );

  const [state, setLocalState] = useState<AiStreamState>(EMPTY_STATE);
  const streamRef = useRef<SharedStream | null>(null);

  // Identity of the stream: a change here means the previous stream belonged to
  // a different session or tenant and must be torn down, not reused.
  const key = useMemo(
    () => `${token ?? 'anon'}|${activeTenantId ?? 'none'}|${tenantEpoch}`,
    [token, activeTenantId, tenantEpoch]
  );

  useEffect(() => {
    // No token means logged out: stop reconnecting entirely.
    if (!enabled || !token || !env.backendBaseUrl || env.demoMode) {
      setLocalState(EMPTY_STATE);
      return;
    }

    if (shared && shared.key !== key) {
      // Tenant switched or the session changed — drop the old stream and its buffer.
      teardown();
    }

    if (!shared) {
      const stream: SharedStream = {
        key,
        connection: null,
        refCount: 0,
        listeners: new Set(),
        state: EMPTY_STATE,
        seen: new Set(),
        readIds: new Set(),
      };
      shared = stream;

      stream.connection = openSse(`${env.apiBaseUrl}/ai/stream`, token, {
        onOpen: () => setState(stream, { connected: true }),
        onError: () => setState(stream, { connected: false }),
        onEvent: (name, data) => {
          if (name !== 'AI_EVENT') return;
          const event = parseEvent(data);
          if (!event) return;

          // Suppress duplicates: the backend only broadcasts new or escalated
          // incidents, but a reconnect could still replay one.
          if (stream.seen.has(event.id)) {
            const events = stream.state.events.map((existing) =>
              existing.id === event.id ? event : existing
            );
            setState(stream, { events });
            return;
          }
          stream.seen.add(event.id);

          const events = [event, ...stream.state.events].slice(0, MAX_BUFFERED_EVENTS);
          const unreadCount = events.filter(
            (item) => !item.acknowledged && !stream.readIds.has(item.id)
          ).length;
          setState(stream, { connected: true, events, unreadCount });

          // Keep cached lists and dashboard counters honest without a refetch storm.
          dispatch(aiApi.util.invalidateTags(['Event', 'Dashboard']));
        },
      });
    }

    const stream = shared;
    streamRef.current = stream;
    stream.refCount += 1;

    const listener: Listener = (next) => setLocalState(next);
    stream.listeners.add(listener);
    setLocalState(stream.state);

    return () => {
      stream.listeners.delete(listener);
      stream.refCount -= 1;
      // Only the last subscriber leaving closes the shared connection.
      if (stream.refCount <= 0 && shared === stream) {
        teardown();
      }
    };
  }, [enabled, token, key, dispatch]);

  return {
    ...state,
    markAllRead: () => {
      const stream = streamRef.current;
      if (!stream) return;
      for (const event of stream.state.events) stream.readIds.add(event.id);
      setState(stream, { unreadCount: 0 });
    },
    markRead: (id: number) => {
      const stream = streamRef.current;
      if (!stream) return;
      stream.readIds.add(id);
      const unreadCount = stream.state.events.filter(
        (item) => !item.acknowledged && !stream.readIds.has(item.id)
      ).length;
      setState(stream, { unreadCount });
    },
  };
}

/** Called on logout so no reconnect attempt outlives the session. */
export function closeAiEventStream(): void {
  teardown();
}
