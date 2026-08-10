export const VEHICLE_MARKER_IMAGES: Record<string, number> = {
  car_running: require('@/assets/markers/car_running.png'),
  car_stopped: require('@/assets/markers/car_stopped.png'),
  car_idle: require('@/assets/markers/car_idle.png'),
  car_inactive: require('@/assets/markers/car_inactive.png'),
  car_expired: require('@/assets/markers/car_expired.png'),
  car_no_data: require('@/assets/markers/car_no_data.png'),
  veh_bus: require('@/assets/markers/veh_bus.png'),
  veh_truck: require('@/assets/markers/veh_truck.png'),
  veh_van: require('@/assets/markers/veh_van.png'),
  veh_suv: require('@/assets/markers/veh_suv.png'),
  veh_bike: require('@/assets/markers/veh_bike.png'),
  veh_excavator: require('@/assets/markers/veh_excavator.png'),
  veh_auto: require('@/assets/markers/veh_auto.png'),
  veh_car: require('@/assets/markers/veh_car.png'),
};

const CATEGORY_ICON: Record<string, string> = {
  AUTO: 'veh_auto',
  BIKE: 'veh_bike',
  BUS: 'veh_bus',
  CAR: 'veh_car',
  EXCAVATOR: 'veh_excavator',
  HEAVY_MACHINERY: 'veh_excavator',
  JEEP: 'veh_suv',
  LORRY: 'veh_truck',
  MIXER_TRUCK: 'veh_truck',
  MOTORCYCLE: 'veh_bike',
  RICKSHAW: 'veh_auto',
  SCOOTER: 'veh_bike',
  SEDAN: 'veh_car',
  SUV: 'veh_suv',
  TRUCK: 'veh_truck',
  VAN: 'veh_van',
};

export function vehicleMarkerKey(category?: string | null, state?: string | null): string {
  const vehicleKey = CATEGORY_ICON[(category ?? '').toUpperCase()];

  if (!vehicleKey || vehicleKey === 'veh_car') {
    switch ((state ?? '').toUpperCase()) {
      case 'RUNNING':
        return 'car_running';
      case 'IDLE':
        return 'car_idle';
      case 'STOPPED':
        return 'car_stopped';
      case 'INACTIVE':
        return 'car_inactive';
      case 'EXPIRED':
        return 'car_expired';
      default:
        return 'car_no_data';
    }
  }

  return vehicleKey in VEHICLE_MARKER_IMAGES ? vehicleKey : 'veh_car';
}

export function vehicleMarkerSource(category?: string | null, state?: string | null): number {
  return VEHICLE_MARKER_IMAGES[vehicleMarkerKey(category, state)] ?? VEHICLE_MARKER_IMAGES.veh_car;
}

/**
 * Per-artwork rotation offset, in degrees.
 *
 * Each marker PNG is drawn with its nose pointing in a fixed direction. To display a
 * compass heading H the image is rotated by `H + offset`, so the offset must cancel
 * the artwork's own direction:
 *
 *     offset = (360 - directionTheArtworkFaces) % 360
 *
 * i.e. artwork facing north (up) -> 0, east (right) -> 270, south (down) -> 180,
 * west (left) -> 90.
 *
 * The values below were set from the measured principal axis of each asset's alpha
 * mask (length : width ≈ 2:1, so the long axis is unambiguous):
 *
 *     veh_bike                     axis 172deg -> vertical,   nose up    -> 0
 *     veh_truck/suv/van/bus/auto   axis   0deg -> vertical,   nose down  -> 180
 *     veh_car, car_*               axis  90deg -> horizontal, nose left  -> 90
 *
 * A missing entry means "no rotation", which is only correct for north-facing
 * artwork. veh_suv and veh_van were previously absent and therefore rendered 180deg
 * backwards: they are the same vertical, south-facing render family as veh_truck.
 */
const HEADING_OFFSET_BY_KEY: Record<string, number> = {
  car_expired: 90,
  car_idle: 90,
  car_inactive: 90,
  car_no_data: 90,
  car_running: 90,
  car_stopped: 90,
  veh_auto: 180,
  veh_bike: 0,
  veh_bus: 180,
  veh_car: 90,
  veh_excavator: 180,
  veh_suv: 180,
  veh_truck: 180,
  veh_van: 180,
};

export function normalizeHeading(heading?: number | null): number {
  return Number.isFinite(heading) ? ((heading! % 360) + 360) % 360 : 0;
}

export function vehicleMarkerRotation(
  heading?: number | null,
  category?: string | null,
  state?: string | null
): number {
  const key = vehicleMarkerKey(category, state);
  return normalizeHeading(normalizeHeading(heading) + (HEADING_OFFSET_BY_KEY[key] ?? 0));
}
