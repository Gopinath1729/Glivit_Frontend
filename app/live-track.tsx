import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  type AppStateStatus,
  type LayoutChangeEvent,
  LayoutAnimation,
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
  UIManager,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  loadMapPreferences,
  type MapPreferences,
  DEFAULT_MAP_PREFERENCES,
} from '@/src/services/mapPreferencesStorage';

import { StatusPill } from '@/src/components/ui/StatusPill';
import {
  FleetWebMap,
  type FleetWebMapHandle,
  type WebMapMarker,
  type WebMapProjection,
} from '@/src/components/FleetWebMap';
import MapView, { Marker } from '@/src/components/maps/NativeMap';
import { splitRouteCoordinates, StableRouteLine } from '@/src/components/StableRouteLayers';
import {
  VehicleMarker,
  markerCategory as markerCategoryFor,
  vehicleMarkerCanvas,
} from '@/src/components/VehicleMarker';
import { vehicleSprite } from '@/src/components/vehicleMarkerSprites';
import { useLiveRoadTrack } from '@/src/hooks/useLiveRoadTrack';
import { useMatchedHistoryRoute } from '@/src/hooks/useMatchedHistoryRoute';
import { describeMatchStatus } from '@/src/services/matchedRoute';
import { resolveDeviceState, stateColorFor } from '@/src/services/deviceState';
import { useLocationDisabledFor } from '@/src/services/mobileGpsStatus';
import {
  useGetAllDevicesQuery,
  useGetDevicePlaybackQuery,
  useGetDeviceQuery,
} from '@/src/services/devicesApi';
import {
  getMapStyleInfo,
} from '@/src/services/mapStyle';
import {
  haversineKm,
  lerpAngle,
  normalizeHeading,
  type PlaybackCoordinate,
} from '@/src/services/playbackEngine';
import { markerRotationFor } from '@/src/services/geoMath';
import { traceCoord, traceGps } from '@/src/services/gpsDiagnostics';
import {
  drawableRuns,
  mergeLiveTrailHistory,
  type LiveTrailRun,
} from '@/src/services/liveRouteTrail';
import { useLivePositions, useLiveRoadMotion } from '@/src/services/livePositions';

import type { DeviceSummary, PlaybackTrackPoint } from '@/src/types/api';

/** Length of the vehicle glyph itself. */
const LIVE_VEHICLE_SIZE = 52;
/**
 * Container for the marker. It has to clear VehicleMarker's own rotation
 * canvas: hardcoding 64 while the marker needed 77 meant Android baked the
 * marker bitmap at 64x64 and cropped the overflow.
 */
const LIVE_MARKER_SIZE = vehicleMarkerCanvas(LIVE_VEHICLE_SIZE);
const LIVE_STATUS_CIRCLE_SIZE = 56;
/** Single spacing unit for every floating map layer (header, rails, pills). */
const OVERLAY_GAP = 10;
/** Height assumed for the collapsed sheet before it has been measured. */
const COLLAPSED_SHEET_FALLBACK = 118;
/** Height of the sheet's drag-handle row. The content pane below it is sized
 *  against this, so the two must stay in step or the History scroll view ends
 *  up taller than the sheet and its last card falls off the bottom. */
// Old-architecture Android needs layout animations switched on explicitly. The
// call is a no-op under Fabric and absent on iOS, so it is guarded rather than
// branched on the architecture, which the app cannot reliably detect.
if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const SHEET_HANDLE_HEIGHT = 56;
/**
 * `bottomSheetContent` vertical padding, top and bottom.
 *
 * Must equal the stylesheet's `paddingTop` plus its BASE `paddingBottom` - the
 * navigation-bar inset the content adds on top of that is accounted for
 * separately in `sheetHeight`. It read 20 against a real 24, so the sheet was
 * laid out four pixels shorter than its own content needed and the last row of
 * labels was clipped.
 */
const SHEET_VERTICAL_PADDING = 24;
/** Short enough to feel immediate, long enough not to look like a jump. */
const SHEET_RESIZE_ANIMATION = {
  duration: 180,
  create: { type: 'easeInEaseOut', property: 'opacity' },
  update: { type: 'easeInEaseOut' },
  delete: { type: 'easeInEaseOut', property: 'opacity' },
} as const;
/** Size of every floating action button, so the rails line up pixel-for-pixel. */
const CONTROL_BUTTON_SIZE = 44;
const CAMERA_MIN_GAP_MS = 560;
const LIVE_STALE_AFTER_SEC = 15;
// The live catch-up clock's constants used to live here. There is no catch-up
// clock any more: the marker travels one matched road segment at a time, and how
// long it takes is derived from the device's own reporting cadence inside
// `useLiveRoadMotion` rather than from a screen-level constant.

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
const CONTACT_PHONE = '+919876543210';

type MapLoadState = 'loading' | 'ready' | 'error';
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

// The one and only tracking-route colour: a vivid road blue with a restrained
// cyan aura, legible over both street and satellite maps.
const ROUTE_BLUE = '#1473E6';
const ROUTE_BLUE_AURA = 'rgba(45, 174, 255, 0.30)';
/**
 * The GPS-only diagnostic line.
 *
 * Deliberately amber, thin and unaura'd so it cannot be confused with the
 * authoritative road route above. It shows where the vehicle REPORTED being
 * over a stretch the matcher could not place - a chord between fixes, not a
 * road - and the whole point of the separate styling is that nobody reads it
 * as one.
 */
const ROUTE_GPS_ONLY = '#F59E0B';

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

/**
 * Thins ONE already-validated run for rendering.
 *
 * Deliberately takes and returns a single run. It used to take a flat
 * coordinate list and quietly drop any vertex that failed validation, which
 * joins the two survivors either side of it with a straight line - the artefact
 * the vertex was dropped to avoid. Splitting is
 * {@link splitRouteCoordinates}'s job and happens BEFORE this; by the time a
 * run reaches here every vertex in it is known good and known adjacent, so
 * thinning cannot invent a segment.
 */
