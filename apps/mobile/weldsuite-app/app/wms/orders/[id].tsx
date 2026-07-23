import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import type { WmsOrderDto, OrderStatus } from '@/types/wms';
import {
  getOrderStatusColor,
  getPriorityColor,
  formatDate,
  formatMoney,
  formatAddress,
} from '@/utils/wms-helpers';
import {
  ChevronLeft,
  Package,
  User,
  MapPin,
  Truck,
  Calendar,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react-native';

const STATUS_ACTIONS: { [key in OrderStatus]?: { label: string; nextStatus: OrderStatus }[] } = {
  pending: [
    { label: 'Start Processing', nextStatus: 'processing' },
    { label: 'Cancel Order', nextStatus: 'cancelled' },
  ],
  processing: [
    { label: 'Mark Ready for Pickup', nextStatus: 'ready_for_pickup' },
    { label: 'Cancel Order', nextStatus: 'cancelled' },
  ],
  ready_for_pickup: [
    { label: 'Mark as Shipped', nextStatus: 'shipped' },
  ],
  shipped: [
    { label: 'Mark as Delivered', nextStatus: 'delivered' },
  ],
};

export default function OrderDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();

  const [order, setOrder] = useState<WmsOrderDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (id) {
      loadOrder();
    }
  }, [id]);

  const loadOrder = async () => {
    try {
      setLoading(true);
      const response = await api.getWmsOrder(id);

      if (response.success && response.data) {
        setOrder(response.data);
      } else {
        throw new Error(response.error || 'Failed to load order');
      }
    } catch (error) {
      console.error('Error loading order:', error);
      toast.error('Failed to load order details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadOrder();
  };

  const handleUpdateStatus = async (newStatus: OrderStatus) => {
    if (!order) return;

    try {
      setUpdating(true);
      const response = await api.updateOrderStatus(order.id, newStatus);

      if (response.success) {
        toast.success('Order status updated successfully');
        await loadOrder();
      } else {
        throw new Error(response.error || 'Failed to update status');
      }
    } catch (error) {
      console.error('Error updating status:', error);
      toast.error('Failed to update order status');
    } finally {
      setUpdating(false);
    }
  };

  const handleAllocateInventory = async () => {
    if (!order) return;

    try {
      setUpdating(true);
      const response = await api.allocateOrderInventory(order.id);

      if (response.success) {
        toast.success('Inventory allocated successfully');
        await loadOrder();
      } else {
        throw new Error(response.error || 'Failed to allocate inventory');
      }
    } catch (error) {
      console.error('Error allocating inventory:', error);
      toast.error('Failed to allocate inventory');
    } finally {
      setUpdating(false);
    }
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
        <Text style={[styles.emptyText, { color: colors.muted }]}>Order not found</Text>
      </View>
    );
  }

  const statusColor = getOrderStatusColor(order.status);
  const priorityColor = getPriorityColor(order.priority);
  const availableActions = STATUS_ACTIONS[order.status] || [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={[styles.orderNumber, { color: colors.text }]}>{order.orderNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {order.status.replace(/_/g, ' ')}
            </Text>
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.tint} />
        }
      >
        {/* Order Summary Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Order Summary</Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.muted }]}>Created</Text>
            <Text style={[styles.summaryValue, { color: colors.text }]}>
              {formatDate(order.createdAt)}
            </Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.muted }]}>Priority</Text>
            <View style={[styles.priorityBadge, { backgroundColor: priorityColor + '20' }]}>
              <Text style={[styles.priorityText, { color: priorityColor }]}>
                {order.priority}
              </Text>
            </View>
          </View>

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.muted }]}>Total Items</Text>
            <Text style={[styles.summaryValue, { color: colors.text }]}>
              {order.items.reduce((sum, item) => sum + item.quantity, 0)} items
            </Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.muted }]}>Total Amount</Text>
            <Text style={[styles.summaryValue, styles.totalAmount, { color: colors.text }]}>
              {formatMoney(order.total.amount, order.total.currency)}
            </Text>
          </View>

          {order.notes && (
            <View style={[styles.notesSection, { borderTopColor: colors.divider }]}>
              <Text style={[styles.notesLabel, { color: colors.muted }]}>Notes</Text>
              <Text style={[styles.notesText, { color: colors.text }]}>{order.notes}</Text>
            </View>
          )}
        </View>

        {/* Customer Info Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <User size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Customer Information</Text>
          </View>

          <Text style={[styles.customerName, { color: colors.text }]}>{order.customerName}</Text>
          {order.customerEmail && (
            <Text style={[styles.customerDetail, { color: colors.muted }]}>{order.customerEmail}</Text>
          )}
          {order.customerPhone && (
            <Text style={[styles.customerDetail, { color: colors.muted }]}>{order.customerPhone}</Text>
          )}
        </View>

        {/* Shipping Address Card */}
        {order.shippingAddress && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <MapPin size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Shipping Address</Text>
            </View>

            <Text style={[styles.addressText, { color: colors.text }]}>
              {formatAddress(order.shippingAddress)}
            </Text>

            {order.requiresShipping && (
              <View style={styles.shippingNote}>
                <Truck size={16} color={colors.muted} />
                <Text style={[styles.shippingNoteText, { color: colors.muted }]}>
                  Shipping required
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Order Items Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Items ({order.items.length})
            </Text>
          </View>

          {order.items.map((item, index) => (
            <View
              key={item.id}
              style={[
                styles.orderItem,
                index !== order.items.length - 1 && { borderBottomWidth: 0.5, borderBottomColor: colors.divider },
              ]}
            >
              <View style={styles.itemDetails}>
                <Text style={[styles.itemName, { color: colors.text }]}>{item.productName}</Text>
                <Text style={[styles.itemSku, { color: colors.muted }]}>SKU: {item.productSku}</Text>
              </View>
              <View style={styles.itemRight}>
                <Text style={[styles.itemQuantity, { color: colors.text }]}>
                  Qty: {item.quantity}
                </Text>
                <Text style={[styles.itemPrice, { color: colors.text }]}>
                  {formatMoney(item.unitPrice.amount * item.quantity, item.unitPrice.currency)}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Fulfillment Info */}
        {order.fulfillmentStatus && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <CheckCircle2 size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Fulfillment</Text>
            </View>

            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Status</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {order.fulfillmentStatus.replace(/_/g, ' ')}
              </Text>
            </View>

            {order.pickListId && (
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.muted }]}>Pick List</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>
                  #{order.pickListId.substring(0, 8)}
                </Text>
              </View>
            )}

            {order.shipmentId && (
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.muted }]}>Shipment</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>
                  #{order.shipmentId.substring(0, 8)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Action Buttons */}
        {availableActions.length > 0 && (
          <View style={styles.actionsCard}>
            <Text style={[styles.actionsTitle, { color: colors.text }]}>Actions</Text>
            {availableActions.map((action, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: action.label.includes('Cancel') ? '#FEE2E2' : colors.text,
                  },
                ]}
                onPress={() => handleUpdateStatus(action.nextStatus)}
                disabled={updating}
              >
                {updating ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Text
                    style={[
                      styles.actionButtonText,
                      {
                        color: action.label.includes('Cancel') ? '#DC2626' : colors.background,
                      },
                    ]}
                  >
                    {action.label}
                  </Text>
                )}
              </TouchableOpacity>
            ))}

            {order.status === 'processing' && (
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: '#DBEAFE', borderWidth: 1, borderColor: '#3B82F6' }]}
                onPress={handleAllocateInventory}
                disabled={updating}
              >
                <Text style={[styles.actionButtonText, { color: '#3B82F6' }]}>
                  Allocate Inventory
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
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
  emptyText: {
    fontSize: 16,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
    marginBottom: 12,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  orderNumber: {
    fontSize: 24,
    fontWeight: '700',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 16,
  },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  summaryLabel: {
    fontSize: 14,
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  totalAmount: {
    fontSize: 18,
    fontWeight: '700',
  },
  priorityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  priorityText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  notesSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
  notesLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 6,
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
  },
  customerName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  customerDetail: {
    fontSize: 14,
    marginBottom: 4,
  },
  addressText: {
    fontSize: 14,
    lineHeight: 20,
  },
  shippingNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
  },
  shippingNoteText: {
    fontSize: 13,
  },
  orderItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  itemDetails: {
    flex: 1,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  itemSku: {
    fontSize: 12,
  },
  itemRight: {
    alignItems: 'flex-end',
    marginLeft: 12,
  },
  itemQuantity: {
    fontSize: 13,
    marginBottom: 4,
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionsCard: {
    marginBottom: 32,
  },
  actionsTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  actionButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
