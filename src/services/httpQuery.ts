/**
 * The HTTP transport behind every API call.
 *
 * <p>This is the layer that turns an endpoint's declarative request description
 * into a `fetch`, and a `fetch` outcome into the discriminated result the rest
 * of the app already understands: `{ data }` on success, `{ error }` otherwise.
 *
 * <h3>Why the error shapes matter</h3>
 * `apiErrorMessage` distinguishes a connectivity failure from a gateway serving
 * HTML from a genuine 5xx, and it does so by reading `error.status`. Those
 * statuses are therefore part of this module's contract, not incidental:
 *
 *  - `FETCH_ERROR`   — the request never completed (offline, DNS, TLS, abort).
 *  - `TIMEOUT_ERROR` — the request was given a deadline and missed it.
 *  - `PARSING_ERROR` — a body arrived but was not JSON, e.g. a tunnel's HTML
 *                      interstitial. `originalStatus` keeps the HTTP status,
 *                      which is what makes "HTTP 502 from the gateway" legible
 *                      instead of a spurious domain error.
 *  - `CUSTOM_ERROR`  — produced by the app itself rather than the network; the
 *                      stale-tenant guard is the only source.
 *  - a number        — a real HTTP status, with the parsed body in `data`.
 */

export type FetchArgs = {
  url: string;
  method?: string;
  body?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type FetchBaseQueryError =
  | { status: number; data: unknown; error?: undefined; originalStatus?: undefined }
  | { status: 'FETCH_ERROR'; data?: undefined; error: string; originalStatus?: undefined }
  | { status: 'TIMEOUT_ERROR'; data?: undefined; error: string; originalStatus?: undefined }
  | { status: 'PARSING_ERROR'; originalStatus: number; data: string; error: string }
  | { status: 'CUSTOM_ERROR'; data?: unknown; error: string; originalStatus?: undefined };

/** Success or failure, never both. Mirrors what every endpoint returns. */
export type QueryReturnValue<Data = unknown, Err = FetchBaseQueryError> =
  | { data: Data; error?: undefined }
  | { data?: undefined; error: Err };

/**
 * What a base query may reach for while a request is in flight.
 *
 * `getState` and `dispatch` are the live app store, which is how the shared
 * base query reads the access token, re-authenticates on a 401 and drops a
 * response that outlived the tenant it was requested for.
 */
export type BaseQueryApi<State = unknown, Action = unknown> = {
  getState: () => State;
  dispatch: (action: Action) => unknown;
  signal?: AbortSignal;
};

export type BaseQueryFn<
  Args = string | FetchArgs,
  Result = unknown,
  Err = FetchBaseQueryError,
  State = unknown,
  Action = unknown,
> = (
  args: Args,
  api: BaseQueryApi<State, Action>,
  extraOptions?: unknown
) => Promise<QueryReturnValue<Result, Err>>;

export type FetchBaseQueryOptions<State> = {
  baseUrl: string;
  /** Injected so requests can be tracked and cancelled as a group. */
  fetchFn?: typeof fetch;
  prepareHeaders?: (
    headers: Headers,
    api: { getState: () => State }
  ) => Headers | void | Promise<Headers | void>;
  /** Optional per-request deadline, in ms. */
  timeout?: number;
};

function joinUrls(base: string, path: string): string {
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Appends query parameters, dropping only `undefined`.
 *
 * `null` is deliberately kept and serialised: an endpoint that sends `null`
 * means it, and silently discarding it would change the request.
 */
function withParams(url: string, params: Record<string, unknown> | undefined): string {
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) search.append(name, String(item));
      }
      continue;
    }
    search.append(name, String(value));
  }
  const serialized = search.toString();
  if (!serialized) return url;
  return url.includes('?') ? `${url}&${serialized}` : `${url}?${serialized}`;
}

/**
 * True for a body that must be sent exactly as given.
 *
 * Everything else is treated as JSON. The profile-image endpoint depends on
 * this: it posts a base64 string under an explicit `text/plain`, and stringifying
 * it would wrap the payload in quotes the backend does not expect.
 */
function isRawBody(body: unknown): boolean {
  return (
    typeof body === 'string' ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)
  );
}

export function createFetchBaseQuery<State, Action>(
  options: FetchBaseQueryOptions<State>
): BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, State, Action> {
  const { baseUrl, fetchFn = fetch, prepareHeaders, timeout } = options;

  return async (args, api) => {
    const request: FetchArgs = typeof args === 'string' ? { url: args } : args;
    const { url, method = 'GET', params, signal } = request;
    let { body } = request;

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      headers.set(name, value);
    }
    if (prepareHeaders) {
      const prepared = await prepareHeaders(headers, { getState: api.getState });
      if (prepared) {
        // A replacement instance is honoured; a mutated one is already applied.
        if (prepared !== headers) {
          prepared.forEach((value, name) => headers.set(name, value));
        }
      }
    }

    if (body !== undefined && !isRawBody(body)) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      body = JSON.stringify(body);
    }

    // One controller per request, chained to any caller-supplied signal, so a
    // timeout and an external abort both cancel the same in-flight request.
    const controller = new AbortController();
    const externalSignal = signal ?? api.signal;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let timedOut = false;
    const timer =
      timeout != null
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeout)
        : null;

    let response: Response;
    try {
      response = await fetchFn(withParams(joinUrls(baseUrl, url), params), {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: body as BodyInit } : {}),
      });
    } catch (error) {
      return {
        error: timedOut
          ? { status: 'TIMEOUT_ERROR', error: String(error) }
          : { status: 'FETCH_ERROR', error: String(error) },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    let text = '';
    let parsed: unknown = null;
    try {
      text = await response.text();
      // An empty body is a valid response for DELETE and logout; only a
      // non-empty body that is not JSON is a parsing failure.
      parsed = text.length ? JSON.parse(text) : null;
    } catch (error) {
      return {
        error: {
          status: 'PARSING_ERROR',
          originalStatus: response.status,
          data: text,
          error: String(error),
        },
      };
    }

    if (!response.ok) {
      return { error: { status: response.status, data: parsed } };
    }
    return { data: parsed };
  };
}
