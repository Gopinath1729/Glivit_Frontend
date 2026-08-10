import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

/**
 * Full-screen blocking loader shown while the active tenant is being switched.
 *
 * Blocking is the point, not a side effect: until the switch commits, the screens
 * underneath still hold the previous tenant's data. Covering them means the user
 * never sees one tenant's vehicles or counts while another tenant is being loaded,
 * and cannot tap anything that would issue a request mid-switch.
 */
export function TenantSwitchOverlay({
  visible,
  tenantName,
}: {
  visible: boolean;
  tenantName?: string | null;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  return (
    <Modal animationType="fade" statusBarTranslucent transparent visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconHalo}>
            <MaterialCommunityIcons color={c.primary} name="office-building-cog-outline" size={34} />
          </View>
          <Text style={styles.title}>Switching tenant</Text>
          <Text style={styles.subtitle}>
            {tenantName
              ? `Loading ${tenantName} and reconnecting live tracking…`
              : 'Loading tenant data and reconnecting live tracking…'}
          </Text>
          <ActivityIndicator color={c.primary} size="large" style={styles.spinner} />
          <Text style={styles.hint}>Please keep the app open.</Text>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      alignItems: 'center',
      backgroundColor: c.overlay,
      flex: 1,
      justifyContent: 'center',
      padding: spacing.xl,
    },
    card: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth * 2,
      maxWidth: 360,
      padding: spacing.xl,
      width: '100%',
    },
    iconHalo: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      height: 68,
      justifyContent: 'center',
      marginBottom: spacing.md,
      width: 68,
    },
    title: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '900',
      textAlign: 'center',
    },
    subtitle: {
      color: c.textSecondary,
      fontSize: typography.caption,
      lineHeight: 18,
      marginTop: spacing.xs,
      textAlign: 'center',
    },
    spinner: { marginTop: spacing.lg },
    hint: {
      color: c.textMuted,
      fontSize: typography.caption,
      marginTop: spacing.md,
      textAlign: 'center',
    },
  });
