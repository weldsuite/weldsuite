/**
 * Compact KPI tiles for the dashboard.
 *
 * A 2×2 grid of equal tiles, so every figure is visible at once on a phone
 * instead of hiding the last ones behind a sideways scroll.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';

export interface KpiCardProps {
  label: string;
  value: string;
  /** Secondary line, e.g. "4 projects". */
  sub?: string;
  /** Renders the value in the destructive colour — used for overdue tasks. */
  warn?: boolean;
  onPress?: () => void;
}

export function KpiCard({ label, value, sub, warn, onPress }: Readonly<KpiCardProps>) {
  const { colors } = useTheme();

  const body = (
    <View style={[styles.chip, { backgroundColor: colors.secondary }]}>
      <Text style={[styles.label, { color: colors.mutedForeground }]} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[styles.value, { color: warn ? colors.destructive : colors.text }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {value}
      </Text>
      {/* Always rendered so tiles without a subtitle keep the same height. */}
      <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
        {sub ?? ' '}
      </Text>
    </View>
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

/** 2×2 grid of KPI tiles. */
export function KpiGrid({ children }: Readonly<{ children: React.ReactNode }>) {
  return <View style={styles.grid}>{children}</View>;
}

export function KpiSkeletonGrid({ count = 4 }: Readonly<{ count?: number }>) {
  const { colors } = useTheme();
  return (
    <View style={styles.grid}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.cell}>
          <View style={[styles.chip, { backgroundColor: colors.secondary }]}>
            <Skeleton width="60%" height={11} />
            <Skeleton width="40%" height={20} style={styles.skeletonValue} />
            <Skeleton width="50%" height={10} style={styles.skeletonSub} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 8,
  },
  cell: { flexBasis: '45%', flexGrow: 1 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
  },
  pressed: { opacity: 0.75 },
  label: { fontSize: 12, fontWeight: '500' },
  value: { fontSize: 20, fontWeight: '700', marginTop: 4, letterSpacing: -0.4 },
  sub: { fontSize: 11, marginTop: 2 },
  skeletonValue: { marginTop: 8 },
  skeletonSub: { marginTop: 6 },
});
