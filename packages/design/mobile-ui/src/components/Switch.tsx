import React from 'react';
import {
  StyleSheet,
  Switch as RNSwitch,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';

export interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function Switch({ value, onValueChange, disabled, label }: SwitchProps) {
  const { colors } = useTheme();

  const control = (
    <RNSwitch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ false: colors.border, true: colors.primary }}
      thumbColor="#FFFFFF"
      ios_backgroundColor={colors.border}
    />
  );

  if (!label) {
    return control;
  }

  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {control}
    </View>
  );
}

export default Switch;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  label: { fontSize: 15, flex: 1 },
  disabled: { opacity: 0.5 },
});
