import { baseApi, unwrap } from '@/src/services/baseApi';
import type {
  ApiResponse,
  FleetTimelineReport,
  ReportContent,
  ReportPeriod,
  VehicleActivityReport,
} from '@/src/types/api';

export type ActivityReportArgs = {
  deviceId: number;
  from: string;
  to: string;
  period: ReportPeriod;
};

export type ActivityReportExportArgs = ActivityReportArgs & { format: 'PDF' | 'EXCEL' };

/** Fleet-wide totals for one window. No deviceId: it covers every vehicle in scope. */
export type FleetTimelineArgs = {
  from: string;
  to: string;
  period: ReportPeriod;
};

export const activityReportsApi = baseApi.injectEndpoints({
  overrideExisting: false,
  endpoints: (build) => ({
    getVehicleActivityReport: build.query<VehicleActivityReport, ActivityReportArgs>({
      query: (params) => ({ url: '/reports/activity', params }),
      transformResponse: (response: ApiResponse<VehicleActivityReport>) => unwrap(response),
      providesTags: (_result, _error, { deviceId }) => [
        'Report',
        { type: 'Device', id: deviceId },
      ],
    }),
    getFleetTimeline: build.query<FleetTimelineReport, FleetTimelineArgs>({
      query: (params) => ({ url: '/reports/fleet-timeline', params }),
      transformResponse: (response: ApiResponse<FleetTimelineReport>) => unwrap(response),
      // Depends on both the vehicle list and its telemetry, so adding or
      // removing a device refreshes the headline count without a manual reload.
      providesTags: ['Report', 'Device'],
    }),
    exportVehicleActivityReport: build.query<ReportContent, ActivityReportExportArgs>({
      query: (params) => ({ url: '/reports/activity/export', params }),
      transformResponse: (response: ApiResponse<ReportContent>) => unwrap(response),
    }),
  }),
});

export const {
  useGetFleetTimelineQuery,
  useGetVehicleActivityReportQuery,
  useLazyExportVehicleActivityReportQuery,
} = activityReportsApi;
