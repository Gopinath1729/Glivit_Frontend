import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlivtLogo } from '@/src/components/GlivtLogo';
import { Button } from '@/src/components/ui/Button';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { TextField } from '@/src/components/ui/TextField';
import { formatCountdown, useCountdown } from '@/src/hooks/useCountdown';
import { apiErrorMessage } from '@/src/services/apiError';
import { useAppSelector } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { spacing, typography, type ThemeColors } from '@/src/theme/tokens';
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

  const { height: screenHeight } = useWindowDimensions();
  const isSmallScreen = screenHeight < 750;
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c, isSmallScreen), [c, isSmallScreen]);
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

  return (
    <View style={styles.flex}>
      <View pointerEvents="none" style={styles.ambient}>
        <View style={styles.ambientOrbOne} />
        <View style={styles.ambientOrbTwo} />
        <View style={styles.roadLineOne} />
        <View style={styles.roadLineTwo} />
      </View>

      <KeyboardAwareForm
        applyBottomInset={false}
        contentContainerStyle={styles.grow}
        style={styles.flex}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.flex}>
          <View style={styles.contentContainer}>
            <View style={styles.upperGroup}>
              <View style={styles.headerGroup}>
                <View style={styles.logo}>
                  {tenant?.logoUrl ? (
                    <Image
                      contentFit="contain"
                      source={{ uri: tenant.logoUrl }}
                      style={styles.logoImage}
                    />
                  ) : (
                    <GlivtLogo size={isSmallScreen ? 40 : 56} />
                  )}
                </View>
                <View style={styles.heroCopy}>
                  <Text style={styles.appName}>{title}</Text>
                  <Text style={styles.heroSubtitle}>{subtitle}</Text>
                </View>
              </View>

              <View style={styles.mainGroup}>
                <View style={styles.form}>
                  <View style={styles.formHeadingRow}>
                    <View style={styles.formIcon}>
                      <MaterialCommunityIcons
                        color="#2BE6A6"
                        name={
                          step === 'password'
                            ? 'lock-reset'
                            : step === 'otp'
                              ? 'email-check-outline'
                              : 'email-outline'
                        }
                        size={21}
                      />
                    </View>
                    <View style={styles.formHeadingCopy}>
                      <Text style={styles.formTitle}>
                        {step === 'password'
                          ? passwordStepTitle
                          : step === 'otp'
                            ? 'Verification Code'
                            : title}
                      </Text>
                      <Text numberOfLines={1} style={styles.formSubtitle}>
                        {tenant?.name ?? 'Glivt Fleet Management'}
                      </Text>
                    </View>
                    <View style={styles.companyBadge}>
                      <Text numberOfLines={1} style={styles.companyBadgeText}>
                        {companyCode ?? '-'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.formRule} />

                  {step === 'email' ? (
                    <>
                      <TextField
                        autoCapitalize="none"
                        autoComplete="email"
                        autoCorrect={false}
                        keyboardType="email-address"
                        label="Email Address"
                        onChangeText={setEmail}
                        onSubmitEditing={sendCode}
                        placeholder="you@company.com"
                        returnKeyType="send"
                        textContentType="emailAddress"
                        value={email}
                      />
                      <Text style={styles.hint}>{emailHint}</Text>
                      {formError ? <Text style={styles.formError}>{formError}</Text> : null}
                      <View style={styles.submit}>
                        <Button
                          color="#D1FAE5"
                          disabled={anyLoading || !emailValid}
                          label="Send Code"
                          loading={requestingCode}
                          onPress={sendCode}
                          textColor="#0F172A"
                        />
                      </View>
                    </>
                  ) : null}

                  {step === 'otp' ? (
                    <>
                      <Text style={styles.hint}>
                        Enter the 6-digit code sent to{' '}
                        <Text style={styles.hintStrong}>{normalizedEmail}</Text>.
                      </Text>
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
                      <Text style={styles.countdown}>
                        {expiry.remaining > 0
                          ? `Code expires in ${formatCountdown(expiry.remaining)}`
                          : 'This code has expired. Request a new one.'}
                      </Text>
                      <View style={styles.submit}>
                        <Button
                          color="#D1FAE5"
                          disabled={anyLoading || otp.length !== 6}
                          label="Verify Code"
                          loading={verifyingCode}
                          onPress={() => void verify()}
                          textColor="#0F172A"
                        />
                      </View>
                      {/* Disabled, not hidden, while the cooldown runs: a
                          button that vanishes reads as a failure, whereas a
                          countdown reads as "not yet". */}
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
                          {cooldown.remaining > 0
                            ? `Resend Code in ${cooldown.remaining}s`
                            : 'Resend Code'}
                        </Text>
                      </Pressable>
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
                    </>
                  ) : null}

                  {step === 'password' ? (
                    <>
                      <TextField
                        autoCapitalize="none"
                        autoComplete="new-password"
                        autoCorrect={false}
                        label="New Password"
                        onChangeText={setNewPassword}
                        placeholder="New password"
                        secure
                        textContentType="newPassword"
                        value={newPassword}
                      />
                      <View style={styles.gap} />
                      <TextField
                        autoCapitalize="none"
                        autoComplete="new-password"
                        autoCorrect={false}
                        error={passwordMismatch ? 'Passwords do not match' : undefined}
                        label="Confirm Password"
                        onChangeText={setConfirmPassword}
                        onSubmitEditing={submitPassword}
                        placeholder="Re-enter new password"
                        returnKeyType="go"
                        secure
                        textContentType="newPassword"
                        value={confirmPassword}
                      />
                      <Text style={styles.hint}>{PASSWORD_RULE}</Text>
                      {formError ? <Text style={styles.formError}>{formError}</Text> : null}
                      <View style={styles.submit}>
                        <Button
                          color="#D1FAE5"
                          disabled={
                            anyLoading ||
                            !STRONG_PASSWORD.test(newPassword) ||
                            newPassword !== confirmPassword
                          }
                          label={passwordButtonLabel}
                          loading={settingPassword}
                          onPress={submitPassword}
                          textColor="#0F172A"
                        />
                      </View>
                    </>
                  ) : null}

                  {notice && step === 'otp' ? (
                    <Text style={styles.notice}>{notice}</Text>
                  ) : null}
                </View>
              </View>
            </View>

            <View style={styles.footerGroup}>
              <Pressable
                accessibilityRole="button"
                disabled={anyLoading}
                onPress={() => router.replace('/login')}
                style={styles.link}>
                <Text style={styles.backText}>Back to sign in</Text>
              </Pressable>
              <Text style={styles.clearCodeText}>
                Company code: <Text style={styles.clearCodeStrong}>{companyCode ?? '-'}</Text>
              </Text>
            </View>
          </View>
        </SafeAreaView>
      </KeyboardAwareForm>
    </View>
  );
}

