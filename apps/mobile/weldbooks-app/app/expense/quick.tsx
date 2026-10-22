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

import api, { QuickExpenseNotBookedError, receiptFileName, type LocalReceipt } from '@/services/api';
import { today } from '@/lib/date';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n, useLocaleFormatters, type Translations } from '@/lib/i18n';
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

type OcrState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * What the save keeps from a scan: the supplier OCR matched (only while the name
 * is still the scanned one), the receipt's currency, and its lines when they
 * carry more than one rate.
 */
interface Scanned {
  vendorName: string | null;
  contactId: string | null;
  currency: string | null;
  total: string | null;
  lines: BillPrefill['items'] | null;
  rates: number[];
}

type ExpensePayload = Parameters<typeof api.createQuickExpense>[0] & {
  /** A photo with no stored document yet (scanned offline, or its upload failed). */
  receipt?: LocalReceipt;
};

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

/** The form fields a scan fills in, and what the save keeps from it. */
function fieldsFromPrefill(prefill: BillPrefill, isUs: boolean) {
  const total = totalFromPrefill(prefill);
  const amount = total != null && total > 0 ? amountInput(total) : null;
  const firstLine = prefill.items[0]?.description?.trim();
  const rates = isUs ? [] : prefillTaxRates(prefill);
  const scanned: Scanned = {
    vendorName: prefill.contactName,
    contactId: prefill.matchedContactId,
    currency: prefill.currency,
    total: amount,
    lines: rates.length > 1 ? prefill.items : null,
    rates,
  };
  return {
    vendorName: prefill.contactName,
    date: prefill.issueDate,
    amount,
    taxRate: isUs ? null : mainTaxRate(prefill),
    description: firstLine && firstLine !== prefill.contactName ? firstLine : null,
    scanned,
  };
}

/** The photo to store with the expense: only one that has no document yet. */
function receiptToStore(documentId?: string, receiptUri?: string, receiptType?: string) {
  if (documentId || !receiptUri) return {};
  const mimeType = receiptType || 'image/jpeg';
  return { receipt: { localUri: receiptUri, mimeType, fileName: receiptFileName(mimeType) } };
}

/** What the save takes from the scan, while the form still matches it. */
function fromScan(scanned: Scanned | null, vendorName: string, amountText: string) {
  if (!scanned) return {};
  return {
    ...(scanned.contactId && vendorName === scanned.vendorName?.trim() ? { contactId: scanned.contactId } : {}),
    ...(scanned.currency ? { currency: scanned.currency } : {}),
    // The receipt's own lines only while its total is what gets booked.
    ...(scanned.lines && amountText === scanned.total ? { receiptLines: scanned.lines } : {}),
  };
}

type SaveResult =
  | { kind: 'booked' | 'queued' | 'retryQueued' }
  | { kind: 'notBooked'; err: QuickExpenseNotBookedError }
  | { kind: 'failed'; err: unknown };

/**
 * Saves the expense, or queues it when offline. Online, a photo without a
 * document is stored before the bill: if the connection then drops, the queued
 * expense carries the document instead of storing the photo a second time.
 */
async function saveExpense(
  payload: ExpensePayload,
  isOnline: boolean,
  queue: (data: ExpensePayload) => Promise<void>,
  /** Called once the photo is stored, so a later attempt (after a rejected save) links it again. */
  onStored: (documentId: string) => void,
): Promise<SaveResult> {
  if (!isOnline) {
    await queue(payload);
    return { kind: 'queued' };
  }
  let pending = payload;
  try {
    if (pending.receipt) {
      const documentId = (await api.uploadReceipt(pending.receipt)) ?? undefined;
      if (documentId) onStored(documentId);
      pending = { ...pending, documentId, receipt: undefined };
    }
    await api.createQuickExpense(pending);
    return { kind: 'booked' };
  } catch (err) {
    // The bill exists; saving again would create it twice.
    if (err instanceof QuickExpenseNotBookedError) return { kind: 'notBooked', err };
    // The server answered: queueing would only fail the same way on every sync.
    if (isApiError(err)) return { kind: 'failed', err };
    // The request never got an answer while nominally online — queue it rather than losing what was typed.
    try {
      await queue(pending);
      return { kind: 'retryQueued' };
    } catch {
      return { kind: 'failed', err };
    }
  }
}

