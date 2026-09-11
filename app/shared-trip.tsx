import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FleetWebMap,
  type FleetWebMapHandle,
  type WebMapNavigationOverlay,
} from '@/src/components/FleetWebMap';
import { COMMON_API_HEADERS, env } from '@/src/config/env';
import { getMapStyleInfo } from '@/src/services/mapStyle';
import type { SharedTripView } from '@/src/services/navigationApi';
import type { ApiResponse } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, type ThemeColors } from '@/src/theme/tokens';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,120}$/;

/** Public, token-scoped live trip. It never receives tenant/device/user ids. */
export default function SharedTripScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const mapRef = useRef<FleetWebMapHandle>(null);
  const [trip, setTrip] = useState<SharedTripView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!token || !TOKEN_PATTERN.test(token) || !env.apiBaseUrl) {
      setError('This shared trip link is invalid or unavailable.');
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(
        `${env.apiBaseUrl}/navigation/shared-trips/${encodeURIComponent(token)}`,
        { headers: COMMON_API_HEADERS, cache: 'no-store', signal }
      );
      const body = (await response.json()) as ApiResponse<SharedTripView>;
      if (!response.ok || !body.data) throw new Error('unavailable');
      setTrip(body.data);
      setError('');
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === 'AbortError') return;
      setError('This live trip has expired, was cancelled, or is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(), 4000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const route = useMemo<WebMapNavigationOverlay | null>(() => {
    if (!trip) return null;
    return {
      routeId: 'public-shared-trip',
      completedRoutes: [],
      remainingRoute: trip.remainingRoute.map(
        (point) => [point.longitude, point.latitude] as [number, number]
      ),
      alternativeRoutes: [],
      start: null,
      destination: {
        lat: trip.destinationLatitude,
        lng: trip.destinationLongitude,
      },
    };
  }, [trip]);

  if (loading && !trip) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color={colors.success} size="large" />
        <Text style={styles.loadingText}>Opening live trip…</Text>
      </SafeAreaView>
    );
  }

  if (!trip) {
    return (
      <SafeAreaView style={styles.centered}>
        <MaterialCommunityIcons color={colors.textMuted} name="link-off" size={42} />
        <Text style={styles.errorTitle}>Live trip unavailable</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setLoading(true);
            void load();
          }}
          style={styles.retry}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const markerTime = trip.lastGpsTime ? Date.parse(trip.lastGpsTime) : 0;
  const reached = trip.status === 'REACHED';
  return (
    <SafeAreaView edges={[]} style={styles.screen}>
      <FleetWebMap
        ref={mapRef}
        cameraMode="follow"
        followSelected={follow && !reached}
        mapStyle={getMapStyleInfo(isDark ? 'dark' : 'street').webStyle}
        markers={[{
          id: 'shared-vehicle',
          lat: trip.latitude,
          lng: trip.longitude,
          color: colors.success,
          heading: trip.bearing,
          label: trip.vehicleName,
          moving: trip.status === 'ACTIVE' && trip.speedKmh > 0,
          sourceTime: Number.isFinite(markerTime) ? markerTime : 0,
        }]}
        navigation={route}
        onInteraction={() => setFollow(false)}
        selectedId="shared-vehicle"
        style={StyleSheet.absoluteFillObject}
      />

      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View>
          <Text style={styles.brand}>GLIVT</Text>
          <Text style={styles.title}>{reached ? 'Destination reached' : 'Shared live trip'}</Text>
        </View>
        <View style={styles.livePill}>
          <View style={[styles.liveDot, reached && styles.reachedDot]} />
          <Text style={styles.liveText}>{trip.status === 'ACTIVE' ? 'LIVE' : trip.status}</Text>
        </View>
      </View>

      <View style={[styles.tripCard, { bottom: insets.bottom + 20 }]}>
        <View style={styles.destinationRow}>
          <MaterialCommunityIcons color={colors.danger} name="map-marker" size={22} />
          <View style={styles.destinationText}>
            <Text style={styles.destinationLabel}>DESTINATION</Text>
            <Text numberOfLines={2} style={styles.destination}>{trip.destinationName}</Text>
          </View>
        </View>
        <View style={styles.metricsRow}>
          <View>
            <Text style={styles.metricValue}>{formatDistance(trip.remainingDistanceMeters)}</Text>
            <Text style={styles.metricLabel}>Remaining</Text>
          </View>
          <View style={styles.divider} />
          <View>
            <Text style={styles.metricValue}>{formatDuration(trip.remainingDurationSeconds)}</Text>
            <Text style={styles.metricLabel}>Estimated time</Text>
          </View>
          <View style={styles.speedBlock}>
            <Text style={styles.speed}>{Math.max(0, Math.round(trip.speedKmh))}</Text>
            <Text style={styles.metricLabel}>km/h</Text>
          </View>
        </View>
        {error ? <Text style={styles.staleText}>Update delayed — showing last trusted position.</Text> : null}
      </View>

      {!follow && !reached ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setFollow(true);
            mapRef.current?.recenterNavigation();
          }}
          style={[styles.recenter, { bottom: insets.bottom + 140 }]}>
          <MaterialCommunityIcons color={colors.success} name="navigation-variant" size={18} />
          <Text style={styles.recenterText}>Recenter</Text>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: c.pageBackground, flex: 1 },
  centered: {
    alignItems: 'center',
    backgroundColor: c.pageBackground,
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  loadingText: { color: c.textSecondary, fontSize: 13, marginTop: 12 },
  errorTitle: { color: c.textPrimary, fontSize: 20, fontWeight: '900', marginTop: 14 },
  errorText: { color: c.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 7, textAlign: 'center' },
  retry: { backgroundColor: c.success, borderRadius: radius.pill, marginTop: 18, paddingHorizontal: 22, paddingVertical: 11 },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  header: {
    alignItems: 'center',
    backgroundColor: c.cardBackground,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    elevation: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingBottom: 14,
    paddingHorizontal: 18,
    position: 'absolute',
    right: 0,
    shadowColor: c.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
  },
  brand: { color: c.success, fontSize: 11, fontStyle: 'italic', fontWeight: '900', letterSpacing: 1.4 },
  title: { color: c.textPrimary, fontSize: 18, fontWeight: '900', marginTop: 2 },
  livePill: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: radius.pill, flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 7 },
  liveDot: { backgroundColor: c.success, borderRadius: 4, height: 8, width: 8 },
  reachedDot: { backgroundColor: c.textMuted },
  liveText: { color: c.textSecondary, fontSize: 10, fontWeight: '900' },
  tripCard: {
    backgroundColor: c.cardBackground,
    borderColor: c.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 12,
    left: 12,
    padding: 15,
    position: 'absolute',
    right: 12,
    shadowColor: c.shadowColor,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.2,
    shadowRadius: 14,
  },
  destinationRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  destinationText: { flex: 1 },
  destinationLabel: { color: c.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
  destination: { color: c.textPrimary, fontSize: 13, fontWeight: '800', marginTop: 2 },
  metricsRow: { alignItems: 'center', flexDirection: 'row', gap: 16, marginTop: 13 },
  metricValue: { color: c.textPrimary, fontSize: 16, fontVariant: ['tabular-nums'], fontWeight: '900' },
  metricLabel: { color: c.textMuted, fontSize: 9, fontWeight: '700', marginTop: 1 },
  divider: { alignSelf: 'stretch', backgroundColor: c.divider, width: StyleSheet.hairlineWidth },
  speedBlock: { marginLeft: 'auto', minWidth: 48 },
  speed: { color: c.success, fontSize: 18, fontVariant: ['tabular-nums'], fontWeight: '900' },
  staleText: { color: c.textMuted, fontSize: 9.5, marginTop: 9 },
  recenter: {
    alignItems: 'center',
    backgroundColor: c.cardBackground,
    borderColor: c.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 7,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    position: 'absolute',
    right: 14,
  },
  recenterText: { color: c.textPrimary, fontSize: 11, fontWeight: '900' },
});
