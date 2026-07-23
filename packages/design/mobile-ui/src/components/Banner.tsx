import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  X,
} from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export type BannerVariant = 'info' | 'success' | 'warning' | 'error';

export interface BannerProps {
  variant?: BannerVariant;
  title?: string;
  children: React.ReactNode;
  onClose?: () => void;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Appends '1A' (≈10 % opacity) to a 6-digit hex colour string. Falls back
 *  to the supplied fallback when the token is not a plain 6-digit hex. */
function lowOpacityBackground(hex: string, fallback: string): string {
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    return `${hex}1A`;
  }
  return fallback;
}

export function Banner({
  variant = 'info',
  title,
  children,
  onClose,
  icon,
  style,
}: BannerProps) {
  const { colors } = useTheme();

  const accentColor: Record<BannerVariant, string> = {
    info: colors.info,
    success: colors.success,
    warning: colors.warning,
    error: colors.destructive,
  };

  const accent = accentColor[variant];
  const bgColor = lowOpacityBackground(accent, colors.secondary);

  const defaultIcon: Record<BannerVariant, React.ReactNode> = {
    info: <Info size={18} color={accent} />,
    success: <CheckCircle2 size={18} color={accent} />,
    warning: <AlertTriangle size={18} color={accent} />,
    error: <XCircle size={18} color={accent} />,
  };

  const resolvedIcon = icon ?? defaultIcon[variant];

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: bgColor, borderRadius: Radii.md },
        style,
      ]}
    >
      <View style={styles.iconSlot}>{resolvedIcon}</View>
      <View style={styles.body}>
        {title != null && (
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        )}
        <Text style={[styles.message, { color: colors.text }]}>{children}</Text>
      </View>
      {onClose != null && (
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
          style={({ pressed }) => [styles.closeButton, { opacity: pressed ? 0.6 : 1 }]}
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

export default Banner;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  iconSlot: {
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
  },
  closeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
});
