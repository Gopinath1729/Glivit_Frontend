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
  projectId?: number;
  groupId?: number;
  includeSuspended?: boolean;
  page?: number;
  size?: number;
};

export type AllDevicesArgs = Pick<DeviceListArgs, 'search' | 'projectId' | 'groupId' | 'includeSuspended'>;

export type DeviceUpsertRequest = {
  name: string;
  imei: string;
  simNumber?: string;
  model?: string;
  port?: number;
  category: string;
  projectId?: number;
  groupId?: number;
  vehicleId?: number;
  managerId?: number;
  driverId?: number;
  driverName?: string;
  driverPhone?: string;
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

        while (page < totalPages) {
          const result = await baseQuery({
            url: '/devices',
            params: {
              ...(filters.search ? { search: filters.search } : {}),
              ...(filters.projectId != null ? { projectId: filters.projectId } : {}),
              ...(filters.groupId != null ? { groupId: filters.groupId } : {}),
              includeSuspended: filters.includeSuspended ?? true,
              page,
              size: 100,
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
      query: ({ search, projectId, groupId, page = 0, size = 20 }) => ({
        url: '/devices',
        params: {
          ...(search ? { search } : {}),
          ...(projectId != null ? { projectId } : {}),
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
  }),
});

export const {
  useCreateDeviceMutation,
  useDeleteDeviceMutation,
  useGetAllDevicesQuery,
  useGetDeviceQuery,
  useGetDevicePlaybackQuery,
  useGetDevicePositionsQuery,
  useGetDevicesQuery,
  useUpdateDeviceMutation,
} = devicesApi;
