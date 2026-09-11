import React, { memo } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import type { VehicleBodyType } from '@/src/services/vehicleCategory';

const MODEL_RENDER: Record<VehicleBodyType, number> = {
  CAR: require('../../assets/images/vehicle-previews/car-3d.png'),
  BIKE: require('../../assets/images/vehicle-previews/bike-3d.png'),
  TRUCK: require('../../assets/images/vehicle-previews/truck-3d.png'),
};

type Props = {
  body: VehicleBodyType;
};

/**
 * A render of the same bundled GLB used on the live and playback maps.
 *
 * Ten cards can be on one page, so this is deliberately a pre-rendered mesh
 * rather than ten independent WebGL contexts. It keeps the real vehicle model
 * and lighting while decoding only a small PNG for each body type.
 */
function VehicleModelThumbnailBase({ body }: Props) {
  return (
    <View pointerEvents="none" style={styles.stage}>
      <View style={styles.glow} />
      <Image
        accessibilityIgnoresInvertColors
        fadeDuration={0}
        resizeMode="contain"
        source={MODEL_RENDER[body]}
        style={[styles.model, body === 'BIKE' && styles.bike]}
      />
    </View>
  );
}

export const VehicleModelThumbnail = memo(VehicleModelThumbnailBase);

const styles = StyleSheet.create({
  stage: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  glow: {
    backgroundColor: 'rgba(255,255,255,0.52)',
    borderRadius: 60,
    bottom: 10,
    height: 25,
    position: 'absolute',
    width: 82,
  },
  model: {
    height: '100%',
    transform: [{ translateY: 4 }],
    width: '116%',
  },
  bike: {
    height: '108%',
    width: '124%',
  },
});
