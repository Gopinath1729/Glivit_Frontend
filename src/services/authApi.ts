import { baseApi, unwrap } from '@/src/services/baseApi';
import type {
  ApiResponse,
  OtpChallengeResponse,
  OtpVerifiedResponse,
  SimpleMessageResponse,
  TokenResponse,
} from '@/src/types/api';

export type LoginArgs = {
  companyCode: string;
  /** Members sign in with their email address. */
  email: string;
  password: string;
  fcmToken?: string;
  deviceInfo?: string;
};

/** "Send me a code", for either activation or a forgotten password. */
export type AccountCodeArgs = {
  companyCode: string;
  email: string;
};

export type AccountOtpVerifyArgs = AccountCodeArgs & {
  otp: string;
};

/**
 * Setting a password after a code was verified.
 *
 * `verificationToken` is the server's own proof that the code was answered.
 * There is deliberately no client-side "verified" flag: the server would have
 * no reason to believe one.
 */
export type AccountPasswordArgs = AccountCodeArgs & {
  verificationToken: string;
  newPassword: string;
  confirmPassword: string;
};

export type ChangePasswordArgs = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

/**
 * Every authentication call the app makes.
 *
 * None of these provides tags or invalidates them except the password change,
 * which ends other sessions; the rest run before there is a cache to speak of.
 */
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

    // --- First-time activation -------------------------------------------
    activateAccountRequest: build.mutation<OtpChallengeResponse, AccountCodeArgs>({
      query: (body) => ({ url: '/auth/activate/request', method: 'POST', body }),
      transformResponse: (response: ApiResponse<OtpChallengeResponse>) => unwrap(response),
    }),
    resendActivationOtp: build.mutation<OtpChallengeResponse, AccountCodeArgs>({
      query: (body) => ({ url: '/auth/activate/resend', method: 'POST', body }),
      transformResponse: (response: ApiResponse<OtpChallengeResponse>) => unwrap(response),
    }),
    verifyActivationOtp: build.mutation<OtpVerifiedResponse, AccountOtpVerifyArgs>({
      query: (body) => ({ url: '/auth/activate/verify', method: 'POST', body }),
      transformResponse: (response: ApiResponse<OtpVerifiedResponse>) => unwrap(response),
    }),
    setActivationPassword: build.mutation<SimpleMessageResponse, AccountPasswordArgs>({
      query: (body) => ({ url: '/auth/activate/password', method: 'POST', body }),
      transformResponse: (response: ApiResponse<SimpleMessageResponse>) => unwrap(response),
      // The member has just become ACTIVE. Any Members list an admin still has
      // open is now showing a stale "Pending Activation" badge.
      invalidatesTags: ['User'],
    }),

    // --- Forgotten password ----------------------------------------------
    forgotPassword: build.mutation<OtpChallengeResponse, AccountCodeArgs>({
      query: (body) => ({ url: '/auth/password/forgot', method: 'POST', body }),
      transformResponse: (response: ApiResponse<OtpChallengeResponse>) => unwrap(response),
    }),
    resendResetOtp: build.mutation<OtpChallengeResponse, AccountCodeArgs>({
      query: (body) => ({ url: '/auth/password/resend', method: 'POST', body }),
      transformResponse: (response: ApiResponse<OtpChallengeResponse>) => unwrap(response),
    }),
    verifyResetOtp: build.mutation<OtpVerifiedResponse, AccountOtpVerifyArgs>({
      query: (body) => ({ url: '/auth/password/verify-otp', method: 'POST', body }),
      transformResponse: (response: ApiResponse<OtpVerifiedResponse>) => unwrap(response),
    }),
    resetPassword: build.mutation<SimpleMessageResponse, AccountPasswordArgs>({
      query: (body) => ({ url: '/auth/password/reset', method: 'POST', body }),
      transformResponse: (response: ApiResponse<SimpleMessageResponse>) => unwrap(response),
    }),

    // --- Authenticated password change -----------------------------------
    /**
     * Returns a fresh session: the server revokes every refresh token when the
     * password changes, so the caller needs new ones or their own screen would
     * be signed out along with the other devices.
     */
    changePassword: build.mutation<TokenResponse, ChangePasswordArgs>({
      query: (body) => ({ url: '/auth/password/change', method: 'POST', body }),
      transformResponse: (response: ApiResponse<TokenResponse>) => unwrap(response),
    }),
  }),
});

export const {
  useLoginMutation,
  useLogoutMutation,
  useActivateAccountRequestMutation,
  useResendActivationOtpMutation,
  useVerifyActivationOtpMutation,
  useSetActivationPasswordMutation,
  useForgotPasswordMutation,
  useResendResetOtpMutation,
  useVerifyResetOtpMutation,
  useResetPasswordMutation,
  useChangePasswordMutation,
} = authApi;
