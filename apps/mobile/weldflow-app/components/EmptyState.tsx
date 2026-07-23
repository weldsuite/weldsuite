import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

interface Props {
  icon?: React.ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {description ? <Text style={[styles.description, { color: colors.muted }]}>{description}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  icon: { marginBottom: 8 },
  title: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  description: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