function ScanBanners({ isOnline, ocrState }: Readonly<{ isOnline: boolean; ocrState: OcrState }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const ocr: Record<Exclude<OcrState, 'idle'>, { variant: 'info' | 'success' | 'warning'; text: string }> = {
    loading: { variant: 'info', text: t.expenseQuick.ocrLoading },
    ready: { variant: 'success', text: t.expenseQuick.ocrReady },
    failed: { variant: 'warning', text: t.expenseQuick.ocrFailed },
  };
  const shown = ocrState === 'idle' ? null : ocr[ocrState];
  return (
    <>
      {isOnline ? null : (
        <Banner variant="warning" icon={<WifiOff size={18} color={colors.warning} />} style={styles.banner}>
          {t.expenseQuick.offlineBanner}
        </Banner>
      )}
      {shown ? (
        <Banner variant={shown.variant} style={styles.banner}>
          {shown.text}
        </Banner>
      ) : null}
    </>
  );
}

/** Under the amount: the VAT inside it, or for a US expense what the amount means. */
function AmountHint({ amount, taxRate, isUs }: Readonly<{ amount: string; taxRate: string; isUs: boolean }>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { labels } = useJurisdiction();
  const { formatCurrency, parseAmount } = useLocaleFormatters();
  const rate = parseAmount(taxRate || '0');
  const text = isUs
    ? t.expenseQuick.amountHintUs
    : format(t.expenseQuick.amountHint, {
        rate,
        tax: labels.tax,
        amount: formatCurrency(splitInclusiveTotal(parseAmount(amount || '0'), rate).tax),
      });
  return <Text style={[styles.amountHint, { color: colors.mutedForeground }]}>{text}</Text>;
}

/** US: accrue use tax when the vendor charged no sales tax. */
function UseTaxFields({
  accrueUseTax,
  onAccrueUseTax,
  taxCode,
  onTaxCode,
}: Readonly<{
  accrueUseTax: boolean;
  onAccrueUseTax: (value: boolean) => void;
  taxCode: string;
  onTaxCode: (value: string) => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <>
      <Switch label={t.expenseQuick.accrueUseTax} value={accrueUseTax} onValueChange={onAccrueUseTax} />
      <Text style={[styles.amountHint, styles.leftHint, { color: colors.mutedForeground }]}>
        {t.expenseQuick.accrueUseTaxHint}
      </Text>
      {accrueUseTax ? (
        <Select
          label={t.salesTax.taxCode}
          value={taxCode}
          onValueChange={onTaxCode}
          options={WELD_TAX_CODES.map((option) => ({ label: t.salesTax.codes[option], value: option }))}
        />
      ) : null}
    </>
  );
}

/** VAT / GST: the rate field, or a note when the receipt's lines carry several rates. */
function TaxRateField({
  taxRate,
  onTaxRate,
  placeholder,
  mixedRates,
}: Readonly<{ taxRate: string; onTaxRate: (value: string) => void; placeholder: string; mixedRates: number[] | null }>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { labels } = useJurisdiction();
  if (mixedRates) {
    return (
      <Text style={[styles.amountHint, styles.leftHint, { color: colors.mutedForeground }]}>
        {format(t.expenseQuick.mixedRates, {
          tax: labels.tax,
          rates: mixedRates.map((rate) => `${rate}%`).join(', '),
        })}
      </Text>
    );
  }
  return (
    <Input
      label={labels.taxPercent}
      value={taxRate}
      onChangeText={onTaxRate}
      keyboardType="decimal-pad"
      placeholder={placeholder}
    />
  );
}

