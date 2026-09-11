import { MaterialCommunityIcons } from '@expo/vector-icons';
import { HeaderHeightContext } from '@react-navigation/elements';
import { useIsFocused } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import React, { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  ActivityIndicator,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FleetWebMap,
  type FleetWebMapHandle,
  type WebMapGeofence,
  type WebMapMarker,
  type WebMapNavigationOverlay,
} from '@/src/components/FleetWebMap';
import {
  DirectionsPanel,
  type DirectionsLocation,
  type DirectionsPanelStatus,
} from '@/src/components/DirectionsPanel';
import { LiveVehicleMapMarker } from '@/src/components/LiveVehicleMapMarker';
import { NavigationDrivePanel } from '@/src/components/NavigationDrivePanel';
import { planRoute } from '@/src/services/routePlanner';
import {
  NavigationVehiclePicker,
  type NavigationVehicleOption,
} from '@/src/components/NavigationVehiclePicker';
import { VEHICLE_SPRITE_SIZE_SELECTED } from '@/src/components/vehicleMarkerSprites';
import MapView, { Circle } from '@/src/components/maps/NativeMap';
import { env } from '@/src/config/env';
import {
  DEFAULT_MAP_PREFERENCES,
  type MapPreferences,
} from '@/src/services/mapPreferencesStorage';
import { useGetAllDevicesQuery, useGetDevicesQuery } from '@/src/services/devicesApi';
import { formatDeviceState, resolveDeviceRecordState } from '@/src/services/deviceState';
import { useMobileGpsReadiness } from '@/src/services/mobileGpsStatus';
import { useGetGeofencesQuery } from '@/src/services/operationsApi';
import { dedupeByVehicle } from '@/src/services/vehicleIdentity';
import { useFleetLivePositions } from '@/src/services/fleetLivePositions';
import {
  getMapStyleInfo,
  PREMIUM_FLEET_MAP_PALETTE,
} from '@/src/services/mapStyle';
import { haversineKm } from '@/src/services/geoMath';
import { safeMatchedGeometry } from '@/src/services/liveRouteTrail';
import {
  type NavigationRoute,
  type SharedTripRequest,
  useCancelSharedTripMutation,
  useCompleteSharedTripMutation,
  useCreateSharedTripMutation,
  useStartSharedTripMutation,
  useUpdateSharedTripMutation,
} from '@/src/services/navigationApi';
import {
  createDestinationPassTracker,
  DESTINATION_PROXIMITY_METERS,
  observeDestinationPass,
  projectPositionOnRoute,
  routeLengthMeters,
  splitRouteAtProjection,
  type DestinationPassTracker,
  type RouteCoordinate,
} from '@/src/services/navigationProgress';
import { formatRouteMetrics } from '@/src/services/navigationMetrics';
import { normalizeHeading } from '@/src/services/vehicleMarkerAssets';
import { vehicleBodyType } from '@/src/services/vehicleCategory';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const NAVIGATION_DEVIATION_METERS = 65;
const NAVIGATION_DEVIATION_SAMPLES = 3;
const NAVIGATION_ARRIVAL_SAMPLES = 3;
const NAVIGATION_MAX_ACCURACY_METERS = 50;
const NAVIGATION_MAX_FIX_AGE_MS = 5 * 60 * 1000;
const NAVIGATION_REROUTE_RETRY_MS = 2_000;

type RerouteReason = 'off-route' | 'destination-passed';

type NavigationEndpoints = {
  from: DirectionsLocation;
  to: DirectionsLocation;
};

