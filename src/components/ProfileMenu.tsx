import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInUp, FadeOut } from 'react-native-reanimated';

import { AppDialog } from '@/src/components/ui/AppDialog';
import { useLogoutMutation } from '@/src/services/authApi';
import { authStorage } from '@/src/services/authStorage';
import { baseApi } from '@/src/services/baseApi';
import { closeLivePositionStream } from '@/src/services/livePositionStream';
import { useGetProfileImageQuery } from '@/src/services/operationsApi';
import { stopTracking } from '@/src/services/phoneTracker';
import { clearSession } from '@/src/store/authState';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { liveVehiclesCleared } from '@/src/store/liveVehiclesState';
import { clearActiveTenant } from '@/src/store/tenantState';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, type ThemeColors } from '@/src/theme/tokens';

const PROFILE_IMG_KEY = 'glivt.profile.imageUri';

type ProfileMenuProps = {
  /** Distance from the top of the window to the bottom of the app bar. */
  anchorTop: number;
  onClose: () => void;
  visible: boolean;
};

/**
 * The account menu, anchored under the avatar.
 *
 * <p>This replaced a full-screen modal panel that dimmed the whole app and
 * re-stated the user's name, role, ID and a link already reachable from the
 * bar itself - a lot of ceremony for its one real action. Signing out is the
 * only thing here, so the surface is sized to that: a small card that hangs off
 * the avatar it was opened from, close enough that the tap and the result are
 * obviously connected.
 */
export function ProfileMenu({ anchorTop, onClose, visible }: ProfileMenuProps) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const user = useAppSelector((s) => s.auth.user);

  const [logout] = useLogoutMutation();
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [profileUri, setProfileUri] = React.useState<string | null>(null);

  const { data: dbProfileImage } = useGetProfileImageQuery(undefined, { skip: !user?.id });

  React.useEffect(() => {
    SecureStore.getItemAsync(PROFILE_IMG_KEY)
      .then((uri) => {
        if (uri) setProfileUri(uri);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!dbProfileImage) return;
    setProfileUri(dbProfileImage);
    SecureStore.setItemAsync(PROFILE_IMG_KEY, dbProfileImage).catch(() => {});
  }, [dbProfileImage]);

  const displayName = user?.name ?? user?.username ?? 'Fleet user';
  const roleLabel = (user?.role ?? 'MEMBER')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const initials = displayName.substring(0, 2).toUpperCase();

  const performLogout = React.useCallback(async () => {
    setBusy(true);
    try {
      await logout().unwrap();
    } catch {
      // Best effort: a server that will not answer must not strand the user
      // in a session they have already asked to leave.
    }
    await stopTracking().catch(() => undefined);
    // The live position stream is shared across screens and reference counted,
    // so a screen unmounting is not enough to close it. Logging out has to
    // close it explicitly, or the old session keeps an authenticated stream
    // open and the next login sees two.
    closeLivePositionStream();
    dispatch(liveVehiclesCleared());
    dispatch(clearSession());
    dispatch(clearActiveTenant());
    baseApi.util.resetApiState();
    await authStorage.clearSession().catch(() => undefined);
    setBusy(false);
    setConfirming(false);
    onClose();
    router.replace('/login');
  }, [dispatch, logout, onClose, router]);

  return (
    <>
      <Modal
        animationType="none"
        onRequestClose={onClose}
        statusBarTranslucent
        transparent
        visible={visible}>
        <Animated.View
          entering={FadeIn.duration(120)}
          exiting={FadeOut.duration(120)}
          style={styles.backdrop}>
          <Pressable
            accessibilityLabel="Close account menu"
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
          <Animated.View
            entering={FadeInUp.duration(160).springify().damping(19).stiffness(230)}
            exiting={FadeOut.duration(110)}
            style={[styles.card, { top: anchorTop + 6 }]}>
            {/* The notch ties the card to the avatar it dropped out of. */}
            <View style={styles.notch} />
            <View style={styles.identity}>
              {profileUri ? (
                <Image contentFit="cover" source={{ uri: profileUri }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarInitials}>{initials}</Text>
                </View>
              )}
              <View style={styles.identityText}>
                <Text numberOfLines={1} style={styles.name}>
                  {displayName}
                </Text>
                <Text numberOfLines={1} style={styles.role}>
                  {roleLabel}
                </Text>
              </View>
            </View>

            <View style={styles.divider} />

            <Pressable
              accessibilityRole="button"
              onPress={() => setConfirming(true)}
              style={({ pressed }) => [styles.logout, pressed && styles.logoutPressed]}>
              <MaterialCommunityIcons color={c.danger} name="logout" size={18} />
              <Text style={styles.logoutText}>Logout</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      </Modal>

      <AppDialog
        busy={busy}
        cancelLabel="Cancel"
        confirmLabel="Logout"
        message={`You will be signed out of ${displayName}'s session on this device.`}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void performLogout()}
        title="Log out?"
        tone="danger"
        visible={confirming}
      />
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    backdrop: { backgroundColor: 'rgba(6, 15, 32, 0.32)', flex: 1 },
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      elevation: 14,
      paddingVertical: spacing.sm,
      position: 'absolute',
      right: spacing.md,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.2,
      shadowRadius: 20,
      width: 232,
    },
    notch: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderLeftWidth: StyleSheet.hairlineWidth * 2,
      borderTopWidth: StyleSheet.hairlineWidth * 2,
      height: 12,
      position: 'absolute',
      right: 18,
      top: -7,
      transform: [{ rotate: '45deg' }],
      width: 12,
    },
    identity: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md - 2,
      paddingVertical: spacing.xs,
    },
    avatar: { borderRadius: 999, height: 38, width: 38 },
    avatarFallback: { alignItems: 'center', backgroundColor: c.accentSoft, justifyContent: 'center' },
    avatarInitials: { color: c.primary, fontSize: 13, fontWeight: '900' },
    identityText: { flex: 1, minWidth: 0 },
    name: { color: c.textPrimary, fontSize: 14, fontWeight: '800' },
    role: { color: c.textMuted, fontSize: 11, marginTop: 1 },
    divider: {
      backgroundColor: c.border,
      height: StyleSheet.hairlineWidth,
      marginHorizontal: spacing.sm,
      marginVertical: spacing.xs + 2,
    },
    logout: {
      alignItems: 'center',
      borderRadius: radius.md,
      flexDirection: 'row',
      gap: spacing.sm,
      marginHorizontal: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    logoutPressed: { backgroundColor: c.surfaceAlt },
    logoutText: { color: c.danger, fontSize: 14, fontWeight: '800' },
  });
