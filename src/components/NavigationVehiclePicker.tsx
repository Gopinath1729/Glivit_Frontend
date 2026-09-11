import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { VehicleModelThumbnail } from '@/src/components/VehicleModelThumbnail';
import type { DeviceSummary } from '@/src/types/api';
import { vehicleBodyType } from '@/src/services/vehicleCategory';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, type ThemeColors } from '@/src/theme/tokens';

/**
 * Which vehicle is going to drive the route.
 *
 * Navigation used to bind silently to whichever device the phone itself was
 * registered as, which is right for a driver holding the phone and wrong for
 * everyone else: an operator planning a delivery is choosing a lorry, not
 * volunteering their own handset. The route is already on screen by the time
 * this opens, so the question is only ever "who takes it".
 */

export type NavigationVehicleOption = DeviceSummary & {
  latitude: number;
  longitude: number;
  /** Straight-line metres from the route's start, for ordering. */
  metresFromStart: number;
};

type Props = {
  visible: boolean;
  vehicles: NavigationVehicleOption[];
  /** The phone's own registered tracker, offered first when it is one of them. */
  ownDeviceId: number | null;
  onCancel: () => void;
  onSelect: (deviceId: number) => void;
};

function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '';
  return metres < 1000
    ? `${Math.round(metres)} m from start`
    : `${(metres / 1000).toFixed(1)} km from start`;
}

export function NavigationVehiclePicker({
  visible,
  vehicles,
  ownDeviceId,
  onCancel,
  onSelect,
}: Props) {
  const { colors, stateColors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Modal animationType="slide" onRequestClose={onCancel} transparent visible={visible}>
      <Pressable accessibilityLabel="Close vehicle picker" onPress={onCancel} style={styles.backdrop} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>START NAVIGATION</Text>
            <Text style={styles.title}>Which vehicle is driving?</Text>
          </View>
          <Pressable accessibilityLabel="Cancel" hitSlop={10} onPress={onCancel} style={styles.close}>
            <MaterialCommunityIcons color={colors.textSecondary} name="close" size={20} />
          </Pressable>
        </View>

        {vehicles.length === 0 ? (
          <View style={styles.empty}>
            <MaterialCommunityIcons color={colors.textMuted} name="car-off" size={30} />
            <Text style={styles.emptyText}>
              No vehicle is reporting a position right now. Navigation needs a live tracker to
              follow.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
            {vehicles.map((vehicle) => {
              const tone = stateColors[vehicle.state ?? 'NO_DATA'] ?? colors.textMuted;
              const body = vehicleBodyType(vehicle.category);
              const isOwn = ownDeviceId != null && vehicle.id === ownDeviceId;
              return (
                <Pressable
                  accessibilityHint="Starts navigation with this vehicle"
                  accessibilityLabel={`Navigate with ${vehicle.vehicleName || vehicle.name}`}
                  accessibilityRole="button"
                  key={vehicle.id}
                  onPress={() => onSelect(vehicle.id)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                  <View style={styles.thumb}>
                    <VehicleModelThumbnail body={body} />
                  </View>
                  <View style={styles.rowBody}>
                    <View style={styles.rowTitleLine}>
                      <Text numberOfLines={1} style={styles.rowTitle}>
                        {vehicle.vehicleName || vehicle.name || `Vehicle ${vehicle.id}`}
                      </Text>
                      {isOwn ? (
                        <View style={styles.ownBadge}>
                          <Text style={styles.ownBadgeText}>THIS PHONE</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.rowMetaLine}>
                      <View style={[styles.stateDot, { backgroundColor: tone }]} />
                      <Text numberOfLines={1} style={styles.rowMeta}>
                        {(vehicle.state ?? 'NO DATA').replace('_', ' ')}
                        {vehicle.metresFromStart >= 0
                          ? ` · ${formatDistance(vehicle.metresFromStart)}`
                          : ''}
                      </Text>
                    </View>
                  </View>
                  <MaterialCommunityIcons
                    color={colors.primary}
                    name="navigation-variant"
                    size={22}
                  />
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,20,30,0.45)' },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      bottom: 0,
      elevation: 24,
      left: 0,
      maxHeight: '74%',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      position: 'absolute',
      right: 0,
      shadowColor: '#06141E',
      shadowOffset: { height: -8, width: 0 },
      shadowOpacity: 0.22,
      shadowRadius: 22,
    },
    grabber: {
      alignSelf: 'center',
      backgroundColor: c.border,
      borderRadius: 999,
      height: 4,
      marginBottom: spacing.sm,
      width: 40,
    },
    header: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
    headerText: { flex: 1 },
    eyebrow: {
      color: c.primary,
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.3,
    },
    title: { color: c.textPrimary, fontSize: 18, fontWeight: '900', marginTop: 2 },
    close: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: 999,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    list: { gap: spacing.sm, paddingBottom: spacing.sm, paddingTop: spacing.md },
    row: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.sm,
    },
    rowPressed: { opacity: 0.72 },
    thumb: {
      alignItems: 'center',
      backgroundColor: hexToRgba(c.primary, 0.08),
      borderRadius: radius.md,
      height: 54,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 72,
    },
    rowBody: { flex: 1, gap: 3 },
    rowTitleLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    rowTitle: { color: c.textPrimary, flexShrink: 1, fontSize: 15, fontWeight: '800' },
    ownBadge: {
      backgroundColor: hexToRgba(c.primary, 0.14),
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    ownBadgeText: { color: c.primary, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
    rowMetaLine: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    stateDot: { borderRadius: 999, height: 7, width: 7 },
    rowMeta: { color: c.textSecondary, flexShrink: 1, fontSize: 11.5, fontWeight: '700' },
    empty: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xl,
    },
    emptyText: {
      color: c.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
  });
