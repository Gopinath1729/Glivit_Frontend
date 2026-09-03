/**
 * Tracing for the client half of the GPS pipeline.
 *
 * Every stage of a fix's journey is logged through here and nowhere else:
 *
 * ```
 * [gps:raw]       phone sensor reading, its GPS timestamp, accuracy, speed, heading
 * [gps:validated] the fix the phone accepted and uploaded, with its upload latency
 * [gps:rejected]  anything refused, with the reason it was refused
 * [gps:sse]       transport state - open, error, retry
 * [gps:matched]   the streamed fix: raw, validated, road-snapped, heading, route source
 * [gps:store]     what reached shared vehicle state
 * [gps:render]    the coordinate and rotation actually handed to the map
 * ```
 *
 * The backend half uses the same stage names on the `glivt.gps-trace` logger
 * (see `com.glivt.telemetry.GpsTrace`), so one fix can be followed from the
 * phone's sensor through ingest, persistence, road matching and the stream to
 * the drawn marker by grepping a device id on both sides.
 *
 * <h3>Turning it on</h3>
 * Off by default everywhere, because a fix a second turns an always-on trace
 * into an unreadable console. Set `EXPO_PUBLIC_GPS_DIAGNOSTICS=true` at build
 * time, or call {@link setGpsDiagnostics} at runtime.
 *
 * Unlike the previous version this is NOT gated on `__DEV__`. The faults it
 * exists to diagnose - late updates, drift, a marker that will not rotate -
 * only reproduce on a real phone driving a real road, which means a release
 * build; a trace that switches itself off in exactly that situation cannot
 * diagnose anything. It stays off unless something explicitly turns it on, and
 * it only ever logs telemetry the app is already handling.
 */

type Stage =
  | 'raw'
  | 'validated'
  | 'matched'
  | 'rejected'
  | 'speed'
  | 'sse'
  | 'store'
  | 'render';

let enabled = (process.env.EXPO_PUBLIC_GPS_DIAGNOSTICS ?? '').toLowerCase() === 'true';

/** Turns tracing on or off at runtime. */
export function setGpsDiagnostics(on: boolean): void {
  enabled = on;
}

export function gpsDiagnosticsEnabled(): boolean {
  return enabled;
}

/**
 * One structured trace line.
 *
 * `vehicleId` is always included: with a fleet on screen, an untagged line
 * cannot be attributed to a vehicle and is worse than no line at all.
 */
export function traceGps(
  stage: Stage,
  vehicleId: number | string | null | undefined,
  detail: Record<string, unknown>
): void {
  if (!enabled) return;
  console.log(`[gps:${stage}] vehicle=${vehicleId ?? 'unknown'}`, detail);
}

/** Rounds a coordinate for logging without implying more precision than GPS has. */
export function traceCoord(
  lat: number | null | undefined,
  lng: number | null | undefined
): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'none';
  return `${(lat as number).toFixed(6)},${(lng as number).toFixed(6)}`;
}
