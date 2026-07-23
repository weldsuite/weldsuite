import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  FileText,
  Receipt,
  Camera,
  BarChart3,
  ChevronRight,
  AlertCircle,
  Clock,
  CheckCircle2,
  TrendingUp,
} from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import type { DashboardData, Invoice } from '@/types/accounting';

const STATUS_COLORS: Record<string, string> = {
  draft: '#F59E0B',
  sent: '#3B82F6',
  paid: '#10B981',
  overdue: '#EF4444',
  cancelled: '#6B7280',
  viewed: '#8B5CF6',
  refunded: '#6B7280',
};

export default function DashboardScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      setError(null);
      const response = await api.getDashboard();
      if (response.data) {
        setData(response.data);
      }
    } catch (err) {
      setError('Failed to load dashboard data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboard();
  }, [fetchDashboard]);

  const handleQuickAction = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as any);
    },
    [router],
  );

  const handleInvoiceTap = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(`/invoice/${id}` as any);
    },
    [router],
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading dashboard...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centered}>
          <AlertCircle size={48} color={colors.muted} />
          <Text style={[styles.errorText, { color: colors.text }]}>{error}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              setLoading(true);
              fetchDashboard();
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const invoiceStats = data?.invoices;
  const recentInvoices = data?.recentInvoices?.slice(0, 5) ?? [];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Dashboard</Text>
          <Text style={[styles.headerSubtitle, { color: colors.muted }]}>
            Financial overview
          </Text>
        </View>

        {/* Revenue Cards */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.revenueCardsContainer}
        >
          <RevenueCard
            label="Today"
            amount={formatCurrency(0)}
            icon={<TrendingUp size={18} color="#10B981" />}
            colors={colors}
          />
          <RevenueCard
            label="This Week"
            amount={formatCurrency(0)}
            icon={<TrendingUp size={18} color="#10B981" />}
            colors={colors}
          />
          <RevenueCard
            label="This Month"
            amount={formatCurrency(invoiceStats?.revenueMonth ?? 0)}
            icon={<TrendingUp size={18} color="#10B981" />}
            colors={colors}
          />
        </ScrollView>

        {/* Invoice Status */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Invoice Status</Text>
          <View style={[styles.statusCard, { backgroundColor: colors.cardBackground }]}>
            <StatusRow
              label="Pending"
              count={invoiceStats?.sent ?? 0}
              color="#3B82F6"
              icon={<Clock size={16} color="#3B82F6" />}
              colors={colors}
            />
            <View style={[styles.statusDivider, { backgroundColor: colors.divider }]} />
            <StatusRow
              label="Overdue"
              count={invoiceStats?.overdue ?? 0}
              color="#EF4444"
              icon={<AlertCircle size={16} color="#EF4444" />}
              colors={colors}
            />
            <View style={[styles.statusDivider, { backgroundColor: colors.divider }]} />
            <StatusRow
              label="Paid"
              count={invoiceStats?.paid ?? 0}
              color="#10B981"
              icon={<CheckCircle2 size={16} color="#10B981" />}
              colors={colors}
            />
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
          <View style={styles.quickActionsGrid}>
            <QuickActionButton
              label="Create Invoice"
              icon={<FileText size={24} color="#10B981" />}
              onPress={() => handleQuickAction('/invoice/new')}
              colors={colors}
            />
            <QuickActionButton
              label="Scan Receipt"
              icon={<Camera size={24} color="#10B981" />}
              onPress={() => handleQuickAction('/scan')}
              colors={colors}
            />
            <QuickActionButton
              label="Quick Expense"
              icon={<Receipt size={24} color="#10B981" />}
              onPress={() => handleQuickAction('/expense/quick')}
              colors={colors}
            />
            <QuickActionButton
              label="View Reports"
              icon={<BarChart3 size={24} color="#10B981" />}
              onPress={() => handleQuickAction('/reports')}
              colors={colors}
            />
          </View>
        </View>

        {/* Recent Invoices */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Invoices</Text>
          {recentInvoices.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: colors.cardBackground }]}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                No recent invoices
              </Text>
            </View>
          ) : (
            <View style={[styles.invoiceListCard, { backgroundColor: colors.cardBackground }]}>
              {recentInvoices.map((invoice, index) => (
                <InvoiceRow
                  key={invoice.id}
                  invoice={invoice}
                  isLast={index === recentInvoices.length - 1}
                  onPress={() => handleInvoiceTap(invoice.id)}
                  colors={colors}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function RevenueCard({
  label,
  amount,
  icon,
  colors,
}: {
  label: string;
  amount: string;
  icon: React.ReactNode;
  colors: any;
}) {
  return (
    <View style={[styles.revenueCard, { backgroundColor: colors.cardBackground }]}>
      <View style={styles.revenueCardHeader}>
        {icon}
        <Text style={[styles.revenueCardLabel, { color: colors.muted }]}>{label}</Text>
      </View>
      <Text style={[styles.revenueCardAmount, { color: colors.text }]}>{amount}</Text>
    </View>
  );
}

function StatusRow({
  label,
  count,
  color,
  icon,
  colors,
}: {
  label: string;
  count: number;
  color: string;
  icon: React.ReactNode;
  colors: any;
}) {
  return (
    <View style={styles.statusRow}>
      <View style={styles.statusRowLeft}>
        {icon}
        <Text style={[styles.statusLabel, { color: colors.text }]}>{label}</Text>
      </View>
      <View style={[styles.statusBadge, { backgroundColor: color + '18' }]}>
        <Text style={[styles.statusBadgeText, { color }]}>{count}</Text>
      </View>
    </View>
  );
}

function QuickActionButton({
  label,
  icon,
  onPress,
  colors,
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  colors: any;
}) {
  return (
    <TouchableOpacity
      style={[styles.quickActionButton, { backgroundColor: colors.cardBackground }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.quickActionIcon}>{icon}</View>
      <Text style={[styles.quickActionLabel, { color: colors.text }]} numberOfLines={2}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function InvoiceRow({
  invoice,
  isLast,
  onPress,
  colors,
}: {
  invoice: Invoice;
  isLast: boolean;
  onPress: () => void;
  colors: any;
}) {
  const statusColor = STATUS_COLORS[invoice.status] ?? colors.muted;

  return (
    <TouchableOpacity
      style={[styles.invoiceRow, !isLast && { borderBottomWidth: 1, borderBottomColor: colors.divider }]}
      onPress={onPress}
      activeOpacity={0.6}
    >
      <View style={styles.invoiceRowLeft}>
        <Text style={[styles.invoiceNumber, { color: colors.text }]}>
          {invoice.invoiceNumber}
        </Text>
        <Text style={[styles.invoiceClient, { color: colors.muted }]} numberOfLines={1}>
          {invoice.contactName}
        </Text>
      </View>
      <View style={styles.invoiceRowRight}>
        <Text style={[styles.invoiceAmount, { color: colors.text }]}>
          {formatCurrency(invoice.total, invoice.currency)}
        </Text>
        <View style={[styles.invoiceStatusBadge, { backgroundColor: statusColor + '18' }]}>
          <Text style={[styles.invoiceStatusText, { color: statusColor }]}>
            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
          </Text>
        </View>
      </View>
      <ChevronRight size={16} color={colors.muted} style={styles.chevron} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  errorText: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#10B981',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
  },
  headerSubtitle: {
    fontSize: 14,
    marginTop: 2,
  },
  revenueCardsContainer: {
    paddingHorizontal: 20,
    gap: 12,
    paddingBottom: 4,
  },
  revenueCard: {
    width: 160,
    padding: 16,
    borderRadius: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  revenueCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  revenueCardLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  revenueCardAmount: {
    fontSize: 20,
    fontWeight: '700',
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  statusCard: {
    borderRadius: 12,
    padding: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  statusRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    minWidth: 32,
    alignItems: 'center',
  },
  statusBadgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  statusDivider: {
    height: 1,
    marginHorizontal: 16,
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  quickActionButton: {
    width: '47%',
    flexGrow: 1,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  quickActionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#10B98115',
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionLabel: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  invoiceListCard: {
    borderRadius: 12,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  emptyCard: {
    borderRadius: 12,
    padding: 32,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  emptyText: {
    fontSize: 14,
  },
  invoiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  invoiceRowLeft: {
    flex: 1,
    marginRight: 12,
  },
  invoiceNumber: {
    fontSize: 14,
    fontWeight: '600',
  },
  invoiceClient: {
    fontSize: 13,
    marginTop: 2,
  },
  invoiceRowRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  invoiceAmount: {
    fontSize: 14,
    fontWeight: '600',
  },
  invoiceStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  invoiceStatusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  chevron: {
    marginLeft: 8,
  },
});
