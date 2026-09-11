import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeviceCreateForm } from '@/src/components/DeviceCreateForm';
import { VehicleModelThumbnail } from '@/src/components/VehicleModelThumbnail';
import { PressableScale } from '@/src/components/ui/Motion';
import { ActionSheet, type ActionSheetItem } from '@/src/components/ui/ActionSheet';
import { CompactSearchBar } from '@/src/components/ui/CompactSearchBar';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { ListPagination } from '@/src/components/ui/ListPagination';
import { useAppDialog } from '@/src/components/ui/useAppDialog';
import {
  ManagementModal,
  ManagementCreateButton,
} from '@/src/components/ui/ManagementPrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useDeleteDeviceMutation,
  useGetAllDevicesQuery,
  useGetDeviceQuery,
} from '@/src/services/devicesApi';
import { resolveDeviceRecordState } from '@/src/services/deviceState';
import { useMobileGpsReadiness } from '@/src/services/mobileGpsStatus';
import { useNowTick } from '@/src/hooks/useNowTick';
import { dedupeByVehicle } from '@/src/services/vehicleIdentity';
import { vehicleBodyType, type VehicleBodyType } from '@/src/services/vehicleCategory';
import { P } from '@/src/constants/permissions';
import { useHasPermission } from '@/src/store/hooks';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

/** A fleet page is always ten vehicles; the page itself scrolls on short phones. */
const PAGE_SIZE = 10;

const STATE_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'Any status' },
  { key: 'RUNNING', label: 'Running' },
  { key: 'STOPPED', label: 'Stopped' },
  // Covers every non-reporting state, not just OFFLINE: a device that has
  // never reported (NO_DATA), one with no GPS fix, and an expired one all
  // belong here. The cards themselves name the specific reason.
  { key: 'OFFLINE', label: 'Not Reporting' },
];

const BODY_TABS: { key: '' | VehicleBodyType; label: string; icon: string }[] = [
  { key: '', label: 'All units', icon: 'view-grid-outline' },
  { key: 'CAR', label: 'Cars', icon: 'car' },
  { key: 'BIKE', label: 'Bikes', icon: 'motorbike' },
  { key: 'TRUCK', label: 'Trucks', icon: 'truck' },
];

/** The tile behind each vehicle's glyph — one wash per body type. */
const BODY_WASH: Record<VehicleBodyType, [string, string]> = {
  CAR: ['#E8F0FE', '#D2E3FC'],
  BIKE: ['#EDE9FE', '#DDD6FE'],
  TRUCK: ['#FEF3C7', '#FDE68A'],
};

/**
 * Vehicles: the fleet, its trackers, and the way into everything about one.
 *
 * <h3>One list, not a list and a detour</h3>
 * There used to be a Devices tab under Management listing the same hardware
 * under another name, and a vehicle details page you had to open before you
 * could reach Live or Playback. Both are gone. A card carries what an operator
 * checks at a glance — what it is, whether it is reporting, how fast, how long
 * ago, and where — and its three actions go straight to the screens that
 * actually do something: Live, Playback, Documents.
 *
 * Registering, configuring and deleting a tracker happen here too, on the
 * vehicle that has it, each gated on its own permission.
 */
