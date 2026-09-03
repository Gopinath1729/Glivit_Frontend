import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueryCache,
  normalizeTag,
  serializeArg,
  tagMatches,
} from './queryCache.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A cache wired to a scriptable transport.
 *
 * `calls` records every request the cache actually issued, which is what most
 * of these assertions are really about: not what the cache returned, but how
 * many times it went to the network to get it.
 */
function harness(responder) {
  const calls = [];
  const cache = createQueryCache({
    getApi: () => ({ getState: () => ({}), dispatch: () => undefined }),
    tagTypes: ['Device', 'Dashboard'],
    baseQuery: async (args) => {
      calls.push(args);
      return responder(args, calls.length);
    },
  });
  return { cache, calls };
}

/** Registers a query endpoint and returns its entry, ready to run. */
function entryFor(cache, name, definition, arg) {
  cache.register(name, { kind: 'query', name, ...definition });
  return cache.ensureEntry(name, cache.keyFor(name, arg), arg);
}

// ---------------------------------------------------------------------------
// Argument identity
// ---------------------------------------------------------------------------

test('arguments differing only in key order are the same cache key', () => {
  assert.equal(serializeArg({ page: 0, size: 20 }), serializeArg({ size: 20, page: 0 }));
  assert.equal(serializeArg({ a: { y: 1, x: 2 } }), serializeArg({ a: { x: 2, y: 1 } }));
});

test('arguments that genuinely differ are different cache keys', () => {
  assert.notEqual(serializeArg({ page: 0 }), serializeArg({ page: 1 }));
  assert.notEqual(serializeArg(undefined), serializeArg(null));
  // Array order is meaningful and must be preserved.
  assert.notEqual(serializeArg([1, 2]), serializeArg([2, 1]));
});

// ---------------------------------------------------------------------------
// Tag matching
// ---------------------------------------------------------------------------

test('invalidating a bare type matches every id of that type', () => {
  const invalidated = normalizeTag('Device');
  assert.equal(tagMatches(normalizeTag('Device'), invalidated), true);
  assert.equal(tagMatches(normalizeTag({ type: 'Device', id: 5 }), invalidated), true);
  assert.equal(tagMatches(normalizeTag('Dashboard'), invalidated), false);
});

test('invalidating one id does not touch the others, or the untagged list', () => {
  const invalidated = normalizeTag({ type: 'Device', id: 5 });
  assert.equal(tagMatches(normalizeTag({ type: 'Device', id: 5 }), invalidated), true);
  assert.equal(tagMatches(normalizeTag({ type: 'Device', id: 6 }), invalidated), false);
  assert.equal(tagMatches(normalizeTag('Device'), invalidated), false);
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

test('the response envelope is unwrapped by transformResponse', async () => {
  const { cache } = harness(async () => ({ data: { success: true, data: [{ id: 1 }] } }));
  const entry = entryFor(cache, 'getDevices', {
    query: () => ({ url: '/devices' }),
    transformResponse: (response) => response.data,
  });

  await cache.runQuery(entry);
  assert.deepEqual(entry.data, [{ id: 1 }]);
  assert.equal(entry.status, 'fulfilled');
  assert.equal(entry.snapshot.isSuccess, true);
});

test('a transport error is surfaced, not swallowed', async () => {
  const { cache } = harness(async () => ({ error: { status: 401, data: null } }));
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  const result = await cache.runQuery(entry);
  assert.equal(result.error.status, 401);
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.snapshot.isError, true);
});

test('a throw inside an endpoint is reported like any other failure', async () => {
  const { cache } = harness(async () => ({ data: { success: true, data: null } }));
  const entry = entryFor(cache, 'getDevices', {
    query: () => ({ url: '/devices' }),
    transformResponse: () => {
      throw new Error('bad envelope');
    },
  });

  const result = await cache.runQuery(entry);
  assert.equal(result.error.status, 'CUSTOM_ERROR');
  assert.match(String(result.error.error), /bad envelope/);
});

test('a failed refresh keeps the last known good data on screen', async () => {
  let fail = false;
  const { cache } = harness(async () =>
    fail ? { error: { status: 500, data: null } } : { data: ['first'] }
  );
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  await cache.runQuery(entry);
  assert.deepEqual(entry.data, ['first']);

  fail = true;
  await cache.runQuery(entry);
  assert.equal(entry.status, 'rejected');
  assert.deepEqual(entry.data, ['first'], 'the screen must not blank on a failed refresh');
  assert.equal(entry.snapshot.isFetching, false);
});

test('initiate serves the cache and only refetches when told to', async () => {
  const { cache, calls } = harness(async () => ({ data: ['ok'] }));
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  cache.initiate(entry, false);
  await tick();
  assert.equal(calls.length, 1);

  // Already fulfilled: a second mount serves the cached value.
  cache.initiate(entry, false);
  await tick();
  assert.equal(calls.length, 1);

  cache.initiate(entry, true);
  await tick();
  assert.equal(calls.length, 2, 'refetchOnMountOrArgChange must force a request');
});

test('a numeric refetchOnMountOrArgChange refetches only once the value is stale', async () => {
  const { cache, calls } = harness(async () => ({ data: ['ok'] }));
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  await cache.runQuery(entry);
  assert.equal(calls.length, 1);

  cache.initiate(entry, 60);
  await tick();
  assert.equal(calls.length, 1, 'a value fetched moments ago is still fresh');

  entry.fulfilledTimeStamp = Date.now() - 61_000;
  cache.initiate(entry, 60);
  await tick();
  assert.equal(calls.length, 2);
});

test('two screens asking for the same data share one request', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cache, calls } = harness(async () => {
    await gate;
    return { data: ['ok'] };
  });
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  cache.initiate(entry, false);
  cache.initiate(entry, false);
  cache.initiate(entry, false);
  assert.equal(entry.status, 'pending');

  release();
  await tick();
  assert.equal(calls.length, 1);
});

