import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FleetWebMap,
  type WebMapMarker,
  type WebMapProjection,
} from '@/src/components/FleetWebMap';
import MapView, { Marker } from '@/src/components/maps/NativeMap';
import {
  sanitizeRouteCoordinates,
  splitRouteCoordinates,
  StableBaseRoute,
  StableRouteLine,
} from '@/src/components/StableRouteLayers';
import { VehicleMarker, markerCategory } from '@/src/components/VehicleMarker';
import { vehicleSprite } from '@/src/components/vehicleMarkerSprites';
import { useMatchedHistoryRoute } from '@/src/hooks/useMatchedHistoryRoute';
import { apiErrorMessage } from '@/src/services/apiError';
import { coordinateOf } from '@/src/services/gpsPipeline';
import { useGetDevicePlaybackQuery } from '@/src/services/devicesApi';
import { getMapStyleInfo } from '@/src/services/mapStyle';
import { advancePlaybackElapsed } from '@/src/services/playbackClock';
import {
  haversineKm,
  sampleAt,
  routeSegments,
  travelledRouteSegments,
  type PlaybackTrack,
} from '@/src/services/playbackEngine';
import { normalizeHeading } from '@/src/services/vehicleMarkerAssets';
import { useTheme } from '@/src/theme/ThemeProvider';
import type {
  PlaybackEventMarker,
  PlaybackResponse,
  PlaybackStopMarker,
  PlaybackTimelineSegment,
} from '@/src/types/api';

// Bright navigation palette. Playback should read like a focused journey view,
// not a black diagnostics console, regardless of the surrounding app theme.
import {
  localDayRangeIso,
  shiftDate,
  todayStr,
} from '@/src/services/localDates';

const SPEEDS = [0.5, 1, 2, 4] as const;
const ROUTE_BLUE = '#1473E6';
const ROUTE_BLUE_AURA = 'rgba(45, 174, 255, 0.30)';
/**
 * The whole journey, drawn before and behind the travelled highlight.
 *
 * At 48% alpha over a light basemap this was very nearly invisible - reported
 * as "the blue history route line is missing", because at a glance it is. It
 * is deliberately still lighter than {@link ROUTE_BLUE} so the travelled part
 * remains distinguishable as playback progresses, but it now has to be legible
 * on its own: the route a trip took is the primary content of this screen.
 */
const ROUTE_BLUE_BASE = 'rgba(52, 122, 214, 0.85)';
/**
 * The GPS-only diagnostic line.
 *
 * Amber, thin and dashed-equivalent, and deliberately nothing like the road
 * route: it marks a stretch the matcher could not place, which is a chord
 * between fixes rather than a road the vehicle drove.
 */
const ROUTE_GPS_ONLY = '#F59E0B';
type CameraMode = 'follow' | 'chase' | 'cinematic' | 'drone' | 'top' | 'overview';
const CAMERAS: { id: CameraMode; icon: string; label: string }[] = [
  { id: 'follow', icon: 'navigation-variant', label: 'Follow' },
  { id: 'chase', icon: 'car-sports', label: 'Chase' },
  { id: 'cinematic', icon: 'movie-open', label: 'Cinematic' },
  { id: 'drone', icon: 'orbit', label: 'Drone' },
  { id: 'top', icon: 'crosshairs-gps', label: 'Top' },
  { id: 'overview', icon: 'fit-to-page-outline', label: 'Overview' },
];

const G = {
  glass: 'rgba(255,255,255,0.92)',
  glassStrong: 'rgba(255,255,255,0.97)',
  hair: 'rgba(20,75,94,0.14)',
  text: '#123247',
  sub: '#607783',
  track: 'rgba(18,50,71,0.12)',
};

