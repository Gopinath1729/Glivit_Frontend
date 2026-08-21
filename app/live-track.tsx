import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  type LayoutChangeEvent,
  Linking,
  Modal,
  PanResponder,
  type PanResponderInstance,
  PermissionsAndroid,
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
  loadMapPreferences,
  saveMapPreferences,
  type MapPreferences,
  type MapTypeOption,
  DEFAULT_MAP_PREFERENCES,
} from '@/src/services/mapPreferencesStorage';

import { StatusPill } from '@/src/components/ui/StatusPill';
import {
  Fleet3DOverlay,
  type Fleet3DOverlayMarker,
} from '@/src/components/Fleet3DOverlay';
import {
  FleetWebMap,
  type FleetWebMapHandle,
  type WebMapMarker,
  type WebMapProjection,
} from '@/src/components/FleetWebMap';
import MapView, { Marker } from '@/src/components/maps/NativeMap';
import {
  sanitizeRouteCoordinates,
  StableRouteLine,
  StableBaseRoute,
} from '@/src/components/StableRouteLayers';
import {
  getVehicleModel,
  modelForVehicle,
  type CarVariant,
} from '@/src/components/Vehicle3DMarker';
import { VehicleModelPicker } from '@/src/components/VehicleModelPicker';
import { env } from '@/src/config/env';
import { useGetAllDevicesQuery, useGetDeviceQuery, useGetDevicePlaybackQuery } from '@/src/services/devicesApi';
import { getMapStyleInfo, getNativeMapProviderLabel } from '@/src/services/mapStyle';
import {
  buildPlaybackTrack,
  haversineKm,
  lerpAngle,
  normalizeHeading,
  sampleAt,
  type PlaybackTrack,
} from '@/src/services/playbackEngine';
import { useLivePositions } from '@/src/services/livePositions';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { setVehicleModelPreference } from '@/src/store/vehiclePreferencesSlice';
import {
  vehicleMarkerKey,
  vehicleMarkerRotation,
  vehicleMarkerSource,
} from '@/src/services/vehicleMarkerAssets';
import type { DeviceSummary, PlaybackTrackPoint, PlaybackResponse, PlaybackStopMarker, PlaybackEventMarker } from '@/src/types/api';

const LIVE_MARKER_SIZE = 64;
/** Single spacing unit for every floating map layer (header, rails, pills). */
const OVERLAY_GAP = 10;
/** Height assumed for the collapsed sheet before it has been measured. */
const COLLAPSED_SHEET_FALLBACK = 118;
/** Size of every floating action button, so the rails line up pixel-for-pixel. */
const CONTROL_BUTTON_SIZE = 44;
const CAMERA_MIN_GAP_MS = 560;
const LIVE_STALE_AFTER_SEC = 15;
// Bounds for the smooth live catch-up between the previous displayed position and
// the newest streamed fix.
const LIVE_TRANSITION_MIN_MS = 420;
const LIVE_TRANSITION_MAX_MS = 3600;
/** How often the live catch-up pushes a new position into React state (~30fps). */
const LIVE_PUBLISH_INTERVAL_MS = 33;

type CameraMode = 'follow' | 'chase' | 'cinematic' | 'top' | 'drone' | 'overview';
const CAMERA_MODES: Record<
  CameraMode,
  {
    label: string;
    icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    pitch: number;
    zoom: number;
    forwardMeters: number;
    bearingFollowsHeading: boolean;
  }
> = {
  follow: { label: 'Follow', icon: 'navigation-variant', pitch: 28, zoom: 15.2, forwardMeters: 0, bearingFollowsHeading: false },
  chase: { label: 'Chase', icon: 'car-sports', pitch: 52, zoom: 15.8, forwardMeters: 28, bearingFollowsHeading: true },
  cinematic: { label: 'Cinema', icon: 'movie-open', pitch: 62, zoom: 15.5, forwardMeters: 44, bearingFollowsHeading: true },
  top: { label: 'Top', icon: 'crosshairs-gps', pitch: 0, zoom: 16, forwardMeters: 0, bearingFollowsHeading: false },
  drone: { label: 'Drone', icon: 'orbit', pitch: 42, zoom: 14.2, forwardMeters: 34, bearingFollowsHeading: true },
  overview: { label: 'Overview', icon: 'fit-to-page-outline', pitch: 0, zoom: 12, forwardMeters: 0, bearingFollowsHeading: false },
};
const CAMERA_MODE_ORDER: CameraMode[] = ['follow', 'chase', 'cinematic', 'top', 'drone', 'overview'];
const CINEMATIC_CAMERAS: {
  id: CameraMode;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
}[] = [
    { id: 'cinematic', icon: 'movie-open', label: 'Cinematic' },
    { id: 'follow', icon: 'navigation-variant', label: 'Follow' },
    { id: 'chase', icon: 'car-sports', label: 'Chase' },
    { id: 'drone', icon: 'orbit', label: 'Drone' },
    { id: 'top', icon: 'crosshairs-gps', label: 'Top' },
    { id: 'overview', icon: 'fit-to-page-outline', label: 'Overview' },
  ];

const CONTACT_PHONE = '+919876543210';

type MapLoadState = 'loading' | 'ready' | 'error';
/** react-native-maps base layers, cycled by the map-type control. */
type NativeMapType = 'standard' | 'satellite' | 'hybrid';
const MAP_TYPE_ORDER: NativeMapType[] = ['standard', 'satellite', 'hybrid'];
const MAP_TYPE_LABEL: Record<NativeMapType, string> = {
  standard: 'Normal map',
  satellite: 'Satellite map',
  hybrid: 'Hybrid map',
};
const MAP_ZOOM_MIN = 3;
const MAP_ZOOM_MAX = 20;
type RouteMapOptionId =
  | 'parking'
  | 'refresh'
  | 'follow'
  | 'alert'
  | 'call'
  | 'location'
  | 'traffic'
  | 'mapType'
  | 'direction'
  | 'night'
  | 'history';

type RouteOptionData = {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
  summary: string;
  tone: 'green' | 'orange' | 'red';
  metrics: { label: string; value: string }[];
};



type Coordinate = {
  latitude: number;
  longitude: number;
};

const ROUTE_TOOLS: {
  id: RouteMapOptionId;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
}[] = [
    { id: 'follow', icon: 'navigation-variant', label: 'Follow' },
    { id: 'location', icon: 'crosshairs-gps', label: 'Center' },
    { id: 'refresh', icon: 'refresh', label: 'Restart' },
    { id: 'parking', icon: 'parking', label: 'Park' },
    { id: 'traffic', icon: 'road-variant', label: 'Route' },
    { id: 'mapType', icon: 'layers-outline', label: 'Map style' },
    { id: 'night', icon: 'weather-night', label: 'Night' },
    { id: 'direction', icon: 'map-marker-path', label: 'Next' },
    { id: 'history', icon: 'history', label: 'History' },
    { id: 'alert', icon: 'alert-outline', label: 'Alert' },
    { id: 'call', icon: 'phone-outline', label: 'Support' },
  ];

// The one and only tracking-route colour. Kept as a single constant so the live
// route can never drift into gradients, traffic/speed tints, or a second hue.
const ROUTE_GREEN = '#16A34A';

const BRAND = {
  green: '#118a36',
  greenDark: '#05652a',
  greenGlow: '#2be69e',
  orange: '#ff7900',
  red: '#fb2f32',
  ink: '#16202c',
  muted: '#667385',
  mapMint: '#e8eef2',
  road: '#fdfcf7',
};

function offsetCoordinate(
  latitude: number,
  longitude: number,
  bearing: number,
  distanceMeters: number
): Coordinate {
  if (distanceMeters <= 0) return { latitude, longitude };
  const radians = (bearing * Math.PI) / 180;
  const latitudeDelta = (distanceMeters * Math.cos(radians)) / 111_320;
  const longitudeScale = Math.max(0.15, Math.cos((latitude * Math.PI) / 180));
  const longitudeDelta = (distanceMeters * Math.sin(radians)) / (111_320 * longitudeScale);
  return {
    latitude: latitude + latitudeDelta,
    longitude: longitude + longitudeDelta,
  };
}

function simplifyRouteForRender(coordinates: Coordinate[], maxPoints = 2_000): Coordinate[] {
  const validCoordinates = sanitizeRouteCoordinates(coordinates);
  if (validCoordinates.length <= 2) return validCoordinates;
  const meaningful = [validCoordinates[0]];
  for (let index = 1; index < validCoordinates.length; index += 1) {
    const point = validCoordinates[index];
    const previous = meaningful[meaningful.length - 1];
    const isLast = index === validCoordinates.length - 1;
    if (
      isLast ||
      haversineKm(previous.latitude, previous.longitude, point.latitude, point.longitude) >= 0.002
    ) {
      meaningful.push(point);
    }
  }
  if (meaningful.length <= maxPoints) return meaningful;
  const stride = Math.ceil(meaningful.length / maxPoints);
  const reduced = meaningful.filter((_, index) => index % stride === 0);
  const last = meaningful[meaningful.length - 1];
  if (reduced[reduced.length - 1] !== last) reduced.push(last);
  return reduced;
}

type LiveVehicleMapMarkerProps = {
  cameraHeading: number;
  category: string;
  coordinate: Coordinate;
  heading: number;
  showStatusCircle: boolean;
  state: string;
  statusColor: string;
};

/**
 * A real geographic map marker. The frame is centered on the GPS coordinate, so
 * it cannot drift when the map pans, pitches, rotates, or zooms.
 */
