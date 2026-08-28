import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PressableScale } from '@/src/components/ui/Motion';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

/**
 * One vehicle as a table row.
 *
 * Deliberately two fixed lines and a fixed height: an operator scanning a fleet
 * reads down a column, and rows that grow with their content break that column.
 * Anything that would need a third line belongs on the device profile instead.
 */
export const DEVICE_ROW_HEIGHT = 58;

const CATEGORY_ICON: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  CAR: 'car',
  TRUCK: 'truck',
  LORRY: 'truck',
  BUS: 'bus',
  VAN: 'van-utility',
  JEEP: 'car-estate',
  MIXER_TRUCK: 'truck-cargo-container',
  BIKE: 'motorbike',
  MOTORCYCLE: 'motorbike',
  SCOOTER: 'motorbike',
  AUTO: 'rickshaw',
  RICKSHAW: 'rickshaw',
  EXCAVATOR: 'excavator',
  HEAVY_MACHINERY: 'excavator',
  GPS_DEVICE: 'crosshairs-gps',
  GPS: 'crosshairs-gps',
};

export function DeviceRow({
  device,
  onPress,
}: {
  device: DeviceSummary;
  onPress: () => void;
}) {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const statusColor = stateColors[(device.state ?? '').toUpperCase()] ?? stateColors.NO_DATA;
  const online = device.gpsValid && device.state !== 'NO_DATA' && device.state !== 'INACTIVE';
  // The second line carries whichever locator is actually known. A blank line
  // reads as missing data, so the IMEI stands in when there is no address.
  const secondary = device.address?.trim() || `IMEI ${device.imei}`;

  return (
    <PressableScale
      haptic
      accessibilityRole="button"
      accessibilityLabel={`${device.name}, ${formatState(device.state)}`}
      onPress={onPress}
      style={styles.row}>
      {/* Status is carried by a spine rather than a pill: it reads as a column
          when the rows stack, and costs no horizontal room. */}
      <View style={[styles.spine, { backgroundColor: statusColor }]} />

      <View style={[styles.iconWrap, { backgroundColor: hexToRgba(statusColor, 0.12) }]}>
        <MaterialCommunityIcons
          color={statusColor}
          name={CATEGORY_ICON[device.category] ?? 'crosshairs-gps'}
          size={18}
        />
      </View>

      <View style={styles.identity}>
        <Text numberOfLines={1} style={styles.name}>
          {device.name}
        </Text>
        <View style={styles.secondaryLine}>
          {!online ? (
            <MaterialCommunityIcons color={c.textMuted} name="signal-off" size={11} />
          ) : null}
          <Text numberOfLines={1} style={styles.secondary}>
            {secondary}
          </Text>
        </View>
      </View>

      <View style={styles.metrics}>
        <Text style={[styles.speed, { color: device.speed > 0 ? c.textPrimary : c.textMuted }]}>
          {Math.round(device.speed)}
          <Text style={styles.unit}> km/h</Text>
        </Text>
        <Text numberOfLines={1} style={[styles.state, { color: statusColor }]}>
          {formatState(device.state)}
        </Text>
      </View>

      <Text numberOfLines={1} style={styles.age}>
        {formatAge(device.lastUpdate)}
      </Text>
    </PressableScale>
  );
}

function formatState(state: string) {
  const normalized = (state ?? '').toUpperCase();
  if (normalized === 'RUNNING' || normalized === 'MOVING') return 'Running';
  if (normalized === 'NO_DATA' || normalized === 'OFFLINE') return 'Offline';
  if (!normalized) return 'Offline';
  return normalized.charAt(0) + normalized.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** Compact relative age — the column is too narrow for a formatted timestamp. */
function formatAge(iso?: string | null) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 100 ? `${days}d` : '—';
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderBottomColor: c.divider,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      height: DEVICE_ROW_HEIGHT,
      paddingLeft: spacing.sm,
      paddingRight: spacing.md,
    },
    spine: {
      alignSelf: 'stretch',
      borderRadius: radius.pill,
      marginVertical: 10,
      width: 3,
    },
    iconWrap: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 34,
      justifyContent: 'center',
      width: 34,
    },
    identity: { flex: 1, gap: 2, minWidth: 0 },
    name: { color: c.textPrimary, fontSize: typography.label, fontWeight: '700' },
    secondaryLine: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    secondary: { color: c.textSecondary, flex: 1, fontSize: typography.caption },
    // Fixed width so the speed and status figures line up down the list.
    metrics: { alignItems: 'flex-end', gap: 2, width: 74 },
    speed: { fontSize: typography.label, fontVariant: ['tabular-nums'], fontWeight: '700' },
    unit: { color: c.textMuted, fontSize: 10, fontWeight: '600' },
    state: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
    age: {
      color: c.textMuted,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
      textAlign: 'right',
      width: 34,
    },
  });
