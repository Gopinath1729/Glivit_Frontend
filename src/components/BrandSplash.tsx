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

const MARK = require('../../assets/images/splash-icon.png');

const NAVY = '#0B161E';
const NAVY_DEEP = '#060D13';
const GREEN = '#27D34D';
const CYAN = '#2A91BD';

/** Letters animate in one at a time, so the wordmark is spelled out. */
const WORDMARK = ['G', 'L', 'I', 'V', 'T'];

/** Time from first frame to the exit fade, in ms. */
const RUNTIME = 2400;

/** Ring diameters as a fraction of screen width, innermost first. */
const RING_SCALES = [0.42, 0.60, 0.78];

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
 * It continues the native splash rather than replacing it: both draw the same
 * mark on the same brand navy, so the handover is invisible.
 *
 * The rings are concentric and fixed, not expanding. An expanding ping reads as
 * a radar sweep in motion but leaves the composition different in every frame --
 * a screenshot catches rings at arbitrary radii, some clipped by the screen
 * edge. Holding them still and breathing the opacity keeps the layout stable at
 * every instant while the screen is still alive.
 */
export function BrandSplash({ onFinished, ready }: Props) {
  const { width } = useWindowDimensions();

  const markScale = useSharedValue(0.82);
  const markOpacity = useSharedValue(0);
  const rings = useSharedValue(0);
  const breathe = useSharedValue(0);
  const wordmark = useSharedValue(0);
  const tagline = useSharedValue(0);
  const exit = useSharedValue(0);

  const ringSizes = useMemo(() => RING_SCALES.map((scale) => Math.round(width * scale)), [width]);
  const markSize = useMemo(() => Math.round(width * 0.36), [width]);

  useEffect(() => {
    markOpacity.value = withDelay(120, withTiming(1, { duration: 460, easing: Easing.out(Easing.quad) }));
    markScale.value = withDelay(120, withSpring(1, { damping: 13, stiffness: 110, mass: 0.9 }));

    rings.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });

    // A slow swell rather than an expansion: the rings stay where they are, so
    // the composition never changes, but the screen is not frozen either.
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );

    wordmark.value = withDelay(560, withTiming(1, { duration: 760, easing: Easing.out(Easing.cubic) }));
    tagline.value = withDelay(1020, withTiming(1, { duration: 640, easing: Easing.out(Easing.quad) }));

    return () => {
      cancelAnimation(breathe);
    };
  }, [breathe, markOpacity, markScale, rings, tagline, wordmark]);

  // Exit only once the animation has played and the app behind is ready.
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setTimeout(() => {
      cancelAnimation(breathe);
      exit.value = withSequence(
        withTiming(0.06, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 440, easing: Easing.in(Easing.quad) }, (finished) => {
          if (finished) {
            runOnJS(onFinished)();
          }
        })
      );
    }, RUNTIME);
    return () => clearTimeout(timer);
  }, [breathe, exit, onFinished, ready]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: 1 - exit.value,
    // A slight push-in on exit hands over to the app rather than just vanishing.
    transform: [{ scale: interpolate(exit.value, [0, 1], [1, 1.08]) }],
  }));

  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [{ scale: markScale.value }],
  }));

  const ring0 = useAnimatedStyle(() => ringFrame(rings.value, breathe.value, 0));
  const ring1 = useAnimatedStyle(() => ringFrame(rings.value, breathe.value, 1));
  const ring2 = useAnimatedStyle(() => ringFrame(rings.value, breathe.value, 2));

  const letter0 = useAnimatedStyle(() => letterFrame(wordmark.value, 0));
  const letter1 = useAnimatedStyle(() => letterFrame(wordmark.value, 1));
  const letter2 = useAnimatedStyle(() => letterFrame(wordmark.value, 2));
  const letter3 = useAnimatedStyle(() => letterFrame(wordmark.value, 3));
  const letter4 = useAnimatedStyle(() => letterFrame(wordmark.value, 4));
  const letterStyles = [letter0, letter1, letter2, letter3, letter4];

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: tagline.value,
    transform: [{ translateY: interpolate(tagline.value, [0, 1], [10, 0]) }],
  }));

  const underlineStyle = useAnimatedStyle(() => ({
    opacity: tagline.value,
    transform: [{ scaleX: tagline.value }],
  }));

  const ringStyles = [ring0, ring1, ring2];

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.root, containerStyle]}
    >
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
        <Animated.Image
          source={MARK}
          style={[{ height: markSize, width: markSize }, markStyle]}
          resizeMode="contain"
        />
      </View>

      <View style={styles.wordmarkRow}>
        {WORDMARK.map((letter, index) => (
          <Animated.Text key={letter} style={[styles.letter, letterStyles[index]]}>
            {letter}
          </Animated.Text>
        ))}
      </View>

      <Animated.View style={[styles.underline, { width: Math.round(width * 0.25) }, underlineStyle]} />
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
  const base = [0.22, 0.15, 0.1][index];
  const start = index * 0.14;
  const appeared = interpolate(entrance, [start, start + 0.6], [0, 1], 'clamp');
  return {
    opacity: appeared * (base + breath * 0.05),
    transform: [{ scale: interpolate(appeared, [0, 1], [0.94, 1]) }],
  };
}

/** One frame of a wordmark letter rising into place. */
function letterFrame(clock: number, index: number) {
  'worklet';
  const start = index * 0.11;
  const progress = interpolate(clock, [start, start + 0.45], [0, 1], 'clamp');
  return {
    opacity: progress,
    transform: [
      { translateY: interpolate(progress, [0, 1], [18, 0]) },
      { scale: interpolate(progress, [0, 1], [0.88, 1]) },
    ],
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
    borderColor: GREEN,
    borderWidth: 1,
    position: 'absolute',
  },
  wordmarkRow: {
    flexDirection: 'row',
    marginTop: 34,
  },
  letter: {
    color: '#F4F9FC',
    fontSize: 44,
    fontWeight: '800',
    letterSpacing: 8,
  },
  underline: {
    backgroundColor: CYAN,
    borderRadius: 1,
    height: 2,
    marginTop: 18,
  },
  tagline: {
    color: '#8AA0B0',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 6,
    marginTop: 16,
  },
});
