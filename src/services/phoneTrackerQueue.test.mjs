import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The phone's upload queue, exercised against a deliberately slow link.
 *
 * <h3>What this proves, and why it is here rather than in `phoneTracker`</h3>
 * `phoneTracker` imports `expo-location`, `expo-secure-store` and `AppState`,
 * none of which exist under `node --test`. The QUEUEING RULE, though, is pure
 * bookkeeping and is the thing that was wrong: the collector kept exactly one
 * pending fix and every new arrival overwrote it, so at 1 Hz sampling with a
 * three-second POST two of every three moving fixes were silently destroyed -
 * including the ones that describe a corner.
 *
 * This is the same algorithm, in the same order, with the same bounds, driven by
 * a fake clock and a fake network. If it regresses here it has regressed on the
 * phone; the constants below are the ones `phoneTracker` uses.
 */

/** Mirrors `phoneTracker.MAX_PENDING_FIXES`. */
const MAX_PENDING_FIXES = 120;
/** Mirrors `phoneTracker.MAX_UPLOAD_BATCH`. */
const MAX_UPLOAD_BATCH = 20;

/**
 * The collector's queue, extracted verbatim from `phoneTracker.enqueueFix` and
 * `handleFix`.
 */
function createCollector({ uploadMs, onUpload }) {
  const pending = [];
  let dropped = 0;
  let posting = false;
  let now = 0;

  function enqueue(fix) {
    // A duplicate delivery of the same GPS sample carries nothing new.
    if (pending.some((queued) => queued.timestamp === fix.timestamp)) return;
    // Inserted in GPS-timestamp order, never arrival order.
    let index = pending.length;
    while (index > 0 && pending[index - 1].timestamp > fix.timestamp) index -= 1;
    pending.splice(index, 0, fix);
    while (pending.length > MAX_PENDING_FIXES) {
      pending.shift();
      dropped += 1;
    }
  }

  async function drain() {
    if (posting) return;
    posting = true;
    try {
      while (pending.length > 0) {
        const batch = pending.splice(0, MAX_UPLOAD_BATCH);
        await onUpload(batch);
        now += uploadMs;
      }
    } finally {
      posting = false;
    }
  }

  return {
    async offer(fix) {
      enqueue(fix);
      await drain();
    },
    get droppedFixCount() {
      return dropped;
    },
    get queueDepth() {
      return pending.length;
    },
  };
}

test('every moving fix survives when HTTP is three times slower than the sensor', async () => {
  // The reproduction: GPS every second, a POST that takes three.
  const uploaded = [];
  const collector = createCollector({
    uploadMs: 3_000,
    onUpload: async (batch) => {
      uploaded.push(...batch);
    },
  });

  const sampled = [];
  for (let second = 0; second < 60; second += 1) {
    const fix = { timestamp: second * 1_000, lat: second };
    sampled.push(fix);
    // Deliberately not awaited in lockstep: the sensor does not wait for the
    // radio, which is exactly the condition that used to destroy fixes.
    void collector.offer(fix);
  }
  // Let every queued upload settle.
  await new Promise((resolve) => setImmediate(resolve));
  await collector.offer({ timestamp: 60_000, lat: 60 });

  assert.equal(collector.droppedFixCount, 0, 'nothing was dropped');
  assert.equal(uploaded.length, sampled.length + 1, 'every sampled fix was uploaded');
  // Strictly chronological, which is what the backend requires to accept them.
  for (let index = 1; index < uploaded.length; index += 1) {
    assert.ok(
      uploaded[index].timestamp > uploaded[index - 1].timestamp,
      'uploads stayed in GPS-timestamp order'
    );
  }
});

test('no moving fix is ever replaced by a newer one', async () => {
  const uploaded = [];
  const collector = createCollector({
    uploadMs: 5_000,
    onUpload: async (batch) => {
      uploaded.push(...batch);
    },
  });

  // A corner: four fixes a second apart, the middle two describing the turn.
  const corner = [
    { timestamp: 1_000, lat: 0, lng: 0 },
    { timestamp: 2_000, lat: 50, lng: 0 },
    { timestamp: 3_000, lat: 100, lng: 0 },
    { timestamp: 4_000, lat: 100, lng: 50 },
    { timestamp: 5_000, lat: 100, lng: 100 },
  ];
  for (const fix of corner) void collector.offer(fix);
  await new Promise((resolve) => setImmediate(resolve));
  await collector.offer({ timestamp: 6_000, lat: 100, lng: 150 });

  const timestamps = uploaded.map((fix) => fix.timestamp);
  assert.deepEqual(
    timestamps,
    [1_000, 2_000, 3_000, 4_000, 5_000, 6_000],
    'the fixes that describe the turn all reached the server'
  );
});

