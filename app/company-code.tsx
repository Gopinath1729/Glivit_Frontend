import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { z } from 'zod';

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AuthScreenShell, authPalette as AUTH } from '@/src/components/ui/AuthScreenShell';
import { Button } from '@/src/components/ui/Button';
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
import { ForcedScheme } from '@/src/theme/ThemeProvider';

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
  const router = useRouter();
  const dispatch = useAppDispatch();
  const styles = React.useMemo(() => makeStyles(), []);
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
    <ForcedScheme scheme="light">
      <AuthScreenShell
        eyebrow="CONNECT THIS DEVICE"
        footer={
          <View style={styles.help}>
            <MaterialCommunityIcons color={AUTH.inkMuted} name="help-circle-outline" size={13} />
            <Text style={styles.helpText}>
              Your administrator or service provider issues this code.
            </Text>
          </View>
        }
        subtitle="Enter the code that links this app to your organization's fleet account."
        title="Enter company code">
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
                // Clear both React Hook Form's message and the last mutation
                // result as soon as the operator changes the value.
                clearErrors('companyCode');
                resetResolveTenant();
                onChange(normalizeCompanyCodeInput(text));
              }}
              onSubmitEditing={onSubmit}
              placeholder="e.g. ACME01"
              returnKeyType="go"
              value={value}
            />
          )}
        />
        <Button label="Continue" loading={isLoading} onPress={onSubmit} />
      </AuthScreenShell>
    </ForcedScheme>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    help: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    helpText: { color: AUTH.inkMuted, fontSize: 11.5, fontWeight: '600' },
  });
