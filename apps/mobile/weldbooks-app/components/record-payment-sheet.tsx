/**
 * Record-payment sheet, shared by invoice and bill details.
 *
 * The mobile twin of the platform's `record-payment-dialog.tsx`. Defaults to the
 * full open balance but allows a smaller amount so partial payments land as
 * `partially_paid` instead of forcing an all-or-nothing settle — which is what
 * the old "Mark as paid" shortcut did.
 *
 * A US entity picks from check, ACH, wire, cards and cash. A check has a number,
 * and a check or cash payment we receive can wait in Undeposited Funds until it
 * is deposited (the default) or go straight to the bank.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { today } from '@/lib/date';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import {
  defaultPaymentMethod,
  offersDepositChoice,
  paymentExtras,
  paymentMethodsFor,
  takesCheckNumber,
  type DepositTarget,
  type PaymentDirection,
  type PaymentMethodValue,
} from '@/lib/payments';

export interface RecordedPayment {
  amount: number;
  /** `YYYY-MM-DD` */
  date: string;
  paymentMethod: string;
  checkNumber?: string;
  depositTo?: DepositTarget;
}

export interface RecordPaymentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Open balance, used as the default amount and the upper bound. */
  balanceDue: number;
  currency: string;
  /** Money coming in (an invoice) or going out (a bill). */
  direction: PaymentDirection;
  submitting?: boolean;
  onSubmit: (payment: RecordedPayment) => Promise<void>;
}

export function RecordPaymentSheet({
  visible,
  onClose,
  balanceDue,
  currency,
  direction,
  submitting = false,
  onSubmit,
}: Readonly<RecordPaymentSheetProps>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { isUs } = useJurisdiction();
  const {
    formatCurrency: money,
    parseAmount,
    parseDateInput,
    formatDateInput,
    datePlaceholder,
  } = useLocaleFormatters();

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState<string>(defaultPaymentMethod(isUs));
  const [checkNumber, setCheckNumber] = useState('');
  const [depositTo, setDepositTo] = useState<DepositTarget>('undeposited_funds');
  const [error, setError] = useState<string | undefined>();
  const [dateError, setDateError] = useState<string | undefined>();

  const methodLabels: Record<PaymentMethodValue, string> = {
    check: t.payments.check,
    ach: t.payments.ach,
    wire: t.payments.wire,
    credit_card: t.payments.creditCard,
    debit_card: t.payments.debitCard,
    cash: t.payments.cash,
    other: t.payments.other,
    bank_transfer: t.payments.bankTransfer,
    card: t.payments.card,
    direct_debit: t.payments.directDebit,
    manual: t.payments.other,
  };
  const methods = paymentMethodsFor(isUs).map((value) => ({ label: methodLabels[value], value }));

  // Reset to the full balance each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setAmount(balanceDue > 0 ? balanceDue.toFixed(2) : '');
      setDate(formatDateInput(today()));
      setMethod(defaultPaymentMethod(isUs));
      setCheckNumber('');
      setDepositTo('undeposited_funds');
      setError(undefined);
      setDateError(undefined);
    }
  }, [visible, balanceDue, isUs, formatDateInput]);

  const handleSubmit = async () => {
    const value = parseAmount(amount);
    if (!value || value <= 0) {
      setError(t.payments.amountError);
      return;
    }
    if (balanceDue > 0 && value > balanceDue + 0.005) {
      setError(format(t.payments.exceedBalance, { amount: money(balanceDue, currency) }));
      return;
    }
    const isoDate = parseDateInput(date);
    if (!isoDate) {
      setDateError(format(t.payments.dateError, { example: datePlaceholder }));
      return;
    }
    setError(undefined);
    setDateError(undefined);
    await onSubmit({
      amount: value,
      date: isoDate,
      paymentMethod: method,
      ...paymentExtras({ isUs, direction, method, checkNumber, depositTo }),
    });
  };

  const remaining = balanceDue - parseAmount(amount || '0');
  const showDepositChoice = offersDepositChoice(isUs, direction, method);

  return (
    <Sheet visible={visible} onClose={onClose} title={t.payments.title} heightRatio={0.85}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={[styles.balance, { backgroundColor: colors.secondary }]}>
            <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>
              {t.payments.openBalance}
            </Text>
            <Text style={[styles.balanceValue, { color: colors.text }]}>
              {money(balanceDue, currency)}
            </Text>
          </View>

          <Input
            label={t.payments.amount}
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
                ? format(t.payments.remaining, { amount: money(remaining, currency) })
                : undefined
            }
          />

          <Input
            label={t.payments.paymentDate}
            value={date}
            onChangeText={(text) => {
              setDate(text);
              if (dateError) setDateError(undefined);
            }}
            placeholder={isUs ? datePlaceholder : t.payments.datePlaceholder}
            error={dateError}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Select label={t.payments.method} value={method} onValueChange={setMethod} options={methods} />

          {takesCheckNumber(isUs, method) ? (
            <Input
              label={t.payments.checkNumber}
              value={checkNumber}
              onChangeText={setCheckNumber}
              placeholder={t.payments.checkNumberPlaceholder}
              keyboardType="number-pad"
              autoCorrect={false}
            />
          ) : null}

          {showDepositChoice ? (
            <View style={styles.deposit}>
              <Select
                label={t.payments.depositTo}
                value={depositTo}
                onValueChange={(next) => setDepositTo(next === 'bank' ? 'bank' : 'undeposited_funds')}
                options={[
                  { label: t.payments.undepositedFunds, value: 'undeposited_funds' },
                  { label: t.payments.bankAccount, value: 'bank' },
                ]}
              />
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                {depositTo === 'bank' ? t.payments.bankHint : t.payments.undepositedHint}
              </Text>
            </View>
          ) : null}

          <Button
            title={t.payments.title}
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
  deposit: { gap: 6 },
  hint: { fontSize: 12, lineHeight: 17 },
  submit: { marginTop: 4 },
});
