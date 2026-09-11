import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

/**
 * The same file the native splash screen is configured with.
 *
 * <p>This is what makes the handover invisible: Android draws this artwork on
 * this navy before a single line of JavaScript has run, and the first frame
 * here lands the real wordmark in the same place at the same size. The screen
 * used to spell "GLIVT" out of five `Text` glyphs in the system font instead,
 * so the launch sequence showed the actual logo, then replaced it with an
 * approximation of the logo in whatever typeface the device happened to have.
 */
const WORDMARK = require('../../assets/images/glivt-wordmark-cropped.png');

/** Matches `backgroundColor` in the expo-splash-screen plugin config. */
const NAVY = '#0B161E';
const NAVY_DEEP = '#060D13';
const BEAM = '#2B7CF3';
const CYAN = '#2A91BD';

/** Native aspect ratio of the wordmark asset (430 x 144). */
const WORDMARK_RATIO = 430 / 144;

/** Time from first frame to the exit fade, in ms. */
const RUNTIME = 2200;

/** Ring diameters as a fraction of screen width, innermost first. */
const RING_SCALES = [0.52, 0.74, 0.96];

type Props = {
  /** Called once the exit fade has finished and the app below is safe to show. */
  onFinished: () => void;
  /**
   * Whether the app behind is ready. The splash holds its final frame until this
   * turns true, so a slow cold start extends the animation rather than cutting
   * to a half-built screen.
   */
  ready: boolean;
};

/**
 * The GLIVT launch animation.
 *
 * <p>It continues the native splash rather than replacing it: both draw the
 * same wordmark on the same brand navy, so there is no visible seam where one
 * hands over to the other.
 *
 * <p>The rings are concentric and fixed, not expanding. An expanding ping reads
 * as a radar sweep in motion but leaves the composition different in every
 * frame - a screenshot catches rings at arbitrary radii, some clipped by the
 * screen edge. Holding them still and breathing their opacity keeps the layout
 * stable at every instant while the screen is still alive. The one thing that
 * does travel is a single highlight sweeping across the mark, which is enough
 * to say "running" without moving anything the eye is reading.
 */
