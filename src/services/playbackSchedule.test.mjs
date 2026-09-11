import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPlaybackTrack } from './playbackEngine.ts';
import {
  HELD_STOP_PLAYBACK_MS,
  buildPlaybackSchedule,
  formatStopDuration,
  heldStopAtPlayback,
  playbackAtRecorded,
  recordedAtPlayback,
  stopAtRecorded,
} from './playbackSchedule.ts';

const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;
const METRE = 1 / 111_320;
const START = Date.parse('2026-09-08T09:00:00.000Z');

const iso = (seconds) => new Date(START + seconds * 1000).toISOString();

function fix(metres, seconds, extra = {}) {
  return {
    lat: BASE_LAT + metres * METRE,
    lng: BASE_LNG,
    t: iso(seconds),
    speed: 20,
    course: 0,
    ignition: true,
    gpsValid: true,
    ...extra,
  };
}

function span(type, fromSeconds, toSeconds, extra = {}) {
  return {
    type,
    from: iso(fromSeconds),
    to: iso(toSeconds),
    seconds: toSeconds - fromSeconds,
    distanceKm: 0,
    startLat: BASE_LAT,
    startLng: BASE_LNG,
    endLat: BASE_LAT,
    endLng: BASE_LNG,
    averageSpeedKmh: 0,
    maxSpeedKmh: 0,
    ...extra,
  };
}

const HOUR = 3600;

/**
 * The journey from the brief: home, three km, five hours outside a friend's
 * house, then home again.
 */
function friendsHouseJourney() {
  const track = buildPlaybackTrack(
    [
      fix(0, 0),
      fix(1500, 540),
      // Parked. Two fixes an hour apart is all a stationary tracker sends.
      fix(1500, 1080),
      fix(1502, 1080 + 5 * HOUR),
      fix(3000, 1080 + 5 * HOUR + 1320),
    ],
    { pointsAreClean: true }
  );
  const timeline = [
    span('MOVING', 0, 1080),
    span('STOPPED', 1080, 1080 + 5 * HOUR, { stopIndex: 1 }),
    span('MOVING', 1080 + 5 * HOUR, 1080 + 5 * HOUR + 1320),
  ];
  return { track, timeline };
}

test('a five-hour stop costs seconds of animation and none of the recording', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);

  assert.equal(schedule.compressed, true);
  assert.equal(schedule.stops.length, 1);
  // The recording is untouched: reports still say five hours.
  assert.equal(schedule.totalRecordedMs, track.totalDurationMs);
  assert.equal(schedule.stops[0].durationMs, 5 * HOUR * 1000);
  assert.equal(schedule.stops[0].mode, 'held');
  // Watching it costs the drive plus a beat, not the drive plus five hours.
  const driving = (1080 + 1320) * 1000;
  assert.equal(schedule.totalPlaybackMs, driving + HELD_STOP_PLAYBACK_MS);
});

test('driving plays at real time on both sides of a held stop', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);

  // One animation second is one recorded second while the vehicle is moving.
  assert.equal(recordedAtPlayback(schedule, 0), 0);
  assert.equal(recordedAtPlayback(schedule, 300_000), 300_000);

  // And after the hold, the clock resumes at real time from the first movement.
  const afterHold = 1080_000 + HELD_STOP_PLAYBACK_MS;
  const resumed = recordedAtPlayback(schedule, afterHold + 60_000);
  assert.equal(resumed, (1080 + 5 * HOUR) * 1000 + 60_000);
});

test('the recorded clock freezes for the whole hold, then jumps', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);
  const holdStart = 1080_000;

  // Frozen at the last moment the vehicle was seen moving...
  for (const offset of [0, 400, 800, HELD_STOP_PLAYBACK_MS - 1]) {
    assert.equal(recordedAtPlayback(schedule, holdStart + offset), holdStart);
  }
  // ...and then straight to the first validated movement after the stop.
  assert.equal(
    recordedAtPlayback(schedule, holdStart + HELD_STOP_PLAYBACK_MS),
    (1080 + 5 * HOUR) * 1000
  );
});

test('the stop being held is what the card is drawn from', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);

  assert.equal(heldStopAtPlayback(schedule, 500_000), null);
  const held = heldStopAtPlayback(schedule, 1080_000 + 200);
  assert.ok(held);
  assert.equal(held.startedAt, START + 1080 * 1000);
  assert.equal(held.endedAt, START + (1080 + 5 * HOUR) * 1000);
  assert.equal(formatStopDuration(held.durationMs), '5h 00m');
});

test('a stop under two minutes is part of the journey and is played in full', () => {
  const track = buildPlaybackTrack(
    [fix(0, 0), fix(300, 120), fix(300, 210), fix(900, 400)],
    { pointsAreClean: true }
  );
  const schedule = buildPlaybackSchedule(track, [
    span('MOVING', 0, 120),
    span('STOPPED', 120, 210),
    span('MOVING', 210, 400),
  ]);

  assert.equal(schedule.compressed, false);
  assert.equal(schedule.stops.length, 0);
  assert.equal(schedule.totalPlaybackMs, schedule.totalRecordedMs);
});

