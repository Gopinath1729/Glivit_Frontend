# Live tracking: the pipeline, its trace, and how to field-test it

Live vehicle tracking has one source of truth: a GPS fix produced by a real
device and posted to `POST /api/ingest/positions`. Nothing else may put a
coordinate on the map. There is no simulator, no demo route, no synthesised
track and no seeded position anywhere in this system.

## The pipeline

```
phone sensor
  -> mobileGpsPayload.validateMobileGpsLocation   accept / reject, with a reason
  -> phoneTracker.postFix                         newest fix always wins
  -> POST /api/ingest/positions
  -> PositionIngestService                        validate, hold, resolve speed + heading
  -> positions row + device_current_position      the stored point
  -> LivePositionPublisher (AFTER_COMMIT, async)
  -> LiveRoadMatcher                              road-snapped point + travelled geometry
  -> LivePositionBroadcaster                      SSE POSITION frame
  -> livePositionStream.parseLivePositionEvent
  -> livePositions.applyLiveEvent                 validate again, accept / reject
  -> liveRouteTrail.appendTrail                   the travelled route line
  -> live-track.tsx                               marker + polyline
```

Each stage either passes the same accepted point on or refuses it with a
recorded reason. **A refused point is never replaced with a generated one**: the
vehicle holds its last trusted position and the label on its freshness changes.

### Which coordinate is used for what

| | source | used for |
|---|---|---|
| **raw** | the device's reported coordinate | auditing only |
| **validated** | raw, after the checks | distance, speed, **bearing** |
| **matched** | where the road matcher placed it | the drawn marker and route |
| **display** | matched, eased between fixes | the rendered marker |

Movement maths never reads a matched coordinate. Two consecutive fixes can be
snapped onto opposite carriageways of a dual road, and the bearing between those
two points runs *across* the road rather than along it.

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
[gps:stream]  device=7 broadcast lat=… lng=… gpsTime=… geometryVertices=…
[gps:stream]  device=7 suppressed reason=OUT_OF_ORDER|STALE_TIMESTAMP|SUPERSEDED_BY_NEWER_FIX
```

**App** — build with `EXPO_PUBLIC_GPS_DIAGNOSTICS=true`, or call
`setGpsDiagnostics(true)` at runtime. This is deliberately **not** gated on
`__DEV__`: the faults it exists to diagnose only reproduce on a real phone on a
real road, which means a release build.

```
[gps:raw]       lat=… lng=… accuracy=… speedMps=… heading=… fixAgeMs=…
[gps:validated] lat=… lng=… uploadLatencyMs=…        <- sensor-to-server latency
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
  points (`accepted`).

## Road matching

Live Tracking, History and Playback all go through **one** matcher:
`MapMatchingService`, against the OSM road network. Live re-solves a small
rolling window per fix (`LiveRoadMatcher`); History and Playback solve the whole
range in one pass and share a cache. There is no client-side snapping anywhere —
the app draws what the server matched.

### Configuration

| Setting | Default | Notes |
|---|---|---|
| `APP_MAP_MATCHING_ENGINE` | `OSRM` | or `VALHALLA`, or `NONE` to turn it off |
| `APP_MAP_MATCHING_BASE_URL` | `https://router.project-osrm.org` | **public demo server** — see below |
| `APP_MAP_MATCHING_LIVE_MIN_INTERVAL_MS` | `0` | 0 = every accepted fix is matched |
| `APP_MAP_MATCHING_LIVE_MIN_MOVEMENT` | `5` | a vehicle that has not moved this far holds its match |
| `APP_MAP_MATCHING_TIMEOUT_MS` | `4000` | per request |

**No API key is involved.** OSRM and Valhalla are keyless; the only
`EXPO_PUBLIC_GEOAPIFY_API_KEY` in this project is for map *tiles* and has
nothing to do with matching.

> The default points at the **public OSRM demo server**. It works with zero
> setup, which is why it is the default — but it is rate-limited, its usage
> policy does not permit production traffic, and every vehicle coordinate sent
> to it leaves your infrastructure. Before carrying a real fleet:
>
> ```
> # One-time: fetch an OSM extract for your region and prepare it, then:
> docker run -p 5000:5000 -v "$PWD/osrm-data:/data" osrm/osrm-backend osrm-routed --algorithm mld /data/region.osrm
>
> # Then point the backend at it:
> APP_MAP_MATCHING_BASE_URL=http://localhost:5000
> ```

The application logs which engine and URL it is using at startup and then probes
it once, so a wrong URL or a stopped container shows up in the boot log rather
than as a toast on somebody's History tab hours later.

### The four states, and why they are not one state

Both `matchStatus` on the playback response and `matchStatus` on every live SSE
frame carry one of these. They all draw validated GPS as the fallback, but they
are different problems and the app says which:

| Status | Means | Who fixes it |
|---|---|---|
| `MATCHED` / `PARTIAL` | On road geometry | — |
| `UNMATCHED` | Engine answered, could not place this trace | Nobody — unmapped ground, or imprecise fixes |
| `UNAVAILABLE` | Configured, **not answering** | You: wrong URL, container down, firewall |
| `DISABLED` | Nothing configured | You: set `APP_MAP_MATCHING_BASE_URL` |

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

While it is open the live matcher **carries the last valid snap correction onto
each new fix** (bounded to 25 m, cleared by a coverage gap). The vehicle keeps
moving, on the road it was last known to be on, and the route is not drawn
through buildings — rather than either freezing the marker or dropping it back
to raw coordinates. A trace the engine *declines* is not counted as a failure:
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
