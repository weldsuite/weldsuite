/**
 * Line-item editor shared by the invoice and bill forms.
 *
 * Amounts are edited as text and only parsed on submit — typing "12." must not
 * be normalised out from under the cursor. `parseAmount` handles both European
 * and US decimal separators, which matters on a Dutch keyboard.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Plus, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { parseAmount } from '@/lib/currency';
import { SectionCard, TotalsBlock } from '@/components/detail';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';

export interface LineItemDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

export function createEmptyLineItem(): LineItemDraft {
  return {
    key: `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: '21',
  };
}

export interface LineItemTotals {
  subtotal: number;
  taxTotal: number;
  total: number;
}

export function calculateTotals(items: LineItemDraft[]): LineItemTotals {
  let subtotal = 0;
  let taxTotal = 0;
  for (const item of items) {
    const lineTotal = parseAmount(item.quantity || '0') * parseAmount(item.unitPrice || '0');
    subtotal += lineTotal;
    taxTotal += lineTotal * (parseAmount(item.taxRate || '0') / 100);
  }
  return { subtotal, taxTotal, total: subtotal + taxTotal };
}

/** Items that have both a description and a non-zero price. */
export function validLineItems(items: LineItemDraft[]): LineItemDraft[] {
  return items.filter(
    (item) => item.description.trim() !== '' && parseAmount(item.unitPrice || '0') > 0,
  );
}

export function LineItemsEditor({
  items,
  onChange,
  currency = 'EUR',
  error,
}: {
  items: LineItemDraft[];
  onChange: (items: LineItemDraft[]) => void;
  currency?: string;
  /** Validation message for the group as a whole, e.g. "add at least one item". */
  error?: string;
}) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { formatCurrency: money } = useLocaleFormatters();
  const totals = calculateTotals(items);

  const update = (key: string, patch: Partial<LineItemDraft>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const remove = (key: string) => onChange(items.filter((item) => item.key !== key));

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
            onPress={() => onChange([...items, createEmptyLineItem()])}
          />
        }
      >
        {items.map((item, index) => {
          const lineTotal =
            parseAmount(item.quantity || '0') * parseAmount(item.unitPrice || '0');
          return (
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
                <Input
                  label={t.lineItems.vatPercent}
                  value={item.taxRate}
                  onChangeText={(text) => update(item.key, { taxRate: text })}
                  keyboardType="decimal-pad"
                  placeholder="21"
                  containerStyle={styles.numberField}
                />
              </View>

              <Text style={[styles.lineTotal, { color: colors.mutedForeground }]}>
                {format(t.lineItems.lineTotal, { amount: money(lineTotal, currency) })}
              </Text>
            </View>
          );
        })}

        {error ? (
          <Text style={[styles.groupError, { color: colors.destructive }]}>{error}</Text>
        ) : null}
      </SectionCard>

      <SectionCard title={t.lineItems.totals}>
        <TotalsBlock
          rows={[
            { label: t.lineItems.subtotal, value: money(totals.subtotal, currency) },
            { label: t.lineItems.vat, value: money(totals.taxTotal, currency) },
          ]}
          total={{ label: t.lineItems.total, value: money(totals.total, currency) }}
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
  lineTotal: { fontSize: 12, marginTop: 8, textAlign: 'right' },
  groupError: { fontSize: 13, marginTop: 12 },
});
