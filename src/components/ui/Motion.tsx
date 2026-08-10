import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, TextInput, View, type PressableProps, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';

/**
 * Shared motion primitives for the Glivt UI.
 *
 * One place for the app's animation grammar so screens stay declarative and
 * every transition uses the same timing/easing. All effects honour the OS
 * "reduce motion" setting (via reanimated's `ReduceMotion.System`) so the app
 * degrades to instant, non-animated states for users who ask for it.
 */

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

/**
 * Staggered entrance for lists/grids — call with the item's index. The stagger
 * delay is clamped so long/recycled lists (FlatList) never accrue multi-second
 * delays: rows past the first screenful just fade in with the max offset.
 */
export function enterUp(index = 0, distance = 14): EntryExitAnimationFunction {
  const step = Math.min(index, 8);
  return FadeInDown.springify()
    .damping(18)
    .stiffness(160)
    .delay(60 + step * 55)
    .withInitialValues({ opacity: 0, transform: [{ translateY: distance }] })
    .reduceMotion(ReduceMotion.System) as unknown as EntryExitAnimationFunction;
}

type AnimatedCountProps = {
  value: number;
  /** Decimal places to render. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  style?: TextStyle | TextStyle[];
};

/**
 * Count-up number that tweens on the UI thread with zero React re-renders — the
 * value is written straight into a (non-editable) TextInput via animated props,
 * the standard reanimated technique for animating text cheaply.
 */
export function AnimatedCount({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  duration = 900,
  style,
}: AnimatedCountProps) {
  const progress = useSharedValue(value);

  React.useEffect(() => {
    progress.value = withTiming(value, {
      duration,
      reduceMotion: ReduceMotion.System,
    });
  }, [value, duration, progress]);

  const display = useDerivedValue(() => {
    const n = progress.value;
    const fixed = decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
    return `${prefix}${fixed}${suffix}`;
  });

  // `text` is a valid TextInput native prop but absent from the public typings;
  // this is the documented reanimated pattern for animating text content.
  const animatedProps = useAnimatedProps(
    () => ({ text: display.value } as object)
  ) as Partial<React.ComponentProps<typeof AnimatedTextInput>>;

  const initial = `${prefix}${decimals > 0 ? value.toFixed(decimals) : Math.round(value)}${suffix}`;

  return (
    <AnimatedTextInput
      editable={false}
      value={undefined}
      defaultValue={initial}
      style={[styles.reset, style]}
      animatedProps={animatedProps}
      accessibilityRole="text"
      accessibilityLabel={initial}
      pointerEvents="none"
    />
  );
}

const styles = StyleSheet.create({
  reset: { padding: 0 },
});

/**
 * A small "live" indicator: a solid dot with an expanding, fading halo that
 * loops forever. Signals that a surface reflects real-time / AI-active data.
 */
export function PulseDot({ color, size = 8 }: { color: string; size?: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 1800, easing: Easing.out(Easing.ease), reduceMotion: ReduceMotion.System }),
      -1,
      false
    );
  }, [progress]);

  const halo = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - progress.value),
    transform: [{ scale: 0.8 + progress.value * 1.9 }],
  }));

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: size, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: color },
          halo,
        ]}
      />
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}

type PressableScaleProps = PressableProps & {
  /** Scale at the pressed-in state. */
  activeScale?: number;
  /** Fire a light haptic tick on press-in (native only). */
  haptic?: boolean;
  children?: React.ReactNode;
};

/**
 * Pressable that springs down on press. Replaces ad-hoc `opacity` press states
 * with a consistent, physical feel and optional haptic tick.
 */
export function PressableScale({
  activeScale = 0.96,
  haptic = false,
  onPressIn,
  onPressOut,
  style,
  children,
  ...rest
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const springIn = useMemo(
    () => ({ damping: 15, stiffness: 320, reduceMotion: ReduceMotion.System }),
    []
  );

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPressIn={(e) => {
          scale.value = withSpring(activeScale, springIn);
          if (haptic) Haptics.selectionAsync().catch(() => undefined);
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          scale.value = withSpring(1, springIn);
          onPressOut?.(e);
        }}
        style={style}
        {...rest}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
