import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Minus, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { appApi } from '@/services/app-api';
import { pickDefaultWarehouse } from '@/utils/barcode';
import { warehouseOnHand } from '@/utils/stock';
import { weldstashKeys } from '@/lib/query-client';
import {
  useWeldstashProduct,
  useWeldstashStock,
  useWeldstashWarehouses,
} from '@/hooks/use-weldstash-queries';
import { useStockAdjuster } from '@/hooks/use-stock-adjuster';

export default function ProductDetailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { error: showError } = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();

  const productQuery = useWeldstashProduct(id);
  const stockQuery = useWeldstashStock(id);
  const warehouseQuery = useWeldstashWarehouses();

  const product = productQuery.data?.data ?? null;
  const stock = stockQuery.data?.data ?? [];
  const warehouses = warehouseQuery.data?.data ?? [];

  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [amount, setAmount] = useState('1');
  const [reason, setReason] = useState('Adjusted from WeldStash');
  const [newWarehouseName, setNewWarehouseName] = useState('');
  const [creatingWarehouse, setCreatingWarehouse] = useState(false);

  useEffect(() => {
    setWarehouseId((current) => current ?? pickDefaultWarehouse(warehouses)?.id ?? null);
  }, [warehouses]);

  const { applyDelta, syncing } = useStockAdjuster({
    productId: id,
    warehouseId,
    reason,
    onError: showError,
  });

  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId) ?? null;
  const onHand = warehouseOnHand(stock, warehouseId);
  const selectedStockCount = stock.filter((row) => row.warehouseId === warehouseId).length;

  const applyAmount = () => {
    const parsed = Number.parseInt(amount, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
      showError('Enter a non-zero quantity');
      return;
    }
    if (!applyDelta(parsed)) {
      showError('Not enough stock to decrease');
    }
  };

  const createWarehouse = async () => {
    if (!newWarehouseName.trim()) {
      showError('Warehouse name is required');
      return;
    }
    setCreatingWarehouse(true);
    try {
      const created = await appApi.warehouses.create({
        name: newWarehouseName.trim(),
        isDefault: warehouses.length === 0,
        isActive: true,
      });
      setNewWarehouseName('');
      setWarehouseId(created.data.id);
      await queryClient.invalidateQueries({ queryKey: weldstashKeys.warehouses() });
    } catch (err) {
      showError((err as Error).message || 'Failed to create warehouse');
    } finally {
      setCreatingWarehouse(false);
    }
  };

  const loading = !product && (productQuery.isPending || stockQuery.isPending || warehouseQuery.isPending);

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!product) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <EmptyState title="Product not found" action={<Button title="Back" onPress={() => router.back()} />} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {product.name}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Meta label="SKU" value={product.sku || '—'} colors={colors} />
          <Meta label="Barcode" value={product.barcode || '—'} colors={colors} />
          <Meta label="Total on hand" value={String(product.inventoryQuantity ?? 0)} colors={colors} last />
        </View>

        {warehouses.length === 0 ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, gap: 12 }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Warehouse</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>
              Create a warehouse to hold this product’s stock.
            </Text>
            <Input
              label="Warehouse name"
              value={newWarehouseName}
              onChangeText={setNewWarehouseName}
              placeholder="Main warehouse"
            />
            <Button title="Create warehouse" loading={creatingWarehouse} onPress={() => void createWarehouse()} />
          </View>
        ) : (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Warehouse</Text>
            <View style={styles.chipRow}>
              {warehouses.map((warehouse) => {
                const selected = warehouse.id === warehouseId;
                return (
                  <Pressable
                    key={warehouse.id}
                    onPress={() => setWarehouseId(warehouse.id)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: selected ? colors.text : colors.inputBackground,
                      },
                    ]}
                  >
                    <Text style={{ color: selected ? colors.background : colors.text, fontWeight: '600' }}>
                      {warehouse.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.onHandLabel, { color: colors.mutedForeground }]}>
                On hand{selectedWarehouse ? ` · ${selectedWarehouse.name}` : ''}
              </Text>
              <View style={styles.onHandRow}>
                <Text style={[styles.onHandValue, { color: colors.text }]}>{onHand}</Text>
                {syncing ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
              </View>
              {selectedStockCount > 1 ? (
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                  Across {selectedStockCount} locations / lots
                </Text>
              ) : null}

              <View style={styles.stepper}>
                <Pressable
                  onPress={() => applyDelta(-1)}
                  accessibilityRole="button"
                  accessibilityLabel="Decrease stock by 1"
                  style={[styles.stepperBtn, { borderColor: colors.border }]}
                >
                  <Minus size={22} color={colors.text} />
                </Pressable>
                <Pressable
                  onPress={() => applyDelta(1)}
                  accessibilityRole="button"
                  accessibilityLabel="Increase stock by 1"
                  style={[styles.stepperBtn, { borderColor: colors.border }]}
                >
                  <Plus size={22} color={colors.text} />
                </Pressable>
              </View>
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, gap: 12 }]}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Adjust by amount</Text>
              <Input
                label="Quantity (use a negative number to decrease)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="numbers-and-punctuation"
              />
              <Input label="Reason" value={reason} onChangeText={setReason} />
              <Button title="Apply adjustment" onPress={applyAmount} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Meta({
  label,
  value,
  colors,
  last,
}: {
  label: string;
  value: string;
  colors: { text: string; mutedForeground: string; divider: string };
  last?: boolean;
}) {
  return (
    <View style={[styles.metaRow, !last && { borderBottomColor: colors.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[styles.metaLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  title: { fontSize: 20, fontWeight: '700', flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 32, gap: 16 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  onHandLabel: { fontSize: 13, fontWeight: '500' },
  onHandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 4 },
  onHandValue: { fontSize: 40, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stepper: { flexDirection: 'row', gap: 12, marginTop: 12 },
  stepperBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, gap: 12 },
  metaLabel: { fontSize: 14 },
  metaValue: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
