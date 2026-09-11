import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthScreenShell, authPalette as AUTH } from '@/src/components/ui/AuthScreenShell';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { TextField } from '@/src/components/ui/TextField';
import { formatCountdown, useCountdown } from '@/src/hooks/useCountdown';
import { apiErrorMessage } from '@/src/services/apiError';
import { useAppSelector } from '@/src/store/hooks';
import { ForcedScheme } from '@/src/theme/ThemeProvider';
import { radius, spacing } from '@/src/theme/tokens';
import type { OtpChallengeResponse, OtpVerifiedResponse } from '@/src/types/api';

/** The password rule the backend enforces, mirrored so errors appear before the round trip. */
const STRONG_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,72}$/;
const PASSWORD_RULE =
  'Use 12-72 characters with an uppercase letter, a lowercase letter, a number and a symbol.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type CodeRequestFn = (args: { companyCode: string; email: string }) => {
  unwrap: () => Promise<OtpChallengeResponse>;
};
type VerifyFn = (args: { companyCode: string; email: string; otp: string }) => {
  unwrap: () => Promise<OtpVerifiedResponse>;
};
type SetPasswordFn = (args: {
  companyCode: string;
  email: string;
  verificationToken: string;
  newPassword: string;
  confirmPassword: string;
}) => { unwrap: () => Promise<{ message: string }> };

export type AccountCodeFlowProps = {
  /** Screen heading, e.g. "Activate Account". */
  title: string;
  subtitle: string;
  /** Copy under the email field explaining what the code will do. */
  emailHint: string;
  /** Label of the final button, e.g. "SET PASSWORD" / "RESET PASSWORD". */
  passwordButtonLabel: string;
  passwordStepTitle: string;
  /** Shown in the success alert once the password is saved. */
  successTitle: string;
  requestCode: CodeRequestFn;
  requestingCode: boolean;
  resendCode: CodeRequestFn;
  resendingCode: boolean;
  verifyCode: VerifyFn;
  verifyingCode: boolean;
  setPassword: SetPasswordFn;
  settingPassword: boolean;
};

type Step = 'email' | 'otp' | 'password';

/**
 * The three-step "prove you own this mailbox, then choose a password" flow,
 * shared by first-time activation and forgotten passwords.
 *
 * The two differ only in wording and in which endpoints they call, so they are
 * one component: duplicating the countdown, the cooldown, the double-submit
 * guards and the keyboard handling into two screens is how the second copy ends
 * up subtly weaker than the first.
 *
 * The tenant is never asked for here - it is the company code already chosen on
 * the Company Code screen, so a member cannot aim this flow at another company.
 */
