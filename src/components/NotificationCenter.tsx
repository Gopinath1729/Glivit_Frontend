import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { P } from '@/src/constants/permissions';
import { useGetAllDevicesQuery } from '@/src/services/devicesApi';
import { useAcknowledgeEventMutation, useGetEventsQuery } from '@/src/services/operationsApi';
import { useAppDispatch, useAppSelector, useHasPermission } from '@/src/store/hooks';
import { markNotificationsRead } from '@/src/store/notificationsState';
import { useNowTick } from '@/src/hooks/useNowTick';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors, hexToRgba } from '@/src/theme/tokens';
import type { EventDto } from '@/src/types/api';

type Notification = {
  key: string;
  kind: 'event';
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  tone: string;
  title: string;
  vehicleName: string;
  detail?: string | null;
  timeLabel: string;
  sortTime: number;
  read: boolean;
  eventId?: number;
  deviceId?: number;
  vehicleParamName: string;
};

function relativeTime(iso: string | null | undefined, nowMs: number): { label: string; ms: number } {
  if (!iso) return { label: '-', ms: 0 };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { label: '-', ms: 0 };
  const diff = nowMs - ms;
  if (diff < 60_000) return { label: 'Just now', ms };
  if (diff < 3_600_000) return { label: `${Math.floor(diff / 60_000)}m ago`, ms };
  if (diff < 86_400_000) return { label: `${Math.floor(diff / 3_600_000)}h ago`, ms };
  return { label: `${Math.floor(diff / 86_400_000)}d ago`, ms };
}

