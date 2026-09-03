# GLIVT implementation status

## Product scope

The user-facing product is focused on vehicles and their registered GPS devices:

- live fleet and single-vehicle maps
- smooth streamed marker movement with stale-fix protection
- road snapping through a configurable OSRM-compatible service
- trip history, route playback, stops, events, and Haversine distance
- backend-owned `RUNNING`, `IDLE`, `STOPPED`, and `OFFLINE` detection from coordinates, time, and optional speed
- geofence entry/exit alerts
- speed-threshold alerts and speed reports
- GPS-device registration, suspension, last-seen, diagnostics, and online/offline health
- vehicle activity and fleet timeline reports with export

Phone-as-tracker, driver, AI, tenant-management, and general management screens are not part of the product surface. Authentication, authorization, tenant isolation, and project scoping remain infrastructure because they protect fleet data.

## GPS ingestion and live delivery

Both authenticated GPS ingestion endpoints persist immutable positions and update a current-position snapshot. Speed is derived from coordinate distance and elapsed device time when a tracker omits it. New in-order positions run speed and geofence monitoring and publish a post-commit event to the tenant- and device-scoped SSE stream.

A scheduled backend health monitor advances stationary devices from `IDLE` to `STOPPED`, changes stale devices to `OFFLINE`, emits transition events once, and broadcasts the new state without waiting for another packet. A fresh packet after an offline period emits a `DEVICE_ONLINE` event.

## Release posture

- Android package: `com.vehiclemoment.tracker`
- Expo SDK 54 / Android target API 36
- foreground location only; no background-location or phone-tracker service
- microphone permission blocked
- production builds require an HTTPS backend and a Geoapify Map Tiles key; road matching uses the configured backend OSRM/Valhalla service
- EAS production output is an AAB; Play submission defaults to an Internal testing draft
- release instructions and Play disclosures are in [PLAY_STORE_RELEASE.md](./PLAY_STORE_RELEASE.md)

## Verified 29 August 2026

- Backend: `137` tests passed, `0` failures/errors/skips.
- Frontend: ESLint passed with zero warnings.
- Frontend: TypeScript passed with no emit.
- Expo Doctor: `18/18` checks passed.
- Android production JavaScript export passed (`1,958` modules).

## External release prerequisites

An AAB cannot be created or uploaded until the repository is linked to the
intended Expo owner/team and the deployment owner supplies a stable HTTPS
backend, a production OSRM/Valhalla endpoint, a Geoapify Map Tiles key, Play
Console app/listing access, and the legal privacy-policy details. Google review
and any required closed-testing period are external to the codebase.
