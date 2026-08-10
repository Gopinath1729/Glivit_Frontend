import { baseApi, unwrap } from '@/src/services/baseApi';
import type { ApiResponse, DashboardSummary } from '@/src/types/api';

export const dashboardApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getDashboardSummary: build.query<DashboardSummary, void>({
      query: () => ({ url: '/dashboard/summary' }),
      transformResponse: (response: ApiResponse<DashboardSummary>) => unwrap(response),
      providesTags: ['Dashboard'],
    }),
  }),
});

export const { useGetDashboardSummaryQuery } = dashboardApi;
