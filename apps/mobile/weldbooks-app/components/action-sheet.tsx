/**
 * A list of actions in a bottom sheet, in the app's own style: the replacement
 * for the plain system `Alert` with a row of buttons (and its "Dismiss").
 *
 * Built on the shared `Sheet`, so it closes on a tap outside, the back button or
 * the close icon, and needs no cancel row. A destructive action is red. Picking a
 * row closes the sheet first and runs the action after it, because the action often
 * opens a confirmation dialog and iOS can't present one while a modal is leaving.
 */

import React from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

export interface ActionSheetOption {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/** How long iOS needs to finish dismissing a modal before another may be presented. */
const IOS_DISMISS_MS = 350;

export function ActionSheet({
  visible,
  onClose,
  title,
  options,
}: Readonly<{
  visible: boolean;
  onClose: () => void;
  title: string;
  options: readonly ActionSheetOption[];
}>) {
  const { colors } = useTheme();

  const pick = (option: ActionSheetOption) => {
    onClose();
    setTimeout(option.onPress, Platform.OS === 'ios' ? IOS_DISMISS_MS : 0);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title} heightRatio={0.45}>
      {options.map((option, index) => (
        <React.Fragment key={option.label}>
          {index > 0 ? <Divider /> : null}
          <Pressable
            onPress={() => pick(option)}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
          >
            <Text
              style={[styles.label, { color: option.destructive ? colors.destructive : colors.text }]}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        </React.Fragment>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  label: { fontSize: 16, fontWeight: '500' },
});
