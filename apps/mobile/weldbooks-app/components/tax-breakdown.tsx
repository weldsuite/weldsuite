/**
 * Sales tax of a US document, as the server calculated it: the total, a
 * collapsible per-jurisdiction breakdown (state, county, city, district), a
 * notice when part of the sale was exempt, and the engine's warnings.
 *
 * Used on the invoice detail (the saved breakdown) and on the invoice form
 * (the preview from `POST /sales-tax/calculate`). The app never calculates any
 * of this itself.
 */

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { toNumber } from '@/lib/currency';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import {
  chargedTaxTotal,
  exemptReasonsOf,
  groupTaxBreakdown,
  hasExemptRows,
  taxWarningText,
  accruedUseTaxTotal,
  type JurisdictionTax,
} from '@/lib/sales-tax';
import { SectionCard } from '@/components/detail';
import type { TaxBreakdownRow } from '@/types/accounting';

/** "resale" / "non_profit" → "Resale" / "Non profit"; the server's reasons are codes or free text. */
function readableReason(reason: string): string {
  const spaced = reason.replaceAll('_', ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function JurisdictionRow({
  group,
  currency,
}: Readonly<{ group: JurisdictionTax; currency: string }>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { formatCurrency } = useLocaleFormatters();

  const level = group.level ? t.salesTax.levels[group.level] : null;
  const detail =
    group.rate > 0
      ? format(t.salesTax.rateOn, {
          rate: group.rate,
          amount: formatCurrency(group.taxableAmount, currency),
        })
      : null;

  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={2}>
          {group.name}
        </Text>
        {level || detail ? (
          <Text style={[styles.rowDetail, { color: colors.mutedForeground }]}>
            {[level, detail].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.rowAmount, { color: colors.text }]}>
        {formatCurrency(group.taxAmount, currency)}
      </Text>
    </View>
  );
}

export function TaxBreakdownCard({
  rows,
  warnings,
  currency,
  title,
  initiallyExpanded = false,
  footnote,
}: Readonly<{
  rows: readonly TaxBreakdownRow[] | null | undefined;
  warnings?: readonly string[] | null;
  currency: string;
  /** Defaults to "Sales tax". */
  title?: string;
  initiallyExpanded?: boolean;
  /** A line of small print under the breakdown. */
  footnote?: string;
}>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { formatCurrency } = useLocaleFormatters();
  const [expanded, setExpanded] = useState(initiallyExpanded);

  const groups = groupTaxBreakdown(rows);
  const charged = groups.filter((group) => group.kind === 'tax');
  const used = groups.filter((group) => group.kind === 'use');
  const shownWarnings = (warnings ?? []).filter(Boolean);
  const exempt = hasExemptRows(rows);

  if (groups.length === 0 && shownWarnings.length === 0) return null;

  const exemptAmount = (rows ?? []).reduce((sum, row) => sum + toNumber(row.exemptAmount), 0);
  const reasons = exemptReasonsOf(rows).map(readableReason);
  // The headline figure: the tax charged, or on a bill (which charges none) the use tax accrued.
  let headline: number | null = null;
  if (charged.length > 0) headline = chargedTaxTotal(rows);
  else if (used.length > 0) headline = accruedUseTaxTotal(rows);
  const canExpand = charged.length > 0 || used.length > 0;

  return (
    <SectionCard>
      <Pressable
        onPress={canExpand ? () => setExpanded((open) => !open) : undefined}
        disabled={!canExpand}
        accessibilityRole="button"
        accessibilityLabel={expanded ? t.salesTax.hideBreakdown : t.salesTax.showBreakdown}
        accessibilityState={{ expanded }}
        style={styles.header}
      >
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]}>{title ?? t.salesTax.title}</Text>
          {canExpand ? (
            <Text style={[styles.toggle, { color: colors.mutedForeground }]}>
              {expanded ? t.salesTax.hideBreakdown : t.salesTax.showBreakdown}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.total, { color: colors.text }]}>
          {headline === null ? t.common.dash : formatCurrency(headline, currency)}
        </Text>
        {canExpand ? (
          expanded ? (
            <ChevronUp size={18} color={colors.mutedForeground} />
          ) : (
            <ChevronDown size={18} color={colors.mutedForeground} />
          )
        ) : null}
      </Pressable>

      {expanded && canExpand ? (
        <View style={styles.breakdown}>
          <Divider style={styles.divider} />
          {charged.map((group) => (
            <JurisdictionRow key={group.key} group={group} currency={currency} />
          ))}
          {used.length > 0 ? (
            <>
              {charged.length > 0 ? (
                <Text style={[styles.subTitle, { color: colors.mutedForeground }]}>
                  {t.salesTax.useTaxAccrued}
                </Text>
              ) : null}
              {used.map((group) => (
                <JurisdictionRow key={group.key} group={group} currency={currency} />
              ))}
            </>
          ) : null}
        </View>
      ) : null}

      {groups.length === 0 ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>{t.salesTax.noTaxCharged}</Text>
      ) : null}

      {footnote ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>{footnote}</Text>
      ) : null}

      {exempt ? (
        <Banner variant="info" title={t.salesTax.exemptTitle} style={styles.banner}>
          {reasons.length > 0
            ? format(t.salesTax.exemptNotice, {
                amount: formatCurrency(exemptAmount, currency),
                reasons: reasons.join(', '),
              })
            : format(t.salesTax.exemptNoticeNoReason, {
                amount: formatCurrency(exemptAmount, currency),
              })}
        </Banner>
      ) : null}

      {shownWarnings.length > 0 ? (
        <Banner variant="warning" title={t.salesTax.warningsTitle} style={styles.banner}>
          {shownWarnings.map((warning) => taxWarningText(warning, t.salesTax.warnings)).join('\n')}
        </Banner>
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600' },
  toggle: { fontSize: 12, marginTop: 2 },
  total: { fontSize: 16, fontWeight: '700' },
  breakdown: { marginTop: 4 },
  divider: { marginVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6 },
  rowText: { flex: 1 },
  rowName: { fontSize: 14, fontWeight: '500' },
  rowDetail: { fontSize: 12, marginTop: 2 },
  rowAmount: { fontSize: 14, fontWeight: '600' },
  subTitle: { fontSize: 12, fontWeight: '600', marginTop: 10, marginBottom: 2 },
  note: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  banner: { marginTop: 12 },
});
