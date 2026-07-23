import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  CreditCard,
  Receipt,
  AlertCircle,
  BarChart3,
  PieChart,
} from 'lucide-react-native';
import api, { AccountingAnalytics } from '@/services/api';

export default function AnalyticsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [analytics, setAnalytics] = useState<AccountingAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadAnalytics();
  }, []);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      const response = await api.getAccountingAnalytics();
      if (response.success && response.data) {
        setAnalytics(response.data);
      }
    } catch (error) {
      console.error('Error loading accounting analytics:', error);
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

  const formatChange = (change: number) => {
    const prefix = change >= 0 ? '+' : '';
    return `${prefix}${change.toFixed(1)}%`;
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
          Analytics will appear here once you have transactions
        </Text>
      </View>
    );
  }

  const maxRevenue = Math.max(...analytics.monthlyRevenue.map(m => m.revenue), 1);
  const totalExpenses = analytics.expenseBreakdown.reduce((sum, e) => sum + e.amount, 0);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 45 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      {/* Summary Cards */}
      <View style={styles.summaryGrid}>
        <View style={[styles.summaryCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.summaryHeader}>
            <View style={[styles.summaryIcon, { backgroundColor: '#10B98120' }]}>
              <DollarSign size={18} color="#10B981" strokeWidth={2} />
            </View>
            {analytics.summary.revenue.change !== 0 && (
              <View style={styles.changeContainer}>
                {analytics.summary.revenue.change >= 0 ? (
                  <TrendingUp size={12} color="#10B981" strokeWidth={2} />
                ) : (
                  <TrendingDown size={12} color="#EF4444" strokeWidth={2} />
                )}
                <Text
                  style={[
                    styles.changeText,
                    { color: analytics.summary.revenue.change >= 0 ? '#10B981' : '#EF4444' },
                  ]}
                >
                  {formatChange(analytics.summary.revenue.change)}
                </Text>
              </View>
            )}
          </View>
          <Text style={[styles.summaryValue, { color: colors.text }]}>
            {formatCurrency(analytics.summary.revenue.amount)}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.muted }]}>Revenue</Text>
        </View>

        <View style={[styles.summaryCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.summaryHeader}>
            <View style={[styles.summaryIcon, { backgroundColor: '#EF444420' }]}>
              <CreditCard size={18} color="#EF4444" strokeWidth={2} />
            </View>
            {analytics.summary.expenses.change !== 0 && (
              <View style={styles.changeContainer}>
                {analytics.summary.expenses.change <= 0 ? (
                  <TrendingDown size={12} color="#10B981" strokeWidth={2} />
                ) : (
                  <TrendingUp size={12} color="#EF4444" strokeWidth={2} />
                )}
                <Text
                  style={[
                    styles.changeText,
                    { color: analytics.summary.expenses.change <= 0 ? '#10B981' : '#EF4444' },
                  ]}
                >
                  {formatChange(analytics.summary.expenses.change)}
                </Text>
              </View>
            )}
          </View>
          <Text style={[styles.summaryValue, { color: colors.text }]}>
            {formatCurrency(analytics.summary.expenses.amount)}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.muted }]}>Expenses</Text>
        </View>

        <View style={[styles.summaryCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.summaryHeader}>
            <View style={[styles.summaryIcon, { backgroundColor: '#3B82F620' }]}>
              <TrendingUp size={18} color="#3B82F6" strokeWidth={2} />
            </View>
            {analytics.summary.profit.change !== 0 && (
              <View style={styles.changeContainer}>
                {analytics.summary.profit.change >= 0 ? (
                  <TrendingUp size={12} color="#10B981" strokeWidth={2} />
                ) : (
                  <TrendingDown size={12} color="#EF4444" strokeWidth={2} />
                )}
                <Text
                  style={[
                    styles.changeText,
                    { color: analytics.summary.profit.change >= 0 ? '#10B981' : '#EF4444' },
                  ]}
                >
                  {formatChange(analytics.summary.profit.change)}
                </Text>
              </View>
            )}
          </View>
          <Text style={[styles.summaryValue, { color: analytics.summary.profit.amount >= 0 ? colors.text : '#EF4444' }]}>
            {formatCurrency(analytics.summary.profit.amount)}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.muted }]}>Profit</Text>
        </View>

        <View style={[styles.summaryCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.summaryHeader}>
            <View style={[styles.summaryIcon, { backgroundColor: '#F59E0B20' }]}>
              <AlertCircle size={18} color="#F59E0B" strokeWidth={2} />
            </View>
          </View>
          <Text style={[styles.summaryValue, { color: colors.text }]}>
            {formatCurrency(analytics.summary.outstanding.amount)}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.muted }]}>Outstanding</Text>
        </View>
      </View>

      {/* Monthly Revenue Chart */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <View style={styles.sectionHeader}>
          <BarChart3 size={18} color="#3B82F6" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Monthly Revenue</Text>
        </View>
        <View style={styles.barChart}>
          {analytics.monthlyRevenue.map((month, index) => (
            <View key={index} style={styles.barChartItem}>
              <View style={styles.barWrapper}>
                <View
                  style={[
                    styles.barFill,
                    {
                      height: `${(month.revenue / maxRevenue) * 100}%`,
                      backgroundColor: '#3B82F6',
                    },
                  ]}
                />
              </View>
              <Text style={[styles.barLabel, { color: colors.muted }]}>{month.month}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Invoice Breakdown */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <View style={styles.sectionHeader}>
          <Receipt size={18} color="#10B981" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Invoice Status</Text>
        </View>
        <View style={styles.invoiceGrid}>
          <View style={[styles.invoiceItem, { backgroundColor: '#10B98110' }]}>
            <Text style={[styles.invoiceValue, { color: '#10B981' }]}>
              {analytics.invoiceBreakdown.paid}
            </Text>
            <Text style={[styles.invoiceLabel, { color: colors.muted }]}>Paid</Text>
          </View>
          <View style={[styles.invoiceItem, { backgroundColor: '#F59E0B10' }]}>
            <Text style={[styles.invoiceValue, { color: '#F59E0B' }]}>
              {analytics.invoiceBreakdown.pending}
            </Text>
            <Text style={[styles.invoiceLabel, { color: colors.muted }]}>Pending</Text>
          </View>
          <View style={[styles.invoiceItem, { backgroundColor: '#6B728010' }]}>
            <Text style={[styles.invoiceValue, { color: '#6B7280' }]}>
              {analytics.invoiceBreakdown.draft}
            </Text>
            <Text style={[styles.invoiceLabel, { color: colors.muted }]}>Draft</Text>
          </View>
          <View style={[styles.invoiceItem, { backgroundColor: '#EF444410' }]}>
            <Text style={[styles.invoiceValue, { color: '#EF4444' }]}>
              {analytics.invoiceBreakdown.overdue}
            </Text>
            <Text style={[styles.invoiceLabel, { color: colors.muted }]}>Overdue</Text>
          </View>
        </View>
      </View>

      {/* Expense Breakdown */}
      <View style={[styles.section, { borderColor: colors.divider, marginBottom: 32 }]}>
        <View style={styles.sectionHeader}>
          <PieChart size={18} color="#EF4444" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Expense Categories</Text>
        </View>
        {analytics.expenseBreakdown.length === 0 ? (
          <Text style={[styles.emptyListText, { color: colors.muted }]}>
            No expenses recorded
          </Text>
        ) : (
          analytics.expenseBreakdown.map((expense, index) => (
            <View key={index} style={styles.expenseRow}>
              <View style={styles.expenseInfo}>
                <Text style={[styles.expenseCategory, { color: colors.text }]}>
                  {expense.category}
                </Text>
                <Text style={[styles.expensePercent, { color: colors.muted }]}>
                  {expense.percentage.toFixed(1)}%
                </Text>
              </View>
              <View style={styles.expenseBarContainer}>
                <View style={[styles.expenseBarBg, { backgroundColor: colors.divider }]}>
                  <View
                    style={[
                      styles.expenseBarFill,
                      {
                        width: `${expense.percentage}%`,
                        backgroundColor: getExpenseColor(index),
                      },
                    ]}
                  />
                </View>
              </View>
              <Text style={[styles.expenseAmount, { color: colors.text }]}>
                {formatCurrency(expense.amount)}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const getExpenseColor = (index: number) => {
  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'];
  return colors[index % colors.length];
};

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
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 16,
    gap: 12,
  },
  summaryCard: {
    width: '47%',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  summaryIcon: {
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
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 2,
  },
  summaryLabel: {
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
  },
  barChart: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 120,
  },
  barChartItem: {
    flex: 1,
    alignItems: 'center',
  },
  barWrapper: {
    width: 24,
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
  invoiceGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  invoiceItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 8,
  },
  invoiceValue: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 2,
  },
  invoiceLabel: {
    fontSize: 10,
  },
  expenseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  expenseInfo: {
    width: 100,
  },
  expenseCategory: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'capitalize',
  },
  expensePercent: {
    fontSize: 10,
  },
  expenseBarContainer: {
    flex: 1,
    marginHorizontal: 10,
  },
  expenseBarBg: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  expenseBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  expenseAmount: {
    width: 70,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
  emptyListText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
