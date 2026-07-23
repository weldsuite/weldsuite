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
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
  totalAmount: number;
  items: InvoiceItem[];
  billingAddress?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  issueDate: string;
  dueDate: string;
  createdAt: string;
  updatedAt: string;
}

const INVOICE_STATUS_CONFIG = {
  draft: {
    label: 'Draft',
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    icon: 'document-text-outline' as const,
  },
  sent: {
    label: 'Sent',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
    icon: 'mail-outline' as const,
  },
  viewed: {
    label: 'Viewed',
    color: '#5B21B6',
    backgroundColor: '#EDE9FE',
    icon: 'eye-outline' as const,
  },
  paid: {
    label: 'Paid',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
    icon: 'checkmark-done-outline' as const,
  },
  overdue: {
    label: 'Overdue',
    color: '#7F1D1D',
    backgroundColor: '#FEE2E2',
    icon: 'alert-circle-outline' as const,
  },
  cancelled: {
    label: 'Cancelled',
    color: '#374151',
    backgroundColor: '#F3F4F6',
    icon: 'close-circle-outline' as const,
  },
  refunded: {
    label: 'Refunded',
    color: '#374151',
    backgroundColor: '#F3F4F6',
    icon: 'arrow-back-outline' as const,
  },
};

export default function InvoicesScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusUpdateModalVisible, setStatusUpdateModalVisible] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    loadInvoices();
  }, [selectedStatus]);

  const loadInvoices = async () => {
    try {
      setLoading(true);
      const response = await api.getInvoices({
        status: selectedStatus || undefined,
        search: searchQuery || undefined,
      });

      if (response.success && response.data) {
        setInvoices(response.data.items);
        setTotal(response.data.meta.total);
      }
    } catch (error) {
      console.error('Error loading invoices:', error);
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleSearch = () => {
    loadInvoices();
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadInvoices();
  };

  const handleInvoicePress = (invoice: Invoice) => {
    router.push(`/invoice/${invoice.id}` as any);
  };

  const handleUpdateInvoiceStatus = (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    setStatusUpdateModalVisible(true);
  };

  const updateInvoiceStatus = (newStatus: Invoice['status']) => {
    if (!selectedInvoice) return;

    setInvoices(invoices.map(invoice =>
      invoice.id === selectedInvoice.id
        ? { ...invoice, status: newStatus, updatedAt: new Date().toISOString() }
        : invoice
    ));

    setStatusUpdateModalVisible(false);
    setSelectedInvoice(null);
    toast.success(`Invoice ${selectedInvoice.invoiceNumber} status updated to ${newStatus}`);
  };

  const handleCancelInvoice = (invoice: Invoice) => {
    updateInvoiceStatus('cancelled');
    toast.success(`Invoice ${invoice.invoiceNumber} has been cancelled`);
  };

  const handleRefundInvoice = (invoice: Invoice) => {
    updateInvoiceStatus('refunded');
    toast.success(`Invoice ${invoice.invoiceNumber} has been refunded`);
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

  const getItemCount = (invoice: Invoice) => {
    if (!invoice.items || invoice.items.length === 0) return 0;
    return invoice.items.reduce((sum, item) => sum + item.quantity, 0);
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Invoices' },
      { key: 'draft', label: 'Draft' },
      { key: 'sent', label: 'Sent' },
      { key: 'viewed', label: 'Viewed' },
      { key: 'paid', label: 'Paid' },
      { key: 'overdue', label: 'Overdue' },
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
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderInvoice = ({ item }: { item: Invoice }) => {
    const itemCount = getItemCount(item);
    const statusConfig = INVOICE_STATUS_CONFIG[item.status];

    return (
      <TouchableOpacity
        style={[styles.invoiceItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleInvoicePress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.invoiceContent}>
          <View style={styles.invoiceLeft}>
            <Text style={[styles.invoiceNumber, { color: colors.text }]}>#{item.invoiceNumber}</Text>
            <Text style={[styles.clientName, { color: colors.muted }]}>{item.clientName}</Text>
            <Text style={[styles.invoiceDate, { color: colors.muted }]}>
              {formatDate(item.createdAt)} · {itemCount} items
            </Text>
          </View>
          <View style={styles.invoiceRight}>
            <Text style={[styles.invoiceTotal, { color: colors.text }]}>${item.totalAmount.toFixed(2)}</Text>
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
      <Text style={[styles.emptyText, { color: colors.muted }]}>No invoices found</Text>
    </View>
  );

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading invoices...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Invoices ({total})</Text>
        <TouchableOpacity
          style={[styles.addButton, { borderColor: colors.buttonBorder }]}
          onPress={() => router.push('/invoice/new' as any)}
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
            placeholder="Search invoices, clients..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={invoices}
        renderItem={renderInvoice}
        keyExtractor={(item) => item.id}
        contentContainerStyle={invoices.length === 0 ? styles.emptyListContainer : styles.listContainer}
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
            {selectedInvoice && (
              <Text style={[styles.modalSubtitle, { color: colors.muted }]}>Invoice {selectedInvoice.invoiceNumber}</Text>
            )}

            {Object.entries(INVOICE_STATUS_CONFIG).map(([status, config]) => (
              <TouchableOpacity
                key={status}
                style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                onPress={() => updateInvoiceStatus(status as Invoice['status'])}
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
  emptyListContainer: {
    flex: 1,
  },
  invoiceItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  invoiceContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  invoiceLeft: {
    flex: 1,
    gap: 2,
  },
  invoiceRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  invoiceNumber: {
    fontSize: 15,
    fontWeight: '600',
  },
  clientName: {
    fontSize: 14,
    fontWeight: '400',
  },
  invoiceDate: {
    fontSize: 12,
  },
  invoiceTotal: {
    fontSize: 16,
    fontWeight: '600',
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