const makeStyles = (c: ThemeColors, isSmallScreen: boolean) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: c.loginBackground },
    grow: { flexGrow: 1 },
    ambient: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: c.loginBackground,
      overflow: 'hidden',
    },
    ambientOrbOne: {
      backgroundColor: 'rgba(0, 190, 143, 0.18)',
      borderRadius: 220,
      height: 360,
      position: 'absolute',
      right: -170,
      top: -120,
      width: 360,
    },
    ambientOrbTwo: {
      backgroundColor: 'rgba(0, 120, 196, 0.13)',
      borderRadius: 180,
      bottom: -150,
      height: 320,
      left: -170,
      position: 'absolute',
      width: 320,
    },
    roadLineOne: {
      backgroundColor: 'rgba(43, 230, 166, 0.09)',
      borderRadius: 8,
      height: 2,
      left: -70,
      position: 'absolute',
      right: -70,
      top: '36%',
      transform: [{ rotate: '-12deg' }],
    },
    roadLineTwo: {
      backgroundColor: 'rgba(67, 188, 226, 0.08)',
      borderRadius: 8,
      height: 1,
      left: -70,
      position: 'absolute',
      right: -70,
      top: '41%',
      transform: [{ rotate: '-12deg' }],
    },
    contentContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xl,
      paddingTop: isSmallScreen ? 5 : 15,
      paddingBottom: isSmallScreen ? 5 : 15,
      width: '100%',
    },
    upperGroup: { alignItems: 'center', width: '100%' },
    headerGroup: { alignItems: 'center', width: '100%' },
    mainGroup: { alignItems: 'center', width: '100%' },
    footerGroup: { alignItems: 'center', width: '100%' },
    logo: {
      alignItems: 'center',
      minHeight: isSmallScreen ? 40 : 60,
      justifyContent: 'center',
    },
    logoImage: { height: isSmallScreen ? 36 : 56, width: isSmallScreen ? 115 : 180 },
    heroCopy: {
      alignItems: 'center',
      marginTop: isSmallScreen ? 4 : spacing.lg,
      maxWidth: 390,
    },
    appName: {
      color: c.white,
      fontSize: isSmallScreen ? 20 : 28,
      fontWeight: '900',
      letterSpacing: -0.6,
    },
    heroSubtitle: {
      color: 'rgba(226,239,247,0.68)',
      fontSize: isSmallScreen ? 11 : typography.body,
      lineHeight: isSmallScreen ? 14 : 21,
      marginTop: isSmallScreen ? 2 : 4,
      textAlign: 'center',
    },
    form: {
      backgroundColor: 'rgba(10, 20, 32, 0.92)',
      borderColor: 'rgba(255,255,255,0.13)',
      borderRadius: isSmallScreen ? 16 : 24,
      borderWidth: 1,
      elevation: 8,
      maxWidth: 470,
      marginTop: isSmallScreen ? 8 : spacing.xl,
      padding: isSmallScreen ? 10 : 20,
      shadowColor: '#02070D',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.36,
      shadowRadius: 28,
      width: '100%',
    },
    formHeadingRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
    formHeadingCopy: { flex: 1, minWidth: 0 },
    formIcon: {
      alignItems: 'center',
      backgroundColor: 'rgba(43,230,166,0.1)',
      borderColor: 'rgba(43,230,166,0.2)',
      borderRadius: 12,
      borderWidth: 1,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    formTitle: { color: '#F4FAFE', fontSize: 16, fontWeight: '900' },
    formSubtitle: { color: '#8299AA', fontSize: 10, fontWeight: '700', marginTop: 2 },
    companyBadge: {
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderColor: 'rgba(255,255,255,0.11)',
      borderRadius: 9,
      borderWidth: 1,
      maxWidth: 88,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    companyBadgeText: {
      color: '#AFC0CC',
      fontSize: 9,
      fontWeight: '900',
      letterSpacing: 0.8,
    },
    formRule: {
      backgroundColor: 'rgba(255,255,255,0.08)',
      height: 1,
      marginBottom: isSmallScreen ? 8 : spacing.lg,
      marginTop: isSmallScreen ? 4 : spacing.md,
    },
    gap: { height: isSmallScreen ? 6 : spacing.md },
    otpBlock: { marginTop: spacing.md, width: '100%' },
    hint: {
      color: 'rgba(226,239,247,0.6)',
      fontSize: typography.caption,
      lineHeight: 17,
      marginTop: spacing.sm,
    },
    hintStrong: { color: '#D1FAE5', fontWeight: '800' },
    countdown: {
      color: '#9BEED1',
      fontSize: typography.caption,
      fontWeight: '700',
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    notice: {
      color: 'rgba(226,239,247,0.5)',
      fontSize: 10,
      lineHeight: 15,
      marginTop: spacing.md,
      textAlign: 'center',
    },
    formError: {
      color: c.danger,
      fontSize: typography.label,
      marginTop: spacing.md,
      textAlign: 'center',
    },
    submit: { marginTop: isSmallScreen ? 8 : spacing.lg },
    link: { alignSelf: 'center', marginTop: spacing.sm, padding: spacing.xs },
    linkText: { color: '#69D9F3', fontSize: typography.label, fontWeight: '700' },
    linkTextDisabled: { color: 'rgba(105,217,243,0.42)' },
    linkTextMuted: { color: 'rgba(226,239,247,0.5)', fontSize: typography.caption },
    backText: { color: 'rgba(255,255,255,0.72)', fontSize: typography.label, fontWeight: '700' },
    clearCodeText: { color: 'rgba(255,255,255,0.64)', fontSize: typography.caption },
    clearCodeStrong: { color: c.white, fontWeight: '800' },
  });
