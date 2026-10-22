/**
 * Quick expense capture — the fastest path from a receipt to a booked cost.
 *
 * Takes what the receipt says was paid (VAT included) and saves it as a bill
 * that is approved and paid straight away (app-api has no separate expense
 * entity; see `createQuickExpense`). When the device is offline the entry goes
 * to the offline queue instead of failing, and syncs when connectivity returns.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  Utensils,
  Car,
  Briefcase,
  Plane,
  Package,
  Zap,
  Shield,
  Tag,
  WifiOff,
} from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';

import { isApiError } from '@weldsuite/api-client/client';

import api, { QuickExpenseNotBookedError, receiptFileName } from '@/services/api';
import { today } from '@/lib/date';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { defaultTaxRateFor } from '@/lib/jurisdiction';
import { paymentMethodsFor, type PaymentMethodValue } from '@/lib/payments';
import {
  prefillTaxRates,
  splitInclusiveTotal,
  totalFromPrefill,
} from '@/lib/quick-expense';
import { accountForCategory, expenseAccounts } from '@/lib/expense-category';
import { describeApiError } from '@/lib/sales-tax';
import { DEFAULT_TAX_CODE, WELD_TAX_CODES } from '@/lib/us';
import { BRAND, tint } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { DateField } from '@/components/date-field';
import { FormScrollView } from '@/components/form-scroll';
import { ReceiptPreview } from '@/components/receipt-preview';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import type { BillPrefill, ExpenseCategory, GlAccount } from '@/types/accounting';

const CATEGORY_KEYS: { key: ExpenseCategory; icon: typeof Utensils }[] = [
  { key: 'food', icon: Utensils },
  { key: 'transport', icon: Car },
  { key: 'office', icon: Briefcase },
  { key: 'travel', icon: Plane },
  { key: 'supplies', icon: Package },
  { key: 'utilities', icon: Zap },
  { key: 'insurance', icon: Shield },
  { key: 'other', icon: Tag },
];

/** How a receipt is usually paid: at the till, by card. */
function defaultExpenseMethod(isUs: boolean): PaymentMethodValue {
  return isUs ? 'debit_card' : 'card';
}

