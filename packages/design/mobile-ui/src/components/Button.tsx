import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii } from '../constants/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Text label. Ignored if `children` is provided. */
  title?: string;
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

const SIZES: Record<ButtonSize, { height: number; paddingHorizontal: number; fontSize: number; gap: number }> = {
  sm: { height: 36, paddingHorizontal: 12, fontSize: 14, gap: 6 },
  md: { height: 44, paddingHorizontal: 16, fontSize: 15, gap: 8 },
  lg: { height: 52, paddingHorizontal: 20, fontSize: 16, gap: 8 },
};

export function Button({
  title,
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  leftIcon,
  rightIcon,
  style,
  textStyle,
  ...rest
}: ButtonProps) {
  const { colors } = useTheme();
  const sz = SIZES[size];
  const isDisabled = disabled || loading;

  const bg: Record<ButtonVariant, string> = {
    primary: colors.primary,
    secondary: colors.secondary,
    outline: 'transparent',
    ghost: 'transparent',
    destructive: colors.destructive,
  };
  const fg: Record<ButtonVariant, string> = {
    primary: colors.primaryForeground,
    secondary: colors.secondaryForeground,
    outline: colors.text,
    ghost: colors.text,
    destructive: colors.destructiveForeground,
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          height: sz.height,
          paddingHorizontal: sz.paddingHorizontal,
          gap: sz.gap,
          backgroundColor: bg[variant],
          borderColor: variant === 'outline' ? colors.border : 'transparent',
          borderWidth: variant === 'outline' ? StyleSheet.hairlineWidth * 2 : 0,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg[variant]} />
      ) : (
        <View style={[styles.content, { gap: sz.gap }]}>
          {leftIcon}
          {children ?? (
            <Text style={[styles.label, { color: fg[variant], fontSize: sz.fontSize }, textStyle]}>
              {title}
            </Text>
          )}
          {rightIcon}
        </View>
      )}
    </Pressable>
  );
}

export default Button;

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radii.md,
  },
  fullWidth: { alignSelf: 'stretch' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600' },
});
