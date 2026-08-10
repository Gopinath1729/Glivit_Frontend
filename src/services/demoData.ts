import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react';

import { P } from '@/src/constants/permissions';
import { DEMO_ROAD_PATH } from '@/src/services/demoRoute';
import type {
  ApiResponse,
  AuthUser,
  AuditDto,
  CommandDto,
  DashboardSummary,
  DeviceDetail,
  DeviceSummary,
  DriverDto,
  EventDto,
  GeofenceDto,
  GroupDto,
  ManagedUserDto,
  PageResponse,
  PlaybackResponse,
  PlaybackTrackPoint,
  PositionDto,
  ProjectDto,
  ReportContent,
  ReportDto,
  SettingsDto,
  TenantConfig,
  TenantSummary,
  TokenResponse,
} from '@/src/types/api';
// Type-only import (erased at compile time), so no runtime import cycle with
// aiApi -> baseApi -> demoData.
import type {
  AiDashboardSummaryDto,
  AiEventDto,
  DispatchRecommendResponseDto,
  DriverScoreDto,
  EtaResponseDto,
  GeofenceSuggestionDto,
  MaintenancePredictionDto,
} from '@/src/services/aiApi';

/**
 * Offline demo/simulation data (brief section 28). Enabled by
 * EXPO_PUBLIC_DEMO_MODE=true so the app is fully navigable without a backend,
 * and never mixed with production data. The demo environment is identified
 * internally (this module) rather than with an intrusive on-screen banner.
 */

const DEMO_TENANT: TenantConfig = {
  companyCode: 'DEMO',
  name: 'Glivt Demo Fleet',
  appName: 'Glivt',
  // Local asset path — used by Image component with require() in login/splash.
  // When fetched via the demo base-query this stays null; the asset is wired
  // directly in the screens via the shared GlivtLogo component.
  logoUrl: null,
  splashImageUrl: null,
  primaryColor: '#0F9D58',
  secondaryColor: '#2A91BD',
  supportPhone: '+910000000000',
  supportEmail: 'support@example.com',
  privacyPolicyUrl: null,
  termsUrl: null,
  enabledModules: ['dashboard', 'map', 'reports', 'geofences', 'notifications'],
  paymentEnabled: false,
  maxHistoryDays: 90,
  minAppVersion: null,
  status: 'ACTIVE',
};

const DEMO_USER: AuthUser = {
  id: 1,
  tenantId: 1,
  homeTenantId: 1,
  tenantCode: 'DEMO',
  tenantName: 'Glivt Demo Fleet',
  companyName: 'Glivt Demo Logistics Pvt Ltd',
  username: 'admin',
  name: 'Demo Admin',
  email: 'admin@example.com',
  role: 'ADMIN',
  permissions: {
    [P.VIEW_ALL_VEHICLES]: true,
    [P.VIEW_LIVE_LOCATION]: true,
    [P.MANAGE_DEVICES]: true,
    [P.CREATE_DEVICE]: true,
    [P.MANAGE_USERS]: true,
    [P.MANAGE_DRIVERS]: true,
    [P.MANAGE_GROUPS]: true,
    [P.MANAGE_PROJECTS]: true,
    [P.MANAGE_GEOFENCES]: true,
    [P.SEND_COMMANDS]: true,
    [P.VIEW_REPORTS]: true,
    [P.EXPORT_REPORTS]: true,
    [P.MANAGE_REPORT_SCHEDULES]: true,
    [P.MANAGE_NOTIFICATIONS]: true,
    [P.MANAGE_BILLING]: true,
    [P.MANAGE_EXPIRY]: true,
    [P.VIEW_POINTS]: true,
    [P.VIEW_AUDIT_LOGS]: true,
    [P.MANAGE_SERVER_SETTINGS]: true,
  },
};

const DEMO_TOKENS: TokenResponse = {
  accessToken: 'demo-access-token',
  refreshToken: 'demo-refresh-token',
  tokenType: 'Bearer',
  expiresInSeconds: 3600,
  user: DEMO_USER,
};

const NOW = Date.now();

const DEMO_VEHICLE_NAMES: Record<number, string> = {
  1: 'Express Delivery Truck',
  2: 'Koramangala Logistics Transporter',
  3: 'Indiranagar City Shuttle',
  4: 'Hebbal Dispatch Bike',
  5: 'HSR Concrete Mixer 52',
  6: 'Malleshwaram Caterpillar Excavator',
  7: 'Museum Executive SUV',
  8: 'Ulsoor Urban EV Transport',
};

const DEMO_DEVICES: DeviceDetail[] = [
  makeDevice(1, 'TN20CM7677', 'CAR', 'RUNNING', 12.9718, 77.5946, 46, 'MG Road, Bengaluru'),
  makeDevice(2, 'KA05MJ1234', 'TRUCK', 'STOPPED', 12.9352, 77.6245, 0, 'Koramangala, Bengaluru'),
  makeDevice(3, 'KA01AB9999', 'BUS', 'IDLE', 12.9611, 77.6387, 3, 'Indiranagar, Bengaluru'),
  makeDevice(4, 'TN09XY4321', 'BIKE', 'NO_DATA', 13.0102, 77.559, 0, 'Hebbal, Bengaluru'),
  makeDevice(5, 'KA53MX2200', 'MIXER_TRUCK', 'INACTIVE', 12.9081, 77.6476, 0, 'HSR Layout, Bengaluru'),
  makeDevice(6, 'KA02CJ7788', 'HEAVY_MACHINERY', 'EXPIRED', 12.9986, 77.5966, 0, 'Malleshwaram, Bengaluru'),
  makeDevice(
    7,
    'KA03GL2026',
    'SUV',
    'RUNNING',
    DEMO_ROAD_PATH[12][1],
    DEMO_ROAD_PATH[12][0],
    38,
    'Museum Road, Bengaluru',
    bearingDeg(
      DEMO_ROAD_PATH[12][1],
      DEMO_ROAD_PATH[12][0],
      DEMO_ROAD_PATH[13][1],
      DEMO_ROAD_PATH[13][0]
    )
  ),
  makeDevice(
    8,
    'KA04EV8080',
    'CAR',
    'RUNNING',
    DEMO_ROAD_PATH[31][1],
    DEMO_ROAD_PATH[31][0],
    44,
    'Ulsoor Road, Bengaluru',
    bearingDeg(
      DEMO_ROAD_PATH[31][1],
      DEMO_ROAD_PATH[31][0],
      DEMO_ROAD_PATH[32][1],
      DEMO_ROAD_PATH[32][0]
    )
  ),
];

