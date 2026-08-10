import { DEMO_ROAD_PATH } from './demoRoute';

export interface SimState {
  deviceId: number;
  latitude: number;
  longitude: number;
  speed: number; // in km/h
  heading: number; // in degrees
  route: [number, number][]; // [longitude, latitude]
  routeIndex: number;
  segmentFraction: number; // 0 to 1
  targetSpeed: number; // in km/h
  destination: [number, number]; // [longitude, latitude]
  state: string;
  moving: boolean;
  updatedAt: number;
  fetchingRoute: boolean;
  pausedUntil: number; // timestamp to pause at destination
}

const vehicleStates = new Map<number, SimState>();

// Physics Constants
const ACCEL = 8.0; // km/h per second
const DECEL = 14.0; // km/h per second
const CRUISE_SPEED = 45.0; // km/h
const TURN_SPEED = 15.0; // km/h
const STOP_DISTANCE = 50.0; // meters
const TURN_DISTANCE_LOOKAHEAD = 40.0; // meters
const LANE_OFFSET_METERS = 2.2; // drive in the left lane

// Helper: Haversine distance in meters
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Helper: Bearing in degrees
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Helper: Find fallback route from DEMO_ROAD_PATH
function getFallbackRoute(startLat: number, startLng: number): [number, number][] {
  let closestIdx = 0;
  let minDist = Infinity;
  for (let idx = 0; idx < DEMO_ROAD_PATH.length; idx++) {
    const [lng, lat] = DEMO_ROAD_PATH[idx];
    const dist = haversineM(startLat, startLng, lat, lng);
    if (dist < minDist) {
      minDist = dist;
      closestIdx = idx;
    }
  }

  // Create route going forward
  const route: [number, number][] = [];
  for (let i = 0; i < DEMO_ROAD_PATH.length; i++) {
    const idx = (closestIdx + i) % DEMO_ROAD_PATH.length;
    route.push(DEMO_ROAD_PATH[idx]);
  }
  // Add first point to close the loop if we want continuous path
  route.push(route[0]);
  return route;
}

// Async helper to fetch OSRM route
async function fetchOSRMRoute(start: [number, number], end: [number, number]): Promise<[number, number][] | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${start[0]},${start[1]};${end[0]},${end[1]}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout?.(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code === 'Ok' && data.routes && data.routes[0]) {
      return data.routes[0].geometry.coordinates as [number, number][];
    }
  } catch {
    // Fail silently, fallback is used
  }
  return null;
}

