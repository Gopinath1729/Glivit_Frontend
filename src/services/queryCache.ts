import type {
  BaseQueryApi,
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
  QueryReturnValue,
} from '@/src/services/httpQuery';

/**
 * The app's data-fetching cache, independent of React.
 *
 * <p>One entry per (endpoint, argument) pair, shared by every component that
 * asks for it. Most of the behaviour worth knowing follows from four rules:
 *
 * <h3>1. An argument identifies a cache entry</h3>
 * Arguments are serialised with sorted keys, so `{page: 0, size: 20}` and
 * `{size: 20, page: 0}` are the same entry. Two screens asking for the same
 * data share one request and one result; a screen changing its arguments moves
 * to a different entry rather than overwriting the old one.
 *
 * <h3>2. A request is described by tags, and a write invalidates them</h3>
 * A query declares what it provides (`providesTags`), a mutation declares what
 * it makes stale (`invalidatesTags`). After a successful mutation every entry
 * carrying a matching tag is refetched if something is still displaying it, and
 * dropped if nothing is. This is why creating a vehicle refreshes the fleet
 * list without any screen wiring the two together.
 *
 * <h3>3. Nothing is thrown away while it is on screen</h3>
 * Entries are reference counted. Data outlives the last component that used it
 * by {@link DEFAULT_KEEP_UNUSED_DATA_FOR}, so navigating away and straight back
 * renders instantly instead of flashing a spinner, while a genuinely unused
 * entry does not sit in memory forever.
 *
 * <h3>4. A late reply never wins</h3>
 * Every run of an entry carries a monotonic id, and a response is applied only
 * if its id is still the entry's newest. A slow reply that lands after a newer
 * one — or after a sign-out emptied the cache — is discarded rather than
 * overwriting fresher data.
 *
 * <h3>Entry identity</h3>
 * An entry object is never swapped out underneath a subscriber: emptying the
 * cache and invalidating tags both reset watched entries in place rather than
 * replacing them. That is what stops a component from listening to one object
 * while reading its state from another.
 */

/** How long an entry with no subscribers is kept before removal, in ms. */
export const DEFAULT_KEEP_UNUSED_DATA_FOR = 60_000;

export type QueryStatus = 'uninitialized' | 'pending' | 'fulfilled' | 'rejected';

export type TagDescription = string | { type: string; id?: string | number };

export type NormalizedTag = { type: string; id: string | number | undefined };

export type TagsFor<Result, Arg> =
  | readonly TagDescription[]
  | ((
      result: Result | undefined,
      error: FetchBaseQueryError | undefined,
      arg: Arg
    ) => readonly TagDescription[]);

export type InnerBaseQuery = (
  args: string | FetchArgs
) => Promise<QueryReturnValue<unknown, FetchBaseQueryError>>;

export type QueryDefinition<Result, Arg, State, Action> = {
  query?: (arg: Arg) => string | FetchArgs;
  queryFn?: (
    arg: Arg,
    api: BaseQueryApi<State, Action>,
    extraOptions: unknown,
    baseQuery: InnerBaseQuery
  ) =>
    | Promise<QueryReturnValue<Result, FetchBaseQueryError>>
    | QueryReturnValue<Result, FetchBaseQueryError>;
  /**
   * `any` is deliberate on the response: each endpoint declares the envelope it
   * actually receives, and a narrower type here would reject those declarations.
   */
  transformResponse?: (response: any, meta: undefined, arg: Arg) => Result | Promise<Result>;
  providesTags?: TagsFor<Result, Arg>;
  keepUnusedDataFor?: number;
};

export type MutationDefinition<Result, Arg, State, Action> = {
  query?: (arg: Arg) => string | FetchArgs;
  queryFn?: (
    arg: Arg,
    api: BaseQueryApi<State, Action>,
    extraOptions: unknown,
    baseQuery: InnerBaseQuery
  ) =>
    | Promise<QueryReturnValue<Result, FetchBaseQueryError>>
    | QueryReturnValue<Result, FetchBaseQueryError>;
  transformResponse?: (response: any, meta: undefined, arg: Arg) => Result | Promise<Result>;
  invalidatesTags?: TagsFor<Result, Arg>;
};

