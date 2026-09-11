import { zodResolver } from '@hookform/resolvers/zod';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { z } from 'zod';

import { env } from '@/src/config/env';
import { AuthScreenShell, authPalette as AUTH } from '@/src/components/ui/AuthScreenShell';
import { Button } from '@/src/components/ui/Button';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import { useLoginMutation } from '@/src/services/authApi';
import { baseApi } from '@/src/services/baseApi';
import { normalizeCompanyCode } from '@/src/services/tenantIdentity';
import { clearTenant, setCredentials, setTenant } from '@/src/store/authState';
import { adoptSessionTenant, clearActiveTenant } from '@/src/store/tenantState';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { ForcedScheme } from '@/src/theme/ThemeProvider';
import { radius, spacing } from '@/src/theme/tokens';
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
  const router = useRouter();
  const dispatch = useAppDispatch();
  const styles = React.useMemo(() => makeStyles(), []);
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
    <ForcedScheme scheme="light">
      <AuthScreenShell
        eyebrow="FLEET COMMAND ACCESS"
        footer={
          <>
            {/* There is no public sign-up: an account exists only once a Tenant
                Admin has created it, so the second link activates an existing
                member rather than registering a new person. */}
            <View style={styles.linkRow}>
              <Pressable
                accessibilityRole="button"
                disabled={anyLoginLoading}
                onPress={() => router.push('/forgot-password')}
                style={styles.link}>
                <Text style={styles.linkText}>Forgot password?</Text>
              </Pressable>
              <View style={styles.linkDivider} />
              <Pressable
                accessibilityRole="button"
                disabled={anyLoginLoading}
                onPress={() => router.push('/activate-account')}
                style={styles.link}>
                <Text style={styles.linkText}>Activate account</Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: anyLoginLoading }}
              disabled={anyLoginLoading}
              onPress={clearCompanyCode}
              style={({ pressed }) => [
                styles.codeChip,
                pressed && !anyLoginLoading && styles.codeChipPressed,
                anyLoginLoading && styles.codeChipDisabled,
              ]}>
              <MaterialCommunityIcons color={AUTH.inkMuted} name="domain" size={13} />
              <Text style={styles.codeChipText}>
                {companyCode ?? '—'}
              </Text>
              <View style={styles.codeChipRule} />
              <Text style={styles.codeChipAction}>Change</Text>
            </Pressable>

            <View style={styles.securityNote}>
              <MaterialCommunityIcons color={AUTH.inkMuted} name="lock-check-outline" size={12} />
              <Text style={styles.securityNoteText}>Encrypted tenant-secured session</Text>
            </View>
          </>
        }
        /* A build compiled without an API host cannot reach anything, and every
           request inside it fails as a bare network error. Say so here: in a
           release build there is no console to read, and the cause is a
           build-time setting, not something the operator can fix by retrying. */
        notice={env.backendConfigurationError}
        subtitle={`Sign in to ${tenant?.name ?? 'Glivt Fleet Management'} to monitor every vehicle, route and alert in real time.`}
        title="Welcome back">
        <Controller
          control={control}
          name="email"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextField
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              error={errors.email?.message}
              importantForAutofill="yes"
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
              onSubmitEditing={onSubmit}
              placeholder="Password"
              returnKeyType="go"
              secure
              textContentType="password"
              value={value}
            />
          )}
        />

        {formError ? (
          <View style={styles.formError}>
            <MaterialCommunityIcons color="#B42318" name="alert-circle-outline" size={16} />
            <Text style={styles.formErrorText}>{formError}</Text>
          </View>
        ) : null}

        <Button
          disabled={anyLoginLoading}
          label="Sign in"
          loading={isLoading}
          onPress={onSubmit}
        />
      </AuthScreenShell>
    </ForcedScheme>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    linkRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    link: { paddingVertical: 2 },
    linkText: { color: AUTH.accent, fontSize: 13, fontWeight: '800' },
    linkDivider: { backgroundColor: AUTH.border, height: 13, width: StyleSheet.hairlineWidth * 2 },
    codeChip: {
      alignItems: 'center',
      backgroundColor: AUTH.card,
      borderColor: AUTH.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 7,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 3,
    },
    codeChipPressed: { backgroundColor: AUTH.accentSoft },
    codeChipDisabled: { opacity: 0.55 },
    codeChipText: {
      color: AUTH.ink,
      fontSize: 12,
      fontWeight: '900',
      letterSpacing: 0.6,
    },
    codeChipRule: { backgroundColor: AUTH.border, height: 12, width: StyleSheet.hairlineWidth * 2 },
    codeChipAction: { color: AUTH.accent, fontSize: 12, fontWeight: '800' },
    securityNote: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    securityNoteText: { color: AUTH.inkMuted, fontSize: 11, fontWeight: '600' },
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
