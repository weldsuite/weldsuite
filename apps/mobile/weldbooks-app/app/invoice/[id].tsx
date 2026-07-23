import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  ArrowLeft,
  Send,
  CheckCircle2,
  MoreHorizontal,
  User,
  Mail,
  Calendar,
  AlertCircle,
} from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import type { Invoice, InvoiceItem, Payment } from '@/types/accounting';

const STATUS_COLORS: Record<string, string> = {
  draft: '#F59E0B',
  sent: '#3B82F6',
  paid: '#10B981',
  overdue: '#EF4444',
  cancelled: '#6B7280',
  viewed: '#8B5CF6',
  refunded: '#6B7280',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
  viewed: 'Viewed',
  refunded: 'Refunded',
};

export default function InvoiceDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchInvoice = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const response = await api.getInvoice(id);
      if (response.data) {
        setInvoice(response.data);
      }
    } catch (err) {
      setError('Failed to load invoice');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      if (!id || actionLoading) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      setActionLoading(true);
      try {
        await api.updateInvoiceStatus(id, newStatus);
        await fetchInvoice();
      } catch (err) {
        Alert.alert('Error', 'Failed to update invoice status');
      } finally {
        setActionLoading(false);
      }
    },
    [id, actionLoading, fetchInvoice],
  );

  const handleSendInvoice = useCallback(() => {
    Alert.alert('Send Invoice', 'Are you sure you want to send this invoice?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: () => handleStatusChange('sent') },
    ]);
  }, [handleStatusChange]);

  const handleMarkAsPaid = useCallback(() => {
    Alert.alert('Mark as Paid', 'Mark this invoice as paid?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => handleStatusChange('paid') },
    ]);
  }, [handleStatusChange]);

  const handleMoreOptions = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('More Actions', undefined, [
      {
        text: 'Mark as Overdue',
        onPress: () => handleStatusChange('overdue'),
      },
      {
        text: 'Cancel Invoice',
        style: 'destructive',
        onPress: () => {
          Alert.alert('Cancel Invoice', 'This action cannot be undone.', [
            { text: 'Keep', style: 'cancel' },
            { text: 'Cancel Invoice', style: 'destructive', onPress: () => handleStatusChange('cancelled') },
          ]);
        },
      },
      { text: 'Dismiss', style: 'cancel' },
    ]);
  }, [handleStatusChange]);

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !invoice) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ArrowLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerBarTitle, { color: colors.text }]}>Invoice</Text>
          <View style={styles.headerBarRight} />
        </View>
        <View style={styles.centered}>
          <AlertCircle size={48} color={colors.muted} />
          <Text style={[styles.errorText, { color: colors.text }]}>
            {error ?? 'Invoice not found'}
          </Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              setLoading(true);
              fetchInvoice();
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const statusColor = STATUS_COLORS[invoice.status] ?? colors.muted;
  const items: InvoiceItem[] = invoice.items ?? [];
  const payments: Payment[] = invoice.payments ?? [];
  const canSend = invoice.status === 'draft';
  const canMarkPaid = invoice.status === 'sent' || invoice.status === 'overdue' || invoice.status === 'viewed';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerBarTitle, { color: colors.text }]} numberOfLines={1}>
          Invoice {invoice.invoiceNumber}
        </Text>
        <View style={styles.headerBarRight} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Status Badge */}
        <View style={styles.statusSection}>
          <View style={[styles.statusBadgeLarge, { backgroundColor: statusColor + '18' }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusBadgeLargeText, { color: statusColor }]}>
              {STATUS_LABELS[invoice.status] ?? invoice.status}
            </Text>
          </View>
          <Text style={[styles.totalAmount, { color: colors.text }]}>
            {formatCurrency(invoice.total, invoice.currency)}
          </Text>
        </View>

        {/* Contact Info */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Contact</Text>
          <View style={styles.infoRow}>
            <User size={16} color={colors.muted} />
            <Text style={[styles.infoText, { color: colors.text }]}>{invoice.contactName}</Text>
          </View>
          {invoice.contactEmail ? (
            <View style={styles.infoRow}>
              <Mail size={16} color={colors.muted} />
              <Text style={[styles.infoText, { color: colors.muted }]}>
                {invoice.contactEmail}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Dates */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Dates</Text>
          <View style={styles.dateRow}>
            <View style={styles.dateItem}>
              <Calendar size={14} color={colors.muted} />
              <Text style={[styles.dateLabel, { color: colors.muted }]}>Issue Date</Text>
            </View>
            <Text style={[styles.dateValue, { color: colors.text }]}>
              {formatDate(invoice.issueDate)}
            </Text>
          </View>
          <View style={[styles.dateDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.dateRow}>
            <View style={styles.dateItem}>
              <Calendar size={14} color={colors.muted} />
              <Text style={[styles.dateLabel, { color: colors.muted }]}>Due Date</Text>
            </View>
            <Text style={[styles.dateValue, { color: colors.text }]}>
              {formatDate(invoice.dueDate)}
            </Text>
          </View>
        </View>

        {/* Line Items */}
        {items.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Line Items</Text>
            {/* Table Header */}
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderCell, styles.descriptionCol, { color: colors.muted }]}>
                Description
              </Text>
              <Text style={[styles.tableHeaderCell, styles.qtyCol, { color: colors.muted }]}>
                Qty
              </Text>
              <Text style={[styles.tableHeaderCell, styles.priceCol, { color: colors.muted }]}>
                Price
              </Text>
              <Text style={[styles.tableHeaderCell, styles.amountCol, { color: colors.muted }]}>
                Amount
              </Text>
            </View>
            {items.map((item, index) => (
              <View key={item.id || index}>
                {index > 0 && (
                  <View style={[styles.tableDivider, { backgroundColor: colors.divider }]} />
                )}
                <View style={styles.tableRow}>
                  <Text
                    style={[styles.tableCell, styles.descriptionCol, { color: colors.text }]}
                    numberOfLines={2}
                  >
                    {item.description}
                  </Text>
                  <Text style={[styles.tableCell, styles.qtyCol, { color: colors.text }]}>
                    {item.quantity}
                  </Text>
                  <Text style={[styles.tableCell, styles.priceCol, { color: colors.text }]}>
                    {formatCurrency(item.unitPrice, invoice.currency)}
                  </Text>
                  <Text style={[styles.tableCell, styles.amountCol, { color: colors.text }]}>
                    {formatCurrency(item.amount, invoice.currency)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Totals */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: colors.muted }]}>Subtotal</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>
              {formatCurrency(invoice.subtotal, invoice.currency)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: colors.muted }]}>Tax</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>
              {formatCurrency(invoice.taxTotal, invoice.currency)}
            </Text>
          </View>
          <View style={[styles.totalDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabelBold, { color: colors.text }]}>Total</Text>
            <Text style={[styles.totalValueBold, { color: colors.text }]}>
              {formatCurrency(invoice.total, invoice.currency)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabelBold, { color: '#10B981' }]}>Balance Due</Text>
            <Text style={[styles.totalValueBold, { color: '#10B981' }]}>
              {formatCurrency(invoice.balanceDue, invoice.currency)}
            </Text>
          </View>
        </View>

        {/* Payments */}
        {payments.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Payments</Text>
            {payments.map((payment, index) => (
              <View key={payment.id || index}>
                {index > 0 && (
                  <View style={[styles.tableDivider, { backgroundColor: colors.divider }]} />
                )}
                <View style={styles.paymentRow}>
                  <View>
                    <Text style={[styles.paymentDate, { color: colors.text }]}>
                      {formatDate(payment.date)}
                    </Text>
                    {payment.method && (
                      <Text style={[styles.paymentMethod, { color: colors.muted }]}>
                        {payment.method}
                      </Text>
                    )}
                  </View>
                  <Text style={[styles.paymentAmount, { color: '#10B981' }]}>
                    {formatCurrency(payment.amount, invoice.currency)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Notes */}
        {invoice.notes ? (
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Notes</Text>
            <Text style={[styles.notesText, { color: colors.muted }]}>{invoice.notes}</Text>
          </View>
        ) : null}

        {/* Reference */}
        {invoice.reference ? (
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Reference</Text>
            <Text style={[styles.notesText, { color: colors.muted }]}>{invoice.reference}</Text>
          </View>
        ) : null}

        {/* Spacer for bottom actions */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Bottom Action Buttons */}
      {(canSend || canMarkPaid) && (
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.divider }]}>
          {canSend && (
            <TouchableOpacity
              style={[styles.actionButton, styles.sendButton]}
              onPress={handleSendInvoice}
              disabled={actionLoading}
              activeOpacity={0.8}
            >
              {actionLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Send size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>Send Invoice</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {canMarkPaid && (
            <TouchableOpacity
              style={[styles.actionButton, styles.paidButton]}
              onPress={handleMarkAsPaid}
              disabled={actionLoading}
              activeOpacity={0.8}
            >
              {actionLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <CheckCircle2 size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>Mark as Paid</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.moreButton, { backgroundColor: colors.cardBackground }]}
            onPress={handleMoreOptions}
            activeOpacity={0.7}
          >
            <MoreHorizontal size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  headerBarTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
  },
  headerBarRight: {
    width: 44,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  statusSection: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 12,
  },
  statusBadgeLarge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusBadgeLargeText: {
    fontSize: 15,
    fontWeight: '600',
  },
  totalAmount: {
    fontSize: 32,
    fontWeight: '700',
  },
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    flex: 1,
  },
  dateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  dateItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateLabel: {
    fontSize: 14,
  },
  dateValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  dateDivider: {
    height: 1,
    marginVertical: 4,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'transparent',
  },
  tableHeaderCell: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    alignItems: 'flex-start',
  },
  tableCell: {
    fontSize: 13,
  },
  descriptionCol: {
    flex: 3,
    paddingRight: 8,
  },
  qtyCol: {
    flex: 1,
    textAlign: 'center',
  },
  priceCol: {
    flex: 2,
    textAlign: 'right',
    paddingRight: 8,
  },
  amountCol: {
    flex: 2,
    textAlign: 'right',
  },
  tableDivider: {
    height: 1,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 14,
  },
  totalLabelBold: {
    fontSize: 15,
    fontWeight: '600',
  },
  totalValueBold: {
    fontSize: 15,
    fontWeight: '700',
  },
  totalDivider: {
    height: 1,
    marginVertical: 6,
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  paymentDate: {
    fontSize: 14,
    fontWeight: '500',
  },
  paymentMethod: {
    fontSize: 12,
    marginTop: 2,
  },
  paymentAmount: {
    fontSize: 14,
    fontWeight: '600',
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderTopWidth: 1,
    gap: 10,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
  },
  sendButton: {
    backgroundColor: '#3B82F6',
  },
  paidButton: {
    backgroundColor: '#10B981',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  moreButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#10B981',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
