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
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface Parcel {
  id: string;
  trackingNumber: string;
  recipientName: string;
  senderName: string;
  status: string;
  weight: number;
  weightUnit?: string;
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: string;
  };
  currentLocation?: string;
  estimatedDeliveryDate?: string;
  recipientAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
  createdAt: string;
  updatedAt?: string;
}

const PARCEL_STATUS_CONFIG = {
  pending: {
    label: 'Pending',
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    icon: 'time-outline' as const,
  },
  'in-transit': {
    label: 'In Transit',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
    icon: 'car-outline' as const,
  },
  'out-for-delivery': {
    label: 'Out for Delivery',
    color: '#5B21B6',
    backgroundColor: '#EDE9FE',
    icon: 'bicycle-outline' as const,
  },
  delivered: {
    label: 'Delivered',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
    icon: 'checkmark-done-outline' as const,
  },
  delayed: {
    label: 'Delayed',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
    icon: 'alert-circle-outline' as const,
  },
  returned: {
    label: 'Returned',
    color: '#374151',
    backgroundColor: '#F3F4F6',
    icon: 'arrow-back-outline' as const,
  },
};

export default function ParcelsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [filteredParcels, setFilteredParcels] = useState<Parcel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusUpdateModalVisible, setStatusUpdateModalVisible] = useState(false);
  const [selectedParcel, setSelectedParcel] = useState<Parcel | null>(null);

  useEffect(() => {
    loadParcels();
  }, []);

  useEffect(() => {
    filterParcels();
  }, [selectedStatus, searchQuery, parcels]);

  const loadParcels = async () => {
    try {
      setLoading(true);
      const response = await api.getParcels({
        status: selectedStatus || undefined,
        search: searchQuery || undefined
      });

      if (response.success && response.data) {
        const mappedParcels: Parcel[] = response.data.items.map((p: any) => ({
          id: p.id,
          trackingNumber: p.trackingNumber || '',
          recipientName: p.recipientName || 'Unknown',
          senderName: p.senderName || 'Unknown',
          status: normalizeStatus(p.status),
          weight: p.weight || 0,
          weightUnit: p.weightUnit || 'kg',
          dimensions: p.dimensions,
          currentLocation: p.currentLocation || getStatusLocation(p.status),
          estimatedDeliveryDate: p.estimatedDeliveryDate,
          recipientAddress: p.recipientAddress,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));
        setParcels(mappedParcels);
        setFilteredParcels(mappedParcels);
      }
    } catch (error) {
      console.error('Error loading parcels:', error);
      toast.error('Failed to load parcels');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const normalizeStatus = (status: string): string => {
    if (!status) return 'pending';
    return status.toLowerCase().replace(/_/g, '-');
  };

  const getStatusLocation = (status: string): string => {
    const normalized = normalizeStatus(status);
    switch (normalized) {
      case 'pending': return 'Awaiting pickup';
      case 'label-created': return 'Label created, awaiting pickup';
      case 'picked-up': return 'Picked up from sender';
      case 'in-transit': return 'In transit to destination';
      case 'out-for-delivery': return 'On vehicle for delivery';
      case 'delivered': return 'Delivered to recipient';
      case 'delayed': return 'Delivery delayed';
      case 'returned': return 'Returned to sender';
      case 'cancelled': return 'Shipment cancelled';
      default: return 'Unknown location';
    }
  };

  const filterParcels = () => {
    let filtered = [...parcels];

    // Status filter
    if (selectedStatus) {
      filtered = filtered.filter((parcel) => parcel.status === selectedStatus);
    }

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter((parcel) =>
        parcel.trackingNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        parcel.recipientName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        parcel.senderName.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    setFilteredParcels(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadParcels();
  };

  const handleParcelPress = (parcel: Parcel) => {
    router.push(`/parcel/${parcel.id}` as any);
  };

  const handleUpdateParcelStatus = (parcel: Parcel) => {
    setSelectedParcel(parcel);
    setStatusUpdateModalVisible(true);
  };

  const updateParcelStatus = (newStatus: Parcel['status']) => {
    if (!selectedParcel) return;

    setParcels(parcels.map(parcel =>
      parcel.id === selectedParcel.id
        ? { ...parcel, status: newStatus, updatedAt: new Date().toISOString() }
        : parcel
    ));

    setStatusUpdateModalVisible(false);
    setSelectedParcel(null);
    toast.success(`Parcel ${selectedParcel.trackingNumber} status updated to ${newStatus}`);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Parcels', count: filteredParcels.length },
      { key: 'pending', label: 'Pending', count: parcels.filter(p => p.status === 'pending').length },
      { key: 'in-transit', label: 'In Transit', count: parcels.filter(p => p.status === 'in-transit').length },
      { key: 'out-for-delivery', label: 'Out for Delivery', count: parcels.filter(p => p.status === 'out-for-delivery').length },
      { key: 'delivered', label: 'Delivered', count: parcels.filter(p => p.status === 'delivered').length },
      { key: 'delayed', label: 'Delayed', count: parcels.filter(p => p.status === 'delayed').length },
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

  const renderParcel = ({ item }: { item: Parcel }) => {
    const statusConfig = PARCEL_STATUS_CONFIG[item.status as keyof typeof PARCEL_STATUS_CONFIG] || PARCEL_STATUS_CONFIG.pending;

    return (
      <TouchableOpacity
        style={[styles.parcelItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleParcelPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.parcelContent}>
          <View style={styles.parcelLeft}>
            <Text style={[styles.trackingNumber, { color: colors.text }]}>{item.trackingNumber}</Text>
            <Text style={[styles.recipientName, { color: colors.muted }]}>{item.recipientName}</Text>
            <Text style={[styles.parcelLocation, { color: colors.muted }]}>{item.currentLocation}</Text>
            <Text style={[styles.parcelInfo, { color: colors.muted }]}>
              {formatDate(item.createdAt)} · {item.weight} {item.weightUnit || 'kg'}
            </Text>
          </View>
          <View style={styles.parcelRight}>
            <Text style={[styles.senderName, { color: colors.text }]}>{item.senderName}</Text>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.muted }]}>No parcels found</Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading parcels...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Parcels ({filteredParcels.length})</Text>
        <TouchableOpacity
          style={[styles.addButton, { borderColor: colors.buttonBorder }]}
          onPress={() => router.push('/parcel/add-parcel' as any)}
        >
          <Ionicons name="add" size={16} color={colors.text} />
          <Text style={[styles.addButtonText, { color: colors.text }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search parcels, recipients..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={filteredParcels}
        renderItem={renderParcel}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />

      {/* Status Update Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={statusUpdateModalVisible}
        onRequestClose={() => setStatusUpdateModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Update Status</Text>
            {selectedParcel && (
              <Text style={[styles.modalSubtitle, { color: colors.muted }]}>Parcel {selectedParcel.trackingNumber}</Text>
            )}

            {Object.entries(PARCEL_STATUS_CONFIG).map(([status, config]) => (
              <TouchableOpacity
                key={status}
                style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                onPress={() => updateParcelStatus(status as Parcel['status'])}
              >
                <Text style={[styles.modalOptionText, { color: colors.text }]}>{config.label}</Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={[styles.modalCancel, { borderTopColor: colors.divider }]}
              onPress={() => setStatusUpdateModalVisible(false)}
            >
              <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  listContainer: {
    paddingHorizontal: 0,
  },
  parcelItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  parcelContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  parcelLeft: {
    flex: 1,
    gap: 2,
  },
  parcelRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  trackingNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  recipientName: {
    fontSize: 14,
    fontWeight: '400',
  },
  parcelLocation: {
    fontSize: 13,
    fontWeight: '400',
  },
  senderName: {
    fontSize: 14,
    fontWeight: '500',
  },
  parcelInfo: {
    fontSize: 12,
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
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    padding: 24,
    borderTopWidth: 0.5,
  },
  modalTitle: {
    fontSize: 12,
    fontWeight: '400',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  modalSubtitle: {
    fontSize: 10,
    textAlign: 'center',
    marginBottom: 24,
  },
  modalOption: {
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  modalOptionText: {
    fontSize: 12,
    fontWeight: '400',
  },
  modalCancel: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    borderTopWidth: 0.5,
  },
  modalCancelText: {
    fontSize: 12,
    fontWeight: '400',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
});