/**
 * Converts a recorded GPS duration into a usable wall-clock playback duration.
 *
 * The old implementation forced every route into 30 seconds. Its first fix
 * still compressed the recorded clock by 30x, so even the UI's slow 0.5x mode
 * moved at 15x real time. On an ordinary city trip that makes the marker skip
 * whole junctions between frames and makes a correctly matched road look like
 * a bad route.
 *
 * Standard playback now advances four recorded seconds per wall-clock second.
 * The speed chips remain useful (0.5x = a relaxed 2x recorded clock, 4x = a
 * quick 16x scan), while the normal setting leaves enough frames for curves,
 * stops and bearing changes to be visible. Very short and multi-day ranges are
 * still bounded, but the bounds are intentionally much less aggressive.
 */
export const PLAYBACK_TIME_COMPRESSION = 4;
export const MIN_PLAYBACK_WALL_MS = 2 * 60_000;
export const MAX_PLAYBACK_WALL_MS = 60 * 60_000;

export function playbackWallDurationMs(recordedDurationMs: number): number {
  if (!Number.isFinite(recordedDurationMs) || recordedDurationMs <= 0) {
    return MIN_PLAYBACK_WALL_MS;
  }
  return Math.min(
    MAX_PLAYBACK_WALL_MS,
    Math.max(MIN_PLAYBACK_WALL_MS, recordedDurationMs / PLAYBACK_TIME_COMPRESSION)
  );
}

/** Recorded milliseconds advanced for one wall-clock frame. */
export function advancePlaybackElapsed(
  elapsedMs: number,
  frameDeltaMs: number,
  recordedDurationMs: number,
  speed: number
): number {
  const duration = Math.max(0, recordedDurationMs);
  if (duration === 0) return 0;
  const wallDuration = playbackWallDurationMs(duration);
  const rate = duration / wallDuration;
  return Math.min(duration, Math.max(0, elapsedMs) + Math.max(0, frameDeltaMs) * rate * speed);
}
