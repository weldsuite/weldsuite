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
import { api } from '@/services/api';
import { useToast } from '@/contexts/ToastContext';

interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

interface Order {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  totalPrice: number;
  items: OrderItem[];
  shippingAddress?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  createdAt: string;
  updatedAt: string;
}

const ORDER_STATUS_CONFIG = {
  pending: {
    label: 'Pending',
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    icon: 'time-outline' as const,
  },
  processing: {
    label: 'Processing',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
    icon: 'construct-outline' as const,
  },
  shipped: {
    label: 'Shipped',
    color: '#5B21B6',
    backgroundColor: '#EDE9FE',
    icon: 'car-outline' as const,
  },
  delivered: {
    label: 'Delivered',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
    icon: 'checkmark-done-outline' as const,
  },
  cancelled: {
    label: 'Cancelled',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
    icon: 'close-circle-outline' as const,
  },
  refunded: {
    label: 'Refunded',
    color: '#374151',
    backgroundColor: '#F3F4F6',
    icon: 'arrow-back-outline' as const,
  },
};

export default function OrdersAdminScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusUpdateModalVisible, setStatusUpdateModalVisible] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  useEffect(() => {
    filterOrders();
  }, [selectedStatus, searchQuery, orders]);

  const loadOrders = async () => {
    try {
      setLoading(true);

      const response = await api.getOrders({
        limit: 100,
        sortBy: 'orderdate',
        sortOrder: 'desc',
      });

      if (response.success && response.data) {
        const apiOrders = response.data.items || [];

        // Map API orders to screen Order interface
        const mappedOrders: Order[] = apiOrders.map((apiOrder) => ({
          id: apiOrder.id,
          orderNumber: apiOrder.orderNumber,
          customerName: apiOrder.customerName,
          customerEmail: apiOrder.customerEmail,
          status: apiOrder.status,
          totalPrice: apiOrder.total, // Map 'total' to 'totalPrice'
          items: apiOrder.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            price: item.price,
          })),
          shippingAddress: apiOrder.shippingAddress,
          createdAt: apiOrder.createdAt,
          updatedAt: apiOrder.updatedAt,
        }));

        setOrders(mappedOrders);
        setFilteredOrders(mappedOrders);
      } else {
        toast.error(response.error || 'Failed to load orders');
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

    // Status filter
    if (selectedStatus) {
      filtered = filtered.filter((order) => order.status === selectedStatus);
    }

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter((order) =>
        order.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        order.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        order.customerEmail.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    setFilteredOrders(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadOrders();
  };

  const handleOrderPress = (order: Order) => {
    router.push(`/order/${order.id}` as any);
  };

  const handleUpdateOrderStatus = (order: Order) => {
    setSelectedOrder(order);
    setStatusUpdateModalVisible(true);
  };

  const updateOrderStatus = async (newStatus: Order['status']) => {
    if (!selectedOrder) return;

    try {
      const response = await api.updateOrderStatus(selectedOrder.id, newStatus);

      if (response.success && response.data) {
        // Update local state with the updated order
        setOrders(orders.map(order =>
          order.id === selectedOrder.id
            ? { ...order, status: newStatus, updatedAt: new Date().toISOString() }
            : order
        ));

        setStatusUpdateModalVisible(false);
        setSelectedOrder(null);
        toast.success(`Order ${selectedOrder.orderNumber} status updated to ${newStatus}`);
      } else {
        toast.error(response.error || 'Failed to update order status');
      }
    } catch (error) {
      console.error('Error updating order status:', error);
      toast.error('Failed to update order status');
    }
  };

  const handleCancelOrder = (order: Order) => {
    setSelectedOrder(order);
    updateOrderStatus('cancelled');
  };

  const handleRefundOrder = (order: Order) => {
    setSelectedOrder(order);
    updateOrderStatus('refunded');
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

  const getItemCount = (order: Order) => {
    return order.items.reduce((total, item) => total + item.quantity, 0);
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Orders', count: filteredOrders.length },
      { key: 'pending', label: 'Pending', count: orders.filter(o => o.status === 'pending').length },
      { key: 'processing', label: 'Processing', count: orders.filter(o => o.status === 'processing').length },
      { key: 'shipped', label: 'Shipped', count: orders.filter(o => o.status === 'shipped').length },
      { key: 'delivered', label: 'Delivered', count: orders.filter(o => o.status === 'delivered').length },
      { key: 'cancelled', label: 'Cancelled', count: orders.filter(o => o.status === 'cancelled').length },
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
    const itemCount = getItemCount(item);
    const statusConfig = ORDER_STATUS_CONFIG[item.status];

    return (
      <TouchableOpacity
        style={[styles.orderItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleOrderPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.orderContent}>
          <View style={styles.orderLeft}>
            <Text style={[styles.orderNumber, { color: colors.text }]}>#{item.orderNumber}</Text>
            <Text style={[styles.customerName, { color: colors.muted }]}>{item.customerName}</Text>
            <Text style={[styles.orderDate, { color: colors.muted }]}>
              {formatDate(item.createdAt)} · {itemCount} items
            </Text>
          </View>
          <View style={styles.orderRight}>
            <Text style={[styles.orderTotal, { color: colors.text }]}>${item.totalPrice.toFixed(2)}</Text>
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
      <Text style={[styles.emptyText, { color: colors.muted }]}>No orders found</Text>
    </View>
  );

  const renderHeader = () => (
    <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
      <Text style={[styles.headerTitle, { color: colors.text }]}>Orders ({filteredOrders.length})</Text>
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
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Orders ({filteredOrders.length})</Text>
        <TouchableOpacity
          style={[styles.addButton, { borderColor: colors.buttonBorder }]}
          onPress={() => router.push('/commerce/add-order' as any)}
        >
          <Ionicons name="add" size={16} color={colors.text} />
          <Text style={[styles.addButtonText, { color: colors.text }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search orders, customers..."
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
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />

      {/* Status Update Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={statusUpdateModalVisible}
        onRequestClose={() => setStatusUpdateModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Update Status</Text>
            {selectedOrder && (
              <Text style={[styles.modalSubtitle, { color: colors.muted }]}>Order {selectedOrder.orderNumber}</Text>
            )}

            {Object.entries(ORDER_STATUS_CONFIG).map(([status, config]) => (
              <TouchableOpacity
                key={status}
                style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                onPress={() => updateOrderStatus(status as Order['status'])}
              >
                <Text style={[styles.modalOptionText, { color: colors.text }]}>{config.label}</Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={[styles.modalCancel, { borderTopColor: colors.divider }]}
              onPress={() => setStatusUpdateModalVisible(false)}
            >
              <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
            </TouchableOpacity>
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
  listContainer: {
    paddingHorizontal: 0,
  },
  orderItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  orderContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderLeft: {
    flex: 1,
    gap: 2,
  },
  orderRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  orderNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  customerName: {
    fontSize: 14,
    fontWeight: '400',
  },
  orderDate: {
    fontSize: 12,
  },
  orderTotal: {
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
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    padding: 24,
    borderTopWidth: 0.5,
  },
  modalTitle: {
    fontSize: 12,
    fontWeight: '400',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  modalSubtitle: {
    fontSize: 10,
    textAlign: 'center',
    marginBottom: 24,
  },
  modalOption: {
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  modalOptionText: {
    fontSize: 12,
    fontWeight: '400',
  },
  modalCancel: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    borderTopWidth: 0.5,
  },
  modalCancelText: {
    fontSize: 12,
    fontWeight: '400',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
});