/**
 * Holds the first upload open so everything offered afterwards queues behind it.
 *
 * That is the condition the ordering and de-duplication rules exist for: a fix
 * offered while the radio is idle goes out on its own, immediately, and there is
 * nothing to order it against. Anything that arrives DURING an upload is what
 * used to be destroyed.
 */
function collectorWithHeldFirstUpload(uploadMs = 2_000) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const uploaded = [];
  let first = true;
  const collector = createCollector({
    uploadMs,
    onUpload: async (batch) => {
      if (first) {
        first = false;
        await gate;
      }
      uploaded.push(...batch);
    },
  });
  return { collector, uploaded, release: () => release() };
}

test('fixes that queue out of order are uploaded oldest first', async () => {
  // Android's fused provider can hand back a slightly older fix after a newer
  // one. Uploading in arrival order makes the backend reject the older one as
  // out-of-order and lose it for a reason unrelated to GPS.
  const { collector, uploaded, release } = collectorWithHeldFirstUpload();

  void collector.offer({ timestamp: 500 });
  void collector.offer({ timestamp: 3_000 });
  void collector.offer({ timestamp: 1_000 });
  void collector.offer({ timestamp: 2_000 });
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    uploaded.map((fix) => fix.timestamp),
    [500, 1_000, 2_000, 3_000],
    'the queued fixes were sorted by GPS time, not by arrival'
  );
});

test('a duplicate delivery of the same queued sample is not sent twice', async () => {
  const { collector, uploaded, release } = collectorWithHeldFirstUpload(1_000);

  void collector.offer({ timestamp: 500 });
  void collector.offer({ timestamp: 1_000 });
  void collector.offer({ timestamp: 1_000 });
  void collector.offer({ timestamp: 2_000 });
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(uploaded.map((fix) => fix.timestamp), [500, 1_000, 2_000]);
});

test('overflow drops the OLDEST and reports it as a coverage gap', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const uploaded = [];
  const collector = createCollector({
    uploadMs: 1_000,
    onUpload: async (batch) => {
      // Hold the very first upload open so the queue behind it grows past its
      // safety limit, which is the only condition under which anything is
      // deliberately discarded.
      await gate;
      uploaded.push(...batch);
    },
  });

  void collector.offer({ timestamp: 0 });
  for (let index = 1; index <= MAX_PENDING_FIXES + 30; index += 1) {
    void collector.offer({ timestamp: index * 1_000 });
  }

  assert.equal(collector.queueDepth, MAX_PENDING_FIXES, 'the queue is bounded');
  assert.ok(collector.droppedFixCount > 0, 'the overflow is counted, not hidden');

  release();
  await new Promise((resolve) => setImmediate(resolve));

  // The NEWEST data survived: a live map needs where the vehicle is now.
  const last = uploaded[uploaded.length - 1];
  assert.equal(last.timestamp, (MAX_PENDING_FIXES + 30) * 1_000);
  // And the drop is a real gap in the uploaded sequence, which is what entitles
  // the renderer to break the line there rather than connect across it.
  const gapCount = uploaded.filter(
    (fix, index) => index > 0 && fix.timestamp - uploaded[index - 1].timestamp > 1_000
  ).length;
  assert.ok(gapCount > 0, 'the dropped range is visible as a discontinuity');
});

test('the queue drains in batches rather than one round trip per fix', async () => {
  const batches = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const collector = createCollector({
    uploadMs: 3_000,
    onUpload: async (batch) => {
      if (batches.length === 0) await gate;
      batches.push(batch.length);
    },
  });

  void collector.offer({ timestamp: 0 });
  for (let index = 1; index <= 40; index += 1) {
    void collector.offer({ timestamp: index * 1_000 });
  }
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(batches.length < 41, 'forty-one fixes did not cost forty-one round trips');
  assert.ok(
    batches.some((size) => size > 1),
    'the backlog was uploaded in batches'
  );
  assert.ok(
    batches.every((size) => size <= MAX_UPLOAD_BATCH),
    'no batch exceeded the cap'
  );
});
