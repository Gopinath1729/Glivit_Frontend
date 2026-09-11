import type { PlaybackTrack } from '@/src/services/playbackEngine';
import type { PlaybackStopMarker, PlaybackTimelineSegment } from '@/src/types/api';

/**
 * Playback time is not recorded time.
 *
 * <h3>The problem</h3>
 * A vehicle that drove three kilometres, sat outside a friend's house for five
 * hours and drove home is a twenty-minute journey wrapped around five hours of
 * nothing. Played at 1x — where one recorded second is one wall-clock second,
 * which is what makes the speed readout mean anything — the screen shows a
 * parked car for five hours. At 4x it shows a parked car for seventy-five
 * minutes. No speed chip fixes this, because the problem is not the rate: it is
 * that a stop carries no information per second, and driving carries all of it.
 *
 * <h3>What this does</h3>
 * It builds a schedule: a piecewise map from ANIMATION time to RECORDED time.
 * Driving maps one-to-one, so the speed readout, the km/h under the marker and
 * the elapsed clock all still mean exactly what they say. Stops are given a
 * budget instead of their duration, by how long they lasted:
 *
 *   - under two minutes  — played in full. A pause at a light IS the journey.
 *   - two to fifteen     — condensed. The clock visibly races through it, which
 *                          reads as "nothing happened here" without hiding it.
 *   - over fifteen       — held. The vehicle freezes at the last road-matched
 *                          position it was seen in, a card names the stop, and
 *                          after a beat the clock jumps to the first validated
 *                          movement after it.
 *
 * <h3>What this deliberately does not do</h3>
 * It does not touch the recording. Every fix, every stop, every second of the
 * five hours is still in the track, still on the timeline, still in the totals
 * and still in the reports. Distance does not move while the vehicle is
 * stopped, because the vehicle did not move. The only thing compressed is how
 * long you have to sit and watch it.
 */

/** Under this, a stop is part of the drive and is played as recorded. */
export const SHORT_STOP_MS = 2 * 60 * 1000;
/** Over this, a stop is held and skipped rather than condensed. */
export const LONG_STOP_MS = 15 * 60 * 1000;
/** Animation time a held stop is given, so the card can be read. */
export const HELD_STOP_PLAYBACK_MS = 1_600;
/** Bounds on the animation time a condensed stop may take. */
export const CONDENSED_STOP_MIN_MS = 1_500;
export const CONDENSED_STOP_MAX_MS = 3_000;
/** Recorded milliseconds per animation millisecond while condensing. */
const CONDENSE_RATE = 60;

/** How a stop is played, which is also what the screen says about it. */
export type StopPlaybackMode = 'real' | 'condensed' | 'held';

export type ScheduledStop = {
  /** Recorded-clock offsets from the start of the track, in ms. */
  fromMs: number;
  toMs: number;
  /** What the recording says, always: real elapsed time. Never compressed. */
  durationMs: number;
  mode: StopPlaybackMode;
  /** Animation time this stop consumes. Equals durationMs only when 'real'. */
  playbackMs: number;
  /** Absolute wall-clock instants, for the readout. */
  startedAt: number;
  endedAt: number;
  latitude: number;
  longitude: number;
  address: string | null;
  /** 1-based journey position, matching the map's stop pins where known. */
  index: number | null;
};

/** One span of the map from animation time to recorded time. */
type ScheduleSpan = {
  playbackFrom: number;
  playbackTo: number;
  recordedFrom: number;
  recordedTo: number;
  /** Set when this span is a stop being held: recorded time does not advance. */
  heldStop: ScheduledStop | null;
};

export type PlaybackSchedule = {
  spans: ScheduleSpan[];
  stops: ScheduledStop[];
  /** Wall-clock length of the animation at 1x. */
  totalPlaybackMs: number;
  /** Recorded length of the journey. Unchanged by any of this. */
  totalRecordedMs: number;
  /** True when at least one stop is not played as recorded. */
  compressed: boolean;
};

/** The schedule that plays a recording exactly as it happened. */
export function realTimeSchedule(totalRecordedMs: number): PlaybackSchedule {
  const total = Number.isFinite(totalRecordedMs) && totalRecordedMs > 0 ? totalRecordedMs : 0;
  return {
    spans: [
      { playbackFrom: 0, playbackTo: total, recordedFrom: 0, recordedTo: total, heldStop: null },
    ],
    stops: [],
    totalPlaybackMs: total,
    totalRecordedMs: total,
    compressed: false,
  };
}

