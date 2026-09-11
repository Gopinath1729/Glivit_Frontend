import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import EmbeddedWebView, {
  type EmbeddedWebViewHandle,
  type EmbeddedWebViewMessageEvent,
} from '@/src/components/maps/EmbeddedWebView';
import type { MapStyleSpec } from '@/src/services/mapStyle';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius as radiusTokens, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

export type PickerCoordinate = { latitude: number; longitude: number };

type Props = {
  /** Current geofence centre. Moving this re-centres the map and the pin. */
  coordinate: PickerCoordinate;
  /** Radius in metres, drawn as a true ground circle. */
  radiusMeters: number;
  /** MapLibre style URL, from getMapStyleInfo so it follows the app theme. */
  styleUrl: MapStyleSpec;
  /** Fired when the user taps the map or drags the pin. */
  onChange: (coordinate: PickerCoordinate) => void;
  style?: ViewStyle;
};

const LOAD_TIMEOUT_MS = 20000;

/**
 * Interactive centre picker for a circular geofence.
 *
 * Deliberately separate from FleetWebMap: this needs a ground-accurate radius
 * ring and tap/drag editing, the live map needs vehicle markers and a route, and
 * merging the two would put editing behaviour into the screen people watch their
 * fleet on. It is a WebView map rather than react-native-maps because the build
 * carries no Google Maps API key -- mounting a native MapView without one throws
 * IllegalStateException and takes the whole app down.
 *
 * The map is a controlled component: it never holds the centre itself. A tap or
 * drag reports upwards, the form updates latitude/longitude, and the new value
 * comes back down as a prop -- so the map, the search box, Use Current Location
 * and the lat/long fields cannot disagree.
 */