export function BrandSplash({ onFinished, ready }: Props) {
  const { width } = useWindowDimensions();

  const markOpacity = useSharedValue(0);
  const markScale = useSharedValue(0.9);
  const rings = useSharedValue(0);
  const breathe = useSharedValue(0);
  const sheen = useSharedValue(0);
  const tagline = useSharedValue(0);
  const exit = useSharedValue(0);

  const ringSizes = useMemo(() => RING_SCALES.map((scale) => Math.round(width * scale)), [width]);
  // Capped so the wordmark cannot run to the screen edges on a tablet.
  const markWidth = useMemo(() => Math.min(Math.round(width * 0.56), 300), [width]);
  const markHeight = useMemo(() => Math.round(markWidth / WORDMARK_RATIO), [markWidth]);

  useEffect(() => {
    markOpacity.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.quad) });
    markScale.value = withSpring(1, { damping: 14, stiffness: 120, mass: 0.9 });

    rings.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });

    // A slow swell rather than an expansion: the rings stay where they are, so
    // the composition never changes, but the screen is not frozen either.
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1400, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );

    sheen.value = withDelay(
      420,
      withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.cubic) }), -1, false)
    );

    tagline.value = withDelay(640, withTiming(1, { duration: 620, easing: Easing.out(Easing.quad) }));

    return () => {
      cancelAnimation(breathe);
      cancelAnimation(sheen);
    };
  }, [breathe, markOpacity, markScale, rings, sheen, tagline]);

  // Exit only once the animation has played and the app behind is ready.
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setTimeout(() => {
      cancelAnimation(breathe);
      cancelAnimation(sheen);
      exit.value = withSequence(
        withTiming(0.06, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 420, easing: Easing.in(Easing.quad) }, (finished) => {
          if (finished) {
            runOnJS(onFinished)();
          }
        })
      );
    }, RUNTIME);
    return () => clearTimeout(timer);
  }, [breathe, exit, onFinished, ready, sheen]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: 1 - exit.value,
    // A slight push-in on exit hands over to the app rather than just vanishing.
    transform: [{ scale: interpolate(exit.value, [0, 1], [1, 1.08]) }],
  }));

  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [{ scale: markScale.value }],
  }));

  const sheenStyle = useAnimatedStyle(() => ({
    // Travels one full mark-width beyond each edge so it enters and leaves
    // cleanly instead of appearing mid-mark.
    opacity: interpolate(sheen.value, [0, 0.12, 0.88, 1], [0, 0.5, 0.5, 0], 'clamp'),
    transform: [
      { translateX: interpolate(sheen.value, [0, 1], [-markWidth, markWidth]) },
      { rotate: '18deg' },
    ],
  }));

  const ring0 = useAnimatedStyle(() => ringFrame(rings.value, breathe.value, 0));
  const ring1 = useAnimatedStyle(() => ringFrame(rings.value, breathe.value, 1));
  const ring2 = useAnimatedStyle(() => ringFrame(rings.value, breathe.value, 2));
  const ringStyles = [ring0, ring1, ring2];

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: tagline.value,
    transform: [{ translateY: interpolate(tagline.value, [0, 1], [10, 0]) }],
  }));

  const underlineStyle = useAnimatedStyle(() => ({
    opacity: tagline.value,
    transform: [{ scaleX: tagline.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.root, containerStyle]}>
      <LinearGradient colors={[NAVY, NAVY_DEEP]} style={StyleSheet.absoluteFill} />

      <View style={[styles.stage, { height: ringSizes[2], width: ringSizes[2] }]}>
        {ringSizes.map((size, index) => (
          <Animated.View
            key={size}
            style={[
              styles.ring,
              { borderRadius: size / 2, height: size, width: size },
              ringStyles[index],
            ]}
          />
        ))}

        <Animated.View style={[styles.markClip, { height: markHeight, width: markWidth }, markStyle]}>
          <Animated.Image
            resizeMode="contain"
            source={WORDMARK}
            style={{ height: markHeight, width: markWidth }}
          />
          <Animated.View style={[styles.sheen, { height: markHeight * 2.4 }, sheenStyle]}>
            <LinearGradient
              colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.85)', 'rgba(255,255,255,0)']}
              end={{ x: 1, y: 0 }}
              start={{ x: 0, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </Animated.View>
      </View>

      <Animated.View
        style={[styles.underline, { width: Math.round(width * 0.25) }, underlineStyle]}
      />
      <Animated.Text style={[styles.tagline, taglineStyle]}>FLEET MANAGEMENT</Animated.Text>
    </Animated.View>
  );
}

/**
 * One frame of a concentric ring.
 *
 * Outer rings sit fainter than inner ones so the set reads as depth rather than
 * three equal circles, and the breath is scaled down accordingly.
 */
function ringFrame(entrance: number, breath: number, index: number) {
  'worklet';
  const base = [0.24, 0.16, 0.1][index];
  const start = index * 0.14;
  const appeared = interpolate(entrance, [start, start + 0.6], [0, 1], 'clamp');
  return {
    opacity: appeared * (base + breath * 0.05),
    transform: [{ scale: interpolate(appeared, [0, 1], [0.94, 1]) }],
  };
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: NAVY,
    justifyContent: 'center',
  },
  stage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    borderColor: BEAM,
    borderWidth: 1,
    position: 'absolute',
  },
  /** Clips the travelling highlight to the wordmark's own box. */
  markClip: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sheen: {
    position: 'absolute',
    width: 46,
  },
  underline: {
    backgroundColor: CYAN,
    borderRadius: 1,
    height: 2,
    marginTop: 26,
  },
  tagline: {
    color: '#8AA0B0',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 6,
    marginTop: 16,
  },
});
