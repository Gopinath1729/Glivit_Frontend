import type { ImageRequireSource } from 'react-native';

/**
 * Pre-baked map marker bitmaps, one per device state.
 *
 * Android cannot rasterise a React view into a marker under the New
 * Architecture. react-native-maps 1.20 ships no codegen spec, so it runs
 * through Fabric's legacy interop, where `MapMarkerManager.updateExtraData` --
 * the only thing that reports the marker view's measured size -- is never
 * called: Fabric invokes it only when `updateState` returns non-null, and
 * `ViewGroupManager.updateState` returns null. `MapMarker.width/height` stay 0,
 * so `createDrawable` bakes the marker into a 100x100 PIXEL bitmap drawn from
 * the view's top-left corner. A 52dp marker on a 3x screen is ~231px of mostly
 * transparent padding around a centred car, so the captured square is empty and
 * the vehicle never appears.
 *
 * Passing a finished PNG through the marker's `image` prop skips rasterisation
 * entirely -- Google Maps gets the bitmap as-is, at full size, and rotates it
 * itself. The trade is that the status colour has to be part of the sprite,
 * which is why these are generated per state by
 * `scripts/build-vehicle-marker-sprites.js`.
 *
 * iOS keeps the vector VehicleMarker view: MapKit has no marker rotation at all
 * (AIRMapMarker does not implement the prop), so the glyph has to be rotated in
 * the view hierarchy there.
 */
type SpritePair = { normal: ImageRequireSource; selected: ImageRequireSource };

const SPRITES = {
  running: {
    normal: require('../../assets/markers/vehicle/vehicle_running.png'),
    selected: require('../../assets/markers/vehicle/vehicle_running_selected.png'),
  },
  idle: {
    normal: require('../../assets/markers/vehicle/vehicle_idle.png'),
    selected: require('../../assets/markers/vehicle/vehicle_idle_selected.png'),
  },
  stopped: {
    normal: require('../../assets/markers/vehicle/vehicle_stopped.png'),
    selected: require('../../assets/markers/vehicle/vehicle_stopped_selected.png'),
  },
  inactive: {
    normal: require('../../assets/markers/vehicle/vehicle_inactive.png'),
    selected: require('../../assets/markers/vehicle/vehicle_inactive_selected.png'),
  },
  no_data: {
    normal: require('../../assets/markers/vehicle/vehicle_no_data.png'),
    selected: require('../../assets/markers/vehicle/vehicle_no_data_selected.png'),
  },
  expired: {
    normal: require('../../assets/markers/vehicle/vehicle_expired.png'),
    selected: require('../../assets/markers/vehicle/vehicle_expired_selected.png'),
  },
} satisfies Record<string, SpritePair>;

export type VehicleSpriteState = keyof typeof SPRITES;

/**
 * Sprite canvas edge, in dp. Callers that project a marker's screen box (popup
 * placement, decluttering) size it from here so the bitmap and the layout agree.
 */
export const VEHICLE_SPRITE_SIZE = 60;
export const VEHICLE_SPRITE_SIZE_SELECTED = 74;

/** Collapses the API's device states onto the six sprites that exist. */
export function vehicleSpriteState(state?: string | null): VehicleSpriteState {
  switch ((state ?? '').toUpperCase()) {
    case 'RUNNING':
    case 'MOVING':
      return 'running';
    case 'STOPPED':
    // Retired state: rows written before IDLE was removed draw as stopped.
    case 'IDLE':
      return 'stopped';
    case 'INACTIVE':
      return 'inactive';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'no_data';
  }
}

export function vehicleSprite(state?: string | null, selected = false): ImageRequireSource {
  const pair = SPRITES[vehicleSpriteState(state)];
  return selected ? pair.selected : pair.normal;
}
