import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii } from '../constants/theme';

export type IconButtonVariant = 'ghost' | 'solid' | 'outline';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** The icon node (e.g. a lucide-react-native icon). */
  icon: React.ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

const DIMENSIONS: Record<IconButtonSize, number> = { sm: 32, md: 40, lg: 48 };

export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  loading = false,
  disabled = false,
  accessibilityLabel,
  style,
  ...rest
}: IconButtonProps) {
  const { colors } = useTheme();
  const dim = DIMENSIONS[size];
  const isDisabled = disabled || loading;

  const backgroundColor =
    variant === 'solid' ? colors.secondary : 'transparent';
  const borderWidth = variant === 'outline' ? StyleSheet.hairlineWidth * 2 : 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          width: dim,
          height: dim,
          borderRadius: Radii.full,
          backgroundColor: pressed && variant === 'ghost' ? colors.pressed : backgroundColor,
          borderColor: colors.border,
          borderWidth,
          opacity: isDisabled ? 0.5 : pressed && variant !== 'ghost' ? 0.85 : 1,
        },
        style,
      ]}
      {...rest}
    >
      {loading ? <ActivityIndicator size="small" color={colors.text} /> : icon}
    </Pressable>
  );
}

export default IconButton;

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
