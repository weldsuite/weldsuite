import React, { useState, useEffect } from 'react';
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
import { useToast } from '@/contexts/ToastContext';
import { api } from '@/services/api';

interface InventoryItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  currentStock: number;
  reservedStock: number;
  availableStock: number;
  reorderLevel: number;
  reorderQuantity: number;
  unitCost: number;
  lastRestocked: string;
  supplier?: string;
  location?: string;
  category: string;
  status: 'in_stock' | 'low_stock' | 'out_of_stock';
}

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

export default function InventoryScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [filteredInventory, setFilteredInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [adjustStockModalVisible, setAdjustStockModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [adjustmentQuantity, setAdjustmentQuantity] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');

  useEffect(() => {
    loadInventory();
  }, []);

  useEffect(() => {
    filterInventory();
  }, [searchQuery, selectedStatus, inventory]);

  const loadInventory = async () => {
    try {
      setLoading(true);

      const response = await api.getInventory({
        limit: 100,
      });

      if (response.success && response.data) {
        const apiInventory = response.data.items || [];

        // Map API inventory to screen InventoryItem interface
        const mappedInventory: InventoryItem[] = apiInventory.map((item) => ({
          id: item.id,
          productId: item.productId,
          productName: item.productName,
          sku: item.sku,
          currentStock: item.currentStock,
          reservedStock: item.reservedStock,
          availableStock: item.availableStock,
          reorderLevel: item.reorderLevel,
          reorderQuantity: item.reorderQuantity,
          unitCost: item.unitCost,
          lastRestocked: item.lastRestocked || new Date().toISOString(),
          supplier: item.supplier,
          location: item.location,
          category: item.category,
          status: item.status,
        }));

        setInventory(mappedInventory);
        setFilteredInventory(mappedInventory);
      } else {
        toast.error(response.error || 'Failed to load inventory');
      }
    } catch (error) {
      console.error('Error loading inventory:', error);
      toast.error('Failed to load inventory');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterInventory = () => {
    let filtered = [...inventory];

    // Status filter
    if (selectedStatus) {
      filtered = filtered.filter((item) => item.status === selectedStatus);
    }

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter((item) =>
        item.productName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.supplier?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    setFilteredInventory(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadInventory();
  };

  const handleItemPress = (item: InventoryItem) => {
    // Navigate to inventory detail page
    // router.push(`/inventory/${item.id}` as any);
    handleAdjustStock(item); // For now, open stock adjustment modal
  };

  const handleAdjustStock = (item: InventoryItem) => {
    setSelectedItem(item);
    setAdjustmentQuantity('');
    setAdjustmentReason('');
    setAdjustStockModalVisible(true);
  };

  const confirmStockAdjustment = async () => {
    if (!selectedItem || !adjustmentQuantity || !adjustmentReason) {
      toast.error('Please fill in all fields');
      return;
    }

    const quantity = parseInt(adjustmentQuantity);
    if (isNaN(quantity)) {
      toast.error('Please enter a valid quantity');
      return;
    }

    try {
      const response = await api.adjustStock(selectedItem.id, quantity, adjustmentReason);

      if (response.success) {
        // Reload inventory to get updated data
        await loadInventory();

        setAdjustStockModalVisible(false);
        setSelectedItem(null);
        toast.success(`Stock adjusted for ${selectedItem.productName}`);
      } else {
        toast.error(response.error || 'Failed to adjust stock');
      }
    } catch (error) {
      console.error('Error adjusting stock:', error);
      toast.error('Failed to adjust stock');
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Items', count: filteredInventory.length },
      { key: 'in_stock', label: 'In Stock', count: inventory.filter(i => i.status === 'in_stock').length },
      { key: 'low_stock', label: 'Low Stock', count: inventory.filter(i => i.status === 'low_stock').length },
      { key: 'out_of_stock', label: 'Out of Stock', count: inventory.filter(i => i.status === 'out_of_stock').length },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedStatus === item.key ? colors.text : colors.background,
                  borderColor: selectedStatus === item.key ? colors.text : colors.divider,
                }
              ]}
              onPress={() => setSelectedStatus(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedStatus === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedStatus === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderInventoryItem = ({ item }: { item: InventoryItem }) => {
    const statusConfig = STOCK_STATUS_CONFIG[item.status];

    return (
      <TouchableOpacity
        style={[styles.inventoryItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleItemPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.itemContent}>
          <View style={styles.itemLeft}>
            <Text style={[styles.productName, { color: colors.text }]}>{item.productName}</Text>
            <Text style={[styles.productSku, { color: colors.muted }]}>SKU: {item.sku}</Text>
            <View style={styles.stockRow}>
              <Text style={[styles.stockInfo, { color: colors.muted }]}>
                Reorder at {item.reorderLevel} units
              </Text>
            </View>
          </View>
          <View style={styles.itemRight}>
            <Text style={[styles.stockValue, { color: colors.text }]}>{item.currentStock} units</Text>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
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

  if (loading) {
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
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Adjust Stock</Text>
            {selectedItem && (
              <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                {selectedItem.productName} (Current: {selectedItem.currentStock})
              </Text>
            )}

            <View style={styles.inputContainer}>
              <Text style={[styles.inputLabel, { color: colors.text }]}>Quantity Change</Text>
              <TextInput
                style={[styles.textInput, { borderColor: colors.divider, color: colors.text }]}
                placeholder="e.g., +10 or -5"
                placeholderTextColor={colors.muted}
                value={adjustmentQuantity}
                onChangeText={setAdjustmentQuantity}
                keyboardType="numeric"
              />
            </View>

            <View style={styles.inputContainer}>
              <Text style={[styles.inputLabel, { color: colors.text }]}>Reason</Text>
              <TextInput
                style={[styles.textInput, { borderColor: colors.divider, color: colors.text }]}
                placeholder="Reason for adjustment"
                placeholderTextColor={colors.muted}
                value={adjustmentReason}
                onChangeText={setAdjustmentReason}
                multiline
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelButton, { borderColor: colors.divider }]}
                onPress={() => setAdjustStockModalVisible(false)}
              >
                <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalConfirmButton, { backgroundColor: colors.text }]}
                onPress={confirmStockAdjustment}
              >
                <Text style={[styles.modalConfirmText, { color: colors.background }]}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
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
  separator: {
    fontSize: 12,
  },
  stockValue: {
    fontSize: 16,
    fontWeight: '600',
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
    marginBottom: 20,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  inputContainer: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
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