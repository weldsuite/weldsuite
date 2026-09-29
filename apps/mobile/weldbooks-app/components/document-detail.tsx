/**
 * Building blocks shared by the invoice and bill detail screens: the summary
 * card, the line-item list, the totals ledger and the mutation runner. The two
 * screens present the same document shape, only their i18n namespaces differ,
 * so labels are passed in as props.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { toNumber } from '@/lib/currency';
import { daysUntil } from '@/lib/date';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { SectionCard, TotalsBlock } from '@/components/detail';

type PluralForms = { one: string; other: string };

/** The money and due-date fields both invoices and bills carry. */
export interface DocumentAmounts {
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid?: string;
  balanceDue: string;
  dueDate: string;
}

export interface DocumentLineItem {
  id?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** The currency a document is denominated in (EUR when unset). */
export function documentCurrency(doc: { currency?: string }): string {
  return doc.currency || 'EUR';
}

function DueHint({
  due,
  labels,
}: Readonly<{
  due: number;
  labels: { overdueBy: PluralForms; dueToday: string; dueIn: PluralForms };
}>) {
  const { colors } = useTheme();
  const { plural } = useI18n();

  let text: string;
  if (due < 0) text = plural(Math.abs(due), labels.overdueBy);
  else if (due === 0) text = labels.dueToday;
  else text = plural(due, labels.dueIn);

  return (
    <Text style={[styles.dueHint, { color: due < 0 ? colors.destructive : colors.mutedForeground }]}>
      {text}
    </Text>
  );
}

export function DocumentSummaryCard({
  doc,
  badge,
  labels,
}: Readonly<{
  doc: DocumentAmounts;
  badge: React.ReactNode;
  labels: {
    balanceDue: string;
    total: string;
    overdueBy: PluralForms;
    dueToday: string;
    dueIn: PluralForms;
  };
}>) {
  const { colors } = useTheme();
  const { formatCurrency } = useLocaleFormatters();
  const balanceDue = toNumber(doc.balanceDue);
  const due = daysUntil(doc.dueDate);
  const hasBalance = balanceDue > 0;

  return (
    <SectionCard>
      <View style={styles.summary}>
        <View>
          <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
            {hasBalance ? labels.balanceDue : labels.total}
          </Text>
          <Text style={[styles.summaryValue, { color: colors.text }]}>
            {formatCurrency(hasBalance ? balanceDue : doc.total, documentCurrency(doc))}
          </Text>
        </View>
        {badge}
      </View>
      {hasBalance && due !== null ? <DueHint due={due} labels={labels} /> : null}
    </SectionCard>
  );
}

function LineItemRow({
  item,
  index,
  currency,
  vatRateLabel,
}: Readonly<{
  item: DocumentLineItem;
  index: number;
  currency: string;
  vatRateLabel: string;
}>) {
  const { colors } = useTheme();
  const { format } = useI18n();
  const { formatCurrency } = useLocaleFormatters();
  const taxRate = toNumber(item.taxRate);
  const vatSuffix = taxRate > 0 ? `  ·  ${format(vatRateLabel, { rate: taxRate })}` : '';

  return (
    <View>
      {index > 0 ? <Divider style={styles.itemDivider} /> : null}
      <Text style={[styles.itemDescription, { color: colors.text }]}>{item.description}</Text>
      <View style={styles.itemMeta}>
        <Text style={[styles.itemQty, { color: colors.mutedForeground }]}>
          {toNumber(item.quantity)} × {formatCurrency(item.unitPrice, currency)}
          {vatSuffix}
        </Text>
        <Text style={[styles.itemTotal, { color: colors.text }]}>
          {formatCurrency(item.lineTotal, currency)}
        </Text>
      </View>
    </View>
  );
}

export function DocumentLineItems({
  items,
  currency,
  title,
  vatRateLabel,
}: Readonly<{
  items: DocumentLineItem[] | undefined;
  currency: string;
  title: string;
  vatRateLabel: string;
}>) {
  if (!items?.length) return null;
  return (
    <SectionCard title={title}>
      {items.map((item, index) => (
        <LineItemRow
          key={item.id ?? index}
          item={item}
          index={index}
          currency={currency}
          vatRateLabel={vatRateLabel}
        />
      ))}
    </SectionCard>
  );
}

export function DocumentTotalsCard({
  doc,
  labels,
}: Readonly<{
  doc: DocumentAmounts;
  labels: { totals: string; subtotal: string; vat: string; paid: string; balanceDue: string; total: string };
}>) {
  const { formatCurrency } = useLocaleFormatters();
  const currency = documentCurrency(doc);
  const balanceDue = toNumber(doc.balanceDue);
  const amountPaid = toNumber(doc.amountPaid);
  const partiallyPaid = balanceDue > 0 && amountPaid > 0;

  return (
    <SectionCard title={labels.totals}>
      <TotalsBlock
        rows={[
          { label: labels.subtotal, value: formatCurrency(doc.subtotal, currency) },
          { label: labels.vat, value: formatCurrency(doc.taxTotal, currency) },
          ...(amountPaid > 0
            ? [{ label: labels.paid, value: `−${formatCurrency(amountPaid, currency)}` }]
            : []),
        ]}
        total={{
          label: partiallyPaid ? labels.balanceDue : labels.total,
          value: formatCurrency(partiallyPaid ? balanceDue : doc.total, currency),
        }}
      />
    </SectionCard>
  );
}

/**
 * Mutation runner for a detail screen. `run` executes an action, then reloads
 * so derived fields (balance, status) are current; `remove` deletes the
 * document and leaves the screen.
 */
export function useDocumentMutations(load: () => Promise<void>) {
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await action();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success(successMessage);
        await load();
      } catch (err) {
        toast.error(errorMessage(err, t.common.actionFailed));
      } finally {
        setBusy(false);
      }
    },
    [load, toast, t],
  );

  const remove = useCallback(
    async (action: () => Promise<unknown>, successMessage: string, failMessage: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(successMessage);
        router.back();
      } catch (err) {
        toast.error(errorMessage(err, failMessage));
      } finally {
        setBusy(false);
      }
    },
    [toast, router],
  );

  return { busy, run, remove };
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  summaryLabel: { fontSize: 13, fontWeight: '500' },
  summaryValue: { fontSize: 30, fontWeight: '700', marginTop: 2, letterSpacing: -0.8 },
  dueHint: { fontSize: 13, marginTop: 8 },
  itemDivider: { marginVertical: 12 },
  itemDescription: { fontSize: 14, fontWeight: '500' },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: 12,
  },
  itemQty: { fontSize: 13, flexShrink: 1 },
  itemTotal: { fontSize: 14, fontWeight: '600' },
});
