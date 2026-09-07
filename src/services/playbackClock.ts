/**
 * The playback clock: the recorded timeline advanced against the wall clock.
 *
 * A speed chip is a literal multiple of real time. `1x` means one recorded
 * second per wall-clock second, so the marker crosses the map at exactly the
 * speed the vehicle drove and the km/h readout under it is the truth about the
 * marker as well as about the recording. `2x` is twice that, `0.5x` is half.
 *
 * <h3>Why the compression was removed</h3>
 * This module used to squeeze the recorded timeline BEFORE the chip was applied
 * — four recorded seconds per wall second, then clamped into a wall-clock
 * duration between two and sixty minutes. Because the clamps are what actually
 * decided the rate on most trips, the factor depended on how long the trip
 * happened to be, and one chip therefore meant a different speed on every trip:
 *
 *   - an 8-minute city trip: `0.5x` ran at 2x real time;
 *   - a 90-second errand: the two-minute floor made `0.5x` run at 0.375x;
 *   - a week-long range: the sixty-minute ceiling made `1x` run at 168x, so the
 *     marker jumped whole junctions between frames.
 *
 * That is the whole of "playback goes fast and the timer is wrong": the vehicle
 * outran its own speed readout, and the elapsed clock advanced several recorded
 * minutes per wall-clock minute. Nothing scales the timeline now. The chip is
 * the entire rate, so the elapsed readout and the wall clock agree at `1x` and
 * stay in a stated ratio at every other chip.
 */

/** Recorded milliseconds advanced per wall-clock millisecond at the `1x` chip. */
export const PLAYBACK_RATE_AT_1X = 1;

/** Wall-clock milliseconds a recording of this length takes to play at `speed`. */
export function playbackWallDurationMs(recordedDurationMs: number, speed = 1): number {
  if (!Number.isFinite(recordedDurationMs) || recordedDurationMs <= 0) return 0;
  const rate = normalizedSpeed(speed);
  return recordedDurationMs / (PLAYBACK_RATE_AT_1X * rate);
}

/**
 * A speed chip reduced to a usable multiplier.
 *
 * A non-finite or non-positive speed would either freeze the playhead or drive
 * it backwards past the clamp in {@link advancePlaybackElapsed}, so it falls
 * back to real time rather than to a stalled screen.
 */
function normalizedSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

/**
 * The playhead moved forward by a stretch of wall-clock time.
 *
 * Deliberately expressed against an ANCHOR rather than as a per-frame
 * accumulation: pass the elapsed value and the wall-clock milliseconds since it
 * was taken, and the result is exact no matter how many frames were dropped in
 * between. Summing clamped frame deltas instead loses every millisecond a slow
 * frame overran by, which on this screen — it re-renders a map and re-clips a
 * polyline per frame — silently ran playback behind real time.
 */
export function advancePlaybackElapsed(
  elapsedMs: number,
  wallDeltaMs: number,
  recordedDurationMs: number,
  speed: number
): number {
  // `Math.max(0, NaN)` is NaN, so a non-finite duration has to be refused
  // explicitly. It used not to be, and the NaN propagated into the progress
  // fraction, out to the scrubber's `width` and on to the marker's coordinate.
  if (!Number.isFinite(recordedDurationMs) || recordedDurationMs <= 0) return 0;
  const duration = recordedDurationMs;
  const from = Math.min(duration, Math.max(0, elapsedMs));
  const delta = Math.max(0, wallDeltaMs) * PLAYBACK_RATE_AT_1X * normalizedSpeed(speed);
  return Math.min(duration, from + delta);
}
