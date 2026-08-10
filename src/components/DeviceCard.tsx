import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PressableScale } from '@/src/components/ui/Motion';
import { StatusPill } from '@/src/components/ui/StatusPill';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const CATEGORY_ICON: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  CAR: 'car',
  TRUCK: 'truck',
  BUS: 'bus',
  MIXER_TRUCK: 'truck-cargo-container',
  BIKE: 'motorbike',
  HEAVY_MACHINERY: 'excavator',
  GPS_DEVICE: 'crosshairs-gps',
  GPS: 'crosshairs-gps',
};

export function DeviceCard({ device, onPress }: { device: DeviceSummary; onPress: () => void }) {
  const { colors: c, elevation } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const online = device.gpsValid && device.state !== 'NO_DATA' && device.state !== 'INACTIVE';
  return (
    <PressableScale
      haptic
      accessibilityRole="button"
      accessibilityLabel={device.name}
      onPress={onPress}
      style={[styles.card, elevation(1)]}>
      <View style={styles.iconWrap}>
        <MaterialCommunityIcons
          color={c.primary}
          name={CATEGORY_ICON[device.category] ?? 'crosshairs-gps'}
          size={28}
        />
        <View style={[styles.onlineDot, { backgroundColor: online ? c.primaryGreen : c.textMuted }]} />
      </View>

      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text numberOfLines={1} style={styles.name}>
            {device.name}
          </Text>
          <StatusPill state={device.state} />
        </View>
        <Text numberOfLines={1} style={styles.imei}>
          IMEI {device.imei}
        </Text>
        <Text numberOfLines={1} style={styles.address}>
          {device.address ?? 'Address unavailable'}
        </Text>
        <View style={styles.metaRow}>
          <Meta icon="speedometer" text={`${Math.round(device.speed)} km/h`} />
          <Meta icon="clock-outline" text={formatUpdate(device.lastUpdate)} />
        </View>
      </View>
    </PressableScale>
  );
}

function Meta({
  icon,
  text,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  text: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.meta}>
      <MaterialCommunityIcons color={c.textSecondary} name={icon} size={14} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

function formatUpdate(iso?: string | null) {
  if (!iso) return 'No data';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No data';
  return d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.md,
      padding: spacing.md,
    },
    iconWrap: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.md,
      height: 52,
      justifyContent: 'center',
      width: 52,
    },
    onlineDot: {
      borderColor: c.surface,
      borderRadius: 6,
      borderWidth: 2,
      bottom: -2,
      height: 12,
      position: 'absolute',
      right: -2,
      width: 12,
    },
    body: { flex: 1, minWidth: 0 },
    topRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
    name: { color: c.textPrimary, flex: 1, fontSize: typography.body, fontWeight: '800' },
    imei: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    address: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    metaRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
    meta: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    metaText: { color: c.textSecondary, fontSize: typography.caption },
  });
