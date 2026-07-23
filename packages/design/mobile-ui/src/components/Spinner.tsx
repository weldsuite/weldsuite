import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';

export interface SpinnerProps {
  size?: 'small' | 'large' | number;
  color?: string;
  label?: string;
  fullscreen?: boolean;
}

export function Spinner({ size = 'small', color, label, fullscreen = false }: SpinnerProps) {
  const { colors } = useTheme();
  const resolvedColor = color ?? colors.primary;

  const inner = (
    <View style={styles.inner}>
      <ActivityIndicator size={size} color={resolvedColor} />
      {label ? (
        <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      ) : null}
    </View>
  );

  if (fullscreen) {
    return (
      <View style={[styles.fullscreen, { backgroundColor: colors.background }]}>
        {inner}
      </View>
    );
  }

  return inner;
}

export default Spinner;

const styles = StyleSheet.create({
  inner: {
    alignItems: 'center',
    gap: Spacing.sm,
  },
  fullscreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 13,
  },
});
