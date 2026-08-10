import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Fleet3DOverlay,
  type Fleet3DOverlayMarker,
} from '@/src/components/Fleet3DOverlay';
import {
  FleetWebMap,
  type WebMapMarker,
  type WebMapProjection,
} from '@/src/components/FleetWebMap';
import MapView, { Marker } from '@/src/components/maps/NativeMap';
import {
  sanitizeRouteCoordinates,
  StableBaseRoute,
  StableRouteLine,
} from '@/src/components/StableRouteLayers';
import {
  getVehicleModel,
  Vehicle3DMarker,
  type CarVariant,
  modelForVehicle,
} from '@/src/components/Vehicle3DMarker';
import { VehicleModelPicker } from '@/src/components/VehicleModelPicker';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetDevicePlaybackQuery } from '@/src/services/devicesApi';
import { getMapStyleInfo } from '@/src/services/mapStyle';
import {
  buildPlaybackTrack,
  haversineKm,
  sampleAt,
  type PlaybackTrack,
} from '@/src/services/playbackEngine';
import { normalizeHeading } from '@/src/services/vehicleMarkerAssets';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { setVehicleModelPreference } from '@/src/store/vehiclePreferencesSlice';
import { useTheme } from '@/src/theme/ThemeProvider';
import type { PlaybackEventMarker, PlaybackStopMarker } from '@/src/types/api';

const SPEEDS = [0.5, 1, 2, 4, 8] as const;
type CameraMode = 'follow' | 'chase' | 'cinematic' | 'drone' | 'top' | 'overview';
const CAMERAS: { id: CameraMode; icon: string; label: string }[] = [
  { id: 'follow', icon: 'navigation-variant', label: 'Follow' },
  { id: 'chase', icon: 'car-sports', label: 'Chase' },
  { id: 'cinematic', icon: 'movie-open', label: 'Cinematic' },
  { id: 'drone', icon: 'orbit', label: 'Drone' },
  { id: 'top', icon: 'crosshairs-gps', label: 'Top' },
  { id: 'overview', icon: 'fit-to-page-outline', label: 'Overview' },
];

// Cinematic overlay palette (fixed night-scene glass, independent of app theme).
const G = {
  glass: 'rgba(10,14,22,0.66)',
  glassStrong: 'rgba(8,11,18,0.82)',
  hair: 'rgba(255,255,255,0.12)',
  text: '#EAF1F8',
  sub: '#9FB2C4',
  track: 'rgba(255,255,255,0.14)',
};