function methodLabels(t: Translations): Record<PaymentMethodValue, string> {
  return {
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
}

/** The expense account: follows the category until the user picks one. Hidden without a chart. */
function AccountPicker({
  accounts,
  accountId,
  onPick,
}: Readonly<{ accounts: GlAccount[]; accountId: string; onPick: (id: string) => void }>) {
  const { t } = useI18n();
  if (accounts.length === 0) return null;
  return (
    <View style={styles.accountPicker}>
      <Select
        label={t.expenseQuick.account}
        value={accountId}
        onValueChange={onPick}
        options={[
          { label: t.expenseQuick.defaultAccount, value: '' },
          ...accounts.map((account) => ({ label: `${account.code} ${account.name}`, value: account.id })),
        ]}
      />
    </View>
  );
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
  const { parseAmount: parseTyped } = useLocaleFormatters();
  const defaultTaxRate = defaultTaxRateFor(code);

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
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [saving, setSaving] = useState(false);
  // The document a save stored the photo as: the scan's own, or the one an earlier attempt stored.
  const [storedDocumentId, setStoredDocumentId] = useState<string | undefined>(params.documentId || undefined);
  const [amountError, setAmountError] = useState<string | undefined>();
  const [ocrState, setOcrState] = useState<OcrState>(params.documentId ? 'loading' : 'idle');

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
  const mixedRates = scanned?.lines && amount === scanned.total ? scanned.rates : null;

  useEffect(() => {
    const documentId = params.documentId;
    if (!documentId) return;
    let cancelled = false;
    setOcrState('loading');
    api
      .getBillFromDocument(documentId)
      .then((prefill) => {
        if (cancelled) return;
        const fields = fieldsFromPrefill(prefill, isUs);
        if (fields.vendorName) setVendorName(fields.vendorName);
        if (fields.date) setDate(fields.date);
        if (fields.amount) setAmount(fields.amount);
        if (fields.taxRate) setTaxRate(fields.taxRate);
        if (fields.description) setDescription(fields.description);
        setScanned(fields.scanned);
        setOcrState('ready');
      })
      .catch(() => {
        if (!cancelled) setOcrState('failed');
      });
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
    const payload: ExpensePayload = {
      amount: value,
      amountIncludesTax: true,
      // The label, not the key: it is the line's description when none is typed.
      category: t.expenseQuick[category],
      description: description.trim() || undefined,
      vendorName: name || undefined,
      date,
      documentId: storedDocumentId,
      ...receiptToStore(storedDocumentId, params.receiptUri, params.receiptType),
      ...fromScan(scanned, name, amount),
      ...(accountId ? { accountId } : {}),
      // A US expense is booked at what was paid: the tax in it is part of the cost, and use tax is accrued on request.
      taxRate: isUs ? 0 : parseTyped(taxRate || '0'),
      roundingDescription: t.expenseQuick.rounding,
      paymentMethod,
      ...(isUs && accrueUseTax ? { accrueUseTax: true, taxCode } : {}),
    };

    setSaving(true);
    const result = await saveExpense(
      payload,
      isOnline,
      (data) => addToQueue({ type: 'expense', data }),
      setStoredDocumentId,
    );
    setSaving(false);

    switch (result.kind) {
      case 'failed':
        toast.error(describeApiError(result.err, t, t.expenseQuick.saveFailed));
        return;
      case 'notBooked':
        toast.info(format(t.expenseQuick.notBooked, { reason: describeApiError(result.err.cause, t, result.err.message) }));
        break;
      case 'booked':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success(t.expenseQuick.saved);
        break;
      case 'queued':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.info(t.expenseQuick.savedOffline);
        break;
      case 'retryQueued':
        toast.info(t.expenseQuick.queuedRetry);
        break;
    }
    router.back();
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
    storedDocumentId,
    params.receiptUri,
    params.receiptType,
    isOnline,
    addToQueue,
    router,
    toast,
    t,
    format,
  ]);

  const methods = methodLabels(t);

  return (
    <Screen header={<ScreenHeader title={t.expenseQuick.title} showBack />}>
      <FormScrollView contentContainerStyle={styles.content}>
          <ScanBanners isOnline={isOnline} ocrState={ocrState} />

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
                    setAmountError(undefined);
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
              <AmountHint amount={amount} taxRate={taxRate} isUs={isUs} />
            )}
          </Card>

          <SectionCard title={t.expenseQuick.category} padded={false}>
            <View style={styles.categories}>
              {CATEGORY_KEYS.map(({ key, icon: Icon }) => {
                const selected = category === key;
                const label = t.expenseQuick[key];
                const color = selected ? BRAND : colors.mutedForeground;
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
                      selected
                        ? { borderColor: BRAND, backgroundColor: tint(BRAND) }
                        : { borderColor: colors.border, backgroundColor: 'transparent' },
                    ]}
                  >
                    <Icon size={20} color={color} />
                    <Text style={[styles.categoryLabel, { color }]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <AccountPicker
              accounts={accounts}
              accountId={accountId}
              onPick={(value) => {
                setAccountId(value);
                setAccountTouched(true);
              }}
            />
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
              <UseTaxFields
                accrueUseTax={accrueUseTax}
                onAccrueUseTax={setAccrueUseTax}
                taxCode={taxCode}
                onTaxCode={setTaxCode}
              />
            ) : (
              <TaxRateField
                taxRate={taxRate}
                onTaxRate={setTaxRate}
                placeholder={defaultTaxRate}
                mixedRates={mixedRates}
              />
            )}
            <Select
              label={t.expenseQuick.paidWith}
              value={paymentMethod}
              onValueChange={setPaymentMethod}
              options={paymentMethodsFor(isUs)
                .filter((method) => method !== 'manual')
                .map((method) => ({ label: methods[method], value: method }))}
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
