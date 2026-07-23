import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Plus,
  Receipt,
  Utensils,
  Car,
  Briefcase,
  Plane,
  Package,
  Zap,
  Shield,
  Tag,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import type { Bill, ExpenseCategory } from '@/types/accounting';

type BillStatus = 'all' | 'pending' | 'overdue' | 'paid';
type ViewMode = 'bills' | 'expenses';

const STATUS_FILTERS: { key: BillStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid' },
];

const CATEGORY_ICONS: Record<ExpenseCategory, typeof Utensils> = {
  food: Utensils,
  transport: Car,
  office: Briefcase,
  travel: Plane,
  supplies: Package,
  utilities: Zap,
  insurance: Shield,
  other: Tag,
};

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  food: 'Food',
  transport: 'Transport',
  office: 'Office',
  travel: 'Travel',
  supplies: 'Supplies',
  utilities: 'Utilities',
  insurance: 'Insurance',
  other: 'Other',
};

function getStatusColor(status: Bill['status']): { bg: string; text: string } {
  switch (status) {
    case 'paid':
      return { bg: '#D1FAE5', text: '#065F46' };
    case 'pending':
    case 'approved':
      return { bg: '#FEF3C7', text: '#92400E' };
    case 'overdue':
      return { bg: '#FEE2E2', text: '#991B1B' };
    case 'rejected':
      return { bg: '#F3F4F6', text: '#6B7280' };
    default:
      return { bg: '#F3F4F6', text: '#6B7280' };
  }
}

