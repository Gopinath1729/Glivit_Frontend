import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  type LayoutChangeEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeviceRow, DEVICE_ROW_HEIGHT } from '@/src/components/DeviceRow';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import { useDeleteDeviceMutation, useGetAllDevicesQuery } from '@/src/services/devicesApi';
import { resolveDeviceRecordState } from '@/src/services/deviceState';
import { useMobileGpsReadiness } from '@/src/services/mobileGpsStatus';
import { dedupeByVehicle } from '@/src/services/vehicleIdentity';
import { P } from '@/src/constants/permissions';
import { useHasPermission } from '@/src/store/hooks';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const COLUMN_HEADER_HEIGHT = 34;
const DEFAULT_PAGINATION_HEIGHT = 52;
const DEFAULT_TOOLBAR_HEIGHT = 108;
const MAX_PAGE_ROWS = 12;

const STATE_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'RUNNING', label: 'Running' },
  { key: 'STOPPED', label: 'Stopped' },
  // Covers every non-reporting state, not just OFFLINE: a device that has
  // never reported (NO_DATA), one with no GPS fix, and an expired one all
  // belong here. The rows themselves name the specific reason.
  { key: 'OFFLINE', label: 'Not Reporting' },
];

export default function VehiclesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { state: stateFilter } = useLocalSearchParams<{ state?: string }>();
  const canDelete = useHasPermission(P.DELETE_DEVICE);

  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const [paginationHeight, setPaginationHeight] = useState(0);
  const [deletingVehicleId, setDeletingVehicleId] = useState<number | null>(null);
  const [deleteDevice] = useDeleteDeviceMutation();

  const pageSize = useMemo(() => {
    const availableHeight = viewportHeight || window.height;
    const fixedHeight =
      (toolbarHeight || DEFAULT_TOOLBAR_HEIGHT) +
      (paginationHeight || DEFAULT_PAGINATION_HEIGHT) +
      COLUMN_HEADER_HEIGHT +
      spacing.sm * 2 +
      2;
    return Math.max(
      1,
      Math.min(MAX_PAGE_ROWS, Math.floor((availableHeight - fixedHeight) / DEVICE_ROW_HEIGHT))
    );
  }, [paginationHeight, toolbarHeight, viewportHeight, window.height]);
  const previousPageSize = useRef(pageSize);
  const maxPageButtons = window.width < 360 ? 3 : window.width < 430 ? 4 : 5;

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(rawSearch.trim());
      setPage(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [rawSearch]);

  useEffect(() => setPage(0), [stateFilter]);

  const { data, isLoading, isFetching, isError, error, refetch } = useGetAllDevicesQuery(
    { search: search || undefined },
    { pollingInterval: 30_000, skipPollingIfUnfocused: true }
  );

  // One row per vehicle: two trackers on the same vehicle are one vehicle.
  const allVehicles = useMemo(
    () => dedupeByVehicle(Array.isArray(data) ? data : []),
    [data]
  );
  // Chips and rows must agree, so both bucket the SAME resolved status the row
  // itself renders — not the raw server field, which can be a stale RUNNING.
  const readiness = useMobileGpsReadiness();
  const bucketOf = useCallback(
    (vehicle: DeviceSummary) => stateBucket(resolveDeviceRecordState(vehicle, readiness).state),
    [readiness]
  );
  const counts = useMemo(() => {
    const tally: Record<string, number> = { RUNNING: 0, STOPPED: 0, OFFLINE: 0 };
    for (const vehicle of allVehicles) {
      const bucket = bucketOf(vehicle);
      tally[bucket] = (tally[bucket] ?? 0) + 1;
    }
    return tally;
  }, [allVehicles, bucketOf]);

  const filteredVehicles = useMemo(
    () =>
      stateFilter ? allVehicles.filter((vehicle) => bucketOf(vehicle) === stateFilter) : allVehicles,
    [allVehicles, bucketOf, stateFilter]
  );

  const totalVehicles = filteredVehicles.length;
  const totalPages = Math.max(1, Math.ceil(totalVehicles / pageSize));

  useEffect(() => {
    const previous = previousPageSize.current;
    if (previous === pageSize) return;
    setPage((current) => Math.floor((current * previous) / pageSize));
    previousPageSize.current = pageSize;
  }, [pageSize]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const visibleVehicles = useMemo(
    () => filteredVehicles.slice(page * pageSize, page * pageSize + pageSize),
    [filteredVehicles, page, pageSize]
  );
  const pageNumbers = useMemo(
    () => paginationWindow(page, totalPages, maxPageButtons),
    [maxPageButtons, page, totalPages]
  );

  const changePage = useCallback(
    (nextPage: number) => {
      const target = Math.max(0, Math.min(totalPages - 1, nextPage));
      void Haptics.selectionAsync().catch(() => undefined);
      setPage(target);
    },
    [totalPages]
  );

  const measureViewport = useCallback((event: LayoutChangeEvent) => {
    setViewportHeight(Math.round(event.nativeEvent.layout.height));
  }, []);
  const measureToolbar = useCallback((event: LayoutChangeEvent) => {
    setToolbarHeight(Math.round(event.nativeEvent.layout.height));
  }, []);
  const measurePagination = useCallback((event: LayoutChangeEvent) => {
    setPaginationHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  const selectFilter = useCallback(
    (key: string) => {
      setPage(0);
      router.setParams({ state: key || undefined });
    },
    [router]
  );

  const openVehicle = useCallback(
    (vehicle: DeviceSummary) =>
      router.push({ pathname: '/device-profile' as never, params: { id: String(vehicle.id) } }),
    [router]
  );

  const confirmDeleteVehicle = useCallback(
    (vehicle: DeviceSummary) => {
      Alert.alert(
        'Delete vehicle permanently?',
        `This erases ${vehicle.vehicleName || vehicle.name} and ALL data related to it — its tracker, complete location history, trips, alerts, commands and documents.

This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete everything',
            style: 'destructive',
            onPress: () => {
              setDeletingVehicleId(vehicle.id);
              void deleteDevice(vehicle.id)
                .unwrap()
                .catch((error) =>
                  Alert.alert('Vehicle not deleted', apiErrorMessage(error))
                )
                .finally(() => setDeletingVehicleId(null));
            },
          },
        ]
      );
    },
    [deleteDevice]
  );

  if (isLoading && allVehicles.length === 0) {
    return <LoadingView label="Loading vehicles…" />;
  }
  if (isError && allVehicles.length === 0) {
    return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refetch} />;
  }

  return (
    <View onLayout={measureViewport} style={styles.screen}>
      <View onLayout={measureToolbar} style={styles.toolbar}>
        <View style={styles.searchBar}>
          <MaterialCommunityIcons color={c.textMuted} name="magnify" size={18} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setRawSearch}
            placeholder="Search name or IMEI"
            placeholderTextColor={c.textMuted}
            style={styles.searchInput}
            value={rawSearch}
          />
          {isFetching ? (
            <MaterialCommunityIcons color={c.primary} name="loading" size={16} />
          ) : rawSearch ? (
            <MaterialCommunityIcons
              color={c.textSecondary}
              name="close-circle"
              onPress={() => setRawSearch('')}
              size={16}
            />
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={styles.filterRow}
          horizontal
          showsHorizontalScrollIndicator={false}>
          {STATE_FILTERS.map(({ key, label }) => {
            const active = (stateFilter ?? '') === key;
            const tint = key ? (stateColors[key] ?? c.textSecondary) : c.primary;
            const count = key ? counts[key] : allVehicles.length;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={key || 'all'}
                onPress={() => selectFilter(key)}
                style={[
                  styles.chip,
                  active && {
                    backgroundColor: hexToRgba(tint, 0.12),
                    borderColor: hexToRgba(tint, 0.38),
                  },
                ]}>
                <Text style={[styles.chipText, active && { color: tint }]}>{label}</Text>
                <Text style={[styles.chipCount, active && { color: tint }]}>{count}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, spacing.sm) + spacing.md },
        ]}
        refreshControl={
          <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={c.primary} />
        }>
        <View style={styles.listCard}>
          <View style={styles.columnHeader}>
            <Text style={styles.columnLabel}>Vehicle</Text>
            <Text style={[styles.columnLabel, styles.columnMetrics]}>Speed / State</Text>
            <Text style={[styles.columnLabel, styles.columnAge]}>Age</Text>
          </View>

          {visibleVehicles.length > 0 ? (
            <View style={styles.rows}>
              {visibleVehicles.map((vehicle) => (
                <DeviceRow
                  deleting={deletingVehicleId === vehicle.id}
                  device={vehicle}
                  key={vehicle.id}
                  onDelete={canDelete ? () => confirmDeleteVehicle(vehicle) : undefined}
                  onPress={() => openVehicle(vehicle)}
                />
              ))}
            </View>
          ) : (
            <View style={styles.emptyState}>
              <EmptyView
                icon="car-off"
                title="No vehicles found"
                message="Try a different search or filter."
              />
            </View>
          )}

          <View onLayout={measurePagination} style={styles.pagination}>
            <View style={styles.paginationControls}>
              <PageControl
                disabled={page === 0}
                icon="chevron-left"
                label="Previous"
                onPress={() => changePage(page - 1)}
                styles={styles}
              />

              <View style={styles.pageNumbers}>
                {pageNumbers.map((pageNumber) => {
                  const active = pageNumber === page;
                  return (
                    <Pressable
                      accessibilityLabel={`Page ${pageNumber + 1}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      key={pageNumber}
                      onPress={() => changePage(pageNumber)}
                      style={[styles.pageButton, active && styles.pageButtonActive]}>
                      <Text style={[styles.pageButtonText, active && styles.pageButtonTextActive]}>
                        {pageNumber + 1}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <PageControl
                disabled={page >= totalPages - 1 || totalVehicles === 0}
                icon="chevron-right"
                iconAfter
                label="Next"
                onPress={() => changePage(page + 1)}
                styles={styles}
              />
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function stateBucket(state?: string | null): string {
  const normalized = (state ?? '').toUpperCase();
  if (normalized === 'RUNNING' || normalized === 'MOVING') return 'RUNNING';
  if (normalized === 'STOPPED' || normalized === 'IDLE' || normalized === 'IMMOBILISED') {
    return 'STOPPED';
  }
  return 'OFFLINE';
}

function paginationWindow(current: number, total: number, maximum: number): number[] {
  const count = Math.min(total, maximum);
  const maxStart = Math.max(0, total - count);
  const start = Math.min(maxStart, Math.max(0, current - Math.floor(count / 2)));
  return Array.from({ length: count }, (_, index) => start + index);
}

function PageControl({
  disabled,
  icon,
  iconAfter = false,
  label,
  onPress,
  styles,
}: {
  disabled: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  iconAfter?: boolean;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { colors: c } = useTheme();
  const content = [
    <MaterialCommunityIcons
      color={disabled ? c.textMuted : c.primary}
      key="icon"
      name={icon}
      size={17}
    />,
    <Text
      key="label"
      style={[styles.paginationLabel, disabled && styles.paginationLabelDisabled]}>
      {label}
    </Text>,
  ];

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.paginationAction, pressed && !disabled && styles.paginationPressed]}>
      {iconAfter ? content.reverse() : content}
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    toolbar: {
      backgroundColor: c.surface,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: spacing.sm,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.sm,
    },
    searchBar: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      height: 38,
      paddingHorizontal: spacing.sm + 2,
    },
    searchInput: { color: c.textPrimary, flex: 1, fontSize: typography.label, padding: 0 },
    filterRow: { gap: 6, paddingRight: spacing.sm },
    chip: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: 'transparent',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 4,
      minHeight: 30,
      paddingHorizontal: 11,
      paddingVertical: 4,
    },
    chipText: { color: c.textSecondary, fontSize: 11.5, fontWeight: '700' },
    chipCount: { color: c.textMuted, fontSize: 11.5, fontVariant: ['tabular-nums'], fontWeight: '800' },
    content: { padding: spacing.sm },
    listCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 2,
      overflow: 'hidden',
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
    },
    columnHeader: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 34,
      paddingLeft: spacing.sm + 3 + spacing.sm + 34 + spacing.sm,
      paddingRight: spacing.md,
    },
    columnLabel: {
      color: c.textMuted,
      flex: 1,
      fontSize: 9.5,
      fontWeight: '800',
      letterSpacing: 0.65,
      textTransform: 'uppercase',
    },
    columnMetrics: { flex: 0, textAlign: 'right', width: 74 },
    columnAge: { flex: 0, textAlign: 'right', width: 34 },
    rows: { backgroundColor: c.surface },
    emptyState: { minHeight: 220 },
    pagination: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm + 2,
    },
    paginationControls: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
    },
    paginationAction: {
      alignItems: 'center',
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 2,
      minHeight: 34,
      paddingHorizontal: 4,
    },
    paginationPressed: { backgroundColor: c.surfaceAlt },
    paginationLabel: { color: c.primary, fontSize: 11, fontWeight: '800' },
    paginationLabelDisabled: { color: c.textMuted, opacity: 0.55 },
    pageNumbers: { alignItems: 'center', flexDirection: 'row', gap: 3 },
    pageButton: {
      alignItems: 'center',
      borderRadius: 9,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    pageButtonActive: { backgroundColor: c.primary },
    pageButtonText: { color: c.textPrimary, fontSize: 12, fontWeight: '800' },
    pageButtonTextActive: { color: c.onPrimary },
  });
