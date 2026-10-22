/**
 * The one row shape the lists use, the same as WeldFlow's: full-bleed, a
 * leading tile, title and snippets, a value and a badge on the right. No
 * per-row card; rows are separated by a hairline.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { initialsOf } from '@/lib/crm';

export interface RecordRowProps {
  title: string;
  subtitle?: string;
  /** Third line, e.g. an email address or "Due 5 Aug". */
  meta?: string;
  metaColor?: string;
  amount?: string;
  amountColor?: string;
  /** Status pill or any right-aligned node under the amount. */
  badge?: React.ReactNode;
  /** Node on the far left, e.g. an InitialsTile. */
  leading?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
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
  testID,
}: Readonly<RecordRowProps>) {
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
          <Text style={[styles.meta, { color: metaColor ?? colors.mutedForeground }]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {amount || badge ? (
        <View style={styles.side}>
          {amount ? (
            <Text style={[styles.amount, { color: amountColor ?? colors.text }]} numberOfLines={1}>
              {amount}
            </Text>
          ) : null}
          {badge ? <View style={styles.badge}>{badge}</View> : null}
        </View>
      ) : null}
    </View>
  );

  if (!onPress && !onLongPress) return content;

  return (
    <Pressable
      testID={testID}
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

/** Rounded tile with initials: square for a company, round for a person. */
export function InitialsTile({ name, round = false, size = 38 }: Readonly<{ name: string; round?: boolean; size?: number }>) {
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: round ? size / 2 : size / 3.2 },
      ]}
    >
      <Text style={[styles.tileText, { fontSize: size * 0.34 }]}>{initialsOf(name)}</Text>
    </View>
  );
}

/** A small coloured pill, e.g. a status. */
export function Pill({ label, color }: Readonly<{ label: string; color: string }>) {
  return (
    <View style={[styles.pill, { backgroundColor: `${color}1F` }]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
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
  tile: { backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center' },
  tileText: { fontWeight: '600', color: '#7C3AED' },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  pillText: { fontSize: 11, fontWeight: '600' },
});
