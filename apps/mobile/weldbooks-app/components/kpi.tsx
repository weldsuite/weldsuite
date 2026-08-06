/**
 * KPI tiles for the dashboard.
 *
 * Deliberately the same set and ordering as the platform's
 * `app/weldbooks/dashboard/components/kpi-cards.tsx`, laid out two-up instead
 * of the web's four-up grid.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';

export interface KpiCardProps {
  label: string;
  value: string;
  /** Secondary line, e.g. "4 invoices". */
  sub?: string;
  /** Renders the value in the destructive colour — used for overdue money. */
  warn?: boolean;
  onPress?: () => void;
}

export function KpiCard({ label, value, sub, warn, onPress }: KpiCardProps) {
  const { colors } = useTheme();

  const body = (
    <Card style={styles.card}>
      <Text style={[styles.label, { color: colors.mutedForeground }]} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[styles.value, { color: warn ? colors.destructive : colors.text }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
      >
        {value}
      </Text>
      {sub ? (
        <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </Card>
  );

  if (!onPress) return <View style={styles.cell}>{body}</View>;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

/** Two-column KPI grid. */
export function KpiGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

export function KpiSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <View style={styles.grid}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.cell}>
          <Card style={styles.card}>
            <Skeleton width="60%" height={12} />
            <Skeleton width="80%" height={24} style={styles.skeletonValue} />
            <Skeleton width="40%" height={10} />
          </Card>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    gap: 8,
  },
  // Two per row, accounting for the 8px gap.
  cell: { width: '48.4%' },
  pressed: { opacity: 0.7 },
  card: { padding: 14, minHeight: 92, justifyContent: 'center' },
  label: { fontSize: 12, fontWeight: '500' },
  value: { fontSize: 22, fontWeight: '700', marginTop: 6, letterSpacing: -0.5 },
  sub: { fontSize: 11, marginTop: 2 },
  skeletonValue: { marginTop: 8, marginBottom: 6 },
});
