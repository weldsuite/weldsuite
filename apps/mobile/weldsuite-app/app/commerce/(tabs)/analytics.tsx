import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  Dimensions,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TrendingUp, TrendingDown, Users, Package, DollarSign, ShoppingCart, Calendar, BarChart3 } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { api } from '@/services/api';

const { width } = Dimensions.get('window');

interface MetricCard {
  title: string;
  value: string;
  change: number;
  icon: any;
  color: string;
}

interface ConversionData {
  conversionRate: number;
  averageOrderValue: number;
  cartAbandonmentRate: number;
  repeatPurchaseRate: number;
}

interface CategoryData {
  category: string;
  revenue: number;
  orders: number;
}

interface ChannelData {
  channel: string;
  percentage: number;
  revenue: number;
}

type TimePeriod = '7d' | '30d' | '90d' | '1y';

export default function CommerceAnalyticsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [metrics, setMetrics] = useState<MetricCard[]>([]);
  const [conversion, setConversion] = useState<ConversionData | null>(null);
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('30d');

  useEffect(() => {
    loadAnalytics();
  }, []);

  const loadAnalytics = async () => {
    try {
      setLoading(true);

      // Fetch all analytics data in parallel
      const [performanceResponse, conversionResponse, categoriesResponse, channelsResponse] = await Promise.all([
        api.getPerformanceMetrics(),
        api.getConversionMetrics(),
        api.getTopCategories(),
        api.getChannelMetrics(),
      ]);

      // Process performance metrics
      if (performanceResponse.success && performanceResponse.data) {
        const data = performanceResponse.data;
        const metricCards: MetricCard[] = [
          {
            title: 'Total Revenue',
            value: `$${data.totalRevenue.toLocaleString()}`,
            change: data.totalRevenue_change,
            icon: DollarSign,
            color: '#10B981',
          },
          {
            title: 'Total Orders',
            value: data.totalOrders.toLocaleString(),
            change: data.totalOrders_change,
            icon: ShoppingCart,
            color: '#3B82F6',
          },
          {
            title: 'Active Customers',
            value: data.activeCustomers.toLocaleString(),
            change: data.activeCustomers_change,
            icon: Users,
            color: '#8B5CF6',
          },
          {
            title: 'Products Sold',
            value: data.productsSold.toLocaleString(),
            change: data.productsSold_change,
            icon: Package,
            color: '#F59E0B',
          },
        ];
        setMetrics(metricCards);
      } else {
        toast.error(performanceResponse.error || 'Failed to load performance metrics');
      }

      // Process conversion metrics
      if (conversionResponse.success && conversionResponse.data) {
        setConversion(conversionResponse.data);
      } else {
        toast.error(conversionResponse.error || 'Failed to load conversion metrics');
      }

      // Process top categories
      if (categoriesResponse.success && categoriesResponse.data) {
        setCategories(categoriesResponse.data);
      } else {
        toast.error(categoriesResponse.error || 'Failed to load top categories');
      }

      // Process channel metrics
      if (channelsResponse.success && channelsResponse.data) {
        setChannels(channelsResponse.data);
      } else {
        toast.error(channelsResponse.error || 'Failed to load channel metrics');
      }
    } catch (error) {
      console.error('Error loading analytics:', error);
      toast.error('Failed to load analytics data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadAnalytics();
  };

  const renderTrendIcon = (change: number) => {
    if (change > 0) {
      return <TrendingUp size={14} color="#10B981" strokeWidth={2} />;
    }
    return <TrendingDown size={14} color="#EF4444" strokeWidth={2} />;
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading analytics...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const timePeriods: { label: string; value: TimePeriod }[] = [
    { label: '7 Days', value: '7d' },
    { label: '30 Days', value: '30d' },
    { label: '90 Days', value: '90d' },
    { label: '1 Year', value: '1y' },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {/* Header with Time Period Selector */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={[styles.headerTitle, { color: colors.text }]}>Analytics</Text>
              <Text style={[styles.headerSubtitle, { color: colors.muted }]}>
                Sales & Performance Insights
              </Text>
            </View>
            <View style={[styles.iconBadge, { backgroundColor: `${colors.text}10` }]}>
              <BarChart3 size={24} color={colors.text} />
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.periodSelector}>
            {timePeriods.map((period) => (
              <TouchableOpacity
                key={period.value}
                style={[
                  styles.periodButton,
                  {
                    backgroundColor: timePeriod === period.value ? colors.text : colors.background,
                    borderColor: colors.divider,
                  },
                ]}
                onPress={() => setTimePeriod(period.value)}
              >
                <Calendar
                  size={14}
                  color={timePeriod === period.value ? colors.background : colors.muted}
                />
                <Text
                  style={[
                    styles.periodText,
                    { color: timePeriod === period.value ? colors.background : colors.muted },
                  ]}
                >
                  {period.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Commerce Specific Metrics */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Sales Performance</Text>
          <View style={styles.metricsGrid}>
            {metrics.map((metric, index) => {
              const IconComponent = metric.icon;
              return (
                <View
                  key={index}
                  style={[
                    styles.metricCard,
                    { backgroundColor: colors.background, borderColor: colors.divider },
                  ]}
                >
                  <View style={styles.metricHeader}>
                    <View style={[styles.iconContainer, { backgroundColor: `${metric.color}15` }]}>
                      <IconComponent size={18} color={metric.color} strokeWidth={1.5} />
                    </View>
                    <View style={styles.trendContainer}>
                      {renderTrendIcon(metric.change)}
                      <Text
                        style={[
                          styles.trendText,
                          { color: metric.change > 0 ? '#10B981' : '#EF4444' },
                        ]}
                      >
                        {Math.abs(metric.change)}%
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.metricValue, { color: colors.text }]}>
                    {metric.value}
                  </Text>
                  <Text style={[styles.metricTitle, { color: colors.muted }]}>
                    {metric.title}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Conversion Metrics */}
        {conversion && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Conversion Metrics</Text>
            <View style={[styles.conversionContainer, { borderColor: colors.divider }]}>
              <View style={styles.conversionRow}>
                <Text style={[styles.conversionLabel, { color: colors.muted }]}>
                  Conversion Rate
                </Text>
                <Text style={[styles.conversionValue, { color: colors.text }]}>
                  {conversion.conversionRate.toFixed(1)}%
                </Text>
              </View>
              <View style={styles.conversionRow}>
                <Text style={[styles.conversionLabel, { color: colors.muted }]}>
                  Average Order Value
                </Text>
                <Text style={[styles.conversionValue, { color: colors.text }]}>
                  ${conversion.averageOrderValue.toFixed(2)}
                </Text>
              </View>
              <View style={styles.conversionRow}>
                <Text style={[styles.conversionLabel, { color: colors.muted }]}>
                  Cart Abandonment Rate
                </Text>
                <Text style={[styles.conversionValue, { color: colors.text }]}>
                  {conversion.cartAbandonmentRate.toFixed(1)}%
                </Text>
              </View>
              <View style={styles.conversionRow}>
                <Text style={[styles.conversionLabel, { color: colors.muted }]}>
                  Repeat Purchase Rate
                </Text>
                <Text style={[styles.conversionValue, { color: colors.text }]}>
                  {conversion.repeatPurchaseRate.toFixed(1)}%
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Top Performing Categories with Bar Chart */}
        {categories.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Top Categories</Text>
            <View style={[styles.categoriesContainer, { borderColor: colors.divider }]}>
              {(() => {
                const maxRevenue = Math.max(...categories.map(c => c.revenue));
                return categories.map((category, index) => {
                  const percentage = (category.revenue / maxRevenue) * 100;
                  return (
                    <View
                      key={index}
                      style={[
                        styles.categoryItem,
                        { borderBottomColor: index === categories.length - 1 ? 'transparent' : colors.divider },
                      ]}
                    >
                      <View style={styles.categoryInfo}>
                        <Text style={[styles.categoryName, { color: colors.text }]}>
                          {category.category}
                        </Text>
                        <View style={styles.categoryStats}>
                          <Text style={[styles.categoryRevenue, { color: colors.text }]}>
                            ${category.revenue.toLocaleString()}
                          </Text>
                          <Text style={[styles.categoryOrders, { color: colors.muted }]}>
                            {category.orders} orders
                          </Text>
                        </View>
                      </View>
                      <View style={styles.barChartContainer}>
                        <View
                          style={[
                            styles.barChart,
                            {
                              width: `${percentage}%`,
                              backgroundColor: `${colors.text}${Math.floor((percentage / 100) * 255).toString(16).padStart(2, '0')}`,
                            },
                          ]}
                        />
                      </View>
                    </View>
                  );
                });
              })()}
            </View>
          </View>
        )}

        {/* Sales Channels with Progress Bars */}
        {channels.length > 0 && (
          <View style={[styles.section, { marginBottom: 40 }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Sales by Channel</Text>
            <View style={[styles.channelsContainer, { borderColor: colors.divider }]}>
              {channels.map((channel, index) => {
                const channelColors = ['#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#EF4444'];
                const channelColor = channelColors[index % channelColors.length];

                return (
                  <View key={index} style={styles.channelItem}>
                    <View style={styles.channelHeader}>
                      <View style={styles.channelLabelContainer}>
                        <View style={[styles.channelDot, { backgroundColor: channelColor }]} />
                        <Text style={[styles.channelLabel, { color: colors.text }]}>
                          {channel.channel || 'Unknown'}
                        </Text>
                      </View>
                      <View style={styles.channelValueContainer}>
                        <Text style={[styles.channelPercentage, { color: colors.text }]}>
                          {channel.percentage.toFixed(1)}%
                        </Text>
                        <Text style={[styles.channelRevenue, { color: colors.muted }]}>
                          ${channel.revenue.toLocaleString()}
                        </Text>
                      </View>
                    </View>
                    <View style={[styles.progressBar, { backgroundColor: colors.divider }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: `${channel.percentage}%`,
                            backgroundColor: channelColor,
                          },
                        ]}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
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
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
  },
  iconBadge: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  periodSelector: {
    flexDirection: 'row',
    gap: 8,
  },
  periodButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 8,
  },
  periodText: {
    fontSize: 13,
    fontWeight: '500',
  },
  section: {
    marginBottom: 24,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 12,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricCard: {
    width: (width - 52) / 2,
    padding: 16,
    borderRadius: 8,
    borderWidth: 0.5,
  },
  metricHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  trendContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trendText: {
    fontSize: 11,
    fontWeight: '600',
  },
  metricValue: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 4,
  },
  metricTitle: {
    fontSize: 12,
  },
  conversionContainer: {
    borderRadius: 8,
    borderWidth: 0.5,
    padding: 16,
  },
  conversionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  conversionLabel: {
    fontSize: 13,
  },
  conversionValue: {
    fontSize: 13,
    fontWeight: '500',
  },
  categoriesContainer: {
    borderRadius: 8,
    borderWidth: 0.5,
    padding: 12,
  },
  categoryItem: {
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  categoryInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  categoryName: {
    fontSize: 14,
    fontWeight: '500',
  },
  categoryStats: {
    alignItems: 'flex-end',
  },
  categoryRevenue: {
    fontSize: 13,
    fontWeight: '500',
  },
  categoryOrders: {
    fontSize: 11,
    marginTop: 2,
  },
  barChartContainer: {
    height: 6,
    backgroundColor: '#F3F4F6',
    borderRadius: 3,
    overflow: 'hidden',
  },
  barChart: {
    height: '100%',
    borderRadius: 3,
  },
  channelsContainer: {
    borderRadius: 8,
    borderWidth: 0.5,
    padding: 16,
  },
  channelItem: {
    marginBottom: 16,
  },
  channelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  channelLabelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  channelDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  channelLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  channelValueContainer: {
    alignItems: 'flex-end',
  },
  channelPercentage: {
    fontSize: 16,
    fontWeight: '600',
  },
  channelRevenue: {
    fontSize: 11,
    marginTop: 2,
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
});