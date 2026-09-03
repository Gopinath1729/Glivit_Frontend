import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type {
  BaseQueryApi,
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
  QueryReturnValue,
} from '@/src/services/httpQuery';
import {
  createQueryCache,
  UNINITIALIZED_SNAPSHOT,
  type CacheEntry,
  type MutationDefinition,
  type QueryDefinition,
  type QueryStatus,
  type RuntimeDefinition,
  type TagDescription,
} from '@/src/services/queryCache';

/**
 * React bindings over {@link createQueryCache}.
 *
 * <p>Declaring an endpoint generates its hooks: a `getDevices` query becomes
 * `useGetDevicesQuery` and `useLazyGetDevicesQuery`, a `createDevice` mutation
 * becomes `useCreateDeviceMutation`. Nothing in a screen reaches the cache
 * directly — subscription, request de-duplication, retention and invalidation
 * are all consequences of a component rendering a hook, which is why a screen
 * only has to say what data it needs.
 */

export type {
  QueryStatus,
  TagDescription,
  QueryDefinition,
  MutationDefinition,
} from '@/src/services/queryCache';

/** Branded wrappers, so the hook types can tell a query from a mutation. */
export type QueryEndpoint<Result, Arg> = {
  readonly __kind: 'query';
  readonly __result: Result;
  readonly __arg: Arg;
};
export type MutationEndpoint<Result, Arg> = {
  readonly __kind: 'mutation';
  readonly __result: Result;
  readonly __arg: Arg;
};

export type EndpointBuilder<State, Action> = {
  query<Result, Arg>(
    definition: QueryDefinition<Result, Arg, State, Action>
  ): QueryEndpoint<Result, Arg>;
  mutation<Result, Arg>(
    definition: MutationDefinition<Result, Arg, State, Action>
  ): MutationEndpoint<Result, Arg>;
};

export type UseQueryOptions = {
  /** Suspends the query entirely; the result reads as uninitialized. */
  skip?: boolean;
  /** Refetch every N ms while at least one component is subscribed. */
  pollingInterval?: number;
  /**
   * Accepted for call-site clarity, but not acted on: nothing in this app
   * reports window or app focus, so there is no focus state to consult and a
   * poll simply runs for as long as the component is mounted.
   */
  skipPollingIfUnfocused?: boolean;
  /** Accepted but not acted on, for the same reason as `skipPollingIfUnfocused`. */
  refetchOnFocus?: boolean;
  /**
   * `true` refetches on mount and whenever the argument changes; a number
   * refetches only when the cached value is older than that many seconds.
   */
  refetchOnMountOrArgChange?: boolean | number;
};

export type UseQueryResult<Result, Arg> = {
  /** The newest result for the current argument; undefined while it loads. */
  currentData: Result | undefined;
  /** The newest result for any argument, so a list does not blank on refilter. */
  data: Result | undefined;
  error: FetchBaseQueryError | undefined;
  status: QueryStatus;
  isUninitialized: boolean;
  /** A first load, with nothing to show yet. */
  isLoading: boolean;
  /** Any request in flight, including a refetch over existing data. */
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  fulfilledTimeStamp: number | undefined;
  originalArgs: Arg | undefined;
  refetch: () => Promise<void>;
};

export type TriggerResult<Result> = Promise<QueryReturnValue<Result, FetchBaseQueryError>> & {
  /** Resolves with the payload, or throws the error for a `catch` block. */
  unwrap: () => Promise<Result>;
};

export type UseMutationState<Result, Arg> = {
  data: Result | undefined;
  error: FetchBaseQueryError | undefined;
  status: QueryStatus;
  isUninitialized: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  originalArgs: Arg | undefined;
  /** Discards the last result, so a retry cannot render a stale failure. */
  reset: () => void;
};

/** A `void` argument may be omitted at the call site; anything else is required. */
type QueryHookArgs<Arg> = void extends Arg
  ? [arg?: Arg, options?: UseQueryOptions]
  : [arg: Arg, options?: UseQueryOptions];

type TriggerArgs<Arg> = void extends Arg ? [arg?: Arg] : [arg: Arg];

export type UseQueryHook<Result, Arg> = (
  ...args: QueryHookArgs<Arg>
) => UseQueryResult<Result, Arg>;

