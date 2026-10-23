import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Gap kept between the focused field (or the form's submit button) and the
 * top of the keyboard when `KeyboardAwareScrollView` scrolls it into view.
 */
export const KEYBOARD_BOTTOM_OFFSET = 56;

/**
 * Height of the on-screen keyboard, 0 when it is closed.
 *
 * Used by sheets that live in a native `Modal`: with Android 15 edge-to-edge
 * the Modal's window is not resized for the keyboard, and
 * `KeyboardAwareScrollView` / `KeyboardAvoidingView` cannot see keyboard events
 * from inside it, so the plain `Keyboard` events are used there.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // iOS announces the keyboard before it animates in; Android only after.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) => setHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}