export default function VehiclesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { state: stateFilter } = useLocalSearchParams<{ state?: string }>();
  const canDelete = useHasPermission(P.DELETE_DEVICE);
  const canCreate = useHasPermission(P.CREATE_DEVICE);
  const canManage = useHasPermission(P.MANAGE_DEVICES);

  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [body, setBody] = useState<'' | VehicleBodyType>('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [deletingVehicleId, setDeletingVehicleId] = useState<number | null>(null);
  const [manageTarget, setManageTarget] = useState<DeviceSummary | null>(null);
  const { confirm, dialogElement, notify } = useAppDialog();
  const [deleteDevice] = useDeleteDeviceMutation();
  const [editing, setEditing] = useState<DeviceSummary | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  // The list carries a summary; the form needs the full record. Fetched only
  // while the sheet that shows it is actually open.
  const deviceDetails = useGetDeviceQuery(editing?.id ?? 0, {
    skip: editing == null || !formVisible,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(rawSearch.trim());
      setPage(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [rawSearch]);

  useEffect(() => setPage(0), [stateFilter, body]);

  const { data, isLoading, isFetching, isError, error, refetch } = useGetAllDevicesQuery(
    { search: search || undefined },
    { pollingInterval: 30_000, skipPollingIfUnfocused: true }
  );

  // The age readout counts up on its own clock. Without this it is only
  // recomputed when the query data changes — so a vehicle that has stopped
  // reporting, whose data by definition stops changing, keeps displaying the
  // age it had when it was last fresh.
  const nowMs = useNowTick();

  // One card per vehicle: two trackers on the same vehicle are one vehicle.
  const allVehicles = useMemo(
    () => dedupeByVehicle(Array.isArray(data) ? data : []),
    [data]
  );

  // Chips, tabs and cards must agree, so all of them bucket the SAME resolved
  // status the card renders — not the raw server field, which can be a stale
  // RUNNING.
  const readiness = useMobileGpsReadiness();
  const bucketOf = useCallback(
    (vehicle: DeviceSummary) => stateBucket(resolveDeviceRecordState(vehicle, readiness).state),
    [readiness]
  );

  const byBody = useMemo(
    () => (body ? allVehicles.filter((v) => vehicleBodyType(v.category) === body) : allVehicles),
    [allVehicles, body]
  );
  const bodyCounts = useMemo(() => {
    const tally: Record<string, number> = { CAR: 0, BIKE: 0, TRUCK: 0 };
    for (const vehicle of allVehicles) tally[vehicleBodyType(vehicle.category)] += 1;
    return tally;
  }, [allVehicles]);
  const statusCounts = useMemo(() => {
    const tally: Record<string, number> = { RUNNING: 0, STOPPED: 0, OFFLINE: 0 };
    for (const vehicle of byBody) tally[bucketOf(vehicle)] += 1;
    return tally;
  }, [bucketOf, byBody]);

  const filteredVehicles = useMemo(
    () => (stateFilter ? byBody.filter((v) => bucketOf(v) === stateFilter) : byBody),
    [bucketOf, byBody, stateFilter]
  );

  const totalVehicles = filteredVehicles.length;
  const totalPages = Math.max(1, Math.ceil(totalVehicles / PAGE_SIZE));

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const visibleVehicles = useMemo(
    () => filteredVehicles.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [filteredVehicles, page]
  );

  const changePage = useCallback(
    (nextPage: number) => {
      const target = Math.max(0, Math.min(totalPages - 1, nextPage));
      void Haptics.selectionAsync().catch(() => undefined);
      setPage(target);
    },
    [totalPages]
  );

  const selectStatus = useCallback(
    (key: string) => {
      setPage(0);
      router.setParams({ state: key || undefined });
    },
    [router]
  );

  const openCreate = useCallback(() => {
    setEditing(null);
    setFormVisible(true);
  }, []);
  const openEdit = useCallback((vehicle: DeviceSummary) => {
    setEditing(vehicle);
    setFormVisible(true);
  }, []);
  const closeForm = useCallback(() => {
    setFormVisible(false);
    setEditing(null);
  }, []);

  /**
   * Every value is coerced to a defined string before it reaches the router.
   * `DeviceSummary` is typed as complete, but it is a network payload: a field
   * the API omitted arrives as `undefined`, and an undefined param throws
   * inside expo-router's URL builder — from an onPress handler, with no error
   * boundary above it, which exits the app rather than showing a broken screen.
   */
  const openLive = useCallback(
    (vehicle: DeviceSummary) => {
      router.push({
        pathname: '/live-track',
        params: {
          deviceId: String(vehicle.id),
          name: vehicleTitle(vehicle),
          subtitle: vehicle.address ?? '',
          category: vehicle.category ?? '',
        },
      });
    },
    [router]
  );

  const openPlayback = useCallback(
    (vehicle: DeviceSummary) => {
      if (!Number.isSafeInteger(vehicle.id) || vehicle.id <= 0) return;
      router.push({
        pathname: '/trip-playback',
        params: {
          deviceId: String(vehicle.id),
          imei: typeof vehicle.imei === 'string' ? vehicle.imei : '',
          name: vehicleTitle(vehicle),
          category: typeof vehicle.category === 'string' ? vehicle.category : '',
          model: '',
          speed: String(Number.isFinite(vehicle.speed) ? vehicle.speed : 0),
          heading: String(Number.isFinite(vehicle.course) ? vehicle.course : 0),
        },
      });
    },
    [router]
  );

  const openDocuments = useCallback(
    (vehicle: DeviceSummary) => {
      router.push({
        pathname: '/vehicle-documents',
        params: { id: String(vehicle.id), name: vehicleTitle(vehicle) },
      });
    },
    [router]
  );

  const confirmDeleteVehicle = useCallback(
    (vehicle: DeviceSummary) => {
      confirm({
        confirmLabel: 'Delete everything',
        message: `This erases ${vehicleTitle(vehicle)} and ALL data related to it — its tracker, complete location history, trips, alerts, commands and documents. This cannot be undone.`,
        onConfirm: async () => {
          setDeletingVehicleId(vehicle.id);
          try {
            await deleteDevice(vehicle.id).unwrap();
          } catch (caught) {
            notify({
              message: apiErrorMessage(caught),
              title: 'Vehicle not deleted',
              tone: 'danger',
            });
          } finally {
            setDeletingVehicleId(null);
          }
        },
        title: 'Delete vehicle permanently?',
        tone: 'danger',
      });
    },
    [confirm, deleteDevice, notify]
  );

  /** Edit and delete, off one unobtrusive control rather than two on every card. */
  const manageItems = useMemo<ActionSheetItem[]>(() => {
    if (!manageTarget) return [];
    const items: ActionSheetItem[] = [];
    if (canManage) {
      items.push({
        icon: 'cog-outline',
        label: 'Vehicle & tracker settings',
        onPress: () => openEdit(manageTarget),
      });
    }
    if (canDelete) {
      items.push({
        destructive: true,
        icon: 'trash-can-outline',
        label: 'Delete vehicle',
        onPress: () => confirmDeleteVehicle(manageTarget),
      });
    }
    return items;
  }, [canDelete, canManage, confirmDeleteVehicle, manageTarget, openEdit]);

  const openManageMenu = useCallback((vehicle: DeviceSummary) => setManageTarget(vehicle), []);

  if (isLoading && allVehicles.length === 0) {
    return <LoadingView label="Loading vehicles…" />;
  }
  if (isError && allVehicles.length === 0) {
    return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refetch} />;
  }

  const liveCount = statusCounts.RUNNING;

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.searchRow}>
          <View style={styles.searchField}>
            <CompactSearchBar
              loading={isFetching && rawSearch.trim() === search}
              onChangeText={setRawSearch}
              placeholder="Search name, IMEI or address"
              value={rawSearch}
            />
          </View>
          {/* The live tally used to live inside the input and vanish the moment
              anyone typed. It is a fleet fact, not a search affordance. */}
          <View style={styles.livePill}>
            <View style={[styles.liveDot, { backgroundColor: c.success }]} />
            <Text style={styles.livePillText}>{liveCount}</Text>
          </View>

          {canCreate ? (
            <ManagementCreateButton accessibilityLabel="Add vehicle" onPress={openCreate} />
          ) : null}

          <Pressable
            accessibilityLabel="Filter by status"
            accessibilityRole="button"
            accessibilityState={{ expanded: filtersOpen }}
            onPress={() => setFiltersOpen((open) => !open)}
            style={({ pressed }) => [
              styles.filterButton,
              (filtersOpen || Boolean(stateFilter)) && styles.filterButtonActive,
              pressed && styles.pressedSoft,
            ]}>
            <MaterialCommunityIcons
              color={filtersOpen || stateFilter ? c.primary : c.textSecondary}
              name="tune-variant"
              size={20}
            />
            {stateFilter ? <View style={[styles.filterMark, { backgroundColor: c.primary }]} /> : null}
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.tabRow}
          horizontal
          showsHorizontalScrollIndicator={false}>
          {BODY_TABS.map((tab) => {
            const active = body === tab.key;
            const count = tab.key ? bodyCounts[tab.key] : allVehicles.length;
            return (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                key={tab.key || 'all'}
                onPress={() => setBody(tab.key)}
                style={[styles.tab, active && styles.tabActive]}>
                {active ? (
                  <View style={[styles.liveDot, { backgroundColor: c.success }]} />
                ) : (
                  <MaterialCommunityIcons
                    color={c.textSecondary}
                    name={tab.icon as never}
                    size={15}
                  />
                )}
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {tab.label.toUpperCase()}
                </Text>
                <Text style={[styles.tabCount, active && styles.tabCountActive]}>({count})</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {filtersOpen ? (
          <ScrollView
            contentContainerStyle={styles.statusRow}
            horizontal
            showsHorizontalScrollIndicator={false}>
            {STATE_FILTERS.map(({ key, label }) => {
              const active = (stateFilter ?? '') === key;
              const tint = key ? (stateColors[key] ?? c.textSecondary) : c.primary;
              const count = key ? statusCounts[key] : byBody.length;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={key || 'any'}
                  onPress={() => selectStatus(key)}
                  style={[
                    styles.statusChip,
                    active && {
                      backgroundColor: hexToRgba(tint, 0.12),
                      borderColor: hexToRgba(tint, 0.38),
                    },
                  ]}>
                  <Text style={[styles.statusChipText, active && { color: tint }]}>{label}</Text>
                  <Text style={[styles.statusChipCount, active && { color: tint }]}>{count}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, spacing.sm) + spacing.md },
        ]}
        refreshControl={
          <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={c.primary} />
        }
        showsVerticalScrollIndicator={false}>
        {visibleVehicles.length > 0 ? (
          visibleVehicles.map((vehicle) => (
            <VehicleCard
              deleting={deletingVehicleId === vehicle.id}
              key={vehicle.id}
              nowMs={nowMs}
              onDocuments={() => openDocuments(vehicle)}
              onLive={() => openLive(vehicle)}
              onManage={canManage || canDelete ? () => openManageMenu(vehicle) : undefined}
              onPlayback={() => openPlayback(vehicle)}
              readiness={readiness}
              vehicle={vehicle}
            />
          ))
        ) : (
          <View style={styles.emptyState}>
            <EmptyView
              icon="car-off"
              title="No vehicles found"
              message={
                canCreate
                  ? 'Tap + to register a tracker, or try a different search or filter.'
                  : 'Try a different search or filter.'
              }
            />
          </View>
        )}

        <ListPagination
          itemLabel="vehicles"
          onPageChange={changePage}
          page={page}
          pageSize={PAGE_SIZE}
          totalItems={totalVehicles}
          totalPages={totalPages}
        />
      </ScrollView>

      <ActionSheet
        items={manageItems}
        onClose={() => setManageTarget(null)}
        subtitle="Manage this vehicle"
        title={manageTarget ? vehicleTitle(manageTarget) : ''}
        visible={manageTarget != null && manageItems.length > 0}
      />

      {dialogElement}

      <ManagementModal
        maxHeightRatio={0.94}
        onClose={closeForm}
        title={editing ? 'Vehicle & tracker' : 'Add vehicle'}
        visible={formVisible}>
        {editing && deviceDetails.isFetching && !deviceDetails.currentData ? (
          <View style={styles.formLoading}>
            <ActivityIndicator color={c.primary} size="small" />
            <Text style={styles.formLoadingText}>Loading vehicle details…</Text>
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
      </ManagementModal>
    </View>
  );
}

/**
 * One vehicle, as much as an operator reads before deciding what to do about it.
 *
 * The three actions are the point of the card: they are the whole reason the
 * details page it replaced existed, and they now cost one tap instead of two.
 */
function VehicleCard({
  deleting,
  nowMs,
  onDocuments,
  onLive,
  onManage,
  onPlayback,
  readiness,
  vehicle,
}: {
  deleting: boolean;
  nowMs: number;
  onDocuments: () => void;
  onLive: () => void;
  onManage?: () => void;
  onPlayback: () => void;
  readiness: { deviceId: number | null; locationDisabled: boolean };
  vehicle: DeviceSummary;
}) {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const resolved = resolveDeviceRecordState(vehicle, readiness);
  const tone = stateColors[resolved.state] ?? stateColors.NO_DATA ?? c.textMuted;
  const body = vehicleBodyType(vehicle.category);
  const wash = BODY_WASH[body];
  const source = vehicle.sourceType === 'MOBILE_GPS' ? 'MOBILE' : 'GPS';

  return (
    <View style={[styles.card, deleting && styles.cardDeleting]}>
      <View style={styles.cardMain}>
        <View style={styles.thumb}>
          <LinearGradient colors={wash} style={StyleSheet.absoluteFillObject} />
          <VehicleModelThumbnail body={body} />
          <View style={styles.thumbChip}>
            <Text style={styles.thumbChipText}>#{shortReference(vehicle)}</Text>
          </View>
        </View>

        <View style={styles.cardHead}>
          <View style={styles.badgeRow}>
            <View style={styles.sourcePill}>
              <View style={[styles.sourceDot, { backgroundColor: c.primary }]} />
              <Text style={styles.sourcePillText}>{source}</Text>
            </View>
            <View style={[styles.statusPill, { backgroundColor: hexToRgba(tone, 0.12), borderColor: hexToRgba(tone, 0.34) }]}>
              <View style={[styles.liveDot, { backgroundColor: tone }]} />
              <Text numberOfLines={1} style={[styles.statusPillText, { color: tone }]}>
                {resolved.label.toUpperCase()}
              </Text>
            </View>
            <View style={styles.agePill}>
              <MaterialCommunityIcons color={c.textMuted} name="clock-outline" size={11} />
              <Text numberOfLines={1} style={styles.agePillText}>
                {formatAge(vehicle.lastUpdate, nowMs)}
              </Text>
            </View>
            {onManage ? (
              <Pressable
                accessibilityLabel={`Manage ${vehicleTitle(vehicle)}`}
                accessibilityRole="button"
                disabled={deleting}
                hitSlop={6}
                onPress={onManage}
                style={({ pressed }) => [styles.manageButton, pressed && styles.pressedSoft]}>
                {deleting ? (
                  <ActivityIndicator color={c.textMuted} size="small" />
                ) : (
                  <MaterialCommunityIcons color={c.textSecondary} name="dots-vertical" size={17} />
                )}
              </Pressable>
            ) : null}
          </View>

          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={styles.cardTitle}>
              {vehicleTitle(vehicle)}
            </Text>
            <View style={styles.speedInline}>
              <MaterialCommunityIcons
                color={vehicle.speed > 0 ? c.primary : c.textMuted}
                name="speedometer"
                size={17}
              />
              <Text style={[styles.speedValue, { color: vehicle.speed > 0 ? c.primary : c.textPrimary }]}>
                {Math.round(vehicle.speed ?? 0)}
                <Text style={styles.speedUnit}> km/h</Text>
              </Text>
            </View>
          </View>

          <View style={styles.whereRow}>
            <MaterialCommunityIcons
              color={vehicle.gpsValid ? c.success : c.textMuted}
              name={vehicle.address ? 'map-marker-outline' : 'identifier'}
              size={12}
            />
            <Text numberOfLines={1} style={styles.whereText}>
              {vehicle.address?.trim() || `IMEI ${vehicle.imei}`}
            </Text>
          </View>

          <View style={styles.actionRow}>
            <CardAction icon="map-marker" label="Live" onPress={onLive} styles={styles} tint={c.success} />
            <CardAction icon="play-circle" label="Playback" onPress={onPlayback} styles={styles} tint={c.primary} />
            <CardAction
              icon="folder-outline"
              label="Documents"
              onPress={onDocuments}
              styles={styles}
              tint={c.warningOrange}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

function CardAction({
  icon,
  label,
  onPress,
  styles,
  tint,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  tint: string;
}) {
  return (
    <PressableScale
      accessibilityLabel={label}
      accessibilityRole="button"
      haptic
      onPress={onPress}
      style={[styles.action, { backgroundColor: hexToRgba(tint, 0.1) }]}>
      <MaterialCommunityIcons color={tint} name={icon} size={14} />
      <Text numberOfLines={1} style={[styles.actionText, { color: tint }]}>
        {label}
      </Text>
    </PressableScale>
  );
}

/** What the operator calls this vehicle, never a bare id. */
function vehicleTitle(vehicle: DeviceSummary): string {
  const named = (vehicle.vehicleName || vehicle.name || '').trim();
  return named || `Vehicle ${vehicle.id}`;
}

/**
 * A short, stable handle for the card's corner chip.
 *
 * The tail of the IMEI, because that is what is printed on the tracker an
 * engineer is holding. Falls back to the record id when there is no IMEI.
 */
function shortReference(vehicle: DeviceSummary): string {
  const imei = (vehicle.imei ?? '').replace(/\D/g, '');
  return imei.length >= 4 ? imei.slice(-4) : String(vehicle.id);
}

/** Compact relative age — the column is too narrow for a formatted timestamp. */
function formatAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 100 ? `${days}d` : '—';
}

function stateBucket(state?: string | null): string {
  const normalized = (state ?? '').toUpperCase();
  if (normalized === 'RUNNING' || normalized === 'MOVING') return 'RUNNING';
  if (normalized === 'STOPPED' || normalized === 'IDLE' || normalized === 'IMMOBILISED') {
    return 'STOPPED';
  }
  return 'OFFLINE';
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },

    toolbar: {
      backgroundColor: c.pageBackground,
      gap: spacing.sm,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.sm,
    },
    searchRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    searchField: { flex: 1, minWidth: 0 },
    livePill: {
      alignItems: 'center',
      backgroundColor: hexToRgba(c.success, 0.12),
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    livePillText: { color: c.success, fontSize: 10.5, fontWeight: '800' },
    liveDot: { borderRadius: 4, height: 7, width: 7 },
    filterButton: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    filterButtonActive: { backgroundColor: c.accentSoft, borderColor: hexToRgba(c.primary, 0.3) },
    filterMark: { borderRadius: 3, height: 6, position: 'absolute', right: 9, top: 9, width: 6 },

    tabRow: { alignItems: 'center', flexDirection: 'row', gap: 7, paddingRight: spacing.sm },
    tab: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 6,
      height: 38,
      paddingHorizontal: 14,
    },
    tabActive: { backgroundColor: '#0B1F3A', borderColor: '#0B1F3A' },
    tabText: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
    tabTextActive: { color: '#FFFFFF' },
    tabCount: { color: c.textMuted, fontSize: 11, fontVariant: ['tabular-nums'], fontWeight: '700' },
    tabCountActive: { color: 'rgba(255,255,255,0.72)' },

    statusRow: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingRight: spacing.sm },
    statusChip: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 5,
      minHeight: 30,
      paddingHorizontal: 11,
    },
    statusChipText: { color: c.textSecondary, fontSize: 11.5, fontWeight: '700' },
    statusChipCount: {
      color: c.textMuted,
      fontSize: 11.5,
      fontVariant: ['tabular-nums'],
      fontWeight: '800',
    },

    content: { gap: spacing.sm + 2, padding: spacing.sm },
    emptyState: { minHeight: 260 },

    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 2,
      overflow: 'hidden',
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.07,
      shadowRadius: 10,
    },
    cardDeleting: { opacity: 0.55 },
    cardMain: { flexDirection: 'row', gap: 9, padding: 9 },
    thumb: {
      alignItems: 'center',
      borderRadius: radius.md,
      height: 102,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 105,
    },
    thumbChip: {
      backgroundColor: 'rgba(11,31,58,0.82)',
      borderRadius: 6,
      left: 6,
      paddingHorizontal: 6,
      paddingVertical: 3,
      position: 'absolute',
      top: 6,
    },
    thumbChipText: {
      color: '#FFFFFF',
      fontSize: 9.5,
      fontVariant: ['tabular-nums'],
      fontWeight: '900',
      letterSpacing: 0.4,
    },
    cardHead: { flex: 1, gap: 5, justifyContent: 'space-between', minWidth: 0 },
    badgeRow: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    sourcePill: {
      alignItems: 'center',
      backgroundColor: hexToRgba(c.primary, 0.1),
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    sourceDot: { borderRadius: 3, height: 6, width: 6 },
    sourcePillText: { color: c.primary, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.4 },
    statusPill: {
      alignItems: 'center',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 4,
      maxWidth: 94,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    statusPillText: { fontSize: 8.5, fontWeight: '900', letterSpacing: 0.25 },
    agePill: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      flex: 1,
      flexDirection: 'row',
      gap: 3,
      justifyContent: 'center',
      minWidth: 43,
      paddingHorizontal: 5,
      paddingVertical: 3,
    },
    agePillText: { color: c.textMuted, fontSize: 8.5, fontWeight: '800' },
    titleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
    cardTitle: { color: c.textPrimary, flex: 1, fontSize: 15, fontWeight: '900', letterSpacing: -0.3 },
    speedInline: { alignItems: 'center', flexDirection: 'row', gap: 3 },
    speedValue: { fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '900' },
    speedUnit: { color: c.textMuted, fontSize: 8.5, fontWeight: '700' },
    whereRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    whereText: { color: c.textMuted, flex: 1, fontSize: 9.5 },
    actionRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    action: {
      alignItems: 'center',
      borderRadius: 8,
      flex: 1,
      flexDirection: 'row',
      gap: 4,
      justifyContent: 'center',
      minHeight: 29,
      paddingHorizontal: 4,
    },
    actionText: { fontSize: 9.5, fontWeight: '800' },
    manageButton: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    pressedSoft: { opacity: 0.65 },


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
