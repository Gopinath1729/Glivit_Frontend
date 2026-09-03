import { baseApi, unwrap } from '@/src/services/baseApi';
import { buildTenantResolveRequest } from '@/src/services/tenantIdentity';
import type { ApiResponse, TenantConfig } from '@/src/types/api';

export const tenantApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    resolveTenant: build.mutation<TenantConfig, string>({
      // A mutation always performs a new request. The screen also resets the
      // hook after a failed attempt, so an old rejection cannot be rendered or
      // mistaken for the result of the next code.
      query: buildTenantResolveRequest,
      transformResponse: (response: ApiResponse<TenantConfig>) => unwrap(response),
    }),
  }),
  overrideExisting: false,
});

export const { useResolveTenantMutation } = tenantApi;
