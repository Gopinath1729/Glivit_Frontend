import { MaterialCommunityIcons } from '@expo/vector-icons';
import { DrawerActions } from '@react-navigation/native';
import { useNavigation, useRouter } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  type LayoutChangeEvent,
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

import { Fleet3DOverlay, type Fleet3DOverlayMarker } from '@/src/components/Fleet3DOverlay';
import { FleetWebMap, type FleetWebMapHandle, type WebMapMarker } from '@/src/components/FleetWebMap';
import { LiveVehicleMapMarker } from '@/src/components/LiveVehicleMapMarker';
import MapView, { Marker } from '@/src/components/maps/NativeMap';
import {
  getVehicleModel,
  modelForVehicle,
  Vehicle3DMarker,
} from '@/src/components/Vehicle3DMarker';
import { StatusPill } from '@/src/components/ui/StatusPill';
import { MapLayersBottomSheet } from '@/src/components/MapLayersBottomSheet';
import {
  DEFAULT_MAP_PREFERENCES,
  loadMapPreferences,
  type MapPreferences,
} from '@/src/services/mapPreferencesStorage';
import { useGetAllDevicesQuery, useGetDeviceQuery, useGetDevicesQuery } from '@/src/services/devicesApi';
import { useFleetLivePositions } from '@/src/services/fleetLivePositions';
import { getMapStyleInfo, type MapStyleVariant } from '@/src/services/mapStyle';
import { normalizeHeading } from '@/src/services/vehicleMarkerAssets';
import type { DeviceSummary } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import { useAppSelector } from '@/src/store/hooks';

/** Shortest-path angular interpolation for smooth live heading changes. */
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}
type AnimatedPos = { lat: number; lng: number; heading: number };