export default function ExpensesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [viewMode, setViewMode] = useState<ViewMode>('bills');
  const [statusFilter, setStatusFilter] = useState<BillStatus>('all');
  const [bills, setBills] = useState<Bill[]>([]);
  const [quickExpenses, setQuickExpenses] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchBills = useCallback(
    async (pageNum = 1, isRefresh = false) => {
      try {
        if (pageNum === 1) {
          if (!isRefresh) setLoading(true);
        } else {
          setLoadingMore(true);
        }

        const params: { page: number; limit: number; status?: string } = {
          page: pageNum,
          limit: 20,
        };
        if (statusFilter !== 'all') {
          params.status = statusFilter;
        }

        const response = await api.getBills(params);
        const data = response.data;
        const items: Bill[] = data?.bills || data?.data || [];

        if (pageNum === 1) {
          setBills(items);
        } else {
          setBills((prev) => [...prev, ...items]);
        }
        setHasMore(items.length === 20);
        setPage(pageNum);
      } catch {
        // Error silently handled
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [statusFilter]
  );

  const fetchQuickExpenses = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) setLoading(true);
      // Quick expenses are bills created via the quick expense flow
      const response = await api.getBills({ limit: 50 });
      const data = response.data;
      const items: Bill[] = data?.bills || data?.data || [];
      setQuickExpenses(items);
    } catch {
      // Error silently handled
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadData = useCallback(
    (isRefresh = false) => {
      if (viewMode === 'bills') {
        fetchBills(1, isRefresh);
      } else {
        fetchQuickExpenses(isRefresh);
      }
    },
    [viewMode, fetchBills, fetchQuickExpenses]
  );

  // Initial load and reload on filter/view changes
  useState(() => {
    loadData();
  });

  // Reload when filter or view mode changes
  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setLoading(true);
    if (mode === 'bills') {
      fetchBills(1);
    } else {
      fetchQuickExpenses();
    }
  };

  const handleStatusFilter = (status: BillStatus) => {
    setStatusFilter(status);
    setLoading(true);
    setTimeout(() => fetchBills(1), 0);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadData(true);
  };

  const handleLoadMore = () => {
    if (viewMode === 'bills' && hasMore && !loadingMore && !loading) {
      fetchBills(page + 1);
    }
  };

  const handleFabPress = () => {
    if (viewMode === 'bills') {
      router.push('/bill/new');
    } else {
      router.push('/expense/quick');
    }
  };

  const renderBillItem = ({ item }: { item: Bill }) => {
    const statusColor = getStatusColor(item.status);
    return (
      <TouchableOpacity
        style={[styles.billCard, { backgroundColor: colors.cardBackground }]}
        activeOpacity={0.7}
        onPress={() => router.push(`/bill/${item.id}`)}
      >
        <View style={styles.billCardContent}>
          <View style={styles.billCardLeft}>
            <Text style={[styles.billNumber, { color: colors.text }]}>
              {item.billNumber || 'No Number'}
            </Text>
            <Text style={[styles.vendorName, { color: colors.muted }]} numberOfLines={1}>
              {item.contactName || 'Unknown Vendor'}
            </Text>
            <Text style={[styles.billDate, { color: colors.muted }]}>
              {new Date(item.issueDate).toLocaleDateString()}
            </Text>
          </View>
          <View style={styles.billCardRight}>
            <Text style={[styles.billTotal, { color: colors.text }]}>
              {formatCurrency(item.total, item.currency)}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: statusColor.bg }]}>
              <Text style={[styles.statusText, { color: statusColor.text }]}>
                {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderExpenseItem = ({ item }: { item: Bill }) => {
    const category = (item.notes?.toLowerCase() as ExpenseCategory) || 'other';
    const IconComponent = CATEGORY_ICONS[category] || Tag;
    const label = CATEGORY_LABELS[category] || 'Other';

    return (
      <TouchableOpacity
        style={[styles.expenseCard, { backgroundColor: colors.cardBackground }]}
        activeOpacity={0.7}
        onPress={() => router.push(`/bill/${item.id}`)}
      >
        <View style={styles.expenseIconContainer}>
          <IconComponent size={20} color="#10B981" />
        </View>
        <View style={styles.expenseContent}>
          <Text style={[styles.expenseDescription, { color: colors.text }]} numberOfLines={1}>
            {item.contactName || label}
          </Text>
          <Text style={[styles.expenseCategory, { color: colors.muted }]}>{label}</Text>
        </View>
        <View style={styles.expenseRight}>
          <Text style={[styles.expenseAmount, { color: colors.text }]}>
            {formatCurrency(item.total, item.currency)}
          </Text>
          <Text style={[styles.expenseDate, { color: colors.muted }]}>
            {new Date(item.issueDate).toLocaleDateString()}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderListFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.loadingMore}>
        <ActivityIndicator size="small" color="#10B981" />
      </View>
    );
  };

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyState}>
        <Receipt size={48} color={colors.muted} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {viewMode === 'bills' ? 'No bills yet' : 'No quick expenses yet'}
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
          {viewMode === 'bills'
            ? 'Create a bill or scan a receipt to get started'
            : 'Use quick expense for fast expense entry'}
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Expenses</Text>
      </View>

      {/* Segmented Control */}
      <View style={[styles.segmentedControl, { backgroundColor: colors.cardBackground }]}>
        <TouchableOpacity
          style={[
            styles.segmentButton,
            viewMode === 'bills' && styles.segmentButtonActive,
          ]}
          activeOpacity={0.7}
          onPress={() => handleViewModeChange('bills')}
        >
          <Text
            style={[
              styles.segmentText,
              { color: colors.muted },
              viewMode === 'bills' && styles.segmentTextActive,
            ]}
          >
            Bills
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.segmentButton,
            viewMode === 'expenses' && styles.segmentButtonActive,
          ]}
          activeOpacity={0.7}
          onPress={() => handleViewModeChange('expenses')}
        >
          <Text
            style={[
              styles.segmentText,
              { color: colors.muted },
              viewMode === 'expenses' && styles.segmentTextActive,
            ]}
          >
            Quick Expenses
          </Text>
        </TouchableOpacity>
      </View>

      {/* Status Filters (Bills view only) */}
      {viewMode === 'bills' && (
        <View style={styles.filterContainer}>
          <FlatList
            horizontal
            data={STATUS_FILTERS}
            keyExtractor={(item) => item.key}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterList}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.filterChip,
                  { backgroundColor: colors.cardBackground },
                  statusFilter === item.key && styles.filterChipActive,
                ]}
                activeOpacity={0.7}
                onPress={() => handleStatusFilter(item.key)}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.muted },
                    statusFilter === item.key && styles.filterChipTextActive,
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      {/* Content */}
      {loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      ) : viewMode === 'bills' ? (
        <FlatList
          data={bills}
          keyExtractor={(item) => item.id}
          renderItem={renderBillItem}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={renderListFooter}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor="#10B981"
              colors={['#10B981']}
            />
          }
        />
      ) : (
        <FlatList
          data={quickExpenses}
          keyExtractor={(item) => item.id}
          renderItem={renderExpenseItem}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor="#10B981"
              colors={['#10B981']}
            />
          }
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        activeOpacity={0.8}
        onPress={handleFabPress}
      >
        <Plus size={24} color="#fff" strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  segmentedControl: {
    flexDirection: 'row',
    marginHorizontal: 20,
    borderRadius: 10,
    padding: 3,
    marginBottom: 12,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentButtonActive: {
    backgroundColor: '#10B981',
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#fff',
  },
  filterContainer: {
    marginBottom: 8,
  },
  filterList: {
    paddingHorizontal: 20,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  filterChipActive: {
    backgroundColor: '#10B981',
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterChipTextActive: {
    color: '#fff',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 100,
  },
  billCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  billCardContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  billCardLeft: {
    flex: 1,
    marginRight: 12,
  },
  billNumber: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  vendorName: {
    fontSize: 13,
    marginBottom: 2,
  },
  billDate: {
    fontSize: 12,
  },
  billCardRight: {
    alignItems: 'flex-end',
  },
  billTotal: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  expenseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  expenseIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#D1FAE5',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  expenseContent: {
    flex: 1,
  },
  expenseDescription: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  expenseCategory: {
    fontSize: 13,
  },
  expenseRight: {
    alignItems: 'flex-end',
  },
  expenseAmount: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 2,
  },
  expenseDate: {
    fontSize: 12,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingMore: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#10B981',
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#10B981',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
    }),
  },
});
