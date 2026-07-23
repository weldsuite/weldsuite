import React, { useState, useEffect } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { RotateCcw } from 'lucide-react-native';
import api from '@/services/api';

interface ReturnItem {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  reason: string;
  notes?: string;
}

interface ParcelReturn {
  id: string;
  returnNumber: string;
  status: string;
  originalTrackingNumber?: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  reason: string;
  items: ReturnItem[];
  returnTrackingNumber?: string;
  returnLabelUrl?: string;
  returnMethod: string;
  receivedAt?: string;
  processedAt?: string;
  refundAmount?: {
    amount: number;
    currency: string;
    formatted: string;
  };
  customerNotes?: string;
  createdAt: string;
  updatedAt?: string;
}

const RETURN_STATUS_CONFIG: Record<string, { label: string; color: string; backgroundColor: string; icon: string }> = {
  requested: {
    label: 'Requested',
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    icon: 'time-outline',
  },
  approved: {
    label: 'Approved',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
    icon: 'checkmark-circle-outline',
  },
  label_sent: {
    label: 'Label Sent',
    color: '#5B21B6',
    backgroundColor: '#EDE9FE',
    icon: 'document-outline',
  },
  in_transit: {
    label: 'In Transit',
    color: '#0369A1',
    backgroundColor: '#E0F2FE',
    icon: 'car-outline',
  },
  received: {
    label: 'Received',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
    icon: 'archive-outline',
  },
  processing: {
    label: 'Processing',
    color: '#7C3AED',
    backgroundColor: '#F3E8FF',
    icon: 'sync-outline',
  },
  completed: {
    label: 'Completed',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
    icon: 'checkmark-done-outline',
  },
  rejected: {
    label: 'Rejected',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
    icon: 'close-circle-outline',
  },
};

export default function ReturnsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [returns, setReturns] = useState<ParcelReturn[]>([]);
  const [filteredReturns, setFilteredReturns] = useState<ParcelReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadReturns();
  }, []);

  useEffect(() => {
    filterReturns();
  }, [selectedStatus, searchQuery, returns]);

  const loadReturns = async () => {
    try {
      setLoading(true);
      const response = await api.getParcelReturns({
        search: searchQuery || undefined
      });

      if (response.success && response.data) {
        setReturns(response.data.items);
        setFilteredReturns(response.data.items);
      }
    } catch (error) {
      console.error('Error loading returns:', error);
      toast.error('Failed to load returns');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterReturns = () => {
    let filtered = [...returns];

    if (selectedStatus) {
      filtered = filtered.filter((r) => r.status === selectedStatus);
    }

    if (searchQuery) {
      filtered = filtered.filter((r) =>
        r.returnNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (r.originalTrackingNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
      );
    }

    setFilteredReturns(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadReturns();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Returns', count: returns.length },
      { key: 'requested', label: 'Requested', count: returns.filter(r => r.status === 'requested').length },
      { key: 'approved', label: 'Approved', count: returns.filter(r => r.status === 'approved').length },
      { key: 'in_transit', label: 'In Transit', count: returns.filter(r => r.status === 'in_transit').length },
      { key: 'completed', label: 'Completed', count: returns.filter(r => r.status === 'completed').length },
      { key: 'rejected', label: 'Rejected', count: returns.filter(r => r.status === 'rejected').length },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedStatus === item.key ? colors.text : colors.background,
                  borderColor: selectedStatus === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedStatus(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedStatus === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedStatus === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderReturn = ({ item }: { item: ParcelReturn }) => {
    const statusConfig = RETURN_STATUS_CONFIG[item.status] || RETURN_STATUS_CONFIG.requested;

    return (
      <TouchableOpacity
        style={[styles.returnItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        activeOpacity={0.7}
      >
        <View style={styles.returnContent}>
          <View style={styles.returnLeft}>
            <Text style={[styles.returnNumber, { color: colors.text }]}>{item.returnNumber}</Text>
            <Text style={[styles.customerName, { color: colors.muted }]}>{item.customerName}</Text>
            {item.originalTrackingNumber && (
              <Text style={[styles.trackingRef, { color: colors.muted }]}>
                Original: {item.originalTrackingNumber}
              </Text>
            )}
            <Text style={[styles.returnInfo, { color: colors.muted }]}>
              {formatDate(item.createdAt)} · {item.items.length} item{item.items.length !== 1 ? 's' : ''}
            </Text>
          </View>
          <View style={styles.returnRight}>
            <Text style={[styles.reason, { color: colors.text }]} numberOfLines={1}>
              {item.reason}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
            {item.refundAmount && (
              <Text style={[styles.refundAmount, { color: '#10B981' }]}>
                {item.refundAmount.formatted}
              </Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <View style={[styles.iconContainer, { backgroundColor: '#F3F4F6' }]}>
        <RotateCcw size={32} color="#9CA3AF" strokeWidth={1.5} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No Returns</Text>
      <Text style={[styles.emptyDescription, { color: colors.muted }]}>
        {searchQuery || selectedStatus
          ? 'No returns match your filters'
          : 'Return requests will be displayed here'
        }
      </Text>
    </View>
  );

  if (loading) {
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
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Returns ({filteredReturns.length})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search returns..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={filteredReturns}
        renderItem={renderReturn}
        keyExtractor={(item) => item.id}
        contentContainerStyle={filteredReturns.length === 0 ? styles.emptyListContainer : styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
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
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchContainer: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 24,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterButtonCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  emptyListContainer: {
    flex: 1,
  },
  returnItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  returnContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  returnLeft: {
    flex: 1,
    gap: 2,
  },
  returnRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  returnNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  customerName: {
    fontSize: 14,
    fontWeight: '400',
  },
  trackingRef: {
    fontSize: 12,
    fontWeight: '400',
  },
  returnInfo: {
    fontSize: 12,
  },
  reason: {
    fontSize: 14,
    fontWeight: '500',
    maxWidth: 120,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  refundAmount: {
    fontSize: 12,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyDescription: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 250,
  },
});
