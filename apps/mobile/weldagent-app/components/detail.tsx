import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card, CardContent, CardTitle } from '@weldsuite/mobile-ui/components/Card';
import { tint } from '@/lib/brand';

export function SectionCard({
  title,
  action,
  children,
  padded = true,
  style,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card style={[styles.card, style]}>
      {title ? (
        <View style={styles.cardHeader}>
          <CardTitle style={styles.cardTitle}>{title}</CardTitle>
          {action}
        </View>
      ) : null}
      {padded ? <CardContent style={styles.cardContent}>{children}</CardContent> : children}
    </Card>
  );
}

export function DetailRow({
  label,
  value,
  valueColor,
  strong = false,
}: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
  strong?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text
          style={[
            styles.detailValue,
            strong && styles.detailValueStrong,
            { color: valueColor ?? colors.text },
          ]}
        >
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

export function IconTile({
  icon: Icon,
  color,
  size = 38,
}: {
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  size?: number;
}) {
  return (
    <View
      style={[
        styles.iconTile,
        { width: size, height: size, borderRadius: size / 3.2, backgroundColor: tint(color) },
      ]}
    >
      <Icon size={size * 0.5} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginTop: 8 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardContent: { padding: 16, gap: 2 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: 16,
  },
  detailLabel: { fontSize: 14, flexShrink: 0 },
  detailValue: { fontSize: 14, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  detailValueStrong: { fontWeight: '700' },
  iconTile: { alignItems: 'center', justifyContent: 'center' },
});
