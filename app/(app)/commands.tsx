import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { SearchableDropdown, type DropdownOption } from '@/src/components/ui/SearchableDropdown';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetAllDevicesQuery, useGetDeviceQuery } from '@/src/services/devicesApi';
import { useGetCommandsQuery, useSubmitCommandMutation } from '@/src/services/operationsApi';
import { useTheme } from '@/src/theme/ThemeProvider';
import type { CommandDto, DeviceDetail, DeviceSummary } from '@/src/types/api';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type CommandTone = 'safe' | 'danger';

type CommandAction = {
  type: string;
  label: string;
  hint: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  tone: CommandTone;
};

const COMMANDS: CommandAction[] = [
  { type: 'REQUEST_LOCATION', label: 'Locate', hint: 'Get current location', icon: 'crosshairs-gps', tone: 'safe' },
  { type: 'RESTART_TRACKER', label: 'Restart', hint: 'Restart device', icon: 'restart', tone: 'safe' },
  { type: 'LOCK', label: 'Lock', hint: 'Lock the vehicle', icon: 'lock-outline', tone: 'danger' },
  { type: 'UNLOCK', label: 'Unlock', hint: 'Unlock the vehicle', icon: 'lock-open-outline', tone: 'danger' },
  { type: 'ENGINE_CUT', label: 'Cut Engine', hint: 'Stop engine remotely', icon: 'engine-off-outline', tone: 'danger' },
  { type: 'ENGINE_RESTORE', label: 'Restore', hint: 'Restore the engine', icon: 'engine-outline', tone: 'danger' },
];

const DESTRUCTIVE = new Set(['LOCK', 'UNLOCK', 'ENGINE_CUT', 'ENGINE_RESTORE']);
const RECENT_ACTIVITY_PREVIEW = 4;

