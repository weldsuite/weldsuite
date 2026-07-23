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
import { useToast } from '@/contexts/ToastContext';
import { router } from 'expo-router';
import api from '@/services/api';

interface AccountingStats {
  totalRevenue: number;
  todayRevenue: number;
  weekRevenue: number;
  monthRevenue: number;
  totalExpenses: number;
  pendingInvoices: number;
  overdueInvoices: number;
  paidInvoices: number;
  totalTransactions: number;
  profitMargin: number;
  totalAccounts: number;
  taxOwed: number;
}

interface RecentInvoice {
  id: string;
  clientName: string;
  amount: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue';
  dueDate: string;
}

interface RecentTransaction {
  id: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
  date: string;
}

export default function AccountingDashboardScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [stats, setStats] = useState<AccountingStats | null>(null);
  const [recentInvoices, setRecentInvoices] = useState<RecentInvoice[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<RecentTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadAccountingData();
  }, []);

  const loadAccountingData = async () => {
    try {
      setLoading(true);

      // Fetch all dashboard data in parallel
      const [statsResponse, invoicesResponse, transactionsResponse] = await Promise.all([
        api.getAccountingDashboardStats(),
        api.getRecentInvoices(5),
        api.getRecentTransactions(5),
      ]);

      if (statsResponse.success && statsResponse.data) {
        setStats(statsResponse.data);
      }

      if (invoicesResponse.success && invoicesResponse.data) {
        setRecentInvoices(invoicesResponse.data);
      }

      if (transactionsResponse.success && transactionsResponse.data) {
        setRecentTransactions(transactionsResponse.data);
      }
    } catch (error) {
      console.error('Error loading accounting data:', error);
      toast.error('Failed to load accounting data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadAccountingData();
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'draft': return 'DRAFT';
      case 'sent': return 'SENT';
      case 'paid': return 'PAID';
      case 'overdue': return 'OVERDUE';
      default: return status.toUpperCase();
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid': return '#10B981';
      case 'overdue': return '#EF4444';
      case 'sent': return '#3B82F6';
      case 'draft': return colors.muted;
      default: return colors.muted;
    }
  };

  const renderRecentInvoice = ({ item }: { item: RecentInvoice }) => (
    <TouchableOpacity
      style={[styles.invoiceItem, { borderBottomColor: colors.divider }]}
      onPress={() => router.push(`/invoice/${item.id}` as any)}
    >
      <View style={styles.invoiceRow}>
        <Text style={[styles.invoiceClient, { color: colors.text }]}>{item.clientName}</Text>
        <Text style={[styles.invoiceAmount, { color: colors.text }]}>${item.amount.toFixed(2)}</Text>
      </View>
      <View style={styles.invoiceRow}>
        <Text style={[styles.invoiceStatus, { color: getStatusColor(item.status) }]}>{getStatusText(item.status)}</Text>
        <Text style={[styles.invoiceDate, { color: colors.muted }]}>{item.dueDate}</Text>
      </View>
    </TouchableOpacity>
  );

  const renderRecentTransaction = ({ item }: { item: RecentTransaction }) => (
    <View style={[styles.transactionItem, { borderBottomColor: colors.divider }]}>
      <View style={styles.transactionLeft}>
        <Text style={[styles.transactionDesc, { color: colors.text }]}>{item.description}</Text>
        <Text style={[styles.transactionDate, { color: colors.muted }]}>{item.date}</Text>
      </View>
      <Text style={[
        styles.transactionAmount, 
        { color: item.type === 'income' ? '#10B981' : '#EF4444' }
      ]}>
        {item.type === 'income' ? '+' : '-'}${item.amount.toFixed(2)}
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Accounting Dashboard</Text>
      </View>
      
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        showsVerticalScrollIndicator={false}
      >

        {/* Revenue Metrics */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Revenue</Text>
          <View style={styles.metricsGrid}>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.todayRevenue.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Today</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.weekRevenue.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>This Week</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.monthRevenue.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>This Month</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.totalRevenue.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Total</Text>
            </View>
          </View>
        </View>

        {/* Financial Overview */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Overview</Text>
          <View style={styles.overviewGrid}>
            <TouchableOpacity style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: colors.text }]}>${stats?.totalExpenses.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Expenses</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: '#10B981' }]}>{stats?.profitMargin.toFixed(1)}%</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Profit Margin</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: '#EF4444' }]}>${stats?.taxOwed.toLocaleString()}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Tax Owed</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Invoice Status */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Invoices</Text>
          <View style={styles.invoiceMetrics}>
            <TouchableOpacity style={styles.metricItem} onPress={() => router.push('/invoices' as any)}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{stats?.pendingInvoices}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Pending</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metricItem} onPress={() => router.push('/invoices' as any)}>
              <Text style={[styles.metricValue, { color: '#EF4444' }]}>{stats?.overdueInvoices}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Overdue</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metricItem} onPress={() => router.push('/invoices' as any)}>
              <Text style={[styles.metricValue, { color: '#10B981' }]}>{stats?.paidInvoices}</Text>
              <Text style={[styles.metricLabel, { color: colors.muted }]}>Paid</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
          <View style={styles.actionsList}>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: colors.divider }]} onPress={() => router.push('/invoice/new' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>Create Invoice</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: colors.divider }]} onPress={() => router.push('/transaction/new' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>Add Transaction</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: colors.divider }]} onPress={() => router.push('/reports' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>Generate Report</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: 'transparent' }]} onPress={() => router.push('/ledger' as any)}>
              <Text style={[styles.actionText, { color: colors.text }]}>View Ledger</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Recent Invoices */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Invoices</Text>
            <TouchableOpacity onPress={() => router.push('/invoices' as any)}>
              <Text style={[styles.viewAllText, { color: colors.muted }]}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.listContainer}>
            <FlatList
              data={recentInvoices}
              renderItem={renderRecentInvoice}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
            />
          </View>
        </View>

        {/* Recent Transactions */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Transactions</Text>
            <TouchableOpacity onPress={() => router.push('/transactions' as any)}>
              <Text style={[styles.viewAllText, { color: colors.muted }]}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.listContainer}>
            <FlatList
              data={recentTransactions}
              renderItem={renderRecentTransaction}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
            />
          </View>
        </View>
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
    fontSize: 12,
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
    fontSize: 14,
    fontWeight: '400',
    marginBottom: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  viewAllText: {
    fontSize: 10,
    fontWeight: '400',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  overviewGrid: {
    flexDirection: 'row',
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
    fontSize: 10,
    marginTop: 2,
    fontWeight: '400',
  },
  invoiceMetrics: {
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
    fontSize: 12,
    fontWeight: '400',
  },
  listContainer: {
    gap: 0,
  },
  invoiceItem: {
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  invoiceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  invoiceClient: {
    fontSize: 12,
    fontWeight: '400',
    marginBottom: 2,
  },
  invoiceAmount: {
    fontSize: 12,
    fontWeight: '400',
    marginBottom: 2,
  },
  invoiceStatus: {
    fontSize: 10,
    fontWeight: '400',
    letterSpacing: 0.3,
  },
  invoiceDate: {
    fontSize: 10,
    fontWeight: '400',
  },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  transactionLeft: {
    flex: 1,
  },
  transactionDesc: {
    fontSize: 12,
    fontWeight: '400',
    marginBottom: 2,
  },
  transactionDate: {
    fontSize: 10,
    fontWeight: '400',
  },
  transactionAmount: {
    fontSize: 12,
    fontWeight: '400',
  },
});