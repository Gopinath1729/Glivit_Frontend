/**
 * Shared road-aligned Bengaluru demo route.
 *
 * These vertices follow actual street turns closely enough for interpolation;
 * both native-map and cinematic playback consume this exact array so the car
 * can no longer drift onto a different synthetic path between views.
 */
export type DemoRouteCoordinate = {
  latitude: number;
  longitude: number;
};

export const DEMO_ROAD_ROUTE: DemoRouteCoordinate[] = [
  { latitude: 12.971873, longitude: 77.594634 },
  { latitude: 12.972069, longitude: 77.594147 },
  { latitude: 12.973084, longitude: 77.59475 },
  { latitude: 12.974067, longitude: 77.595777 },
  { latitude: 12.97502, longitude: 77.596943 },
  { latitude: 12.976297, longitude: 77.598726 },
  { latitude: 12.976672, longitude: 77.599195 },
  { latitude: 12.976661, longitude: 77.600859 },
  { latitude: 12.976843, longitude: 77.601809 },
  { latitude: 12.979084, longitude: 77.602355 },
  { latitude: 12.978999, longitude: 77.603454 },
  { latitude: 12.978329, longitude: 77.605485 },
  { latitude: 12.977919, longitude: 77.606737 },
  { latitude: 12.977529, longitude: 77.607925 },
  { latitude: 12.977055, longitude: 77.608755 },
  { latitude: 12.975154, longitude: 77.608078 },
  { latitude: 12.974442, longitude: 77.611112 },
  { latitude: 12.974046, longitude: 77.611179 },
  { latitude: 12.973438, longitude: 77.610926 },
  { latitude: 12.971895, longitude: 77.610576 },
  { latitude: 12.971539, longitude: 77.610499 },
  { latitude: 12.970416, longitude: 77.610288 },
  { latitude: 12.970172, longitude: 77.610756 },
  { latitude: 12.969826, longitude: 77.611784 },
  { latitude: 12.969783, longitude: 77.612137 },
  { latitude: 12.971078, longitude: 77.612358 },
  { latitude: 12.972735, longitude: 77.612712 },
  { latitude: 12.973847, longitude: 77.612908 },
  { latitude: 12.974084, longitude: 77.612127 },
  { latitude: 12.974557, longitude: 77.610153 },
  { latitude: 12.974849, longitude: 77.608919 },
  { latitude: 12.975057, longitude: 77.608042 },
  { latitude: 12.976775, longitude: 77.608556 },
  { latitude: 12.977275, longitude: 77.608716 },
  { latitude: 12.97991, longitude: 77.609666 },
  { latitude: 12.980994, longitude: 77.610235 },
  { latitude: 12.980775, longitude: 77.610971 },
  { latitude: 12.981373, longitude: 77.611542 },
  { latitude: 12.982204, longitude: 77.612275 },
  { latitude: 12.982906, longitude: 77.61291 },
  { latitude: 12.982561, longitude: 77.61431 },
  { latitude: 12.982699, longitude: 77.615667 },
  { latitude: 12.982656, longitude: 77.615788 },
  { latitude: 12.981922, longitude: 77.615632 },
  { latitude: 12.981276, longitude: 77.615667 },
  { latitude: 12.980701, longitude: 77.616329 },
  { latitude: 12.98085, longitude: 77.61605 },
  { latitude: 12.980764, longitude: 77.615836 },
  { latitude: 12.981065, longitude: 77.615544 },
  { latitude: 12.981559, longitude: 77.615623 },
  { latitude: 12.982581, longitude: 77.615623 },
  { latitude: 12.982699, longitude: 77.615667 },
  { latitude: 12.983219, longitude: 77.616567 },
  { latitude: 12.984059, longitude: 77.617614 },
  { latitude: 12.98519, longitude: 77.618647 },
  { latitude: 12.98678, longitude: 77.619491 },
  { latitude: 12.987217, longitude: 77.619268 },
  { latitude: 12.988027, longitude: 77.619368 },
  { latitude: 12.990033, longitude: 77.619476 },
  { latitude: 12.990805, longitude: 77.619415 },
  { latitude: 12.99284, longitude: 77.618724 },
  { latitude: 12.992865, longitude: 77.61879 },
  { latitude: 12.992941, longitude: 77.618951 },
  { latitude: 12.992902, longitude: 77.619829 },
  { latitude: 12.992873, longitude: 77.620851 },
  { latitude: 12.993186, longitude: 77.621935 },
  { latitude: 12.993237, longitude: 77.622299 },
  { latitude: 12.993166, longitude: 77.623239 },
  { latitude: 12.993143, longitude: 77.623685 },
  { latitude: 12.993647, longitude: 77.625347 },
  { latitude: 12.99318, longitude: 77.625735 },
];

export const DEMO_ROAD_PATH: [number, number][] = DEMO_ROAD_ROUTE.map(
  ({ latitude, longitude }) => [longitude, latitude]
);
