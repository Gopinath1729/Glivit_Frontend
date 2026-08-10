import { zodResolver } from '@hookform/resolvers/zod';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { Button } from '@/src/components/ui/Button';
import { GlivtLogo } from '@/src/components/GlivtLogo';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import {
  useAdminDemoLoginMutation,
  useDemoLoginMutation,
  useDriverDemoLoginMutation,
  useLoginMutation,
} from '@/src/services/authApi';
import { baseApi } from '@/src/services/baseApi';
import { env } from '@/src/config/env';
import { normalizeCompanyCode } from '@/src/services/tenantIdentity';
import { useResolveTenantMutation } from '@/src/services/tenantApi';
import { clearTenant, setCredentials, setTenant } from '@/src/store/authSlice';
import { adoptSessionTenant, clearActiveTenant } from '@/src/store/tenantSlice';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { store } from '@/src/store/store';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { TenantConfig, TokenResponse } from '@/src/types/api';

const DEFAULT_DEMO_CONFIG: TenantConfig = {
  companyCode: 'DEMO',
  name: 'Glivt Demo Fleet',
  appName: 'Glivt Demo',
  primaryColor: '#0F172A',
  secondaryColor: '#1E293B',
  enabledModules: ['LIVE_TRACKING', 'REPORTS', 'ALERTS', 'GEOFENCING'],
  paymentEnabled: false,
  maxHistoryDays: 90,
  status: 'ACTIVE',
};