/** An endpoint definition once its name is known, as the cache stores it. */
export type RuntimeDefinition = {
  kind: 'query' | 'mutation';
  name: string;
  query?: (arg: any) => string | FetchArgs;
  queryFn?: (
    arg: any,
    api: BaseQueryApi<any, any>,
    extraOptions: unknown,
    baseQuery: InnerBaseQuery
  ) =>
    | Promise<QueryReturnValue<unknown, FetchBaseQueryError>>
    | QueryReturnValue<unknown, FetchBaseQueryError>;
  transformResponse?: (response: any, meta: undefined, arg: any) => unknown;
  providesTags?: TagsFor<any, any>;
  invalidatesTags?: TagsFor<any, any>;
  keepUnusedDataFor?: number;
};

/** The immutable view of an entry that a component renders from. */
export type QuerySnapshot = {
  status: QueryStatus;
  data: unknown;
  error: FetchBaseQueryError | undefined;
  isUninitialized: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  fulfilledTimeStamp: number | undefined;
};

export type CacheEntry = {
  key: string;
  definition: RuntimeDefinition;
  arg: unknown;
  status: QueryStatus;
  data: unknown;
  error: FetchBaseQueryError | undefined;
  fulfilledTimeStamp: number | undefined;
  tags: NormalizedTag[];
  /** Components that have committed a subscription to this entry. */
  subscribers: number;
  listeners: Set<() => void>;
  /** Newest run; a reply from an older run is ignored. */
  runId: number;
  removalTimer: ReturnType<typeof setTimeout> | null;
  snapshot: QuerySnapshot;
};

export const UNINITIALIZED_SNAPSHOT: QuerySnapshot = {
  status: 'uninitialized',
  data: undefined,
  error: undefined,
  isUninitialized: true,
  isLoading: false,
  isFetching: false,
  isSuccess: false,
  isError: false,
  fulfilledTimeStamp: undefined,
};

/**
 * A stable string for any endpoint argument.
 *
 * Object keys are sorted, so two calls differing only in property order share
 * one cache entry and therefore one request.
 */
export function serializeArg(arg: unknown): string {
  if (arg === undefined) return 'undefined';
  return JSON.stringify(arg, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const source = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = source[key];
      return sorted;
    }
    return value;
  }) as string;
}

export function normalizeTag(tag: TagDescription): NormalizedTag {
  return typeof tag === 'string' ? { type: tag, id: undefined } : { type: tag.type, id: tag.id };
}

export function resolveTags(
  tags: TagsFor<any, any> | undefined,
  result: unknown,
  error: FetchBaseQueryError | undefined,
  arg: unknown
): NormalizedTag[] {
  if (!tags) return [];
  const list = typeof tags === 'function' ? tags(result, error, arg) : tags;
  return list.map(normalizeTag);
}

/**
 * Invalidation matching.
 *
 * A tag with no id stands for the whole type, so invalidating `Device` refreshes
 * every device-derived entry. A tag with an id matches only entries providing
 * that exact id, which keeps editing one vehicle from refetching the detail of
 * every other.
 */
export function tagMatches(provided: NormalizedTag, invalidated: NormalizedTag): boolean {
  if (provided.type !== invalidated.type) return false;
  return invalidated.id === undefined || provided.id === invalidated.id;
}

export function buildSnapshot(entry: CacheEntry): QuerySnapshot {
  const isFetching = entry.status === 'pending';
  return {
    status: entry.status,
    data: entry.data,
    error: entry.error,
    isUninitialized: entry.status === 'uninitialized',
    // A first load has nothing to render; a refetch over existing data does.
    isLoading: isFetching && entry.data === undefined,
    isFetching,
    // A refresh does not stop the entry from having a usable result, so a
    // screen gated on `isSuccess` keeps rendering its data instead of
    // collapsing back to a placeholder every poll.
    isSuccess: entry.status === 'fulfilled' || (isFetching && entry.data !== undefined),
    isError: entry.status === 'rejected',
    fulfilledTimeStamp: entry.fulfilledTimeStamp,
  };
}

export type QueryCache<State, Action> = ReturnType<typeof createQueryCache<State, Action>>;

