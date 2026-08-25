/**
 * Quick expense capture — the fastest path from a receipt to a booked cost.
 *
 * Saves as a one-line bill (app-api has no separate expense entity). When the
 * device is offline the entry goes to the offline queue instead of failing, and
 * syncs when connectivity returns.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  KeyboardAvoidingView,
  Platform,
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

import api from '@/services/api';
import { parseAmount } from '@/lib/currency';
import { today } from '@/lib/date';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { BRAND, tint } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import type { BillPrefill, ExpenseCategory } from '@/types/accounting';

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

function exclusiveFromPrefill(prefill: BillPrefill): number | null {
  if (prefill.items.length > 0) {
    const sum = prefill.items.reduce((acc, item) => {
      return acc + parseAmount(item.quantity || '1') * parseAmount(item.unitPrice || '0');
    }, 0);
    if (sum > 0) return sum;
  }
  if (prefill.subtotal != null && prefill.subtotal > 0) return prefill.subtotal;
  return prefill.total;
}

function amountInput(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export default function QuickExpenseScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const amountRef = useRef<TextInput>(null);
  const { isOnline, addToQueue } = useOfflineQueue();
  const params = useLocalSearchParams<{ amount?: string; vendorName?: string; documentId?: string }>();
  const { t, format } = useI18n();
  const { formatCurrency } = useLocaleFormatters();

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

  const [amount, setAmount] = useState(params.amount ?? '');
  const [category, setCategory] = useState<ExpenseCategory>('other');
  const [vendorName, setVendorName] = useState(params.vendorName ?? '');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(today());
  const [taxRate, setTaxRate] = useState('21');
  const [saving, setSaving] = useState(false);
  const [amountError, setAmountError] = useState<string | undefined>();
  const [ocrState, setOcrState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    params.documentId ? 'loading' : 'idle',
  );

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
        const exclusive = exclusiveFromPrefill(prefill);
        if (exclusive != null && exclusive > 0) setAmount(amountInput(exclusive));
        const rate = prefill.items.find((item) => item.taxRate)?.taxRate;
        if (rate) setTaxRate(rate);
        const firstLine = prefill.items[0]?.description?.trim();
        if (firstLine && firstLine !== prefill.contactName) setDescription(firstLine);
        setOcrState('ready');
      } catch {
        if (!cancelled) setOcrState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.documentId]);

  const handleSave = useCallback(async () => {
    const value = parseAmount(amount);
    if (value <= 0) {
      setAmountError(t.expenseQuick.amountError);
      return;
    }
    setAmountError(undefined);

    const payload = {
      amount: value,
      category,
      description: description.trim() || undefined,
      vendorName: vendorName.trim() || undefined,
      date,
      documentId: params.documentId || undefined,
      taxRate: parseAmount(taxRate || '0'),
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
      // A request that failed while nominally online is still worth keeping —
      // queue it rather than losing what was typed.
      try {
        await addToQueue({ type: 'expense', data: payload });
        toast.info(t.expenseQuick.queuedRetry);
        router.back();
      } catch {
        toast.error(err instanceof Error ? err.message : t.expenseQuick.saveFailed);
      }
    } finally {
      setSaving(false);
    }
  }, [
    amount,
    category,
    description,
    vendorName,
    date,
    taxRate,
    params.documentId,
    isOnline,
    addToQueue,
    router,
    toast,
    t,
  ]);

  return (
    <Screen header={<ScreenHeader title={t.expenseQuick.title} showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
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

          <Card style={styles.amountCard}>
            <Text style={[styles.amountLabel, { color: colors.mutedForeground }]}>
              {t.expenseQuick.amount}
            </Text>
            <Pressable onPress={() => amountRef.current?.focus()} style={styles.amountPress}>
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
                autoFocus={!params.documentId}
              />
            </Pressable>
            {amountError ? (
              <Text style={[styles.amountError, { color: colors.destructive }]}>{amountError}</Text>
            ) : (
              <Text style={[styles.amountHint, { color: colors.mutedForeground }]}>
                {format(t.expenseQuick.amountHint, {
                  rate: parseAmount(taxRate || '0'),
                  total: formatCurrency(
                    parseAmount(amount || '0') * (1 + parseAmount(taxRate || '0') / 100),
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
          </SectionCard>

          <SectionCard title={t.expenseQuick.details}>
            <Input
              label={t.expenseQuick.vendor}
              value={vendorName}
              onChangeText={setVendorName}
              placeholder={t.expenseQuick.vendorPlaceholder}
              autoCapitalize="words"
            />
            <Input
              label={t.expenseQuick.date}
              value={date}
              onChangeText={setDate}
              placeholder={t.expenseQuick.datePlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label={t.expenseQuick.vatPercent}
              value={taxRate}
              onChangeText={setTaxRate}
              keyboardType="decimal-pad"
              placeholder="21"
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
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: 40, paddingTop: 8 },
  banner: { marginHorizontal: 12, marginBottom: 4 },
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
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16, paddingTop: 12 },
  category: {
    width: '23%',
    aspectRatio: 1,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  categoryLabel: { fontSize: 10, fontWeight: '600' },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
