import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import EmbeddedWebView, {
  type EmbeddedWebViewHandle,
  type EmbeddedWebViewMessageEvent,
} from '@/src/components/maps/EmbeddedWebView';
import type { MapStyleSpec } from '@/src/services/mapStyle';

export type WebMapMarker = {
  id: string | number;
  lat: number;
  lng: number;
  color: string;
  heading?: number;
  category?: string;
  hidden?: boolean;
  label?: string;
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
  zoomIn: () => void;
  zoomOut: () => void;
  resetBearing: () => void;
};

type FleetWebMapProps = {
  markers: WebMapMarker[];
  mapStyle: MapStyleSpec;
  cameraMode?: WebMapCameraMode;
  polyline?: [number, number][]; // [lng, lat] pairs
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

/**
 * Web-only fallback. react-native-maps has no free native web renderer, so web
 * keeps the existing MapLibre GL JS view with OpenFreeMap/Geoapify styles.
 */
export const FleetWebMap = forwardRef<FleetWebMapHandle, FleetWebMapProps>(function FleetWebMap(
  {
    cameraMode = 'follow',
    markers,
    mapStyle,
    polyline,
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
  const lastSyncedRouteRef = useRef<[number, number][] | null>(null);
  markersRef.current = markers;
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<WebMapStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useImperativeHandle(
    ref,
    () => ({
      fitAll: () => webRef.current?.injectJavaScript('window.__glivtFit && window.__glivtFit(); true;'),
      zoomIn: () => webRef.current?.injectJavaScript('window.__glivtZoomIn && window.__glivtZoomIn(); true;'),
      zoomOut: () => webRef.current?.injectJavaScript('window.__glivtZoomOut && window.__glivtZoomOut(); true;'),
      resetBearing: () => webRef.current?.injectJavaScript('window.__glivtResetBearing && window.__glivtResetBearing(); true;'),
    }),
    []
  );

  // The document contains only the map engine and selected style. Live GPS data
  // is streamed into the existing instance below, so a moving marker never
  // reloads MapLibre, its style, or its tile cache.
  const html = useMemo(() => buildHtml(mapStyle), [mapStyle]);
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
        })),
    }),
    [cameraMode, followSelected, markers]
  );
  const routeCoordinates = useMemo(() => sanitizeWebRoute(polyline ?? []), [polyline]);

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
      `window.__glivtSyncRoute && window.__glivtSyncRoute(${JSON.stringify(routeCoordinates)}); true;`
    );
    lastSyncedRouteRef.current = routeCoordinates;
  }, [routeCoordinates]);

  const syncAll = useCallback(
    (fit = false) => {
      webRef.current?.injectJavaScript(
        `window.__glivtSyncRoute && window.__glivtSyncRoute(${JSON.stringify(routeCoordinates)});` +
          `window.__glivtSyncMarkers && window.__glivtSyncMarkers(${JSON.stringify(markerPayload)}, ${fit ? 'true' : 'false'}); true;`
      );
      lastSyncedRouteRef.current = routeCoordinates;
      lastSyncedMarkersRef.current = markerPayload;
    },
    [markerPayload, routeCoordinates]
  );

  useEffect(() => {
    setStatus('loading');
    setErrorMessage('');
    lastSyncedMarkersRef.current = null;
    lastSyncedRouteRef.current = null;
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
        setErrorMessage(msg.message || 'Map tiles could not be loaded.');
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
          setErrorMessage(event.nativeEvent.description || 'Map WebView failed to load.');
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

function buildHtml(mapStyle: MapStyleSpec): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #09111d; }
    #map:after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(circle at 50% 48%, transparent 35%, rgba(3,9,18,.16) 100%);
    }
    .glivt-marker {
      width: 46px; height: 46px; display: flex; align-items: center; justify-content: center;
      filter: drop-shadow(0 7px 8px rgba(2,8,18,.34));
      transition: transform .2s cubic-bezier(.2,.8,.2,1), filter .2s ease;
      transform-origin: center;
    }
    /* No circular halo/ring behind the vehicle marker. */
    .glivt-marker:before { content: none; }
    .glivt-car {
      position: relative; width: 17px; height: 31px; border-radius: 6px;
      background: linear-gradient(145deg, color-mix(in srgb, var(--vehicle-color) 82%, white), var(--vehicle-color));
      border: 1.5px solid rgba(255,255,255,.94); box-shadow: 0 0 13px var(--vehicle-color);
      transform: rotate(var(--heading)); transition: transform .2s linear;
    }
    .glivt-car:before {
      content: ''; position: absolute; left: 3px; right: 3px; top: 5px; height: 8px;
      border-radius: 3px; background: linear-gradient(#c7f1ff, #4b7896);
      border: 1px solid rgba(255,255,255,.75);
    }
    .glivt-car:after {
      content: ''; position: absolute; left: 4px; right: 4px; top: 15px; height: 7px;
      border-radius: 3px; background: rgba(2,10,22,.36);
    }
    .glivt-label {
      position: absolute; left: 39px; top: 8px; max-width: 130px; overflow: hidden;
      padding: 5px 8px; border-radius: 8px; white-space: nowrap; text-overflow: ellipsis;
      color: #f7fbff; background: rgba(5,13,24,.9); border: 1px solid rgba(255,255,255,.18);
      font: 700 10px system-ui, sans-serif; opacity: 0; transform: translateX(-4px);
      transition: opacity .2s ease, transform .2s ease;
    }
    .glivt-marker.selected { transform: scale(1.3); filter: drop-shadow(0 9px 12px rgba(2,8,18,.5)); z-index: 5; }
    .glivt-marker.selected:before { width: 44px; height: 44px; border-width: 2px; }
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
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Map error: ' + message;
        post({ type:'error', message: message });
      }
      try {
        var STYLE = ${JSON.stringify(mapStyle)};
        var BASE_READY = false;
        var MARKERS = [];
        var LINE = [];
        if (!window.maplibregl) throw new Error('MapLibre GL JS did not load.');
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
          attributionControl: false,
          fadeDuration: 80,
          maxPitch: 70
        });
        var markerEls = {};
        var markerRefs = {};
        var selectedMarkerId = null;
        var cameraMode = 'follow';
        var followSelected = false;
        var lastCameraAt = 0;
        var lastProjectionAt = 0;
        var lastBaseError = '';

        function fitToData() {
          var pts = MARKERS.map(function (m) { return [m.lng, m.lat]; }).concat(LINE);
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

        function updateScreenHeadings() {
          var mapHeading = normalizedHeading(map.getBearing());
          MARKERS.forEach(function (marker) {
            var el = markerEls[marker.id];
            if (!el) return;
            var car = el.querySelector('.glivt-car');
            if (car) {
              car.style.setProperty(
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
          if (!shouldFit && now - lastCameraAt < 320) {
            reportProjection(false);
            return;
          }
          lastCameraAt = now;
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
          map.stop();
          map.easeTo({
            center: [marker.lng, marker.lat],
            bearing: profile.bearing,
            duration: shouldFit ? Math.max(560, profile.duration) : profile.duration,
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
          map.addSource('route', { type: 'geojson', data: { type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates: [] } } });
          map.addLayer({ id:'route-aura', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(22, 163, 74, 0.18)','line-width':18, 'line-blur':8 } }, labelLayerId);
          map.addLayer({ id:'route-shadow', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'rgba(3, 12, 22, 0.55)','line-width':11 } }, labelLayerId);
          map.addLayer({ id:'route', type:'line', source:'route',
            layout:{ 'line-cap':'round','line-join':'round' },
            paint:{ 'line-color':'#16A34A','line-width':5 } }, labelLayerId);
          BASE_READY = true;
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

        function makeMarker(m) {
            var el = document.createElement('div');
            el.className = 'glivt-marker';
            el.style.setProperty('--vehicle-color', m.color);
            var car = document.createElement('div');
            car.className = 'glivt-car';
            car.style.setProperty(
              '--heading',
              normalizedHeading(m.heading - map.getBearing()) + 'deg'
            );
            var label = document.createElement('div');
            label.className = 'glivt-label';
            label.textContent = m.label || ('Vehicle ' + m.id);
            el.appendChild(car);
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
        window.__glivtSyncRoute = function (line) {
          LINE = Array.isArray(line) ? line : [];
          if (!BASE_READY) return;
          var routeSource = map.getSource('route');
          if (routeSource) {
            routeSource.setData({
              type:'Feature',
              properties:{},
              geometry:{ type:'LineString', coordinates: LINE }
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
              markerEls[m.id].style.opacity = m.hidden ? '0' : '1';
              markerEls[m.id].style.pointerEvents = m.hidden ? 'none' : 'auto';
              var car = markerEls[m.id].querySelector('.glivt-car');
              if (car) {
                car.style.setProperty(
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

          if (cameraModeChanged) lastCameraAt = 0;
          applyCamera(Boolean(shouldFit || cameraModeChanged));
          reportVisibleMarkers();
          reportProjection(true);
        };
        window.__glivtSelect = function (id, lng, lat) {
          selectedMarkerId = id;
          Object.keys(markerEls).forEach(function (k) { markerEls[k].classList.remove('selected'); });
          if (markerEls[id]) markerEls[id].classList.add('selected');
          lastCameraAt = 0;
          applyCamera(true);
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
  container: { backgroundColor: '#09111D', flex: 1, overflow: 'hidden' },
  web: { backgroundColor: '#09111D', flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  panel: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 16, 28, 0.96)',
    borderColor: 'rgba(255,255,255,0.13)',
    borderRadius: 20,
    borderWidth: 1,
    maxWidth: 310,
    paddingHorizontal: 20,
    paddingVertical: 18,
    shadowColor: '#020712',
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
    color: '#F2F8FD',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0,
    marginTop: 4,
    textAlign: 'center',
  },
  message: {
    color: '#8FA5B9',
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
