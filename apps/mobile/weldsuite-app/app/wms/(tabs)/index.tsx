import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useWms } from '@/contexts/WmsContext';
import { useToast } from '@/contexts/ToastContext';
import {
  Package,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  ClipboardList,
  Truck,
  BarChart3,
  ChevronRight,
  RefreshCw,
} from 'lucide-react-native';
import type { DashboardOverviewDto, LowStockItemDto, OrderSummaryDto } from '@/types/wms';
import { formatMoney, formatRelativeTime, getOrderStatusColor, getPriorityColor } from '@/utils/wms-helpers';

export default function WmsDashboardScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { dashboardData, loadDashboard, refreshDashboard, loading } = useWms();

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDashboard();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshDashboard();
    } catch (error) {
      console.error('Failed to refresh dashboard:', error);
      toast.error('Failed to refresh dashboard data');
    } finally {
      setRefreshing(false);
    }
  }, [refreshDashboard]);

  const defaultStats = {
    totalOrders: 0,
    ordersToday: 0,
    pendingOrders: 0,
    processingOrders: 0,
    activePickLists: 0,
    lowStockItemsCount: 0,
    totalProducts: 0,
    totalInventoryValue: { amount: 0, currency: 'USD', formatted: '$0.00' },
    lowStockProducts: [],
    recentOrders: [],
  };

  const stats = {
    ...defaultStats,
    ...dashboardData,
    // Ensure totalInventoryValue always has the correct structure
    totalInventoryValue: dashboardData?.totalInventoryValue?.amount !== undefined
      ? dashboardData.totalInventoryValue
      : defaultStats.totalInventoryValue,
    // Ensure recentOrders have correct structure
    recentOrders: (dashboardData?.recentOrders || []).map((order: any) => ({
      ...order,
      total: order.total?.amount !== undefined
        ? order.total
        : { amount: 0, currency: 'USD' },
    })),
    // Ensure lowStockProducts is an array
    lowStockProducts: Array.isArray(dashboardData?.lowStockProducts)
      ? dashboardData.lowStockProducts
      : [],
  };

  const percentageChange = stats.ordersYesterday
    ? ((stats.ordersToday - stats.ordersYesterday) / stats.ordersYesterday) * 100
    : 0;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.tint}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Dashboard</Text>
      </View>

      {/* Stats Grid */}
      <View style={styles.statsGrid}>
        {/* Total Orders */}
        <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.statHeader}>
            <ShoppingCart size={20} color={colors.tint} />
            <Text style={[styles.statLabel, { color: colors.muted }]}>Total Orders</Text>
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>{stats.totalOrders}</Text>
          <View style={styles.statFooter}>
            <Text style={[styles.statChange, { color: percentageChange >= 0 ? '#4CAF50' : '#F44336' }]}>
              {percentageChange >= 0 ? (
                <TrendingUp size={12} color="#4CAF50" />
              ) : (
                <TrendingDown size={12} color="#F44336" />
              )}
              {' '}{Math.abs(percentageChange).toFixed(1)}%
            </Text>
            <Text style={[styles.statSubtext, { color: colors.muted }]}>vs yesterday</Text>
          </View>
        </View>

        {/* Pending Orders */}
        <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.statHeader}>
            <ClipboardList size={20} color="#FFA500" />
            <Text style={[styles.statLabel, { color: colors.muted }]}>Pending</Text>
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>{stats.pendingOrders}</Text>
          <TouchableOpacity onPress={() => router.push('/wms/orders?status=pending')}>
            <Text style={[styles.statLink, { color: colors.tint }]}>View all →</Text>
          </TouchableOpacity>
        </View>

        {/* Active Pick Lists */}
        <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.statHeader}>
            <Package size={20} color="#9C27B0" />
            <Text style={[styles.statLabel, { color: colors.muted }]}>Active Picks</Text>
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>{stats.activePickLists}</Text>
          <TouchableOpacity onPress={() => router.push('/wms/picklists?status=in_progress')}>
            <Text style={[styles.statLink, { color: colors.tint }]}>View all →</Text>
          </TouchableOpacity>
        </View>

        {/* Low Stock Items */}
        <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.statHeader}>
            <AlertTriangle size={20} color="#F44336" />
            <Text style={[styles.statLabel, { color: colors.muted }]}>Low Stock</Text>
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>{stats.lowStockItemsCount}</Text>
          <TouchableOpacity onPress={() => router.push('/wms/inventory?lowStock=true')}>
            <Text style={[styles.statLink, { color: colors.tint }]}>View all →</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Inventory Value Card */}
      <View style={[styles.valueCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <View style={styles.valueHeader}>
          <BarChart3 size={24} color={colors.tint} />
          <Text style={[styles.valueLabel, { color: colors.muted }]}>Total Inventory Value</Text>
        </View>
        <Text style={[styles.valueAmount, { color: colors.text }]}>
          {formatMoney(stats.totalInventoryValue.amount, stats.totalInventoryValue.currency)}
        </Text>
        <Text style={[styles.valueSubtext, { color: colors.muted }]}>
          {stats.totalProducts} total products
        </Text>
      </View>

      {/* Low Stock Alerts */}
      {stats.lowStockProducts && stats.lowStockProducts.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Low Stock Alerts</Text>
            <TouchableOpacity onPress={() => router.push('/wms/inventory?lowStock=true')}>
              <Text style={[styles.sectionLink, { color: colors.tint }]}>See all</Text>
            </TouchableOpacity>
          </View>
          {stats.lowStockProducts.slice(0, 5).map((item: LowStockItemDto) => (
            <TouchableOpacity
              key={item.productId}
              style={[styles.listItem, { backgroundColor: colors.background, borderColor: colors.border }]}
              onPress={() => router.push(`/wms/inventory/${item.productId}`)}
            >
              <View style={styles.listItemContent}>
                <View>
                  <Text style={[styles.listItemTitle, { color: colors.text }]}>
                    {item.productName}
                  </Text>
                  <Text style={[styles.listItemSubtitle, { color: colors.muted }]}>
                    SKU: {item.productSku} • {item.warehouseName}
                  </Text>
                </View>
                <View style={styles.listItemRight}>
                  <Text style={[styles.listItemQty, { color: '#F44336' }]}>
                    {item.quantityOnHand} left
                  </Text>
                  <Text style={[styles.listItemReorder, { color: colors.muted }]}>
                    Reorder: {item.reorderQuantity}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Recent Orders */}
      {stats.recentOrders && stats.recentOrders.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Orders</Text>
            <TouchableOpacity onPress={() => router.push('/wms/orders')}>
              <Text style={[styles.sectionLink, { color: colors.tint }]}>See all</Text>
            </TouchableOpacity>
          </View>
          {stats.recentOrders.slice(0, 5).map((order: OrderSummaryDto) => (
            <TouchableOpacity
              key={order.id}
              style={[styles.listItem, { backgroundColor: colors.background, borderColor: colors.border }]}
              onPress={() => router.push(`/wms/orders/${order.id}`)}
            >
              <View style={styles.listItemContent}>
                <View>
                  <Text style={[styles.listItemTitle, { color: colors.text }]}>
                    {order.orderNumber}
                  </Text>
                  <Text style={[styles.listItemSubtitle, { color: colors.muted }]}>
                    {order.customerName} • {formatRelativeTime(order.createdAt)}
                  </Text>
                </View>
                <View style={styles.listItemRight}>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: getOrderStatusColor(order.status) + '20' },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusBadgeText,
                        { color: getOrderStatusColor(order.status) },
                      ]}
                    >
                      {order.status}
                    </Text>
                  </View>
                  <Text style={[styles.listItemAmount, { color: colors.text }]}>
                    {formatMoney(order.total.amount, order.total.currency)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
        <View style={styles.quickActions}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.background, borderColor: colors.border }]}
            onPress={() => router.push('/wms/orders/create')}
          >
            <ShoppingCart size={24} color={colors.tint} />
            <Text style={[styles.actionButtonText, { color: colors.text }]}>New Order</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.background, borderColor: colors.border }]}
            onPress={() => router.push('/wms/picklists/create')}
          >
            <ClipboardList size={24} color={colors.tint} />
            <Text style={[styles.actionButtonText, { color: colors.text }]}>Create Pick List</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.background, borderColor: colors.border }]}
            onPress={() => router.push('/wms/shipments/create')}
          >
            <Truck size={24} color={colors.tint} />
            <Text style={[styles.actionButtonText, { color: colors.text }]}>New Shipment</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.background, borderColor: colors.border }]}
            onPress={() => router.push('/wms/inventory')}
          >
            <Package size={24} color={colors.tint} />
            <Text style={[styles.actionButtonText, { color: colors.text }]}>View Inventory</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  warehouseText: {
    fontSize: 14,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    width: '47%',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  statHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  statValue: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  statFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statChange: {
    fontSize: 12,
    fontWeight: '600',
  },
  statSubtext: {
    fontSize: 11,
  },
  statLink: {
    fontSize: 12,
    fontWeight: '500',
  },
  valueCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
  },
  valueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  valueLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  valueAmount: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 4,
  },
  valueSubtext: {
    fontSize: 12,
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  sectionLink: {
    fontSize: 14,
    fontWeight: '500',
  },
  listItem: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  listItemContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  listItemTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  listItemSubtitle: {
    fontSize: 12,
  },
  listItemRight: {
    alignItems: 'flex-end',
  },
  listItemQty: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  listItemReorder: {
    fontSize: 11,
  },
  listItemAmount: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginBottom: 4,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  quickActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
  },
  actionButton: {
    width: '47%',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  actionButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
});