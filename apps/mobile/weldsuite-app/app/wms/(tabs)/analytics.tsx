import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Package,
  ShoppingCart,
  Truck,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  BarChart3,
  ClipboardList,
} from 'lucide-react-native';
import api, { WmsAnalytics } from '@/services/api';

export default function WmsAnalyticsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [analytics, setAnalytics] = useState<WmsAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadAnalytics();
  }, []);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      const response = await api.getWmsAnalytics();
      if (response.success && response.data) {
        setAnalytics(response.data);
      }
    } catch (error) {
      console.error('Error loading WMS analytics:', error);
      toast.error('Failed to load analytics');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadAnalytics();
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading analytics...
        </Text>
      </View>
    );
  }

  if (!analytics) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <BarChart3 size={48} color={colors.muted} strokeWidth={1.5} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No data available</Text>
        <Text style={[styles.emptyText, { color: colors.muted }]}>
          Analytics will appear here once you have warehouse activity
        </Text>
      </View>
    );
  }

  const maxOrders = Math.max(...analytics.dailyOrders.map(d => d.orders), 1);
  const totalHealth =
    analytics.inventory.health.healthy +
    analytics.inventory.health.adequate +
    analytics.inventory.health.low +
    analytics.inventory.health.outOfStock;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 45 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      {/* Key Metrics */}
      <View style={styles.metricsGrid}>
        <View style={[styles.metricCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.metricHeader}>
            <View style={[styles.metricIcon, { backgroundColor: '#3B82F620' }]}>
              <Package size={18} color="#3B82F6" strokeWidth={2} />
            </View>
          </View>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {analytics.inventory.totalItems.toLocaleString()}
          </Text>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>Total Items</Text>
        </View>

        <View style={[styles.metricCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.metricHeader}>
            <View style={[styles.metricIcon, { backgroundColor: '#10B98120' }]}>
              <ShoppingCart size={18} color="#10B981" strokeWidth={2} />
            </View>
            {analytics.orders.growth !== 0 && (
              <View style={styles.changeContainer}>
                {analytics.orders.growth >= 0 ? (
                  <TrendingUp size={12} color="#10B981" strokeWidth={2} />
                ) : (
                  <TrendingDown size={12} color="#EF4444" strokeWidth={2} />
                )}
                <Text
                  style={[
                    styles.changeText,
                    { color: analytics.orders.growth >= 0 ? '#10B981' : '#EF4444' },
                  ]}
                >
                  {analytics.orders.growth >= 0 ? '+' : ''}{analytics.orders.growth.toFixed(0)}%
                </Text>
              </View>
            )}
          </View>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {analytics.orders.thisMonth}
          </Text>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>Orders This Month</Text>
        </View>

        <View style={[styles.metricCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.metricHeader}>
            <View style={[styles.metricIcon, { backgroundColor: '#F59E0B20' }]}>
              <ClipboardList size={18} color="#F59E0B" strokeWidth={2} />
            </View>
          </View>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {analytics.pickLists.completionRate.toFixed(0)}%
          </Text>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>Pick Completion</Text>
        </View>

        <View style={[styles.metricCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.metricHeader}>
            <View style={[styles.metricIcon, { backgroundColor: '#8B5CF620' }]}>
              <Truck size={18} color="#8B5CF6" strokeWidth={2} />
            </View>
          </View>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {analytics.orders.fulfillmentRate.toFixed(0)}%
          </Text>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>Fulfillment Rate</Text>
        </View>
      </View>

      {/* Inventory Value */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Inventory Overview</Text>
        <View style={styles.inventoryStats}>
          <View style={styles.inventoryStat}>
            <Text style={[styles.inventoryValue, { color: colors.text }]}>
              {formatCurrency(analytics.inventory.totalValue)}
            </Text>
            <Text style={[styles.inventoryLabel, { color: colors.muted }]}>Total Value</Text>
          </View>
          <View style={styles.inventoryStat}>
            <Text style={[styles.inventoryValue, { color: colors.text }]}>
              {analytics.inventory.totalQuantity.toLocaleString()}
            </Text>
            <Text style={[styles.inventoryLabel, { color: colors.muted }]}>Total Units</Text>
          </View>
        </View>
      </View>

      {/* Inventory Health */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Inventory Health</Text>
        <View style={styles.healthGrid}>
          <View style={[styles.healthItem, { backgroundColor: '#10B98110' }]}>
            <CheckCircle2 size={18} color="#10B981" strokeWidth={2} />
            <Text style={[styles.healthValue, { color: '#10B981' }]}>
              {analytics.inventory.health.healthy}
            </Text>
            <Text style={[styles.healthLabel, { color: colors.muted }]}>Healthy</Text>
          </View>
          <View style={[styles.healthItem, { backgroundColor: '#3B82F610' }]}>
            <Package size={18} color="#3B82F6" strokeWidth={2} />
            <Text style={[styles.healthValue, { color: '#3B82F6' }]}>
              {analytics.inventory.health.adequate}
            </Text>
            <Text style={[styles.healthLabel, { color: colors.muted }]}>Adequate</Text>
          </View>
          <View style={[styles.healthItem, { backgroundColor: '#F59E0B10' }]}>
            <AlertTriangle size={18} color="#F59E0B" strokeWidth={2} />
            <Text style={[styles.healthValue, { color: '#F59E0B' }]}>
              {analytics.inventory.health.low}
            </Text>
            <Text style={[styles.healthLabel, { color: colors.muted }]}>Low Stock</Text>
          </View>
          <View style={[styles.healthItem, { backgroundColor: '#EF444410' }]}>
            <Package size={18} color="#EF4444" strokeWidth={2} />
            <Text style={[styles.healthValue, { color: '#EF4444' }]}>
              {analytics.inventory.health.outOfStock}
            </Text>
            <Text style={[styles.healthLabel, { color: colors.muted }]}>Out of Stock</Text>
          </View>
        </View>
      </View>

      {/* Daily Orders Chart */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <View style={styles.sectionHeader}>
          <BarChart3 size={18} color="#3B82F6" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>Daily Orders</Text>
        </View>
        <View style={styles.barChart}>
          {analytics.dailyOrders.map((day, index) => (
            <View key={index} style={styles.barChartItem}>
              <View style={styles.barWrapper}>
                <View
                  style={[
                    styles.barFill,
                    {
                      height: `${(day.orders / maxOrders) * 100}%`,
                      backgroundColor: '#3B82F6',
                    },
                  ]}
                />
              </View>
              <Text style={[styles.barLabel, { color: colors.muted }]}>{day.day}</Text>
              <Text style={[styles.barValue, { color: colors.text }]}>{day.orders}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Shipping Stats */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <View style={styles.sectionHeader}>
          <Truck size={18} color="#8B5CF6" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>Shipping</Text>
        </View>
        <View style={styles.shippingStats}>
          <View style={[styles.shippingStat, { borderColor: colors.divider }]}>
            <Text style={[styles.shippingValue, { color: colors.text }]}>
              {analytics.shipping.shipmentsThisMonth}
            </Text>
            <Text style={[styles.shippingLabel, { color: colors.muted }]}>Shipments</Text>
          </View>
          <View style={styles.shippingStat}>
            <Text style={[styles.shippingValue, { color: '#10B981' }]}>
              {analytics.shipping.deliveredThisMonth}
            </Text>
            <Text style={[styles.shippingLabel, { color: colors.muted }]}>Delivered</Text>
          </View>
        </View>
      </View>

      {/* Top Products */}
      <View style={[styles.section, { borderColor: colors.divider, marginBottom: 32 }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Top Moving Products</Text>
        {analytics.topProducts.length === 0 ? (
          <Text style={[styles.emptyListText, { color: colors.muted }]}>
            No product data available
          </Text>
        ) : (
          analytics.topProducts.map((product, index) => (
            <View
              key={product.productId}
              style={[
                styles.productRow,
                index < analytics.topProducts.length - 1 && { borderBottomWidth: 1, borderColor: colors.divider },
              ]}
            >
              <View style={styles.productRank}>
                <Text
                  style={[styles.rankText, { color: index < 3 ? '#F59E0B' : colors.muted }]}
                >
                  #{index + 1}
                </Text>
              </View>
              <View style={styles.productInfo}>
                <Text style={[styles.productName, { color: colors.text }]} numberOfLines={1}>
                  {product.productName}
                </Text>
              </View>
              <View style={styles.productQuantity}>
                <Text style={[styles.quantityValue, { color: '#10B981' }]}>
                  {product.quantity.toLocaleString()}
                </Text>
                <Text style={[styles.quantityLabel, { color: colors.muted }]}>units</Text>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
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
    paddingHorizontal: 32,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 16,
    gap: 12,
  },
  metricCard: {
    width: '47%',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  metricHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  metricIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  changeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 2,
  },
  metricLabel: {
    fontSize: 11,
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
  },
  inventoryStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  inventoryStat: {
    alignItems: 'center',
  },
  inventoryValue: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  inventoryLabel: {
    fontSize: 12,
  },
  healthGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  healthItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 6,
  },
  healthValue: {
    fontSize: 18,
    fontWeight: '700',
  },
  healthLabel: {
    fontSize: 10,
  },
  barChart: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 140,
    marginTop: 8,
  },
  barChartItem: {
    flex: 1,
    alignItems: 'center',
  },
  barWrapper: {
    width: 20,
    height: 100,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  barFill: {
    width: '100%',
    borderRadius: 4,
    minHeight: 4,
  },
  barLabel: {
    fontSize: 10,
    marginTop: 6,
  },
  barValue: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  shippingStats: {
    flexDirection: 'row',
  },
  shippingStat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRightWidth: 1,
  },
  shippingValue: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  shippingLabel: {
    fontSize: 12,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  productRank: {
    width: 30,
  },
  rankText: {
    fontSize: 14,
    fontWeight: '600',
  },
  productInfo: {
    flex: 1,
    marginRight: 12,
  },
  productName: {
    fontSize: 14,
    fontWeight: '500',
  },
  productQuantity: {
    alignItems: 'flex-end',
  },
  quantityValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  quantityLabel: {
    fontSize: 10,
  },
  emptyListText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
