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
import type { PickListDto, PickListStatus } from '@/types/wms';
import {
  getPickListStatusColor,
  getPriorityColor,
  formatDate,
  formatRelativeTime,
  calculatePickingProgress,
} from '@/utils/wms-helpers';
import { ChevronLeft, Search, ClipboardList, User, Package, AlertCircle } from 'lucide-react-native';

const STATUS_OPTIONS: { key: PickListStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

export default function PickListsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { } = useWms();

  const [pickLists, setPickLists] = useState<PickListDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<PickListStatus | 'all'>('all');
  const [totalPickLists, setTotalPickLists] = useState(0);

  useEffect(() => {
    loadPickLists();
  }, [selectedStatus]);

  const loadPickLists = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (selectedStatus !== 'all') {
        filters.status = selectedStatus;
      }

      const response = await api.getPickLists(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const pickLists = Array.isArray(items) ? items : [];
        setPickLists(pickLists);
        setTotalPickLists(pickLists.length);
      } else {
        throw new Error(response.error || 'Failed to load pick lists');
      }
    } catch (error) {
      console.error('Error loading pick lists:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPickLists();
  }, [loadPickLists]);

  const handlePickListPress = (pickList: PickListDto) => {
    router.push(`/wms/picklists/${pickList.id}` as any);
  };

  // Filter pick lists based on search query
  const filteredPickLists = pickLists.filter((pickList) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      pickList.pickListNumber.toLowerCase().includes(query) ||
      pickList.pickerName?.toLowerCase().includes(query) ||
      pickList.id.toLowerCase().includes(query)
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

  const renderPickListItem = ({ item }: { item: PickListDto }) => {
    const statusColor = getPickListStatusColor(item.status);
    const priorityColor = getPriorityColor(item.priority);
    const progress = calculatePickingProgress(
      item.items.filter((i) => i.pickedQuantity > 0).length,
      item.items.length
    );

    return (
      <TouchableOpacity
        style={[styles.pickListItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handlePickListPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.pickListHeader}>
          <View style={styles.pickListHeaderLeft}>
            <Text style={[styles.pickListNumber, { color: colors.text }]}>{item.pickListNumber}</Text>
            {item.pickerName && (
              <View style={styles.assignedTo}>
                <User size={12} color={colors.muted} />
                <Text style={[styles.assignedToText, { color: colors.muted }]}>{item.pickerName}</Text>
              </View>
            )}
          </View>
          <View style={styles.pickListHeaderRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {item.status.replace(/_/g, ' ')}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.pickListDetails}>
          <View style={styles.detailRow}>
            <View style={styles.detailItem}>
              <Package size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]}>
                {item.items.length} items
              </Text>
            </View>
            <View style={[styles.priorityBadge, { backgroundColor: priorityColor + '20' }]}>
              <Text style={[styles.priorityText, { color: priorityColor }]}>
                {item.priority}
              </Text>
            </View>
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
                {progress.completed} of {progress.total} picked
              </Text>
            </View>
          )}
        </View>

        <View style={styles.pickListFooter}>
          <Text style={[styles.pickListTime, { color: colors.muted }]}>
            Created {formatRelativeTime(item.createdAt)}
          </Text>
          {item.dueDate && (
            <View style={styles.dueDate}>
              <AlertCircle size={12} color="#F59E0B" />
              <Text style={[styles.dueDateText, { color: '#F59E0B' }]}>
                Due {formatDate(item.dueDate)}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <ClipboardList size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyText, { color: colors.muted }]}>No pick lists found</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Pick lists will appear here when they are created
      </Text>
    </View>
  );

  if (loading && pickLists.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading pick lists...</Text>
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
          <Text style={[styles.headerTitle, { color: colors.text }]}>Pick Lists</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={[styles.pickListCount, { color: colors.muted }]}>
          {filteredPickLists.length} {filteredPickLists.length === 1 ? 'pick list' : 'pick lists'}
        </Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by pick list #, assignee..."
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

      {/* Pick Lists */}
      <FlatList
        data={filteredPickLists}
        renderItem={renderPickListItem}
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
  pickListCount: {
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
  pickListItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  pickListHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  pickListHeaderLeft: {
    flex: 1,
  },
  pickListHeaderRight: {
    marginLeft: 12,
  },
  pickListNumber: {
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
  pickListDetails: {
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailText: {
    fontSize: 13,
  },
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  priorityText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  progressSection: {
    marginTop: 12,
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
  pickListFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pickListTime: {
    fontSize: 12,
  },
  dueDate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dueDateText: {
    fontSize: 11,
    fontWeight: '500',
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
