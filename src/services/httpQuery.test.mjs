import assert from 'node:assert/strict';
import test from 'node:test';

import { apiErrorMessage } from './apiError.ts';
import { createFetchBaseQuery } from './httpQuery.ts';

const API = { getState: () => ({ token: 'abc' }), dispatch: () => undefined };

/**
 * A base query over a scripted transport.
 *
 * `requests` records the URL, method, headers and body exactly as they would go
 * on the wire, which is what the request-shaping assertions below inspect.
 */
function harness(respond, options = {}) {
  const requests = [];
  const baseQuery = createFetchBaseQuery({
    baseUrl: 'https://api.test/api',
    ...options,
    fetchFn: async (url, init) => {
      const headers = {};
      init.headers.forEach((value, name) => {
        headers[name] = value;
      });
      requests.push({ url, method: init.method, headers, body: init.body, signal: init.signal });
      return respond(url, init);
    },
  });
  return { baseQuery, requests };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

test('a string endpoint is joined onto the base url', async () => {
  const { baseQuery, requests } = harness(() => json({ success: true, data: null }));
  await baseQuery('/settings', API);
  assert.equal(requests[0].url, 'https://api.test/api/settings');
  assert.equal(requests[0].method, 'GET');
});

test('query parameters are appended, and undefined ones are omitted', async () => {
  const { baseQuery, requests } = harness(() => json({ success: true, data: null }));
  await baseQuery(
    { url: '/devices', params: { search: 'lorry', groupId: undefined, page: 0, size: 20 } },
    API
  );
  assert.equal(requests[0].url, 'https://api.test/api/devices?search=lorry&page=0&size=20');
});

test('a parameter value is escaped rather than injected into the query string', async () => {
  const { baseQuery, requests } = harness(() => json({ success: true, data: null }));
  await baseQuery({ url: '/devices', params: { search: 'a&b=c d' } }, API);
  assert.equal(requests[0].url, 'https://api.test/api/devices?search=a%26b%3Dc+d');
});

test('an object body is sent as JSON', async () => {
  const { baseQuery, requests } = harness(() => json({ success: true, data: null }));
  await baseQuery({ url: '/auth/login', method: 'POST', body: { email: 'a@b.c' } }, API);
  assert.equal(requests[0].headers['content-type'], 'application/json');
  assert.equal(requests[0].body, '{"email":"a@b.c"}');
});

test('a string body is sent verbatim under the content type the endpoint chose', async () => {
  const { baseQuery, requests } = harness(() => json({ success: true, data: null }));
  await baseQuery(
    {
      url: '/users/me/profile-image',
      method: 'PUT',
      body: 'data:image/png;base64,AAAA',
      headers: { 'Content-Type': 'text/plain' },
    },
    API
  );
  assert.equal(requests[0].headers['content-type'], 'text/plain');
  assert.equal(requests[0].body, 'data:image/png;base64,AAAA', 'must not be JSON-quoted');
});

test('prepareHeaders sees the live state and its headers reach the request', async () => {
  const { baseQuery, requests } = harness(() => json({ success: true, data: null }), {
    prepareHeaders: (headers, { getState }) => {
      headers.set('Authorization', `Bearer ${getState().token}`);
      return headers;
    },
  });
  await baseQuery('/devices', API);
  assert.equal(requests[0].headers.authorization, 'Bearer abc');
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

test('a successful response is parsed into data', async () => {
  const { baseQuery } = harness(() => json({ success: true, data: [{ id: 1 }] }));
  const result = await baseQuery('/devices', API);
  assert.deepEqual(result.data, { success: true, data: [{ id: 1 }] });
  assert.equal(result.error, undefined);
});

test('an empty body is a valid response, not a parse failure', async () => {
  const { baseQuery } = harness(() => new Response(null, { status: 204 }));
  const result = await baseQuery({ url: '/devices/1', method: 'DELETE' }, API);
  assert.equal(result.error, undefined);
  assert.equal(result.data, null);
});

test('an HTTP error carries the status and the parsed envelope', async () => {
  const { baseQuery } = harness(() =>
    json({ success: false, data: null, error: { code: 'FORBIDDEN', message: 'Not allowed' } }, 403)
  );
  const result = await baseQuery('/tenants', API);
  assert.equal(result.error.status, 403);
  assert.equal(apiErrorMessage(result.error), 'Not allowed');
});

test('a 5xx keeps the server message and its correlation id', async () => {
  const { baseQuery } = harness(() =>
    json(
      {
        success: false,
        data: null,
        error: { code: 'INTERNAL', message: 'Database unavailable' },
        correlationId: 'abc-123',
      },
      500
    )
  );
  const result = await baseQuery('/devices', API);
  assert.equal(apiErrorMessage(result.error), 'Database unavailable (ref abc-123)');
});

test("a gateway's HTML page is reported as a gateway problem, not a domain error", async () => {
  const { baseQuery } = harness(
    () => new Response('<html>502 Bad Gateway</html>', { status: 502 })
  );
  const result = await baseQuery('/tenant/resolve', API);
  assert.equal(result.error.status, 'PARSING_ERROR');
  assert.equal(result.error.originalStatus, 502);
  assert.match(apiErrorMessage(result.error, 'Invalid company code'), /HTTP 502/);
});

test('being offline is reported as a connectivity failure', async () => {
  const { baseQuery } = harness(() => {
    throw new TypeError('Network request failed');
  });
  const result = await baseQuery('/devices', API);
  assert.equal(result.error.status, 'FETCH_ERROR');
  assert.match(apiErrorMessage(result.error), /Cannot reach the server/);
});

test('a request that misses its deadline is reported as a timeout', async () => {
  const { baseQuery } = harness(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }),
    { timeout: 20 }
  );
  const result = await baseQuery('/devices', API);
  assert.equal(result.error.status, 'TIMEOUT_ERROR');
});

test('an external abort cancels the request in flight', async () => {
  const controller = new AbortController();
  const { baseQuery } = harness(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      })
  );
  const pending = baseQuery({ url: '/devices', signal: controller.signal }, API);
  controller.abort();
  const result = await pending;
  assert.equal(result.error.status, 'FETCH_ERROR');
});