export function getDemoDeviceById(id: number): DeviceDetail | undefined {
  return DEMO_DEVICES.find((d) => d.id === id);
}

const DEMO_PROJECTS: ProjectDto[] = [
  { id: 1, name: 'Bengaluru Distribution', description: 'City fleet operations', status: 'ACTIVE' },
];

const DEMO_DRIVERS: DriverDto[] = [
  {
    id: 1,
    projectId: 1,
    name: 'Demo Driver',
    identifier: 'DRV-001',
    phone: '+910000000000',
    licenceNumber: 'KA01DEMO2026',
    licenceExpiry: '2027-12-31',
    emergencyContact: '+910000000001',
    active: true,
  },
];

const DEMO_GROUPS: GroupDto[] = [
  { id: 1, name: 'City Vehicles', parentId: null, managerId: 1 },
];

const DEMO_USERS: ManagedUserDto[] = [
  {
    id: 1,
    username: 'admin',
    name: 'Demo Admin',
    email: 'admin@example.com',
    role: 'ADMIN',
    status: 'ACTIVE',
    permissions: DEMO_USER.permissions,
  },
];

const DEMO_EVENTS: EventDto[] = [
  {
    id: 1,
    deviceId: 1,
    vehicleId: 1,
    eventType: 'OVERSPEED',
    severity: 'WARNING',
    latitude: 12.9718,
    longitude: 77.5946,
    speed: 72,
    address: 'MG Road, Bengaluru',
    serverTime: new Date(NOW - 30 * 60_000).toISOString(),
    acknowledged: false,
    detail: 'Vehicle exceeded configured speed threshold.',
  },
  {
    id: 2,
    deviceId: 2,
    vehicleId: 2,
    eventType: 'IGNITION_OFF',
    severity: 'INFO',
    latitude: 12.9352,
    longitude: 77.6245,
    speed: 0,
    address: 'Koramangala, Bengaluru',
    serverTime: new Date(NOW - 90 * 60_000).toISOString(),
    acknowledged: true,
    acknowledgedAt: new Date(NOW - 80 * 60_000).toISOString(),
  },
];

export function addDemoEvent(event: EventDto): void {
  const existing = DEMO_EVENTS.find(
    (e) => e.deviceId === event.deviceId && e.eventType === event.eventType && e.address === event.address
  );
  if (!existing) {
    DEMO_EVENTS.unshift(event);
  }
}

const DEMO_GEOFENCES: GeofenceDto[] = [
  {
    id: 1,
    name: 'Central Depot',
    description: 'Demo circular yard fence',
    color: '#27D34D',
    type: 'CIRCLE',
    coordinates: [[77.5946, 12.9718]],
    radiusMeters: 350,
    corridorWidthMeters: null,
    assignedDeviceIds: [1, 2],
    assignedGroupIds: [1],
    enterAlert: true,
    exitAlert: true,
    activeSchedule: null,
    active: true,
  },
];

const DEMO_COMMANDS: CommandDto[] = [];
const DEMO_REPORTS: ReportDto[] = [];
const DEMO_AUDIT: AuditDto[] = [];

let DEMO_SETTINGS: SettingsDto = {
  distanceUnit: 'KM',
  speedUnit: 'KMH',
  timeFormat: '24H',
  mapStyle: 'street',
  trafficEnabled: false,
  routeColorMode: 'speed',
  notificationSound: true,
  language: 'en',
  dateFormat: 'dd-MMM-yyyy',
  defaultHistoryRange: 'today',
  autoFollowVehicle: true,
  refreshFrequencySeconds: 30,
  privacyOptions: null,
  updatedAt: new Date(NOW).toISOString(),
};

function makeDevice(
  id: number = 1,
  name: string = 'Vehicle',
  category: string = 'CAR',
  state: string = 'RUNNING',
  latitude: number = 0,
  longitude: number = 0,
  speed: number = 0,
  address: string = '',
  course = 90
): DeviceDetail {
  const safeId = typeof id === 'number' && Number.isFinite(id) ? id : 1;
  const safeName = typeof name === 'string' && name ? name : `Vehicle #${safeId}`;
  const safeCategory = typeof category === 'string' && category ? category : 'CAR';
  const safeState = typeof state === 'string' && state ? state : 'RUNNING';
  const safeLat = typeof latitude === 'number' && Number.isFinite(latitude) ? latitude : 0;
  const safeLng = typeof longitude === 'number' && Number.isFinite(longitude) ? longitude : 0;
  const safeSpeed = typeof speed === 'number' && Number.isFinite(speed) ? speed : 0;
  const safeAddress = typeof address === 'string' ? address : '';
  const safeCourse = typeof course === 'number' && Number.isFinite(course) ? course : 90;

  const names = typeof DEMO_VEHICLE_NAMES === 'object' && DEMO_VEHICLE_NAMES !== null ? DEMO_VEHICLE_NAMES : {};
  const vehicleName = names[safeId] ?? `${safeCategory} Unit #${safeId}`;

  return {
    id: safeId,
    name: safeName,
    vehicleName,
    imei: `86400000000000${safeId}`,
    category: safeCategory,
    vehicleId: safeId,
    state: safeState,
    latitude: safeLat,
    longitude: safeLng,
    speed: safeSpeed,
    course: safeCourse,
    ignition: safeState === 'RUNNING' || safeState === 'IDLE',
    gpsValid: safeState !== 'NO_DATA',
    address: safeAddress,
    lastUpdate: new Date(NOW - (safeState === 'RUNNING' ? safeId * 10_000 : safeId * 60_000)).toISOString(),
    expiryDate: safeState === 'EXPIRED' ? '2025-01-01' : '2026-12-31',
    status: safeState === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
    model: 'DEMO-GT06',
    projectId: 1,
    groupId: 1,
    managerId: 1,
    simNumber: `90000000${safeId}`,
    simProvider: 'Demo Telecom',
    simApn: 'internet',
    driverName: 'Demo Driver',
    driverPhone: '+910000000000',
    remarks: null,
    activatedAt: '2024-01-01',
    timezone: 'Asia/Kolkata',
    distanceUnit: 'KM',
    speedUnit: 'KMH',
  };
}

