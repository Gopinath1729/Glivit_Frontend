/**
 * Converts a recorded GPS duration into a usable wall-clock playback duration.
 *
 * The old implementation forced every route into 30 seconds. A full working
 * day therefore shot across the map, while a short trip moved at the same rate.
 * This keeps timing proportional to the real timestamps: standard playback is
 * 30x recorded time, never shorter than one minute and never longer than twenty.
 */
export const PLAYBACK_TIME_COMPRESSION = 30;
export const MIN_PLAYBACK_WALL_MS = 60_000;
export const MAX_PLAYBACK_WALL_MS = 20 * 60_000;

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

