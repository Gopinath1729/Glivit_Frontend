/**
 * Road snapping / map-matching helper.
 *
 * snapCoordinateToRoadSync(lat, lng, rawHeading)
 *   → Synchronously returns the best available snapped point.
 *
 * Behaviour
 * ---------
 * 1. Check the LRU cache (key = rounded lat/lng). Return cache hit immediately.
 * 2. Fire an async OSRM /nearest request in the background; when it resolves,
 *    populate the cache so the *next* call for the same location is instant.
 * 3. Meanwhile return a best-effort result from local geometry or raw GPS.
 *
 * The function is deliberately synchronous at the call-site so it can be used
 * inside React render passes and Animated callbacks without async plumbing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnappedPoint = {
  latitude: number;
  longitude: number;
  /**
   * Compass bearing in degrees [0, 360).
   *
   * This is ALWAYS the caller's own `rawHeading`, passed straight back. Snapping
   * corrects position, never direction: OSRM's /nearest reports where the road is,
   * not which way this vehicle is travelling along it.
   */
  bearing: number;
  /** True when the coordinate was snapped to a road network node. */
  snapped: boolean;
};

/** Cached snap result. Position only - deliberately carries no heading (see below). */
type CachedSnap = {
  latitude: number;
  longitude: number;
};

// ---------------------------------------------------------------------------
// OSRM public endpoint (no key required)
// ---------------------------------------------------------------------------

const OSRM_BASE = 'https://router.project-osrm.org/nearest/v1/driving';

// ---------------------------------------------------------------------------
// LRU cache (max 512 entries, keyed by "lat4:lng4")
// ---------------------------------------------------------------------------

// The cache key is a ~11 m grid cell, so it is SHARED by every vehicle that passes
// through that cell, in either direction, at any time. It therefore stores position
// only. It previously stored the heading of whichever vehicle happened to snap the
// cell first, which every later caller then inherited - so a vehicle driving back
// down the same road, or a second vehicle heading the other way, was rendered facing
// exactly backwards. Direction of travel is per-vehicle state and can never be
// cached per location.
const CACHE_MAX = 512;
const cache = new Map<string, CachedSnap>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)}:${lng.toFixed(4)}`;
}

function cacheGet(lat: number, lng: number): CachedSnap | undefined {
  const k = cacheKey(lat, lng);
  const hit = cache.get(k);
  if (hit) {
    // Move to end (LRU ordering)
    cache.delete(k);
    cache.set(k, hit);
  }
  return hit;
}

function cacheSet(lat: number, lng: number, point: CachedSnap): void {
  const k = cacheKey(lat, lng);
  if (cache.size >= CACHE_MAX) {
    // Evict oldest entry
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(k, point);
}

// This module no longer computes bearings. Direction of travel is resolved from a
// vehicle's own consecutive fixes by `resolveTravelHeading` in geoMath, which is the
// only place that has the per-vehicle history needed to get it right.

// ---------------------------------------------------------------------------
// Background OSRM fetch (populates cache; never throws)
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();

function fetchAndCache(lat: number, lng: number): void {
  const k = cacheKey(lat, lng);
  if (inFlight.has(k)) return;
  inFlight.add(k);

  const url = `${OSRM_BASE}/${lng},${lat}?number=1`;

  fetch(url, { signal: AbortSignal.timeout?.(4000) })
    .then((r) => r.json())
    .then((json: { code: string; waypoints?: { location: [number, number]; name?: string }[] }) => {
      if (json.code === 'Ok' && json.waypoints && json.waypoints.length > 0) {
        const [snapLng, snapLat] = json.waypoints[0].location;
        const dist = haversineM(lat, lng, snapLat, snapLng);
        // Reject snaps > 50 m from original — likely wrong road
        if (dist <= 50) {
          cacheSet(lat, lng, { latitude: snapLat, longitude: snapLng });
        }
      }
    })
    .catch(() => {
      // Silently ignore network errors — fall back to raw GPS
    })
    .finally(() => {
      inFlight.delete(k);
    });
}

// ---------------------------------------------------------------------------
// Haversine distance (metres)
// ---------------------------------------------------------------------------

function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronously snap a GPS coordinate to the nearest drivable road.
 *
 * Only the POSITION is corrected. `bearing` is returned exactly as supplied,
 * because the direction a vehicle is travelling along a road is per-vehicle state
 * that a location-keyed cache cannot represent.
 *
 * @param lat        Raw GPS latitude
 * @param lng        Raw GPS longitude
 * @param rawHeading Vehicle heading from GPS (degrees, may be 0 when stopped)
 * @returns          Best available SnappedPoint — either from cache or raw GPS
 */
export function snapCoordinateToRoadSync(
  lat: number,
  lng: number,
  rawHeading = 0
): SnappedPoint {
  // 1. Validate inputs
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { latitude: lat, longitude: lng, bearing: rawHeading, snapped: false };
  }

  // 2. Cache hit → snapped position, but ALWAYS this caller's own heading.
  const cached = cacheGet(lat, lng);
  if (cached) {
    return {
      latitude: cached.latitude,
      longitude: cached.longitude,
      bearing: Number.isFinite(rawHeading) ? rawHeading : 0,
      snapped: true,
    };
  }

  // 3. Trigger background fetch for next time
  fetchAndCache(lat, lng);

  // 4. Fallback: return raw GPS (snapped = false)
  return {
    latitude: lat,
    longitude: lng,
    bearing: rawHeading,
    snapped: false,
  };
}
