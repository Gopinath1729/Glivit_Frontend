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

import { AiCommandCentrePanel } from '@/src/components/AiCommandCentrePanel';
import { P } from '@/src/constants/permissions';
import { useGetFleetMaintenanceQuery } from '@/src/services/aiApi';
import { useGetAllDevicesQuery } from '@/src/services/devicesApi';
import { useAcknowledgeEventMutation, useGetEventsQuery } from '@/src/services/operationsApi';
import { useAppDispatch, useAppSelector, useHasPermission } from '@/src/store/hooks';
import { markNotificationsRead } from '@/src/store/notificationsSlice';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { EventDto } from '@/src/types/api';

type Notification = {
  key: string;
  kind: 'event' | 'maintenance';
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

function relativeTime(iso?: string | null): { label: string; ms: number } {
  if (!iso) return { label: '-', ms: 0 };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { label: '-', ms: 0 };
  const diff = Date.now() - ms;
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

function riskTone(risk: string, c: ThemeColors): string {
  switch (risk?.toUpperCase()) {
    case 'CRITICAL':
    case 'HIGH':
      return c.danger;
    case 'MEDIUM':
      return c.warningOrange;
    default:
      return c.warning;
  }
}

/**
 * Notification bell + slide-in panel. Surfaces vehicle events and predictive
 * maintenance alerts (previously separate pages) in one place, with an unread
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
  const [tab, setTab] = useState<'alerts' | 'ai'>('alerts');
  const readKeys = useAppSelector((s) => s.notifications.readKeys);

  const { data: eventsPage, isFetching: eventsFetching, refetch: refetchEvents } =
    useGetEventsQuery({ page: 0, size: 30 }, { skip: !canView });
  const { data: maintenance, isFetching: maintFetching, refetch: refetchMaint } =
    useGetFleetMaintenanceQuery(undefined, { skip: !canView });
  const { data: devices } = useGetAllDevicesQuery(undefined, { skip: !canView });
  const [acknowledgeEvent] = useAcknowledgeEventMutation();

  const deviceNameById = useMemo(() => {
    const byId = new Map<number, string>();
    const byVehicle = new Map<number, { id: number; name: string }>();
    for (const d of devices ?? []) {
      byId.set(d.id, d.name);
      if (d.vehicleId != null) byVehicle.set(d.vehicleId, { id: d.id, name: d.name });
    }
    return { byId, byVehicle };
  }, [devices]);

  const notifications = useMemo<Notification[]>(() => {
    const items: Notification[] = [];
    for (const ev of (eventsPage?.content ?? []) as EventDto[]) {
      const key = `event:${ev.id}`;
      const { label, ms } = relativeTime(ev.serverTime ?? ev.deviceTime);
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
    for (const m of maintenance ?? []) {
      const key = `maint:${m.id}`;
      const match = m.vehicleId != null ? deviceNameById.byVehicle.get(m.vehicleId) : undefined;
      const { label, ms } = relativeTime(m.predictedFailureDate);
      items.push({
        key,
        kind: 'maintenance',
        icon: 'wrench-clock',
        tone: riskTone(m.riskLevel, c),
        title: `${m.riskLevel} maintenance risk`,
        vehicleName: m.vehicleName ?? match?.name ?? `Vehicle ${m.vehicleId}`,
        detail:
          m.predictedDaysRemaining != null
            ? `~${m.predictedDaysRemaining} days to service`
            : (m.recommendedActions?.[0] ?? m.reasoning ?? null),
        timeLabel: m.predictedFailureDate ? label : 'Predicted',
        sortTime: ms,
        read: Boolean(readKeys[key]),
        deviceId: match?.id,
        vehicleParamName: match?.name ?? m.vehicleName ?? '',
      });
    }
    return items.sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return b.sortTime - a.sortTime;
    });
  }, [c, deviceNameById, eventsPage?.content, maintenance, readKeys]);

  const unreadCount = notifications.reduce((n, item) => (item.read ? n : n + 1), 0);
  const loading = eventsFetching || maintFetching;

  const onOpen = (item: Notification) => {
    if (!item.read) {
      dispatch(markNotificationsRead([item.key]));
      if (item.kind === 'event' && item.eventId != null) {
        // Durably mark the event read on the server via the existing API.
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
              {tab === 'alerts' && unreadCount > 0 ? (
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

          <View style={styles.tabBar}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === 'alerts' }}
              onPress={() => setTab('alerts')}
              style={[styles.tab, tab === 'alerts' && styles.tabActive]}>
              <MaterialCommunityIcons
                color={tab === 'alerts' ? c.primary : c.textSecondary}
                name="bell-outline"
                size={16}
              />
              <Text style={[styles.tabText, tab === 'alerts' && styles.tabTextActive]}>
                Alerts{unreadCount > 0 ? ` · ${unreadCount}` : ''}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === 'ai' }}
              onPress={() => setTab('ai')}
              style={[styles.tab, tab === 'ai' && styles.tabActive]}>
              <MaterialCommunityIcons
                color={tab === 'ai' ? c.primary : c.textSecondary}
                name="brain"
                size={16}
              />
              <Text style={[styles.tabText, tab === 'ai' && styles.tabTextActive]}>AI Command Centre</Text>
            </Pressable>
          </View>

          <View style={styles.panelBody}>
            <View style={{ flex: 1, display: tab === 'ai' ? 'flex' : 'none' }}>
              <AiCommandCentrePanel onClose={() => setOpen(false)} />
            </View>
            <View style={{ flex: 1, display: tab === 'alerts' ? 'flex' : 'none' }}>
              <FlatList
                data={notifications}
                keyExtractor={(item) => item.key}
                contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.md }]}
                showsVerticalScrollIndicator={false}
                refreshing={loading}
                onRefresh={() => {
                  void refetchEvents();
                  void refetchMaint();
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
                    <View style={[styles.rowIcon, { backgroundColor: `${item.tone}22` }]}>
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
                            {item.kind === 'maintenance' ? 'View vehicle ›' : 'Track vehicle ›'}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  </Pressable>
                )}
              />
            </View>
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
    tabBar: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    tab: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    tabActive: { backgroundColor: c.accentSoft, borderColor: c.primary },
    tabText: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '800' },
    tabTextActive: { color: c.primary },
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
