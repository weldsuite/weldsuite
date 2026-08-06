/**
 * Record-payment sheet, shared by invoice and bill details.
 *
 * The mobile twin of the platform's `record-payment-dialog.tsx`. Defaults to the
 * full open balance but allows a smaller amount so partial payments land as
 * `partially_paid` instead of forcing an all-or-nothing settle — which is what
 * the old "Mark as paid" shortcut did.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { formatCurrency, parseAmount } from '@/lib/currency';
import { today } from '@/lib/date';

const METHODS = [
  { label: 'Bank transfer', value: 'bank_transfer' },
  { label: 'Card', value: 'card' },
  { label: 'Cash', value: 'cash' },
  { label: 'Direct debit', value: 'direct_debit' },
  { label: 'Other', value: 'manual' },
];

export interface RecordPaymentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Open balance, used as the default amount and the upper bound. */
  balanceDue: number;
  currency: string;
  submitting?: boolean;
  onSubmit: (payment: { amount: number; date: string; paymentMethod: string }) => Promise<void>;
}

export function RecordPaymentSheet({
  visible,
  onClose,
  balanceDue,
  currency,
  submitting = false,
  onSubmit,
}: RecordPaymentSheetProps) {
  const { colors } = useTheme();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('bank_transfer');
  const [error, setError] = useState<string | undefined>();

  // Reset to the full balance each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setAmount(balanceDue > 0 ? balanceDue.toFixed(2) : '');
      setDate(today());
      setError(undefined);
    }
  }, [visible, balanceDue]);

  const handleSubmit = async () => {
    const value = parseAmount(amount);
    if (!value || value <= 0) {
      setError('Enter an amount greater than zero');
      return;
    }
    if (balanceDue > 0 && value > balanceDue + 0.005) {
      setError(`Cannot exceed the open balance of ${formatCurrency(balanceDue, currency)}`);
      return;
    }
    setError(undefined);
    await onSubmit({ amount: value, date, paymentMethod: method });
  };

  const remaining = balanceDue - parseAmount(amount || '0');

  return (
    <Sheet visible={visible} onClose={onClose} title="Record payment" heightRatio={0.7}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={[styles.balance, { backgroundColor: colors.secondary }]}>
            <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>Open balance</Text>
            <Text style={[styles.balanceValue, { color: colors.text }]}>
              {formatCurrency(balanceDue, currency)}
            </Text>
          </View>

          <Input
            label="Amount"
            value={amount}
            onChangeText={(text) => {
              setAmount(text);
              if (error) setError(undefined);
            }}
            keyboardType="decimal-pad"
            placeholder="0.00"
            error={error}
            helperText={
              !error && remaining > 0.005
                ? `${formatCurrency(remaining, currency)} will remain outstanding`
                : undefined
            }
          />

          <Input
            label="Payment date"
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Select label="Method" value={method} onValueChange={setMethod} options={METHODS} />

          <Button
            title="Record payment"
            onPress={handleSubmit}
            loading={submitting}
            fullWidth
            style={styles.submit}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  balance: { borderRadius: 12, padding: 14 },
  balanceLabel: { fontSize: 12, fontWeight: '500' },
  balanceValue: { fontSize: 24, fontWeight: '700', marginTop: 2, letterSpacing: -0.5 },
  submit: { marginTop: 4 },
});
