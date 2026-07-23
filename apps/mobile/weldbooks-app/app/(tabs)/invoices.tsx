import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Search, Plus, ChevronRight, FileText } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import type { Invoice } from '@/types/accounting';

const STATUS_COLORS: Record<string, string> = {
  draft: '#F59E0B',
  sent: '#3B82F6',
  paid: '#10B981',
  overdue: '#EF4444',
  cancelled: '#6B7280',
  viewed: '#8B5CF6',
  refunded: '#6B7280',
};

const FILTER_OPTIONS = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'paid', label: 'Paid' },
  { key: 'overdue', label: 'Overdue' },
] as const;

const PAGE_LIMIT = 20;

export default function InvoicesScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchInvoices = useCallback(
    async (pageNum: number, append = false) => {
      try {
        setError(null);
        const params: { page: number; limit: number; search?: string; status?: string } = {
          page: pageNum,
          limit: PAGE_LIMIT,
        };
        if (search.trim()) params.search = search.trim();
        if (activeFilter !== 'all') params.status = activeFilter;

        const response = await api.getInvoices(params);
        const result = response.data;

        if (result) {
          const items: Invoice[] = result.items ?? [];
          const meta = result.meta;

          if (append) {
            setInvoices((prev) => [...prev, ...items]);
          } else {
            setInvoices(items);
          }

          setHasNext(meta?.hasNext ?? false);
          setPage(pageNum);
        }
      } catch (err) {
        setError('Failed to load invoices');
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [search, activeFilter],
  );

  useEffect(() => {
    setLoading(true);
    setPage(1);
    fetchInvoices(1);
  }, [activeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setLoading(true);
      setPage(1);
      fetchInvoices(1);
    }, 400);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
    fetchInvoices(1);
  }, [fetchInvoices]);

  const onEndReached = useCallback(() => {
    if (!hasNext || loadingMore || loading) return;
    setLoadingMore(true);
    fetchInvoices(page + 1, true);
  }, [hasNext, loadingMore, loading, page, fetchInvoices]);

  const handleFilterPress = useCallback((key: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveFilter(key);
  }, []);

  const handleInvoiceTap = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(`/invoice/${id}` as any);
    },
    [router],
  );

  const handleCreateInvoice = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/invoice/new' as any);
  }, [router]);

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  const renderInvoice = useCallback(
    ({ item }: { item: Invoice }) => {
      const statusColor = STATUS_COLORS[item.status] ?? colors.muted;

      return (
        <TouchableOpacity
          style={[styles.invoiceItem, { backgroundColor: colors.cardBackground }]}
          onPress={() => handleInvoiceTap(item.id)}
          activeOpacity={0.6}
        >
          <View style={styles.invoiceItemLeft}>
            <View style={styles.invoiceItemHeader}>
              <Text style={[styles.invoiceNumber, { color: colors.text }]}>
                {item.invoiceNumber}
              </Text>
              <View style={[styles.statusBadge, { backgroundColor: statusColor + '18' }]}>
                <Text style={[styles.statusBadgeText, { color: statusColor }]}>
                  {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                </Text>
              </View>
            </View>
            <Text style={[styles.contactName, { color: colors.muted }]} numberOfLines={1}>
              {item.contactName}
            </Text>
            <Text style={[styles.invoiceDate, { color: colors.muted }]}>
              {formatDate(item.issueDate)}
            </Text>
          </View>
          <View style={styles.invoiceItemRight}>
            <Text style={[styles.invoiceTotal, { color: colors.text }]}>
              {formatCurrency(item.total, item.currency)}
            </Text>
            <ChevronRight size={16} color={colors.muted} />
          </View>
        </TouchableOpacity>
      );
    },
    [colors, handleInvoiceTap],
  );

  const renderEmpty = useCallback(() => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <FileText size={48} color={colors.muted} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No invoices found</Text>
        <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
          {search.trim()
            ? 'Try adjusting your search or filters'
            : 'Create your first invoice to get started'}
        </Text>
      </View>
    );
  }, [loading, colors, search]);

  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color="#10B981" />
      </View>
    );
  }, [loadingMore]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Invoices</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <View style={[styles.searchBar, { backgroundColor: colors.cardBackground }]}>
          <Search size={18} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search invoices..."
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
      </View>

      {/* Filter Chips */}
      <View style={styles.filterContainer}>
        <FlatList
          horizontal
          data={FILTER_OPTIONS}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          renderItem={({ item }) => {
            const isActive = activeFilter === item.key;
            return (
              <TouchableOpacity
                style={[
                  styles.filterChip,
                  isActive
                    ? styles.filterChipActive
                    : { backgroundColor: colors.cardBackground },
                ]}
                onPress={() => handleFilterPress(item.key)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    isActive ? styles.filterChipTextActive : { color: colors.text },
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Invoice List */}
      {loading && !refreshing ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.text }]}>{error}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              setLoading(true);
              fetchInvoices(1);
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={invoices}
          keyExtractor={(item) => item.id}
          renderItem={renderInvoice}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={renderFooter}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* FAB */}
      <TouchableOpacity style={styles.fab} onPress={handleCreateInvoice} activeOpacity={0.8}>
        <Plus size={28} color="#fff" strokeWidth={2.5} />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
  },
  searchContainer: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 10,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    height: '100%',
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
    fontWeight: '600',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 100,
    flexGrow: 1,
  },
  invoiceItem: {
    flexDirection: 'row',
    alignItems: 'center',
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
  invoiceItemLeft: {
    flex: 1,
    marginRight: 12,
  },
  invoiceItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  invoiceNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  contactName: {
    fontSize: 13,
    marginBottom: 2,
  },
  invoiceDate: {
    fontSize: 12,
  },
  invoiceItemRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  invoiceTotal: {
    fontSize: 15,
    fontWeight: '700',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 60,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
  },
  errorText: {
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
  footerLoader: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
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
