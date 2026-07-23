import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  leftIcon?: React.ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Chip({
  label,
  selected = false,
  onPress,
  onRemove,
  leftIcon,
  disabled = false,
  style,
}: ChipProps) {
  const { colors } = useTheme();

  const backgroundColor = selected ? colors.primary : colors.secondary;
  const textColor = selected ? colors.primaryForeground : colors.text;
  const removeIconColor = selected ? colors.primaryForeground : colors.mutedForeground;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || (!onPress && !onRemove)}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {leftIcon && <View style={styles.leftIcon}>{leftIcon}</View>}
      <Text style={[styles.label, { color: textColor }]} numberOfLines={1}>
        {label}
      </Text>
      {onRemove && (
        <Pressable
          onPress={onRemove}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          hitSlop={8}
          style={({ pressed }) => [styles.removeButton, { opacity: pressed ? 0.7 : 1 }]}
        >
          <X size={14} color={removeIconColor} />
        </Pressable>
      )}
    </Pressable>
  );
}

export default Chip;

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    height: 32,
    paddingHorizontal: Spacing.md,
    borderRadius: Radii.full,
    gap: Spacing.xs,
  },
  leftIcon: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
  removeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