/** Returns today as a YYYY-MM-DD string in local time. */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Shift a YYYY-MM-DD string by `delta` days. */
function shiftDate(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

export default function TripPlaybackScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    deviceId?: string;
    name?: string;
    category?: string;
    make?: string;
    model?: string;
    speed?: string;
    heading?: string;
  }>();
  const deviceId = Number(params.deviceId);
  const devicePreferenceKey = String(deviceId);
  const dispatch = useAppDispatch();
  const preferredModel = useAppSelector(
    (state) => state.vehiclePreferences.modelByDevice[devicePreferenceKey]
  );

  const initialVariant = useMemo(() => {
    if (preferredModel) return preferredModel;
    return modelForVehicle(params.category, params.deviceId ?? '0');
  }, [preferredModel, params.category, params.deviceId]);

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

  const fromIso = useMemo(() => `${activeFromDate}T00:00:00.000Z`, [activeFromDate]);
  const toIso = useMemo(() => `${activeToDate}T23:59:59.999Z`, [activeToDate]);

  const isInvalidRange = draftFromDate > draftToDate;

  const { data, isFetching, isError, error, refetch } = useGetDevicePlaybackQuery(
    { deviceId, from: fromIso, to: toIso },
    { skip: !Number.isFinite(deviceId) }
  );

  const [playing, setPlaying] = useState(true);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [camera, setCamera] = useState<CameraMode>('cinematic');
  const [cameraCommandId, setCameraCommandId] = useState(0);
  const [carVariant, setCarVariant] = useState<CarVariant>(initialVariant);
  const [modelLoadState, setModelLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [ui, setUi] = useState(0); // throttled progress for UI (0..1)
  const [mapReady, setMapReady] = useState(false);

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

  useEffect(() => {
    setCarVariant(initialVariant);
    setModelLoadState('loading');
    setModelLoadError(null);
  }, [initialVariant]);

  const selectVehicleModel = useCallback(
    (variant: CarVariant) => {
      haptic();
      setCarVariant(variant);
      setModelLoadState('loading');
      setModelLoadError(null);
      dispatch(setVehicleModelPreference({ deviceKey: devicePreferenceKey, variant }));
      if (__DEV__) console.debug(`[VehicleModel] selected ${variant}`);
    },
    [devicePreferenceKey, dispatch, haptic]
  );

  const handleModelLoadState = useCallback(
    (state: 'loading' | 'ready' | 'error', message?: string) => {
      setModelLoadState(state);
      setModelLoadError(state === 'error' ? message ?? '3D model unavailable.' : null);
    },
    []
  );

  const track = useMemo(() => buildPlaybackTrack(data?.points ?? []), [data?.points]);
  const points = track.points;
  /** A day only has playable history when there are at least two real fixes. */
  const hasTrack = points.length >= 2;
  const showLoading = isFetching && !data;

  /**
   * Rewind whenever the loaded date range changes.
   */
  useEffect(() => {
    progressRef.current = 0;
    setUi(0);
    setPlaying(hasTrack);
  }, [data, hasTrack, activeFromDate, activeToDate]);

  // Real trip duration (for the clock readout) and event tick fractions.
  const timing = useMemo(() => {
    if (points.length < 2) return { start: 0, end: 1, durationMin: 0 };
    const start = new Date(points[0].t).getTime();
    const end = start + track.totalDurationMs;
    return { start, end, durationMin: Math.max(0, (end - start) / 60000) };
  }, [points, track.totalDurationMs]);

  const eventTicks = useMemo(() => {
    if (!data || timing.end <= timing.start) return [];
    return data.events.map((e) => ({
      frac: Math.max(0, Math.min(1, (new Date(e.t).getTime() - timing.start) / (timing.end - timing.start))),
      type: e.eventType,
    }));
  }, [data, timing]);

  // 60fps clock — advances the ref (drives 3D) and throttles UI state at ~12fps.
  useEffect(() => {
    let raf: number;
    let lastUi = 0;
    let last = Date.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (appActive && playingRef.current && points.length >= 2 && mapReady) {
        progressRef.current +=
          ((dt * 1000) / Math.max(1, track.totalDurationMs)) * speedRef.current;
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
    return () => cancelAnimationFrame(raf);
  }, [appActive, mapReady, points.length, track.totalDurationMs]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
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
      }),
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
  const handleMapReady = useCallback(() => setMapReady(true), []);

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

  if (!Number.isFinite(deviceId)) {
    return <Center text="No vehicle selected." />;
  }

  const currentSample = hasTrack ? sampleAt(track, ui * track.totalDurationMs) : null;
  const curSpeed = Math.round(currentSample?.speed ?? 0);
  const elapsedMin = hasTrack ? timing.durationMin * ui : 0;
  const coveredDistanceKm = currentSample?.distanceKm ?? 0;

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
          cameraCommandId={cameraCommandId}
          cameraMode={camera}
          carVariant={carVariant}
          events={data.events}
          onReady={handleMapReady}
          onModelLoadState={handleModelLoadState}
          playing={appActive && playing}
          speed={speed}
          stops={data.stops}
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
              <Text style={styles.placeholderTitle}>No history available</Text>
              <Text style={styles.placeholderText}>
                {activeFromDate === activeToDate
                  ? `${labelDate(activeFromDate)} has no recorded trip for this vehicle.`
                  : `No recorded trips between ${labelDate(activeFromDate)} and ${labelDate(activeToDate)}.`}
                {' Use the filter above to select another date range.'}
              </Text>
            </>
          )}
        </View>
      )}


      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityLabel="Back" hitSlop={12} onPress={() => router.back()} style={styles.iconBtn}>
          <MaterialCommunityIcons color={G.text} name="arrow-left" size={22} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text numberOfLines={1} style={styles.title}>{params.name ?? `Vehicle #${deviceId}`}</Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {hasTrack && data
              ? `${data.distanceKm.toFixed(1)} km · ${Math.round(timing.durationMin)} min · ${data.returnedPoints} pts`
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
              {ui >= 1 ? 'ROUTE COMPLETE' : 'NATIVE 3D MAP'}
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

      {hasTrack ? (
        <View style={[styles.carPicker, { top: insets.top + 116 }]}>
          <VehicleModelPicker
            compact
            errorMessage={modelLoadError}
            loading={modelLoadState === 'loading'}
            value={carVariant}
            onChange={selectVehicleModel}
            category={params.category}
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

      {/* Bottom control deck */}
      <View style={[styles.deck, { paddingBottom: 14 }]}>
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
            {...(hasTrack ? pan.panHandlers : {})}>
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
                const isSelected = cell.dateStr === (pickerTarget === 'from' ? draftFromDate : draftToDate);
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

function Center({ text, spinner, onRetry }: { text: string; spinner?: boolean; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
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
  );
}

function lerpAngle(start: number, end: number, t: number): number {
  const da = (((end - start) % 360) + 540) % 360 - 180;
  return normalizeHeading(start + da * t);
}

type CinematicTripMapProps = {
  accent: string;
  cameraCommandId: number;
  cameraMode: CameraMode;
  carVariant: CarVariant;
  events: PlaybackEventMarker[];
  onModelLoadState: (state: 'loading' | 'ready' | 'error', message?: string) => void;
  onReady: () => void;
  playing: boolean;
  speed: number;
  stops: PlaybackStopMarker[];
  track: PlaybackTrack;
  ui: number;
};

type ScreenPoint = { x: number; y: number };

function coordinateAhead(
  latitude: number,
  longitude: number,
  heading: number,
  meters: number
) {
  if (meters <= 0) return { latitude, longitude };
  const distance = meters / 6_371_000;
  const bearing = (normalizeHeading(heading) * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lng1 = (longitude * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance) +
    Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1),
      Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2)
    );
  return {
    latitude: (lat2 * 180) / Math.PI,
    longitude: (lng2 * 180) / Math.PI,
  };
}

function isDisplayCoordinate(latitude: number, longitude: number) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/**
 * Cinematic playback keeps the configured native map permanently mounted.
 * Route/event layers are rendered by the map SDK and the transparent 3D vehicle
 * is projected over its real coordinate, so the GL surface can never obscure
 * tiles, roads, labels or buildings.
 */
function CinematicTripMap({
  accent,
  cameraCommandId,
  cameraMode,
  carVariant,
  events,
  onModelLoadState,
  onReady,
  playing,
  speed,
  stops,
  track,
  ui,
}: CinematicTripMapProps) {
  const mapRef = useRef<MapView>(null);
  const mountedRef = useRef(true);
  const projectionRequestRef = useRef(0);
  const lastCameraAtRef = useRef(0);
  const lastCameraCoordinateRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const lastCameraModeRef = useRef<CameraMode | null>(null);
  const stableHeadingRef = useRef<number | null>(null);
  const lastProjectionAtRef = useRef(0);
  const readyReportedRef = useRef(false);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [mapLoaded, setMapLoaded] = useState(Platform.OS === 'web');
  const [autoFollow, setAutoFollow] = useState(true);
  const [resumeRequest, setResumeRequest] = useState(0);
  const [mapCameraHeading, setMapCameraHeading] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [modelFailed, setModelFailed] = useState(false);
  const [overlayPoint, setOverlayPoint] = useState<ScreenPoint | null>(null);
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

  const cur = useMemo(() => {
    const sample = sampleAt(track, ui * track.totalDurationMs);
    return {
      lat: sample?.latitude ?? points[0]?.lat ?? 0,
      lng: sample?.longitude ?? points[0]?.lng ?? 0,
      heading: sample?.heading ?? 0,
      speed: sample?.speed ?? 0,
      atEnd: sample?.atEnd ?? false,
      completedPointCount: sample?.completedPointCount ?? 0,
      segmentIndex: sample?.segmentIndex ?? 0,
    };
  }, [points, track, ui]);
  const completedRouteCoords = useMemo(
    () =>
      sanitizeRouteCoordinates(
        points
          .slice(0, cur.completedPointCount)
          .map((point) => ({ latitude: point.lat, longitude: point.lng }))
      ),
    [cur.completedPointCount, points]
  );
  const progressTail = useMemo(() => {
    if (cur.atEnd) return [];
    const start = completedRouteCoords[completedRouteCoords.length - 1];
    if (
      !start ||
      haversineKm(start.latitude, start.longitude, cur.lat, cur.lng) < 0.0005
    ) {
      return [];
    }
    return [start, { latitude: cur.lat, longitude: cur.lng }];
  }, [completedRouteCoords, cur]);

  const styleInfo = getMapStyleInfo('dark');
  const webMarkers = useMemo<WebMapMarker[]>(
    () => [
      {
        category: getVehicleModel(carVariant).category.toUpperCase(),
        color: getVehicleModel(carVariant).paintColor || accent,
        heading: cur.heading,
        hidden: modelReady && overlayPoint != null,
        id: 'vehicle',
        lat: cur.lat,
        lng: cur.lng,
      },
    ],
    [accent, carVariant, cur, modelReady, overlayPoint]
  );
  const webPolyline = useMemo<[number, number][]>(
    () => points.map((p) => [p.lng, p.lat] as [number, number]),
    [points]
  );

  const validEvents = useMemo(
    () => events.filter((event) => isDisplayCoordinate(event.lat, event.lng)),
    [events]
  );
  const validStops = useMemo(
    () => stops.filter((stop) => isDisplayCoordinate(stop.lat, stop.lng)),
    [stops]
  );

  const reportReady = useCallback(() => {
    if (readyReportedRef.current) return;
    readyReportedRef.current = true;
    onReady();
  }, [onReady]);

  useEffect(() => {
    mountedRef.current = true;
    if (Platform.OS === 'web') reportReady();
    return () => {
      mountedRef.current = false;
      projectionRequestRef.current += 1;
    };
  }, [reportReady]);

  useEffect(() => {
    setModelReady(false);
    setModelFailed(false);
    onModelLoadState('loading');
  }, [carVariant, onModelLoadState]);

  useEffect(() => {
    setAutoFollow(true);
    lastCameraAtRef.current = 0;
  }, [cameraCommandId]);

  const projectVehicle = useCallback(async (force = false) => {
    const instance = mapRef.current;
    if (!instance || !mapLoaded || !isDisplayCoordinate(cur.lat, cur.lng)) return;
    const now = Date.now();
    if (!force && now - lastProjectionAtRef.current < 40) return;
    lastProjectionAtRef.current = now;
    const request = ++projectionRequestRef.current;
    try {
      const [projected, camera] = await Promise.all([
        instance.pointForCoordinate({
          latitude: cur.lat,
          longitude: cur.lng,
        }),
        instance.getCamera(),
      ]);
      if (
        !mountedRef.current ||
        request !== projectionRequestRef.current ||
        !Number.isFinite(projected.x) ||
        !Number.isFinite(projected.y)
      ) {
        return;
      }
      // A stale SDK projection can briefly return a point far outside the map
      // during a camera transition. Keep the last valid screen position instead.
      if (
        projected.x >= -120 &&
        projected.x <= width + 120 &&
        projected.y >= -120 &&
        projected.y <= height + 120
      ) {
        const heading = Number.isFinite(camera.heading) ? normalizeHeading(camera.heading) : 0;
        setMapCameraHeading(heading);
        setOverlayPoint(projected);
      }
    } catch {
      // Projection can reject while the native map is changing regions.
    }
  }, [cur.lat, cur.lng, height, mapLoaded, width]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    void projectVehicle(false);
  }, [projectVehicle]);

  useEffect(() => {
    if (Platform.OS === 'web' || !mapLoaded || !autoFollow || !mapRef.current) return;

    const now = Date.now();
    const modeChanged = lastCameraModeRef.current !== cameraMode;
    if (cameraMode === 'overview') {
      if (modeChanged) {
        mapRef.current.setCamera({ heading: 0, pitch: 0 });
        setMapCameraHeading(0);
        if (routeCoords.length === 1) {
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
    const duration = modeChanged ? 550 : Math.min(360, Math.max(180, Math.round(baseInterval * 1.1)));

    mapRef.current.animateCamera(
      { center, heading, pitch, zoom },
      { duration }
    );
    setMapCameraHeading(heading);
    lastCameraAtRef.current = now;
    lastCameraCoordinateRef.current = { latitude: cur.lat, longitude: cur.lng };
    lastCameraModeRef.current = cameraMode;
  }, [
    autoFollow,
    cameraMode,
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
  ]);

  const handleNativeMapReady = useCallback(() => {
    setMapLoaded(true);
    reportReady();
  }, [reportReady]);

  const syncProjectionDuringCamera = useCallback(() => {
    void projectVehicle(false);
  }, [projectVehicle]);

  const syncProjectionAfterCamera = useCallback(() => {
    void projectVehicle(true);
  }, [projectVehicle]);

  const handleWebProjection = useCallback((projection: WebMapProjection) => {
    const heading = normalizeHeading(projection.heading);
    setMapCameraHeading(heading);
    const point = projection.points.vehicle;
    if (point) setOverlayPoint(point);
  }, []);
  const projectedVehicleMarkers = useMemo<Fleet3DOverlayMarker[]>(
    () =>
      overlayPoint
        ? [
          {
            heading: normalizeHeading(cur.heading - mapCameraHeading),
            id: 'vehicle',
            isActive: playing,
            selected: true,
            speed: cur.speed,
            variant: carVariant,
            x: overlayPoint.x,
            y: overlayPoint.y,
          },
        ]
        : [],
    [carVariant, cur.heading, cur.speed, mapCameraHeading, overlayPoint, playing]
  );

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
      {Platform.OS === 'web' ? (
        <FleetWebMap
          cameraMode={cameraMode}
          followSelected={autoFollow}
          mapStyle={styleInfo.webStyle}
          markers={webMarkers}
          onInteraction={pauseFollowing}
          onProjectionChange={handleWebProjection}
          polyline={webPolyline}
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
          <StableBaseRoute
            auraColor="rgba(43,230,255,0.22)"
            coordinates={routeCoords}
            lineColor="rgba(151,171,190,0.72)"
            lineWidth={6}
          />
          <StableRouteLine color={accent} coordinates={completedRouteCoords} />
          <StableRouteLine color={accent} coordinates={progressTail} width={6} zIndex={13} />
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
        </MapView>
      )}

      {overlayPoint && mapLoaded ? (
        <>
          <Fleet3DOverlay
            height={height}
            markers={projectedVehicleMarkers}
            onModelError={(id, variant, message) => {
              if (id !== 'vehicle' || variant !== carVariant) return;
              setModelReady(false);
              setModelFailed(true);
              onModelLoadState('error', message);
            }}
            onModelLoaded={(id, variant) => {
              if (id !== 'vehicle' || variant !== carVariant) return;
              setModelReady(true);
              onModelLoadState('ready');
            }}
            onModelLoadStart={(id, variant) => {
              if (id !== 'vehicle' || variant !== carVariant) return;
              setModelReady(false);
              setModelFailed(false);
              onModelLoadState('loading');
            }}
            onUnavailable={(message) => {
              setModelReady(false);
              setModelFailed(true);
              onModelLoadState('error', message);
            }}
            width={width}
          />
          {modelFailed ? (
            <View
              pointerEvents="none"
              style={[
                styles.mapVehicle,
                {
                  left: overlayPoint.x - 52,
                  top: overlayPoint.y - 52,
                },
              ]}>
              <View style={[styles.vehiclePulse, { borderColor: accent }]} />
              <Vehicle3DMarker
                heading={normalizeHeading(cur.heading - mapCameraHeading)}
                isActive={playing}
                renderMode="image"
                showImageFallback
                size={104}
                speed={cur.speed}
                variant={carVariant}
              />
            </View>
          ) : null}
        </>
      ) : null}

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
  root: { backgroundColor: '#05070c', flex: 1 },
  center: { alignItems: 'center', backgroundColor: '#05070c', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  centerText: { color: G.sub, fontSize: 15, textAlign: 'center' },
  retry: { borderColor: '#22c55e', borderRadius: 10, borderWidth: 1, marginTop: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: '#22c55e', fontWeight: '800' },

  topBar: { alignItems: 'center', flexDirection: 'row', gap: 8, left: 0, paddingHorizontal: 14, position: 'absolute', right: 0, top: 0 },
  iconBtn: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 12, borderWidth: 1,
    height: 40, justifyContent: 'center', width: 40,
  },
  titleWrap: { flex: 1, minWidth: 0 },
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
    backgroundColor: '#05070c',
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
    backgroundColor: 'rgba(7, 14, 24, 0.8)',
    borderColor: 'rgba(83, 216, 255, 0.2)',
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
    backgroundColor: '#2BE6FF',
    borderRadius: 5,
    height: 9,
    shadowColor: '#2BE6FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 7,
    width: 9,
  },
  sceneEyebrow: { color: '#53D8FF', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  sceneMode: { color: G.text, fontSize: 11, fontWeight: '800', marginTop: 1 },
  camRail: { gap: 8, position: 'absolute', right: 14 },
  camBtn: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 12, borderWidth: 1,
    flexDirection: 'row', gap: 6, height: 40, justifyContent: 'flex-start', paddingHorizontal: 10, width: 92,
  },
  camLabel: { fontSize: 10, fontWeight: '800' },
  carPicker: {
    backgroundColor: 'rgba(7, 14, 24, 0.82)',
    borderColor: 'rgba(83, 216, 255, 0.18)',
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
    backgroundColor: '#EAF1F8',
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
    borderTopWidth: 1, bottom: 0, gap: 14, left: 0, paddingHorizontal: 18, paddingTop: 16, position: 'absolute', right: 0,
  },
  statRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  speedBlock: { alignItems: 'flex-end', flexDirection: 'row', gap: 4 },
  speedValue: { color: G.text, fontSize: 40, fontVariant: ['tabular-nums'], fontWeight: '900', lineHeight: 42 },
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
    backgroundColor: '#0b0f16', borderRadius: 999, borderWidth: 3, height: 18, marginLeft: -9, position: 'absolute',
    top: -6, width: 18,
  },

  controls: { alignItems: 'center', flexDirection: 'row', gap: 16, justifyContent: 'space-between' },
  ctrlSmall: {
    alignItems: 'center', backgroundColor: G.glass, borderColor: G.hair, borderRadius: 999, borderWidth: 1,
    height: 46, justifyContent: 'center', width: 46,
  },
  playBtn: { alignItems: 'center', borderRadius: 999, height: 60, justifyContent: 'center', width: 60 },
  speeds: { flexDirection: 'row', gap: 6 },
  speedChip: { borderColor: G.hair, borderRadius: 999, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  speedChipText: { fontSize: 13, fontWeight: '800' },

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
    backgroundColor: 'rgba(3, 8, 16, 0.78)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    zIndex: 1000,
  },
  filterModalCard: {
    backgroundColor: '#0B131E',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 20,
    borderWidth: 1,
    elevation: 20,
    maxWidth: 380,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
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
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
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
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
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
    color: 'rgba(255, 255, 255, 0.25)',
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
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
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
