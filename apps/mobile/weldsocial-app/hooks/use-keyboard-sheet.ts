import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Space kept between the top of a lifted sheet and the top of the screen. */
const TOP_GAP = 16;
/** Bottom padding of a lifted sheet; the keyboard already covers the home indicator. */
const LIFTED_PADDING_BOTTOM = 16;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.95;

/** Height of the on-screen keyboard, 0 when it is closed. */
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

/**
 * Props for the shared `Sheet` so a form inside it stays reachable while the
 * keyboard is open: the sheet is lifted above the keyboard and capped to the
 * space left over (its own content ScrollView then scrolls).
 *
 * The sheet lives in a native Modal window. With edge-to-edge enabled that
 * window is not resized for the keyboard, and `KeyboardAvoidingView` /
 * `KeyboardAwareScrollView` cannot see keyboard events from inside it, so the
 * plain `Keyboard` events are used here.
 *
 * Usage: `<Sheet {...useKeyboardSheet()} ... />`.
 */
export function useKeyboardSheet(baseRatio = 0.5): { heightRatio: number; style?: ViewStyle } {
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();

  if (keyboardHeight <= 0) return { heightRatio: baseRatio };

  const screenHeight = Dimensions.get('window').height;
  const available = screenHeight - keyboardHeight - insets.top - TOP_GAP;
  return {
    heightRatio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, available / screenHeight)),
    style: { marginBottom: keyboardHeight, paddingBottom: LIFTED_PADDING_BOTTOM },
  };
}
