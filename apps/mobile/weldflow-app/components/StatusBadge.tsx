import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

const STATUS_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  backlog: { bg: '#E5E7EB', fg: '#374151', label: 'Backlog' },
  todo: { bg: '#DBEAFE', fg: '#1E40AF', label: 'To Do' },
  in_progress: { bg: '#FEF3C7', fg: '#92400E', label: 'In Progress' },
  in_review: { bg: '#E9D5FF', fg: '#6B21A8', label: 'In Review' },
  testing: { bg: '#CFFAFE', fg: '#155E75', label: 'Testing' },
  done: { bg: '#D1FAE5', fg: '#065F46', label: 'Done' },
  cancelled: { bg: '#FEE2E2', fg: '#991B1B', label: 'Cancelled' },
  Planning: { bg: '#DBEAFE', fg: '#1E40AF', label: 'Planning' },
  Active: { bg: '#D1FAE5', fg: '#065F46', label: 'Active' },
  OnHold: { bg: '#FEF3C7', fg: '#92400E', label: 'On hold' },
  Completed: { bg: '#E5E7EB', fg: '#374151', label: 'Completed' },
  Cancelled: { bg: '#FEE2E2', fg: '#991B1B', label: 'Cancelled' },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_COLORS[status] ?? { bg: '#E5E7EB', fg: '#374151', label: status };
  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.text, { color: config.fg }]}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  text: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
});
