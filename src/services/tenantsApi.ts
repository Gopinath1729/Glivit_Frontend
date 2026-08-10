import { baseApi, unwrap } from '@/src/services/baseApi';
import type {
  ApiResponse,
  PageResponse,
  TenantCreateRequest,
  TenantSummary,
  TenantSwitchResponse,
  TenantUpdateRequest,
} from '@/src/types/api';

export type TenantListArgs = {
  search?: string;
  page?: number;
  size?: number;
};

/**
 * Tenant management endpoints.
 *
 * The list is authoritative about what the caller may see: the backend filters it
 * to the caller's authorised tenants, so this service never has to (and never
 * should) filter tenants on the client.
 *
 * The switch mutation deliberately does NOT invalidate tags. Cache handling for a
 * switch is a full reset performed by `switchTenant`, because invalidation would
 * refetch every affected query against the OLD token while the switch is still in
 * progress.
 */
export const tenantsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getTenants: build.query<PageResponse<TenantSummary>, TenantListArgs | void>({
      query: (args) => {
        const { search, page = 0, size = 50 } = args ?? {};
        return {
          url: '/tenants',
          params: { ...(search ? { search } : {}), page, size },
        };
      },
      transformResponse: (response: ApiResponse<PageResponse<TenantSummary>>) => unwrap(response),
      providesTags: ['Tenant'],
    }),
    createTenant: build.mutation<TenantSummary, TenantCreateRequest>({
      query: (body) => ({ url: '/tenants', method: 'POST', body }),
      transformResponse: (response: ApiResponse<TenantSummary>) => unwrap(response),
      // The new tenant appears in the list immediately; the audit trail changes too.
      invalidatesTags: ['Tenant', 'Audit'],
    }),
    updateTenant: build.mutation<TenantSummary, { id: number; body: TenantUpdateRequest }>({
      query: ({ id, body }) => ({ url: `/tenants/${id}`, method: 'PUT', body }),
      transformResponse: (response: ApiResponse<TenantSummary>) => unwrap(response),
      invalidatesTags: ['Tenant', 'Audit'],
    }),
    deleteTenant: build.mutation<void, { id: number; confirmTenantId?: string }>({
      query: ({ id, confirmTenantId }) => ({
        url: `/tenants/${id}`,
        method: 'DELETE',
        params: confirmTenantId ? { confirmTenantId } : undefined,
      }),
      invalidatesTags: ['Tenant', 'Audit'],
    }),
    switchTenant: build.mutation<TenantSwitchResponse, { id: number; deviceInfo?: string }>({
      query: ({ id, deviceInfo }) => ({
        url: `/tenants/${id}/switch`,
        method: 'POST',
        body: { deviceInfo: deviceInfo ?? null },
      }),
      transformResponse: (response: ApiResponse<TenantSwitchResponse>) => unwrap(response),
    }),
  }),
  overrideExisting: false,
});

export const {
  useCreateTenantMutation,
  useDeleteTenantMutation,
  useGetTenantsQuery,
  useSwitchTenantMutation,
  useUpdateTenantMutation,
} = tenantsApi;