test('a stop between two and fifteen minutes is condensed, not held', () => {
  const track = buildPlaybackTrack(
    [fix(0, 0), fix(300, 120), fix(300, 120 + 600), fix(900, 900 + 120)],
    { pointsAreClean: true }
  );
  const schedule = buildPlaybackSchedule(track, [
    span('MOVING', 0, 120),
    span('STOPPED', 120, 720),
    span('MOVING', 720, 1020),
  ]);

  assert.equal(schedule.stops.length, 1);
  assert.equal(schedule.stops[0].mode, 'condensed');
  // Ten recorded minutes, played in seconds — but the clock still moves
  // through them rather than freezing, which is what says "nothing happened".
  assert.ok(schedule.stops[0].playbackMs <= 3_000);
  assert.equal(heldStopAtPlayback(schedule, 130_000), null);
  const partWay = recordedAtPlayback(schedule, 120_000 + schedule.stops[0].playbackMs / 2);
  assert.ok(partWay > 120_000 && partWay < 720_000);
});

test('a scrub maps back to the animation, and lands on the card not past it', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);

  // Anywhere inside the five hours puts the playhead at the start of the hold,
  // so scrubbing into a stop shows it instead of stepping over it.
  const midStop = (1080 + 2 * HOUR) * 1000;
  assert.equal(playbackAtRecorded(schedule, midStop), 1080_000);
  // And a scrub into the drive is a plain round trip.
  assert.equal(playbackAtRecorded(schedule, 300_000), 300_000);
  assert.equal(recordedAtPlayback(schedule, playbackAtRecorded(schedule, 300_000)), 300_000);
});

test('the recorded clock never runs backwards as the animation advances', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);
  let previous = -1;
  for (let playback = 0; playback <= schedule.totalPlaybackMs; playback += 97) {
    const recorded = recordedAtPlayback(schedule, playback);
    assert.ok(Number.isFinite(recorded), `finite at ${playback}`);
    assert.ok(recorded >= previous, `went backwards at ${playback}`);
    previous = recorded;
  }
  assert.equal(recordedAtPlayback(schedule, schedule.totalPlaybackMs), schedule.totalRecordedMs);
});

test('a hold takes the same wall-clock time at every speed chip', () => {
  const { track, timeline } = friendsHouseJourney();

  // The chip multiplies animation time, so the budget is scaled by it and the
  // card stays readable for the same beat whether you are watching at 0.5x or
  // 4x. Driving is untouched: a chip still means exactly what it says there.
  for (const speed of [0.5, 1, 2, 4]) {
    const schedule = buildPlaybackSchedule(track, timeline, [], { speed });
    const wallClockMs = schedule.stops[0].playbackMs / speed;
    assert.equal(wallClockMs, HELD_STOP_PLAYBACK_MS, `at ${speed}x`);
  }
});

test('a condensed stop is never given more time than playing it would take', () => {
  const track = buildPlaybackTrack(
    [fix(0, 0), fix(300, 60), fix(300, 60 + 130), fix(600, 250)],
    { pointsAreClean: true }
  );
  // A stop barely over the two-minute line, at half speed: the compressed
  // budget must not exceed simply letting it play.
  const schedule = buildPlaybackSchedule(
    track,
    [span('MOVING', 0, 60), span('STOPPED', 60, 190), span('MOVING', 190, 250)],
    [],
    { speed: 0.5 }
  );
  assert.equal(schedule.stops.length, 1);
  assert.ok(schedule.stops[0].playbackMs <= schedule.stops[0].durationMs);
});

test('showing full stops is the recording, exactly as it happened', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline, [], { compress: false });

  assert.equal(schedule.compressed, false);
  assert.equal(schedule.totalPlaybackMs, schedule.totalRecordedMs);
  assert.equal(recordedAtPlayback(schedule, 4_000_000), 4_000_000);
});

test('a stop marker supplies the place the card names', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline, [
    {
      from: iso(1080),
      to: iso(1080 + 5 * HOUR),
      lat: 12.98,
      lng: 77.6,
      minutes: 300,
      seconds: 18_000,
      index: 1,
      distanceFromPreviousKm: 3,
      address: "Friend's House",
    },
  ]);

  assert.equal(schedule.stops[0].address, "Friend's House");
  assert.equal(schedule.stops[0].latitude, 12.98);
  assert.equal(schedule.stops[0].index, 1);
});

test('a stop is still findable on the recorded clock, for the timeline', () => {
  const { track, timeline } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, timeline);

  assert.ok(stopAtRecorded(schedule, (1080 + HOUR) * 1000));
  assert.equal(stopAtRecorded(schedule, 60_000), null);
});

test('overlapping stop spans cannot make the playhead go backwards', () => {
  const { track } = friendsHouseJourney();
  const schedule = buildPlaybackSchedule(track, [
    span('STOPPED', 1080, 1080 + 5 * HOUR, { stopIndex: 1 }),
    span('STOPPED', 1080 + HOUR, 1080 + 3 * HOUR, { stopIndex: 2 }),
  ]);

  assert.equal(schedule.stops.length, 1);
  let previous = -1;
  for (let playback = 0; playback <= schedule.totalPlaybackMs; playback += 211) {
    const recorded = recordedAtPlayback(schedule, playback);
    assert.ok(recorded >= previous);
    previous = recorded;
  }
});

test('a recording with no usable clock falls back to playing it straight', () => {
  const empty = buildPlaybackTrack([], { pointsAreClean: true });
  const schedule = buildPlaybackSchedule(empty, []);
  assert.equal(schedule.compressed, false);
  assert.equal(recordedAtPlayback(schedule, 1000), 0);
  assert.equal(playbackAtRecorded(schedule, 1000), 0);
});

test('durations read the way an operator says them', () => {
  assert.equal(formatStopDuration(45_000), '45s');
  assert.equal(formatStopDuration(12 * 60_000), '12m');
  assert.equal(formatStopDuration(5 * HOUR * 1000 + 3 * 60_000), '5h 03m');
});