export type UseLazyQueryHook<Result, Arg> = () => [
  (...args: TriggerArgs<Arg>) => TriggerResult<Result>,
  UseQueryResult<Result, Arg>,
];

export type UseMutationHook<Result, Arg> = () => [
  (...args: TriggerArgs<Arg>) => TriggerResult<Result>,
  UseMutationState<Result, Arg>,
];

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I
) => void
  ? I
  : never;

type HooksFor<Definitions> = UnionToIntersection<
  {
    [Name in keyof Definitions & string]: Definitions[Name] extends QueryEndpoint<
      infer Result,
      infer Arg
    >
      ? { [K in `use${Capitalize<Name>}Query`]: UseQueryHook<Result, Arg> } & {
          [K in `useLazy${Capitalize<Name>}Query`]: UseLazyQueryHook<Result, Arg>;
        }
      : Definitions[Name] extends MutationEndpoint<infer Result, infer Arg>
        ? { [K in `use${Capitalize<Name>}Mutation`]: UseMutationHook<Result, Arg> }
        : never;
  }[keyof Definitions & string]
>;

export type ApiClient<State, Action> = {
  /** Registers endpoints and returns the hooks generated for them. */
  injectEndpoints<Definitions extends Record<string, unknown>>(options: {
    endpoints: (build: EndpointBuilder<State, Action>) => Definitions;
    overrideExisting?: boolean;
  }): HooksFor<Definitions> & ApiClient<State, Action>;
  util: {
    /**
     * Empties the cache.
     *
     * Anything still on screen is refetched on the next tick — after the state
     * changes around this call have settled, so the refetch runs under the new
     * session rather than the one being torn down. Anything unused is dropped.
     */
    resetApiState: () => void;
    /** Refetches, or drops, every entry carrying one of these tags. */
    invalidateTags: (tags: readonly TagDescription[]) => void;
  };
};