export default function AllVehiclesMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  /**
   * The fleet map is a TAB, so it stays mounted while the operator is on
   * Vehicles, in a trip playback, or anywhere else. Its document is kept warm
   * for an instant return, but it stops being fed - otherwise it went on
   * animating live positions, and running its own camera, underneath whatever
   * screen was actually on top.
   */
  const isFocused = useIsFocused();
  const { colors: c, stateColors, autoFollowVehicle } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  // The header is transparent and floats over the map, so overlays have to
  // clear its *measured* height. Hard-coding `insets.top + 52` assumed a header
  // bar shorter than the one the navigator actually draws, which is why the
  // legend and the top of the toolbar ended up underneath it. The context value
  // already includes the top safe-area inset; the fallback covers the case of
  // this screen being rendered outside a navigator that provides a header.
  const contextHeaderHeight = useContext(HeaderHeightContext);
  const headerHeight = contextHeaderHeight ?? insets.top + (Platform.OS === 'ios' ? 44 : 56);
  const overlayTop = headerHeight + spacing.sm;
  const [legendHeight, setLegendHeight] = useState(0);
  const handleLegendLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height);
    setLegendHeight((current) => (current === next ? current : next));
  }, []);
  const mapRef = useRef<MapView>(null);
  const webMapRef = useRef<FleetWebMapHandle>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeLocateId, setActiveLocateId] = useState<number | null>(null);
  const [showDirections, setShowDirections] = useState(false);
  const [directionsRoute, setDirectionsRoute] = useState<NavigationRoute | null>(null);
  const [directionsRoutes, setDirectionsRoutes] = useState<NavigationRoute[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [directionsResetKey, setDirectionsResetKey] = useState(0);
  const [navigationEndpoints, setNavigationEndpoints] = useState<NavigationEndpoints | null>(null);
  const [navigationStatus, setNavigationStatus] = useState<DirectionsPanelStatus>('preview');
  const [navigationVehicleId, setNavigationVehicleId] = useState<number | null>(null);
  const [vehiclePickerOpen, setVehiclePickerOpen] = useState(false);
  const [navigationRouteId, setNavigationRouteId] = useState('');
  const [remainingPlannedRoute, setRemainingPlannedRoute] = useState<RouteCoordinate[]>([]);
  const [completedNavigationRoutes, setCompletedNavigationRoutes] = useState<RouteCoordinate[][]>([]);
  const [remainingDistanceMeters, setRemainingDistanceMeters] = useState<number | null>(null);
  const [remainingDurationSeconds, setRemainingDurationSeconds] = useState<number | null>(null);
  const [navigationFollow, setNavigationFollow] = useState(false);
  const [navigationMessage, setNavigationMessage] = useState('');
  const [rerouteReason, setRerouteReason] = useState<RerouteReason | null>(null);
  const [createSharedTrip, createSharedTripRequest] = useCreateSharedTripMutation();
  const [updateSharedTrip] = useUpdateSharedTripMutation();
  const [startSharedTrip] = useStartSharedTripMutation();
  const [completeSharedTrip] = useCompleteSharedTripMutation();
  const [cancelSharedTrip] = useCancelSharedTripMutation();
  const [sharedTripToken, setSharedTripToken] = useState<string | null>(null);
  const sharedTripTokenRef = useRef<string | null>(null);
  const updateSharedTripToken = useCallback((token: string | null) => {
    sharedTripTokenRef.current = token;
    setSharedTripToken(token);
  }, []);
  const activePlannedRouteRef = useRef<RouteCoordinate[]>([]);
  const progressMetersRef = useRef(0);
  const offRouteSamplesRef = useRef(0);
  const arrivalSamplesRef = useRef(0);
  const lastNavigationFixTimeRef = useRef(0);
  const lastCompletedPositionIdRef = useRef<number | null>(null);
  const completedRouteTailRef = useRef<RouteCoordinate | null>(null);
  const completedRouteOpenRef = useRef(false);
  const rerouteInFlightRef = useRef(false);
  const reroutePendingReasonRef = useRef<RerouteReason | null>(null);
  const rerouteGenerationRef = useRef(0);
  const lastRerouteAttemptAtRef = useRef(0);
  const destinationPassTrackerRef = useRef<DestinationPassTracker>(
    createDestinationPassTracker()
  );
  const activeRouteDistanceRef = useRef(0);

  const { data, isFetching, refetch } = useGetAllDevicesQuery();
  const listQuery = useGetDevicesQuery({ page: 0, size: 100 });
  // Zones are loaded on the Live Map itself, so they are redrawn on every
  // mount -- after a refresh, after navigating away and back, and on a cold
  // start -- rather than only existing in whatever created them.
  const geofenceQuery = useGetGeofencesQuery({ page: 0, size: 200 });

  const rawDevices = useMemo(() => {
    // Collapsed to one tracker per vehicle so a vehicle carrying two devices
    // gets a single marker and is counted once in the status strip.
    if (data && Array.isArray(data) && data.length > 0) return dedupeByVehicle(data);
    if (listQuery.data?.content && Array.isArray(listQuery.data.content)) {
      return dedupeByVehicle(listQuery.data.content);
    }
    return dedupeByVehicle(data ?? []);
  }, [data, listQuery.data?.content]);

  const { targetsRef, vehicleCount } = useFleetLivePositions(rawDevices);
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  const located = useMemo(() => {
    // vehicleCount is the render version emitted when the mutable live target
    // map changes; reading it here intentionally invalidates this projection.
    void vehicleCount;
    const unique = new Map<number, LocatedDevice>();
    for (const d of rawDevices) {
      if (unique.has(d.id)) continue;
      const target = targetsRef.current?.get(d.id);
      const lat = target ? target.latitude : d.latitude;
      const lng = target ? target.longitude : d.longitude;
      if (lat != null && lng != null && lat !== 0 && lng !== 0 && Number.isFinite(lat) && Number.isFinite(lng)) {
        unique.set(d.id, {
          ...d,
          latitude: lat,
          longitude: lng,
        } as LocatedDevice);
      }
    }
    return Array.from(unique.values());
  }, [rawDevices, targetsRef, vehicleCount]);

  // Located devices with status metadata from SSE.
  const liveDevices = useMemo<LocatedDevice[]>(
    () => {
      void vehicleCount;
      return located.map((d) => {
        const target = targetsRef.current?.get(d.id);
        const state = target?.state ?? d.state;
        return {
          ...d,
          state,
          // Canonical km/h straight from the backend. Never rescaled here.
          speed: target ? target.speedKmh : (d.speed ?? 0),
          accuracyMeters: target?.accuracyMeters ?? null,
          ignition: target?.ignition ?? d.ignition,
          gpsValid: target?.gpsValid ?? d.gpsValid,
          latitude: target ? target.latitude : d.latitude,
          longitude: target ? target.longitude : d.longitude,
          course: target?.heading ?? d.course ?? 0,
          // The GPS clock, not the arrival clock. Reporting when the packet
          // reached the app would make a vehicle replaying an old buffer look
          // permanently fresh, and would hide a tracker that has gone quiet.
          lastUpdate:
            target && target.sourceTime > 0
              ? new Date(target.sourceTime).toISOString()
              : d.lastUpdate,
        };
      });
    },
    [located, targetsRef, vehicleCount]
  );

  const mapGeofences = useMemo<WebMapGeofence[]>(
    () =>
      (geofenceQuery.data?.content ?? [])
        .filter((g) => g.active !== false && (g.type ?? '').toUpperCase() === 'CIRCLE')
        .map((g) => {
          // Stored GeoJSON-style: [longitude, latitude].
          const centre = g.coordinates?.[0];
          return {
            id: g.id,
            name: g.name,
            lat: centre?.[1] ?? Number.NaN,
            lng: centre?.[0] ?? Number.NaN,
            radius: g.radiusMeters ?? Number.NaN,
            color: g.color,
          };
        })
        .filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lng) && g.radius > 0),
    [geofenceQuery.data?.content]
  );

  const readiness = useMobileGpsReadiness();
  const statusCounts = useMemo(() => {
    const acc = { RUNNING: 0, STOPPED: 0, OFFLINE: 0 };
    for (const d of liveDevices) {
      // The same resolved status the markers and the vehicle list show.
      const st = resolveDeviceRecordState(d, readiness).state;
      if (st === 'RUNNING' || st === 'MOVING') acc.RUNNING += 1;
      else if (st === 'STOPPED' || st === 'IDLE' || st === 'IMMOBILISED') acc.STOPPED += 1;
      else acc.OFFLINE += 1;
    }
    return acc;
  }, [liveDevices, readiness]);

  useEffect(() => {
    if (selectedId != null && !located.some((device) => device.id === selectedId)) {
      // The owner-scoped mobile GPS source may not have a roster snapshot yet.
      // Keep its follow identity stable until its validated SSE target arrives.
      if (navigationStatus === 'navigating' && navigationVehicleId === selectedId) return;
      setSelectedId(null);
      setActiveLocateId(null);
    }
  }, [located, navigationStatus, navigationVehicleId, selectedId]);

  const selectedLive = useMemo(
    () => liveDevices.find((d) => d.id === selectedId) ?? null,
    [liveDevices, selectedId]
  );

  const activeLocatedVehicle = useMemo(
    () => liveDevices.find((device) => device.id === activeLocateId) ?? null,
    [activeLocateId, liveDevices]
  );

  const revokeSharedTrip = useCallback(async () => {
    const token = sharedTripTokenRef.current;
    updateSharedTripToken(null);
    if (!token) return;
    await cancelSharedTrip(token).unwrap().catch(() => undefined);
  }, [cancelSharedTrip, updateSharedTripToken]);

  const applyPreviewRoute = useCallback(
    (route: NavigationRoute, index: number, endpoints: NavigationEndpoints) => {
      const coordinates = navigationRouteCoordinates(route);
      if (coordinates.length < 2) return false;

      activePlannedRouteRef.current = coordinates;
      progressMetersRef.current = 0;
      offRouteSamplesRef.current = 0;
      arrivalSamplesRef.current = 0;
      destinationPassTrackerRef.current = createDestinationPassTracker();
      rerouteGenerationRef.current += 1;
      rerouteInFlightRef.current = false;
      reroutePendingReasonRef.current = null;
      lastRerouteAttemptAtRef.current = 0;
      activeRouteDistanceRef.current = routeLengthMeters(coordinates);
      completedRouteTailRef.current = null;
      completedRouteOpenRef.current = false;
      setDirectionsRoute(route);
      setSelectedRouteIndex(index);
      setNavigationEndpoints(endpoints);
      setNavigationStatus('preview');
      setNavigationVehicleId(null);
      setNavigationFollow(false);
      setNavigationMessage('');
      setRerouteReason(null);
      setCompletedNavigationRoutes([]);
      setRemainingPlannedRoute(coordinates);
      setRemainingDistanceMeters(route.distanceMeters);
      setRemainingDurationSeconds(route.durationSeconds);
      setNavigationRouteId(
        `${Date.now()}-${index}-${endpoints.from.latitude.toFixed(5)}-${endpoints.to.latitude.toFixed(5)}`
      );
      // The complete route should remain visible while it is being reviewed.
      setActiveLocateId(null);
      return true;
    },
    []
  );

  const handleRoutesCalculated = useCallback(
    (routes: NavigationRoute[], from: DirectionsLocation, to: DirectionsLocation) => {
      const validRoutes = routes
        .filter((route) => navigationRouteCoordinates(route).length >= 2)
        .slice(0, 3);
      if (validRoutes.length === 0) return;
      setDirectionsRoutes(validRoutes);
      applyPreviewRoute(validRoutes[0], 0, { from, to });
    },
    [applyPreviewRoute]
  );

  const selectDirectionsRoute = useCallback(
    (index: number) => {
      const route = directionsRoutes[index];
      if (!route || !navigationEndpoints || index === selectedRouteIndex) return;
      if (!applyPreviewRoute(route, index, navigationEndpoints)) return;
      const deviceId = navigationVehicleId ?? readiness.deviceId;
      if (sharedTripToken && deviceId != null) {
        void updateSharedTrip({
          token: sharedTripToken,
          body: sharedTripRequestOf(
            deviceId, route, navigationEndpoints.to, navigationStatus === 'navigating'
          ),
        }).unwrap().catch(() => {
          updateSharedTripToken(null);
          setNavigationMessage('Route selected. Share again to create a fresh live link.');
        });
      }
    },
    [
      applyPreviewRoute,
      directionsRoutes,
      navigationEndpoints,
      navigationStatus,
      navigationVehicleId,
      readiness.deviceId,
      selectedRouteIndex,
      sharedTripToken,
      updateSharedTripToken,
      updateSharedTrip,
    ]
  );

  const clearPreviewRoute = useCallback(() => {
    activePlannedRouteRef.current = [];
    progressMetersRef.current = 0;
    offRouteSamplesRef.current = 0;
    arrivalSamplesRef.current = 0;
    destinationPassTrackerRef.current = createDestinationPassTracker();
    rerouteGenerationRef.current += 1;
    rerouteInFlightRef.current = false;
    reroutePendingReasonRef.current = null;
    lastRerouteAttemptAtRef.current = 0;
    lastNavigationFixTimeRef.current = 0;
    lastCompletedPositionIdRef.current = null;
    completedRouteTailRef.current = null;
    completedRouteOpenRef.current = false;
    setDirectionsRoute(null);
    setDirectionsRoutes([]);
    setSelectedRouteIndex(0);
    setNavigationEndpoints(null);
    setNavigationStatus('preview');
    setNavigationVehicleId(null);
    setNavigationFollow(false);
    setNavigationRouteId('');
    setRemainingPlannedRoute([]);
    setCompletedNavigationRoutes([]);
    setRemainingDistanceMeters(null);
    setRemainingDurationSeconds(null);
    setNavigationMessage('');
    setRerouteReason(null);
    void revokeSharedTrip();
  }, [revokeSharedTrip]);

  const planAnotherRoute = useCallback(() => {
    activePlannedRouteRef.current = [];
    progressMetersRef.current = 0;
    offRouteSamplesRef.current = 0;
    arrivalSamplesRef.current = 0;
    destinationPassTrackerRef.current = createDestinationPassTracker();
    rerouteGenerationRef.current += 1;
    rerouteInFlightRef.current = false;
    reroutePendingReasonRef.current = null;
    lastRerouteAttemptAtRef.current = 0;
    lastNavigationFixTimeRef.current = 0;
    lastCompletedPositionIdRef.current = null;
    completedRouteTailRef.current = null;
    completedRouteOpenRef.current = false;
    setNavigationStatus('preview');
    setNavigationVehicleId(null);
    setNavigationFollow(false);
    setDirectionsRoute(null);
    setDirectionsRoutes([]);
    setSelectedRouteIndex(0);
    setNavigationEndpoints(null);
    setNavigationRouteId('');
    setRemainingPlannedRoute([]);
    setCompletedNavigationRoutes([]);
    setRemainingDistanceMeters(null);
    setRemainingDurationSeconds(null);
    setNavigationMessage('');
    setRerouteReason(null);
    updateSharedTripToken(null);
  }, [updateSharedTripToken]);

  const startNavigation = useCallback((chosenDeviceId: number | null) => {
    if (!directionsRoute || !navigationEndpoints) return;
    const deviceId = chosenDeviceId ?? readiness.deviceId;
    const target = deviceId == null ? undefined : targetsRef.current.get(deviceId);
    // Do not reinterpret the snapshot already on screen as a newly travelled
    // navigation segment. Progress begins with the next accepted SSE fix.
    lastNavigationFixTimeRef.current = target?.sourceTime ?? 0;
    lastCompletedPositionIdRef.current = target?.positionId ?? null;
    completedRouteTailRef.current = null;
    completedRouteOpenRef.current = false;
    offRouteSamplesRef.current = 0;
    arrivalSamplesRef.current = 0;
    destinationPassTrackerRef.current = createDestinationPassTracker();
    rerouteGenerationRef.current += 1;
    rerouteInFlightRef.current = false;
    reroutePendingReasonRef.current = null;
    lastRerouteAttemptAtRef.current = 0;
    progressMetersRef.current = 0;
    setCompletedNavigationRoutes([]);
    setRemainingPlannedRoute(activePlannedRouteRef.current);
    setRemainingDistanceMeters(directionsRoute.distanceMeters);
    setRemainingDurationSeconds(directionsRoute.durationSeconds);
    setNavigationVehicleId(deviceId);
    setNavigationStatus('navigating');
    setNavigationFollow(true);
    setRerouteReason(null);
    setShowDirections(false);
    if (deviceId != null) {
      setSelectedId(deviceId);
      setActiveLocateId(deviceId);
    }
    setNavigationMessage(
      readiness.locationDisabled
        ? 'Navigation is ready. Enable GPS to receive live position updates.'
        : deviceId == null
          ? 'Navigation is ready. Waiting for the registered mobile GPS stream.'
          : target && target.sourceTime > 0 && Date.now() - target.sourceTime <= NAVIGATION_MAX_FIX_AGE_MS
        ? 'Following validated live GPS'
        : 'Waiting for a fresh validated GPS update'
    );
    if (sharedTripToken) {
      void startSharedTrip(sharedTripToken).unwrap().catch(() => {
        updateSharedTripToken(null);
        setNavigationMessage('Navigation started. Share again to create a fresh live link.');
      });
    }
  }, [
    directionsRoute,
    navigationEndpoints,
    readiness.deviceId,
    readiness.locationDisabled,
    sharedTripToken,
    startSharedTrip,
    targetsRef,
    updateSharedTripToken,
  ]);

  /**
   * The fleet, ordered by how close each vehicle is to the route's start.
   *
   * Whoever is nearest the pick-up is nearly always the answer, so the list
   * opens on it rather than on whatever order the roster happened to arrive in.
   */
  const navigationVehicleOptions = useMemo<NavigationVehicleOption[]>(() => {
    const start = navigationEndpoints?.from;
    return liveDevices
      .map((device) => ({
        ...device,
        metresFromStart: start
          ? haversineKm(start.latitude, start.longitude, device.latitude, device.longitude) * 1000
          : -1,
      }))
      .sort((a, b) => {
        if (a.id === readiness.deviceId) return -1;
        if (b.id === readiness.deviceId) return 1;
        return a.metresFromStart - b.metresFromStart;
      });
  }, [liveDevices, navigationEndpoints?.from, readiness.deviceId]);

  const confirmVehicleAndStart = useCallback(
    (deviceId: number) => {
      setVehiclePickerOpen(false);
      startNavigation(deviceId);
    },
    [startNavigation]
  );

  /**
   * Start asks who is driving first.
   *
   * With exactly one candidate there is no question to ask, so it is not asked.
   */
  const requestNavigationStart = useCallback(() => {
    if (navigationVehicleOptions.length === 1) {
      startNavigation(navigationVehicleOptions[0].id);
      return;
    }
    if (navigationVehicleOptions.length === 0) {
      startNavigation(null);
      return;
    }
    setVehiclePickerOpen(true);
  }, [navigationVehicleOptions, startNavigation]);

  // MobileGpsTrackingGate may finish its owner-scoped bootstrap just after the
  // route is started. Bind that device as soon as it becomes available; the
  // user never has to choose a fleet marker and no other tenant/device can be
  // substituted as the navigation source.
  useEffect(() => {
    if (
      navigationStatus !== 'navigating' ||
      navigationVehicleId != null ||
      readiness.deviceId == null
    ) {
      return;
    }
    const deviceId = readiness.deviceId;
    const target = targetsRef.current.get(deviceId);
    lastNavigationFixTimeRef.current = target?.sourceTime ?? 0;
    lastCompletedPositionIdRef.current = target?.positionId ?? null;
    setNavigationVehicleId(deviceId);
    setSelectedId(deviceId);
    setActiveLocateId(deviceId);
    setNavigationMessage(
      readiness.locationDisabled
        ? 'Navigation is ready. Enable GPS to receive live position updates.'
        : 'Waiting for a fresh validated GPS update'
    );
  }, [
    navigationStatus,
    navigationVehicleId,
    readiness.deviceId,
    readiness.locationDisabled,
    targetsRef,
  ]);

  const rerouteFromPosition = useCallback(
    async (latitude: number, longitude: number, reason: RerouteReason) => {
      if (!navigationEndpoints || rerouteInFlightRef.current) return;
      const requestGeneration = ++rerouteGenerationRef.current;
      const destination = navigationEndpoints.to;
      rerouteInFlightRef.current = true;
      reroutePendingReasonRef.current = reason;
      lastRerouteAttemptAtRef.current = Date.now();
      setRerouteReason(reason);
      setNavigationMessage(
        reason === 'destination-passed'
          ? 'Destination passed. Rerouting…'
          : 'Route deviation confirmed. Rerouting…'
      );

      // Remove the previous plan before requesting its replacement. A stale
      // route and stale ETA must not remain visible during a pending reroute.
      activePlannedRouteRef.current = [];
      activeRouteDistanceRef.current = 0;
      progressMetersRef.current = 0;
      offRouteSamplesRef.current = 0;
      arrivalSamplesRef.current = 0;
      setDirectionsRoutes([]);
      setRemainingPlannedRoute([]);
      setRemainingDistanceMeters(null);
      setRemainingDurationSeconds(null);
      setNavigationRouteId(`${Date.now()}-rerouting-${requestGeneration}`);

      try {
        // Rerouting uses the same on-device planner as the original route.
        // Leaving this on the old keyed service would have meant a wrong turn
        // silently falling back to the provider the rest of the screen no
        // longer uses - and failing wherever that provider is unavailable.
        const planned = await planRoute({
          from: { latitude, longitude },
          to: { latitude: destination.latitude, longitude: destination.longitude },
        });
        const nextRoute = {
          distanceMeters: planned.distanceMeters,
          durationSeconds: planned.durationSeconds,
          coordinates: planned.coordinates,
        };
        const coordinates = navigationRouteCoordinates(nextRoute);
        if (coordinates.length < 2) throw new Error('No route geometry');
        if (requestGeneration !== rerouteGenerationRef.current) return;

        // Replace, never append, the remaining provider route. The completed
        // journey remains composed exclusively of accepted road-match runs.
        activePlannedRouteRef.current = coordinates;
        progressMetersRef.current = 0;
        activeRouteDistanceRef.current = routeLengthMeters(coordinates);
        reroutePendingReasonRef.current = null;
        setDirectionsRoute(nextRoute);
        setDirectionsRoutes([nextRoute]);
        setSelectedRouteIndex(0);
        setNavigationEndpoints((current) =>
          current
            ? {
                ...current,
                from: {
                  ...current.from,
                  id: `live-position-${requestGeneration}`,
                  name: 'Latest vehicle position',
                  formatted: 'Latest vehicle position',
                  latitude,
                  longitude,
                  source: 'device',
                },
              }
            : current
        );
        setRemainingPlannedRoute(coordinates);
        setRemainingDistanceMeters(nextRoute.distanceMeters);
        setRemainingDurationSeconds(nextRoute.durationSeconds);
        setNavigationRouteId(`${Date.now()}-reroute-${requestGeneration}`);
        setRerouteReason(null);
        setNavigationMessage('Route updated from the latest validated vehicle location');
        if (sharedTripToken && navigationVehicleId != null) {
          void updateSharedTrip({
            token: sharedTripToken,
            body: sharedTripRequestOf(
              navigationVehicleId, nextRoute, destination, true
            ),
          }).unwrap().catch(() => {
            updateSharedTripToken(null);
            setNavigationMessage('Route updated. Share again to create a fresh live link.');
          });
        }
      } catch {
        if (requestGeneration !== rerouteGenerationRef.current) return;
        // Keep the stale route removed. The next trusted fix retries from its
        // newer coordinate while retaining the original destination.
        setNavigationMessage('Unable to reroute yet. Retrying from the latest validated position.');
      } finally {
        if (requestGeneration === rerouteGenerationRef.current) {
          offRouteSamplesRef.current = 0;
          rerouteInFlightRef.current = false;
        }
      }
    },
    [
      navigationEndpoints,
      navigationVehicleId,
      sharedTripToken,
      updateSharedTripToken,
      updateSharedTrip,
    ]
  );

  useEffect(() => {
    if (
      navigationStatus !== 'navigating' ||
      navigationVehicleId == null ||
      !navigationEndpoints ||
      !directionsRoute
    ) {
      return;
    }
    const target = targetsRef.current.get(navigationVehicleId);
    if (!target) return;

    const trustedTarget =
      target.gpsValid &&
      target.sourceTime > 0 &&
      Date.now() - target.sourceTime <= NAVIGATION_MAX_FIX_AGE_MS &&
      (target.accuracyMeters == null ||
        (Number.isFinite(target.accuracyMeters) &&
          target.accuracyMeters <= NAVIGATION_MAX_ACCURACY_METERS)) &&
      Number.isFinite(target.latitude) &&
      Number.isFinite(target.longitude) &&
      Math.abs(target.latitude) <= 90 &&
      Math.abs(target.longitude) <= 180 &&
      !(target.latitude === 0 && target.longitude === 0);

    // Preserve only real backend road geometry as the completed journey. This
    // sits before the timestamp guard because an older backend may enrich an
    // already-seen POSITION with a ROAD_MATCH frame carrying the same GPS time.
    if (
      trustedTarget &&
      target.positionId != null &&
      target.positionId !== lastCompletedPositionIdRef.current
    ) {
      const previousTail = completedRouteOpenRef.current
        ? completedRouteTailRef.current
        : null;
      const geometry = safeMatchedGeometry(
        target.matchedGeometry,
        previousTail
          ? { latitude: previousTail[1], longitude: previousTail[0] }
          : null,
        { latitude: target.latitude, longitude: target.longitude },
        previousTail == null
      ).map(
        ({ latitude, longitude }) => [longitude, latitude] as RouteCoordinate
      );
      if (geometry.length >= 2) {
        // Mark the fix complete only once its road geometry is present. An
        // older two-stage backend may first publish POSITION with no geometry,
        // then enrich that same positionId with ROAD_MATCH.
        lastCompletedPositionIdRef.current = target.positionId;
        const startNewRun = previousTail == null;
        completedRouteTailRef.current = geometry[geometry.length - 1];
        completedRouteOpenRef.current = true;
        setCompletedNavigationRoutes((runs) =>
          appendCompletedRouteRun(runs, geometry, startNewRun)
        );
      } else if (target.matchedSource != null) {
        // No accepted road answer for this physical stretch. Close the run so
        // a later match cannot draw a chord across the unobserved gap. A null
        // source is the legacy two-stage backend's still-pending POSITION and
        // stays open until its ROAD_MATCH enrichment arrives.
        completedRouteOpenRef.current = false;
      }
    }

    if (target.sourceTime <= lastNavigationFixTimeRef.current) return;
    lastNavigationFixTimeRef.current = target.sourceTime;

    // This is intentionally stricter than merely having numbers. The fleet
    // stream already rejected duplicates, out-of-order packets, impossible
    // jumps and stationary drift; navigation additionally refuses stale or
    // poor-accuracy targets before they can affect progress or arrival.
    if (!trustedTarget) {
      setNavigationMessage('Ignored an untrusted GPS update; holding the last valid position');
      return;
    }

    const pendingReroute = reroutePendingReasonRef.current;
    if (pendingReroute) {
      if (
        !rerouteInFlightRef.current &&
        Date.now() - lastRerouteAttemptAtRef.current >= NAVIGATION_REROUTE_RETRY_MS
      ) {
        void rerouteFromPosition(target.latitude, target.longitude, pendingReroute);
      }
      return;
    }

    setNavigationMessage('Following validated live GPS');

    const destinationDistance =
      haversineKm(
        target.latitude,
        target.longitude,
        navigationEndpoints.to.latitude,
        navigationEndpoints.to.longitude
      ) * 1000;

    const vehicleIsMoving = target.moving || target.speedKmh >= 2.5;
    const destinationObservation = observeDestinationPass(
      destinationPassTrackerRef.current,
      destinationDistance,
      vehicleIsMoving
    );
    destinationPassTrackerRef.current = destinationObservation.tracker;
    if (destinationObservation.passed) {
      arrivalSamplesRef.current = 0;
      void rerouteFromPosition(
        target.latitude,
        target.longitude,
        'destination-passed'
      );
      return;
    }

    if (
      destinationDistance <= DESTINATION_PROXIMITY_METERS &&
      !vehicleIsMoving
    ) {
      arrivalSamplesRef.current += 1;
      if (arrivalSamplesRef.current >= NAVIGATION_ARRIVAL_SAMPLES) {
        setNavigationStatus('arrived');
        setNavigationFollow(false);
        setRemainingPlannedRoute([]);
        setRemainingDistanceMeters(0);
        setRemainingDurationSeconds(0);
        setNavigationMessage('Destination reached with confirmed live GPS samples');
        setShowDirections(true);
        if (sharedTripToken) {
          void completeSharedTrip(sharedTripToken).unwrap().catch(() => undefined);
        }
        return;
      }
    } else {
      arrivalSamplesRef.current = 0;
    }

    const projection = projectPositionOnRoute(
      activePlannedRouteRef.current,
      { latitude: target.latitude, longitude: target.longitude },
      progressMetersRef.current
    );
    if (!projection) return;
    if (projection.distanceToRouteMeters > NAVIGATION_DEVIATION_METERS) {
      offRouteSamplesRef.current += 1;
      setNavigationMessage(
        `Checking route deviation (${offRouteSamplesRef.current}/${NAVIGATION_DEVIATION_SAMPLES})`
      );
      if (offRouteSamplesRef.current >= NAVIGATION_DEVIATION_SAMPLES) {
        void rerouteFromPosition(target.latitude, target.longitude, 'off-route');
      }
      return;
    }

    offRouteSamplesRef.current = 0;
    progressMetersRef.current = Math.max(progressMetersRef.current, projection.alongRouteMeters);
    const split = splitRouteAtProjection(activePlannedRouteRef.current, projection);
    const remainingGeometryMeters = routeLengthMeters(split.remaining);
    const totalGeometryMeters = Math.max(1, activeRouteDistanceRef.current);
    const remainingFraction = Math.min(1, remainingGeometryMeters / totalGeometryMeters);
    setRemainingPlannedRoute(split.remaining);
    // Both values remain projections of the selected Geoapify route object.
    // Geometry determines progress only; it never invents an ETA or replaces
    // the provider's routed road distance/duration.
    setRemainingDistanceMeters(directionsRoute.distanceMeters * remainingFraction);
    setRemainingDurationSeconds(directionsRoute.durationSeconds * remainingFraction);
  }, [
    directionsRoute,
    navigationEndpoints,
    navigationStatus,
    navigationVehicleId,
    completeSharedTrip,
    rerouteFromPosition,
    sharedTripToken,
    targetsRef,
    vehicleCount,
  ]);

  const navigationOverlay = useMemo<WebMapNavigationOverlay | null>(() => {
    if (!directionsRoute || !navigationEndpoints || !navigationRouteId) return null;
    return {
      routeId: navigationRouteId,
      fitRoute: navigationStatus === 'preview',
      completedRoutes: navigationStatus === 'arrived' ? completedNavigationRoutes : [],
      remainingRoute: remainingPlannedRoute,
      alternativeRoutes:
        navigationStatus === 'preview'
          ? directionsRoutes
              .map((route, index) => ({
                index,
                coordinates: navigationRouteCoordinates(route),
              }))
              .filter((route) => route.index !== selectedRouteIndex)
              .map((route, alternativeIndex) => ({
                ...route,
                color: [
                  PREMIUM_FLEET_MAP_PALETTE.alternativeRouteGray,
                  PREMIUM_FLEET_MAP_PALETTE.alternativeRouteBlue,
                  PREMIUM_FLEET_MAP_PALETTE.alternativeRouteSlate,
                ][alternativeIndex] ?? PREMIUM_FLEET_MAP_PALETTE.alternativeRouteGray,
              }))
          : [],
      routeLabels:
        navigationStatus === 'preview'
          ? directionsRoutes.flatMap((route, index) => {
              const coordinates = navigationRouteCoordinates(route);
              const point = coordinates[Math.floor(coordinates.length / 2)];
              if (!point) return [];
              return [{
                index,
                lng: point[0],
                lat: point[1],
                label: formatRouteMetrics(route.distanceMeters, route.durationSeconds),
                selected: index === selectedRouteIndex,
              }];
            })
          : [],
      start: {
        lat: navigationEndpoints.from.latitude,
        lng: navigationEndpoints.from.longitude,
      },
      destination: {
        lat: navigationEndpoints.to.latitude,
        lng: navigationEndpoints.to.longitude,
      },
    };
  }, [
    completedNavigationRoutes,
    directionsRoute,
    directionsRoutes,
    navigationEndpoints,
    navigationRouteId,
    navigationStatus,
    remainingPlannedRoute,
    selectedRouteIndex,
  ]);

  useEffect(() => {
    if (autoFollowVehicle && activeLocatedVehicle && mapRef.current) {
      mapRef.current.animateCamera({
        center: {
          latitude: activeLocatedVehicle.latitude,
          longitude: activeLocatedVehicle.longitude,
        },
        zoom: 15.2,
      }, { duration: 800 });
    }
  }, [activeLocatedVehicle, autoFollowVehicle]);

  useEffect(() => {
    if (navigationStatus === 'navigating' && navigationFollow) {
      webMapRef.current?.recenterNavigation();
    }
  }, [navigationFollow, navigationStatus]);

  const webMarkers = useMemo<WebMapMarker[]>(
    () => {
      const markers = liveDevices.map((d) => {
        const resolved = resolveDeviceRecordState(d, readiness);
        return {
          id: d.id,
          lat: d.latitude,
          lng: d.longitude,
          color: stateColors[resolved.state] ?? stateColors.NO_DATA ?? '#475569',
          heading: d.course,
          category: vehicleBodyType(d.category),
          label: d.name,
          moving: resolved.state === 'RUNNING' && (d.speed ?? 0) > 0,
          speedKph: d.speed ?? 0,
          sourceTime: d.lastUpdate ? Date.parse(d.lastUpdate) : 0,
        };
      });
      if (
        navigationStatus === 'navigating' &&
        navigationVehicleId != null &&
        !markers.some((marker) => Number(marker.id) === navigationVehicleId)
      ) {
        const target = targetsRef.current.get(navigationVehicleId);
        if (target) {
          // This is the backend's validated/map-matched display coordinate from
          // SSE. It is never projected onto the planned route in the client.
          markers.push({
            id: navigationVehicleId,
            lat: target.latitude,
            lng: target.longitude,
            color: stateColors[target.state] ?? stateColors.NO_DATA ?? '#475569',
            heading: target.heading,
            category: vehicleBodyType(
              rawDevices.find((device) => device.id === navigationVehicleId)?.category
            ),
            label: 'My current location',
            moving: target.moving,
            speedKph: target.speedKmh,
            sourceTime: target.sourceTime,
          });
        }
      }
      return markers;
    },
    [
      liveDevices,
      navigationStatus,
      navigationVehicleId,
      rawDevices,
      readiness,
      stateColors,
      targetsRef,
    ]
  );

  const mapPreferences: MapPreferences = DEFAULT_MAP_PREFERENCES;
  // One light OpenFreeMap/MapLibre scene on every platform. There is no map
  // type state to drift between screens or cover the map with another picker.
  const mapStyleInfo = getMapStyleInfo('street');
  const useNativeMap = false;

  const [manualRefreshing, setManualRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    try {
      setManualRefreshing(true);
      await Promise.all([refetch(), listQuery.refetch()]);
    } catch {
      // ignore
    } finally {
      setTimeout(() => setManualRefreshing(false), 500);
    }
  }, [refetch, listQuery]);

  const toggleDirections = useCallback(() => {
    setShowDirections((visible) => !visible);
    if (navigationStatus === 'preview') setActiveLocateId(null);
  }, [navigationStatus]);

  const handleMapInteraction = useCallback(() => {
    if (navigationStatus === 'navigating') setNavigationFollow(false);
  }, [navigationStatus]);

  const recenterNavigation = useCallback(() => {
    if (navigationStatus !== 'navigating' || navigationVehicleId == null) return;
    setSelectedId(navigationVehicleId);
    setActiveLocateId(navigationVehicleId);
    setNavigationFollow(true);
  }, [navigationStatus, navigationVehicleId]);

  const shareNavigation = useCallback(async () => {
    const deviceId = navigationVehicleId ?? readiness.deviceId;
    if (!directionsRoute || !navigationEndpoints || deviceId == null) {
      Alert.alert(
        'Live location unavailable',
        'A registered mobile GPS tracker is needed to share this live trip.'
      );
      return;
    }
    try {
      let token = sharedTripToken;
      if (!token) {
        const created = await createSharedTrip(
          sharedTripRequestOf(
            deviceId,
            directionsRoute,
            navigationEndpoints.to,
            navigationStatus === 'navigating'
          )
        ).unwrap();
        token = created.token;
        updateSharedTripToken(token);
      }
      const url = sharedTripUrl(token);
      await Share.share({
        title: 'Glivt live trip',
        message: `Follow this live Glivt trip: ${url}`,
        ...(Platform.OS === 'ios' ? { url } : {}),
      });
    } catch {
      Alert.alert('Unable to share', 'A secure live-trip link could not be created. Try again.');
    }
  }, [
    createSharedTrip,
    directionsRoute,
    navigationEndpoints,
    navigationStatus,
    navigationVehicleId,
    readiness.deviceId,
    sharedTripToken,
    updateSharedTripToken,
  ]);

  const confirmCancelNavigation = useCallback(() => {
    Alert.alert(
      navigationStatus === 'navigating' ? 'Cancel current trip?' : 'Clear directions?',
      navigationStatus === 'navigating'
        ? 'Only navigation will stop. Live GPS and fleet tracking will keep running.'
        : 'The route preview and its locations will be removed.',
      [
        { text: 'Keep trip', style: 'cancel' },
        {
          text: navigationStatus === 'navigating' ? 'Cancel trip' : 'Clear',
          style: 'destructive',
          onPress: () => {
            clearPreviewRoute();
            setDirectionsResetKey((key) => key + 1);
            setShowDirections(false);
            setActiveLocateId(null);
          },
        },
      ]
    );
  }, [clearPreviewRoute, navigationStatus]);

  const focusNative = useCallback((device: DeviceSummary) => {
    if (device?.latitude == null || device?.longitude == null) return;
    mapRef.current?.animateCamera({
      center: { latitude: device.latitude, longitude: device.longitude },
      zoom: 15.2,
      heading: -8,
      pitch: 48,
    }, { duration: 650 });
  }, []);

  const locateMe = useCallback(() => {
    if (navigationStatus === 'navigating' && navigationVehicleId != null) {
      recenterNavigation();
      return;
    }
    if (!selectedLive) {
      Alert.alert('Select a vehicle', 'Tap a vehicle marker first, then use Locate Me.');
      return;
    }

    // A single id owns the locate/follow camera. Replacing it atomically drops
    // the previous vehicle before focusing the newly selected live position.
    setActiveLocateId(selectedLive.id);
    if (useNativeMap) {
      focusNative(selectedLive);
    } else {
      webMapRef.current?.focusMarker(selectedLive.id);
    }
  }, [focusNative, navigationStatus, navigationVehicleId, recenterNavigation, selectedLive, useNativeMap]);

  const fitAll = useCallback(() => {
    if (navigationStatus === 'navigating') setNavigationFollow(false);
    setActiveLocateId(null);
    if (useNativeMap) {
      if (located.length === 0) return;
      const coords = located.map((d) => ({
        latitude: d.latitude,
        longitude: d.longitude
      }));
      // Keep the fitted bounds clear of the floating header, the legend under
      // it and the tab bar, so "fit all" never parks a vehicle behind chrome.
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: {
          top: Math.round(overlayTop + legendHeight + spacing.md),
          right: 60,
          bottom: 220,
          left: 60,
        },
        animated: true,
      });
    } else {
      webMapRef.current?.fitAll();
    }
  }, [useNativeMap, located, navigationStatus, overlayTop, legendHeight]);

  const selectById = useCallback(
    (id: string | number) => {
      const device = located.find((candidate) => String(candidate.id) === String(id))
        || rawDevices.find((candidate) => String(candidate.id) === String(id));
      const targetId = device ? device.id : id;
      if (targetId == null) return;

      const numericId = Number(targetId);
      if (!Number.isSafeInteger(numericId)) return;

      if (navigationStatus === 'navigating' && navigationVehicleId != null) {
        if (numericId !== navigationVehicleId) {
          Alert.alert(
            'Navigation is active',
            'Finish the current live navigation before selecting a different vehicle.'
          );
        } else {
          recenterNavigation();
        }
        return;
      }

      // First tap selects exactly one vehicle for Locate Me. Repeating the tap
      // opens Live Tracking for it — the details page it used to open was a
      // slower copy of what this map already shows, and is gone.
      if (selectedIdRef.current === numericId) {
        const vehicle = rawDevices.find((device) => device.id === numericId);
        router.push({
          pathname: '/live-track',
          params: {
            deviceId: String(numericId),
            name: vehicle?.vehicleName || vehicle?.name || `Vehicle ${numericId}`,
            subtitle: vehicle?.address ?? '',
            category: vehicle?.category ?? '',
          },
        });
        return;
      }

      setActiveLocateId(null);
      setSelectedId(numericId);
    },
    [located, navigationStatus, navigationVehicleId, rawDevices, recenterNavigation, router]
  );

  const clearSelection = useCallback(() => {
    if (navigationStatus === 'navigating') return;
    setActiveLocateId(null);
    setSelectedId(null);
  }, [navigationStatus]);
  const handleVisibleIdsChange = useCallback((visibleIds: string[]) => { }, []);
  const controlsTop =
    located.length > 0 && legendHeight > 0
      ? overlayTop + legendHeight + spacing.sm
      : overlayTop;
  /**
   * What this screen draws over its own map.
   *
   * The follow camera frames the selected vehicle inside what is left, so
   * "Locate me" can never park it behind the header, the fleet legend or the
   * tab bar - and "Fit all" fits the fleet into the visible strip rather than
   * into the container.
   */
  const mapViewportPadding = useMemo(
    () => ({
      top: controlsTop,
      bottom: insets.bottom + (directionsRoute ? 168 : 82),
      left: spacing.md,
      right: spacing.md,
    }),
    [controlsTop, directionsRoute, insets.bottom]
  );
  return (
    <SafeAreaView edges={['bottom']} style={styles.screen}>
      {useNativeMap ? (
        <NativeFleetMap
          mapRef={mapRef}
          devices={liveDevices}
          geofences={mapGeofences}
          mapStyle={mapStyleInfo.style}
          mapPreferences={mapPreferences}
          onClearSelection={clearSelection}
          onFitAll={fitAll}
          onSelectDevice={selectById}
          onVisibleIdsChange={handleVisibleIdsChange}
          selectedId={selectedId}
          targetsRef={targetsRef}
        />
      ) : (
        <FleetWebMap
          ref={webMapRef}
          cameraMode={navigationStatus === 'navigating' ? 'chase' : 'follow'}
          geofences={mapGeofences}
          mapStyle={mapStyleInfo.webStyle}
          premiumVectorTheme
          markers={webMarkers}
          navigation={navigationOverlay}
          onClearSelection={clearSelection}
          onInteraction={handleMapInteraction}
          onSelectNavigationRoute={selectDirectionsRoute}
          onSelect={selectById}
          onVisibleIdsChange={handleVisibleIdsChange}
          followSelected={
            navigationStatus === 'navigating'
              ? navigationFollow && navigationVehicleId != null && navigationVehicleId === selectedId
              : navigationOverlay == null &&
                autoFollowVehicle &&
                activeLocateId != null &&
                activeLocateId === selectedId
          }
          selectedId={selectedId}
          style={StyleSheet.absoluteFillObject}
          viewportPadding={mapViewportPadding}
          active={isFocused}
        />
      )}

      <NavigationVehiclePicker
        onCancel={() => setVehiclePickerOpen(false)}
        onSelect={confirmVehicleAndStart}
        ownDeviceId={readiness.deviceId}
        vehicles={navigationVehicleOptions}
        visible={vehiclePickerOpen}
      />

      <View pointerEvents="none" style={styles.mapVignette} />

      {/* Fleet status, always on screen. It used to live in a panel behind a
          toggle, which meant the one number an operator checks constantly cost
          a tap and covered a quarter of the map to read. */}
      {located.length > 0 ? (
        <View
          onLayout={handleLegendLayout}
          pointerEvents="none"
          style={[styles.statusStrip, { top: overlayTop }]}>
          {STATUS_SEGMENTS.map(({ key, label }) => (
            <View key={key} style={styles.statusSegment}>
              <View style={[styles.stripDot, { backgroundColor: stateColors[key] ?? c.textMuted }]} />
              <Text style={styles.stripValue}>{statusCounts[key] ?? 0}</Text>
              <Text style={styles.stripLabel}>{label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <DirectionsPanel
        bottom={insets.bottom + (directionsRoute ? 158 : 72)}
        navigationMessage={navigationMessage}
        onClose={() => setShowDirections(false)}
        onRoutesCalculated={handleRoutesCalculated}
        onRouteCleared={clearPreviewRoute}
        onSelectRoute={selectDirectionsRoute}
        onPlanAnotherRoute={planAnotherRoute}
        remainingDistanceMeters={remainingDistanceMeters}
        remainingDurationSeconds={remainingDurationSeconds}
        resetKey={directionsResetKey}
        route={directionsRoute}
        routeOptions={directionsRoutes}
        selectedRouteIndex={selectedRouteIndex}
        status={navigationStatus}
        visible={showDirections}
      />

      {directionsRoute ? (
        <NavigationDrivePanel
          bottom={insets.bottom + 72}
          canStart={Boolean(navigationEndpoints)}
          onCancel={confirmCancelNavigation}
          onShare={shareNavigation}
          onStart={requestNavigationStart}
          remainingDistanceMeters={remainingDistanceMeters}
          remainingDurationSeconds={remainingDurationSeconds}
          rerouting={rerouteReason != null}
          route={directionsRoute}
          sharing={createSharedTripRequest.isLoading}
          status={navigationStatus}
        />
      ) : null}

      {/* One slab of icon buttons rather than five labelled pills down the
          edge: same actions, a fraction of the map covered. The rail stacks
          under the legend rather than beside it, so neither has to be clipped
          on a narrow screen and both share the same right margin. */}
      <View
        style={[
          styles.railRight,
          { top: controlsTop },
        ]}>
        <RailButton
          icon="refresh"
          label="Refresh"
          loading={isFetching || listQuery.isFetching || manualRefreshing}
          onPress={handleRefresh}
        />
        <View style={styles.railDivider} />
        <RailButton icon="crosshairs-gps" label="Locate me" onPress={locateMe} />
        <View style={styles.railDivider} />
        <RailButton icon="fit-to-page-outline" label="Fit all" onPress={fitAll} />
        <View style={styles.railDivider} />
        <RailButton icon="directions" label="Directions" onPress={toggleDirections} />
      </View>

      {navigationStatus === 'navigating' && !navigationFollow ? (
        <Pressable
          accessibilityLabel="Recenter live navigation"
          accessibilityRole="button"
          onPress={recenterNavigation}
          style={({ pressed }) => [
            styles.recenterButton,
            { bottom: insets.bottom + (directionsRoute ? 158 : 72) },
            pressed && styles.railButtonPressed,
          ]}>
          <MaterialCommunityIcons color={c.textPrimary} name="navigation-variant" size={19} />
          <Text style={styles.recenterText}>Recenter</Text>
        </Pressable>
      ) : null}

      {rerouteReason ? (
        <View
          pointerEvents="none"
          style={[
            styles.reroutePill,
            { bottom: insets.bottom + (directionsRoute ? 158 : 72) },
          ]}>
          <ActivityIndicator color={c.textPrimary} size="small" />
          <Text style={styles.rerouteText}>
            {rerouteReason === 'destination-passed'
              ? 'Destination passed. Rerouting…'
              : 'Rerouting from latest position…'}
          </Text>
        </View>
      ) : null}

      {located.length === 0 && !isFetching && !listQuery.isFetching ? (
        <View pointerEvents="none" style={styles.emptyOverlayContainer}>
          <View style={styles.emptyOverlayCard}>
            <View style={styles.emptyIconHalo}>
              <MaterialCommunityIcons color={c.textSecondary} name="map-marker-off" size={24} />
            </View>
            <Text style={styles.emptyOverlayTitle}>No located vehicles</Text>
            <Text style={styles.emptyOverlayMessage}>No live positions to show yet.</Text>
          </View>
        </View>
      ) : null}

    </SafeAreaView>
  );
}

function appendCompletedRouteRun(
  runs: RouteCoordinate[][],
  geometry: RouteCoordinate[],
  startNewRun: boolean
): RouteCoordinate[][] {
  if (geometry.length < 2) return runs;
  const lastRun = runs[runs.length - 1];
  const last = lastRun?.[lastRun.length - 1];
  const first = geometry[0];
  if (!last || startNewRun) return [...runs, geometry];
  const joinsExisting = haversineKm(last[1], last[0], first[1], first[0]) * 1000 <= 12;
  if (!joinsExisting) return [...runs, geometry];
  const joined = [...lastRun];
  for (const point of geometry) {
    const tail = joined[joined.length - 1];
    if (!tail || tail[0] !== point[0] || tail[1] !== point[1]) joined.push(point);
  }
  return [...runs.slice(0, -1), joined];
}

function navigationRouteCoordinates(route: NavigationRoute): RouteCoordinate[] {
  const coordinates: RouteCoordinate[] = [];
  for (const point of route.coordinates) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180 ||
      (point.latitude === 0 && point.longitude === 0)
    ) {
      // Never bridge across an invalid provider vertex with a straight line.
      return [];
    }
    const coordinate: RouteCoordinate = [point.longitude, point.latitude];
    const previous = coordinates[coordinates.length - 1];
    if (previous && previous[0] === coordinate[0] && previous[1] === coordinate[1]) {
      continue;
    }
    coordinates.push(coordinate);
  }
  return coordinates;
}

function sharedTripRequestOf(
  deviceId: number,
  route: NavigationRoute,
  destination: DirectionsLocation,
  active: boolean
): SharedTripRequest {
  return {
    deviceId,
    destinationName: destination.formatted || destination.name,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    coordinates: route.coordinates,
    active,
  };
}

function sharedTripUrl(token: string): string {
  const query = `token=${encodeURIComponent(token)}`;
  if (env.shareBaseUrl) return `${env.shareBaseUrl}/shared-trip?${query}`;
  return Linking.createURL('/shared-trip', { queryParams: { token } });
}

type LocatedDevice = DeviceSummary & { latitude: number; longitude: number };

function NativeFleetMap({
  mapRef,
  devices,
  mapStyle,
  mapPreferences,
  onClearSelection,
  onFitAll,
  onSelectDevice,
  onVisibleIdsChange,
  selectedId,
  targetsRef,
  geofences,
}: {
  mapRef: React.RefObject<MapView | null>;
  devices: LocatedDevice[];
  mapStyle: any;
  mapPreferences: MapPreferences;
  onClearSelection: () => void;
  onFitAll: () => void;
  onSelectDevice: (id: string | number) => void;
  onVisibleIdsChange: (ids: string[]) => void;
  selectedId: number | null;
  geofences: WebMapGeofence[];
  targetsRef: React.MutableRefObject<Map<number, import('@/src/services/fleetLivePositions').FleetTarget>>;
}) {
  const { stateColors } = useTheme();
  // Same shared status calculation the list and the counters use; subscribing
  // here keeps marker colours in step when the phone's location switch flips.
  const readiness = useMobileGpsReadiness();
  const screen = useWindowDimensions();
  // The 3D overlay's orthographic camera has to use the MAP's box, not the
  // window's: the map sits inside a bottom-safe-area inset, so window height is
  // taller than the surface `pointForCoordinate` projects into. Feeding the
  // window size in offset every vehicle vertically by the inset.
  const [mapSize, setMapSize] = useState({ height: screen.height, width: screen.width });
  const { height, width } = mapSize;
  const handleMapLayout = useCallback((event: LayoutChangeEvent) => {
    const next = {
      height: Math.round(event.nativeEvent.layout.height),
      width: Math.round(event.nativeEvent.layout.width),
    };
    if (next.height <= 0 || next.width <= 0) return;
    setMapSize((current) =>
      current.height === next.height && current.width === next.width ? current : next
    );
  }, []);
  const mountedRef = useRef(true);
  const projectionRequestRef = useRef(0);
  const lastCameraRef = useRef<any>(null);
  const hasInitialFitRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [projection, setProjection] = useState<{
    heading: number;
    points: Record<string, { x: number; y: number }>;
  }>({ heading: 0, points: {} });
  // Popups appear only when zoomed in. Driven off the region's latitudeDelta
  // (reliable on both Google and Apple maps, unlike camera.zoom) with a
  // hysteresis band so popups don't flicker on/off right at the threshold.
  const zoomedInRef = useRef(false);
  const isCameraMovingRef = useRef(false);
  // Mirrors isCameraMovingRef into render. The 3D overlay draws in screen space
  // from points that are only re-projected once the gesture ends, so it has to
  // stand down while the camera moves or it slides along with the finger.
  const [cameraMoving, setCameraMoving] = useState(false);
  const [zoomedIn, setZoomedIn] = useState(false);
  const updateZoomFromRegion = useCallback((latitudeDelta?: number) => {
    if (!Number.isFinite(latitudeDelta)) return;
    const delta = latitudeDelta as number;
    const next = zoomedInRef.current ? delta <= POPUP_EXIT_DELTA : delta <= POPUP_ENTER_DELTA;
    if (next !== zoomedInRef.current) {
      zoomedInRef.current = next;
      setZoomedIn(next);
    }
  }, []);

  useEffect(
    () => () => {
      mountedRef.current = false;
      projectionRequestRef.current += 1;
    },
    []
  );

  const projectVehicles = useCallback(async (notifyVisibility = false) => {
    const instance = mapRef.current;
    if (!instance || !mapReady) return;
    const request = ++projectionRequestRef.current;
    try {
      const [camera, screenPoints] = await Promise.all([
        instance.getCamera(),
        Promise.all(
          devices.map(async (device) => ({
            id: String(device.id),
            point: await instance.pointForCoordinate({
              latitude: device.latitude,
              longitude: device.longitude,
            }),
          }))
        ),
      ]);
      if (!mountedRef.current || request !== projectionRequestRef.current) return;
      lastCameraRef.current = camera;

      // Keep a margin around the viewport so markers near the edges are not
      // culled (and re-added) mid-animation while the camera pans/zooms or
      // focuses a tapped vehicle — that on/off toggling is what reads as a flash.
      const visiblePoints: Record<string, { x: number; y: number }> = {};
      for (const result of screenPoints) {
        if (
          Number.isFinite(result.point.x) &&
          Number.isFinite(result.point.y) &&
          result.point.x >= -100 &&
          result.point.x <= width + 100 &&
          result.point.y >= -100 &&
          result.point.y <= height + 100
        ) {
          visiblePoints[result.id] = result.point;
        }
      }
      setProjection({
        heading: normalizeHeading(camera.heading),
        points: visiblePoints,
      });
      if (notifyVisibility) onVisibleIdsChange(Object.keys(visiblePoints));
    } catch {
      // The SDK can reject coordinate projection during its first layout pass.
    }
  }, [devices, height, mapReady, mapRef, onVisibleIdsChange, width]);

  useEffect(() => {
    if (!mapReady) return;
    void projectVehicles();
  }, [mapReady, projectVehicles]);

  const handleMapReady = useCallback(() => {
    setMapReady(true);
    if (!hasInitialFitRef.current) {
      hasInitialFitRef.current = true;
      onFitAll();
    } else if (lastCameraRef.current) {
      mapRef.current?.setCamera(lastCameraRef.current);
      setTimeout(() => void projectVehicles(true), 100);
    }
  }, [onFitAll, projectVehicles, mapRef]);

  const handleRegionChange = useCallback(
    (region?: { latitudeDelta?: number }) => {
      if (!isCameraMovingRef.current) {
        isCameraMovingRef.current = true;
        setCameraMoving(true);
      }
      updateZoomFromRegion(region?.latitudeDelta);
    },
    [updateZoomFromRegion]
  );

  const handleRegionChangeComplete = useCallback(
    (region?: { latitudeDelta?: number }) => {
      isCameraMovingRef.current = false;
      updateZoomFromRegion(region?.latitudeDelta);
      // Only hand the scene back to the 3D overlay once it holds screen points
      // for the camera that is actually on screen now, otherwise it would show
      // one frame of vehicles at their pre-gesture positions.
      void projectVehicles(true).then(() => {
        if (mountedRef.current && !isCameraMovingRef.current) setCameraMoving(false);
      });
    },
    [projectVehicles, updateZoomFromRegion]
  );

  const placed = useMemo(
    () =>
      devices.flatMap((device) => {
        const point = projection.points[String(device.id)];
        if (!point) return [];
        return [{ id: String(device.id), item: device, point }];
      }),
    [devices, projection.points]
  );

  // Which vehicles get a compact popup. Far zoom -> none (except the selected
  // one, which always shows). Overlapping non-selected popups are suppressed,
  // and the selected popup is placed first so it always wins.
  const popups = useMemo(() => {
    const visible: { device: LocatedDevice; point: { x: number; y: number }; selected: boolean }[] = [];
    for (const { item: device, point } of placed) {
      const selected = selectedId === device.id;
      if (!selected && !zoomedIn) continue;
      visible.push({ device, point, selected });
    }
    visible.sort((a, b) =>
      a.selected === b.selected ? a.point.y - b.point.y : a.selected ? -1 : 1
    );
    const placedRects: { left: number; top: number; right: number; bottom: number }[] = [];
    const shown: typeof visible = [];
    for (const item of visible) {
      const left = item.point.x - POPUP_W / 2;
      const top = item.point.y - MARKER_HALF - POPUP_H - POPUP_ARROW;
      const rect = { left, top, right: left + POPUP_W, bottom: top + POPUP_H };
      const overlaps = placedRects.some(
        (r) => rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top
      );
      if (item.selected || !overlaps) {
        placedRects.push(rect);
        shown.push(item);
      }
    }
    return shown;
  }, [placed, selectedId, zoomedIn]);

  return (
    <View onLayout={handleMapLayout} style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        customMapStyle={mapPreferences.mapType === 'satellite' ? [] : mapStyle}
        mapType={
          mapPreferences.mapType === 'satellite'
            ? 'hybrid'
            : mapPreferences.mapType === 'terrain'
              ? 'terrain'
              : 'standard'
        }
        showsTraffic={mapPreferences.details.traffic}
        loadingBackgroundColor="#E8EDF2"
        loadingEnabled
        onMapReady={handleMapReady}
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        showsCompass={false}
        showsUserLocation={false}
        pitchEnabled
        rotateEnabled
        toolbarEnabled={false}
        onPress={onClearSelection}
        initialCamera={{
          altitude: 1400,
          center: { latitude: 12.97, longitude: 77.59 },
          heading: -8,
          pitch: 42,
          zoom: 11,
        }}>
        {/* Drawn before the vehicles so a marker is never hidden by the zone
            it sits in. react-native-maps takes a radius in metres, so this
            stays correct through zoom and pan without any recomputation. */}
        {geofences.map((zone) => (
          <Circle
            key={`geofence-${zone.id}`}
            center={{ latitude: zone.lat, longitude: zone.lng }}
            fillColor={hexToRgba(zone.color ?? '#1A73E8', 0.14)}
            radius={zone.radius}
            strokeColor={zone.color ?? '#1A73E8'}
            strokeWidth={2}
          />
        ))}
        {devices.map((device) => {
          return (
            <LiveVehicleMapMarker
              key={`native-vehicle-${device.id}`}
              device={device}
              targetsRef={targetsRef}
              projectionHeading={projection.heading}
              isSelected={selectedId === device.id}
              onSelect={onSelectDevice}
              color={stateColors[resolveDeviceRecordState(device, readiness).state] ?? stateColors.NO_DATA}
            />
          );
        })}
      </MapView>

      {/* Real 3D vehicle models for every placed marker. The transparent GL
          surface sits over the map and is driven by the same projected screen
          points as the tap targets below, so the models track the map exactly.
          The 2D marker images only appear while this is starting up or if the
          device genuinely cannot provide a GL context. */}
      {/* Leader lines tying a moved marker back to where it actually is. These
          are positioned from the same projected points as the 3D overlay, so
          they stand down during a gesture for the same reason it does. */}
      {(cameraMoving ? [] : popups).map(({ device, point, selected }) => (
        <VehiclePopup
          key={`popup-${device.id}`}
          x={point.x}
          y={point.y}
          name={device.name}
          state={resolveDeviceRecordState(device, readiness).state}
          speed={device.speed}
          lastUpdate={device.lastUpdate}
          statusColor={stateColors[resolveDeviceRecordState(device, readiness).state] ?? stateColors.NO_DATA}
          selected={selected}
        />
      ))}
    </View>
  );
}

// Compact zoom-based vehicle popup (no circles/rings around the model).
const POPUP_W = 132;
const POPUP_H = 54;
const POPUP_ARROW = 7;
// Half the marker's on-screen box, so a popup clears the vehicle instead of
// sitting on it. Android draws the sprite bitmap, whose canvas is a known dp
// size; iOS still draws the vector marker's larger rotation canvas.
const MARKER_HALF = Platform.OS === 'android' ? VEHICLE_SPRITE_SIZE_SELECTED / 2 : 46;
const POPUP_BG = 'rgba(9, 17, 29, 0.92)';
// latitudeDelta thresholds (smaller delta = more zoomed in). Hysteresis band.
const POPUP_ENTER_DELTA = 0.055;
const POPUP_EXIT_DELTA = 0.09;


function formatRelativeUpdate(iso?: string | null): string {
  if (!iso) return 'No update';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'No update';
  const diff = Date.now() - ms;
  if (diff < 60_000) return `Updated ${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `Updated ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `Updated ${Math.floor(diff / 3_600_000)}h ago`;
  return `Updated ${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Small dark popup anchored above a 3D vehicle. Memoised so only the vehicles
 * whose position/status actually changed re-render on a GPS tick. Non-interactive
 * (pointerEvents none) so it never blocks taps on the map or the marker below.
 */
const VehiclePopup = memo(function VehiclePopup({
  x,
  y,
  name,
  state,
  speed,
  lastUpdate,
  statusColor,
  selected,
}: {
  x: number;
  y: number;
  name: string;
  state: string;
  speed: number;
  lastUpdate?: string | null;
  statusColor: string;
  selected: boolean;
}) {
  return (
    <View
      pointerEvents="none"
      style={[
        popupStyles.popup,
        { left: x - POPUP_W / 2, top: y - MARKER_HALF - POPUP_H - POPUP_ARROW },
        selected && popupStyles.popupSelected,
      ]}>
      <Text numberOfLines={1} style={popupStyles.title}>
        {name}
      </Text>
      <View style={popupStyles.row}>
        <View style={[popupStyles.dot, { backgroundColor: statusColor }]} />
        <Text numberOfLines={1} style={popupStyles.meta}>
          {formatDeviceState(state)} · {Math.max(0, Math.round(speed))} km/h
        </Text>
      </View>
      <Text numberOfLines={1} style={popupStyles.time}>
        {formatRelativeUpdate(lastUpdate)}
      </Text>
      <View style={popupStyles.arrow} />
    </View>
  );
});

const popupStyles = StyleSheet.create({
  popup: {
    backgroundColor: POPUP_BG,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 6,
    position: 'absolute',
    width: POPUP_W,
    zIndex: 20,
  },
  popupSelected: { borderColor: 'rgba(138, 180, 248, 0.9)', borderWidth: 1.5 },
  title: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 0.2 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 2 },
  dot: { borderRadius: 4, height: 7, width: 7 },
  meta: { color: '#DCE7F0', flex: 1, fontSize: 10, fontWeight: '700' },
  time: { color: '#8BA0B4', fontSize: 9, fontWeight: '600', marginTop: 1 },
  arrow: {
    borderLeftColor: 'transparent',
    borderLeftWidth: POPUP_ARROW,
    borderRightColor: 'transparent',
    borderRightWidth: POPUP_ARROW,
    borderTopColor: POPUP_BG,
    borderTopWidth: POPUP_ARROW,
    bottom: -POPUP_ARROW,
    height: 0,
    left: POPUP_W / 2 - POPUP_ARROW,
    position: 'absolute',
    width: 0,
  },
});

function RailButton({
  icon,
  label,
  loading = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const spinValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!loading) {
      spinValue.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spinValue, { toValue: 1, duration: 900, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [loading, spinValue]);

  const spin = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.railButton, pressed && styles.railButtonPressed]}>
      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <MaterialCommunityIcons color={c.textPrimary} name={icon} size={19} />
      </Animated.View>
    </Pressable>
  );
}

const STATUS_SEGMENTS: { key: 'RUNNING' | 'STOPPED' | 'OFFLINE'; label: string }[] = [
  { key: 'RUNNING', label: 'Running' },
  { key: 'STOPPED', label: 'Stopped' },
  // Every non-reporting state, matching the Vehicles screen's bucket.
  { key: 'OFFLINE', label: 'Not Reporting' },
];

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    railRight: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 5,
      overflow: 'hidden',
      position: 'absolute',
      right: 12,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.16,
      shadowRadius: 8,
      zIndex: 20,
    },
    railButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
    railButtonPressed: { backgroundColor: c.surfaceAlt },
    railDivider: { alignSelf: 'stretch', backgroundColor: c.divider, height: StyleSheet.hairlineWidth },
    recenterButton: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 6,
      flexDirection: 'row',
      gap: 6,
      height: 42,
      justifyContent: 'center',
      paddingHorizontal: 15,
      position: 'absolute',
      right: 12,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18,
      shadowRadius: 9,
      zIndex: 24,
    },
    recenterText: { color: c.textPrimary, fontSize: 11, fontWeight: '800' },
    reroutePill: {
      alignItems: 'center',
      alignSelf: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 7,
      left: 12,
      paddingHorizontal: 13,
      paddingVertical: 10,
      position: 'absolute',
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      zIndex: 23,
    },
    rerouteText: { color: c.textPrimary, fontSize: 10.5, fontWeight: '800' },
    statusStrip: {
      alignSelf: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 4,
      flexDirection: 'row',
      left: spacing.sm,
      minHeight: 44,
      paddingHorizontal: 10,
      paddingVertical: 7,
      position: 'absolute',
      right: spacing.sm,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.13,
      shadowRadius: 9,
      zIndex: 20,
    },
    statusSegment: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 5, justifyContent: 'center' },
    stripDot: { borderRadius: 999, height: 7, width: 7 },
    stripValue: {
      color: c.textPrimary,
      fontSize: 12.5,
      fontVariant: ['tabular-nums'],
      fontWeight: '800',
    },
    stripLabel: { color: c.textSecondary, fontSize: 10, fontWeight: '700' },
    mapVignette: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(6, 13, 24, 0.022)',
      borderColor: 'rgba(4, 10, 20, 0.08)',
      borderWidth: 1,
    },
    floatingHeader: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: 24,
      borderWidth: 1,
      flexDirection: 'row',
      left: spacing.md,
      paddingHorizontal: spacing.md,
      height: 72,
      position: 'absolute',
      right: spacing.md,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.22,
      shadowRadius: 12,
      elevation: 8,
      zIndex: 50,
    },
    headerLeftCol: {
      marginRight: spacing.sm,
    },
    headerMidCol: {
      flex: 1,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 2,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    statusLabel: {
      color: c.textSecondary,
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.2,
    },
    headerTitle: {
      color: c.textPrimary,
      fontSize: 16,
      fontWeight: '800',
    },
    rightActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    menuButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
    },
    commandTitle: { flex: 1, minWidth: 0 },
    eyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    signalDot: { borderRadius: 4, height: 7, width: 7 },
    eyebrow: { color: c.textSecondary, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
    commandHeading: { color: c.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 1 },
    fleetCount: {
      alignItems: 'flex-end',
      borderLeftColor: c.divider,
      borderLeftWidth: 1,
      minWidth: 58,
      paddingHorizontal: 8,
    },
    fleetCountValue: { color: c.textPrimary, fontSize: 20, fontWeight: '900' },
    fleetCountLabel: { color: c.textSecondary, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
    fab: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: 16,
      borderWidth: 1,
      elevation: 4,
      height: 48,
      justifyContent: 'center',
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.22,
      shadowRadius: 6,
      width: 48,
    },
    emptyOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    vehicleSheet: {
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: 1,
      elevation: 12,
      left: spacing.md,
      maxHeight: '80%',
      paddingBottom: 16,
      paddingHorizontal: 18,
      paddingTop: 8,
      position: 'absolute',
      right: spacing.md,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: -8 },
      shadowOpacity: 0.38,
      shadowRadius: 26,
      zIndex: 30,
    },
    sheetHandleHit: {
      alignItems: 'center',
      marginHorizontal: -8,
      paddingBottom: 8,
      paddingTop: 2,
    },
    sheetHandle: {
      backgroundColor: c.divider,
      borderRadius: 3,
      height: 5,
      width: 48,
    },
    collapsedSheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: radius.xl,
      zIndex: 50,
    },
    sheetDivider: {
      backgroundColor: c.divider,
      height: 1,
      marginTop: 13,
    },
    sheetSpeedRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      marginTop: 11,
    },
    lastUpdate: {
      color: c.textSecondary,
      flex: 1,
      fontSize: 10,
      fontWeight: '700',
      textAlign: 'right',
    },
    detailGrid: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: 13,
      borderWidth: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 13,
      justifyContent: 'space-between',
      marginTop: 12,
      padding: 12,
    },
    expandedSheetContent: { paddingBottom: 2 },
    coordinateRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 11,
    },
    coordinateLabel: {
      color: c.textSecondary,
      fontSize: 8,
      fontWeight: '900',
      letterSpacing: 0.9,
    },
    coordinateValue: { color: c.textPrimary, fontSize: 10, fontWeight: '800' },
    cardList: { bottom: 0, left: 0, position: 'absolute', right: 0 },
    cards: { gap: spacing.sm, paddingHorizontal: spacing.md },
    card: {
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: 1,
      padding: 18,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.32,
      shadowRadius: 24,
    },
    cardTop: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
    cardIdentity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 10, minWidth: 0 },
    cardBeacon: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: 15,
      borderWidth: 1,
      height: 70,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 80,
    },
    cardTitleBlock: { flex: 1, minWidth: 0 },
    cardName: { color: c.textPrimary, fontSize: typography.body, fontWeight: '900' },
    cardId: { color: c.textSecondary, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
    addressRow: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 12 },
    cardAddress: { color: c.textSecondary, flex: 1, fontSize: typography.caption },
    cardMetaRow: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
    speedReadout: { alignItems: 'baseline', flexDirection: 'row', gap: 5 },
    speedNumber: { color: c.textPrimary, fontSize: 28, fontWeight: '900' },
    speedUnit: { color: c.textSecondary, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
    cardActions: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.md,
      justifyContent: 'flex-end',
      marginTop: 14,
    },
    cardPlay: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    cardPlayText: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '800' },
    trackButton: {
      alignItems: 'center',
      backgroundColor: c.primary,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    cardTrack: { color: c.onPrimary, fontSize: typography.caption, fontWeight: '900' },
    emptyOverlayContainer: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
      zIndex: 10,
    },
    emptyOverlayCard: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: 1,
      elevation: 8,
      maxWidth: 320,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.lg,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.2,
      shadowRadius: 16,
    },
    emptyIconHalo: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: 1,
      height: 52,
      justifyContent: 'center',
      marginBottom: spacing.xs,
      width: 52,
    },
    emptyOverlayTitle: {
      color: c.textPrimary,
      fontSize: typography.body,
      fontWeight: '800',
      textAlign: 'center',
    },
    emptyOverlayMessage: {
      color: c.textSecondary,
      fontSize: typography.caption,
      marginTop: 4,
      textAlign: 'center',
    },
  });
