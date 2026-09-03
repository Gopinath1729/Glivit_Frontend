import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advancePlaybackElapsed,
  MAX_PLAYBACK_WALL_MS,
  MIN_PLAYBACK_WALL_MS,
  playbackWallDurationMs,
} from './playbackClock.ts';

test('short routes never flash by in less than one minute', () => {
  assert.equal(playbackWallDurationMs(10 * 60_000), MIN_PLAYBACK_WALL_MS);
});

test('ordinary routes retain proportional recorded timing', () => {
  assert.equal(playbackWallDurationMs(60 * 60_000), 2 * 60_000);
});

test('very long ranges stay bounded', () => {
  assert.equal(playbackWallDurationMs(48 * 60 * 60_000), MAX_PLAYBACK_WALL_MS);
});

test('frame advancement is monotonic, speed-aware, and capped', () => {
  const duration = 60 * 60_000;
  const first = advancePlaybackElapsed(0, 1_000, duration, 1);
  const faster = advancePlaybackElapsed(0, 1_000, duration, 2);
  assert.ok(first > 0);
  assert.equal(faster, first * 2);
  assert.equal(advancePlaybackElapsed(duration - 1, 1_000, duration, 8), duration);
});