export function createApiClient<State, Action>(options: {
  baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, State, Action>;
  /** Supplies `getState`/`dispatch` to the base query on every request. */
  getApi: () => BaseQueryApi<State, Action>;
  tagTypes?: readonly string[];
}): ApiClient<State, Action> {
  const cache = createQueryCache(options);

  /**
   * Attaches `unwrap` to a trigger's promise.
   *
   * The promise itself always resolves — with `{ data }` or `{ error }` — so a
   * caller that ignores the outcome cannot produce an unhandled rejection.
   * `unwrap()` is the opt-in that turns a failure into a throw.
   */
  function withUnwrap(
    promise: Promise<QueryReturnValue<unknown, FetchBaseQueryError>>
  ): TriggerResult<unknown> {
    const wrapped = promise as TriggerResult<unknown>;
    wrapped.unwrap = () =>
      promise.then((result) => {
        if (result.error !== undefined) throw result.error;
        return result.data;
      });
    return wrapped;
  }

  function useQueryHook(
    name: string,
    arg: unknown,
    hookOptions: UseQueryOptions | undefined
  ): UseQueryResult<unknown, unknown> {
    const { skip = false, pollingInterval, refetchOnMountOrArgChange = false } = hookOptions ?? {};

    const key = skip ? null : cache.keyFor(name, arg);

    // The argument is read through a ref so a re-render passing an equivalent
    // but newly allocated object literal does not restart the request.
    const argRef = useRef(arg);
    argRef.current = arg;

    const subscribe = useCallback(
      (onStoreChange: () => void) => {
        if (!key) return () => undefined;
        return cache.addListener(cache.ensureEntry(name, key, argRef.current), onStoreChange);
      },
      [key, name]
    );

    const getSnapshot = useCallback(() => {
      if (!key) return UNINITIALIZED_SNAPSHOT;
      return cache.getEntry(key)?.snapshot ?? UNINITIALIZED_SNAPSHOT;
    }, [key]);

    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    useEffect(() => {
      if (!key) return;
      const entry = cache.ensureEntry(name, key, argRef.current);
      cache.addSubscriber(entry);
      cache.initiate(entry, refetchOnMountOrArgChange);
      return () => cache.removeSubscriber(entry);
    }, [key, name, refetchOnMountOrArgChange]);

    useEffect(() => {
      if (!key || !pollingInterval || pollingInterval <= 0) return;
      const timer = setInterval(() => {
        // A poll never stacks on top of a request that is still running.
        const entry = cache.getEntry(key);
        if (entry && entry.status !== 'pending') void cache.runQuery(entry);
      }, pollingInterval);
      return () => clearInterval(timer);
    }, [key, pollingInterval]);

    const refetch = useCallback(
      () => (key ? cache.refetchKey(key) : Promise.resolve()),
      [key]
    );

    // `data` deliberately outlives a change of argument, so a filtered list
    // keeps its rows while the next selection loads. A skipped query has no
    // argument at all, so it drops back to undefined.
    const stickyData = useRef<unknown>(undefined);
    if (!key) stickyData.current = undefined;
    else if (snapshot.data !== undefined) stickyData.current = snapshot.data;
    const data = snapshot.data !== undefined ? snapshot.data : stickyData.current;

    return useMemo(
      () => ({
        currentData: snapshot.data,
        data,
        error: snapshot.error,
        status: snapshot.status,
        isUninitialized: snapshot.isUninitialized,
        isLoading: snapshot.isLoading,
        isFetching: snapshot.isFetching,
        isSuccess: snapshot.isSuccess,
        isError: snapshot.isError,
        fulfilledTimeStamp: snapshot.fulfilledTimeStamp,
        originalArgs: key ? argRef.current : undefined,
        refetch,
      }),
      [snapshot, data, key, refetch]
    );
  }

  function useMutationHook(
    name: string
  ): [(arg?: unknown) => TriggerResult<unknown>, UseMutationState<unknown, unknown>] {
    const [state, setState] = useState<{
      status: QueryStatus;
      data: unknown;
      error: FetchBaseQueryError | undefined;
      originalArgs: unknown;
    }>({ status: 'uninitialized', data: undefined, error: undefined, originalArgs: undefined });

    // Only the newest call may write state, so an earlier slow request cannot
    // overwrite the result of the one the user is actually waiting on.
    const runIdRef = useRef(0);
    const mountedRef = useRef(true);
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    const trigger = useCallback(
      (arg?: unknown) => {
        const definition = cache.getDefinition(name);
        if (!definition || definition.kind !== 'mutation') {
          throw new Error(`Unknown mutation endpoint "${name}".`);
        }
        const runId = runIdRef.current + 1;
        runIdRef.current = runId;
        setState({ status: 'pending', data: undefined, error: undefined, originalArgs: arg });

        const promise = (async (): Promise<QueryReturnValue<unknown, FetchBaseQueryError>> => {
          const result = await cache.execute(definition, arg);
          const isCurrent = runIdRef.current === runId;

          if (result.error) {
            if (isCurrent && mountedRef.current) {
              setState({
                status: 'rejected',
                data: undefined,
                error: result.error,
                originalArgs: arg,
              });
            }
            return { error: result.error };
          }

          // Invalidation runs for every successful call, including one whose
          // component has since unmounted: the write happened on the server, so
          // the caches it makes stale must be refreshed regardless of who is
          // left to see this mutation's own result.
          const tags = cache.resolveTags(definition.invalidatesTags, result.data, undefined, arg);
          cache.warnUnknownTags(name, tags);
          cache.invalidateTags(tags);

          if (isCurrent && mountedRef.current) {
            setState({
              status: 'fulfilled',
              data: result.data,
              error: undefined,
              originalArgs: arg,
            });
          }
          return { data: result.data };
        })();

        return withUnwrap(promise);
      },
      [name]
    );

    const reset = useCallback(() => {
      // Advancing the run id abandons any call in flight, so its result cannot
      // land after the reset and re-show what was just cleared.
      runIdRef.current += 1;
      setState({
        status: 'uninitialized',
        data: undefined,
        error: undefined,
        originalArgs: undefined,
      });
    }, []);

    const result = useMemo<UseMutationState<unknown, unknown>>(
      () => ({
        data: state.data,
        error: state.error,
        status: state.status,
        isUninitialized: state.status === 'uninitialized',
        isLoading: state.status === 'pending',
        isSuccess: state.status === 'fulfilled',
        isError: state.status === 'rejected',
        originalArgs: state.originalArgs,
        reset,
      }),
      [state, reset]
    );

    return [trigger, result];
  }

  /**
   * A query run on demand rather than on render.
   *
   * The result is cached like any other query — the trigger's argument picks the
   * entry — and this hook holds a subscription to whichever entry it fetched
   * last, so the value stays available for as long as the screen is up and is
   * released when it is not.
   */
  function useLazyQueryHook(
    name: string
  ): [(arg?: unknown) => TriggerResult<unknown>, UseQueryResult<unknown, unknown>] {
    // The entry itself is the state, so the subscription and the snapshot can
    // never disagree about which object they are reading.
    const [entry, setEntry] = useState<CacheEntry | null>(null);
    const subscribedRef = useRef<CacheEntry | null>(null);
    const argRef = useRef<unknown>(undefined);

    useEffect(
      () => () => {
        if (subscribedRef.current) {
          cache.removeSubscriber(subscribedRef.current);
          subscribedRef.current = null;
        }
      },
      []
    );

    const subscribe = useCallback(
      (onStoreChange: () => void) =>
        entry ? cache.addListener(entry, onStoreChange) : () => undefined,
      [entry]
    );

    const getSnapshot = useCallback(
      () => entry?.snapshot ?? UNINITIALIZED_SNAPSHOT,
      [entry]
    );

    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const trigger = useCallback(
      (arg?: unknown) => {
        argRef.current = arg;
        const target = cache.ensureEntry(name, cache.keyFor(name, arg), arg);

        // Move the subscription to the entry being fetched, releasing the
        // previous one so an abandoned result does not pin its payload.
        if (subscribedRef.current !== target) {
          if (subscribedRef.current) cache.removeSubscriber(subscribedRef.current);
          cache.addSubscriber(target);
          subscribedRef.current = target;
        }
        setEntry(target);

        // An explicit trigger always fetches rather than serving whatever the
        // cache happens to hold, and resolves with the result of this run
        // specifically — not with whatever the entry ends up holding.
        return withUnwrap(cache.runQuery(target));
      },
      [name]
    );

    const refetch = useCallback(
      () => (entry ? cache.runQuery(entry).then(() => undefined) : Promise.resolve()),
      [entry]
    );

    const result = useMemo<UseQueryResult<unknown, unknown>>(
      () => ({
        currentData: snapshot.data,
        data: snapshot.data,
        error: snapshot.error,
        status: snapshot.status,
        isUninitialized: snapshot.isUninitialized,
        isLoading: snapshot.isLoading,
        isFetching: snapshot.isFetching,
        isSuccess: snapshot.isSuccess,
        isError: snapshot.isError,
        fulfilledTimeStamp: snapshot.fulfilledTimeStamp,
        originalArgs: argRef.current,
        refetch,
      }),
      [snapshot, refetch]
    );

    return [trigger, result];
  }

  const client: Record<string, unknown> = {
    util: {
      resetApiState: cache.resetApiState,
      invalidateTags: cache.invalidateTags,
    },
  };

  client.injectEndpoints = (injection: {
    endpoints: (build: EndpointBuilder<State, Action>) => Record<string, unknown>;
    overrideExisting?: boolean;
  }) => {
    // The builder only tags a definition with its kind. The name is filled in
    // below, once the returned map reveals what each endpoint is called.
    const build = {
      query: (definition: object) => ({ ...definition, kind: 'query' }),
      mutation: (definition: object) => ({ ...definition, kind: 'mutation' }),
    } as unknown as EndpointBuilder<State, Action>;

    for (const [name, raw] of Object.entries(injection.endpoints(build))) {
      if (cache.getDefinition(name) && injection.overrideExisting === false) continue;
      const definition = { ...(raw as object), name } as RuntimeDefinition;
      cache.register(name, definition);

      // Each generated hook is bound to its endpoint name and then published
      // under the conventional `use<Endpoint>Query` / `Mutation` key. The local
      // bindings are named so they read — and lint — as the hooks they are.
      const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
      if (definition.kind === 'query') {
        const useEndpointQuery = (arg?: unknown, hookOptions?: UseQueryOptions) =>
          useQueryHook(name, arg, hookOptions);
        const useEndpointLazyQuery = () => useLazyQueryHook(name);
        client[`use${capitalized}Query`] = useEndpointQuery;
        client[`useLazy${capitalized}Query`] = useEndpointLazyQuery;
      } else {
        const useEndpointMutation = () => useMutationHook(name);
        client[`use${capitalized}Mutation`] = useEndpointMutation;
      }
    }
    return client;
  };

  return client as unknown as ApiClient<State, Action>;
}
