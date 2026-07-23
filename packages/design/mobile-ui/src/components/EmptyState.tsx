import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  style,
}: EmptyStateProps) {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, style]}>
      {icon != null && <View style={styles.iconContainer}>{icon}</View>}
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {description != null && (
        <Text style={[styles.description, { color: colors.mutedForeground }]}>
          {description}
        </Text>
      )}
      {action != null && <View style={styles.action}>{action}</View>}
    </View>
  );
}

export default EmptyState;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: Spacing.sm,
  },
  iconContainer: {
    marginBottom: Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  action: {
    marginTop: Spacing.sm,
  },
});