function stopMode(durationMs: number): StopPlaybackMode {
  if (durationMs < SHORT_STOP_MS) return 'real';
  return durationMs > LONG_STOP_MS ? 'held' : 'condensed';
}

/**
 * The animation time a stop is given, at a given speed chip.
 *
 * Scaled BY the chip so the wall-clock result is the same at every chip: the
 * chip multiplies animation time, and a card you are meant to read in a second
 * and a half is not readable in four hundred milliseconds because someone chose
 * 4x. The chip goes on meaning exactly what it says about driving, which is the
 * only part of a recording where a rate is a fact about the vehicle.
 */
function stopPlaybackMs(durationMs: number, mode: StopPlaybackMode, speed: number): number {
  if (mode === 'real') return durationMs;
  if (mode === 'held') return HELD_STOP_PLAYBACK_MS * speed;
  const condensed = Math.min(
    CONDENSED_STOP_MAX_MS,
    Math.max(CONDENSED_STOP_MIN_MS, durationMs / CONDENSE_RATE)
  );
  // Never longer than the stop itself: at 0.5x a two-minute stop must not be
  // given more animation time than simply playing it would have taken.
  return Math.min(durationMs, condensed * speed);
}

/**
 * Build the schedule for a recording.
 *
 * Stops come from the backend's own timeline, which is the same span list the
 * timeline strip and the trip reports are drawn from — so what is compressed
 * here is exactly what the screen calls a stop, and never a stretch of driving
 * that merely looked slow.
 *
 * Passing `compress: false` returns the real-time schedule, which is what the
 * "Show full stops" setting selects. `speed` is the active chip, and only
 * affects how much animation time a compressed stop is given — see
 * {@link stopPlaybackMs}.
 */
export function buildPlaybackSchedule(
  track: PlaybackTrack,
  timeline: readonly PlaybackTimelineSegment[],
  stopMarkers: readonly PlaybackStopMarker[] = [],
  options: { compress?: boolean; speed?: number } = {}
): PlaybackSchedule {
  const speed = Number.isFinite(options.speed) && (options.speed as number) > 0
    ? (options.speed as number)
    : 1;
  const totalRecordedMs = track.totalDurationMs;
  if (options.compress === false || !Number.isFinite(totalRecordedMs) || totalRecordedMs <= 0) {
    return realTimeSchedule(totalRecordedMs);
  }

  const trackStart = Date.parse(track.points[0]?.t ?? '');
  if (!Number.isFinite(trackStart)) return realTimeSchedule(totalRecordedMs);

  const stops: ScheduledStop[] = [];
  for (const segment of timeline) {
    if (segment.type !== 'STOPPED') continue;
    const from = Date.parse(segment.from);
    const to = Date.parse(segment.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;

    // Clamped into the track's own window: a span the backend reports slightly
    // outside the fixes it sent must not push the playhead past either end.
    const fromMs = Math.max(0, Math.min(totalRecordedMs, from - trackStart));
    const toMs = Math.max(0, Math.min(totalRecordedMs, to - trackStart));
    if (toMs <= fromMs) continue;

    const durationMs = to - from;
    const mode = stopMode(durationMs);
    if (mode === 'real') continue;

    const marker =
      segment.stopIndex != null
        ? stopMarkers.find((stop) => stop.index === segment.stopIndex)
        : undefined;

    stops.push({
      fromMs,
      toMs,
      durationMs,
      mode,
      playbackMs: stopPlaybackMs(durationMs, mode, speed),
      startedAt: from,
      endedAt: to,
      latitude: marker?.lat ?? segment.startLat,
      longitude: marker?.lng ?? segment.startLng,
      address: marker?.address ?? segment.startAddress ?? null,
      index: segment.stopIndex ?? marker?.index ?? null,
    });
  }

  stops.sort((a, b) => a.fromMs - b.fromMs);

  // Overlapping spans would make the map non-monotonic, and a playhead that can
  // go backwards is worse than one that sits still.
  const ordered: ScheduledStop[] = [];
  for (const stop of stops) {
    const previous = ordered[ordered.length - 1];
    if (previous && stop.fromMs < previous.toMs) continue;
    ordered.push(stop);
  }

  if (ordered.length === 0) return realTimeSchedule(totalRecordedMs);

  const spans: ScheduleSpan[] = [];
  let recordedCursor = 0;
  let playbackCursor = 0;

  const addSpan = (recordedTo: number, playbackLength: number, heldStop: ScheduledStop | null) => {
    spans.push({
      playbackFrom: playbackCursor,
      playbackTo: playbackCursor + playbackLength,
      recordedFrom: recordedCursor,
      recordedTo,
      heldStop,
    });
    playbackCursor += playbackLength;
    recordedCursor = recordedTo;
  };

  for (const stop of ordered) {
    if (stop.fromMs > recordedCursor) {
      // Driving, at real time. This is the part whose speed readout has to
      // remain literally true, so it is never scaled.
      addSpan(stop.fromMs, stop.fromMs - recordedCursor, null);
    }
    addSpan(stop.toMs, stop.playbackMs, stop.mode === 'held' ? stop : null);
  }
  if (recordedCursor < totalRecordedMs) {
    addSpan(totalRecordedMs, totalRecordedMs - recordedCursor, null);
  }

  return {
    spans,
    stops: ordered,
    totalPlaybackMs: playbackCursor,
    totalRecordedMs,
    compressed: true,
  };
}

function spanAtPlayback(schedule: PlaybackSchedule, playbackMs: number): ScheduleSpan | null {
  const { spans } = schedule;
  if (spans.length === 0) return null;
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (spans[middle].playbackFrom <= playbackMs) low = middle;
    else high = middle - 1;
  }
  return spans[low];
}

