import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useWms } from '@/contexts/WmsContext';
import api from '@/services/api';
import type { ReturnDto, ReturnStatus } from '@/types/wms';
import {
  getReturnStatusColor,
  formatDate,
  formatRelativeTime,
  formatMoney,
} from '@/utils/wms-helpers';
import { ChevronLeft, Search, RotateCcw, Package, User, AlertCircle } from 'lucide-react-native';

const STATUS_OPTIONS: { key: ReturnStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'received', label: 'Received' },
  { key: 'inspecting', label: 'Inspecting' },
  { key: 'restocking', label: 'Restocking' },
  { key: 'completed', label: 'Completed' },
  { key: 'rejected', label: 'Rejected' },
];

export default function ReturnsListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { } = useWms();

  const [returns, setReturns] = useState<ReturnDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<ReturnStatus | 'all'>('all');
  const [totalReturns, setTotalReturns] = useState(0);

  useEffect(() => {
    loadReturns();
  }, [selectedStatus]);

  const loadReturns = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (selectedStatus !== 'all') {
        filters.status = selectedStatus;
      }

      const response = await api.getReturns(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const returns = Array.isArray(items) ? items : [];
        setReturns(returns);
        setTotalReturns(returns.length);
      } else {
        throw new Error(response.error || 'Failed to load returns');
      }
    } catch (error) {
      console.error('Error loading returns:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadReturns();
  }, [loadReturns]);

  const handleReturnPress = (returnItem: ReturnDto) => {
    router.push(`/wms/returns/${returnItem.id}` as any);
  };

  // Filter returns based on search query
  const filteredReturns = returns.filter((returnItem) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      returnItem.returnNumber.toLowerCase().includes(query) ||
      returnItem.customerName?.toLowerCase().includes(query) ||
      returnItem.orderNumber?.toLowerCase().includes(query) ||
      returnItem.id.toLowerCase().includes(query)
    );
  });

  const renderStatusFilter = () => (
    <View style={styles.filterSection}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterList}
      >
        {STATUS_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.key}
            style={[
              styles.filterChip,
              {
                backgroundColor: selectedStatus === option.key ? colors.text : colors.background,
                borderColor: colors.buttonBorder,
              },
            ]}
            onPress={() => setSelectedStatus(option.key)}
          >
            <Text
              style={[
                styles.filterChipText,
                { color: selectedStatus === option.key ? colors.background : colors.text },
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderReturnItem = ({ item }: { item: ReturnDto }) => {
    const statusColor = getReturnStatusColor(item.status);

    return (
      <TouchableOpacity
        style={[styles.returnItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleReturnPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.returnHeader}>
          <View style={styles.returnHeaderLeft}>
            <Text style={[styles.returnNumber, { color: colors.text }]}>{item.returnNumber}</Text>
            {item.customerName && (
              <View style={styles.customerInfo}>
                <User size={12} color={colors.muted} />
                <Text style={[styles.customerText, { color: colors.muted }]}>
                  {item.customerName}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.returnHeaderRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {item.status}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.returnDetails}>
          {item.orderNumber && (
            <View style={styles.detailRow}>
              <Package size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]}>
                Order: {item.orderNumber}
              </Text>
            </View>
          )}
          <View style={styles.detailRow}>
            <Text style={[styles.detailText, { color: colors.muted }]}>
              {item.items.length} {item.items.length === 1 ? 'item' : 'items'}
            </Text>
          </View>
          {item.reason && (
            <View style={styles.detailRow}>
              <AlertCircle size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]} numberOfLines={1}>
                {item.reason}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.returnFooter}>
          <Text style={[styles.returnTime, { color: colors.muted }]}>
            Created {formatRelativeTime(item.createdAt)}
          </Text>
          {item.refundAmount && (
            <Text style={[styles.refundAmount, { color: colors.text }]}>
              Refund: {formatMoney(item.refundAmount.amount, item.refundAmount.currency)}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <RotateCcw size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyText, { color: colors.muted }]}>No returns found</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Returns will appear here when they are created
      </Text>
    </View>
  );

  if (loading && returns.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading returns...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Returns</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={[styles.returnCount, { color: colors.muted }]}>
          {filteredReturns.length} {filteredReturns.length === 1 ? 'return' : 'returns'}
        </Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by return #, customer, order..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {/* Status Filter */}
      <View style={[styles.filtersContainer, { borderBottomColor: colors.divider }]}>
        {renderStatusFilter()}
      </View>

      {/* Returns List */}
      <FlatList
        data={filteredReturns}
        renderItem={renderReturnItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.tint} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />
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
  header: {
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
  },
  warehouseText: {
    fontSize: 14,
    marginTop: 4,
  },
  returnCount: {
    fontSize: 14,
    marginTop: 4,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filtersContainer: {
    borderBottomWidth: 0.5,
    paddingVertical: 12,
  },
  filterSection: {
    paddingHorizontal: 16,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  listContainer: {
    paddingBottom: 20,
  },
  returnItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  returnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  returnHeaderLeft: {
    flex: 1,
  },
  returnHeaderRight: {
    marginLeft: 12,
  },
  returnNumber: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  customerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  customerText: {
    fontSize: 13,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  returnDetails: {
    gap: 8,
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailText: {
    fontSize: 13,
    flex: 1,
  },
  returnFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  returnTime: {
    fontSize: 12,
  },
  refundAmount: {
    fontSize: 14,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
});
