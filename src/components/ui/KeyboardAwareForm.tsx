import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  findNodeHandle,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardHeight } from '@/src/hooks/useKeyboardInset';

/**
 * Shared keyboard-aware scroller for every form, modal and bottom sheet.
 *
 * React Native's own KeyboardAvoidingView is not enough here. The app runs
 * edge-to-edge on targetSdk 36, where Android no longer resizes the window for
 * the IME the way `adjustResize` used to, so the old
 * `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` pattern -- which
 * did nothing at all on Android -- left the focused field, and usually the
 * submit button under it, behind the keyboard.
 *
 * This reserves the real IME height as bottom padding and scrolls the focused
 * input into the space that is left, using the keyboard frame the platform
 * reports rather than anything derived from window metrics.
 *
 * Defaults chosen so callers rarely pass anything:
 *  - the focused field is scrolled clear of the keyboard with room to breathe;
 *  - taps pass through to buttons while the keyboard is up, so a dropdown or
 *    Save can be hit directly instead of needing a dismiss tap first;
 *  - tapping the background dismisses the keyboard;
 *  - the bottom safe-area inset is added to the content, so the last field
 *    clears the gesture bar once the keyboard closes.
 */
export type KeyboardAwareFormProps = {
  children: React.ReactNode;
  /** Gap left between the focused input and the top of the keyboard. */
  extraOffset?: number;
  /**
   * Style for the scroll container itself.
   *
   * Pass a filling style (`flex: 1`) only when the scroller should occupy a
   * bounded parent, such as a full screen. Inside a bottom sheet -- whose height
   * is driven by its content with a maxHeight cap -- `flex: 1` sets
   * `flexBasis: 0`, which collapses the scroller to zero height and renders the
   * sheet empty. Left unset, the scroller sizes to its content and the sheet's
   * cap makes it scrollable, which is what a sheet wants.
   */
  style?: StyleProp<ViewStyle>;
  /** Style applied to the scrolled content. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Set false for screens that manage their own bottom inset. */
  applyBottomInset?: boolean;
  /** Set false when a tap on the background should not dismiss the keyboard. */
  dismissOnTapOutside?: boolean;
  testID?: string;
};

/** Room left between the focused field and the keyboard, in px. */
const FOCUS_GAP = 24;

export function KeyboardAwareForm({
  children,
  extraOffset = FOCUS_GAP,
  style,
  contentContainerStyle,
  applyBottomInset = true,
  dismissOnTapOutside = true,
  testID,
}: KeyboardAwareFormProps) {
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const scrollRef = useRef<ScrollView>(null);

  // The keyboard already covers the gesture bar, so the safe-area inset is only
  // added back once it closes -- adding both leaves dead space under the IME.
  const keyboardPadding =
    keyboardHeight > 0 ? Math.max(0, keyboardHeight - insets.bottom) + extraOffset : 0;

  // Flattened so a caller's own paddingBottom is added to, not replaced by, the
  // insets -- otherwise a sheet's padding would silently disappear.
  const contentStyle = useMemo(() => {
    const flat = StyleSheet.flatten(contentContainerStyle) ?? {};
    const own = typeof flat.paddingBottom === 'number' ? flat.paddingBottom : 0;
    const safeArea = applyBottomInset ? insets.bottom : 0;
    return [flat, { paddingBottom: own + safeArea + keyboardPadding }];
  }, [applyBottomInset, contentContainerStyle, insets.bottom, keyboardPadding]);

  /**
   * Bring a focused field into the space above the keyboard.
   *
   * Deferred a frame because at the moment of focus the keyboard frame is not
   * known yet, so scrolling immediately would aim at the pre-keyboard layout.
   */
  const scrollToInput = useCallback(
    (node: number | null) => {
      if (node == null) return;
      requestAnimationFrame(() => {
        scrollRef.current
          ?.getScrollResponder?.()
          ?.scrollResponderScrollNativeHandleToKeyboard?.(node, extraOffset, true);
      });
    },
    [extraOffset]
  );

  // Fields report focus through context, so moving between them while the
  // keyboard is already open re-scrolls -- the keyboard height has not changed,
  // so nothing else would fire.
  const focusContext = useMemo(() => ({ onInputFocused: scrollToInput }), [scrollToInput]);

  // Opening the keyboard changes how much room is left, so whatever is focused
  // has to be brought back into it.
  useEffect(() => {
    if (keyboardHeight <= 0) return;
    const focused = TextInput.State.currentlyFocusedInput();
    // currentlyFocusedInput() is typed as NativeMethods, which findNodeHandle
    // does not accept in its public signature even though it handles it.
    scrollToInput(focused ? findNodeHandle(focused as never) : null);
  }, [keyboardHeight, scrollToInput]);

  const content = (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      style={style}
      contentContainerStyle={contentStyle}
      // Buttons and dropdown rows stay tappable while the keyboard is open.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );

  const body = dismissOnTapOutside ? (
    <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.flex}>
      {content}
    </Pressable>
  ) : (
    content
  );

  return <KeyboardFocusContext.Provider value={focusContext}>{body}</KeyboardFocusContext.Provider>;
}

type KeyboardFocusValue = { onInputFocused: (node: number | null) => void };

/**
 * Lets an input tell the nearest KeyboardAwareForm that it has been focused.
 *
 * ScrollView has no capture-phase focus prop in React Native, and the keyboard
 * height does not change when focus moves between two fields, so without this
 * the second field tapped would never be scrolled into view.
 */
const KeyboardFocusContext = React.createContext<KeyboardFocusValue | null>(null);

/** Used by TextField; safe to call outside a KeyboardAwareForm, where it no-ops. */
export function useKeyboardFocusReporter() {
  return useContext(KeyboardFocusContext);
}

/**
 * Lifts bottom-anchored content -- a sheet, or a chat composer -- clear of the
 * keyboard.
 *
 * Used where the content is pinned to the bottom of the screen rather than
 * scrolled, which is exactly where the keyboard lands.
 */
export function KeyboardLift({
  children,
  style,
  useSafeArea = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Set false when the child already accounts for the bottom safe area. */
  useSafeArea?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const lift = keyboardHeight > 0 ? Math.max(0, keyboardHeight - (useSafeArea ? insets.bottom : 0)) : 0;

  return <View style={[{ marginBottom: lift }, style]}>{children}</View>;
}

/**
 * A bottom sheet that stays clear of the keyboard.
 *
 * A sheet anchored to the bottom of the screen sits exactly where the keyboard
 * opens, so a scroller inside it cannot help -- the whole sheet is covered.
 * This lifts it by the keyboard height and shrinks its cap by the same amount,
 * so the lifted sheet still fits on screen rather than running off the top.
 *
 * With the keyboard closed the lift is zero and the cap is the ratio it always
 * was, so the resting layout is unchanged.
 */
export function KeyboardBottomSheet({
  children,
  style,
  maxHeightRatio = 0.85,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Fraction of the screen the sheet may occupy, matching its resting cap. */
  maxHeightRatio?: number;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  const lift = keyboardHeight > 0 ? Math.max(0, keyboardHeight - insets.bottom) : 0;

  return (
    <View style={[style, { marginBottom: lift, maxHeight: (height - lift) * maxHeightRatio }]}>
      {children}
    </View>
  );
}

/** Re-exported so callers do not need to reach for the input module directly. */
export const dismissKeyboard = () => {
  TextInput.State.blurTextInput?.(TextInput.State.currentlyFocusedInput());
  Keyboard.dismiss();
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
