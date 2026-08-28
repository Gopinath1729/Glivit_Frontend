/**
 * Web renders fleet markers inside FleetWebMap/MapLibre. Keeping this module
 * platform-specific prevents react-native-maps native codegen modules from
 * entering Expo's static web bundle through the shared Live Map screen.
 */
export function LiveVehicleMapMarker() {
  return null;
}
