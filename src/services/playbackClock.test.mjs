import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advancePlaybackElapsed,
  MAX_PLAYBACK_WALL_MS,
  MIN_PLAYBACK_WALL_MS,
  playbackWallDurationMs,
} from './playbackClock.ts';

test('short routes never flash by in less than two minutes', () => {
  // Anything under eight recorded minutes compresses below the floor, so the
  // floor is what it gets. A ninety-second errand played back in twenty-two
  // seconds is unreadable, which is the whole reason the floor exists.
  assert.equal(playbackWallDurationMs(90_000), MIN_PLAYBACK_WALL_MS);
  assert.equal(playbackWallDurationMs(8 * 60_000), MIN_PLAYBACK_WALL_MS);
});

test('a route long enough to clear the floor keeps its own proportional timing', () => {
  // Ten recorded minutes is past the floor: 4x compression, not the clamp.
  assert.equal(playbackWallDurationMs(10 * 60_000), 150_000);
});

test('ordinary routes retain proportional recorded timing', () => {
  assert.equal(playbackWallDurationMs(60 * 60_000), 15 * 60_000);
});

test('very long ranges stay bounded', () => {
  assert.equal(playbackWallDurationMs(48 * 60 * 60_000), MAX_PLAYBACK_WALL_MS);
});

test('frame advancement is monotonic, speed-aware, and capped', () => {
  const duration = 60 * 60_000;
  const first = advancePlaybackElapsed(0, 1_000, duration, 1);
  const faster = advancePlaybackElapsed(0, 1_000, duration, 2);
  assert.equal(first, 4_000, 'normal playback advances four recorded seconds per wall second');
  assert.equal(faster, first * 2);
  assert.equal(advancePlaybackElapsed(duration - 1, 1_000, duration, 8), duration);
});

test('the device trip no longer races even in the slow mode', () => {
  const recorded = (32 * 60 + 37) * 1_000;
  const afterTenSeconds = advancePlaybackElapsed(0, 10_000, recorded, 0.5);
  assert.equal(afterTenSeconds, 20_000);
  assert.equal(playbackWallDurationMs(recorded), recorded / 4);
});