export default function CommandsScreen() {
  const { colors: c, stateColors } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { data: devices, isLoading: loadingDevices, refetch: refetchDevices } = useGetAllDevicesQuery();
  const { data, isLoading, isFetching, isError, error, refetch } = useGetCommandsQuery({ size: 50 });
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<number | null>(null);
  const [pendingCommand, setPendingCommand] = React.useState<string | null>(null);
  const [showAllActivity, setShowAllActivity] = React.useState(false);
  const [submitCommand] = useSubmitCommandMutation();

  const deviceList = React.useMemo(() => devices ?? [], [devices]);

  const dropdownOptions: DropdownOption[] = React.useMemo(() => {
    return deviceList.map((device) => {
      const label = device.vehicleName ? `${device.name} (${device.vehicleName})` : device.name;
      const subLabel = device.driverName ? `Driver: ${device.driverName}` : undefined;
      const searchTags = [device.name, device.vehicleName, device.driverName, device.imei].filter(Boolean) as string[];

      return {
        id: device.id,
        label,
        subLabel,
        dotColor: stateColors[device.state] ?? stateColors.NO_DATA,
        searchTags,
      };
    });
  }, [deviceList, stateColors]);

  const selected =
    deviceList.find((device) => device.id === selectedDeviceId) ?? deviceList[0] ?? null;

  const { data: selectedDeviceDetail, isLoading: loadingSelectedDetail } = useGetDeviceQuery(
    selected?.id ?? 0,
    { skip: !selected?.id }
  );

  React.useEffect(() => {
    if (selected && selectedDeviceId == null) setSelectedDeviceId(selected.id);
  }, [selected, selectedDeviceId]);

  const refreshAll = React.useCallback(() => {
    void refetch();
    void refetchDevices();
  }, [refetch, refetchDevices]);

  const submit = React.useCallback(
    async (command: CommandAction) => {
      if (!selected) return;
      const destructive = DESTRUCTIVE.has(command.type);
      const run = async () => {
        setPendingCommand(command.type);
        try {
          await submitCommand({
            deviceId: selected.id,
            commandType: command.type,
            confirmed: destructive,
            idempotencyKey: `${selected.id}-${command.type}-${Date.now()}`,
          }).unwrap();
        } catch (err) {
          Alert.alert('Command not submitted', apiErrorMessage(err));
        } finally {
          setPendingCommand(null);
        }
      };
      if (destructive) {
        Alert.alert(
          command.label,
          `${command.label} will be sent to ${selected.name}. Continue?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Send', style: 'destructive', onPress: () => void run() },
          ]
        );
        return;
      }
      await run();
    },
    [selected, submitCommand]
  );

  if (isLoading || loadingDevices) return <LoadingView label="Loading command centre…" />;
  if (isError || !data) return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refreshAll} />;

  const history = data.content;
  const visibleHistory = showAllActivity ? history : history.slice(0, RECENT_ACTIVITY_PREVIEW);

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={styles.list}
        data={visibleHistory}
        keyExtractor={(item) => String(item.id)}
        refreshControl={
          <RefreshControl refreshing={isFetching} onRefresh={refreshAll} tintColor={c.primary} />
        }
        ListHeaderComponent={
          <View style={styles.headerStack}>
            <Panel>
              <Text style={styles.title}>Command Centre</Text>
              <Text style={styles.subtitle}>
                Commands are idempotent, audited, and submitted only to tenant-owned devices.
              </Text>
            </Panel>

            <Panel>
              <SectionHeading icon="car-multiple" title="Select Vehicle" />
              {deviceList.length === 0 ? (
                <Text style={styles.emptyLine}>No devices are available for this tenant.</Text>
              ) : (
                <SearchableDropdown
                  placeholder="Search vehicle number, name, driver..."
                  emptyText="No matching vehicles found"
                  options={dropdownOptions}
                  selectedId={selectedDeviceId ?? undefined}
                  onSelect={(option) => {
                    if (option) {
                      setSelectedDeviceId(option.id);
                      refreshAll();
                    }
                  }}
                />
              )}
            </Panel>

            {selected ? (
              <SelectedVehiclePanel
                device={selected}
                deviceDetail={selectedDeviceDetail}
                isLoadingDetail={loadingSelectedDetail}
              />
            ) : null}

            <Panel>
              <SectionHeading icon="lightning-bolt" title="Quick Actions" />
              <ScrollView
                contentContainerStyle={styles.actionRow}
                horizontal
                showsHorizontalScrollIndicator={false}>
                {COMMANDS.map((command) => {
                  const busy = pendingCommand === command.type;
                  const danger = command.tone === 'danger';
                  const tint = danger ? c.danger : c.primary;
                  return (
                    <Pressable
                      accessibilityHint={command.hint}
                      accessibilityLabel={command.label}
                      accessibilityRole="button"
                      disabled={!selected || pendingCommand != null}
                      key={command.type}
                      onPress={() => void submit(command)}
                      style={[
                        styles.actionTile,
                        danger ? styles.actionTileDanger : styles.actionTileSafe,
                        (!selected || pendingCommand != null) && styles.actionTileDisabled,
                      ]}>
                      {busy ? (
                        <ActivityIndicator color={tint} size="small" />
                      ) : (
                        <MaterialCommunityIcons color={tint} name={command.icon} size={26} />
                      )}
                      <Text numberOfLines={1} style={[styles.actionLabel, { color: tint }]}>
                        {command.label}
                      </Text>
                      <Text numberOfLines={2} style={styles.actionHint}>
                        {command.hint}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </Panel>

            <View style={styles.activityHeader}>
              <SectionHeading icon="history" title="Recent Activity" />
              {history.length > RECENT_ACTIVITY_PREVIEW ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowAllActivity((current) => !current)}
                  style={styles.viewAll}>
                  <Text style={styles.viewAllText}>
                    {showAllActivity ? 'Show less' : 'View all'}
                  </Text>
                  <MaterialCommunityIcons
                    color={c.primary}
                    name={showAllActivity ? 'chevron-up' : 'chevron-right'}
                    size={18}
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyView
            icon="console-line"
            title="No commands yet"
            message="Submitted command history will appear here."
          />
        }
        renderItem={({ item }) => <ActivityRow command={item} devices={deviceList} />}
      />
    </View>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return <View style={styles.panel}>{children}</View>;
}

function SectionHeading({
  icon,
  title,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.sectionHeading}>
      <MaterialCommunityIcons color={c.primary} name={icon} size={20} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function SelectedVehiclePanel({
  device,
  deviceDetail,
  isLoadingDetail,
}: {
  device: DeviceSummary;
  deviceDetail?: DeviceDetail | null;
  isLoadingDetail?: boolean;
}) {
  const { colors: c, stateColors } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const stateColor = stateColors[device.state] ?? stateColors.NO_DATA;
  const immobilised = Boolean(device.immobilised || device.locked);

  const vehicleName =
    deviceDetail?.vehicleName ||
    deviceDetail?.driverName ||
    device.vehicleName ||
    device.name;

  return (
    <Panel>
      <SectionHeading icon="truck-outline" title="Selected Vehicle Details" />
      <View style={styles.detailGrid}>
        <DetailCell
          icon="car-info"
          label="Vehicle Name"
          value={isLoadingDetail && !vehicleName ? 'Loading...' : vehicleName}
          wide
        />
        <DetailCell icon="card-account-details-outline" label="Vehicle No." value={device.name} />
        <DetailCell icon="tag-outline" label="Category" value={device.category || 'Unknown'} />
        <DetailCell
          icon="signal"
          label="Status"
          value={device.state.replace(/_/g, ' ')}
          valueColor={stateColor}
          dotColor={stateColor}
        />
        <DetailCell
          icon="power"
          label="Ignition"
          value={device.ignition == null ? 'Unknown' : device.ignition ? 'On' : 'Off'}
          valueColor={device.ignition ? c.primary : undefined}
        />
        <DetailCell icon="speedometer" label="Speed" value={`${Math.round(device.speed)} km/h`} />
        <DetailCell icon="identifier" label="IMEI" value={device.imei || 'Unavailable'} />
        <DetailCell
          icon="clock-outline"
          label="Last Update"
          value={formatTime(device.lastUpdate)}
          wide
        />
        <DetailCell
          icon="map-marker-outline"
          label="Last Location"
          value={device.address || 'Unavailable'}
          wide
        />
      </View>
      {immobilised ? (
        <View style={styles.immobilisedBanner}>
          <MaterialCommunityIcons color={c.danger} name="shield-alert-outline" size={18} />
          <Text style={styles.immobilisedText}>
            {device.immobilised ? 'Engine cut is active' : 'Vehicle is locked'}
            {device.lastCommandAt ? ` • ${formatTime(device.lastCommandAt)}` : ''}
          </Text>
        </View>
      ) : null}
    </Panel>
  );
}

function DetailCell({
  dotColor,
  icon,
  label,
  value,
  valueColor,
  wide = false,
}: {
  dotColor?: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  value: string;
  valueColor?: string;
  wide?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={[styles.detailCell, wide && styles.detailCellWide]}>
      <MaterialCommunityIcons color={c.primary} name={icon} size={18} />
      <View style={styles.detailText}>
        <View style={styles.detailLabelRow}>
          <Text numberOfLines={1} style={styles.detailLabel}>
            {label}
          </Text>
          {dotColor ? <View style={[styles.detailDot, { backgroundColor: dotColor }]} /> : null}
        </View>
        <Text numberOfLines={1} style={[styles.detailValue, valueColor ? { color: valueColor } : null]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function ActivityRow({ command, devices }: { command: CommandDto; devices: DeviceSummary[] }) {
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const device = devices.find((candidate) => candidate.id === command.deviceId);
  const tone = commandStatusColor(command.status, c);

  return (
    <Pressable
      accessibilityHint="Opens live tracking for this vehicle"
      accessibilityLabel={`${command.commandType} on ${device?.name ?? `device ${command.deviceId}`}, ${command.status}`}
      accessibilityRole="button"
      disabled={!device}
      onPress={() =>
        device
          ? router.push({
              pathname: '/live-track',
              params: { deviceId: String(device.id), name: device.name, subtitle: device.address ?? '' },
            })
          : undefined
      }
      style={styles.activityRow}>
      <View style={styles.activityIcon}>
        <MaterialCommunityIcons color={c.info} name="console" size={20} />
      </View>
      <View style={styles.activityBody}>
        <Text numberOfLines={1} style={styles.activityTitle}>
          {command.commandType}
        </Text>
        <Text numberOfLines={1} style={styles.activityMeta}>
          {device?.name ?? `Device #${command.deviceId}`}
        </Text>
        {command.responseMessage ? (
          <Text numberOfLines={1} style={styles.activityResponse}>
            {command.responseMessage}
          </Text>
        ) : null}
      </View>
      <View style={styles.activityRight}>
        <View style={[styles.statusBadge, { backgroundColor: `${tone}1F`, borderColor: `${tone}55` }]}>
          <View style={[styles.statusDot, { backgroundColor: tone }]} />
          <Text numberOfLines={1} style={[styles.statusText, { color: tone }]}>
            {command.status}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.activityTime}>
          {formatTime(command.requestedAt)}
        </Text>
      </View>
      {device ? (
        <MaterialCommunityIcons color={c.textMuted} name="chevron-right" size={20} />
      ) : null}
    </Pressable>
  );
}

function commandStatusColor(status: CommandDto['status'], c: ThemeColors) {
  switch (status) {
    case 'ACKNOWLEDGED':
    case 'DELIVERED':
      return c.primary;
    case 'FAILED':
    case 'TIMED_OUT':
      return c.danger;
    case 'SENT':
      return c.warningOrange;
    default:
      return c.info;
  }
}

function formatTime(iso?: string | null) {
  if (!iso) return 'Unavailable';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : date.toLocaleString([], {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    list: { gap: spacing.sm, padding: spacing.md, paddingBottom: spacing.xl },
    headerStack: { gap: spacing.md, marginBottom: spacing.sm },
    panel: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.md,
      padding: spacing.md,
    },
    title: { color: c.textPrimary, fontSize: typography.h2, fontWeight: '900' },
    subtitle: {
      color: c.textSecondary,
      fontSize: typography.caption,
      lineHeight: 18,
      marginTop: -spacing.sm,
    },
    emptyLine: { color: c.textMuted, fontSize: typography.caption },
    sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    sectionTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '800' },

    // Select Vehicle — search bar + scrollable grid (Removed unused styles)

    // Selected Vehicle Details
    detailGrid: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
      padding: spacing.md,
    },
    detailCell: { flexBasis: '46%', flexDirection: 'row', flexGrow: 1, gap: spacing.sm, minWidth: 0 },
    detailCellWide: { flexBasis: '100%' },
    detailText: { flex: 1, minWidth: 0 },
    detailLabelRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    detailLabel: { color: c.textMuted, flexShrink: 1, fontSize: 11, fontWeight: '700' },
    detailDot: { borderRadius: 4, height: 7, width: 7 },
    detailValue: {
      color: c.textPrimary,
      fontSize: typography.label,
      fontWeight: '800',
      marginTop: 2,
    },
    immobilisedBanner: {
      alignItems: 'center',
      backgroundColor: 'rgba(220,38,38,0.10)',
      borderColor: 'rgba(220,38,38,0.35)',
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.sm,
    },
    immobilisedText: { color: c.danger, flex: 1, fontSize: typography.caption, fontWeight: '800' },

    // Quick Actions — a scroll row so tiles keep a readable size on any width.
    actionRow: { gap: spacing.sm, paddingRight: spacing.sm },
    actionTile: {
      alignItems: 'center',
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: 5,
      justifyContent: 'center',
      minHeight: 112,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
      width: 108,
    },
    actionTileSafe: { backgroundColor: c.accentSoft, borderColor: c.accent },
    actionTileDanger: {
      backgroundColor: 'rgba(220,38,38,0.10)',
      borderColor: 'rgba(220,38,38,0.35)',
    },
    actionTileDisabled: { opacity: 0.45 },
    actionLabel: { fontSize: typography.label, fontWeight: '900' },
    actionHint: {
      color: c.textSecondary,
      fontSize: 11,
      lineHeight: 14,
      textAlign: 'center',
    },

    // Recent Activity
    activityHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xs,
    },
    viewAll: { alignItems: 'center', flexDirection: 'row', gap: 2 },
    viewAllText: { color: c.primary, fontSize: typography.label, fontWeight: '800' },
    activityRow: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    activityIcon: {
      alignItems: 'center',
      backgroundColor: 'rgba(37,99,235,0.12)',
      borderRadius: radius.sm,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    activityBody: { flex: 1, minWidth: 0 },
    activityTitle: { color: c.textPrimary, fontSize: typography.label, fontWeight: '800' },
    activityMeta: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    activityResponse: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    activityRight: { alignItems: 'flex-end', gap: 5 },
    statusBadge: {
      alignItems: 'center',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    statusDot: { borderRadius: 4, height: 7, width: 7 },
    statusText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
    activityTime: { color: c.textMuted, fontSize: 11, fontWeight: '600' },
  });
