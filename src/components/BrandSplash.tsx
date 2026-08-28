import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect } from 'react';
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
 * mark on the same brand navy, so the handover is invisible and the motion reads
 * as part of the launch. The sequence is mark, GPS ping, speed streaks, wordmark,
 * tagline -- the order the logo itself is built from.
 */
export function BrandSplash({ onFinished, ready }: Props) {
  const { width } = useWindowDimensions();

  const markScale = useSharedValue(0.72);
  const markOpacity = useSharedValue(0);
  const ping = useSharedValue(0);
  const streak = useSharedValue(0);
  const wordmark = useSharedValue(0);
  const tagline = useSharedValue(0);
  const exit = useSharedValue(0);

  useEffect(() => {
    markOpacity.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.quad) });
    markScale.value = withSpring(1, { damping: 11, stiffness: 120, mass: 0.9 });

    // The ping loops for as long as the splash is up, so a slow cold start still
    // looks alive instead of frozen on a static frame.
    ping.value = withDelay(
      260,
      withRepeat(withTiming(1, { duration: 1700, easing: Easing.out(Easing.quad) }), -1, false)
    );

    streak.value = withDelay(360, withTiming(1, { duration: 640, easing: Easing.out(Easing.cubic) }));
    wordmark.value = withDelay(620, withTiming(1, { duration: 740, easing: Easing.out(Easing.cubic) }));
    tagline.value = withDelay(1100, withTiming(1, { duration: 620, easing: Easing.out(Easing.quad) }));

    return () => {
      cancelAnimation(ping);
    };
  }, [markOpacity, markScale, ping, streak, tagline, wordmark]);

  // Exit only once the animation has played and the app behind is ready.
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setTimeout(() => {
      cancelAnimation(ping);
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
  }, [exit, onFinished, ping, ready]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: 1 - exit.value,
    // A slight push-in on exit hands over to the app rather than just vanishing.
    transform: [{ scale: interpolate(exit.value, [0, 1], [1, 1.08]) }],
  }));

  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [{ scale: markScale.value }],
  }));

  // Three rings on one clock, offset in phase, so they radiate in sequence.
  const ping0 = useAnimatedStyle(() => pingFrame(ping.value, 0));
  const ping1 = useAnimatedStyle(() => pingFrame(ping.value, 0.33));
  const ping2 = useAnimatedStyle(() => pingFrame(ping.value, 0.66));

  const streak0 = useAnimatedStyle(() => streakFrame(streak.value, 0, width));
  const streak1 = useAnimatedStyle(() => streakFrame(streak.value, 1, width));
  const streak2 = useAnimatedStyle(() => streakFrame(streak.value, 2, width));

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

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.root, containerStyle]}
    >
      <LinearGradient colors={[NAVY, NAVY_DEEP]} style={StyleSheet.absoluteFill} />

      <View style={styles.stage}>
        <Animated.View style={[styles.ping, ping0]} />
        <Animated.View style={[styles.ping, ping1]} />
        <Animated.View style={[styles.ping, ping2]} />

        <View style={styles.streaks}>
          <Animated.View style={[styles.streak, styles.streakTop, streak0]} />
          <Animated.View style={[styles.streak, styles.streakMid, streak1]} />
          <Animated.View style={[styles.streak, styles.streakLow, streak2]} />
        </View>

        <Animated.Image source={MARK} style={[styles.mark, markStyle]} resizeMode="contain" />
      </View>

      <View style={styles.wordmarkRow}>
        {WORDMARK.map((letter, index) => (
          <Animated.Text key={letter} style={[styles.letter, letterStyles[index]]}>
            {letter}
          </Animated.Text>
        ))}
      </View>

      <Animated.View style={[styles.underline, underlineStyle]} />
      <Animated.Text style={[styles.tagline, taglineStyle]}>FLEET MANAGEMENT</Animated.Text>
    </Animated.View>
  );
}

/** One frame of a radiating ring, `phase` offsetting it around the shared clock. */
function pingFrame(clock: number, phase: number) {
  'worklet';
  const t = (clock + phase) % 1;
  return {
    opacity: interpolate(t, [0, 0.15, 1], [0, 0.34, 0]),
    transform: [{ scale: interpolate(t, [0, 1], [0.55, 2.1]) }],
  };
}

/** One frame of a motion streak sliding in from off-screen left. */
function streakFrame(clock: number, index: number, width: number) {
  'worklet';
  const start = index * 0.12;
  const progress = interpolate(clock, [start, start + 0.6], [0, 1], 'clamp');
  return {
    opacity: interpolate(progress, [0, 0.4, 1], [0, 0.9, 0.55]),
    transform: [{ translateX: interpolate(progress, [0, 1], [-width * 0.5, 0]) }],
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
      { scale: interpolate(progress, [0, 1], [0.86, 1]) },
    ],
  };
}

const MARK_SIZE = 168;
const PING_SIZE = 210;

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: NAVY,
    justifyContent: 'center',
  },
  stage: {
    alignItems: 'center',
    height: MARK_SIZE,
    justifyContent: 'center',
    width: MARK_SIZE * 1.6,
  },
  mark: {
    height: MARK_SIZE,
    width: MARK_SIZE,
  },
  ping: {
    borderColor: GREEN,
    borderRadius: PING_SIZE / 2,
    borderWidth: 1.5,
    height: PING_SIZE,
    position: 'absolute',
    width: PING_SIZE,
  },
  streaks: {
    left: 0,
    position: 'absolute',
    top: '40%',
  },
  streak: {
    backgroundColor: GREEN,
    borderRadius: 2,
    height: 3.5,
  },
  streakTop: {
    marginBottom: 9,
    width: 54,
  },
  streakMid: {
    marginBottom: 9,
    width: 42,
  },
  streakLow: {
    width: 30,
  },
  wordmarkRow: {
    flexDirection: 'row',
    marginTop: 26,
  },
  letter: {
    color: '#F4F9FC',
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: 5,
  },
  underline: {
    backgroundColor: CYAN,
    borderRadius: 1,
    height: 2,
    marginTop: 14,
    width: 92,
  },
  tagline: {
    color: '#7E97A8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 5.5,
    marginTop: 12,
  },
});
