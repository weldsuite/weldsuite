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
import type { WmsOrderDto, OrderStatus, OrderPriority } from '@/types/wms';
import {
  getOrderStatusColor,
  getPriorityColor,
  formatDate,
  formatRelativeTime,
  formatMoney,
} from '@/utils/wms-helpers';
import { ChevronLeft, Search, Filter, ShoppingCart, AlertCircle } from 'lucide-react-native';

const ORDER_STATUS_OPTIONS: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'processing', label: 'Processing' },
  { key: 'ready_for_pickup', label: 'Ready' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_OPTIONS: { key: OrderPriority | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'low', label: 'Low' },
  { key: 'normal', label: 'Normal' },
  { key: 'high', label: 'High' },
  { key: 'urgent', label: 'Urgent' },
];

export default function OrdersListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { } = useWms();

  const [orders, setOrders] = useState<WmsOrderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | 'all'>('all');
  const [selectedPriority, setSelectedPriority] = useState<OrderPriority | 'all'>('all');
  const [totalOrders, setTotalOrders] = useState(0);

  useEffect(() => {
    loadOrders();
  }, [selectedStatus, selectedPriority]);

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (selectedStatus !== 'all') {
        filters.status = selectedStatus;
      }

      if (selectedPriority !== 'all') {
        filters.priority = selectedPriority;
      }

      const response = await api.getWmsOrders(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const orders = Array.isArray(items) ? items : [];
        setOrders(orders);
        setTotalOrders(orders.length);
      } else {
        throw new Error(response.error || 'Failed to load orders');
      }
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus, selectedPriority]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadOrders();
  }, [loadOrders]);

  const handleOrderPress = (order: WmsOrderDto) => {
    router.push(`/wms/orders/${order.id}` as any);
  };

  // Filter orders based on search query
  const filteredOrders = orders.filter((order) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      order.orderNumber.toLowerCase().includes(query) ||
      order.customerName.toLowerCase().includes(query) ||
      order.id.toLowerCase().includes(query)
    );
  });

  const renderStatusFilter = () => (
    <View style={styles.filterSection}>
      <Text style={[styles.filterLabel, { color: colors.text }]}>Status</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterList}
      >
        {ORDER_STATUS_OPTIONS.map((option) => (
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

  const renderPriorityFilter = () => (
    <View style={styles.filterSection}>
      <Text style={[styles.filterLabel, { color: colors.text }]}>Priority</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterList}
      >
        {PRIORITY_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.key}
            style={[
              styles.filterChip,
              {
                backgroundColor: selectedPriority === option.key ? colors.text : colors.background,
                borderColor: colors.buttonBorder,
              },
            ]}
            onPress={() => setSelectedPriority(option.key)}
          >
            <Text
              style={[
                styles.filterChipText,
                { color: selectedPriority === option.key ? colors.background : colors.text },
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderOrderItem = ({ item }: { item: WmsOrderDto }) => {
    const statusColor = getOrderStatusColor(item.status);
    const priorityColor = getPriorityColor(item.priority);

    return (
      <TouchableOpacity
        style={[styles.orderItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleOrderPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.orderHeader}>
          <View style={styles.orderHeaderLeft}>
            <Text style={[styles.orderNumber, { color: colors.text }]}>{item.orderNumber}</Text>
            <Text style={[styles.customerName, { color: colors.muted }]}>{item.customerName}</Text>
          </View>
          <View style={styles.orderHeaderRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {item.status.replace(/_/g, ' ')}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.orderDetails}>
          <View style={styles.orderDetailRow}>
            <View style={styles.orderDetailItem}>
              <Text style={[styles.orderDetailLabel, { color: colors.muted }]}>Items</Text>
              <Text style={[styles.orderDetailValue, { color: colors.text }]}>
                {item.items.reduce((sum, i) => sum + i.quantity, 0)}
              </Text>
            </View>
            <View style={styles.orderDetailItem}>
              <Text style={[styles.orderDetailLabel, { color: colors.muted }]}>Priority</Text>
              <View style={[styles.priorityBadge, { backgroundColor: priorityColor + '20' }]}>
                <Text style={[styles.priorityText, { color: priorityColor }]}>
                  {item.priority}
                </Text>
              </View>
            </View>
            <View style={styles.orderDetailItem}>
              <Text style={[styles.orderDetailLabel, { color: colors.muted }]}>Total</Text>
              <Text style={[styles.orderDetailValue, { color: colors.text }]}>
                {formatMoney(item.total.amount, item.total.currency)}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.orderFooter}>
          <Text style={[styles.orderTime, { color: colors.muted }]}>
            {formatRelativeTime(item.createdAt)}
          </Text>
          {item.requiresShipping && (
            <View style={styles.shippingBadge}>
              <AlertCircle size={12} color={colors.muted} />
              <Text style={[styles.shippingText, { color: colors.muted }]}>Shipping required</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <ShoppingCart size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyText, { color: colors.muted }]}>No orders found</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Orders will appear here when they are created
      </Text>
    </View>
  );

  if (loading && orders.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading orders...</Text>
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
          <Text style={[styles.headerTitle, { color: colors.text }]}>Orders</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={[styles.orderCount, { color: colors.muted }]}>
          {filteredOrders.length} {filteredOrders.length === 1 ? 'order' : 'orders'}
        </Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by order #, customer..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.filtersContainer, { borderBottomColor: colors.divider }]}
      >
        <View style={styles.filtersContent}>
          {renderStatusFilter()}
          {renderPriorityFilter()}
        </View>
      </ScrollView>

      {/* Orders List */}
      <FlatList
        data={filteredOrders}
        renderItem={renderOrderItem}
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
  orderCount: {
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
  filtersContent: {
    paddingHorizontal: 16,
    gap: 16,
  },
  filterSection: {
    marginBottom: 8,
  },
  filterLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
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
  orderItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  orderHeaderLeft: {
    flex: 1,
  },
  orderHeaderRight: {
    marginLeft: 12,
  },
  orderNumber: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  customerName: {
    fontSize: 14,
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
  orderDetails: {
    marginBottom: 12,
  },
  orderDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  orderDetailItem: {
    flex: 1,
  },
  orderDetailLabel: {
    fontSize: 11,
    marginBottom: 4,
  },
  orderDetailValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  priorityText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderTime: {
    fontSize: 12,
  },
  shippingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  shippingText: {
    fontSize: 11,
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
