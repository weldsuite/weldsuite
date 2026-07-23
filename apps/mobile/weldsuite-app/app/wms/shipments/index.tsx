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
import type { ShipmentDto, ShipmentStatus } from '@/types/wms';
import {
  getShipmentStatusColor,
  formatDate,
  formatRelativeTime,
  formatMoney,
} from '@/utils/wms-helpers';
import { ChevronLeft, Search, Truck, Package, MapPin, Clock } from 'lucide-react-native';

const STATUS_OPTIONS: { key: ShipmentStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'ready_to_ship', label: 'Ready' },
  { key: 'in_transit', label: 'In Transit' },
  { key: 'out_for_delivery', label: 'Out for Delivery' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'failed', label: 'Failed' },
  { key: 'returned', label: 'Returned' },
];

export default function ShipmentsListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { } = useWms();

  const [shipments, setShipments] = useState<ShipmentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<ShipmentStatus | 'all'>('all');
  const [totalShipments, setTotalShipments] = useState(0);

  useEffect(() => {
    loadShipments();
  }, [selectedStatus]);

  const loadShipments = useCallback(async () => {
    try {
      setLoading(true);

      const filters: any = {
        limit: 100,
      };

      if (selectedStatus !== 'all') {
        filters.status = selectedStatus;
      }

      const response = await api.getShipments(filters);

      if (response.success && response.data) {
        // Handle paginated response - items are in response.data.items
        const items = response.data.items || response.data;
        const shipments = Array.isArray(items) ? items : [];
        setShipments(shipments);
        setTotalShipments(shipments.length);
      } else {
        throw new Error(response.error || 'Failed to load shipments');
      }
    } catch (error) {
      console.error('Error loading shipments:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedStatus]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadShipments();
  }, [loadShipments]);

  const handleShipmentPress = (shipment: ShipmentDto) => {
    router.push(`/wms/shipments/${shipment.id}` as any);
  };

  // Filter shipments based on search query
  const filteredShipments = shipments.filter((shipment) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      shipment.trackingNumber?.toLowerCase().includes(query) ||
      shipment.carrierName?.toLowerCase().includes(query) ||
      shipment.orderNumber?.toLowerCase().includes(query) ||
      shipment.id.toLowerCase().includes(query)
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

  const renderShipmentItem = ({ item }: { item: ShipmentDto }) => {
    const statusColor = getShipmentStatusColor(item.status);

    return (
      <TouchableOpacity
        style={[styles.shipmentItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleShipmentPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.shipmentHeader}>
          <View style={styles.shipmentHeaderLeft}>
            {item.trackingNumber ? (
              <>
                <Text style={[styles.trackingNumber, { color: colors.text }]}>
                  {item.trackingNumber}
                </Text>
                {item.carrierName && (
                  <View style={styles.carrierInfo}>
                    <Truck size={12} color={colors.muted} />
                    <Text style={[styles.carrierText, { color: colors.muted }]}>
                      {item.carrierName}
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <Text style={[styles.noTracking, { color: colors.muted }]}>No tracking number</Text>
            )}
          </View>
          <View style={styles.shipmentHeaderRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {item.status.replace(/_/g, ' ')}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.shipmentDetails}>
          {item.orderNumber && (
            <View style={styles.detailRow}>
              <Package size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]}>
                Order: {item.orderNumber}
              </Text>
            </View>
          )}
          {item.shippingAddress && (
            <View style={styles.detailRow}>
              <MapPin size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]} numberOfLines={1}>
                {item.shippingAddress.city}, {item.shippingAddress.state}
              </Text>
            </View>
          )}
          {item.estimatedDeliveryDate && (
            <View style={styles.detailRow}>
              <Clock size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.muted }]}>
                Est. delivery: {formatDate(item.estimatedDeliveryDate)}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.shipmentFooter}>
          <Text style={[styles.shipmentTime, { color: colors.muted }]}>
            Shipped {formatRelativeTime(item.shipmentDate)}
          </Text>
          {item.shippingCost && (
            <Text style={[styles.shippingCost, { color: colors.text }]}>
              {formatMoney(item.shippingCost.amount, item.shippingCost.currency)}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Truck size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyText, { color: colors.muted }]}>No shipments found</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Shipments will appear here when they are created
      </Text>
    </View>
  );

  if (loading && shipments.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading shipments...</Text>
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
          <Text style={[styles.headerTitle, { color: colors.text }]}>Shipments</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={[styles.shipmentCount, { color: colors.muted }]}>
          {filteredShipments.length} {filteredShipments.length === 1 ? 'shipment' : 'shipments'}
        </Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by tracking #, carrier, order..."
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

      {/* Shipments List */}
      <FlatList
        data={filteredShipments}
        renderItem={renderShipmentItem}
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
  shipmentCount: {
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
  shipmentItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  shipmentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  shipmentHeaderLeft: {
    flex: 1,
  },
  shipmentHeaderRight: {
    marginLeft: 12,
  },
  trackingNumber: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  noTracking: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  carrierInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  carrierText: {
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
  shipmentDetails: {
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
  shipmentFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  shipmentTime: {
    fontSize: 12,
  },
  shippingCost: {
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