/** Where a moment of animation sits on the recorded clock. */
export function recordedAtPlayback(schedule: PlaybackSchedule, playbackMs: number): number {
  const clamped = Math.max(0, Math.min(schedule.totalPlaybackMs, playbackMs));
  const span = spanAtPlayback(schedule, clamped);
  if (!span) return 0;
  // A held stop does not advance the recorded clock at all: the vehicle stays
  // where it was last seen and the readout keeps saying so, until the hold ends
  // and the clock jumps to the first validated movement after it.
  if (span.heldStop) return span.recordedFrom;
  const playbackLength = span.playbackTo - span.playbackFrom;
  if (playbackLength <= 0) return span.recordedTo;
  const share = (clamped - span.playbackFrom) / playbackLength;
  return span.recordedFrom + (span.recordedTo - span.recordedFrom) * share;
}

/**
 * Where a moment of the recording sits in the animation.
 *
 * The inverse of {@link recordedAtPlayback}, and what a scrub has to go
 * through: the scrubber is drawn against recorded time so a five-hour stop
 * still occupies five hours of the strip, but the clock that plays it runs on
 * animation time. Scrubbing into a held stop lands at the START of its hold, so
 * the card is shown rather than skipped past.
 */
export function playbackAtRecorded(schedule: PlaybackSchedule, recordedMs: number): number {
  const clamped = Math.max(0, Math.min(schedule.totalRecordedMs, recordedMs));
  for (const span of schedule.spans) {
    if (clamped > span.recordedTo) continue;
    if (span.heldStop) return span.playbackFrom;
    const recordedLength = span.recordedTo - span.recordedFrom;
    if (recordedLength <= 0) return span.playbackFrom;
    const share = (clamped - span.recordedFrom) / recordedLength;
    return span.playbackFrom + (span.playbackTo - span.playbackFrom) * share;
  }
  return schedule.totalPlaybackMs;
}

/** The stop being held at this moment of the animation, if any. */
export function heldStopAtPlayback(
  schedule: PlaybackSchedule,
  playbackMs: number
): ScheduledStop | null {
  const span = spanAtPlayback(schedule, Math.max(0, Math.min(schedule.totalPlaybackMs, playbackMs)));
  return span?.heldStop ?? null;
}

/**
 * The scheduled stop covering a moment of the RECORDING, if any.
 *
 * The end is exclusive on purpose: the instant a hold releases, the clock lands
 * exactly on the stop end, and that instant belongs to the drive that follows.
 * Treating it as still inside the stop would leave the card on screen over a
 * moving vehicle.
 */
export function stopAtRecorded(
  schedule: PlaybackSchedule,
  recordedMs: number
): ScheduledStop | null {
  for (const stop of schedule.stops) {
    if (recordedMs >= stop.fromMs && recordedMs < stop.toMs) return stop;
  }
  return null;
}

/**
 * "5h 03m", "12m", "45s" — a duration as an operator would say it.
 *
 * Always describes the REAL stop, never its playback budget.
 */
export function formatStopDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}
