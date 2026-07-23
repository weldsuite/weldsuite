import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Flag } from 'lucide-react-native';

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#DC2626',
  high: '#F97316',
  medium: '#F59E0B',
  low: '#10B981',
  none: '#9CA3AF',
};

export function PriorityIndicator({ priority, showLabel = false }: { priority: string; showLabel?: boolean }) {
  const color = PRIORITY_COLORS[priority] ?? '#9CA3AF';
  return (
    <View style={styles.container}>
      <Flag size={12} color={color} fill={color} />
      {showLabel && <Text style={[styles.label, { color }]}>{priority}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
});
