import { baseApi, unwrap } from '@/src/services/baseApi';
import type {
  ApiResponse,
  DeviceDetail,
  DeviceSummary,
  PageResponse,
  PlaybackResponse,
  PositionDto,
} from '@/src/types/api';

export type DevicePlaybackArgs = {
  deviceId: number;
  from?: string;
  to?: string;
};

export type DevicePositionsArgs = DevicePlaybackArgs & {
  page?: number;
  size?: number;
};

export type DeviceListArgs = {
  search?: string;
  groupId?: number;
  page?: number;
  size?: number;
};

export type AllDevicesArgs = Pick<DeviceListArgs, 'search' | 'groupId'>;

/** Page size used when walking the whole fleet for the live map. */
const ALL_DEVICES_PAGE_SIZE = 100;
/**
 * Hard ceiling on that walk.
 *
 * The map needs every vehicle, but "every vehicle" is a number the client does
 * not control: an unbounded loop turns one large tenant into hundreds of
 * sequential requests and an unbounded array on a phone. Stopping is the safe
 * failure — the map draws what it has instead of hanging the screen.
 */
const MAX_DEVICE_PAGES = 50;

export type MobileGpsSession = {
  registered: boolean;
  deviceId: number | null;
  deviceName: string | null;
  ingestToken: string | null;
};

export type DeviceUpsertRequest = {
  name: string;
  imei?: string;
  sourceType?: 'GPS_DEVICE' | 'MOBILE_GPS';
  simNumber?: string;
  model?: string;
  port?: number;
  category: string;
  /** Driver contact details. Free text on the device, not a linked account. */
  driverName?: string;
  driverPhone?: string;
  driverAddress?: string;
  groupId?: number;
  vehicleId?: number;
  managerId?: number;
  remarks?: string;
  address?: string;
  simProvider?: string;
  simApn?: string;
  expiryDate?: string;
  activatedAt?: string;
  timezone?: string;
  distanceUnit?: string;
  speedUnit?: string;
  status?: string;
};

