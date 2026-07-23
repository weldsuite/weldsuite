import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps {
  children?: React.ReactNode;
  label?: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  style?: StyleProp<ViewStyle>;
}

export function Badge({
  children,
  label,
  variant = 'default',
  size = 'md',
  style,
}: BadgeProps) {
  const { colors } = useTheme();

  const bg: Record<BadgeVariant, string> = {
    default: colors.primary,
    secondary: colors.secondary,
    success: colors.success,
    warning: colors.warning,
    destructive: colors.destructive,
    outline: 'transparent',
  };
  const fg: Record<BadgeVariant, string> = {
    default: colors.primaryForeground,
    secondary: colors.secondaryForeground,
    success: colors.successForeground,
    warning: colors.warningForeground,
    destructive: colors.destructiveForeground,
    outline: colors.text,
  };

  const fontSize = size === 'sm' ? 11 : 12;
  const paddingHorizontal = size === 'sm' ? Spacing.sm : Spacing.md;
  const paddingVertical = size === 'sm' ? 2 : 3;

  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: bg[variant],
          borderColor: variant === 'outline' ? colors.border : 'transparent',
          borderWidth: variant === 'outline' ? StyleSheet.hairlineWidth * 2 : 0,
          paddingHorizontal,
          paddingVertical,
        },
        style,
      ]}
    >
      {children ?? (
        <Text style={[styles.label, { color: fg[variant], fontSize }]}>
          {label}
        </Text>
      )}
    </View>
  );
}

export default Badge;

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radii.full,
  },
  label: {
    fontWeight: '600',
    lineHeight: 16,
  },
});
