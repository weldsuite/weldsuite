import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useWms } from '@/contexts/WmsContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import type { InventoryDto, InventoryAdjustmentReason } from '@/types/wms';
import { calculateStockStatus, formatDate, formatRelativeTime, formatMoney } from '@/utils/wms-helpers';

const STOCK_STATUS_CONFIG = {
  in_stock: {
    label: 'In Stock',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  low_stock: {
    label: 'Low Stock',
    color: '#92400E',
    backgroundColor: '#FEF3C7',
  },
  out_of_stock: {
    label: 'Out of Stock',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
  },
};

const ADJUSTMENT_REASONS: { value: InventoryAdjustmentReason; label: string }[] = [
  { value: 'restock', label: 'Restock' },
  { value: 'sale', label: 'Sale' },
  { value: 'damage', label: 'Damage' },
  { value: 'loss', label: 'Loss' },
  { value: 'found', label: 'Found' },
  { value: 'correction', label: 'Correction' },
  { value: 'return', label: 'Return' },
  { value: 'other', label: 'Other' },
];

export default function InventoryScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [inventory, setInventory] = useState<InventoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [adjustStockModalVisible, setAdjustStockModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryDto | null>(null);
  const [adjustmentQuantity, setAdjustmentQuantity] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState<InventoryAdjustmentReason>('correction');
  const [adjustmentNotes, setAdjustmentNotes] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  // Stats
  const [totalItems, setTotalItems] = useState(0);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [outOfStockCount, setOutOfStockCount] = useState(0);

  useEffect(() => {
    loadInventory();
  }, [selectedStatus, showLowStockOnly]);

  const loadInventory = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (showLowStockOnly) {
        filters.lowStock = true;
      }

      const response = await api.getInventoryItems(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const inventory = Array.isArray(items) ? items : [];
        setInventory(inventory);

        // Calculate stats
        setTotalItems(inventory.length);
        setLowStockCount(
          inventory.filter((item) =>
            item.quantityOnHand > 0 && item.quantityOnHand <= item.reorderPoint
          ).length
        );
        setOutOfStockCount(
          inventory.filter((item) => item.quantityOnHand === 0).length
        );
      } else {
        throw new Error(response.error || 'Failed to load inventory');
      }
    } catch (error) {
      console.error('Error loading inventory:', error);
      toast.error('Failed to load inventory data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus, showLowStockOnly]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadInventory();
  }, [loadInventory]);

  const handleItemPress = (item: InventoryDto) => {
    // Navigate to inventory detail page
    // router.push(`/wms/inventory/${item.id}` as any);
    handleAdjustStock(item); // For now, open stock adjustment modal
  };

  const handleAdjustStock = (item: InventoryDto) => {
    setSelectedItem(item);
    setAdjustmentQuantity('');
    setAdjustmentReason('correction');
    setAdjustmentNotes('');
    setAdjustStockModalVisible(true);
  };

  const confirmStockAdjustment = async () => {
    if (!selectedItem || !adjustmentQuantity) {
      toast.error('Please enter a quantity');
      return;
    }

    // Remove any plus signs and parse the number
    const quantity = parseInt(adjustmentQuantity.replace(/\+/g, ''));
    if (isNaN(quantity) || quantity === 0) {
      toast.error('Please enter a valid non-zero quantity');
      return;
    }

    try {
      setAdjusting(true);

      const response = await api.adjustInventory({
        inventoryItemId: selectedItem.id,
        quantityChange: quantity,
        type: adjustmentReason,
        reason: adjustmentNotes || 'Manual adjustment',
        notes: adjustmentNotes || undefined,
      });

      if (response.success) {
        toast.success(`Stock adjusted for ${selectedItem.productName}`);
        setAdjustStockModalVisible(false);
        setSelectedItem(null);
        // Reload inventory to get updated data
        await loadInventory();
      } else {
        throw new Error(response.error || 'Failed to adjust stock');
      }
    } catch (error) {
      console.error('Error adjusting stock:', error);
      toast.error('Failed to adjust stock. Please try again.');
    } finally {
      setAdjusting(false);
    }
  };

  // Filter inventory based on search query
  const filteredInventory = inventory.filter((item) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      item.productName.toLowerCase().includes(query) ||
      item.productSku.toLowerCase().includes(query) ||
      item.location?.name?.toLowerCase().includes(query)
    );
  });

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Items', count: totalItems },
      { key: 'in_stock', label: 'In Stock', count: totalItems - lowStockCount - outOfStockCount },
      { key: 'low_stock', label: 'Low Stock', count: lowStockCount },
      { key: 'out_of_stock', label: 'Out of Stock', count: outOfStockCount },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((option) => (
            <TouchableOpacity
              key={option.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedStatus === option.key ? colors.text : colors.background,
                  borderColor: selectedStatus === option.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedStatus(option.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedStatus === option.key ? colors.background : colors.text }
                ]}
              >
                {option.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedStatus === option.key ? colors.background : colors.muted }
                ]}
              >
                ({option.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderInventoryItem = ({ item }: { item: InventoryDto }) => {
    const stockStatus = calculateStockStatus(
      item.quantityOnHand,
      item.reorderPoint,
      item.reorderQuantity
    );
    const statusConfig = STOCK_STATUS_CONFIG[stockStatus.status];

    return (
      <TouchableOpacity
        style={[styles.inventoryItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleItemPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.itemContent}>
          <View style={styles.itemLeft}>
            <Text style={[styles.productName, { color: colors.text }]}>{item.productName}</Text>
            <Text style={[styles.productSku, { color: colors.muted }]}>SKU: {item.productSku}</Text>
            <View style={styles.stockRow}>
              <Text style={[styles.stockInfo, { color: colors.muted }]}>
                {item.location?.name || 'No location'} • Reorder at {item.reorderPoint} units
              </Text>
            </View>
            {item.quantityReserved > 0 && (
              <Text style={[styles.reservedInfo, { color: colors.muted }]}>
                {item.quantityReserved} reserved • {item.quantityAvailable} available
              </Text>
            )}
          </View>
          <View style={styles.itemRight}>
            <Text style={[styles.stockValue, { color: colors.text }]}>{item.quantityOnHand} units</Text>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
            {item.unitCost && (
              <Text style={[styles.costText, { color: colors.muted }]}>
                {formatMoney(item.unitCost.amount, item.unitCost.currency)} / unit
              </Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.muted }]}>No inventory items found</Text>
    </View>
  );

  if (loading && inventory.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading inventory...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Inventory ({filteredInventory.length})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search products, SKU, supplier..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={filteredInventory}
        renderItem={renderInventoryItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />

      {/* Stock Adjustment Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={adjustStockModalVisible}
        onRequestClose={() => setAdjustStockModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <ScrollView
            style={styles.modalScrollView}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Adjust Stock</Text>
              {selectedItem && (
                <>
                  <Text style={[styles.modalSubtitle, { color: colors.text }]}>
                    {selectedItem.productName}
                  </Text>
                  <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                    Current: {selectedItem.quantityOnHand} units
                  </Text>
                </>
              )}

              <View style={styles.inputContainer}>
                <Text style={[styles.inputLabel, { color: colors.text }]}>Quantity Change</Text>
                <TextInput
                  style={[styles.textInput, { borderColor: colors.divider, color: colors.text }]}
                  placeholder="e.g., +10 or -5"
                  placeholderTextColor={colors.muted}
                  value={adjustmentQuantity}
                  onChangeText={setAdjustmentQuantity}
                  keyboardType="numbers-and-punctuation"
                />
                <Text style={[styles.inputHint, { color: colors.muted }]}>
                  Use + for increase, - for decrease
                </Text>
              </View>

              <View style={styles.inputContainer}>
                <Text style={[styles.inputLabel, { color: colors.text }]}>Reason</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.reasonScroll}
                  contentContainerStyle={styles.reasonList}
                >
                  {ADJUSTMENT_REASONS.map((reason) => (
                    <TouchableOpacity
                      key={reason.value}
                      style={[
                        styles.reasonChip,
                        {
                          backgroundColor: adjustmentReason === reason.value ? colors.text : colors.background,
                          borderColor: colors.buttonBorder,
                        }
                      ]}
                      onPress={() => setAdjustmentReason(reason.value)}
                    >
                      <Text
                        style={[
                          styles.reasonChipText,
                          { color: adjustmentReason === reason.value ? colors.background : colors.text }
                        ]}
                      >
                        {reason.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              <View style={styles.inputContainer}>
                <Text style={[styles.inputLabel, { color: colors.text }]}>Notes (Optional)</Text>
                <TextInput
                  style={[styles.textInput, styles.textInputMultiline, { borderColor: colors.divider, color: colors.text }]}
                  placeholder="Additional notes..."
                  placeholderTextColor={colors.muted}
                  value={adjustmentNotes}
                  onChangeText={setAdjustmentNotes}
                  multiline
                  numberOfLines={3}
                />
              </View>

              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalCancelButton, { borderColor: colors.divider }]}
                  onPress={() => setAdjustStockModalVisible(false)}
                  disabled={adjusting}
                >
                  <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.modalConfirmButton, { backgroundColor: colors.text }]}
                  onPress={confirmStockAdjustment}
                  disabled={adjusting}
                >
                  {adjusting ? (
                    <ActivityIndicator size="small" color={colors.background} />
                  ) : (
                    <Text style={[styles.modalConfirmText, { color: colors.background }]}>Confirm</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  searchContainer: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 24,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterButtonCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  warehouseText: {
    fontSize: 14,
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  inventoryItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  itemContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemLeft: {
    flex: 1,
    gap: 2,
  },
  itemRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  productName: {
    fontSize: 15,
    fontWeight: '600',
  },
  productSku: {
    fontSize: 14,
    fontWeight: '400',
  },
  stockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  stockInfo: {
    fontSize: 12,
  },
  reservedInfo: {
    fontSize: 11,
    marginTop: 2,
  },
  separator: {
    fontSize: 12,
  },
  stockValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  costText: {
    fontSize: 11,
    marginTop: 4,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalScrollView: {
    flex: 1,
  },
  modalScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  inputContainer: {
    marginTop: 16,
    marginBottom: 8,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  inputHint: {
    fontSize: 12,
    marginTop: 4,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  textInputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  reasonScroll: {
    marginTop: 4,
  },
  reasonList: {
    flexDirection: 'row',
    gap: 8,
  },
  reasonChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  reasonChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalConfirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalConfirmText: {
    fontSize: 14,
    fontWeight: '500',
  },
});