/** Format YYYY-MM-DD to human label ("Today", "Yesterday", or "23 Jul"). */
function labelDate(dateStr: string): string {
  const today = todayStr();
  if (dateStr === today) return 'Today';
  if (dateStr === shiftDate(today, -1)) return 'Yesterday';
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Format range label for header trigger (e.g. "Today", "28 Jul", or "28 Jul – 01 Aug"). */
function formatRangeHeaderLabel(fromStr: string, toStr: string): string {
  const today = todayStr();
  if (fromStr === today && toStr === today) return 'Today';
  const yest = shiftDate(today, -1);
  if (fromStr === yest && toStr === yest) return 'Yesterday';
  if (fromStr === toStr) return labelDate(fromStr);

  const dFrom = new Date(`${fromStr}T12:00:00`);
  const dTo = new Date(`${toStr}T12:00:00`);
  const fromLbl = dFrom.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const toLbl = dTo.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${fromLbl} – ${toLbl}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function getCalendarDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1).getDay(); // 0 = Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days: { year: number; month: number; day: number; dateStr: string; currentMonth: boolean }[] = [];

  const prevMonthDays = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const prevM = month === 0 ? 11 : month - 1;
    const prevY = month === 0 ? year - 1 : year;
    const dateStr = `${prevY}-${String(prevM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    days.push({ year: prevY, month: prevM, day: d, dateStr, currentMonth: false });
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    days.push({ year, month, day: d, dateStr, currentMonth: true });
  }

  const remaining = 42 - days.length;
  for (let d = 1; d <= remaining; d++) {
    const nextM = month === 11 ? 0 : month + 1;
    const nextY = month === 11 ? year + 1 : year;
    const dateStr = `${nextY}-${String(nextM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    days.push({ year: nextY, month: nextM, day: d, dateStr, currentMonth: false });
  }

  return days;
}

function formatDuration(totalSeconds: number | null | undefined): string {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function formatHistoryTime(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString([], {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  });
}

function timelinePresentation(segment: PlaybackTimelineSegment) {
  switch (segment.type) {
    case 'STOPPED':
      return { color: '#DC2626', icon: 'map-marker-radius-outline', label: `Stop ${segment.stopIndex ?? ''}`.trim() } as const;
    case 'NO_DATA':
      return { color: '#64748B', icon: 'signal-off', label: 'No GPS signal' } as const;
    default:
      return { color: '#087C73', icon: 'navigation-variant-outline', label: 'Moving' } as const;
  }
}

export default function TripPlaybackScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    deviceId?: string;
    imei?: string;
    name?: string;
    category?: string;
    make?: string;
    model?: string;
    speed?: string;
    heading?: string;
  }>();

  /**
   * Route params, validated before anything reads them.
   *
   * expo-router hands back `string | string[]` - a param repeated in the URL
   * arrives as an array - and every value here is optional in practice
   * regardless of the type annotation, because a deep link or a caller that
   * omitted one produces exactly the same shape. `Number(['7'])` is 7 but
   * `Number(['7','8'])` is NaN, so the first value is taken explicitly rather
   * than relying on coercion.
   */
  const vehicle = useMemo(() => {
    const first = (value: string | string[] | undefined): string | undefined =>
      Array.isArray(value) ? value[0] : value;
    const rawId = first(params.deviceId);
    const parsedId = rawId == null || rawId.trim() === '' ? Number.NaN : Number(rawId);
    const id = Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : null;
    const name = first(params.name)?.trim();
    return {
      id,
      imei: first(params.imei)?.trim() || null,
      name: name || (id != null ? `Vehicle #${id}` : 'Vehicle'),
      category: first(params.category)?.trim() || '',
    };
  }, [params.category, params.deviceId, params.imei, params.name]);
  const deviceId = vehicle.id;

  /**
   * Back must never strand the user or throw.
   *
   * `router.back()` on a stack with nothing behind it - Playback reached from a
   * notification or a cold deep link - has no destination. Falling back to this
   * vehicle's own detail screen keeps the documented flow (Playback -> Vehicle
   * Details) intact however the screen was reached.
   */
  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (deviceId != null) {
      router.replace({ pathname: '/device-profile', params: { id: String(deviceId) } });
      return;
    }
    router.replace('/(app)/map');
  }, [deviceId, router]);

  // Date-range filter — defaults to today.
  const today = todayStr();
  const [activeFromDate, setActiveFromDate] = useState(today);
  const [activeToDate, setActiveToDate] = useState(today);

  // Modal draft state
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [draftFromDate, setDraftFromDate] = useState(today);
  const [draftToDate, setDraftToDate] = useState(today);
  const [pickerTarget, setPickerTarget] = useState<'from' | 'to'>('from');

  // Calendar month/year navigation state
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());

  // The chosen dates are LOCAL calendar days. Appending a Z read them as UTC,
  // so east of Greenwich the window started hours into the day and everything
  // before dawn fell into the previous one - which is how a day with a real trip
  // on it came back empty.
  const { from: fromIso, to: toIso } = useMemo(
    () => localDayRangeIso(activeFromDate, activeToDate),
    [activeFromDate, activeToDate]
  );

  const isInvalidRange = draftFromDate > draftToDate;

  const { data, isFetching, isError, error, refetch } = useGetDevicePlaybackQuery(
    // Keyed by THIS vehicle's id, so the cache entry, the in-flight request and
    // the response all belong to the vehicle whose Playback icon was tapped.
    // Nothing on this screen reads live-tracking state.
    { deviceId: deviceId ?? 0, from: fromIso, to: toIso },
    { refetchOnMountOrArgChange: true, skip: deviceId == null }
  );

  const [playing, setPlaying] = useState(false);
  const [appActive, setAppActive] = useState(() => isForeground(AppState.currentState));
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [camera, setCamera] = useState<CameraMode>('cinematic');
  const [cameraCommandId, setCameraCommandId] = useState(0);
  const [showHistoryDetails, setShowHistoryDetails] = useState(false);
  const [ui, setUi] = useState(0); // throttled progress for UI (0..1)

  const progressRef = useRef(0);
  const playingRef = useRef(playing);
  const speedRef = useRef<number>(speed);
  const trackWidth = useRef(0);
  playingRef.current = playing;
  speedRef.current = speed;

  const haptic = useCallback(() => {
    if (Platform.OS !== 'web') {
      void Haptics.selectionAsync().catch(() => undefined);
    }
  }, []);


  // The route is the road the backend matched this history onto, and the track
  // rides that road. Nothing here joins raw fixes into a line.
  const {
    track,
    route: matchedRoute,
    gpsOnlySegments,
  } = useMatchedHistoryRoute(data);
  const points = track.points;
  /** A day only has playable history when there are at least two real fixes. */
  const hasTrack = points.length >= 2;
  const showLoading = isFetching && !data;

  /**
   * Rewind whenever the loaded date range changes.
   *
   * Keyed on the range and on whether there is a route, NOT on `data`: the cache
   * hands back a new object on every refetch, and rewinding on those threw the
   * playhead back to the start and forced playback on again mid-trip.
   */
  useEffect(() => {
    progressRef.current = 0;
    setUi(0);
    setPlaying(false);
  }, [hasTrack, activeFromDate, activeToDate]);

  // Real trip duration (for the clock readout) and event tick fractions.
  const timing = useMemo(() => {
    if (points.length < 2) return { start: 0, end: 1, durationMin: 0 };
    const firstPointTime = points[0]?.t ? new Date(points[0].t).getTime() : 0;
    const start = Number.isFinite(firstPointTime) && firstPointTime > 0 ? firstPointTime : Date.now();
    const duration = Math.max(1000, track.totalDurationMs || (points.length * 2000));
    const end = start + duration;
    return { start, end, durationMin: Math.max(0, (end - start) / 60000) };
  }, [points, track.totalDurationMs]);

  const eventTicks = useMemo(() => {
    if (!data || timing.end <= timing.start) return [];
    return (data.events ?? []).map((e) => ({
      frac: Math.max(0, Math.min(1, (new Date(e.t).getTime() - timing.start) / (timing.end - timing.start))),
      type: e.eventType,
    }));
  }, [data, timing]);

  // 60fps clock — advances the ref (drives 3D) and throttles UI state at ~12fps.
  const screenMountedRef = useRef(true);
  useEffect(() => {
    screenMountedRef.current = true;
    return () => {
      screenMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let raf: number;
    let cancelled = false;
    let lastUi = 0;
    let last = Date.now();
    const tick = () => {
      // Re-scheduling FIRST and cancelling on the way out is what guarantees a
      // single loop: the effect owns exactly one handle, and a re-run (speed,
      // range, vehicle, app state) cancels its predecessor before the next
      // frame. `cancelled` closes the one-frame window where a queued callback
      // can still fire after cancelAnimationFrame.
      if (cancelled || !screenMountedRef.current) return;
      raf = requestAnimationFrame(tick);
      const now = Date.now();
      const frameDeltaMs = Math.min(50, now - last);
      last = now;
      if (appActive && playingRef.current && points.length >= 2) {
        const durationMs = Math.max(1, track.totalDurationMs);
        const nextElapsedMs = advancePlaybackElapsed(
          progressRef.current * durationMs,
          frameDeltaMs,
          durationMs,
          speedRef.current
        );
        progressRef.current = nextElapsedMs / durationMs;
        if (progressRef.current >= 1) {
          progressRef.current = 1;
          setPlaying(false);
        }
      }
      if (now - lastUi > 40) {
        lastUi = now;
        setUi(progressRef.current);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [appActive, points.length, track.totalDurationMs]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(isForeground(state));
    });
    return () => subscription.remove();
  }, []);

  const seek = (frac: number) => {
    const clamped = Math.max(0, Math.min(1, frac));
    progressRef.current = clamped;
    setUi(clamped);
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          if (trackWidth.current > 0) seek(e.nativeEvent.locationX / trackWidth.current);
        },
        onPanResponderMove: (e) => {
          if (trackWidth.current > 0) seek(e.nativeEvent.locationX / trackWidth.current);
        },
      }).panHandlers,
    []
  );

  const onTrackLayout = (e: LayoutChangeEvent) => {
    trackWidth.current = e.nativeEvent.layout.width;
  };

  const restart = useCallback(() => {
    haptic();
    seek(0);
    setPlaying(true);
  }, [haptic]);
  const togglePlay = useCallback(() => {
    haptic();
    if (progressRef.current >= 1) restart();
    else setPlaying((p) => !p);
  }, [haptic, restart]);
  const handleMapReady = useCallback(() => undefined, []);

  const openFilterModal = useCallback(() => {
    haptic();
    setDraftFromDate(activeFromDate);
    setDraftToDate(activeToDate);
    const targetDate = new Date(`${activeFromDate}T12:00:00`);
    if (!Number.isNaN(targetDate.getTime())) {
      setCalYear(targetDate.getFullYear());
      setCalMonth(targetDate.getMonth());
    }
    setShowFilterModal(true);
  }, [activeFromDate, activeToDate, haptic]);

  const applyFilter = useCallback(() => {
    if (isInvalidRange) return;
    haptic();
    setActiveFromDate(draftFromDate);
    setActiveToDate(draftToDate);
    setShowFilterModal(false);
    progressRef.current = 0;
    setUi(0);
  }, [draftFromDate, draftToDate, haptic, isInvalidRange]);

  const resetFilter = useCallback(() => {
    haptic();
    setDraftFromDate(today);
    setDraftToDate(today);
    setActiveFromDate(today);
    setActiveToDate(today);
    setShowFilterModal(false);
    progressRef.current = 0;
    setUi(0);
  }, [haptic, today]);

  const selectPreset = useCallback((preset: 'today' | 'yesterday' | 'week' | 'month') => {
    haptic();
    const now = todayStr();
    if (preset === 'today') {
      setDraftFromDate(now);
      setDraftToDate(now);
    } else if (preset === 'yesterday') {
      const yest = shiftDate(now, -1);
      setDraftFromDate(yest);
      setDraftToDate(yest);
    } else if (preset === 'week') {
      setDraftFromDate(shiftDate(now, -6));
      setDraftToDate(now);
    } else if (preset === 'month') {
      const d = new Date();
      const firstOfMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      setDraftFromDate(firstOfMonth);
      setDraftToDate(now);
    }
  }, [haptic]);

  if (deviceId == null) {
    return <Center onBack={goBack} text="No vehicle selected." />;
  }

  const currentSample = hasTrack ? sampleAt(track, ui * track.totalDurationMs) : null;
  const curSpeed = Math.round(currentSample?.speed ?? 0);
  const elapsedMin = hasTrack ? timing.durationMin * ui : 0;
  const coveredDistanceKm = currentSample?.distanceKm ?? 0;
  // Totals belong to the backend's validated GPS sequence. Measuring the
  // rendered road geometry or the simplified client track inflates distance
  // and can shift durations around stops.
  const journeyDistanceKm = data?.summary?.distanceKm ?? data?.distanceKm ?? 0;
  const journeySeconds = data?.summary?.totalSeconds ?? Math.round(track.totalDurationMs / 1000);

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {/* The map is only mounted once there is a real route for the selected
          day. Every other state (loading, error, no history) is shown as an
          overlay so the date selector below stays on screen and usable —
          previously an empty day replaced the whole screen and stranded the
          user with no way back to a day that does have history. */}
      {hasTrack && data ? (
        <CinematicTripMap
          accent={colors.primary}
          category={vehicle.category}
          cameraCommandId={cameraCommandId}
          cameraMode={camera}
          events={data.events ?? []}
          // The road route is drawn only where the engine actually matched. The
          // stretches it could not place travel separately, as an explicitly
          // labelled GPS-only overlay, so one failed chunk can never appear as
          // a confident blue diagonal inside an otherwise matched trace.
          gpsOnlySegments={gpsOnlySegments}
          hasMatchedGeometry={matchedRoute.hasMatchedGeometry}
          onReady={handleMapReady}
          playing={appActive && playing}
          speed={speed}
          stops={data.stops ?? []}
          track={track}
          ui={ui}
        />
      ) : (
        <View style={styles.mapPlaceholder}>
          {showLoading ? (
            <>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.placeholderText}>Loading route history…</Text>
            </>
          ) : isError ? (
            <>
              <MaterialCommunityIcons color={G.sub} name="cloud-alert" size={44} />
              <Text style={styles.placeholderTitle}>Route history unavailable</Text>
              <Text style={styles.placeholderText}>{apiErrorMessage(error)}</Text>
              <Pressable accessibilityRole="button" onPress={refetch} style={styles.retry}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </>
          ) : (
            <>
              <MaterialCommunityIcons color={G.sub} name="map-marker-off-outline" size={44} />
              {/* The screen stays open and fully usable on an empty range - the
                  date filter above is still mounted - so the user can pick
                  another period instead of being returned to Vehicle Details. */}
              <Text style={styles.placeholderTitle}>
                No history data available for the selected period
              </Text>
              <Text style={styles.placeholderText}>
                {activeFromDate === activeToDate
                  ? `${labelDate(activeFromDate)} has no recorded trip for ${vehicle.name}.`
                  : `No recorded trips between ${labelDate(activeFromDate)} and ${labelDate(activeToDate)}.`}
                {' Use the filter above to select another date range.'}
              </Text>
            </>
          )}
        </View>
      )}


      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityLabel="Back" hitSlop={12} onPress={goBack} style={styles.iconBtn}>
          <MaterialCommunityIcons color={G.text} name="arrow-left" size={22} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text numberOfLines={1} style={styles.title}>{vehicle.name}</Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {hasTrack && data
              ? `${journeyDistanceKm.toFixed(1)} km · ${formatDuration(journeySeconds)} · ${data.returnedPoints} GPS pts`
              : isFetching
                ? 'Loading route history…'
                : isError
                  ? 'History unavailable'
                  : 'No history available'}
          </Text>
        </View>
        {/* Date-range filter trigger button. Always mounted so range can be changed anytime. */}
        <Pressable
          accessibilityLabel="Filter date range"
          accessibilityRole="button"
          onPress={openFilterModal}
          style={styles.rangeFilterTrigger}>
          <MaterialCommunityIcons color={colors.primary} name="calendar-range" size={16} />
          {isFetching ? (
            <ActivityIndicator color={colors.primary} size="small" style={{ marginHorizontal: 4 }} />
          ) : (
            <Text numberOfLines={1} style={styles.rangeFilterTriggerText}>
              {formatRangeHeaderLabel(activeFromDate, activeToDate)}
            </Text>
          )}
          <MaterialCommunityIcons color={G.sub} name="chevron-down" size={14} />
        </Pressable>
        <Pressable
          accessibilityLabel="Open trip history details"
          accessibilityRole="button"
          disabled={!data}
          hitSlop={10}
          onPress={() => {
            haptic();
            setPlaying(false);
            setShowHistoryDetails(true);
          }}
          style={[styles.iconBtn, !data && styles.deckDisabled]}>
          <MaterialCommunityIcons color={G.text} name="clipboard-text-clock-outline" size={20} />
        </Pressable>
        <Pressable
          accessibilityLabel="Reload trip history"
          accessibilityRole="button"
          disabled={isFetching}
          hitSlop={12}
          onPress={() => refetch()}
          style={styles.iconBtn}>
          {isFetching ? (
            <ActivityIndicator color={G.text} size="small" />
          ) : (
            <MaterialCommunityIcons color={G.text} name="refresh" size={20} />
          )}
        </Pressable>
      </View>

      {/* Scene, model and camera controls only make sense over a real route. */}
      {hasTrack ? (
        <View
          pointerEvents="none"
          style={[styles.sceneBadge, { top: insets.top + 68 }]}>
          <View style={styles.sceneSignal} />
          <View>
            <Text style={styles.sceneEyebrow}>
              {ui >= 1 ? 'ROUTE COMPLETE' : 'GEOAPIFY DRIVE VIEW'}
            </Text>
            <Text style={styles.sceneMode}>
              {ui >= 1
                ? 'Completed · 100%'
                : `${CAMERAS.find((item) => item.id === camera)?.label} camera`}
            </Text>
          </View>
          <MaterialCommunityIcons
            color={G.text}
            name="map-outline"
            size={16}
          />
        </View>
      ) : null}

      {/* Camera mode rail drives the existing map without remounting it. */}
      {hasTrack ? (
        <View style={[styles.camRail, { top: insets.top + 64 }]}>
          {CAMERAS.map((cam) => {
            const active = cam.id === camera;
            return (
              <Pressable
                key={cam.id}
                accessibilityLabel={cam.label}
                onPress={() => {
                  haptic();
                  setCamera(cam.id);
                  setCameraCommandId((value) => value + 1);
                  if (__DEV__) console.debug(`[Camera] mode ${cam.id}`);
                }}
                style={[styles.camBtn, active && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                <MaterialCommunityIcons color={active ? colors.onPrimary : G.text} name={cam.icon as never} size={18} />
                <Text style={[styles.camLabel, { color: active ? colors.onPrimary : G.sub }]}>{cam.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* Bottom control deck.

          The padding carries the system navigation bar's inset explicitly. It
          was a hardcoded 14, and with `edgeToEdgeEnabled` the app draws behind
          the navigation bar - so on a phone with three-button navigation the
          play button and the speed chips sat UNDERNEATH it. Tapping them hit
          Home or Back instead, which is why playback appeared not to start,
          the speed controls appeared not to work, and the app appeared to
          "exit" when the transport controls were used. The deck is absolutely
          positioned, so it does not inherit the SafeAreaView's own padding and
          has to state the inset itself. */}
      <View style={[styles.deck, { paddingBottom: insets.bottom + 14 }]}>
        <View style={styles.statRow}>
          <View style={styles.speedBlock}>
            <Text style={styles.speedValue}>{curSpeed}</Text>
            <Text style={styles.speedUnit}>km/h</Text>
          </View>
          <View style={styles.statPair}>
            <Stat label="Elapsed" value={`${Math.floor(elapsedMin)}:${String(Math.floor((elapsedMin % 1) * 60)).padStart(2, '0')}`} />
            <Stat label="Covered" value={`${Math.round(ui * 100)}%`} />
            <Stat label="Distance" value={`${coveredDistanceKm.toFixed(1)} km`} />
          </View>
        </View>

        {/* Timeline. Scrubbing is only wired up when the day has a route. */}
        <View style={[styles.timelineWrap, !hasTrack && styles.deckDisabled]}>
          <View
            style={styles.track}
            onLayout={onTrackLayout}
            {...(hasTrack ? pan : {})}>
            <View style={[styles.trackFill, { width: `${ui * 100}%`, backgroundColor: colors.primary }]} />
            {eventTicks.map((t, i) => (
              <View key={i} style={[styles.tick, { left: `${t.frac * 100}%`, backgroundColor: G.text }]} />
            ))}
            <View style={[styles.thumb, { left: `${ui * 100}%`, borderColor: colors.primary }]} />
          </View>
        </View>

        <View style={[styles.controls, !hasTrack && styles.deckDisabled]}>
          <Pressable
            accessibilityLabel="Restart"
            accessibilityRole="button"
            disabled={!hasTrack}
            onPress={restart}
            style={styles.ctrlSmall}>
            <MaterialCommunityIcons color={G.text} name="restart" size={22} />
          </Pressable>
          <Pressable
            accessibilityLabel={playing ? 'Pause' : 'Play'}
            accessibilityRole="button"
            disabled={!hasTrack}
            onPress={togglePlay}
            style={[styles.playBtn, { backgroundColor: colors.primary }]}>
            <MaterialCommunityIcons color={colors.onPrimary} name={playing ? 'pause' : 'play'} size={30} />
          </Pressable>
          <View style={styles.speeds}>
            {SPEEDS.map((sp) => {
              const active = sp === speed;
              return (
                <Pressable
                  key={sp}
                  onPress={() => {
                    haptic();
                    setSpeed(sp);
                  }}
                  style={[styles.speedChip, active && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                  <Text style={[styles.speedChipText, { color: active ? colors.onPrimary : G.sub }]}>{sp}x</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* Date Range Filter Modal Overlay */}
      {showFilterModal ? (
        <View style={styles.filterModalBackdrop}>
          <View style={styles.filterModalCard}>
            <View style={styles.filterHeader}>
              <Text style={styles.filterTitle}>Filter Trip History</Text>
              <Pressable
                accessibilityLabel="Close date filter"
                hitSlop={10}
                onPress={() => setShowFilterModal(false)}>
                <MaterialCommunityIcons color={G.sub} name="close" size={22} />
              </Pressable>
            </View>

            {/* From Date & To Date Input Fields */}
            <View style={styles.rangeFieldRow}>
              <Pressable
                accessibilityLabel="Select from date"
                onPress={() => {
                  haptic();
                  setPickerTarget('from');
                }}
                style={[styles.rangeField, pickerTarget === 'from' && styles.rangeFieldActive]}>
                <Text style={styles.rangeFieldLabel}>From Date</Text>
                <Text style={styles.rangeFieldValue}>{labelDate(draftFromDate)}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Select to date"
                onPress={() => {
                  haptic();
                  setPickerTarget('to');
                }}
                style={[styles.rangeField, pickerTarget === 'to' && styles.rangeFieldActive]}>
                <Text style={styles.rangeFieldLabel}>To Date</Text>
                <Text style={styles.rangeFieldValue}>{labelDate(draftToDate)}</Text>
              </Pressable>
            </View>

            {/* Quick Presets */}
            <View style={styles.presetsRow}>
              <Pressable onPress={() => selectPreset('today')} style={styles.presetChip}>
                <Text style={styles.presetChipText}>Today</Text>
              </Pressable>
              <Pressable onPress={() => selectPreset('yesterday')} style={styles.presetChip}>
                <Text style={styles.presetChipText}>Yesterday</Text>
              </Pressable>
              <Pressable onPress={() => selectPreset('week')} style={styles.presetChip}>
                <Text style={styles.presetChipText}>Last 7 Days</Text>
              </Pressable>
              <Pressable onPress={() => selectPreset('month')} style={styles.presetChip}>
                <Text style={styles.presetChipText}>This Month</Text>
              </Pressable>
            </View>

            {/* Calendar Grid Header */}
            <View style={styles.calendarHeader}>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  haptic();
                  if (calMonth === 0) {
                    setCalMonth(11);
                    setCalYear((y) => y - 1);
                  } else {
                    setCalMonth((m) => m - 1);
                  }
                }}>
                <MaterialCommunityIcons color={G.text} name="chevron-left" size={22} />
              </Pressable>
              <Text style={styles.calendarMonthText}>
                {MONTH_NAMES[calMonth]} {calYear}
              </Text>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  haptic();
                  if (calMonth === 11) {
                    setCalMonth(0);
                    setCalYear((y) => y + 1);
                  } else {
                    setCalMonth((m) => m + 1);
                  }
                }}>
                <MaterialCommunityIcons color={G.text} name="chevron-right" size={22} />
              </Pressable>
            </View>

            {/* Weekday Labels */}
            <View style={styles.weekDaysRow}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <Text key={d} style={styles.weekDayText}>
                  {d}
                </Text>
              ))}
            </View>

            {/* Days Grid */}
            <View style={styles.daysGrid}>
              {getCalendarDays(calYear, calMonth).map((cell, idx) => {
                const isFrom = cell.dateStr === draftFromDate;
                const isTo = cell.dateStr === draftToDate;
                const inRange = cell.dateStr >= draftFromDate && cell.dateStr <= draftToDate;
                const isFuture = cell.dateStr > today;

                return (
                  <Pressable
                    key={`${cell.dateStr}-${idx}`}
                    disabled={isFuture}
                    onPress={() => {
                      haptic();
                      if (pickerTarget === 'from') {
                        setDraftFromDate(cell.dateStr);
                        if (cell.dateStr > draftToDate) setDraftToDate(cell.dateStr);
                        setPickerTarget('to');
                      } else {
                        setDraftToDate(cell.dateStr);
                        if (cell.dateStr < draftFromDate) setDraftFromDate(cell.dateStr);
                      }
                    }}
                    style={[
                      styles.dayCell,
                      inRange && !isFrom && !isTo && styles.dayCellInRange,
                      (isFrom || isTo) && styles.dayCellSelected,
                      isFuture && { opacity: 0.3 },
                    ]}>
                    <Text
                      style={[
                        styles.dayCellText,
                        !cell.currentMonth && styles.dayCellTextMuted,
                        (isFrom || isTo) && styles.dayCellTextSelected,
                      ]}>
                      {cell.day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Validation Alert */}
            {isInvalidRange ? (
              <View style={styles.validationErrorBox}>
                <MaterialCommunityIcons color="#EF4444" name="alert-circle-outline" size={18} />
                <Text style={styles.validationErrorText}>
                  From Date cannot be later than To Date.
                </Text>
              </View>
            ) : null}

            {/* Action Buttons */}
            <View style={styles.filterActionsRow}>
              <Pressable accessibilityRole="button" onPress={resetFilter} style={styles.filterResetBtn}>
                <Text style={styles.filterResetText}>Reset</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isInvalidRange}
                onPress={applyFilter}
                style={[styles.filterApplyBtn, isInvalidRange && styles.filterApplyBtnDisabled]}>
                <Text style={styles.filterApplyText}>Apply Filter</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {showHistoryDetails && data ? (
        <HistoryDetails
          data={data}
          onClose={() => setShowHistoryDetails(false)}
          vehicleName={vehicle.name}
        />
      ) : null}
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function HistoryDetails({
  data,
  onClose,
  vehicleName,
}: {
  data: PlaybackResponse;
  onClose: () => void;
  vehicleName: string;
}) {
  const summary = data.summary;
  const timeline = data.timeline ?? [];
  const stops = data.stops ?? [];
  const rejected = Object.entries(data.rejectedPoints ?? {}).filter(([, count]) => count > 0);
  const rejectedTotal = rejected.reduce((total, [, count]) => total + count, 0);
  const distanceKm = summary?.distanceKm ?? data.distanceKm ?? 0;

  return (
    <View style={styles.historyBackdrop}>
      <Pressable accessibilityLabel="Close trip history" onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={styles.historyCard}>
        <View style={styles.historyHeader}>
          <View style={styles.historyHeaderCopy}>
            <Text style={styles.historyEyebrow}>TRIP HISTORY</Text>
            <Text numberOfLines={1} style={styles.historyTitle}>{vehicleName}</Text>
            <Text style={styles.historyRange}>
              {formatHistoryTime(summary?.startTime)} – {formatHistoryTime(summary?.endTime)}
            </Text>
          </View>
          <Pressable accessibilityLabel="Close history details" hitSlop={10} onPress={onClose} style={styles.historyClose}>
            <MaterialCommunityIcons color={G.text} name="close" size={22} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.historyContent} showsVerticalScrollIndicator={false}>
          <View style={styles.historySummaryGrid}>
            <HistoryMetric icon="map-marker-distance" label="Distance" value={`${distanceKm.toFixed(2)} km`} />
            <HistoryMetric icon="clock-outline" label="Total time" value={formatDuration(summary?.totalSeconds)} />
            <HistoryMetric icon="car-arrow-right" label="Moving" value={formatDuration(summary?.movingSeconds)} tone="#087C73" />
            <HistoryMetric icon="stop-circle-outline" label="Stopped" value={formatDuration(summary?.stoppedSeconds)} tone="#DC2626" />
            <HistoryMetric icon="signal-off" label="No signal" value={formatDuration(summary?.noDataSeconds)} tone="#64748B" />
            <HistoryMetric icon="map-marker-check-outline" label="Stops" value={String(summary?.stopCount ?? stops.length)} tone="#D97706" />
          </View>

          <View style={styles.historySection}>
            <Text style={styles.historySectionTitle}>Journey endpoints</Text>
            <HistoryLocation
              color="#16A34A"
              label="Started"
              time={summary?.startLocation?.time ?? summary?.startTime}
              address={summary?.startLocation?.address}
              latitude={summary?.startLocation?.lat}
              longitude={summary?.startLocation?.lng}
            />
            <View style={styles.endpointConnector} />
            <HistoryLocation
              color="#DC2626"
              label="Ended"
              time={summary?.endLocation?.time ?? summary?.endTime}
              address={summary?.endLocation?.address}
              latitude={summary?.endLocation?.lat}
              longitude={summary?.endLocation?.lng}
            />
          </View>

          <View style={styles.historySection}>
            <Text style={styles.historySectionTitle}>Chronological activity</Text>
            {timeline.length > 0 ? timeline.map((segment, index) => {
              const presentation = timelinePresentation(segment);
              const address = segment.type === 'STOPPED'
                ? segment.startAddress
                : segment.startAddress && segment.endAddress
                  ? `${segment.startAddress} → ${segment.endAddress}`
                  : segment.startAddress ?? segment.endAddress;
              return (
                <View key={`${segment.type}-${segment.from}-${index}`} style={styles.timelineDetailRow}>
                  <View style={[styles.timelineDetailIcon, { backgroundColor: `${presentation.color}14` }]}>
                    <MaterialCommunityIcons color={presentation.color} name={presentation.icon} size={19} />
                  </View>
                  <View style={styles.timelineDetailBody}>
                    <View style={styles.timelineDetailHeading}>
                      <Text style={[styles.timelineDetailTitle, { color: presentation.color }]}>{presentation.label}</Text>
                      <Text style={styles.timelineDetailDuration}>{formatDuration(segment.seconds)}</Text>
                    </View>
                    <Text style={styles.timelineDetailTime}>
                      {formatHistoryTime(segment.from)} – {formatHistoryTime(segment.to)}
                    </Text>
                    {address ? <Text numberOfLines={2} style={styles.timelineDetailAddress}>{address}</Text> : null}
                    {segment.type === 'MOVING' ? (
                      <Text style={styles.timelineDetailMeta}>
                        {segment.distanceKm.toFixed(2)} km · avg {segment.averageSpeedKmh.toFixed(1)} km/h · max {segment.maxSpeedKmh.toFixed(1)} km/h
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            }) : (
              <Text style={styles.historyEmpty}>No activity segments were recorded in this period.</Text>
            )}
          </View>

          {stops.length > 0 ? (
            <View style={styles.historySection}>
              <Text style={styles.historySectionTitle}>Stop details</Text>
              {stops.map((stop) => (
                <View key={`${stop.index}-${stop.from}`} style={styles.stopDetailRow}>
                  <View style={styles.stopNumber}><Text style={styles.stopNumberText}>{stop.index}</Text></View>
                  <View style={styles.stopDetailBody}>
                    <Text style={styles.stopDetailTitle}>{stop.address || `${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`}</Text>
                    <Text style={styles.stopDetailMeta}>
                      {formatHistoryTime(stop.from)} – {formatHistoryTime(stop.to)} · {formatDuration(stop.seconds)}
                    </Text>
                    <Text style={styles.stopDetailDistance}>{stop.distanceFromPreviousKm.toFixed(2)} km from previous stop/start</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.qualityCard}>
            <View style={styles.qualityTitleRow}>
              <MaterialCommunityIcons
                color={rejectedTotal > 0 ? '#D97706' : '#16A34A'}
                name={rejectedTotal > 0 ? 'shield-alert-outline' : 'shield-check-outline'}
                size={21}
              />
              <View style={styles.qualityTitleCopy}>
                <Text style={styles.qualityTitle}>GPS data quality</Text>
                <Text style={styles.qualitySubtitle}>
                  {data.returnedPoints} valid of {data.totalPoints} received · {data.matchStatus ?? 'UNMATCHED'} route
                </Text>
              </View>
            </View>
            {rejected.map(([reason, count]) => (
              <View key={reason} style={styles.qualityReasonRow}>
                <Text style={styles.qualityReason}>{reason.replaceAll('_', ' ').toLowerCase()}</Text>
                <Text style={styles.qualityCount}>{count}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function HistoryMetric({ icon, label, tone = G.text, value }: { icon: string; label: string; tone?: string; value: string }) {
  return (
    <View style={styles.historyMetric}>
      <MaterialCommunityIcons color={tone} name={icon as never} size={18} />
      <Text style={[styles.historyMetricValue, { color: tone }]}>{value}</Text>
      <Text style={styles.historyMetricLabel}>{label}</Text>
    </View>
  );
}

function HistoryLocation({
  address,
  color,
  label,
  latitude,
  longitude,
  time,
}: {
  address?: string | null;
  color: string;
  label: string;
  latitude?: number;
  longitude?: number;
  time?: string | null;
}) {
  const coordinate = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? `${latitude!.toFixed(5)}, ${longitude!.toFixed(5)}`
    : 'Coordinates unavailable';
  return (
    <View style={styles.endpointRow}>
      <View style={[styles.endpointDot, { backgroundColor: color }]} />
      <View style={styles.endpointBody}>
        <View style={styles.endpointHeading}>
          <Text style={styles.endpointLabel}>{label}</Text>
          <Text style={styles.endpointTime}>{formatHistoryTime(time)}</Text>
        </View>
        <Text numberOfLines={2} style={styles.endpointAddress}>{address || coordinate}</Text>
      </View>
    </View>
  );
}

function Center({ text, spinner, onBack, onRetry }: { text: string; spinner?: boolean; onBack?: () => void; onRetry?: () => void }) {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.center}>
      {onBack ? (
        <View style={{ width: '100%', paddingHorizontal: 16, paddingTop: 8 }}>
          <Pressable accessibilityLabel="Back" onPress={onBack} style={styles.iconBtn}>
            <MaterialCommunityIcons color={G.text} name="arrow-left" size={22} />
          </Pressable>
        </View>
      ) : null}
      <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12 }}>
        {spinner ? <ActivityIndicator color="#22c55e" size="large" /> : (
          <MaterialCommunityIcons color={G.sub} name="movie-open-outline" size={48} />
        )}
        <Text style={styles.centerText}>{text}</Text>
        {onRetry ? (
          <Pressable onPress={onRetry} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function lerpAngle(start: number, end: number, t: number): number {
  const da = (((end - start) % 360) + 540) % 360 - 180;
  return normalizeHeading(start + da * t);
}

/**
 * Android cannot rasterise a marker's React view under the New Architecture, so
 * the vehicle is drawn from a pre-baked bitmap there -- see
 * src/components/vehicleMarkerSprites. iOS keeps the vector marker because
 * MapKit has no marker rotation at all.
 */
/**
 * Is the app in the foreground?
 *
 * Android reports `AppState.currentState` as "unknown" until the native module
 * has answered, and an app that is already foregrounded never fires a change
 * event to correct it. Comparing against "active" therefore left the playback
 * clock gated off for the whole session with no way to recover, so anything not
 * explicitly backgrounded counts as active.
 */
function isForeground(state: AppStateStatus | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

const USE_VEHICLE_SPRITE = Platform.OS === 'android';

type CinematicTripMapProps = {
  accent: string;
  /** Device category, for choosing the marker glyph. */
  category?: string;
  cameraCommandId: number;
  cameraMode: CameraMode;
  events: PlaybackEventMarker[];
  /**
   * Stretches with no road answer, as validated GPS.
   *
   * Drawn as a thin dashed amber overlay beneath the road route, never as part
   * of it. Splicing them together is what produced a single blue polyline of
   * `matched road + raw chord + matched road`.
   */
  gpsOnlySegments: { latitude: number; longitude: number }[][];
  /** False when the engine placed nothing at all: there is no road to draw. */
  hasMatchedGeometry: boolean;
  onReady: () => void;
  playing: boolean;
  speed: number;
  stops: PlaybackStopMarker[];
  track: PlaybackTrack;
  ui: number;
};


function coordinateAhead(
  latitude: number,
  longitude: number,
  heading: number,
  meters: number
) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude: 0, longitude: 0 };
  }
  if (meters <= 0) return { latitude, longitude };
  const distance = meters / 6_371_000;
  const bearing = (normalizeHeading(heading) * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lng1 = (longitude * Math.PI) / 180;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinDist = Math.sin(distance);
  const cosDist = Math.cos(distance);
  const sinLat2 = sinLat1 * cosDist + cosLat1 * sinDist * Math.cos(bearing);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const y = Math.sin(bearing) * sinDist * cosLat1;
  const x = cosDist - sinLat1 * Math.sin(lat2);
  const lng2 = lng1 + Math.atan2(y, x);
  const resultLat = (lat2 * 180) / Math.PI;
  const resultLng = (lng2 * 180) / Math.PI;
  if (!Number.isFinite(resultLat) || !Number.isFinite(resultLng)) {
    return { latitude, longitude };
  }
  return {
    latitude: resultLat,
    longitude: resultLng,
  };
}

/** The one coordinate gate, shared with every other stage of the pipeline. */
function isDisplayCoordinate(latitude: unknown, longitude: unknown) {
  return coordinateOf(latitude, longitude) != null;
}

/**
 * Cinematic playback keeps the configured native map permanently mounted.
 * Route/event layers are rendered by the map SDK and the transparent 3D vehicle
 * is projected over its real coordinate, so the GL surface can never obscure
 * tiles, roads, labels or buildings.
 */
function CinematicTripMap({
  accent,
  category,
  cameraCommandId,
  cameraMode,
  events,
  gpsOnlySegments,
  hasMatchedGeometry,
  onReady,
  playing,
  speed,
  stops,
  track,
  ui,
}: CinematicTripMapProps) {
  /**
   * Whether the native map may be mounted AT ALL.
   *
   * On Android, constructing react-native-maps' MapView without
   * `com.google.android.geo.API_KEY` in the manifest throws
   * `IllegalStateException: API key not found` from
   * `com.rnmaps.maps.MapView.<init>` — a FATAL EXCEPTION on the main thread, so
   * the process dies. It is a native crash during view pre-allocation, which
   * means no JavaScript error boundary, `try`/`catch` or `onError` prop can see
   * it, let alone stop it.
   *
   * `app.config.js` only injects that meta-data when GOOGLE_MAPS_API_KEY is
   * set, so any build made without the key crashes the instant this screen
   * mounts its map. That is the whole of "tapping Playback exits the app": Live
   * Tracking already made this check and fell back to the WebView map, and this
   * screen simply never made it.
   */
  // One provider and one rendering engine on every platform. The previous
  // native branch silently switched Android playback back to Google Maps and
  // could crash before React mounted when that key was absent.
  const useNativeMap = false;
  const mapRef = useRef<MapView>(null);
  const mountedRef = useRef(true);
  const projectionRequestRef = useRef(0);
  const lastCameraAtRef = useRef(0);
  const lastCameraCoordinateRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const lastCameraModeRef = useRef<CameraMode | null>(null);
  const stableHeadingRef = useRef<number | null>(null);
  const lastProjectionAtRef = useRef(0);
  const readyReportedRef = useRef(false);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [mapLoaded, setMapLoaded] = useState(!useNativeMap);
  const [autoFollow, setAutoFollow] = useState(true);
  const [resumeRequest, setResumeRequest] = useState(0);
  const [mapCameraHeading, setMapCameraHeading] = useState(0);
  const mapPadding = useMemo(
    () => ({
      top: Math.max(174, insets.top + 150),
      right: Math.max(88, Math.min(112, width * 0.18)),
      bottom: Math.max(244, insets.bottom + 226),
      left: Math.max(24, Math.min(36, width * 0.06)),
    }),
    [insets.bottom, insets.top, width]
  );
  const points = track.points;
  const routeCoords = useMemo(
    () =>
      sanitizeRouteCoordinates(
        points
          .filter((point) => isDisplayCoordinate(point.lat, point.lng))
          .map((point) => ({ latitude: point.lat, longitude: point.lng }))
      ),
    [points]
  );

  const playbackSample = useMemo(
    () => sampleAt(track, ui * track.totalDurationMs),
    [track, ui]
  );
  const cur = useMemo(() => {
    const sample = playbackSample;
    const lat = sample?.latitude ?? points[0]?.lat;
    const lng = sample?.longitude ?? points[0]?.lng;
    return {
      // `?? 0` here used to put the vehicle on Null Island whenever no sample
      // and no first point were available. `hasValidPosition` is what the
      // marker is gated on instead, so the absence of a position draws no
      // vehicle rather than drawing one 500 km off the coast of Ghana.
      lat: lat ?? 0,
      lng: lng ?? 0,
      hasValidPosition: isDisplayCoordinate(lat as number, lng as number),
      heading: Number.isFinite(sample?.heading) ? (sample as { heading: number }).heading : 0,
      speed: Number.isFinite(sample?.speed) ? (sample as { speed: number }).speed : 0,
      atEnd: sample?.atEnd ?? false,
      completedPointCount: sample?.completedPointCount ?? 0,
      segmentIndex: sample?.segmentIndex ?? 0,
    };
  }, [playbackSample, points]);
  // One polyline per observed run. A coverage gap is left undrawn rather than
  // closed with a straight line across roads that were never recorded.
  // Each run is split again on the segment rule before it is drawn. The track's
  // own runs already break at the coverage gaps the backend flagged; this
  // catches a step inside a run that no observed stretch of road could be, so a
  // diagonal can never survive to the polyline.
  //
  // The blue route is road geometry and ONLY road geometry.
  //
  // When the range produced no confident match at all there is no road to draw,
  // so both blue layers are empty and the journey appears on the GPS-only
  // overlay below instead. The track still contains every fix - playback, the
  // timeline, the speed readout and the stop dwell all need them - it simply is
  // not the thing being drawn in blue. Drawing it wholesale is what turned
  // `matched road + failed chunk + matched road` into one confident polyline
  // with a diagonal through the middle of it.
  const fullRouteSegments = useMemo(
    () =>
      hasMatchedGeometry
        ? routeSegments(track).flatMap((segment) => splitRouteCoordinates(segment))
        : [],
    [hasMatchedGeometry, track]
  );
  const travelledRouteSegs = useMemo(
    () =>
      hasMatchedGeometry
        ? travelledRouteSegments(track, playbackSample).flatMap((segment) =>
            splitRouteCoordinates(segment)
          )
        : [],
    [hasMatchedGeometry, playbackSample, track]
  );
  /**
   * Stretches with no road answer, drawn thin, dashed and amber.
   *
   * Split on the same segment rule as the road route, so a coverage gap stays a
   * gap even on the diagnostic layer.
   */
  const diagnosticRouteSegments = useMemo(
    () => gpsOnlySegments.flatMap((segment) => splitRouteCoordinates(segment)),
    [gpsOnlySegments]
  );

  const styleInfo = getMapStyleInfo('bright');
  const webMarkers = useMemo<WebMapMarker[]>(
    () => [
      {
        category: (category ?? '').toUpperCase(),
        color: accent,
        heading: cur.heading,
        id: 'vehicle',
        lat: cur.lat,
        lng: cur.lng,
        moving: playing,
      },
    ],
    [accent, category, cur, playing]
  );
  const webPolylines = useMemo<[number, number][][]>(
    () =>
      travelledRouteSegs.map((segment) =>
        segment.map((point) => [point.longitude, point.latitude] as [number, number])
      ),
    [travelledRouteSegs]
  );
  const webDiagnosticPolylines = useMemo<[number, number][][]>(
    () =>
      diagnosticRouteSegments.map((segment) =>
        segment.map((point) => [point.longitude, point.latitude] as [number, number])
      ),
    [diagnosticRouteSegments]
  );

  const validEvents = useMemo(
    () => (events ?? []).filter((event) => isDisplayCoordinate(event.lat, event.lng)),
    [events]
  );
  const validStops = useMemo(
    () => (stops ?? []).filter((stop) => isDisplayCoordinate(stop.lat, stop.lng)),
    [stops]
  );

  const webHistory = useMemo(
    () => {
      // Start/end pins mark the JOURNEY, so they fall back to the diagnostic
      // geometry when no road matched - a trip with no matched road still
      // started and ended somewhere, and dropping its pins as well would make
      // an unmatched day look like no data at all.
      const terminalSegments =
        fullRouteSegments.length > 0 ? fullRouteSegments : diagnosticRouteSegments;
      const firstPoint = terminalSegments[0]?.[0];
      const lastSegment = terminalSegments[terminalSegments.length - 1];
      const lastPoint = lastSegment?.[lastSegment.length - 1];
      return {
        routes: fullRouteSegments.map((segment) =>
        segment.map((point) => [point.longitude, point.latitude] as [number, number])
      ),
        stops: validStops.map((stop, index) => ({
          index: index + 1,
          lat: stop.lat,
          lng: stop.lng,
          active: false,
        })),
        events: validEvents.map((event, index) => ({
          id: `${event.t}-${index}`,
          lat: event.lat,
          lng: event.lng,
          label: event.eventType.replaceAll('_', ' '),
        })),
        start: firstPoint ? { lat: firstPoint.latitude, lng: firstPoint.longitude } : null,
        end: lastPoint ? { lat: lastPoint.latitude, lng: lastPoint.longitude } : null,
      };
    },
    [diagnosticRouteSegments, fullRouteSegments, validEvents, validStops]
  );

  const reportReady = useCallback(() => {
    if (readyReportedRef.current) return;
    readyReportedRef.current = true;
    onReady();
  }, [onReady]);

  useEffect(() => {
    mountedRef.current = true;
    if (!useNativeMap) reportReady();
    return () => {
      mountedRef.current = false;
      projectionRequestRef.current += 1;
    };
  }, [reportReady, useNativeMap]);

  /** The camera command this effect last acted on. See `modeChanged` below. */
  const lastCameraCommandRef = useRef(cameraCommandId);

  useEffect(() => {
    setAutoFollow(true);
    lastCameraAtRef.current = 0;
  }, [cameraCommandId]);

  // Android caches a custom marker's bitmap, so it needs a window in which to
  // redraw. Heading is bucketed to 15deg to keep that window rare.
  const headingBucket = Math.round(normalizeHeading(cur.heading - mapCameraHeading) / 15);
  const [vehicleTracksView, setVehicleTracksView] = useState(true);
  useEffect(() => {
    if (USE_VEHICLE_SPRITE) return;
    setVehicleTracksView(true);
    const timer = setTimeout(() => {
      if (mountedRef.current) setVehicleTracksView(false);
    }, 240);
    return () => clearTimeout(timer);
  }, [accent, headingBucket, playing]);

  const projectVehicle = useCallback(async (force = false) => {
    const instance = mapRef.current;
    if (!instance || !mapLoaded) return;
    const now = Date.now();
    if (!force && now - lastProjectionAtRef.current < 40) return;
    lastProjectionAtRef.current = now;
    const request = ++projectionRequestRef.current;
    try {
      const camera = await instance.getCamera();
      if (!mountedRef.current || request !== projectionRequestRef.current) return;
      setMapCameraHeading(Number.isFinite(camera.heading) ? normalizeHeading(camera.heading) : 0);
    } catch {
      // The camera can reject while the native map is changing regions.
    }
  }, [mapLoaded]);

  useEffect(() => {
    if (!useNativeMap) return;
    void projectVehicle(false);
  }, [projectVehicle, useNativeMap]);

  useEffect(() => {
    if (!useNativeMap || !mapLoaded || !autoFollow || !mapRef.current) return;
    // A camera animation started against a map that is being torn down is a
    // native-side call on a released view.
    if (!mountedRef.current) return;
    if (!cur.hasValidPosition) return;

    const now = Date.now();
    // A re-tap of the ALREADY-active camera button is a request to re-frame,
    // not a no-op. Overview is the one where that matters: after scrubbing or
    // playing, "fit the whole journey again" is exactly what the button is for,
    // and gating the refit on a mode CHANGE alone made the second tap do
    // nothing. `cameraCommandId` was already incremented on every tap; it was
    // simply not read here.
    const modeChanged =
      lastCameraModeRef.current !== cameraMode || lastCameraCommandRef.current !== cameraCommandId;
    lastCameraCommandRef.current = cameraCommandId;
    if (cameraMode === 'overview') {
      if (modeChanged) {
        try {
          mapRef.current.setCamera({ heading: 0, pitch: 0 });
          setMapCameraHeading(0);
          if (routeCoords.length === 1 && routeCoords[0]) {
            mapRef.current.animateCamera(
              { center: routeCoords[0], heading: 0, pitch: 0, zoom: 16 },
              { duration: 520 }
            );
          } else if (routeCoords.length >= 2) {
            mapRef.current.fitToCoordinates(routeCoords, {
              edgePadding: mapPadding,
              animated: true,
            });
          }
        } catch {
          // Native camera errors are non-fatal
        }
      }
      lastCameraModeRef.current = cameraMode;
      return;
    }
    if (!playing && !modeChanged) return;

    // Scale animation interval and duration according to playback speed
    const baseInterval = speed > 2 ? 160 : speed > 1 ? 220 : 280;
    const interval = modeChanged ? 0 : baseInterval;
    if (!modeChanged && now - lastCameraAtRef.current < interval) return;

    const previousCoordinate = lastCameraCoordinateRef.current;
    const movementKm = previousCoordinate
      ? haversineKm(
        previousCoordinate.latitude,
        previousCoordinate.longitude,
        cur.lat,
        cur.lng
      )
      : Number.POSITIVE_INFINITY;
    if (!modeChanged && movementKm < 0.0003) return;

    const rawHeading = Number.isFinite(cur.heading) ? normalizeHeading(cur.heading) : 0;
    const prevHeading = stableHeadingRef.current ?? rawHeading;
    // Smooth angle lerp to eliminate camera twisting/jittering
    const travelHeading = modeChanged
      ? rawHeading
      : lerpAngle(prevHeading, rawHeading, 0.32);
    stableHeadingRef.current = travelHeading;

    // Smooth continuous speed-based scaling without discrete steps
    const speedRatio = Math.min(1, Math.max(0, cur.speed / 100));
    let pitch = 28;
    let zoom = 16.2 - speedRatio * 0.5;
    let heading = 0;
    let forwardMeters = 8 + speedRatio * 14;

    if (cameraMode === 'chase') {
      pitch = 48;
      zoom = 16.4 - speedRatio * 0.6;
      heading = travelHeading;
      forwardMeters = 14 + speedRatio * 20;
    } else if (cameraMode === 'cinematic') {
      pitch = 55;
      zoom = 16.0 - speedRatio * 0.5;
      heading = travelHeading;
      forwardMeters = 16 + speedRatio * 22;
    } else if (cameraMode === 'drone') {
      pitch = 36;
      zoom = 14.2 - speedRatio * 0.6;
      heading = travelHeading;
      forwardMeters = 10 + speedRatio * 14;
    } else if (cameraMode === 'top') {
      pitch = 0;
      zoom = 16.5 - speedRatio * 0.6;
      heading = 0;
      forwardMeters = 0;
    }

    const center = coordinateAhead(cur.lat, cur.lng, travelHeading, forwardMeters);
    if (!Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) return;

    const duration = modeChanged ? 550 : Math.min(360, Math.max(180, Math.round(baseInterval * 1.1)));

    try {
      mapRef.current.animateCamera(
        { center, heading, pitch, zoom },
        { duration }
      );
      setMapCameraHeading(heading);
      lastCameraAtRef.current = now;
      lastCameraCoordinateRef.current = { latitude: cur.lat, longitude: cur.lng };
      lastCameraModeRef.current = cameraMode;
    } catch {
      // Native animation errors are non-fatal
    }
  }, [
    autoFollow,
    cameraCommandId,
    cameraMode,
    cur.hasValidPosition,
    cur.heading,
    cur.lat,
    cur.lng,
    cur.speed,
    mapLoaded,
    mapPadding,
    playing,
    resumeRequest,
    routeCoords,
    speed,
    useNativeMap,
  ]);

  const handleNativeMapReady = useCallback(() => {
    // onMapReady can fire after the screen has been popped - the native view
    // outlives the React tree for a moment - and setting state then is a leak
    // that React reports against an unmounted component.
    if (!mountedRef.current) return;
    setMapLoaded(true);
    reportReady();
  }, [reportReady]);

  const syncProjectionDuringCamera = useCallback(() => {
    if (!autoFollow) void projectVehicle(false);
  }, [autoFollow, projectVehicle]);

  const syncProjectionAfterCamera = useCallback(() => {
    if (!autoFollow) void projectVehicle(true);
  }, [autoFollow, projectVehicle]);

  const handleWebProjection = useCallback((projection: WebMapProjection) => {
    if (!mountedRef.current) return;
    setMapCameraHeading(normalizeHeading(projection.heading));
  }, []);

  const pauseFollowing = useCallback(() => {
    setAutoFollow(false);
  }, []);

  const resumeFollowing = useCallback(() => {
    setAutoFollow(true);
    lastCameraAtRef.current = 0;
    lastCameraModeRef.current = null;
    setResumeRequest((value) => value + 1);
  }, []);

  return (
    <View style={StyleSheet.absoluteFill}>
      {!useNativeMap ? (
        <FleetWebMap
          cameraMode={cameraMode}
          followSelected={autoFollow}
          diagnosticPolylines={webDiagnosticPolylines}
          history={webHistory}
          mapStyle={styleInfo.webStyle}
          markers={webMarkers}
          onInteraction={pauseFollowing}
          onProjectionChange={handleWebProjection}
          polylines={webPolylines}
          selectedId="vehicle"
          style={StyleSheet.absoluteFillObject}
        />
      ) : (
        <MapView
          ref={mapRef}
          customMapStyle={styleInfo.style}
          initialCamera={{
            center: routeCoords[0] ?? { latitude: 12.97, longitude: 77.59 },
            heading: 0,
            pitch: 45,
            zoom: 15.8,
          }}
          mapPadding={mapPadding}
          loadingBackgroundColor="#16202B"
          loadingEnabled
          loadingIndicatorColor={accent}
          moveOnMarkerPress={false}
          onMapReady={handleNativeMapReady}
          onPanDrag={pauseFollowing}
          onRegionChange={syncProjectionDuringCamera}
          onRegionChangeComplete={syncProjectionAfterCamera}
          onTouchStart={pauseFollowing}
          pitchEnabled
          rotateEnabled
          showsBuildings
          showsCompass={false}
          showsUserLocation={false}
          style={StyleSheet.absoluteFillObject}
          toolbarEnabled={false}>
          {/* GPS-only diagnostic, beneath the road route and unmistakably
              different: thin, amber, no aura. It shows where the vehicle
              reported being over a stretch the matcher could not place. It is
              not a road and must never be drawn as one. */}
          {diagnosticRouteSegments.map((segment, index) => (
            <StableRouteLine
              key={`trip-gps-only-${index}`}
              auraColor=""
              color={ROUTE_GPS_ONLY}
              coordinates={segment}
              width={2}
              zIndex={11}
            />
          ))}
          {fullRouteSegments.map((segment, index) => (
            <StableBaseRoute
              key={`trip-base-${index}`}
              auraColor={ROUTE_BLUE_AURA}
              coordinates={segment}
              lineColor={ROUTE_BLUE_BASE}
              lineWidth={6}
            />
          ))}
          {travelledRouteSegs.map((segment, index) => (
            <StableRouteLine
              key={`trip-done-${index}`}
              auraColor={ROUTE_BLUE_AURA}
              color={ROUTE_BLUE}
              coordinates={segment}
              zIndex={13}
            />
          ))}
          {validEvents.map((event, index) => (
            <Marker
              key={`${event.t}-${event.eventType}-${index}`}
              anchor={{ x: 0.5, y: 0.5 }}
              coordinate={{ latitude: event.lat, longitude: event.lng }}
              tracksViewChanges={false}
              zIndex={20}>
              <View style={styles.eventMarker}>
                <MaterialCommunityIcons color="#071018" name="alert" size={12} />
              </View>
            </Marker>
          ))}
          {validStops.map((stop, index) => (
            <Marker
              key={`${stop.from}-${stop.to}-${index}`}
              anchor={{ x: 0.5, y: 0.5 }}
              coordinate={{ latitude: stop.lat, longitude: stop.lng }}
              tracksViewChanges={false}
              zIndex={21}>
              <View style={styles.stopMarker}>
                <MaterialCommunityIcons color="#071018" name="parking" size={12} />
              </View>
            </Marker>
          ))}
          {!cur.hasValidPosition ? null : USE_VEHICLE_SPRITE ? (
            <Marker
              anchor={{ x: 0.5, y: 0.5 }}
              coordinate={{ latitude: cur.lat, longitude: cur.lng }}
              flat
              identifier="playback-vehicle"
              image={vehicleSprite(playing ? 'RUNNING' : 'STOPPED', true)}
              rotation={normalizeHeading(cur.heading)}
              tracksViewChanges={false}
              zIndex={60}
            />
          ) : (
            <Marker
              anchor={{ x: 0.5, y: 0.5 }}
              coordinate={{ latitude: cur.lat, longitude: cur.lng }}
              flat
              identifier="playback-vehicle"
              tracksViewChanges={vehicleTracksView}
              zIndex={60}>
              <VehicleMarker
                category={markerCategory(category)}
                color={accent}
                heading={normalizeHeading(cur.heading - mapCameraHeading)}
                moving={playing}
                selected
                size={56}
              />
            </Marker>
          )}
        </MapView>
      )}

      {!autoFollow ? (
        <Pressable
          accessibilityLabel="Resume cinematic tracking"
          accessibilityRole="button"
          onPress={resumeFollowing}
          style={styles.resumeTracking}>
          <MaterialCommunityIcons color="#071018" name="crosshairs-gps" size={17} />
          <Text style={styles.resumeTrackingText}>Resume Cinematic Tracking</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#EDF4F7', flex: 1 },
  center: { alignItems: 'center', backgroundColor: '#EDF4F7', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  centerText: { color: G.sub, fontSize: 15, textAlign: 'center' },
  retry: { borderColor: '#22c55e', borderRadius: 10, borderWidth: 1, marginTop: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: '#22c55e', fontWeight: '800' },

  topBar: { alignItems: 'center', flexDirection: 'row', gap: 8, left: 0, paddingHorizontal: 14, position: 'absolute', right: 0, top: 0 },
  iconBtn: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 12, borderWidth: 1,
    height: 40, justifyContent: 'center', width: 40,
  },
  titleWrap: {
    backgroundColor: G.glass,
    borderColor: G.hair,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  title: { color: G.text, fontSize: 17, fontWeight: '900' },
  subtitle: { color: G.sub, fontSize: 12, marginTop: 1 },
  datePicker: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 12, borderWidth: 1,
    flexDirection: 'row', gap: 2, paddingHorizontal: 4, paddingVertical: 6,
  },
  dateArrow: { alignItems: 'center', height: 28, justifyContent: 'center', width: 22 },
  dateLabel: { color: G.text, fontSize: 12, fontWeight: '800', minWidth: 58, textAlign: 'center' },
  dateLabelSlot: { alignItems: 'center', justifyContent: 'center', minWidth: 58 },

  mapPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: '#EDF4F7',
    gap: 10,
    justifyContent: 'center',
    paddingBottom: 200,
    paddingHorizontal: 34,
    paddingTop: 120,
  },
  placeholderTitle: { color: G.text, fontSize: 17, fontWeight: '900', textAlign: 'center' },
  placeholderText: { color: G.sub, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  deckDisabled: { opacity: 0.35 },

  sceneBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderColor: 'rgba(20,117,143,0.18)',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    left: 14,
    paddingHorizontal: 11,
    paddingVertical: 8,
    position: 'absolute',
  },
  sceneSignal: {
    backgroundColor: '#18B77B',
    borderRadius: 5,
    height: 9,
    shadowColor: '#18B77B',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 7,
    width: 9,
  },
  sceneEyebrow: { color: '#087C73', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  sceneMode: { color: G.text, fontSize: 11, fontWeight: '800', marginTop: 1 },
  camRail: { gap: 8, position: 'absolute', right: 14 },
  camBtn: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 12, borderWidth: 1,
    elevation: 2, flexDirection: 'row', gap: 6, height: 40, justifyContent: 'flex-start', paddingHorizontal: 10,
    shadowColor: '#173E4D', shadowOffset: { height: 2, width: 0 }, shadowOpacity: 0.1, shadowRadius: 5, width: 92,
  },
  camLabel: { fontSize: 10, fontWeight: '800' },
  carPicker: {
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderColor: G.hair,
    borderRadius: 14,
    borderWidth: 1,
    left: 14,
    padding: 8,
    position: 'absolute',
    right: 118,
  },
  eventMarker: {
    alignItems: 'center',
    backgroundColor: '#F59E0B',
    borderColor: 'rgba(255,255,255,0.88)',
    borderRadius: 999,
    borderWidth: 2,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  stopMarker: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#F59E0B',
    borderRadius: 999,
    borderWidth: 2,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  mapVehicle: {
    alignItems: 'center',
    height: 104,
    justifyContent: 'center',
    position: 'absolute',
    width: 104,
    zIndex: 30,
  },
  vehiclePulse: {
    backgroundColor: 'rgba(34,197,94,0.16)',
    borderRadius: 999,
    borderWidth: 2,
    height: 64,
    opacity: 0.72,
    position: 'absolute',
    width: 64,
  },
  resumeTracking: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#EAF1F8',
    borderRadius: 999,
    bottom: 220,
    elevation: 8,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
    zIndex: 40,
  },
  resumeTrackingText: { color: '#071018', fontSize: 12, fontWeight: '900' },

  deck: {
    backgroundColor: G.glassStrong, borderTopColor: G.hair, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, bottom: 0, elevation: 18, gap: 14, left: 0, paddingHorizontal: 18, paddingTop: 16,
    position: 'absolute', right: 0, shadowColor: '#173E4D', shadowOffset: { height: -8, width: 0 },
    shadowOpacity: 0.16, shadowRadius: 18,
  },
  statRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  speedBlock: { alignItems: 'flex-end', flexDirection: 'row', gap: 4 },
  speedValue: { color: '#087C73', fontSize: 40, fontVariant: ['tabular-nums'], fontWeight: '900', lineHeight: 42 },
  speedUnit: { color: G.sub, fontSize: 13, marginBottom: 6 },
  statPair: { flexDirection: 'row', gap: 18 },
  stat: { alignItems: 'flex-end' },
  statValue: { color: G.text, fontSize: 15, fontVariant: ['tabular-nums'], fontWeight: '800' },
  statLabel: { color: G.sub, fontSize: 11 },

  timelineWrap: { justifyContent: 'center' },
  track: { backgroundColor: G.track, borderRadius: 999, height: 6, justifyContent: 'center' },
  trackFill: { borderRadius: 999, height: 6 },
  tick: { borderRadius: 1, height: 12, marginLeft: -1, opacity: 0.7, position: 'absolute', top: -3, width: 2 },
  thumb: {
    backgroundColor: '#FFFFFF', borderRadius: 999, borderWidth: 3, height: 18, marginLeft: -9, position: 'absolute',
    top: -6, width: 18,
  },

  controls: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  ctrlSmall: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 999, borderWidth: 1,
    height: 46, justifyContent: 'center', width: 46,
  },
  playBtn: { alignItems: 'center', borderRadius: 999, height: 60, justifyContent: 'center', width: 60 },
  speeds: { flexDirection: 'row', gap: 4 },
  speedChip: { borderColor: G.hair, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 8 },
  speedChipText: { fontSize: 13, fontWeight: '800' },

  historyBackdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: 'rgba(18, 50, 71, 0.42)',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 26,
    zIndex: 1100,
  },
  historyCard: {
    backgroundColor: '#F7FAFC',
    borderColor: 'rgba(20,75,94,0.18)',
    borderRadius: 24,
    borderWidth: 1,
    elevation: 24,
    maxHeight: '94%',
    maxWidth: 520,
    overflow: 'hidden',
    shadowColor: '#102D3D',
    shadowOffset: { height: 14, width: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 26,
    width: '100%',
  },
  historyHeader: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomColor: G.hair,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 18,
  },
  historyHeaderCopy: { flex: 1 },
  historyEyebrow: { color: '#087C73', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  historyTitle: { color: G.text, fontSize: 22, fontWeight: '900', marginTop: 2 },
  historyRange: { color: G.sub, fontSize: 11, marginTop: 4 },
  historyClose: {
    alignItems: 'center',
    backgroundColor: '#EFF5F7',
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  historyContent: { gap: 12, padding: 14, paddingBottom: 26 },
  historySummaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  historyMetric: {
    backgroundColor: '#FFFFFF',
    borderColor: G.hair,
    borderRadius: 14,
    borderWidth: 1,
    minWidth: '30%',
    padding: 11,
    rowGap: 2,
    width: '31.5%',
  },
  historyMetricValue: { fontSize: 15, fontVariant: ['tabular-nums'], fontWeight: '900', marginTop: 3 },
  historyMetricLabel: { color: G.sub, fontSize: 10, fontWeight: '700' },
  historySection: {
    backgroundColor: '#FFFFFF',
    borderColor: G.hair,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  historySectionTitle: { color: G.text, fontSize: 14, fontWeight: '900', marginBottom: 12 },
  endpointRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  endpointDot: { borderRadius: 999, height: 11, marginTop: 4, width: 11 },
  endpointBody: { flex: 1 },
  endpointHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  endpointLabel: { color: G.text, fontSize: 12, fontWeight: '900' },
  endpointTime: { color: G.sub, fontSize: 10 },
  endpointAddress: { color: G.sub, fontSize: 11, lineHeight: 16, marginTop: 2 },
  endpointConnector: { backgroundColor: 'rgba(100,116,139,0.28)', height: 22, marginLeft: 5, width: 1 },
  timelineDetailRow: {
    borderBottomColor: 'rgba(20,75,94,0.09)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 10,
  },
  timelineDetailIcon: { alignItems: 'center', borderRadius: 12, height: 38, justifyContent: 'center', width: 38 },
  timelineDetailBody: { flex: 1, minWidth: 0 },
  timelineDetailHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  timelineDetailTitle: { fontSize: 12, fontWeight: '900' },
  timelineDetailDuration: { color: G.text, fontSize: 11, fontVariant: ['tabular-nums'], fontWeight: '800' },
  timelineDetailTime: { color: G.sub, fontSize: 10, marginTop: 2 },
  timelineDetailAddress: { color: G.text, fontSize: 11, lineHeight: 15, marginTop: 5 },
  timelineDetailMeta: { color: '#087C73', fontSize: 10, fontWeight: '700', marginTop: 5 },
  historyEmpty: { color: G.sub, fontSize: 12, paddingVertical: 8, textAlign: 'center' },
  stopDetailRow: { flexDirection: 'row', gap: 10, paddingVertical: 8 },
  stopNumber: {
    alignItems: 'center',
    backgroundColor: '#FFF7ED',
    borderColor: '#FDBA74',
    borderRadius: 999,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  stopNumberText: { color: '#C2410C', fontSize: 11, fontWeight: '900' },
  stopDetailBody: { flex: 1 },
  stopDetailTitle: { color: G.text, fontSize: 12, fontWeight: '800', lineHeight: 16 },
  stopDetailMeta: { color: G.sub, fontSize: 10, lineHeight: 14, marginTop: 2 },
  stopDetailDistance: { color: '#C2410C', fontSize: 10, fontWeight: '700', marginTop: 3 },
  qualityCard: {
    backgroundColor: '#EDF7F4',
    borderColor: 'rgba(8,124,115,0.2)',
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  qualityTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  qualityTitleCopy: { flex: 1 },
  qualityTitle: { color: G.text, fontSize: 12, fontWeight: '900' },
  qualitySubtitle: { color: G.sub, fontSize: 10, lineHeight: 14, marginTop: 2 },
  qualityReasonRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  qualityReason: { color: G.sub, fontSize: 10, textTransform: 'capitalize' },
  qualityCount: { color: '#D97706', fontSize: 10, fontWeight: '900' },

  // Date Range Filter & Modal Styles
  rangeFilterTrigger: {
    alignItems: 'center',
    backgroundColor: G.glass,
    borderColor: G.hair,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    height: 38,
    paddingHorizontal: 10,
  },
  rangeFilterTriggerText: {
    color: G.text,
    fontSize: 12,
    fontWeight: '800',
    maxWidth: 110,
  },
  filterModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: 'rgba(18, 50, 71, 0.38)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    zIndex: 1000,
  },
  filterModalCard: {
    backgroundColor: '#FFFFFF',
    borderColor: G.hair,
    borderRadius: 20,
    borderWidth: 1,
    elevation: 20,
    maxWidth: 380,
    padding: 18,
    shadowColor: '#173E4D',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.24,
    shadowRadius: 20,
    width: '100%',
  },
  filterHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  filterTitle: {
    color: G.text,
    fontSize: 17,
    fontWeight: '900',
  },
  rangeFieldRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  rangeField: {
    backgroundColor: '#F3F8FA',
    borderColor: G.hair,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    padding: 10,
  },
  rangeFieldActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    borderColor: '#22c55e',
  },
  rangeFieldLabel: {
    color: G.sub,
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  rangeFieldValue: {
    color: G.text,
    fontSize: 13,
    fontWeight: '800',
  },
  presetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 14,
  },
  presetChip: {
    backgroundColor: '#F3F8FA',
    borderColor: G.hair,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  presetChipText: {
    color: G.sub,
    fontSize: 11,
    fontWeight: '700',
  },
  calendarHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
  },
  calendarMonthText: {
    color: G.text,
    fontSize: 14,
    fontWeight: '800',
  },
  weekDaysRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  weekDayText: {
    color: G.sub,
    flex: 1,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 14,
  },
  dayCell: {
    alignItems: 'center',
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    marginVertical: 1,
    width: '14.28%',
  },
  dayCellSelected: {
    backgroundColor: '#22c55e',
  },
  dayCellInRange: {
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
  },
  dayCellText: {
    color: G.text,
    fontSize: 12,
    fontWeight: '700',
  },
  dayCellTextSelected: {
    color: '#071018',
    fontWeight: '900',
  },
  dayCellTextMuted: {
    color: '#B7C5CB',
  },
  validationErrorBox: {
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    padding: 10,
  },
  validationErrorText: {
    color: '#EF4444',
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
  },
  filterActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  filterResetBtn: {
    alignItems: 'center',
    backgroundColor: '#F3F8FA',
    borderColor: G.hair,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    height: 44,
    justifyContent: 'center',
  },
  filterResetText: {
    color: G.text,
    fontSize: 13,
    fontWeight: '800',
  },
  filterApplyBtn: {
    alignItems: 'center',
    backgroundColor: '#22c55e',
    borderRadius: 12,
    flex: 1.5,
    height: 44,
    justifyContent: 'center',
  },
  filterApplyBtnDisabled: {
    backgroundColor: 'rgba(34, 197, 94, 0.35)',
  },
  filterApplyText: {
    color: '#071018',
    fontSize: 13,
    fontWeight: '900',
  },
});
