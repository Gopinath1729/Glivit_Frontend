import React, { useEffect, useRef, memo, useState } from 'react';
import { Platform, View } from 'react-native';
import { AnimatedRegion, MarkerAnimated } from 'react-native-maps';
import { Marker } from '@/src/components/maps/NativeMap';
import { Vehicle3DMarker, modelForVehicle } from '@/src/components/Vehicle3DMarker';
import { normalizeHeading, lerpAngle } from '@/src/services/playbackEngine';
import type { FleetTarget } from '@/src/services/fleetLivePositions';
import type { DeviceSummary } from '@/src/types/api';

export type LocatedDevice = DeviceSummary & { latitude: number; longitude: number };

type LiveVehicleMapMarkerProps = {
  device: LocatedDevice;
  targetsRef: React.MutableRefObject<Map<number, FleetTarget>>;
  projectionHeading: number;
  isSelected: boolean;
  onSelect: (id: number) => void;
  threeFailed: boolean;
};

// Use MarkerAnimated to support AnimatedRegion coordinate
const AnimatedNativeMarker = MarkerAnimated as any;

export const LiveVehicleMapMarker = memo(function LiveVehicleMapMarker({
  device,
  targetsRef,
  projectionHeading,
  isSelected,
  onSelect,
  threeFailed,
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
        
        coordinateRef.current.timing({
          latitude: nextLat,
          longitude: nextLng,
          latitudeDelta: 0,
          longitudeDelta: 0,
          duration: 33, // Target ~30fps 
          useNativeDriver: false,
        } as any).start();
      } else if (target && !target.moving) {
        // Snap to target if stopped
        coordinateRef.current.timing({
          latitude: target.latitude,
          longitude: target.longitude,
          latitudeDelta: 0,
          longitudeDelta: 0,
          duration: 100,
          useNativeDriver: false,
        } as any).start();
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

  const markerSize = isSelected ? 76 : 60;
  // If threeFailed is false, we just use opacity 0 so it's a touch target.
  // If true, it falls back to 2D image marker which we don't bother rotating seamlessly.
  
  const [tracksView, setTracksView] = useState(true);
  useEffect(() => {
    setTracksView(true);
    const timer = setTimeout(() => setTracksView(false), 240);
    return () => clearTimeout(timer);
  }, [threeFailed, device.state, isSelected]);

  return (
    <AnimatedNativeMarker
      coordinate={coordinateRef.current}
      anchor={{ x: 0.5, y: 0.5 }}
      flat={false}
      opacity={threeFailed ? 1 : 0}
      tracksViewChanges={threeFailed ? tracksView : false}
      onPress={(e: any) => {
        e.stopPropagation();
        onSelect(device.id);
      }}
      zIndex={isSelected ? 50 : 20}
    >
      {threeFailed ? (
        <Vehicle3DMarker
          heading={normalizeHeading((device.course ?? 0) - projectionHeading)}
          isActive={device.state === 'RUNNING'}
          renderMode="image"
          showImageFallback
          size={markerSize}
          speed={device.speed ?? 0}
          variant={modelForVehicle(device.category, device.id)}
        />
      ) : (
        <View style={{ width: markerSize, height: markerSize, backgroundColor: 'transparent' }} />
      )}
    </AnimatedNativeMarker>
  );
});
