import React, { memo, useMemo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { vehicleBodyType } from '@/src/services/vehicleCategory';

export type VehicleMarkerCategory =
  | 'car'
  | 'truck'
  | 'bus'
  | 'van'
  | 'bike'
  | 'auto'
  | 'machinery'
  | 'unknown';

type Props = {
  heading: number;
  color: string;
  category: VehicleMarkerCategory;
  moving?: boolean;
  selected?: boolean;
  size?: number;
  /**
   * Fired once the car bitmap has decoded. Map markers rasterise their child
   * view on Android, so the caller needs this to know when the snapshot is
   * worth taking -- baking on a timer can capture an empty frame.
   */
  onImageLoad?: () => void;
};

const REALISTIC_CAR = require('../../assets/markers/car-marker-photorealistic-v4-map-trim.png');

/**
 * The sprite is trimmed to the car's own bounds (115x262, with a 2px alpha
 * margin). The untrimmed export wrapped the same car in ~38% horizontal and
 * ~19% vertical transparent padding, which had to be cancelled out by drawing
 * the <Image> larger than `size`. That made the image overflow its parent --
 * fine on iOS, which draws outside a view's bounds, but Android clips a child
 * to its parent and sheared the rotated car into a wedge. Trimming the asset
 * removes the overflow instead of relying on per-platform overflow behaviour.
 */
const SPRITE_ASPECT = 115 / 262;

/**
 * Square canvas a marker of `size` rasterises into. A rectangular vehicle
 * sweeps a larger square as it rotates, so this has to clear the image box's
 * diagonal or react-native-maps crops bumpers at diagonal headings. Callers
 * that wrap the marker in a fixed-size container MUST size it with this, or
 * Android bakes the marker bitmap at the container's bounds and silently
 * clips whatever overflows.
 */
export function vehicleMarkerCanvas(size: number): number {
  return Math.ceil(size * 1.48);
}

const CATEGORY_SCALE: Record<VehicleMarkerCategory, number> = {
  car: 1,
  truck: 1.04,
  bus: 1.04,
  van: 1.02,
  bike: 0.82,
  auto: 0.9,
  machinery: 1.04,
  unknown: 1,
};

export function markerCategory(category?: string | null): VehicleMarkerCategory {
  switch (vehicleBodyType(category)) {
    case 'CAR':
      return 'car';
    case 'TRUCK':
      return 'truck';
    case 'BIKE':
      return 'bike';
  }
}

/**
 * Photorealistic navigation marker. The car is an alpha PNG product render;
 * heading, movement, live status and selection remain driven by map state.
 */
function VehicleMarkerBase({
  category,
  color,
  heading,
  moving = false,
  selected = false,
  size = 48,
  onImageLoad,
}: Props) {
  const styles = useMemo(() => makeStyles(size), [size]);
  const rotation = Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0;
  const categoryScale = (CATEGORY_SCALE[category] ?? 1) * (selected ? 1.1 : 1);

  return (
    <View collapsable={false} pointerEvents="none" style={styles.wrapper}>
      <View
        style={[
          styles.rotatingBody,
          { transform: [{ rotate: `${rotation}deg` }, { scale: categoryScale }] },
        ]}>
        {moving ? (
          <Svg height={size} pointerEvents="none" style={styles.directionBeam} viewBox="0 0 100 100" width={size}>
            <Path d="M 50 2 L 68 39 L 50 31 L 32 39 Z" fill={color} fillOpacity={0.28} />
          </Svg>
        ) : null}
        <Image
          onLoad={onImageLoad}
          resizeMode="contain"
          source={REALISTIC_CAR}
          style={styles.vehicleImage}
        />
      </View>
    </View>
  );
}

export const VehicleMarker = memo(
  VehicleMarkerBase,
  (prev, next) =>
    prev.color === next.color &&
    prev.category === next.category &&
    prev.moving === next.moving &&
    prev.selected === next.selected &&
    prev.size === next.size &&
    prev.onImageLoad === next.onImageLoad &&
    Math.round(prev.heading) === Math.round(next.heading)
);

const makeStyles = (size: number) =>
  {
    const canvas = vehicleMarkerCanvas(size);
    return StyleSheet.create({
    wrapper: {
      alignItems: 'center',
      height: canvas,
      justifyContent: 'center',
      width: canvas,
    },
    // The full canvas, not `size`: a rotated child sweeps beyond the unrotated
    // box, and Android clips whatever leaves its parent. Everything inside
    // stays centred, so the glyph does not move.
    rotatingBody: {
      alignItems: 'center',
      height: canvas,
      justifyContent: 'center',
      position: 'absolute',
      width: canvas,
    },
    // Centred by the parent's align rules rather than pinned to a corner, which
    // is where top/left:0 would now put it.
    directionBeam: {
      position: 'absolute',
    },
    vehicleImage: {
      height: size,
      width: size * SPRITE_ASPECT,
    },
  });
  };
