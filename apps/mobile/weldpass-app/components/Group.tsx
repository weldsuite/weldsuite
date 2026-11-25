/** Grouped rows, as on iOS settings pages: a heading, a card of rows, a note under it. */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

export function Group({
  title,
  footer,
  children,
}: Readonly<{ title?: string; footer?: string; children: ReactNode }>) {
  const { colors } = useTheme();
  return (
    <View style={styles.group}>
      {title ? <Text style={[styles.heading, { color: colors.mutedForeground }]}>{title}</Text> : null}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>{children}</View>
      {footer ? <Text style={[styles.footer, { color: colors.mutedForeground }]}>{footer}</Text> : null}
    </View>
  );
}

export function GroupRow({
  icon,
  title,
  subtitle,
  value,
  onPress,
  destructive = false,
  chevron,
  testID,
}: Readonly<{
  icon?: ReactNode;
  title: string;
  subtitle?: string | null;
  value?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  /** Defaults to on for rows that open something. */
  chevron?: boolean;
  testID?: string;
}>) {
  const { colors } = useTheme();
  const showChevron = chevron ?? (!!onPress && !destructive);
  const body = (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <View style={styles.text}>
        <Text style={[styles.title, { color: destructive ? colors.destructive : colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {typeof value === 'string' ? (
        <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
          {value}
        </Text>
      ) : (
        value
      )}
      {showChevron ? <ChevronRight size={18} color={colors.mutedForeground} /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={[styles.row, { borderBottomColor: colors.border }]} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: colors.border, backgroundColor: pressed ? colors.pressed : 'transparent' },
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { paddingHorizontal: 16, marginBottom: 24 },
  heading: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 6, marginLeft: 4 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  footer: { fontSize: 13, marginTop: 6, marginHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: { width: 24, alignItems: 'center' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16 },
  subtitle: { fontSize: 13 },
  value: { fontSize: 15, maxWidth: '50%' },
});
