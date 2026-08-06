/**
 * The one row shape every WeldBooks list uses.
 *
 * Left: a title and one or two meta lines. Right: an amount and a status pill.
 * Keeping invoices, bills, transactions and contacts on the same row means the
 * lists stay scannable and the density matches the platform's tables.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';

export interface RecordRowProps {
  title: string;
  subtitle?: string;
  /** Third line, e.g. "Due 5 Aug 2026". */
  meta?: string;
  metaColor?: string;
  amount?: string;
  amountColor?: string;
  /** Status pill or any right-aligned node under the amount. */
  badge?: React.ReactNode;
  /** Node on the far left, e.g. an IconTile or Avatar. */
  leading?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
}

export function RecordRow({
  title,
  subtitle,
  meta,
  metaColor,
  amount,
  amountColor,
  badge,
  leading,
  onPress,
  onLongPress,
}: RecordRowProps) {
  const { colors } = useTheme();

  const content = (
    <Card style={styles.card}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.main}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text
            style={[styles.meta, { color: metaColor ?? colors.mutedForeground }]}
            numberOfLines={1}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      <View style={styles.side}>
        {amount ? (
          <Text style={[styles.amount, { color: amountColor ?? colors.text }]} numberOfLines={1}>
            {amount}
          </Text>
        ) : null}
        {badge ? <View style={styles.badge}>{badge}</View> : null}
      </View>
    </Card>
  );

  if (!onPress && !onLongPress) return content;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, amount].filter(Boolean).join(', ')}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  pressed: { opacity: 0.65 },
  leading: { flexShrink: 0 },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  subtitle: { fontSize: 13, marginTop: 2 },
  meta: { fontSize: 12, marginTop: 3 },
  side: { alignItems: 'flex-end', flexShrink: 0, gap: 6 },
  amount: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  badge: {},
});
