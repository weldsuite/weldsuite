import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';

export interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
  onPress?: () => void;
}

export function KpiCard({ label, value, sub, warn, onPress }: KpiCardProps) {
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
      {sub ? (
        <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {body}
    </Pressable>
  );
}

export function KpiGrid({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      style={styles.stripWrap}
    >
      {children}
    </ScrollView>
  );
}

export function KpiSkeletonGrid({ count = 4 }: { count?: number }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      style={styles.stripWrap}
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.chip, { backgroundColor: colors.secondary }]}>
          <Skeleton width="60%" height={11} />
          <Skeleton width="80%" height={20} style={styles.skeletonValue} />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  stripWrap: { flexGrow: 0 },
  strip: { paddingHorizontal: 16, gap: 8 },
  chip: {
    width: 148,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    minHeight: 78,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  label: { fontSize: 12, fontWeight: '500' },
  value: { fontSize: 20, fontWeight: '700', marginTop: 4, letterSpacing: -0.4 },
  sub: { fontSize: 11, marginTop: 2 },
  skeletonValue: { marginTop: 8 },
});
