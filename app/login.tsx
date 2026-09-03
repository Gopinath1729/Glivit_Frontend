import { zodResolver } from '@hookform/resolvers/zod';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { z } from 'zod';

import { env } from '@/src/config/env';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { Button } from '@/src/components/ui/Button';
import { GlivtLogo } from '@/src/components/GlivtLogo';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import { useLoginMutation } from '@/src/services/authApi';
import { baseApi } from '@/src/services/baseApi';
import { normalizeCompanyCode } from '@/src/services/tenantIdentity';
import { clearTenant, setCredentials, setTenant } from '@/src/store/authState';
import { adoptSessionTenant, clearActiveTenant } from '@/src/store/tenantState';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { TenantConfig, TokenResponse } from '@/src/types/api';

const DEFAULT_TENANT_CONFIG: TenantConfig = {
  companyCode: '',
  name: 'Glivt Fleet',
  appName: 'Glivt',
  primaryColor: '#0F172A',
  secondaryColor: '#1E293B',
  enabledModules: ['LIVE_TRACKING', 'REPORTS', 'ALERTS', 'GEOFENCING'],
  paymentEnabled: false,
  maxHistoryDays: 90,
  status: 'ACTIVE',
};

// Members sign in with the email address their Tenant Admin registered. The
// address is lower-cased before it leaves the device so it matches the
// normalised value the account was created with.
const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginScreen() {
  const { height: screenHeight } = useWindowDimensions();
  const isSmallScreen = screenHeight < 750;
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c, isSmallScreen), [c, isSmallScreen]);
  const tenant = useAppSelector((s) => s.auth.tenantConfig);
  const companyCode = useAppSelector((s) => s.auth.companyCode);
  const [login, { isLoading }] = useLoginMutation();
  const [formError, setFormError] = React.useState<string | null>(null);
  const loginAttemptRef = React.useRef(false);
  const anyLoginLoading = isLoading;

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const openSession = React.useCallback(
    async (result: TokenResponse, sessionCompanyCode: string) => {
      const code = normalizeCompanyCode(sessionCompanyCode);
      if (!code) throw new Error('The authenticated session is missing a company code.');
      const activeConfig: TenantConfig = tenant || {
        ...DEFAULT_TENANT_CONFIG,
        companyCode: code,
        name: result.user.companyName || 'Glivt Fleet',
      };
      await authStorage.saveTenant(code, activeConfig);
      await authStorage.saveSession({
        accessToken: result.accessToken,
        companyCode: code,
        refreshToken: result.refreshToken,
        user: result.user,
      });
      baseApi.util.resetApiState();
      dispatch(setTenant({ companyCode: code, tenantConfig: activeConfig }));
      dispatch(
        setCredentials({
          accessToken: result.accessToken,
          companyCode: code,
          refreshToken: result.refreshToken,
          user: result.user,
        })
      );
      dispatch(adoptSessionTenant(result.user));
      router.replace('/map');
    },
    [dispatch, router, tenant]
  );

  const onSubmit = handleSubmit(async (values) => {
    if (anyLoginLoading || loginAttemptRef.current) return;
    loginAttemptRef.current = true;
    setFormError(null);
    if (!companyCode) {
      loginAttemptRef.current = false;
      router.replace('/company-code');
      return;
    }
    try {
      const result = await login({
        companyCode,
        deviceInfo: `${Platform.OS} app`,
        email: values.email.trim().toLowerCase(),
        password: values.password,
      }).unwrap();
      await openSession(result, companyCode);
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Unable to sign in'));
    } finally {
      loginAttemptRef.current = false;
    }
  });

  const clearCompanyCode = async () => {
    dispatch(clearTenant());
    dispatch(clearActiveTenant());
    baseApi.util.resetApiState();
    await authStorage.clearAll().catch(() => undefined);
    router.replace('/company-code');
  };

  return (
    <View style={styles.flex}>
      <View pointerEvents="none" style={styles.ambient}>
        <View style={styles.ambientOrbOne} />
        <View style={styles.ambientOrbTwo} />
        <View style={styles.roadLineOne} />
        <View style={styles.roadLineTwo} />
      </View>
      {/* flexGrow keeps the laid-out design pixel-identical while there is room,
          and only lets it scroll once the keyboard takes the space away. */}
      <KeyboardAwareForm applyBottomInset={false} contentContainerStyle={styles.grow} style={styles.flex}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.flex}>
        <View style={styles.contentContainer}>

          {/* A build compiled without an API host cannot reach anything, and
              every request inside it fails as a bare network error. Say so here
              instead: in a release build there is no console to read, and the
              cause is a build-time setting, not something the operator can fix
              by retrying. */}
          {env.backendConfigurationError ? (
            <View style={styles.configBanner}>
              <MaterialCommunityIcons color="#FCA5A5" name="server-off" size={18} />
              <Text style={styles.configBannerText}>{env.backendConfigurationError}</Text>
            </View>
          ) : null}

          <View style={styles.upperGroup}>
            <View style={styles.headerGroup}>
              <View style={styles.logo}>
                {tenant?.logoUrl ? (
                  <Image contentFit="contain" source={{ uri: tenant.logoUrl }} style={styles.logoImage} />
                ) : (
                  <GlivtLogo size={isSmallScreen ? 40 : 56} />
                )}
              </View>
              <View style={styles.heroCopy}>
                <View style={styles.liveEyebrow}>
                  <View style={styles.liveDot} />
                  <Text style={styles.eyebrowText}>FLEET COMMAND ACCESS</Text>
                </View>
                <Text style={styles.appName}>Welcome back</Text>
                <Text style={styles.heroSubtitle}>
                  Sign in to monitor every vehicle, route and alert in real time.
                </Text>
              </View>
            </View>

            <View style={styles.mainGroup}>
              <View style={styles.form}>
                <View style={styles.formHeadingRow}>
                  <View style={styles.formIcon}>
                    <MaterialCommunityIcons color="#2BE6A6" name="shield-lock-outline" size={21} />
                  </View>
                  <View style={styles.formHeadingCopy}>
                    <Text style={styles.formTitle}>Secure sign in</Text>
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
                <Controller
                  control={control}
                  name="email"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <TextField
                      autoCapitalize="none"
                      autoComplete="email"
                      autoCorrect={false}
                      importantForAutofill="yes"
                      error={errors.email?.message}
                      keyboardType="email-address"
                      label="Email"
                      onBlur={onBlur}
                      onChangeText={onChange}
                      placeholder="you@company.com"
                      textContentType="emailAddress"
                      value={value}
                    />
                  )}
                />
                <View style={styles.gap} />
                <Controller
                  control={control}
                  name="password"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <TextField
                      autoCapitalize="none"
                      autoComplete="current-password"
                      autoCorrect={false}
                      error={errors.password?.message}
                      importantForAutofill="yes"
                      label="Password"
                      onBlur={onBlur}
                      onChangeText={onChange}
                      placeholder="Password"
                      secure
                      textContentType="password"
                      value={value}
                      onSubmitEditing={onSubmit}
                      returnKeyType="go"
                    />
                  )}
                />

                {formError ? <Text style={styles.formError}>{formError}</Text> : null}

                <View style={styles.submit}>
                  <Button
                    disabled={anyLoginLoading}
                    label="Login"
                    color="#D1FAE5"
                    textColor="#0F172A"
                    loading={isLoading}
                    onPress={onSubmit}
                  />
                </View>

                {/* Both self-service routes sit on one row. There is no public
                    sign-up: an account only exists once a Tenant Admin has
                    created it, so the second link activates an existing member
                    rather than registering a new person. */}
                <View style={styles.linkRow}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={anyLoginLoading}
                    onPress={() => router.push('/forgot-password')}
                    style={styles.link}>
                    <Text style={styles.linkText}>Forgot Password?</Text>
                  </Pressable>
                  <Text style={styles.linkDivider}>|</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={anyLoginLoading}
                    onPress={() => router.push('/activate-account')}
                    style={styles.link}>
                    <Text style={styles.linkText}>Activate Account</Text>
                  </Pressable>
                </View>
              </View>

            </View>
          </View>

          <View style={styles.footerGroup}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: anyLoginLoading }}
              disabled={anyLoginLoading}
              onPress={clearCompanyCode}
              style={[styles.clearCode, anyLoginLoading && styles.clearCodeDisabled]}>
              <Text style={styles.clearCodeText}>
                Company code: <Text style={styles.clearCodeStrong}>{companyCode ?? '-'}</Text> | Change
              </Text>
            </Pressable>
            <View style={styles.securityNote}>
              <MaterialCommunityIcons
                color="rgba(255,255,255,0.48)"
                name="lock-check-outline"
                size={13}
              />
              <Text style={styles.securityNoteText}>Encrypted tenant-secured session</Text>
            </View>
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
    // Fills the viewport so the fixed design is unchanged, then scrolls
    // only when the keyboard leaves less room than the layout needs.
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
    configBanner: {
    alignItems: 'flex-start',
    backgroundColor: 'rgba(127,29,29,0.35)',
    borderColor: 'rgba(248,113,113,0.45)',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    padding: 12,
  },
  configBannerText: {
    color: '#FECACA',
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
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
    upperGroup: {
      alignItems: 'center',
      width: '100%',
    },
    headerGroup: {
      alignItems: 'center',
      width: '100%',
    },
    mainGroup: {
      alignItems: 'center',
      width: '100%',
    },
    footerGroup: {
      alignItems: 'center',
      width: '100%',
    },
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
    liveEyebrow: {
      alignItems: 'center',
      backgroundColor: 'rgba(43,230,166,0.08)',
      borderColor: 'rgba(43,230,166,0.22)',
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: isSmallScreen ? 4 : 7,
      paddingHorizontal: isSmallScreen ? 6 : 11,
      paddingVertical: isSmallScreen ? 3 : 6,
    },
    liveDot: {
      backgroundColor: '#2BE6A6',
      borderRadius: 4,
      height: 7,
      shadowColor: '#2BE6A6',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.9,
      shadowRadius: 6,
      width: 7,
    },
    eyebrowText: {
      color: '#9BEED1',
      fontSize: 9,
      fontWeight: '900',
      letterSpacing: 1.2,
    },
    appName: {
      color: c.white,
      fontSize: isSmallScreen ? 20 : 31,
      fontWeight: '900',
      letterSpacing: -0.6,
      marginTop: isSmallScreen ? 2 : spacing.md,
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
    formHeadingRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
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
    formSubtitle: {
      color: '#8299AA',
      fontSize: 10,
      fontWeight: '700',
      marginTop: 2,
    },
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
    formError: {
      color: c.danger,
      fontSize: typography.label,
      marginTop: spacing.md,
      textAlign: 'center',
    },
    submit: { marginTop: isSmallScreen ? 8 : spacing.lg },
    demoEndpointText: {
      color: 'rgba(226,239,247,0.66)',
      fontSize: 10,
      fontWeight: '700',
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    superAdminBtn: {
      marginTop: isSmallScreen ? 0 : 2,
      borderColor: '#2BE6A6',
      borderWidth: 1.5,
      backgroundColor: 'transparent',
      maxWidth: 470,
      width: '100%',
    },
    link: { alignSelf: 'center', padding: spacing.xs },
    linkText: { color: '#69D9F3', fontSize: typography.label, fontWeight: '700' },
    linkRow: {
      alignItems: 'center',
      alignSelf: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      marginTop: isSmallScreen ? 4 : spacing.md,
    },
    linkDivider: { color: 'rgba(255,255,255,0.28)', fontSize: typography.label },
    contactCard: {
      alignItems: 'center',
      backgroundColor: 'rgba(255,255,255,0.055)',
      borderColor: 'rgba(255,255,255,0.11)',
      borderRadius: 17,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 11,
      maxWidth: 470,
      marginTop: isSmallScreen ? 8 : spacing.lg,
      padding: isSmallScreen ? 8 : 12,
      width: '100%',
    },
    contactIcon: {
      alignItems: 'center',
      backgroundColor: 'rgba(43,230,166,0.09)',
      borderRadius: 11,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    contactCopy: { flex: 1 },
    contactText: { color: c.white, fontSize: 13, fontWeight: '800' },
    contactSubtext: {
      color: 'rgba(226,239,247,0.55)',
      fontSize: 10,
      marginTop: 2,
    },
    clearCode: { marginTop: isSmallScreen ? 2 : spacing.md, padding: spacing.sm },
    clearCodeDisabled: { opacity: 0.45 },
    clearCodeText: { color: 'rgba(255,255,255,0.64)', fontSize: typography.caption },
    clearCodeStrong: { color: c.white, fontWeight: '800' },
    securityNote: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 5,
      marginTop: isSmallScreen ? 0 : 2,
    },
    securityNoteText: {
      color: 'rgba(255,255,255,0.4)',
      fontSize: 9,
      fontWeight: '600',
    },
  });
