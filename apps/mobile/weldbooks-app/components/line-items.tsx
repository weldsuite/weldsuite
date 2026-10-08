/**
 * Line-item editor shared by the invoice and bill forms.
 *
 * The drafts, totals and API payload live in `lib/line-items.ts`; this draws
 * them. How a line is taxed depends on the entity's jurisdiction (`mode`):
 *  - `rate`: VAT / GST, a percentage per line.
 *  - `code`: US invoice, a product tax code per line; the tax itself comes from
 *    the server (`serverTax`) because it depends on the ship-to address.
 *  - `cost`: US bill, the sales tax the vendor charged (part of the cost) and a
 *    switch to accrue use tax where it charged none.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Plus, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { SectionCard, TotalsBlock } from '@/components/detail';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import {
  calculateTotals,
  createEmptyLineItem,
  lineTotal,
  type LineItemDraft,
  type LineItemTaxMode,
} from '@/lib/line-items';
import { WELD_TAX_CODES } from '@/lib/us';

/** The server's calculation of a US invoice's tax, once it has one. */
export interface ServerTaxTotals {
  taxTotal: number;
  total: number;
  loading: boolean;
}

export function LineItemsEditor({
  items,
  onChange,
  mode,
  defaultTaxRate,
  currency,
  error,
  serverTax,
}: Readonly<{
  items: LineItemDraft[];
  onChange: (items: LineItemDraft[]) => void;
  mode: LineItemTaxMode;
  /** The percentage a new VAT / GST line starts with. */
  defaultTaxRate: string;
  /** Defaults to the entity's base currency. */
  currency?: string;
  /** Validation message for the group as a whole, e.g. "add at least one item". */
  error?: string;
  serverTax?: ServerTaxTotals | null;
}>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { formatCurrency: money, currency: entityCurrency } = useLocaleFormatters();
  const { labels } = useJurisdiction();
  const shownCurrency = currency ?? entityCurrency;
  const totals = calculateTotals(items, mode);

  const taxCodeOptions = WELD_TAX_CODES.map((code) => ({ label: t.salesTax.codes[code], value: code }));

  const update = (key: string, patch: Partial<LineItemDraft>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const remove = (key: string) => onChange(items.filter((item) => item.key !== key));

  let taxRow: { label: string; value: string };
  let grandTotal = totals.total;
  if (mode === 'code') {
    const ready = serverTax && !serverTax.loading;
    taxRow = {
      label: labels.tax,
      value: ready ? money(serverTax.taxTotal, shownCurrency) : t.lineItems.taxPending,
    };
    if (ready) grandTotal = serverTax.total;
  } else if (mode === 'cost') {
    taxRow = { label: t.lineItems.taxPaid, value: money(totals.taxTotal, shownCurrency) };
  } else {
    taxRow = { label: labels.tax, value: money(totals.taxTotal, shownCurrency) };
  }

  return (
    <>
      <SectionCard
        title={t.lineItems.title}
        action={
          <Button
            title={t.lineItems.add}
            variant="ghost"
            size="sm"
            leftIcon={<Plus size={16} color={colors.text} />}
            onPress={() => onChange([...items, createEmptyLineItem({ taxRate: defaultTaxRate })])}
          />
        }
      >
        {items.map((item, index) => (
          <View key={item.key}>
            {index > 0 ? <Divider style={styles.divider} /> : null}
            <View style={styles.itemHeader}>
              <Text style={[styles.itemIndex, { color: colors.mutedForeground }]}>
                {format(t.lineItems.item, { index: index + 1 })}
              </Text>
              {items.length > 1 ? (
                <IconButton
                  icon={<Trash2 size={16} color={colors.destructive} />}
                  accessibilityLabel={format(t.lineItems.remove, { index: index + 1 })}
                  size="sm"
                  onPress={() => remove(item.key)}
                />
              ) : null}
            </View>

            <Input
              value={item.description}
              onChangeText={(text) => update(item.key, { description: text })}
              placeholder={t.lineItems.description}
            />

            <View style={styles.numbers}>
              <Input
                label={t.lineItems.qty}
                value={item.quantity}
                onChangeText={(text) => update(item.key, { quantity: text })}
                keyboardType="decimal-pad"
                placeholder="1"
                containerStyle={styles.numberField}
              />
              <Input
                label={t.lineItems.unitPrice}
                value={item.unitPrice}
                onChangeText={(text) => update(item.key, { unitPrice: text })}
                keyboardType="decimal-pad"
                placeholder="0.00"
                containerStyle={styles.numberFieldWide}
              />
              {mode === 'code' ? null : (
                <Input
                  label={mode === 'cost' ? t.lineItems.taxPaidPercent : labels.taxPercent}
                  value={item.taxRate}
                  onChangeText={(text) => update(item.key, { taxRate: text })}
                  keyboardType="decimal-pad"
                  placeholder={defaultTaxRate}
                  containerStyle={styles.numberField}
                />
              )}
            </View>

            {mode === 'code' ? (
              <View style={styles.extra}>
                <Select
                  label={t.salesTax.taxCode}
                  value={item.taxCode}
                  onValueChange={(taxCode) => update(item.key, { taxCode })}
                  options={taxCodeOptions}
                />
              </View>
            ) : null}

            {mode === 'cost' ? (
              <View style={styles.extra}>
                <Switch
                  label={t.lineItems.accrueUseTax}
                  value={item.accrueUseTax}
                  onValueChange={(accrueUseTax) => update(item.key, { accrueUseTax })}
                />
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  {t.lineItems.accrueUseTaxHint}
                </Text>
                {item.accrueUseTax ? (
                  <Select
                    label={t.salesTax.taxCode}
                    value={item.taxCode}
                    onValueChange={(taxCode) => update(item.key, { taxCode })}
                    options={taxCodeOptions}
                  />
                ) : null}
              </View>
            ) : null}

            <Text style={[styles.lineTotal, { color: colors.mutedForeground }]}>
              {format(t.lineItems.lineTotal, { amount: money(lineTotal(item), shownCurrency) })}
            </Text>
          </View>
        ))}

        {error ? (
          <Text style={[styles.groupError, { color: colors.destructive }]}>{error}</Text>
        ) : null}
      </SectionCard>

      <SectionCard title={t.lineItems.totals}>
        <TotalsBlock
          rows={[{ label: t.lineItems.subtotal, value: money(totals.subtotal, shownCurrency) }, taxRow]}
          total={{ label: t.lineItems.total, value: money(grandTotal, shownCurrency) }}
        />
      </SectionCard>
    </>
  );
}

const styles = StyleSheet.create({
  divider: { marginVertical: 16 },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  itemIndex: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },
  numbers: { flexDirection: 'row', gap: 8, marginTop: 12 },
  numberField: { flex: 1 },
  numberFieldWide: { flex: 1.5 },
  extra: { marginTop: 12, gap: 8 },
  hint: { fontSize: 12, lineHeight: 17 },
  lineTotal: { fontSize: 12, marginTop: 8, textAlign: 'right' },
  groupError: { fontSize: 13, marginTop: 12 },
});
