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
import type { CycleCountDto, CycleCountStatus } from '@/types/wms';
import {
  getCycleCountStatusColor,
  formatDate,
  formatRelativeTime,
  calculatePickingProgress,
} from '@/utils/wms-helpers';
import { ChevronLeft, Search, Clipboard, User, CheckSquare, Clock } from 'lucide-react-native';

const STATUS_OPTIONS: { key: CycleCountStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

export default function CycleCountsListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { } = useWms();

  const [cycleCounts, setCycleCounts] = useState<CycleCountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<CycleCountStatus | 'all'>('all');
  const [totalCounts, setTotalCounts] = useState(0);

  useEffect(() => {
    loadCycleCounts();
  }, [selectedStatus]);

  const loadCycleCounts = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (selectedStatus !== 'all') {
        filters.status = selectedStatus;
      }

      const response = await api.getCycleCounts(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const cycleCounts = Array.isArray(items) ? items : [];
        setCycleCounts(cycleCounts);
        setTotalCounts(cycleCounts.length);
      } else {
        throw new Error(response.error || 'Failed to load cycle counts');
      }
    } catch (error) {
      console.error('Error loading cycle counts:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadCycleCounts();
  }, [loadCycleCounts]);

  const handleCycleCountPress = (cycleCount: CycleCountDto) => {
    router.push(`/wms/cycle-counts/${cycleCount.id}` as any);
  };

  // Filter cycle counts based on search query
  const filteredCycleCounts = cycleCounts.filter((count) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      count.countNumber.toLowerCase().includes(query) ||
      count.assignedToName?.toLowerCase().includes(query) ||
      count.id.toLowerCase().includes(query)
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

  const renderCycleCountItem = ({ item }: { item: CycleCountDto }) => {
    const statusColor = getCycleCountStatusColor(item.status);
    const progress = calculatePickingProgress(
      item.items.filter((i) => i.countedQuantity !== null).length,
      item.items.length
    );

    return (
      <TouchableOpacity
        style={[styles.countItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleCycleCountPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.countHeader}>
          <View style={styles.countHeaderLeft}>
            <Text style={[styles.countNumber, { color: colors.text }]}>{item.countNumber}</Text>
            {item.assignedToName && (
              <View style={styles.assignedTo}>
                <User size={12} color={colors.muted} />
                <Text style={[styles.assignedToText, { color: colors.muted }]}>
                  {item.assignedToName}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.countHeaderRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {item.status.replace(/_/g, ' ')}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.countDetails}>
          <View style={styles.detailRow}>
            <CheckSquare size={14} color={colors.muted} />
            <Text style={[styles.detailText, { color: colors.muted }]}>
              {item.items.length} items
            </Text>
          </View>
          {item.scheduledDate && (
            <View style={styles.detailRow}>
              <Clock size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]}>
                Scheduled: {formatDate(item.scheduledDate)}
              </Text>
            </View>
          )}
        </View>

        {item.status === 'in_progress' && (
          <View style={styles.progressSection}>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${progress.percentage}%`, backgroundColor: colors.text },
                ]}
              />
            </View>
            <Text style={[styles.progressText, { color: colors.muted }]}>
              {progress.completed} of {progress.total} counted
            </Text>
          </View>
        )}

        <View style={styles.countFooter}>
          <Text style={[styles.countTime, { color: colors.muted }]}>
            Created {formatRelativeTime(item.createdAt)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Clipboard size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyText, { color: colors.muted }]}>No cycle counts found</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Cycle counts will appear here when they are created
      </Text>
    </View>
  );

  if (loading && cycleCounts.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading cycle counts...</Text>
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
          <Text style={[styles.headerTitle, { color: colors.text }]}>Cycle Counts</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={[styles.countCount, { color: colors.muted }]}>
          {filteredCycleCounts.length} {filteredCycleCounts.length === 1 ? 'count' : 'counts'}
        </Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by count #, assignee..."
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

      {/* Cycle Counts List */}
      <FlatList
        data={filteredCycleCounts}
        renderItem={renderCycleCountItem}
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
  countCount: {
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
  countItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  countHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  countHeaderLeft: {
    flex: 1,
  },
  countHeaderRight: {
    marginLeft: 12,
  },
  countNumber: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  assignedTo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  assignedToText: {
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
  countDetails: {
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
  },
  progressSection: {
    marginBottom: 12,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressText: {
    fontSize: 12,
  },
  countFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  countTime: {
    fontSize: 12,
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
