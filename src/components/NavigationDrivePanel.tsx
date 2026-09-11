import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { DirectionsPanelStatus } from '@/src/components/DirectionsPanel';
import { PREMIUM_FLEET_MAP_PALETTE } from '@/src/services/mapStyle';
import type { NavigationRoute } from '@/src/services/navigationApi';
import { formatRouteDistance, formatRouteDuration } from '@/src/services/navigationMetrics';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, type ThemeColors } from '@/src/theme/tokens';

type Props = {
  bottom: number;
  canStart: boolean;
  remainingDistanceMeters: number | null;
  remainingDurationSeconds: number | null;
  rerouting: boolean;
  route: NavigationRoute;
  sharing: boolean;
  status: DirectionsPanelStatus;
  onCancel: () => void;
  onShare: () => void;
  onStart: () => void;
};

/** Compact trip controls kept available even when the directions editor is closed. */
export function NavigationDrivePanel({
  bottom,
  canStart,
  remainingDistanceMeters,
  remainingDurationSeconds,
  rerouting,
  route,
  sharing,
  status,
  onCancel,
  onShare,
  onStart,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const active = status === 'navigating';
  const distance = active && remainingDistanceMeters != null
    ? remainingDistanceMeters
    : route.distanceMeters;
  const duration = active && remainingDurationSeconds != null
    ? remainingDurationSeconds
    : route.durationSeconds;

  return (
    <View style={[styles.panel, { bottom }]}>
      <View style={styles.summary}>
        <Text style={styles.mode}>{rerouting ? 'Rerouting' : 'Drive'}</Text>
        <Text style={styles.metrics}>
          {rerouting
            ? 'Updating route…'
            : `${formatRouteDistance(distance)} · ${formatRouteDuration(duration)}`}
        </Text>
      </View>

      <Pressable
        accessibilityLabel={active ? 'Live navigation active' : 'Start navigation'}
        accessibilityRole="button"
        disabled={active || status === 'arrived' || !canStart}
        onPress={onStart}
        style={({ pressed }) => [
          styles.start,
          (active || status === 'arrived' || !canStart) && styles.disabled,
          pressed && styles.pressed,
        ]}>
        <MaterialCommunityIcons color="#FFFFFF" name="navigation-variant" size={20} />
        <Text style={styles.startText}>
          {status === 'arrived' ? 'Reached' : active ? 'Live' : 'Start'}
        </Text>
      </Pressable>

      <Pressable
        accessibilityLabel="Share live trip"
        accessibilityRole="button"
        disabled={sharing || rerouting || status === 'arrived'}
        onPress={onShare}
        style={({ pressed }) => [
          styles.iconButton,
          (sharing || rerouting) && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {sharing ? (
          <ActivityIndicator color={colors.textPrimary} size="small" />
        ) : (
          <MaterialCommunityIcons color={colors.textPrimary} name="share-variant-outline" size={23} />
        )}
      </Pressable>

      <Pressable
        accessibilityLabel="Cancel trip"
        accessibilityRole="button"
        onPress={onCancel}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <MaterialCommunityIcons color={colors.textPrimary} name="close" size={27} />
      </Pressable>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    panel: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 12,
      flexDirection: 'row',
      gap: 6,
      left: 10,
      minHeight: 76,
      paddingHorizontal: 10,
      paddingVertical: 10,
      position: 'absolute',
      right: 10,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.16,
      shadowRadius: 14,
      zIndex: 32,
    },
    summary: { flex: 1, minWidth: 62 },
    mode: { color: c.textPrimary, fontSize: 16, fontWeight: '900' },
    metrics: { color: c.textSecondary, fontSize: 10, fontWeight: '800', marginTop: 3 },
    start: {
      alignItems: 'center',
      backgroundColor: PREMIUM_FLEET_MAP_PALETTE.selectedRoute,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 6,
      height: 48,
      justifyContent: 'center',
      minWidth: 88,
      paddingHorizontal: 12,
    },
    startText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
    iconButton: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.78 },
  });
