import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View,
  Text,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, MoreVertical, Package, User, MapPin, CreditCard } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  total: number;
}

interface Order {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  totalPrice: number;
  subtotal: number;
  tax: number;
  shipping: number;
  discount?: number;
  items: OrderItem[];
  shippingAddress: {
    name: string;
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  billingAddress?: {
    name: string;
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  paymentMethod: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

const ORDER_STATUS_CONFIG = {
  pending: {
    label: 'Pending',
    color: '#F59E0B',
    bgColor: '#FEF3C7',
  },
  processing: {
    label: 'Processing',
    color: '#3B82F6',
    bgColor: '#DBEAFE',
  },
  shipped: {
    label: 'Shipped',
    color: '#8B5CF6',
    bgColor: '#EDE9FE',
  },
  delivered: {
    label: 'Delivered',
    color: '#10B981',
    bgColor: '#D1FAE5',
  },
  cancelled: {
    label: 'Cancelled',
    color: '#EF4444',
    bgColor: '#FEE2E2',
  },
  refunded: {
    label: 'Refunded',
    color: '#6B7280',
    bgColor: '#F3F4F6',
  },
};

export default function OrderDetailScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusUpdateModalVisible, setStatusUpdateModalVisible] = useState(false);

  useEffect(() => {
    loadOrder();
  }, [id]);

  const loadOrder = async () => {
    if (!id) return;

    try {
      setLoading(true);
      const response = await api.getOrder(id);

      if (response.success && response.data) {
        // Transform API data to match component interface
        const orderData: Order = {
          id: response.data.id,
          orderNumber: response.data.orderNumber,
          customerName: response.data.customerName,
          customerEmail: response.data.customerEmail,
          customerPhone: response.data.customerPhone,
          status: response.data.status,
          totalPrice: response.data.total,
          subtotal: response.data.subtotal,
          tax: response.data.tax,
          shipping: response.data.shipping,
          discount: 0, // API doesn't provide discount, default to 0
          items: response.data.items.map(item => ({
            id: item.id,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            price: item.price,
            total: item.total,
          })),
          shippingAddress: response.data.shippingAddress ? {
            name: response.data.customerName,
            street: response.data.shippingAddress.street,
            city: response.data.shippingAddress.city,
            state: response.data.shippingAddress.state,
            zipCode: response.data.shippingAddress.zipCode,
            country: response.data.shippingAddress.country,
          } : {
            name: response.data.customerName,
            street: '',
            city: '',
            state: '',
            zipCode: '',
            country: '',
          },
          billingAddress: response.data.shippingAddress ? {
            name: response.data.customerName,
            street: response.data.shippingAddress.street,
            city: response.data.shippingAddress.city,
            state: response.data.shippingAddress.state,
            zipCode: response.data.shippingAddress.zipCode,
            country: response.data.shippingAddress.country,
          } : undefined,
          paymentMethod: response.data.paymentStatus || 'Payment information not available',
          createdAt: response.data.createdAt,
          updatedAt: response.data.updatedAt,
          notes: undefined, // API doesn't provide notes
        };

        setOrder(orderData);
      } else {
        throw new Error(response.error || 'Failed to load order');
      }
    } catch (error) {
      console.error('Error loading order:', error);
      toast.error('Failed to load order details');
      router.back();
    } finally {
      setLoading(false);
    }
  };

  const updateOrderStatus = async (newStatus: Order['status']) => {
    if (!id) return;

    try {
      const response = await api.updateOrderStatus(id, newStatus);

      if (response.success && response.data) {
        setOrder(prev => prev ? { ...prev, status: newStatus } : null);
        setStatusUpdateModalVisible(false);
        toast.success('Order status updated successfully');
      } else {
        throw new Error(response.error || 'Failed to update order status');
      }
    } catch (error) {
      console.error('Error updating order status:', error);
      toast.error('Failed to update order status');
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

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading order...</Text>
      </View>
    );
  }

  if (!order) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>Order not found</Text>
      </View>
    );
  }

  const statusConfig = ORDER_STATUS_CONFIG[order.status];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: '#E5E7EB' }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={24} color={colors.text} strokeWidth={1.5} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Order #{order.orderNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.bgColor }]}>
            <Text style={[styles.statusBadgeText, { color: statusConfig.color }]}>
              {statusConfig.label}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.moreButton}
          onPress={() => setStatusUpdateModalVisible(true)}
        >
          <MoreVertical size={20} color={colors.text} strokeWidth={1.5} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Customer Section */}
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <View style={styles.cardHeader}>
            <User size={16} color={colors.text} strokeWidth={1.5} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Customer</Text>
          </View>
          <View style={styles.cardContent}>
            <Text style={[styles.primaryText, { color: colors.text }]}>{order.customerName}</Text>
            <Text style={[styles.secondaryText, { color: colors.muted }]}>{order.customerEmail}</Text>
            {order.customerPhone && (
              <Text style={[styles.secondaryText, { color: colors.muted }]}>{order.customerPhone}</Text>
            )}
          </View>
        </View>

        {/* Shipping Address */}
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <View style={styles.cardHeader}>
            <MapPin size={16} color={colors.text} strokeWidth={1.5} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Shipping Address</Text>
          </View>
          <View style={styles.cardContent}>
            <Text style={[styles.primaryText, { color: colors.text }]}>{order.shippingAddress.name}</Text>
            <Text style={[styles.secondaryText, { color: colors.muted }]}>{order.shippingAddress.street}</Text>
            <Text style={[styles.secondaryText, { color: colors.muted }]}>
              {order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.zipCode}
            </Text>
            <Text style={[styles.secondaryText, { color: colors.muted }]}>{order.shippingAddress.country}</Text>
          </View>
        </View>

        {/* Payment Method */}
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <View style={styles.cardHeader}>
            <CreditCard size={16} color={colors.text} strokeWidth={1.5} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Payment</Text>
          </View>
          <View style={styles.cardContent}>
            <Text style={[styles.primaryText, { color: colors.text }]}>{order.paymentMethod}</Text>
            <Text style={[styles.secondaryText, { color: colors.muted }]}>
              Paid on {formatDate(order.createdAt)}
            </Text>
          </View>
        </View>

        {/* Order Items */}
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <View style={styles.cardHeader}>
            <Package size={16} color={colors.text} strokeWidth={1.5} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Items</Text>
          </View>
          <View style={styles.itemsContainer}>
            {order.items.map((item, index) => (
              <View 
                key={item.id} 
                style={[
                  styles.orderItem,
                  { borderBottomColor: '#E5E7EB' },
                  index === order.items.length - 1 && { borderBottomWidth: 0 }
                ]}
              >
                <View style={styles.itemInfo}>
                  <Text style={[styles.itemName, { color: colors.text }]}>{item.productName}</Text>
                  <Text style={[styles.itemQuantity, { color: colors.muted }]}>
                    Qty: {item.quantity} × ${item.price.toFixed(2)}
                  </Text>
                </View>
                <Text style={[styles.itemPrice, { color: colors.text }]}>${item.total.toFixed(2)}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Order Summary */}
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <View style={styles.summaryContainer}>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Subtotal</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>${order.subtotal.toFixed(2)}</Text>
            </View>
            {order.discount && order.discount > 0 && (
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.muted }]}>Discount</Text>
                <Text style={[styles.summaryValue, { color: '#10B981' }]}>
                  -${order.discount.toFixed(2)}
                </Text>
              </View>
            )}
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Shipping</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>${order.shipping.toFixed(2)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Tax</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>${order.tax.toFixed(2)}</Text>
            </View>
            <View style={[styles.summaryRow, styles.totalRow]}>
              <Text style={[styles.totalLabel, { color: colors.text }]}>Total</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>${order.totalPrice.toFixed(2)}</Text>
            </View>
          </View>
        </View>

        {/* Notes */}
        {order.notes && (
          <View style={[styles.card, { backgroundColor: colors.background }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Notes</Text>
            <Text style={[styles.notesText, { color: colors.muted }]}>{order.notes}</Text>
          </View>
        )}

        <View style={styles.bottomSpacer} />
      </ScrollView>

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
            
            {Object.entries(ORDER_STATUS_CONFIG).map(([status, config]) => (
              <TouchableOpacity
                key={status}
                style={[
                  styles.modalOption,
                  { borderBottomColor: colors.divider },
                  order.status === status && { backgroundColor: '#F3F4F6' },
                ]}
                onPress={() => updateOrderStatus(status as Order['status'])}
              >
                <View style={styles.modalOptionContent}>
                  <View style={[styles.statusDot, { backgroundColor: config.color }]} />
                  <Text style={[styles.modalOptionText, { color: colors.text }]}>
                    {config.label}
                  </Text>
                </View>
                {order.status === status && (
                  <Text style={[styles.checkmark, { color: colors.text }]}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
            
            <TouchableOpacity
              style={styles.modalCancel}
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
    marginTop: 12,
    fontSize: 14,
  },
  errorText: {
    fontSize: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  moreButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: '#E5E7EB',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardContent: {
    gap: 4,
  },
  primaryText: {
    fontSize: 15,
    fontWeight: '500',
  },
  secondaryText: {
    fontSize: 13,
    lineHeight: 18,
  },
  itemsContainer: {
    marginTop: 8,
  },
  orderItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  itemInfo: {
    flex: 1,
    gap: 2,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '500',
  },
  itemQuantity: {
    fontSize: 12,
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: '600',
  },
  summaryContainer: {
    gap: 8,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 14,
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  totalRow: {
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: '#E5E7EB',
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: '700',
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  bottomSpacer: {
    height: 24,
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
  modalOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  modalOptionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  modalOptionText: {
    fontSize: 15,
  },
  checkmark: {
    fontSize: 18,
    fontWeight: '600',
  },
  modalCancel: {
    marginTop: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '500',
  },
});