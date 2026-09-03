import React, { memo } from 'react';

import { Polyline } from '@/src/components/maps/NativeMap';
import {
  coordinateOf,
  distanceBetween,
  segmentConnectivity,
  type LatLng,
} from '@/src/services/gpsPipeline';

export type RouteCoordinate = LatLng;

type BaseRouteProps = {
  auraColor: string;
  coordinates: RouteCoordinate[];
  lineColor: string;
  lineWidth?: number;
};

type RouteLineProps = {
  auraColor?: string;
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
  auraColor,
  color,
  coordinates,
  width = 6,
  zIndex = 12,
}: RouteLineProps) {
  if (coordinates.length < 2) return null;
  return (
    <>
      {auraColor ? (
        <Polyline
          coordinates={coordinates}
          lineCap="round"
          lineJoin="round"
          strokeColor={auraColor}
          strokeWidth={width + 7}
          zIndex={zIndex - 1}
        />
      ) : null}
      <Polyline
        coordinates={coordinates}
        lineCap="round"
        lineJoin="round"
        strokeColor={color}
        strokeWidth={width}
        zIndex={zIndex}
      />
    </>
  );
});

/**
 * Removes duplicate vertices from ONE already-validated run.
 *
 * It no longer removes anything else. Dropping an unusable vertex from the
 * middle of a run silently joins its two neighbours with a straight line -
 * which is the exact artefact the vertex was dropped to avoid, now drawn with
 * no record that anything was discarded. Use {@link splitRouteCoordinates}
 * instead: it breaks the run at the bad vertex so the gap stays a gap.
 */
export function sanitizeRouteCoordinates(
  coordinates: readonly RouteCoordinate[],
  minimumSpacingMeters = 0.5
): RouteCoordinate[] {
  const clean: RouteCoordinate[] = [];
  for (const candidate of coordinates) {
    const coordinate = coordinateOf(candidate?.latitude, candidate?.longitude);
    if (!coordinate) continue;
    const previous = clean[clean.length - 1];
    if (previous && distanceBetween(previous, coordinate) < minimumSpacingMeters) continue;
    clean.push(coordinate);
  }
  return clean;
}

/**
 * One polyline-ready run per contiguous stretch of drawable geometry.
 *
 * A vertex that fails validation ENDS the run and starts a new one, rather than
 * being deleted from the middle of it. That is the difference between a break in
 * the data being drawn as a break and being drawn as a diagonal across the
 * buildings between its ends.
 *
 * <h3>Why there is no distance rule here</h3>
 * Because this sees no clock. Whether a 1.5 km step is a coverage gap or one
 * ordinary reporting interval depends entirely on how often the device reports,
 * and a fixed metre limit applied here would break a two-minute-cadence
 * tracker's route at every single fix. Every distance and time rule lives in
 * {@link segmentConnectivity}, applied where the timestamps are: by the live
 * trail as it is built, and by the backend as it flags coverage gaps.
 *
 * Runs shorter than two vertices are dropped here rather than by every caller:
 * a single point is not a line, and handing one to the native map produces an
 * overlay with no geometry that still costs a native view.
 */
export function splitRouteCoordinates(
  coordinates: readonly RouteCoordinate[],
  minimumSpacingMeters = 0.5
): RouteCoordinate[][] {
  const runs: RouteCoordinate[][] = [];
  let current: RouteCoordinate[] = [];

  const flush = () => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };

  for (const candidate of coordinates) {
    const coordinate = coordinateOf(candidate?.latitude, candidate?.longitude);
    if (!coordinate) {
      // Not "skip the bad point and carry on" - the two points either side of
      // it are no longer known to be adjacent.
      flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && distanceBetween(previous, coordinate) < minimumSpacingMeters) continue;
    current.push(coordinate);
  }
  flush();
  return runs;
}

/**
 * Splits a run using the full segment rule, when timestamps are available.
 *
 * Geometry that carries its own clock (a playback track, the live trail) can be
 * checked for elapsed time and implied speed as well as for distance, which is
 * what catches a chord across a silence the vehicle spent parked - short enough
 * in metres to pass the distance rule, long enough in seconds that the roads in
 * between were never observed.
 */
export function splitTimedRouteCoordinates(
  points: readonly (RouteCoordinate & { timestampMs: number; gapBefore?: boolean })[]
): RouteCoordinate[][] {
  const runs: RouteCoordinate[][] = [];
  let current: RouteCoordinate[] = [];
  let previous: (RouteCoordinate & { timestampMs: number }) | null = null;

  const flush = () => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };

  for (const candidate of points) {
    const coordinate = coordinateOf(candidate?.latitude, candidate?.longitude);
    if (!coordinate) {
      flush();
      previous = null;
      continue;
    }
    if (previous) {
      const decision = segmentConnectivity({
        previousTimestampMs: previous.timestampMs,
        currentTimestampMs: candidate.timestampMs,
        distanceMeters: distanceBetween(previous, coordinate),
        gapBefore: candidate.gapBefore,
      });
      if (!decision.connect) flush();
    }
    current.push(coordinate);
    previous = { ...coordinate, timestampMs: candidate.timestampMs };
  }
  flush();
  return runs;
}