export default function AllVehiclesMapScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors: c, stateColors, isDark, autoFollowVehicle } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const mapRef = useRef<MapView>(null);
  const webMapRef = useRef<FleetWebMapHandle>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const autoFollowVehicleRef = useRef(autoFollowVehicle);
  useEffect(() => {
    autoFollowVehicleRef.current = autoFollowVehicle;
  }, [autoFollowVehicle]);

  const { data, isFetching, refetch } = useGetAllDevicesQuery();
  const listQuery = useGetDevicesQuery({ page: 0, size: 100 });

  const rawDevices = useMemo(() => {
    if (data && Array.isArray(data) && data.length > 0) return data;
    if (listQuery.data?.content && Array.isArray(listQuery.data.content)) return listQuery.data.content;
    return data ?? [];
  }, [data, listQuery.data?.content]);

  const { targetsRef, connected, vehicleCount } = useFleetLivePositions(rawDevices);
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  const located = useMemo(() => {
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
  }, [rawDevices, vehicleCount]);

  const selected = useMemo(
    () => located.find((device) => device.id === selectedId) ?? null,
    [located, selectedId]
  );

  // Located devices with status metadata from SSE.
  const liveDevices = useMemo<LocatedDevice[]>(
    () =>
      located.map((d) => {
        const target = targetsRef.current?.get(d.id);
        const state = target?.state ?? d.state;
        return {
          ...d,
          state,
          speed: target ? target.speed : (d.speed ?? 0),
          latitude: target ? target.latitude : d.latitude,
          longitude: target ? target.longitude : d.longitude,
          course: target?.heading ?? d.course ?? 0,
          lastUpdate: target ? new Date(target.updatedAt).toISOString() : d.lastUpdate,
        };
      }),
    [located, vehicleCount]
  );

  const statusCounts = useMemo(() => {
    const acc = { RUNNING: 0, IDLE: 0, STOPPED: 0, NO_DATA: 0 };
    for (const d of liveDevices) {
      const st = (d.state ?? '').toUpperCase();
      if (st === 'RUNNING' || st === 'MOVING') acc.RUNNING += 1;
      else if (st === 'IDLE') acc.IDLE += 1;
      else if (st === 'STOPPED') acc.STOPPED += 1;
      else acc.NO_DATA += 1;
    }
    return acc;
  }, [liveDevices]);

  useEffect(() => {
    if (selectedId != null && !located.some((device) => device.id === selectedId)) {
      setSelectedId(null);
    }
  }, [located, selectedId]);

  const selectedLive = useMemo(
    () => liveDevices.find((d) => d.id === selectedId) ?? null,
    [liveDevices, selectedId]
  );

  useEffect(() => {
    if (autoFollowVehicle && selectedLive && mapRef.current) {
      mapRef.current.animateCamera({
        center: { latitude: selectedLive.latitude, longitude: selectedLive.longitude },
        zoom: 15.2,
      }, { duration: 800 });
    }
  }, [selectedLive?.latitude, selectedLive?.longitude, autoFollowVehicle]);

  const webMarkers = useMemo<WebMapMarker[]>(
    () =>
      liveDevices.map((d) => ({
        id: d.id,
        lat: d.latitude,
        lng: d.longitude,
        color: stateColors[d.state] ?? stateColors.NO_DATA ?? '#475569',
        heading: d.course,
        category: d.category,
        label: d.name,
      })),
    [liveDevices, stateColors]
  );

  const [showLayersSheet, setShowLayersSheet] = useState(false);
  const [legendExpanded, setLegendExpanded] = useState(false);
  const legendAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(legendAnim, {
      toValue: legendExpanded ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [legendExpanded, legendAnim]);

  const translateY = legendAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [200, 0],
  });

  const opacity = legendAnim.interpolate({
    inputRange: [0, 0.1, 1],
    outputRange: [0, 0.9, 1],
  });

  const aiFabTranslateY = legendAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -180],
  });

  const [mapPreferences, setMapPreferences] = useState<MapPreferences>(DEFAULT_MAP_PREFERENCES);

  useEffect(() => {
    const sub = navigation.addListener('focus', () => {
      void loadMapPreferences().then((prefs) => {
        setMapPreferences(prefs);
      });
    });
    return sub;
  }, [navigation]);

  const activeStyleKey: MapStyleVariant =
    mapPreferences.mapType === 'satellite'
      ? 'satellite'
      : isDark
        ? 'dark'
        : 'street';
  const mapStyleInfo = getMapStyleInfo(activeStyleKey);
  const useNativeMap = Platform.OS !== 'web';

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

  const toggleLayers = useCallback(() => {
    setShowLayersSheet(true);
  }, []);

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
    if (located.length === 0) return;
    const target = selected ?? located[0];
    if (useNativeMap) {
      focusNative(target);
    } else {
      webMapRef.current?.fitAll();
    }
  }, [located, selected, useNativeMap, focusNative]);

  const fitAll = useCallback(() => {
    if (useNativeMap) {
      if (located.length === 0) return;
      const coords = located.map((d) => ({
        latitude: d.latitude,
        longitude: d.longitude
      }));
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: { top: 120, right: 60, bottom: 220, left: 60 },
        animated: true,
      });
    } else {
      webMapRef.current?.fitAll();
    }
  }, [useNativeMap, located]);

  const selectById = useCallback(
    (id: string | number) => {
      const device = located.find((candidate) => String(candidate.id) === String(id));
      if (!device) return;
      router.push({ pathname: '/device-profile', params: { id: String(device.id) } });
    },
    [located, router]
  );

  const clearSelection = useCallback(() => {}, []);
  const handleVisibleIdsChange = useCallback((visibleIds: string[]) => {}, []);

  const openLiveTrack = (item: DeviceSummary) =>
    router.push({ pathname: '/live-track', params: { deviceId: String(item.id), name: item.name, subtitle: item.address ?? '' } });

  const openPlayback = (item: DeviceSummary) => {
    const variant = modelForVehicle(item.category, item.id);
    const model = getVehicleModel(variant);
    router.push({
      pathname: '/trip-playback' as never,
      params: {
        deviceId: String(item.id),
        name: item.name,
        category: item.category ?? '',
        make: model.label,
        model: model.id,
        speed: String(item.speed ?? 0),
        heading: String(item.course ?? 0),
      },
    });
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.screen}>
      {useNativeMap ? (
        <NativeFleetMap
          mapRef={mapRef}
          devices={liveDevices}
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
          mapStyle={mapStyleInfo.webStyle}
          markers={webMarkers}
          onClearSelection={clearSelection}
          onSelect={selectById}
          onVisibleIdsChange={handleVisibleIdsChange}
          selectedId={selectedId}
          style={StyleSheet.absoluteFillObject}
        />
      )}

      <View pointerEvents="none" style={styles.mapVignette} />

      <View style={[styles.railRight, { top: spacing.md }]}>
        <LabeledFloatingButton icon="refresh" label="Refresh" loading={isFetching || listQuery.isFetching || manualRefreshing} onPress={handleRefresh} />
        <LabeledFloatingButton icon="crosshairs-gps" label="Locate Me" onPress={locateMe} />
        <LabeledFloatingButton icon="layers-outline" label="Layers" onPress={toggleLayers} />
        <LabeledFloatingButton icon="fit-to-page-outline" label="Fit All" onPress={fitAll} />
        {located.length > 0 && !selected && (
          <LabeledFloatingButton
            icon={legendExpanded ? 'chevron-down' : 'chevron-up'}
            label="Status"
            onPress={() => setLegendExpanded((prev) => !prev)}
          />
        )}
      </View>

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

      {located.length > 0 ? (
        <>
          <Animated.View
            style={[
              styles.legend,
              {
                bottom: 68 + (insets.bottom > 0 ? insets.bottom : 8) + 16,
                transform: [{ translateY }],
                opacity,
              },
            ]}
            pointerEvents={legendExpanded ? 'auto' : 'none'}
          >
            <LegendChip
              badgeColor="#22C55E"
              icon="truck"
              label="Running"
              labelColor="#22C55E"
              value={statusCounts.RUNNING}
            />
            <LegendChip
              badgeColor="#F59E0B"
              icon="pause"
              label="Idle"
              labelColor="#94A3B8"
              value={statusCounts.IDLE}
            />
            <LegendChip
              badgeColor="#EF4444"
              icon="stop"
              label="Stopped"
              labelColor="#EF4444"
              value={statusCounts.STOPPED}
            />
            <LegendChip
              badgeColor="#475569"
              icon="wifi-off"
              label="Offline"
              labelColor="#94A3B8"
              value={statusCounts.NO_DATA}
            />
          </Animated.View>
        </>
      ) : null}

      <Animated.View
        style={[
          styles.aiFab,
          {
            bottom: 68 + (insets.bottom > 0 ? insets.bottom : 8) + 16,
            transform: [{ translateY: aiFabTranslateY }],
          },
        ]}
      >
        <Pressable style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} onPress={() => router.push('/ai-chat')}>
          <MaterialCommunityIcons name="robot-outline" size={28} color="#ffffff" />
        </Pressable>
      </Animated.View>

      <MapLayersBottomSheet
        visible={showLayersSheet}
        onClose={() => setShowLayersSheet(false)}
        preferences={mapPreferences}
        onChangePreferences={setMapPreferences}
      />
    </SafeAreaView>
  );
}

