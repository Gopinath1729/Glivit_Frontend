import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/src/components/ui/Button';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useGetAllDevicesQuery,
  useIssueIngestTokenMutation,
} from '@/src/services/devicesApi';
import {
  currentStats,
  isTracking,
  requestTrackingPermission,
  startTracking,
  stopTracking,
  type TrackerAccuracy,
  type TrackerStats,
} from '@/src/services/phoneTracker';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

/**
 * Tracker mode — use this phone as the GPS device.
 *
 * Pick a registered device, take its ingestion token, and stream this phone's
 * fixes to the same endpoint a hardware tracker posts to. Useful for testing
 * the whole pipeline without hardware.
 */
export default function TrackerModeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const devices = useGetAllDevicesQuery();
  const [issueToken, issueTokenState] = useIssueIngestTokenMutation();

  const [selected, setSelected] = useState<DeviceSummary | null>(null);
  const [accuracy, setAccuracy] = useState<TrackerAccuracy>('high');
  const [running, setRunning] = useState(isTracking());
  const [stats, setStats] = useState<TrackerStats>(currentStats());
  const [starting, setStarting] = useState(false);

  // Tracking outlives this screen's mount, so re-entering it has to pick the
  // session back up rather than show a stopped tracker that is in fact running.
  useEffect(() => {
    setRunning(isTracking());
    setStats(currentStats());
  }, []);

  const handleStart = useCallback(async () => {
    if (!selected) return;
    setStarting(true);
    try {
      const permission = await requestTrackingPermission();
      if (!permission.granted) {
        Alert.alert('Cannot start tracking', permission.message);
        return;
      }
      // Rotated per session on purpose: the token is shown once and this is the
      // only place that needs to hold it.
      const { ingestToken } = await issueToken(selected.id).unwrap();
      await startTracking({ ingestToken, accuracy, onStats: setStats });
      setRunning(true);
    } catch (error) {
      Alert.alert('Cannot start tracking', apiErrorMessage(error));
    } finally {
      setStarting(false);
    }
  }, [accuracy, issueToken, selected]);

  const handleStop = useCallback(async () => {
    await stopTracking();
    setRunning(false);
  }, []);

  const renderDevice = useCallback(
    ({ item }: { item: DeviceSummary }) => {
      const active = selected?.id === item.id;
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: active }}
          disabled={running}
          onPress={() => setSelected(item)}
          style={[styles.deviceRow, active && styles.deviceRowActive, running && styles.rowLocked]}>
          <MaterialCommunityIcons
            color={active ? c.primary : c.textMuted}
            name={active ? 'radiobox-marked' : 'radiobox-blank'}
            size={18}
          />
          <View style={styles.deviceIdentity}>
            <Text numberOfLines={1} style={styles.deviceName}>
              {item.name}
            </Text>
            <Text numberOfLines={1} style={styles.deviceImei}>
              IMEI {item.imei}
            </Text>
          </View>
          <Text style={styles.deviceCategory}>{item.category || 'GPS'}</Text>
        </Pressable>
      );
    },
    [c.primary, c.textMuted, running, selected?.id, styles]
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
          <MaterialCommunityIcons color={c.textPrimary} name="chevron-left" size={24} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Tracker mode</Text>
          <Text style={styles.headerSubtitle}>Send this phone&apos;s GPS as a device</Text>
        </View>
        <View style={[styles.liveBadge, running && { backgroundColor: hexToRgba(c.primary, 0.15) }]}>
          <View style={[styles.liveDot, { backgroundColor: running ? c.primary : c.textMuted }]} />
          <Text style={[styles.liveText, running && { color: c.primary }]}>
            {running ? 'LIVE' : 'IDLE'}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
        {running ? (
          <View style={styles.statsPanel}>
            <View style={styles.statsGrid}>
              <Stat label="Accepted" value={String(stats.sent)} styles={styles} />
              <Stat
                label="Rejected"
                value={String(stats.rejected)}
                styles={styles}
                tint={stats.rejected > 0 ? c.danger : undefined}
              />
              <Stat
                label="Speed"
                value={stats.lastFix ? `${stats.lastFix.speedKph} km/h` : '—'}
                styles={styles}
              />
              <Stat
                label="Accuracy"
                value={stats.lastFix ? `±${stats.lastFix.accuracyMeters} m` : '—'}
                styles={styles}
              />
            </View>
            {stats.lastFix ? (
              <Text style={styles.coordinates}>
                {stats.lastFix.latitude.toFixed(5)}, {stats.lastFix.longitude.toFixed(5)}
              </Text>
            ) : (
              <Text style={styles.coordinates}>Waiting for the first fix…</Text>
            )}
            {stats.lastError ? (
              <View style={styles.errorLine}>
                <MaterialCommunityIcons color={c.danger} name="alert-circle-outline" size={13} />
                <Text style={styles.errorText}>{stats.lastError}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <Text style={styles.sectionLabel}>Accuracy</Text>
        <View style={styles.segmented}>
          {(['balanced', 'high'] as TrackerAccuracy[]).map((value) => {
            const active = accuracy === value;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                disabled={running}
                key={value}
                onPress={() => setAccuracy(value)}
                style={[styles.segment, active && styles.segmentActive, running && styles.rowLocked]}>
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {value === 'high' ? 'High (3s)' : 'Balanced (8s)'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>
          Device{running ? ' — stop tracking to change' : ''}
        </Text>
        {devices.isLoading ? (
          <View style={styles.listState}>
            <ActivityIndicator color={c.primary} size="small" />
          </View>
        ) : devices.isError ? (
          <View style={styles.listState}>
            <Text style={styles.listStateText}>{apiErrorMessage(devices.error)}</Text>
          </View>
        ) : (devices.data?.length ?? 0) === 0 ? (
          <View style={styles.listState}>
            <Text style={styles.listStateText}>
              No devices registered. Create one under Management first.
            </Text>
          </View>
        ) : (
          <FlatList
            data={devices.data}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderDevice}
            scrollEnabled={false}
            style={styles.deviceList}
          />
        )}

        <Text style={styles.note}>
          Positions post to the same ingestion endpoint a hardware tracker uses, so the device&apos;s
          history, state and alerts behave exactly as they would in the field. Tracking stops when
          the app is backgrounded.
        </Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
        <Button
          label={running ? 'Stop tracking' : 'Start tracking'}
          disabled={!selected && !running}
          loading={starting || issueTokenState.isLoading}
          onPress={running ? handleStop : handleStart}
        />
      </View>
    </View>
  );
}

function Stat({
  label,
  value,
  styles,
  tint,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof makeStyles>;
  tint?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tint ? { color: tint } : null]}>{value}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    header: {
      alignItems: 'center',
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    backButton: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    headerSubtitle: { color: c.textMuted, fontSize: 11 },
    liveBadge: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
    },
    liveDot: { borderRadius: 999, height: 6, width: 6 },
    liveText: { color: c.textMuted, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6 },
    content: { gap: spacing.sm, padding: spacing.sm },
    statsPanel: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.sm,
      padding: spacing.sm,
    },
    statsGrid: { flexDirection: 'row', gap: spacing.sm },
    stat: { flex: 1, gap: 2 },
    statLabel: {
      color: c.textMuted,
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    statValue: {
      color: c.textPrimary,
      fontSize: typography.label,
      fontVariant: ['tabular-nums'],
      fontWeight: '800',
    },
    coordinates: {
      color: c.textSecondary,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    errorLine: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    errorText: { color: c.danger, flex: 1, fontSize: 11 },
    sectionLabel: {
      color: c.textMuted,
      fontSize: 9.5,
      fontWeight: '800',
      letterSpacing: 0.7,
      marginTop: spacing.xs,
      textTransform: 'uppercase',
    },
    segmented: { flexDirection: 'row', gap: 6 },
    segment: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: 'transparent',
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      paddingVertical: 7,
    },
    segmentActive: { backgroundColor: hexToRgba(c.primary, 0.13), borderColor: hexToRgba(c.primary, 0.4) },
    segmentText: { color: c.textSecondary, fontSize: 11.5, fontWeight: '700' },
    segmentTextActive: { color: c.primary },
    deviceList: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
    },
    deviceRow: {
      alignItems: 'center',
      borderBottomColor: c.divider,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      height: 48,
      paddingHorizontal: spacing.sm,
    },
    deviceRowActive: { backgroundColor: hexToRgba(c.primary, 0.07) },
    rowLocked: { opacity: 0.5 },
    deviceIdentity: { flex: 1, minWidth: 0 },
    deviceName: { color: c.textPrimary, fontSize: 13, fontWeight: '700' },
    deviceImei: { color: c.textMuted, fontSize: 10.5, fontVariant: ['tabular-nums'] },
    deviceCategory: { color: c.textMuted, fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },
    listState: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.sm,
      justifyContent: 'center',
      minHeight: 56,
      padding: spacing.sm,
    },
    listStateText: { color: c.textSecondary, fontSize: typography.caption, textAlign: 'center' },
    note: { color: c.textMuted, fontSize: 10.5, lineHeight: 15, marginTop: spacing.xs },
    footer: {
      backgroundColor: c.surface,
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.sm,
    },
  });
