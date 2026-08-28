import { baseApi, unwrap } from '@/src/services/baseApi';
import type { ApiResponse, TokenResponse } from '@/src/types/api';

export type LoginArgs = {
  companyCode: string;
  username: string;
  password: string;
  fcmToken?: string;
  deviceInfo?: string;
};

export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    login: build.mutation<TokenResponse, LoginArgs>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      transformResponse: (response: ApiResponse<TokenResponse>) => unwrap(response),
    }),
    logout: build.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
    }),
  }),
});

export const {
  useLoginMutation,
  useLogoutMutation,
} = authApi;
