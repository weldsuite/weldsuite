/**
 * Quick expense capture — the fastest path from a receipt to a booked cost.
 *
 * Saves as a one-line bill (app-api has no separate expense entity). When the
 * device is offline the entry goes to the offline queue instead of failing, and
 * syncs when connectivity returns.
 */

import { useCallback, useRef, useState } from 'react';
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
import { formatCurrency, parseAmount } from '@/lib/currency';
import { today } from '@/lib/date';
import { BRAND, tint } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import type { ExpenseCategory } from '@/types/accounting';

const CATEGORIES: { key: ExpenseCategory; label: string; icon: typeof Utensils }[] = [
  { key: 'food', label: 'Food', icon: Utensils },
  { key: 'transport', label: 'Transport', icon: Car },
  { key: 'office', label: 'Office', icon: Briefcase },
  { key: 'travel', label: 'Travel', icon: Plane },
  { key: 'supplies', label: 'Supplies', icon: Package },
  { key: 'utilities', label: 'Utilities', icon: Zap },
  { key: 'insurance', label: 'Insurance', icon: Shield },
  { key: 'other', label: 'Other', icon: Tag },
];

export default function QuickExpenseScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const amountRef = useRef<TextInput>(null);
  const { isOnline, addToQueue } = useOfflineQueue();
  const params = useLocalSearchParams<{ amount?: string; vendorName?: string; documentId?: string }>();

  const [amount, setAmount] = useState(params.amount ?? '');
  const [category, setCategory] = useState<ExpenseCategory>('other');
  const [vendorName, setVendorName] = useState(params.vendorName ?? '');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(today());
  const [taxRate, setTaxRate] = useState('21');
  const [saving, setSaving] = useState(false);
  const [amountError, setAmountError] = useState<string | undefined>();

  const handleSave = useCallback(async () => {
    const value = parseAmount(amount);
    if (value <= 0) {
      setAmountError('Enter an amount greater than zero');
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
        toast.info('Saved offline — it will sync when you reconnect');
        router.back();
        return;
      }

      await api.createQuickExpense(payload);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success('Expense saved');
      router.back();
    } catch (err) {
      // A request that failed while nominally online is still worth keeping —
      // queue it rather than losing what was typed.
      try {
        await addToQueue({ type: 'expense', data: payload });
        toast.info('Saved to the offline queue — we’ll retry shortly');
        router.back();
      } catch {
        toast.error(err instanceof Error ? err.message : 'Could not save the expense');
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
  ]);

  return (
    <Screen header={<ScreenHeader title="Quick expense" showBack />}>
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
              You&apos;re offline. This expense will be queued and synced later.
            </Banner>
          ) : null}

          <Card style={styles.amountCard}>
            <Text style={[styles.amountLabel, { color: colors.mutedForeground }]}>Amount</Text>
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
                autoFocus
              />
            </Pressable>
            {amountError ? (
              <Text style={[styles.amountError, { color: colors.destructive }]}>{amountError}</Text>
            ) : (
              <Text style={[styles.amountHint, { color: colors.mutedForeground }]}>
                incl. {parseAmount(taxRate || '0')}% VAT ·{' '}
                {formatCurrency(parseAmount(amount || '0'))}
              </Text>
            )}
          </Card>

          <SectionCard title="Category" padded={false}>
            <View style={styles.categories}>
              {CATEGORIES.map(({ key, label, icon: Icon }) => {
                const selected = category === key;
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

          <SectionCard title="Details">
            <Input
              label="Vendor"
              value={vendorName}
              onChangeText={setVendorName}
              placeholder="e.g. Shell, Amazon"
              autoCapitalize="words"
            />
            <Input
              label="Date"
              value={date}
              onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label="VAT %"
              value={taxRate}
              onChangeText={setTaxRate}
              keyboardType="decimal-pad"
              placeholder="21"
            />
            <Textarea
              label="Description"
              value={description}
              onChangeText={setDescription}
              placeholder="What was this for?"
              numberOfLines={3}
            />
          </SectionCard>

          <Button
            title={isOnline ? 'Save expense' : 'Queue expense'}
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