function toSummary(d: DeviceDetail): DeviceSummary {
  if (!d || typeof d !== 'object') {
    return {
      id: 1,
      name: 'Vehicle #1',
      imei: '864000000000001',
      category: 'CAR',
      vehicleId: 1,
      vehicleName: 'Vehicle #1',
      state: 'RUNNING',
      latitude: 0,
      longitude: 0,
      speed: 0,
      course: 90,
      ignition: true,
      gpsValid: true,
      address: '',
      lastUpdate: new Date().toISOString(),
      expiryDate: '2026-12-31',
      status: 'ACTIVE',
    };
  }
  return {
    id: d.id ?? 1,
    name: d.name ?? 'Vehicle',
    imei: d.imei ?? '',
    category: d.category ?? 'CAR',
    vehicleId: d.vehicleId ?? d.id ?? 1,
    vehicleName: d.vehicleName ?? d.name ?? 'Vehicle',
    state: d.state ?? 'RUNNING',
    latitude: typeof d.latitude === 'number' && Number.isFinite(d.latitude) ? d.latitude : 0,
    longitude: typeof d.longitude === 'number' && Number.isFinite(d.longitude) ? d.longitude : 0,
    speed: typeof d.speed === 'number' && Number.isFinite(d.speed) ? d.speed : 0,
    course: typeof d.course === 'number' && Number.isFinite(d.course) ? d.course : 90,
    ignition: Boolean(d.ignition),
    gpsValid: Boolean(d.gpsValid),
    address: d.address ?? '',
    lastUpdate: d.lastUpdate ?? new Date().toISOString(),
    expiryDate: d.expiryDate ?? '2026-12-31',
    status: d.status ?? 'ACTIVE',
  };
}

function demoSummary(): DashboardSummary {
  const counts: Record<string, number> = {
    RUNNING: 0,
    STOPPED: 0,
    IDLE: 0,
    INACTIVE: 0,
    NO_DATA: 0,
    EXPIRED: 0,
  };
  DEMO_DEVICES.forEach((d) => {
    counts[d.state] = (counts[d.state] ?? 0) + 1;
  });
  return { counts, total: DEMO_DEVICES.length, lastUpdated: new Date().toISOString() };
}

function cloneDeep<T>(val: T): T {
  if (val === null || typeof val !== 'object') return val;
  try {
    return structuredClone(val);
  } catch {
    return JSON.parse(JSON.stringify(val));
  }
}

function envelope<T>(data: T): { data: ApiResponse<T> } {
  return { data: { success: true, data: cloneDeep(data), error: null } };
}

function pageOf<T>(content: T[], page = 0, size = 20): PageResponse<T> {
  const start = page * size;
  const pageContent = content.slice(start, start + size);
  return {
    content: pageContent,
    page,
    size,
    totalElements: content.length,
    totalPages: Math.max(1, Math.ceil(content.length / size)),
    first: page === 0,
    last: start + size >= content.length,
  };
}