export function createQueryCache<State, Action>(options: {
  baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, State, Action>;
  /** Supplies `getState`/`dispatch` to the base query on every request. */
  getApi: () => BaseQueryApi<State, Action>;
  tagTypes?: readonly string[];
}) {
  const { baseQuery, getApi, tagTypes } = options;
  const definitions = new Map<string, RuntimeDefinition>();
  const entries = new Map<string, CacheEntry>();
  const knownTagTypes = new Set(tagTypes ?? []);

  function warnUnknownTags(name: string, tags: NormalizedTag[]): void {
    if (knownTagTypes.size === 0 || typeof __DEV__ === 'undefined' || !__DEV__) return;
    for (const tag of tags) {
      if (!knownTagTypes.has(tag.type)) {
        console.warn(`[api] Endpoint "${name}" used undeclared tag type "${tag.type}".`);
      }
    }
  }

  const innerBaseQuery: InnerBaseQuery = (args) => baseQuery(args, getApi());

  /** Runs one endpoint end to end: request, envelope unwrap, error passthrough. */
  async function execute(
    definition: RuntimeDefinition,
    arg: unknown
  ): Promise<QueryReturnValue<unknown, FetchBaseQueryError>> {
    try {
      if (definition.queryFn) {
        return await definition.queryFn(arg, getApi(), undefined, innerBaseQuery);
      }
      if (!definition.query) {
        throw new Error(`Endpoint "${definition.name}" defines neither query nor queryFn.`);
      }
      const result = await baseQuery(definition.query(arg), getApi());
      if (result.error) return { error: result.error };
      const data = definition.transformResponse
        ? await definition.transformResponse(result.data, undefined, arg)
        : result.data;
      return { data };
    } catch (error) {
      // A throw from `query`, `queryFn` or `transformResponse` is a client-side
      // fault. Reporting it in the same shape as a transport failure means every
      // caller's existing error handling already covers it.
      return { error: { status: 'CUSTOM_ERROR', error: String(error), data: String(error) } };
    }
  }

  function notify(entry: CacheEntry): void {
    entry.snapshot = buildSnapshot(entry);
    for (const listener of Array.from(entry.listeners)) listener();
  }

  /** True while anything is watching, or about to watch, this entry. */
  function inUse(entry: CacheEntry): boolean {
    return entry.subscribers > 0 || entry.listeners.size > 0;
  }

  function register(name: string, definition: RuntimeDefinition): void {
    definitions.set(name, definition);
  }

  function getDefinition(name: string): RuntimeDefinition | undefined {
    return definitions.get(name);
  }

  function keyFor(name: string, arg: unknown): string {
    return `${name}(${serializeArg(arg)})`;
  }

  function getEntry(key: string): CacheEntry | undefined {
    return entries.get(key);
  }

  function ensureEntry(name: string, key: string, arg: unknown): CacheEntry {
    const existing = entries.get(key);
    if (existing) return existing;
    const definition = definitions.get(name);
    if (!definition || definition.kind !== 'query') {
      throw new Error(`Unknown query endpoint "${name}".`);
    }
    const entry: CacheEntry = {
      key,
      definition,
      arg,
      status: 'uninitialized',
      data: undefined,
      error: undefined,
      fulfilledTimeStamp: undefined,
      tags: [],
      subscribers: 0,
      listeners: new Set(),
      runId: 0,
      removalTimer: null,
      snapshot: UNINITIALIZED_SNAPSHOT,
    };
    entries.set(key, entry);
    return entry;
  }

  async function runQuery(
    entry: CacheEntry
  ): Promise<QueryReturnValue<unknown, FetchBaseQueryError>> {
    const runId = entry.runId + 1;
    entry.runId = runId;
    entry.status = 'pending';
    notify(entry);

    const result = await execute(entry.definition, entry.arg);

    // Superseded by a newer run, or the entry was discarded underneath us. The
    // result is still handed back to whoever started this run, but it must not
    // be written to an entry that has moved on.
    if (entry.runId !== runId || entries.get(entry.key) !== entry) return result;

    if (result.error) {
      entry.status = 'rejected';
      entry.error = result.error;
      // `data` is intentionally left in place: a failed refresh should keep
      // showing the last known good value rather than blanking the screen.
    } else {
      entry.status = 'fulfilled';
      entry.data = result.data;
      entry.error = undefined;
      entry.fulfilledTimeStamp = Date.now();
    }
    entry.tags = resolveTags(entry.definition.providesTags, result.data, result.error, entry.arg);
    warnUnknownTags(entry.definition.name, entry.tags);
    notify(entry);
    return result;
  }

  /** Starts a request only when there is a reason to; otherwise serves cache. */
  function initiate(entry: CacheEntry, force: boolean | number): void {
    if (entry.status === 'pending') return;
    if (entry.status === 'uninitialized') {
      void runQuery(entry);
      return;
    }
    if (force === true) {
      void runQuery(entry);
      return;
    }
    if (typeof force === 'number') {
      const ageSeconds = (Date.now() - (entry.fulfilledTimeStamp ?? 0)) / 1000;
      if (ageSeconds >= force) void runQuery(entry);
    }
  }

  function refetchKey(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return Promise.resolve();
    return runQuery(entry).then(() => undefined);
  }

  function discardEntry(entry: CacheEntry): void {
    if (entry.removalTimer) clearTimeout(entry.removalTimer);
    entry.removalTimer = null;
    // Advancing the run id means a reply already on the wire is discarded
    // rather than resurrecting an entry nothing is watching.
    entry.runId += 1;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }

  function addSubscriber(entry: CacheEntry): void {
    entry.subscribers += 1;
    if (entry.removalTimer) {
      clearTimeout(entry.removalTimer);
      entry.removalTimer = null;
    }
  }

  function removeSubscriber(entry: CacheEntry): void {
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (entry.subscribers > 0 || entry.removalTimer) return;
    const keepFor = entry.definition.keepUnusedDataFor ?? DEFAULT_KEEP_UNUSED_DATA_FOR;
    entry.removalTimer = setTimeout(() => {
      entry.removalTimer = null;
      if (!inUse(entry)) discardEntry(entry);
    }, keepFor);
  }

  /** Registers a re-render callback and returns its unsubscribe. */
  function addListener(entry: CacheEntry, listener: () => void): () => void {
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  function invalidateTags(tags: readonly TagDescription[]): void {
    if (tags.length === 0) return;
    const invalidated = tags.map(normalizeTag);
    const affected: CacheEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.tags.some((provided) => invalidated.some((tag) => tagMatches(provided, tag)))) {
        affected.push(entry);
      }
    }
    for (const entry of affected) {
      // Still on screen: refresh it in place. Nothing watching: drop it, so the
      // next screen that needs it fetches rather than rendering a stale value.
      if (inUse(entry)) void runQuery(entry);
      else discardEntry(entry);
    }
  }

  function resetApiState(): void {
    const stillWatched: CacheEntry[] = [];
    for (const entry of Array.from(entries.values())) {
      if (entry.removalTimer) {
        clearTimeout(entry.removalTimer);
        entry.removalTimer = null;
      }
      // Discards any reply still on the wire from the session being torn down.
      entry.runId += 1;
      entry.status = 'uninitialized';
      entry.data = undefined;
      entry.error = undefined;
      entry.fulfilledTimeStamp = undefined;
      entry.tags = [];
      // Watched entries are reset in place and kept in the map, so the
      // components listening to them keep pointing at the same object.
      if (inUse(entry)) stillWatched.push(entry);
      else entries.delete(entry.key);
      notify(entry);
    }
    if (stillWatched.length === 0) return;

    // Deferred by a tick on purpose. A reset is always issued alongside the
    // state changes that make it necessary — new credentials, a cleared
    // session, a switched tenant — and refetching now would run under the
    // session being replaced. By the time this fires React has re-rendered, so
    // a component that has since unmounted or started skipping no longer counts
    // as a subscriber and is left alone.
    setTimeout(() => {
      for (const entry of stillWatched) {
        if (!inUse(entry) || entries.get(entry.key) !== entry) continue;
        void runQuery(entry);
      }
    }, 0);
  }

  return {
    register,
    getDefinition,
    keyFor,
    getEntry,
    ensureEntry,
    execute,
    runQuery,
    initiate,
    refetchKey,
    addSubscriber,
    removeSubscriber,
    addListener,
    invalidateTags,
    resolveTags,
    warnUnknownTags,
    resetApiState,
    /** Number of live entries. Exposed for assertions about retention. */
    size: () => entries.size,
  };
}
