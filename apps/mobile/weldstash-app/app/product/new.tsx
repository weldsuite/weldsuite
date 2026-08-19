import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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

export default function NewProductScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const params = useLocalSearchParams<{ barcode?: string }>();

  const initialBarcode = useMemo(
    () => normalizeBarcode(typeof params.barcode === 'string' ? params.barcode : ''),
    [params.barcode],
  );

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState(initialBarcode);
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = buildCreateProductPayload({ name, sku, barcode });
      const created = await appApi.products.create(payload);
      toast.success('Product created');
      await queryClient.invalidateQueries({ queryKey: weldstashKeys.products() });
      router.replace(`/product/${created.data.id}`);
    } catch (err) {
      toast.error((err as Error).message || 'Failed to create product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>New product</Text>
      </View>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Input label="Name" value={name} onChangeText={setName} placeholder="Widget" autoFocus />
        <Input
          label="SKU"
          value={sku}
          onChangeText={setSku}
          placeholder="WID-001"
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Input
          label="Barcode"
          value={barcode}
          onChangeText={setBarcode}
          placeholder="Scan or type barcode"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button title="Create product" loading={saving} onPress={() => void onSave()} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  form: { paddingHorizontal: 16, paddingBottom: 32, gap: 16 },
});
