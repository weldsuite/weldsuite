/**
 * The one row shape every WeldBooks list uses.
 *
 * Full-bleed, like a messaging inbox: leading tile, title + snippet, amount
 * and status on the right. No per-row card — the floating tab bar is the
 * chrome, not a stack of bordered tiles.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

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
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
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
    </View>
  );

  if (!onPress && !onLongPress) return content;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, amount].filter(Boolean).join(', ')}
      style={({ pressed }) => (pressed ? { backgroundColor: colors.pressed } : undefined)}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  leading: { flexShrink: 0 },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  subtitle: { fontSize: 13, marginTop: 2 },
  meta: { fontSize: 12, marginTop: 2 },
  side: { alignItems: 'flex-end', flexShrink: 0, gap: 4 },
  amount: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  badge: { marginTop: 2 },
});
