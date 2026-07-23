import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';

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
  clientPhone?: string;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
  totalAmount: number;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
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
  paymentTerms?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

const INVOICE_STATUS_CONFIG = {
  draft: {
    label: 'Draft',
    color: '#71717A',
    icon: 'document-text-outline' as const,
  },
  sent: {
    label: 'Sent',
    color: '#3B82F6',
    icon: 'mail-outline' as const,
  },
  viewed: {
    label: 'Viewed',
    color: '#8B5CF6',
    icon: 'eye-outline' as const,
  },
  paid: {
    label: 'Paid',
    color: '#10B981',
    icon: 'checkmark-circle-outline' as const,
  },
  overdue: {
    label: 'Overdue',
    color: '#EF4444',
    icon: 'alert-circle-outline' as const,
  },
  cancelled: {
    label: 'Cancelled',
    color: '#6B7280',
    icon: 'close-circle-outline' as const,
  },
  refunded: {
    label: 'Refunded',
    color: '#6B7280',
    icon: 'arrow-back-outline' as const,
  },
};

export default function InvoiceDetailsScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams();
  const toast = useToast();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionsModalVisible, setActionsModalVisible] = useState(false);

  useEffect(() => {
    loadInvoice();
  }, [id]);

  const loadInvoice = async () => {
    try {
      setLoading(true);
      // Mock data - replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      
      setInvoice({
        id: id as string,
        invoiceNumber: 'INV-001',
        clientName: 'Tech Corp',
        clientEmail: 'billing@techcorp.com',
        clientPhone: '+1 (555) 123-4567',
        status: 'overdue',
        totalAmount: 4599.99,
        subtotal: 4000.00,
        taxRate: 15,
        taxAmount: 599.99,
        items: [
          { id: '1', description: 'Consulting Services - January 2024', quantity: 20, rate: 150.00, amount: 3000.00 },
          { id: '2', description: 'Development Work - Custom API Integration', quantity: 10, rate: 100.00, amount: 1000.00 },
        ],
        billingAddress: {
          street: '123 Tech Plaza',
          city: 'San Francisco',
          state: 'CA',
          zipCode: '94105',
          country: 'USA',
        },
        issueDate: '2024-01-10',
        dueDate: '2024-01-25',
        paymentTerms: 'Net 15',
        notes: 'Please include invoice number in payment reference.',
        createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });
    } catch (error) {
      console.error('Error loading invoice:', error);
      toast.error('Failed to load invoice details');
    } finally {
      setLoading(false);
    }
  };

  const handleSendInvoice = () => {
    setActionsModalVisible(false);
    toast.success('Invoice sent successfully');
    if (invoice) {
      setInvoice({ ...invoice, status: 'sent' });
    }
  };

  const handleMarkAsPaid = () => {
    if (invoice) {
      setInvoice({ ...invoice, status: 'paid' });
      toast.success('Invoice marked as paid');
    }
  };

  const handleDownloadPDF = () => {
    setActionsModalVisible(false);
    toast.success('PDF downloaded successfully');
  };

  const handleDuplicateInvoice = () => {
    setActionsModalVisible(false);
    router.push('/invoice/new' as any);
  };

  const handleDeleteInvoice = () => {
    setActionsModalVisible(false);
    toast.success('Invoice deleted');
    router.back();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!invoice) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>Invoice not found</Text>
      </View>
    );
  }

  const statusConfig = INVOICE_STATUS_CONFIG[invoice.status];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerActions}>
          <TouchableOpacity style={[styles.iconButton, { borderColor: colors.divider }]}>
            <Ionicons name="share-outline" size={18} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.iconButton, { borderColor: colors.divider }]}>
            <Ionicons name="download-outline" size={18} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.iconButton, { borderColor: colors.divider }]}
            onPress={() => setActionsModalVisible(true)}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={styles.content}>
        {/* Invoice Header Info */}
        <View style={styles.invoiceHeader}>
          <View>
            <Text style={[styles.invoiceNumber, { color: colors.text }]}>Invoice #{invoice.invoiceNumber}</Text>
            <View style={styles.statusBadge}>
              <View style={[styles.statusDot, { backgroundColor: statusConfig.color }]} />
              <Text style={[styles.statusText, { color: colors.muted }]}>{statusConfig.label}</Text>
            </View>
          </View>
          <Text style={[styles.totalAmount, { color: colors.text }]}>${invoice.totalAmount.toFixed(2)}</Text>
        </View>

        {/* Dates Section */}
        <View style={styles.section}>
          <View style={styles.infoRow}>
            <Text style={[styles.label, { color: colors.muted }]}>Issue Date</Text>
            <Text style={[styles.value, { color: colors.text }]}>{formatDate(invoice.issueDate)}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={[styles.label, { color: colors.muted }]}>Due Date</Text>
            <Text style={[styles.value, { color: colors.text }]}>{formatDate(invoice.dueDate)}</Text>
          </View>
          {invoice.paymentTerms && (
            <View style={styles.infoRow}>
              <Text style={[styles.label, { color: colors.muted }]}>Payment Terms</Text>
              <Text style={[styles.value, { color: colors.text }]}>{invoice.paymentTerms}</Text>
            </View>
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.divider }]} />

        {/* Client Info Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>BILL TO</Text>
          <Text style={[styles.clientName, { color: colors.text }]}>{invoice.clientName}</Text>
          <Text style={[styles.clientInfo, { color: colors.muted }]}>{invoice.clientEmail}</Text>
          {invoice.clientPhone && (
            <Text style={[styles.clientInfo, { color: colors.muted }]}>{invoice.clientPhone}</Text>
          )}
          {invoice.billingAddress && (
            <View style={styles.addressBlock}>
              <Text style={[styles.clientInfo, { color: colors.muted }]}>{invoice.billingAddress.street}</Text>
              <Text style={[styles.clientInfo, { color: colors.muted }]}>
                {invoice.billingAddress.city}, {invoice.billingAddress.state} {invoice.billingAddress.zipCode}
              </Text>
              <Text style={[styles.clientInfo, { color: colors.muted }]}>{invoice.billingAddress.country}</Text>
            </View>
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.divider }]} />

        {/* Line Items Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>LINE ITEMS</Text>
          
          {/* Table Header */}
          <View style={[styles.tableHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.tableHeaderText, styles.descriptionColumn, { color: colors.muted }]}>Description</Text>
            <Text style={[styles.tableHeaderText, styles.qtyColumn, { color: colors.muted }]}>Qty</Text>
            <Text style={[styles.tableHeaderText, styles.rateColumn, { color: colors.muted }]}>Rate</Text>
            <Text style={[styles.tableHeaderText, styles.amountColumn, { color: colors.muted }]}>Amount</Text>
          </View>

          {/* Table Rows */}
          {invoice.items.map((item, index) => (
            <View key={item.id} style={[
              styles.tableRow,
              index < invoice.items.length - 1 && { borderBottomColor: colors.divider, borderBottomWidth: 1 }
            ]}>
              <Text style={[styles.tableText, styles.descriptionColumn, { color: colors.text }]} numberOfLines={2}>
                {item.description}
              </Text>
              <Text style={[styles.tableText, styles.qtyColumn, { color: colors.text }]}>{item.quantity}</Text>
              <Text style={[styles.tableText, styles.rateColumn, { color: colors.text }]}>${item.rate.toFixed(2)}</Text>
              <Text style={[styles.tableText, styles.amountColumn, { color: colors.text }]}>${item.amount.toFixed(2)}</Text>
            </View>
          ))}

          {/* Totals */}
          <View style={[styles.totalsSection, { borderTopColor: colors.divider }]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>Subtotal</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>${invoice.subtotal.toFixed(2)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>Tax ({invoice.taxRate}%)</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>${invoice.taxAmount.toFixed(2)}</Text>
            </View>
            <View style={[styles.totalRow, styles.grandTotal, { borderTopColor: colors.divider }]}>
              <Text style={[styles.totalLabel, styles.grandTotalText, { color: colors.text }]}>Total</Text>
              <Text style={[styles.totalValue, styles.grandTotalText, { color: colors.text }]}>${invoice.totalAmount.toFixed(2)}</Text>
            </View>
          </View>
        </View>

        {/* Notes */}
        {invoice.notes && (
          <>
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.muted }]}>NOTES</Text>
              <Text style={[styles.notesText, { color: colors.text }]}>{invoice.notes}</Text>
            </View>
          </>
        )}

        {/* Action Buttons */}
        <View style={styles.actions}>
          {invoice.status === 'draft' && (
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.text }]}
              onPress={handleSendInvoice}
            >
              <Text style={[styles.primaryButtonText, { color: colors.background }]}>Send Invoice</Text>
            </TouchableOpacity>
          )}
          
          {invoice.status !== 'paid' && invoice.status !== 'cancelled' && invoice.status !== 'refunded' && (
            <TouchableOpacity
              style={[styles.secondaryButton, { borderColor: colors.divider }]}
              onPress={handleMarkAsPaid}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Mark as Paid</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* Actions Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={actionsModalVisible}
        onRequestClose={() => setActionsModalVisible(false)}
      >
        <TouchableOpacity 
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setActionsModalVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={() => {
                setActionsModalVisible(false);
                router.push(`/invoice/edit/${invoice.id}` as any);
              }}
            >
              <Ionicons name="create-outline" size={20} color={colors.text} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>Edit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={handleDuplicateInvoice}
            >
              <Ionicons name="copy-outline" size={20} color={colors.text} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>Duplicate</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={handleDownloadPDF}
            >
              <Ionicons name="document-outline" size={20} color={colors.text} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>Export PDF</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: 'transparent' }]}
              onPress={handleDeleteInvoice}
            >
              <Ionicons name="trash-outline" size={20} color="#EF4444" />
              <Text style={[styles.modalOptionText, { color: '#EF4444' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
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
  errorText: {
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  invoiceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  invoiceNumber: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 14,
  },
  totalAmount: {
    fontSize: 24,
    fontWeight: '600',
  },
  section: {
    paddingVertical: 24,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.5,
    marginBottom: 16,
  },
  divider: {
    height: 1,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  label: {
    fontSize: 14,
  },
  value: {
    fontSize: 14,
    fontWeight: '500',
  },
  clientName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  clientInfo: {
    fontSize: 14,
    lineHeight: 20,
  },
  addressBlock: {
    marginTop: 12,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  tableHeaderText: {
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 48,
    alignItems: 'center',
  },
  tableText: {
    fontSize: 14,
  },
  descriptionColumn: {
    flex: 3,
    paddingRight: 8,
  },
  qtyColumn: {
    flex: 0.8,
    textAlign: 'center',
  },
  rateColumn: {
    flex: 1.2,
    textAlign: 'right',
    paddingRight: 8,
  },
  amountColumn: {
    flex: 1.2,
    textAlign: 'right',
  },
  totalsSection: {
    paddingTop: 12,
    borderTopWidth: 1,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  grandTotal: {
    borderTopWidth: 1,
    marginTop: 8,
    paddingTop: 12,
  },
  grandTotalText: {
    fontSize: 16,
    fontWeight: '600',
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    gap: 12,
    marginTop: 8,
    marginBottom: 32,
  },
  primaryButton: {
    height: 44,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  secondaryButton: {
    height: 44,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    borderRadius: 8,
    width: '100%',
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 10,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  modalOptionText: {
    fontSize: 14,
  },
});