// Select a random destination in Bengaluru
function getNewDestination(lat: number, lng: number): [number, number] {
  // Select a random distance between 1.5 and 3.0 km
  const randomAngle = Math.random() * 2 * Math.PI;
  const randomDistKm = 1.5 + Math.random() * 1.5;
  const dLat = (randomDistKm / 111.32) * Math.cos(randomAngle);
  const dLng = (randomDistKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(randomAngle);
  return [lng + dLng, lat + dLat];
}

// Initialize state
function initVehicleState(
  deviceId: number,
  lat: number,
  lng: number,
  heading: number,
  state: string,
  moving: boolean
): SimState {
  const dest = getNewDestination(lat, lng);
  const fallback = getFallbackRoute(lat, lng);

  const initial: SimState = {
    deviceId,
    latitude: lat,
    longitude: lng,
    speed: moving ? 15 : 0,
    heading,
    route: fallback,
    routeIndex: 0,
    segmentFraction: 0,
    targetSpeed: moving ? CRUISE_SPEED : 0,
    destination: dest,
    state,
    moving,
    updatedAt: Date.now(),
    fetchingRoute: false,
    pausedUntil: 0,
  };

  vehicleStates.set(deviceId, initial);

  // Trigger OSRM route fetch in background
  triggerRouteFetch(deviceId, [lng, lat], dest);

  return initial;
}

function triggerRouteFetch(deviceId: number, start: [number, number], dest: [number, number]) {
  const current = vehicleStates.get(deviceId);
  if (!current || current.fetchingRoute) return;

  current.fetchingRoute = true;
  fetchOSRMRoute(start, dest).then((osrmCoords) => {
    const updated = vehicleStates.get(deviceId);
    if (!updated) return;
    updated.fetchingRoute = false;
    if (osrmCoords && osrmCoords.length >= 2) {
      updated.route = osrmCoords;
      updated.routeIndex = 0;
      updated.segmentFraction = 0;
    }
  });
}

/**
 * Get or update the simulation state of a vehicle.
 */
export function getSimulatedVehicle(
  deviceId: number,
  seedLat: number,
  seedLng: number,
  seedHeading: number,
  state: string,
  moving: boolean
): SimState {
  let sim = vehicleStates.get(deviceId);
  if (!sim) {
    sim = initVehicleState(deviceId, seedLat, seedLng, seedHeading, state, moving);
  }

  // Update states that can change dynamically from parameters
  sim.state = state;
  sim.moving = moving;

  const now = Date.now();
  const dt = Math.min(2.0, (now - sim.updatedAt) / 1000);
  sim.updatedAt = now;

  if (dt <= 0) return sim;

  // Handle stopped or inactive vehicles
  if (!moving) {
    sim.speed = Math.max(0, sim.speed - DECEL * dt);
    sim.targetSpeed = 0;
    return sim;
  }

  // Handle pause at destination
  if (now < sim.pausedUntil) {
    sim.speed = 0;
    sim.targetSpeed = 0;
    return sim;
  }

  // If no route exists (should not happen due to fallback), get fallback
  if (sim.route.length < 2) {
    sim.route = getFallbackRoute(sim.latitude, sim.longitude);
    sim.routeIndex = 0;
    sim.segmentFraction = 0;
  }

  // Calculate speed limit / target speed
  // 1. Decelerate near destination
  let distanceToDestination = 0;
  for (let i = sim.routeIndex; i < sim.route.length - 1; i++) {
    const p1 = sim.route[i];
    const p2 = sim.route[i + 1];
    const len = haversineM(p1[1], p1[0], p2[1], p2[0]);
    if (i === sim.routeIndex) {
      distanceToDestination += len * (1 - sim.segmentFraction);
    } else {
      distanceToDestination += len;
    }
  }

  let nextTargetSpeed = CRUISE_SPEED;

  if (distanceToDestination < STOP_DISTANCE) {
    nextTargetSpeed = Math.max(0, (distanceToDestination / STOP_DISTANCE) * CRUISE_SPEED);
  } else {
    // 2. Slow down for sharp turns ahead
    let lookAheadDist = 0;
    let turnDetected = false;
    let prevBearing = -1;

    for (let i = sim.routeIndex; i < sim.route.length - 1; i++) {
      const p1 = sim.route[i];
      const p2 = sim.route[i + 1];
      const brg = bearingDeg(p1[1], p1[0], p2[1], p2[0]);
      if (prevBearing !== -1) {
        const diff = Math.abs((((brg - prevBearing) % 360) + 540) % 360 - 180);
        if (diff > 30) {
          turnDetected = true;
          break;
        }
      }
      prevBearing = brg;
      const len = i === sim.routeIndex ? haversineM(sim.latitude, sim.longitude, p2[1], p2[0]) : haversineM(p1[1], p1[0], p2[1], p2[0]);
      lookAheadDist += len;
      if (lookAheadDist > TURN_DISTANCE_LOOKAHEAD) break;
    }

    if (turnDetected) {
      nextTargetSpeed = TURN_SPEED;
    }
  }

  sim.targetSpeed = nextTargetSpeed;

  // Apply smooth acceleration/deceleration
  if (sim.speed < sim.targetSpeed) {
    sim.speed = Math.min(sim.targetSpeed, sim.speed + ACCEL * dt);
  } else if (sim.speed > sim.targetSpeed) {
    sim.speed = Math.max(sim.targetSpeed, sim.speed - DECEL * dt);
  }

  // Advance position along route
  let distToTravel = (sim.speed / 3.6) * dt; // meters
  if (distToTravel > 0) {
    while (distToTravel > 0 && sim.routeIndex < sim.route.length - 1) {
      const p1 = sim.route[sim.routeIndex];
      const p2 = sim.route[sim.routeIndex + 1];
      const segLen = haversineM(p1[1], p1[0], p2[1], p2[0]);
      const remSegLen = segLen * (1 - sim.segmentFraction);

      if (distToTravel >= remSegLen) {
        distToTravel -= remSegLen;
        sim.routeIndex++;
        sim.segmentFraction = 0;
      } else {
        sim.segmentFraction += distToTravel / segLen;
        distToTravel = 0;
      }
    }

    // Check if destination reached
    if (sim.routeIndex >= sim.route.length - 1) {
      const lastPoint = sim.route[sim.route.length - 1];
      sim.latitude = lastPoint[1];
      sim.longitude = lastPoint[0];
      sim.speed = 0;
      sim.pausedUntil = Date.now() + 3000 + Math.random() * 3000; // Pause for 3-6s

      // Plan next destination
      const nextDest = getNewDestination(sim.latitude, sim.longitude);
      sim.destination = nextDest;
      triggerRouteFetch(deviceId, [sim.longitude, sim.latitude], nextDest);
    } else {
      // Calculate centerline position
      const p1 = sim.route[sim.routeIndex];
      const p2 = sim.route[sim.routeIndex + 1];
      const rawLat = p1[1] + (p2[1] - p1[1]) * sim.segmentFraction;
      const rawLng = p1[0] + (p2[0] - p1[0]) * sim.segmentFraction;

      const brg = bearingDeg(p1[1], p1[0], p2[1], p2[0]);
      sim.heading = brg;

      // Apply lane offset (left side of road)
      const leftBrg = (brg - 90 + 360) % 360;
      const rad = (leftBrg * Math.PI) / 180;
      const offsetLat = (LANE_OFFSET_METERS / 6371000) * (180 / Math.PI) * Math.cos(rad);
      const offsetLng = (LANE_OFFSET_METERS / (6371000 * Math.cos((rawLat * Math.PI) / 180))) * (180 / Math.PI) * Math.sin(rad);

      sim.latitude = rawLat + offsetLat;
      sim.longitude = rawLng + offsetLng;
    }
  }

  return sim;
}