const schema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const tenant = useAppSelector((s) => s.auth.tenantConfig);
  const companyCode = useAppSelector((s) => s.auth.companyCode);
  const [login, { isLoading }] = useLoginMutation();
  const [demoLogin, { isLoading: isDemoLoading }] = useDemoLoginMutation();
  const [adminDemoLogin, { isLoading: isAdminDemoLoading }] = useAdminDemoLoginMutation();
  const [driverDemoLogin, { isLoading: isDriverDemoLoading }] = useDriverDemoLoginMutation();
  const [resolveTenant, { isLoading: isResolvingDemoTenant }] = useResolveTenantMutation();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [demoError, setDemoError] = React.useState(false);
  const showDemoLogin = env.demoMode;
  const anyLoginLoading =
    isLoading || isDemoLoading || isAdminDemoLoading || isDriverDemoLoading || isResolvingDemoTenant;

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  });

  const openSession = React.useCallback(
    async (result: TokenResponse, sessionCompanyCode: string) => {
      const code = normalizeCompanyCode(sessionCompanyCode) || 'DEMO';
      const activeConfig: TenantConfig = tenant || {
        ...DEFAULT_DEMO_CONFIG,
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
      dispatch(baseApi.util.resetApiState());
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
    if (anyLoginLoading) return;
    setFormError(null);
    setDemoError(false);
    if (!companyCode) {
      router.replace('/company-code');
      return;
    }
    try {
      const result = await login({
        companyCode,
        username: values.username,
        password: values.password,
      }).unwrap();
      await openSession(result, companyCode);
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Unable to sign in'));
    }
  });

  const onDemoLogin = async () => {
    if (anyLoginLoading) return;
    setFormError(null);
    setDemoError(false);
    try {
      let config: TenantConfig;
      try {
        config = await resolveTenant('DEMO').unwrap();
      } catch {
        config = DEFAULT_DEMO_CONFIG;
      }
      await authStorage.saveTenant(config.companyCode, config);
      dispatch(setTenant({ companyCode: config.companyCode, tenantConfig: config }));

      const result = await demoLogin().unwrap();
      await openSession(result, config.companyCode);
    } catch (err) {
      setDemoError(true);
      setFormError(apiErrorMessage(err, 'Unable to open demo account'));
    }
  };

  const onRoleDemoLogin = async (role: 'admin' | 'driver') => {
    if (anyLoginLoading) return;
    setFormError(null);
    setDemoError(false);
    try {
      let config: TenantConfig;
      try {
        config = await resolveTenant('DEMO').unwrap();
      } catch {
        config = DEFAULT_DEMO_CONFIG;
      }
      await authStorage.saveTenant(config.companyCode, config);
      dispatch(setTenant({ companyCode: config.companyCode, tenantConfig: config }));

      const result =
        role === 'admin'
          ? await adminDemoLogin().unwrap()
          : await driverDemoLogin().unwrap();

      await openSession(result, config.companyCode);
    } catch (err) {
      setDemoError(true);
      setFormError(
        apiErrorMessage(
          err,
          `Unable to open ${role === 'admin' ? 'Admin' : 'Driver'} demo account`
        )
      );
    }
  };

  const contactProvider = () => {
    const phone = tenant?.supportPhone;
    const email = tenant?.supportEmail;
    if (phone) {
      Linking.openURL(`tel:${phone}`).catch(() => undefined);
    } else if (email) {
      Linking.openURL(`mailto:${email}`).catch(() => undefined);
    } else {
      Alert.alert('Contact Service Provider', 'No support contact configured for this account.');
    }
  };

  const clearCompanyCode = async () => {
    dispatch(clearTenant());
    dispatch(clearActiveTenant());
    dispatch(baseApi.util.resetApiState());
    await authStorage.clearAll().catch(() => undefined);
    router.replace('/company-code');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}>
      <View pointerEvents="none" style={styles.ambient}>
        <View style={styles.ambientOrbOne} />
        <View style={styles.ambientOrbTwo} />
        <View style={styles.roadLineOne} />
        <View style={styles.roadLineTwo} />
      </View>
      <SafeAreaView edges={['bottom']} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + spacing.xl, paddingBottom: spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled">
          <View style={styles.logo}>
            {tenant?.logoUrl ? (
              <Image contentFit="contain" source={{ uri: tenant.logoUrl }} style={styles.logoImage} />
            ) : (
              <GlivtLogo size={72} />
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
              name="username"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextField
                  autoCapitalize="none"
                  autoCorrect={false}
                  error={errors.username?.message}
                  label="Username"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  placeholder="Username"
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
                  error={errors.password?.message}
                  label="Password"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  placeholder="Password"
                  secure
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

            {showDemoLogin ? (
              <>
                {demoError ? (
                  <Text style={styles.demoEndpointText}>
                    Backend: {env.backendBaseUrl || 'not configured'}
                  </Text>
                ) : null}
                <Button
                  disabled={anyLoginLoading}
                  icon="shield-crown-outline"
                  label={demoError ? 'Retry Super Admin Demo' : 'Super Admin Demo'}
                  loading={isDemoLoading || isResolvingDemoTenant}
                  onPress={onDemoLogin}
                  style={styles.demoLogin}
                  variant="secondary"
                />
                <View style={styles.demoRoleRow}>
                  <Button
                    disabled={anyLoginLoading}
                    icon="shield-account-outline"
                    label="Admin Demo"
                    loading={isAdminDemoLoading}
                    onPress={() => void onRoleDemoLogin('admin')}
                    style={styles.demoRoleBtn}
                    variant="secondary"
                  />
                  <Button
                    disabled={anyLoginLoading}
                    icon="account-badge-outline"
                    label="Driver Demo"
                    loading={isDriverDemoLoading}
                    onPress={() => void onRoleDemoLogin('driver')}
                    style={styles.demoRoleBtn}
                    variant="secondary"
                  />
                </View>
              </>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() =>
                Alert.alert(
                  'Forgot Password',
                  'Please contact your service provider to reset your password.'
                )
              }
              style={styles.link}>
              <Text style={styles.linkText}>Forgot Password?</Text>
            </Pressable>
          </View>

          <Pressable accessibilityRole="button" onPress={contactProvider} style={styles.contactCard}>
            <View style={styles.contactIcon}>
              <MaterialCommunityIcons color="#2BE6A6" name="headset" size={20} />
            </View>
            <View style={styles.contactCopy}>
              <Text style={styles.contactText}>Need help signing in?</Text>
              <Text style={styles.contactSubtext}>Contact your service provider</Text>
            </View>
            <MaterialCommunityIcons color="rgba(255,255,255,0.62)" name="chevron-right" size={20} />
          </Pressable>

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
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: c.loginBackground },
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
    content: {
      alignItems: 'center',
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    logo: {
      alignItems: 'center',
      minHeight: 76,
      justifyContent: 'center',
    },
    logoImage: { height: 72, width: 230 },
    heroCopy: {
      alignItems: 'center',
      marginTop: spacing.lg,
      maxWidth: 390,
    },
    liveEyebrow: {
      alignItems: 'center',
      backgroundColor: 'rgba(43,230,166,0.08)',
      borderColor: 'rgba(43,230,166,0.22)',
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 7,
      paddingHorizontal: 11,
      paddingVertical: 6,
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
      fontSize: 31,
      fontWeight: '900',
      letterSpacing: -0.6,
      marginTop: spacing.md,
    },
    heroSubtitle: {
      color: 'rgba(226,239,247,0.68)',
      fontSize: typography.body,
      lineHeight: 21,
      marginTop: 7,
      textAlign: 'center',
    },
    form: {
      backgroundColor: 'rgba(10, 20, 32, 0.92)',
      borderColor: 'rgba(255,255,255,0.13)',
      borderRadius: 24,
      borderWidth: 1,
      elevation: 8,
      maxWidth: 470,
      marginTop: spacing.xl,
      padding: 20,
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
      marginBottom: spacing.lg,
      marginTop: spacing.md,
    },
    gap: { height: spacing.md },
    formError: {
      color: c.danger,
      fontSize: typography.label,
      marginTop: spacing.md,
      textAlign: 'center',
    },
    submit: { marginTop: spacing.lg },
    demoEndpointText: {
      color: 'rgba(226,239,247,0.66)',
      fontSize: 10,
      fontWeight: '700',
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    demoLogin: { marginTop: spacing.sm },
    demoRoleRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    demoRoleBtn: {
      flex: 1,
    },
    link: { alignSelf: 'center', marginTop: spacing.md, padding: spacing.xs },
    linkText: { color: '#69D9F3', fontSize: typography.label, fontWeight: '700' },
    contactCard: {
      alignItems: 'center',
      backgroundColor: 'rgba(255,255,255,0.055)',
      borderColor: 'rgba(255,255,255,0.11)',
      borderRadius: 17,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 11,
      maxWidth: 470,
      marginTop: spacing.lg,
      padding: 12,
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
    clearCode: { marginTop: spacing.md, padding: spacing.sm },
    clearCodeDisabled: { opacity: 0.45 },
    clearCodeText: { color: 'rgba(255,255,255,0.64)', fontSize: typography.caption },
    clearCodeStrong: { color: c.white, fontWeight: '800' },
    securityNote: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 5,
      marginTop: 2,
    },
    securityNoteText: {
      color: 'rgba(255,255,255,0.4)',
      fontSize: 9,
      fontWeight: '600',
    },
  });
