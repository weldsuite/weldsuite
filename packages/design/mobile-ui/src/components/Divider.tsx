import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
  inset?: number;
  style?: StyleProp<ViewStyle>;
}

export function Divider({ orientation = 'horizontal', inset = 0, style }: DividerProps) {
  const { colors } = useTheme();

  if (orientation === 'vertical') {
    return (
      <View
        style={[
          styles.vertical,
          { backgroundColor: colors.divider },
          style,
        ]}
      />
    );
  }

  return (
    <View
      style={[
        styles.horizontal,
        {
          backgroundColor: colors.divider,
          marginHorizontal: inset,
        },
        style,
      ]}
    />
  );
}

/** Alias for Divider. */
export const Separator = Divider;

export default Divider;

const styles = StyleSheet.create({
  horizontal: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  vertical: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
});
