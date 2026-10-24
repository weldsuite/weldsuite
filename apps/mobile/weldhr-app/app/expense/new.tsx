import { useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Camera, FileText, Images, X } from 'lucide-react-native';
import type { HrDeclarationCategory } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { ErrorNote, Screen } from '@/components/Screen';
import { useCreateDeclaration, useMe } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { parseAmount } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { toReceipt, type LocalReceipt } from '@/utils/receipt';

const CATEGORIES: HrDeclarationCategory[] = ['travel', 'meals', 'accommodation', 'equipment', 'training', 'other'];
const CURRENCIES = ['EUR', 'USD', 'GBP'] as const;
type Currency = (typeof CURRENCIES)[number];

export default function NewExpenseScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const me = useMe();
  const create = useCreateDeclaration();

  const today = todayIso();
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [expenseDate, setExpenseDate] = useState(today);
  const [category, setCategory] = useState<HrDeclarationCategory>('travel');
  const [description, setDescription] = useState('');
  const [receipt, setReceipt] = useState<LocalReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (source: 'camera' | 'library') => {
    setError(null);
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(source === 'camera' ? t.expenseForm.cameraDenied : t.expenseForm.libraryDenied);
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7 };
    const result =
      source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    const picked = toReceipt(asset);
    if (picked === 'type') setError(t.expenseForm.receiptType);
    else if (picked === 'size') setError(t.expenseForm.receiptSize);
    else setReceipt(picked);
  };

  const submit = () => {
    setError(null);
    const amount = parseAmount(amountText);
    if (amount == null) return setError(t.expenseForm.amountInvalid);
    if (!description.trim()) return setError(t.expenseForm.descriptionRequired);
    create.mutate(
      { body: { amount, currency, expenseDate, category, description: description.trim() }, receipt },
      {
        onSuccess: ({ receiptFailed }) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (receiptFailed) toast.warning(t.expenseForm.sentNoReceipt, 6000);
          else toast.success(t.expenseForm.sent);
          router.back();
        },
        onError: (err) => setError((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  if (me.data?.features.declarations === false) {
    return (
      <Screen title={t.expenseForm.title} variant="modal">
        <Banner variant="info">{t.expenses.turnedOff}</Banner>
      </Screen>
    );
  }

  return (
    <Screen title={t.expenseForm.title} variant="modal">
      <View style={styles.form}>
        <Input
              label={t.expenseForm.amount}
              placeholder={t.expenseForm.amountPlaceholder}
              value={amountText}
              onChangeText={setAmountText}
              keyboardType="decimal-pad"
              inputStyle={styles.amountInput}
              autoFocus
            />
        <SegmentedControl
          value={currency}
          onValueChange={(value) => setCurrency(value as Currency)}
          options={CURRENCIES.map((code) => ({ label: code, value: code }))}
        />

        <DateField label={t.expenseForm.date} value={expenseDate} max={today} onChange={setExpenseDate} />

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.text }]}>{t.expenseForm.category}</Text>
          <View style={styles.chips}>
            {CATEGORIES.map((value) => (
              <Chip
                key={value}
                label={t.declarationCategory[value]}
                selected={category === value}
                onPress={() => setCategory(value)}
              />
            ))}
          </View>
        </View>

        <Textarea
          label={t.expenseForm.description}
          placeholder={t.expenseForm.descriptionPlaceholder}
          value={description}
          onChangeText={setDescription}
          numberOfLines={2}
          maxLength={2000}
        />

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.text }]}>{t.expenseForm.receipt}</Text>
          {receipt ? (
            <View style={[styles.receipt, { backgroundColor: colors.inputBackground }]}>
              {receipt.type.startsWith('image/') ? (
                <Image source={{ uri: receipt.uri }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.pdfThumb]}>
                  <FileText size={22} color={colors.mutedForeground} />
                </View>
              )}
              <Text style={[styles.receiptName, { color: colors.text }]} numberOfLines={1}>
                {receipt.name}
              </Text>
              <Pressable
                onPress={() => setReceipt(null)}
                accessibilityRole="button"
                accessibilityLabel={t.expenseForm.removeReceipt}
                hitSlop={10}
              >
                <X size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
          ) : (
            <View style={styles.pickRow}>
              {Platform.OS === 'web' ? null : (
                <Button
                  title={t.expenseForm.takePhoto}
                  variant="outline"
                  leftIcon={<Camera size={16} color={colors.text} />}
                  onPress={() => void pick('camera')}
                  style={styles.flex}
                />
              )}
              <Button
                title={t.expenseForm.choosePhoto}
                variant="outline"
                leftIcon={<Images size={16} color={colors.text} />}
                onPress={() => void pick('library')}
                style={styles.flex}
              />
            </View>
          )}
        </View>

        {error ? <ErrorNote message={error} /> : null}

        <Button title={t.expenseForm.submit} onPress={submit} loading={create.isPending} fullWidth size="lg" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  form: { gap: 16 },
  amountInput: { fontSize: 24, fontWeight: '700' },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickRow: { flexDirection: 'row', gap: 10 },
  receipt: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 10 },
  thumb: { width: 48, height: 48, borderRadius: 8 },
  pdfThumb: { alignItems: 'center', justifyContent: 'center' },
  receiptName: { flex: 1, fontSize: 14 },
});