export const devicesApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getAllDevices: build.query<DeviceSummary[], AllDevicesArgs | void>({
      async queryFn(args, _api, _extraOptions, baseQuery) {
        const filters = args ?? {};
        const devices = new Map<number, DeviceSummary>();
        let page = 0;
        let totalPages = 1;

        while (page < totalPages && page < MAX_DEVICE_PAGES) {
          const result = await baseQuery({
            url: '/devices',
            params: {
              ...(filters.search ? { search: filters.search } : {}),
              ...(filters.groupId != null ? { groupId: filters.groupId } : {}),
              page,
              size: ALL_DEVICES_PAGE_SIZE,
            },
          });
          if (result.error) return { error: result.error };

          const raw = result.data as any;
          let content: DeviceSummary[] | undefined;
          let totalPagesVal = 1;
          let isLast = false;

          if (raw?.data && Array.isArray(raw.data.content)) {
            content = raw.data.content;
            totalPagesVal = raw.data.totalPages ?? 1;
            isLast = Boolean(raw.data.last);
          } else if (raw && Array.isArray(raw.content)) {
            content = raw.content;
            totalPagesVal = raw.totalPages ?? 1;
            isLast = Boolean(raw.last);
          } else if (Array.isArray(raw?.data)) {
            content = raw.data;
            isLast = true;
          } else if (Array.isArray(raw)) {
            content = raw;
            isLast = true;
          }

          if (!content) {
            return {
              error: {
                status: 'PARSING_ERROR',
                originalStatus: 200,
                data: 'Invalid device list response',
                error: 'Invalid device list response',
              },
            };
          }
          content.forEach((device) => {
            if (device && Number.isSafeInteger(device.id)) devices.set(device.id, device);
          });
          totalPages = Number.isFinite(totalPagesVal)
            ? Math.max(1, Math.trunc(totalPagesVal))
            : page + 1;
          if (isLast || content.length === 0) break;
          page += 1;
        }

        return { data: Array.from(devices.values()) };
      },
      providesTags: ['Device'],
    }),
    getDevices: build.query<PageResponse<DeviceSummary>, DeviceListArgs>({
      query: ({ search, groupId, page = 0, size = 20 }) => ({
        url: '/devices',
        params: {
          ...(search ? { search } : {}),
          ...(groupId != null ? { groupId } : {}),
          page,
          size,
        },
      }),
      transformResponse: (response: ApiResponse<PageResponse<DeviceSummary>>) => unwrap(response),
      providesTags: ['Device'],
    }),
    getDevice: build.query<DeviceDetail, number>({
      query: (id) => ({ url: `/devices/${id}` }),
      transformResponse: (response: ApiResponse<DeviceDetail>) => unwrap(response),
      providesTags: (_result, _error, id) => [{ type: 'Device', id }],
    }),
    createDevice: build.mutation<DeviceDetail, DeviceUpsertRequest>({
      query: (body) => ({ url: '/devices', method: 'POST', body }),
      transformResponse: (response: ApiResponse<DeviceDetail>) => unwrap(response),
      invalidatesTags: ['Dashboard', 'Device'],
    }),
    updateDevice: build.mutation<DeviceDetail, { id: number; body: DeviceUpsertRequest }>({
      query: ({ id, body }) => ({ url: `/devices/${id}`, method: 'PUT', body }),
      transformResponse: (response: ApiResponse<DeviceDetail>) => unwrap(response),
      invalidatesTags: (_result, _error, { id }) => ['Dashboard', 'Device', { type: 'Device', id }],
    }),
    deleteDevice: build.mutation<void, number>({
      query: (id) => ({ url: `/devices/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Dashboard', 'Device'],
    }),
    // Real route playback (simplified geometry + event/stop markers) that
    // replaces the hard-coded demo route on the live-track screen.
    getDevicePlayback: build.query<PlaybackResponse, DevicePlaybackArgs>({
      query: ({ deviceId, from, to }) => ({
        url: `/devices/${deviceId}/playback`,
        params: {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      }),
      transformResponse: (response: ApiResponse<PlaybackResponse>) => unwrap(response),
      providesTags: (_result, _error, { deviceId }) => [{ type: 'Device', id: deviceId }],
    }),
    getDevicePositions: build.query<PageResponse<PositionDto>, DevicePositionsArgs>({
      query: ({ deviceId, from, to, page = 0, size = 100 }) => ({
        url: `/devices/${deviceId}/positions`,
        params: {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          page,
          size,
        },
      }),
      transformResponse: (response: ApiResponse<PageResponse<PositionDto>>) => unwrap(response),
      providesTags: (_result, _error, { deviceId }) => [{ type: 'Device', id: deviceId }],
    }),
    /**
     * Rotates and returns a device's opaque ingestion token.
     *
     * The token is shown once and the previous one stops working, so callers
     * must keep what they get. Requires `manage_devices`. This is what lets the
     * phone post its own fixes as that device without carrying a user JWT.
     */
    issueIngestToken: build.mutation<{ deviceId: number; ingestToken: string }, number>({
      query: (deviceId) => ({
        url: `/devices/${deviceId}/ingest-token`,
        method: 'POST',
      }),
      transformResponse: (response: ApiResponse<{ deviceId: number; ingestToken: string }>) =>
        unwrap(response),
    }),
    /**
     * Resolves only the authenticated login's Mobile GPS registration. The app
     * calls this before any Expo Location API so users without a phone tracker
     * never receive a GPS or permission prompt.
     */
    bootstrapMobileGps: build.query<MobileGpsSession, void>({
      query: () => ({ url: '/devices/mobile-gps/session', method: 'POST' }),
      transformResponse: (response: ApiResponse<MobileGpsSession>) => unwrap(response),
      providesTags: ['Device'],
    }),
  }),
});

export const {
  useBootstrapMobileGpsQuery,
  useCreateDeviceMutation,
  useIssueIngestTokenMutation,
  useDeleteDeviceMutation,
  useGetAllDevicesQuery,
  useGetDeviceQuery,
  useGetDevicePlaybackQuery,
  useGetDevicePositionsQuery,
  useGetDevicesQuery,
  useUpdateDeviceMutation,
} = devicesApi;