test('a superseded reply never overwrites the newer one', async () => {
  const gates = [];
  const { cache } = harness(
    (_args, call) =>
      new Promise((resolve) => {
        gates.push(() => resolve({ data: [`call-${call}`] }));
      })
  );
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  const first = cache.runQuery(entry);
  const second = cache.runQuery(entry);

  // The newer request answers first, then the older, slower one lands.
  gates[1]();
  await second;
  assert.deepEqual(entry.data, ['call-2']);

  gates[0]();
  await first;
  assert.deepEqual(entry.data, ['call-2'], 'a late reply must not resurrect stale data');
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

test('a write refreshes what is on screen and drops what is not', async () => {
  const { cache, calls } = harness(async () => ({ data: ['ok'] }));

  const watched = entryFor(cache, 'getDevices', {
    query: () => ({ url: '/devices' }),
    providesTags: ['Device'],
  });
  cache.addSubscriber(watched);
  await cache.runQuery(watched);

  const unwatched = entryFor(
    cache,
    'getDevice',
    { query: (id) => ({ url: `/devices/${id}` }), providesTags: ['Device'] },
    3
  );
  await cache.runQuery(unwatched);

  const before = calls.length;
  cache.invalidateTags(['Device']);
  await tick();

  assert.equal(calls.length, before + 1, 'only the watched entry is refetched');
  assert.equal(cache.getEntry(unwatched.key), undefined, 'the unwatched entry is dropped');
  assert.equal(cache.getEntry(watched.key), watched, 'the watched entry keeps its identity');
});

test('invalidating one record leaves the others alone', async () => {
  const { cache, calls } = harness(async () => ({ data: ['ok'] }));
  const define = { query: (id) => ({ url: `/devices/${id}` }) };

  cache.register('getDevice', {
    kind: 'query',
    name: 'getDevice',
    ...define,
    providesTags: (_result, _error, id) => [{ type: 'Device', id }],
  });

  const five = cache.ensureEntry('getDevice', cache.keyFor('getDevice', 5), 5);
  const six = cache.ensureEntry('getDevice', cache.keyFor('getDevice', 6), 6);
  cache.addSubscriber(five);
  cache.addSubscriber(six);
  await cache.runQuery(five);
  await cache.runQuery(six);

  const before = calls.length;
  cache.invalidateTags([{ type: 'Device', id: 5 }]);
  await tick();
  assert.equal(calls.length, before + 1);

  // The broad tag reaches both.
  cache.invalidateTags(['Device']);
  await tick();
  assert.equal(calls.length, before + 3);
});

test('an entry whose request failed is still refreshed by an invalidation', async () => {
  let fail = true;
  const { cache } = harness(async () =>
    fail ? { error: { status: 500, data: null } } : { data: ['recovered'] }
  );
  const entry = entryFor(cache, 'getDevices', {
    query: () => ({ url: '/devices' }),
    providesTags: ['Device'],
  });
  cache.addSubscriber(entry);
  await cache.runQuery(entry);
  assert.equal(entry.status, 'rejected');

  fail = false;
  cache.invalidateTags(['Device']);
  await tick();
  assert.deepEqual(entry.data, ['recovered']);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test('data outlives the screen that used it, then is dropped', async () => {
  const { cache } = harness(async () => ({ data: ['ok'] }));
  const entry = entryFor(cache, 'getDevices', {
    query: () => ({ url: '/devices' }),
    keepUnusedDataFor: 25,
  });

  cache.addSubscriber(entry);
  await cache.runQuery(entry);
  cache.removeSubscriber(entry);

  assert.equal(cache.getEntry(entry.key), entry, 'still cached right after unmount');
  await wait(60);
  assert.equal(cache.getEntry(entry.key), undefined, 'dropped once nothing came back for it');
});

test('coming straight back cancels the drop', async () => {
  const { cache } = harness(async () => ({ data: ['ok'] }));
  const entry = entryFor(cache, 'getDevices', {
    query: () => ({ url: '/devices' }),
    keepUnusedDataFor: 25,
  });

  cache.addSubscriber(entry);
  await cache.runQuery(entry);
  cache.removeSubscriber(entry);
  cache.addSubscriber(entry);

  await wait(60);
  assert.equal(cache.getEntry(entry.key), entry);
  assert.deepEqual(entry.data, ['ok']);
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

test('a reset blanks every entry immediately', async () => {
  const { cache } = harness(async () => ({ data: ['ok'] }));
  const watched = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });
  cache.addSubscriber(watched);
  await cache.runQuery(watched);

  cache.resetApiState();
  assert.equal(watched.data, undefined, 'no previous-tenant data may be rendered, even briefly');
  assert.equal(watched.snapshot.isUninitialized, true);
});

test('a reset refetches what is still on screen, on the next tick', async () => {
  const { cache, calls } = harness(async () => ({ data: ['ok'] }));
  const watched = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });
  cache.addSubscriber(watched);
  await cache.runQuery(watched);

  cache.resetApiState();
  assert.equal(calls.length, 1, 'the refetch must not run in the same tick as the state change');

  await wait(5);
  assert.equal(calls.length, 2);
  assert.deepEqual(watched.data, ['ok']);
  assert.equal(cache.getEntry(watched.key), watched, 'the entry object is reused, not replaced');
});

test('a reset drops entries nothing is watching, and does not refetch them', async () => {
  const { cache, calls } = harness(async () => ({ data: ['ok'] }));
  const orphan = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });
  await cache.runQuery(orphan);

  cache.resetApiState();
  await wait(5);

  assert.equal(cache.getEntry(orphan.key), undefined);
  assert.equal(calls.length, 1);
  assert.equal(cache.size(), 0);
});

