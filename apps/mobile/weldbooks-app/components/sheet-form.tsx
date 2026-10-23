/**
 * Body for a form that lives in a `Sheet`.
 *
 * The shared `Sheet` is a bottom-anchored modal whose content scrolls on its own, so
 * the form must NOT wrap itself in a `flex: 1` view or a second ScrollView: on Android
 * that collapses the content to nothing and the sheet opens empty (TASK-1164). The
 * form just lays its fields out and lets the sheet size to them.
 *
 * Nothing resizes a modal for the keyboard (not on iOS, and not on Android 15's
 * edge-to-edge window), so `SheetForm` ends in a spacer as tall as the keyboard:
 * with it open the sheet can scroll its last field and the submit button above the
 * keys.
 */

import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/** The height of the keyboard while it is open, 0 otherwise. */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (event) =>
      setHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}

export function SheetForm({
  children,
  style,
}: Readonly<{ children: React.ReactNode; style?: StyleProp<ViewStyle> }>) {
  const keyboardHeight = useKeyboardHeight();
  return (
    <View style={[styles.form, style]}>
      {children}
      <View style={{ height: keyboardHeight }} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16, paddingBottom: 16 },
});
