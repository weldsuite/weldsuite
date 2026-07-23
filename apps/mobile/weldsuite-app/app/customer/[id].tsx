import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View,
  Text,
  ActivityIndicator,
  Image,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  total: number;
  date: string;
}

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  avatar?: string;
  totalOrders: number;
  totalSpent: number;
  averageOrderValue: number;
  lastOrderDate?: string;
  registeredDate: string;
  status: 'active' | 'inactive';
  address?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  segment: 'vip' | 'regular' | 'new';
  notes?: string;
  orders: CustomerOrder[];
}

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadCustomer();
  }, [id]);

  const loadCustomer = async () => {
    if (!id) return;

    try {
      setLoading(true);
      const response = await api.getCustomer(id);

      if (response.success && response.data) {
        // Transform API data to match component interface
        const customerData: Customer = {
          id: response.data.id,
          firstName: response.data.name?.split(' ')[0] || response.data.name || '',
          lastName: response.data.name?.split(' ').slice(1).join(' ') || '',
          email: response.data.email,
          phone: response.data.phone,
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(response.data.name || 'Customer')}&background=007AFF&color=fff`,
          totalOrders: response.data.orderCount || response.data.totalOrders || 0,
          totalSpent: response.data.totalSpent || 0,
          averageOrderValue: response.data.averageOrderValue || (response.data.totalSpent && response.data.orderCount ? response.data.totalSpent / response.data.orderCount : 0),
          lastOrderDate: response.data.lastOrderDate,
          registeredDate: response.data.createdAt || response.data.registeredDate,
          status: response.data.status || 'active',
          address: response.data.defaultShippingAddress ? {
            street: response.data.defaultShippingAddress.line1 || '',
            city: response.data.defaultShippingAddress.city || '',
            state: response.data.defaultShippingAddress.state || '',
            zipCode: response.data.defaultShippingAddress.postalCode || '',
            country: response.data.defaultShippingAddress.country || '',
          } : undefined,
          segment: (response.data.vipStatus ? 'vip' : response.data.orderCount && response.data.orderCount > 5 ? 'regular' : 'new') as 'vip' | 'regular' | 'new',
          notes: response.data.notes || response.data.internalNotes,
          orders: response.data.orders || [],
        };

        setCustomer(customerData);
      } else {
        throw new Error(response.error || 'Failed to load customer');
      }
    } catch (error) {
      console.error('Error loading customer:', error);
      toast.error('Failed to load customer details');
      router.back();
    } finally {
      setLoading(false);
    }
  };

  const getSegmentColor = (segment: string) => {
    switch (segment) {
      case 'vip': return '#FFD700';
      case 'regular': return '#007AFF';
      case 'new': return '#34C759';
      default: return '#666';
    }
  };

  const getSegmentLabel = (segment: string) => {
    switch (segment) {
      case 'vip': return 'VIP Customer';
      case 'regular': return 'Regular Customer';
      case 'new': return 'New Customer';
      default: return 'Unknown';
    }
  };

  const getOrderStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return '#ff9500';
      case 'processing': return '#007AFF';
      case 'shipped': return '#34c759';
      case 'delivered': return '#28a745';
      case 'cancelled': return '#dc3545';
      case 'refunded': return '#6c757d';
      default: return '#666';
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

  const renderSection = (title: string, children: React.ReactNode) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );

  const renderOrderItem = ({ item }: { item: CustomerOrder }) => (
    <TouchableOpacity
      style={styles.orderItem}
      onPress={() => router.push(`/order/${item.id}`)}
    >
      <View style={styles.orderInfo}>
        <Text style={styles.orderNumber}>#{item.orderNumber}</Text>
        <Text style={styles.orderDate}>{formatDate(item.date)}</Text>
      </View>
      <View style={styles.orderRight}>
        <Text style={styles.orderTotal}>${item.total.toFixed(2)}</Text>
        <Text style={styles.orderStatusText}>{item.status.toUpperCase()}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading customer...</Text>
      </View>
    );
  }

  if (!customer) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>Customer not found</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Ionicons name="arrow-back" size={24} color="#007AFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Customer Details</Text>
        <TouchableOpacity
          style={styles.moreButton}
          onPress={() => toast.info('Customer actions menu')}
        >
          <Ionicons name="ellipsis-horizontal" size={24} color="#007AFF" />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Customer Profile */}
        <View style={styles.profileSection}>
          <View style={styles.avatarContainer}>
            {customer.avatar ? (
              <Image source={{ uri: customer.avatar }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>
                  {customer.firstName.charAt(0)}{customer.lastName.charAt(0)}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.profileInfo}>
            <Text style={styles.customerName}>
              {customer.firstName} {customer.lastName}
            </Text>

            <View style={styles.segmentBadge}>
              <View style={[styles.segmentDot, { backgroundColor: getSegmentColor(customer.segment) }]} />
              <Text style={[styles.segmentText, { color: getSegmentColor(customer.segment) }]}>
                {getSegmentLabel(customer.segment)}
              </Text>
            </View>

            <View style={styles.statusIndicator}>
              <View style={[styles.statusDot, { backgroundColor: customer.status === 'active' ? '#34C759' : '#8E8E93' }]} />
              <Text style={styles.statusText}>{customer.status.toUpperCase()}</Text>
            </View>
          </View>
        </View>

        {/* Stats */}
        <View style={styles.statsContainer}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{customer.totalOrders}</Text>
            <Text style={styles.statLabel}>Total Orders</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>${customer.totalSpent.toLocaleString()}</Text>
            <Text style={styles.statLabel}>Total Spent</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>${customer.averageOrderValue.toFixed(0)}</Text>
            <Text style={styles.statLabel}>Avg Order</Text>
          </View>
        </View>

        {/* Contact Information */}
        {renderSection('Contact Information', (
          <>
            <View style={styles.contactRow}>
              <Ionicons name="mail" size={20} color="#007AFF" />
              <Text style={styles.contactText}>{customer.email}</Text>
            </View>
            {customer.phone && (
              <View style={styles.contactRow}>
                <Ionicons name="call" size={20} color="#007AFF" />
                <Text style={styles.contactText}>{customer.phone}</Text>
              </View>
            )}
            <View style={styles.contactRow}>
              <Ionicons name="calendar" size={20} color="#007AFF" />
              <Text style={styles.contactText}>
                Registered: {formatDate(customer.registeredDate)}
              </Text>
            </View>
            {customer.lastOrderDate && (
              <View style={styles.contactRow}>
                <Ionicons name="time" size={20} color="#007AFF" />
                <Text style={styles.contactText}>
                  Last order: {formatDate(customer.lastOrderDate)}
                </Text>
              </View>
            )}
          </>
        ))}

        {/* Address */}
        {customer.address && renderSection('Address', (
          <View style={styles.addressContainer}>
            <Text style={styles.addressLine}>{customer.address.street}</Text>
            <Text style={styles.addressLine}>
              {customer.address.city}, {customer.address.state} {customer.address.zipCode}
            </Text>
            <Text style={styles.addressLine}>{customer.address.country}</Text>
          </View>
        ))}

        {/* Notes */}
        {customer.notes && renderSection('Notes', (
          <View style={styles.notesContainer}>
            <Text style={styles.notesText}>{customer.notes}</Text>
          </View>
        ))}

        {/* Recent Orders */}
        {renderSection('Recent Orders', (
          <>
            <FlatList
              data={customer.orders.slice(0, 5)}
              renderItem={renderOrderItem}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
            />
            {customer.orders.length > 5 && (
              <TouchableOpacity style={styles.viewAllOrdersButton}>
                <Text style={styles.viewAllOrdersText}>View All Orders</Text>
                <Ionicons name="chevron-forward" size={16} color="#007AFF" />
              </TouchableOpacity>
            )}
          </>
        ))}

        {/* Actions */}
        <View style={styles.actionsSection}>
          <TouchableOpacity style={styles.actionButton}>
            <Ionicons name="mail" size={20} color="#007AFF" />
            <Text style={styles.actionButtonText}>Send Email</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionButton}>
            <Ionicons name="call" size={20} color="#34C759" />
            <Text style={styles.actionButtonText}>Call Customer</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionButton}>
            <Ionicons name="create" size={20} color="#FF9500" />
            <Text style={styles.actionButtonText}>Edit Details</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666666',
  },
  errorText: {
    fontSize: 18,
    color: '#000000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
  },
  backButton: {
    padding: 8,
  },
  backText: {
    fontSize: 16,
    color: '#000000',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '400',
    color: '#000000',
    flex: 1,
    textAlign: 'center',
  },
  moreButton: {
    padding: 8,
  },
  moreText: {
    fontSize: 16,
    color: '#000000',
  },
  content: {
    flex: 1,
  },
  profileSection: {
    backgroundColor: '#fff',
    marginTop: 0,
    marginHorizontal: 0,
    padding: 20,
    shadowOpacity: 0,
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
  },
  profileInfo: {
    gap: 8,
  },
  customerName: {
    fontSize: 24,
    fontWeight: '600',
    color: '#000000',
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '400',
    color: '#666666',
  },
  statusText: {
    fontSize: 12,
    color: '#666666',
    fontWeight: '400',
  },
  statsContainer: {
    flexDirection: 'row',
    marginTop: 0,
    marginHorizontal: 0,
    gap: 0,
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 16,
    alignItems: 'center',
    shadowOpacity: 0,
    borderRightWidth: 0.5,
    borderRightColor: '#000000',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '600',
    color: '#000000',
  },
  statLabel: {
    fontSize: 12,
    color: '#666666',
    marginTop: 4,
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#fff',
    marginTop: 0,
    marginHorizontal: 0,
    padding: 20,
    shadowOpacity: 0,
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 16,
  },
  contactRow: {
    marginBottom: 12,
  },
  contactText: {
    fontSize: 16,
    color: '#000000',
  },
  addressContainer: {
    gap: 4,
  },
  addressLine: {
    fontSize: 16,
    color: '#000000',
    lineHeight: 24,
  },
  notesContainer: {
    backgroundColor: '#f5f5f5',
    padding: 12,
  },
  notesText: {
    fontSize: 14,
    color: '#666666',
    lineHeight: 20,
  },
  orderItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#f5f5f5',
  },
  orderInfo: {
    flex: 1,
  },
  orderNumber: {
    fontSize: 16,
    fontWeight: '400',
    color: '#000000',
    marginBottom: 4,
  },
  orderDate: {
    fontSize: 14,
    color: '#666666',
  },
  orderRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  orderTotal: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
  orderStatusText: {
    fontSize: 10,
    fontWeight: '400',
    color: '#666666',
  },
  viewAllOrdersButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    marginTop: 8,
  },
  viewAllOrdersText: {
    fontSize: 14,
    color: '#000000',
    fontWeight: '400',
  },
  actionsSection: {
    flexDirection: 'row',
    marginTop: 0,
    marginHorizontal: 0,
    gap: 0,
  },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    paddingVertical: 16,
    shadowOpacity: 0,
    borderRightWidth: 0.5,
    borderRightColor: '#000000',
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '400',
    color: '#000000',
  },
  bottomSpacer: {
    height: 20,
  },
});