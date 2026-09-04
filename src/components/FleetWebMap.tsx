import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import EmbeddedWebView, {
  type EmbeddedWebViewHandle,
  type EmbeddedWebViewMessageEvent,
} from '@/src/components/maps/EmbeddedWebView';
import { WEB_MARKER_DATA_URI } from '@/src/components/webMarkerImage';
import type { MapStyleSpec } from '@/src/services/mapStyle';

export type WebMapMarker = {
  id: string | number;
  lat: number;
  lng: number;
  color: string;
  heading?: number;
  category?: string;
  moving?: boolean;
  hidden?: boolean;
  label?: string;
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

export type WebMapCameraMode =
  | 'follow'
  | 'chase'
  | 'cinematic'
  | 'drone'
  | 'top'
  | 'overview';

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
};

type FleetWebMapProps = {
  markers: WebMapMarker[];
  mapStyle: MapStyleSpec;
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
  /** Legacy single-run input. Prefer `polylines` for live tracking/playback. */
  polyline?: [number, number][]; // [lng, lat] pairs
  /** Recorded route + stop markers drawn beneath the live polyline. */
  history?: WebMapHistoryOverlay;
  /** Circular geofences to draw as ground-accurate rings. */
  geofences?: WebMapGeofence[];
  selectedId?: string | number | null;
  followSelected?: boolean;
  onSelect?: (id: string | number) => void;
  onClearSelection?: () => void;
  onInteraction?: () => void;
  onProjectionChange?: (projection: WebMapProjection) => void;
  onVisibleIdsChange?: (ids: string[]) => void;
  style?: ViewStyle;
};

const WEB_MAP_LOAD_TIMEOUT_MS = 20000;

type WebMapStatus = 'loading' | 'ready' | 'error';

