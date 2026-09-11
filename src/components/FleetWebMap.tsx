import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Asset } from 'expo-asset';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import bikeModel from '@/models/bike-map.glb';
import carModel from '@/models/car.glb';
import truckModel from '@/models/truck.glb';

import EmbeddedWebView, {
  type EmbeddedWebViewHandle,
  type EmbeddedWebViewMessageEvent,
} from '@/src/components/maps/EmbeddedWebView';
import {
  PREMIUM_FLEET_MAP_PALETTE,
  type MapStyleSpec,
} from '@/src/services/mapStyle';
import type { RouteProgress } from '@/src/services/playbackRoute';
import { routeDelta } from '@/src/services/routeDelta';
import { vehicleBodyType, type VehicleBodyType } from '@/src/services/vehicleCategory';

const VEHICLE_MODEL_MODULES: Record<VehicleBodyType, number> = {
  CAR: carModel,
  BIKE: bikeModel,
  TRUCK: truckModel,
};

function modelAssetDirectory(uris: Record<VehicleBodyType, string>): string | undefined {
  const localUri = Object.values(uris).find((uri) => uri.startsWith('file://'));
  if (!localUri) return undefined;
  return localUri.slice(0, localUri.lastIndexOf('/') + 1);
}

/**
 * A WebView document cannot reliably fetch Expo cache `file://` URLs with
 * XHR/fetch on every Android and iOS release. GLTFLoader uses fetch internally,
 * so native builds receive the GLB as a self-contained data URL instead. Web
 * keeps the emitted HTTP asset URL and avoids expanding the bundle in memory.
 */
/**
 * The encoded meshes, kept for the life of the process.
 *
 * Reading a GLB and base64-encoding it costs real time - the bike is 833 KB of
 * binary, 1.1 MB of text - and it was being paid again by every map that
 * mounted: opening playback re-encoded a model the live map had already
 * prepared a minute earlier. The result is identical every time and small
 * enough to hold (about 2 MB for all three bodies), so it is built once and
 * every later map is handed the string. The promise is cached rather than the
 * value, so two maps mounting together share one read instead of racing.
 */
const MODEL_URI_CACHE = new Map<VehicleBodyType, Promise<string>>();

function cachedModelUri(body: VehicleBodyType): Promise<string> {
  const cached = MODEL_URI_CACHE.get(body);
  if (cached) return cached;
  const pending = (async () => {
    const asset = Asset.fromModule(VEHICLE_MODEL_MODULES[body]);
    if (!asset.localUri) await asset.downloadAsync();
    return webViewModelUri(asset);
  })();
  // A failed read must not be remembered as the answer.
  pending.catch(() => MODEL_URI_CACHE.delete(body));
  MODEL_URI_CACHE.set(body, pending);
  return pending;
}

async function webViewModelUri(asset: Asset): Promise<string> {
  const uri = asset.localUri ?? asset.uri;
  if (Platform.OS === 'web' || !asset.localUri?.startsWith('file://')) return uri;

  // Let a read failure reach the caller. Returning file:// here would mark an
  // unreadable file as delivered even though the HTTPS page cannot fetch it.
  const { File } = await import('expo-file-system');
  const base64 = await new File(asset.localUri).base64();
  return `data:model/gltf-binary;base64,${base64}`;
}

export type WebMapMarker = {
  id: string | number;
  lat: number;
  lng: number;
  color: string;
  heading?: number;
  category?: string;
  moving?: boolean;
  /** Current ground speed, used only to choose the navigation camera lens. */
  speedKph?: number;
  hidden?: boolean;
  label?: string;
  /** GPS source time. Used only to bound interpolation between accepted fixes. */
  sourceTime?: number;
};

/** A circular zone drawn on the map, in metres. */
export type WebMapGeofence = {
  id: string | number;
  name: string;
  lat: number;
  lng: number;
  radius: number;
  color?: string;
};

/**
 * Recorded-history overlay: the complete travelled route as one line per
 * observed run (a break between runs is coverage the tracker never reported,
 * so it is left undrawn rather than closed with a straight line), plus the
 * detected stops.
 */
export type WebMapHistoryOverlay = {
  routes: [number, number][][];
  stops: { index: number; lat: number; lng: number; active: boolean }[];
  events?: { id: string | number; lat: number; lng: number; label?: string }[];
  start?: { lat: number; lng: number } | null;
  end?: { lat: number; lng: number } | null;
};

/** Planned route plus the real, road-matched journey completed during navigation. */
export type WebMapNavigationOverlay = {
  routeId: string;
  /** Fit only route previews; live reroutes must not move or zoom the camera. */
  fitRoute?: boolean;
  completedRoutes: [number, number][][];
  remainingRoute: [number, number][];
  alternativeRoutes: {
    index: number;
    color: string;
    coordinates: [number, number][];
  }[];
  routeLabels?: {
    index: number;
    lat: number;
    lng: number;
    label: string;
    selected: boolean;
  }[];
  start: { lat: number; lng: number } | null;
  destination: { lat: number; lng: number };
};

export type WebMapCameraMode =
  | 'follow'
  | 'chase'
  | 'cinematic'
  | 'drone'
  | 'top'
  | 'overview';

/**
 * Screen space the map may not use for the thing it is following, in dp.
 *
 * Every screen that follows a vehicle covers part of the map with its own
 * chrome - a header at the top, a control deck or tab bar at the bottom. The
 * camera centred the vehicle in the CONTAINER, which on the playback screen put
 * it behind the transport deck: the map was working and the vehicle was simply
 * underneath the controls. Callers state their chrome here and the camera frames
 * the vehicle, and fits routes, inside what is actually visible.
 */
export type WebMapViewportPadding = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
};

export type WebMapProjection = {
  heading: number;
  points: Record<string, { x: number; y: number }>;
};

export type FleetWebMapHandle = {
  fitAll: () => void;
  focusMarker: (id: string | number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetBearing: () => void;
  fitNavigation: () => void;
  recenterNavigation: () => void;
};

type FleetWebMapProps = {
  markers: WebMapMarker[];
  mapStyle: MapStyleSpec;
  /** Apply Glivt's semantic light fleet theme to the provider's OSM vectors. */
  premiumVectorTheme?: boolean;
  cameraMode?: WebMapCameraMode;
  /** Every currently-travelled route run, kept separate across GPS gaps. */
  polylines?: [number, number][][];
  /**
   * Stretches with NO road answer, drawn as an explicitly different overlay.
   *
   * Thin, dashed and amber, beneath the road route. It exists so a map-matching
   * outage can still show where the vehicle was reported to be without that
   * evidence being mistaken for a road: joining two GPS fixes with a solid blue
   * line is a chord through whatever lies between them, and the reason routes
   * appeared to cross buildings. Optional - a caller that would rather show
   * nothing at all simply omits it.
   */
  diagnosticPolylines?: [number, number][][];
  /**
   * Draw `polylines` as a fixed road, revealed up to this point.
   *
   * For a recorded trip the road does not change — only how much of it has been
   * driven does. Supplying progress puts the map in the mode that says so: the
   * geometry is pushed once and never again, and each frame moves a paint
   * property instead of replacing a line. That is the difference between a
   * route that grows and one that arrives in bursts.
   *
   * Omit it for live geometry, where the road genuinely is still being
   * discovered and every update carries new vertices.
   */
  routeProgress?: RouteProgress | null;
  /** Legacy single-run input. Prefer `polylines` for live tracking/playback. */
  polyline?: [number, number][]; // [lng, lat] pairs
  /** Recorded route + stop markers drawn beneath the live polyline. */
  history?: WebMapHistoryOverlay;
  /** FROM -> TO route overlay, independent of the recorded live trail. */
  navigation?: WebMapNavigationOverlay | null;
  /** Circular geofences to draw as ground-accurate rings. */
  geofences?: WebMapGeofence[];
  selectedId?: string | number | null;
  followSelected?: boolean;
  /** Chrome covering the map, so the followed vehicle is framed clear of it. */
  viewportPadding?: WebMapViewportPadding;
  /**
   * Whether this map is the one the operator is looking at.
   *
   * A screen that is still mounted but not on top passes `false`. The document
   * is KEPT - the engine, the style, the tiles and the decoded vehicle meshes
   * all stay warm, so coming back is instant - but nothing is pushed into it
   * and it runs no camera loop, so a backgrounded map costs nothing. Leaving
   * both maps live meant the fleet map kept animating positions under the
   * playback screen for the whole of every trip.
   */
  active?: boolean;
  onSelect?: (id: string | number) => void;
  onClearSelection?: () => void;
  onInteraction?: () => void;
  onSelectNavigationRoute?: (index: number) => void;
  onProjectionChange?: (projection: WebMapProjection) => void;
  onVisibleIdsChange?: (ids: string[]) => void;
  style?: ViewStyle;
};

/**
 * Backstop for a document that never ran any JavaScript at all. The page runs
 * its own staged watchdog and reports a specific reason at ~32 s, so this sits
 * deliberately behind it: at 20 s it was pre-empting that message and turning
 * every slow mobile connection into "Web map unavailable".
 */
const WEB_MAP_LOAD_TIMEOUT_MS = 40000;

type WebMapStatus = 'loading' | 'ready' | 'error';

function sanitizeMapErrorMessage(message: string): string {
  return message.replace(/([?&]apiKey=)[^& )]*/gi, '$1[redacted]');
}

/**
 * The origin to hand the WebView document, taken from the tile host itself when
 * the style is a URL so that tile requests are same-origin. Any real HTTPS
 * origin restores blob-worker access; this one also removes a CORS round trip.
 */
