import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { MapStyleElement } from 'react-native-maps';

export type MapStyleSpec = string | Record<string, unknown>;
export type MapStyleVariant = 'street' | 'bright' | 'dark' | 'satellite';
export type NativeMapProvider = 'google-apple';
export type WebMapProvider = 'openfreemap';

/**
 * Shared presentation tokens for the fleet basemap. OpenFreeMap supplies
 * OpenStreetMap vector data; FleetWebMap applies these values to the
 * loaded MapLibre source layers, rather than applying a colour filter to a
 * raster image. Keeping the values here also prevents route overlays and the
 * native fallback from drifting away from the basemap palette.
 */
export const PREMIUM_FLEET_MAP_PALETTE = {
  background: '#F5F7F5',
  building: '#E3E9E9',
  minorRoad: '#FFFFFF',
  mainRoad: '#F7D889',
  roadBorder: '#CED5D3',
  water: '#CFEAF4',
  waterEdge: '#B7DCE9',
  park: '#DCEEDB',
  primaryLabel: '#263746',
  secondaryLabel: '#65758B',
  selectedRoute: '#1B66C9',
  selectedRouteOutline: '#174EA6',
  alternativeRouteGray: '#7C8794',
  alternativeRouteBlue: '#6F8FAA',
  alternativeRouteSlate: '#9AA6B2',
} as const;

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

// Native fallback equivalent of the MapLibre fleet theme. The production Live
// Map uses semantic vector-layer styling in FleetWebMap; these rules keep the
// dormant Google/Apple fallback visually consistent.
const STREET_MAP_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.background }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.secondaryLabel }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.background }, { weight: 3 }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.primaryLabel }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.roadBorder }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.background }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.building }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.park }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.park }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.minorRoad }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.roadBorder }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.mainRoad }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.mainRoad }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.roadBorder }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.water }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: PREMIUM_FLEET_MAP_PALETTE.secondaryLabel }] },
];

const BRIGHT_MAP_STYLE: MapStyleElement[] = [
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.medical', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

const OPEN_FREE_MAP_STYLES: Record<MapStyleVariant, string> = {
  street: 'liberty',
  bright: 'bright',
  dark: 'fiord',
  // Satellite/map-type switching is intentionally gone. Legacy callers that
  // still request it get the same coherent automotive vector scene.
  satellite: 'liberty',
};

function getWebStyleInfo(variant: MapStyleVariant): {
  provider: WebMapProvider;
  style: MapStyleSpec;
  styleUrl: string;
  issues: MapStyleIssue[];
} {
  const styleUrl = `https://tiles.openfreemap.org/styles/${OPEN_FREE_MAP_STYLES[variant]}`;

  return {
    provider: 'openfreemap',
    style: styleUrl,
    styleUrl,
    issues: [],
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