const LiveVehicleMapMarker = memo(function LiveVehicleMapMarker({
  cameraHeading,
  category,
  coordinate,
  heading,
  showStatusCircle,
  state,
  statusColor,
}: LiveVehicleMapMarkerProps) {
  const source = useMemo(() => vehicleMarkerSource(category, state), [category, state]);
  const sourceKey = useMemo(() => vehicleMarkerKey(category, state), [category, state]);
  const assetRotation = vehicleMarkerRotation(heading, category, state);
  const [tracksViewChanges, setTracksViewChanges] = useState(true);

  useEffect(() => {
    setTracksViewChanges(true);
    const timer = setTimeout(() => setTracksViewChanges(false), 240);
    return () => clearTimeout(timer);
  }, [showStatusCircle, sourceKey, statusColor]);

  // Android/Google Maps supports native flat-marker rotation. Apple MapKit does
  // not, so its billboard image is rotated relative to the current map heading.
  const imageRotation =
    Platform.OS === 'ios'
      ? ((assetRotation - cameraHeading) % 360 + 360) % 360
      : 0;

  return (
    <Marker
      anchor={{ x: 0.5, y: 0.5 }}
      centerOffset={{ x: 0, y: 0 }}
      coordinate={coordinate}
      flat={Platform.OS === 'android'}
      identifier="live-vehicle"
      rotation={Platform.OS === 'android' ? assetRotation : 0}
      tappable={false}
      tracksViewChanges={tracksViewChanges}
      zIndex={40}>
      <View collapsable={false} style={styles.liveVehicleMarker}>
        {showStatusCircle ? (
          <View style={[styles.markerStatusCircle, { borderColor: statusColor }]} />
        ) : null}
        <View style={styles.markerShadow} />
        <Image
          fadeDuration={0}
          resizeMode="contain"
          source={source}
          style={[
            styles.markerVehicleImage,
            Platform.OS === 'ios' && { transform: [{ rotate: `${imageRotation}deg` }] },
          ]}
        />
      </View>
    </Marker>
  );
});

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDate(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function labelDate(dateStr: string): string {
  const today = todayStr();
  if (dateStr === today) return 'Today';
  if (dateStr === shiftDate(today, -1)) return 'Yesterday';
  const parts = dateStr.split('-');
  const monthIdx = parseInt(parts[1] ?? '1', 10) - 1;
  const day = parts[2] ? parseInt(parts[2], 10) : '';
  return `${day} ${MONTH_NAMES[monthIdx] || ''}`;
}

export default function VehicleTrackerScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    category?: string;
    deviceId?: string;
    name?: string;
    subtitle?: string;
  }>();
  // Real route playback for the selected device. Falls back to the demo route
  // only when no device is passed or the app is in offline demo mode.
  const deviceId = params.deviceId ? Number(params.deviceId) : undefined;
  const devicePreferenceKey = String(deviceId ?? 'demo');
  const dispatch = useAppDispatch();
  const preferredModel = useAppSelector(
    (state) => state.vehiclePreferences.modelByDevice[devicePreferenceKey]
  );
  // A real, tenant-scoped device is selected (not the offline/demo screen).
  const hasRealDevice = deviceId != null && !Number.isNaN(deviceId) && !env.demoMode;
  const validDeviceId = deviceId != null && !Number.isNaN(deviceId);
  const { data: deviceDetail, refetch: refetchDevice } = useGetDeviceQuery(deviceId as number, {
    skip: !validDeviceId,
  });
  const vehicleName =
    params.name ?? deviceDetail?.name ?? 'TN20CM7677 (VinothKumar Srinivas)';
  const vehicleSubtitle =
    params.subtitle ??
    deviceDetail?.address ??
    'Kuppalamadugu, Uthukkottai, Thiruvallur, Tamil Nadu';
  const vehicleCategory = params.category ?? deviceDetail?.category ?? 'CAR';
  // Live position stream (SSE for real devices; a one-fix-at-a-time simulator in
  // demo mode). This is the ONLY source of movement on this LIVE screen — no
  // recorded history is fetched or merged and no demo route is pre-loaded, so
  // nothing is ever drawn ahead of the vehicle. Recorded playback lives entirely
  // on the separate Route Playback / History screen.
  const liveEnabled = validDeviceId;
  const live = useLivePositions(liveEnabled ? deviceId : undefined, deviceDetail?.state);
  // Fleet roster for the in-screen vehicle switcher. Selecting a different
  // vehicle re-points every data source on this screen (device detail, live SSE
  // stream, route buffer, camera) rather than only swapping the 3D model.
  const { data: fleetDevices } = useGetAllDevicesQuery();
  const fleet = useMemo(() => fleetDevices ?? [], [fleetDevices]);
  const [vehiclePickerOpen, setVehiclePickerOpen] = useState(false);
  // The device summary carries the latest known position. Use it to seed the
  // vehicle at its current location immediately (before the first streamed fix)
  // and to start the route from that single trip-start coordinate.
  const seedPoint = useMemo<PlaybackTrackPoint | null>(() => {
    const lat = deviceDetail?.latitude;
    const lng = deviceDetail?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      t: deviceDetail?.lastUpdate ?? new Date().toISOString(),
      lat: lat as number,
      lng: lng as number,
      speed: Number.isFinite(deviceDetail?.speed) ? Math.max(0, deviceDetail!.speed) : 0,
      course: Number.isFinite(deviceDetail?.course) ? (deviceDetail!.course as number) : 0,
      gpsValid: deviceDetail?.gpsValid ?? true,
      ignition: deviceDetail?.ignition ?? null,
    };
  }, [deviceDetail]);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [activeTab, setActiveTab] = useState<'live' | 'history' | 'cinematic'>('live');
  const today = todayStr();
  const [activeFromDate, setActiveFromDate] = useState(today);
  const [activeToDate, setActiveToDate] = useState(today);
  const [historyPlaying, setHistoryPlaying] = useState(false);
  const [historySpeed, setHistorySpeed] = useState<0.5 | 1 | 2 | 4 | 8>(1);

  const fromIso = useMemo(() => `${activeFromDate}T00:00:00.000Z`, [activeFromDate]);
  const toIso = useMemo(() => `${activeToDate}T23:59:59.999Z`, [activeToDate]);

  const { data: playbackData, isFetching: isPlaybackFetching } = useGetDevicePlaybackQuery(
    { deviceId: deviceId ?? 0, from: fromIso, to: toIso },
    { skip: !deviceId || activeTab !== 'history' }
  );

  // The travelled route is EXACTLY the accepted live fixes of the current trip
  // (livePositions resets this buffer when a new trip starts). Before the first
  // fix we show only the seed position, so the green line always begins where the
  // live trip began and grows behind the vehicle as new coordinates arrive.
  const track = useMemo<PlaybackTrack>(() => {
    if (activeTab === 'history' && playbackData?.points) {
      return buildPlaybackTrack(playbackData.points);
    }
    if (live.points.length > 0) return buildPlaybackTrack(live.points);
    return buildPlaybackTrack(seedPoint ? [seedPoint] : []);
  }, [activeTab, playbackData, live.points, seedPoint]);

  useEffect(() => {
    elapsedMsRef.current = 0;
    setElapsedMs(0);
    setHistoryPlaying(false);
  }, [playbackData]);

  // 60fps clock for History playback
  useEffect(() => {
    if (activeTab !== 'history' || !historyPlaying || track.points.length < 2) return;
    let raf: number;
    let lastUi = 0;
    let last = Date.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (appActive) {
        let nextElapsed = elapsedMsRef.current + (dt * 1000) * historySpeed;
        if (nextElapsed >= track.totalDurationMs) {
          nextElapsed = track.totalDurationMs;
          setHistoryPlaying(false);
        }
        elapsedMsRef.current = nextElapsed;
        if (now - lastUi > 40) {
          lastUi = now;
          setElapsedMs(nextElapsed);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activeTab, historyPlaying, historySpeed, appActive, track.points.length, track.totalDurationMs]);
  const seekHistory = useCallback((frac: number) => {
    const clamped = Math.max(0, Math.min(1, frac));
    const nextElapsed = clamped * track.totalDurationMs;
    elapsedMsRef.current = nextElapsed;
    setElapsedMs(nextElapsed);
  }, [track.totalDurationMs]);

  const route = useMemo<Coordinate[]>(
    () => track.points.map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [track]
  );
  // Distance travelled so far on the current live trip (grows with the route).
  const totalDistanceKm = track.totalDistanceKm;
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const mapRef = useRef<MapView>(null);
  const webMapRef = useRef<FleetWebMapHandle>(null);
  const fitWholeRouteRef = useRef<() => boolean>(() => false);
  const mapReadyRef = useRef(false);
  const mapLayoutReadyRef = useRef(false);
  const cameraReadRequestRef = useRef(0);
  const cameraFrameRef = useRef<number | null>(null);
  const lastCameraAtRef = useRef(0);
  const lastCameraHeadingRef = useRef(0);
  const lastCameraCoordinateRef = useRef<Coordinate | null>(null);
  const lastCameraModeRef = useRef<CameraMode | null>(null);
  const lastCameraProfileRef = useRef('');
  const lastProjectionAtRef = useRef(0);
  const lastValidHeadingRef = useRef<number | null>(null);
  const manualInteractionRef = useRef(false);
  const liveTransitionFrameRef = useRef<number | null>(null);
  const sheetTranslateY = useRef(new Animated.Value(0)).current;
  const sheetHeightRef = useRef(0);
  const sheetDragStartRef = useRef(0);
  const sheetExpandedRef = useRef(true);
  const sheetAnimationFrameRef = useRef<number | null>(null);
  const screenMountedRef = useRef(true);
  const staleSeenRef = useRef(false);
  const [mapRetryKey, setMapRetryKey] = useState(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialRouteFitRef = useRef(false);
  const liveFollowingRef = useRef(false);
  const trackDurationRef = useRef(0);
  const trackStartRef = useRef<number | null>(null);
  // Position along the live buffer (ms since the trip's first fix). It is only
  // ever driven forward to the newest fix by the live catch-up animation below —
  // there is no user-controlled playback clock, rate, or scrubbing on this screen.
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedMsRef = useRef(0);
  // This is a live-only screen: the marker is always pinned to (and smoothly
  // animated toward) the newest streamed fix. There is no pause/resume state.
  const [isLiveFollowing, setIsLiveFollowing] = useState(true);
  const [liveAgeSec, setLiveAgeSec] = useState<number | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [autoFollowSuspended, setAutoFollowSuspended] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const [cinematicMode, setCinematicMode] = useState(false);
  const [carVariant, setCarVariant] = useState<CarVariant>(() =>
    preferredModel ?? modelForVehicle(vehicleCategory, deviceId ?? 0)
  );
  const [modelLoadState, setModelLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [markerCategoryOverride, setMarkerCategoryOverride] = useState<string | null>(null);
  // Bottom sheet detent: collapsed shows only the summary; expanded shows all.
  const [sheetExpanded, setSheetExpanded] = useState(true);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [collapsedSheetHeight, setCollapsedSheetHeight] = useState(0);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [isTrafficVisible, setIsTrafficVisible] = useState(true);
  const [isNightMode, setIsNightMode] = useState(false);
  const [isSatelliteMode, setIsSatelliteMode] = useState(false);
  const [isAlertActive, setIsAlertActive] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  // Default true because the native map fills the screen. handleMapLayout still
  // flips it to an error if a real zero-size layout is reported.
  const [mapContainerReady, setMapContainerReady] = useState(true);
  const [mapLoadState, setMapLoadState] = useState<MapLoadState>('loading');
  const [mapErrorMessage, setMapErrorMessage] = useState('');
  const [selectedOptionId, setSelectedOptionId] = useState<RouteMapOptionId | null>(null);
  const [toastText, setToastText] = useState('');
  const [mapCameraHeading, setMapCameraHeading] = useState(0);
  const [vehicleScreenPoint, setVehicleScreenPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Native map layer controls. Synchronized with the global mapPreferences storage.
  const [mapPreferences, setMapPreferences] = useState<MapPreferences>(DEFAULT_MAP_PREFERENCES);

  const [tooltipVisible, setTooltipVisible] = useState(false);
  const tooltipAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(tooltipAnim, {
      toValue: tooltipVisible ? 1 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [tooltipVisible]);

  const tooltipStyle = {
    opacity: tooltipAnim,
    transform: [
      { scale: tooltipAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
      { translateY: tooltipAnim.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) },
    ],
  };

  useEffect(() => {
    const sub = navigation.addListener('focus', () => {
      void loadMapPreferences().then((prefs) => {
        setMapPreferences(prefs);
        setIsTrafficVisible(prefs.details.traffic);
      });
    });
    return sub;
  }, [navigation]);
  const [showsUserLocation, setShowsUserLocation] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(true);
  const [mapSize, setMapSize] = useState({ height, width });
  const [overlayHeights, setOverlayHeights] = useState({
    camera: 46,
    cinema: 150,
    header: 70,
    resume: 38,
  });
  const markerCategory = markerCategoryOverride ?? vehicleCategory;

  useEffect(() => {
    const nextModel = preferredModel ?? modelForVehicle(vehicleCategory, deviceId ?? 0);
    if (carVariant !== nextModel) {
      setCarVariant(nextModel);
      setModelLoadState('loading');
      setModelLoadError(null);
    }
    setMarkerCategoryOverride(
      preferredModel ? getVehicleModel(nextModel).category.toUpperCase() : null
    );
  }, [carVariant, deviceId, preferredModel, vehicleCategory]);

  const sample = useMemo(() => sampleAt(track, elapsedMs), [track, elapsedMs]);
  elapsedMsRef.current = elapsedMs;
  liveFollowingRef.current = activeTab === 'live' && isLiveFollowing;
  trackDurationRef.current = track.totalDurationMs;
  const vehicleCoordinate = useMemo<Coordinate>(
    () =>
      sample
        ? { latitude: sample.latitude, longitude: sample.longitude }
        : route[0] ?? { latitude: 0, longitude: 0 },
    [sample, route]
  );
  const heading = sample?.heading ?? 0;
  // Live values change on every animation frame. Callbacks read them through a
  // ref instead of closing over them, so their identity stays stable and the
  // memoised bottom sheet is not re-rendered (and its native-driven transform
  // not re-attached) 60 times a second.
  const liveRef = useRef({ coordinate: vehicleCoordinate, heading });
  liveRef.current = { coordinate: vehicleCoordinate, heading };
  // The rendered route only depends on accepted GPS history, never on the
  // per-frame playback position, so it is not rebuilt on every animation frame.
  const renderRoute = useMemo(() => simplifyRouteForRender(route), [route]);
  const completedRoute = useMemo(() => {
    if (activeTab !== 'history') return [];
    const maxIdx = Math.max(1, sample?.completedPointCount ?? 0);
    return route.slice(0, maxIdx + 1).map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  }, [activeTab, route, sample?.completedPointCount]);
  const trackStartMs = useMemo(() => {
    const start = track.points[0]?.t ? Date.parse(track.points[0].t) : Number.NaN;
    return Number.isFinite(start) ? start : null;
  }, [track.points]);

  useEffect(() => {
    const previousStart = trackStartRef.current;
    trackStartRef.current = trackStartMs;
    if (previousStart == null || trackStartMs == null || previousStart === trackStartMs) return;
    setElapsedMs((current) =>
      Math.min(Math.max(previousStart + current - trackStartMs, 0), track.totalDurationMs)
    );
  }, [track.totalDurationMs, trackStartMs]);

  const coveredKm = sample?.distanceKm ?? 0;
  // Speed is the live-reported value at the current fix — never synthesized.
  const reportedSpeed = Math.max(0, Math.round(sample?.speed ?? 0));
  const isLiveStale =
    live.quality === 'stale' ||
    (liveAgeSec != null && liveAgeSec >= LIVE_STALE_AFTER_SEC);
  const isLowAccuracy = live.quality === 'low_accuracy';
  const hasInvalidLiveFix = live.quality === 'invalid' && !live.latest;
  const liveState = live.latest?.state?.trim().toUpperCase();
  const isStopped = liveState === 'STOPPED' || (!liveState && deviceDetail?.state === 'STOPPED');
  // A remotely cut or locked vehicle cannot be moving whatever the last GPS fix
  // said, so immobilisation outranks the live stream. The flag is refetched when
  // a command invalidates the device cache.
  const isImmobilised = Boolean(deviceDetail?.immobilised || deviceDetail?.locked);
  const currentSpeed = (isImmobilised || isStopped) ? 0 : reportedSpeed;
  const latestIgnition =
    live.latest?.ignition ?? sample?.ignition ?? deviceDetail?.ignition ?? null;
  const isStoppedOff = currentSpeed === 0 && latestIgnition === false;
  const status = isAlertActive
    ? 'Alert'
    : isImmobilised
      ? deviceDetail?.immobilised
        ? 'Engine cut'
        : 'Locked'
      : (isStopped || isStoppedOff)
        ? 'Stopped'
        : liveEnabled && (!live.connected || isLiveStale)
          ? 'Offline'
          : hasInvalidLiveFix
            ? 'GPS error'
            : isLowAccuracy
              ? 'Low accuracy'
              : liveState === 'IDLE'
                ? 'Idle'
                : 'Running';
  const statusColor =
    status === 'Running'
      ? BRAND.greenGlow
      : status === 'Idle' || status === 'Low accuracy'
        ? '#F5A623'
        : status === 'Offline'
          ? BRAND.muted
          : BRAND.red;
  // Not every streamed fix carries a reverse-geocoded address. Falling back to
  // the route param on those fixes made the sheet's two-line address snap
  // between one and two lines on alternating updates, so the last known address
  // is kept until a new one actually arrives.
  const lastAddressRef = useRef<string | null>(null);
  const streamedAddress = live.latest?.address?.trim();
  if (streamedAddress) lastAddressRef.current = streamedAddress;
  const currentAddress = lastAddressRef.current ?? vehicleSubtitle;
  const ignitionText =
    latestIgnition == null ? 'Unknown' : latestIgnition ? 'On' : 'Off';
  const gpsText = live.connected && !isLiveStale ? 'Connected' : isLiveStale ? 'Delayed' : 'Offline';
  // Ping time reflects the last recorded fix, not wall-clock.
  const pingTime = useMemo(() => {
    const last = track.points[track.points.length - 1];
    const parsed = last?.t ? new Date(last.t) : new Date();
    return formatPingTime(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
  }, [track]);

  /**
   * Hard reset when the tracked vehicle changes.
   *
   * The route buffer, playback clock, cached address and camera history all
   * belong to the previous vehicle; carrying them over drew the old trip behind
   * the new marker and left the camera parked on the old position. Clearing them
   * (and re-arming the initial fit) makes the map re-centre on the newly
   * selected vehicle's live location and every readout refresh for it.
   */
  useEffect(() => {
    setElapsedMs(0);
    elapsedMsRef.current = 0;
    setIsLiveFollowing(true);
    setIsFollowing(true);
    setAutoFollowSuspended(false);
    setVehicleScreenPoint(null);
    setLiveAgeSec(null);
    lastAddressRef.current = null;
    manualInteractionRef.current = false;
    initialRouteFitRef.current = false;
    trackStartRef.current = null;
    lastCameraAtRef.current = 0;
    lastCameraCoordinateRef.current = null;
    lastCameraModeRef.current = null;
    lastCameraProfileRef.current = '';
    lastValidHeadingRef.current = null;
    staleSeenRef.current = false;
  }, [deviceId]);

  // Re-centre the camera on the live vehicle and snap the marker to the newest
  // fix. (No timeline seeking — this is a live screen.)
  const jumpToLive = useCallback(() => {
    manualInteractionRef.current = false;
    setAutoFollowSuspended(false);
    setIsFollowing(true);
    if (cameraMode === 'overview') setCameraMode('follow');
    setIsLiveFollowing(true);
    setElapsedMs(trackDurationRef.current);
  }, [cameraMode]);
  const mapStyleInfo = useMemo(
    () => getMapStyleInfo(isNightMode ? 'dark' : isSatelliteMode ? 'bright' : 'street'),
    [isNightMode, isSatelliteMode]
  );
  const useNativeMap = Platform.OS !== 'web';
  const blockingMapIssue = mapStyleInfo.issues.find((issue) => issue.blocking);
  const mapProviderLabel = useMemo(() => {
    if (useNativeMap) return getNativeMapProviderLabel(Platform.OS);
    return mapStyleInfo.webProvider === 'geoapify' ? 'Geoapify web fallback' : 'OpenFreeMap web fallback';
  }, [mapStyleInfo.webProvider, useNativeMap]);
  // One gap constant for every floating layer, so the header, camera rail,
  // control rail and sheet read as an evenly spaced stack on any screen size
  // instead of drifting apart with ad-hoc paddings.
  const headerTop = insets.top + OVERLAY_GAP;
  const cameraBarTop = headerTop + overlayHeights.header + OVERLAY_GAP;
  const cinemaDeckTop = headerTop + overlayHeights.header + OVERLAY_GAP;
  // The LIVE badge now lives inside the header card and the resume pill is
  // anchored above the sheet, so the top stack is just header + camera rail.
  const topOverlayBottom = cinematicMode
    ? cinemaDeckTop + overlayHeights.cinema
    : cameraBarTop + overlayHeights.camera;
  const visibleSheetHeight = isFullScreen
    ? 0
    : sheetExpanded
      ? sheetHeight || Math.min(420, Math.max(280, mapSize.height * 0.48))
      : collapsedSheetHeight || COLLAPSED_SHEET_FALLBACK;
  // Resume tracking floats just above the details sheet rather than over the
  // map, so it never covers the vehicle or the road ahead of it.
  const resumeButtonBottom = Math.ceil(visibleSheetHeight + insets.bottom) + OVERLAY_GAP;
  // The control rail lives in the gap between the tracking overlays and the
  // details sheet, so it can never sit on top of either. When the resume pill is
  // showing, the rail stops above it too.
  const controlRailTop = isFullScreen ? insets.top + OVERLAY_GAP : Math.ceil(topOverlayBottom) + OVERLAY_GAP;
  const controlRailBottom =
    resumeButtonBottom +
    (autoFollowSuspended && !isFullScreen ? overlayHeights.resume + OVERLAY_GAP : 0);
  const mapPadding = useMemo(() => {
    const viewportHeight = Math.max(mapSize.height || height, 1);
    const horizontal = Math.max(20, Math.min(52, (mapSize.width || width) * 0.06));
    const top = Math.min(
      Math.max(insets.top + 20, Math.ceil(topOverlayBottom + 12)),
      Math.max(insets.top + 20, viewportHeight - 96)
    );
    const desiredBottom = Math.ceil(visibleSheetHeight + insets.bottom + 12);
    // Keep a minimum usable strip even on very small landscape screens.
    const bottom = Math.max(88, Math.min(desiredBottom, Math.max(88, viewportHeight - top - 96)));
    return { top, right: horizontal, bottom, left: horizontal };
  }, [
    height,
    insets.bottom,
    insets.top,
    mapSize.height,
    mapSize.width,
    topOverlayBottom,
    visibleSheetHeight,
    width,
  ]);
  const remainingDistanceKm = Math.max(totalDistanceKm - coveredKm, 0);
  // Display strings are derived once and quantised to what is actually shown.
  // Deriving the panel from the raw continuous values rebuilt it on every
  // animation frame, which re-rendered the sheet even when nothing changed.
  const coveredKmText = coveredKm.toFixed(1);
  const totalKmText = totalDistanceKm.toFixed(1);
  const remainingKmText = remainingDistanceKm.toFixed(1);
  const headingDeg = Math.round(heading);
  // Read out the newest accepted fix rather than the interpolated position, so
  // the label reflects real GPS and changes once per fix instead of per frame.
  const coordinateLabel = useMemo(() => {
    const lastFix = track.points[track.points.length - 1];
    return lastFix
      ? formatCoordinate({ latitude: lastFix.lat, longitude: lastFix.lng })
      : formatCoordinate({ latitude: 0, longitude: 0 });
  }, [track.points]);
  const selectedOptionData = useMemo<RouteOptionData | null>(() => {
    if (!selectedOptionId) return null;

    const options: Record<RouteMapOptionId, RouteOptionData> = {
      parking: {
        icon: 'parking',
        metrics: [
          { label: 'State', value: status },
          { label: 'Speed', value: `${currentSpeed} km/h` },
          { label: 'Location', value: coordinateLabel },
        ],
        summary: 'Camera centred on the vehicle at its current live position.',
        title: 'Parking',
        tone: 'green',
      },
      refresh: {
        icon: 'refresh',
        metrics: [
          { label: 'Speed', value: `${currentSpeed} km/h` },
          { label: 'Covered', value: `${coveredKmText} km` },
          { label: 'Ping', value: `${pingTime.dateText}, ${pingTime.timeText}` },
        ],
        summary: 'Live tracking resumed and the camera is following the vehicle.',
        title: 'Refresh',
        tone: 'green',
      },
      follow: {
        icon: 'navigation-variant',
        metrics: [
          { label: 'Mode', value: isFollowing ? 'Following' : 'Manual' },
          { label: 'Heading', value: `${headingDeg} deg` },
          { label: 'Speed', value: `${currentSpeed} km/h` },
        ],
        summary: isFollowing ? 'Camera is locked to the playback marker.' : 'Camera is free for manual map viewing.',
        title: 'Navigation',
        tone: isFollowing ? 'green' : 'orange',
      },
      alert: {
        icon: 'alert',
        metrics: [
          { label: 'State', value: isAlertActive ? 'Active' : 'Cleared' },
          { label: 'Vehicle', value: vehicleName },
          { label: 'Support', value: CONTACT_PHONE },
        ],
        summary: isAlertActive ? 'Emergency alert is active for this vehicle.' : 'Emergency alert is cleared.',
        title: 'Alert',
        tone: isAlertActive ? 'red' : 'green',
      },
      call: {
        icon: 'phone',
        metrics: [
          { label: 'Number', value: CONTACT_PHONE },
          { label: 'Vehicle', value: vehicleName },
          { label: 'Status', value: status },
        ],
        summary: 'Support call opened from the route playback screen.',
        title: 'Call',
        tone: 'orange',
      },
      location: {
        icon: 'map-marker',
        metrics: [
          { label: 'Point', value: coordinateLabel },
          { label: 'Address', value: vehicleSubtitle },
          { label: 'Covered', value: `${coveredKmText} km` },
        ],
        summary: 'Camera centered on the current playback marker.',
        title: 'Location',
        tone: 'green',
      },
      traffic: {
        icon: 'road-variant',
        metrics: [
          { label: 'Route', value: isTrafficVisible ? 'Visible' : 'Hidden' },
          { label: 'Remaining', value: `${remainingKmText} km` },
          { label: 'Trip', value: `${totalKmText} km` },
        ],
        // The tracking route is a single green line with no congestion/speed
        // colours; this control only shows or hides that one line.
        summary: isTrafficVisible
          ? 'The green tracking route is visible.'
          : 'The green tracking route is hidden.',
        title: 'Route Line',
        tone: 'green',
      },
      mapType: {
        icon: 'rhombus-outline',
        metrics: [
          { label: 'Map', value: isSatelliteMode ? 'Bright' : 'Standard' },
          { label: 'Provider', value: mapProviderLabel },
          { label: 'Style', value: isNightMode ? 'Night' : 'Day' },
        ],
        summary: isSatelliteMode ? 'Bright road-map style is selected.' : 'Standard road-map style is selected.',
        title: 'Map Type',
        tone: 'orange',
      },
      direction: {
        icon: 'directions',
        metrics: [
          { label: 'Speed', value: `${currentSpeed} km/h` },
          { label: 'Heading', value: `${headingDeg} deg` },
          { label: 'Covered', value: `${coveredKmText} km` },
        ],
        summary: 'Camera is following the live vehicle.',
        title: 'Direction',
        tone: 'green',
      },
      night: {
        icon: 'weather-night',
        metrics: [
          { label: 'Theme', value: isNightMode ? 'Night' : 'Day' },
          { label: 'Map', value: isSatelliteMode ? 'Bright' : 'Standard' },
          { label: 'Provider', value: mapProviderLabel },
        ],
        summary: isNightMode ? 'Night road-map style is active.' : 'Day road-map style is active.',
        title: 'Night Mode',
        tone: 'orange',
      },
      history: {
        icon: 'history',
        metrics: [
          { label: 'Covered', value: `${coveredKmText} km` },
          { label: 'Trip', value: `${totalKmText} km` },
          { label: 'Ping', value: `${pingTime.dateText}, ${pingTime.timeText}` },
        ],
        summary: 'Opening recorded route history on the playback screen.',
        title: 'History',
        tone: 'green',
      },
    };

    return options[selectedOptionId];
  }, [
    coordinateLabel,
    coveredKmText,
    currentSpeed,
    headingDeg,
    isAlertActive,
    isFollowing,
    isNightMode,
    isSatelliteMode,
    isTrafficVisible,
    mapProviderLabel,
    pingTime,
    remainingKmText,
    selectedOptionId,
    status,
    totalKmText,
    vehicleName,
    vehicleSubtitle,
  ]);

  const moveCamera = useCallback(
    (
      mode: CameraMode,
      lng: number,
      lat: number,
      heading: number,
      duration = 400,
      force = false
    ) => {
      if (
        !useNativeMap ||
        !mapReadyRef.current ||
        mode === 'overview' ||
        (!force && (isLiveStale || manualInteractionRef.current))
      ) {
        return;
      }

      const now = Date.now();
      const target = CAMERA_MODES[mode];
      const modeChanged = lastCameraModeRef.current !== mode;
      const previousCoordinate = lastCameraCoordinateRef.current;
      const distanceMoved = previousCoordinate
        ? haversineKm(previousCoordinate.latitude, previousCoordinate.longitude, lat, lng)
        : Infinity;
      const isStopped = currentSpeed < 2;
      const speedBand =
        currentSpeed >= 75
          ? 'fast'
          : currentSpeed >= 38
            ? 'medium'
            : isStopped
              ? 'stopped'
              : 'moving';
      const cameraProfile = [
        mode,
        speedBand,
        Math.round(mapPadding.top),
        Math.round(mapPadding.right),
        Math.round(mapPadding.bottom),
        Math.round(mapPadding.left),
      ].join(':');
      const profileChanged = lastCameraProfileRef.current !== cameraProfile;
      const validHeading = normalizeHeading(heading, lastValidHeadingRef.current ?? 0);
      if (!isStopped || lastValidHeadingRef.current == null) {
        lastValidHeadingRef.current = validHeading;
      }
      const travelHeading = lastValidHeadingRef.current ?? validHeading;
      const shouldForce = force || modeChanged;
      if (
        !shouldForce &&
        !profileChanged &&
        now - lastCameraAtRef.current < CAMERA_MIN_GAP_MS
      ) {
        return;
      }
      const cameraHeading = target.bearingFollowsHeading
        ? isStopped
          ? travelHeading
          : shouldForce
            ? travelHeading
            : lerpAngle(lastCameraHeadingRef.current, travelHeading, 0.42)
        : 0;
      if (
        !shouldForce &&
        !profileChanged &&
        distanceMoved < 0.002 &&
        Math.abs(
          ((((cameraHeading - lastCameraHeadingRef.current) % 360) + 540) % 360) - 180
        ) < 2
      ) {
        return;
      }
      const speedZoomAdjustment =
        currentSpeed >= 75 ? -0.85 : currentSpeed >= 38 ? -0.42 : isStopped ? 0.32 : 0;
      const speedOffsetScale =
        isStopped ? 0 : currentSpeed >= 75 ? 1.45 : currentSpeed >= 38 ? 1.18 : 0.82;
      const center = offsetCoordinate(
        lat,
        lng,
        target.bearingFollowsHeading ? cameraHeading : travelHeading,
        target.forwardMeters * speedOffsetScale
      );
      lastCameraAtRef.current = now;
      lastCameraHeadingRef.current = cameraHeading;
      lastCameraCoordinateRef.current = { latitude: lat, longitude: lng };
      lastCameraModeRef.current = mode;
      lastCameraProfileRef.current = cameraProfile;
      setMapCameraHeading(cameraHeading);
      mapRef.current?.animateCamera(
        {
          center,
          pitch: isStopped && mode !== 'top' ? Math.max(18, target.pitch - 8) : target.pitch,
          zoom: target.zoom + speedZoomAdjustment,
          heading: cameraHeading,
        },
        { duration }
      );
    },
    [currentSpeed, isLiveStale, mapPadding, useNativeMap]
  );
  const moveCameraRef = useRef(moveCamera);
  moveCameraRef.current = moveCamera;

  const showToast = useCallback((message: string) => {
    setToastText(message);

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = setTimeout(() => {
      setToastText('');
    }, 1800);
  }, []);

  const haptic = useCallback(() => {
    if (Platform.OS !== 'web') {
      void Haptics.selectionAsync().catch(() => undefined);
    }
  }, []);

  const selectVehicleModel = useCallback(
    (variant: CarVariant) => {
      haptic();
      setModelLoadState('loading');
      setModelLoadError(null);
      setCarVariant(variant);
      setMarkerCategoryOverride(getVehicleModel(variant).category.toUpperCase());
      dispatch(setVehicleModelPreference({ deviceKey: devicePreferenceKey, variant }));
      if (__DEV__) console.debug(`[VehicleModel] selected ${variant}`);
    },
    [devicePreferenceKey, dispatch, haptic]
  );

  const openVehiclePicker = useCallback(() => {
    if (fleet.length <= 1) return;
    haptic();
    setVehiclePickerOpen(true);
  }, [fleet.length, haptic]);

  const closeVehiclePicker = useCallback(() => setVehiclePickerOpen(false), []);

  /**
   * Switches the tracked vehicle.
   *
   * Everything on this screen is derived from `params.deviceId`, so re-pointing
   * the route params is enough to move the device detail query, the live SSE
   * subscription, the route buffer and every readout (speed, ignition, GPS,
   * trip) onto the newly selected vehicle. The reset effect below then clears
   * the previous vehicle's route/camera state and re-centres the map.
   */
  const selectVehicle = useCallback(
    (device: DeviceSummary) => {
      setVehiclePickerOpen(false);
      if (device.id === deviceId) return;
      haptic();
      router.setParams({
        // Empty strings would win over the freshly fetched device detail (they
        // are not nullish), so only pass through values we actually have.
        ...(device.category ? { category: device.category } : {}),
        ...(device.address ? { subtitle: device.address } : {}),
        deviceId: String(device.id),
        name: device.name,
      });
      showToast(`Tracking ${device.name}`);
    },
    [deviceId, haptic, router, showToast]
  );

  const snapSheet = useCallback(
    (expanded: boolean) => {
      const collapsedOffset = Math.max(48, sheetHeightRef.current - 48);
      sheetExpandedRef.current = expanded;
      sheetTranslateY.stopAnimation();
      if (sheetAnimationFrameRef.current != null) {
        cancelAnimationFrame(sheetAnimationFrameRef.current);
        sheetAnimationFrameRef.current = null;
      }
      setSheetExpanded(expanded);
      if (expanded) {
        Animated.spring(sheetTranslateY, {
          damping: 22,
          mass: 0.82,
          stiffness: 240,
          toValue: 0,
          useNativeDriver: true,
        }).start();
      } else {
        Animated.spring(sheetTranslateY, {
          damping: 24,
          mass: 0.86,
          stiffness: 250,
          toValue: collapsedOffset,
          useNativeDriver: true,
        }).start();
      }
      haptic();
    },
    [haptic, sheetTranslateY]
  );

  const sheetPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gesture) =>
          gesture.dy > 5 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
          gesture.dy > 5 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
        onPanResponderGrant: () => {
          sheetTranslateY.stopAnimation((value) => {
            sheetDragStartRef.current = value;
          });
        },
        onPanResponderMove: (_, gesture) => {
          const collapsedOffset = Math.max(48, sheetHeightRef.current - 48);
          sheetTranslateY.setValue(
            Math.max(0, Math.min(collapsedOffset, sheetDragStartRef.current + gesture.dy))
          );
        },
        onPanResponderRelease: (_, gesture) => {
          const collapsedOffset = Math.max(48, sheetHeightRef.current - 48);
          const projected = sheetDragStartRef.current + gesture.dy + gesture.vy * 90;
          snapSheet(projected < collapsedOffset * 0.5);
        },
        onPanResponderTerminate: () => snapSheet(sheetExpandedRef.current),
      }),
    [sheetTranslateY, snapSheet]
  );

  // Stable identities so the memoised sheet is not re-rendered by a new inline
  // arrow on every tick of the live position.
  const toggleSheet = useCallback(() => snapSheet(!sheetExpandedRef.current), [snapSheet]);
  const expandSheet = useCallback(() => snapSheet(true), [snapSheet]);
  const toggleTools = useCallback(() => setToolsExpanded((current) => !current), []);
  const closeOptionPanel = useCallback(() => setSelectedOptionId(null), []);

  const handleSheetLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = Math.ceil(event.nativeEvent.layout.height);
      if (nextHeight <= 0) return;
      sheetHeightRef.current = nextHeight;
      setSheetHeight((current) => (current === nextHeight ? current : nextHeight));
    },
    []
  );

  const fitWholeRoute = useCallback(() => {
    if (
      !useNativeMap ||
      !mapRef.current ||
      !mapReadyRef.current ||
      !mapLayoutReadyRef.current ||
      manualInteractionRef.current
    ) {
      return false;
    }
    const coordinates = [...renderRoute, vehicleCoordinate].filter(
      (coordinate) =>
        Number.isFinite(coordinate.latitude) &&
        Number.isFinite(coordinate.longitude) &&
        Math.abs(coordinate.latitude) <= 90 &&
        Math.abs(coordinate.longitude) <= 180 &&
        !(coordinate.latitude === 0 && coordinate.longitude === 0)
    );
    const seen = new Set<string>();
    const distinct = coordinates.filter((coordinate) => {
      const key = `${coordinate.latitude.toFixed(7)}:${coordinate.longitude.toFixed(7)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (distinct.length < 2) {
      const only = distinct[0];
      if (only) {
        setMapCameraHeading(0);
        mapRef.current.animateCamera(
          {
            center: only,
            heading: 0,
            pitch: 0,
            zoom: CAMERA_MODES.top.zoom,
          },
          { duration: 420 }
        );
      }
      return false;
    }

    setMapCameraHeading(0);
    mapRef.current.setCamera({ heading: 0, pitch: 0 });
    mapRef.current.fitToCoordinates(distinct, {
      edgePadding: {
        top: mapPadding.top,
        right: mapPadding.right,
        bottom: mapPadding.bottom,
        left: mapPadding.left,
      },
      animated: true,
    });
    lastCameraModeRef.current = 'overview';
    return true;
  }, [mapPadding, renderRoute, useNativeMap, vehicleCoordinate]);
  fitWholeRouteRef.current = fitWholeRoute;

  const selectCameraMode = useCallback(
    (mode: CameraMode) => {
      manualInteractionRef.current = false;
      setCameraMode(mode);
      setAutoFollowSuspended(false);
      haptic();
      if (__DEV__) console.debug(`[Camera] mode ${mode}`);
      if (mode === 'overview') {
        setIsFollowing(false);
        fitWholeRouteRef.current();
      } else {
        setIsFollowing(true);
        const { coordinate, heading: liveHeading } = liveRef.current;
        moveCameraRef.current(
          mode,
          coordinate.longitude,
          coordinate.latitude,
          liveHeading,
          620,
          true
        );
      }
      showToast(`${CAMERA_MODES[mode].label} camera`);
    },
    [haptic, showToast]
  );

  const handleManualMapInteraction = useCallback(() => {
    manualInteractionRef.current = true;
    if (isFollowing || cameraMode === 'overview') {
      if (isFollowing) setIsFollowing(false);
      setAutoFollowSuspended(true);
    }
  }, [cameraMode, isFollowing]);

  const resumeCinematicTracking = useCallback(() => {
    manualInteractionRef.current = false;
    setAutoFollowSuspended(false);
    setIsFollowing(true);
    setIsLiveFollowing(true);
    haptic();
    if (cameraMode === 'overview') {
      setIsFollowing(false);
      fitWholeRouteRef.current();
      showToast('Overview restored');
      return;
    }
    const { coordinate, heading: liveHeading } = liveRef.current;
    if (useNativeMap) {
      moveCameraRef.current(
        cameraMode,
        coordinate.longitude,
        coordinate.latitude,
        liveHeading,
        500,
        true
      );
    } else {
      webMapRef.current?.fitAll();
    }
    showToast('Centered on vehicle');
  }, [cameraMode, haptic, showToast, useNativeMap]);

  // ---------------------------------------------------------------------------
  // Map controls. Every handler has a stable identity so the control rail (and
  // the memoised bottom sheet) are not re-rendered by the live position ticks.
  // ---------------------------------------------------------------------------

  const zoomBy = useCallback(
    async (delta: number) => {
      haptic();
      manualInteractionRef.current = true;
      if (!useNativeMap) {
        if (delta > 0) {
          webMapRef.current?.zoomIn();
        } else {
          webMapRef.current?.zoomOut();
        }
        return;
      }
      const instance = mapRef.current;
      if (!instance) return;
      try {
        const camera = await instance.getCamera();
        if (camera.zoom != null) {
          instance.animateCamera(
            { zoom: Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, camera.zoom + delta)) },
            { duration: 260 }
          );
          return;
        }
        // iOS cameras report altitude rather than zoom; halving/doubling the
        // altitude is the equivalent of one zoom level.
        const altitude = camera.altitude ?? 1400;
        instance.animateCamera(
          { altitude: Math.min(2_000_000, Math.max(120, delta > 0 ? altitude / 2 : altitude * 2)) },
          { duration: 260 }
        );
      } catch {
        // Camera reads can reject while the provider is laying out.
      }
    },
    [haptic, useNativeMap]
  );

  const resetBearing = useCallback(async () => {
    haptic();
    if (!useNativeMap) {
      webMapRef.current?.resetBearing();
      setMapCameraHeading(0);
      lastCameraHeadingRef.current = 0;
      showToast('Facing north');
      return;
    }
    const instance = mapRef.current;
    if (!instance) return;
    try {
      const camera = await instance.getCamera();
      instance.animateCamera({ ...camera, heading: 0 }, { duration: 320 });
      setMapCameraHeading(0);
      lastCameraHeadingRef.current = 0;
      showToast('Facing north');
    } catch {
      // Ignore: the camera is mid-animation.
    }
  }, [haptic, showToast, useNativeMap]);

  const toggleUserLocation = useCallback(async () => {
    haptic();
    if (showsUserLocation) {
      setShowsUserLocation(false);
      showToast('My location hidden');
      return;
    }

    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          showToast('Location permission denied');
          return;
        }
      } catch {
        showToast('Location permission unavailable');
        return;
      }
    }

    setShowsUserLocation(true);
    showToast('Showing my location');

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (useNativeMap && mapRef.current) {
            mapRef.current.animateCamera(
              {
                center: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
                zoom: 15,
              },
              { duration: 500 }
            );
          }
        },
        () => undefined,
        { enableHighAccuracy: true, timeout: 5000 }
      );
    }
  }, [haptic, showToast, showsUserLocation, useNativeMap]);

  const cycleMapType = useCallback(() => {
    haptic();
    setMapPreferences((current) => {
      const nextType: MapTypeOption =
        current.mapType === 'standard'
          ? 'satellite'
          : current.mapType === 'satellite'
            ? 'terrain'
            : 'standard';
      const updated = { ...current, mapType: nextType };
      void saveMapPreferences(updated);
      const labels = { standard: 'Default map', satellite: 'Satellite map', terrain: 'Terrain map' };
      showToast(labels[nextType]);
      return updated;
    });
  }, [haptic, showToast]);

  const toggleTrafficLayer = useCallback(() => {
    haptic();
    setMapPreferences((current) => {
      const nextTraffic = !current.details.traffic;
      const updated = {
        ...current,
        details: { ...current.details, traffic: nextTraffic },
      };
      void saveMapPreferences(updated);
      setIsTrafficVisible(nextTraffic);
      showToast(nextTraffic ? 'Traffic layer on' : 'Traffic layer off');
      return updated;
    });
  }, [haptic, showToast]);

  const toggleFullScreen = useCallback(() => {
    haptic();
    setIsFullScreen((current) => {
      showToast(current ? 'Exited full screen' : 'Full screen map');
      return !current;
    });
  }, [haptic, showToast]);

  const refreshMap = useCallback(async () => {
    haptic();
    showToast('Refreshing live data');
    try {
      await refetchDevice();
      if (useNativeMap) {
        void syncNativeProjectionRef.current(true);
      }
      showToast('Refreshed live map');
    } catch {
      showToast('Refresh failed');
    }
  }, [haptic, refetchDevice, showToast, useNativeMap]);

  const openStreetView = useCallback(async () => {
    haptic();
    const { coordinate } = liveRef.current;
    if (!coordinate || (coordinate.latitude === 0 && coordinate.longitude === 0)) {
      showToast('Location unavailable for Street View');
      return;
    }
    const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${coordinate.latitude},${coordinate.longitude}`;
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        showToast('Street View unavailable on this device');
      }
    } catch {
      showToast('Could not open Street View');
    }
  }, [haptic, showToast]);

  const measureOverlay = useCallback(
    (key: keyof typeof overlayHeights, event: LayoutChangeEvent) => {
      const next = Math.ceil(event.nativeEvent.layout.height);
      if (next <= 0) return;
      setOverlayHeights((current) =>
        current[key] === next ? current : { ...current, [key]: next }
      );
    },
    []
  );

  const scheduleCameraFrame = useCallback((task: () => void) => {
    if (cameraFrameRef.current != null) {
      cancelAnimationFrame(cameraFrameRef.current);
    }
    cameraFrameRef.current = requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      if (screenMountedRef.current) task();
    });
  }, []);

  /**
   * Layout of the MAP surface itself.
   *
   * This must be the only writer of `mapSize`. It used to also be attached to
   * the screen's SafeAreaView, whose box is taller than the map by the bottom
   * inset — so the two callbacks fought over `mapSize`, which re-keyed (and so
   * destroyed and recreated) the 3D overlay's GL surface on every layout pass
   * and left the vehicle stuck on the 2D fallback. `pointForCoordinate` also
   * projects into the map's box, so this is the size the overlay needs.
   */
  const handleMapLayout = useCallback((event: LayoutChangeEvent) => {
    const { height: mapHeight, width: mapWidth } = event.nativeEvent.layout;
    const hasVisibleSize = mapHeight > 0 && mapWidth > 0;
    mapLayoutReadyRef.current = hasVisibleSize;
    setMapContainerReady(hasVisibleSize);
    if (hasVisibleSize) {
      const nextHeight = Math.ceil(mapHeight);
      const nextWidth = Math.ceil(mapWidth);
      setMapSize((current) =>
        current.height === nextHeight && current.width === nextWidth
          ? current
          : { height: nextHeight, width: nextWidth }
      );
    }

    if (!hasVisibleSize) {
      setMapLoadState('error');
      setMapErrorMessage('Map container has no visible size.');
    } else if (mapReadyRef.current && !initialRouteFitRef.current) {
      scheduleCameraFrame(() => {
        if (!mapLayoutReadyRef.current || initialRouteFitRef.current) return;
        if (cameraMode === 'overview') {
          fitWholeRouteRef.current();
        } else {
          const { coordinate, heading: liveHeading } = liveRef.current;
          moveCameraRef.current(
            cameraMode,
            coordinate.longitude,
            coordinate.latitude,
            liveHeading,
            620,
            true
          );
        }
        initialRouteFitRef.current = true;
      });
    }
  }, [cameraMode, scheduleCameraFrame]);

  const syncNativeProjection = useCallback(
    async (force = false) => {
      if (!useNativeMap || !mapRef.current || !mapReadyRef.current) return;
      const now = Date.now();
      if (!force && now - lastProjectionAtRef.current < 40) return;
      lastProjectionAtRef.current = now;
      const requestId = ++cameraReadRequestRef.current;
      try {
        const [camera, point] = await Promise.all([
          mapRef.current.getCamera(),
          mapRef.current.pointForCoordinate(vehicleCoordinate),
        ]);
        if (requestId !== cameraReadRequestRef.current || !screenMountedRef.current) return;
        const nextHeading = Number.isFinite(camera.heading) ? normalizeHeading(camera.heading) : 0;
        const nextPitch = Number.isFinite(camera.pitch) ? camera.pitch : 0;
        if (
          cameraMode === 'overview' &&
          !manualInteractionRef.current &&
          (Math.abs(nextHeading) >= 0.5 || Math.abs(nextPitch) >= 0.5)
        ) {
          mapRef.current?.setCamera({ ...camera, heading: 0, pitch: 0 });
          setMapCameraHeading(0);
        } else {
          setMapCameraHeading((current) =>
            Math.abs(current - nextHeading) < 0.5 ? current : nextHeading
          );
        }
        if (
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          point.x >= -120 &&
          point.x <= mapSize.width + 120 &&
          point.y >= -120 &&
          point.y <= mapSize.height + 120
        ) {
          setVehicleScreenPoint(point);
        }
      } catch {
        // Projection can reject while the provider is laying out or animating.
      }
    },
    [cameraMode, mapSize.height, mapSize.width, useNativeMap, vehicleCoordinate]
  );
  // Rebuilt on every fix (it closes over the live coordinate), so map callbacks
  // go through this ref to keep MapView's props stable.
  const syncNativeProjectionRef = useRef(syncNativeProjection);
  syncNativeProjectionRef.current = syncNativeProjection;

  const handleRegionChange = useCallback(() => {
    void syncNativeProjectionRef.current(false);
  }, []);

  const handleRegionChangeComplete = useCallback(() => {
    void syncNativeProjectionRef.current(true);
  }, []);

  const handleWebProjection = useCallback((projection: WebMapProjection) => {
    setMapCameraHeading(normalizeHeading(projection.heading));
    const point = projection.points.vehicle;
    if (point) setVehicleScreenPoint(point);
  }, []);

  const handleMapReady = useCallback(() => {
    if (blockingMapIssue) {
      setMapLoadState('error');
      setMapErrorMessage(blockingMapIssue.message);
      return;
    }

    mapReadyRef.current = true;
    setIsMapReady(true);
    setMapLoadState('ready');
    setMapErrorMessage('');

    scheduleCameraFrame(() => {
      if (mapLayoutReadyRef.current && !initialRouteFitRef.current) {
        if (cameraMode === 'overview') {
          fitWholeRouteRef.current();
        } else {
          const { coordinate, heading: liveHeading } = liveRef.current;
          moveCameraRef.current(
            cameraMode,
            coordinate.longitude,
            coordinate.latitude,
            liveHeading,
            620,
            true
          );
        }
        initialRouteFitRef.current = true;
      }
      void syncNativeProjectionRef.current(true);
    });
  }, [blockingMapIssue, cameraMode, scheduleCameraFrame]);

  const retryMapLoad = useCallback(() => {
    initialRouteFitRef.current = false;
    mapReadyRef.current = false;
    mapLayoutReadyRef.current = false;
    lastCameraAtRef.current = 0;
    lastCameraCoordinateRef.current = null;
    lastCameraModeRef.current = null;
    lastCameraProfileRef.current = '';
    setVehicleScreenPoint(null);
    setIsMapReady(false);
    setMapLoadState('loading');
    setMapErrorMessage('');
    setMapRetryKey((current) => current + 1);
  }, []);

  const handleRouteTool = useCallback(
    (id: RouteMapOptionId) => {
      setSelectedOptionId(id);
      setToolsExpanded(false);
      haptic();
      switch (id) {
        case 'parking':
          // Live screen: re-centre on the vehicle's current position.
          resumeCinematicTracking();
          showToast('Centered on vehicle');
          break;
        case 'refresh':
          // Live screen: resume live-follow and re-centre (no route restart).
          setIsAlertActive(false);
          resumeCinematicTracking();
          showToast('Live tracking resumed');
          break;
        case 'follow':
          if (isFollowing) {
            setIsFollowing(false);
            setAutoFollowSuspended(true);
            showToast('Manual map mode');
          } else {
            resumeCinematicTracking();
          }
          break;
        case 'alert':
          setIsAlertActive(!isAlertActive);
          showToast(!isAlertActive ? 'Emergency alert active' : 'Alert cleared');
          break;
        case 'call':
          Linking.openURL(`tel:${CONTACT_PHONE}`).catch(() => undefined);
          showToast('Calling support');
          break;
        case 'location':
          resumeCinematicTracking();
          showToast('Vehicle centered');
          break;
        case 'traffic':
          setIsTrafficVisible(!isTrafficVisible);
          showToast(isTrafficVisible ? 'Route hidden' : 'Route visible');
          break;
        case 'mapType':
          setIsSatelliteMode(!isSatelliteMode);
          showToast(isSatelliteMode ? 'Standard map' : 'Bright map');
          break;
        case 'direction':
          // Live screen: follow the vehicle (there is no future route to skip to).
          setIsFollowing(true);
          setAutoFollowSuspended(false);
          resumeCinematicTracking();
          showToast('Following vehicle');
          break;
        case 'night':
          setIsNightMode(!isNightMode);
          showToast(isNightMode ? 'Day map' : 'Night map');
          break;
        case 'history':
          // Recorded route history lives on the SEPARATE playback screen, so the
          // live screen never shows past/complete routes — it links out instead.
          if (validDeviceId) {
            const variant = modelForVehicle(vehicleCategory, deviceId);
            const model = getVehicleModel(variant);
            router.push({
              pathname: '/trip-playback' as never,
              params: {
                deviceId: String(deviceId),
                name: vehicleName,
                category: vehicleCategory,
                make: model.label,
                model: model.id,
                speed: String(deviceDetail?.speed ?? 0),
                heading: String(deviceDetail?.course ?? 0),
              },
            });
          }
          showToast('Opening route history');
          break;
      }
    },
    [
      deviceId,
      haptic,
      isAlertActive,
      isFollowing,
      isNightMode,
      isSatelliteMode,
      isTrafficVisible,
      resumeCinematicTracking,
      router,
      showToast,
      validDeviceId,
      vehicleName,
    ]
  );

  // NOTE: There is intentionally no playback clock, rate multiplier, pause/resume,
  // or scrubbing on this LIVE screen. The vehicle only ever moves toward the newest
  // streamed fix via the single live catch-up animation below. Recorded-timeline
  // playback lives on the separate Route Playback / History screen.

  useEffect(() => {
    // Smoothly catch up to each new live fix. Cancelling the previous RAF before
    // starting the next prevents duplicate animations when updates arrive fast.
    if (!appActive || activeTab !== 'live' || !isLiveFollowing) return;
    if (liveTransitionFrameRef.current != null) {
      cancelAnimationFrame(liveTransitionFrameRef.current);
    }
    const from = Math.min(elapsedMsRef.current, track.totalDurationMs);
    const to = track.totalDurationMs;
    if (to <= from) {
      setElapsedMs(to);
      return;
    }
    if (isStopped || isStoppedOff) {
      setElapsedMs(to);
      return;
    }
    const recordedGapMs = to - from;
    const duration = Math.min(
      LIVE_TRANSITION_MAX_MS,
      Math.max(LIVE_TRANSITION_MIN_MS, recordedGapMs * 0.82)
    );
    const startedAt = Date.now();
    // Publish at ~30fps rather than every frame. Everything downstream is
    // already slower than that (the camera moves at most every 560ms, the
    // projection at 25fps, the 3D overlay at ~30fps), and a 60fps setState here
    // re-rendered the whole screen — which detached and re-attached the bottom
    // sheet's native-driven transform on every frame, making it flicker.
    let lastPublishedAt = 0;
    const animate = () => {
      const now = Date.now();
      const fraction = Math.min(1, (now - startedAt) / duration);
      if (fraction >= 1 || now - lastPublishedAt >= LIVE_PUBLISH_INTERVAL_MS) {
        lastPublishedAt = now;
        const eased = 1 - (1 - fraction) ** 3;
        setElapsedMs(from + (to - from) * eased);
      }
      if (fraction < 1) {
        liveTransitionFrameRef.current = requestAnimationFrame(animate);
      } else {
        liveTransitionFrameRef.current = null;
      }
    };
    liveTransitionFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (liveTransitionFrameRef.current != null) {
        cancelAnimationFrame(liveTransitionFrameRef.current);
        liveTransitionFrameRef.current = null;
      }
    };
  }, [appActive, activeTab, isLiveFollowing, isStopped, isStoppedOff, track.totalDurationMs]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const nextActive = state === 'active';
      if (nextActive && liveFollowingRef.current) {
        if (liveTransitionFrameRef.current != null) {
          cancelAnimationFrame(liveTransitionFrameRef.current);
          liveTransitionFrameRef.current = null;
        }
        // Resume at the authoritative latest fix instead of replaying animation
        // frames accumulated while the app was in the background.
        setElapsedMs(trackDurationRef.current);
      }
      setAppActive(nextActive);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    // Tick the "last update" age once a second while a live feed is active.
    if (!liveEnabled) {
      setLiveAgeSec(null);
      return;
    }
    const update = () =>
      setLiveAgeSec(
        live.lastReceivedAt
          ? Math.max(0, Math.round((Date.now() - live.lastReceivedAt) / 1000))
          : null
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [liveEnabled, live.lastReceivedAt]);

  useEffect(() => {
    if (isLiveStale && live.lastReceivedAt) {
      staleSeenRef.current = true;
      return;
    }
    if (staleSeenRef.current && live.connected && liveAgeSec != null && !isLiveStale) {
      staleSeenRef.current = false;
      showToast('Live GPS connection restored');
    }
  }, [isLiveStale, live.connected, live.lastReceivedAt, liveAgeSec, showToast]);

  useEffect(() => {
    if (live.rejectedReason) showToast(live.rejectedReason);
  }, [live.rejectedReason, showToast]);

  const fallbackMarkers = useMemo<WebMapMarker[]>(
    () => [
      {
        category: getVehicleModel(carVariant).category.toUpperCase(),
        id: 'vehicle',
        lat: vehicleCoordinate.latitude,
        lng: vehicleCoordinate.longitude,
        color: getVehicleModel(carVariant).paintColor,
        heading,
        hidden: modelLoadState === 'ready' && vehicleScreenPoint != null,
        label: vehicleName,
      },
    ],
    [carVariant, heading, modelLoadState, vehicleCoordinate, vehicleName, vehicleScreenPoint]
  );
  const fallbackPolyline = useMemo<[number, number][]>(
    () => renderRoute.map((c) => [c.longitude, c.latitude] as [number, number]),
    [renderRoute]
  );
  const projectedVehicleMarkers = useMemo<Fleet3DOverlayMarker[]>(
    () =>
      vehicleScreenPoint && sample
        ? [
          {
            heading: normalizeHeading(heading - mapCameraHeading),
            id: 'vehicle',
            isActive: !isStopped && !isStoppedOff && currentSpeed > 0,
            selected: true,
            speed: currentSpeed,
            variant: carVariant,
            x: vehicleScreenPoint.x,
            y: vehicleScreenPoint.y,
          },
        ]
        : [],
    [
      carVariant,
      currentSpeed,
      heading,
      isStoppedOff,
      mapCameraHeading,
      sample,
      vehicleScreenPoint,
    ]
  );

  useEffect(() => {
    screenMountedRef.current = true;
    return () => {
      screenMountedRef.current = false;
      sheetTranslateY.stopAnimation();
      if (sheetAnimationFrameRef.current != null) {
        cancelAnimationFrame(sheetAnimationFrameRef.current);
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
      if (liveTransitionFrameRef.current != null) {
        cancelAnimationFrame(liveTransitionFrameRef.current);
      }
      if (cameraFrameRef.current != null) {
        cancelAnimationFrame(cameraFrameRef.current);
      }
      cameraReadRequestRef.current += 1;
    };
  }, [sheetTranslateY]);

  useEffect(() => {
    initialRouteFitRef.current = false;
    mapReadyRef.current = false;
    setIsMapReady(false);

    if (!useNativeMap) {
      mapReadyRef.current = true;
      mapLayoutReadyRef.current = true;
      setIsMapReady(true);
      setMapLoadState('ready');
      setMapErrorMessage('');
      return;
    }

    if (blockingMapIssue) {
      setMapLoadState('error');
      setMapErrorMessage(blockingMapIssue.message);
      return;
    }

    setMapLoadState('loading');
    setMapErrorMessage('');
  }, [blockingMapIssue, mapRetryKey, useNativeMap]);

  // No external tile-load timeout is needed for the native Google/Apple map.

  useEffect(() => {
    if (!appActive || !isFollowing || !isMapReady || isLiveStale) {
      return;
    }

    moveCamera(cameraMode, vehicleCoordinate.longitude, vehicleCoordinate.latitude, heading, 520);
  }, [
    appActive,
    moveCamera,
    cameraMode,
    isFollowing,
    isLiveStale,
    isMapReady,
    vehicleCoordinate,
    heading,
    mapPadding.bottom,
    mapPadding.left,
    mapPadding.right,
    mapPadding.top,
  ]);

  useEffect(() => {
    if (!appActive || !isMapReady || !useNativeMap) return;
    void syncNativeProjection(false);
  }, [appActive, isMapReady, syncNativeProjection, useNativeMap, vehicleCoordinate]);

  useEffect(() => {
    if (
      !appActive ||
      !isMapReady ||
      cameraMode !== 'overview' ||
      manualInteractionRef.current
    ) {
      return;
    }
    scheduleCameraFrame(() => {
      fitWholeRouteRef.current();
    });
  }, [
    appActive,
    cameraMode,
    isMapReady,
    mapPadding.bottom,
    mapPadding.left,
    mapPadding.right,
    mapPadding.top,
    scheduleCameraFrame,
  ]);

  const isMapLoading = useNativeMap && (mapLoadState === 'loading' || !mapContainerReady);

  const leftMapControls = useMemo<MapControl[]>(
    () => [
      {
        active: isFollowing && !autoFollowSuspended,
        icon: 'crosshairs-gps',
        label: 'Recenter on vehicle',
        onPress: resumeCinematicTracking,
      },
      {
        active: showsUserLocation,
        icon: 'account-circle-outline',
        label: 'My location',
        onPress: () => void toggleUserLocation(),
      },
      { icon: 'plus', label: 'Zoom in', onPress: () => void zoomBy(1) },
      { icon: 'minus', label: 'Zoom out', onPress: () => void zoomBy(-1) },
      {
        active: Math.abs(mapCameraHeading) > 0.5,
        icon: 'navigation',
        label: 'Face north',
        onPress: () => void resetBearing(),
        // The needle points at true north relative to the current camera.
        rotation: -mapCameraHeading,
      },
    ],
    [
      autoFollowSuspended,
      isFollowing,
      mapCameraHeading,
      resetBearing,
      resumeCinematicTracking,
      showsUserLocation,
      toggleUserLocation,
      zoomBy,
    ]
  );

  const rightMapControls = useMemo<MapControl[]>(
    () => [
      {
        active: mapPreferences.mapType !== 'standard',
        icon: mapPreferences.mapType === 'standard' ? 'layers-outline' : 'satellite-variant',
        label: `Map type: ${mapPreferences.mapType === 'satellite'
          ? 'Satellite'
          : mapPreferences.mapType === 'terrain'
            ? 'Terrain'
            : 'Default'
          }`,
        onPress: cycleMapType,
      },
      {
        active: mapPreferences.details.traffic,
        icon: 'traffic-light',
        label: 'Traffic layer',
        onPress: toggleTrafficLayer,
      },
      { icon: 'panorama-variant-outline', label: 'Street View', onPress: openStreetView },
      {
        active: isFullScreen,
        icon: isFullScreen ? 'fullscreen-exit' : 'fullscreen',
        label: isFullScreen ? 'Exit full screen' : 'Full screen',
        onPress: toggleFullScreen,
      },
      { icon: 'refresh', label: 'Refresh map', onPress: refreshMap },
    ],
    [
      cycleMapType,
      isFullScreen,
      mapPreferences,
      openStreetView,
      refreshMap,
      toggleFullScreen,
      toggleTrafficLayer,
    ]
  );
  const toggleControls = useCallback(() => setControlsExpanded((current) => !current), []);

  // Real device with no usable history AND no live fixes yet: show a loading
  // state while the playback query resolves, then a proper empty state. Never
  // fall back to the demo route for a real device (no fabricated GPS movement in
  // production). Live streaming alone is enough to render the map.
  if (hasRealDevice && track.points.length === 0) {
    return (
      <View style={styles.screen}>
        <View style={[styles.headerCard, { top: headerTop }]}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/map'))}
            style={styles.headerIconButton}>
            <MaterialCommunityIcons color={BRAND.green} name="arrow-left" size={30} />
          </Pressable>
          <View style={styles.headerTextBlock}>
            <Text numberOfLines={1} style={styles.headerTitle}>{vehicleName}</Text>
            <Text numberOfLines={1} style={styles.headerSubtitle}>{vehicleSubtitle}</Text>
          </View>
        </View>
        <View style={styles.playbackStateBox}>
          {!live.connected && !live.rejectedReason ? (
            <>
              <ActivityIndicator color={BRAND.green} size="large" />
              <Text style={styles.playbackStateText}>Connecting to live GPS…</Text>
            </>
          ) : (
            <>
              <MaterialCommunityIcons color={BRAND.muted} name="map-marker-off-outline" size={40} />
              <Text style={styles.playbackStateText}>
                {live.rejectedReason ??
                  'Waiting for the first live GPS position of this vehicle.'}
              </Text>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.screen}>
      {useNativeMap ? (
        <MapView
          key={`route-map-${mapRetryKey}`}
          ref={mapRef}
          customMapStyle={mapPreferences.mapType === 'satellite' ? [] : mapStyleInfo.style}
          initialCamera={{
            center: route[Math.min(20, route.length - 1)] ?? vehicleCoordinate,
            heading: 0,
            pitch: 38,
            zoom: 14.8,
          }}
          mapPadding={mapPadding}
          mapType={
            mapPreferences.mapType === 'satellite'
              ? 'hybrid'
              : mapPreferences.mapType === 'terrain'
                ? 'terrain'
                : 'standard'
          }
          onLayout={handleMapLayout}
          onMapReady={handleMapReady}
          onPanDrag={handleManualMapInteraction}
          onPress={() => {
            handleManualMapInteraction();
            setTooltipVisible(false);
          }}
          onRegionChange={handleRegionChange}
          onRegionChangeComplete={handleRegionChangeComplete}
          onTouchStart={handleManualMapInteraction}
          pitchEnabled
          rotateEnabled
          scrollEnabled
          showsBuildings
          // The in-house rail below owns the compass and my-location controls,
          // so the provider's own buttons stay off to avoid two of each.
          showsCompass={false}
          showsMyLocationButton={false}
          showsTraffic={mapPreferences.details.traffic}
          showsUserLocation={showsUserLocation}
          style={styles.mapCanvas}
          toolbarEnabled={false}
          zoomEnabled>
          {/* One stable green tracking route: a SINGLE memoized polyline with a
              fixed React key. react-native-maps keeps the same native overlay and
              only updates its coordinates as accepted GPS history grows — the line
              is never remounted and there are no overlapping/duplicate route
              layers, so it cannot flicker on vehicle switch, zoom, pan, or live
              updates. No per-frame progress lines, gradients, or traffic colours. */}
          {activeTab === 'history' ? (
            <>
              <StableBaseRoute
                auraColor="rgba(43,230,255,0.22)"
                coordinates={renderRoute}
                lineColor="rgba(151,171,190,0.72)"
                lineWidth={6}
              />
              <StableRouteLine color={BRAND.green} coordinates={completedRoute} />
              {playbackData?.events.map((event, index) => (
                <Marker
                  key={`hist-event-${event.t}-${event.eventType}-${index}`}
                  anchor={{ x: 0.5, y: 0.5 }}
                  coordinate={{ latitude: event.lat, longitude: event.lng }}
                  tracksViewChanges={false}
                  zIndex={20}>
                  <View style={styles.eventMarker}>
                    <MaterialCommunityIcons color="#071018" name="alert" size={12} />
                  </View>
                </Marker>
              ))}
              {playbackData?.stops.map((stop, index) => (
                <Marker
                  key={`hist-stop-${stop.from}-${stop.to}-${index}`}
                  anchor={{ x: 0.5, y: 0.5 }}
                  coordinate={{ latitude: stop.lat, longitude: stop.lng }}
                  tracksViewChanges={false}
                  zIndex={21}>
                  <View style={styles.stopMarker}>
                    <MaterialCommunityIcons color="#071018" name="parking" size={12} />
                  </View>
                </Marker>
              ))}
            </>
          ) : isTrafficVisible ? (
            <StableRouteLine
              key="live-track-route"
              color={ROUTE_GREEN}
              coordinates={renderRoute}
              width={6}
            />
          ) : null}
          {sample && (modelLoadState !== 'ready' || !vehicleScreenPoint) ? (
            <LiveVehicleMapMarker
              cameraHeading={mapCameraHeading}
              category={markerCategory}
              coordinate={vehicleCoordinate}
              heading={heading}
              showStatusCircle={
                liveEnabled &&
                (!live.connected || isLiveStale || isLowAccuracy || hasInvalidLiveFix)
              }
              state={liveState ?? status}
              statusColor={statusColor}
            />
          ) : null}
        </MapView>
      ) : (
        <FleetWebMap
          ref={webMapRef}
          cameraMode={cameraMode}
          followSelected={isFollowing}
          mapStyle={mapStyleInfo.webStyle}
          markers={fallbackMarkers}
          onInteraction={handleManualMapInteraction}
          onProjectionChange={handleWebProjection}
          polyline={fallbackPolyline}
          selectedId="vehicle"
          style={styles.mapCanvas}
        />
      )}

      <View pointerEvents="none" style={styles.mapShade} />

      {vehicleScreenPoint ? (
        <Fleet3DOverlay
          height={mapSize.height}
          markers={projectedVehicleMarkers}
          onModelError={(id, variant, message) => {
            if (id !== 'vehicle' || variant !== carVariant) return;
            setModelLoadState('error');
            setModelLoadError(message);
          }}
          onModelLoaded={(id, variant) => {
            if (id !== 'vehicle' || variant !== carVariant) return;
            setModelLoadState('ready');
            setModelLoadError(null);
          }}
          onModelLoadStart={(id, variant) => {
            if (id !== 'vehicle' || variant !== carVariant) return;
            setModelLoadState('loading');
            setModelLoadError(null);
          }}
          onUnavailable={(message) => {
            setModelLoadState('error');
            setModelLoadError(message);
          }}
          width={mapSize.width}
        />
      ) : null}

      {vehicleScreenPoint && tooltipVisible ? (
        <Animated.View
          style={[
            tooltipStyles.tooltip,
            {
              left: vehicleScreenPoint.x - TOOLTIP_W / 2,
              top: vehicleScreenPoint.y - TOOLTIP_MARKER_HALF - TOOLTIP_H - TOOLTIP_ARROW,
            },
            tooltipStyle,
          ]}
          pointerEvents="none"
        >
          <View style={tooltipStyles.row}>
            <Text style={tooltipStyles.statusText}>
              {status}
            </Text>
            <Text style={tooltipStyles.speedText}>
              {Math.max(0, Math.round(currentSpeed))} km/h
            </Text>
          </View>
          <Text style={tooltipStyles.timeText}>
            {liveAgeSec != null ? `Updated ${formatAge(liveAgeSec)}` : 'Updated recently'}
          </Text>
          <View style={tooltipStyles.arrow} />
        </Animated.View>
      ) : null}

      {vehicleScreenPoint ? (
        <Pressable
          style={{
            position: 'absolute',
            left: vehicleScreenPoint.x - 32,
            top: vehicleScreenPoint.y - 32,
            width: 64,
            height: 64,
            zIndex: 99,
          }}
          onPress={() => setTooltipVisible(true)}
          onLongPress={() => setTooltipVisible(true)}
        />
      ) : null}

      {useNativeMap && mapLoadState === 'error' ? (
        <RouteMapStateOverlay
          message={mapErrorMessage}
          onRetry={retryMapLoad}
          state="error"
        />
      ) : isMapLoading ? (
        <RouteMapStateOverlay message="Loading native road map" state="loading" />
      ) : null}

      {isFullScreen ? null : (
        <View
          onLayout={(event) => measureOverlay('header', event)}
          style={[styles.headerCard, { top: headerTop }]}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/map'))}
            style={styles.headerIconButton}>
            <MaterialCommunityIcons color={BRAND.green} name="arrow-left" size={30} />
          </Pressable>
          <Pressable
            accessibilityHint="Switch to another vehicle"
            accessibilityLabel={`Tracking ${vehicleName}. Tap to change vehicle.`}
            accessibilityRole="button"
            onPress={openVehiclePicker}
            style={styles.headerTextBlock}>
            <View style={styles.headerTitleRow}>
              <Text numberOfLines={1} style={[styles.headerTitle, { flexShrink: 1 }]}>
                {vehicleName}
              </Text>
              {fleet.length > 1 ? (
                <MaterialCommunityIcons color={BRAND.greenGlow} name="chevron-down" size={18} />
              ) : null}
              <StatusPill state={status} />
            </View>
            <Text numberOfLines={1} style={styles.headerSubtitle}>
              {currentAddress}
            </Text>
          </Pressable>
        </View>
      )}

      {autoFollowSuspended && !isFullScreen ? (
        <View
          onLayout={(event) => measureOverlay('resume', event)}
          pointerEvents="box-none"
          style={[styles.resumeTrackingSlot, { bottom: resumeButtonBottom }]}>
          <FadeIn>
            <Pressable
              accessibilityLabel="Resume Cinematic Tracking"
              accessibilityRole="button"
              onPress={resumeCinematicTracking}
              style={styles.resumeTrackingButton}>
              <MaterialCommunityIcons color="#07121B" name="navigation-variant" size={16} />
              <Text style={styles.resumeTrackingText}>Resume tracking</Text>
            </Pressable>
          </FadeIn>
        </View>
      ) : null}



      {/* Native-map camera modes stay selected until the user changes mode.
          One horizontally scrollable row keeps this to a single line on every
          screen width instead of wrapping into a block that eats the map. */}


      <MapControlRail
        bottom={controlRailBottom}
        controls={leftMapControls}
        expanded={controlsExpanded}
        onToggleExpanded={toggleControls}
        side="left"
        top={controlRailTop}
      />
      <MapControlRail
        bottom={controlRailBottom}
        controls={rightMapControls}
        expanded={controlsExpanded}
        onToggleExpanded={toggleControls}
        side="right"
        top={controlRailTop}
      />

      {isFullScreen ? null : (
        <LiveDetailsSheet
          address={currentAddress}
          alertActive={isAlertActive}
          carVariant={carVariant}
          coveredText={`${coveredKmText} km`}
          expanded={sheetExpanded}
          following={isFollowing}
          gpsText={gpsText}
          ignitionText={ignitionText}
          modelLoadError={modelLoadError}
          modelLoading={modelLoadState === 'loading'}
          nightMode={isNightMode}
          onClosePanel={closeOptionPanel}
          onExpand={expandSheet}
          onFollowLive={jumpToLive}
          onLayout={handleSheetLayout}
          onRouteTool={handleRouteTool}
          onSelectModel={selectVehicleModel}
          onToggle={toggleSheet}
          onToggleTools={toggleTools}
          panHandlers={sheetPanResponder.panHandlers}
          pingTime={pingTime}
          routeVisible={isTrafficVisible}
          satelliteMode={isSatelliteMode}
          selectedOptionData={selectedOptionData}
          selectedOptionId={selectedOptionId}
          speed={currentSpeed}
          status={status}
          toolsExpanded={toolsExpanded}
          totalText={`${totalKmText} km`}
          translateY={sheetTranslateY}
          vehicleName={vehicleName}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          activeFromDate={activeFromDate}
          setActiveFromDate={setActiveFromDate}
          activeToDate={activeToDate}
          setActiveToDate={setActiveToDate}
          historyPlaying={historyPlaying}
          setHistoryPlaying={setHistoryPlaying}
          historySpeed={historySpeed}
          setHistorySpeed={setHistorySpeed}
          playbackData={playbackData}
          isPlaybackFetching={isPlaybackFetching}
          elapsedMs={elapsedMs}
          totalDurationMs={track.totalDurationMs}
          seekHistory={seekHistory}
          onSelectVehicle={() => setVehiclePickerOpen(true)}
          cameraMode={cameraMode}
          onSelectCameraMode={selectCameraMode}
        />
      )}

      <VehiclePickerSheet
        devices={fleet}
        onClose={closeVehiclePicker}
        onSelect={selectVehicle}
        selectedId={deviceId ?? null}
        visible={vehiclePickerOpen}
      />

      {toastText ? (
        <View
          pointerEvents="none"
          style={[
            styles.toast,
            {
              top: Math.min(
                topOverlayBottom + 8,
                Math.max(headerTop, mapSize.height - 72)
              ),
            },
          ]}>
          <Text numberOfLines={1} style={styles.toastText}>
            {toastText}
          </Text>
        </View>
      ) : null}

    </SafeAreaView>
  );
}

/**
 * Fades and lifts its child in on mount.
 *
 * Used for the floating pills so they appear the way a Maps-style control does
 * rather than popping into place. Native-driven, so it costs nothing per frame.
 */
function FadeIn({ children }: { children: React.ReactNode }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.spring(progress, {
      damping: 18,
      mass: 0.7,
      stiffness: 220,
      toValue: 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress]);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
        ],
      }}>
      {children}
    </Animated.View>
  );
}

