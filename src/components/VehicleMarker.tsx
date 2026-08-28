import React, { memo, useMemo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

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
  switch ((category ?? '').toUpperCase()) {
    case 'CAR':
    case 'SEDAN':
    case 'HATCHBACK':
    case 'SUV':
      return 'car';
    case 'TRUCK':
    case 'LORRY':
    case 'MIXER_TRUCK':
      return 'truck';
    case 'BUS':
      return 'bus';
    case 'VAN':
    case 'JEEP':
      return 'van';
    case 'BIKE':
    case 'MOTORCYCLE':
    case 'SCOOTER':
      return 'bike';
    case 'AUTO':
    case 'RICKSHAW':
      return 'auto';
    case 'EXCAVATOR':
    case 'HEAVY_MACHINERY':
      return 'machinery';
    default:
      return 'unknown';
  }
}

function colorWithAlpha(color: string, alpha: number): string {
  const clean = (color ?? '').trim().replace('#', '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
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
  const categoryScale = CATEGORY_SCALE[category] ?? 1;

  return (
    <View collapsable={false} pointerEvents="none" style={styles.wrapper}>
      {selected ? (
        <View
          style={[
            styles.selectionRing,
            { backgroundColor: colorWithAlpha(color, 0.08), borderColor: color },
          ]}
        />
      ) : null}

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
      <View style={[styles.statusDot, { backgroundColor: color, shadowColor: color }]} />
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
    const bodyOffset = (canvas - size) / 2;
    const ringSize = size * 1.08;
    const statusSize = Math.max(7, size * 0.16);
    return StyleSheet.create({
    wrapper: {
      alignItems: 'center',
      height: canvas,
      justifyContent: 'center',
      width: canvas,
    },
    selectionRing: {
      borderRadius: size,
      borderWidth: 2,
      height: ringSize,
      position: 'absolute',
      width: ringSize,
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
    statusDot: {
      borderColor: '#FFFFFF',
      borderRadius: size,
      borderWidth: 1.5,
      bottom: bodyOffset + size * 0.06,
      elevation: 4,
      height: statusSize,
      position: 'absolute',
      right: bodyOffset + size * 0.06,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.55,
      shadowRadius: 3,
      width: statusSize,
    },
  });
  };