function thinRunForRender(coordinates: Coordinate[], maxPoints = 2_000): Coordinate[] {
  if (coordinates.length <= 2) return coordinates;
  const meaningful = [coordinates[0]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const point = coordinates[index];
    const previous = meaningful[meaningful.length - 1];
    const isLast = index === coordinates.length - 1;
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

/** Validate-then-split-then-thin, in that order, for a whole coordinate list. */
function renderableRuns(coordinates: Coordinate[], maxPoints = 2_000): Coordinate[][] {
  return splitRouteCoordinates(coordinates)
    .map((run) => thinRunForRender(run, maxPoints))
    .filter((run) => run.length >= 2);
}

/**
 * Android cannot rasterise a marker's React view under the New Architecture,
 * so the vehicle is drawn from a pre-baked bitmap there. iOS keeps the vector
 * marker because MapKit has no marker rotation at all.
 */
const USE_VEHICLE_SPRITE = Platform.OS === 'android';

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
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  const moving = (state ?? '').toUpperCase() === 'RUNNING';
  // Bucketed so a turning vehicle re-rasterises a few times, not every fix.
  const headingBucket = Math.round(heading / 15);
  // Baking stopped on a fixed 240ms timer before. If the car bitmap had not
  // decoded by then the marker captured an empty frame and never re-baked.
  const [imageLoaded, setImageLoaded] = useState(false);
  const onImageLoad = useCallback(() => setImageLoaded(true), []);

  useEffect(() => {
    if (USE_VEHICLE_SPRITE) return;
    setTracksViewChanges(true);
    // Never block on onLoad forever: it is not always fired for a bundled
    // static image, and permanent rasterisation costs a redraw every frame.
    const timer = setTimeout(() => setTracksViewChanges(false), imageLoaded ? 120 : 1500);
    return () => clearTimeout(timer);
  }, [showStatusCircle, statusColor, headingBucket, imageLoaded, moving]);

  // The vector marker draws its own heading cone into a billboard the SDK never
  // turns, so it must be given the bearing relative to the camera. A flat
  // sprite is rotated by the map itself and wants the true bearing. Both go
  // through markerRotationFor, so the vehicle artwork's own orientation offset
  // is applied in exactly one place for both platforms.
  const mapRotation = markerRotationFor(heading);
  const screenHeading = normalizeHeading(mapRotation - cameraHeading);

  // Android bakes a custom marker view into a 100x100 pixel square taken from
  // its top-left corner under the New Architecture, which for a centred car is
  // empty -- see src/components/vehicleMarkerSprites.
  if (USE_VEHICLE_SPRITE) {
    return (
      <Marker
        anchor={{ x: 0.5, y: 0.5 }}
        centerOffset={{ x: 0, y: 0 }}
        coordinate={coordinate}
        flat
        identifier="live-vehicle"
        image={vehicleSprite(state, showStatusCircle)}
        rotation={mapRotation}
        tappable={false}
        tracksViewChanges={false}
        zIndex={40}
      />
    );
  }

  return (
    <Marker
      anchor={{ x: 0.5, y: 0.5 }}
      centerOffset={{ x: 0, y: 0 }}
      coordinate={coordinate}
      flat
      identifier="live-vehicle"
      tappable={false}
      tracksViewChanges={tracksViewChanges}
      zIndex={40}>
      <View collapsable={false} style={styles.liveVehicleMarker}>
        {showStatusCircle ? (
          <View style={[styles.markerStatusCircle, { borderColor: statusColor }]} />
        ) : null}
        <VehicleMarker
          category={markerCategoryFor(category)}
          color={statusColor}
          heading={screenHeading}
          moving={moving}
          onImageLoad={onImageLoad}
          size={LIVE_VEHICLE_SIZE}
        />
      </View>
    </Marker>
  );
});