function sanitizeMapErrorMessage(message: string): string {
  return message.replace(/([?&]apiKey=)[^& )]*/gi, '$1[redacted]');
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
    polylines,
    diagnosticPolylines,
    polyline,
    history,
    geofences,
    selectedId,
    followSelected = false,
    onSelect,
    onClearSelection,
    onInteraction,
    onProjectionChange,
    onVisibleIdsChange,
    style,
  },
  ref
) {
  const webRef = useRef<EmbeddedWebViewHandle>(null);
  const markersRef = useRef(markers);
  const lastSyncedMarkersRef = useRef<object | null>(null);
  const lastSyncedRouteRef = useRef<[number, number][][] | null>(null);
  const lastSyncedGeofencesRef = useRef<object | null>(null);
  const lastSyncedHistoryRef = useRef<object | null>(null);
  markersRef.current = markers;
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<WebMapStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');

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
    }),
    []
  );

  // The document contains only the map engine and selected style. Live GPS data
  // is streamed into the existing instance below, so a moving marker never
  // reloads MapLibre, its style, or its tile cache.
  const html = useMemo(() => buildHtml(mapStyle, WEB_MARKER_DATA_URI), [mapStyle]);
  const webSource = useMemo(() => ({ html }), [html]);

  const markerPayload = useMemo(
    () => ({
      cameraMode,
      followSelected,
      markers: markers
        .filter((m) => isValidWebCoordinate(m.lat, m.lng))
        .map((m) => ({
          category: m.category ?? 'CAR',
          color: m.color,
          heading: m.heading ?? 0,
          hidden: Boolean(m.hidden),
          id: String(m.id),
          label: m.label ?? '',
          lat: m.lat,
          lng: m.lng,
          moving: Boolean(m.moving),
        })),
    }),
    [cameraMode, followSelected, markers]
  );
  const routeCoordinates = useMemo(
    () =>
      (polylines ?? (polyline ? [polyline] : []))
        .map((line) => sanitizeWebRoute(line))
        .filter((line) => line.length >= 2),
    [polyline, polylines]
  );
  const diagnosticCoordinates = useMemo(
    () =>
      (diagnosticPolylines ?? [])
        .map((line) => sanitizeWebRoute(line))
        .filter((line) => line.length >= 2),
    [diagnosticPolylines]
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
          color: g.color ?? '#27D34D',
        })),
    [geofences]
  );

  const syncMarkers = useCallback(
    (fit = false) => {
      webRef.current?.injectJavaScript(
        `window.__glivtSyncMarkers && window.__glivtSyncMarkers(${JSON.stringify(markerPayload)}, ${fit ? 'true' : 'false'}); true;`
      );
      lastSyncedMarkersRef.current = markerPayload;
    },
    [markerPayload]
  );

  const syncRoute = useCallback(() => {
    webRef.current?.injectJavaScript(
      `window.__glivtSyncRoutes && window.__glivtSyncRoutes(${JSON.stringify(routeCoordinates)});` +
        `window.__glivtSyncDiagnosticRoutes && window.__glivtSyncDiagnosticRoutes(${JSON.stringify(diagnosticCoordinates)}); true;`
    );
    lastSyncedRouteRef.current = routeCoordinates;
  }, [diagnosticCoordinates, routeCoordinates]);

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

  const syncHistory = useCallback(() => {
    webRef.current?.injectJavaScript(
      `window.__glivtSyncHistory && window.__glivtSyncHistory(${JSON.stringify(historyPayload)}); true;`
    );
    lastSyncedHistoryRef.current = historyPayload;
  }, [historyPayload]);

  const syncGeofences = useCallback(() => {
    webRef.current?.injectJavaScript(
      `window.__glivtSyncGeofences && window.__glivtSyncGeofences(${JSON.stringify(geofencePayload)}); true;`
    );
    lastSyncedGeofencesRef.current = geofencePayload;
  }, [geofencePayload]);

  const syncAll = useCallback(
    (fit = false) => {
      webRef.current?.injectJavaScript(
        `window.__glivtSyncRoutes && window.__glivtSyncRoutes(${JSON.stringify(routeCoordinates)});` +
          `window.__glivtSyncDiagnosticRoutes && window.__glivtSyncDiagnosticRoutes(${JSON.stringify(diagnosticCoordinates)});` +
          `window.__glivtSyncHistory && window.__glivtSyncHistory(${JSON.stringify(historyPayload)});` +
          `window.__glivtSyncGeofences && window.__glivtSyncGeofences(${JSON.stringify(geofencePayload)});` +
          `window.__glivtSyncMarkers && window.__glivtSyncMarkers(${JSON.stringify(markerPayload)}, ${fit ? 'true' : 'false'}); true;`
      );
      lastSyncedRouteRef.current = routeCoordinates;
      lastSyncedHistoryRef.current = historyPayload;
      lastSyncedGeofencesRef.current = geofencePayload;
      lastSyncedMarkersRef.current = markerPayload;
    },
    [diagnosticCoordinates, geofencePayload, historyPayload, markerPayload, routeCoordinates]
  );

  useEffect(() => {
    setStatus('loading');
    setErrorMessage('');
    lastSyncedMarkersRef.current = null;
    lastSyncedRouteRef.current = null;
    lastSyncedHistoryRef.current = null;
    lastSyncedGeofencesRef.current = null;
  }, [html, reloadKey]);

  useEffect(() => {
    if (status !== 'loading') return;

    const timeout = setTimeout(() => {
      setStatus('error');
      setErrorMessage('Web map tiles are taking too long to load. Check the style URL and network connection.');
    }, WEB_MAP_LOAD_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [reloadKey, status]);

  useEffect(() => {
    if (status !== 'ready') return;
    if (selectedId == null) {
      webRef.current?.injectJavaScript(
        'window.__glivtClearSelection && window.__glivtClearSelection(); true;'
      );
      return;
    }
    const marker = markersRef.current.find((m) => String(m.id) === String(selectedId));
    if (!marker) return;
    webRef.current?.injectJavaScript(
      `window.__glivtSelect && window.__glivtSelect(${JSON.stringify(String(selectedId))}, ${marker.lng}, ${marker.lat}); true;`
    );
  }, [selectedId, status]);

  useEffect(() => {
    if (status === 'ready' && lastSyncedMarkersRef.current !== markerPayload) {
      syncMarkers(false);
    }
  }, [markerPayload, status, syncMarkers]);

  useEffect(() => {
    if (status === 'ready' && lastSyncedRouteRef.current !== routeCoordinates) {
      syncRoute();
    }
  }, [routeCoordinates, status, syncRoute]);

  useEffect(() => {
    if (status === 'ready' && lastSyncedHistoryRef.current !== historyPayload) {
      syncHistory();
    }
  }, [historyPayload, status, syncHistory]);

  // Zones are pushed like markers and the route: on ready, and whenever the set
  // changes. That is what makes a newly saved geofence appear without a reload,
  // and what redraws every saved zone after a remount or app restart.
  useEffect(() => {
    if (status === 'ready' && lastSyncedGeofencesRef.current !== geofencePayload) {
      syncGeofences();
    }
  }, [geofencePayload, status, syncGeofences]);

  const handleMessage = (event: EmbeddedWebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {
        type: string;
        id?: string;
        ids?: unknown;
        heading?: unknown;
        message?: string;
        points?: unknown;
      };
      if (msg.type === 'ready') {
        syncAll(true);
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
      <EmbeddedWebView
        key={reloadKey}
        ref={webRef}
        originWhitelist={['*']}
        source={webSource}
        javaScriptEnabled
        domStorageEnabled
        onError={(event) => {
          setStatus('error');
          setErrorMessage(
            sanitizeMapErrorMessage(
              event.nativeEvent.description || 'Map WebView failed to load.'
            )
          );
        }}
        onHttpError={(event) => {
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
        <WebMapStateOverlay message="Loading road map" status="loading" />
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
    if (!isValidWebCoordinate(lat, lng)) continue;
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

function buildHtml(mapStyle: MapStyleSpec, realisticMarkerUri: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #edf4f7; }
    #map:after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(circle at 50% 46%, transparent 48%, rgba(22,73,91,.07) 100%);
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
    .glivt-marker:before {
      content: ''; position: absolute; inset: 5px 1px; border-radius: 50%; pointer-events: none;
      background: color-mix(in srgb, var(--vehicle-color) 8%, transparent);
      border: 2px solid var(--vehicle-color); box-shadow: 0 0 0 2px rgba(255,255,255,.72);
      opacity: 0; transform: scale(.82); transition: opacity .2s ease, transform .2s ease;
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
    .glivt-car {
      position: absolute; left: 11px; top: 2px; width: 34px; height: 62px;
      object-fit: contain; filter: drop-shadow(1px 3px 2px rgba(2,8,18,.58));
      transform-origin: center; user-select: none; pointer-events: none;
    }
    .glivt-status-dot {
      position: absolute; right: 5px; bottom: 6px; width: 9px; height: 9px;
      border-radius: 50%; background: var(--vehicle-color); border: 1.5px solid white;
      box-shadow: 0 1px 5px var(--vehicle-color); z-index: 2;
    }
    .glivt-marker[data-category="BIKE"] .glivt-car { transform: scale(.82); }
    .glivt-marker[data-category="AUTO"] .glivt-car { transform: scale(.9); }
    .glivt-marker[data-category="VAN"] .glivt-car,
    .glivt-marker[data-category="BUS"] .glivt-car { transform: scale(1.03); }
    .glivt-marker[data-category="TRUCK"] .glivt-car,
    .glivt-marker[data-category="MACHINERY"] .glivt-car { transform: scale(1.04); }
    .glivt-label {
      position: absolute; left: 44px; top: 10px; max-width: 130px; overflow: hidden;
      padding: 5px 8px; border-radius: 8px; white-space: nowrap; text-overflow: ellipsis;
      color: #f7fbff; background: rgba(5,13,24,.9); border: 1px solid rgba(255,255,255,.18);
      font: 700 10px system-ui, sans-serif; opacity: 0; transform: translateX(-4px);
      transition: opacity .2s ease, transform .2s ease;
    }
    .glivt-marker.selected { transform: scale(1.22); filter: drop-shadow(0 9px 10px rgba(2,8,18,.5)); z-index: 5; }
    .glivt-marker.selected:before { opacity: .14; transform: scale(1); }
    .glivt-marker.selected .glivt-label { opacity: 1; transform: translateX(0); }
    #err { position:absolute; top:0; left:0; right:0; padding:10px; font-family:sans-serif;
           font-size:12px; color:#FF432F; background:#fff; display:none; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="err"></div>
  <script>
    (function () {
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
      function reportError(message) {
        var safeMessage = String(message || 'Map tiles could not be loaded.')
          .replace(/([?&]apiKey=)[^& )]*/gi, '$1[redacted]');
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Map error: ' + safeMessage;
        post({ type:'error', message: safeMessage });
      }
      try {
        var STYLE = ${JSON.stringify(mapStyle)};
        var BASE_READY = false;
        var MARKERS = [];
        var LINES = [];
        var DIAGNOSTIC_LINES = [];
        var GEOFENCES = [];
        var HISTORY = { routes: [], stops: [] };
        if (!window.maplibregl) throw new Error('MapLibre GL JS did not load.');
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
          // The Geoapify style carries the required Geoapify, OpenMapTiles and
          // OpenStreetMap credits. Keeping MapLibre's control enabled renders
          // those attributions automatically.
          attributionControl: true,
          fadeDuration: 80,
          maxPitch: 70
        });
        var markerEls = {};
        var markerRefs = {};
        var selectedMarkerId = null;
        var cameraMode = 'follow';
        var followSelected = false;
        var lastCameraAt = 0;
        var lastCameraCoordinate = null;
        var lastCameraBearing = 0;
        var lastProjectionAt = 0;
        var lastBaseError = '';

        function fitToData() {
          var pts = MARKERS.map(function (m) { return [m.lng, m.lat]; });
          LINES.forEach(function (line) { pts = pts.concat(line); });
          (HISTORY.routes || []).forEach(function (line) { pts = pts.concat(line); });
          map.stop();
          if (pts.length === 1) { map.setCenter(pts[0]); map.setZoom(14); }
          else if (pts.length > 1) {
            var b = pts.reduce(function (acc, p) { return acc.extend(p); }, new maplibregl.LngLatBounds(pts[0], pts[0]));
            map.fitBounds(b, { padding: { top: 90, bottom: 220, left: 60, right: 60 }, duration: 400 });
          }
        }

        function reportVisibleMarkers() {
          if (!BASE_READY) return;
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

        function angularDifference(a, b) {
          return Math.abs((((normalizedHeading(a) - normalizedHeading(b)) % 360) + 540) % 360 - 180);
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

        function normalizedCategory(value) {
          var category = typeof value === 'string' ? value.toUpperCase() : 'CAR';
          if (category === 'MOTORCYCLE' || category === 'SCOOTER') return 'BIKE';
          if (category === 'RICKSHAW') return 'AUTO';
          if (category === 'LORRY' || category === 'MIXER_TRUCK') return 'TRUCK';
          if (category === 'JEEP') return 'VAN';
          if (category === 'EXCAVATOR' || category === 'HEAVY_MACHINERY') return 'MACHINERY';
          return ['CAR', 'TRUCK', 'BUS', 'VAN', 'BIKE', 'AUTO', 'MACHINERY'].includes(category)
            ? category
            : 'CAR';
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

        function reportProjection(force) {
          if (!BASE_READY) return;
          var now = Date.now();
          if (!force && now - lastProjectionAt < 32) return;
          lastProjectionAt = now;
          updateScreenHeadings();
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

        function applyCamera(shouldFit) {
          if (!BASE_READY) return;
          if (cameraMode === 'overview') {
            map.stop();
            fitToData();
            reportProjection(true);
            return;
          }
          if (!followSelected || !selectedMarkerId) {
            if (shouldFit) fitToData();
            reportProjection(true);
            return;
          }
          var marker = MARKERS.find(function (item) { return item.id === selectedMarkerId; });
          if (!marker) return;
          var now = Date.now();
          var profile =
            cameraMode === 'chase'
              ? { bearing: normalizedHeading(marker.heading), duration: 420, offset: [0, 88], pitch: 52, zoom: 16.0 }
              : cameraMode === 'cinematic'
                ? { bearing: normalizedHeading(marker.heading), duration: 480, offset: [0, 108], pitch: 62, zoom: 15.6 }
                : cameraMode === 'drone'
                  ? { bearing: normalizedHeading(marker.heading), duration: 480, offset: [0, 62], pitch: 42, zoom: 14.2 }
                  : cameraMode === 'top'
                    ? { bearing: 0, duration: 380, offset: [0, 0], pitch: 0, zoom: 16.2 }
                    : { bearing: 0, duration: 400, offset: [0, 58], pitch: 28, zoom: 15.4 };

          // Marker coordinates arrive at animation-frame cadence. Restarting a
          // 400-480ms camera ease every 320ms meant no ease ever completed: the
          // map oscillated around its target and the whole Live Track page
          // appeared to shake. Follow only meaningful movement/rotation, and
          // never schedule a new camera animation before the previous one has
          // had time to settle.
          if (!shouldFit) {
            var movement = groundDistanceMeters(lastCameraCoordinate, marker);
            var bearingChange = angularDifference(profile.bearing, lastCameraBearing);
            if (movement < 2 && bearingChange < 3) {
              reportProjection(false);
              return;
            }
            if (now - lastCameraAt < 620) {
              reportProjection(false);
              return;
            }
          }
          lastCameraAt = now;
          lastCameraCoordinate = { lat: marker.lat, lng: marker.lng };
          lastCameraBearing = profile.bearing;
          map.easeTo({
            center: [marker.lng, marker.lat],
            bearing: profile.bearing,
            duration: shouldFit ? Math.max(560, profile.duration) : Math.min(540, profile.duration),
            offset: profile.offset,
            pitch: profile.pitch,
            zoom: profile.zoom,
            essential: true
          });
        }

        function firstLabelLayerId() {
          var layers = (map.getStyle() && map.getStyle().layers) || [];
          for (var i = 0; i < layers.length; i += 1) {
            var layer = layers[i];
            if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) return layer.id;
          }
          return undefined;
        }

        map.on('error', function (event) {
          if (BASE_READY) return;
          lastBaseError =
            event && event.error && event.error.message
              ? event.error.message
              : 'Base map tiles failed to load.';
        });
        setTimeout(function () {
          if (!BASE_READY) reportError(lastBaseError || 'Map style is taking too long to load.');
        }, 12000);

        map.on('load', function () {
          var labelLayerId = firstLabelLayerId();
          map.addSource('route', { type: 'geojson', data: emptyCollection() });
          map.addLayer({ id:'route-aura', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(0, 122, 255, 0.24)',
                    'line-width':['interpolate',['linear'],['zoom'],8,8,14,15,18,22],
                    'line-blur':6 } }, labelLayerId);
          map.addLayer({ id:'route-shadow', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(255,255,255,0.96)',
                    'line-width':['interpolate',['linear'],['zoom'],8,6,14,10,18,14] } }, labelLayerId);
          map.addLayer({ id:'route', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'#0878FF',
                    'line-width':['interpolate',['linear'],['zoom'],8,3,14,6,18,9] } }, labelLayerId);

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
          map.addLayer({ id:'history-route', type:'line', source:'history-route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(151,171,190,0.75)','line-width':5 } }, 'route-aura');
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
          BASE_READY = true;
          // Replay whatever arrived before the style finished loading. Without
          // this a diagnostic overlay pushed during load is silently lost.
          if (DIAGNOSTIC_LINES.length) {
            window.__glivtSyncDiagnosticRoutes(DIAGNOSTIC_LINES);
          }
          post({ type:'ready' });
        });
        map.on('move', function () { reportProjection(false); });
        map.on('moveend', function () {
          reportVisibleMarkers();
          reportProjection(true);
        });
        map.on('dragstart', function () {
          post({ type:'interaction' });
        });
        map.on('click', function () {
          post({ type:'clear-selection' });
        });

        // Vector stand-in for the marker artwork: a top-down car silhouette
        // tinted by the marker's own status colour via currentColor.
        var FALLBACK_CAR_SVG =
          'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 62">' +
              '<g fill="#eef4fb" stroke="#0b1626" stroke-width="1.4">' +
                '<rect x="6" y="4" width="22" height="54" rx="9"/>' +
                '<rect x="9" y="10" width="16" height="12" rx="4" fill="#7c93ad"/>' +
                '<rect x="9" y="40" width="16" height="10" rx="4" fill="#7c93ad"/>' +
              '</g>' +
            '</svg>'
          );

        function makeMarker(m) {
            var el = document.createElement('div');
            el.className = 'glivt-marker';
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
            var car = document.createElement('img');
            car.className = 'glivt-car';
            // A broken <img> renders as an empty bordered box, which reads as a
            // missing vehicle. Swapping to the inline silhouette keeps a car on
            // the map whatever happens to the artwork.
            car.onerror = function () {
              car.onerror = null;
              car.src = FALLBACK_CAR_SVG;
            };
            car.src = ${JSON.stringify(realisticMarkerUri)};
            car.alt = '';
            car.draggable = false;
            var statusDot = document.createElement('span');
            statusDot.className = 'glivt-status-dot';
            var label = document.createElement('div');
            label.className = 'glivt-label';
            label.textContent = m.label || ('Vehicle ' + m.id);
            vehicle.appendChild(beam);
            vehicle.appendChild(car);
            el.appendChild(vehicle);
            el.appendChild(statusDot);
            el.appendChild(label);
            el.style.opacity = m.hidden ? '0' : '1';
            el.style.pointerEvents = m.hidden ? 'none' : 'auto';
            el.addEventListener('click', function (event) {
              event.stopPropagation();
              post({ type:'select', id: m.id });
            });
            markerEls[m.id] = el;
            markerRefs[m.id] = new maplibregl.Marker({ element: el, anchor: 'center' })
              .setLngLat([m.lng, m.lat])
              .addTo(map);
        }

        window.__glivtFit = fitToData;
        window.__glivtZoomIn = function () { if (map) map.zoomIn(); };
        window.__glivtZoomOut = function () { if (map) map.zoomOut(); };
        window.__glivtResetBearing = function () { if (map) map.setBearing(0); };
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
              properties:{ name: g.name || '', color: g.color || '#27D34D' },
              geometry:{ type:'Polygon', coordinates:[ ringPolygon(g.lat, g.lng, g.radius) ] }
            };
          });
          source.setData({ type:'FeatureCollection', features: features });
        }

        window.__glivtSyncGeofences = function (list) {
          GEOFENCES = Array.isArray(list) ? list : [];
          if (!BASE_READY) return;
          syncGeofenceSource();
        };

        window.__glivtSyncRoutes = function (lines) {
          LINES = Array.isArray(lines) ? lines : [];
          if (!BASE_READY) return;
          var routeSource = map.getSource('route');
          if (routeSource) {
            routeSource.setData({
              type:'FeatureCollection',
              features: LINES.map(function (line) {
                return { type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates: line } };
              })
            });
          }
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
            if (HISTORY.start) terminals.push({ point:HISTORY.start, label:'A', color:'#16A34A' });
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
        window.__glivtSyncMarkers = function (payload, shouldFit) {
          MARKERS = payload && Array.isArray(payload.markers) ? payload.markers : [];
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
              markerRefs[m.id].setLngLat([m.lng, m.lat]);
              markerEls[m.id].style.setProperty('--vehicle-color', m.color);
              markerEls[m.id].dataset.category = normalizedCategory(m.category);
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
              if (label) label.textContent = m.label || ('Vehicle ' + m.id);
            }
            markerEls[m.id].classList.toggle('selected', selectedMarkerId === m.id);
          });
          Object.keys(markerRefs).forEach(function (id) {
            if (nextIds[id]) return;
            markerRefs[id].remove();
            delete markerRefs[id];
            delete markerEls[id];
          });

          if (cameraModeChanged) {
            lastCameraAt = 0;
            lastCameraCoordinate = null;
          }
          applyCamera(Boolean(shouldFit || cameraModeChanged));
          reportVisibleMarkers();
          reportProjection(true);
        };
        window.__glivtSelect = function (id, lng, lat) {
          selectedMarkerId = id;
          Object.keys(markerEls).forEach(function (k) { markerEls[k].classList.remove('selected'); });
          if (markerEls[id]) markerEls[id].classList.add('selected');
          if (followSelected) {
            lastCameraAt = 0;
            lastCameraCoordinate = null;
            applyCamera(true);
          }
        };
        window.__glivtFocus = function (id) {
          selectedMarkerId = id;
          Object.keys(markerEls).forEach(function (k) { markerEls[k].classList.remove('selected'); });
          if (markerEls[id]) markerEls[id].classList.add('selected');
          var marker = MARKERS.find(function (item) { return item.id === id; });
          if (!marker || !map) return;
          map.stop();
          map.easeTo({
            center: [marker.lng, marker.lat],
            bearing: 0,
            duration: 680,
            offset: [0, 42],
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
        };
      } catch (e) {
        reportError(e && e.message ? e.message : String(e));
      }
    })();
  </script>
</body>
</html>`;
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
        <Text style={styles.title}>{isLoading ? 'Preparing live terrain' : 'Web map unavailable'}</Text>
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
    backgroundColor: '#118A36',
    borderRadius: 8,
    height: 40,
    justifyContent: 'center',
    marginTop: 14,
    paddingHorizontal: 16,
  },
  retryText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 0 },
});
