/**
 * Detail-screen building blocks: labelled rows, totals ledgers and the tinted
 * icon tiles used on menu lists. Shared so invoice, bill, contact, bank and VAT
 * details all present their fields identically.
 */

import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card, CardContent, CardTitle } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { tint } from '@/lib/brand';

/** A titled card. `padded={false}` for cards that hold their own list rows. */
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

/** Label on the left, value on the right. */
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

/**
 * Subtotal / tax / total ledger. The final row is separated and emphasised the
 * same way the platform's invoice view does it.
 */
export function TotalsBlock({
  rows,
  total,
}: {
  rows: { label: string; value: string }[];
  total: { label: string; value: string };
}) {
  const { colors } = useTheme();
  return (
    <View>
      {rows.map((row) => (
        <DetailRow key={row.label} label={row.label} value={row.value} />
      ))}
      <Divider style={styles.totalsDivider} />
      <View style={styles.detailRow}>
        <Text style={[styles.totalLabel, { color: colors.text }]}>{total.label}</Text>
        <Text style={[styles.totalValue, { color: colors.text }]}>{total.value}</Text>
      </View>
    </View>
  );
}

/** Rounded tinted square holding a lucide icon — the platform's menu-row motif. */
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
  totalsDivider: { marginVertical: 8 },
  totalLabel: { fontSize: 15, fontWeight: '700' },
  totalValue: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  iconTile: { alignItems: 'center', justifyContent: 'center' },
});
