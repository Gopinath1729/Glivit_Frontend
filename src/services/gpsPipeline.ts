/**
 * THE GPS pipeline. One module, one set of rules, one set of numbers.
 *
 * <h3>Why this exists</h3>
 * Live tracking, the travelled route, History, playback and the phone's own
 * collector used to each carry their own copy of "is this fix any good?". They
 * had drifted apart on every constant that matters:
 *
 * | rule                | phone collector | live stream          | playback        |
 * | ------------------- | --------------- | -------------------- | --------------- |
 * | speed ceiling       | 220 km/h        | 220..360 km/h        | 220 + 1.5x      |
 * | stationary radius   | 15 m            | 15 m                 | 15 m / 2 m      |
 * | accuracy ceiling    | 50 m            | 50 m                 | 50 m            |
 * | spike detection     | none            | none                 | 75 m out / 50 back |
 * | segment gap rule    | n/a             | NONE                 | 5 min           |
 *
 * The last row is the fault this module was written for: the live route had no
 * segment rule at all, so any telemetry silence shorter than a trip reset was
 * closed with one straight chord between the two fixes either side of it -
 * which is the long diagonal across the buildings.
 *
 * Everything below is a pure function of its arguments, so every rule here is
 * covered by `gpsPipeline.test.mjs` and a regression fails a test rather than a
 * drive.
 *
 * <h3>The four stages, kept apart on purpose</h3>
 * ```
 *   rawGpsPoint       what the sensor or the wire reported. Never modified.
 *        |
 *        v  validateGpsSample()
 *   validatedGpsPoint the fix the pipeline is willing to believe. Movement
 *                     maths (distance, speed, bearing, trip distance) uses
 *                     THIS and only this.
 *        |
 *        v  road matching (backend) + acceptMatchedCoordinate()
 *   roadMatchedPoint  where the OSM matcher placed the validated fix.
 *        |
 *        v  marker animation
 *   displayPoint      what the marker is drawn at this frame.
 * ```
 * A later stage never writes back into an earlier one. In particular the raw
 * coordinate is never replaced by a snapped or an animated one, which is what
 * let road geometry feed back into the next fix's distance and bearing.
 */

// --------------------------------------------------------------- constants

/**
 * Every threshold the pipeline uses, in one object.
 *
 * Changing a rule means changing it here, once, for the phone collector, the
 * live stream, the travelled route, History and playback simultaneously.
 */
export const GPS_LIMITS = {
  /** Beyond this a fix cannot be placed on a specific road. */
  maxAccuracyMeters: 50,
  /** Above this a fix is usable but is reported as low quality. */
  lowAccuracyMeters: 30,
  /** A fix older than this is history, not a live position. */
  maxFixAgeMs: 5 * 60 * 1000,
  /** Device clocks run fast; beyond this the timestamp is wrong, not early. */
  maxFutureSkewMs: 60 * 1000,
  /**
   * Hard ceiling on the speed two consecutive fixes may imply.
   *
   * Deliberately a CONSTANT. The live validator used to raise it to
   * `deviceSpeed * 2.2 + 40` (capped at 360), so a device reporting 100 km/h
   * admitted a 260 km/h chord - which is 360 m of sideways jump at a 5 s
   * update rate, more than enough to put the vehicle on the next street. A
   * vehicle that genuinely exceeds this is not something this product tracks.
   */
  maxSpeedKph: 200,
  /**
   * No single accepted step may exceed this, whatever the elapsed time says.
   *
   * The speed ceiling alone is not a limit on DISTANCE: at 200 km/h a
   * two-minute silence admits a 6.7 km chord. This is the rule that stops one
   * fix after a gap being connected to the last one before it.
   */
  maxStepMeters: 600,
  /** At or below this the vehicle is parked and its coordinate is held. */
  stationarySpeedKph: 2.5,
  /**
   * Radius a parked GPS wanders within. Movement inside it is drift.
   *
   * The TOP of the 10-20 m band consumer GPS wanders over while stationary,
   * not the middle of it: the canonical parked wander is a tenth of a
   * milli-degree in each axis, which is 15.5 m at low latitudes, and a 15 m
   * radius fell just short of the exact case it exists to catch. Matches the
   * backend's `TripDistanceCalculator.DRIFT_RADIUS_METERS`.
   */
  stationaryDriftMeters: 20,
  /** Two fixes closer together than this are the same place. */
  duplicateDistanceMeters: 1,
  /** Minimum travel before a coordinate pair may set a heading. */
  minHeadingMoveMeters: 3,
  /**
   * A lone low-speed excursion at least this far out whose successor returns
   * within {@link spikeReturnMeters} of the previous fix is multipath.
   */
  spikeAwayMeters: 75,
  spikeReturnMeters: 50,
  spikeWindowMs: 5 * 60 * 1000,
  /**
   * FLOOR on the silence that means the roads in between were never observed.
   *
   * The route is BROKEN there - a new polyline run starts - rather than drawn
   * across the interval. It is deliberately far shorter than the trip-reset
   * gap: a 30 s tunnel is not a new journey, but it is absolutely a stretch of
   * road nobody recorded.
   *
   * It is a floor, not the rule. The rule is this device's OWN cadence times
   * {@link segmentGapIntervalFactor}: a phone sampling at 1 Hz has genuinely
   * lost coverage after twenty seconds, while a hardware tracker that reports
   * every two minutes by design has not, and applying the phone's number to it
   * would break its line at every single fix.
   */
  segmentGapMs: 20 * 1000,
  segmentGapIntervalFactor: 4,
  /** Silence longer than this starts a new TRIP. Matches the backend's rule. */
  tripResetGapMs: 4 * 60 * 1000,
  /** Confidence below which a road match is not trusted. */
  minMatchConfidence: 0.2,
  /** A snap further than this from the reported fix is a different road. */
  maxSnapDistanceMeters: 60,
  /**
   * How far a carried snap correction may move a fix that was not solved.
   *
   * Mirrors the backend's own carry limit so the two cannot disagree about
   * whether a coordinate is still describing the same stretch of road.
   */
  maxCarriedSnapMeters: 25,
  /** Matched geometry may not contain a hop longer than this. */
  maxGeometryStepMeters: 120,
  /**
   * Longest step the route may cover between two ENGINE-MATCHED positions when
   * the matcher returned no intermediate road vertices.
   *
   * <p>The live matcher emits the road vertices travelled since the previous
   * match. When a vehicle advances without leaving the road segment it is on,
   * that tail legitimately contains one vertex or none - there is no new vertex
   * to report - and on a real drive that is roughly one fix in six. Refusing
   * those breaks the line into a piece per short step, which is a fragmented
   * route drawn for a vehicle that never left the road.
   *
   * <p>Joining two matched positions across such a step is NOT the raw-GPS
   * fallback this pipeline removed: both endpoints came from the routing engine
   * and lie on the road, and the straight line between two points on one road
   * segment IS that segment. The bound is what keeps it honest - past it, the
   * absence of geometry means the road taken is genuinely unknown, and the line
   * breaks. 30 m is about 108 km/h at a 1 Hz report rate, so it covers ordinary
   * driving and excludes the long silences it is there to catch.
   */
  maxMatchedSegmentStepMeters: 30,
  /** How far matched geometry may sit from the points it claims to join. */
  maxGeometryEndpointGapMeters: 120,
  /** Recent validated fixes retained for the noise/movement decision. */
  rollingWindowSize: 5,
} as const;

