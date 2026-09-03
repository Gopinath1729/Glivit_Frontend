import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeviceCreateForm } from '@/src/components/DeviceCreateForm';
import { MembersPanel } from '@/src/components/MembersPanel';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import {
  ManagementActionButton,
  ManagementBottomSheet,
  ManagementCard,
  ManagementSectionHeader,
} from '@/src/components/ui/ManagementPrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { P } from '@/src/constants/permissions';
import { apiErrorMessage } from '@/src/services/apiError';
import { resolveDeviceRecordState } from '@/src/services/deviceState';
import { useMobileGpsReadiness } from '@/src/services/mobileGpsStatus';
import {
  useDeleteDeviceMutation,
  useGetAllDevicesQuery,
  useGetDeviceQuery,
} from '@/src/services/devicesApi';
import { useHasPermission } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { DeviceSummary } from '@/src/types/api';

type ManagementTab = 'devices' | 'members';

/** Tenant administration for registered devices and member accounts. */
export default function ManagementScreen() {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const canCreate = useHasPermission(P.CREATE_DEVICE);
  const canManage = useHasPermission(P.MANAGE_DEVICES);
  const canDelete = useHasPermission(P.DELETE_DEVICE);
  const canManageMembers = useHasPermission(P.MANAGE_USERS);
  const [tab, setTab] = useState<ManagementTab>('devices');
  const readiness = useMobileGpsReadiness();
  const devices = useGetAllDevicesQuery(
    undefined,
    { pollingInterval: 30_000, skipPollingIfUnfocused: true }
  );
  const [deleteDevice] = useDeleteDeviceMutation();
  const [editing, setEditing] = useState<DeviceSummary | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  const deviceDetails = useGetDeviceQuery(editing?.id ?? 0, {
    skip: editing == null || !formVisible,
  });

  const openCreate = () => {
    setEditing(null);
    setFormVisible(true);
  };
  const openEdit = (device: DeviceSummary) => {
    setEditing(device);
    setFormVisible(true);
  };
  const closeForm = () => {
    setFormVisible(false);
    setEditing(null);
  };
  const remove = (device: DeviceSummary) => {
    Alert.alert(
      'Delete device permanently?',
      `This erases ${device.name} and ALL data related to it — its complete location history, trips, alerts, commands and documents. The vehicle is removed too if this was its only tracker.

This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: () => {
            void deleteDevice(device.id)
              .unwrap()
              .catch((error) => Alert.alert('Device not deleted', apiErrorMessage(error)));
          },
        },
      ]
    );
  };

  const tabStrip = canManageMembers ? (
    <View accessibilityRole="tablist" style={styles.tabStrip}>
      {(['devices', 'members'] as const).map((value) => {
        const active = tab === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={value}
            onPress={() => setTab(value)}
            style={({ pressed }) => [
              styles.tabItem,
              active && styles.tabItemActive,
              pressed && styles.tabItemPressed,
            ]}>
            <Text style={[styles.tabText, active && styles.tabTextActive]}>
              {value === 'devices' ? 'Devices' : 'Members'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  ) : null;

  if (canManageMembers && tab === 'members') {
    return (
      <View style={styles.screen}>
        {tabStrip}
        <MembersPanel />
      </View>
    );
  }

  const rows = devices.data ?? [];
  return (
    <View style={styles.screen}>
      {tabStrip}
      <ManagementSectionHeader
        createLabel="Create device"
        onCreate={canCreate ? openCreate : undefined}
        subtitle={`${rows.length} registered tracker${rows.length === 1 ? '' : 's'}`}
        title="Devices"
      />

      {devices.isLoading && !devices.data ? (
        <LoadingView label="Loading devices…" />
      ) : devices.isError && !devices.data ? (
        <ErrorRetryView message={apiErrorMessage(devices.error)} onRetry={devices.refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(insets.bottom, spacing.md) + 88 },
          ]}
          refreshControl={
            <RefreshControl
              onRefresh={devices.refetch}
              refreshing={devices.isFetching}
              tintColor={c.primary}
            />
          }
          showsVerticalScrollIndicator={false}>
          {rows.length === 0 ? (
            <EmptyView
              icon="access-point-off"
              message="Tap + to register a physical tracker or a mobile GPS tracker."
              title="No devices"
            />
          ) : (
            rows.map((device) => {
              const status = managementStatus(device, readiness);
              const tone = status === 'Active' ? c.success : stateColors.OFFLINE;
              const isMobile = device.sourceType === 'MOBILE_GPS';
              return (
                <ManagementCard key={device.id}>
                  <View style={styles.cardHeader}>
                    <View style={styles.identity}>
                      <View style={[styles.deviceIcon, { backgroundColor: `${tone}18` }]}>
                        <MaterialCommunityIcons
                          color={tone}
                          name={isMobile ? 'cellphone-marker' : 'access-point'}
                          size={23}
                        />
                      </View>
                      <View style={styles.identityText}>
                        <Text numberOfLines={1} style={styles.name}>
                          {device.name}
                        </Text>
                        <Text numberOfLines={1} style={styles.meta}>
                          {isMobile ? 'Mobile GPS Tracker' : 'Physical GPS Device'}
                        </Text>
                      </View>
                    </View>
                    <View style={[styles.badge, { backgroundColor: `${tone}18` }]}>
                      <View style={[styles.statusDot, { backgroundColor: tone }]} />
                      <Text style={[styles.badgeText, { color: tone }]}>{status}</Text>
                    </View>
                  </View>

                  <View style={styles.updatedRow}>
                    <MaterialCommunityIcons color={c.textMuted} name="clock-outline" size={14} />
                    <Text style={styles.updatedText}>Last updated {relativeAge(device.lastUpdate)}</Text>
                  </View>

                  {canManage || canDelete ? (
                    <View style={styles.actions}>
                      {canManage ? (
                        <ManagementActionButton
                          accessibilityLabel={`Edit ${device.name}`}
                          icon="pencil-outline"
                          label="Edit"
                          onPress={() => openEdit(device)}
                        />
                      ) : null}
                      {canDelete ? (
                        <ManagementActionButton
                          accessibilityLabel={`Delete ${device.name}`}
                          destructive
                          icon="trash-can-outline"
                          label="Delete"
                          onPress={() => remove(device)}
                        />
                      ) : null}
                    </View>
                  ) : null}
                </ManagementCard>
              );
            })
          )}
        </ScrollView>
      )}

      <ManagementBottomSheet
        maxHeightRatio={0.94}
        onClose={closeForm}
        title={editing ? 'Edit device' : 'Create device'}
        visible={formVisible}>
        {editing && deviceDetails.isFetching && !deviceDetails.currentData ? (
          <View style={styles.formLoading}>
            <ActivityIndicator color={c.primary} size="small" />
            <Text style={styles.formLoadingText}>Loading device details…</Text>
          </View>
        ) : (
          <KeyboardAwareForm
            applyBottomInset={false}
            contentContainerStyle={styles.form}
            contentSized>
            <DeviceCreateForm
              initialDevice={editing ? (deviceDetails.currentData ?? editing) : null}
              onSuccess={closeForm}
            />
          </KeyboardAwareForm>
        )}
      </ManagementBottomSheet>
    </View>
  );
}

/**
 * Management shows lifecycle, not motion, so it collapses the shared status
 * into three buckets — but off the SAME resolved value every other screen
 * renders, so a device cannot read Active here and Offline in the fleet list.
 */
/**
 * Management shows lifecycle, not motion, so it collapses the shared status
 * into two buckets — but off the SAME resolved value every other screen
 * renders, so a device cannot read Active here and Offline in the fleet list.
 */
function managementStatus(
  device: DeviceSummary,
  readiness: { deviceId: number | null; locationDisabled: boolean }
): 'Active' | 'Offline' {
  return resolveDeviceRecordState(device, readiness).offline ? 'Offline' : 'Active';
}

function relativeAge(value?: string | null): string {
  if (!value) return 'never';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    tabStrip: {
      backgroundColor: c.surface,
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm + 2,
    },
    tabItem: {
      borderBottomColor: 'transparent',
      borderBottomWidth: 3,
      justifyContent: 'center',
      minHeight: 46,
      paddingHorizontal: spacing.sm,
    },
    tabItemActive: { borderBottomColor: c.primary },
    tabItemPressed: { opacity: 0.7 },
    tabText: { color: c.textSecondary, fontSize: typography.body, fontWeight: '700' },
    tabTextActive: { color: c.primary, fontWeight: '800' },
    content: { gap: spacing.sm + 2, padding: spacing.md, paddingTop: spacing.sm + 2 },
    cardHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    identity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
    identityText: { flex: 1, minWidth: 0 },
    deviceIcon: {
      alignItems: 'center',
      borderRadius: radius.md,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    name: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    meta: { color: c.textMuted, fontSize: typography.caption, marginTop: 2 },
    badge: {
      alignItems: 'center',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 5,
      marginLeft: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    statusDot: { borderRadius: radius.pill, height: 6, width: 6 },
    badgeText: { fontSize: 10, fontWeight: '800' },
    updatedRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    updatedText: { color: c.textMuted, fontSize: typography.caption },
    actions: { flexDirection: 'row', gap: spacing.sm },
    form: { paddingBottom: spacing.sm },
    formLoading: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xl,
    },
    formLoadingText: { color: c.textSecondary, fontSize: typography.body },
  });
