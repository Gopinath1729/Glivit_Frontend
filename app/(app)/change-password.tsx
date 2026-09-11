import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { useAppDialog } from '@/src/components/ui/useAppDialog';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import { useChangePasswordMutation } from '@/src/services/authApi';
import { normalizeCompanyCode } from '@/src/services/tenantIdentity';
import { setCredentials } from '@/src/store/authState';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { spacing, typography, type ThemeColors } from '@/src/theme/tokens';

/** Mirrors the server-side policy so the rule is visible before the round trip. */
const STRONG_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,72}$/;
const PASSWORD_RULE =
  'Use 12-72 characters with an uppercase letter, a lowercase letter, a number and a symbol.';

/**
 * Password rotation for a member who is already signed in.
 *
 * Deliberately separate from Forgot Password: this one asks for the current
 * password, which is what makes it safe to leave reachable from inside an open
 * session - someone who picks up an unlocked phone still cannot take the
 * account over. Forgot Password exists for the opposite case, where the member
 * does not know the current password at all.
 */
export default function ChangePasswordScreen() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const companyCode = useAppSelector((s) => s.auth.sessionCompanyCode ?? s.auth.companyCode);

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [changePassword, { isLoading }] = useChangePasswordMutation();
  const { dialogElement, notify } = useAppDialog();
  const busyRef = React.useRef(false);

  const mismatch = Boolean(confirmPassword) && confirmPassword !== newPassword;
  const sameAsCurrent = Boolean(newPassword) && newPassword === currentPassword;
  const canSubmit =
    Boolean(currentPassword) &&
    STRONG_PASSWORD.test(newPassword) &&
    newPassword === confirmPassword &&
    !sameAsCurrent;

  const submit = async () => {
    // Set synchronously, before the first await, so a double tap cannot send
    // the request twice while the loading flag is still catching up.
    if (busyRef.current || isLoading) return;
    busyRef.current = true;
    setFormError(null);
    try {
      if (!STRONG_PASSWORD.test(newPassword)) {
        setFormError(PASSWORD_RULE);
        return;
      }
      if (newPassword !== confirmPassword) {
        setFormError('New password and confirm password do not match.');
        return;
      }
      const result = await changePassword({
        currentPassword,
        newPassword,
        confirmPassword,
      }).unwrap();

      // Changing the password revokes every refresh token, this device's
      // included. The server hands back a fresh session so this screen keeps
      // working while other devices are forced to sign in again.
      const code = normalizeCompanyCode(companyCode ?? result.user.tenantCode ?? '');
      if (code) {
        await authStorage.saveSession({
          accessToken: result.accessToken,
          companyCode: code,
          refreshToken: result.refreshToken,
          user: result.user,
        });
        dispatch(
          setCredentials({
            accessToken: result.accessToken,
            companyCode: code,
            refreshToken: result.refreshToken,
            user: result.user,
          })
        );
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      notify({
        confirmLabel: 'Done',
        message: 'Your password has been updated. Other devices will need to sign in again.',
        onDismiss: () => router.back(),
        title: 'Password changed',
        tone: 'success',
      });
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not change your password.'));
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <KeyboardAwareForm contentContainerStyle={styles.content} style={styles.screen}>
      <Card style={styles.card}>
        <View style={styles.titleRow}>
          <MaterialCommunityIcons color={c.primary} name="lock-reset" size={22} />
          <Text style={styles.title}>Change Password</Text>
        </View>
        <Text style={styles.hint}>
          Enter your current password, then choose a new one. If you have forgotten your current
          password, sign out and use Forgot Password on the login screen instead.
        </Text>

        <TextField
          autoCapitalize="none"
          autoComplete="current-password"
          autoCorrect={false}
          label="Current Password"
          onChangeText={setCurrentPassword}
          placeholder="Current password"
          secure
          textContentType="password"
          value={currentPassword}
        />
        <View style={styles.gap} />
        <TextField
          autoCapitalize="none"
          autoComplete="new-password"
          autoCorrect={false}
          error={sameAsCurrent ? 'Choose a password different from your current one' : undefined}
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
          error={mismatch ? 'Passwords do not match' : undefined}
          label="Confirm New Password"
          onChangeText={setConfirmPassword}
          onSubmitEditing={submit}
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
            disabled={!canSubmit}
            label="Change Password"
            loading={isLoading}
            onPress={submit}
          />
        </View>
      </Card>
      {dialogElement}
    </KeyboardAwareForm>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xxl },
    card: { gap: spacing.xs, padding: spacing.md },
    titleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '800' },
    hint: {
      color: c.textSecondary,
      fontSize: typography.caption,
      lineHeight: 18,
      marginBottom: spacing.sm,
    },
    gap: { height: spacing.sm },
    formError: { color: c.danger, fontSize: typography.label, marginTop: spacing.sm },
    submit: { marginTop: spacing.md },
  });
