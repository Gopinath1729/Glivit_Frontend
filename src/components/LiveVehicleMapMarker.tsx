import React, { useCallback, useEffect, useRef, memo, useState } from 'react';
import { Platform } from 'react-native';
import { AnimatedRegion, MarkerAnimated } from 'react-native-maps';
import { VehicleMarker, markerCategory } from '@/src/components/VehicleMarker';
import { vehicleSprite } from '@/src/components/vehicleMarkerSprites';
import { markerRotationFor, normalizeHeading } from '@/src/services/geoMath';
import type { FleetTarget } from '@/src/services/fleetLivePositions';
import type { DeviceSummary } from '@/src/types/api';

export type LocatedDevice = DeviceSummary & { latitude: number; longitude: number };

type LiveVehicleMapMarkerProps = {
  device: LocatedDevice;
  targetsRef: React.MutableRefObject<Map<number, FleetTarget>>;
  /** Camera heading, so the marker's cone points at the real bearing on screen. */
  projectionHeading: number;
  isSelected: boolean;
  onSelect: (id: number) => void;
  /** Status colour for this device's state, resolved by the caller's theme. */
  color: string;
};

// MarkerAnimated is what accepts an AnimatedRegion coordinate.
const AnimatedNativeMarker = MarkerAnimated as any;

/**
 * Android draws the vehicle from a pre-baked bitmap rather than from a React
 * view: Fabric's legacy interop never reports a marker view's size, so
 * react-native-maps bakes every custom marker into a 100x100 pixel square taken
 * from its top-left corner -- which for a centred car is empty. See
 * `vehicleMarkerSprites` for the full account. iOS keeps the vector marker,
 * because MapKit cannot rotate a marker image at all.
 */
const USE_SPRITE = Platform.OS === 'android';

export const LiveVehicleMapMarker = memo(function LiveVehicleMapMarker({
  device,
  targetsRef,
  projectionHeading,
  isSelected,
  onSelect,
  color,
}: LiveVehicleMapMarkerProps) {
  const coordinateRef = useRef(
    new AnimatedRegion({
      latitude: device.latitude,
      longitude: device.longitude,
      latitudeDelta: 0,
      longitudeDelta: 0,
    })
  );
  const rafRef = useRef<number | null>(null);
  const lastUpdateRef = useRef(Date.now());

  useEffect(() => {
    let active = true;
    const loop = () => {
      if (!active) return;
      const now = Date.now();
      const dt = Math.min(0.1, (now - lastUpdateRef.current) / 1000);
      lastUpdateRef.current = now;

      const target = targetsRef.current.get(device.id);
      if (target && target.moving) {
        const damp = 1 - Math.exp(-6 * dt);
        const currentCoord = (coordinateRef.current as any).__getValue();
        const nextLat = currentCoord.latitude + (target.latitude - currentCoord.latitude) * damp;
        const nextLng = currentCoord.longitude + (target.longitude - currentCoord.longitude) * damp;

        coordinateRef.current.setValue({
          latitude: nextLat,
          longitude: nextLng,
          latitudeDelta: 0,
          longitudeDelta: 0,
        });
      } else if (target && !target.moving) {
        // Snap to target if stopped
        coordinateRef.current.setValue({
          latitude: target.latitude,
          longitude: target.longitude,
          latitudeDelta: 0,
          longitudeDelta: 0,
        });
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      active = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [device.id, targetsRef]);

  const markerSize = isSelected ? 64 : 52;
  // The vehicle artwork's own orientation offset is applied here, in the one
  // shared helper, rather than being re-derived per call site.
  const course = markerRotationFor(device.course ?? 0);
  // A flat sprite is rotated by the map itself, so it wants the true bearing.
  // The vector marker draws its own cone into a billboard the SDK never turns,
  // so that one has to be handed the bearing relative to the camera instead.
  const heading = USE_SPRITE ? course : normalizeHeading(course - projectionHeading);
  const moving = device.state === 'RUNNING' && (device.speed ?? 0) > 0;

  // Android rasterises a custom marker view once and reuses the bitmap, so it
  // has to be told when the drawing actually changed. Heading is bucketed to
  // 15deg: a vehicle rounding a corner re-bakes a few times, not on every fix.
  const headingBucket = Math.round(heading / 15);
  // Rasterisation used to stop on a fixed 240ms timer. If the car bitmap had
  // not decoded by then Android baked an empty frame and never re-baked, so the
  // marker stayed blank. Tracking continues until the image reports it loaded.
  const [imageLoaded, setImageLoaded] = useState(false);
  const onImageLoad = useCallback(() => setImageLoaded(true), []);
  const [tracksView, setTracksView] = useState(true);
  useEffect(() => {
    if (USE_SPRITE) return;
    setTracksView(true);
    // Prefer the decoded-image signal, but never wait on it forever. iOS does
    // not always fire onLoad for a bundled static image, and leaving
    // rasterisation on permanently costs a redraw every frame.
    const timer = setTimeout(() => setTracksView(false), imageLoaded ? 120 : 1500);
    return () => clearTimeout(timer);
  }, [color, headingBucket, imageLoaded, isSelected, moving]);

  const onPress = useCallback(
    (event: any) => {
      event.stopPropagation();
      onSelect(device.id);
    },
    [device.id, onSelect]
  );

  if (USE_SPRITE) {
    return (
      <AnimatedNativeMarker
        coordinate={coordinateRef.current}
        anchor={{ x: 0.5, y: 0.5 }}
        flat
        image={vehicleSprite(device.state, isSelected)}
        rotation={heading}
        // Nothing is rasterised from a view, so there is no bitmap to re-bake.
        tracksViewChanges={false}
        onPress={onPress}
        zIndex={isSelected ? 50 : 20}
      />
    );
  }

  return (
    <AnimatedNativeMarker
      coordinate={coordinateRef.current}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      tracksViewChanges={tracksView}
      onPress={onPress}
      zIndex={isSelected ? 50 : 20}>
      <VehicleMarker
        category={markerCategory(device.category)}
        color={color}
        heading={heading}
        moving={moving}
        onImageLoad={onImageLoad}
        selected={isSelected}
        size={markerSize}
      />
    </AnimatedNativeMarker>
  );
});
