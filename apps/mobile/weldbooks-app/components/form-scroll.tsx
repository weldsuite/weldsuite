/**
 * Scroll container for the full-screen forms (new invoice, new bill, quick
 * expense, new contact).
 *
 * On Android 15 the window is edge-to-edge and `adjustResize` does nothing, and a
 * `KeyboardAvoidingView` only acts on iOS, so an open keyboard used to cover the
 * last fields and the submit button with no way to scroll them into view.
 * `KeyboardAwareScrollView` (react-native-keyboard-controller, mounted once by the
 * `KeyboardProvider` in app/_layout.tsx) grows the scrollable area by the keyboard's
 * height and scrolls the focused field into view, on both platforms.
 */

import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

/** Space kept between the focused field and the top of the keyboard. */
const KEYBOARD_GAP = 24;

export function FormScrollView({
  children,
  contentContainerStyle,
}: Readonly<{
  children: React.ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
}>) {
  return (
    <KeyboardAwareScrollView
      style={styles.flex}
      keyboardShouldPersistTaps="handled"
      bottomOffset={KEYBOARD_GAP}
      contentContainerStyle={contentContainerStyle}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