function webViewBaseUrl(style: MapStyleSpec): string {
  if (typeof style === 'string') {
    const origin = /^https:\/\/[^/?#]+/i.exec(style);
    if (origin) return `${origin[0]}/`;
  }
  return 'https://tiles.openfreemap.org/';
}

/**
 * Web-only fallback. react-native-maps has no free native web renderer, so web
 * keeps the existing MapLibre GL JS view with OpenFreeMap/Geoapify styles.
 */
export const FleetWebMap = forwardRef<FleetWebMapHandle, FleetWebMapProps>(function FleetWebMap(
  {
    cameraMode = 'follow',
    markers,
    mapStyle,
    premiumVectorTheme = false,
    polylines,
    diagnosticPolylines,
    polyline,
    routeProgress = null,
    history,
    navigation,
    geofences,
    selectedId,
    followSelected = false,
    viewportPadding,
    active = true,
    onSelect,
    onClearSelection,
    onInteraction,
    onSelectNavigationRoute,
    onProjectionChange,
    onVisibleIdsChange,
    style,
  },
  ref
) {
  const webRef = useRef<EmbeddedWebViewHandle>(null);

  /**
   * One bridge crossing per frame, not one per thing that changed.
   *
   * Markers, routes, history, geofences and navigation each had their own
   * effect calling `injectJavaScript` directly, so a single commit could fire
   * five separate `evaluateJavascript` calls - and playback commits ~25 times a
   * second. Every call serialises a string on the JS thread, hands it across
   * the bridge and is executed asynchronously in the WebView, so bursts arrive
   * out of step with the frames that produced them. That is what the route line
   * was flickering to.
   *
   * Commands are queued and flushed once on the next animation frame, in the
   * order they were queued, so the page still sees exactly the same sequence.
   */
  const scriptQueueRef = useRef<string[]>([]);
  const flushHandleRef = useRef<number | null>(null);
  const flushScripts = useCallback(() => {
    flushHandleRef.current = null;
    const queued = scriptQueueRef.current;
    if (queued.length === 0) return;
    scriptQueueRef.current = [];
    webRef.current?.injectJavaScript(queued.join('') + ' true;');
  }, []);
  const queueScript = useCallback(
    (script: string) => {
      scriptQueueRef.current.push(script);
      if (flushHandleRef.current != null) return;
      flushHandleRef.current = requestAnimationFrame(flushScripts);
    },
    [flushScripts]
  );
  useEffect(
    () => () => {
      if (flushHandleRef.current != null) cancelAnimationFrame(flushHandleRef.current);
      flushHandleRef.current = null;
      scriptQueueRef.current = [];
    },
    []
  );

  const markersRef = useRef(markers);
  const lastSyncedMarkersRef = useRef<object | null>(null);
  const lastSyncedRouteRef = useRef<[number, number][][] | null>(null);
  const lastSyncedDiagnosticRef = useRef<[number, number][][] | null>(null);
  const lastSyncedProgressRef = useRef<RouteProgress | null | undefined>(undefined);
  const lastSyncedGeofencesRef = useRef<object | null>(null);
  const lastSyncedHistoryRef = useRef<object | null>(null);
  const lastSyncedNavigationRef = useRef<object | null>(null);
  const lastSyncedPaddingRef = useRef<object | null>(null);
  markersRef.current = markers;
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<WebMapStatus>('loading');
  // Read inside WebView callbacks, which capture the render they were created
  // in and would otherwise judge a live map by a stale status.
  const statusRef = useRef<WebMapStatus>('loading');
  statusRef.current = status;
  const [errorMessage, setErrorMessage] = useState('');
  /** Body types already encoded and handed to the page, so each is paid for once. */
  const deliveredModelsRef = useRef<Partial<Record<VehicleBodyType, string>>>({});
  const [modelReadAccessUrl, setModelReadAccessUrl] = useState<string | undefined>(undefined);

  useImperativeHandle(
    ref,
    () => ({
      fitAll: () => webRef.current?.injectJavaScript('window.__glivtFit && window.__glivtFit(); true;'),
      focusMarker: (id) =>
        webRef.current?.injectJavaScript(
          `window.__glivtFocus && window.__glivtFocus(${JSON.stringify(String(id))}); true;`
        ),
      zoomIn: () => webRef.current?.injectJavaScript('window.__glivtZoomIn && window.__glivtZoomIn(); true;'),
      zoomOut: () => webRef.current?.injectJavaScript('window.__glivtZoomOut && window.__glivtZoomOut(); true;'),
      resetBearing: () => webRef.current?.injectJavaScript('window.__glivtResetBearing && window.__glivtResetBearing(); true;'),
      fitNavigation: () => webRef.current?.injectJavaScript('window.__glivtFitNavigation && window.__glivtFitNavigation(); true;'),
      recenterNavigation: () => webRef.current?.injectJavaScript('window.__glivtRecenterNavigation && window.__glivtRecenterNavigation(); true;'),
    }),
    []
  );

  // The document contains only the map engine and selected style. Live GPS data
  // is streamed into the existing instance below, so a moving marker never
  // reloads MapLibre, its style, or its tile cache.
  const html = useMemo(
    () => buildHtml(mapStyle, premiumVectorTheme),
    [mapStyle, premiumVectorTheme]
  );
  /**
   * The document is given a real HTTPS origin, and it must be a stable one.
   *
   * MapLibre parses every vector tile in a Web Worker, which it builds either
   * from a cross-origin URL - never permitted for worker scripts - or, failing
   * that, from a blob URL. A WebView document loaded without a base URL has an
   * opaque ("null") origin, and an opaque origin may not create blob workers
   * either. The style still loads on the main thread, so the map reports ready
   * and paints its background layer while every tile silently fails to parse:
   * a blank basemap with working attribution and working markers.
   *
   * Borrowing the tile host's own origin additionally makes tile requests
   * same-origin, so they skip CORS entirely. The model directory is kept out of
   * this on purpose - `baseUrl` is part of the source, so a value that only
   * resolves after the GLB assets have been read would reload the document, and
   * every tile with it, the moment it arrived.
   */
  const baseUrl = useMemo(() => webViewBaseUrl(mapStyle), [mapStyle]);
  const webSource = useMemo(() => ({ baseUrl, html }), [baseUrl, html]);

  const markerPayload = useMemo(
    () => ({
      cameraMode,
      followSelected,
      markers: markers
        .filter((m) => isValidWebCoordinate(m.lat, m.lng))
        .map((m) => ({
          category: vehicleBodyType(m.category),
          color: m.color,
          heading: m.heading ?? 0,
          hidden: Boolean(m.hidden),
          id: String(m.id),
          label: m.label ?? '',
          lat: m.lat,
          lng: m.lng,
          moving: Boolean(m.moving),
          speedKph: Number.isFinite(m.speedKph) ? m.speedKph : 0,
          sourceTime: Number.isFinite(m.sourceTime) ? m.sourceTime : 0,
        })),
    }),
    [cameraMode, followSelected, markers]
  );
  /**
   * Validate each run once and keep the result.
   *
   * Sanitising rebuilds every vertex into a new array, so doing it per render
   * allocated the whole route on every frame AND handed the delta a set of
   * objects it had never seen — which defeated the sharing it depends on and
   * made every frame a full comparison. Cached on the run it came from, an
   * unchanged run is the same array it was last time, and the delta settles it
   * without reading a coordinate.
   */
  const sanitizedRunsRef = useRef(
    new WeakMap<readonly [number, number][], [number, number][]>()
  );
  const sanitizeRuns = useCallback((lines: readonly [number, number][][]) => {
    const cache = sanitizedRunsRef.current;
    const clean: [number, number][][] = [];
    for (const line of lines) {
      let sanitized = cache.get(line);
      if (!sanitized) {
        sanitized = sanitizeWebRoute(line);
        cache.set(line, sanitized);
      }
      if (sanitized.length >= 2) clean.push(sanitized);
    }
    return clean;
  }, []);

  const routeCoordinates = useMemo(
    () => sanitizeRuns(polylines ?? (polyline ? [polyline] : [])),
    [polyline, polylines, sanitizeRuns]
  );
  const diagnosticCoordinates = useMemo(
    () => sanitizeRuns(diagnosticPolylines ?? []),
    [diagnosticPolylines, sanitizeRuns]
  );
  const geofencePayload = useMemo(
    () =>
      (geofences ?? [])
        .filter(
          (g) =>
            isValidWebCoordinate(g.lat, g.lng) &&
            Number.isFinite(g.radius) &&
            g.radius > 0
        )
        .map((g) => ({
          id: String(g.id),
          name: g.name ?? '',
          lat: g.lat,
          lng: g.lng,
          radius: g.radius,
          color: g.color ?? '#1A73E8',
        })),
    [geofences]
  );

  const syncMarkers = useCallback(
    (fit = false) => {
      queueScript(
        `window.__glivtSyncMarkers && window.__glivtSyncMarkers(${JSON.stringify(markerPayload)}, ${fit ? 'true' : 'false'});`
      );
      lastSyncedMarkersRef.current = markerPayload;
    },
    [markerPayload, queueScript]
  );

  /**
   * Push the route as the growth since the last push, whenever it IS growth.
   *
   * A playing trip and a live trail both extend one polyline at its head, and
   * both used to re-send every vertex of it on every frame. On a full day's
   * route that is a six-figure JSON string crossing the bridge twenty-five
   * times a second, which saturates the bridge, starves the WebView's own frame
   * loop and makes the line arrive in visible bursts.
   *
   * `routeDelta` proves the new geometry really is the old geometry plus a tail
   * - by comparing it, which costs numeric compares and no allocation - and
   * sends only that tail. Anything else (a seek backwards, a new day, a changed
   * run count) falls back to the full push, so the drawn line is always exactly
   * the geometry it was given.
   */
  const syncRoute = useCallback(() => {
    const delta = routeDelta(lastSyncedRouteRef.current, routeCoordinates);
    if (delta) {
      if (delta.length > 0) {
        queueScript(
          `window.__glivtExtendRoutes && window.__glivtExtendRoutes(${JSON.stringify(delta)});`
        );
      }
    } else {
      queueScript(
        `window.__glivtSyncRoutes && window.__glivtSyncRoutes(${JSON.stringify(routeCoordinates)});`
      );
    }
    lastSyncedRouteRef.current = routeCoordinates;
    if (lastSyncedDiagnosticRef.current !== diagnosticCoordinates) {
      queueScript(
        `window.__glivtSyncDiagnosticRoutes && window.__glivtSyncDiagnosticRoutes(${JSON.stringify(diagnosticCoordinates)});`
      );
      lastSyncedDiagnosticRef.current = diagnosticCoordinates;
    }
  }, [diagnosticCoordinates, queueScript, routeCoordinates]);

  const historyPayload = useMemo(
    () => ({
      routes: (history?.routes ?? [])
        .map((line) => sanitizeWebRoute(line))
        .filter((line) => line.length >= 2),
      stops: (history?.stops ?? []).filter((stop) => isValidWebCoordinate(stop.lat, stop.lng)),
      events: (history?.events ?? []).filter((event) =>
        isValidWebCoordinate(event.lat, event.lng)
      ),
      start:
        history?.start && isValidWebCoordinate(history.start.lat, history.start.lng)
          ? history.start
          : null,
      end:
        history?.end && isValidWebCoordinate(history.end.lat, history.end.lng)
          ? history.end
          : null,
    }),
    [history]
  );

  const navigationPayload = useMemo(
    () => ({
      routeId: navigation?.routeId ?? '',
      fitRoute: Boolean(navigation?.fitRoute),
      completedRoutes: (navigation?.completedRoutes ?? [])
        .map((line) => sanitizeWebRoute(line))
        .filter((line) => line.length >= 2),
      remainingRoute: sanitizeWebRoute(navigation?.remainingRoute ?? []),
      alternativeRoutes: (navigation?.alternativeRoutes ?? [])
        .map((route) => ({
          index: route.index,
          color: route.color,
          coordinates: sanitizeWebRoute(route.coordinates),
        }))
        .filter((route) => route.coordinates.length >= 2),
      routeLabels: (navigation?.routeLabels ?? [])
        .filter((label) => isValidWebCoordinate(label.lat, label.lng))
        .map((label) => ({
          index: label.index,
          lat: label.lat,
          lng: label.lng,
          label: label.label,
          selected: label.selected,
        })),
      start:
        navigation?.start && isValidWebCoordinate(navigation.start.lat, navigation.start.lng)
          ? navigation.start
          : null,
      destination:
        navigation?.destination &&
        isValidWebCoordinate(navigation.destination.lat, navigation.destination.lng)
          ? navigation.destination
          : null,
    }),
    [navigation]
  );

  const syncHistory = useCallback(() => {
    queueScript(
      `window.__glivtSyncHistory && window.__glivtSyncHistory(${JSON.stringify(historyPayload)});`
    );
    lastSyncedHistoryRef.current = historyPayload;
  }, [historyPayload, queueScript]);

  const syncNavigation = useCallback(
    (fit = false) => {
      queueScript(
        `window.__glivtSyncNavigation && window.__glivtSyncNavigation(${JSON.stringify(navigationPayload)}, ${fit ? 'true' : 'false'});`
      );
      lastSyncedNavigationRef.current = navigationPayload;
    },
    [navigationPayload, queueScript]
  );

  /**
   * The playhead. Two numbers, and the only thing a playing frame sends.
   */
  const syncRouteProgress = useCallback(() => {
    queueScript(
      `window.__glivtSetRouteProgress && window.__glivtSetRouteProgress(${
        routeProgress ? `${routeProgress.runIndex}, ${routeProgress.fraction}` : 'null, null'
      });`
    );
    lastSyncedProgressRef.current = routeProgress;
  }, [queueScript, routeProgress]);

  /**
   * Chrome insets, sent as four numbers whenever they actually change.
   *
   * Deck height is measured on layout, so this arrives after the first frame
   * and again on rotation - both of which have to reach the camera, or the
   * vehicle stays behind whatever moved.
   */
  const paddingPayload = useMemo(
    () => ({
      top: Math.max(0, Math.round(viewportPadding?.top ?? 0)),
      bottom: Math.max(0, Math.round(viewportPadding?.bottom ?? 0)),
      left: Math.max(0, Math.round(viewportPadding?.left ?? 0)),
      right: Math.max(0, Math.round(viewportPadding?.right ?? 0)),
    }),
    [viewportPadding?.bottom, viewportPadding?.left, viewportPadding?.right, viewportPadding?.top]
  );

  const syncPadding = useCallback(() => {
    queueScript(
      `window.__glivtSetViewportPadding && window.__glivtSetViewportPadding(${JSON.stringify(paddingPayload)});`
    );
    lastSyncedPaddingRef.current = paddingPayload;
  }, [paddingPayload, queueScript]);

  const syncGeofences = useCallback(() => {
    queueScript(
      `window.__glivtSyncGeofences && window.__glivtSyncGeofences(${JSON.stringify(geofencePayload)});`
    );
    lastSyncedGeofencesRef.current = geofencePayload;
  }, [geofencePayload, queueScript]);

  const syncAll = useCallback(
    (fit = false) => {
      webRef.current?.injectJavaScript(
        `window.__glivtSetViewportPadding && window.__glivtSetViewportPadding(${JSON.stringify(paddingPayload)});` +
          `window.__glivtSyncRoutes && window.__glivtSyncRoutes(${JSON.stringify(routeCoordinates)});` +
          `window.__glivtSetRouteProgress && window.__glivtSetRouteProgress(${
            routeProgress ? `${routeProgress.runIndex}, ${routeProgress.fraction}` : 'null, null'
          });` +
          `window.__glivtSyncDiagnosticRoutes && window.__glivtSyncDiagnosticRoutes(${JSON.stringify(diagnosticCoordinates)});` +
          `window.__glivtSyncHistory && window.__glivtSyncHistory(${JSON.stringify(historyPayload)});` +
          `window.__glivtSyncGeofences && window.__glivtSyncGeofences(${JSON.stringify(geofencePayload)});` +
          `window.__glivtSyncMarkers && window.__glivtSyncMarkers(${JSON.stringify(markerPayload)}, ${fit && navigationPayload.remainingRoute.length < 2 ? 'true' : 'false'});` +
          `window.__glivtSyncNavigation && window.__glivtSyncNavigation(${JSON.stringify(navigationPayload)}, ${fit && navigationPayload.remainingRoute.length >= 2 ? 'true' : 'false'}); true;`
      );
      lastSyncedRouteRef.current = routeCoordinates;
      lastSyncedDiagnosticRef.current = diagnosticCoordinates;
      lastSyncedProgressRef.current = routeProgress;
      lastSyncedHistoryRef.current = historyPayload;
      lastSyncedGeofencesRef.current = geofencePayload;
      lastSyncedNavigationRef.current = navigationPayload;
      lastSyncedMarkersRef.current = markerPayload;
      lastSyncedPaddingRef.current = paddingPayload;
    },
    [
      diagnosticCoordinates,
      geofencePayload,
      historyPayload,
      markerPayload,
      navigationPayload,
      paddingPayload,
      routeCoordinates,
      routeProgress,
    ]
  );

  useEffect(() => {
    setStatus('loading');
    setErrorMessage('');
    lastSyncedMarkersRef.current = null;
    lastSyncedRouteRef.current = null;
    lastSyncedDiagnosticRef.current = null;
    lastSyncedProgressRef.current = undefined;
    lastSyncedHistoryRef.current = null;
    lastSyncedGeofencesRef.current = null;
    lastSyncedNavigationRef.current = null;
    lastSyncedPaddingRef.current = null;
  }, [html, reloadKey]);

  useEffect(() => {
    if (status !== 'loading') return;

    const timeout = setTimeout(() => {
      setStatus('error');
      setErrorMessage('The map is not responding. Check your network connection and try again.');
    }, WEB_MAP_LOAD_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [reloadKey, status]);

  /**
   * Hand the page one vehicle mesh, in answer to its own request.
   *
   * Encoding all three bodies up front and gating the WebView on the result
   * meant ~8 MB of GLB had to be read and base64-encoded before the map could
   * even mount. Pushing them afterwards was no better: the native side had to
   * guess which bodies were needed, and guessed wrong for a vehicle that was
   * merely hidden. The page now asks for exactly the body it is about to draw.
   *
   * Delivery is base64 because a WebView cannot reliably fetch an Expo cache
   * `file://` URL - and, now that the document has a real https origin, must
   * not try.
   */
  const deliverVehicleModel = useCallback(async (body: VehicleBodyType) => {
    const assetModule = VEHICLE_MODEL_MODULES[body];
    if (!assetModule) return;
    try {
      // Encoded once per process, not once per map.
      const uri = deliveredModelsRef.current[body] ?? (await cachedModelUri(body));
      if (!uri) throw new Error('asset produced no URI');
      deliveredModelsRef.current[body] = uri;
      const directory = modelAssetDirectory({ [body]: uri } as Record<VehicleBodyType, string>);
      if (directory) setModelReadAccessUrl((current) => current ?? directory);
      webRef.current?.injectJavaScript(
        `window.__glivtSetVehicleModel && window.__glivtSetVehicleModel(${JSON.stringify(
          body
        )}, ${JSON.stringify(uri)}); true;`
      );
    } catch (error) {
      // One unavailable mesh must not stop the others, and the DOM marker
      // already covers every vehicle regardless.
      console.warn(`[FleetWebMap] could not prepare the ${body} model`, error);
    }
  }, []);

  /**
   * Ready AND on screen: the condition for pushing anything into the page.
   *
   * Every sync below is gated on this, and the `lastSynced` refs are only
   * written when a push actually happened - so whatever changed while the map
   * was in the background is delivered by the catch-up sync when it returns.
   */
  const live = status === 'ready' && active;

  useEffect(() => {
    if (status !== 'ready') return;
    queueScript(`window.__glivtSetActive && window.__glivtSetActive(${active ? 'true' : 'false'});`);
  }, [active, queueScript, status]);

  // Coming back to a map that was left behind: replay everything it missed.
  const wasLiveRef = useRef(false);
  useEffect(() => {
    if (!live) {
      wasLiveRef.current = false;
      return;
    }
    if (wasLiveRef.current) return;
    wasLiveRef.current = true;
    syncAll(false);
  }, [live, syncAll]);

  const wantsProjection = Boolean(onProjectionChange);
  useEffect(() => {
    if (!live) return;
    queueScript(
      `window.__glivtSetProjectionReporting && window.__glivtSetProjectionReporting(${wantsProjection ? 'true' : 'false'});`
    );
  }, [live, queueScript, wantsProjection]);

  useEffect(() => {
    if (!live) return;
    if (selectedId == null) {
      queueScript('window.__glivtClearSelection && window.__glivtClearSelection();');
      return;
    }
    const marker = markersRef.current.find((m) => String(m.id) === String(selectedId));
    if (!marker) return;
    queueScript(
      `window.__glivtSelect && window.__glivtSelect(${JSON.stringify(String(selectedId))}, ${marker.lng}, ${marker.lat});`
    );
  }, [live, queueScript, selectedId]);

  // Pushed before the markers below, so the first camera move a screen makes
  // already knows which part of the map its own chrome is covering.
  useEffect(() => {
    if (live && lastSyncedPaddingRef.current !== paddingPayload) {
      syncPadding();
    }
  }, [live, paddingPayload, syncPadding]);

  useEffect(() => {
    if (live && lastSyncedMarkersRef.current !== markerPayload) {
      syncMarkers(false);
    }
  }, [live, markerPayload, syncMarkers]);

  useEffect(() => {
    if (live && lastSyncedRouteRef.current !== routeCoordinates) {
      syncRoute();
    }
  }, [live, routeCoordinates, syncRoute]);

  useEffect(() => {
    if (!live) return;
    const previous = lastSyncedProgressRef.current;
    if (
      previous !== undefined &&
      previous?.runIndex === routeProgress?.runIndex &&
      previous?.fraction === routeProgress?.fraction
    ) {
      return;
    }
    syncRouteProgress();
  }, [live, routeProgress, syncRouteProgress]);

  useEffect(() => {
    if (live && lastSyncedHistoryRef.current !== historyPayload) {
      syncHistory();
    }
  }, [historyPayload, live, syncHistory]);

  useEffect(() => {
    if (!live || lastSyncedNavigationRef.current === navigationPayload) return;
    const previous = lastSyncedNavigationRef.current as { routeId?: string } | null;
    syncNavigation(
      Boolean(
        navigationPayload.fitRoute &&
          navigationPayload.routeId &&
          previous?.routeId !== navigationPayload.routeId
      )
    );
  }, [live, navigationPayload, syncNavigation]);

  // Zones are pushed like markers and the route: on ready, and whenever the set
  // changes. That is what makes a newly saved geofence appear without a reload,
  // and what redraws every saved zone after a remount or app restart.
  useEffect(() => {
    if (live && lastSyncedGeofencesRef.current !== geofencePayload) {
      syncGeofences();
    }
  }, [geofencePayload, live, syncGeofences]);

  const handleMessage = (event: EmbeddedWebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {
        type: string;
        id?: string;
        ids?: unknown;
        heading?: unknown;
        message?: string;
        points?: unknown;
        index?: unknown;
        category?: string;
      };
      if (msg.type === 'ready') {
        syncAll(true);
        setStatus('ready');
        setErrorMessage('');
        return;
      }
      if (msg.type === 'recovered') {
        // A recovered tile request is not a new navigation session. Never fit
        // or reset the camera when dismissing a transient network error.
        setStatus('ready');
        setErrorMessage('');
        return;
      }
      if (msg.type === 'error') {
        setStatus('error');
        setErrorMessage(
          sanitizeMapErrorMessage(msg.message || 'Map tiles could not be loaded.')
        );
        return;
      }
      if (msg.type === 'model-request' && typeof msg.category === 'string') {
        if (msg.category in VEHICLE_MODEL_MODULES) {
          void deliverVehicleModel(msg.category as VehicleBodyType);
        }
        return;
      }
      if (msg.type === 'model-error') {
        // Never fatal - 3D is an enhancement - but never silent either.
        console.warn(
          `[FleetWebMap] 3D unavailable (${String(msg.category ?? '?')}): ${msg.message ?? ''}`
        );
        return;
      }
      if (msg.type === 'select' && msg.id != null) {
        const original = markers.find((m) => String(m.id) === msg.id);
        onSelect?.(original ? original.id : msg.id);
        return;
      }
      if (msg.type === 'clear-selection') {
        onClearSelection?.();
        return;
      }
      if (msg.type === 'interaction') {
        onInteraction?.();
        return;
      }
      if (
        msg.type === 'select-navigation-route' &&
        typeof msg.index === 'number' &&
        Number.isSafeInteger(msg.index)
      ) {
        onSelectNavigationRoute?.(msg.index);
        return;
      }
      if (msg.type === 'projection' && isProjectionPoints(msg.points)) {
        onProjectionChange?.({
          heading: typeof msg.heading === 'number' && Number.isFinite(msg.heading) ? msg.heading : 0,
          points: msg.points,
        });
        return;
      }
      if (msg.type === 'visible-markers' && Array.isArray(msg.ids)) {
        onVisibleIdsChange?.(
          msg.ids.filter((id): id is string => typeof id === 'string')
        );
      }
    } catch {
      // ignore malformed messages
    }
  };

  return (
    <View style={[styles.container, style]}>
      {/* Mounted immediately. This used to wait on every vehicle mesh being
          read and base64-encoded first, which left the screen empty for as long
          as that took before the map had even been asked to load. */}
      <EmbeddedWebView
        key={reloadKey}
        ref={webRef}
        originWhitelist={['*']}
        source={webSource}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowingReadAccessToURL={modelReadAccessUrl}
        cacheEnabled
        // The engine and its stylesheet are served from immutable, version-
        // pinned URLs with a year-long max-age, so honouring the HTTP cache is
        // what makes every mount after the first one paint almost immediately.
        // Deliberately LOAD_DEFAULT and not LOAD_CACHE_ELSE_NETWORK: the map
        // style itself is an unversioned URL, and serving that from an expired
        // cache would pin the basemap to whatever it looked like on the day it
        // was first fetched.
        cacheMode="LOAD_DEFAULT"
        // A GPU-backed layer. Without it Android composites the map's canvas in
        // software on some devices, which reads as a map that pans and zooms in
        // steps rather than smoothly.
        androidLayerType="hardware"
        // Dev builds only: lets the map document be inspected over adb
        // (chrome://inspect / the DevTools protocol) while the app runs.
        webviewDebuggingEnabled={__DEV__}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        onError={(event) => {
          // Both callbacks also fire for individual sub-resources (a tile, a
          // glyph range, a sprite sheet). Tearing a live map down over one
          // failed tile is wrong: the renderer retries those by itself.
          if (statusRef.current === 'ready') return;
          setStatus('error');
          setErrorMessage(
            sanitizeMapErrorMessage(
              event.nativeEvent.description || 'Map WebView failed to load.'
            )
          );
        }}
        onHttpError={(event) => {
          if (statusRef.current === 'ready') return;
          setStatus('error');
          setErrorMessage(`Map request failed with HTTP ${event.nativeEvent.statusCode}.`);
        }}
        onLoadStart={() => {
          setStatus('loading');
          setErrorMessage('');
        }}
        onMessage={handleMessage}
        style={styles.web}
        mixedContentMode="never"
      />
      {status === 'error' ? (
        <WebMapStateOverlay
          message={errorMessage}
          onRetry={() => {
            setStatus('loading');
            setErrorMessage('');
            setReloadKey((current) => current + 1);
          }}
          status="error"
        />
      ) : status === 'loading' ? (
        <WebMapLoadingPill />
      ) : null}
    </View>
  );
});

/**
 * An HTML string inside a native WebView cannot read Metro's file:// asset URI.
 * Embed the optimized bitmap as a data URI so the actual car renders on every
 * platform instead of leaving only its CSS status backing visible.
 */
function isValidWebCoordinate(lat: number, lng: number) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function sanitizeWebRoute(polyline: readonly [number, number][]): [number, number][] {
  const clean: [number, number][] = [];
  for (const coordinate of polyline) {
    const [lng, lat] = coordinate;
    // Reject the complete geometry instead of dropping a bad middle vertex:
    // skipping it would join both sides with an artificial straight chord.
    if (!isValidWebCoordinate(lat, lng)) return [];
    const previous = clean[clean.length - 1];
    if (previous && Math.abs(previous[0] - lng) < 1e-7 && Math.abs(previous[1] - lat) < 1e-7) {
      continue;
    }
    clean.push([lng, lat]);
  }
  return clean;
}

function isProjectionPoints(
  value: unknown
): value is Record<string, { x: number; y: number }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (point) =>
      typeof point === 'object' &&
      point !== null &&
      !Array.isArray(point) &&
      Number.isFinite((point as { x?: unknown }).x) &&
      Number.isFinite((point as { y?: unknown }).y)
  );
}