export function AccountCodeFlow(props: AccountCodeFlowProps) {
  const {
    title,
    subtitle,
    emailHint,
    passwordButtonLabel,
    passwordStepTitle,
    successTitle,
    requestCode,
    requestingCode,
    resendCode,
    resendingCode,
    verifyCode,
    verifyingCode,
    setPassword,
    settingPassword,
  } = props;

  const router = useRouter();
  const styles = React.useMemo(() => makeStyles(), []);
  const tenant = useAppSelector((s) => s.auth.tenantConfig);
  const companyCode = useAppSelector((s) => s.auth.companyCode);

  const [step, setStep] = React.useState<Step>('email');
  const [email, setEmail] = React.useState('');
  const [otp, setOtp] = React.useState('');
  const [verificationToken, setVerificationToken] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const expiry = useCountdown();
  const cooldown = useCountdown();

  // One in-flight submission at a time, per action. The mutation's own loading
  // flag lags by a render, so a fast double tap can slip past it; this ref is
  // set synchronously before any await.
  const busyRef = React.useRef(false);

  const normalizedEmail = email.trim().toLowerCase();
  const emailValid = EMAIL_PATTERN.test(normalizedEmail);
  const anyLoading = requestingCode || resendingCode || verifyingCode || settingPassword;

  const guard = React.useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await action();
    } finally {
      busyRef.current = false;
    }
  }, []);

  /**
   * Codes are only ever requested from a button press. Never from an effect:
   * an effect keyed on the email or the step would fire again on every
   * re-render caused by typing, burning through the resend cooldown before the
   * member has read the first message.
   */
  const sendCode = () =>
    guard(async () => {
      setFormError(null);
      if (!companyCode) {
        router.replace('/company-code');
        return;
      }
      if (!emailValid) {
        setFormError('Enter a valid email address.');
        return;
      }
      try {
        const result = await requestCode({ companyCode, email: normalizedEmail }).unwrap();
        setOtp('');
        setNotice(result.message);
        expiry.start(result.expiresInSeconds);
        cooldown.start(result.resendAfterSeconds);
        setStep('otp');
      } catch (err) {
        setFormError(apiErrorMessage(err, 'Could not send the verification code.'));
      }
    });

  const resend = () =>
    guard(async () => {
      setFormError(null);
      if (!companyCode || cooldown.remaining > 0) return;
      try {
        const result = await resendCode({ companyCode, email: normalizedEmail }).unwrap();
        setOtp('');
        setNotice(result.message);
        expiry.start(result.expiresInSeconds);
        cooldown.start(result.resendAfterSeconds);
      } catch (err) {
        setFormError(apiErrorMessage(err, 'Could not resend the verification code.'));
      }
    });

  const verify = (code: string = otp) =>
    guard(async () => {
      setFormError(null);
      if (!companyCode || code.length !== 6) {
        setFormError('Enter the 6-digit code from your email.');
        return;
      }
      try {
        const result = await verifyCode({
          companyCode,
          email: normalizedEmail,
          otp: code,
        }).unwrap();
        // The server issued this. It is the only thing that will get the next
        // request past the password endpoint - the client has no way to claim
        // verification on its own.
        setVerificationToken(result.verificationToken);
        expiry.stop();
        cooldown.stop();
        setNotice(null);
        setStep('password');
      } catch (err) {
        setOtp('');
        setFormError(apiErrorMessage(err, 'That code is not valid.'));
      }
    });

  const submitPassword = () =>
    guard(async () => {
      setFormError(null);
      if (!companyCode) return;
      if (!STRONG_PASSWORD.test(newPassword)) {
        setFormError(PASSWORD_RULE);
        return;
      }
      if (newPassword !== confirmPassword) {
        setFormError('Password and confirm password do not match.');
        return;
      }
      try {
        const result = await setPassword({
          companyCode,
          email: normalizedEmail,
          verificationToken,
          newPassword,
          confirmPassword,
        }).unwrap();
        setVerificationToken('');
        setNewPassword('');
        setConfirmPassword('');
        Alert.alert(successTitle, result.message, [
          { text: 'Sign in', onPress: () => router.replace('/login') },
        ]);
      } catch (err) {
        setFormError(apiErrorMessage(err, 'Could not save the new password.'));
      }
    });

  const passwordMismatch = Boolean(confirmPassword) && confirmPassword !== newPassword;

  const stepTitle =
    step === 'password' ? passwordStepTitle : step === 'otp' ? 'Verification code' : title;
  const stepSubtitle =
    step === 'password'
      ? PASSWORD_RULE
      : step === 'otp'
        ? `Enter the 6-digit code we sent to ${normalizedEmail}.`
        : subtitle;

  return (
    <ForcedScheme scheme="light">
      <AuthScreenShell
        eyebrow={(tenant?.name ?? 'GLIVT FLEET').toUpperCase()}
        footer={
          <>
            <Pressable
              accessibilityRole="button"
              disabled={anyLoading}
              onPress={() => router.replace('/login')}
              style={styles.link}>
              <Text style={styles.linkText}>Back to sign in</Text>
            </Pressable>
            <View style={styles.codeChip}>
              <MaterialCommunityIcons color={AUTH.inkMuted} name="domain" size={13} />
              <Text style={styles.codeChipText}>{companyCode ?? '—'}</Text>
            </View>
          </>
        }
        subtitle={stepSubtitle}
        title={stepTitle}>
        {step === 'email' ? (
          <>
            <TextField
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              label="Email address"
              onChangeText={setEmail}
              onSubmitEditing={sendCode}
              placeholder="you@company.com"
              returnKeyType="send"
              textContentType="emailAddress"
              value={email}
            />
            <Text style={styles.hint}>{emailHint}</Text>
            {formError ? <FormError message={formError} styles={styles} /> : null}
            <Button
              disabled={anyLoading || !emailValid}
              label="Send code"
              loading={requestingCode}
              onPress={sendCode}
            />
          </>
        ) : null}

        {step === 'otp' ? (
          <>
            <View style={styles.otpBlock}>
              <OtpInput
                autoFocus
                disabled={verifyingCode}
                error={formError ?? undefined}
                onChange={setOtp}
                onComplete={(code) => void verify(code)}
                value={otp}
              />
            </View>
            <View style={styles.countdownRow}>
              <MaterialCommunityIcons
                color={expiry.remaining > 0 ? AUTH.inkMuted : '#B42318'}
                name={expiry.remaining > 0 ? 'timer-sand' : 'timer-off-outline'}
                size={13}
              />
              <Text style={[styles.countdown, expiry.remaining === 0 && styles.countdownExpired]}>
                {expiry.remaining > 0
                  ? `Code expires in ${formatCountdown(expiry.remaining)}`
                  : 'This code has expired. Request a new one.'}
              </Text>
            </View>
            <Button
              disabled={anyLoading || otp.length !== 6}
              label="Verify code"
              loading={verifyingCode}
              onPress={() => void verify()}
            />
            {/* Disabled, not hidden, while the cooldown runs: a button that
                vanishes reads as a failure, whereas a countdown reads as
                "not yet". */}
            <View style={styles.linkRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: cooldown.remaining > 0 || anyLoading }}
                disabled={cooldown.remaining > 0 || anyLoading}
                onPress={resend}
                style={styles.link}>
                <Text
                  style={[
                    styles.linkText,
                    (cooldown.remaining > 0 || anyLoading) && styles.linkTextDisabled,
                  ]}>
                  {cooldown.remaining > 0 ? `Resend in ${cooldown.remaining}s` : 'Resend code'}
                </Text>
              </Pressable>
              <View style={styles.linkDivider} />
              <Pressable
                accessibilityRole="button"
                disabled={anyLoading}
                onPress={() => {
                  setStep('email');
                  setOtp('');
                  setFormError(null);
                }}
                style={styles.link}>
                <Text style={styles.linkTextMuted}>Use a different email</Text>
              </Pressable>
            </View>
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          </>
        ) : null}

        {step === 'password' ? (
          <>
            <TextField
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              label="New password"
              onChangeText={setNewPassword}
              placeholder="New password"
              secure
              textContentType="newPassword"
              value={newPassword}
            />
            <TextField
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              error={passwordMismatch ? 'Passwords do not match' : undefined}
              label="Confirm password"
              onChangeText={setConfirmPassword}
              onSubmitEditing={submitPassword}
              placeholder="Re-enter new password"
              returnKeyType="go"
              secure
              textContentType="newPassword"
              value={confirmPassword}
            />
            {formError ? <FormError message={formError} styles={styles} /> : null}
            <Button
              disabled={
                anyLoading ||
                !STRONG_PASSWORD.test(newPassword) ||
                newPassword !== confirmPassword
              }
              label={passwordButtonLabel}
              loading={settingPassword}
              onPress={submitPassword}
            />
          </>
        ) : null}
      </AuthScreenShell>
    </ForcedScheme>
  );
}

