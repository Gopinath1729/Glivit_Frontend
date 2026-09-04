import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PressableScale } from '@/src/components/ui/Motion';
import { resolveDeviceRecordState } from '@/src/services/deviceState';
import { useMobileGpsReadiness } from '@/src/services/mobileGpsStatus';
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
  onDelete,
  deleting = false,
  nowMs,
}: {
  device: DeviceSummary;
  onPress: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  /**
   * The clock the age column is measured against.
   *
   * Passed in rather than read from `Date.now()` inside the formatter so the
   * age is a function of props alone: a caller that wants the label to keep
   * counting up supplies a ticking value (see `useNowTick`), and the age of a
   * device that has stopped reporting climbs instead of freezing at "now".
   */
  nowMs?: number;
}) {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  // One shared calculation, the same one the map, live view and management
  // use — the row never re-derives a status of its own.
  const readiness = useMobileGpsReadiness();
  const resolved = resolveDeviceRecordState(device, readiness);
  const statusColor = stateColors[resolved.state] ?? stateColors.NO_DATA;
  const online = device.gpsValid && !resolved.offline;
  // The second line carries whichever locator is actually known. A blank line
  // reads as missing data, so the IMEI stands in when there is no address.
  const secondary = device.address?.trim() || `IMEI ${device.imei}`;

  return (
    <PressableScale
      haptic
      accessibilityRole="button"
      accessibilityLabel={`${device.name}, ${resolved.label}`}
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
          {resolved.label}
        </Text>
      </View>

      <Text numberOfLines={1} style={styles.age}>
        {formatAge(device.lastUpdate, nowMs)}
      </Text>

      {onDelete ? (
        <Pressable
          accessibilityLabel={`Delete ${device.name}`}
          accessibilityRole="button"
          disabled={deleting}
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          style={({ pressed }) => [
            styles.deleteButton,
            pressed && !deleting && styles.deleteButtonPressed,
            deleting && styles.deleteButtonDisabled,
          ]}>
          <MaterialCommunityIcons color={c.danger} name="trash-can-outline" size={17} />
        </Pressable>
      ) : null}
    </PressableScale>
  );
}

/** Compact relative age — the column is too narrow for a formatted timestamp. */
function formatAge(iso?: string | null, nowMs?: number) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const now = nowMs != null && Number.isFinite(nowMs) ? nowMs : Date.now();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
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
    deleteButton: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 30,
      justifyContent: 'center',
      width: 30,
    },
    deleteButtonPressed: { backgroundColor: hexToRgba(c.danger, 0.1) },
    deleteButtonDisabled: { opacity: 0.45 },
  });
