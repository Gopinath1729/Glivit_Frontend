import React from 'react';

import { AccountCodeFlow } from '@/src/components/AccountCodeFlow';
import {
  useForgotPasswordMutation,
  useResendResetOtpMutation,
  useResetPasswordMutation,
  useVerifyResetOtpMutation,
} from '@/src/services/authApi';

/**
 * Password recovery for a member who cannot sign in.
 *
 * The current password is never asked for - not knowing it is the entire reason
 * this screen exists. The emailed code is what proves the member controls the
 * address, and the server revokes their other sessions once the new password is
 * set, so a reset genuinely locks out whoever prompted it.
 */
export default function ForgotPasswordScreen() {
  const [requestCode, requestState] = useForgotPasswordMutation();
  const [resendCode, resendState] = useResendResetOtpMutation();
  const [verifyCode, verifyState] = useVerifyResetOtpMutation();
  const [setPassword, passwordState] = useResetPasswordMutation();

  return (
    <AccountCodeFlow
      emailHint="Enter the email address registered for your account. This also works for a new account that has not created its password yet."
      passwordButtonLabel="Reset Password"
      passwordStepTitle="New Password"
      requestCode={requestCode}
      requestingCode={requestState.isLoading}
      resendCode={resendCode}
      resendingCode={resendState.isLoading}
      setPassword={setPassword}
      settingPassword={passwordState.isLoading}
      subtitle="Verify your email address, then choose a new password for your account."
      successTitle="Password changed"
      title="Forgot Password"
      verifyCode={verifyCode}
      verifyingCode={verifyState.isLoading}
    />
  );
}