export function GeofencePickerMap({ coordinate, radiusMeters, styleUrl, onChange, style }: Props) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const webRef = useRef<EmbeddedWebViewHandle>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const readyRef = useRef(false);

  // Built once per style so retuning the radius or dragging the pin never
  // reloads MapLibre or re-fetches a single tile.
  const html = useMemo(
    () => buildPickerHtml(styleUrl, coordinate, radiusMeters, c.primary),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [styleUrl, c.primary, reloadKey]
  );
  const source = useMemo(() => ({ html }), [html]);

  const push = useCallback((script: string) => {
    webRef.current?.injectJavaScript(`${script} true;`);
  }, []);

  // Centre and radius are pushed into the live map instance rather than
  // rebuilding the document, so an external change (search result, current
  // location, a typed coordinate) moves the pin without a visible reload.
  useEffect(() => {
    if (!readyRef.current) return;
    push(
      `window.__glivtSetCentre && window.__glivtSetCentre(${coordinate.latitude}, ${coordinate.longitude});`
    );
  }, [coordinate.latitude, coordinate.longitude, push]);

  useEffect(() => {
    if (!readyRef.current) return;
    push(`window.__glivtSetRadius && window.__glivtSetRadius(${radiusMeters});`);
  }, [radiusMeters, push]);

  useEffect(() => {
    if (status !== 'loading') return undefined;
    const timer = setTimeout(() => setStatus('error'), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, reloadKey]);

  const handleMessage = (event: EmbeddedWebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        type: string;
        lat?: number;
        lng?: number;
      };
      if (message.type === 'ready') {
        readyRef.current = true;
        setStatus('ready');
        // Sync whatever the form holds now, in case it moved while loading.
        push(
          `window.__glivtSetCentre && window.__glivtSetCentre(${coordinate.latitude}, ${coordinate.longitude});` +
            `window.__glivtSetRadius && window.__glivtSetRadius(${radiusMeters});`
        );
        return;
      }
      if (message.type === 'error') {
        setStatus('error');
        return;
      }
      if (
        message.type === 'pick' &&
        typeof message.lat === 'number' &&
        typeof message.lng === 'number' &&
        Number.isFinite(message.lat) &&
        Number.isFinite(message.lng)
      ) {
        onChange({ latitude: message.lat, longitude: message.lng });
      }
    } catch {
      // A malformed message must not take the picker down.
    }
  };

  const retry = () => {
    readyRef.current = false;
    setStatus('loading');
    setReloadKey((key) => key + 1);
  };

  return (
    <View style={[styles.container, style]}>
      <EmbeddedWebView
        key={reloadKey}
        ref={webRef}
        domStorageEnabled
        javaScriptEnabled
        mixedContentMode="never"
        onError={() => setStatus('error')}
        onMessage={handleMessage}
        originWhitelist={['*']}
        source={source}
        style={styles.web}
      />

      {status === 'loading' ? (
        <View style={styles.overlay}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.overlayText}>Loading map…</Text>
        </View>
      ) : null}

      {status === 'error' ? (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>
            The map could not load. You can still set the centre using search or the latitude and
            longitude fields.
          </Text>
          <Pressable accessibilityRole="button" onPress={retry} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The picker document.
 *
 * The radius ring is a generated polygon rather than a MapLibre circle layer:
 * circle-radius is measured in screen pixels, so a pixel circle would keep its
 * size while zooming and stop describing the geofence. A polygon in geographic
 * coordinates stays true to the ground at any zoom, which is the whole point of
 * showing it.
 */
function buildPickerHtml(
  styleUrl: MapStyleSpec,
  initial: PickerCoordinate,
  radiusMeters: number,
  accent: string
): string {
  const style = typeof styleUrl === 'string' ? JSON.stringify(styleUrl) : JSON.stringify(styleUrl);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; background: transparent; }
    /* MapLibre's compact attribution still mounts expanded, so on a 168pt
       picker the credit ran the full width of the map and collided with the
       controls over it. Collapsed to its (i) button; a tap still opens the
       full credit, which is what the OpenMapTiles/OSM licence requires. */
    .maplibregl-ctrl-attrib { font-size: 9px; }
    .maplibregl-ctrl-attrib.maplibregl-compact { min-height: 20px; }
    .maplibregl-ctrl-bottom-right { margin-bottom: 2px; margin-right: 2px; }
    .glivt-pin {
      width: 30px; height: 30px; cursor: grab;
      display: flex; align-items: center; justify-content: center;
    }
    .glivt-pin:active { cursor: grabbing; }
    .glivt-pin-dot {
      width: 15px; height: 15px; border-radius: 50%;
      background: ${accent}; border: 3px solid #fff;
      box-shadow: 0 2px 7px rgba(2,8,18,.55);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var post = function (payload) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    };

    var CENTRE = { lat: ${initial.latitude}, lng: ${initial.longitude} };
    var RADIUS = ${radiusMeters};
    var map, marker;
    var STYLE = ${style};

    /** Ground circle as a polygon, so the ring stays true to scale at any zoom. */
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
      return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] }, properties: {} };
    }

    function redraw() {
      var source = map.getSource('glivt-ring');
      if (source) source.setData(ringPolygon(CENTRE.lat, CENTRE.lng, RADIUS));
    }

    try {
      var configurationError =
        STYLE && typeof STYLE === 'object' && STYLE.metadata
          ? STYLE.metadata.glivtConfigurationError
          : '';
      if (configurationError) throw new Error(String(configurationError));
      map = new maplibregl.Map({
        container: 'map',
        style: STYLE,
        center: [CENTRE.lng, CENTRE.lat],
        zoom: 14.5,
        attributionControl: { compact: true }
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

      map.on('error', function (e) {
        post({ type: 'error', message: (e && e.error && e.error.message) || 'map error' });
      });

      map.on('load', function () {
        // Mounted with the credit open; collapse it to the (i) button so the
        // map is legible. Tapping it still reveals the full attribution.
        var attrib = document.querySelector('.maplibregl-ctrl-attrib');
        if (attrib) attrib.classList.remove('maplibregl-compact-show');

        map.addSource('glivt-ring', { type: 'geojson', data: ringPolygon(CENTRE.lat, CENTRE.lng, RADIUS) });
        map.addLayer({
          id: 'glivt-ring-fill', type: 'fill', source: 'glivt-ring',
          paint: { 'fill-color': '${accent}', 'fill-opacity': 0.16 }
        });
        map.addLayer({
          id: 'glivt-ring-line', type: 'line', source: 'glivt-ring',
          paint: { 'line-color': '${accent}', 'line-width': 2 }
        });

        var el = document.createElement('div');
        el.className = 'glivt-pin';
        var dot = document.createElement('div');
        dot.className = 'glivt-pin-dot';
        el.appendChild(dot);

        marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' })
          .setLngLat([CENTRE.lng, CENTRE.lat])
          .addTo(map);

        // Live feedback while dragging; the form is only told on release, so a
        // drag does not fire a reverse-geocode per frame.
        marker.on('drag', function () {
          var pos = marker.getLngLat();
          CENTRE = { lat: pos.lat, lng: pos.lng };
          redraw();
        });
        marker.on('dragend', function () {
          var pos = marker.getLngLat();
          post({ type: 'pick', lat: pos.lat, lng: pos.lng });
        });

        map.on('click', function (event) {
          post({ type: 'pick', lat: event.lngLat.lat, lng: event.lngLat.lng });
        });

        post({ type: 'ready' });
      });
    } catch (err) {
      post({ type: 'error', message: String(err) });
    }

    window.__glivtSetCentre = function (lat, lng) {
      if (!map || !marker) return;
      if (!isFinite(lat) || !isFinite(lng)) return;
      // Ignore an echo of the value this map just reported, so a drag is not
      // fought by the prop coming back down.
      if (Math.abs(lat - CENTRE.lat) < 1e-9 && Math.abs(lng - CENTRE.lng) < 1e-9) return;
      CENTRE = { lat: lat, lng: lng };
      marker.setLngLat([lng, lat]);
      redraw();
      map.easeTo({ center: [lng, lat], duration: 420 });
    };

    window.__glivtSetRadius = function (metres) {
      if (!map || !isFinite(metres) || metres <= 0) return;
      RADIUS = metres;
      redraw();
    };
  </script>
</body>
</html>`;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radiusTokens.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      overflow: 'hidden',
    },
    web: {
      backgroundColor: 'transparent',
      flex: 1,
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      gap: spacing.sm,
      justifyContent: 'center',
      padding: spacing.md,
    },
    overlayText: {
      color: c.textSecondary,
      fontSize: typography.caption,
      textAlign: 'center',
    },
    retry: {
      backgroundColor: c.primary,
      borderRadius: radiusTokens.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    retryText: {
      color: c.onPrimary,
      fontSize: typography.caption,
      fontWeight: '700',
    },
  });