function FormError({
  message,
  styles,
}: {
  message: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.formError}>
      <MaterialCommunityIcons color="#B42318" name="alert-circle-outline" size={16} />
      <Text style={styles.formErrorText}>{message}</Text>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    hint: { color: AUTH.inkSoft, fontSize: 12, lineHeight: 18 },
    otpBlock: { paddingVertical: spacing.xs },
    countdownRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    countdown: { color: AUTH.inkMuted, fontSize: 12, fontWeight: '600' },
    countdownExpired: { color: '#B42318' },
    linkRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'center' },
    link: { paddingVertical: 2 },
    linkText: { color: AUTH.accent, fontSize: 13, fontWeight: '800' },
    linkTextDisabled: { color: AUTH.inkMuted },
    linkTextMuted: { color: AUTH.inkSoft, fontSize: 13, fontWeight: '700' },
    linkDivider: { backgroundColor: AUTH.border, height: 13, width: StyleSheet.hairlineWidth * 2 },
    notice: { color: AUTH.inkSoft, fontSize: 12, lineHeight: 18, textAlign: 'center' },
    codeChip: {
      alignItems: 'center',
      backgroundColor: AUTH.card,
      borderColor: AUTH.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
    },
    codeChipText: { color: AUTH.ink, fontSize: 12, fontWeight: '900', letterSpacing: 0.6 },
    formError: {
      alignItems: 'center',
      backgroundColor: '#FEF3F2',
      borderColor: '#FDA29B',
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm,
    },
    formErrorText: { color: '#B42318', flex: 1, fontSize: 12.5, lineHeight: 18 },
  });