function amountInput(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The rate that carries most of the receipt's net amount: the one to fall back to. */
function mainTaxRate(prefill: BillPrefill): string | null {
  const byRate = new Map<string, number>();
  for (const item of prefill.items) {
    if (!item.taxRate) continue;
    const net = Number(item.quantity || '1') * Number(item.unitPrice || '0');
    byRate.set(item.taxRate, (byRate.get(item.taxRate) ?? 0) + (Number.isFinite(net) ? net : 0));
  }
  let best: string | null = null;
  for (const [rate, net] of byRate) {
    if (best === null || net > (byRate.get(best) ?? 0)) best = rate;
  }
  return best;
}

export default function QuickExpenseScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const amountRef = useRef<TextInput>(null);
  const { isOnline, addToQueue } = useOfflineQueue();
  const params = useLocalSearchParams<{
    amount?: string;
    vendorName?: string;
    documentId?: string;
    /** The photo on this device, shown while the figures are typed from it. */
    receiptUri?: string;
    receiptType?: string;
  }>();
  const { t, format } = useI18n();
  const { isUs, code, labels } = useJurisdiction();
  const { formatCurrency, parseAmount: parseTyped } = useLocaleFormatters();
  const defaultTaxRate = defaultTaxRateFor(code);

  const categoryLabels: Record<ExpenseCategory, string> = {
    food: t.expenseQuick.food,
    transport: t.expenseQuick.transport,
    office: t.expenseQuick.office,
    travel: t.expenseQuick.travel,
    supplies: t.expenseQuick.supplies,
    utilities: t.expenseQuick.utilities,
    insurance: t.expenseQuick.insurance,
    other: t.expenseQuick.other,
  };

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

  const [amount, setAmount] = useState(params.amount ?? '');
  const [category, setCategory] = useState<ExpenseCategory>('other');
  const [vendorName, setVendorName] = useState(params.vendorName ?? '');
  const [description, setDescription] = useState('');
  // A calendar day as `YYYY-MM-DD`; the date field shows it in the company's locale.
  const [date, setDate] = useState(() => today());
  const [taxRate, setTaxRate] = useState(defaultTaxRate);
  const [accrueUseTax, setAccrueUseTax] = useState(false);
  const [taxCode, setTaxCode] = useState<string>(DEFAULT_TAX_CODE);
  const [paymentMethod, setPaymentMethod] = useState<string>(() => defaultExpenseMethod(isUs));
  // The expense account follows the category until the user picks one themselves.
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [accountTouched, setAccountTouched] = useState(false);
  // From the scan: the supplier OCR matched (only while the name is still the scanned one),
  // the receipt's currency, and its lines when they carry more than one rate.
  const [scanned, setScanned] = useState<{
    vendorName: string | null;
    contactId: string | null;
    currency: string | null;
    total: string | null;
    lines: BillPrefill['items'] | null;
    rates: number[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [amountError, setAmountError] = useState<string | undefined>();
  const [ocrState, setOcrState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    params.documentId ? 'loading' : 'idle',
  );
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    api
      .getAccounts()
      .then((rows) => {
        if (!cancelled) setAccounts(expenseAccounts(rows));
      })
      // Without the chart the expense books to the default expense account, as it always could.
      .catch((err) => console.error('Failed to load expense accounts:', err));
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  useEffect(() => {
    if (!accountTouched) setAccountId(accountForCategory(category, accounts)?.id ?? '');
  }, [category, accounts, accountTouched]);

  // Booked per receipt line while the scanned total stands; editing it falls back to one rate.
  const mixedRates = Boolean(scanned?.lines) && amount === scanned?.total;

  useEffect(() => {
    if (!params.documentId) return;
    let cancelled = false;
    setOcrState('loading');
    void (async () => {
      try {
        const prefill = await api.getBillFromDocument(params.documentId!);
        if (cancelled) return;
        if (prefill.contactName) setVendorName(prefill.contactName);
        if (prefill.issueDate) setDate(prefill.issueDate);
        const total = totalFromPrefill(prefill);
        const totalText = total != null && total > 0 ? amountInput(total) : null;
        if (totalText) setAmount(totalText);
        const rate = mainTaxRate(prefill);
        if (rate && !isUs) setTaxRate(rate);
        const firstLine = prefill.items[0]?.description?.trim();
        if (firstLine && firstLine !== prefill.contactName) setDescription(firstLine);
        const rates = isUs ? [] : prefillTaxRates(prefill);
        setScanned({
          vendorName: prefill.contactName,
          contactId: prefill.matchedContactId,
          currency: prefill.currency,
          total: totalText,
          lines: rates.length > 1 ? prefill.items : null,
          rates,
        });
        setOcrState('ready');
      } catch {
        if (!cancelled) setOcrState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.documentId, isUs]);

  const handleSave = useCallback(async () => {
    const value = parseTyped(amount);
    if (value <= 0) {
      setAmountError(t.expenseQuick.amountError);
      return;
    }
    setAmountError(undefined);

    const name = vendorName.trim();
    const sameSupplier = scanned?.contactId && name === scanned.vendorName?.trim();
    // The receipt's own lines only while its total is what gets booked.
    const receiptLines = scanned?.lines && amount === scanned.total ? scanned.lines : undefined;
    const payload = {
      amount: value,
      amountIncludesTax: true,
      // The label, not the key: it is the line's description when none is typed.
      category: t.expenseQuick[category],
      description: description.trim() || undefined,
      vendorName: name || undefined,
      ...(sameSupplier ? { contactId: scanned.contactId! } : {}),
      ...(scanned?.currency ? { currency: scanned.currency } : {}),
      date,
      documentId: params.documentId || undefined,
      // A photo scanned offline (or whose upload failed) is stored with the expense, so it stays linked.
      ...(!params.documentId && params.receiptUri
        ? {
            receipt: {
              localUri: params.receiptUri,
              mimeType: params.receiptType || 'image/jpeg',
              fileName: receiptFileName(params.receiptType || 'image/jpeg'),
            },
          }
        : {}),
      ...(accountId ? { accountId } : {}),
      // A US expense is booked at what was paid: the tax in it is part of the cost, and use tax is accrued on request.
      taxRate: isUs ? 0 : parseTyped(taxRate || '0'),
      ...(receiptLines ? { receiptLines } : {}),
      roundingDescription: t.expenseQuick.rounding,
      paymentMethod,
      ...(isUs && accrueUseTax ? { accrueUseTax: true, taxCode } : {}),
    };

    setSaving(true);
    try {
      if (!isOnline) {
        await addToQueue({ type: 'expense', data: payload });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.info(t.expenseQuick.savedOffline);
        router.back();
        return;
      }

      await api.createQuickExpense(payload);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(t.expenseQuick.saved);
      router.back();
    } catch (err) {
      if (err instanceof QuickExpenseNotBookedError) {
        // The bill exists; saving again would create it twice.
        toast.info(format(t.expenseQuick.notBooked, { reason: describeApiError(err.cause, t, err.message) }));
        router.back();
        return;
      }
      if (isApiError(err)) {
        // The server answered: queueing would only fail the same way on every sync.
        toast.error(describeApiError(err, t, t.expenseQuick.saveFailed));
        return;
      }
      // The request never got an answer while nominally online — queue it rather than losing what was typed.
      try {
        await addToQueue({ type: 'expense', data: payload });
        toast.info(t.expenseQuick.queuedRetry);
        router.back();
      } catch {
        toast.error(describeApiError(err, t, t.expenseQuick.saveFailed));
      }
    } finally {
      setSaving(false);
    }
  }, [
    amount,
    category,
    description,
    vendorName,
    scanned,
    accountId,
    date,
    taxRate,
    paymentMethod,
    accrueUseTax,
    taxCode,
    isUs,
    parseTyped,
    params.documentId,
    params.receiptUri,
    params.receiptType,
    isOnline,
    addToQueue,
    router,
    toast,
    t,
    format,
  ]);

  return (
    <Screen header={<ScreenHeader title={t.expenseQuick.title} showBack />}>
      <FormScrollView contentContainerStyle={styles.content}>
          {!isOnline ? (
            <Banner
              variant="warning"
              icon={<WifiOff size={18} color={colors.warning} />}
              style={styles.banner}
            >
              {t.expenseQuick.offlineBanner}
            </Banner>
          ) : null}
          {ocrState === 'loading' ? (
            <Banner variant="info" style={styles.banner}>
              {t.expenseQuick.ocrLoading}
            </Banner>
          ) : null}
          {ocrState === 'ready' ? (
            <Banner variant="success" style={styles.banner}>
              {t.expenseQuick.ocrReady}
            </Banner>
          ) : null}
          {ocrState === 'failed' ? (
            <Banner variant="warning" style={styles.banner}>
              {t.expenseQuick.ocrFailed}
            </Banner>
          ) : null}

          <ReceiptPreview uri={params.receiptUri} style={styles.receipt} />

          <Card style={styles.amountCard}>
            <Text style={[styles.amountLabel, { color: colors.mutedForeground }]}>
              {t.expenseQuick.amount}
            </Text>
            <Pressable onPress={() => amountRef.current?.focus()} style={styles.amountPress}>
              {/* The card takes the touches: on Android a drag that starts on a single-line
                  input stays with the input, so the form would not scroll from here. */}
              <View pointerEvents="none">
                <TextInput
                  ref={amountRef}
                  value={amount}
                  onChangeText={(text) => {
                    setAmount(text);
                    if (amountError) setAmountError(undefined);
                  }}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.placeholder}
                  style={[styles.amountInput, { color: colors.text }]}
                  // The big centred figure is the display; a caret blinking beside it (on Android it
                  // sits at the far edge of the card, away from the digits) only points at the wrong place.
                  caretHidden
                  selectionColor={BRAND}
                  testID="expense-amount"
                  autoFocus={!params.documentId}
                />
              </View>
            </Pressable>
            {amountError ? (
              <Text style={[styles.amountError, { color: colors.destructive }]}>{amountError}</Text>
            ) : (
              <Text style={[styles.amountHint, { color: colors.mutedForeground }]}>
                {isUs
                  ? t.expenseQuick.amountHintUs
                  : format(t.expenseQuick.amountHint, {
                      rate: parseTyped(taxRate || '0'),
                      tax: labels.tax,
                      amount: formatCurrency(
                        splitInclusiveTotal(parseTyped(amount || '0'), parseTyped(taxRate || '0')).tax,
                      ),
                    })}
              </Text>
            )}
          </Card>

          <SectionCard title={t.expenseQuick.category} padded={false}>
            <View style={styles.categories}>
              {CATEGORY_KEYS.map(({ key, icon: Icon }) => {
                const selected = category === key;
                const label = categoryLabels[key];
                return (
                  <Pressable
                    key={key}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setCategory(key);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={label}
                    style={[
                      styles.category,
                      {
                        borderColor: selected ? BRAND : colors.border,
                        backgroundColor: selected ? tint(BRAND) : 'transparent',
                      },
                    ]}
                  >
                    <Icon size={20} color={selected ? BRAND : colors.mutedForeground} />
                    <Text
                      style={[
                        styles.categoryLabel,
                        { color: selected ? BRAND : colors.mutedForeground },
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {accounts.length > 0 ? (
              <View style={styles.accountPicker}>
                <Select
                  label={t.expenseQuick.account}
                  value={accountId}
                  onValueChange={(value) => {
                    setAccountId(value);
                    setAccountTouched(true);
                  }}
                  options={[
                    { label: t.expenseQuick.defaultAccount, value: '' },
                    ...accounts.map((account) => ({ label: `${account.code} ${account.name}`, value: account.id })),
                  ]}
                />
              </View>
            ) : null}
          </SectionCard>

          <SectionCard title={t.expenseQuick.details}>
            <Input
              label={labels.supplier}
              value={vendorName}
              onChangeText={setVendorName}
              placeholder={t.expenseQuick.vendorPlaceholder}
              autoCapitalize="words"
              testID="expense-vendor"
            />
            <DateField label={t.expenseQuick.date} value={date} onChange={setDate} testID="expense-date" />
            {isUs ? (
              <>
                <Switch
                  label={t.expenseQuick.accrueUseTax}
                  value={accrueUseTax}
                  onValueChange={setAccrueUseTax}
                />
                <Text style={[styles.amountHint, styles.leftHint, { color: colors.mutedForeground }]}>
                  {t.expenseQuick.accrueUseTaxHint}
                </Text>
                {accrueUseTax ? (
                  <Select
                    label={t.salesTax.taxCode}
                    value={taxCode}
                    onValueChange={setTaxCode}
                    options={WELD_TAX_CODES.map((option) => ({
                      label: t.salesTax.codes[option],
                      value: option,
                    }))}
                  />
                ) : null}
              </>
            ) : null}
            {!isUs && mixedRates ? (
              <Text style={[styles.amountHint, styles.leftHint, { color: colors.mutedForeground }]}>
                {format(t.expenseQuick.mixedRates, {
                  tax: labels.tax,
                  rates: scanned!.rates.map((rate) => `${rate}%`).join(', '),
                })}
              </Text>
            ) : null}
            {!isUs && !mixedRates ? (
              <Input
                label={labels.taxPercent}
                value={taxRate}
                onChangeText={setTaxRate}
                keyboardType="decimal-pad"
                placeholder={defaultTaxRate}
              />
            ) : null}
            <Select
              label={t.expenseQuick.paidWith}
              value={paymentMethod}
              onValueChange={setPaymentMethod}
              options={paymentMethodsFor(isUs)
                .filter((method) => method !== 'manual')
                .map((method) => ({ label: methodLabels[method], value: method }))}
            />
            <Textarea
              label={t.expenseQuick.description}
              value={description}
              onChangeText={setDescription}
              placeholder={t.expenseQuick.descriptionPlaceholder}
              numberOfLines={3}
            />
          </SectionCard>

          <Button
            title={isOnline ? t.expenseQuick.save : t.expenseQuick.queue}
            onPress={handleSave}
            loading={saving}
            fullWidth
            style={styles.submit}
          />
      </FormScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 8 },
  banner: { marginHorizontal: 12, marginBottom: 4 },
  receipt: { marginBottom: 4 },
  amountCard: { marginHorizontal: 12, padding: 20, alignItems: 'center' },
  amountLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  amountPress: { width: '100%' },
  amountInput: {
    fontSize: 44,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -1,
    paddingVertical: 4,
  },
  amountError: { fontSize: 13, marginTop: 4 },
  amountHint: { fontSize: 12, marginTop: 4 },
  leftHint: { lineHeight: 17 },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16, paddingTop: 12 },
  accountPicker: { paddingHorizontal: 16, paddingBottom: 12 },
  category: {
    width: '23%',
    // A fixed height: `aspectRatio` on a percentage width makes Yoga size the wrapped
    // grid for a taller row than it draws, leaving a gap under the last row.
    height: 76,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  categoryLabel: { fontSize: 10, fontWeight: '600' },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