test('a reply already on the wire when the session ended is discarded', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cache } = harness(async () => {
    await gate;
    return { data: ['previous-tenant'] };
  });
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });
  cache.addSubscriber(entry);

  const inFlight = cache.runQuery(entry);
  cache.resetApiState();
  release();
  await inFlight;

  assert.notDeepEqual(entry.data, ['previous-tenant']);
});

test('a listener is told about every state change of its entry', async () => {
  const { cache } = harness(async () => ({ data: ['ok'] }));
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  const seen = [];
  const unsubscribe = cache.addListener(entry, () => seen.push(entry.snapshot.status));
  await cache.runQuery(entry);
  assert.deepEqual(seen, ['pending', 'fulfilled']);

  unsubscribe();
  await cache.runQuery(entry);
  assert.deepEqual(seen, ['pending', 'fulfilled'], 'an unsubscribed listener is not called');
});

test('a first load reads as loading; a refresh over data does not', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cache } = harness(async () => {
    await gate;
    return { data: ['ok'] };
  });
  const entry = entryFor(cache, 'getDevices', { query: () => ({ url: '/devices' }) });

  const first = cache.runQuery(entry);
  assert.equal(entry.snapshot.isLoading, true);
  assert.equal(entry.snapshot.isFetching, true);
  release();
  await first;

  cache.runQuery(entry);
  assert.equal(entry.snapshot.isLoading, false, 'a refresh must not replace the list with a spinner');
  assert.equal(entry.snapshot.isFetching, true);
  assert.equal(entry.snapshot.isSuccess, true, 'the data is still usable while it refreshes');
});