/**
 * The silence, and the step, that mean the ground in between was unobserved.
 *
 * Both scale with how often this device actually reports. A raw distance rule
 * cannot be used on its own: a tracker reporting every two minutes covers a
 * kilometre and a half between consecutive fixes at ordinary road speed, and
 * that is its resolution, not a gap.
 *
 * @param expectedIntervalMs this device's typical gap between accepted fixes,
 *                           or null before enough have arrived to know
 */
export function coverageLimitsFor(expectedIntervalMs: number | null | undefined): {
  gapMs: number;
  stepMeters: number;
} {
  const cadence =
    expectedIntervalMs != null && Number.isFinite(expectedIntervalMs) && expectedIntervalMs > 0
      ? expectedIntervalMs
      : null;
  const gapMs = Math.max(
    GPS_LIMITS.segmentGapMs,
    cadence == null ? 0 : cadence * GPS_LIMITS.segmentGapIntervalFactor
  );
  // How far the vehicle could legitimately travel in one reporting interval at
  // the ceiling speed, never below the absolute step limit.
  const reachableMeters = cadence == null ? 0 : (cadence / 1000) * (GPS_LIMITS.maxSpeedKph / 3.6);
  return { gapMs, stepMeters: Math.max(GPS_LIMITS.maxStepMeters, reachableMeters) };
}

const EARTH_RADIUS_METERS = 6_371_008.8;

// --------------------------------------------------------------- primitives

/**
 * One numeric conversion, at the edge, and never again.
 *
 * A JSON body, a native bridge and a SQL driver can each hand back a
 * coordinate as a string. `"12.97" > 90` is false and `Number.isFinite("12.97")`
 * is false, so a string coordinate slips past a range check and then fails
 * silently at the map, which is how a vehicle ends up at Null Island. Converting
 * once, here, means everything downstream is dealing with a real number.
 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type LatLng = { latitude: number; longitude: number };

export type CoordinateRejection =
  | 'missing'
  | 'not_a_number'
  | 'out_of_range'
  | 'axes_reversed'
  | 'null_island';

export type CoordinateCheck =
  | { valid: true; coordinate: LatLng }
  | { valid: false; reason: CoordinateRejection };

/**
 * The single coordinate gate.
 *
 * Rejects null, undefined, NaN, Infinity, strings that are not numbers,
 * out-of-range values, (0,0), and a latitude/longitude pair that has been
 * swapped somewhere between the phone, the API, the database and the map.
 *
 * <h3>On reversal</h3>
 * A swap is REPORTED, never silently corrected. Auto-swapping would hide the
 * defect at exactly the layer that introduced it, and would corrupt genuine
 * data anywhere the pair is legitimately near the equator. The reason code
 * names the fault so the trace points at the layer that produced it.
 */
export function checkCoordinate(
  latitudeInput: unknown,
  longitudeInput: unknown
): CoordinateCheck {
  if (latitudeInput == null || longitudeInput == null) {
    return { valid: false, reason: 'missing' };
  }
  const latitude = toFiniteNumber(latitudeInput);
  const longitude = toFiniteNumber(longitudeInput);
  if (latitude == null || longitude == null) {
    return { valid: false, reason: 'not_a_number' };
  }
  if (Math.abs(latitude) > 90) {
    // A latitude out of range whose partner would be a valid latitude is the
    // signature of a reversed pair, not of corrupt sensor data.
    //
    // This catches only the swaps that are structurally impossible - anything
    // outside +/-90 in the latitude slot. A swap between two values that are
    // BOTH valid latitudes (12.97/77.59 becomes 77.59/12.97, which is a real
    // place in northern Canada) cannot be detected from one sample and is
    // caught against the previous accepted fix instead: see
    // `looksAxisReversed` in `validateGpsSample`.
    return {
      valid: false,
      reason: Math.abs(longitude) <= 90 ? 'axes_reversed' : 'out_of_range',
    };
  }
  if (Math.abs(longitude) > 180) {
    return { valid: false, reason: 'out_of_range' };
  }
  if (Math.abs(latitude) < 1e-7 && Math.abs(longitude) < 1e-7) {
    // Trackers and emulators emit (0,0) before they have a lock.
    return { valid: false, reason: 'null_island' };
  }
  return { valid: true, coordinate: { latitude, longitude } };
}

/** Convenience wrapper: the coordinate, or null. */
export function coordinateOf(latitude: unknown, longitude: unknown): LatLng | null {
  const check = checkCoordinate(latitude, longitude);
  return check.valid ? check.coordinate : null;
}

