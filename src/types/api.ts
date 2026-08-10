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

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'DRIVER';

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
  category: string;
  vehicleId?: number | null;
  vehicleName?: string | null;
  projectId?: number | null;
  groupId?: number | null;
  simNumber?: string | null;
  simProvider?: string | null;
  driverName?: string | null;
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
};

export type DeviceDetail = DeviceSummary & {
  model?: string | null;
  projectId?: number | null;
  managerId?: number | null;
  simNumber?: string | null;
  simProvider?: string | null;
  simApn?: string | null;
  driverId?: number | null;
  driverName?: string | null;
  driverPhone?: string | null;
  remarks?: string | null;
  activatedAt?: string | null;
  timezone?: string | null;
  distanceUnit?: string | null;
  speedUnit?: string | null;
};

export type ProjectDto = {
  id: number;
  name: string;
  description?: string | null;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

export type DriverDto = {
  id: number;
  projectId?: number | null;
  name: string;
  identifier?: string | null;
  phone?: string | null;
  licenceNumber?: string | null;
  licenceExpiry?: string | null;
  emergencyContact?: string | null;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type GroupDto = {
  id: number;
  name: string;
  parentId?: number | null;
  managerId?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ManagedUserDto = {
  id: number;
  username: string;
  name: string;
  email?: string | null;
  mobile?: string | null;
  address?: string | null;
  role: Role;
  managerId?: number | null;
  status: string;
  accountExpiry?: string | null;
  permissions: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
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
  speed: number;
  course: number;
  ignition?: boolean | null;
  gpsValid: boolean;
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
};
