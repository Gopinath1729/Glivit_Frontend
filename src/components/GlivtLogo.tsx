import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, View } from 'react-native';

type Props = {
  size?: number;
};

/**
 * Exact Glivt wordmark supplied for the app, cropped only to remove transparent
 * outer padding. `size` is the rendered height; the original aspect ratio is
 * preserved.
 */
export function GlivtLogo({ size = 76 }: Props) {
  return (
    <View style={[styles.wrap, { width: size * 2.986, height: size }]}>
      <Image
        source={require('@/assets/images/glivt-wordmark-cropped.png')}
        contentFit="contain"
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
  },
});
