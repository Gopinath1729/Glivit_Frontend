import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeviceCard } from '@/src/components/DeviceCard';
import { enterUp } from '@/src/components/ui/Motion';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { StatusPill } from '@/src/components/ui/StatusPill';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetDevicesQuery } from '@/src/services/devicesApi';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const PAGE_SIZE = 20;

export default function VehiclesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { state: stateFilter } = useLocalSearchParams<{ state?: string }>();

  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<DeviceSummary[]>([]);

  // Debounce the search box; reset pagination when the term changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(rawSearch.trim());
      setPage(0);
    }, 350);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const { data, isLoading, isFetching, isError, error, refetch } = useGetDevicesQuery({
    search: search || undefined,
    page,
    size: PAGE_SIZE,
  });

  // Accumulate pages, de-duplicating by id so merged pages never show twice.
  useEffect(() => {
    if (!data) return;
    setItems((prev) => {
      if (page === 0) return data.content;
      const seen = new Set(prev.map((d) => d.id));
      return [...prev, ...data.content.filter((d) => !seen.has(d.id))];
    });
  }, [data, page]);

  const visible = useMemo(
    () => (stateFilter ? items.filter((d) => d.state === stateFilter) : items),
    [items, stateFilter]
  );

  const loadMore = useCallback(() => {
    if (data && !data.last && !isFetching) {
      setPage((p) => p + 1);
    }
  }, [data, isFetching]);

  const onRefresh = useCallback(() => {
    setPage(0);
    refetch();
  }, [refetch]);

  if (isLoading && items.length === 0) {
    return <LoadingView label="Loading vehicles…" />;
  }
  if (isError && items.length === 0) {
    return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refetch} />;
  }

  return (
    <View style={styles.screen}>
      <View style={styles.searchBar}>
        <MaterialCommunityIcons color={c.textSecondary} name="magnify" size={20} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setRawSearch}
          placeholder="Search name or IMEI"
          placeholderTextColor={c.textMuted}
          style={styles.searchInput}
          value={rawSearch}
        />
        {rawSearch ? (
          <MaterialCommunityIcons
            color={c.textSecondary}
            name="close-circle"
            onPress={() => setRawSearch('')}
            size={18}
          />
        ) : null}
      </View>

      {stateFilter ? (
        <View style={styles.filterRow}>
          <Text style={styles.filterLabel}>Filtered by</Text>
          <StatusPill state={stateFilter} />
          <Text onPress={() => router.setParams({ state: undefined })} style={styles.clearFilter}>
            Clear
          </Text>
        </View>
      ) : null}

      <FlatList
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.lg }]}
        data={visible}
        keyExtractor={(item) => String(item.id)}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        onRefresh={onRefresh}
        refreshing={isFetching && page === 0}
        renderItem={({ item, index }) => (
          <Animated.View entering={enterUp(index)}>
            <DeviceCard
              device={item}
              onPress={() =>
                router.push({
                  pathname: '/device-profile' as never,
                  params: { id: String(item.id) },
                })
              }
            />
          </Animated.View>
        )}
        ListEmptyComponent={
          <EmptyView icon="car-off" title="No vehicles found" message="Try a different search or filter." />
        }
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    searchBar: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    searchInput: { color: c.textPrimary, flex: 1, fontSize: typography.body, paddingVertical: spacing.sm },
    filterRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    filterLabel: { color: c.textSecondary, fontSize: typography.caption },
    clearFilter: { color: c.secondary, fontSize: typography.caption, fontWeight: '700' },
    list: { gap: spacing.sm, padding: spacing.md },
  });
