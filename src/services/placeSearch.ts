import type { NavigationPlace } from '@/src/services/navigationApi';

/**
 * Place search for the directions panel.
 *
 * <h3>Why this is not the backend's Geoapify endpoint any more</h3>
 * It answered Indian queries badly. Searching "Padi" — a Chennai neighbourhood
 * the fleet parks in — returned Padiyatalawa, Sri Lanka first, and single
 * results for "Vadapalani" and "Guindy". The proximity bias was being applied
 * and was simply not strong enough to overcome its ranking, and there was no
 * country filter behind it. Photon, which indexes the same OpenStreetMap data
 * this app already draws its map from, answers every one of those queries with
 * the right Chennai place.
 *
 * <h3>No API key</h3>
 * Photon is keyless, so there is no secret left to hide and no reason to pay
 * for a round trip through our own server to hide it. The request goes straight
 * from the device, which also means the fix needs no backend deploy.
 *
 * The shape it returns is deliberately unchanged: everything downstream —
 * suggestions, the map pin, the route request — still speaks `NavigationPlace`.
 */

const PHOTON_URL = 'https://photon.komoot.io/api/';

/** Photon's own cap is 50; more than this is a list nobody reads. */
const RESULT_LIMIT = 8;

type PhotonProperties = {
  osm_id?: number;
  osm_type?: string;
  osm_key?: string;
  osm_value?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  countrycode?: string;
  type?: string;
};

type PhotonFeature = {
  geometry?: { coordinates?: unknown };
  properties?: PhotonProperties;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validCoordinate(latitude: number, longitude: number): boolean {
  return (
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/**
 * The one line under the place name.
 *
 * Built from the widest parts that are actually present and are not already the
 * name — Photon repeats the name in `city` for a city, and an address that
 * reads "Guindy, Guindy, Chennai" looks broken rather than precise.
 */
export function formatPlaceAddress(properties: PhotonProperties): string {
  const name = (properties.name ?? '').trim();
  const street = [properties.housenumber, properties.street]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const parts = [
    street,
    properties.district,
    properties.city,
    properties.county,
    properties.state,
    properties.country,
  ];
  const seen = new Set<string>();
  if (name) seen.add(name.toLowerCase());
  const kept: string[] = [];
  for (const part of parts) {
    const value = (part ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(value);
  }
  return kept.join(', ');
}

/** A place's display name, falling back through the fields that can carry one. */
export function placeDisplayName(properties: PhotonProperties): string {
  const candidates = [
    properties.name,
    [properties.housenumber, properties.street].filter(Boolean).join(' '),
    properties.city,
    properties.district,
    properties.state,
  ];
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim();
    if (value) return value;
  }
  return '';
}

/** Turns one Photon feature into the shape the rest of the app already speaks. */
export function toNavigationPlace(feature: PhotonFeature): NavigationPlace | null {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  // GeoJSON is longitude, latitude.
  const longitude = coordinates[0];
  const latitude = coordinates[1];
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;
  if (!validCoordinate(latitude, longitude)) return null;

  const properties = feature.properties ?? {};
  const name = placeDisplayName(properties);
  if (!name) return null;
  const formatted = formatPlaceAddress(properties);

  return {
    id:
      properties.osm_type && properties.osm_id != null
        ? `${properties.osm_type}${properties.osm_id}`
        : `${latitude.toFixed(6)},${longitude.toFixed(6)}`,
    name,
    formatted: formatted || name,
    resultType: (properties.osm_value ?? properties.type ?? '').trim(),
    city: (properties.city ?? '').trim(),
    state: (properties.state ?? '').trim(),
    country: (properties.country ?? '').trim(),
    latitude,
    longitude,
  };
}

/**
 * A query that is already a coordinate pair.
 *
 * Operators paste these out of other systems constantly, and sending
 * "13.0827, 80.2707" to a text geocoder returns nothing useful.
 */
export function parseCoordinateQuery(query: string): NavigationPlace | null {
  const match = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(query);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;
  if (!validCoordinate(latitude, longitude)) return null;
  const label = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  return {
    id: label,
    name: label,
    formatted: 'Coordinates',
    resultType: 'coordinate',
    city: '',
    state: '',
    country: '',
    latitude,
    longitude,
  };
}

/** Drops the same OSM place arriving twice under different spellings. */
export function dedupePlaces(places: NavigationPlace[]): NavigationPlace[] {
  const seen = new Set<string>();
  const kept: NavigationPlace[] = [];
  for (const place of places) {
    const key = `${place.name.toLowerCase()}|${place.latitude.toFixed(4)}|${place.longitude.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(place);
  }
  return kept;
}

export type PlaceSearchBias = { latitude: number; longitude: number };

/**
 * Search for a place by name.
 *
 * `signal` is the caller's — a keystroke that supersedes this one aborts it,
 * so a slow answer to an old query can never overwrite a fast answer to the
 * current one.
 */
export async function searchPlaces(
  query: string,
  bias: PlaceSearchBias | null,
  signal?: AbortSignal
): Promise<NavigationPlace[]> {
  const text = query.trim();
  if (text.length < 2) return [];

  const coordinate = parseCoordinateQuery(text);
  if (coordinate) return [coordinate];

  const params = new URLSearchParams({
    q: text,
    limit: String(RESULT_LIMIT),
    lang: 'en',
  });
  // Proximity, so "Park Road" means the one the fleet is on.
  if (bias && validCoordinate(bias.latitude, bias.longitude)) {
    params.set('lat', bias.latitude.toFixed(6));
    params.set('lon', bias.longitude.toFixed(6));
  }

  const response = await fetch(`${PHOTON_URL}?${params.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Place search failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { features?: unknown };
  const features = Array.isArray(body?.features) ? body.features : [];
  const places: NavigationPlace[] = [];
  for (const feature of features) {
    const place = toNavigationPlace(feature as PhotonFeature);
    if (place) places.push(place);
  }
  return dedupePlaces(places).slice(0, RESULT_LIMIT);
}
