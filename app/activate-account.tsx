import React from 'react';

import { AccountCodeFlow } from '@/src/components/AccountCodeFlow';
import {
  useActivateAccountRequestMutation,
  useResendActivationOtpMutation,
  useSetActivationPasswordMutation,
  useVerifyActivationOtpMutation,
} from '@/src/services/authApi';

/**
 * First-time activation for a member their Tenant Admin has already created.
 *
 * This is not a sign-up screen and cannot become one: the backend only sends a
 * code to an address that already belongs to a member awaiting activation
 * inside the selected company, and answers identically otherwise - so nobody
 * can create an account here or learn whether one exists.
 */
export default function ActivateAccountScreen() {
  const [requestCode, requestState] = useActivateAccountRequestMutation();
  const [resendCode, resendState] = useResendActivationOtpMutation();
  const [verifyCode, verifyState] = useVerifyActivationOtpMutation();
  const [setPassword, passwordState] = useSetActivationPasswordMutation();

  return (
    <AccountCodeFlow
      emailHint="Enter the email address your administrator registered. We will send a verification code to it."
      passwordButtonLabel="Set Password"
      passwordStepTitle="Create Password"
      requestCode={requestCode}
      requestingCode={requestState.isLoading}
      resendCode={resendCode}
      resendingCode={resendState.isLoading}
      setPassword={setPassword}
      settingPassword={passwordState.isLoading}
      subtitle="Verify your email address and create your own password to finish setting up your account."
      successTitle="Account activated"
      title="Activate Account"
      verifyCode={verifyCode}
      verifyingCode={verifyState.isLoading}
    />
  );
}