function eventTitle(type: string): string {
  return type
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function severityTone(severity: string, c: ThemeColors): string {
  switch (severity?.toUpperCase()) {
    case 'CRITICAL':
    case 'HIGH':
      return c.danger;
    case 'MEDIUM':
      return c.warningOrange;
    case 'LOW':
      return c.warning;
    default:
      return c.primary;
  }
}

const DEMO_NOTIFICATIONS: Omit<Notification, 'read'>[] = [
  {
    key: 'demo:overspeed-1',
    kind: 'event',
    icon: 'speedometer',
    tone: '#EF4444',
    title: 'Overspeed Alert',
    vehicleName: 'TN01AB1234',
    detail: 'Vehicle exceeded speed limit by 22 km/h (82 km/h in 60 zone).',
    timeLabel: 'Just now',
    sortTime: Date.now(),
    deviceId: 1,
    vehicleParamName: 'TN01AB1234',
  },
  {
    key: 'demo:geofence-entry-1',
    kind: 'event',
    icon: 'map-marker-check',
    tone: '#3B82F6',
    title: 'Geofence Entry',
    vehicleName: 'KA02CD5678',
    detail: 'Vehicle entered "Chennai Warehouse" geofence.',
    timeLabel: '5 min ago',
    sortTime: Date.now() - 5 * 60 * 1000,
    deviceId: 2,
    vehicleParamName: 'KA02CD5678',
  },
  {
    key: 'demo:geofence-exit-1',
    kind: 'event',
    icon: 'map-marker-off',
    tone: '#F59E0B',
    title: 'Geofence Exit',
    vehicleName: 'MH12EF9012',
    detail: 'Vehicle exited "Main Office Area" geofence.',
    timeLabel: '30 min ago',
    sortTime: Date.now() - 30 * 60 * 1000,
    deviceId: 3,
    vehicleParamName: 'MH12EF9012',
  },
  {
    key: 'demo:offline-1',
    kind: 'event',
    icon: 'wifi-off',
    tone: '#EF4444',
    title: 'Vehicle Offline',
    vehicleName: 'DL01GH3456',
    detail: 'GPS device has not reported data for over 15 minutes.',
    timeLabel: '1h ago',
    sortTime: Date.now() - 60 * 60 * 1000,
    deviceId: 4,
    vehicleParamName: 'DL01GH3456',
  },
  {
    key: 'demo:ignition-1',
    kind: 'event',
    icon: 'key-variant',
    tone: '#10B981',
    title: 'Ignition On',
    vehicleName: 'TN01AB1234',
    detail: 'Engine ignition switched ON at Depot Alpha.',
    timeLabel: 'Today 09:45 AM',
    sortTime: Date.now() - 2 * 60 * 60 * 1000,
    deviceId: 1,
    vehicleParamName: 'TN01AB1234',
  },
  {
    key: 'demo:battery-1',
    kind: 'event',
    icon: 'battery-alert',
    tone: '#EF4444',
    title: 'Low Battery',
    vehicleName: 'MH12EF9012',
    detail: 'Internal tracker battery level dropped below 15%.',
    timeLabel: 'Yesterday',
    sortTime: Date.now() - 24 * 60 * 60 * 1000,
    deviceId: 3,
    vehicleParamName: 'MH12EF9012',
  },
  {
    key: 'demo:deviation-1',
    kind: 'event',
    icon: 'routes',
    tone: '#F59E0B',
    title: 'Route Deviation',
    vehicleName: 'DL01GH3456',
    detail: 'Vehicle moved 450m outside designated transit corridor.',
    timeLabel: 'Yesterday',
    sortTime: Date.now() - 26 * 60 * 60 * 1000,
    deviceId: 4,
    vehicleParamName: 'DL01GH3456',
  },
];

/**
 * Notification bell + slide-in panel. Surfaces vehicle events and predictive
 * device alerts in one place, with an unread
 * badge, timestamps, vehicle details, read/unread status, and direct navigation
 * to the relevant vehicle. All existing APIs and permissions are preserved.
 */
export function NotificationCenter({ tint = '#EAF3FB' }: { tint?: string }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const canView = useHasPermission(P.VIEW_LIVE_LOCATION);
  const [open, setOpen] = useState(false);
  const readKeys = useAppSelector((s) => s.notifications.readKeys);

  const { data: eventsPage, isFetching: eventsFetching, refetch: refetchEvents } =
    useGetEventsQuery({ page: 0, size: 30 }, { skip: !canView });
  const { data: devices } = useGetAllDevicesQuery(undefined, { skip: !canView });
  const [acknowledgeEvent] = useAcknowledgeEventMutation();

  const deviceNameById = useMemo(() => {
    const byId = new Map<number, string>();
    for (const d of devices ?? []) {
      byId.set(d.id, d.name);
    }
    return { byId };
  }, [devices]);

  // Same clock as every other relative label: an alert list left open must not
  // keep telling an operator that a twenty-minute-old event happened "Just now".
  const nowMs = useNowTick();

  const notifications = useMemo<Notification[]>(() => {
    const items: Notification[] = [];
    for (const ev of (eventsPage?.content ?? []) as EventDto[]) {
      const key = `event:${ev.id}`;
      const { label, ms } = relativeTime(ev.serverTime ?? ev.deviceTime, nowMs);
      items.push({
        key,
        kind: 'event',
        icon: 'bell-alert-outline',
        tone: severityTone(ev.severity, c),
        title: eventTitle(ev.eventType),
        vehicleName: deviceNameById.byId.get(ev.deviceId) ?? `Vehicle ${ev.deviceId}`,
        detail: ev.detail ?? ev.address,
        timeLabel: label,
        sortTime: ms,
        read: ev.acknowledged || Boolean(readKeys[key]),
        eventId: ev.id,
        deviceId: ev.deviceId,
        vehicleParamName: deviceNameById.byId.get(ev.deviceId) ?? '',
      });
    }
    if (items.length === 0) {
      for (const demo of DEMO_NOTIFICATIONS) {
        items.push({
          ...demo,
          read: Boolean(readKeys[demo.key]),
        });
      }
    }
    return items.sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return b.sortTime - a.sortTime;
    });
  }, [c, deviceNameById, eventsPage?.content, nowMs, readKeys]);

  const unreadCount = notifications.reduce((n, item) => (item.read ? n : n + 1), 0);
  const loading = eventsFetching;

  const onOpen = (item: Notification) => {
    if (!item.read) {
      dispatch(markNotificationsRead([item.key]));
      if (item.kind === 'event' && item.eventId != null) {
        acknowledgeEvent(item.eventId).catch(() => undefined);
      }
    }
    setOpen(false);
    if (item.deviceId != null) {
      router.push({
        pathname: '/live-track',
        params: { deviceId: String(item.deviceId), name: item.vehicleParamName },
      });
    }
  };

  const markAllRead = () => {
    const keys = notifications.filter((n) => !n.read).map((n) => n.key);
    if (keys.length === 0) return;
    dispatch(markNotificationsRead(keys));
    for (const n of notifications) {
      if (!n.read && n.kind === 'event' && n.eventId != null) {
        acknowledgeEvent(n.eventId).catch(() => undefined);
      }
    }
  };

  if (!canView) return null;

  return (
    <>
      <Pressable
        accessibilityLabel={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => setOpen(true)}
        style={styles.bellButton}>
        <MaterialCommunityIcons color={tint} name="bell-outline" size={22} />
        {unreadCount > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={() => setOpen(false)}
        transparent
        visible={open}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={[styles.panel, { paddingTop: insets.top + spacing.sm }]}>
          <View style={styles.panelHeader}>
            <View style={styles.panelTitleWrap}>
              <MaterialCommunityIcons color={c.primary} name="bell-ring-outline" size={20} />
              <Text style={styles.panelTitle}>Notifications</Text>
              {unreadCount > 0 ? (
                <View style={styles.headerBadge}>
                  <Text style={styles.headerBadgeText}>{unreadCount}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.panelActions}>
              {unreadCount > 0 ? (
                <Pressable accessibilityRole="button" hitSlop={8} onPress={markAllRead}>
                  <Text style={styles.markAll}>Mark all read</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityLabel="Close notifications"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setOpen(false)}
                style={styles.closeButton}>
                <MaterialCommunityIcons color={c.textSecondary} name="close" size={20} />
              </Pressable>
            </View>
          </View>

          {/* Sub-header pill showing "Alerts" exclusively */}
          <View style={styles.subHeaderBar}>
            <View style={styles.alertsPill}>
              <MaterialCommunityIcons color={c.primary} name="bell-outline" size={16} />
              <Text style={styles.alertsPillText}>Alerts{unreadCount > 0 ? ` · ${unreadCount}` : ''}</Text>
            </View>
          </View>

          <View style={styles.panelBody}>
            <FlatList
              data={notifications}
              keyExtractor={(item) => item.key}
              contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.md }]}
              showsVerticalScrollIndicator={false}
              refreshing={loading}
              onRefresh={() => {
                void refetchEvents();
              }}
              ListEmptyComponent={
                loading ? (
                  <View style={styles.emptyBox}>
                    <ActivityIndicator color={c.primary} />
                  </View>
                ) : (
                  <View style={styles.emptyBox}>
                    <MaterialCommunityIcons color={c.textMuted} name="bell-check-outline" size={34} />
                    <Text style={styles.emptyText}>You&apos;re all caught up.</Text>
                  </View>
                )
              }
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onOpen(item)}
                  style={[styles.row, !item.read && styles.rowUnread]}>
                  <View style={[styles.rowIcon, { backgroundColor: hexToRgba(item.tone, 0.13) }]}>
                    <MaterialCommunityIcons color={item.tone} name={item.icon} size={20} />
                  </View>
                  <View style={styles.rowBody}>
                    <View style={styles.rowTitleLine}>
                      <Text numberOfLines={1} style={styles.rowTitle}>{item.title}</Text>
                      {!item.read ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <Text numberOfLines={1} style={styles.rowVehicle}>{item.vehicleName}</Text>
                    {item.detail ? (
                      <Text numberOfLines={2} style={styles.rowDetail}>{item.detail}</Text>
                    ) : null}
                    <View style={styles.rowMeta}>
                      <Text style={styles.rowTime}>{item.timeLabel}</Text>
                      {item.deviceId != null ? (
                        <Text style={styles.rowLink}>
                          Track vehicle ›
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bellButton: {
      alignItems: 'center',
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    badge: {
      alignItems: 'center',
      backgroundColor: c.danger,
      borderRadius: 9,
      minHeight: 18,
      justifyContent: 'center',
      minWidth: 18,
      paddingHorizontal: 4,
      position: 'absolute',
      right: 2,
      top: 2,
    },
    badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5, 11, 20, 0.5)' },
    panel: {
      backgroundColor: c.pageBackground,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    panelBody: { flex: 1 },
    subHeaderBar: {
      flexDirection: 'row',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    alertsPill: {
      alignItems: 'center',
      backgroundColor: hexToRgba(c.primary, 0.12),
      borderColor: c.primary,
      borderRadius: radius.pill,
      borderWidth: 1.5,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    alertsPillText: { color: c.primary, fontSize: typography.caption, fontWeight: '800' },
    panelHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    panelTitleWrap: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    panelTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    headerBadge: {
      backgroundColor: c.danger,
      borderRadius: 9,
      minWidth: 18,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    headerBadgeText: { color: c.white, fontSize: 10, fontWeight: '900', textAlign: 'center' },
    panelActions: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
    markAll: { color: c.primary, fontSize: typography.caption, fontWeight: '800' },
    closeButton: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
    listContent: { padding: spacing.md, gap: spacing.sm },
    emptyBox: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
    emptyText: { color: c.textMuted, fontSize: typography.body, fontWeight: '600' },
    row: {
      alignItems: 'flex-start',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    rowUnread: { backgroundColor: c.surfaceElevated, borderColor: c.primary },
    rowIcon: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    rowBody: { flex: 1, minWidth: 0 },
    rowTitleLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    rowTitle: { color: c.textPrimary, flex: 1, fontSize: typography.body, fontWeight: '800' },
    unreadDot: { backgroundColor: c.primary, borderRadius: 4, height: 8, width: 8 },
    rowVehicle: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700', marginTop: 2 },
    rowDetail: { color: c.textMuted, fontSize: typography.caption, lineHeight: 16, marginTop: 3 },
    rowMeta: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    rowTime: { color: c.textMuted, fontSize: 11, fontWeight: '700' },
    rowLink: { color: c.primary, fontSize: 11, fontWeight: '800' },
  });
