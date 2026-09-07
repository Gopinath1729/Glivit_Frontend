import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advancePlaybackElapsed,
  PLAYBACK_RATE_AT_1X,
  playbackWallDurationMs,
} from './playbackClock.ts';

test('1x is real time: the marker takes as long as the vehicle did', () => {
  assert.equal(PLAYBACK_RATE_AT_1X, 1);
  const recorded = (8 * 60 + 1) * 1_000; // the THIRU trip: 2.5 km in 8m 01s
  assert.equal(playbackWallDurationMs(recorded, 1), recorded);
  assert.equal(advancePlaybackElapsed(0, 1_000, recorded, 1), 1_000);
});

test('a chip is a literal multiple of real time', () => {
  const recorded = 60 * 60_000;
  assert.equal(advancePlaybackElapsed(0, 1_000, recorded, 0.5), 500);
  assert.equal(advancePlaybackElapsed(0, 1_000, recorded, 2), 2_000);
  assert.equal(advancePlaybackElapsed(0, 1_000, recorded, 4), 4_000);
  assert.equal(playbackWallDurationMs(recorded, 2), 30 * 60_000);
  assert.equal(playbackWallDurationMs(recorded, 4), 15 * 60_000);
});

test('the chip means the same thing however long the recording is', () => {
  // The old clock's two-minute floor and sixty-minute ceiling made the rate a
  // function of trip length: 0.5x ran at 2x real time on an eight-minute trip
  // and at 84x on a week-long range. One wall second is now one recorded second
  // at 1x on every one of them.
  for (const recorded of [90_000, 8 * 60_000, 60 * 60_000, 48 * 60 * 60_000]) {
    assert.equal(advancePlaybackElapsed(0, 1_000, recorded, 1), 1_000);
    assert.equal(playbackWallDurationMs(recorded, 1), recorded);
  }
});

test('the slow chip is genuinely slower than real time', () => {
  // The reported bug in one line: the screenshot sat on 0.5x while the vehicle
  // crossed the map at 2x, because compression was applied before the chip.
  const recorded = (8 * 60 + 1) * 1_000;
  assert.equal(advancePlaybackElapsed(0, 10_000, recorded, 0.5), 5_000);
});

test('the playhead is anchored, so a dropped frame costs no time', () => {
  const recorded = 10 * 60_000;
  // One 900 ms stall resolves to exactly the elapsed value the wall clock says,
  // where summing 50 ms-clamped frame deltas would have lost 850 ms of it.
  assert.equal(advancePlaybackElapsed(0, 900, recorded, 1), 900);
  // Anchored advancement equals the same span taken in one step.
  const inOneStep = advancePlaybackElapsed(0, 3_000, recorded, 2);
  const viaAnchor = advancePlaybackElapsed(
    advancePlaybackElapsed(0, 1_000, recorded, 2),
    2_000,
    recorded,
    2
  );
  assert.equal(viaAnchor, inOneStep);
});

test('the playhead is monotonic and never runs past the recording', () => {
  const recorded = 60 * 60_000;
  assert.equal(advancePlaybackElapsed(recorded - 1, 1_000, recorded, 4), recorded);
  assert.equal(advancePlaybackElapsed(recorded + 5_000, 1_000, recorded, 1), recorded);
  assert.equal(advancePlaybackElapsed(-5_000, 0, recorded, 1), 0);
  assert.equal(advancePlaybackElapsed(1_000, -500, recorded, 1), 1_000);
});

test('a degenerate duration or speed cannot stall or reverse playback', () => {
  assert.equal(advancePlaybackElapsed(0, 1_000, 0, 1), 0);
  assert.equal(advancePlaybackElapsed(0, 1_000, Number.NaN, 1), 0);
  assert.equal(playbackWallDurationMs(0, 1), 0);
  assert.equal(playbackWallDurationMs(Number.NaN, 1), 0);
  // A missing or nonsensical chip falls back to real time rather than freezing.
  assert.equal(advancePlaybackElapsed(0, 1_000, 60_000, 0), 1_000);
  assert.equal(advancePlaybackElapsed(0, 1_000, 60_000, Number.NaN), 1_000);
});
