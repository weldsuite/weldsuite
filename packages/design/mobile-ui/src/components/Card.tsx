import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface CardProps extends ViewProps {
  /** Adds a hairline border around the card. @default true */
  bordered?: boolean;
  /** Adds a subtle drop shadow. @default false */
  elevated?: boolean;
}

export function Card({ bordered = true, elevated = false, style, children, ...rest }: CardProps) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        bordered && { borderWidth: StyleSheet.hairlineWidth },
        elevated && styles.elevated,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export function CardHeader({ style, children, ...rest }: ViewProps) {
  return (
    <View style={[styles.header, style]} {...rest}>
      {children}
    </View>
  );
}

export function CardTitle({ style, children, ...rest }: { style?: StyleProp<TextStyle>; children: React.ReactNode } & Omit<React.ComponentProps<typeof Text>, 'style'>) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.title, { color: colors.text }, style]} {...rest}>
      {children}
    </Text>
  );
}

export function CardDescription({ style, children, ...rest }: { style?: StyleProp<TextStyle>; children: React.ReactNode } & Omit<React.ComponentProps<typeof Text>, 'style'>) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.description, { color: colors.mutedForeground }, style]} {...rest}>
      {children}
    </Text>
  );
}

export function CardContent({ style, children, ...rest }: ViewProps) {
  return (
    <View style={[styles.content, style]} {...rest}>
      {children}
    </View>
  );
}

export function CardFooter({ style, children, ...rest }: ViewProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.footer, { borderTopColor: colors.border }, style as StyleProp<ViewStyle>]} {...rest}>
      {children}
    </View>
  );
}

export default Card;

const styles = StyleSheet.create({
  card: { borderRadius: Radii.lg, overflow: 'hidden' },
  elevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  header: { padding: Spacing.lg, gap: Spacing.xs },
  title: { fontSize: 17, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 20 },
  content: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
});