/**
 * Vehicle switcher.
 *
 * Opened from the header title. Choosing a vehicle re-points the whole screen
 * (live stream, detail query, route, camera) at that device — this is the
 * vehicle filter, and is deliberately separate from the 3D model picker, which
 * only changes how the selected vehicle is drawn.
 */
const VehiclePickerSheet = memo(function VehiclePickerSheet({
  devices,
  onClose,
  onSelect,
  selectedId,
  visible,
}: {
  devices: DeviceSummary[];
  onClose: () => void;
  onSelect: (device: DeviceSummary) => void;
  selectedId: number | null;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable
        accessibilityLabel="Close vehicle list"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.pickerBackdrop}
      />
      <View style={[styles.pickerSheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.pickerHandle} />
        <Text style={styles.pickerTitle}>Select vehicle</Text>
        <Text style={styles.pickerSubtitle}>
          {devices.length} vehicle{devices.length === 1 ? '' : 's'} in this fleet
        </Text>
        <ScrollView
          contentContainerStyle={styles.pickerList}
          showsVerticalScrollIndicator={false}
          style={styles.pickerScroll}>
          {devices.map((device) => {
            const active = device.id === selectedId;
            const state = (device.state ?? '').toUpperCase();
            return (
              <Pressable
                accessibilityLabel={`Track ${device.name}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={device.id}
                onPress={() => onSelect(device)}
                style={({ pressed }) => [
                  styles.pickerRow,
                  active && styles.pickerRowActive,
                  pressed && styles.pressedControl,
                ]}>
                <View
                  style={[
                    styles.pickerDot,
                    {
                      backgroundColor:
                        state === 'RUNNING'
                          ? BRAND.greenGlow
                          : state === 'IDLE'
                            ? '#F5A623'
                            : state === 'STOPPED'
                              ? BRAND.red
                              : BRAND.muted,
                    },
                  ]}
                />
                <View style={styles.pickerRowText}>
                  <Text numberOfLines={1} style={styles.pickerRowName}>
                    {device.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.pickerRowMeta}>
                    {device.address ?? 'Address unavailable'}
                  </Text>
                </View>
                <Text style={styles.pickerRowSpeed}>
                  {Math.max(0, Math.round(device.speed ?? 0))} km/h
                </Text>
                {active ? (
                  <MaterialCommunityIcons color={BRAND.greenGlow} name="check-circle" size={20} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
});

type MapControl = {
  active?: boolean;
  danger?: boolean;
  /** Rotates the icon — used to point the compass needle at true north. */
  rotation?: number;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
};

type MapControlRailProps = {
  bottom: number;
  controls: MapControl[];
  expanded: boolean;
  onToggleExpanded: () => void;
  side?: 'left' | 'right';
  top: number;
};

/**
 * Vertical map-control rail.
 *
 * Pinned to the left or right edge and bounded by the tracking overlays above
 * and the details sheet below, so it never sits on top of them. It scrolls
 * internally and collapses to a single button, which keeps every control reachable.
 */
const MapControlRail = memo(function MapControlRail({
  bottom,
  controls,
  expanded,
  onToggleExpanded,
  side = 'right',
  top,
}: MapControlRailProps) {
  const isLeft = side === 'left';
  const insets = useSafeAreaInsets();
  const sideStyle = isLeft
    ? { left: OVERLAY_GAP + 4 + insets.left, alignItems: 'flex-start' as const }
    : { right: OVERLAY_GAP + 4 + insets.right, alignItems: 'flex-end' as const };
  const toggleIcon = expanded
    ? isLeft
      ? 'chevron-left'
      : 'chevron-right'
    : 'tune-vertical';

  const lastPressRef = useRef<number>(0);
  const handlePress = useCallback((onPress: () => void) => {
    const now = Date.now();
    if (now - lastPressRef.current < 250) return;
    lastPressRef.current = now;
    onPress();
  }, []);

  return (
    <View pointerEvents="box-none" style={[styles.controlRail, sideStyle, { bottom, top }]}>
      <Pressable
        accessibilityLabel={expanded ? 'Hide map controls' : 'Show map controls'}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => handlePress(onToggleExpanded)}
        style={({ pressed }) => [
          styles.controlButton,
          styles.controlToggle,
          pressed && styles.pressedControl,
        ]}>
        <MaterialCommunityIcons
          color={BRAND.greenGlow}
          name={toggleIcon}
          size={20}
        />
      </Pressable>
      {expanded ? (
        <FadeIn>
          {/* One evenly spaced column of identically sized buttons. The rail is
              bounded above by the tracking overlays and below by the sheet, and
              scrolls internally, so it stays fully reachable on short screens
              and never overlaps another layer. */}
          <ScrollView
            contentContainerStyle={styles.controlStack}
            showsVerticalScrollIndicator={false}
            style={styles.controlScroll}>
            {controls.map((control) => (
              <Pressable
                accessibilityLabel={control.label}
                accessibilityRole="button"
                accessibilityState={{ selected: Boolean(control.active) }}
                key={control.label}
                onPress={() => handlePress(control.onPress)}
                style={({ pressed }) => [
                  styles.controlButton,
                  control.active && styles.controlButtonActive,
                  control.danger && styles.controlButtonDanger,
                  pressed && styles.pressedControl,
                ]}>
                <MaterialCommunityIcons
                  color={control.danger ? BRAND.orange : control.active ? '#07121B' : '#DCE9F4'}
                  name={control.icon}
                  size={20}
                  style={
                    control.rotation
                      ? { transform: [{ rotate: `${control.rotation}deg` }] }
                      : undefined
                  }
                />
              </Pressable>
            ))}
          </ScrollView>
        </FadeIn>
      ) : null}
    </View>
  );
});

type LiveDetailsSheetProps = {
  address: string;
  alertActive: boolean;
  carVariant: CarVariant;
  coveredText: string;
  expanded: boolean;
  following: boolean;
  gpsText: string;
  ignitionText: string;
  modelLoadError: string | null;
  modelLoading: boolean;
  nightMode: boolean;
  onClosePanel: () => void;
  onExpand: () => void;
  onFollowLive: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onRouteTool: (id: RouteMapOptionId) => void;
  onSelectModel: (variant: CarVariant) => void;
  onToggle: () => void;
  onToggleTools: () => void;
  panHandlers: PanResponderInstance['panHandlers'];
  pingTime: { dateText: string; timeText: string };
  routeVisible: boolean;
  satelliteMode: boolean;
  selectedOptionData: RouteOptionData | null;
  selectedOptionId: RouteMapOptionId | null;
  speed: number;
  status: string;
  toolsExpanded: boolean;
  totalText: string;
  translateY: Animated.Value;
  vehicleName: string;
  activeTab: 'live' | 'history' | 'cinematic';
  setActiveTab: (tab: 'live' | 'history' | 'cinematic') => void;
  activeFromDate: string;
  setActiveFromDate: (date: string) => void;
  activeToDate: string;
  setActiveToDate: (date: string) => void;
  historyPlaying: boolean;
  setHistoryPlaying: (playing: boolean) => void;
  historySpeed: 0.5 | 1 | 2 | 4 | 8;
  setHistorySpeed: (speed: 0.5 | 1 | 2 | 4 | 8) => void;
  playbackData: PlaybackResponse | null | undefined;
  isPlaybackFetching: boolean;
  elapsedMs: number;
  totalDurationMs: number;
  seekHistory: (frac: number) => void;
  onSelectVehicle: () => void;
  cameraMode: CameraMode;
  onSelectCameraMode: (mode: CameraMode) => void;
};

/**
 * The vehicle details sheet.
 *
 * Memoised, and deliberately given only display-ready values: the screen around
 * it re-renders as the live position is interpolated, and re-rendering this
 * subtree on every one of those ticks detached and re-attached the sheet's
 * native-driven `translateY`, which is what made it flicker. Nothing passed in
 * may change per animation frame — quantise it in the parent first.
 */
const LiveDetailsSheet = memo(function LiveDetailsSheet({
  address,
  alertActive,
  carVariant,
  coveredText,
  expanded,
  following,
  gpsText,
  ignitionText,
  modelLoadError,
  modelLoading,
  nightMode,
  onClosePanel,
  onExpand,
  onFollowLive,
  onLayout,
  onRouteTool,
  onSelectModel,
  onToggle,
  onToggleTools,
  panHandlers,
  pingTime,
  routeVisible,
  satelliteMode,
  selectedOptionData,
  selectedOptionId,
  speed,
  status,
  toolsExpanded,
  totalText,
  translateY,
  vehicleName,
  activeTab,
  setActiveTab,
  activeFromDate,
  setActiveFromDate,
  activeToDate,
  setActiveToDate,
  historyPlaying,
  setHistoryPlaying,
  historySpeed,
  setHistorySpeed,
  playbackData,
  isPlaybackFetching,
  elapsedMs,
  totalDurationMs,
  seekHistory,
  onSelectVehicle,
  cameraMode,
  onSelectCameraMode,
}: LiveDetailsSheetProps) {
  const sheetStyle = useMemo(
    () => [styles.bottomSheetWrapper, { transform: [{ translateY }] }],
    [translateY]
  );
  const progressBarWidthRef = useRef<number>(0);

  const formatTime = (isoString?: string) => {
    if (!isoString) return '--:--';
    return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <Animated.View onLayout={onLayout} {...panHandlers} style={sheetStyle}>
      <Pressable
        accessibilityLabel={expanded ? 'Collapse details' : 'Expand details'}
        accessibilityRole="button"
        hitSlop={20}
        onPress={onToggle}
        style={styles.sheetHandleHit}>
        <MaterialCommunityIcons 
          name={expanded ? "chevron-down" : "chevron-up"} 
          size={36} 
          color="rgba(255,255,255,1)" 
          style={{
            textShadowColor: 'rgba(0,0,0,0.8)',
            textShadowOffset: { width: 0, height: 2 },
            textShadowRadius: 5,
          }}
        />
      </Pressable>

      <Animated.View
        pointerEvents={expanded ? 'auto' : 'none'}
        style={[styles.bottomSheetContent, {
          opacity: expanded ? 1 : 0,
          flex: 1,
        }]}
      >
        <View style={styles.tabBar}>
          <Pressable
            onPress={() => setActiveTab('live')}
            style={[styles.tabButton, activeTab === 'live' && styles.tabButtonActive]}>
            <Text style={[styles.tabButtonText, activeTab === 'live' && styles.tabButtonTextActive]}>
              Live Info
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('cinematic')}
            style={[styles.tabButton, activeTab === 'cinematic' && styles.tabButtonActive]}>
            <Text style={[styles.tabButtonText, activeTab === 'cinematic' && styles.tabButtonTextActive]}>
              Cinematic View
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('history')}
            style={[styles.tabButton, activeTab === 'history' && styles.tabButtonActive]}>
            <Text style={[styles.tabButtonText, activeTab === 'history' && styles.tabButtonTextActive]}>
              History
            </Text>
          </Pressable>
        </View>

        {activeTab === 'live' ? (
          <View style={{ flex: 1 }}>
            <View style={styles.sheetStats}>
              <Metric
                icon="clock-outline"
                label="Ping Time"
                subValue={pingTime.timeText}
                value={pingTime.dateText}
              />
              <Metric icon="map-marker-distance" label="Covered" value={coveredText} />
              <Metric icon="flag-checkered" label="Trip" value={totalText} />
            </View>
            <View style={[styles.sheetStats, styles.sheetStatsSecondary]}>
              <Metric icon="engine-outline" label="Ignition" value={ignitionText} />
              <Metric icon="access-point" label="GPS" value={gpsText} />
              <Metric icon="car-info" label="Status" value={status} />
            </View>
          </View>
        ) : activeTab === 'cinematic' ? (
          <View style={styles.cinematicSection}>
            <View style={[styles.sheetModelPicker, { marginTop: 0, marginBottom: 12 }]}>
              <VehicleModelPicker
                compact
                errorMessage={modelLoadError}
                loading={modelLoading}
                onChange={onSelectModel}
                value={carVariant}
              />
            </View>
            <Text style={styles.cinematicTitleText}>CAMERA MODES</Text>
            <View style={styles.cameraGrid}>
              {CINEMATIC_CAMERAS.map((item) => {
                const active = cameraMode === item.id;
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => onSelectCameraMode(item.id)}
                    style={[styles.cameraCard, active && styles.cameraCardActive]}>
                    <MaterialCommunityIcons
                      color={active ? '#07121B' : BRAND.greenGlow}
                      name={item.icon}
                      size={22}
                    />
                    <Text style={[styles.cameraCardLabel, active && styles.cameraCardLabelActive]}>
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : (
          <ScrollView style={styles.historyScroll} contentContainerStyle={{ paddingBottom: 16 }}>
            <View style={styles.historyDateSelector}>
              <Pressable
                onPress={() => {
                  const prev = shiftDate(activeFromDate, -1);
                  setActiveFromDate(prev);
                  setActiveToDate(prev);
                }}
                style={styles.dateNavBtn}>
                <MaterialCommunityIcons name="chevron-left" size={20} color="#fff" />
              </Pressable>
              <Text style={styles.dateNavLabel}>{labelDate(activeFromDate)}</Text>
              <Pressable
                onPress={() => {
                  const todayStrVal = todayStr();
                  if (activeFromDate >= todayStrVal) return;
                  const next = shiftDate(activeFromDate, 1);
                  setActiveFromDate(next);
                  setActiveToDate(next);
                }}
                style={styles.dateNavBtn}>
                <MaterialCommunityIcons name="chevron-right" size={20} color="#fff" />
              </Pressable>
            </View>

            <View style={styles.presetsRow}>
              <Pressable
                onPress={() => {
                  const t = todayStr();
                  setActiveFromDate(t);
                  setActiveToDate(t);
                }}
                style={[styles.presetChip, activeFromDate === todayStr() && styles.presetChipActive]}>
                <Text style={[styles.presetChipText, activeFromDate === todayStr() && styles.presetChipTextActive]}>Today</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const y = shiftDate(todayStr(), -1);
                  setActiveFromDate(y);
                  setActiveToDate(y);
                }}
                style={[styles.presetChip, activeFromDate === shiftDate(todayStr(), -1) && styles.presetChipActive]}>
                <Text style={[styles.presetChipText, activeFromDate === shiftDate(todayStr(), -1) && styles.presetChipTextActive]}>Yesterday</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setActiveFromDate(shiftDate(todayStr(), -6));
                  setActiveToDate(todayStr());
                }}
                style={[styles.presetChip, activeFromDate === shiftDate(todayStr(), -6) && styles.presetChipActive]}>
                <Text style={[styles.presetChipText, activeFromDate === shiftDate(todayStr(), -6) && styles.presetChipTextActive]}>7 Days</Text>
              </Pressable>
            </View>

            {isPlaybackFetching ? (
              <ActivityIndicator color={BRAND.green} size="small" style={{ marginVertical: 20 }} />
            ) : playbackData && playbackData.points.length >= 2 ? (
              <>
                <View style={styles.playbackControlsRow}>
                  <Pressable
                    onPress={() => setHistoryPlaying(!historyPlaying)}
                    style={[styles.playBtn, { backgroundColor: BRAND.green }]}>
                    <MaterialCommunityIcons name={historyPlaying ? 'pause' : 'play'} size={24} color="#fff" />
                  </Pressable>
                  <View style={styles.speedsRow}>
                    {([0.5, 1, 2, 4, 8] as const).map((sp) => (
                      <Pressable
                        key={sp}
                        onPress={() => setHistorySpeed(sp)}
                        style={[styles.speedChip, historySpeed === sp && styles.speedChipActive]}>
                        <Text style={[styles.speedChipText, historySpeed === sp && styles.speedChipTextActive]}>{sp}x</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.scrubberRow}>
                  <Pressable
                    onLayout={(e) => {
                      progressBarWidthRef.current = e.nativeEvent.layout.width;
                    }}
                    onPress={(e) => {
                      if (progressBarWidthRef.current) {
                        seekHistory(e.nativeEvent.locationX / progressBarWidthRef.current);
                      }
                    }}
                    style={styles.scrubberTrack}>
                    <View style={[styles.scrubberProgress, { width: `${(elapsedMs / (totalDurationMs || 1)) * 100}%`, backgroundColor: BRAND.green }]} />
                  </Pressable>
                  <Text style={styles.scrubberTimeText}>
                    {Math.round((elapsedMs / (totalDurationMs || 1)) * 100)}%
                  </Text>
                </View>

                <View style={styles.historyStatsGrid}>
                  <View style={styles.historyStatCell}>
                    <Text style={styles.histStatVal}>{playbackData.distanceKm.toFixed(1)} km</Text>
                    <Text style={styles.histStatLbl}>Distance</Text>
                  </View>
                  <View style={styles.historyStatCell}>
                    <Text style={styles.histStatVal}>{formatTime(playbackData.points[0]?.t)}</Text>
                    <Text style={styles.histStatLbl}>Start Time</Text>
                  </View>
                  <View style={styles.historyStatCell}>
                    <Text style={styles.histStatVal}>{formatTime(playbackData.points[playbackData.points.length - 1]?.t)}</Text>
                    <Text style={styles.histStatLbl}>End Time</Text>
                  </View>
                </View>

                {playbackData.stops.length > 0 && (
                  <View style={styles.timelineSection}>
                    <Text style={styles.sectionHeadingText}>Stops</Text>
                    {playbackData.stops.map((stop: PlaybackStopMarker, idx: number) => (
                      <View key={`stop-${idx}`} style={styles.timelineItem}>
                        <MaterialCommunityIcons name="parking" size={16} color={BRAND.orange} />
                        <View style={styles.timelineItemContent}>
                          <Text style={styles.timelineTitleText}>Stopped for {Math.round(stop.minutes)} mins</Text>
                          <Text style={styles.timelineSubtitleText}>{formatTime(stop.from)} - {formatTime(stop.to)}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {playbackData.events.length > 0 && (
                  <View style={styles.timelineSection}>
                    <Text style={styles.sectionHeadingText}>Alert Logs</Text>
                    {playbackData.events.map((evt: PlaybackEventMarker, idx: number) => (
                      <View key={`event-${idx}`} style={styles.timelineItem}>
                        <MaterialCommunityIcons name="alert" size={16} color="#EAB308" />
                        <View style={styles.timelineItemContent}>
                          <Text style={styles.timelineTitleText}>{evt.eventType}</Text>
                          <Text style={styles.timelineSubtitleText}>{formatTime(evt.t)}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <View style={styles.noHistoryBox}>
                <Text style={styles.noHistoryText}>No recorded trip history for this date.</Text>
              </View>
            )}
          </ScrollView>
        )}
      </Animated.View>

      {!expanded ? (
        <Pressable
          accessibilityLabel="Expand vehicle details"
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          onPress={onExpand}
          style={styles.collapsedSheetTapTarget}
        />
      ) : null}
    </Animated.View>
  );
});

function MapToolsPanel({
  activeId,
  alertActive,
  following,
  historyVisible,
  nightMode,
  onSelect,
  routeVisible,
  satelliteMode,
}: {
  activeId: RouteMapOptionId | null;
  alertActive: boolean;
  following: boolean;
  historyVisible: boolean;
  nightMode: boolean;
  onSelect: (id: RouteMapOptionId) => void;
  routeVisible: boolean;
  satelliteMode: boolean;
}) {
  const activeFor = (id: RouteMapOptionId) => {
    if (id === 'follow') return following;
    if (id === 'alert') return alertActive;
    if (id === 'history') return historyVisible;
    if (id === 'night') return nightMode;
    if (id === 'traffic') return routeVisible;
    if (id === 'mapType') return satelliteMode;
    return activeId === id;
  };
  return (
    <View style={styles.mapToolsGrid}>
      {ROUTE_TOOLS.map((tool) => {
        const active = activeFor(tool.id);
        const danger = tool.id === 'alert' && alertActive;
        return (
          <Pressable
            accessibilityLabel={tool.label}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={tool.id}
            onPress={() => onSelect(tool.id)}
            style={[
              styles.mapTool,
              active && styles.mapToolActive,
              danger && styles.mapToolDanger,
            ]}>
            <MaterialCommunityIcons
              color={danger ? '#FF7A7D' : active ? '#2BE69E' : '#AFC1D0'}
              name={tool.icon}
              size={20}
            />
            <Text
              numberOfLines={1}
              style={[
                styles.mapToolText,
                active && styles.mapToolTextActive,
                danger && styles.mapToolTextDanger,
              ]}>
              {tool.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function RouteOptionDataPanel({
  data,
  onClose,
}: {
  data: RouteOptionData;
  onClose: () => void;
}) {
  return (
    <View style={[styles.optionPanel, data.tone === 'red' && styles.optionPanelRed]}>
      <View style={styles.optionHeader}>
        <View style={[styles.optionIconWrap, data.tone === 'red' && styles.optionIconWrapRed]}>
          <MaterialCommunityIcons color="#fff" name={data.icon} size={20} />
        </View>
        <View style={styles.optionTextBlock}>
          <Text numberOfLines={1} style={styles.optionTitle}>
            {data.title}
          </Text>
          <Text numberOfLines={2} style={styles.optionSummary}>
            {data.summary}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.optionCloseButton}>
          <MaterialCommunityIcons color={BRAND.muted} name="close" size={18} />
        </Pressable>
      </View>
      <View style={styles.optionMetrics}>
        {data.metrics.map((metric) => (
          <View key={metric.label} style={styles.optionMetric}>
            <Text numberOfLines={1} style={styles.optionMetricValue}>
              {metric.value}
            </Text>
            <Text numberOfLines={1} style={styles.optionMetricLabel}>
              {metric.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function RouteMapStateOverlay({
  message,
  onRetry,
  state,
}: {
  message: string;
  onRetry?: () => void;
  state: MapLoadState;
}) {
  const isLoading = state === 'loading';

  return (
    <View pointerEvents={isLoading ? 'none' : 'box-none'} style={styles.mapStateOverlay}>
      <View style={styles.mapStatePanel}>
        {isLoading ? (
          <ActivityIndicator color={BRAND.green} size="large" />
        ) : (
          <MaterialCommunityIcons color={BRAND.red} name="map-marker-alert-outline" size={36} />
        )}
        <Text style={styles.mapStateTitle}>{isLoading ? 'Map Loading' : 'Map Unavailable'}</Text>
        <Text style={styles.mapStateMessage}>{message}</Text>
        {!isLoading && onRetry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} style={styles.mapRetryButton}>
            <MaterialCommunityIcons color="#fff" name="refresh" size={18} />
            <Text style={styles.mapRetryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const SmoothSpeed = memo(function SmoothSpeed({ value }: { value: number }) {
  const currentRef = useRef(value);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const from = currentRef.current;
    const startedAt = Date.now();
    let frame = 0;
    const tick = () => {
      const fraction = Math.min(1, (Date.now() - startedAt) / 360);
      const eased = 1 - (1 - fraction) ** 3;
      const next = from + (value - from) * eased;
      currentRef.current = next;
      setDisplay(Math.round(next));
      if (fraction < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <Text style={styles.speedValue}>{display}</Text>;
});

function Metric({
  icon,
  label,
  value,
  subValue,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <View style={styles.metric}>
      <MaterialCommunityIcons color={BRAND.green} name={icon} size={18} style={styles.metricIcon} />
      <View style={styles.metricTextBlock}>
        <Text numberOfLines={1} style={styles.metricValue}>
          {value}
        </Text>
        {subValue ? (
          <Text numberOfLines={1} style={styles.metricValue}>
            {subValue}
          </Text>
        ) : null}
        <Text numberOfLines={1} style={styles.metricLabel}>
          {label}
        </Text>
      </View>
    </View>
  );
}

function formatPingTime(date: Date): { dateText: string; timeText: string } {
  const day = date.getDate().toString().padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear().toString().slice(-2);
  const dateText = `${day} ${month} ${year}`;
  const timeText = date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return { dateText, timeText };
}

function formatCoordinate(coordinate: Coordinate) {
  return `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: BRAND.mapMint,
    flex: 1,
  },
  playbackStateBox: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  playbackStateText: {
    color: BRAND.ink,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  mapCanvas: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BRAND.mapMint,
    minHeight: 1,
    minWidth: 1,
  },
  mapShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
  },
  mapStateOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  mapStatePanel: {
    alignItems: 'center',
    backgroundColor: 'rgba(7, 15, 27, 0.96)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 20,
    borderWidth: 1,
    maxWidth: 310,
    paddingHorizontal: 20,
    paddingVertical: 18,
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    width: '100%',
  },
  mapStateTitle: {
    color: '#F3F8FD',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0,
    marginTop: 10,
    textAlign: 'center',
  },
  mapStateMessage: {
    color: '#91A6B9',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0,
    lineHeight: 17,
    marginTop: 5,
    textAlign: 'center',
  },
  mapRetryButton: {
    alignItems: 'center',
    backgroundColor: BRAND.green,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 7,
    height: 40,
    justifyContent: 'center',
    marginTop: 14,
    paddingHorizontal: 16,
  },
  mapRetryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0,
  },
  headerCard: {
    alignItems: 'center',
    backgroundColor: 'rgba(7, 15, 27, 0.94)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 20,
    borderWidth: 1,
    elevation: 8,
    flexDirection: 'row',
    gap: 8,
    left: OVERLAY_GAP + 4,
    minHeight: 64,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: 'absolute',
    right: OVERLAY_GAP + 4,
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 20,
  },
  headerIconButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 36,
  },
  headerTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  headerStatusColumn: {
    alignItems: 'flex-end',
    gap: 4,
  },
  liveInlineBadge: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  liveInlineText: {
    color: '#9DB2C6',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  pressedControl: {
    opacity: 0.75,
    transform: [{ scale: 0.96 }],
  },
  headerCinemaActive: {
    backgroundColor: BRAND.greenGlow,
    borderRadius: 13,
  },
  headerTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    color: '#F3F8FD',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
  },
  headerSubtitle: {
    color: '#8FA5B9',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0,
    marginTop: 4,
  },
  statusPill: {
    alignItems: 'center',
    borderRadius: 10,
    justifyContent: 'center',
    minWidth: 66,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  statusPillActive: {
    backgroundColor: BRAND.green,
  },
  statusPillStopped: {
    backgroundColor: BRAND.red,
  },
  statusPillText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  liveDot: {
    borderRadius: 3.5,
    height: 7,
    width: 7,
  },
  // The pill floats just above the details sheet, so it can never sit over the
  // vehicle, the route, or the road ahead of it.
  resumeTrackingSlot: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  resumeTrackingButton: {
    alignItems: 'center',
    backgroundColor: BRAND.greenGlow,
    borderRadius: 999,
    elevation: 6,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
  resumeTrackingText: {
    color: '#07121B',
    fontSize: 12,
    fontWeight: '900',
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(3, 8, 16, 0.62)',
  },
  pickerSheet: {
    backgroundColor: 'rgba(9, 17, 29, 0.99)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    position: 'absolute',
    right: 0,
  },
  pickerHandle: {
    alignSelf: 'center',
    backgroundColor: 'rgba(190, 210, 228, 0.34)',
    borderRadius: 2,
    height: 4,
    marginBottom: 12,
    width: 44,
  },
  pickerTitle: { color: '#F3F8FD', fontSize: 17, fontWeight: '900' },
  pickerSubtitle: { color: '#8FA5B9', fontSize: 11, fontWeight: '700', marginTop: 2 },
  pickerScroll: { marginTop: 12, maxHeight: 360 },
  pickerList: { gap: 8, paddingBottom: 4 },
  pickerRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: 'rgba(255,255,255,0.09)',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  pickerRowActive: {
    backgroundColor: 'rgba(43, 230, 158, 0.12)',
    borderColor: 'rgba(43, 230, 158, 0.55)',
  },
  pickerDot: { borderRadius: 5, height: 10, width: 10 },
  pickerRowText: { flex: 1, minWidth: 0 },
  pickerRowName: { color: '#EDF5FB', fontSize: 14, fontWeight: '800' },
  pickerRowMeta: { color: '#8298AC', fontSize: 11, marginTop: 2 },
  pickerRowSpeed: { color: '#B9C9D7', fontSize: 11, fontWeight: '800' },
  hiddenControls: {
    opacity: 0,
  },
  controlRail: {
    gap: OVERLAY_GAP,
    position: 'absolute',
    zIndex: 25,
  },
  controlScroll: { flexGrow: 0 },
  controlStack: { gap: OVERLAY_GAP, paddingBottom: 2 },
  controlButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(9, 18, 31, 0.92)',
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 14,
    borderWidth: 1,
    elevation: 5,
    height: CONTROL_BUTTON_SIZE,
    justifyContent: 'center',
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.34,
    shadowRadius: 10,
    width: CONTROL_BUTTON_SIZE,
  },
  controlToggle: { backgroundColor: 'rgba(9, 18, 31, 0.96)' },
  controlButtonActive: {
    backgroundColor: BRAND.greenGlow,
    borderColor: BRAND.greenGlow,
  },
  controlButtonDanger: { borderColor: 'rgba(255,121,0,0.55)' },
  cinemaControlDeck: {
    backgroundColor: 'rgba(6, 13, 23, 0.88)',
    borderColor: 'rgba(83, 216, 255, 0.22)',
    borderRadius: 18,
    borderWidth: 1,
    gap: 9,
    left: OVERLAY_GAP + 4,
    padding: 10,
    position: 'absolute',
    right: OVERLAY_GAP + 4,
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: 9 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
  },
  cinemaControlHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cinemaLiveTitle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  cinemaLiveSignal: {
    backgroundColor: '#2BE6FF',
    borderRadius: 6,
    height: 10,
    shadowColor: '#2BE6FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
    width: 10,
  },
  cinemaLiveSignalLoading: {
    backgroundColor: '#FF9D5C',
    shadowColor: '#FF9D5C',
  },
  cinemaEyebrow: {
    color: '#65D9FF',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  cinemaTitle: {
    color: '#F3FAFF',
    fontSize: 11,
    fontWeight: '900',
    marginTop: 1,
  },
  cinemaCameraRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  cinemaCameraChoice: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    borderWidth: 1,
    flexBasis: '30%',
    flexGrow: 1,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 7,
  },
  cinemaCameraChoiceActive: {
    backgroundColor: '#2BE6FF',
    borderColor: '#2BE6FF',
  },
  cinemaCameraText: {
    color: '#B9D1E3',
    fontSize: 9,
    fontWeight: '800',
  },
  cinemaCameraTextActive: {
    color: '#07121B',
  },
  cameraModeBar: {
    left: 0,
    position: 'absolute',
    right: 0,
  },
  cameraModeContent: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: OVERLAY_GAP + 4,
  },
  cameraChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(7, 15, 27, 0.9)',
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    borderWidth: 1,
    elevation: 3,
    flexDirection: 'row',
    gap: 5,
    height: 34,
    paddingHorizontal: 11,
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.24,
    shadowRadius: 8,
  },
  cameraChipActive: {
    backgroundColor: BRAND.green,
    borderColor: BRAND.green,
  },
  cameraChipText: {
    color: '#DCE8F2',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0,
  },
  cameraChipTextActive: {
    color: '#fff',
  },
  liveVehicleMarker: {
    alignItems: 'center',
    height: LIVE_MARKER_SIZE,
    justifyContent: 'center',
    width: LIVE_MARKER_SIZE,
  },
  markerStatusCircle: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 28,
    borderWidth: 2,
    height: 56,
    left: 4,
    position: 'absolute',
    top: 4,
    width: 56,
  },
  markerShadow: {
    backgroundColor: 'rgba(3, 10, 18, 0.32)',
    borderRadius: 18,
    height: 12,
    position: 'absolute',
    top: 29,
    transform: [{ scaleX: 1.25 }],
    width: 34,
  },
  markerVehicleImage: {
    height: 58,
    width: 58,
  },
  bottomSheetWrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  bottomSheetContent: {
    backgroundColor: 'rgba(7, 15, 27, 0.97)',
    borderColor: 'rgba(255,255,255,0.13)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    shadowColor: '#020712',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.42,
    shadowRadius: 24,
    flex: 1,
  },
  sheetHandleHit: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    width: 60,
    alignSelf: 'center',
    backgroundColor: 'transparent',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
    elevation: 4,
  },
  sheetHandle: {
    display: 'none',
  },
  collapsedSheetTapTarget: {
    ...StyleSheet.absoluteFillObject,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    zIndex: 20,
  },
  sheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  deviceAvatar: {
    alignItems: 'center',
    backgroundColor: 'rgba(43, 230, 158, 0.1)',
    borderColor: 'rgba(43, 230, 158, 0.22)',
    borderRadius: 16,
    borderWidth: 1,
    height: 64,
    justifyContent: 'center',
    width: 70,
  },
  deviceInfo: {
    flex: 1,
    minWidth: 0,
  },
  deviceName: {
    color: '#F3F8FD',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
  },
  deviceAddress: {
    color: '#8FA5B9',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0,
    lineHeight: 18,
    marginTop: 4,
  },
  speedBlock: {
    alignItems: 'center',
    minWidth: 60,
  },
  speedValue: {
    color: BRAND.greenGlow,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 0,
  },
  speedLabel: {
    color: '#8FA5B9',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
  },
  progressTrack: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 4,
    height: 8,
    marginTop: 13,
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: BRAND.green,
    borderRadius: 4,
    height: '100%',
  },
  rateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  rateLabel: {
    color: '#8FA5B9',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
  },
  rateChips: {
    flexDirection: 'row',
    gap: 6,
  },
  rateChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 9,
    borderWidth: 1,
    justifyContent: 'center',
    minWidth: 38,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  rateChipActive: {
    backgroundColor: BRAND.green,
  },
  rateChipText: {
    color: '#C8D6E3',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
  },
  rateChipTextActive: {
    color: '#fff',
  },
  toolsToggle: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 11,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  toolsToggleActive: {
    backgroundColor: BRAND.greenGlow,
    borderColor: BRAND.greenGlow,
  },
  toolsToggleLabel: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  toolsToggleText: {
    color: '#E5EEF5',
    fontSize: 12,
    fontWeight: '900',
  },
  toolsToggleTextActive: {
    color: '#07121B',
  },
  toolsToggleHint: {
    color: '#8198AA',
    fontSize: 10,
    fontWeight: '800',
  },
  mapToolsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 10,
  },
  mapTool: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 11,
    borderWidth: 1,
    flexBasis: '22%',
    flexGrow: 1,
    gap: 4,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 5,
    paddingVertical: 7,
  },
  mapToolActive: {
    backgroundColor: 'rgba(43,230,158,0.1)',
    borderColor: 'rgba(43,230,158,0.5)',
  },
  mapToolDanger: {
    backgroundColor: 'rgba(251,47,50,0.09)',
    borderColor: 'rgba(251,47,50,0.42)',
  },
  mapToolText: {
    color: '#93A7B8',
    fontSize: 9,
    fontWeight: '800',
  },
  mapToolTextActive: {
    color: '#DDF9EE',
  },
  mapToolTextDanger: {
    color: '#FF9A9D',
  },
  optionPanel: {
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: 'rgba(43, 230, 158, 0.18)',
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 12,
    padding: 11,
  },
  optionPanelRed: {
    backgroundColor: 'rgba(251, 47, 50, 0.07)',
    borderColor: 'rgba(251, 47, 50, 0.24)',
  },
  optionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  optionIconWrap: {
    alignItems: 'center',
    backgroundColor: BRAND.green,
    borderRadius: 8,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  optionIconWrapRed: {
    backgroundColor: BRAND.red,
  },
  optionTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  optionTitle: {
    color: '#E9F4FC',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0,
  },
  optionSummary: {
    color: '#8FA5B9',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0,
    lineHeight: 15,
    marginTop: 2,
  },
  optionCloseButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 28,
  },
  optionMetrics: {
    borderColor: 'rgba(255,255,255,0.1)',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    paddingTop: 9,
  },
  optionMetric: {
    flex: 1,
    minWidth: 0,
  },
  optionMetricValue: {
    color: '#EDF5FB',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
  },
  optionMetricLabel: {
    color: '#7990A6',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  sheetStats: {
    borderColor: 'rgba(255,255,255,0.09)',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginTop: 13,
    paddingTop: 12,
  },
  sheetModelPicker: {
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 10,
    padding: 8,
  },
  sheetStatsSecondary: {
    borderTopWidth: 0,
    marginTop: 2,
    paddingTop: 2,
  },
  metric: {
    alignItems: 'flex-start',
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 43,
  },
  metricIcon: {
    marginTop: 2,
  },
  metricTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  metricValue: {
    color: '#EDF5FB',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
  },
  metricLabel: {
    color: '#7F96AA',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0,
    marginTop: 2,
  },
  sheetActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: BRAND.orange,
    borderRadius: 14,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    height: 48,
    justifyContent: 'center',
  },
  primaryActionStopped: {
    backgroundColor: BRAND.green,
  },
  primaryActionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0,
  },
  secondaryAction: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    width: 50,
  },
  toast: {
    alignSelf: 'center',
    backgroundColor: 'rgba(22, 32, 44, 0.9)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 9,
    position: 'absolute',
  },
  toastText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
  },
  historyBackdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: 'rgba(20, 32, 30, 0.62)',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  historyCard: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 26,
    paddingVertical: 28,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    width: '100%',
  },
  historyTitle: {
    color: BRAND.green,
    fontSize: 25,
    fontWeight: '900',
    letterSpacing: 0,
  },
  historyRule: {
    backgroundColor: BRAND.green,
    borderRadius: 1,
    height: 2,
    marginTop: 14,
    width: '52%',
  },
  historySubtitle: {
    color: '#141b23',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0,
    marginBottom: 20,
    marginTop: 20,
  },
  historyOption: {
    alignItems: 'center',
    borderColor: '#249cff',
    borderRadius: 8,
    borderWidth: 2,
    height: 50,
    justifyContent: 'center',
    marginTop: 12,
    width: '100%',
  },
  historyOptionText: {
    color: '#249cff',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0,
  },
  tabBar: {
    flexDirection: 'row',
    borderColor: 'rgba(255,255,255,0.08)',
    borderBottomWidth: 1,
    marginTop: 10,
    marginBottom: 8,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabButtonActive: {
    borderBottomColor: BRAND.green,
  },
  tabButtonText: {
    color: '#8FA5B9',
    fontSize: 13,
    fontWeight: '800',
  },
  tabButtonTextActive: {
    color: BRAND.greenGlow,
  },
  historyScroll: {
    flex: 1,
    marginTop: 6,
  },
  historyDateSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
    marginTop: 6,
  },
  dateNavBtn: {
    padding: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
  },
  dateNavLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  presetsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 10,
  },
  presetChip: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
  },
  presetChipActive: {
    backgroundColor: BRAND.green,
    borderColor: BRAND.green,
  },
  presetChipText: {
    color: '#8FA5B9',
    fontSize: 12,
    fontWeight: '800',
  },
  presetChipTextActive: {
    color: '#fff',
  },
  playbackControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 12,
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedsRow: {
    flexDirection: 'row',
    flex: 1,
    justifyContent: 'space-between',
    gap: 4,
  },
  speedChip: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
  },
  speedChipActive: {
    backgroundColor: BRAND.green,
    borderColor: BRAND.green,
  },
  speedChipText: {
    color: '#8FA5B9',
    fontSize: 11,
    fontWeight: '800',
  },
  speedChipTextActive: {
    color: '#fff',
  },
  scrubberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 10,
  },
  scrubberTrack: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  scrubberProgress: {
    height: '100%',
    borderRadius: 4,
  },
  scrubberTimeText: {
    color: '#8FA5B9',
    fontSize: 12,
    fontWeight: '700',
    minWidth: 32,
    textAlign: 'right',
  },
  historyStatsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  historyStatCell: {
    flex: 1,
    alignItems: 'center',
  },
  histStatVal: {
    color: '#EDF5FB',
    fontSize: 13,
    fontWeight: '900',
  },
  histStatLbl: {
    color: '#7F96AA',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
    textTransform: 'uppercase',
  },
  timelineSection: {
    marginTop: 16,
    borderColor: 'rgba(255,255,255,0.08)',
    borderTopWidth: 1,
    paddingTop: 12,
  },
  sectionHeadingText: {
    color: '#8FA5B9',
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginVertical: 6,
  },
  timelineItemContent: {
    flex: 1,
  },
  timelineTitleText: {
    color: '#E9F4FC',
    fontSize: 13,
    fontWeight: '800',
  },
  timelineSubtitleText: {
    color: '#8FA5B9',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  noHistoryBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 30,
  },
  noHistoryText: {
    color: '#8FA5B9',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  eventMarker: {
    alignItems: 'center',
    backgroundColor: '#eab308',
    borderRadius: 10,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  stopMarker: {
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  cinematicSection: {
    flex: 1,
    marginTop: 10,
  },
  cinematicTitleText: {
    color: '#8FA5B9',
    fontSize: 12,
    fontWeight: '900',
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  cameraGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  cameraCard: {
    flexBasis: '28%',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    gap: 6,
  },
  cameraCardActive: {
    backgroundColor: BRAND.greenGlow,
    borderColor: BRAND.greenGlow,
  },
  cameraCardLabel: {
    color: '#DDF9EE',
    fontSize: 12,
    fontWeight: '800',
  },
  cameraCardLabelActive: {
    color: '#07121B',
  },
});

const TOOLTIP_W = 140;
const TOOLTIP_H = 50;
const TOOLTIP_ARROW = 6;
const TOOLTIP_MARKER_HALF = 32;

const tooltipStyles = StyleSheet.create({
  tooltip: {
    position: 'absolute',
    width: TOOLTIP_W,
    height: TOOLTIP_H,
    backgroundColor: 'rgba(9, 24, 15, 0.95)',
    borderColor: 'rgba(34, 197, 94, 0.6)',
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    zIndex: 100,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  statusText: {
    color: '#2BE69E',
    fontSize: 11,
    fontWeight: '900',
  },
  speedText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  timeText: {
    color: '#A3B8CC',
    fontSize: 9,
    fontWeight: '600',
    textAlign: 'center',
  },
  arrow: {
    position: 'absolute',
    bottom: -TOOLTIP_ARROW,
    left: TOOLTIP_W / 2 - TOOLTIP_ARROW,
    width: 0,
    height: 0,
    borderLeftWidth: TOOLTIP_ARROW,
    borderLeftColor: 'transparent',
    borderRightWidth: TOOLTIP_ARROW,
    borderRightColor: 'transparent',
    borderTopWidth: TOOLTIP_ARROW,
    borderTopColor: 'rgba(9, 24, 15, 0.95)',
  },
});