/** Great-circle distance in metres. The only distance function this app uses. */
export function haversineMeters(
  latA: number,
  lngA: number,
  latB: number,
  lngB: number
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(latB - latA);
  const dLng = toRadians(lngB - lngA);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function distanceBetween(a: LatLng, b: LatLng): number {
  return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

/** Initial compass bearing from `a` to `b`, normalised to [0, 360). */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const phi1 = (a.latitude * Math.PI) / 180;
  const phi2 = (b.latitude * Math.PI) / 180;
  const deltaLambda = ((b.longitude - a.longitude) * Math.PI) / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

export function normalizeDegrees(value: number | null | undefined, fallback = 0): number {
  const degrees = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return ((degrees % 360) + 360) % 360;
}

// ------------------------------------------------------------- stage types

/**
 * A fix exactly as it was reported, before anything has looked at it.
 *
 * Nothing in the pipeline ever writes to one of these. The animated marker
 * position and the road-snapped coordinate live on later stages precisely so
 * that neither can feed back into the next fix's distance, speed or bearing.
 */
export type RawGpsPoint = {
  /** Which vehicle/device this came from, for the trace and for routing. */
  vehicleId: number | string | null;
  /** The GPS clock, epoch ms. Never the arrival clock. */
  timestampMs: number;
  latitude: number;
  longitude: number;
  /** Horizontal uncertainty in metres, or null when the source reports none. */
  accuracyMeters: number | null;
  /** Ground speed in km/h as reported by the device, or null. */
  deviceSpeedKmh: number | null;
  /** Course over ground the device reported, or null. */
  reportedHeading: number | null;
  /** Where this reading came from, for the trace. */
  source: 'device' | 'stream' | 'history';
};

/** A raw fix the pipeline is willing to believe, plus what it measured. */
export type ValidatedGpsPoint = {
  raw: RawGpsPoint;
  /**
   * The coordinate movement maths uses.
   *
   * Equal to the raw coordinate, EXCEPT when the fix was held: a parked
   * vehicle's wander is held at the previous accepted coordinate so the step
   * is zero metres long and contributes no distance and no bearing.
   */
  coordinate: LatLng;
  timestampMs: number;
  /** Metres from the previous accepted coordinate. 0 for the first fix. */
  distanceMeters: number;
  /** Seconds since the previous accepted fix. 0 for the first fix. */
  deltaSeconds: number;
  /** Speed implied by distance/time, km/h. */
  calculatedSpeedKph: number;
  /** The canonical speed for this fix: the device's, or the derived one. */
  speedKmh: number;
  /** Compass bearing to draw, 0-360. */
  bearing: number;
  /** True when this fix was held at the previous coordinate rather than moved. */
  held: boolean;
  /**
   * True when the DEVICE itself reported a speed below the stationary
   * threshold, as opposed to reporting nothing at all.
   *
   * Kept separate from {@link held} because the two answer different
   * questions. `held` asks "may this coordinate move the vehicle?", and an
   * unknown speed correctly answers no until the fix leaves the anchor radius.
   * This asks "is the vehicle parked?", and an unknown speed is not evidence
   * of that in either direction - Android's fused provider omits the speed
   * field routinely while driving, because it needs a Doppler lock the phone
   * may not have.
   *
   * A collector deciding whether to spend a radio transmission must use THIS.
   * Throttling on `held` meant a phone whose speedometer was simply quiet
   * uploaded once every ten seconds while the vehicle was moving.
   */
  deviceConfirmedStationary: boolean;
  /**
   * True when the roads between the previous accepted fix and this one were
   * never observed. The polyline is broken here.
   */
  gapBefore: boolean;
  quality: 'good' | 'low_accuracy';
};

export type GpsRejectionReason =
  | 'invalid_coordinate'
  | 'coordinate_axes_reversed'
  | 'null_island'
  | 'invalid_timestamp'
  | 'future_timestamp'
  | 'stale_timestamp'
  | 'duplicate_timestamp'
  | 'duplicate_coordinate'
  | 'out_of_order'
  | 'invalid_accuracy'
  | 'poor_accuracy'
  | 'impossible_jump'
  | 'implausible_step'
  | 'isolated_spike';

/**
 * Whether an operator needs to be told.
 *
 * `notice` is ordinary pipeline bookkeeping - a reconnect replaying a fix the
 * client already has, a frame that lost a race with a newer one. Reporting
 * those as GPS faults is what trained operators to ignore the ones that matter.
 * `warning` is something wrong with the fix itself.
 */
export type GpsRejectionSeverity = 'notice' | 'warning';

export type GpsDecision =
  | { accepted: true; point: ValidatedGpsPoint }
  | {
      accepted: false;
      reason: GpsRejectionReason;
      severity: GpsRejectionSeverity;
      /** Populated where the check measured something, for the trace. */
      distanceMeters?: number;
      deltaSeconds?: number;
      calculatedSpeedKph?: number;
    };

/** The anchor the next fix is judged against. */
export type AcceptedAnchor = {
  /** The RAW coordinate of the last accepted fix. Movement maths uses this. */
  raw: LatLng;
  /** The coordinate that fix was DRAWN at. Only rendering uses this. */
  display: LatLng;
  timestampMs: number;
  bearing: number;
  speedKmh: number;
  ignition: boolean | null;
};

// ---------------------------------------------------------- rolling window

/**
 * A short history of accepted fixes, used to tell noise from movement.
 *
 * <h3>What it is not</h3>
 * It is NOT an averaging filter. Averaging a window that spans a junction
 * places the vehicle in the middle of the block between two roads - inside a
 * building - and that artefact is indistinguishable from the fault this
 * pipeline exists to remove. The window is only ever used to ANSWER QUESTIONS
 * about the recent past: has this vehicle actually left where it was parked,
 * and is this one fix an excursion the next fix immediately undoes?
 */
export class GpsRollingWindow {
  private readonly entries: { coordinate: LatLng; timestampMs: number; speedKmh: number }[] = [];
  // Written as an explicit field rather than a constructor parameter property:
  // the unit tests run through Node's type-stripping loader, which cannot
  // rewrite parameter properties, and an untestable pipeline is how this code
  // regressed repeatedly in the first place.
  private readonly capacity: number;

  constructor(capacity = GPS_LIMITS.rollingWindowSize) {
    this.capacity = capacity;
  }

  push(coordinate: LatLng, timestampMs: number, speedKmh: number): void {
    this.entries.push({ coordinate, timestampMs, speedKmh });
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** The most recent accepted entry, or null. */
  last(): { coordinate: LatLng; timestampMs: number; speedKmh: number } | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  /**
   * True when every recent fix sits inside the drift radius of the newest one
   * and none of them reported real speed.
   *
   * This is the evidence a candidate departure is measured against: a vehicle
   * whose last five fixes are all within 15 m of each other has not started
   * moving, whatever one outlying sample claims.
   */
  isSettled(): boolean {
    if (this.entries.length < 2) return false;
    const newest = this.entries[this.entries.length - 1];
    return this.entries.every(
      (entry) =>
        entry.speedKmh < GPS_LIMITS.stationarySpeedKph &&
        distanceBetween(entry.coordinate, newest.coordinate) <= GPS_LIMITS.stationaryDriftMeters
    );
  }

  /**
   * Median gap between the window's fixes, in ms, or null before there are two.
   *
   * This is how the pipeline learns a device's cadence without being told it:
   * a phone reports every second or three, a hardware tracker every thirty or
   * every two minutes, and the rules for "has coverage been lost?" and "is this
   * step too long to have been observed?" mean completely different numbers for
   * the two.
   */
  typicalIntervalMs(): number | null {
    if (this.entries.length < 2) return null;
    const gaps: number[] = [];
    for (let i = 1; i < this.entries.length; i += 1) {
      const gap = this.entries[i].timestampMs - this.entries[i - 1].timestampMs;
      if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) return null;
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  }

  /**
   * Radius the recent window covers, in metres. A settled vehicle's is small;
   * a moving one's grows with every fix.
   */
  spreadMeters(): number {
    if (this.entries.length < 2) return 0;
    let spread = 0;
    for (let i = 1; i < this.entries.length; i += 1) {
      spread = Math.max(
        spread,
        distanceBetween(this.entries[i - 1].coordinate, this.entries[i].coordinate)
      );
    }
    return spread;
  }
}

// ------------------------------------------------------------- validation

export type ValidateGpsSampleParams = {
  raw: RawGpsPoint;
  /** The last accepted fix, or null when this is the first of a session. */
  previous: AcceptedAnchor | null;
  /** Recent accepted fixes. Optional; improves the departure decision. */
  window?: GpsRollingWindow | null;
  /** Bearing currently displayed, held whenever nothing better is proven. */
  lastBearing?: number | null;
  /** Wall clock, injectable for tests. */
  now?: number;
};

/**
 * Everything that must be true before a fix is allowed to move a vehicle.
 *
 * The order is deliberate: structural checks that need nothing but the fix,
 * then ordering checks against the previous accepted fix, then the physics.
 * A rejection never mutates anything - the caller keeps what it had and records
 * why.
 */
export function validateGpsSample(params: ValidateGpsSampleParams): GpsDecision {
  const { raw, previous, window, lastBearing, now = Date.now() } = params;

  // --- structural ---------------------------------------------------------
  const coordinate = checkCoordinate(raw.latitude, raw.longitude);
  if (!coordinate.valid) {
    return {
      accepted: false,
      reason:
        coordinate.reason === 'axes_reversed'
          ? 'coordinate_axes_reversed'
          : coordinate.reason === 'null_island'
            ? 'null_island'
            : 'invalid_coordinate',
      severity: 'warning',
    };
  }

  if (!Number.isFinite(raw.timestampMs)) {
    return { accepted: false, reason: 'invalid_timestamp', severity: 'warning' };
  }
  if (raw.timestampMs > now + GPS_LIMITS.maxFutureSkewMs) {
    return { accepted: false, reason: 'future_timestamp', severity: 'warning' };
  }
  if (raw.timestampMs < now - GPS_LIMITS.maxFixAgeMs) {
    // Not a fault: a buffered replay is a real fix, it is simply not a live
    // position. It belongs to history, and history reads it from the database.
    return { accepted: false, reason: 'stale_timestamp', severity: 'notice' };
  }

  const accuracy = raw.accuracyMeters;
  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0)) {
    return { accepted: false, reason: 'invalid_accuracy', severity: 'warning' };
  }
  if (accuracy != null && accuracy > GPS_LIMITS.maxAccuracyMeters) {
    // The uncertainty circle covers several streets. This cannot be placed on
    // a road, so it may not move the vehicle onto one.
    return { accepted: false, reason: 'poor_accuracy', severity: 'warning' };
  }

  const deviceSpeed =
    raw.deviceSpeedKmh != null && Number.isFinite(raw.deviceSpeedKmh)
      ? Math.max(0, raw.deviceSpeedKmh)
      : null;

  // --- first fix of a session --------------------------------------------
  if (!previous) {
    return {
      accepted: true,
      point: {
        raw,
        coordinate: coordinate.coordinate,
        timestampMs: raw.timestampMs,
        distanceMeters: 0,
        deltaSeconds: 0,
        calculatedSpeedKph: 0,
        speedKmh: deviceSpeed ?? 0,
        bearing: normalizeDegrees(raw.reportedHeading ?? lastBearing ?? 0),
        held: false,
        deviceConfirmedStationary:
          deviceSpeed != null && deviceSpeed < GPS_LIMITS.stationarySpeedKph,
        gapBefore: false,
        quality: qualityFor(accuracy),
      },
    };
  }

  // --- ordering -----------------------------------------------------------
  if (raw.timestampMs === previous.timestampMs) {
    return { accepted: false, reason: 'duplicate_timestamp', severity: 'notice' };
  }
  if (raw.timestampMs < previous.timestampMs) {
    // A stale callback, a reconnect replay, or a delivery that overtook an
    // older one. It says nothing new and must never drag the vehicle back.
    return { accepted: false, reason: 'out_of_order', severity: 'notice' };
  }

  const distanceMeters = distanceBetween(previous.raw, coordinate.coordinate);
  const deltaSeconds = (raw.timestampMs - previous.timestampMs) / 1000;
  const calculatedSpeedKph = deltaSeconds > 0 ? (distanceMeters / deltaSeconds) * 3.6 : 0;

  if (distanceMeters <= GPS_LIMITS.duplicateDistanceMeters && deltaSeconds < 1) {
    // Same place, same instant, different packet.
    return {
      accepted: false,
      reason: 'duplicate_coordinate',
      severity: 'notice',
      distanceMeters,
      deltaSeconds,
      calculatedSpeedKph,
    };
  }

  // --- physics ------------------------------------------------------------
  //
  // Both rules are needed and neither implies the other. The speed ceiling
  // catches a teleport across a short interval; the step ceiling catches the
  // same teleport across a long one, where the arithmetic makes 6 km at
  // 200 km/h look perfectly reasonable.
  if (!Number.isFinite(calculatedSpeedKph) || calculatedSpeedKph > GPS_LIMITS.maxSpeedKph) {
    return {
      accepted: false,
      // Both are rejections. Naming the reversal separately is the whole point:
      // "impossible jump" sends somebody looking at the GPS chip, and the fault
      // is a serialiser, a column order or a `[lng, lat]` API somewhere between
      // the phone and the map.
      reason: looksAxisReversed(previous.raw, coordinate.coordinate)
        ? 'coordinate_axes_reversed'
        : 'impossible_jump',
      severity: 'warning',
      distanceMeters,
      deltaSeconds,
      calculatedSpeedKph,
    };
  }
  if (distanceMeters > GPS_LIMITS.maxStepMeters) {
    return {
      accepted: false,
      reason: looksAxisReversed(previous.raw, coordinate.coordinate)
        ? 'coordinate_axes_reversed'
        : 'implausible_step',
      severity: 'warning',
      distanceMeters,
      deltaSeconds,
      calculatedSpeedKph,
    };
  }

  // --- stationary drift ---------------------------------------------------
  //
  // A parked vehicle still reports, and every reported wander drawn as a
  // vertex is a lap of the parking bay. The fix is ACCEPTED - it is the
  // evidence the device is still online, and the stop has a real duration -
  // but it is held at the coordinate the vehicle was last trusted at, so the
  // step is zero metres long and contributes no distance and no bearing.
  const reportedStationary =
    deviceSpeed == null || deviceSpeed < GPS_LIMITS.stationarySpeedKph;
  const withinDriftRadius = distanceMeters <= GPS_LIMITS.stationaryDriftMeters;
  const settled = window?.isSettled() ?? false;
  const held = reportedStationary && withinDriftRadius;

  // A device that reports nothing and has been settled for several fixes needs
  // more than one sample to be believed about a departure. Below the drift
  // radius that decision is already made above; this catches the sample that
  // clears the radius in one step while every other recent fix says parked.
  const unconfirmedDeparture =
    !held &&
    settled &&
    reportedStationary &&
    calculatedSpeedKph >= GPS_LIMITS.stationarySpeedKph * 6;

  const gapBefore =
    deltaSeconds * 1000 > coverageLimitsFor(window?.typicalIntervalMs()).gapMs;

  if (unconfirmedDeparture) {
    return {
      accepted: false,
      reason: 'isolated_spike',
      severity: 'warning',
      distanceMeters,
      deltaSeconds,
      calculatedSpeedKph,
    };
  }

  const coordinateToUse = held ? previous.raw : coordinate.coordinate;
  const bearing = resolveBearing({
    previous: previous.raw,
    current: coordinate.coordinate,
    distanceMeters,
    reportedHeading: raw.reportedHeading,
    deviceSpeedKmh: deviceSpeed,
    accuracyMeters: accuracy,
    lastBearing: lastBearing ?? previous.bearing,
    held,
  });

  return {
    accepted: true,
    point: {
      raw,
      coordinate: coordinateToUse,
      timestampMs: raw.timestampMs,
      distanceMeters: held ? 0 : distanceMeters,
      deltaSeconds,
      calculatedSpeedKph,
      speedKmh: held ? 0 : (deviceSpeed ?? calculatedSpeedKph),
      bearing,
      held,
      deviceConfirmedStationary:
        deviceSpeed != null && deviceSpeed < GPS_LIMITS.stationarySpeedKph,
      // A held fix did not travel, so nothing was missed between it and the
      // previous one however long the silence was.
      gapBefore: gapBefore && !held,
      quality: qualityFor(accuracy),
    },
  };
}

/**
 * Would this fix have been plausible with its axes the other way round?
 *
 * A swap between two values that are both valid latitudes is invisible to a
 * range check - (12.97, 77.59) and (77.59, 12.97) are both real coordinates -
 * so the only witness is the previous accepted position. When the reported pair
 * is thousands of kilometres away and the transposed pair is right next to
 * where the vehicle just was, the axes are reversed and nothing else explains
 * it.
 *
 * The fix is still REJECTED. Silently transposing it would hide the defect at
 * the layer that introduced it - and would corrupt genuine data anywhere near
 * the equator, where a transposed pair is also plausible.
 */
function looksAxisReversed(previous: LatLng, reported: LatLng): boolean {
  if (Math.abs(reported.longitude) > 90) return false;
  const transposed: LatLng = {
    latitude: reported.longitude,
    longitude: reported.latitude,
  };
  const reportedMeters = distanceBetween(previous, reported);
  const transposedMeters = distanceBetween(previous, transposed);
  return (
    reportedMeters > 100_000 &&
    transposedMeters <= GPS_LIMITS.maxStepMeters &&
    transposedMeters * 100 < reportedMeters
  );
}

function qualityFor(accuracy: number | null): 'good' | 'low_accuracy' {
  return accuracy != null && accuracy > GPS_LIMITS.lowAccuracyMeters ? 'low_accuracy' : 'good';
}

/**
 * Which way the vehicle is pointing after this fix.
 *
 * In descending order of trustworthiness:
 *   1. nothing at all while parked or held - the heading is frozen, so drift
 *      can never spin a stationary vehicle;
 *   2. the device's own course over ground, when it reported one AND says it
 *      is moving;
 *   3. the bearing between the last two accepted RAW coordinates;
 *   4. the last bearing displayed, held.
 *
 * RAW coordinates deliberately, never matched ones: two consecutive fixes can
 * be snapped onto opposite carriageways of a dual road, and the bearing between
 * those two snapped points runs across the road rather than along it.
 */
function resolveBearing(params: {
  previous: LatLng;
  current: LatLng;
  distanceMeters: number;
  reportedHeading: number | null;
  deviceSpeedKmh: number | null;
  accuracyMeters: number | null;
  lastBearing: number | null;
  held: boolean;
}): number {
  const held = normalizeDegrees(params.lastBearing ?? params.reportedHeading ?? 0);
  if (params.held) return held;

  const movingBySpeed =
    params.deviceSpeedKmh != null && params.deviceSpeedKmh >= GPS_LIMITS.stationarySpeedKph;
  const movingByDistance = params.distanceMeters >= GPS_LIMITS.minHeadingMoveMeters;
  if (!movingBySpeed && !movingByDistance) return held;

  const reported =
    params.reportedHeading != null && Number.isFinite(params.reportedHeading)
      ? normalizeDegrees(params.reportedHeading)
      : null;
  // The device's course is preferred only when the device itself says it is
  // moving. A phone creeping in traffic reports zero long after it has covered
  // real ground, and there the coordinates are the better witness.
  if (movingBySpeed && reported != null) return reported;
  if (movingByDistance) return bearingBetween(params.previous, params.current);
  return reported ?? held;
}

// ------------------------------------------------- road-matched acceptance

export type MatchedCandidate = {
  latitude: unknown;
  longitude: unknown;
  /** Confidence of the latest road solve, retained while a coordinate is held. */
  confidence: number | null;
  /**
   * How the backend produced the coordinate.
   *
   * `SOLVED`  - the routing engine placed this fix on a road.
   * `HELD`    - no new usable match; keep the exact previous road position.
   * `CARRIED` - the previous solve's correction was carried onto this fix
   *             (legacy backend compatibility only).
   * `NONE`    - the validated coordinate, unmodified.
   *
   * Null for a backend that predates the field, which is read as `SOLVED` when
   * a confidence is present and `NONE` otherwise - the behaviour those clients
   * already had.
   */
  source: 'SOLVED' | 'HELD' | 'CARRIED' | 'NONE' | null;
};

export type RoadMatchedPoint = {
  validated: ValidatedGpsPoint;
  /** The coordinate to DRAW. Never fed back into movement maths. */
  coordinate: LatLng;
  /** True when this coordinate came from the road network, not the sensor. */
  onRoad: boolean;
  /** Metres between the validated fix and where it was drawn. */
  snapDistanceMeters: number;
  confidence: number | null;
  source: 'SOLVED' | 'HELD' | 'CARRIED' | 'NONE';
};

/**
 * Where a validated fix should be drawn.
 *
 * <h3>The rule that stopped the zig-zag</h3>
 * A live trip must not alternate between coordinate spaces. When the router
 * solved one fix and was rate-limited on the next, the marker used to hop
 * between the snapped position and the raw one every other fix - which draws a
 * saw-tooth on and off the carriageway, and is a large part of "the route
 * crosses buildings". A HELD coordinate preserves the exact last road position
 * until a fresh solve arrives. CARRIED remains accepted only for older servers.
 *
 * A held fix keeps the coordinate it was held at: applying a match to it would
 * move the vehicle immediately after deciding not to.
 */
export function acceptMatchedCoordinate(
  validated: ValidatedGpsPoint,
  candidate: MatchedCandidate | null,
  previousDisplay: LatLng | null
): RoadMatchedPoint {
  const unmatched: RoadMatchedPoint = {
    validated,
    coordinate: validated.coordinate,
    onRoad: false,
    snapDistanceMeters: 0,
    confidence: null,
    source: 'NONE',
  };

  if (validated.held) {
    return previousDisplay
      ? { ...unmatched, coordinate: previousDisplay }
      : unmatched;
  }
  if (!candidate) return unmatched;

  const matched = coordinateOf(candidate.latitude, candidate.longitude);
  if (!matched) return unmatched;

  const source =
    candidate.source ?? (candidate.confidence != null ? 'SOLVED' : 'NONE');
  if (source === 'NONE') return unmatched;

  if (source === 'HELD') {
    // A provider failure never promotes the new raw coordinate. The backend
    // repeats its last trusted road coordinate and the client independently
    // verifies that it is the same point it was already drawing.
    if (!previousDisplay || distanceBetween(previousDisplay, matched) > 1) return unmatched;
    return {
      validated,
      coordinate: previousDisplay,
      onRoad: true,
      snapDistanceMeters: distanceBetween(validated.coordinate, previousDisplay),
      confidence: candidate.confidence,
      source: 'HELD',
    };
  }

  const snapDistanceMeters = distanceBetween(validated.coordinate, matched);

  if (source === 'CARRIED') {
    // An extrapolation of the previous solve, not a new one. It is only valid
    // near where it was measured, so it is bounded far more tightly than a
    // fresh match and never claims a confidence.
    if (snapDistanceMeters > GPS_LIMITS.maxCarriedSnapMeters) return unmatched;
    return {
      validated,
      coordinate: matched,
      onRoad: true,
      snapDistanceMeters,
      confidence: null,
      source: 'CARRIED',
    };
  }

  if (
    candidate.confidence == null ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < GPS_LIMITS.minMatchConfidence
  ) {
    // A low-confidence match is the solver guessing between parallel roads.
    // Drawing the reported coordinate is the honest degradation.
    return unmatched;
  }
  if (snapDistanceMeters > GPS_LIMITS.maxSnapDistanceMeters) {
    // The nearest road is not this vehicle's road.
    return unmatched;
  }

  return {
    validated,
    coordinate: matched,
    onRoad: true,
    snapDistanceMeters,
    confidence: candidate.confidence,
    source: 'SOLVED',
  };
}

// ------------------------------------------------------ segment connectivity

export type SegmentBreakReason =
  | 'telemetry_gap'
  | 'excessive_step'
  | 'impossible_speed'
  | 'road_discontinuity'
  /**
   * The vehicle drove continuously, but the stretch it just covered has no road
   * geometry, so the drawn route has a hole in it there.
   *
   * A break for a reason that is about the MAP rather than about the telemetry.
   * Without it, the next matched segment extends the run across the hole and
   * joins the last matched vertex straight to the next one - a chord through
   * whatever the matcher could not place.
   */
  | 'unmatched_stretch'
  | 'new_trip';

export type SegmentDecision =
  | { connect: true }
  | { connect: false; reason: SegmentBreakReason };

/**
 * May these two consecutive drawn positions be joined by a polyline segment?
 *
 * <h3>The rule the live route did not have</h3>
 * Nothing before this asked the question at all. `Polyline([...coordinates])`
 * - or its equivalent, appending both ends of every accepted pair to one run -
 * joins whatever it is given, so a telemetry silence became one straight chord
 * between the fixes either side of it. That chord is the long diagonal across
 * the buildings, and it appeared on every backgrounded app, every tunnel,
 * every reconnect and every server restart.
 *
 * A break is not a loss: the run ends and a new one begins at the far side, so
 * both stretches are still drawn and the unobserved ground between them simply
 * is not.
 */
export function segmentConnectivity(params: {
  previousTimestampMs: number;
  currentTimestampMs: number;
  /** Distance between the two DRAWN coordinates, in metres. */
  distanceMeters: number;
  /** True when the pipeline already flagged a coverage gap before this fix. */
  gapBefore?: boolean;
  newTrip?: boolean;
  /** This device's typical gap between accepted fixes. See {@link coverageLimitsFor}. */
  expectedIntervalMs?: number | null;
}): SegmentDecision {
  if (params.newTrip) return { connect: false, reason: 'new_trip' };
  if (params.gapBefore) return { connect: false, reason: 'telemetry_gap' };

  const limits = coverageLimitsFor(params.expectedIntervalMs);
  const deltaMs = params.currentTimestampMs - params.previousTimestampMs;
  if (!Number.isFinite(deltaMs) || deltaMs > limits.gapMs) {
    return { connect: false, reason: 'telemetry_gap' };
  }
  if (params.distanceMeters > limits.stepMeters) {
    return { connect: false, reason: 'excessive_step' };
  }
  if (deltaMs > 0) {
    const kph = (params.distanceMeters / (deltaMs / 1000)) * 3.6;
    if (kph > GPS_LIMITS.maxSpeedKph) {
      return { connect: false, reason: 'impossible_speed' };
    }
  }
  return { connect: true };
}

/**
 * Splits a coordinate list wherever a vertex is unusable.
 *
 * The previous helper DELETED an invalid vertex and carried on, which joins its
 * two neighbours with a straight line - the exact artefact the vertex was
 * dropped to avoid. A break is drawn as a break instead.
 */
export function splitOnInvalidVertices(
  coordinates: readonly { latitude: unknown; longitude: unknown }[]
): LatLng[][] {
  const runs: LatLng[][] = [];
  let current: LatLng[] = [];
  for (const entry of coordinates) {
    const coordinate = coordinateOf(entry?.latitude, entry?.longitude);
    if (!coordinate) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push(coordinate);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

// ----------------------------------------------------------------- tracing

/**
 * The one trace record shape, carrying every field needed to say exactly where
 * a bad coordinate entered the pipeline.
 *
 * Deliberately a flat object of primitives: a trace that has to be expanded in
 * a console to be read is not one anybody uses at the roadside.
 */
/**
 * What the pipeline did with a fix once it had finished judging it.
 *
 * The validation verdict alone does not answer the question an operator
 * actually asks - "did this coordinate end up on my route?" - because an
 * accepted fix can still be held, and a held fix extends nothing. Naming the
 * outcome separately closes the trace: every fix now says both what was
 * decided about it and what was done with it.
 */
export type GpsPipelineOutcome =
  /** Extended the live polyline and became a stored playback point. */
  | 'LIVE_APPENDED'
  /** Persisted for replay, but did not extend the live line. */
  | 'PLAYBACK_STORED'
  /** Deliberately did nothing: rejected, held, or duplicated. */
  | 'SKIPPED';

export type GpsTraceRecord = {
  vehicleId: number | string | null;
  /** The reporting device. Equal to `vehicleId` where one device is one vehicle. */
  deviceId: number | string | null;
  timestamp: string;
  rawLat: number | null;
  rawLng: number | null;
  accuracy: number | null;
  deviceSpeed: number | null;
  previousAcceptedPoint: string | null;
  distanceMeters: number | null;
  deltaSeconds: number | null;
  calculatedSpeed: number | null;
  bearing: number | null;
  validationResult: 'accepted' | 'accepted_held' | 'rejected';
  rejectionReason: GpsRejectionReason | null;
  roadMatchedLatLng: string | null;
  snapDistance: number | null;
  finalRenderedLatLng: string | null;
  outcome: GpsPipelineOutcome;
  /**
   * The whole journey of this fix on one line.
   *
   * `RAW -> ACCEPTED|REJECTED -> reason -> MATCHED -> outcome`. Structured
   * fields are better for machines; a single greppable line is what gets a
   * fault localised at the roadside, and reconstructing it by eye from
   * fourteen separate keys is not something anybody does twice.
   */
  pipeline: string;
};

function coordinateText(coordinate: LatLng | null | undefined): string | null {
  if (!coordinate) return null;
  return `${coordinate.latitude.toFixed(6)},${coordinate.longitude.toFixed(6)}`;
}

/** Builds the trace record for one processed fix, accepted or not. */
export function buildTraceRecord(params: {
  raw: RawGpsPoint;
  previous: AcceptedAnchor | null;
  decision: GpsDecision;
  matched?: RoadMatchedPoint | null;
  rendered?: LatLng | null;
  /** What the caller went on to do with this fix. Defaults to SKIPPED. */
  outcome?: GpsPipelineOutcome;
  /** The reporting device, when the caller knows it separately. */
  deviceId?: number | string | null;
}): GpsTraceRecord {
  const { raw, previous, decision, matched, rendered } = params;
  const accepted = decision.accepted ? decision.point : null;
  const outcome: GpsPipelineOutcome = params.outcome ?? 'SKIPPED';
  const verdict = !decision.accepted
    ? `REJECTED -> ${decision.reason}`
    : decision.point.held
      ? 'ACCEPTED -> held_stationary_drift'
      : 'ACCEPTED';
  const matchStage = matched?.onRoad
    ? `MATCHED(${matched.source}) ${coordinateText(matched.coordinate)}`
    : 'UNMATCHED';
  return {
    vehicleId: raw.vehicleId,
    deviceId: params.deviceId ?? raw.vehicleId,
    timestamp: Number.isFinite(raw.timestampMs)
      ? new Date(raw.timestampMs).toISOString()
      : String(raw.timestampMs),
    rawLat: toFiniteNumber(raw.latitude),
    rawLng: toFiniteNumber(raw.longitude),
    accuracy: raw.accuracyMeters,
    deviceSpeed: raw.deviceSpeedKmh,
    previousAcceptedPoint: coordinateText(previous?.raw),
    distanceMeters: accepted ? accepted.distanceMeters : (decision.accepted ? null : decision.distanceMeters ?? null),
    deltaSeconds: accepted ? accepted.deltaSeconds : (decision.accepted ? null : decision.deltaSeconds ?? null),
    calculatedSpeed: accepted
      ? accepted.calculatedSpeedKph
      : decision.accepted
        ? null
        : decision.calculatedSpeedKph ?? null,
    bearing: accepted ? accepted.bearing : null,
    validationResult: !decision.accepted
      ? 'rejected'
      : decision.point.held
        ? 'accepted_held'
        : 'accepted',
    rejectionReason: decision.accepted ? null : decision.reason,
    roadMatchedLatLng: matched?.onRoad ? coordinateText(matched.coordinate) : null,
    snapDistance: matched?.onRoad ? matched.snapDistanceMeters : null,
    finalRenderedLatLng: coordinateText(rendered ?? matched?.coordinate ?? accepted?.coordinate),
    outcome,
    pipeline: `RAW ${coordinateText(checkCoordinate(raw.latitude, raw.longitude).valid
      ? { latitude: raw.latitude as number, longitude: raw.longitude as number }
      : null) ?? 'invalid'} -> ${verdict} -> ${matchStage} -> ${outcome}`,
  };
}

// ----------------------------------------------------------- acquisition

/**
 * The warm-up rules. Deliberately separate numbers from {@link GPS_LIMITS}.
 *
 * Steady-state limits answer "may this fix move a vehicle that is already
 * being tracked correctly?". Acquisition answers a harder question: "is this
 * receiver telling the truth yet at all?" - and it has no previously trusted
 * position to measure against, which is exactly why it needs stricter evidence
 * rather than looser.
 */
export const GPS_ACQUISITION = {
  /** Consecutive agreeing fixes before the session is trusted. */
  minSamples: 4,
  /**
   * Accuracy ceiling DURING warm-up.
   *
   * Tighter than {@link GPS_LIMITS.maxAccuracyMeters}. A cold receiver reports
   * 30-50 m for its first several seconds while it is still deciding which
   * satellites it can see, and those fixes pass the steady-state ceiling. They
   * are also the ones that wander a hundred metres between consecutive
   * readings, which is the zig-zag at the start of every route.
   */
  maxAccuracyMeters: 35,
  /** A sample already this stale when it arrives is not evidence of "now". */
  maxSampleAgeMs: 15_000,
  /**
   * Give up on the strict ceiling after this long.
   *
   * Indoors, in an urban canyon or under cover a receiver may never reach
   * 35 m. Waiting forever means the vehicle never appears at all, which is
   * worse than a slightly less precise start - so after this the ceiling
   * relaxes to the steady-state one and warm-up completes on the ordinary
   * rules. It never relaxes below those, so warm-up can never admit a fix that
   * ordinary validation would refuse.
   */
  maxWarmupMs: 30_000,
} as const;

export type AcquisitionRejection =
  | 'invalid_coordinate'
  | 'invalid_timestamp'
  | 'stale_sample'
  | 'out_of_order'
  | 'poor_accuracy'
  | 'implausible_step';

export type AcquisitionVerdict =
  /** Counted, but the session is not trusted yet. Do not send, store or draw. */
  | { state: 'acquiring'; samples: number; needed: number; reason: AcquisitionRejection | null }
  /** This fix completes warm-up, or warm-up was already complete. Proceed. */
  | { state: 'acquired'; samples: number };

type AcquisitionSample = {
  coordinate: LatLng;
  timestampMs: number;
  accuracyMeters: number | null;
};

/**
 * The GPS warm-up gate: nothing is sent, stored or drawn until the receiver
 * has proven itself.
 *
 * <h3>Why the first fix is the worst one</h3>
 * A cold GPS returns a position long before it returns a good one. The first
 * readings are typically a fused cell/Wi-Fi estimate or a two-satellite
 * solution: they satisfy every structural check, carry a plausible accuracy
 * number, and sit anywhere within a block or two of the truth. Posted
 * immediately they become the route's first vertex, the trip's origin and the
 * stored playback record's first point - permanently. Everything after them is
 * measured from a position that was never real, which is why a live route is
 * wrong at the start and "gets better after a while": the pipeline is not
 * healing, it is simply leaving the bad opening behind.
 *
 * <h3>What counts as proof</h3>
 * {@link GPS_ACQUISITION.minSamples} consecutive fixes that are each fresh,
 * each inside the acquisition accuracy ceiling, strictly ordered in time, and
 * separated by steps the elapsed time can actually explain. The step test is
 * the same Haversine-over-elapsed-time physics the steady-state validator
 * uses, so warm-up completes just as readily for a phone that starts tracking
 * in a moving car as for one sitting on a desk. There is no fixed movement
 * threshold to re-tune per travel mode - walking, cycling and driving all
 * satisfy the same rule because the rule is expressed as a speed, not as a
 * distance.
 *
 * A single failing sample resets the run. That is the point: a receiver whose
 * consecutive fixes disagree with each other has not converged, and the run
 * length is precisely the measurement of that.
 *
 * <h3>Scope</h3>
 * One gate per tracked device session. Callers key it accordingly; a device
 * change must construct a new gate rather than reuse this one, or one
 * vehicle's warm-up would vouch for another vehicle's receiver.
 */
export class GpsAcquisitionGate {
  private readonly samples: AcquisitionSample[] = [];
  private startedAtMs: number | null = null;
  private acquired = false;

  /** True once warm-up has completed and ordinary validation has taken over. */
  get isAcquired(): boolean {
    return this.acquired;
  }

  /** Agreeing fixes collected so far in the current run. */
  get sampleCount(): number {
    return this.samples.length;
  }

  /** Forgets everything. Use on device change, sign-out or a tracking restart. */
  reset(): void {
    this.samples.length = 0;
    this.startedAtMs = null;
    this.acquired = false;
  }

  /**
   * Offers one raw fix to the gate.
   *
   * @returns `acquired` when the caller may proceed with this fix, `acquiring`
   *          when the caller must drop it and wait for the next one.
   */
  offer(raw: RawGpsPoint, now = Date.now()): AcquisitionVerdict {
    if (this.acquired) return { state: 'acquired', samples: this.samples.length };
    if (this.startedAtMs == null) this.startedAtMs = now;

    const verdict = this.evaluate(raw, now);
    if (verdict.state === 'acquired') this.acquired = true;
    return verdict;
  }

  private fail(reason: AcquisitionRejection): AcquisitionVerdict {
    // A disagreeing sample invalidates the whole run, not just itself. Keeping
    // the earlier samples would let a receiver that alternates between a good
    // and a bad solution accumulate its way to "converged" without ever having
    // converged.
    this.samples.length = 0;
    return { state: 'acquiring', samples: 0, needed: GPS_ACQUISITION.minSamples, reason };
  }

  private evaluate(raw: RawGpsPoint, now: number): AcquisitionVerdict {
    const coordinate = checkCoordinate(raw.latitude, raw.longitude);
    if (!coordinate.valid) return this.fail('invalid_coordinate');
    if (!Number.isFinite(raw.timestampMs)) return this.fail('invalid_timestamp');
    if (raw.timestampMs > now + GPS_LIMITS.maxFutureSkewMs) return this.fail('invalid_timestamp');
    if (now - raw.timestampMs > GPS_ACQUISITION.maxSampleAgeMs) {
      // A buffered or delayed reading says where the phone WAS. Warm-up is a
      // claim about the receiver right now, so it cannot be built out of one.
      return this.fail('stale_sample');
    }

    const accuracy = raw.accuracyMeters;
    if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0)) {
      return this.fail('poor_accuracy');
    }
    if (accuracy != null && accuracy > this.accuracyCeiling(now)) {
      return this.fail('poor_accuracy');
    }

    const previous = this.samples[this.samples.length - 1];
    if (previous) {
      if (raw.timestampMs <= previous.timestampMs) return this.fail('out_of_order');
      const distanceMeters = distanceBetween(previous.coordinate, coordinate.coordinate);
      const deltaSeconds = (raw.timestampMs - previous.timestampMs) / 1000;
      const impliedKph = deltaSeconds > 0 ? (distanceMeters / deltaSeconds) * 3.6 : Infinity;
      // The same two rules the steady-state validator applies, for the same
      // reason: the speed ceiling catches a teleport across a short interval,
      // the step ceiling catches one across a long interval where the
      // arithmetic makes the distance look reasonable. Together they let a car
      // at 100 km/h through and keep a stationary receiver's 200 m hop out.
      if (!Number.isFinite(impliedKph) || impliedKph > GPS_LIMITS.maxSpeedKph) {
        return this.fail('implausible_step');
      }
      if (distanceMeters > GPS_LIMITS.maxStepMeters) return this.fail('implausible_step');
    }

    this.samples.push({
      coordinate: coordinate.coordinate,
      timestampMs: raw.timestampMs,
      accuracyMeters: accuracy,
    });
    if (this.samples.length >= GPS_ACQUISITION.minSamples) {
      return { state: 'acquired', samples: this.samples.length };
    }
    return {
      state: 'acquiring',
      samples: this.samples.length,
      needed: GPS_ACQUISITION.minSamples,
      reason: null,
    };
  }

  /**
   * The accuracy a sample must beat to count, which relaxes exactly once.
   *
   * Strict while there is any prospect of a better fix; the ordinary
   * steady-state ceiling after {@link GPS_ACQUISITION.maxWarmupMs}, so a
   * receiver that genuinely cannot do better under cover still starts tracking
   * rather than leaving the vehicle invisible indefinitely.
   */
  private accuracyCeiling(now: number): number {
    const warmingForMs = this.startedAtMs == null ? 0 : now - this.startedAtMs;
    return warmingForMs >= GPS_ACQUISITION.maxWarmupMs
      ? GPS_LIMITS.maxAccuracyMeters
      : GPS_ACQUISITION.maxAccuracyMeters;
  }
}
