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
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { ShoppingCart } from 'lucide-react-native';
import api from '@/services/api';

interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

interface Money {
  amount: number;
  currency: string;
  formatted: string;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  priority: string;
  paymentStatus: string;
  customerId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  shippingAddress?: Address;
  subtotal?: Money;
  shippingCost?: Money;
  tax?: Money;
  total?: Money;
  carrierId?: string;
  serviceType?: string;
  trackingNumber?: string;
  parcelId?: string;
  shippedAt?: string;
  estimatedDeliveryDate?: string;
  deliveredAt?: string;
  customerNotes?: string;
  internalNotes?: string;
  createdAt: string;
  updatedAt?: string;
}

const ORDER_STATUS_CONFIG: Record<string, { label: string; color: string; backgroundColor: string }> = {
  Pending: {
    label: 'Pending',
    color: '#92400E',
    backgroundColor: '#FEF3C7',
  },
  Processing: {
    label: 'Processing',
    color: '#7C3AED',
    backgroundColor: '#F3E8FF',
  },
  Shipped: {
    label: 'Shipped',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
  },
  Delivered: {
    label: 'Delivered',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  Cancelled: {
    label: 'Cancelled',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
  },
  OnHold: {
    label: 'On Hold',
    color: '#B45309',
    backgroundColor: '#FEF3C7',
  },
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  Low: { label: 'Low', color: '#6B7280' },
  Normal: { label: 'Normal', color: '#3B82F6' },
  High: { label: 'High', color: '#F59E0B' },
  Urgent: { label: 'Urgent', color: '#EF4444' },
};

export default function OrdersScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadOrders();
  }, []);

  useEffect(() => {
    filterOrders();
  }, [selectedStatus, searchQuery, orders]);

  const loadOrders = async () => {
    try {
      setLoading(true);
      const response = await api.getParcelOrders({
        status: selectedStatus || undefined,
        search: searchQuery || undefined
      });

      if (response.success && response.data) {
        setOrders(response.data.items);
        setFilteredOrders(response.data.items);
      }
    } catch (error) {
      console.error('Error loading orders:', error);
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterOrders = () => {
    let filtered = [...orders];

    if (selectedStatus) {
      filtered = filtered.filter((o) => o.status === selectedStatus);
    }

    if (searchQuery) {
      filtered = filtered.filter((o) =>
        o.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        o.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        o.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (o.trackingNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
      );
    }

    setFilteredOrders(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadOrders();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Orders', count: orders.length },
      { key: 'Pending', label: 'Pending', count: orders.filter(o => o.status === 'Pending').length },
      { key: 'Processing', label: 'Processing', count: orders.filter(o => o.status === 'Processing').length },
      { key: 'Shipped', label: 'Shipped', count: orders.filter(o => o.status === 'Shipped').length },
      { key: 'Delivered', label: 'Delivered', count: orders.filter(o => o.status === 'Delivered').length },
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
                  borderColor: selectedStatus === item.key ? colors.text : colors.buttonBorder,
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

  const renderOrder = ({ item }: { item: Order }) => {
    const statusConfig = ORDER_STATUS_CONFIG[item.status] || ORDER_STATUS_CONFIG.Pending;
    const priorityConfig = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG.Normal;

    return (
      <TouchableOpacity
        style={[styles.orderItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        activeOpacity={0.7}
      >
        <View style={styles.orderContent}>
          <View style={styles.orderLeft}>
            <View style={styles.orderHeader}>
              <Text style={[styles.orderNumber, { color: colors.text }]}>{item.orderNumber}</Text>
              {item.priority && item.priority !== 'Normal' && (
                <View style={[styles.priorityBadge, { borderColor: priorityConfig.color }]}>
                  <Text style={[styles.priorityText, { color: priorityConfig.color }]}>
                    {priorityConfig.label}
                  </Text>
                </View>
              )}
            </View>
            <Text style={[styles.customerName, { color: colors.muted }]}>{item.customerName}</Text>
            {item.shippingAddress && (
              <Text style={[styles.shippingAddress, { color: colors.muted }]} numberOfLines={1}>
                {item.shippingAddress.city}, {item.shippingAddress.country}
              </Text>
            )}
            <Text style={[styles.orderInfo, { color: colors.muted }]}>
              {formatDate(item.createdAt)}
            </Text>
          </View>
          <View style={styles.orderRight}>
            {item.total && (
              <Text style={[styles.orderTotal, { color: colors.text }]}>
                {item.total.formatted}
              </Text>
            )}
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
            {item.trackingNumber && (
              <Text style={[styles.trackingNumber, { color: colors.muted }]} numberOfLines={1}>
                {item.trackingNumber}
              </Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <View style={[styles.iconContainer, { backgroundColor: '#F3F4F6' }]}>
        <ShoppingCart size={32} color="#9CA3AF" strokeWidth={1.5} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No Orders Yet</Text>
      <Text style={[styles.emptyDescription, { color: colors.muted }]}>
        {searchQuery || selectedStatus
          ? 'No orders match your filters'
          : 'Orders will appear here once they are created'
        }
      </Text>
    </View>
  );

  if (loading) {
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
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Orders ({filteredOrders.length})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search orders..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={filteredOrders}
        renderItem={renderOrder}
        keyExtractor={(item) => item.id}
        contentContainerStyle={filteredOrders.length === 0 ? styles.emptyListContainer : styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
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
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
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
  listContainer: {
    paddingHorizontal: 0,
  },
  emptyListContainer: {
    flex: 1,
  },
  orderItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  orderContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  orderLeft: {
    flex: 1,
    gap: 2,
  },
  orderRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  orderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  orderNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  priorityBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  priorityText: {
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  customerName: {
    fontSize: 14,
    fontWeight: '400',
  },
  shippingAddress: {
    fontSize: 12,
    fontWeight: '400',
    maxWidth: 180,
  },
  orderInfo: {
    fontSize: 12,
  },
  orderTotal: {
    fontSize: 15,
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
  trackingNumber: {
    fontSize: 11,
    fontWeight: '400',
    maxWidth: 100,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyDescription: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 250,
  },
});
