import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { router } from 'expo-router';
import {
  ChevronLeft,
  Plus,
  ChevronRight,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  Building2,
  Calendar,
} from 'lucide-react-native';
import api from '@/services/api';
import type { Bill } from '@/services/api';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
];

export default function BillsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState('all');

  useEffect(() => {
    loadBills();
  }, [selectedFilter]);

  const loadBills = async () => {
    setLoading(true);
    try {
      const params = selectedFilter !== 'all' ? { status: selectedFilter } : undefined;
      const response = await api.getBills(params);
      if (response.success && response.data) {
        setBills(response.data);
      } else {
        // Mock data for demo
        setBills([
          {
            id: '1',
            billNumber: 'BILL-2024-001',
            supplierId: 'sup-1',
            supplierName: 'Office Supplies Co.',
            issueDate: '2024-10-15',
            dueDate: '2024-11-15',
            status: 'pending',
            subtotal: 1250.00,
            taxAmount: 262.50,
            total: 1512.50,
            currency: 'EUR',
            createdAt: '2024-10-15',
            updatedAt: '2024-10-15',
          },
          {
            id: '2',
            billNumber: 'BILL-2024-002',
            supplierId: 'sup-2',
            supplierName: 'Tech Services Inc.',
            issueDate: '2024-10-10',
            dueDate: '2024-10-25',
            status: 'overdue',
            subtotal: 3500.00,
            taxAmount: 735.00,
            total: 4235.00,
            currency: 'EUR',
            createdAt: '2024-10-10',
            updatedAt: '2024-10-10',
          },
          {
            id: '3',
            billNumber: 'BILL-2024-003',
            supplierId: 'sup-3',
            supplierName: 'Cloud Hosting Ltd.',
            issueDate: '2024-10-01',
            dueDate: '2024-10-31',
            status: 'paid',
            subtotal: 890.00,
            taxAmount: 186.90,
            total: 1076.90,
            currency: 'EUR',
            paidAt: '2024-10-28',
            createdAt: '2024-10-01',
            updatedAt: '2024-10-28',
          },
          {
            id: '4',
            billNumber: 'BILL-2024-004',
            supplierId: 'sup-4',
            supplierName: 'Marketing Agency',
            issueDate: '2024-10-20',
            dueDate: '2024-11-20',
            status: 'approved',
            subtotal: 2800.00,
            taxAmount: 588.00,
            total: 3388.00,
            currency: 'EUR',
            createdAt: '2024-10-20',
            updatedAt: '2024-10-22',
          },
        ]);
      }
    } catch (error) {
      console.error('Failed to load bills:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadBills();
    setRefreshing(false);
  };

  const getStatusInfo = (status: Bill['status']) => {
    switch (status) {
      case 'paid':
        return { color: '#10B981', label: 'Paid', icon: CheckCircle2 };
      case 'approved':
        return { color: '#3B82F6', label: 'Approved', icon: CheckCircle2 };
      case 'pending':
        return { color: '#F59E0B', label: 'Pending', icon: Clock };
      case 'overdue':
        return { color: '#EF4444', label: 'Overdue', icon: AlertCircle };
      case 'cancelled':
        return { color: '#6B7280', label: 'Cancelled', icon: AlertCircle };
      case 'draft':
      default:
        return { color: '#6B7280', label: 'Draft', icon: FileText };
    }
  };

  const formatCurrency = (amount: number, currency: string = 'EUR') => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency,
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const isOverdue = (dueDate: string, status: string) => {
    if (status === 'paid' || status === 'cancelled') return false;
    return new Date(dueDate) < new Date();
  };

  // Calculate totals
  const totalPending = bills
    .filter(b => ['pending', 'approved'].includes(b.status))
    .reduce((sum, b) => sum + b.total, 0);
  const overdueCount = bills.filter(b => b.status === 'overdue').length;

  const filteredBills = selectedFilter === 'all'
    ? bills
    : bills.filter(b => b.status === selectedFilter);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Bills</Text>
        </View>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: '#8B5CF6' }]}
          onPress={() => router.push('/accounting/bills/new' as any)}
        >
          <Plus size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5CF6" />
        }
      >
        {/* Summary Cards */}
        <View style={styles.summaryRow}>
          <View style={[styles.summaryCard, { backgroundColor: '#F59E0B10', borderColor: '#F59E0B' }]}>
            <Text style={[styles.summaryLabel, { color: colors.muted }]}>Pending</Text>
            <Text style={[styles.summaryValue, { color: '#F59E0B' }]}>
              {formatCurrency(totalPending)}
            </Text>
          </View>
          <View style={[styles.summaryCard, { backgroundColor: '#EF444410', borderColor: '#EF4444' }]}>
            <Text style={[styles.summaryLabel, { color: colors.muted }]}>Overdue</Text>
            <Text style={[styles.summaryValue, { color: '#EF4444' }]}>
              {overdueCount} bills
            </Text>
          </View>
        </View>

        {/* Filter Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterContainer}
          contentContainerStyle={styles.filterContent}
        >
          {STATUS_FILTERS.map((filter) => (
            <TouchableOpacity
              key={filter.value}
              style={[
                styles.filterTab,
                selectedFilter === filter.value && styles.filterTabActive,
              ]}
              onPress={() => setSelectedFilter(filter.value)}
            >
              <Text
                style={[
                  styles.filterTabText,
                  { color: selectedFilter === filter.value ? '#FFFFFF' : colors.text },
                ]}
              >
                {filter.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Bills List */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#8B5CF6" />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading bills...</Text>
          </View>
        ) : filteredBills.length === 0 ? (
          <View style={styles.emptyState}>
            <FileText size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No Bills Found</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              {selectedFilter === 'all'
                ? 'Create your first bill to get started'
                : `No ${selectedFilter} bills`}
            </Text>
          </View>
        ) : (
          filteredBills.map((bill) => {
            const statusInfo = getStatusInfo(bill.status);
            const StatusIcon = statusInfo.icon;
            const overdue = isOverdue(bill.dueDate, bill.status);

            return (
              <TouchableOpacity
                key={bill.id}
                style={[styles.billCard, { backgroundColor: colors.background, borderColor: colors.border }]}
                onPress={() => router.push(`/accounting/bills/${bill.id}` as any)}
              >
                <View style={styles.billHeader}>
                  <View style={styles.supplierInfo}>
                    <View style={[styles.supplierIcon, { backgroundColor: '#8B5CF620' }]}>
                      <Building2 size={18} color="#8B5CF6" />
                    </View>
                    <View>
                      <Text style={[styles.supplierName, { color: colors.text }]}>
                        {bill.supplierName}
                      </Text>
                      <Text style={[styles.billNumber, { color: colors.muted }]}>
                        {bill.billNumber}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.billAmountContainer}>
                    <Text style={[styles.billAmount, { color: colors.text }]}>
                      {formatCurrency(bill.total, bill.currency)}
                    </Text>
                    <View style={[styles.statusBadge, { backgroundColor: statusInfo.color + '20' }]}>
                      <StatusIcon size={12} color={statusInfo.color} />
                      <Text style={[styles.statusText, { color: statusInfo.color }]}>
                        {statusInfo.label}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={styles.billFooter}>
                  <View style={styles.dateInfo}>
                    <Calendar size={14} color={overdue ? '#EF4444' : colors.muted} />
                    <Text style={[styles.dateText, { color: overdue ? '#EF4444' : colors.muted }]}>
                      Due: {formatDate(bill.dueDate)}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.muted} />
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  summaryCard: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  summaryLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '700',
  },
  filterContainer: {
    marginBottom: 16,
  },
  filterContent: {
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  filterTabActive: {
    backgroundColor: '#8B5CF6',
  },
  filterTabText: {
    fontSize: 13,
    fontWeight: '500',
  },
  loadingContainer: {
    alignItems: 'center',
    paddingTop: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  billCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  billHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  supplierInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  supplierIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  supplierName: {
    fontSize: 15,
    fontWeight: '600',
  },
  billNumber: {
    fontSize: 12,
    marginTop: 2,
  },
  billAmountContainer: {
    alignItems: 'flex-end',
  },
  billAmount: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  billFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  dateInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dateText: {
    fontSize: 12,
  },
});
