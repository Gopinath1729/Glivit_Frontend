import { baseApi, unwrap } from '@/src/services/baseApi';
import type {
  ApiResponse,
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
    exportVehicleActivityReport: build.query<ReportContent, ActivityReportExportArgs>({
      query: (params) => ({ url: '/reports/activity/export', params }),
      transformResponse: (response: ApiResponse<ReportContent>) => unwrap(response),
    }),
  }),
});

export const {
  useGetVehicleActivityReportQuery,
  useLazyExportVehicleActivityReportQuery,
} = activityReportsApi;
