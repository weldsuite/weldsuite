import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Camera, FileText, Images, X } from 'lucide-react-native';
import type { HrDeclarationCategory } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { FormChips, FormField, FormHint, FormInput, FormScreen, useFieldBox } from '@/components/Form';
import { useCreateDeclaration, useMe } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { parseAmount } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { toReceipt, type LocalReceipt } from '@/utils/receipt';

const CATEGORIES: HrDeclarationCategory[] = ['travel', 'meals', 'accommodation', 'equipment', 'training', 'other'];
const CURRENCIES = ['EUR', 'USD', 'GBP'] as const;
type Currency = (typeof CURRENCIES)[number];

/**
 * Android picks photos with the system photo picker, which needs no
 * permission; the media permissions are blocked in app.json, since Play only
 * allows them to apps whose core feature is the photo library.
 */
async function requestPickerPermission(source: 'camera' | 'library'): Promise<boolean> {
  if (source === 'camera') return (await ImagePicker.requestCameraPermissionsAsync()).granted;
  if (Platform.OS === 'android') return true;
  return (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted;
}

export default function NewExpenseScreen() {
  const { t } = useI18n();
  const router = useRouter();
  // From the + menu on Expenses: start with the receipt, from the camera or the photos.
  const { receipt: startWith } = useLocalSearchParams<{ receipt?: string }>();
  const start = startWith === 'camera' || startWith === 'library' ? startWith : null;
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

  const pick = useCallback(
    async (source: 'camera' | 'library') => {
      setError(null);
      // A simulator has no camera, and the picker aborts the app rather than say so.
      if (source === 'camera' && !Device.isDevice) {
        setError(t.expenseForm.noCamera);
        return;
      }
      if (!(await requestPickerPermission(source))) {
        setError(source === 'camera' ? t.expenseForm.cameraDenied : t.expenseForm.libraryDenied);
        return;
      }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7 };
      let result: ImagePicker.ImagePickerResult;
      try {
        result =
          source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      } catch (err) {
        // No camera (the simulator) or the picker could not open.
        setError((err as Error).message || t.common.somethingWrong);
        return;
      }
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const picked = toReceipt(asset);
      if (picked === 'type') setError(t.expenseForm.receiptType);
      else if (picked === 'size') setError(t.expenseForm.receiptSize);
      else setReceipt(picked);
    },
    [t],
  );

  // Once, when the form has opened.
  const started = useRef(false);
  useEffect(() => {
    if (!start || started.current) return;
    started.current = true;
    void pick(start);
  }, [start, pick]);

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
      <FormScreen title={t.expenseForm.title}>
        <Banner variant="info">{t.expenses.turnedOff}</Banner>
      </FormScreen>
    );
  }

  return (
    <FormScreen
      title={t.expenseForm.title}
      action={{
        label: t.common.submit,
        onPress: submit,
        disabled: create.isPending,
        loading: create.isPending,
        testID: 'expense-submit',
      }}
    >
      <FormField label={t.expenseForm.amount}>
        <FormInput
          testID="expense-amount"
          placeholder={t.expenseForm.amountPlaceholder}
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          accessibilityLabel={t.expenseForm.amount}
          // Not over the camera or the photos it opens with.
          autoFocus={!start}
        />
        <View style={styles.currencies}>
          <FormChips
            value={currency}
            onChange={setCurrency}
            options={CURRENCIES.map((code) => ({ label: code, value: code }))}
          />
        </View>
      </FormField>

      <DateField label={t.expenseForm.date} value={expenseDate} max={today} onChange={setExpenseDate} />

      <FormField label={t.expenseForm.category}>
        <FormChips
          value={category}
          onChange={setCategory}
          options={CATEGORIES.map((value) => ({ label: t.declarationCategory[value], value }))}
        />
      </FormField>

      <FormField label={t.expenseForm.description}>
        <FormInput
          placeholder={t.expenseForm.descriptionPlaceholder}
          testID="expense-description"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.description}
          maxLength={2000}
          accessibilityLabel={t.expenseForm.description}
        />
      </FormField>

      <FormField label={t.expenseForm.receipt}>
        <ReceiptField receipt={receipt} onPick={(source) => void pick(source)} onRemove={() => setReceipt(null)} />
        {error ? <FormHint error>{error}</FormHint> : null}
      </FormField>
    </FormScreen>
  );
}

/** The receipt once picked (a thumbnail, its name, remove), or the two ways to add one. */
function ReceiptField({
  receipt,
  onPick,
  onRemove,
}: Readonly<{ receipt: LocalReceipt | null; onPick: (source: 'camera' | 'library') => void; onRemove: () => void }>) {
  const { t } = useI18n();
  const { colors, box, value } = useFieldBox();
  if (receipt) {
    return (
      <View style={[box, styles.receipt]}>
        {receipt.type.startsWith('image/') ? (
          <Image source={{ uri: receipt.uri }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.pdfThumb, { backgroundColor: colors.background }]}>
            <FileText size={18} color={colors.mutedForeground} />
          </View>
        )}
        <Text style={[value, styles.receiptName]} numberOfLines={1}>
          {receipt.name}
        </Text>
        <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={t.expenseForm.removeReceipt} hitSlop={10}>
          <X size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
    );
  }
  const button = (source: 'camera' | 'library', Icon: typeof Camera, label: string) => (
    <Pressable
      onPress={() => onPick(source)}
      accessibilityRole="button"
      style={({ pressed }) => [box, styles.pickButton, pressed && styles.pressed]}
    >
      <Icon size={18} color={colors.text} strokeWidth={2} />
      <Text style={[value, styles.pickLabel]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.pickRow}>
      {Platform.OS === 'web' ? null : button('camera', Camera, t.expenseForm.takePhoto)}
      {button('library', Images, t.expenseForm.choosePhoto)}
    </View>
  );
}

const styles = StyleSheet.create({
  currencies: { marginTop: 10 },
  description: { minHeight: 80 },
  pickRow: { flexDirection: 'row', gap: 12 },
  pickButton: { flex: 1, justifyContent: 'center', gap: 8 },
  pickLabel: { fontWeight: '500', flexShrink: 1 },
  pressed: { opacity: 0.8 },
  receipt: { gap: 12, height: 64, paddingHorizontal: 10 },
  thumb: { width: 44, height: 44, borderRadius: 9 },
  pdfThumb: { alignItems: 'center', justifyContent: 'center' },
  receiptName: { flex: 1 },
});
