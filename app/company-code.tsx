import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { Button } from '@/src/components/ui/Button';
import { GlivtLogo } from '@/src/components/GlivtLogo';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import { baseApi } from '@/src/services/baseApi';
import {
  normalizeCompanyCodeInput,
} from '@/src/services/tenantIdentity';
import { useResolveTenantMutation } from '@/src/services/tenantApi';
import { clearTenant, setTenant } from '@/src/store/authState';
import { useAppDispatch } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const schema = z.object({
  companyCode: z
    .string()
    .transform(normalizeCompanyCodeInput)
    .pipe(
      z
        .string()
        .min(2, 'Enter your company code')
        .max(64, 'Company code must be 64 characters or fewer')
    ),
});
type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

export default function CompanyCodeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [resolveTenant, { isLoading, reset: resetResolveTenant }] = useResolveTenantMutation();
  // React state does not update synchronously, so this closes the tiny window in
  // which two return-key events could start overlapping requests.
  const submitInFlight = React.useRef(false);

  const {
    control,
    handleSubmit,
    clearErrors,
    setError,
    formState: { errors },
  } = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { companyCode: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    const companyCode = normalizeCompanyCodeInput(values.companyCode);
    clearErrors('companyCode');
    // Mutation results are scoped to this hook instance. Resetting here drops a
    // previous failed result before a valid retry starts; the trigger below then
    // always sends a fresh request for the current normalized value.
    resetResolveTenant();
    try {
      if (__DEV__) {
        console.info('[company-code] resolving', {
          receivedCode: JSON.stringify(values.companyCode),
          normalizedCode: companyCode,
        });
      }
      const config = await resolveTenant(companyCode).unwrap();
      if (__DEV__) {
        console.info('[company-code] API response', {
          companyCode: config.companyCode,
          status: 200,
        });
      }
      // Invalidate the in-memory tenant immediately so an in-flight refresh or
      // cached query cannot repopulate data from the previous company.
      dispatch(clearTenant());
      baseApi.util.resetApiState();
      await authStorage.clearAll();
      await authStorage.saveTenant(config.companyCode, config);
      dispatch(setTenant({ companyCode: config.companyCode, tenantConfig: config }));
      router.replace('/login');
    } catch (err) {
      if (__DEV__) {
        const response = err as { status?: number | string };
        console.warn('[company-code] API response', {
          normalizedCode: companyCode,
          status: response?.status ?? 'UNKNOWN',
        });
      }
      setError('companyCode', { message: apiErrorMessage(err, 'Invalid company code') });
    } finally {
      submitInFlight.current = false;
    }
  });

  return (
    <View style={styles.flex}>
      {/* Bottom inset is already in the content padding below. */}
      <KeyboardAwareForm
        applyBottomInset={false}
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xl },
        ]}>
        <View style={{ marginBottom: spacing.lg }}>
          <GlivtLogo size={72} />
        </View>
        <Text style={styles.title}>Enter Company Code</Text>
        <Text style={styles.subtitle}>
          Provided by your service provider to connect this app to your account.
        </Text>

        <View style={styles.form}>
          <Controller
            control={control}
            name="companyCode"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextField
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!isLoading}
                error={errors.companyCode?.message}
                onBlur={onBlur}
                onChangeText={(text) => {
                  // Clear both React Hook Form's message and the last
                  // mutation result as soon as the operator changes the value.
                  clearErrors('companyCode');
                  resetResolveTenant();
                  onChange(normalizeCompanyCodeInput(text));
                }}
                placeholder="e.g. ACME01"
                returnKeyType="go"
                onSubmitEditing={onSubmit}
                value={value}
              />
            )}
          />
          <View style={styles.submit}>
            <Button label="Continue" loading={isLoading} onPress={onSubmit} />
          </View>
        </View>
      </KeyboardAwareForm>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: c.loginBackground },
    content: {
      alignItems: 'center',
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xxl,
    },
    title: {
      color: '#FFFFFF',
      fontSize: typography.h1,
      fontWeight: '800',
      letterSpacing: 0.3,
    },
    subtitle: {
      color: 'rgba(255,255,255,0.82)',
      fontSize: typography.body,
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    form: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth * 2,
      marginTop: spacing.xl,
      padding: spacing.lg,
      width: '100%',
    },
    submit: {
      marginTop: spacing.md,
    },
  });
