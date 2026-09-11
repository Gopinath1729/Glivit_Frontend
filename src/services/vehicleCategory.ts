/** The only vehicle bodies exposed by the current Glivt map and device UI. */
export type VehicleBodyType = 'CAR' | 'BIKE' | 'TRUCK';

/**
 * Collapse legacy backend categories onto the three supported 3D bodies.
 *
 * Existing fleets can still contain older values such as BUS or SCOOTER. They
 * remain usable, but the renderer and editor never invent a fourth body type.
 */
export function vehicleBodyType(value?: string | null): VehicleBodyType {
  switch ((value ?? '').trim().toUpperCase()) {
    case 'BIKE':
    case 'MOTORCYCLE':
    case 'SCOOTER':
      return 'BIKE';
    case 'TRUCK':
    case 'LORRY':
    case 'MIXER_TRUCK':
    case 'TRAILER':
    case 'BUS':
    case 'EXCAVATOR':
    case 'HEAVY_MACHINERY':
      return 'TRUCK';
    default:
      return 'CAR';
  }
}

