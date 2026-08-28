import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

/**
 * Height of the on-screen keyboard, in px, or 0 when it is closed.
 *
 * Read straight from the IME frame the platform reports rather than inferred
 * from screen metrics. That distinction matters on Android: the app runs
 * edge-to-edge on targetSdk 36, where the window is no longer resized for the
 * keyboard the way `adjustResize` used to guarantee, so anything derived from
 * window height is wrong exactly when it is needed.
 *
 * iOS gets the `will` events so movement starts with the keyboard animation
 * rather than after it; Android only emits `did`, and emits it early enough to
 * look immediate.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      setHeight(event.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  return height;
}

/**
 * How much a bottom-anchored element must lift to clear the keyboard.
 *
 * The safe-area inset is subtracted because the keyboard already covers the
 * gesture bar: adding both would leave a visible gap of dead space under the
 * keyboard.
 */
export function useKeyboardLift(bottomInset: number): number {
  const keyboardHeight = useKeyboardHeight();
  return keyboardHeight > 0 ? Math.max(0, keyboardHeight - bottomInset) : 0;
}
