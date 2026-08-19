import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Package, Plus, ScanBarcode } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { appApi } from '@/services/app-api';
import { useHardwareBarcodeScan } from '@/hooks/useHardwareBarcodeScan';
import { normalizeBarcode, pickExactProduct } from '@/utils/barcode';
import { weldstashKeys } from '@/lib/query-client';
import { prefetchWeldstashProduct, useWeldstashProducts } from '@/hooks/use-weldstash-queries';

export default function ProductsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { info, error: showError } = useToast();

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const productsQuery = useWeldstashProducts(query);
  const products = productsQuery.data?.data ?? [];
  const loading = productsQuery.isPending && products.length === 0;
  const error = productsQuery.error ? (productsQuery.error as Error).message : null;

  const handleSearchChange = (text: string) => {
    setSearch(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(text.trim()), 300);
  };

  const openExactOrStay = useCallback(
    async (code: string) => {
      const normalized = normalizeBarcode(code);
      if (!normalized) return;

      setSearch(normalized);
      setQuery(normalized);
      try {
        const response = await queryClient.fetchQuery({
          queryKey: weldstashKeys.productList(normalized),
          queryFn: () => appApi.products.list({ search: normalized, limit: 50 }),
        });
        const rows = response.data ?? [];
        const exact = pickExactProduct(rows, normalized);
        if (exact) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          prefetchWeldstashProduct(queryClient, exact.id);
          router.push(`/product/${exact.id}`);
        } else {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          info('No exact match — showing search results');
        }
      } catch (err) {
        showError((err as Error).message || 'Scan lookup failed');
      }
    },
    [queryClient, router, info, showError],
  );

  const hardwareScanner = useHardwareBarcodeScan((code) => {
    void openExactOrStay(code);
  });

  const onSubmitSearch = () => {
    const normalized = normalizeBarcode(search);
    if (!normalized) return;
    void openExactOrStay(normalized);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: colors.text }]}>Products</Text>
          <Pressable
            onPress={() => router.push('/product/new')}
            accessibilityRole="button"
            accessibilityLabel="New product"
            hitSlop={8}
            style={[styles.iconButton, { backgroundColor: colors.inputBackground }]}
          >
            <Plus size={20} color={colors.text} />
          </Pressable>
        </View>
        <SearchBar
          value={search}
          onChangeText={handleSearchChange}
          onSubmitEditing={onSubmitSearch}
          placeholder="Search or scan barcode"
          autoCorrect={false}
          autoCapitalize="none"
          onClear={() => {
            setSearch('');
            setQuery('');
          }}
        />
        <View style={styles.scanHint}>
          <ScanBarcode size={14} color={colors.mutedForeground} />
          <Text style={[styles.scanHintText, { color: colors.mutedForeground }]}>
            {hardwareScanner
              ? 'Zebra scanner ready — scan a barcode to open the product'
              : 'Scan into the search field, then press Enter'}
          </Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          contentContainerStyle={products.length === 0 ? styles.emptyList : styles.list}
          refreshControl={
            <RefreshControl
              refreshing={productsQuery.isRefetching && !productsQuery.isPending}
              onRefresh={() => {
                void productsQuery.refetch();
              }}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon={<Package size={36} color={colors.mutedForeground} />}
              title={query ? 'No matching products' : 'No products yet'}
              description={
                query
                  ? 'Create a product with this barcode, or try a different search.'
                  : 'Add a product, then scan its barcode to adjust stock.'
              }
              action={
                <Button
                  title={query ? 'Create product' : 'New product'}
                  onPress={() =>
                    router.push(query ? `/product/new?barcode=${encodeURIComponent(query)}` : '/product/new')
                  }
                />
              }
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPressIn={() => prefetchWeldstashProduct(queryClient, item.id)}
              onPress={() => router.push(`/product/${item.id}`)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? colors.pressed : colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {[item.sku, item.barcode].filter(Boolean).join(' · ') || 'No SKU or barcode'}
                </Text>
              </View>
              <Text style={[styles.qty, { color: colors.text }]}>{item.inventoryQuantity ?? 0}</Text>
            </Pressable>
          )}
        />
      )}

      {error ? (
        <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 34, fontWeight: '700' },
  iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  scanHint: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scanHintText: { fontSize: 13, flex: 1 },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 8 },
  emptyList: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, paddingRight: 12 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  qty: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  error: { paddingHorizontal: 16, paddingBottom: 16, fontSize: 13 },
});
