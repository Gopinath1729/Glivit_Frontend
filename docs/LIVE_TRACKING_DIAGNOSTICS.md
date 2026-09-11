# Live tracking: the pipeline, its trace, and how to field-test it

Live vehicle tracking has one source of truth: a GPS fix produced by a real
device and posted to `POST /api/ingest/positions`. Nothing else may put a
coordinate on the map. There is no simulator, no demo route, no synthesised
track and no seeded position anywhere in this system.

## The pipeline

```
phone sensor
  -> gpsPipeline.GpsAcquisitionGate               WARM-UP: nothing leaves the
                                                  phone until several fresh,
                                                  accurate, mutually consistent
                                                  fixes agree
  -> mobileGpsPayload.validateMobileGpsLocation   accept / reject, with a reason
  -> phoneTracker.postFix                         newest fix always wins
  -> POST /api/ingest/positions
  -> PositionIngestService                        validate, hold, resolve speed + heading
  -> positions row + device_current_position      the stored point
  -> LiveRoadMatchWorker (AFTER_COMMIT, async)    one pipeline, one sample
  -> LiveRoadMatcher                              validate + rolling 8-10 point window
  -> Geoapify Map Matching                        road point + travelled geometry
  -> persist match + LivePositionBroadcaster      one SSE POSITION frame
  -> livePositionStream.parseLivePositionEvent
  -> livePositions.applyLiveEvent                 validate again, accept / reject
  -> liveRouteTrail.appendTrail                   the travelled route line
  -> live-track.tsx                               marker + polyline
```

Each stage either passes the same accepted point on or refuses it with a
recorded reason. **A refused point is never replaced with a generated one**: the
vehicle holds its last trusted position and the label on its freshness changes.

### Warm-up, and why the first fix is never published

A cold GPS returns a position long before it returns a good one. Its first
readings are a fused cell/Wi-Fi estimate or a two-satellite solution: they pass
every structural check, carry a plausible accuracy number, and sit anywhere
within a block or two of the truth. Published immediately they become the
route's first vertex, the trip's origin and the stored playback record's
opening point — permanently — and everything after them is measured from a
position that was never real. That is the whole of "the live route is wrong at
the start and gets better after a while": nothing heals, the pipeline simply
leaves the bad opening behind.

`GpsAcquisitionGate` holds the session closed until
`GPS_ACQUISITION.minSamples` consecutive fixes are each fresh, each inside a
tighter-than-usual accuracy ceiling, strictly ordered in time, and separated by
steps their elapsed time can explain. One disagreeing sample restarts the run,
because a receiver whose consecutive fixes contradict each other has not
converged.

The step test is Haversine over elapsed time — a *speed*, not a distance — so
warm-up completes just as readily for a phone that starts tracking in a moving
car as for one on a desk. There is no per-travel-mode threshold to re-tune for
walking, cycling or driving.

The gate sits **before the POST**, which is what makes Live and Playback agree
by construction: a fix refused during warm-up is never ingested, so it can
never be matched, drawn live, or replayed later. The tracker screen shows
`Acquiring GPS… n/N stable fixes` while this is happening; it is a healthy
state, not an error.

Under cover the strict ceiling relaxes once, after `maxWarmupMs`, to the
ordinary steady-state ceiling — so a receiver that genuinely cannot do better
still starts tracking rather than leaving the vehicle invisible. It never
relaxes past that, so warm-up can never admit a fix ordinary validation would
refuse.

### One collector uploads at a time

Both collectors stay registered — the background task is what keeps tracking
alive once the app leaves the screen — but only one of them POSTs. The
foreground watcher owns uploads while the app is on screen; the background task
owns them the rest of the time, and `setForegroundCollectorActive` /
`isForegroundCollectorActive` is the single predicate both consult.

They used to both upload, at 1 Hz each, for the same device. The backend
deduplicated the result (`verdict=REJECTED:DUPLICATE` on every other frame), so
no data was corrupted — but it was two uploads per second where one is needed,
and the two are not equivalent: the background task drains its delivery
serially, awaiting each POST, so on a slow link its queue never catches up.
Observed on the test fleet as a device whose stored GPS time ran a steady
58 seconds behind its arrival time while a second device on the same phone was
current. That is the "delayed coordinates" symptom, and it was self-inflicted.

### Which coordinate is used for what

| | source | used for |
|---|---|---|
| **raw** | the device's reported coordinate | auditing only |
| **validated** | raw, after the checks | duplicate/jump rejection and sensor speed/status inputs |
| **matched** | where Geoapify placed it | marker movement, route, road bearing/rotation and continuity checks |
| **display** | matched, eased between fixes | the rendered marker |

