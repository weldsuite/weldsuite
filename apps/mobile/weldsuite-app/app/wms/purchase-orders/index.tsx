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
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useWms } from '@/contexts/WmsContext';
import api from '@/services/api';
import type { PurchaseOrderDto, PurchaseOrderStatus } from '@/types/wms';
import {
  getPurchaseOrderStatusColor,
  formatDate,
  formatRelativeTime,
  formatMoney,
} from '@/utils/wms-helpers';
import { ChevronLeft, Search, FileText, Package, User, Calendar } from 'lucide-react-native';

const STATUS_OPTIONS: { key: PurchaseOrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'ordered', label: 'Ordered' },
  { key: 'partially_received', label: 'Partial' },
  { key: 'received', label: 'Received' },
  { key: 'cancelled', label: 'Cancelled' },
];

export default function PurchaseOrdersListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { } = useWms();

  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<PurchaseOrderStatus | 'all'>('all');
  const [totalPOs, setTotalPOs] = useState(0);

  useEffect(() => {
    loadPurchaseOrders();
  }, [selectedStatus]);

  const loadPurchaseOrders = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (selectedStatus !== 'all') {
        filters.status = selectedStatus;
      }

      const response = await api.getPurchaseOrders(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const purchaseOrders = Array.isArray(items) ? items : [];
        setPurchaseOrders(purchaseOrders);
        setTotalPOs(purchaseOrders.length);
      } else {
        throw new Error(response.error || 'Failed to load purchase orders');
      }
    } catch (error) {
      console.error('Error loading purchase orders:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPurchaseOrders();
  }, [loadPurchaseOrders]);

  const handlePOPress = (po: PurchaseOrderDto) => {
    router.push(`/wms/purchase-orders/${po.id}` as any);
  };

  // Filter purchase orders based on search query
  const filteredPOs = purchaseOrders.filter((po) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      po.poNumber.toLowerCase().includes(query) ||
      po.supplierName.toLowerCase().includes(query) ||
      po.id.toLowerCase().includes(query)
    );
  });

  const renderStatusFilter = () => (
    <View style={styles.filterSection}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterList}
      >
        {STATUS_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.key}
            style={[
              styles.filterChip,
              {
                backgroundColor: selectedStatus === option.key ? colors.text : colors.background,
                borderColor: colors.buttonBorder,
              },
            ]}
            onPress={() => setSelectedStatus(option.key)}
          >
            <Text
              style={[
                styles.filterChipText,
                { color: selectedStatus === option.key ? colors.background : colors.text },
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderPOItem = ({ item }: { item: PurchaseOrderDto }) => {
    const statusColor = getPurchaseOrderStatusColor(item.status);

    return (
      <TouchableOpacity
        style={[styles.poItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handlePOPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.poHeader}>
          <View style={styles.poHeaderLeft}>
            <Text style={[styles.poNumber, { color: colors.text }]}>{item.poNumber}</Text>
            <View style={styles.supplierInfo}>
              <User size={12} color={colors.muted} />
              <Text style={[styles.supplierText, { color: colors.muted }]}>
                {item.supplierName}
              </Text>
            </View>
          </View>
          <View style={styles.poHeaderRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {item.status.replace(/_/g, ' ')}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.poDetails}>
          <View style={styles.detailRow}>
            <Package size={14} color={colors.muted} />
            <Text style={[styles.detailText, { color: colors.muted }]}>
              {item.items.length} items
            </Text>
          </View>
          {item.expectedDeliveryDate && (
            <View style={styles.detailRow}>
              <Calendar size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]}>
                Expected: {formatDate(item.expectedDeliveryDate)}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.poFooter}>
          <Text style={[styles.poTime, { color: colors.muted }]}>
            Created {formatRelativeTime(item.createdAt)}
          </Text>
          <Text style={[styles.poTotal, { color: colors.text }]}>
            {formatMoney(item.total.amount, item.total.currency)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <FileText size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyText, { color: colors.muted }]}>No purchase orders found</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Purchase orders will appear here when they are created
      </Text>
    </View>
  );

  if (loading && purchaseOrders.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading purchase orders...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Purchase Orders</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={[styles.poCount, { color: colors.muted }]}>
          {filteredPOs.length} {filteredPOs.length === 1 ? 'order' : 'orders'}
        </Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by PO #, supplier..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {/* Status Filter */}
      <View style={[styles.filtersContainer, { borderBottomColor: colors.divider }]}>
        {renderStatusFilter()}
      </View>

      {/* Purchase Orders List */}
      <FlatList
        data={filteredPOs}
        renderItem={renderPOItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.tint} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />
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
    marginTop: 12,
    fontSize: 14,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
  },
  warehouseText: {
    fontSize: 14,
    marginTop: 4,
  },
  poCount: {
    fontSize: 14,
    marginTop: 4,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filtersContainer: {
    borderBottomWidth: 0.5,
    paddingVertical: 12,
  },
  filterSection: {
    paddingHorizontal: 16,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  listContainer: {
    paddingBottom: 20,
  },
  poItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  poHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  poHeaderLeft: {
    flex: 1,
  },
  poHeaderRight: {
    marginLeft: 12,
  },
  poNumber: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  supplierInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  supplierText: {
    fontSize: 13,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  poDetails: {
    gap: 8,
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailText: {
    fontSize: 13,
  },
  poFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  poTime: {
    fontSize: 12,
  },
  poTotal: {
    fontSize: 14,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
});