function buildHtml(
  mapStyle: MapStyleSpec,
  premiumVectorTheme: boolean
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <!-- Every one of these hosts is contacted within the first few hundred
       milliseconds, and on mobile the DNS lookup plus TLS handshake is most of
       what "the map is slow to load" actually measures. Opening them while the
       document is still being parsed takes that cost off the critical path. -->
  <link rel="preconnect" href="https://unpkg.com" crossorigin />
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link rel="preconnect" href="https://tiles.openfreemap.org" crossorigin />
  <link rel="dns-prefetch" href="https://unpkg.com" />
  <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />
  <link rel="dns-prefetch" href="https://tiles.openfreemap.org" />
  <link rel="dns-prefetch" href="https://tiles.mapterhorn.com" />
  <!-- The map engine is the one download the map genuinely cannot start
       without. As a bare dynamic import inside the module below it could not begin
       until the document had been parsed and that module had started running;
       declared here it is in flight from the first bytes of the head. The
       import below then resolves against a request already on the wire. -->
  <link rel="modulepreload" href="https://unpkg.com/maplibre-gl@6.8.0/dist/maplibre-gl.mjs" crossorigin />
  <!-- MapLibre's stylesheet is fetched without blocking first paint: a stalled
       CDN used to hold the whole document hostage before the map could even be
       constructed. The rules the renderer actually depends on are inlined below,
       so the map is fully functional even if this request never completes. -->
  <link href="https://unpkg.com/maplibre-gl@6.8.0/dist/maplibre-gl.css" rel="stylesheet"
        media="print" onload="this.media='all'" />
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.166.1/examples/jsm/"
      }
    }
  </script>
  <style>
    /* Critical MapLibre layout. Without these the canvas and the DOM markers
       are mispositioned, so they cannot depend on the async stylesheet. */
    .maplibregl-map { position: relative; overflow: hidden; -webkit-tap-highlight-color: transparent; }
    .maplibregl-canvas-container, .maplibregl-canvas { position: absolute; top: 0; left: 0; }
    .maplibregl-canvas-container.maplibregl-interactive { cursor: grab; }
    .maplibregl-marker { position: absolute; top: 0; left: 0; will-change: transform; opacity: 1; }
    .maplibregl-ctrl-bottom-right { position: absolute; right: 0; bottom: 0; z-index: 2; pointer-events: none; }
    .maplibregl-ctrl-bottom-right .maplibregl-ctrl { pointer-events: auto; margin: 0 8px 4px 0; }
    .maplibregl-ctrl-attrib.maplibregl-compact { background: rgba(255,255,255,.72); border-radius: 10px; padding: 1px 7px; }
    .maplibregl-ctrl-attrib a { color: inherit; text-decoration: none; }
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #F7F7F4; }
    #map:after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(circle at 50% 46%, transparent 58%, rgba(38,55,70,.035) 100%);
    }
    .maplibregl-ctrl-attrib { font: 9px/1.2 system-ui, sans-serif; opacity: .82; }
    .glivt-marker {
      width: 60px; height: 68px; display: flex; align-items: center; justify-content: center;
      /* MapLibre owns this element's translate transform. React already feeds
         interpolated positions at animation-frame cadence; transitioning that
         transform again makes the marker trail the GPS by another 220 ms. */
      transition: filter .18s ease;
      transform-origin: center;
    }
    .glivt-vehicle {
      position: absolute; inset: 2px; transform: rotate(var(--heading));
      transform-origin: center; transition: transform .2s linear;
    }
    .glivt-beam {
      position: absolute; left: 18px; top: -1px; width: 20px; height: 28px;
      background: linear-gradient(to top, var(--vehicle-color), transparent 82%);
      clip-path: polygon(50% 0, 100% 100%, 50% 80%, 0 100%); opacity: .28;
    }
    .glivt-marker:not(.moving) .glivt-beam { display: none; }
    /* Never substitute a flat black car while the mesh is decoding. Loading is
       deliberately compact and non-circular so it cannot be mistaken for a
       second vehicle position or status marker. */
    .glivt-model-loader {
      position:absolute; left:19px; top:23px; width:18px; height:18px;
      display:flex; align-items:center; justify-content:center; box-sizing:border-box;
      border:3px solid color-mix(in srgb, var(--vehicle-color) 34%, white);
      border-radius:6px; background:rgba(255,255,255,.94);
      box-shadow:0 3px 9px rgba(2,8,18,.28); color:transparent;
      font:900 11px/1 system-ui,sans-serif; transition:opacity .16s ease;
    }
    .glivt-marker.model-loading .glivt-model-loader {
      width:26px; height:26px; left:15px; top:19px; border-radius:8px;
      border-color:color-mix(in srgb, var(--vehicle-color) 24%, white);
      border-top-color:var(--vehicle-color); animation:glivt-model-spin .75s linear infinite;
    }
    .glivt-marker.model-failed .glivt-model-loader {
      color:#fff; background:#E5484D; border-color:#fff; animation:none;
    }
    @keyframes glivt-model-spin { to { transform:rotate(360deg); } }
    .glivt-label {
      position: absolute; left: 44px; top: 10px; max-width: 130px; overflow: hidden;
      padding: 5px 8px; border-radius: 8px; white-space: nowrap; text-overflow: ellipsis;
      color: #263746; background: rgba(255,255,255,.96); border: 1px solid #D7D9D4;
      box-shadow: 0 4px 12px rgba(38,55,70,.18);
      font: 750 10px system-ui, sans-serif; opacity: 0; transform: translateX(-4px);
      transition: opacity .2s ease, transform .2s ease;
    }
    .glivt-marker.selected { filter: drop-shadow(0 8px 9px rgba(38,55,70,.42)); z-index: 5; }
    .glivt-marker.selected .glivt-vehicle { transform: rotate(var(--heading)) scale(1.14); }
    .glivt-marker.selected .glivt-label { opacity: 1; transform: translateX(0); }
    /* An empty label is no label: without this the chip still drew as a bare
       white pill beside the vehicle. */
    .glivt-label:empty { display: none; }
    .glivt-marker.model-ready .glivt-model-loader,
    .glivt-marker.model-ready .glivt-beam { opacity: 0; }
    /* A bottom toast, not a full-width bar pinned to the top: there it ran
       underneath the status bar and collided with the native error card that
       covers the same failure. */
    #err { position:absolute; left:12px; right:12px; bottom:12px; padding:10px 12px;
           border-radius:12px; font:600 12px/1.35 system-ui, sans-serif; color:#8A1B10;
           background:rgba(255,241,239,.97); border:1px solid rgba(203,60,44,.28);
           box-shadow:0 6px 18px rgba(38,55,70,.18); display:none; z-index:9; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="err"></div>
  <script type="module">
    /* Both hosts serve the same pinned build. Hard-coding a single CDN meant one
       blocked or throttled host took the entire map down with it; the first host
       to answer wins and the next is tried only when the previous one fails. */
    var MAPLIBRE_SOURCES = [
      'https://unpkg.com/maplibre-gl@6.8.0/dist/maplibre-gl.mjs',
      'https://cdn.jsdelivr.net/npm/maplibre-gl@6.8.0/dist/maplibre-gl.mjs'
    ];

    async function importFirstAvailable(urls) {
      var failure = null;
      for (var index = 0; index < urls.length; index += 1) {
        try {
          return await import(urls[index]);
        } catch (error) {
          failure = error;
        }
      }
      throw failure || new Error('Module could not be downloaded.');
    }

    (async function () {
      window.addEventListener('message', function (event) {
        if (event.data && event.data.__glivtPing) {
          if (BASE_READY) post({ type:'ready' });
          return;
        }
        if (!event.data || !event.data.__glivtCommand || typeof event.data.script !== 'string') return;
        try {
          Function(event.data.script)();
        } catch (error) {
          post({ type:'error', message: error && error.message ? error.message : 'Map command failed.' });
        }
      });
      function post(obj) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(obj));
        } else if (window.parent && window.parent !== window) {
          window.parent.postMessage({ __glivt: true, payload: obj }, '*');
        }
      }
      var hasReportedMapError = false;
      function reportError(message) {
        hasReportedMapError = true;
        var safeMessage = String(message || 'Map tiles could not be loaded.')
          .replace(/([?&]apiKey=)[^& )]*/gi, '$1[redacted]');
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Map error: ' + safeMessage;
        post({ type:'error', message: safeMessage });
      }
      /** Clears a previously reported error once the map recovers on its own. */
      function clearError() {
        hasReportedMapError = false;
        var err = document.getElementById('err');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
      }

      /**
       * MapLibre parses every vector tile in a Web Worker, built from a blob
       * URL when - as here - the engine itself is cross-origin. A document with
       * an opaque origin may not create one, and the failure is silent: the
       * style loads, the background paints, and no tile ever arrives. Probe it
       * so that this names itself instead of looking like an empty map.
       */
      function workerSupportError() {
        try {
          var blobUrl = URL.createObjectURL(new Blob([''], { type:'text/javascript' }));
          var probe = new Worker(blobUrl);
          probe.terminate();
          URL.revokeObjectURL(blobUrl);
          return '';
        } catch (error) {
          return 'This WebView blocked the map worker at origin "' + location.origin + '" (' +
            (error && error.message ? error.message : 'unknown') + '). Vector tiles cannot be parsed.';
        }
      }

      var maplibregl;
      try {
        maplibregl = await importFirstAvailable(MAPLIBRE_SOURCES);
      } catch (_) {
        reportError('Map engine could not be downloaded. Check the network connection.');
        return;
      }

      /* Three.js and the GLTF loader only power the 3D vehicle models.
         They used to be static imports, which meant ~1.4 MB of geometry code had
         to arrive from a second CDN before the map was even constructed - the
         basemap was queued behind an enhancement it does not need. They are now
         fetched after the map is live, and an explicit loader covers the gap. */
      var THREE = null;
      var GLTFLoader = null;
      var threeRequest = null;

      function loadThree() {
        if (threeRequest) return threeRequest;
        threeRequest = Promise.all([
          import('three'),
          import('three/addons/loaders/GLTFLoader.js')
        ]).then(function (modules) {
          THREE = modules[0];
          GLTFLoader = modules[1].GLTFLoader;
          return true;
        }).catch(function (error) {
          setAllModelStates('failed');
          post({
            type:'model-error',
            category:'*',
            message:'3D engine unavailable: ' +
              (error && error.message ? error.message : 'module import failed')
          });
          return false;
        });
        return threeRequest;
      }

      try {
        var STYLE = ${JSON.stringify(mapStyle)};
        var PREMIUM_VECTOR_THEME = ${JSON.stringify(premiumVectorTheme)};
        var FLEET_PALETTE = ${JSON.stringify(PREMIUM_FLEET_MAP_PALETTE)};
        /* Filled in after the map is live, one body type at a time. These used
           to be base64 data URLs baked straight into this document - with the
           bike model alone at 7.4 MB, the HTML string reached ~10 MB and had to
           be encoded, crossed over the bridge and parsed before the WebView
           could request a single tile. */
        var MODEL_URIS = {};
        var BASE_READY = false;
        var MARKERS = [];
        var LINES = [];
        /* No run carries a negative ordinal, so this is "draw nothing". */
        var NO_RUNS = ['==', ['get','runIndex'], -1];
        var FULL_ROUTE_GRADIENT = ['interpolate',['linear'],['line-progress'],
          0,'#7FB4F5', 0.55,'#2A8BFF', 1,'#0057D8'];
        var ROUTE_PROGRESS = null;
        var DISPLAY_ROUTE_PROGRESS = null;
        var routeProgressFrame = null;
        var lastRouteProgressAt = 0;
        /* The map opens on a placeholder view because a document has to be
           given somewhere to start, and the fleet's positions have not arrived
           yet when it is built. The first batch of markers is what actually
           says where the operator's vehicles are, so it is also what decides
           where the camera goes - once, and never again once the operator has
           moved it themselves. */
        var hasFramedFleet = false;
        var operatorMovedCamera = false;

        /** The whole run in one colour, as a gradient the layer already uses. */
        function solidGradient(color) {
          return ['step',['line-progress'],color,1,color];
        }
        /** That colour up to the playhead, and nothing at all beyond it. */
        function clippedGradient(color, cut) {
          return cut >= 1
            ? solidGradient(color)
            : ['step',['line-progress'],color,cut,'rgba(0,0,0,0)'];
        }
        /** The depth-graded blue, ending at the playhead. */
        function clippedRouteGradient(cut) {
          var stops = ['interpolate',['linear'],['line-progress'],
            0,'#7FB4F5', cut * 0.55,'#2A8BFF', cut * 0.995,'#0057D8'];
          if (cut < 1) {
            stops.push(cut, 'rgba(0,0,0,0)');
            stops.push(1, 'rgba(0,0,0,0)');
          }
          return stops;
        }
        var DIAGNOSTIC_LINES = [];
        var GEOFENCES = [];
        var HISTORY = { routes: [], stops: [] };
        var NAVIGATION = { routeId:'', completedRoutes:[], remainingRoute:[], alternativeRoutes:[], routeLabels:[], start:null, destination:null };
        if (typeof maplibregl.Map !== 'function') throw new Error('MapLibre GL JS did not load.');
        var configurationError =
          STYLE && typeof STYLE === 'object' && STYLE.metadata
            ? STYLE.metadata.glivtConfigurationError
            : '';
        if (configurationError) throw new Error(String(configurationError));
        if (typeof STYLE === 'string' && STYLE.indexOf('https://') !== 0) {
          throw new Error('Map style URL must use HTTPS.');
        }
        var map = new maplibregl.Map({
          container: 'map',
          style: STYLE,
          center: [77.59, 12.97],
          zoom: 10.8,
          pitch: 38,
          bearing: -8,
          // The OpenFreeMap style carries its OpenStreetMap attribution.
          attributionControl: true,
          /* A 450 dpi phone otherwise asks WebGL to shade the full 1080x2340
             surface with multisampling on every rotating camera frame. Two
             device pixels per CSS pixel remains crisp for roads and labels,
             while cutting the fragment workload roughly in half on the Galaxy
             A15-class devices this app targets. */
          pixelRatio:Math.min(2, window.devicePixelRatio || 1),
          canvasContextAttributes: { antialias:false, powerPreference:'high-performance' },
          fadeDuration: 0,
          maxPitch: 78
        });
        var markerEls = {};
        var markerRefs = {};
        var markerAnimations = {};
        /* Marker headings are already resolved by the validated GPS/playback
           pipeline before they cross the bridge. The page must not derive a
           second bearing from rendered coordinates: those coordinates are
           intermediate animation samples, and at a junction their tiny deltas
           can alternate between adjoining road legs. That used to make the 3D
           vehicle and the heading-up camera fight through the same turn. */
        var selectedMarkerId = null;
        var cameraMode = 'follow';
        var followSelected = false;
        var lastProjectionAt = 0;
        var lastVisibleReportAt = 0;
        var lastBaseError = '';

        /**
         * Screen the host's own chrome is covering, in CSS pixels.
         *
         * Sent by the React side and used for two things: framing the followed
         * vehicle inside what is actually visible, and fitting routes into the
         * same strip. Zero on a screen that draws nothing over the map.
         */
        var VIEW_PADDING = { top:0, bottom:0, left:0, right:0 };

        /* Whether this document is the map on screen. Declared here, with the
           map itself, because the camera and the reporters below read it and a
           declaration further down would be undefined - and so falsely
           inactive - for any event that arrived first. */
        var PAGE_ACTIVE = true;

        /**
         * The lens each camera mode uses, and where in the clear strip the
         * vehicle sits.
         *
         * 'anchor' is a fraction of the visible height: a head-up drive view
         * puts the vehicle low so the road ahead fills the screen, exactly as a
         * factory navigation display does, while the north-up view centres it.
         */
        var CAMERA_PROFILES = {
          follow:{ pitch:52, zoom:16.6, anchor:0.70, headingUp:true },
          chase:{ pitch:64, zoom:17.0, anchor:0.72, headingUp:true },
          cinematic:{ pitch:68, zoom:17.3, anchor:0.76, headingUp:true },
          drone:{ pitch:44, zoom:14.6, anchor:0.55, headingUp:true },
          top:{ pitch:0, zoom:16.4, anchor:0.5, headingUp:false }
        };

        function cameraProfile() {
          return CAMERA_PROFILES[cameraMode] || CAMERA_PROFILES.follow;
        }

        /**
         * Automotive cameras see farther ahead as speed rises, while a parked
         * vehicle gets a closer, less aggressively pitched inspection view.
         * This changes only the local lens; it needs no routing or map API.
         */
        function cameraProfileForPose(pose) {
          var base = cameraProfile();
          if (!base.headingUp || !pose) return base;
          var speed = Math.max(0, Number(pose.speedKph) || 0);
          var speedFactor = Math.max(0, Math.min(1, (speed - 18) / 68));
          var parked = !pose.moving || speed < 2.5;
          return {
            pitch:parked ? Math.max(44, base.pitch - 9) : base.pitch - speedFactor * 3,
            zoom:base.zoom + (parked ? 0.22 : -speedFactor * 0.62),
            anchor:base.anchor,
            headingUp:base.headingUp
          };
        }

        /**
         * Camera padding that lands the followed vehicle on its anchor.
         *
         * MapLibre centres on the middle of the padded box, so placing a point
         * anywhere else is a matter of solving for the bottom inset:
         * top + (height - top - bottom) / 2 === targetY.
         */
        function cameraPadding(anchor) {
          var container = map.getContainer();
          var height = container.clientHeight || 1;
          var width = container.clientWidth || 1;
          var chromeTop = Math.min(VIEW_PADDING.top, height * 0.42);
          var chromeBottom = Math.min(VIEW_PADDING.bottom, height * 0.6);
          var freeHeight = Math.max(60, height - chromeTop - chromeBottom);
          var targetY = chromeTop + freeHeight * anchor;
          /* Only the DIFFERENCE between the two insets moves the centre, and it
             has to be able to go either way: an anchor below the middle of the
             container needs padding at the TOP, and no amount of bottom padding
             expresses it. Solving for one inset with the other pinned to the
             chrome is what silently dropped the anchor whenever the answer came
             out negative, leaving the vehicle centred. */
          var delta = 2 * targetY - height;
          var limit = Math.max(0, height - 48);
          return {
            top:delta > 0 ? Math.min(delta, limit) : 0,
            bottom:delta < 0 ? Math.min(-delta, limit) : 0,
            left:Math.min(VIEW_PADDING.left, width * 0.4),
            right:Math.min(VIEW_PADDING.right, width * 0.4)
          };
        }

        /**
         * Padding for a bounds fit: the real chrome, plus a breathing margin.
         *
         * The floors are not decoration. A bounds fit only knows about the
         * anchor COORDINATES, while each vehicle is drawn as a screen-sized
         * model up to ~74 px long around its anchor - so a vehicle fitted flush
         * to the edge had half its body cropped by the viewport.
         */
        function fitPadding() {
          var container = map.getContainer();
          var height = container.clientHeight || 1;
          var width = container.clientWidth || 1;
          return {
            top:Math.min(height * 0.4, Math.max(56, VIEW_PADDING.top + 24)),
            bottom:Math.min(height * 0.45, Math.max(56, VIEW_PADDING.bottom + 24)),
            left:Math.min(width * 0.35, Math.max(56, VIEW_PADDING.left + 24)),
            right:Math.min(width * 0.35, Math.max(56, VIEW_PADDING.right + 24))
          };
        }

        function fitToData() {
          var pts = MARKERS.map(function (m) { return [m.lng, m.lat]; });
          LINES.forEach(function (line) { pts = pts.concat(line); });
          (HISTORY.routes || []).forEach(function (line) { pts = pts.concat(line); });
          (NAVIGATION.completedRoutes || []).forEach(function (line) { pts = pts.concat(line); });
          pts = pts.concat(NAVIGATION.remainingRoute || []);
          map.stop();
          if (pts.length === 1) {
            map.easeTo({ center:pts[0], zoom:15, padding:fitPadding(), duration:400, essential:true });
          }
          else if (pts.length > 1) {
            var b = pts.reduce(function (acc, p) { return acc.extend(p); }, new maplibregl.LngLatBounds(pts[0], pts[0]));
            // A whole fleet parked in one yard produces a degenerate box, and
            // fitting that zooms past every tile the style has. maxZoom keeps
            // the result a map rather than a close-up of one rooftop.
            map.fitBounds(b, {
              padding: fitPadding(),
              duration: 400,
              maxZoom: 16
            });
          }
        }

        function fitNavigation() {
          var pts = [];
          (NAVIGATION.completedRoutes || []).forEach(function (line) { pts = pts.concat(line); });
          (NAVIGATION.alternativeRoutes || []).forEach(function (route) {
            pts = pts.concat(route.coordinates || []);
          });
          pts = pts.concat(NAVIGATION.remainingRoute || []);
          if (NAVIGATION.start) pts.push([NAVIGATION.start.lng, NAVIGATION.start.lat]);
          if (NAVIGATION.destination) pts.push([NAVIGATION.destination.lng, NAVIGATION.destination.lat]);
          if (!pts.length) return;
          map.stop();
          if (pts.length === 1) {
            map.easeTo({ center:pts[0], zoom:15.4, bearing:0, pitch:28, duration:500, essential:true });
            return;
          }
          var bounds = pts.reduce(function (acc, point) { return acc.extend(point); },
            new maplibregl.LngLatBounds(pts[0], pts[0]));
          map.fitBounds(bounds, {
            padding:fitPadding(),
            bearing:0,
            pitch:24,
            duration:650,
            maxZoom:16.2
          });
        }

        function reportVisibleMarkers(force) {
          if (!BASE_READY) return;
          // The follow camera moves the map on every animation frame, and each
          // move ends. Without this the page posted the whole visible roster
          // sixty times a second for the length of a trip.
          var now = Date.now();
          if (!force && now - lastVisibleReportAt < 500) return;
          lastVisibleReportAt = now;
          var bounds = map.getBounds();
          var ids = MARKERS
            .filter(function (marker) { return bounds.contains([marker.lng, marker.lat]); })
            .map(function (marker) { return String(marker.id); });
          post({ type:'visible-markers', ids:ids });
        }

        function normalizedHeading(value) {
          var heading = Number.isFinite(value) ? value : 0;
          return ((heading % 360) + 360) % 360;
        }

        function groundDistanceMeters(a, b) {
          if (!a || !b) return Number.POSITIVE_INFINITY;
          var toRad = function (value) { return value * Math.PI / 180; };
          var dLat = toRad(b.lat - a.lat);
          var dLng = toRad(b.lng - a.lng);
          var latA = toRad(a.lat);
          var latB = toRad(b.lat);
          var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
          return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        }

        function resolveMarkerHeadings(markers) {
          return markers.map(function (marker) {
            marker.heading = normalizedHeading(Number(marker.heading));
            return marker;
          }).filter(function (marker) {
            return marker && Number.isFinite(Number(marker.lat)) && Number.isFinite(Number(marker.lng));
          });
        }

        function normalizedCategory(value) {
          var category = typeof value === 'string' ? value.toUpperCase() : 'CAR';
          if (category === 'MOTORCYCLE' || category === 'SCOOTER') return 'BIKE';
          if (['TRUCK', 'LORRY', 'MIXER_TRUCK', 'TRAILER', 'BUS', 'EXCAVATOR', 'HEAVY_MACHINERY'].includes(category)) return 'TRUCK';
          return category === 'BIKE' ? 'BIKE' : 'CAR';
        }

        function setCategoryModelState(category, state) {
          var normalized = normalizedCategory(category);
          Object.keys(markerEls).forEach(function (id) {
            var el = markerEls[id];
            if (!el || el.dataset.category !== normalized) return;
            el.classList.toggle('model-loading', state === 'loading');
            el.classList.toggle('model-failed', state === 'failed');
            if (state !== 'ready') el.classList.remove('model-ready');
          });
        }

        function setAllModelStates(state) {
          Object.keys(markerEls).forEach(function (id) {
            var el = markerEls[id];
            if (el) setCategoryModelState(el.dataset.category, state);
          });
        }

        function updateScreenHeadings() {
          var mapHeading = normalizedHeading(map.getBearing());
          MARKERS.forEach(function (marker) {
            var el = markerEls[marker.id];
            if (!el) return;
            var vehicle = el.querySelector('.glivt-vehicle');
            if (vehicle) {
              vehicle.style.setProperty(
                '--heading',
                normalizedHeading(marker.heading - mapHeading) + 'deg'
              );
            }
          });
        }

        /* Whether any screen is listening for screen-space marker positions.
           Only the single-vehicle tracking screen draws its own overlay from
           them; the fleet map draws nothing in screen space, and used to be
           sent a projection of every marker thirty times a second for the whole
           of every pan - computed, serialised, sent across the bridge, parsed,
           and handed to a callback that was not there. */
        var PROJECTION_WANTED = false;
        window.__glivtSetProjectionReporting = function (wanted) {
          PROJECTION_WANTED = Boolean(wanted);
        };

        function reportProjection(force) {
          if (!BASE_READY || !PAGE_ACTIVE) return;
          var now = Date.now();
          if (!force && now - lastProjectionAt < 32) return;
          lastProjectionAt = now;
          // Headings are a visual property of the markers themselves and are
          // always kept current, listener or not.
          updateScreenHeadings();
          if (!PROJECTION_WANTED) return;
          var points = {};
          MARKERS.forEach(function (marker) {
            var point = map.project([marker.lng, marker.lat]);
            if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
              points[String(marker.id)] = { x: point.x, y: point.y };
            }
          });
          post({
            type:'projection',
            heading:normalizedHeading(map.getBearing()),
            points:points
          });
        }

        /**
         * The pose the camera follows: the vehicle as it is drawn RIGHT NOW.
         *
         * Positions arrive in bursts - a live fix every few seconds, a playback
         * publish twenty-five times a second - and both are interpolated for
         * drawing. Reading the drawn pose rather than the last delivered one is
         * what lets the camera move with the vehicle instead of after it.
         */
        function followPose() {
          if (selectedMarkerId == null) return null;
          var marker = null;
          for (var index = 0; index < MARKERS.length; index += 1) {
            if (String(MARKERS[index].id) === String(selectedMarkerId)) {
              marker = MARKERS[index];
              break;
            }
          }
          if (!marker || marker.hidden) return null;
          var entity = vehicle3D.entities[String(selectedMarkerId)];
          if (entity) {
            var pose = entityPose(entity, performance.now());
            return {
              lng:pose.lng, lat:pose.lat,
              heading:normalizedHeading(pose.heading),
              moving:Boolean(marker.moving),
              speedKph:Number(marker.speedKph) || 0
            };
          }
          var ref = markerRefs[selectedMarkerId];
          var at = ref ? ref.getLngLat() : null;
          return {
            lng:at ? at.lng : marker.lng,
            lat:at ? at.lat : marker.lat,
            heading:normalizedHeading(marker.heading),
            moving:Boolean(marker.moving),
            speedKph:Number(marker.speedKph) || 0
          };
        }

        /*
         * The camera is a damped follower, stepped once per animation frame.
         *
         * It used to be a queue of easeTo calls, one per delivered position,
         * each with its own duration. Two of them overlapping is a camera
         * restarting mid-flight, which is what made the map turn in steps while
         * the vehicle itself moved smoothly - and on a corner the bearing
         * visibly snapped. Here the camera holds its own state and approaches
         * the vehicle exponentially: 1 - exp(-dt / tau) is frame-rate
         * independent, so a dropped frame changes nothing about the path, and
         * the result is the continuous head-up rotation a car display gives.
         */
        var FOLLOW_POSITION_TAU = 0.17;
        var FOLLOW_BEARING_TAU = 0.40;
        var FOLLOW_LENS_TAU = 0.45;
        var followFrame = null;
        var followCamera = null;
        var followFrameAt = 0;
        var followSnap = false;
        /* Frames in a row with nothing left to move. A parked vehicle would
           otherwise hold the GPU at sixty repaints a second for as long as the
           screen is open; the loop parks itself instead and the next published
           position starts it again, from the state it stopped in. */
        var followSettledFrames = 0;

        function followSettled(target, pose) {
          return Math.abs(target.lng - pose.lng) < 1e-7 &&
            Math.abs(target.lat - pose.lat) < 1e-7 &&
            Math.abs(shortestAngle(target.bearing, target.wantBearing)) < 0.05 &&
            Math.abs(target.zoom - target.wantZoom) < 0.002 &&
            Math.abs(target.pitch - target.wantPitch) < 0.02;
        }

        function followTick(now) {
          followFrame = null;
          if (!PAGE_ACTIVE || !BASE_READY || !followSelected || selectedMarkerId == null || cameraMode === 'overview') {
            followCamera = null;
            followFrameAt = 0;
            return;
          }
          var pose = followPose();
          var profile = cameraProfileForPose(pose);
          if (pose) {
            var dt = followFrameAt > 0
              ? Math.min(0.25, Math.max(0.001, (now - followFrameAt) / 1000))
              : 0.016;
            followFrameAt = now;
            var targetBearing = profile.headingUp ? pose.heading : 0;
            /* A camera seeded this frame matches its target by construction,
               which the settle test below would read as "nothing to do" - and
               the map would keep whatever view it had before following began.
               Seeding is exactly the case that must reach the map. */
            var seeded = false;
            if (!followCamera || followSnap) {
              seeded = true;
              var centre = map.getCenter();
              // A correction the operator can follow is glided into; a jump
              // across town or a mode change that re-frames the scene is not.
              var reframing = followSnap ||
                groundDistanceMeters(centre, pose) > 1200 ||
                Math.abs(map.getZoom() - profile.zoom) > 2;
              followCamera = reframing
                ? { lng:pose.lng, lat:pose.lat, bearing:targetBearing, pitch:profile.pitch, zoom:profile.zoom }
                : { lng:centre.lng, lat:centre.lat, bearing:normalizedHeading(map.getBearing()),
                    pitch:map.getPitch(), zoom:map.getZoom() };
              followSnap = false;
            } else {
              var positionAlpha = 1 - Math.exp(-dt / FOLLOW_POSITION_TAU);
              var lensAlpha = 1 - Math.exp(-dt / FOLLOW_LENS_TAU);
              followCamera.lng += (pose.lng - followCamera.lng) * positionAlpha;
              followCamera.lat += (pose.lat - followCamera.lat) * positionAlpha;
              /* A standing vehicle keeps reporting whatever heading it stopped
                 on, and that value wanders. Turning the whole map for it spins
                 the world around a parked car, so only a moving vehicle steers
                 the camera - the same rule every head unit applies. */
              if (pose.moving) {
                var turn = Math.abs(shortestAngle(followCamera.bearing, targetBearing));
                /* Follow a proven corner promptly, but damp the tiny heading
                   corrections that otherwise make the whole world shimmer. */
                var bearingTau = turn > 32 ? 0.23 : FOLLOW_BEARING_TAU;
                var bearingAlpha = 1 - Math.exp(-dt / bearingTau);
                followCamera.bearing = normalizedHeading(
                  followCamera.bearing +
                    shortestAngle(followCamera.bearing, targetBearing) * bearingAlpha
                );
              } else if (!profile.headingUp) {
                followCamera.bearing = normalizedHeading(
                  followCamera.bearing + shortestAngle(followCamera.bearing, 0) *
                    (1 - Math.exp(-dt / FOLLOW_BEARING_TAU))
                );
              }
              followCamera.pitch += (profile.pitch - followCamera.pitch) * lensAlpha;
              followCamera.zoom += (profile.zoom - followCamera.zoom) * lensAlpha;
              /* An exponential approach never actually arrives, and MapLibre
                 fires a full zoomstart/zoom/zoomend (and pitch, and rotate)
                 cascade for any difference at all - so a camera trailing its
                 target by a millionth of a zoom level kept dispatching twelve
                 events a frame for the life of the screen. Close enough is
                 arrived. */
              if (Math.abs(profile.zoom - followCamera.zoom) < 0.004) followCamera.zoom = profile.zoom;
              if (Math.abs(profile.pitch - followCamera.pitch) < 0.05) followCamera.pitch = profile.pitch;
            }
            var settled = !seeded && followSettled({
              lng:followCamera.lng, lat:followCamera.lat,
              bearing:followCamera.bearing,
              // North-up keeps steering to zero even at a standstill; head-up
              // holds whatever heading a stopped vehicle last drove.
              wantBearing:profile.headingUp
                ? (pose.moving ? targetBearing : followCamera.bearing)
                : 0,
              zoom:followCamera.zoom, wantZoom:profile.zoom,
              pitch:followCamera.pitch, wantPitch:profile.pitch
            }, pose);
            if (settled) {
              followSettledFrames += 1;
              // Roughly a quarter of a second of nothing happening.
              if (followSettledFrames > 15) {
                followFrame = null;
                followFrameAt = 0;
                return;
              }
            } else {
              followSettledFrames = 0;
              map.jumpTo({
                center:[followCamera.lng, followCamera.lat],
                bearing:followCamera.bearing,
                pitch:followCamera.pitch,
                zoom:followCamera.zoom,
                padding:cameraPadding(profile.anchor)
              });
            }
          } else {
            followFrameAt = now;
          }
          followFrame = requestAnimationFrame(followTick);
        }

        function startFollowLoop(snap) {
          if (!PAGE_ACTIVE) return;
          if (snap) followSnap = true;
          followSettledFrames = 0;
          if (followFrame !== null) return;
          // Cancel any easing left over from a fit or a focus; the loop owns
          // the camera from here.
          map.stop();
          followFrameAt = 0;
          followFrame = requestAnimationFrame(followTick);
        }

        function stopFollowLoop() {
          if (followFrame !== null) cancelAnimationFrame(followFrame);
          followFrame = null;
          followCamera = null;
          followFrameAt = 0;
          followSettledFrames = 0;
        }

        function applyCamera(shouldFit) {
          if (!BASE_READY) return;
          if (cameraMode === 'overview') {
            stopFollowLoop();
            map.stop();
            fitToData();
            reportProjection(true);
            return;
          }
          if (!followSelected || selectedMarkerId == null) {
            stopFollowLoop();
            if (shouldFit) fitToData();
            reportProjection(true);
            return;
          }
          startFollowLoop(Boolean(shouldFit));
          reportProjection(false);
        }

        function firstLabelLayerId() {
          var layers = (map.getStyle() && map.getStyle().layers) || [];
          for (var i = 0; i < layers.length; i += 1) {
            var layer = layers[i];
            if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) return layer.id;
          }
          return undefined;
        }

        function semanticLayerName(layer) {
          return String((layer && layer.id) || '') + ' ' +
            String((layer && layer['source-layer']) || '');
        }

        function containsAny(value, tokens) {
          var lower = String(value || '').toLowerCase();
          return tokens.some(function (token) { return lower.indexOf(token) >= 0; });
        }

        function safeSetPaint(layerId, property, value) {
          try { map.setPaintProperty(layerId, property, value); } catch (_) { }
        }

        function safeSetLayout(layerId, property, value) {
          try { map.setLayoutProperty(layerId, property, value); } catch (_) { }
        }

        /**
         * Restyle Geoapify's OpenStreetMap vector layers by semantic role.
         * This deliberately touches only MapLibre vector paint/layout values:
         * telemetry, marker coordinates and route data sources never enter this
         * function. Matching both layer id and source-layer keeps the theme
         * resilient to compatible Geoapify/OpenMapTiles style revisions.
         */
        function applyPremiumFleetVectorTheme() {
          if (!PREMIUM_VECTOR_THEME) return;
          var style = map.getStyle();
          var layers = (style && style.layers) || [];
          layers.forEach(function (layer) {
            var semantic = semanticLayerName(layer).toLowerCase();
            var isWater = containsAny(semantic, ['water', 'ocean', 'river', 'lake']);
            var isBuilding = containsAny(semantic, ['building']);
            var isPark = containsAny(semantic, [
              'park', 'grass', 'wood', 'forest', 'garden', 'green', 'recreation', 'nature_reserve'
            ]);
            var isLandUse = containsAny(semantic, ['landuse', 'landcover', 'residential', 'industrial', 'commercial']);
            var isRoad = containsAny(semantic, [
              'road', 'street', 'highway', 'motorway', 'trunk', 'tunnel', 'bridge', 'transportation', 'path'
            ]);
            var isMainRoad = containsAny(semantic, [
              'motorway', 'trunk', 'primary', 'secondary', 'major', 'highway_major', 'highway_motorway'
            ]);
            var isRoadCasing = containsAny(semantic, ['casing', '_case', '-case', 'outline', 'border']);
            var isBoundary = containsAny(semantic, ['boundary', 'admin']);
            var isRail = containsAny(semantic, ['rail', 'transit']);
            var isFerry = containsAny(semantic, ['ferry']);
            var isPlace = containsAny(semantic, [
              'place', 'locality', 'country', 'state', 'province', 'city', 'town', 'village', 'suburb', 'district'
            ]);
            var isPoi = containsAny(semantic, [
              'poi', 'amenity', 'shop', 'housenumber', 'house_number', 'airport_label', 'transit_station'
            ]);

            if (layer.type === 'background') {
              safeSetPaint(layer.id, 'background-color', FLEET_PALETTE.background);
              safeSetPaint(layer.id, 'background-opacity', 1);
              return;
            }

            if (layer.type === 'hillshade' || layer.type === 'heatmap') {
              safeSetLayout(layer.id, 'visibility', 'none');
              return;
            }

            if (layer.type === 'fill' || layer.type === 'fill-extrusion') {
              var fillPrefix = layer.type === 'fill-extrusion' ? 'fill-extrusion' : 'fill';
              if (isWater) {
                safeSetPaint(layer.id, fillPrefix + '-color', FLEET_PALETTE.water);
                safeSetPaint(layer.id, fillPrefix + '-opacity', 1);
              } else if (isBuilding) {
                safeSetPaint(layer.id, fillPrefix + '-color', FLEET_PALETTE.building);
                safeSetPaint(layer.id, fillPrefix + '-opacity', 0.58);
                if (layer.type === 'fill') {
                  safeSetPaint(layer.id, 'fill-outline-color', FLEET_PALETTE.roadBorder);
                }
              } else if (isPark) {
                safeSetPaint(layer.id, fillPrefix + '-color', FLEET_PALETTE.park);
                safeSetPaint(layer.id, fillPrefix + '-opacity', 0.86);
              } else if (isRoad) {
                safeSetPaint(
                  layer.id,
                  fillPrefix + '-color',
                  isMainRoad ? FLEET_PALETTE.mainRoad : FLEET_PALETTE.minorRoad
                );
                safeSetPaint(layer.id, fillPrefix + '-opacity', 1);
              } else if (isLandUse) {
                safeSetPaint(layer.id, fillPrefix + '-color', '#F0F1ED');
                safeSetPaint(layer.id, fillPrefix + '-opacity', 0.72);
              }
              return;
            }

            if (layer.type === 'line') {
              if (isWater) {
                safeSetPaint(layer.id, 'line-color', FLEET_PALETTE.waterEdge);
                safeSetPaint(layer.id, 'line-opacity', 0.9);
              } else if (isPark) {
                safeSetPaint(layer.id, 'line-color', '#BCD8BE');
                safeSetPaint(layer.id, 'line-opacity', 0.72);
              } else if (isRail) {
                safeSetPaint(layer.id, 'line-color', '#C4CBCB');
                safeSetPaint(layer.id, 'line-opacity', 0.42);
              } else if (isFerry) {
                safeSetPaint(layer.id, 'line-color', '#82AFC0');
                safeSetPaint(layer.id, 'line-opacity', 0.58);
              } else if (isRoad) {
                safeSetPaint(
                  layer.id,
                  'line-color',
                  isRoadCasing
                    ? FLEET_PALETTE.roadBorder
                    : isMainRoad
                      ? FLEET_PALETTE.mainRoad
                      : FLEET_PALETTE.minorRoad
                );
                safeSetPaint(layer.id, 'line-opacity', isRoadCasing ? 0.9 : 1);
              } else if (isBoundary) {
                safeSetPaint(layer.id, 'line-color', '#C8CECA');
                safeSetPaint(layer.id, 'line-opacity', 0.62);
              }
              return;
            }

            if (layer.type !== 'symbol') return;

            // Remove low-value POI layers as complete style layers. Locality,
            // highway shield and road-name layers stay visible and legible.
            if (isPoi && !isPark && !isRoad && !isPlace) {
              safeSetLayout(layer.id, 'visibility', 'none');
              return;
            }

            var labelColor = isPlace
              ? FLEET_PALETTE.primaryLabel
              : isWater
                ? '#52788A'
                : isPark
                  ? '#52705B'
                  : FLEET_PALETTE.secondaryLabel;
            safeSetPaint(layer.id, 'text-color', labelColor);
            safeSetPaint(layer.id, 'text-halo-color', FLEET_PALETTE.background);
            safeSetPaint(layer.id, 'text-halo-width', isPlace ? 1.7 : 1.25);
            safeSetPaint(layer.id, 'text-halo-blur', 0.35);
            safeSetPaint(layer.id, 'text-opacity', isPlace || isMainRoad ? 0.98 : 0.86);
            safeSetLayout(layer.id, 'text-allow-overlap', false);
            safeSetLayout(layer.id, 'text-ignore-placement', false);

            // Icon-heavy generic symbol layers create most of the visual
            // clutter. Road shields are intentionally excluded.
            if (!isRoad && !isPlace) safeSetPaint(layer.id, 'icon-opacity', isPark ? 0.45 : 0.18);

            // Minor street names are useful only at neighbourhood zoom. Major
            // roads and locality names retain their provider zoom ranges.
            if (isRoad && !isMainRoad) {
              var existingMinZoom = Number.isFinite(layer.minzoom) ? layer.minzoom : 0;
              var existingMaxZoom = Number.isFinite(layer.maxzoom) ? layer.maxzoom : 24;
              try {
                map.setLayerZoomRange(layer.id, Math.max(13.25, existingMinZoom), existingMaxZoom);
              } catch (_) { }
            }
          });
        }

        /** Key-free OpenStreetMap building extrusions. */
        /**
         * A drawn horizon. With the camera pitched into drive view the map used
         * to end at a hard edge against the page background; a sky and its
         * ground haze are what make the same scene read as a car head-unit
         * rather than a tilted paper map.
         */
        function installSky() {
          try {
            map.setSky({
              'sky-color':'#BFE4F5',
              'sky-horizon-blend':0.6,
              'horizon-color':'#EEF5F7',
              /* Deliberately no fog. fog-color and fog-ground-blend tint the
                 GROUND rather than the sky, and at drive pitch that pulls the
                 whole scene toward one flat colour - which is indistinguishable
                 from a basemap that failed to load. The horizon earns its keep;
                 the haze does not. Atmosphere is faded out entirely by the
                 zooms this app actually drives at. */
              'atmosphere-blend':['interpolate',['linear'],['zoom'],6,0.35,12,0.12,15,0]
            });
          } catch (_) { }
        }

        /**
         * The direction chevron ridden by the guidance line. Drawn here rather
         * than shipped as a sprite so it needs no extra network request and
         * stays crisp on any device pixel ratio. Line-placed symbols are rotated
         * along the geometry, so the artwork points right.
         */
        function ensureRouteArrowImage() {
          try {
            if (map.hasImage('glivt-route-arrow')) return true;
            var size = 44;
            var canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            if (!ctx) return false;
            ctx.clearRect(0, 0, size, size);
            ctx.beginPath();
            ctx.moveTo(size * 0.30, size * 0.18);
            ctx.lineTo(size * 0.76, size * 0.50);
            ctx.lineTo(size * 0.30, size * 0.82);
            ctx.lineTo(size * 0.44, size * 0.50);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,255,255,0.97)';
            ctx.shadowColor = 'rgba(6,42,26,0.55)';
            ctx.shadowBlur = size * 0.09;
            ctx.fill();
            map.addImage(
              'glivt-route-arrow',
              ctx.getImageData(0, 0, size, size),
              { pixelRatio:2 }
            );
            return true;
          } catch (_) {
            return false;
          }
        }

        /*
         * There is deliberately no 3D terrain here.
         *
         * MapLibre's terrain drapes the map by rendering every visible layer
         * into an offscreen texture per terrain tile, and the number of those
         * tiles grows with the camera's pitch. Measured on a mid-range phone
         * (Galaxy A15, 4 GB), the drive view's GPU allocation was 1.05 GB with
         * relief on and 96 MB with it off - and the device has ~130 MB free, so
         * the map was being killed by the low-memory killer, taking the app
         * with it. Relief also buys nothing on the flat city maps this fleet
         * runs on: what reads as 3D here is the extruded buildings below, which
         * cost a fraction of that and are unaffected.
         */

        function install3DEnvironment(labelLayerId) {
          installSky();
          ensureRouteArrowImage();

          try {
            // Viewport-anchored daylight gives building sides readable depth
            // as the head-up camera turns, with no terrain or extra tiles.
            map.setLight({
              anchor:'viewport',
              color:'#FFFFFF',
              intensity:0.38,
              position:[1.2, 205, 32]
            });
          } catch (_) { }

          try {
            var hasBuildingExtrusion = ((map.getStyle() && map.getStyle().layers) || [])
              .some(function (layer) {
                return layer.type === 'fill-extrusion' &&
                  semanticLayerName(layer).toLowerCase().indexOf('building') >= 0;
              });
            if (!hasBuildingExtrusion) {
              if (!map.getSource('glivt-openfreemap')) {
                map.addSource('glivt-openfreemap', {
                  type:'vector',
                  url:'https://tiles.openfreemap.org/planet'
                });
              }
              map.addLayer({
                id:'glivt-3d-buildings',
                source:'glivt-openfreemap',
                'source-layer':'building',
                type:'fill-extrusion',
                minzoom:14.6,
                filter:['!=', ['get', 'hide_3d'], true],
                paint:{
                  'fill-extrusion-color':['interpolate',['linear'],['get','render_height'],0,'#E9EDEE',80,'#CEDADD',260,'#ABC2C7'],
                  'fill-extrusion-height':['interpolate',['linear'],['zoom'],14.6,0,15.5,['get','render_height']],
                  'fill-extrusion-base':['interpolate',['linear'],['zoom'],15.49,0,15.5,['coalesce',['get','render_min_height'],0]],
                  'fill-extrusion-opacity':0.88,
                  'fill-extrusion-vertical-gradient':true
                }
              }, labelLayerId);
            }
          } catch (_) { }
        }

        var vehicle3D = {
          camera:null,
          entities:{},
          failed:{},
          loading:{},
          prototypes:{},
          renderer:null,
          renderFailed:false,
          scene:null
        };

        /**
         * How long each body should appear on screen, in CSS pixels.
         *
         * Drawing the mesh at its true physical size is what made the 3D
         * vehicles look missing: 4.4 m of car is under three pixels at the
         * zooms this map actually uses, so the model was rendering correctly
         * and was simply too small to see. Car head units all draw the vehicle
         * as a fixed-size symbol instead, which is what these are.
         */
        var VEHICLE_SCREEN_LENGTH_PX = { CAR:62, BIKE:46, TRUCK:74 };

        /*
         * One soft contact shadow, shared by every vehicle on the map.
         *
         * The map's depth buffer is cleared before the vehicles are drawn -
         * that is what keeps a car from being buried in the road it is on - so
         * there is no ground surface left for a real shadow to fall on. An
         * alpha plane under the wheels does the one job a shadow has here:
         * planting the vehicle on the street instead of leaving it hovering
         * over it. It is built once and shared, so a fleet of fifty costs one
         * 128px texture.
         */
        var groundShadowTexture = null;
        function ensureGroundShadowTexture() {
          if (groundShadowTexture) return groundShadowTexture;
          var canvas = document.createElement('canvas');
          canvas.width = 128;
          canvas.height = 128;
          var context = canvas.getContext('2d');
          var gradient = context.createRadialGradient(64, 64, 3, 64, 64, 62);
          gradient.addColorStop(0, 'rgba(10, 20, 30, 0.40)');
          gradient.addColorStop(0.55, 'rgba(10, 20, 30, 0.18)');
          gradient.addColorStop(1, 'rgba(10, 20, 30, 0)');
          context.fillStyle = gradient;
          context.fillRect(0, 0, 128, 128);
          groundShadowTexture = new THREE.CanvasTexture(canvas);
          groundShadowTexture.colorSpace = THREE.SRGBColorSpace;
          return groundShadowTexture;
        }

        /**
         * Metres per CSS pixel at the camera's centre.
         *
         * Measure along CAMERA right, not longitude. Longitude becomes vertical
         * at an east/west bearing; dividing by its screen-X delta made the mesh
         * explode in size near 90 degrees. Unproject a small symmetric screen
         * interval to avoid both that singularity and perspective distortion.
         */
        function metresPerPixel() {
          try {
            var centre = map.getCenter();
            var pixel = map.project(centre);
            var a = map.unproject([pixel.x - 1, pixel.y]);
            var b = map.unproject([pixel.x + 1, pixel.y]);
            var metres = groundDistanceMeters(a, b) / 2;
            return Number.isFinite(metres) && metres > 0 ? metres : 1;
          } catch (_) {
            return 1;
          }
        }

        function shortestAngle(from, to) {
          return ((((to - from) % 360) + 540) % 360) - 180;
        }

        function entityPose(entity, now) {
          if (!entity || !entity.duration || now >= entity.startedAt + entity.duration) {
            return { lng:entity.targetLng, lat:entity.targetLat, heading:entity.targetHeading };
          }
          var progress = Math.max(0, Math.min(1, (now - entity.startedAt) / entity.duration));
          return {
            // Constant progress avoids visibly accelerating and braking once
            // per bridge update. The upstream road sampler already controls
            // the vehicle's actual speed.
            lng:entity.startLng + (entity.targetLng - entity.startLng) * progress,
            lat:entity.startLat + (entity.targetLat - entity.startLat) * progress,
            heading:normalizedHeading(entity.startHeading + shortestAngle(entity.startHeading, entity.targetHeading) * progress)
          };
        }

        function remove3DEntity(id) {
          var entity = vehicle3D.entities[id];
          if (!entity) return;
          if (vehicle3D.scene && entity.object) vehicle3D.scene.remove(entity.object);
          delete vehicle3D.entities[id];
          if (markerEls[id]) markerEls[id].classList.remove('model-ready');
        }

        function refresh3DVisibility() {
          // The model is screen-sized, like a navigation puck, so it remains
          // useful well below street zoom. Only a true regional overview swaps
          // it for the small coloured status puck to avoid covering whole towns.
          var detailed = map.getZoom() >= 10.5 && !vehicle3D.renderFailed;
          Object.keys(vehicle3D.entities).forEach(function (id) {
            var entity = vehicle3D.entities[id];
            var visible = detailed && !entity.hidden;
            entity.object.visible = visible;
            if (markerEls[id]) {
              markerEls[id].classList.toggle('model-ready', visible && Boolean(entity.rendered));
              if (entity.rendered) {
                markerEls[id].classList.remove('model-loading');
                markerEls[id].classList.remove('model-failed');
              }
            }
          });
        }

        function add3DEntity(marker, prototype) {
          var object = prototype.object.clone(true);
          object.matrixAutoUpdate = false;
          object.visible = !marker.hidden;
          vehicle3D.scene.add(object);
          vehicle3D.entities[marker.id] = {
            modelSize:prototype.modelSize,
            category:normalizedCategory(marker.category),
            currentHeading:normalizedHeading(marker.heading),
            currentLat:marker.lat,
            currentLng:marker.lng,
            duration:0,
            hidden:Boolean(marker.hidden),
            rendered:false,
            object:object,
            receivedAt:performance.now(),
            sourceTime:Number(marker.sourceTime || 0),
            startHeading:normalizedHeading(marker.heading),
            startLat:marker.lat,
            startLng:marker.lng,
            startedAt:performance.now(),
            targetHeading:normalizedHeading(marker.heading),
            targetLat:marker.lat,
            targetLng:marker.lng
          };
          object.traverse(function (node) {
            if (!node.isMesh) return;
            node.onAfterRender = function () {
              var entity = vehicle3D.entities[marker.id];
              if (!entity || entity.rendered) return;
              entity.rendered = true;
              if (markerEls[marker.id]) {
                markerEls[marker.id].classList.remove('model-loading');
                markerEls[marker.id].classList.remove('model-failed');
              }
              post({ type:'model-ready', category:entity.category, id:String(marker.id) });
            };
          });
          refresh3DVisibility();
        }

        function sync3DMarkers(markers) {
          if (!vehicle3D.scene) return;
          var now = performance.now();
          var nextIds = {};
          (markers || []).forEach(function (marker) {
            var id = String(marker.id);
            var category = normalizedCategory(marker.category);
            nextIds[id] = true;
            var prototype = vehicle3D.prototypes[category];
            if (!prototype) {
              if (vehicle3D.failed[category]) {
                setCategoryModelState(category, 'failed');
                return;
              }
              loadVehiclePrototype(category);
              return;
            }
            var entity = vehicle3D.entities[id];
            if (!entity || entity.category !== category) {
              remove3DEntity(id);
              add3DEntity(marker, prototype);
              entity = vehicle3D.entities[id];
            }
            var pose = entityPose(entity, now);
            var previousSourceTime = entity.sourceTime;
            var sourceGap = Number(marker.sourceTime || 0) - previousSourceTime;
            var arrivalGap = Math.max(0, now - Number(entity.receivedAt || now));
            var distance = groundDistanceMeters(
              { lat:pose.lat, lng:pose.lng },
              { lat:marker.lat, lng:marker.lng }
            );
            var canInterpolate = Boolean(marker.moving) && distance > 0.2 && distance <= 500 &&
              sourceGap > 0 && sourceGap <= 15000;
            entity.currentLat = pose.lat;
            entity.currentLng = pose.lng;
            entity.currentHeading = pose.heading;
            entity.startLat = pose.lat;
            entity.startLng = pose.lng;
            entity.startHeading = pose.heading;
            entity.targetLat = marker.lat;
            entity.targetLng = marker.lng;
            entity.targetHeading = normalizedHeading(marker.heading);
            entity.startedAt = now;
            // Animate through one bridge-delivery interval. Playback's
            // source time may advance at 4x, while live fixes may be a second
            // apart; using either as a visual duration made one lag and the
            // other crawl. Arrival cadence is the actual frame budget, with a
            // small overlap so a scheduling wobble never parks the model for a
            // frame between targets.
            entity.duration = canInterpolate ? Math.max(34, Math.min(1200, arrivalGap * 1.05)) : 0;
            entity.hidden = Boolean(marker.hidden);
            entity.sourceTime = Number(marker.sourceTime || previousSourceTime || 0);
            entity.receivedAt = now;
          });
          Object.keys(vehicle3D.entities).forEach(function (id) {
            if (!nextIds[id]) remove3DEntity(id);
          });
          refresh3DVisibility();
          map.triggerRepaint();
        }

        var requestedModels = {};
        var modelRequestAttempts = {};
        function loadVehiclePrototype(category) {
          if (
            vehicle3D.prototypes[category] ||
            vehicle3D.loading[category] ||
            vehicle3D.failed[category]
          ) return;
          setCategoryModelState(category, 'loading');
          var uri = MODEL_URIS[category];
          if (!uri) {
            /* Ask for the mesh rather than waiting to be given one. The page is
               the only side that knows both which body is on the map and that
               the 3D layer is ready to receive it, so pulling removes every
               ordering race with the native side - and it covers a vehicle that
               is hidden right now but needs its model the moment it moves. */
            if (!requestedModels[category]) {
              requestedModels[category] = true;
              modelRequestAttempts[category] = (modelRequestAttempts[category] || 0) + 1;
              post({ type:'model-request', category:category });
              setTimeout(function () {
                if (MODEL_URIS[category] || vehicle3D.prototypes[category]) return;
                if (modelRequestAttempts[category] < 3) {
                  requestedModels[category] = false;
                  loadVehiclePrototype(category);
                } else {
                  vehicle3D.failed[category] = true;
                  setCategoryModelState(category, 'failed');
                  post({ type:'model-error', category:category, message:'Vehicle model was not delivered. Reload the map to retry.' });
                }
              }, 10000);
            }
            return;
          }
          vehicle3D.loading[category] = true;
          var loader = new GLTFLoader();
          loader.load(uri, function (gltf) {
            vehicle3D.loading[category] = false;
            var object = gltf.scene;
            // These bundled transport assets export the painted body as BLEND
            // as well as the windows. That makes front/back body triangles sort
            // as glass, exposing the interior in a patchwork pattern. Repair
            // only the known body material; retain real window transparency.
            object.traverse(function (node) {
              if (!node.isMesh) return;
              var materials = Array.isArray(node.material) ? node.material : [node.material];
              materials.forEach(function (material) {
                if (material.name === 'TransportPack') {
                  material.transparent = false;
                  material.opacity = 1;
                  material.depthWrite = true;
                  material.side = THREE.FrontSide;
                  material.needsUpdate = true;
                } else if (material.name === 'TransportPack_transparent') {
                  material.depthWrite = false;
                  material.side = THREE.FrontSide;
                  material.needsUpdate = true;
                } else if (category === 'BIKE' && !material.map) {
                  // The supplied bike is untextured white. A graphite finish
                  // keeps its real geometry legible against the light basemap.
                  material.color.setHex(0x354f61);
                  material.metalness = 0.22;
                  material.roughness = 0.48;
                }
              });
            });
            object.updateMatrixWorld(true);
            var box = new THREE.Box3().setFromObject(object);
            var size = box.getSize(new THREE.Vector3());
            var center = box.getCenter(new THREE.Vector3());
            object.position.x -= center.x;
            object.position.y -= box.min.y;
            object.position.z -= center.z;
            var wrapper = new THREE.Group();
            wrapper.add(object);
            var footprint = Math.max(size.x, size.z, 0.001);
            /* Model space is Y-up and the wrapper is tilted into the map's
               Z-up world later, so the plane is laid flat here and inherits
               that rotation with the body it belongs to. Drawn first, and
               without writing depth, so the vehicle always sorts over it. */
            var shadow = new THREE.Mesh(
              new THREE.PlaneGeometry(footprint * 1.5, footprint * 1.5),
              new THREE.MeshBasicMaterial({
                map:ensureGroundShadowTexture(),
                transparent:true,
                depthWrite:false
              })
            );
            shadow.rotation.x = -Math.PI / 2;
            shadow.position.y = footprint * 0.004;
            shadow.renderOrder = -1;
            wrapper.add(shadow);
            vehicle3D.prototypes[category] = {
              // The mesh's own longest horizontal dimension, in model units.
              // Screen size is applied per frame; see VEHICLE_SCREEN_LENGTH_PX.
              modelSize:Math.max(size.x, size.z, 0.001),
              object:wrapper
            };
            setCategoryModelState(category, 'loading');
            sync3DMarkers(MARKERS);
          }, undefined, function (error) {
            vehicle3D.loading[category] = false;
            vehicle3D.failed[category] = true;
            setCategoryModelState(category, 'failed');
            post({
              type:'model-error',
              category:category,
              message:error && error.message ? error.message : 'Bundled GLB could not be decoded.'
            });
          });
        }

        function installVehicle3DLayer(labelLayerId) {
          var layer = {
            id:'glivt-vehicle-models',
            type:'custom',
            renderingMode:'3d',
            onAdd:function (mapInstance, gl) {
              vehicle3D.camera = new THREE.Camera();
              vehicle3D.scene = new THREE.Scene();
              /* Every light here is aimed for a Z-up world.
               *
               * MapLibre's mercator space puts altitude on +Z, but Three.js
               * lights default to a Y-up world - a HemisphereLight points its
               * sky at +Y unless told otherwise. So the roof of every vehicle,
               * which faces +Z, was being lit with the hemisphere's GROUND
               * colour while its flank caught the sky. That is what made the
               * models read as dark, muddy shapes instead of painted cars. */
              var skyLight = new THREE.HemisphereLight(0xeffbff, 0x64757c, 2.4);
              skyLight.position.set(0, 0, 1);
              vehicle3D.scene.add(skyLight);
              var keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
              keyLight.position.set(-0.4, -0.55, 1).normalize();
              vehicle3D.scene.add(keyLight);
              var rimLight = new THREE.DirectionalLight(0x9fdcff, 1.1);
              rimLight.position.set(0.65, 0.45, 0.35).normalize();
              vehicle3D.scene.add(rimLight);
              vehicle3D.renderer = new THREE.WebGLRenderer({
                canvas:mapInstance.getCanvas(),
                context:gl,
                antialias:false
              });
              vehicle3D.renderer.autoClear = false;
              vehicle3D.renderer.outputColorSpace = THREE.SRGBColorSpace;
              vehicle3D.renderer.toneMapping = THREE.ACESFilmicToneMapping;
              vehicle3D.renderer.toneMappingExposure = 1.05;
              // Models are requested by sync3DMarkers only when that vehicle
              // body is present, avoiding an unnecessary 7 MB bike decode on
              // car-only fleet and live-detail maps.
              sync3DMarkers(MARKERS);
            },
            render:function (_gl, projection) {
              if (!vehicle3D.camera || !vehicle3D.renderer || !vehicle3D.scene || vehicle3D.renderFailed) return;
              var mainMatrix = projection && projection.defaultProjectionData
                ? projection.defaultProjectionData.mainMatrix
                : projection;
              if (!mainMatrix) return;
              var now = performance.now();
              var animating = false;
              // One reading per frame: the camera cannot change mid-frame, and
              // every vehicle is sized against the same scale.
              var metresPerPx = metresPerPixel();

              /* Vehicles are placed in METRES around a per-frame anchor, and
               * the anchor's mercator transform rides on the camera instead.
               *
               * Writing the mercator scale straight into each object's matrix
               * is the obvious way to do this and it is why the models rendered
               * as dark, faceted lumps: that scale is around 5e-8, Three.js
               * derives its normal matrix from the object's world matrix, and
               * inverting a matrix that small costs enough precision on a
               * mobile GPU to wreck the normals - so the shading collapsed even
               * though the geometry projected to exactly the right pixels.
               * Anchoring keeps every object matrix at metre scale, where the
               * normals stay exact, and moves the tiny numbers into the
               * projection, which no normal is ever derived from. */
              var centre = map.getCenter();
              var anchor = maplibregl.MercatorCoordinate.fromLngLat([centre.lng, centre.lat], 0);
              var metreUnits = anchor.meterInMercatorCoordinateUnits();
              if (!(metreUnits > 0)) return;
              Object.keys(vehicle3D.entities).forEach(function (id) {
                var entity = vehicle3D.entities[id];
                var pose = entityPose(entity, now);
                entity.currentLat = pose.lat;
                entity.currentLng = pose.lng;
                entity.currentHeading = pose.heading;
                if (entity.duration && now < entity.startedAt + entity.duration) animating = true;
                // Flat world, so the only height a vehicle needs is the
                // hair of clearance that keeps it off the road surface.
                var mercator = maplibregl.MercatorCoordinate.fromLngLat([pose.lng, pose.lat], 0.08);
                // Three's local frame is right-handed: east, NORTH, up.
                var localX = (mercator.x - anchor.x) / metreUnits;
                var localY = (anchor.y - mercator.y) / metreUnits;
                var localZ = (mercator.z - anchor.z) / metreUnits;
                var lengthMetres =
                  (VEHICLE_SCREEN_LENGTH_PX[entity.category] || VEHICLE_SCREEN_LENGTH_PX.CAR) *
                  metresPerPx;
                var scale = (lengthMetres / entity.modelSize) *
                  (selectedMarkerId === id ? 1.14 : 1);
                var headingRadians = normalizedHeading(pose.heading) * Math.PI / 180;
                // Y-up model -> Z-up local metres. Model forward is -Z;
                // negative yaw turns north clockwise toward east. The camera
                // below converts north to Mercator south, preserving outward
                // face winding instead of rendering the inside of the mesh.
                var transform = new THREE.Matrix4()
                  .makeTranslation(localX, localY, localZ)
                  .scale(new THREE.Vector3(scale, scale, scale))
                  .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
                  .multiply(new THREE.Matrix4().makeRotationY(-headingRadians));
                entity.object.matrix.copy(transform);
                entity.object.matrixWorldNeedsUpdate = true;
              });
              // mainMatrix expects mercator coordinates, so the anchor's
              // translation and metre scale are folded in here rather than into
              // any object matrix.
              vehicle3D.camera.projectionMatrix = new THREE.Matrix4()
                .fromArray(mainMatrix)
                .multiply(
                  new THREE.Matrix4()
                    .makeTranslation(anchor.x, anchor.y, anchor.z)
                    .scale(new THREE.Vector3(metreUnits, -metreUnits, metreUnits))
                );
              vehicle3D.renderer.resetState();
              /* The vehicle shares MapLibre's depth buffer, so the road it is
                 standing on, and every 3D building around it, was
                 clipping the mesh into scattered fragments. Clearing depth first
                 draws the vehicle over the scene while still letting it sort
                 against itself, which is how a navigation puck should behave:
                 always visible, never buried in the road it is driving on. */
              vehicle3D.renderer.clearDepth();
              try {
                vehicle3D.renderer.render(vehicle3D.scene, vehicle3D.camera);
              } catch (error) {
                vehicle3D.renderFailed = true;
                post({ type:'model-error', category:'*', message:error && error.message ? error.message : '3D renderer failed.' });
              }
              // onAfterRender confirms an actual mesh draw, not just a decoded
              // asset or an entity that happens to be outside the viewport.
              refresh3DVisibility();
              if (animating) map.triggerRepaint();
            }
          };
          map.addLayer(layer, labelLayerId);
        }

        /* Recorded whether or not the map has already signalled ready. Errors
           raised after readiness used to be dropped on the floor, which is
           precisely the case that leaves a blank basemap with no explanation:
           the style parses, the scene installs, and every tile request then
           fails silently. */
        map.on('error', function (event) {
          var sourceId = event && event.sourceId ? String(event.sourceId) : '';
          lastBaseError =
            event && event.error && event.error.message
              ? event.error.message
              : 'Base map tiles failed to load.';
          if (sourceId) lastBaseError = sourceId + ': ' + lastBaseError;

        });

        // Recorded up front so the "no tiles" watchdog can name the real cause
        // rather than blaming the network for a blocked worker.
        var workerError = workerSupportError();
        if (workerError) lastBaseError = workerError;

        var sawStyleData = false;
        map.on('styledata', function () { sawStyleData = true; });

        /* Did any real tile ever arrive? A ready map that has painted nothing
           but its background layer is indistinguishable from a working one
           until this is checked, so the failure is escalated with whatever the
           renderer last complained about. */
        var sawBaseTile = false;
        /* DEM and overlay tiles do not prove that a road tile rendered, so the
           same two types decide both what counts as a base tile and whether any
           base tile was ever owed. */
        function isBaseTileSource(type) {
          return type === 'vector' || type === 'raster';
        }
        /* A style that declares no tile source has nothing to wait for. Without
           this the watchdog below reported a background-only style - a diagnostic
           or offline scene that is drawing exactly what it was asked to draw - as
           a dead map, and said every tile request had failed when not one had
           ever been made. */
        function expectsBaseTiles() {
          try {
            var sources = (map.getStyle() || {}).sources || {};
            return Object.keys(sources).some(function (id) {
              return Boolean(sources[id]) && isBaseTileSource(sources[id].type);
            });
          } catch (_) {
            return false;
          }
        }
        map.on('data', function (event) {
          if (!event || event.dataType !== 'source' || !event.tile || event.tile.state !== 'loaded') return;
          var source = event.sourceId && map.getSource(event.sourceId);
          if (!source || !isBaseTileSource(source.type)) return;
          sawBaseTile = true;
          if (BASE_READY && hasReportedMapError) {
            clearError();
            post({ type:'recovered' });
          }
        });

        /* A slow network is not a broken map. Two things used to turn one into
           the other: a single 12 s deadline, and no way back once it expired.
           Now a style request that has produced nothing at all is re-issued
           once - that is a stalled socket, not slow progress - and the hard
           failure is only reported much later, when the map really is dead. */
        setTimeout(function () {
          if (BASE_READY || sawStyleData) return;
          try { map.setStyle(STYLE, { diff:false }); } catch (_) { }
        }, 11000);
        setTimeout(function () {
          if (!BASE_READY) reportError(lastBaseError || 'Map style is taking too long to load.');
        }, 32000);
        setTimeout(function () {
          if (!BASE_READY || sawBaseTile || !expectsBaseTiles()) return;
          reportError(
            lastBaseError
              ? 'No map tiles loaded. ' + lastBaseError
              : 'No map tiles loaded. The style opened but every tile request failed.'
          );
        }, 24000);

        /* Installing the scene used to wait for MapLibre's 'load' event, which
           does not fire until the style AND the first screenful of tiles have
           arrived. Every call below - addSource, addLayer - is legal
           as soon as the style itself is parsed, so readiness no longer waits on
           tile downloads that the map renders progressively anyway. */
        var sceneInstalled = false;
        /* Deliberately not isStyleLoaded(): that also waits for every source
           cache to settle, which is the same tile round-trip the old 'load'
           gate was stuck behind. The only precondition for addSource, addLayer
           and firstLabelLayerId is a parsed style, and a readable layer list is
           exactly that. */
        function styleParsed() {
          try {
            var style = map.getStyle();
            return Boolean(style && style.layers && style.layers.length);
          } catch (_) {
            return false;
          }
        }
        function installScene() {
          if (sceneInstalled || !styleParsed()) return;
          sceneInstalled = true;
          applyPremiumFleetVectorTheme();
          var labelLayerId = firstLabelLayerId();
          install3DEnvironment(labelLayerId);
          /* The live trail. Line metrics let the core fade from a cool, spent
             blue at the oldest fix to a bright head at the vehicle, so the
             direction it has just travelled is legible without any marker. */
          map.addSource('route', { type: 'geojson', data: emptyCollection(), lineMetrics: true });
          /* Runs already finished, drawn whole. In progress mode these are the
             runs behind the one the vehicle is in; with no progress the filter
             matches nothing and every run is drawn by the layers below. */
          map.addLayer({ id:'route-done-aura', type:'line', source:'route',
            filter:NO_RUNS, layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(0, 122, 255, 0.26)',
                    'line-width':['interpolate',['linear'],['zoom'],8,10,14,20,18,30],
                    'line-blur':['interpolate',['linear'],['zoom'],8,5,14,11,18,18] } }, labelLayerId);
          map.addLayer({ id:'route-done-shadow', type:'line', source:'route',
            filter:NO_RUNS, layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(255,255,255,0.96)',
                    'line-width':['interpolate',['linear'],['zoom'],8,6,14,10,18,14] } }, labelLayerId);
          map.addLayer({ id:'route-done', type:'line', source:'route',
            filter:NO_RUNS, layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'#0057D8',
                    'line-width':['interpolate',['linear'],['zoom'],8,3,14,6.4,18,10] } }, labelLayerId);

          /* The run being travelled. Every one of these is clipped by a
             gradient over line-progress rather than by its geometry, which is
             what lets a playing trip move the head twenty-five times a second
             without the source being replaced, re-parsed or re-tiled once. */
          map.addLayer({ id:'route-aura', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-gradient':['step',['line-progress'],'rgba(0, 122, 255, 0.26)',1,'rgba(0, 122, 255, 0.26)'],
                    'line-width':['interpolate',['linear'],['zoom'],8,10,14,20,18,30],
                    'line-blur':['interpolate',['linear'],['zoom'],8,5,14,11,18,18] } }, labelLayerId);
          map.addLayer({ id:'route-shadow', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-gradient':['step',['line-progress'],'rgba(255,255,255,0.96)',1,'rgba(255,255,255,0.96)'],
                    'line-width':['interpolate',['linear'],['zoom'],8,6,14,10,18,14] } }, labelLayerId);
          map.addLayer({ id:'route', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-width':['interpolate',['linear'],['zoom'],8,3,14,6.4,18,10],
                    'line-gradient':FULL_ROUTE_GRADIENT } }, labelLayerId);

          // Planned navigation is deliberately separate from the live trail.
          // Progress may clip this road geometry, but it can never move the
          // vehicle marker, which is fed only by validated SSE positions.
          map.addSource('navigation-alternatives', { type:'geojson', data:emptyCollection() });
          map.addLayer({ id:'navigation-alternatives-casing', type:'line', source:'navigation-alternatives',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':FLEET_PALETTE.background, 'line-opacity':0.9,
                    'line-width':['interpolate',['linear'],['zoom'],8,5,14,8,18,11] } }, labelLayerId);
          map.addLayer({ id:'navigation-alternatives', type:'line', source:'navigation-alternatives',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':['get','color'], 'line-opacity':0.68,
                    'line-width':['interpolate',['linear'],['zoom'],8,2,14,4,18,6] } }, labelLayerId);
          /* The road ahead, drawn the way a factory-fit head unit draws it: a
             soft ground glow that lifts the line off the basemap, a dark casing
             so it stays legible over any surface colour, a depth-graded core,
             and chevrons riding the geometry so the direction of travel is
             readable at a glance without reading a single label.
             Line metrics are what make the gradient core possible. */
          map.addSource('navigation-remaining', {
            type:'geojson', data:emptyCollection(), lineMetrics:true
          });
          map.addLayer({ id:'navigation-remaining-glow', type:'line', source:'navigation-remaining',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':FLEET_PALETTE.selectedRoute, 'line-opacity':0.22,
                    'line-blur':['interpolate',['linear'],['zoom'],8,5,14,12,18,20],
                    'line-width':['interpolate',['linear'],['zoom'],8,12,14,24,18,38] } }, labelLayerId);
          map.addLayer({ id:'navigation-remaining-casing', type:'line', source:'navigation-remaining',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':FLEET_PALETTE.selectedRouteOutline,
                    'line-width':['interpolate',['linear'],['zoom'],8,6,14,11,18,16] } }, labelLayerId);
          map.addLayer({ id:'navigation-remaining', type:'line', source:'navigation-remaining',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-width':['interpolate',['linear'],['zoom'],8,3.4,14,7,18,11],
                    'line-gradient':['interpolate',['linear'],['line-progress'],
                      0,'#4C8DF6', 0.5,FLEET_PALETTE.selectedRoute, 1,'#174EA6'] } }, labelLayerId);
          if (ensureRouteArrowImage()) {
            map.addLayer({ id:'navigation-remaining-arrows', type:'symbol', source:'navigation-remaining',
              layout:{ 'symbol-placement':'line',
                       'symbol-spacing':['interpolate',['linear'],['zoom'],10,58,16,104],
                       'icon-image':'glivt-route-arrow', 'icon-allow-overlap':true,
                       'icon-ignore-placement':true, 'icon-rotation-alignment':'map',
                       'icon-size':['interpolate',['linear'],['zoom'],10,0.52,16,0.8] },
              paint:{ 'icon-opacity':0.95 } }, labelLayerId);
          }
          map.addSource('navigation-completed', { type:'geojson', data:emptyCollection() });
          map.addLayer({ id:'navigation-completed', type:'line', source:'navigation-completed',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':FLEET_PALETTE.alternativeRouteSlate, 'line-opacity':0.5,
                    'line-width':['interpolate',['linear'],['zoom'],8,3,14,6,18,9] } }, labelLayerId);
          map.addSource('navigation-terminals', { type:'geojson', data:emptyCollection() });
          map.addLayer({ id:'navigation-terminals', type:'circle', source:'navigation-terminals',
            paint:{ 'circle-color':['get','color'], 'circle-radius':10,
                    'circle-stroke-color':'#FFFFFF', 'circle-stroke-width':3 } }, labelLayerId);
          map.addLayer({ id:'navigation-terminal-labels', type:'symbol', source:'navigation-terminals',
            layout:{ 'text-field':['get','label'], 'text-size':11,
                     'text-font':['Noto Sans Regular'], 'text-allow-overlap':true },
            paint:{ 'text-color':'#FFFFFF' } }, labelLayerId);
          map.addSource('navigation-route-labels', { type:'geojson', data:emptyCollection() });
          map.addLayer({ id:'navigation-route-labels', type:'symbol', source:'navigation-route-labels',
            layout:{ 'text-field':['get','label'], 'text-size':12, 'text-line-height':1.15,
                     'text-font':['Noto Sans Regular'], 'text-allow-overlap':true,
                     'text-ignore-placement':true },
            paint:{ 'text-color':['case',['boolean',['get','selected'],false],FLEET_PALETTE.selectedRoute,FLEET_PALETTE.secondaryLabel],
                    'text-halo-color':'rgba(255,255,255,0.98)', 'text-halo-width':5,
                    'text-halo-blur':1 } }, labelLayerId);

          // GPS-only diagnostic. Deliberately thin, dashed and amber, and drawn
          // UNDER the road route: it must never be mistakable for the
          // authoritative road-following line. It carries stretches the matcher
          // could not place, which are chords between fixes rather than roads.
          map.addSource('gps-only-route', { type:'geojson', data: emptyCollection() });
          map.addLayer({ id:'gps-only-route', type:'line', source:'gps-only-route',
            layout:{ 'line-cap':'butt','line-join':'round' },
            paint:{ 'line-color':'#F59E0B',
                    'line-opacity':0.85,
                    'line-dasharray':[2, 2],
                    'line-width':['interpolate',['linear'],['zoom'],8,1,14,2,18,3] } }, 'route-aura');

          // Recorded history sits beneath the live/progress route: one muted
          // line per observed run (never joined across a coverage gap) plus a
          // red numbered circle for every detected stop.
          map.addSource('history-route', { type:'geojson', data: emptyCollection() });
          /* The road ahead of the playhead. It is the SAME road the blue line
             reveals, so it is drawn to the same zoom ramp with the same white
             casing: at drive zoom a fixed 5px grey thread beside a 10px blue
             one read as two different routes rather than one being uncovered. */
          map.addLayer({ id:'history-route-casing', type:'line', source:'history-route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(255,255,255,0.92)',
                    'line-width':['interpolate',['linear'],['zoom'],8,6,14,10,18,14] } }, 'route-aura');
          map.addLayer({ id:'history-route', type:'line', source:'history-route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(140,161,181,0.82)',
                    'line-width':['interpolate',['linear'],['zoom'],8,3,14,6.4,18,10] } }, 'route-aura');
          map.addSource('history-stops', { type:'geojson', data: emptyCollection() });
          map.addLayer({ id:'history-stops', type:'circle', source:'history-stops',
            paint:{ 'circle-color':'#EF4444',
                    'circle-radius':['case',['get','active'],11,8],
                    'circle-stroke-color':'#FFFFFF',
                    'circle-stroke-width':['case',['get','active'],3,1.5] } }, labelLayerId);
          map.addLayer({ id:'history-stop-labels', type:'symbol', source:'history-stops',
            layout:{ 'text-field':['get','label'], 'text-size':10,
                     'text-font':['Noto Sans Regular'], 'text-allow-overlap':true },
            paint:{ 'text-color':'#FFFFFF' } }, labelLayerId);
          map.addSource('history-events', { type:'geojson', data: emptyCollection() });
          map.addLayer({ id:'history-events', type:'circle', source:'history-events',
            paint:{ 'circle-color':'#F59E0B', 'circle-radius':7,
                    'circle-stroke-color':'#FFFFFF', 'circle-stroke-width':2 } }, labelLayerId);
          map.addLayer({ id:'history-event-labels', type:'symbol', source:'history-events',
            layout:{ 'text-field':['get','label'], 'text-size':9,
                     'text-font':['Noto Sans Regular'], 'text-offset':[0,1.45],
                     'text-allow-overlap':false },
            paint:{ 'text-color':'#8A4A00', 'text-halo-color':'#FFFFFF',
                    'text-halo-width':1.2 } }, labelLayerId);
          map.addSource('history-terminals', { type:'geojson', data: emptyCollection() });
          map.addLayer({ id:'history-terminals', type:'circle', source:'history-terminals',
            paint:{ 'circle-color':['get','color'], 'circle-radius':9,
                    'circle-stroke-color':'#FFFFFF', 'circle-stroke-width':2.5 } }, labelLayerId);
          map.addLayer({ id:'history-terminal-labels', type:'symbol', source:'history-terminals',
            layout:{ 'text-field':['get','label'], 'text-size':10,
                     'text-font':['Noto Sans Regular'], 'text-allow-overlap':true },
            paint:{ 'text-color':'#FFFFFF' } }, labelLayerId);

          // Geofences sit beneath the route and markers so a vehicle is never
          // obscured by the zone it is sitting in.
          map.addSource('geofences', { type:'geojson', data: emptyCollection() });
          map.addLayer({ id:'geofence-fill', type:'fill', source:'geofences',
            paint:{ 'fill-color':['get','color'], 'fill-opacity':0.14 } }, 'route-aura');
          map.addLayer({ id:'geofence-line', type:'line', source:'geofences',
            paint:{ 'line-color':['get','color'], 'line-width':2 } }, 'route-aura');
          map.addLayer({ id:'geofence-label', type:'symbol', source:'geofences',
            layout:{ 'text-field':['get','name'], 'text-size':11,
                     'text-font':['Noto Sans Regular'], 'text-allow-overlap':false },
            paint:{ 'text-color':['get','color'], 'text-halo-color':'rgba(3,12,22,0.85)',
                    'text-halo-width':1.4 } }, labelLayerId);
          syncGeofenceSource();
          // The regular DOM marker remains usable if a particular WebView/GPU
          // cannot initialise the custom Three.js layer - and while Three.js is
          // still downloading, since the map no longer waits for it.
          loadThree().then(function (available) {
            if (!available) return;
            try {
              installVehicle3DLayer(labelLayerId);
              sync3DMarkers(MARKERS);
            } catch (error) {
              vehicle3D.renderFailed = true;
              refresh3DVisibility();
              setAllModelStates('failed');
              post({ type:'model-error', category:'*', message:error && error.message ? error.message : '3D layer could not be installed.' });
            }
          });
          BASE_READY = true;
          applyRouteProgress();
          clearError();
          // Replay whatever arrived before the style finished loading. Without
          // this a diagnostic overlay pushed during load is silently lost.
          if (DIAGNOSTIC_LINES.length) {
            window.__glivtSyncDiagnosticRoutes(DIAGNOSTIC_LINES);
          }
          post({ type:'ready' });
        }
        map.on('style.load', installScene);
        map.on('styledata', installScene);
        map.on('load', installScene);
        // A style served from the WebView cache can be parsed before either
        // event is bound, which would otherwise leave the map permanently blank.
        installScene();

        map.on('move', function () { reportProjection(false); });
        map.on('zoom', refresh3DVisibility);
        map.on('moveend', function () {
          reportVisibleMarkers();
          // The follow loop ends a move on every frame. Its own throttled
          // reporting covers that case; this one is for camera moves that
          // actually finish.
          if (followFrame === null) reportProjection(true);
        });
        function operatorTookTheCamera() {
          operatorMovedCamera = true;
          hasFramedFleet = true;
        }
        map.on('dragstart', function () {
          operatorTookTheCamera();
          post({ type:'interaction' });
        });
        // Pinch-zoom and two-finger rotate are the operator choosing a view just
        // as much as a drag is, and framing the fleet out from under either of
        // them is the same wrong answer.
        map.on('zoomstart', function (event) {
          if (event && event.originalEvent) operatorTookTheCamera();
        });
        map.on('rotatestart', function (event) {
          if (event && event.originalEvent) operatorTookTheCamera();
        });
        map.on('click', 'navigation-alternatives', function (event) {
          var feature = event && event.features && event.features[0];
          var routeIndex = feature && Number(feature.properties && feature.properties.routeIndex);
          if (Number.isSafeInteger(routeIndex)) {
            post({ type:'select-navigation-route', index:routeIndex });
          }
        });
        map.on('mouseenter', 'navigation-alternatives', function () {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'navigation-alternatives', function () {
          map.getCanvas().style.cursor = '';
        });
        map.on('click', function (event) {
          // A layer click also reaches the generic map listener. Keep the
          // map state intact when the click was choosing an alternative route.
          var navigationHits = map.queryRenderedFeatures(event.point, {
            layers:['navigation-alternatives', 'navigation-remaining']
          });
          if (navigationHits && navigationHits.length) return;
          post({ type:'clear-selection' });
        });

        function makeMarker(m) {
            var el = document.createElement('div');
            el.className = 'glivt-marker model-loading';
            el.style.setProperty('--vehicle-color', m.color);
            el.dataset.category = normalizedCategory(m.category);
            el.classList.toggle('moving', Boolean(m.moving));
            var vehicle = document.createElement('div');
            vehicle.className = 'glivt-vehicle';
            vehicle.style.setProperty(
              '--heading',
              normalizedHeading(m.heading - map.getBearing()) + 'deg'
            );
            var beam = document.createElement('span');
            beam.className = 'glivt-beam';
            var loader = document.createElement('span');
            loader.className = 'glivt-model-loader';
            loader.textContent = '!';
            var label = document.createElement('div');
            label.className = 'glivt-label';
            // A single-vehicle screen names its vehicle in its own header, and
            // an id is not a name: "Vehicle vehicle" was the playback marker.
            label.textContent = m.label || '';
            vehicle.appendChild(beam);
            vehicle.appendChild(loader);
            el.appendChild(vehicle);
            el.appendChild(label);
            el.style.opacity = m.hidden ? '0' : '1';
            el.style.pointerEvents = m.hidden ? 'none' : 'auto';
            el.addEventListener('click', function (event) {
              event.stopPropagation();
              post({ type:'select', id: m.id });
            });
            markerEls[m.id] = el;
            el.dataset.sourceTime = String(m.sourceTime || 0);
            el.dataset.receivedAt = String(performance.now());
            markerRefs[m.id] = new maplibregl.Marker({ element: el, anchor: 'center' })
              .setLngLat([m.lng, m.lat])
              .addTo(map);
        }

        function moveMarkerToAcceptedFix(m) {
          var ref = markerRefs[m.id];
          var el = markerEls[m.id];
          if (!ref || !el) return;
          if (markerAnimations[m.id]) {
            cancelAnimationFrame(markerAnimations[m.id]);
            delete markerAnimations[m.id];
          }
          var from = ref.getLngLat();
          var target = { lng:m.lng, lat:m.lat };
          var distance = groundDistanceMeters(from, target);
          var previousSourceTime = Number(el.dataset.sourceTime || 0);
          var sourceGap = Number(m.sourceTime || 0) - previousSourceTime;
          var now = performance.now();
          var arrivalGap = Math.max(0, now - Number(el.dataset.receivedAt || now));
          el.dataset.sourceTime = String(m.sourceTime || previousSourceTime || 0);
          el.dataset.receivedAt = String(now);

          // Interpolation exists only between two accepted SSE targets. A long
          // reporting gap has no observed path between its ends, so it is
          // placed directly rather than pretending the vehicle drove the chord.
          var canInterpolate = Boolean(m.moving) && distance > 0.2 && distance <= 500 &&
            sourceGap > 0 && sourceGap <= 15000;
          if (!canInterpolate) {
            ref.setLngLat([m.lng, m.lat]);
            return;
          }
          var duration = Math.max(34, Math.min(1200, arrivalGap * 1.05));
          var startedAt = now;
          var tick = function (now) {
            var fraction = Math.min(1, (now - startedAt) / duration);
            ref.setLngLat([
              from.lng + (m.lng - from.lng) * fraction,
              from.lat + (m.lat - from.lat) * fraction
            ]);
            if (fraction < 1) {
              markerAnimations[m.id] = requestAnimationFrame(tick);
            } else {
              delete markerAnimations[m.id];
            }
          };
          markerAnimations[m.id] = requestAnimationFrame(tick);
        }

        window.__glivtFit = fitToData;
        window.__glivtFitNavigation = fitNavigation;
        window.__glivtZoomIn = function () { if (map) map.zoomIn(); };
        window.__glivtZoomOut = function () { if (map) map.zoomOut(); };
        window.__glivtResetBearing = function () { if (map) map.setBearing(0); };
        window.__glivtRecenterNavigation = function () {
          applyCamera(true);
        };
        function emptyCollection() {
          return { type:'FeatureCollection', features: [] };
        }

        /**
         * A geofence radius as a ground polygon.
         *
         * MapLibre's circle-radius is measured in screen pixels, so a pixel
         * circle would keep its size as the map zooms and stop describing the
         * zone. A polygon in geographic coordinates stays true to the ground,
         * which is what keeps the boundary correct through zoom and pan.
         */
        function ringPolygon(lat, lng, metres) {
          var points = [];
          var segments = 72;
          var latDelta = metres / 111320;
          var cos = Math.cos((lat * Math.PI) / 180);
          var lngDelta = metres / (111320 * (Math.abs(cos) < 1e-6 ? 1e-6 : cos));
          for (var i = 0; i <= segments; i++) {
            var angle = (i / segments) * 2 * Math.PI;
            points.push([lng + lngDelta * Math.cos(angle), lat + latDelta * Math.sin(angle)]);
          }
          return points;
        }

        function syncGeofenceSource() {
          if (!map) return;
          var source = map.getSource('geofences');
          if (!source) return;
          var features = GEOFENCES.map(function (g) {
            return {
              type:'Feature',
              properties:{ name: g.name || '', color: g.color || '#1A73E8' },
              geometry:{ type:'Polygon', coordinates:[ ringPolygon(g.lat, g.lng, g.radius) ] }
            };
          });
          source.setData({ type:'FeatureCollection', features: features });
        }

        /**
         * Hand the page one vehicle model. Called once per body type that is
         * actually on screen, so a car-only fleet never pays for the bike mesh.
         * A body that previously failed is cleared for a fresh attempt.
         */
        window.__glivtSetVehicleModel = function (category, uri) {
          if (!category || !uri || (MODEL_URIS[category] === uri && !vehicle3D.failed[category])) return;
          MODEL_URIS[category] = uri;
          delete vehicle3D.failed[category];
          // A body that had already been asked for may be delivered again after
          // a failure, so clear the request latch rather than blocking a retry.
          requestedModels[category] = false;
          if (vehicle3D.scene) sync3DMarkers(MARKERS);
        };

        /**
         * Reveal the road up to the playhead.
         *
         * Nothing here writes geometry. The active run is clipped by a gradient
         * over its own line-progress, and the runs behind it are turned on by a
         * filter - both paint-time decisions, so a frame costs a uniform update
         * rather than a re-parse and a re-tile of a line thousands of points
         * long. Passing null returns the map to drawing every run whole, which
         * is what live tracking needs: there the geometry really is changing.
         */
        /* What the six route layers were last told.
           A filter is not a uniform: MapLibre re-evaluates it against every
           feature in the source and re-tiles what changes. Re-issuing the same
           two filters on every animation frame is what made a long route jerk
           while the vehicle over it moved smoothly, so a filter is now written
           only when the run being travelled actually changes. */
        var appliedRunIndex = null;
        var appliedCut = -1;
        /* Set when the layers may no longer match what this cache claims -
           at startup they do, because the layer definitions below ARE the
           no-progress state. */
        var routeLayersDirty = false;

        function applyRouteProgress() {
          if (!BASE_READY || !map.getLayer('route')) return;
          var progress = DISPLAY_ROUTE_PROGRESS;

          if (!progress) {
            if (routeLayersDirty || appliedRunIndex !== null) {
              appliedRunIndex = null;
              appliedCut = -1;
              routeLayersDirty = false;
              map.setFilter('route-done-aura', NO_RUNS);
              map.setFilter('route-done-shadow', NO_RUNS);
              map.setFilter('route-done', NO_RUNS);
              map.setFilter('route-aura', null);
              map.setFilter('route-shadow', null);
              map.setFilter('route', null);
              map.setPaintProperty('route-aura', 'line-gradient', solidGradient('rgba(0, 122, 255, 0.26)'));
              map.setPaintProperty('route-shadow', 'line-gradient', solidGradient('rgba(255,255,255,0.96)'));
              map.setPaintProperty('route', 'line-gradient', FULL_ROUTE_GRADIENT);
            }
            return;
          }

          if (routeLayersDirty || appliedRunIndex !== progress.runIndex) {
            appliedRunIndex = progress.runIndex;
            routeLayersDirty = false;
            var active = ['==', ['get','runIndex'], progress.runIndex];
            var finished = ['<', ['get','runIndex'], progress.runIndex];
            map.setFilter('route-done-aura', finished);
            map.setFilter('route-done-shadow', finished);
            map.setFilter('route-done', finished);
            map.setFilter('route-aura', active);
            map.setFilter('route-shadow', active);
            map.setFilter('route', active);
            appliedCut = -1;
          }

          // A gradient's stops must strictly increase, so a playhead sitting on
          // the very start of a run is nudged off zero rather than rejected.
          var cut = Math.max(0.002, Math.min(1, progress.fraction));
          /* The gradient is rasterised into a 256-wide ramp, so a change too
             small to move it by a texel cannot change a pixel on screen. */
          if (Math.abs(cut - appliedCut) < 0.002 && cut !== 1) return;
          appliedCut = cut;
          map.setPaintProperty('route-aura', 'line-gradient', clippedGradient('rgba(0, 122, 255, 0.26)', cut));
          map.setPaintProperty('route-shadow', 'line-gradient', clippedGradient('rgba(255,255,255,0.96)', cut));
          map.setPaintProperty('route', 'line-gradient', clippedRouteGradient(cut));
        }

        window.__glivtSetRouteProgress = function (runIndex, fraction) {
          var next =
            typeof runIndex === 'number' && typeof fraction === 'number' && isFinite(fraction)
              ? { runIndex: runIndex, fraction: Math.max(0, Math.min(1, fraction)) }
              : null;
          var now = performance.now();
          var previous = DISPLAY_ROUTE_PROGRESS;
          var arrivalGap = lastRouteProgressAt > 0 ? now - lastRouteProgressAt : 0;
          lastRouteProgressAt = now;
          ROUTE_PROGRESS = next;
          if (routeProgressFrame !== null) {
            cancelAnimationFrame(routeProgressFrame);
            routeProgressFrame = null;
          }
          var canAnimate = Boolean(
            next && previous && next.runIndex === previous.runIndex &&
            next.fraction >= previous.fraction && next.fraction - previous.fraction <= 0.08 &&
            arrivalGap > 0 && arrivalGap < 250
          );
          if (!canAnimate) {
            DISPLAY_ROUTE_PROGRESS = next;
            applyRouteProgress();
            return;
          }
          var from = previous.fraction;
          var duration = Math.max(34, Math.min(100, arrivalGap * 1.18));
          var tick = function (frameNow) {
            var progress = Math.min(1, (frameNow - now) / duration);
            DISPLAY_ROUTE_PROGRESS = {
              runIndex:next.runIndex,
              fraction:from + (next.fraction - from) * progress
            };
            applyRouteProgress();
            map.triggerRepaint();
            if (progress < 1) routeProgressFrame = requestAnimationFrame(tick);
            else routeProgressFrame = null;
          };
          routeProgressFrame = requestAnimationFrame(tick);
        };

        /**
         * Chrome insets from the host screen, in CSS pixels.
         *
         * Applied on the next follow frame and by the next fit, so a deck that
         * measures itself after the first layout still moves the camera.
         */
        /**
         * Whether this document is the map on screen.
         *
         * A backgrounded map is kept intact - engine, style, tiles and decoded
         * meshes all stay in memory, which is what makes returning to it
         * instant - but it stops driving its camera and stops reporting, so it
         * costs nothing while it waits. MapLibre only redraws when something
         * changes, and with the native side no longer pushing, nothing does.
         */
        window.__glivtSetActive = function (next) {
          var active = next !== false;
          if (active === PAGE_ACTIVE) return;
          PAGE_ACTIVE = active;
          if (!active) {
            stopFollowLoop();
            Object.keys(markerAnimations).forEach(function (id) {
              cancelAnimationFrame(markerAnimations[id]);
              delete markerAnimations[id];
            });
            if (routeProgressFrame !== null) {
              cancelAnimationFrame(routeProgressFrame);
              routeProgressFrame = null;
            }
            return;
          }
          applyCamera(true);
        };

        window.__glivtSetViewportPadding = function (next) {
          VIEW_PADDING = {
            top:Math.max(0, Number(next && next.top) || 0),
            bottom:Math.max(0, Number(next && next.bottom) || 0),
            left:Math.max(0, Number(next && next.left) || 0),
            right:Math.max(0, Number(next && next.right) || 0)
          };
          /* A control deck measures itself after its first layout, so the real
             insets arrive one frame behind the camera that needs them. Re-frame
             on the spot: the camera is already on the vehicle, so all that
             actually moves is the padding this call just changed. */
          if (BASE_READY && followSelected && selectedMarkerId != null) startFollowLoop(true);
        };

        window.__glivtSyncGeofences = function (list) {
          GEOFENCES = Array.isArray(list) ? list : [];
          if (!BASE_READY) return;
          syncGeofenceSource();
        };

        /* One route repaint per animation frame.
           The route arrives as a stream of small extensions while a trip plays,
           and calling setData for each of them re-parses and re-tiles the whole
           line more often than the renderer can draw it - which is seen as a
           line that stutters and blinks rather than one that grows. Coalescing
           to the frame gives the renderer exactly one new version per frame it
           is actually going to paint. */
        var routeRepaintHandle = null;
        function paintRoute() {
          routeRepaintHandle = null;
          var routeSource = map.getSource('route');
          if (!routeSource) return;
          routeSource.setData({
            type:'FeatureCollection',
            features: LINES.map(function (line, index) {
              // The run's ordinal is what the finished/active filters select
              // on, so which part of the road is behind the vehicle is decided
              // without touching the geometry.
              return { type:'Feature', properties:{ runIndex: index },
                       geometry:{ type:'LineString', coordinates: line } };
            })
          });
        }
        function scheduleRoutePaint() {
          if (!BASE_READY || routeRepaintHandle !== null) return;
          routeRepaintHandle = requestAnimationFrame(paintRoute);
        }

        window.__glivtSyncRoutes = function (lines) {
          LINES = Array.isArray(lines) ? lines : [];
          // New geometry invalidates what the layers were last told, so the
          // filters and the clip are written again rather than skipped as
          // already-applied.
          routeLayersDirty = true;
          scheduleRoutePaint();
          applyRouteProgress();
        };
        /* Apply the tail the native side worked out instead of a whole route.
           The from index is where the new vertices start, so the moving head
           vertex is overwritten rather than duplicated. */
        window.__glivtExtendRoutes = function (extensions) {
          if (!Array.isArray(extensions) || extensions.length === 0) return;
          for (var i = 0; i < extensions.length; i += 1) {
            var extension = extensions[i];
            var line = LINES[extension.index];
            if (!line) continue;
            line.length = extension.from;
            for (var c = 0; c < extension.coords.length; c += 1) {
              line.push(extension.coords[c]);
            }
          }
          scheduleRoutePaint();
        };
        window.__glivtSyncDiagnosticRoutes = function (lines) {
          DIAGNOSTIC_LINES = Array.isArray(lines) ? lines : [];
          if (!BASE_READY) return;
          var source = map.getSource('gps-only-route');
          if (source) {
            source.setData({
              type:'FeatureCollection',
              features: DIAGNOSTIC_LINES.map(function (line) {
                return { type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates: line } };
              })
            });
          }
        };
        window.__glivtSyncHistory = function (payload) {
          HISTORY = payload && typeof payload === 'object' ? payload : { routes: [], stops: [] };
          if (!BASE_READY) return;
          var routeSource = map.getSource('history-route');
          if (routeSource) {
            routeSource.setData({
              type:'FeatureCollection',
              features: (HISTORY.routes || []).map(function (line) {
                return { type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates: line } };
              })
            });
          }
          var stopSource = map.getSource('history-stops');
          if (stopSource) {
            stopSource.setData({
              type:'FeatureCollection',
              features: (HISTORY.stops || []).map(function (stop) {
                return {
                  type:'Feature',
                  properties:{ label: String(stop.index), active: Boolean(stop.active) },
                  geometry:{ type:'Point', coordinates: [stop.lng, stop.lat] }
                };
              })
            });
          }
          var eventSource = map.getSource('history-events');
          if (eventSource) {
            eventSource.setData({
              type:'FeatureCollection',
              features: (HISTORY.events || []).map(function (event) {
                return {
                  type:'Feature',
                  properties:{ label: event.label || '' },
                  geometry:{ type:'Point', coordinates: [event.lng, event.lat] }
                };
              })
            });
          }
          var terminalSource = map.getSource('history-terminals');
          if (terminalSource) {
            var terminals = [];
            if (HISTORY.start) terminals.push({ point:HISTORY.start, label:'A', color:'#1B66C9' });
            if (HISTORY.end) terminals.push({ point:HISTORY.end, label:'B', color:'#1473E6' });
            terminalSource.setData({
              type:'FeatureCollection',
              features: terminals.map(function (terminal) {
                return {
                  type:'Feature',
                  properties:{ label:terminal.label, color:terminal.color },
                  geometry:{ type:'Point', coordinates:[terminal.point.lng, terminal.point.lat] }
                };
              })
            });
          }
        };
        window.__glivtSyncNavigation = function (payload, shouldFit) {
          NAVIGATION = payload && typeof payload === 'object'
            ? payload
            : { routeId:'', completedRoutes:[], remainingRoute:[], alternativeRoutes:[], routeLabels:[], start:null, destination:null };
          if (!BASE_READY) return;
          var alternativesSource = map.getSource('navigation-alternatives');
          if (alternativesSource) {
            alternativesSource.setData({
              type:'FeatureCollection',
              features:(NAVIGATION.alternativeRoutes || []).filter(function (route) {
                return route.coordinates && route.coordinates.length >= 2;
              }).map(function (route) {
                return {
                  type:'Feature',
                  properties:{ routeIndex:route.index, color:route.color || '#60A5FA' },
                  geometry:{ type:'LineString', coordinates:route.coordinates }
                };
              })
            });
          }
          var remainingSource = map.getSource('navigation-remaining');
          if (remainingSource) {
            remainingSource.setData({
              type:'FeatureCollection',
              features:(NAVIGATION.remainingRoute || []).length >= 2
                ? [{ type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates:NAVIGATION.remainingRoute } }]
                : []
            });
          }
          var completedSource = map.getSource('navigation-completed');
          if (completedSource) {
            completedSource.setData({
              type:'FeatureCollection',
              features:(NAVIGATION.completedRoutes || []).filter(function (line) { return line.length >= 2; })
                .map(function (line) {
                  return { type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates:line } };
                })
            });
          }
          var terminalsSource = map.getSource('navigation-terminals');
          if (terminalsSource) {
            var terminals = [];
            if (NAVIGATION.start) terminals.push({ point:NAVIGATION.start, label:'A', color:'#1B66C9' });
            if (NAVIGATION.destination) terminals.push({ point:NAVIGATION.destination, label:'B', color:'#111827' });
            terminalsSource.setData({
              type:'FeatureCollection',
              features:terminals.map(function (terminal) {
                return {
                  type:'Feature',
                  properties:{ label:terminal.label, color:terminal.color },
                  geometry:{ type:'Point', coordinates:[terminal.point.lng, terminal.point.lat] }
                };
              })
            });
          }
          var routeLabelsSource = map.getSource('navigation-route-labels');
          if (routeLabelsSource) {
            routeLabelsSource.setData({
              type:'FeatureCollection',
              features:(NAVIGATION.routeLabels || []).map(function (routeLabel) {
                return {
                  type:'Feature',
                  properties:{ label:routeLabel.label || '', selected:Boolean(routeLabel.selected) },
                  geometry:{ type:'Point', coordinates:[routeLabel.lng, routeLabel.lat] }
                };
              })
            });
          }
          if (shouldFit) fitNavigation();
        };
        window.__glivtSyncMarkers = function (payload, shouldFit) {
          MARKERS = resolveMarkerHeadings(
            payload && Array.isArray(payload.markers) ? payload.markers : []
          );
          followSelected = Boolean(payload && payload.followSelected);
          var nextCameraMode = payload && typeof payload.cameraMode === 'string'
            ? payload.cameraMode
            : 'follow';
          var cameraModeChanged = nextCameraMode !== cameraMode;
          cameraMode = nextCameraMode;
          if (!BASE_READY) return;

          var nextIds = {};
          MARKERS.forEach(function (m) {
            nextIds[m.id] = true;
            if (!markerRefs[m.id]) {
              makeMarker(m);
            } else {
              moveMarkerToAcceptedFix(m);
              markerEls[m.id].style.setProperty('--vehicle-color', m.color);
              var nextCategory = normalizedCategory(m.category);
              if (markerEls[m.id].dataset.category !== nextCategory) {
                markerEls[m.id].classList.add('model-loading');
                markerEls[m.id].classList.remove('model-ready');
                markerEls[m.id].classList.remove('model-failed');
              }
              markerEls[m.id].dataset.category = nextCategory;
              markerEls[m.id].classList.toggle('moving', Boolean(m.moving));
              markerEls[m.id].style.opacity = m.hidden ? '0' : '1';
              markerEls[m.id].style.pointerEvents = m.hidden ? 'none' : 'auto';
              var vehicle = markerEls[m.id].querySelector('.glivt-vehicle');
              if (vehicle) {
                vehicle.style.setProperty(
                  '--heading',
                  normalizedHeading(m.heading - map.getBearing()) + 'deg'
                );
              }
              var label = markerEls[m.id].querySelector('.glivt-label');
              if (label) label.textContent = m.label || '';
            }
            markerEls[m.id].classList.toggle('selected', selectedMarkerId === m.id);
          });
          sync3DMarkers(MARKERS);
          Object.keys(markerRefs).forEach(function (id) {
            if (nextIds[id]) return;
            if (markerAnimations[id]) {
              cancelAnimationFrame(markerAnimations[id]);
              delete markerAnimations[id];
            }
            markerRefs[id].remove();
            delete markerRefs[id];
            delete markerEls[id];
          });

          // A new lens re-frames the scene rather than easing into it from
          // whatever the previous mode happened to be looking at.
          if (cameraModeChanged) followSnap = true;
          // The roster is fetched after the document is built, so "fit on
          // ready" fitted an empty map and left the placeholder view showing.
          var framingFleet = false;
          if (!hasFramedFleet && !operatorMovedCamera && MARKERS.length > 0) {
            hasFramedFleet = true;
            framingFleet = true;
          }
          applyCamera(Boolean(shouldFit || cameraModeChanged || framingFleet));
          // A roster change is the one case that must always be reported, so it
          // bypasses the throttle the follow camera's moveend storm needs.
          reportVisibleMarkers(true);
          reportProjection(true);
        };
        window.__glivtSelect = function (id, lng, lat) {
          selectedMarkerId = id;
          Object.keys(markerEls).forEach(function (k) { markerEls[k].classList.remove('selected'); });
          if (markerEls[id]) markerEls[id].classList.add('selected');
          map.triggerRepaint();
          if (followSelected) applyCamera(true);
        };
        window.__glivtFocus = function (id) {
          selectedMarkerId = id;
          Object.keys(markerEls).forEach(function (k) { markerEls[k].classList.remove('selected'); });
          if (markerEls[id]) markerEls[id].classList.add('selected');
          map.triggerRepaint();
          var marker = MARKERS.find(function (item) { return item.id === id; });
          if (!marker || !map) return;
          if (followSelected) {
            startFollowLoop(true);
            return;
          }
          map.stop();
          map.easeTo({
            center: [marker.lng, marker.lat],
            bearing: 0,
            duration: 680,
            padding: cameraPadding(0.62),
            pitch: 34,
            zoom: 15.4,
            essential: true
          });
        };
        window.__glivtClearSelection = function () {
          selectedMarkerId = null;
          Object.keys(markerEls).forEach(function (key) {
            markerEls[key].classList.remove('selected');
          });
          map.triggerRepaint();
        };
      } catch (e) {
        reportError(e && e.message ? e.message : String(e));
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Loading is not a failure, and it should not look like one.
 *
 * Opening a map showed the same full-screen card the error state uses, which
 * reads as something having gone wrong every single time the screen is opened.
 * The map paints progressively underneath, so all this has to say is that more
 * is still arriving - a pill at the top, out of the way of the map itself.
 */
function WebMapLoadingPill() {
  return (
    <View pointerEvents="none" style={styles.loadingPillWrap}>
      <View style={styles.loadingPill}>
        <ActivityIndicator color="#1A73E8" size="small" />
        <Text style={styles.loadingPillText}>Loading map</Text>
      </View>
    </View>
  );
}

function WebMapStateOverlay({
  message,
  onRetry,
  status,
}: {
  message: string;
  onRetry?: () => void;
  status: WebMapStatus;
}) {
  const isLoading = status === 'loading';

  return (
    <View pointerEvents={isLoading ? 'none' : 'box-none'} style={styles.overlay}>
      <View style={styles.panel}>
        {isLoading ? (
          <ActivityIndicator color="#2BE6FF" size="large" />
        ) : (
          <Text style={styles.errorIcon}>!</Text>
        )}
        <Text style={styles.eyebrow}>MAP ENGINE</Text>
        <Text style={styles.title}>{isLoading ? 'Preparing the map' : 'Web map unavailable'}</Text>
        <Text style={styles.message}>{message}</Text>
        {!isLoading && onRetry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#EDF4F7', flex: 1, overflow: 'hidden' },
  web: { backgroundColor: '#EDF4F7', flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  loadingPillWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderColor: 'rgba(20,75,94,0.12)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 16,
    paddingVertical: 10,
    shadowColor: '#173E4D',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
  },
  loadingPillText: {
    color: '#123247',
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  panel: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
    borderColor: 'rgba(20, 75, 94, 0.14)',
    borderRadius: 20,
    borderWidth: 1,
    maxWidth: 310,
    paddingHorizontal: 20,
    paddingVertical: 18,
    shadowColor: '#173E4D',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    width: '100%',
  },
  errorIcon: {
    backgroundColor: '#FB2F32',
    borderRadius: 18,
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
    height: 36,
    lineHeight: 36,
    overflow: 'hidden',
    textAlign: 'center',
    width: 36,
  },
  eyebrow: {
    color: '#53D8FF',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.8,
    marginTop: 12,
  },
  title: {
    color: '#123247',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0,
    marginTop: 4,
    textAlign: 'center',
  },
  message: {
    color: '#5B7180',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0,
    lineHeight: 17,
    marginTop: 5,
    textAlign: 'center',
  },
  retryButton: {
    alignItems: 'center',
    backgroundColor: '#1B66C9',
    borderRadius: 8,
    height: 40,
    justifyContent: 'center',
    marginTop: 14,
    paddingHorizontal: 16,
  },
  retryText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 0 },
});
