import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { MapStyleElement } from 'react-native-maps';

import { env } from '@/src/config/env';

export type MapStyleSpec = string | Record<string, unknown>;
export type MapStyleVariant = 'street' | 'bright' | 'dark' | 'satellite';
export type NativeMapProvider = 'google-apple';
export type WebMapProvider = 'geoapify';

export type MapStyleIssue = {
  code: 'missing_geoapify_key' | 'placeholder_geoapify_key' | 'insecure_style_url';
  message: string;
  blocking: boolean;
};

export type MapStyleInfo = {
  provider: NativeMapProvider;
  style: MapStyleElement[];
  webProvider: WebMapProvider;
  webStyle: MapStyleSpec;
  webStyleUrl: string;
  issues: MapStyleIssue[];
};

const DARK_MAP_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#242f3e' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#242f3e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#746855' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#263c3f' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6b9a76' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#38414e' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#746855' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f2835' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#f3d19c' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2f3948' }] },
  { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17263c' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#515c6d' }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#17263c' }] },
];

// Cool, low-noise navigation styling. It keeps Google/Apple as the map
// provider, but gives pitched fleet views cleaner road hierarchy and stronger
// vehicle contrast than the provider default.
const STREET_MAP_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#E8EDF2' }] },
  { elementType: 'labels.icon', stylers: [{ saturation: -70 }, { lightness: 8 }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#53677A' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#F4F7FA' }, { weight: 3 }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#C8D3DD' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#DFE9E6' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#DCE6E2' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#CFE3D7' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#D5DEE6' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#F8FAFC' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#CBDCE8' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#AABFCE' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#B9D8E8' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#5E8195' }] },
];

const BRIGHT_MAP_STYLE: MapStyleElement[] = [
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.medical', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

const GEOAPIFY_STYLES: Record<MapStyleVariant, string> = {
  street: 'osm-bright',
  bright: 'osm-bright-grey',
  dark: 'dark-matter',
  satellite: 'osm-bright',
};

function isPlaceholderKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === 'your_geoapify_key' ||
    normalized === 'your_api_key' ||
    normalized === 'your_api_key_here' ||
    normalized === 'geoapify_api_key'
  );
}

function getWebStyleInfo(variant: MapStyleVariant): {
  provider: WebMapProvider;
  style: MapStyleSpec;
  styleUrl: string;
  issues: MapStyleIssue[];
} {
  const issues: MapStyleIssue[] = [];
  const configuredKey = env.geoapifyApiKey.trim();
  const key = configuredKey && !isPlaceholderKey(configuredKey) ? configuredKey : '';

  if (!configuredKey) {
    issues.push({
      blocking: true,
      code: 'missing_geoapify_key',
      message:
        'This build has no Geoapify API key. Set EXPO_PUBLIC_GEOAPIFY_API_KEY and rebuild the app.',
    });
  } else if (!key) {
    issues.push({
      blocking: true,
      code: 'placeholder_geoapify_key',
      message:
        'The Geoapify API key is still a placeholder. Set EXPO_PUBLIC_GEOAPIFY_API_KEY to a real key and rebuild the app.',
    });
  }

  // Geoapify is the only map-tile provider used by the app. An invalid or
  // missing key is intentionally not hidden behind another public tile host:
  // release builds fail configuration validation and local builds surface the
  // real provider error instead of appearing to work against an unsupported
  // fallback.
  const styleUrl = `https://maps.geoapify.com/v1/styles/${GEOAPIFY_STYLES[variant]}/style.json?apiKey=${encodeURIComponent(key)}`;

  if (!styleUrl.startsWith('https://')) {
    issues.push({
      blocking: true,
      code: 'insecure_style_url',
      message: 'Map style URL must use HTTPS so web map tiles can load securely.',
    });
  }

  return {
    provider: 'geoapify',
    style: styleUrl,
    styleUrl,
    issues,
  };
}

export function getMapStyleInfo(variant: MapStyleVariant = 'street'): MapStyleInfo {
  const web = getWebStyleInfo(variant);

  return {
    provider: 'google-apple',
    style: getMapStyle(variant),
    webProvider: web.provider,
    webStyle: web.style,
    webStyleUrl: web.styleUrl,
    issues: web.issues,
  };
}

export function getMapStyle(variant: MapStyleVariant = 'street'): MapStyleElement[] {
  if (variant === 'dark') return DARK_MAP_STYLE;
  if (variant === 'bright') return BRIGHT_MAP_STYLE;
  return STREET_MAP_STYLE;
}

/**
 * Whether the native react-native-maps view can be mounted at all.
 *
 * On Android the native map throws IllegalStateException("API key not found")
 * the moment it is created without com.google.android.geo.API_KEY in the
 * manifest, and that takes the whole app down rather than just the map.
 * app.config.js only injects that meta-data when GOOGLE_MAPS_API_KEY is set, so
 * a build made without the key has to fall back to the WebView map. iOS draws
 * Apple Maps and needs no key; web never mounts the native view.
 */
function resolveNativeMapsAvailable(): boolean {
  if (Platform.OS === 'web') return false;
  if (Platform.OS !== 'android') return true;
  const apiKey = Constants.expoConfig?.android?.config?.googleMaps?.apiKey ?? '';
  return apiKey.trim().length > 0;
}

export const nativeMapsAvailable = resolveNativeMapsAvailable();

export function getNativeMapProviderLabel(platform: string): string {
  if (platform === 'android') return 'Google Maps';
  if (platform === 'ios') return 'Apple Maps';
  return 'Web map fallback';
}
