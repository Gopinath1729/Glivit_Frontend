import React, { memo } from 'react';

import { Polyline } from '@/src/components/maps/NativeMap';

export type RouteCoordinate = {
  latitude: number;
  longitude: number;
};

type BaseRouteProps = {
  auraColor: string;
  coordinates: RouteCoordinate[];
  lineColor: string;
  lineWidth?: number;
};

type RouteLineProps = {
  color: string;
  coordinates: RouteCoordinate[];
  width?: number;
  zIndex?: number;
};

/**
 * The complete route changes only when accepted GPS history changes. Keeping it
 * in a memoized child prevents marker/camera frames from touching native route
 * overlays or rebuilding MapLibre-equivalent line buckets.
 */
export const StableBaseRoute = memo(function StableBaseRoute({
  auraColor,
  coordinates,
  lineColor,
  lineWidth = 7,
}: BaseRouteProps) {
  if (coordinates.length < 2) return null;
  return (
    <>
      <Polyline
        key="route-aura"
        coordinates={coordinates}
        lineCap="round"
        lineJoin="round"
        strokeColor={auraColor}
        strokeWidth={lineWidth + 5}
        zIndex={10}
      />
      <Polyline
        key="route-base"
        coordinates={coordinates}
        lineCap="round"
        lineJoin="round"
        strokeColor={lineColor}
        strokeWidth={lineWidth}
        zIndex={11}
      />
    </>
  );
});

export const StableRouteLine = memo(function StableRouteLine({
  color,
  coordinates,
  width = 6,
  zIndex = 12,
}: RouteLineProps) {
  if (coordinates.length < 2) return null;
  return (
    <Polyline
      coordinates={coordinates}
      lineCap="round"
      lineJoin="round"
      strokeColor={color}
      strokeWidth={width}
      zIndex={zIndex}
    />
  );
});

export function sanitizeRouteCoordinates(
  coordinates: readonly RouteCoordinate[],
  minimumDistanceKm = 0.0005
): RouteCoordinate[] {
  const clean: RouteCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (
      !Number.isFinite(coordinate.latitude) ||
      !Number.isFinite(coordinate.longitude) ||
      Math.abs(coordinate.latitude) > 90 ||
      Math.abs(coordinate.longitude) > 180 ||
      (coordinate.latitude === 0 && coordinate.longitude === 0)
    ) {
      continue;
    }
    const previous = clean[clean.length - 1];
    if (previous) {
      const latKm = (coordinate.latitude - previous.latitude) * 111.32;
      const lngKm =
        (coordinate.longitude - previous.longitude) *
        111.32 *
        Math.max(0.15, Math.cos((coordinate.latitude * Math.PI) / 180));
      if (Math.hypot(latKm, lngKm) < minimumDistanceKm) {
        continue;
      }
    }
    clean.push(coordinate);
  }
  return clean;
}
