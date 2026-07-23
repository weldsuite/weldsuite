import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface RadioOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface RadioProps {
  option: RadioOption;
  selected: boolean;
  onSelect: (value: string) => void;
}

export function Radio({ option, selected, onSelect }: RadioProps) {
  const { colors } = useTheme();
  const isDisabled = option.disabled ?? false;

  return (
    <Pressable
      onPress={() => !isDisabled && onSelect(option.value)}
      disabled={isDisabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: isDisabled }}
      style={[styles.row, isDisabled && styles.disabled]}
    >
      <View
        style={[
          styles.ring,
          {
            borderColor: selected ? colors.primary : colors.border,
          },
        ]}
      >
        {selected && (
          <View style={[styles.dot, { backgroundColor: colors.primary }]} />
        )}
      </View>
      <Text style={[styles.label, { color: colors.text }]}>{option.label}</Text>
    </Pressable>
  );
}

export interface RadioGroupProps {
  value: string;
  onValueChange: (v: string) => void;
  options: RadioOption[];
  style?: StyleProp<ViewStyle>;
}

export function RadioGroup({ value, onValueChange, options, style }: RadioGroupProps) {
  return (
    <View style={[styles.group, style]}>
      {options.map((option) => (
        <Radio
          key={option.value}
          option={option}
          selected={value === option.value}
          onSelect={onValueChange}
        />
      ))}
    </View>
  );
}

export default RadioGroup;

const RING_SIZE = 20;
const DOT_SIZE = 10;

const styles = StyleSheet.create({
  group: { gap: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: Radii.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: Radii.full,
  },
  label: { fontSize: 15 },
  disabled: { opacity: 0.5 },
});
