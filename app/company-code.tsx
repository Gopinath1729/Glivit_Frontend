import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { Button } from '@/src/components/ui/Button';
import { GlivtLogo } from '@/src/components/GlivtLogo';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import { baseApi } from '@/src/services/baseApi';
import { useResolveTenantMutation } from '@/src/services/tenantApi';
import { clearTenant, setTenant } from '@/src/store/authSlice';
import { useAppDispatch } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const schema = z.object({
  companyCode: z.string().trim().min(2, 'Enter your company code'),
});
type FormValues = z.infer<typeof schema>;

export default function CompanyCodeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [resolveTenant, { isLoading }] = useResolveTenantMutation();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { companyCode: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const config = await resolveTenant(values.companyCode).unwrap();
      // Invalidate the in-memory tenant immediately so an in-flight refresh or
      // cached query cannot repopulate data from the previous company.
      dispatch(clearTenant());
      dispatch(baseApi.util.resetApiState());
      await authStorage.clearAll();
      await authStorage.saveTenant(config.companyCode, config);
      dispatch(setTenant({ companyCode: config.companyCode, tenantConfig: config }));
      router.replace('/login');
    } catch (err) {
      setError('companyCode', { message: apiErrorMessage(err, 'Invalid company code') });
    }
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled">
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
                error={errors.companyCode?.message}
                onBlur={onBlur}
                onChangeText={onChange}
                placeholder="e.g. DEMO"
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
      </ScrollView>
    </KeyboardAvoidingView>
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