Validation deliberately remains in raw-sensor space; rendered movement remains
in matched-road space. Road bearing is reconciled with the observed travel
direction so a bidirectional road cannot rotate the vehicle backwards.

## Turning the trace on

Both halves use the same stage names, so one device id follows a fix end to end.

**Backend** — set `APP_GPS_TRACE=DEBUG` (or
`logging.level.glivt.gps-trace=DEBUG`). Emitted by
`com.glivt.telemetry.GpsTrace`:

```
[gps:ingest]  device=7 stage=raw lat=… lng=… gpsTime=… receivedAt=… delayMs=…
              accuracy=… speedKmh=… heading=… provider=…
[gps:ingest]  device=7 stage=decision verdict=ACCEPTED|ACCEPTED_HELD:…|REJECTED:…
              movedM=… derivedKph=… speedKmh=… heading=…
[gps:stored]  device=7 positionId=… lat=… lng=… gpsTime=… serverTime=… tripKm=…
[gps:matched] device=7 raw=(…) matched=(…) offsetM=… roadBearing=… confidence=…
              matched=… held=… geometryVertices=…
[gps:live]    device=7 positionId=… raw=(…) matched=(…) previousDisplay=(…)
              display=(…) rawToMatchedDistanceM=… previousToDisplayDistanceM=…
              matchSource=SOLVED|HELD|NONE matchStatus=… heldAgeMs=…
              matchConfidence=… geometryVertices=… gpsTime=… gpsToServerMs=…
              processingLatencyMs=… decision=…
[gps:stream]  device=7 broadcast lat=… lng=… gpsTime=… geometryVertices=…
[gps:stream]  device=7 suppressed reason=OUT_OF_ORDER|STALE_TIMESTAMP|SUPERSEDED_BY_NEWER_FIX
```

`[gps:live]` is the line to read first. It is one line per GPS sample carrying
the whole decision, so no correlation is needed: where the device said it was,
where the matcher put it, where the marker was drawn, and the real distances
between all three.

* `rawToMatchedDistanceM` is measured from the CURRENT validated fix to the
  drawn coordinate. On a held fix it is the distance the marker is *behind* the
  vehicle — the number that used to read `0.0` for every hold because the held
  coordinate was passed as both the raw and the matched one.
* `matchSource=HELD` with a growing `rawToMatchedDistanceM` and `heldAgeMs`
  means matching is failing repeatedly. It is now self-limiting: past
  `app.map-matching.held-max-distance-meters` (40 m) or
  `held-max-age-ms` (10 s) while moving, the hold is released — look for
  `live-match hold released … reason=HELD_OFF_ROAD|HELD_EXPIRED|HELD_TOO_FAR`
  at INFO — and the vehicle follows its real GPS with `matchSource=NONE`.
* `decision` names why this coordinate was chosen: `SOLVED`, a matcher
  rejection (`DISCONTINUOUS_ROAD`, `MATCH_INVENTS_TRAVEL`, `POOR_ACCURACY`,
  `UNTRUSTWORTHY`, `ENGINE_NO_ANSWER`, …), or `DISPLAY_JUMP_REFUSED` when the
  drawn step itself was refused.
* `gpsToServerMs` is negative when the phone's GPS clock leads the server's,
  which is normal by one to three seconds and is never a reason to reject a
  sample.

**App** — build with `EXPO_PUBLIC_GPS_DIAGNOSTICS=true`, or call
`setGpsDiagnostics(true)` at runtime. This is deliberately **not** gated on
`__DEV__`: the faults it exists to diagnose only reproduce on a real phone on a
real road, which means a release build.

```
[gps:raw]       lat=… lng=… accuracy=… speedMps=… heading=… fixAgeMs=…
[gps:validated] lat=… lng=… uploadLatencyMs=…        <- sensor-to-server latency
[gps:rejected]  reason=acquiring:… samples=n needed=N  <- still warming up
[gps:rejected]  reason=…                              <- every refusal, with why
[gps:sse]       event=open|error|retry
[gps:matched]   raw=… validated=… matched=… isMatched=… deviceCourse=…
                roadBearing=… heading=… routeSource=matched|accepted
                routeVertices=… renderLagMs=…         <- GPS clock to renderer
[gps:render]    stage=marker drawn=… heading=… rotation=…
[gps:render]    stage=route runs=… vertices=… lastVertex=…
```

### Reading it

* **The same point end to end.** `[gps:raw]` on the phone, `[gps:stored]` on the
  server, `[gps:stream]`, and `[gps:render] stage=marker` must all carry the same
  coordinate for one `gpsTime` (allowing for the road snap between `stored` and
  `matched`).