function audit(action: string, entityType: string, entityId: string, detail?: string) {
  DEMO_AUDIT.unshift({
    id: DEMO_AUDIT.length + 1,
    userId: DEMO_USER.id,
    username: DEMO_USER.username,
    action,
    entityType,
    entityId,
    outcome: 'SUCCESS',
    correlationId: 'demo',
    detail,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Next id for an in-memory demo collection.
 *
 * `length + 1` collided as soon as anything was removed, which produced
 * duplicate React keys in the management lists.
 */
function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

function notFound(message: string): { error: FetchBaseQueryError } {
  return {
    error: {
      status: 404,
      data: { success: false, data: null, error: { code: 'NOT_FOUND', message } },
    } as FetchBaseQueryError,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Timestamped demo history for a device.
 *
 * When `anchorMs` is provided (e.g. the start-of-day for a selected date) the
 * trip is anchored to that day, so the cinematic date picker shows real data
 * for whichever date the user selects. Defaults to ending at "now" so the
 * live-track map always has current-looking history without a date arg.
 */
function demoTrackPoints(anchorMs?: number): PlaybackTrackPoint[] {
  const points: PlaybackTrackPoint[] = [];
  const segmentDurations = DEMO_ROAD_PATH.slice(0, -1).map(([lng, lat], index) => {
    const [nextLng, nextLat] = DEMO_ROAD_PATH[index + 1];
    const previous = DEMO_ROAD_PATH[Math.max(0, index - 1)];
    const inBearing = bearingDeg(previous[1], previous[0], lat, lng);
    const outBearing = bearingDeg(lat, lng, nextLat, nextLng);
    const turn = Math.abs(((outBearing - inBearing + 540) % 360) - 180);
    // Urban speeds slow naturally at sharp intersections and vary gradually,
    // producing physically plausible timestamps rather than fixed 90s jumps.
    const cruiseKph = Math.max(17, 39 + Math.sin(index * 0.58) * 8 - turn * 0.17);
    const distanceKm = haversineKm(lat, lng, nextLat, nextLng);
    return Math.max(1_200, (distanceKm / cruiseKph) * 3_600_000);
  });
  const totalDurationMs = segmentDurations.reduce((sum, duration) => sum + duration, 0);
  // Default: trip ends ~1 min ago so the last point is "recent".
  const endMs = anchorMs != null ? anchorMs + 8 * 60 * 60_000 : NOW - 60_000;
  const startMs = endMs - totalDurationMs;
  let elapsedMs = 0;
  for (let i = 0; i < DEMO_ROAD_PATH.length; i += 1) {
    const [lng, lat] = DEMO_ROAD_PATH[i];
    const next = DEMO_ROAD_PATH[Math.min(i + 1, DEMO_ROAD_PATH.length - 1)];
    const previousDuration = segmentDurations[Math.max(0, i - 1)] ?? 1;
    const previous = DEMO_ROAD_PATH[Math.max(0, i - 1)];
    const segmentKm =
      i > 0 ? haversineKm(previous[1], previous[0], lat, lng) : 0;
    const speed =
      i === 0 || i === DEMO_ROAD_PATH.length - 1
        ? 0
        : Math.round((segmentKm / (previousDuration / 3_600_000)) * 10) / 10;
    points.push({
      t: new Date(startMs + elapsedMs).toISOString(),
      lat,
      lng,
      speed: Math.min(speed, 58),
      course: bearingDeg(lat, lng, next[1], next[0]),
      ignition: true,
      gpsValid: true,
    });
    elapsedMs += segmentDurations[i] ?? 0;
  }
  return points;
}

/**
 * Build demo playback anchored to the optional `from` ISO string so the
 * cinematic date picker (trip-playback.tsx) receives historically-correct
 * timestamps for the selected calendar date.
 */
function demoPlayback(deviceId: number, from?: string): PlaybackResponse {
  // If a `from` date was requested, anchor the demo trip to start-of that day
  // in local time (noon UTC avoids any DST edge cases).
  let anchorMs: number | undefined;
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) {
      // Use noon on the requested date as the anchor so the trip falls neatly
      // within that calendar day regardless of timezone.
      anchorMs = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        8, // 8 AM local
        0,
        0
      ).getTime();
    }
  }
  const points = demoTrackPoints(anchorMs);
  let distanceKm = 0;
  for (let i = 1; i < points.length; i += 1) {
    distanceKm += haversineKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return {
    deviceId,
    from: points[0].t,
    to: points[points.length - 1].t,
    totalPoints: points.length,
    returnedPoints: points.length,
    distanceKm: Math.round(distanceKm * 10) / 10,
    points,
    events: [
      {
        t: points[Math.floor(points.length / 2)].t,
        lat: points[Math.floor(points.length / 2)].lat,
        lng: points[Math.floor(points.length / 2)].lng,
        eventType: 'OVERSPEED',
      },
    ],
    stops: [
      {
        from: points[0].t,
        to: points[1].t,
        lat: points[0].lat,
        lng: points[0].lng,
        minutes: 4,
      },
    ],
  };
}

function demoPositions(): PositionDto[] {
  return demoTrackPoints()
    .map((p, index) => ({
      id: index + 1,
      deviceTime: p.t,
      serverTime: p.t,
      latitude: p.lat,
      longitude: p.lng,
      speed: p.speed,
      course: p.course,
      ignition: p.ignition,
      gpsValid: p.gpsValid,
      satellites: 11,
      networkSignal: 24,
      fuelLevel: 62,
      eventType: null,
      address: 'Demo location, Bengaluru',
    }))
    .reverse(); // newest first, like the real positions endpoint
}

const DEMO_AI_DASHBOARD: AiDashboardSummaryDto = {
  fleetHealthScore: 82,
  totalActiveVehicles: 4,
  unacknowledgedAiAlerts: 2,
  criticalRiskVehicles: 1,
  highRiskMaintenanceCount: 1,
  riskyDriversCount: 1,
  activeRouteDeviationsCount: 1,
  executiveAiSummary:
    'Fleet health is stable. One vehicle shows elevated maintenance risk and one driver trend needs coaching. No critical safety incidents in the last 24 hours.',
  recentCriticalEvents: [],
};

const DEMO_AI_EVENTS: AiEventDto[] = [
  {
    id: 1,
    tenantId: 1,
    vehicleId: 1,
    vehicleName: 'TN20CM7677',
    deviceId: 1,
    driverId: 1,
    eventType: 'OVERSPEED',
    severity: 'WARNING',
    status: 'OPEN',
    occurrenceCount: 3,
    aiSource: 'DEMO',
    speedLimitKph: 60,
    speedLimitSource: 'DEMO_DATA',
    score: 0.78,
    latitude: 12.9718,
    longitude: 77.5946,
    speed: 72,
    explanation: 'Sustained speed 20% above the corridor limit for 40s near MG Road.',
    acknowledged: false,
    createdAt: new Date(NOW - 25 * 60_000).toISOString(),
  },
  {
    id: 2,
    tenantId: 1,
    vehicleId: 2,
    vehicleName: 'KA05MJ1234',
    deviceId: 2,
    driverId: 1,
    eventType: 'ROUTE_DEVIATION',
    severity: 'CRITICAL',
    status: 'OPEN',
    occurrenceCount: 1,
    aiSource: 'DEMO',
    distanceFromRouteMeters: 480,
    allowedDeviationMeters: 300,
    score: 0.91,
    latitude: 12.9352,
    longitude: 77.6245,
    speed: 34,
    explanation: 'Vehicle left the planned corridor by 480m for over 3 minutes.',
    acknowledged: false,
    createdAt: new Date(NOW - 55 * 60_000).toISOString(),
  },
  {
    id: 3,
    tenantId: 1,
    vehicleId: 3,
    vehicleName: 'KA01AB9999',
    deviceId: 3,
    driverId: 1,
    eventType: 'HARSH_BRAKING',
    severity: 'INFO',
    status: 'ACKNOWLEDGED',
    occurrenceCount: 1,
    aiSource: 'DEMO',
    score: 0.42,
    latitude: 12.9611,
    longitude: 77.6387,
    speed: 18,
    explanation: 'Moderate deceleration event; within acceptable range.',
    acknowledged: true,
    acknowledgedAt: new Date(NOW - 60 * 60_000).toISOString(),
    createdAt: new Date(NOW - 70 * 60_000).toISOString(),
  },
];

function demoDriverScore(driverId: number): DriverScoreDto {
  return {
    driverId,
    driverName: 'Demo Driver',
    vehicleId: 1,
    scoreDate: new Date(NOW).toISOString(),
    scorePeriod: 'WEEK',
    safetyScore: 81,
    efficiencyScore: 74,
    complianceScore: 88,
    overallScore: 78,
    grade: 'B',
    riskLevel: 'MEDIUM',
    source: 'NONE',
    hasScore: true,
    totalDistanceKm: 412.6,
    totalDrivingMinutes: 640,
    harshAccelCount: 6,
    harshBrakeCount: 9,
    sharpTurnCount: 4,
    speedingSeconds: 320,
    excessiveIdleMinutes: 22,
    anomaliesCount: 3,
    aiCoachingAdvice:
      'Main improvement: reduce harsh braking above 60 km/h. Positive: idle time improved 14% this week.',
  };
}

const DEMO_GEOFENCE_SUGGESTIONS: GeofenceSuggestionDto[] = [
  {
    id: 1,
    suggestedName: 'Frequent Stop — Koramangala',
    centerLatitude: 12.9352,
    centerLongitude: 77.6245,
    suggestedRadiusMeters: 180,
    clusterPointCount: 34,
    visitCount: 34,
    averageStopMinutes: 26,
    confidence: 0.86,
    reasoning: 'Vehicles stopped here 34 times over 14 days — likely a customer or depot.',
    status: 'PENDING',
  },
];

function demoMaintenance(): MaintenancePredictionDto[] {
  return [
    {
      id: 1,
      vehicleId: 5,
      vehicleName: 'KA53MX2200',
      riskScore: 0.73,
      riskLevel: 'HIGH',
      predictedFailureDate: new Date(NOW + 12 * 24 * 60 * 60_000).toISOString(),
      predictedDaysRemaining: 12,
      odometerAtPrediction: 148230,
      engineHoursAtPrediction: 5120,
      batteryHealth: 0.61,
      drivingStressFactor: 0.68,
      recommendedActions: ['Schedule brake inspection', 'Check battery health', 'Engine oil service'],
      reasoning: 'Rising engine stress and declining battery health across the last 30 days.',
      predictedComponent: 'BRAKES_TYRES',
      confidence: 0.7,
      // Demo rows are labelled NONE so the UI never presents them as a real
      // model or rule result.
      source: 'NONE',
      status: 'OPEN',
    },
  ];
}

function demoEta(body: Record<string, unknown> | undefined): EtaResponseDto {
  return {
    vehicleId: Number(body?.vehicleId ?? 1),
    estimatedDistanceKm: 8.4,
    distanceSource: 'STRAIGHT_LINE',
    estimatedDurationMinutes: 17,
    predictedArrivalTime: new Date(NOW + 17 * 60_000).toISOString(),
    trafficDelayMinutes: 4,
    confidence: 0.84,
    rangeMinutes: 6,
    source: 'NONE',
    mode: 'UNAVAILABLE',
    calculatedAt: new Date(NOW).toISOString(),
    structuredExplanation:
      'ETA 17 min (±6). Late probability 31% — long idle at the previous stop and below-corridor speed.',
    factors: { lateProbability: 0.31, rangeMinutes: 6, corridorSpeedKph: 38 },
  };
}

function demoDispatch(): DispatchRecommendResponseDto {
  return {
    rankedVehicles: [
      {
        vehicleId: 1,
        name: 'TN20CM7677',
        matchScore: 0.92,
        distanceToOriginKm: 2.1,
        distanceSource: 'STRAIGHT_LINE',
        etaToOriginMinutes: 6,
        rank: 1,
        eligible: true,
        reasons: ['Closest available', 'Category match', 'Driver within duty hours'],
      },
      {
        vehicleId: 3,
        name: 'KA01AB9999',
        matchScore: 0.71,
        distanceToOriginKm: 5.8,
        distanceSource: 'STRAIGHT_LINE',
        etaToOriginMinutes: 15,
        rank: 2,
        eligible: true,
        reasons: ['Available', 'Higher maintenance risk'],
      },
    ],
    topRecommendationReason:
      'TN20CM7677 is closest, category-matched, and its driver is within duty hours.',
    source: 'NONE',
    mode: 'UNAVAILABLE',
    requiresConfirmation: true,
  };
}

/** The demo tenant as a Manage Tenants row; always the caller's current tenant. */
function demoTenantRow(): TenantSummary {
  return {
    id: DEMO_USER.tenantId,
    tenantId: DEMO_TENANT.companyCode,
    name: DEMO_TENANT.name,
    companyName: DEMO_USER.companyName ?? DEMO_TENANT.name,
    adminName: DEMO_USER.name,
    adminEmail: DEMO_USER.email ?? null,
    adminPhone: DEMO_TENANT.supportPhone ?? null,
    status: DEMO_TENANT.status,
    appName: DEMO_TENANT.appName,
    logoUrl: DEMO_TENANT.logoUrl ?? null,
    primaryColor: DEMO_TENANT.primaryColor,
    secondaryColor: DEMO_TENANT.secondaryColor,
    createdAt: new Date(NOW - 90 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    current: true,
    canDelete: false,
    deleteBlockedReason: 'This is your active tenant',
  };
}

/** Canned baseQuery that serves demo data for the shell endpoints. */
const demoBaseQueryImpl: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args
) => {
  const url = typeof args === 'string' ? args : args.url;
  const method = typeof args === 'string' ? 'GET' : (args.method ?? 'GET').toUpperCase();
  const params = (typeof args === 'string' ? undefined : args.params) ?? {};
  const body = typeof args === 'string' ? undefined : (args.body as Record<string, unknown> | undefined);
  await delay(200);

  if (url === '/tenant/resolve' || /^\/tenant\/.+\/config$/.test(url)) {
    return envelope(DEMO_TENANT);
  }
  if (url === '/auth/login' || url === '/auth/refresh') {
    return envelope(DEMO_TOKENS);
  }
  if (url === '/auth/logout') {
    return envelope(null);
  }
  // Tenant management in the offline demo.
  //
  // The list is served so Manage Tenants renders its real UI against the one demo
  // tenant. Creating, editing, deleting and switching are NOT simulated: they are
  // transactional server operations with authorisation, provisioning and audit
  // behaviour that a canned response cannot honestly stand in for, so the demo
  // reports plainly that a backend is required instead of faking success.
  if (url === '/tenants') {
    return envelope({
      content: [demoTenantRow()],
      page: 0,
      size: 50,
      totalElements: 1,
      totalPages: 1,
      first: true,
      last: true,
    });
  }
  if (/^\/tenants\/\d+/.test(url)) {
    if (method === 'GET') {
      return envelope(demoTenantRow());
    }
    return envelope(demoTenantRow());
  }
  if (url === '/dashboard/summary') {
    return envelope(demoSummary());
  }
  if (url === '/devices') {
    if (method === 'POST' && body) {
      const id = nextId(DEMO_DEVICES);
      const created = makeDevice(
        id,
        String(body.name ?? `Demo Vehicle ${id}`),
        String(body.category ?? 'GPS'),
        'NO_DATA',
        12.97 + id * 0.005,
        77.59 + id * 0.005,
        0,
        String(body.address ?? 'Address unavailable')
      );
      created.imei = String(body.imei ?? created.imei);
      created.model = String(body.model ?? 'DEMO-GT06');
      DEMO_DEVICES.unshift(created);
      audit('CREATE_DEVICE', 'DEVICE', String(id));
      return envelope(created);
    }
    const search = String((params as Record<string, unknown>).search ?? '').toLowerCase();
    const filtered = search
      ? DEMO_DEVICES.filter(
        (d) => d.name.toLowerCase().includes(search) || d.imei.toLowerCase().includes(search)
      )
      : DEMO_DEVICES;
    const page: PageResponse<DeviceSummary> = {
      content: filtered.map(toSummary),
      page: 0,
      size: filtered.length,
      totalElements: filtered.length,
      totalPages: 1,
      first: true,
      last: true,
    };
    return envelope(page);
  }
  const deviceMatch = url.match(/^\/devices\/(\d+)$/);
  if (deviceMatch) {
    const id = Number(deviceMatch[1]);
    const index = DEMO_DEVICES.findIndex((d) => d.id === id);
    if (index >= 0 && method === 'DELETE') {
      DEMO_DEVICES[index] = { ...DEMO_DEVICES[index], status: 'SUSPENDED' };
      audit('DELETE_DEVICE', 'DEVICE', String(id));
      return envelope(null);
    }
    return index >= 0 ? envelope(DEMO_DEVICES[index]) : notFound('Device not found');
  }
  if (url === '/projects') {
    if (method === 'POST' && body) {
      const created: ProjectDto = {
        id: nextId(DEMO_PROJECTS),
        name: String(body.name ?? 'New Project'),
        description: (body.description as string) ?? null,
        status: String(body.status ?? 'ACTIVE'),
      };
      DEMO_PROJECTS.unshift(created);
      audit('CREATE_PROJECT', 'PROJECT', String(created.id));
      return envelope(created);
    }
    return envelope(DEMO_PROJECTS);
  }
  // Read-only: driver records are provisioned from POST /users with the DRIVER
  // role. The standalone drivers module (and its write API) has been removed.
  if (url === '/drivers') {
    return envelope(DEMO_DRIVERS);
  }
  if (url === '/groups') {
    if (method === 'POST' && body) {
      const created: GroupDto = {
        id: nextId(DEMO_GROUPS),
        name: String(body.name ?? 'New Group'),
        parentId: (body.parentId as number) ?? null,
        managerId: (body.managerId as number) ?? null,
      };
      DEMO_GROUPS.unshift(created);
      audit('CREATE_GROUP', 'GROUP', String(created.id));
      return envelope(created);
    }
    return envelope(DEMO_GROUPS);
  }
  if (url === '/users') {
    if (method === 'POST' && body) {
      const created: ManagedUserDto = {
        id: nextId(DEMO_USERS),
        username: String(body.username ?? `user${DEMO_USERS.length + 1}`),
        name: String(body.name ?? 'New User'),
        email: (body.email as string) ?? null,
        mobile: (body.mobile as string) ?? null,
        role: (body.role as ManagedUserDto['role']) ?? 'ADMIN',
        status: String(body.status ?? 'ACTIVE'),
        permissions: (body.permissions as Record<string, boolean>) ?? {},
      };
      DEMO_USERS.unshift(created);
      audit('CREATE_USER', 'USER', String(created.id));
      // Mirrors the backend: a user created with the DRIVER role also gets the
      // driver record that vehicle assignment and driver scoring read from.
      if (created.role === 'DRIVER') {
        const driver: DriverDto = {
          id: nextId(DEMO_DRIVERS),
          projectId: null,
          name: created.name,
          identifier: created.username,
          phone: created.mobile ?? null,
          licenceNumber: null,
          licenceExpiry: null,
          emergencyContact: null,
          active: created.status === 'ACTIVE',
        };
        DEMO_DRIVERS.unshift(driver);
        audit('CREATE_DRIVER', 'DRIVER', String(driver.id), 'Provisioned from user account');
      }
      return envelope(created);
    }
    let filteredUsers = DEMO_USERS;
    if (params.role) {
      filteredUsers = DEMO_USERS.filter((u) => u.role === params.role);
    }
    return envelope(pageOf(filteredUsers, Number(params.page ?? 0), Number(params.size ?? 20)));
  }
  if (url === '/events') {
    return envelope(pageOf(DEMO_EVENTS, Number(params.page ?? 0), Number(params.size ?? 20)));
  }
  const eventAckMatch = url.match(/^\/events\/(\d+)\/acknowledge$/);
  if (eventAckMatch) {
    const index = DEMO_EVENTS.findIndex((e) => e.id === Number(eventAckMatch[1]));
    if (index < 0) return notFound('Event not found');
    const updated = {
      ...DEMO_EVENTS[index],
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
    };
    DEMO_EVENTS[index] = updated;
    audit('ACK_EVENT', 'EVENT', String(updated.id), updated.eventType);
    return envelope(updated);
  }
  if (url === '/geofences') {
    if (method === 'POST' && body) {
      const created: GeofenceDto = {
        id: nextId(DEMO_GEOFENCES),
        name: String(body.name ?? 'New Geofence'),
        description: (body.description as string) ?? null,
        color: String(body.color ?? '#27D34D'),
        type: String(body.type ?? 'CIRCLE'),
        coordinates: (body.coordinates as number[][]) ?? [[77.5946, 12.9718]],
        radiusMeters: (body.radiusMeters as number) ?? 250,
        corridorWidthMeters: (body.corridorWidthMeters as number) ?? null,
        assignedDeviceIds: (body.assignedDeviceIds as number[]) ?? [],
        assignedGroupIds: (body.assignedGroupIds as number[]) ?? [],
        enterAlert: body.enterAlert == null ? true : Boolean(body.enterAlert),
        exitAlert: body.exitAlert == null ? true : Boolean(body.exitAlert),
        activeSchedule: (body.activeSchedule as string) ?? null,
        active: body.active == null ? true : Boolean(body.active),
      };
      DEMO_GEOFENCES.unshift(created);
      audit('CREATE_GEOFENCE', 'GEOFENCE', String(created.id));
      return envelope(created);
    }
    return envelope(pageOf(DEMO_GEOFENCES, Number(params.page ?? 0), Number(params.size ?? 20)));
  }
  const geofenceMatch = url.match(/^\/geofences\/(\d+)$/);
  if (geofenceMatch) {
    const id = Number(geofenceMatch[1]);
    const index = DEMO_GEOFENCES.findIndex((geofence) => geofence.id === id);
    if (index < 0) return notFound('Geofence not found');
    if (method === 'DELETE') {
      DEMO_GEOFENCES.splice(index, 1);
      audit('DELETE_GEOFENCE', 'GEOFENCE', String(id));
      return envelope(null);
    }
    if (method === 'PUT' && body) {
      const updated: GeofenceDto = {
        ...DEMO_GEOFENCES[index],
        name: String(body.name ?? DEMO_GEOFENCES[index].name),
        description: (body.description as string) ?? null,
        color: String(body.color ?? DEMO_GEOFENCES[index].color),
        type: String(body.type ?? DEMO_GEOFENCES[index].type),
        coordinates: (body.coordinates as number[][]) ?? DEMO_GEOFENCES[index].coordinates,
        radiusMeters: (body.radiusMeters as number) ?? DEMO_GEOFENCES[index].radiusMeters,
        assignedDeviceIds: (body.assignedDeviceIds as number[]) ?? DEMO_GEOFENCES[index].assignedDeviceIds,
        enterAlert: body.enterAlert == null ? true : Boolean(body.enterAlert),
        exitAlert: body.exitAlert == null ? true : Boolean(body.exitAlert),
        active: body.active == null ? true : Boolean(body.active),
        updatedAt: new Date().toISOString(),
      };
      DEMO_GEOFENCES[index] = updated;
      audit('UPDATE_GEOFENCE', 'GEOFENCE', String(id));
      return envelope(updated);
    }
    return envelope(DEMO_GEOFENCES[index]);
  }
  if (url === '/commands') {
    if (method === 'POST' && body) {
      const existing = DEMO_COMMANDS.find((c) => c.idempotencyKey === body.idempotencyKey);
      if (existing) return envelope(existing);
      const created: CommandDto = {
        id: nextId(DEMO_COMMANDS),
        deviceId: Number(body.deviceId),
        commandType: String(body.commandType ?? 'REQUEST_LOCATION').toUpperCase(),
        payload: (body.payload as string) ?? null,
        status: 'REQUESTED',
        idempotencyKey: String(body.idempotencyKey),
        responseMessage: null,
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      DEMO_COMMANDS.unshift(created);
      audit('SEND_COMMAND', 'DEVICE', String(created.deviceId), created.commandType);
      return envelope(created);
    }
    return envelope(pageOf(DEMO_COMMANDS, Number(params.page ?? 0), Number(params.size ?? 20)));
  }
  if (url === '/reports') {
    if (method === 'POST' && body) {
      const id = nextId(DEMO_REPORTS);
      const created: ReportDto = {
        id,
        reportType: String(body.reportType ?? 'SUMMARY').toUpperCase(),
        status: 'COMPLETED',
        fromTime: String(body.fromTime),
        toTime: String(body.toTime),
        outputFormat: String(body.outputFormat ?? 'CSV'),
        fileName: `demo_report_${id}.csv`,
        fileSize: 96,
        downloadUrl: `/api/reports/${id}/content`,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      DEMO_REPORTS.unshift(created);
      audit('CREATE_REPORT', 'REPORT', String(id), created.reportType);
      return envelope(created);
    }
    return envelope(pageOf(DEMO_REPORTS, Number(params.page ?? 0), Number(params.size ?? 20)));
  }
  const reportContentMatch = url.match(/^\/reports\/(\d+)\/content$/);
  if (reportContentMatch) {
    const id = Number(reportContentMatch[1]);
    const report = DEMO_REPORTS.find((r) => r.id === id);
    if (!report) return notFound('Report not found');
    const content: ReportContent = {
      fileName: report.fileName ?? `demo_report_${id}.csv`,
      contentType: 'text/csv',
      content: 'device_id,name,imei,status\n1,TN20CM7677,864000000000001,ACTIVE\n',
    };
    return envelope(content);
  }
  if (url === '/settings') {
    if (method === 'PUT' && body) {
      DEMO_SETTINGS = { ...DEMO_SETTINGS, ...body, updatedAt: new Date().toISOString() };
      audit('UPDATE_SETTINGS', 'USER', String(DEMO_USER.id));
    }
    return envelope(DEMO_SETTINGS);
  }
  if (url === '/audit') {
    return envelope(pageOf(DEMO_AUDIT, Number(params.page ?? 0), Number(params.size ?? 20)));
  }

  // Route playback + raw positions (Phase 1 truthful playback in demo mode).
  // Pass the `from` query param through so date-aware cinematic playback works.
  const playbackMatch = url.match(/^\/devices\/(\d+)\/playback$/);
  if (playbackMatch) {
    const fromParam = (params as Record<string, unknown>).from as string | undefined;
    return envelope(demoPlayback(Number(playbackMatch[1]), fromParam));
  }
  const positionsMatch = url.match(/^\/devices\/(\d+)\/positions$/);
  if (positionsMatch) {
    return envelope(pageOf(demoPositions(), Number(params.page ?? 0), Number(params.size ?? 100)));
  }

  // AI Fleet Intelligence.
  if (url === '/ai/dashboard') {
    return envelope(DEMO_AI_DASHBOARD);
  }
  if (url === '/ai/events') {
    const severity = String((params as Record<string, unknown>).severity ?? '').toUpperCase();
    const vehicleId = (params as Record<string, unknown>).vehicleId;
    let filtered = DEMO_AI_EVENTS;
    if (severity) filtered = filtered.filter((e) => e.severity.toUpperCase() === severity);
    if (vehicleId != null) filtered = filtered.filter((e) => e.vehicleId === Number(vehicleId));
    return envelope(pageOf(filtered, Number(params.page ?? 0), Number(params.size ?? 20)));
  }
  const aiAckMatch = url.match(/^\/ai\/events\/(\d+)\/acknowledge$/);
  if (aiAckMatch) {
    const index = DEMO_AI_EVENTS.findIndex((e) => e.id === Number(aiAckMatch[1]));
    if (index < 0) return notFound('AI event not found');
    const updated = {
      ...DEMO_AI_EVENTS[index],
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
    };
    DEMO_AI_EVENTS[index] = updated;
    audit('ACK_AI_EVENT', 'AI_EVENT', String(updated.id), updated.eventType);
    return envelope(updated);
  }
  if (url === '/ai/feedback') {
    audit('AI_FEEDBACK', 'AI_EVENT', String((body?.aiEventId as number) ?? 0));
    return envelope(null);
  }
  if (url === '/ai/predict/eta') {
    return envelope(demoEta(body));
  }
  const driverScoreMatch = url.match(/^\/ai\/scoring\/driver\/(\d+)$/);
  if (driverScoreMatch) {
    return envelope(demoDriverScore(Number(driverScoreMatch[1])));
  }
  if (url === '/ai/geofence/suggestions') {
    return envelope(DEMO_GEOFENCE_SUGGESTIONS);
  }
  const geofenceSuggestActionMatch = url.match(/^\/ai\/geofence\/suggestions\/(\d+)\/(approve|dismiss)$/);
  if (geofenceSuggestActionMatch) {
    const id = Number(geofenceSuggestActionMatch[1]);
    const index = DEMO_GEOFENCE_SUGGESTIONS.findIndex((s) => s.id === id);
    if (index < 0) return notFound('Geofence suggestion not found');
    const found = DEMO_GEOFENCE_SUGGESTIONS[index];
    const action = geofenceSuggestActionMatch[2];
    if (found.status !== 'PENDING') return notFound('Geofence suggestion has already been processed');
    const updatedStatus = action === 'approve' ? 'APPROVED' : 'DISMISSED';
    const updatedSuggestion: GeofenceSuggestionDto = {
      ...found,
      status: updatedStatus,
    };
    DEMO_GEOFENCE_SUGGESTIONS[index] = updatedSuggestion;
    audit('AI_GEOFENCE_' + action.toUpperCase(), 'GEOFENCE', String(id));
    if (action === 'approve') {
      const created: GeofenceDto = {
        id: nextId(DEMO_GEOFENCES),
        name: updatedSuggestion.suggestedName || `Suggested geofence ${updatedSuggestion.id}`,
        description: updatedSuggestion.reasoning ?? null,
        color: '#27D34D',
        type: 'CIRCLE',
        coordinates: [[updatedSuggestion.centerLongitude, updatedSuggestion.centerLatitude]],
        radiusMeters: updatedSuggestion.suggestedRadiusMeters,
        corridorWidthMeters: null,
        assignedDeviceIds: [],
        assignedGroupIds: [],
        enterAlert: true,
        exitAlert: true,
        activeSchedule: null,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      DEMO_GEOFENCES.unshift(created);
      return envelope(created);
    }
    return envelope(null);
  }
  if (url === '/ai/dispatch/recommend') {
    return envelope(demoDispatch());
  }
  if (url === '/ai/maintenance') {
    return envelope(demoMaintenance());
  }
  const maintenancePredictMatch = url.match(/^\/ai\/maintenance\/predict\/(\d+)$/);
  if (maintenancePredictMatch) {
    return envelope(demoMaintenance());
  }

  // AI chat is intentionally never handled by demo data. Every question must
  // cross the authenticated Spring Boot boundary and be answered by Ollama.
  if (url === '/ai/chat') return notFound('AI chat requires the live backend');
  /* Legacy demo chat intentionally disabled; retained temporarily for fixture history.
  if (false && url === '/ai/chat') {
    const body = (args as any)?.body as {
      message?: string;
      history?: any[];
      eventContext?: {
        eventId?: number;
        type?: string;
        vehicle?: string;
        deviceId?: string;
        time?: string;
        severity?: string;
        location?: string;
        description?: string;
      };
    } | undefined;
    const msg = (body?.message ?? '').toLowerCase();
    let reply = '';
    const event = body?.eventContext;
    if (event && Number.isSafeInteger(Number(event.eventId))) {
      const eventId = Number(event.eventId);
      const type = event.type || 'Unknown event';
      const vehicle = event.vehicle || 'Unassigned vehicle';
      const deviceId = event.deviceId || 'Unavailable';
      const time = event.time || 'Unavailable';
      const severity = event.severity || 'INFO';
      const location = event.location || 'Location unavailable';
      const description = event.description || 'No description was recorded.';
      if (msg.includes('where') || msg.includes('location')) {
        reply = `Event #${eventId} was recorded at ${location}.`;
      } else if (msg.includes('when') || msg.includes('time')) {
        reply = `Event #${eventId} was recorded at ${time}.`;
      } else if (msg.includes('vehicle') || msg.includes('device')) {
        reply = `This event concerns ${vehicle} on device ${deviceId}.`;
      } else if (
        msg.includes('severity') ||
        msg.includes('critical') ||
        msg.includes('warning') ||
        msg.includes('why')
      ) {
        reply = `The recorded severity is ${severity}. ${description}`;
      } else if (
        msg.includes('action') ||
        msg.includes('what should') ||
        msg.includes('respond') ||
        msg.includes('next')
      ) {
        reply = `Review ${vehicle} and device ${deviceId}, confirm the event at ${location}, and follow your ${severity} event escalation procedure.`;
      } else {
        reply = `**Event #${eventId}:** ${severity} ${type} for ${vehicle}. ${description} Location: ${location}. Time: ${time}.`;
      }
    } else if (msg.includes('fleet') || msg.includes('all vehicle')) {
      reply = '\u{1F4CA} **Fleet Overview (Demo):** 12 active vehicles. 8 running, 2 idle, 1 stopped, 1 offline. Fleet health: 84/100.';
    } else if (msg.includes('maintenance') || msg.includes('service')) {
      reply = '\u{1F527} **Maintenance (Demo):** 3 vehicles due for service. KA-01-AB-1234 needs an oil change in 320 km.';
    } else if (msg.includes('alert') || msg.includes('warning')) {
      reply = '\u{1F6A8} **Alerts (Demo):** 2 unacknowledged alerts — speeding (120 km/h on NH44) and a geofence breach near Koramangala.';
    } else if (msg.includes('speed') || msg.includes('overspeed')) {
      reply = '\u26A1 **Speed (Demo):** 3 overspeed events in 24 hrs. Highest: 138 km/h by TN-09-MN-2023 on NH48.';
    } else if (msg.includes('driver') || msg.includes('score')) {
      reply = '\u{1F464} **Driver Score (Demo):** Top: Rajesh Kumar 94/100. Lowest: Pradeep Sharma 61/100 (harsh braking).';
    } else if (msg.includes('route') || msg.includes('trip')) {
      reply = '\u{1F5FA}\uFE0F **Routes (Demo):** Today 847 km across 12 vehicles. 2 route deviations detected.';
    } else if (msg.includes('fuel') || msg.includes('mileage')) {
      reply = '\u26FD **Fuel (Demo):** Fleet avg: 12.4 km/L. TN-22-XX-7890 uses 18% more than average — check idle time.';
    } else if (msg.includes('report') || msg.includes('analytics')) {
      reply = '\u{1F4C8} **Analytics (Demo):** This week — 5,240 km | Avg 48 km/h | Idle 12.3 hrs | Fuel 423 L.';
    } else if (msg.includes('geofence') || msg.includes('zone')) {
      reply = '\u{1F4CD} **Geofence (Demo):** 5 active zones. 1 breach today — TN-09-MN-2023 exited City Zone at 14:23.';
    } else {
      reply = "\u{1F44B} Hello! I'm your **Glivt AI Fleet Assistant**. Ask me about fleet status, maintenance, alerts, driver scores, routes, fuel, or reports!";
    }
    return envelope({ message: reply, timestamp: new Date().toISOString() });
  }
  */

  return notFound(`No demo handler for ${url}`);
};

/**
 * Public demo baseQuery. Wraps the handler so a bug in any single demo response
 * degrades to a clean error for that request instead of crashing the screen.
 */
export const demoBaseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extraOptions
) => {
  try {
    return await demoBaseQueryImpl(args, api, extraOptions);
  } catch (error) {
    const url = typeof args === 'string' ? args : args.url;
    const method = typeof args === 'string' ? 'GET' : (args.method ?? 'GET').toUpperCase();
    const reason = error instanceof Error ? error.message : String(error);
    // Surface the underlying reason instead of a generic failure: an opaque
    // "Server error" here made demo-mode write failures impossible to diagnose
    // from the screen that reported them.
    console.warn(`[demo] ${method} ${url} failed`, error);
    return {
      error: {
        status: 500,
        data: {
          success: false,
          data: null,
          error: {
            code: 'DEMO_ERROR',
            message: `Demo handler failed for ${method} ${url}: ${reason}`,
          },
        },
      } as FetchBaseQueryError,
    };
  }
};
