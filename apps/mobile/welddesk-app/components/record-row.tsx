/**
 * Full-bleed list row — same shape as WeldBooks inbox-style lists.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

export interface RecordRowProps {
  title: string;
  subtitle?: string;
  meta?: string;
  metaColor?: string;
  trailing?: string;
  badge?: React.ReactNode;
  leading?: React.ReactNode;
  unread?: boolean;
  onPress?: () => void;
}

export function RecordRow({
  title,
  subtitle,
  meta,
  metaColor,
  trailing,
  badge,
  leading,
  unread,
  onPress,
}: RecordRowProps) {
  const { colors } = useTheme();

  const content = (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.main}>
        <Text
          style={[
            styles.title,
            { color: colors.text },
            unread && styles.titleUnread,
          ]}
          numberOfLines={1}
        >
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
        {trailing ? (
          <Text style={[styles.trailing, { color: colors.mutedForeground }]} numberOfLines={1}>
            {trailing}
          </Text>
        ) : null}
        {badge ? <View style={styles.badge}>{badge}</View> : null}
        {unread ? <View style={[styles.dot, { backgroundColor: colors.text }]} /> : null}
      </View>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, trailing].filter(Boolean).join(', ')}
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
  title: { fontSize: 16, fontWeight: '500', letterSpacing: -0.2 },
  titleUnread: { fontWeight: '700' },
  subtitle: { fontSize: 13, marginTop: 2 },
  meta: { fontSize: 12, marginTop: 2 },
  side: { alignItems: 'flex-end', flexShrink: 0, gap: 4 },
  trailing: { fontSize: 12 },
  badge: { marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
});