* **"It updates late."** Three numbers localise it without guessing:
  `fixAgeMs` (how stale the reading was when the phone sent it),
  `uploadLatencyMs` (sensor to server), and `renderLagMs` (GPS clock to
  renderer). Whichever is large is the stage at fault.
* **"It jumped."** Look for `verdict=REJECTED:IMPOSSIBLE_JUMP` or
  `ACCEPTED_HELD:…`. A hold means the marker deliberately did **not** move.
* **"It faces the wrong way."** `[gps:matched]` carries `deviceCourse`,
  `roadBearing` and the resolved `heading`. `[gps:render]` carries the
  `rotation` handed to the marker.
* **"The route line is missing."** `[gps:render] stage=route` gives the run and
  vertex counts, and `routeSource` on `[gps:matched]` says whether each stretch
  came from road geometry (`matched`) or from the segment between two accepted
  points (`accepted`). On the server, `geometryVertices=0` on `[gps:live]` says
  the provider returned no road for that stretch, so nothing was appended —
  which is correct, and never a reason to draw the chord instead.
* **"The marker is stuck behind me."** `[gps:live] matchSource=HELD` with a
  large `rawToMatchedDistanceM`. The hold releases itself past the distance and
  age limits above; if it is not releasing, the fix is being reported with a
  speed of zero (`observation.speedKmh`), which is what makes it look parked.
* **"Nothing is being sent at all."** Look for `reason=acquiring:…`. Warm-up is
  working; the receiver has not converged. `samples=n needed=N` is the
  progress, and the `acquiring:` suffix names what keeps resetting the run.

Every client-side record also carries a one-line `pipeline` summary —
`RAW <coord> -> ACCEPTED|REJECTED -> reason -> MATCHED(source) <coord> ->
LIVE_APPENDED|PLAYBACK_STORED|SKIPPED` — alongside the structured fields. It
answers the question the structured fields do not: *did this coordinate end up
on my route?* An accepted fix can still be held, and a held fix extends
nothing.

## Road matching

Live Tracking, History and Playback all go through **one** matcher:
`MapMatchingService`, against the OSM road network. Live re-solves a small
rolling window per fix (`LiveRoadMatcher`); History and Playback solve the whole
range in one pass and share a cache. There is no client-side snapping anywhere —
the app draws what the server matched.

### Configuration

| Setting | Default | Notes |
|---|---|---|
| `MAP_MATCHING_PROVIDER` | `GEOAPIFY` | or `NONE` to turn it off |
| `GEOAPIFY_API_KEY` | unset | backend-only Map Matching API credential |
| `GEOAPIFY_MAP_MATCHING_URL` | `https://api.geoapify.com/v1/mapmatching` | POST endpoint |
| `MAP_MATCHING_WINDOW_SIZE` | `10` | clamped to the latest 8-10 validated fixes |
| `GPS_MAX_ACCURACY_METERS` | `30` | less accurate fixes never reach matching |
| `MAP_MATCHING_TIMEOUT_MS` | `2000` | per attempt |
| `MAP_MATCHING_MAX_RETRIES` | `1` | transient 429/5xx/transport failures only |

`GEOAPIFY_API_KEY` exists only in backend configuration. The app uses key-free
OpenFreeMap vector tiles through MapLibre and never receives the matching
credential.

The application logs whether the provider, URL, and key are configured without
logging the URL query string or secret. It does not spend a paid API request on
a synthetic startup probe.

### The four states, and why they are not one state

Both `matchStatus` on the playback response and `matchStatus` on every live SSE
frame carry one of these. They all draw validated GPS as the fallback, but they
are different problems and the app says which:

| Status | Means | Who fixes it |
|---|---|---|
| `MATCHED` / `PARTIAL` | On road geometry | — |
| `UNMATCHED` | Engine answered, could not place this trace | Nobody — unmapped ground, or imprecise fixes |
| `UNAVAILABLE` | Configured, **not answering** | You: wrong URL, container down, firewall |
| `DISABLED` | Nothing configured | You: set the backend `GEOAPIFY_API_KEY` |

`UNAVAILABLE` and `DISABLED` are announced on the Live tab as well as History.
`UNMATCHED` is not — it happens routinely on unmapped ground, and toasting it
every time would train operators to ignore the message that actually means their
routing service is broken.

### When the router fails

A `MapMatchingHealth` circuit breaker sits in front of the engine. After three
consecutive transport failures it opens and calls fail immediately instead of
each paying the full request timeout — a wedged router used to cost a history
read `4s × number of chunks` before it drew anything. It half-opens after a
cooldown that backs off to one probe a minute, and closes on the first success.

