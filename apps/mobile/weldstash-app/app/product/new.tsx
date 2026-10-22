import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { appApi } from '@/services/app-api';
import { buildCreateProductPayload, normalizeBarcode } from '@/utils/barcode';
import { weldstashKeys } from '@/lib/query-client';
import { useI18n } from '@/lib/i18n';

export default function NewProductScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const params = useLocalSearchParams<{ barcode?: string }>();

  const initialBarcode = useMemo(
    () => normalizeBarcode(typeof params.barcode === 'string' ? params.barcode : ''),
    [params.barcode],
  );

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState(initialBarcode);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onNameChange = (value: string) => {
    setName(value);
    if (nameError) setNameError(null);
  };

  const onSave = async () => {
    // Shown under the field, not as a toast: a toast is easy to miss and the
    // button looked like it did nothing.
    if (!name.trim()) {
      setNameError(t.newProduct.nameRequired);
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      const payload = buildCreateProductPayload({ name, sku, barcode });
      const created = await appApi.products.create(payload);
      toast.success(t.newProduct.created);
      await queryClient.invalidateQueries({ queryKey: weldstashKeys.products() });
      router.replace(`/product/${created.data.id}`);
    } catch (err) {
      toast.error((err as Error).message || t.newProduct.createFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t.common.back}
        >
          <ChevronLeft size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{t.newProduct.title}</Text>
      </View>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
        bottomOffset={56}
      >
        <Input
          label={t.newProduct.nameLabel}
          value={name}
          onChangeText={onNameChange}
          placeholder={t.newProduct.namePlaceholder}
          error={nameError ?? undefined}
          autoFocus
        />
        <Input
          label={t.newProduct.skuLabel}
          value={sku}
          onChangeText={setSku}
          placeholder={t.newProduct.skuPlaceholder}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Input
          label={t.newProduct.barcodeLabel}
          value={barcode}
          onChangeText={setBarcode}
          placeholder={t.newProduct.barcodePlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button title={t.newProduct.submit} loading={saving} onPress={() => void onSave()} />
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  form: { paddingHorizontal: 16, paddingBottom: 32, gap: 16 },
});