type LocatedDevice = DeviceSummary & { latitude: number; longitude: number };

function hasCoordinate(device: DeviceSummary): device is LocatedDevice {
  return (
    device != null &&
    typeof device.latitude === 'number' &&
    typeof device.longitude === 'number' &&
    Number.isFinite(device.latitude) &&
    Number.isFinite(device.longitude) &&
    (device.latitude !== 0 || device.longitude !== 0) &&
    Math.abs(device.latitude) <= 90 &&
    Math.abs(device.longitude) <= 180
  );
}

function formatLastUpdate(value?: string | null) {
  if (!value) return 'Update unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Update unavailable';
  return `Updated ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

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
  targetsRef: React.MutableRefObject<Map<number, import('@/src/services/fleetLivePositions').FleetTarget>>;
}) {
  const { stateColors } = useTheme();
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
  const [threeReady, setThreeReady] = useState(false);
  const [threeFailed, setThreeFailed] = useState(false);
  const [projection, setProjection] = useState<{
    heading: number;
    points: Record<string, { x: number; y: number }>;
  }>({ heading: 0, points: {} });
  // Popups appear only when zoomed in. Driven off the region's latitudeDelta
  // (reliable on both Google and Apple maps, unlike camera.zoom) with a
  // hysteresis band so popups don't flicker on/off right at the threshold.
  const zoomedInRef = useRef(false);
  const isCameraMovingRef = useRef(false);
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

  const handleThreeReady = useCallback(() => setThreeReady(true), []);
  const handleThreeUnavailable = useCallback((message: string) => {
    console.warn('[FleetMap] 3D vehicles unavailable; using marker images.', message);
    setThreeReady(false);
    setThreeFailed(true);
  }, []);

  const handleRegionChange = useCallback(
    (region?: { latitudeDelta?: number }) => {
      isCameraMovingRef.current = true;
      updateZoomFromRegion(region?.latitudeDelta);
    },
    [updateZoomFromRegion]
  );

  const handleRegionChangeComplete = useCallback(
    (region?: { latitudeDelta?: number }) => {
      isCameraMovingRef.current = false;
      updateZoomFromRegion(region?.latitudeDelta);
      void projectVehicles(true);
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

  const threeMarkers = useMemo<Fleet3DOverlayMarker[]>(
    () =>
      placed.map(({ id, item, point }) => ({
        heading: normalizeHeading(item.course - projection.heading),
        id,
        isActive: item.state === 'RUNNING',
        selected: selectedId === item.id,
        speed: Number.isFinite(item.speed) ? item.speed : 0,
        variant: modelForVehicle(item.category, item.id),
        x: point.x,
        y: point.y,
      })),
    [placed, projection.heading, selectedId]
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
        {devices.map((device) => {
          return (
            <LiveVehicleMapMarker
              key={`native-vehicle-${device.id}`}
              device={device}
              targetsRef={targetsRef}
              projectionHeading={projection.heading}
              isSelected={selectedId === device.id}
              onSelect={onSelectDevice}
              threeFailed={threeFailed}
            />
          );
        })}
      </MapView>

      {/* Real 3D vehicle models for every placed marker. The transparent GL
          surface sits over the map and is driven by the same projected screen
          points as the tap targets below, so the models track the map exactly.
          The 2D marker images only appear while this is starting up or if the
          device genuinely cannot provide a GL context. */}
      <Fleet3DOverlay
        height={height}
        markers={threeMarkers}
        onReady={handleThreeReady}
        onUnavailable={handleThreeUnavailable}
        width={width}
      />

      {/* Leader lines tying a moved marker back to where it actually is. */}
      {popups.map(({ device, point, selected }) => (
        <VehiclePopup
          key={`popup-${device.id}`}
          x={point.x}
          y={point.y}
          name={device.name}
          state={device.state}
          speed={device.speed}
          lastUpdate={device.lastUpdate}
          statusColor={stateColors[device.state] ?? stateColors.NO_DATA}
          selected={selected}
        />
      ))}
    </View>
  );
}

const fleetMapStyles = StyleSheet.create({
  vehicle3DOverlay: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
    zIndex: 10,
  },
});

// Compact zoom-based vehicle popup (no circles/rings around the model).
const POPUP_W = 132;
const POPUP_H = 54;
const POPUP_ARROW = 7;
const MARKER_HALF = 32;
const POPUP_BG = 'rgba(9, 17, 29, 0.92)';
// latitudeDelta thresholds (smaller delta = more zoomed in). Hysteresis band.
const POPUP_ENTER_DELTA = 0.055;
const POPUP_EXIT_DELTA = 0.09;

function formatVehicleState(state: string): string {
  switch ((state ?? '').toUpperCase()) {
    case 'RUNNING':
      return 'Running';
    case 'IDLE':
      return 'Idle';
    case 'STOPPED':
      return 'Stopped';
    case 'EXPIRED':
      return 'Expired';
    case 'INACTIVE':
      return 'Inactive';
    case 'NO_DATA':
      return 'Offline';
    default:
      return state ? state.charAt(0) + state.slice(1).toLowerCase() : 'Offline';
  }
}

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
          {formatVehicleState(state)} · {Math.max(0, Math.round(speed))} km/h
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
  popupSelected: { borderColor: 'rgba(43, 230, 158, 0.9)', borderWidth: 1.5 },
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

function FloatingButton({
  icon,
  onPress,
  loading,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  onPress: () => void;
  loading?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable accessibilityRole="button" disabled={loading} onPress={onPress} style={styles.fab}>
      <MaterialCommunityIcons color={c.textPrimary} name={loading ? 'timer-sand' : icon} size={22} />
    </Pressable>
  );
}

function LabeledFloatingButton({
  icon,
  label,
  loading = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label?: string;
  loading?: boolean;
  onPress: () => void;
}) {
  const { colors: c, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const spinValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (loading) {
      const loop = Animated.loop(
        Animated.timing(spinValue, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        })
      );
      loop.start();
      return () => loop.stop();
    } else {
      spinValue.setValue(0);
    }
  }, [loading, spinValue]);

  const spin = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.fabWrapper}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}>
        <Animated.View style={{ transform: [{ rotate: spin }] }}>
          <MaterialCommunityIcons color={c.textPrimary} name={icon} size={22} />
        </Animated.View>
      </Pressable>
      {label ? (
        <Text
          numberOfLines={1}
          style={[
            styles.fabLabelText,
            {
              color: c.textPrimary,
              textShadowColor: isDark ? 'rgba(0, 0, 0, 0.9)' : 'rgba(255, 255, 255, 0.95)',
            },
          ]}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

function LegendChip({
  badgeColor,
  icon,
  label,
  labelColor,
  value,
}: {
  badgeColor: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  labelColor?: string;
  value: number;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.legendChip}>
      <View style={styles.legendTopRow}>
        <View style={[styles.legendBadge, { backgroundColor: badgeColor }]}>
          <MaterialCommunityIcons color="#FFFFFF" name={icon} size={13} />
        </View>
        <Text style={styles.legendValue}>{value}</Text>
      </View>
      <Text style={[styles.legendLabel, labelColor ? { color: labelColor } : null]}>{label}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    railRight: { alignItems: 'center', gap: 16, position: 'absolute', right: spacing.md, zIndex: 20 },
    fabWrapper: { alignItems: 'center', gap: 4, width: 64 },
    fabPressed: { opacity: 0.85, transform: [{ scale: 0.95 }] },
    fabLabelText: {
      fontSize: 11,
      fontWeight: '800',
      textAlign: 'center',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    legend: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: 1,
      bottom: spacing.sm,
      elevation: 8,
      flexDirection: 'row',
      justifyContent: 'space-around',
      left: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      position: 'absolute',
      right: spacing.sm,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.28,
      shadowRadius: 18,
    },
    aiFab: {
      position: 'absolute',
      right: spacing.md,
      backgroundColor: c.primary,
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
      elevation: 6,
      zIndex: 45,
    },
    legendChip: { alignItems: 'center', flexDirection: 'column', gap: 4 },
    legendTopRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    legendBadge: {
      alignItems: 'center',
      borderRadius: radius.pill,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    legendValue: { color: c.textPrimary, fontSize: 16, fontWeight: '900' },
    legendLabel: { color: c.textSecondary, fontSize: 11, fontWeight: '700', textAlign: 'center' },
    mapVignette: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(6, 13, 24, 0.035)',
      borderColor: 'rgba(4, 10, 20, 0.12)',
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
