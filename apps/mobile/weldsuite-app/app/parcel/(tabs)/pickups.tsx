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
import { CalendarCheck } from 'lucide-react-native';
import api from '@/services/api';

interface TimeWindow {
  startTime: string;
  endTime: string;
}

interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

interface Pickup {
  id: string;
  pickupNumber: string;
  status: string;
  carrierId: string;
  carrierName: string;
  confirmationNumber?: string;
  pickupDate: string;
  timeWindow: TimeWindow;
  pickupAddress: Address;
  contactName?: string;
  contactPhone?: string;
  specialInstructions?: string;
  shipmentIds: string[];
  totalParcels: number;
  totalWeight: number;
  pickupCost?: {
    amount: number;
    currency: string;
    formatted: string;
  };
  confirmedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  createdAt: string;
  updatedAt?: string;
}

const PICKUP_STATUS_CONFIG: Record<string, { label: string; color: string; backgroundColor: string }> = {
  scheduled: {
    label: 'Scheduled',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
  },
  confirmed: {
    label: 'Confirmed',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  in_progress: {
    label: 'In Progress',
    color: '#7C3AED',
    backgroundColor: '#F3E8FF',
  },
  completed: {
    label: 'Completed',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  cancelled: {
    label: 'Cancelled',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
  },
};

export default function PickupsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [filteredPickups, setFilteredPickups] = useState<Pickup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadPickups();
  }, []);

  useEffect(() => {
    filterPickups();
  }, [selectedStatus, searchQuery, pickups]);

  const loadPickups = async () => {
    try {
      setLoading(true);
      const response = await api.getParcelPickups({
        search: searchQuery || undefined
      });

      if (response.success && response.data) {
        setPickups(response.data.items);
        setFilteredPickups(response.data.items);
      }
    } catch (error) {
      console.error('Error loading pickups:', error);
      toast.error('Failed to load pickups');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterPickups = () => {
    let filtered = [...pickups];

    if (selectedStatus) {
      filtered = filtered.filter((p) => p.status === selectedStatus);
    }

    if (searchQuery) {
      filtered = filtered.filter((p) =>
        p.pickupNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.carrierName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.confirmationNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false) ||
        (p.contactName?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
      );
    }

    setFilteredPickups(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadPickups();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatTimeWindow = (timeWindow: TimeWindow) => {
    return `${timeWindow.startTime} - ${timeWindow.endTime}`;
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Pickups', count: pickups.length },
      { key: 'scheduled', label: 'Scheduled', count: pickups.filter(p => p.status === 'scheduled').length },
      { key: 'confirmed', label: 'Confirmed', count: pickups.filter(p => p.status === 'confirmed').length },
      { key: 'completed', label: 'Completed', count: pickups.filter(p => p.status === 'completed').length },
      { key: 'cancelled', label: 'Cancelled', count: pickups.filter(p => p.status === 'cancelled').length },
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

  const renderPickup = ({ item }: { item: Pickup }) => {
    const statusConfig = PICKUP_STATUS_CONFIG[item.status] || PICKUP_STATUS_CONFIG.scheduled;

    return (
      <TouchableOpacity
        style={[styles.pickupItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        activeOpacity={0.7}
      >
        <View style={styles.pickupContent}>
          <View style={styles.pickupLeft}>
            <Text style={[styles.pickupNumber, { color: colors.text }]}>{item.pickupNumber}</Text>
            <Text style={[styles.carrierName, { color: colors.muted }]}>{item.carrierName}</Text>
            <Text style={[styles.pickupDate, { color: colors.text }]}>
              {formatDate(item.pickupDate)}
            </Text>
            <Text style={[styles.timeWindow, { color: colors.muted }]}>
              {formatTimeWindow(item.timeWindow)}
            </Text>
          </View>
          <View style={styles.pickupRight}>
            <Text style={[styles.parcelCount, { color: colors.text }]}>
              {item.totalParcels} parcel{item.totalParcels !== 1 ? 's' : ''}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
            {item.confirmationNumber && (
              <Text style={[styles.confirmationNumber, { color: colors.muted }]}>
                #{item.confirmationNumber}
              </Text>
            )}
          </View>
        </View>
        {item.pickupAddress && (
          <View style={styles.addressContainer}>
            <Text style={[styles.addressText, { color: colors.muted }]}>
              {item.pickupAddress.line1}, {item.pickupAddress.city}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <View style={[styles.iconContainer, { backgroundColor: '#F3F4F6' }]}>
        <CalendarCheck size={32} color="#9CA3AF" strokeWidth={1.5} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No Scheduled Pickups</Text>
      <Text style={[styles.emptyDescription, { color: colors.muted }]}>
        {searchQuery || selectedStatus
          ? 'No pickups match your filters'
          : 'Your scheduled pickups will appear here'
        }
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading pickups...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Pickups ({filteredPickups.length})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search pickups..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={filteredPickups}
        renderItem={renderPickup}
        keyExtractor={(item) => item.id}
        contentContainerStyle={filteredPickups.length === 0 ? styles.emptyListContainer : styles.listContainer}
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
  pickupItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  pickupContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  pickupLeft: {
    flex: 1,
    gap: 2,
  },
  pickupRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  pickupNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  carrierName: {
    fontSize: 14,
    fontWeight: '400',
  },
  pickupDate: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 4,
  },
  timeWindow: {
    fontSize: 12,
    fontWeight: '400',
  },
  parcelCount: {
    fontSize: 14,
    fontWeight: '500',
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
  confirmationNumber: {
    fontSize: 11,
    fontWeight: '400',
  },
  addressContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 0.5,
    borderTopColor: '#E5E7EB',
  },
  addressText: {
    fontSize: 12,
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
