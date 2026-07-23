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
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import api, { Customer as ApiCustomer } from '@/services/api';
import { useToast } from '@/contexts/ToastContext';

// Extend API Customer type with UI-specific fields
interface Customer extends Omit<ApiCustomer, 'vipStatus'> {
  segment: 'vip' | 'regular' | 'new';
  vipStatus: ApiCustomer['vipStatus'];
}

export default function CustomersScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [segmentFilter, setSegmentFilter] = useState<'all' | 'vip' | 'regular' | 'new'>('all');

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    filterCustomers();
  }, [searchQuery, segmentFilter, customers]);

  const loadCustomers = async () => {
    try {
      setLoading(true);

      // Call the real API
      const response = await api.getCustomers({
        limit: 100, // Load first 100 customers
        sortBy: 'totalspent',
        sortOrder: 'desc',
      });

      if (response.success && response.data) {
        // Map API customers to UI customers with segment field
        const apiCustomers = response.data.items || [];
        const mappedCustomers: Customer[] = apiCustomers.map((customer) => {
          // Determine segment based on VIP status and order count
          let segment: 'vip' | 'regular' | 'new' = 'regular';

          if (customer.vipStatus && customer.vipStatus !== 'none') {
            segment = 'vip';
          } else if (customer.orderCount === 0 || !customer.firstPurchaseDate) {
            segment = 'new';
          }

          return {
            ...customer,
            segment,
          };
        });

        setCustomers(mappedCustomers);
        setFilteredCustomers(mappedCustomers);
      } else {
        console.error('Invalid response format:', response);
        toast.error(response.error || 'Failed to load customers');
      }
    } catch (error) {
      console.error('Error loading customers:', error);
      toast.error('Failed to load customers. Please check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterCustomers = () => {
    let filtered = [...customers];

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter((customer) =>
        `${customer.firstName} ${customer.lastName}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
        customer.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        customer.phone?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Segment filter
    if (segmentFilter !== 'all') {
      filtered = filtered.filter((customer) => customer.segment === segmentFilter);
    }

    setFilteredCustomers(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadCustomers();
  };

  const handleCustomerPress = (customer: Customer) => {
    router.push(`/customer/${customer.id}` as any);
  };

  const getSegmentLabel = (segment: string) => {
    switch (segment) {
      case 'vip': return 'VIP';
      case 'regular': return 'REGULAR';
      case 'new': return 'NEW';
      default: return 'UNKNOWN';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const renderCustomer = ({ item }: { item: Customer }) => (
    <TouchableOpacity
      style={[styles.customerItem, { borderBottomColor: colors.divider }]}
      onPress={() => handleCustomerPress(item)}
      activeOpacity={0.7}
    >
      <View style={styles.customerRow}>
        <Text style={[styles.customerName, { color: colors.text }]}>
          {item.name || `${item.firstName} ${item.lastName}`}
        </Text>
        <Text style={[styles.customerSpent, { color: colors.text }]}>
          ${item.totalSpent.toFixed(2)}
        </Text>
      </View>

      <View style={styles.customerRow}>
        <Text style={[styles.customerEmail, { color: colors.muted }]}>
          {item.email}
        </Text>
        <Text style={[styles.customerOrders, { color: colors.muted }]}>
          {item.orderCount} orders
        </Text>
      </View>

      <View style={styles.customerRow}>
        <Text style={[styles.customerSegment, { color: colors.muted }]}>
          {getSegmentLabel(item.segment)}
        </Text>
        <Text style={[styles.customerRegistered, { color: colors.muted }]}>
          {formatDate(item.createdAt)}
        </Text>
      </View>
    </TouchableOpacity>
  );

  const renderStats = () => {
    const totalCustomers = customers.length;
    const vipCustomers = customers.filter(c => c.segment === 'vip').length;
    const newCustomers = customers.filter(c => c.segment === 'new').length;
    const averageSpent = customers.length > 0
      ? customers.reduce((sum, c) => sum + c.totalSpent, 0) / customers.length
      : 0;

    return (
      <View style={[styles.statsContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.text }]}>{totalCustomers}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>Total</Text>
        </View>

        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.text }]}>{vipCustomers}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>VIP</Text>
        </View>

        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.text }]}>{newCustomers}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>New</Text>
        </View>

        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.text }]}>${averageSpent.toFixed(0)}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>Avg Spent</Text>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading customers...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Customers ({filteredCustomers.length})</Text>
        <TouchableOpacity style={styles.addButton}>
          <Text style={[styles.addButtonText, { color: colors.text }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search customers..."
          placeholderTextColor={colors.muted}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {/* Segment Filter */}
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          style={[styles.filterButton, { borderBottomColor: segmentFilter === 'all' ? colors.text : 'transparent' }]}
          onPress={() => setSegmentFilter('all')}
        >
          <Text style={[styles.filterButtonText, { color: segmentFilter === 'all' ? colors.text : colors.muted }]}>
            All
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, { borderBottomColor: segmentFilter === 'vip' ? colors.text : 'transparent' }]}
          onPress={() => setSegmentFilter('vip')}
        >
          <Text style={[styles.filterButtonText, { color: segmentFilter === 'vip' ? colors.text : colors.muted }]}>
            VIP
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, { borderBottomColor: segmentFilter === 'regular' ? colors.text : 'transparent' }]}
          onPress={() => setSegmentFilter('regular')}
        >
          <Text style={[styles.filterButtonText, { color: segmentFilter === 'regular' ? colors.text : colors.muted }]}>
            Regular
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, { borderBottomColor: segmentFilter === 'new' ? colors.text : 'transparent' }]}
          onPress={() => setSegmentFilter('new')}
        >
          <Text style={[styles.filterButtonText, { color: segmentFilter === 'new' ? colors.text : colors.muted }]}>
            New
          </Text>
        </TouchableOpacity>
      </View>

      {/* Stats */}
      {renderStats()}

      {/* Customers List */}
      <FlatList
        data={filteredCustomers}
        renderItem={renderCustomer}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.muted }]}>No customers found</Text>
          </View>
        }
      />
    </SafeAreaView>
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
    padding: 24,
    borderBottomWidth: 0.5,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '400',
    letterSpacing: -0.3,
  },
  addButton: {
    padding: 4,
  },
  addButtonText: {
    fontSize: 12,
    fontWeight: '400',
  },
  searchContainer: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  searchInput: {
    fontSize: 12,
    fontWeight: '400',
    paddingVertical: 8,
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    gap: 24,
  },
  filterButton: {
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  filterButtonText: {
    fontSize: 10,
    fontWeight: '400',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
    gap: 24,
  },
  statItem: {
    flex: 1,
    alignItems: 'flex-start',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '400',
    lineHeight: 20,
  },
  statLabel: {
    fontSize: 10,
    marginTop: 2,
    fontWeight: '400',
  },
  listContainer: {
    paddingHorizontal: 24,
  },
  customerItem: {
    paddingVertical: 20,
    borderBottomWidth: 0.5,
  },
  customerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  customerName: {
    fontSize: 12,
    fontWeight: '400',
    flex: 1,
    paddingRight: 16,
  },
  customerSpent: {
    fontSize: 12,
    fontWeight: '400',
  },
  customerEmail: {
    fontSize: 10,
    fontWeight: '400',
  },
  customerOrders: {
    fontSize: 10,
    fontWeight: '400',
  },
  customerSegment: {
    fontSize: 8,
    fontWeight: '400',
    letterSpacing: 0.3,
  },
  customerRegistered: {
    fontSize: 10,
    fontWeight: '400',
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
});