import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Check } from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  size?: number;
}

export function Checkbox({ checked, onChange, disabled, label, size = 22 }: CheckboxProps) {
  const { colors } = useTheme();

  const box = (
    <View
      style={[
        styles.box,
        {
          width: size,
          height: size,
          backgroundColor: checked ? colors.primary : 'transparent',
          borderColor: checked ? colors.primary : colors.border,
        },
      ]}
    >
      {checked && <Check size={size * 0.7} color={colors.primaryForeground} />}
    </View>
  );

  if (!label) {
    return (
      <Pressable
        onPress={() => !disabled && onChange(!checked)}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled }}
        style={disabled ? styles.disabled : undefined}
      >
        {box}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => !disabled && onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      style={[styles.row, disabled && styles.disabled]}
    >
      {box}
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export default Checkbox;

const styles = StyleSheet.create({
  box: {
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  label: { fontSize: 15 },
  disabled: { opacity: 0.5 },
});
