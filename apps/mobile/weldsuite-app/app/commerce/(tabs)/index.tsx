import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  RefreshControl,
  Dimensions,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { router } from 'expo-router';
import { api } from '@/services/api';
import { useToast } from '@/contexts/ToastContext';

interface DashboardStats {
  totalSales: number;
  todaySales: number;
  weekSales: number;
  monthSales: number;
  totalOrders: number;
  pendingOrders: number;
  processingOrders: number;
  shippedOrders: number;
  totalProducts: number;
  lowStockProducts: number;
  totalCustomers: number;
  newCustomersToday: number;
}

interface RecentOrder {
  id: string;
  customerName: string;
  total: number;
  status: 'pending' | 'processing' | 'shipped' | 'delivered';
  createdAt: string;
}

interface TopProduct {
  id: string;
  name: string;
  sales: number;
  revenue: number;
}

export default function DashboardScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
    } else {
      return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
    }
  };

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      // Fetch all data in parallel
      const [statsResponse, ordersResponse, productsResponse] = await Promise.all([
        api.getDashboardStats(),
        api.getRecentOrders(5),
        api.getTopProducts(4),
      ]);

      if (statsResponse.success && statsResponse.data) {
        setStats(statsResponse.data);
      } else {
        toast.error(statsResponse.error || 'Failed to load dashboard stats');
      }

      if (ordersResponse.success && ordersResponse.data) {
        // Map API orders to screen format with relative time
        const mappedOrders = ordersResponse.data.map((order) => ({
          id: order.id,
          customerName: order.customerName,
          total: order.total,
          status: order.status as 'pending' | 'processing' | 'shipped' | 'delivered',
          createdAt: formatRelativeTime(order.createdAt),
        }));
        setRecentOrders(mappedOrders);
      } else {
        toast.error(ordersResponse.error || 'Failed to load recent orders');
      }

      if (productsResponse.success && productsResponse.data) {
        setTopProducts(productsResponse.data);
      } else {
        toast.error(productsResponse.error || 'Failed to load top products');
      }
    } catch (error) {
      console.error('Error loading dashboard:', error);
      toast.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadDashboardData();
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return 'PENDING';
      case 'processing': return 'PROCESSING';
      case 'shipped': return 'SHIPPED';
      case 'delivered': return 'DELIVERED';
      default: return status.toUpperCase();
    }
  };

  const renderRecentOrder = ({ item }: { item: RecentOrder }) => (
    <TouchableOpacity
      style={[styles.orderItem, { borderBottomColor: colors.divider }]}
      onPress={() => router.push(`/order/${item.id}` as any)}
    >
      <View style={styles.orderRow}>
        <Text style={[styles.orderCustomer, { color: colors.text }]}>{item.customerName}</Text>
        <Text style={[styles.orderTotal, { color: colors.text }]}>${item.total.toFixed(2)}</Text>
      </View>
      <View style={styles.orderRow}>
        <Text style={[styles.orderStatus, { color: colors.muted }]}>{getStatusText(item.status)}</Text>
        <Text style={[styles.orderTime, { color: colors.muted }]}>{item.createdAt}</Text>
      </View>
    </TouchableOpacity>
  );

  const renderTopProduct = ({ item }: { item: TopProduct }) => (
    <View style={[styles.productItem, { borderBottomColor: colors.divider }]}>
      <Text style={[styles.productName, { color: colors.text }]}>{item.name}</Text>
      <View style={styles.productStats}>
        <Text style={[styles.productSales, { color: colors.muted }]}>{item.sales} sold</Text>
        <Text style={[styles.productRevenue, { color: colors.text }]}>${item.revenue.toLocaleString()}</Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Dashboard</Text>
      </View>
      
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        showsVerticalScrollIndicator={false}
      >

        {/* Sales Metrics */}
        <View style={styles.section}>
          <View style={styles.metricsGrid}>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.todaySales.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Today</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.weekSales.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>This Week</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.monthSales.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>This Month</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.totalSales.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Total</Text>
            </View>
          </View>
        </View>

        {/* Order Status */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Orders</Text>
          <View style={styles.orderMetrics}>
            <TouchableOpacity style={styles.metricItem} onPress={() => router.push('/orders' as any)}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{stats?.pendingOrders}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Pending</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metricItem} onPress={() => router.push('/orders' as any)}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{stats?.processingOrders}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Processing</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metricItem} onPress={() => router.push('/orders' as any)}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{stats?.shippedOrders}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Shipped</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Actions</Text>
          <View style={styles.actionsList}>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: colors.divider }]} onPress={() => router.push('/product/new' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>Add Product</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: colors.divider }]} onPress={() => router.push('/orders' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>View Orders</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: colors.divider }]} onPress={() => router.push('/inventory' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>Check Stock</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: 'transparent' }]} onPress={() => router.push('/customers' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>Customers</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Recent Orders */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Orders</Text>
            <TouchableOpacity onPress={() => router.push('/orders' as any)}>
              <Text style={[styles.viewAllText, { color: colors.muted }]}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.listContainer}>
            <FlatList
              data={recentOrders}
              renderItem={renderRecentOrder}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
            />
          </View>
        </View>

        {/* Top Products */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Top Products</Text>
            <TouchableOpacity onPress={() => router.push('/products' as any)}>
              <Text style={[styles.viewAllText, { color: colors.muted }]}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.listContainer}>
            <FlatList
              data={topProducts}
              renderItem={renderTopProduct}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
            />
          </View>
        </View>

        {/* Low Stock Alert */}
        {stats && stats.lowStockProducts > 0 && (
          <TouchableOpacity
            style={[styles.alertItem, { borderColor: colors.divider }]}
            onPress={() => router.push('/inventory' as any)}
          >
            <Text style={[styles.alertText, { color: colors.text }]}>Low Stock: {stats.lowStockProducts} products</Text>
          </TouchableOpacity>
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
    marginTop: 16,
    fontSize: 15,
  },
  header: {
    padding: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  section: {
    marginTop: 20,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '400',
    marginBottom: 12,
    letterSpacing: -0.1,
    textTransform: 'uppercase',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  viewAllText: {
    fontSize: 13,
    fontWeight: '400',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricItem: {
    flex: 1,
    minWidth: '48%',
    alignItems: 'flex-start',
    paddingVertical: 4,
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '400',
    lineHeight: 20,
  },
  metricLabel: {
    fontSize: 13,
    marginTop: 2,
    fontWeight: '400',
  },
  orderMetrics: {
    flexDirection: 'row',
    gap: 12,
  },
  actionsList: {
    gap: 0,
  },
  actionItem: {
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  actionText: {
    fontSize: 17,
    fontWeight: '400',
  },
  listContainer: {
    gap: 0,
  },
  orderItem: {
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  orderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderCustomer: {
    fontSize: 15,
    fontWeight: '400',
    marginBottom: 2,
  },
  orderTotal: {
    fontSize: 15,
    fontWeight: '400',
    marginBottom: 2,
  },
  orderStatus: {
    fontSize: 13,
    fontWeight: '400',
    letterSpacing: -0.1,
  },
  orderTime: {
    fontSize: 13,
    fontWeight: '400',
  },
  productItem: {
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  productName: {
    fontSize: 15,
    fontWeight: '400',
    marginBottom: 4,
  },
  productStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  productSales: {
    fontSize: 13,
    fontWeight: '400',
  },
  productRevenue: {
    fontSize: 13,
    fontWeight: '400',
  },
  alertItem: {
    padding: 16,
    margin: 16,
    borderWidth: 0.5,
    borderRadius: 2,
  },
  alertText: {
    fontSize: 13,
    fontWeight: '400',
  },
});