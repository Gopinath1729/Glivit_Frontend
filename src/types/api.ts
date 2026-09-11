/** TypeScript mirrors of the backend (glivt) DTOs and response envelope. */

export type ApiError = {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  correlationId?: string;
  timestamp?: string;
};

export type PageResponse<T> = {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
};

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'TENANT_ADMIN' | 'COMPANY_USER';

export type TenantConfig = {
  companyCode: string;
  name: string;
  appName: string;
  logoUrl?: string | null;
  splashImageUrl?: string | null;
  primaryColor: string;
  secondaryColor: string;
  supportPhone?: string | null;
  supportEmail?: string | null;
  privacyPolicyUrl?: string | null;
  termsUrl?: string | null;
  enabledModules: string[];
  paymentEnabled: boolean;
  maxHistoryDays: number;
  minAppVersion?: string | null;
  status: string;
};

export type AuthUser = {
  id: number;
  /** The ACTIVE tenant this session acts inside. Changes when the user switches tenant. */
  tenantId: number;
  /** The tenant that owns the login. Never changes. */
  homeTenantId?: number | null;
  /** Company code of the active tenant. */
  tenantCode?: string | null;
  tenantName?: string | null;
  companyName?: string | null;
  username: string;
  name: string;
  email?: string | null;
  role: Role;
  permissions: Record<string, boolean>;
};

export type TokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSeconds: number;
  user: AuthUser;
};

export type TenantStatus = 'ACTIVE' | 'DISABLED' | 'MAINTENANCE';

/** A row in the Manage Tenants list (backend TenantDto). */
export type TenantSummary = {
  id: number;
  /** The tenant's unique public identifier, used as the login company code. */
  tenantId: string;
  name: string;
  companyName: string;
  adminName?: string | null;
  adminEmail?: string | null;
  adminPhone?: string | null;
  status: string;
  appName?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** True for the caller's currently active tenant. */
  current: boolean;
  /** The server's verdict; the UI must not offer a delete it will refuse. */
  canDelete: boolean;
  deleteBlockedReason?: string | null;
};

export type TenantCreateRequest = {
  name: string;
  companyName: string;
  adminName: string;
  adminEmail: string;
  adminPhone: string;
  status: TenantStatus;
};

export type TenantMemberRole = 'ALL' | 'ADMIN' | 'USER';

export type TenantUpdateRequest = {
  name: string;
  companyName: string;
  adminName: string;
  adminEmail: string;
  adminPhone: string;
  status: TenantStatus;
};

export type TenantSwitchResponse = {
  session: TokenResponse;
  tenant: TenantConfig;
  activeTenant: TenantSummary;
};

export type DashboardSummary = {
  counts: Record<string, number>;
  total: number;
  lastUpdated: string;
};

export type DeviceSummary = {
  id: number;
  name: string;
  imei: string;
  sourceType?: 'GPS_DEVICE' | 'MOBILE_GPS';
  category: string;
  vehicleId?: number | null;
  vehicleName?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  driverAddress?: string | null;
  groupId?: number | null;
  simNumber?: string | null;
  simProvider?: string | null;
  state: string;
  latitude?: number | null;
  longitude?: number | null;
  speed: number;
  course: number;
  ignition?: boolean | null;
  gpsValid: boolean;
  address?: string | null;
  lastUpdate?: string | null;
  expiryDate?: string | null;
  status: string;
  /** Engine cut by an ENGINE_CUT command; cleared by ENGINE_RESTORE. */
  immobilised?: boolean;
  /** Locked by a LOCK command; cleared by UNLOCK. */
  locked?: boolean;
  lastCommandType?: string | null;
  lastCommandAt?: string | null;
  /**
   * Tenant staleness threshold for `lastUpdate`, from the server, so the client
   * applies the same freshness rule rather than guessing its own.
   */
  offlineTimeoutSeconds: number;
};

export type DeviceDetail = DeviceSummary & {
  /**
   * The backend's running trip distance for this device, in km.
   *
   * Sent by `DeviceDetail` on the server and simply not declared here, so the
   * live screen had nothing to show for a vehicle that was not currently
   * streaming and displayed 0.0 km for a trip the server had measured at
   * 0.67 km.
   */
  tripDistanceKm?: number | null;
  model?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  driverAddress?: string | null;
  managerId?: number | null;
  simNumber?: string | null;
  simProvider?: string | null;
  simApn?: string | null;
  remarks?: string | null;
  activatedAt?: string | null;
  timezone?: string | null;
  distanceUnit?: string | null;
  speedUnit?: string | null;
};