While it is open the live matcher **holds the exact last valid matched road
coordinate** and emits no new route geometry. It never substitutes the failed
sample's raw coordinate, so no diagonal or building-crossing segment is added.
A trace the engine *declines* is not counted as a failure:
that is the engine working, and counting it would open the breaker on a run of
rural trips.

## Geofences do not touch tracking

Geofence evaluation runs from `GeofenceEvaluationListener`, **after** the
position has been committed, on its own executor and its own transaction. It
reads the latest accepted GPS coordinate and writes exactly two things: its own
per-pair inside/outside state, and a notification event.

It has no repository for positions, current positions, or tracking sessions, so
there is no code path by which a crossing could move a marker, clear a route,
reset a previous or current position, or restart tracking — and
`theMonitorHasNoRouteToVehiclePositionAtAll` asserts that structurally, so the
coupling cannot come back unnoticed.

It used to run **inside** the ingest transaction. Its own `catch` claimed "the
position is already stored by the time this runs" — it was not, it was in the
same uncommitted transaction. A failure in geofencing therefore doomed the
position write, and the vehicle's coordinate silently failed to advance at
exactly the fixes where a boundary was crossed.

One event per crossing, guarded three ways:

1. **Remembered state** per `(geofence, device)` — inside→inside and
   outside→outside raise nothing.
2. **Hysteresis**, 25 m either side of the boundary, so a vehicle parked on the
   line does not flip on GPS noise.
3. **Event de-duplication** — the same event type for the same pair inside 60 s
   is refused, plus an optimistic lock on the state row so two concurrently
   evaluated fixes cannot both raise the same crossing.

## Field test

Automated tests cover the rules (`npm run test:gps`, and the backend suite), but
the pipeline ends at a phone on a road. Run this with the trace on, on **both**
Android and iOS, and repeat the whole sequence twice — a fault that appears once
in two runs is not fixed.

| # | Scenario | What must happen |
|---|---|---|
| 1 | Stand still 2 min | Marker does not move or rotate. Route does not grow. Vehicle stays online. |
| 2 | Walk 100 m | Marker follows within a second or two. Route extends behind it. Heading points the way you are walking. |
| 3 | Drive slowly (10–20 km/h) | Marker tracks the road. No jumps to parallel roads. |
| 4 | Drive faster (50 km/h+) | Marker keeps up; `renderLagMs` stays small. Route follows the road. |
| 5 | Left turn | Marker rotates through the turn the short way and ends aligned with the new road. |
| 6 | Right turn | As above. |
| 7 | Stop at lights | Marker stops and holds its heading. No spinning. |
| 8 | Pull away | Marker moves off without a multi-second delay. |
| 9 | Restart the app mid-journey | Marker reappears at the current position immediately (SSE replay), not at an old one. Route restarts cleanly rather than drawing a line across the gap. |
| 10 | Turn GPS off, then on | Vehicle stays on the map, labelled stale. On recovery it resumes from the real position; no line is drawn across the outage. |
| 11 | Aeroplane mode 30 s, then back | Same. Queued fixes upload in order; the marker ends on the newest. |
| 12 | Cross an intersection | No snap onto the crossing road. |
| 13 | Drive a road parallel to another (service road, dual carriageway) | Marker stays on the correct one. |
| 14 | Drive a flyover, then the road beneath it | Marker does not swap between levels. |
| 15 | Background the app for 5 min while driving | Updates continue; the route has no holes in it. |
| 16 | Drive into an assigned geofence | **One** ENTER notification. The marker keeps moving through the boundary — it must not stop, jump back, recentre, or reset to the fence centre or the trip start. Route, bearing, speed and distance keep updating. |
| 17 | Drive out of it | **One** EXIT notification, same continuity. |
| 18 | Park on the boundary for 5 min | No repeat notifications from GPS drift. |
| 19 | Cross the same fence twice in a minute | Both crossings notify (ENTER, EXIT); no third from the drift between them. |
| 20 | Stop the routing service mid-journey | Live says the service is unreachable, marker keeps moving on the road, no route through buildings. Restart it: matching resumes within about a minute. |

Failures to watch for, and where to look first:

* Marker lags → `fixAgeMs` / `uploadLatencyMs` / `renderLagMs`.
* Marker spins while parked → `[gps:matched] held=true` should be present.
* Route line missing → `[gps:render] stage=route`, then `routeSource`.
* Marker on the wrong road → `[gps:matched] offsetM` and `confidence`.
* "Road matching is not configured" → the boot log says which engine and URL
  were loaded and whether the probe answered.
* Marker resets on a geofence crossing → it cannot come from geofencing any
  more; check `[gps:stream] suppressed` and `[gps:ingest] verdict` instead.
