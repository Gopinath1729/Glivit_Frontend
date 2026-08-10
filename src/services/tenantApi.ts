import { baseApi, unwrap } from '@/src/services/baseApi';
import type { ApiResponse, TenantConfig } from '@/src/types/api';

export const tenantApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    resolveTenant: build.mutation<TenantConfig, string>({
      query: (companyCode) => ({
        url: '/tenant/resolve',
        method: 'POST',
        body: { companyCode },
      }),
      transformResponse: (response: ApiResponse<TenantConfig>) => unwrap(response),
    }),
  }),
  overrideExisting: false,
});

export const { useResolveTenantMutation } = tenantApi;