export type VehicleDocumentDto = {
  id: number;
  deviceId: number;
  name: string;
  documentType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  expiryDate?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VehicleDocumentContent = {
  fileName: string;
  contentType: string;
  content: string;
};

export type GroupDto = {
  id: number;
  name: string;
  parentId?: number | null;
  managerId?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Lifecycle of a member account, mirroring the backend UserStatus.
 *
 * A member the Tenant Admin has just created is PENDING_ACTIVATION: the row
 * exists but holds no password and its address is unverified, so the Members
 * list must say so rather than implying the person can already sign in.
 */
export type MemberStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'DISABLED' | 'LOCKED';

export type ManagedUserDto = {
  id: number;
  username: string;
  name: string;
  email?: string | null;
  /** True once the address has answered a verification code. */
  emailVerified?: boolean;
  mobile?: string | null;
  address?: string | null;
  role: Role;
  managerId?: number | null;
  status: MemberStatus | string;
  accountExpiry?: string | null;
  permissions: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
};

/** Reply to a "send me a code" request. Carries no code and no account data. */
export type OtpChallengeResponse = {
  message: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
};

/** The server-issued proof that a code was answered. */
export type OtpVerifiedResponse = {
  verificationToken: string;
  expiresInSeconds: number;
};

export type SimpleMessageResponse = {
  message: string;
};

export type EventDto = {
  id: number;
  deviceId: number;
  vehicleId?: number | null;
  eventType: string;
  severity: string;
  latitude?: number | null;
  longitude?: number | null;
  speed?: number | null;
  address?: string | null;
  deviceTime?: string | null;
  serverTime: string;
  acknowledged: boolean;
  acknowledgedAt?: string | null;
  detail?: string | null;
};

export type GeofenceDto = {
  id: number;
  name: string;
  description?: string | null;
  color: string;
  type: 'CIRCLE' | 'POLYGON' | 'POLYLINE' | string;
  coordinates: number[][];
  radiusMeters?: number | null;
  corridorWidthMeters?: number | null;
  assignedDeviceIds: number[];
  assignedGroupIds: number[];
  enterAlert: boolean;
  exitAlert: boolean;
  activeSchedule?: string | null;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CommandDto = {
  id: number;
  deviceId: number;
  commandType: string;
  payload?: string | null;
  status: 'REQUESTED' | 'SENT' | 'DELIVERED' | 'ACKNOWLEDGED' | 'FAILED' | 'TIMED_OUT';
  idempotencyKey: string;
  responseMessage?: string | null;
  requestedAt: string;
  updatedAt: string;
};

export type ReportDto = {
  id: number;
  reportType: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  fromTime: string;
  toTime: string;
  outputFormat: string;
  fileName?: string | null;
  fileSize?: number | null;
  downloadUrl?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

export type ReportContent = {
  fileName: string;
  contentType: string;
  content: string;
};

export type ReportPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type ReportLocationPoint = {
  label: string;
  dateTime: string;
  latitude: number;
  longitude: number;
  /** Horizontal GPS uncertainty in metres. */
  accuracyMeters?: number | null;
  address: string;
  lastKnown: boolean;
};

export type ReportActivityEvent = {
  startTime: string;
  endTime: string;
  durationSeconds: number;
  latitude?: number | null;
  longitude?: number | null;
  address: string;
};

export type ReportOverspeedEvent = {
  startTime: string;
  endTime: string;
  durationSeconds: number;
  maximumSpeedKmh: number;
  speedLimitKmh: number;
  latitude?: number | null;
  longitude?: number | null;
  address: string;
};

/** One bucket of the distance trend: a labelled day/week/month and its total. */
export type ReportTrendPoint = { label: string; bucketStart: string; distanceKm: number };

/**
 * Fleet-wide activity for one time window, summed across every vehicle the
 * caller may reach.
 *
 * `totalVehicles` counts vehicles in scope whether or not they reported;
 * `reportingVehicles` counts only those that did. `hasData` is false when
 * nothing reported, and the screen shows an empty state rather than a grid of
 * zeroes -- which would read as "the fleet did nothing" instead of "there is
 * nothing to show".
 */
export type FleetTimelineReport = {
  fromTime: string;
  toTime: string;
  period: ReportPeriod;
  totalVehicles: number;
  reportingVehicles: number;
  hasData: boolean;
  summary: {
    totalDistanceKm: number;
    runningSeconds: number;
    idleSeconds: number;
    stoppedSeconds: number;
    offlineSeconds: number;
    maximumSpeedKmh: number;
    averageSpeedKmh: number;
    totalTrips: number;
  };
  distanceTrend: ReportTrendPoint[];
};

export type VehicleActivityReport = {
  deviceId: number;
  vehicleId?: number | null;
  vehicleName: string;
  registrationNumber: string;
  imei: string;
  vehicleStatus: string;
  fromTime: string;
  toTime: string;
  period: ReportPeriod;
  hasGpsData: boolean;
  summary: {
    totalDistanceKm: number;
    runningSeconds: number;
    idleSeconds: number;
    stoppedSeconds: number;
    offlineSeconds: number;
    maximumSpeedKmh: number;
    averageSpeedKmh: number;
    overspeedCount: number;
    /**
     * Continuous periods of movement, not one per position report.
     *
     * Optional because a backend older than this field simply omits it, and a
     * client that types it as required renders `NaN` against such a server.
     */
    trips?: number;
  };
  distanceTrend: ReportTrendPoint[];
  journey: { start?: ReportLocationPoint | null; end?: ReportLocationPoint | null };
  stopIdleDetails: {
    totalStops: number;
    stops: ReportActivityEvent[];
    totalIdleEvents: number;
    idleEvents: ReportActivityEvent[];
  };
  overspeedDetails: ReportOverspeedEvent[];
  activitySummary: { status: 'RUNNING' | 'IDLE' | 'STOPPED' | 'OFFLINE'; durationSeconds: number; percentage: number }[];
};

export type SettingsDto = {
  distanceUnit: string;
  speedUnit: string;
  timeFormat: string;
  mapStyle: string;
  trafficEnabled: boolean;
  routeColorMode: string;
  notificationSound: boolean;
  language: string;
  dateFormat: string;
  defaultHistoryRange: string;
  autoFollowVehicle: boolean;
  refreshFrequencySeconds: number;
  privacyOptions?: string | null;
  themeMode?: 'light' | 'dark' | 'system';
  themeColor?: string | null;
  updatedAt?: string | null;
};

export type AuditDto = {
  id: number;
  userId?: number | null;
  username?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  outcome: string;
  correlationId?: string | null;
  detail?: string | null;
  createdAt: string;
};

// --- Telemetry: position history & route playback (backend Stage 1) ---
export type PositionDto = {
  id: number;
  deviceTime: string;
  serverTime: string;
  latitude: number;
  longitude: number;
  /** Canonical km/h. The backend converted it exactly once, at ingest. */
  speedKmh?: number;
  /** Legacy alias of `speedKmh`. */
  speed: number;
  course: number;
  ignition?: boolean | null;
  gpsValid: boolean;
  satellites?: number | null;
  networkSignal?: number | null;
  fuelLevel?: number | null;
  eventType?: string | null;
  address?: string | null;
};

export type PlaybackTrackPoint = {
  t: string;
  lat: number;
  lng: number;
  /**
   * Identity of the stored fix behind this point.
   *
   * The boundary between a hydrated trip and the live stream is expressed with
   * this and nothing else: history is every point up to and including the last
   * hydrated `positionId`, the stream is everything after it, and a fix that
   * appears in both is de-duplicated by id.
   *
   * It replaces a spatial join. The two halves used to be attached whenever the
   * last history vertex happened to sit within ~120 m of the first live one —
   * which a parallel carriageway, a service road or the street under a flyover
   * all satisfy, so reopening the screen could splice the route onto the wrong
   * road. Proximity is not identity.
   *
   * Optional for a backend that predates the field.
   */
  positionId?: number | null;
  /**
   * Where the backend map matcher placed this fix on the OSM road network.
   * Absent when the matcher could not place it confidently, in which case the
   * reported coordinate is used and the route is reported as unmatched rather
   * than presented as if it had been matched.
   */
  matchedLat?: number | null;
  matchedLng?: number | null;
  matched?: boolean;
  /** Horizontal GPS uncertainty in metres. */
  accuracyMeters?: number | null;
  /** Canonical km/h from the backend. Converted exactly once, at ingest. */
  speedKmh?: number;
  /** Legacy alias of `speedKmh`. */
  speed: number;
  /**
   * Confirmed travel from the start of the range up to this fix, in km, as
   * measured by the backend.
   *
   * The app never derives distance itself. The drawn route follows road
   * geometry and is longer than the path between fixes, so measuring what is
   * drawn over-reports; and a stationary phone's jitter, summed on the client,
   * is exactly what produced 3 km for a vehicle that never moved.
   */
  distanceKm?: number;
  course: number;
  ignition?: boolean | null;
  gpsValid: boolean;
  /**
   * The tracker went silent between the previous point and this one while the
   * vehicle kept moving, so the roads in between were never observed. The route
   * is broken here instead of being drawn as a straight line across them.
   */
  gapBefore?: boolean;
  /** Client-only marker used to reconcile overlapping road-match chunks. */
  mapMatched?: boolean;
  /**
   * The GPS coordinate exactly as the tracker reported it, kept for auditing
   * whenever `lat`/`lng` have been moved by drift-holding or road snapping.
   * Absent when the rendered coordinate is still the reported one. Nothing on
   * the map may read these: rendering uses `lat`/`lng` only.
   */
  rawLat?: number;
  rawLng?: number;
};

export type PlaybackEventMarker = {
  t: string;
  lat: number;
  lng: number;
  eventType: string;
};

export type PlaybackStopMarker = {
  from: string;
  to: string;
  lat: number;
  lng: number;
  minutes: number;
  seconds: number;
  /** 1-based position of this stop in the journey. */
  index: number;
  /** Distance travelled since the previous stop, or since the journey start. */
  distanceFromPreviousKm: number;
  address?: string | null;
};

export type PlaybackSegmentType = 'MOVING' | 'STOPPED' | 'NO_DATA';

/** One contiguous span of the journey, in chronological order. */
export type PlaybackTimelineSegment = {
  type: PlaybackSegmentType;
  from: string;
  to: string;
  seconds: number;
  distanceKm: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  startAddress?: string | null;
  endAddress?: string | null;
  /** Set on STOPPED spans; matches PlaybackStopMarker.index. */
  stopIndex?: number | null;
  averageSpeedKmh: number;
  maxSpeedKmh: number;
};

export type PlaybackLocation = {
  time: string;
  lat: number;
  lng: number;
  address?: string | null;
};

export type PlaybackSummary = {
  startTime: string | null;
  endTime: string | null;
  totalSeconds: number;
  movingSeconds: number;
  stoppedSeconds: number;
  noDataSeconds: number;
  distanceKm: number;
  stopCount: number;
  startLocation: PlaybackLocation | null;
  endLocation: PlaybackLocation | null;
};

/** Status of the backend road-matching pass over a history range. */
/**
 * Why a route is, or is not, drawn on road geometry.
 *
 * `UNAVAILABLE` is deliberately distinct from `UNMATCHED`: both fall back to
 * validated GPS, but the first is a routing service that is configured and not
 * answering - a deployment problem an operator can fix - and the second is a
 * trace the service genuinely could not place. Reporting them identically meant
 * a router that had been down for days looked like a run of awkward trips.
 */
export type MapMatchStatus =
  | 'MATCHED'
  | 'PARTIAL'
  | 'UNMATCHED'
  /**
   * The road answer for this fix has been asked for and has not come back yet.
   *
   * Deliberately distinct from `UNMATCHED`. Nothing has been decided, so the UI
   * must neither draw a road for this stretch nor report a matching fault; it
   * shows the vehicle and waits. The live pipeline publishes the validated fix
   * immediately and its ROAD_MATCH enrichment a moment later, and this is the
   * state in between.
   */
  | 'PENDING'
  | 'UNAVAILABLE'
  | 'DISABLED';

/**
 * One contiguous polyline of matched road, as `[latitude, longitude]` pairs.
 *
 * Runs are separated by genuine coverage gaps, and each is drawn as its own
 * polyline. That separation is the whole reason a break in the data is never
 * rendered as a diagonal across the buildings between its two ends.
 */
export type PlaybackRouteRun = {
  path: [number, number][];
  /** False when this run fell back to the validated GPS trace. */
  matched: boolean;
  confidence: number;
  /** Index into `points` of the first fix this run covers. */
  fromIndex: number;
  /** Index into `points` of the last fix this run covers. */
  toIndex: number;
};

export type PlaybackResponse = {
  deviceId: number;
  from: string;
  to: string;
  totalPoints: number;
  returnedPoints: number;
  distanceKm: number;
  points: PlaybackTrackPoint[];
  events: PlaybackEventMarker[];
  stops: PlaybackStopMarker[];
  timeline: PlaybackTimelineSegment[];
  summary: PlaybackSummary;
  /**
   * THE geometry to draw. Rendering joins these coordinates; it never joins
   * `points`, which are the GPS observations behind them.
   */
  route?: PlaybackRouteRun[];
  matchStatus?: MapMatchStatus;
  matchConfidence?: number;
  matchEngine?: string;
  /** How many raw fixes the backend validator refused, by reason. */
  rejectedPoints?: Record<string, number>;
};