export default function VehicleTrackerScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    category?: string;
    deviceId?: string;
    name?: string;
    subtitle?: string;
  }>();
  // Real route playback for the selected device.
  const deviceId = params.deviceId ? Number(params.deviceId) : undefined;
  // A real, tenant-scoped device is selected.
  const hasRealDevice = deviceId != null && !Number.isNaN(deviceId);
  const validDeviceId = deviceId != null && !Number.isNaN(deviceId);
  const { data: deviceDetail, refetch: refetchDevice } = useGetDeviceQuery(deviceId as number, {
    skip: !validDeviceId,
  });
  // No fabricated fallbacks. A hardcoded registration and address here read as
  // real vehicle data on a screen whose entire job is to report where a real
  // vehicle actually is, and they showed up for any device whose detail had not
  // loaded yet.
  const vehicleName = params.name ?? deviceDetail?.name ?? 'Vehicle';
  const vehicleSubtitle = params.subtitle ?? deviceDetail?.address ?? 'Locating…';
  const vehicleCategory = params.category ?? deviceDetail?.category ?? 'CAR';
  // The tenant's live SSE stream, filtered to this device. This is the ONLY
  // source of movement on this LIVE screen: there is no simulator, no demo
  // route and no synthesised track behind it. The current trip's already
  // accepted history is restored below only so an app restart cannot erase the
  // travelled line; nothing is ever drawn ahead of the vehicle. Full recorded
  // playback lives entirely on the separate Route Playback / History screen.
  const liveEnabled = validDeviceId;
  // The device's own state is deliberately NOT passed in. It used to be, and
  // because it sat in the subscription's dependency list every state change
  // (RUNNING -> IDLE -> STOPPED, refetched on a timer) tore the stream down and
  // rebuilt it - losing every fix that landed during the reconnect. The stream
  // is shared and its lifetime depends only on which device is selected.
  const live = useLivePositions(liveEnabled ? deviceId : undefined);
  const hydrationRangeRef = useRef<{ deviceId: number; from: string; to: string } | null>(null);
  if (
    deviceId != null &&
    live.latest?.deviceId === deviceId &&
    live.tripStartedAt != null &&
    Number.isFinite(live.tripStartedAt)
  ) {
    const from = new Date(live.tripStartedAt).toISOString();
    if (
      hydrationRangeRef.current?.deviceId !== deviceId ||
      hydrationRangeRef.current?.from !== from
    ) {
      // Freeze the cutoff at the first live snapshot for this trip. A query
      // whose `to` advances every second continually refetches; omitting it can
      // briefly return a point newer than the marker and draw the line ahead of
      // the vehicle. SSE owns everything after this exact boundary.
      hydrationRangeRef.current = {
        deviceId,
        from,
        to: new Date(live.lastEventAt ?? Date.now()).toISOString(),
      };
    }
  } else if (hydrationRangeRef.current) {
    hydrationRangeRef.current = null;
  }
  const liveTripFrom = hydrationRangeRef.current?.from;
  const liveTripTo = hydrationRangeRef.current?.to;
  const { data: liveTripPlayback } = useGetDevicePlaybackQuery(
    { deviceId: deviceId as number, from: liveTripFrom, to: liveTripTo },
    { skip: !validDeviceId || !liveTripFrom || !liveTripTo }
  );
  const { track: hydratedLiveTrack, route: hydratedRoute } =
    useMatchedHistoryRoute(liveTripPlayback);
  /**
   * The already-recorded part of this trip, as identified runs.
   *
   * Each run carries the positionId and GPS time of the fixes at its ends, which
   * is what lets the live stream be attached to it by IDENTITY. The previous
   * version compared the two endpoints' coordinates and joined them if they were
   * within ~120 m - a test that a parallel carriageway, a service road and a
   * flyover all pass, so reopening the screen mid-trip could weld the route onto
   * a road the vehicle had never been on.
   */
  const hydratedLiveTrail = useMemo<LiveTrailRun[]>(() => {
    // No confident road for this range means no road to draw. The recorded fixes
    // still exist - they are what the timeline and the readouts are built from -
    // but joining them would be a chord across every stretch the matcher could
    // not place, in the same blue as the geometry it could.
    if (!hydratedRoute.hasMatchedGeometry) return [];
    const points = hydratedLiveTrack.points;
    return hydratedLiveTrack.runs
      .map((run) => {
        const slice = points
          .slice(run.start, run.end + 1)
          // Only vertices the matcher actually placed. A run can end on a fix it
          // could not cover; that fix belongs to the journey, not to the road.
          .filter((point) => point.mapMatched);
        const vertices = slice.map((point) => ({ latitude: point.lat, longitude: point.lng }));
        // Densified road vertices carry no id of their own; the run's identity
        // is the first and last REAL fix inside it.
        const ids = slice
          .map((point) => point.positionId)
          .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
        const times = slice
          .map((point) => Date.parse(point.t))
          .filter((time) => Number.isFinite(time));
        return {
          vertices,
          firstPositionId: ids.length > 0 ? ids[0] : null,
          lastPositionId: ids.length > 0 ? ids[ids.length - 1] : null,
          firstTimestampMs: times.length > 0 ? times[0] : null,
          lastTimestampMs: times.length > 0 ? times[times.length - 1] : null,
        } satisfies LiveTrailRun;
      })
      .filter((run) => run.vertices.length > 0);
  }, [hydratedLiveTrack, hydratedRoute.hasMatchedGeometry]);
  /**
   * Where hydration stops and the stream starts.
   *
   * Everything up to and including this positionId came from the recorded trip;
   * everything after it comes from SSE. A fix on both sides is de-duplicated by
   * id rather than drawn twice.
   */
  const hydrationBoundary = useMemo(() => {
    const tail = hydratedLiveTrail[hydratedLiveTrail.length - 1];
    return tail
      ? { positionId: tail.lastPositionId, timestampMs: tail.lastTimestampMs }
      : null;
  }, [hydratedLiveTrail]);
  /**
   * Route hydration is a state of its OWN, distinct from the live stream.
   *
   * Deliberately not folded into a single "loading" flag. The map, the live
   * stream, the recorded part of the trip and the road answer all become ready
   * at different moments and for different reasons, and collapsing them means a
   * screen that is waiting for one of them looks like a screen that is broken.
   * In particular the MARKER never waits on this: it is driven entirely by the
   * live stream, so a slow history fetch can no longer replace a current
   * position with stale history or blank the vehicle while it loads.
   */
  const routeHydrating =
    validDeviceId && Boolean(liveTripFrom) && Boolean(liveTripTo) && !liveTripPlayback;
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
  const [appActive, setAppActive] = useState(() => isForeground(AppState.currentState));

  // Live fixes arrive already validated and road-matched, so this is pure
  // in-memory bookkeeping. Recorded-range playback (Journey Summary, Journey
  // Timeline) remains on the separate Route Playback screen; the small history
  // query above only hydrates the current trip's travelled live line.
  const track = useLiveRoadTrack(live.points, seedPoint);
  // Distance travelled so far on the current live trip (grows with the route).
  /**
   * Trip distance, measured by the backend from validated GPS coordinates.
   *
   * The ingest pipeline accumulates it as each fix is accepted. It is never
   * derived from the polyline, the animated marker or the road-matched geometry.
   *
   * <h3>Two sources, and why the fallback is needed</h3>
   * The live stream carries it on every frame, and that is the value to prefer
   * while frames are arriving. But a vehicle that is offline, stale, or simply
   * has not pushed a frame since this screen opened produces none - and the
   * stream's default of 0 is indistinguishable from a genuine zero. That is why
   * an offline vehicle read "Covered 0.0 km / Trip 0.0 km" while the server had
   * it at 0.67 km.
   *
   * The device snapshot is the fallback, and it is the SAME number: both come
   * from `device_current_position.trip_distance_km`. The live frame is
   * preferred only once one has actually been accepted for this device.
   */
  const tripDistanceKm =
    live.lastEventAt != null
      ? live.tripDistanceKm
      : Number.isFinite(deviceDetail?.tripDistanceKm)
        ? (deviceDetail!.tripDistanceKm as number)
        : live.tripDistanceKm;
  const totalDistanceKm = tripDistanceKm;
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
  // There is deliberately NO recorded-timeline clock on this screen any more.
  //
  // Live Track used to run two independent motion mechanisms at once: a
  // `sampleAt(track, elapsedMs)` playback clock catching up to the newest fix,
  // AND a separate marker ease toward the newest matched coordinate, with a
  // projection of the second onto the route on top. Three components each
  // claimed a position for the same instant, and whichever rendered last won -
  // which is why the marker could visibly stutter, sit behind the line, or jump
  // back to a position it had already left. The single authority is now
  // `useLiveRoadMotion` below: one distance, along one matched road segment.
  // Recorded playback keeps its own clock on the Route Playback screen.
  // This is a live-only screen: the marker is always pinned to (and smoothly
  // animated toward) the newest streamed fix. There is no pause/resume state.
  const [isLiveFollowing, setIsLiveFollowing] = useState(true);
  const [liveAgeSec, setLiveAgeSec] = useState<number | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [autoFollowSuspended, setAutoFollowSuspended] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const [cinematicMode] = useState(false);
  const [markerCategoryOverride] = useState<string | null>(null);
  // Bottom sheet detent: collapsed shows only the summary; expanded shows all.
  const [sheetExpanded, setSheetExpanded] = useState(true);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [collapsedSheetHeight] = useState(0);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  /**
   * Whether the travelled route line is drawn.
   *
   * Owned by this screen and defaulted ON. It used to be the SAME flag as the
   * map's traffic layer, and was re-read from the stored map preferences on
   * every focus - where `details.traffic` defaults to false. So the travelled
   * route was hidden by default, and reappeared only if somebody happened to
   * enable traffic; navigating away and back hid it again. That is the "route
   * line keeps disappearing" fault, and it had nothing to do with the geometry.
   * Traffic is now read from `mapPreferences.details.traffic` where it belongs
   * (see `showsTraffic` on the MapView) and this flag only ever changes when the
   * operator presses the Route control.
   */
  const [isRouteVisible, setIsRouteVisible] = useState(true);
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
  }, [tooltipAnim, tooltipVisible]);

  const tooltipStyle = {
    opacity: tooltipAnim,
    transform: [
      { scale: tooltipAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
      { translateY: tooltipAnim.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) },
    ],
  };

  useEffect(() => {
    const sub = navigation.addListener('focus', () => {
      // Map layer preferences only. The travelled route's visibility is NOT one
      // of them and is deliberately not touched here - re-applying a stored
      // preference on every focus is what kept switching the route line off.
      void loadMapPreferences().then(setMapPreferences);
    });
    return sub;
  }, [navigation]);
  const [showsUserLocation, setShowsUserLocation] = useState(false);
  // Full screen was removed with its control; the layout is always windowed.
  const isFullScreen = false;
  const [mapSize, setMapSize] = useState({ height, width });
  const [overlayHeights, setOverlayHeights] = useState({
    camera: 46,
    cinema: 150,
    header: 70,
    resume: 38,
  });
  const markerCategory = markerCategoryOverride ?? vehicleCategory;

  liveFollowingRef.current = isLiveFollowing;
  /**
   * The authoritative travelled route: hydrated history plus the live stream,
   * joined by positionId rather than by proximity.
   */
  const completeLiveTrail = useMemo(
    () => mergeLiveTrailHistory(hydratedLiveTrail, live.trail, hydrationBoundary),
    [hydratedLiveTrail, hydrationBoundary, live.trail]
  );
  /**
   * The ONE live motion clock.
   *
   * Travels the marker a monotonically increasing DISTANCE along the current
   * matched road segment, and returns the route clipped at that same distance.
   * Because both come from one polyline and one number, the blue line always
   * ends directly behind the vehicle, and the vehicle always rides the road -
   * including through a 90-degree turn, which component-wise interpolation
   * between two matched endpoints cuts diagonally.
   */
  const motion = useLiveRoadMotion(
    live.roadSegment,
    completeLiveTrail,
    live.displayPosition,
    live.displayHeading
  );
  /**
   * The GPS-only diagnostic overlay.
   *
   * Stretches with no road answer. Drawn thin and dashed in a deliberately
   * different colour, and never as the authoritative route: a matching outage
   * must read as "we do not know which road", not as a confident blue line
   * across the buildings between two fixes.
   */
  const diagnosticSegments = useMemo(
    () => drawableRuns(live.diagnosticTrail),
    [live.diagnosticTrail]
  );
  /** True while the road answer for the newest fix has not arrived yet. */
  const roadMatchPending = live.roadMatchPending;
  const roadMatchUnavailable =
    live.matchStatus === 'UNAVAILABLE' || live.matchStatus === 'DISABLED';
  /** The transport, separately from anything about the vehicle. */
  const liveStreamConnecting =
    liveEnabled && (live.stream.status === 'connecting' || live.stream.status === 'reconnecting');

  // Final stage of the trace: the coordinate and rotation the marker is actually
  // given. Fired per ACCEPTED fix, not per animation frame - the easing runs at
  // 60fps and tracing it would bury every other line. Together with the
  // `[gps:matched]` line above it this is what proves the point the pipeline
  // accepted is the point that got drawn.
  useEffect(() => {
    if (!live.displayPosition) return;
    traceGps('render', deviceId ?? 'live', {
      stage: 'marker',
      drawn: traceCoord(live.displayPosition.latitude, live.displayPosition.longitude),
      raw: traceCoord(live.rawPosition?.latitude, live.rawPosition?.longitude),
      heading: live.displayHeading,
      rotation: markerRotationFor(live.displayHeading),
      gpsTime: live.lastEventAt,
      quality: live.quality,
    });
  }, [
    deviceId,
    live.displayHeading,
    live.displayPosition,
    live.lastEventAt,
    live.quality,
    live.rawPosition,
  ]);

  /**
   * The last coordinate we were ever confident about.
   *
   * This is the whole of the "the vehicle must not disappear" contract on the
   * render side. A dropped stream, a rejected fix, a refetch that came back
   * without a position, a tab switch, a remount - none of them produce a
   * coordinate, and every one of them used to fall through to (0, 0) or to no
   * marker at all. They now fall through to here instead, and the marker stays
   * exactly where it was while its freshness label does the talking.
   */
  const lastKnownCoordinateRef = useRef<Coordinate | null>(null);
  /**
   * Which vehicle the sticky coordinate above belongs to.
   *
   * Without this the ref survived a vehicle switch, so selecting a second
   * vehicle drew its marker at the FIRST one's last position until a fix for
   * the new one arrived - on a parked fleet, minutes. It is the same class of
   * fault as a stale cached coordinate, just held in a ref instead of a cache.
   */
  const lastKnownDeviceRef = useRef<number | undefined>(deviceId);
  if (lastKnownDeviceRef.current !== deviceId) {
    lastKnownDeviceRef.current = deviceId;
    lastKnownCoordinateRef.current = null;
  }
  const vehicleCoordinate = useMemo<Coordinate>(() => {
    const resolved =
      motion.position ??
      live.displayPosition ??
      (seedPoint ? { latitude: seedPoint.lat, longitude: seedPoint.lng } : null) ??
      lastKnownCoordinateRef.current;

    if (resolved) lastKnownCoordinateRef.current = resolved;
    // Only ever reached before anything at all has been received, and the
    // marker is not rendered in that state (see hasVehicleCoordinate).
    return resolved ?? { latitude: 0, longitude: 0 };
  }, [live.displayPosition, motion.position, seedPoint]);

  /**
   * True once any position has been established, and never false again for the
   * life of this screen. Gating the marker on the CURRENT frame having a sample
   * is what made the vehicle blink out whenever the track was momentarily empty
   * - between a vehicle switch and its first fix, across a trip reset, during a
   * refetch - and reappear minutes later when the next packet happened to land.
   */
  const hasVehicleCoordinate = lastKnownCoordinateRef.current != null;
  const heading = motion.heading;
  // Live values change on every animation frame. Callbacks read them through a
  // ref instead of closing over them, so their identity stays stable and the
  // memoised bottom sheet is not re-rendered (and its native-driven transform
  // not re-attached) 60 times a second.
  const liveRef = useRef({ coordinate: vehicleCoordinate, heading });
  liveRef.current = { coordinate: vehicleCoordinate, heading };
  // The rendered route only depends on accepted GPS history, never on the
  // per-frame playback position, so it is not rebuilt on every animation frame.
  const renderRoute = useMemo(
    () => motion.route.flatMap((run) => renderableRuns(run)).flat(),
    [motion.route]
  );
  /**
   * The live route as one polyline per observed run.
   *
   * The live buffer has coverage gaps too — a tunnel, a dead zone, a tracker
   * that dropped out — and a flat coordinate list forces the map to close every
   * one of them with a straight line through whatever it crosses. Splitting on
   * the same runs history uses means a break is drawn as a break.
   */
  const liveRouteSegments = useMemo<PlaybackCoordinate[][]>(() => {
    // `motion.route` is the travelled route clipped at the vehicle: road
    // geometry the backend actually matched, and nothing else. There is no
    // fallback to the chord between two accepted fixes - a stretch with no road
    // answer contributes no blue line at all and appears, if the operator wants
    // it, only on the GPS-only diagnostic layer below.
    return motion.route.flatMap((segment) => renderableRuns(segment));
  }, [motion.route]);
  /** The GPS-only overlay, thinned the same way but drawn very differently. */
  const diagnosticRouteSegments = useMemo<PlaybackCoordinate[][]>(
    () => diagnosticSegments.flatMap((segment) => renderableRuns(segment)),
    [diagnosticSegments]
  );
  // Route diagnostics are emitted once per accepted fix. `liveProgress` changes
  // every animation frame; tracing that value would produce ~30 log records a
  // second and hide the GPS packet that caused the movement.
  useEffect(() => {
    const segments = drawableRuns(live.trail);
    const tail = segments[segments.length - 1];
    traceGps('render', deviceId ?? 'live', {
      stage: 'route_append',
      positionId: live.trail[live.trail.length - 1]?.lastPositionId ?? null,
      runs: segments.length,
      vertices: segments.reduce((total, segment) => total + segment.length, 0),
      lastVertex: tail
        ? traceCoord(tail[tail.length - 1].latitude, tail[tail.length - 1].longitude)
        : 'none',
      diagnosticRuns: live.diagnosticTrail.length,
      matchStatus: live.matchStatus,
      roadMatchPending: live.roadMatchPending,
    });
  }, [
    deviceId,
    live.diagnosticTrail.length,
    live.matchStatus,
    live.roadMatchPending,
    live.trail,
  ]);
  // The vehicle is always at the newest fix, so covered and total are the same
  // backend number.
  const coveredKm = tripDistanceKm;
  // The backend's canonical speedKmh for the newest accepted fix - already
  // converted from the device's own unit exactly once, at ingest, and already
  // smoothed and clamped there. It is never recomputed, rescaled or estimated
  // on this side.
  const reportedSpeed = Math.max(0, Math.round(live.speedKmh));
  const isLiveStale =
    live.quality === 'stale' ||
    (liveAgeSec != null && liveAgeSec >= LIVE_STALE_AFTER_SEC);
  const isLowAccuracy = live.quality === 'low_accuracy';
  const hasInvalidLiveFix = live.quality === 'invalid' && !live.latest;
  const liveState = live.latest?.state?.trim().toUpperCase();
  // A remotely cut or locked vehicle cannot be moving whatever the last GPS fix
  // said, so immobilisation outranks the live stream. The flag is refetched when
  // a command invalidates the device cache.
  const isImmobilised = Boolean(deviceDetail?.immobilised || deviceDetail?.locked);
  // This login's own phone tracker, with its location switch off.
  const locationDisabled = useLocationDisabledFor(deviceId);
  /**
   * The single, shared status calculation — the same one the vehicle list, the
   * map and management render.
   *
   * This screen used to derive its own answer from stream connectivity, speed
   * and ignition, and only honoured the server's state when it happened to be
   * STOPPED or IDLE. Anything else (OFFLINE included) fell through to
   * "Running", so an open SSE socket made a three-hour-old fix look like a
   * moving vehicle while the list correctly showed it Offline.
   */
  const resolvedState = useMemo(
    () =>
      resolveDeviceState({
        serverState: liveState || deviceDetail?.state,
        // The newest fix wins: the stream carries fresher telemetry than the
        // periodically-refetched device record.
        // The GPS clock of the newest fix, not when the packet arrived. A device
        // replaying an old buffer is receiving data now but is not reporting
        // where the vehicle is now, and must not be presented as live.
        lastUpdate:
          live.latest?.lastGpsTime ??
          live.latest?.deviceTime ??
          live.latest?.serverTime ??
          deviceDetail?.lastUpdate,
        offlineTimeoutSeconds: deviceDetail?.offlineTimeoutSeconds,
        sourceType: deviceDetail?.sourceType,
        immobilised: deviceDetail?.immobilised,
        locked: deviceDetail?.locked,
        speedKmh: live.latest ? live.speedKmh : deviceDetail?.speed,
        ignition: live.latest?.ignition ?? deviceDetail?.ignition,
        gpsValid: live.latest?.gpsValid ?? deviceDetail?.gpsValid,
        accuracyMeters: live.latest?.accuracyMeters,
        locationDisabled,
      }),
    [
      live.latest,
      deviceDetail?.immobilised,
      deviceDetail?.lastUpdate,
      deviceDetail?.locked,
      deviceDetail?.offlineTimeoutSeconds,
      deviceDetail?.sourceType,
      deviceDetail?.state,
      deviceDetail?.gpsValid,
      deviceDetail?.ignition,
      live.speedKmh,
      deviceDetail?.speed,
      liveState,
      locationDisabled,
    ]
  );
  const isStopped = resolvedState.state === 'STOPPED';
  const isOffline = resolvedState.offline;
  const currentSpeed = isOffline || isStopped ? 0 : reportedSpeed;
  // The newest accepted fix's own ignition, then the device snapshot. The
  // interpolated playback sample used to sit between them; it no longer exists,
  // and reading a per-frame animation value for a discrete device signal was
  // never right anyway.
  const latestIgnition =
    live.latest?.ignition ??
    track.points[track.points.length - 1]?.ignition ??
    deviceDetail?.ignition ??
    null;
  const status = isAlertActive
    ? 'Alert'
    : isImmobilised
      ? deviceDetail?.immobilised
        ? 'Engine cut'
        : 'Locked'
      : resolvedState.label;
  const statusColor =
    stateColorFor(status === 'Engine cut' || status === 'Locked' ? 'IMMOBILISED' : resolvedState.state);
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
  /**
   * The GPS row reports the VEHICLE's fix, not the app's connection.
   *
   * It used to read `live.connected`, which is only "the SSE socket is open" —
   * so it said "Connected" for a vehicle that had not reported in hours.
   */
  const gpsText =
    resolvedState.state === 'LOCATION_DISABLED'
      ? 'Off'
      : resolvedState.state === 'GPS_INVALID' || hasInvalidLiveFix
        ? 'No fix'
        : isOffline
          ? 'No signal'
          : isLowAccuracy
            ? 'Low accuracy'
            : isLiveStale
              ? 'Delayed'
              : 'Connected';
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
    setIsLiveFollowing(true);
    setIsFollowing(true);
    setAutoFollowSuspended(false);
    setVehicleScreenPoint(null);
    setLiveAgeSec(null);
    lastAddressRef.current = null;
    manualInteractionRef.current = false;
    initialRouteFitRef.current = false;
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
  }, [cameraMode]);
  const mapStyleInfo = useMemo(
    () => getMapStyleInfo(isNightMode ? 'dark' : isSatelliteMode ? 'bright' : 'street'),
    [isNightMode, isSatelliteMode]
  );
  // Geoapify/MapLibre is the map renderer on Android, iOS and web. Keeping the
  // provider identical across platforms removes the Google-key crash path and
  // makes route/camera behaviour consistent on the phone that supplies GPS.
  const useNativeMap = false;
  const blockingMapIssue = mapStyleInfo.issues.find((issue) => issue.blocking);
  const mapProviderLabel = useMemo(() => {
    return 'Geoapify';
  }, []);
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
          { label: 'Route', value: isRouteVisible ? 'Visible' : 'Hidden' },
          { label: 'Remaining', value: `${remainingKmText} km` },
          { label: 'Trip', value: `${totalKmText} km` },
        ],
        // The tracking route is a single green line with no congestion/speed
        // colours; this control only shows or hides that one line.
        summary: isRouteVisible
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
    isRouteVisible,
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

  const openVehiclePicker = useCallback(() => {
    if (fleet.length <= 1) return;
    haptic();
    setVehiclePickerOpen(true);
  }, [fleet.length, haptic]);

  const closeVehiclePicker = useCallback(() => setVehiclePickerOpen(false), []);
  // Stable identity. Passing an inline arrow here defeated the sheet's memo, so
  // every live fix re-rendered the whole History list underneath an in-flight
  // scroll gesture.
  const openVehiclePickerFromSheet = useCallback(() => setVehiclePickerOpen(true), []);

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
          setIsRouteVisible(!isRouteVisible);
          showToast(isRouteVisible ? 'Route hidden' : 'Route visible');
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
            router.push({
              pathname: '/trip-playback' as never,
              params: {
                deviceId: String(deviceId),
                name: vehicleName,
                category: vehicleCategory,
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
      isRouteVisible,
      resumeCinematicTracking,
      router,
      showToast,
      validDeviceId,
      deviceDetail?.course,
      deviceDetail?.speed,
      vehicleCategory,
      vehicleName,
    ]
  );

  // NOTE: There is intentionally no playback clock, rate multiplier, pause/resume,
  // or scrubbing on this LIVE screen. The vehicle only ever moves toward the newest
  // streamed fix via the single live catch-up animation below. Recorded-timeline
  // playback lives on the separate Route Playback screen.

  // The live catch-up animation that used to live here has been removed.
  //
  // It drove a recorded-timeline clock (`elapsedMs`) toward the end of the live
  // buffer and the marker was sampled from THAT, while a second mechanism eased
  // the marker toward the newest matched coordinate at the same time. Two
  // clocks, one marker. `useLiveRoadMotion` is now the only thing that moves the
  // vehicle, and it moves it along the matched road rather than along a
  // time axis over straight chords between fixes.

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const nextActive = isForeground(state);
      if (nextActive && liveFollowingRef.current) {
        // Nothing to resume: the marker is driven by the newest matched segment,
        // which the stream re-delivers on reconnect. There is no accumulated
        // animation state to replay.
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

  /**
   * Say so when the live route could not be matched to a road.
   *
   * Live tracking used to fall back to raw coordinates with nothing said about
   * it, so a router that was down showed up as a marker quietly sitting off the
   * carriageway with no explanation anywhere, which is exactly the silent
   * fallback this must not do.
   *
   * Only the two ACTIONABLE states are announced. `UNMATCHED` is a property of
   * the trace and happens routinely on unmapped ground; toasting it every time
   * the vehicle leaves a mapped road would train operators to ignore the
   * message that actually means their routing service is broken.
   */
  const liveMatchNotice =
    live.matchStatus === 'DISABLED' || live.matchStatus === 'UNAVAILABLE'
      ? describeMatchStatus(live.matchStatus)
      : null;
  useEffect(() => {
    if (liveMatchNotice) showToast(liveMatchNotice);
  }, [liveMatchNotice, showToast]);

  /**
   * The one place the pipeline's outstanding stage is turned into words.
   *
   * Ordered by what an operator can act on. A missing road matcher is a
   * deployment fault they can fix; a stream still connecting and a trip still
   * hydrating are transient and merely need saying so the screen does not look
   * stuck. Everything below is about the ROUTE - the vehicle itself is drawn
   * throughout, from the live stream, in every one of these states.
   */
  const pipelineNotice = useMemo<
    {
      text: string;
      icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
      tone: string;
    } | null
  >(() => {
    if (roadMatchUnavailable) {
      return {
        text: 'Road matching unavailable — GPS only, no road drawn',
        icon: 'road-variant',
        tone: ROUTE_GPS_ONLY,
      };
    }
    if (liveStreamConnecting) {
      return {
        text: live.stream.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…',
        icon: 'access-point',
        tone: '#93C5FD',
      };
    }
    if (routeHydrating) {
      return { text: 'Loading travelled route…', icon: 'map-marker-path', tone: '#93C5FD' };
    }
    if (roadMatchPending && diagnosticRouteSegments.length > 0) {
      return { text: 'Waiting for road match…', icon: 'progress-clock', tone: ROUTE_GPS_ONLY };
    }
    return null;
  }, [
    diagnosticRouteSegments.length,
    live.stream.status,
    liveStreamConnecting,
    roadMatchPending,
    roadMatchUnavailable,
    routeHydrating,
  ]);

  const fallbackMarkers = useMemo<WebMapMarker[]>(
    () => [
      {
        category: (markerCategory ?? '').toUpperCase(),
        id: 'vehicle',
        lat: vehicleCoordinate.latitude,
        lng: vehicleCoordinate.longitude,
        color: statusColor,
        heading,
        label: vehicleName,
        moving: resolvedState.state === 'RUNNING' && currentSpeed > 0,
      },
    ],
    [
      currentSpeed,
      heading,
      markerCategory,
      resolvedState.state,
      statusColor,
      vehicleCoordinate,
      vehicleName,
    ]
  );
  const fallbackPolylines = useMemo<[number, number][][]>(
    () =>
      // [longitude, latitude] for MapLibre GeoJSON. This conversion is correct
      // and is deliberately the only place it happens.
      liveRouteSegments.map((segment) =>
        segment.map((coordinate) => [coordinate.longitude, coordinate.latitude])
      ),
    [liveRouteSegments]
  );
  const fallbackDiagnosticPolylines = useMemo<[number, number][][]>(
    () =>
      diagnosticRouteSegments.map((segment) =>
        segment.map((coordinate) => [coordinate.longitude, coordinate.latitude])
      ),
    [diagnosticRouteSegments]
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
    // A stale live fix must not drag the camera around.
    if (!appActive || !isFollowing || !isMapReady) return;
    if (isLiveStale) return;

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

  /**
   * The four map controls, in one rail.
   *
   * Zoom, map type, traffic and full screen are gone: pinch and rotate already
   * do the first, and the rest were three taps of chrome over a tracking screen
   * whose job is to show one vehicle. What is left is the four things an
   * operator actually reaches for, in a single evenly spaced column rather than
   * two half-empty ones.
   */
  const mapControls = useMemo<MapControl[]>(
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
      { icon: 'panorama-variant-outline', label: 'Map preview', onPress: openStreetView },
      { icon: 'refresh', label: 'Refresh map', onPress: refreshMap },
    ],
    [
      autoFollowSuspended,
      isFollowing,
      openStreetView,
      refreshMap,
      resumeCinematicTracking,
      showsUserLocation,
      toggleUserLocation,
    ]
  );

  // Real device with no live fixes yet: show a loading state, then a proper
  // empty state. Never fall back to the demo route for a real device (no
  // fabricated GPS movement in production). Live streaming alone is enough to
  // render the map.
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
            center: renderRoute[Math.min(20, renderRoute.length - 1)] ?? vehicleCoordinate,
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
          {isRouteVisible ? (
            <>
              {/* GPS-only diagnostic, UNDER the road route and visibly
                  different: thin, amber, no aura. A stretch the matcher could
                  not place is evidence of where the vehicle said it was, not a
                  road it drove on, and drawing the two the same way is what made
                  a matching outage look like a route through buildings. */}
              {diagnosticRouteSegments.map((segment, index) => (
                <StableRouteLine
                  key={`live-track-gps-only-${index}`}
                  auraColor=""
                  color={ROUTE_GPS_ONLY}
                  coordinates={segment}
                  width={2}
                  zIndex={11}
                />
              ))}
              {liveRouteSegments.map((segment, index) => (
                <StableRouteLine
                  key={`live-track-route-${index}`}
                  auraColor={ROUTE_BLUE_AURA}
                  color={ROUTE_BLUE}
                  coordinates={segment}
                  width={6}
                />
              ))}
            </>
          ) : null}
          {hasVehicleCoordinate ? (
            <LiveVehicleMapMarker
              cameraHeading={mapCameraHeading}
              category={markerCategory}
              coordinate={vehicleCoordinate}
              heading={heading}
              showStatusCircle={
                liveEnabled &&
                (!live.connected || isLiveStale || isLowAccuracy || hasInvalidLiveFix)
              }
              state={resolvedState.state || status}
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
          diagnosticPolylines={fallbackDiagnosticPolylines}
          polylines={fallbackPolylines}
          selectedId="vehicle"
          style={styles.mapCanvas}
        />
      )}

      <View pointerEvents="none" style={styles.mapShade} />

      {/* Road-matching state, stated rather than implied.
          A matching outage must read as "we do not know which road", with the
          vehicle still on screen and NO fabricated line - not as a confident
          blue route across whatever lies between two fixes. The toast announces
          the transition; this pill is the standing statement, because an
          operator who joined after the toast expired still needs to know why
          the line stopped growing. */}
      {pipelineNotice ? (
        <View pointerEvents="none" style={[styles.roadMatchPill, { top: headerTop + 74 }]}>
          <MaterialCommunityIcons
            color={pipelineNotice.tone}
            name={pipelineNotice.icon}
            size={16}
          />
          <Text style={styles.roadMatchPillText}>{pipelineNotice.text}</Text>
        </View>
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
        controls={mapControls}
        side="right"
        top={controlRailTop}
      />

      {isFullScreen ? null : (
        <LiveDetailsSheet
          address={currentAddress}
          alertActive={isAlertActive}
          coveredText={`${coveredKmText} km`}
          expanded={sheetExpanded}
          following={isFollowing}
          gpsText={gpsText}
          ignitionText={ignitionText}
          nightMode={isNightMode}
          onClosePanel={closeOptionPanel}
          onExpand={expandSheet}
          onFollowLive={jumpToLive}
          onLayout={handleSheetLayout}
          onRouteTool={handleRouteTool}
          onToggle={toggleSheet}
          onToggleTools={toggleTools}
          panHandlers={sheetPanResponder.panHandlers}
          pingTime={pingTime}
          routeVisible={isRouteVisible}
          satelliteMode={isSatelliteMode}
          selectedOptionData={selectedOptionData}
          selectedOptionId={selectedOptionId}
          speed={currentSpeed}
          status={status}
          toolsExpanded={toolsExpanded}
          totalText={`${totalKmText} km`}
          translateY={sheetTranslateY}
          vehicleName={vehicleName}
          onSelectVehicle={openVehiclePickerFromSheet}
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
                          : state === 'STOPPED' || state === 'IDLE'
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
  side = 'right',
  top,
}: MapControlRailProps) {
  const isLeft = side === 'left';
  const insets = useSafeAreaInsets();
  const sideStyle = isLeft
    ? { left: OVERLAY_GAP + 4 + insets.left, alignItems: 'flex-start' as const }
    : { right: OVERLAY_GAP + 4 + insets.right, alignItems: 'flex-end' as const };

  const lastPressRef = useRef<number>(0);
  const handlePress = useCallback((onPress: () => void) => {
    const now = Date.now();
    if (now - lastPressRef.current < 250) return;
    lastPressRef.current = now;
    onPress();
  }, []);

  return (
    <View pointerEvents="box-none" style={[styles.controlRail, sideStyle, { bottom, top }]}>
      {/* No collapse toggle: four buttons are not worth hiding, and the chevron
          that used to hide them read as a previous/next control. */}
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
    </View>
  );
});

type LiveDetailsSheetProps = {
  address: string;
  alertActive: boolean;
  coveredText: string;
  expanded: boolean;
  following: boolean;
  gpsText: string;
  ignitionText: string;
  nightMode: boolean;
  onClosePanel: () => void;
  onExpand: () => void;
  onFollowLive: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onRouteTool: (id: RouteMapOptionId) => void;
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
  onSelectVehicle: () => void;
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
  coveredText,
  expanded,
  following,
  gpsText,
  ignitionText,
  nightMode,
  onClosePanel,
  onExpand,
  onFollowLive,
  onLayout,
  onRouteTool,
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
  onSelectVehicle,
}: LiveDetailsSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  /**
   * Half the USABLE screen, never more.
   *
   * Usable means the window minus the safe-area insets, so the cap is measured
   * against the space an operator can actually see rather than the raw pixel
   * height. The map keeps the other half on every device.
   */
  const maxSheetHeight = Math.max(
    220,
    (windowHeight - insets.top - insets.bottom) * 0.5
  );

  /**
   * Natural height of the body, measured as it lays out, so the sheet only
   * reaches the cap when the content genuinely fills it rather than always
   * opening to a tall panel above a block of empty space.
   */
  const [bodyHeight, setBodyHeight] = useState(0);
  const recordBodyHeight = useCallback((height: number) => {
    const next = Math.ceil(height);
    setBodyHeight((current) => (Math.abs(current - next) < 1 ? current : next));
  }, []);

  // Handle row and the sheet's own vertical padding: the space the body does
  // not get. Measured from the constants the stylesheet uses so the two cannot
  // drift apart.
  const sheetChromeHeight = SHEET_HANDLE_HEIGHT + SHEET_VERTICAL_PADDING;
  const sheetHeight = Math.round(
    Math.min(
      maxSheetHeight,
      // Before the first measurement, open at the cap rather than at zero: a
      // sheet that grows from nothing on first paint reads as a flicker.
      bodyHeight > 0
        ? Math.max(160, bodyHeight + sheetChromeHeight + insets.bottom)
        : maxSheetHeight
    )
  );

  // Animate the resize. The wrapper's transform is native-driven, so its
  // height cannot be an Animated value on the same node; a layout animation
  // resizes it without that conflict.
  const previousSheetHeight = useRef(sheetHeight);
  useEffect(() => {
    if (previousSheetHeight.current !== sheetHeight) {
      previousSheetHeight.current = sheetHeight;
      LayoutAnimation.configureNext(SHEET_RESIZE_ANIMATION);
    }
  }, [sheetHeight]);

  const sheetStyle = useMemo(
    () => [
      styles.bottomSheetWrapper,
      {
        height: sheetHeight,
        transform: [{ translateY }],
      },
    ],
    [sheetHeight, translateY]
  );

  return (
    <Animated.View onLayout={onLayout} style={sheetStyle}>
      <View {...panHandlers} style={styles.sheetHandleContainer}>
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
      </View>

      {/* The wrapper's height is definite, so `flex: 1` here resolves to exactly
          the sheet minus the handle row on every platform. The old explicit
          height fought the `flex: 1` still set in the stylesheet and assumed a
          48 px handle that actually measures SHEET_HANDLE_HEIGHT. */}
      <Animated.View
        pointerEvents={expanded ? 'auto' : 'none'}
        // The sheet's HEIGHT already reserves the navigation bar's inset (see
        // `sheetHeight`), but the padding did not spend it, so the last row of
        // content sat flush against - and under - the system navigation bar on
        // a phone with three-button navigation. `edgeToEdgeEnabled` means the
        // app draws behind that bar, so every bottom-anchored surface has to
        // state the inset itself.
        style={[
          styles.bottomSheetContent,
          { opacity: expanded ? 1 : 0, paddingBottom: insets.bottom + 14 },
        ]}
      >
        <Text style={styles.sheetSectionTitle}>Live Info</Text>

        {/* No flex: the body reports its NATURAL height so the sheet can size
            to it. Stretching it to fill was what produced the empty space. */}
        <View onLayout={(event) => recordBodyHeight(event.nativeEvent.layout.height)}>
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
  roadMatchPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(17, 24, 39, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.55)',
  },
  roadMatchPillText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '600',
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
    borderRadius: LIVE_STATUS_CIRCLE_SIZE / 2,
    borderWidth: 2,
    height: LIVE_STATUS_CIRCLE_SIZE,
    left: (LIVE_MARKER_SIZE - LIVE_STATUS_CIRCLE_SIZE) / 2,
    position: 'absolute',
    top: (LIVE_MARKER_SIZE - LIVE_STATUS_CIRCLE_SIZE) / 2,
    width: LIVE_STATUS_CIRCLE_SIZE,
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
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    borderColor: '#DCE8E3',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    shadowColor: '#18382D',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    flex: 1,
  },
  sheetSectionTitle: {
    color: '#102A23',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  sheetHandleContainer: {
    alignItems: 'center',
    height: SHEET_HANDLE_HEIGHT,
    justifyContent: 'center',
    width: '100%',
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
    borderColor: '#E2ECE8',
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
    color: '#152B25',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
  },
  metricLabel: {
    color: '#71827C',
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
  // Each History section is its own panel so the tab reads as a stack of
  // answers (when, playback, totals, route) rather than one long column.
  histCard: {
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  histCardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  histCardHeaderText: {
    color: '#C7D7E4',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  // --- Date & range -------------------------------------------------------
  histDateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  histDateNav: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  // Keeps the pill centred when the forward arrow is not shown.
  histDateNavPlaceholder: {
    height: 42,
    width: 42,
  },
  histDatePill: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  histDatePillText: {
    color: '#EDF5FB',
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  histPresetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  histPresetChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    borderWidth: 1,
    flexBasis: 'auto',
    flexGrow: 1,
    paddingHorizontal: 10,
    paddingVertical: 11,
  },
  histPresetChipActive: {
    backgroundColor: BRAND.green,
    borderColor: BRAND.green,
  },
  histPresetText: {
    color: '#9FB4C6',
    fontSize: 12,
    fontWeight: '800',
  },
  histPresetTextActive: {
    color: '#04140A',
  },

  // --- Playback controls --------------------------------------------------
  histPlaybackRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  histPlayBtn: {
    alignItems: 'center',
    backgroundColor: BRAND.green,
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  histRestartBtn: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  histSpeedRow: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    marginLeft: 4,
  },
  histSpeedChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 11,
  },
  histSpeedChipActive: {
    backgroundColor: BRAND.green,
    borderColor: BRAND.green,
  },
  histSpeedText: {
    color: '#9FB4C6',
    fontSize: 13,
    fontWeight: '800',
  },
  histSpeedTextActive: {
    color: '#04140A',
  },
  histScrubRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  histScrubTrack: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 4,
    flex: 1,
    height: 6,
  },
  histScrubFill: {
    backgroundColor: BRAND.green,
    borderRadius: 4,
    height: '100%',
  },
  histScrubThumb: {
    backgroundColor: BRAND.green,
    borderRadius: 8,
    height: 16,
    marginLeft: -8,
    position: 'absolute',
    top: -5,
    width: 16,
  },
  histScrubTime: {
    color: '#9FB4C6',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 46,
    textAlign: 'center',
  },
  histStopBanner: {
    alignItems: 'center',
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderColor: 'rgba(239,68,68,0.38)',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  histStopBannerText: {
    color: '#FCA5A5',
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
  },

  // --- Trip summary -------------------------------------------------------
  histStatGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  // Two per row on a phone; the fixed basis keeps the value column aligned
  // down the grid instead of shifting with each label's width.
  histStatCell: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    flexGrow: 1,
    gap: 8,
    paddingHorizontal: 9,
    paddingVertical: 11,
  },
  histStatText: {
    flex: 1,
    minWidth: 0,
  },
  histStatValue: {
    color: '#EDF5FB',
    fontSize: 15,
    fontWeight: '900',
  },
  histStatLabel: {
    color: '#7F96AA',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 1,
  },
  histStatValueCompact: {
    fontSize: 13,
  },
  histStatLabelCompact: {
    fontSize: 9,
  },

  // --- Start / end --------------------------------------------------------
  histEndpointCard: {
    flexDirection: 'row',
    gap: 12,
  },
  histEndpoint: {
    flex: 1,
    gap: 6,
    minWidth: 0,
  },
  histEndpointHead: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  histEndpointLabel: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  histEndpointValue: {
    color: '#E9F4FC',
    fontSize: 13,
    fontWeight: '700',
  },
  histEndpointDivider: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    width: 1,
  },

  // --- Journey timeline ---------------------------------------------------
  histTimelineHeading: {
    color: '#C7D7E4',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.9,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  histTimelineRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 10,
    minHeight: 56,
  },
  histRail: {
    alignItems: 'center',
    width: 24,
  },
  histRailLine: {
    backgroundColor: 'rgba(39,211,77,0.45)',
    flex: 1,
    width: 2,
  },
  histRailLineHidden: {
    backgroundColor: 'transparent',
  },
  histRailDot: {
    alignItems: 'center',
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  // A plain leg needs no glyph, so its marker is just a bead on the rail.
  histRailDotSmall: {
    borderRadius: 8,
    height: 16,
    width: 16,
  },
  histRailDotText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  histTimelineBody: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
    paddingVertical: 10,
  },
  histTimelineTitleLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  histTimelineTitle: {
    color: '#EDF5FB',
    fontSize: 14,
    fontWeight: '800',
  },
  histTimelineMeta: {
    color: '#8FA5B9',
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '600',
  },
  histTimelineSub: {
    color: '#6F869A',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 3,
  },
  histTimelineRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 66,
    paddingVertical: 10,
  },
  histTimelinePrimary: {
    fontSize: 13,
    fontWeight: '900',
  },
  histTimelineSecondary: {
    color: '#7F96AA',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  histChevronPlaceholder: {
    width: 20,
  },
  histAlertRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
  },

  // --- Empty state --------------------------------------------------------
  histEmptyBox: {
    alignItems: 'center',
    gap: 10,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 40,
  },
  histEmptyTitle: {
    color: '#9FB4C6',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  histEmptyHint: {
    color: '#6F869A',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  rangePickerBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(3,10,18,0.72)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  rangePickerCard: {
    backgroundColor: '#0E1A26',
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    width: '100%',
  },
  rangePickerTitle: {
    color: '#EDF5FB',
    fontSize: 16,
    fontWeight: '900',
  },
  rangePickerHint: {
    color: '#7F96AA',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  rangeField: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rangeFieldLabel: {
    color: '#7F96AA',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    width: 46,
  },
  rangeFieldValue: {
    color: '#EDF5FB',
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  rangeError: {
    color: '#FCA5A5',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 10,
  },
  rangeActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  rangeActionBtn: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 12,
  },
  rangeActionBtnPrimary: {
    backgroundColor: BRAND.green,
    borderColor: BRAND.green,
  },
  rangeActionText: {
    color: '#8FA5B9',
    fontSize: 13,
    fontWeight: '800',
  },
  rangeActionTextPrimary: {
    color: '#FFFFFF',
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
    backgroundColor: BRAND.red,
    borderColor: '#FFFFFF',
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  // The stop the playhead is currently waiting out.
  stopMarkerActive: {
    borderColor: '#FFE9E9',
    borderRadius: 15,
    borderWidth: 3,
    height: 30,
    width: 30,
  },
  stopMarkerText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  journeyStartMarker: {
    alignItems: 'center',
    backgroundColor: '#27D34D',
    borderColor: '#FFFFFF',
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  journeyEndMarker: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#0B1622',
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
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
