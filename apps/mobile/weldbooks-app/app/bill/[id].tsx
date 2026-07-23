import { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft,
  Calendar,
  FileText,
  CheckCircle,
  XCircle,
  CreditCard,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api, { API_URL } from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import type { Bill, BillItem } from '@/types/accounting';

function getStatusColor(status: Bill['status']): { bg: string; text: string } {
  switch (status) {
    case 'paid':
      return { bg: '#D1FAE5', text: '#065F46' };
    case 'pending':
      return { bg: '#FEF3C7', text: '#92400E' };
    case 'approved':
      return { bg: '#DBEAFE', text: '#1E40AF' };
    case 'overdue':
      return { bg: '#FEE2E2', text: '#991B1B' };
    case 'rejected':
      return { bg: '#F3F4F6', text: '#6B7280' };
    default:
      return { bg: '#F3F4F6', text: '#6B7280' };
  }
}

export default function BillDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [bill, setBill] = useState<Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      loadBill();
    }
  }, [id]);

  const loadBill = async () => {
    try {
      setLoading(true);
      const response = await api.getBill(id!);
      setBill(response.data);
    } catch {
      Alert.alert('Error', 'Failed to load bill details.');
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: 'paid' | 'approved' | 'rejected') => {
    if (!bill) return;

    const labels: Record<string, string> = {
      paid: 'Mark as Paid',
      approved: 'Approve',
      rejected: 'Reject',
    };

    Alert.alert(
      labels[action],
      `Are you sure you want to ${labels[action].toLowerCase()} this bill?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: action === 'rejected' ? 'destructive' : 'default',
          onPress: async () => {
            try {
              setActionLoading(action);
              await api.updateBill(bill.id, { status: action });
              setBill((prev) => (prev ? { ...prev, status: action } : prev));
            } catch {
              Alert.alert('Error', `Failed to ${labels[action].toLowerCase()} bill.`);
            } finally {
              setActionLoading(null);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#10B981" />
      </View>
    );
  }

  if (!bill) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.muted }}>Bill not found</Text>
      </View>
    );
  }

  const statusColor = getStatusColor(bill.status);
  const items: BillItem[] = bill.items || [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: colors.background },
        ]}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          Bill #{bill.billNumber || '---'}
        </Text>
        <View style={[styles.headerStatusBadge, { backgroundColor: statusColor.bg }]}>
          <Text style={[styles.headerStatusText, { color: statusColor.text }]}>
            {bill.status.charAt(0).toUpperCase() + bill.status.slice(1)}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Vendor Info */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>Vendor</Text>
          <Text style={[styles.vendorName, { color: colors.text }]}>
            {bill.contactName || 'Unknown Vendor'}
          </Text>
        </View>

        {/* Dates */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.dateRow}>
            <View style={styles.dateItem}>
              <View style={styles.dateLabelRow}>
                <Calendar size={14} color={colors.muted} />
                <Text style={[styles.dateLabel, { color: colors.muted }]}>Issue Date</Text>
              </View>
              <Text style={[styles.dateValue, { color: colors.text }]}>
                {new Date(bill.issueDate).toLocaleDateString()}
              </Text>
            </View>
            <View style={[styles.dateDivider, { backgroundColor: colors.divider }]} />
            <View style={styles.dateItem}>
              <View style={styles.dateLabelRow}>
                <Calendar size={14} color={colors.muted} />
                <Text style={[styles.dateLabel, { color: colors.muted }]}>Due Date</Text>
              </View>
              <Text style={[styles.dateValue, { color: colors.text }]}>
                {new Date(bill.dueDate).toLocaleDateString()}
              </Text>
            </View>
          </View>
        </View>

        {/* Line Items */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Line Items</Text>
          {items.length > 0 ? (
            <>
              {/* Table Header */}
              <View style={[styles.tableHeader, { borderBottomColor: colors.divider }]}>
                <Text style={[styles.tableHeaderText, styles.descColumn, { color: colors.muted }]}>
                  Description
                </Text>
                <Text style={[styles.tableHeaderText, styles.qtyColumn, { color: colors.muted }]}>
                  Qty
                </Text>
                <Text style={[styles.tableHeaderText, styles.priceColumn, { color: colors.muted }]}>
                  Price
                </Text>
                <Text style={[styles.tableHeaderText, styles.amountColumn, { color: colors.muted }]}>
                  Amount
                </Text>
              </View>
              {/* Table Rows */}
              {items.map((item, index) => (
                <View
                  key={item.id || index}
                  style={[
                    styles.tableRow,
                    index < items.length - 1 && { borderBottomColor: colors.divider, borderBottomWidth: StyleSheet.hairlineWidth },
                  ]}
                >
                  <Text
                    style={[styles.tableCell, styles.descColumn, { color: colors.text }]}
                    numberOfLines={2}
                  >
                    {item.description || '-'}
                  </Text>
                  <Text style={[styles.tableCell, styles.qtyColumn, { color: colors.text }]}>
                    {item.quantity}
                  </Text>
                  <Text style={[styles.tableCell, styles.priceColumn, { color: colors.text }]}>
                    {formatCurrency(item.unitPrice, bill.currency)}
                  </Text>
                  <Text
                    style={[styles.tableCell, styles.amountColumn, { color: colors.text, fontWeight: '600' }]}
                  >
                    {formatCurrency(item.amount, bill.currency)}
                  </Text>
                </View>
              ))}
            </>
          ) : (
            <Text style={[styles.noItems, { color: colors.muted }]}>No line items</Text>
          )}
        </View>

        {/* Totals */}
        <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: colors.muted }]}>Subtotal</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>
              {formatCurrency(bill.subtotal, bill.currency)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: colors.muted }]}>Tax</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>
              {formatCurrency(bill.taxTotal, bill.currency)}
            </Text>
          </View>
          <View style={[styles.totalDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabelBold, { color: colors.text }]}>Total</Text>
            <Text style={[styles.totalValueBold, { color: colors.text }]}>
              {formatCurrency(bill.total, bill.currency)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: '#10B981' }]}>Balance Due</Text>
            <Text style={[styles.totalValueBold, { color: '#10B981' }]}>
              {formatCurrency(bill.balanceDue, bill.currency)}
            </Text>
          </View>
        </View>

        {/* Document / Receipt */}
        {bill.documentId && (
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Attached Document</Text>
            <View style={styles.documentContainer}>
              <View style={styles.documentPlaceholder}>
                <FileText size={32} color={colors.muted} />
                <Text style={[styles.documentLabel, { color: colors.muted }]}>
                  Receipt / Document
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Notes */}
        {bill.notes && (
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Notes</Text>
            <Text style={[styles.notesText, { color: colors.text }]}>{bill.notes}</Text>
          </View>
        )}
      </ScrollView>

      {/* Action Buttons */}
      {bill.status !== 'paid' && bill.status !== 'rejected' && (
        <View
          style={[
            styles.actionsContainer,
            { paddingBottom: insets.bottom + 16, backgroundColor: colors.background, borderTopColor: colors.divider },
          ]}
        >
          {bill.status === 'pending' && (
            <TouchableOpacity
              style={[styles.actionButton, styles.approveButton]}
              activeOpacity={0.8}
              onPress={() => handleAction('approved')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'approved' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <CheckCircle size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>Approve</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.actionButton, styles.paidButton]}
            activeOpacity={0.8}
            onPress={() => handleAction('paid')}
            disabled={actionLoading !== null}
          >
            {actionLoading === 'paid' ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <CreditCard size={18} color="#fff" />
                <Text style={styles.actionButtonText}>Mark as Paid</Text>
              </>
            )}
          </TouchableOpacity>

          {bill.status === 'pending' && (
            <TouchableOpacity
              style={[styles.actionButton, styles.rejectButton]}
              activeOpacity={0.8}
              onPress={() => handleAction('rejected')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'rejected' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <XCircle size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>Reject</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backButton: {
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
  },
  headerStatusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 8,
  },
  headerStatusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  vendorName: {
    fontSize: 18,
    fontWeight: '600',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dateItem: {
    flex: 1,
  },
  dateLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  dateLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  dateValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  dateDivider: {
    width: 1,
    height: 32,
    marginHorizontal: 16,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  tableHeaderText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
  },
  tableCell: {
    fontSize: 14,
  },
  descColumn: {
    flex: 3,
    paddingRight: 8,
  },
  qtyColumn: {
    flex: 1,
    textAlign: 'center',
  },
  priceColumn: {
    flex: 2,
    textAlign: 'right',
    paddingRight: 8,
  },
  amountColumn: {
    flex: 2,
    textAlign: 'right',
  },
  noItems: {
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 16,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  totalLabelBold: {
    fontSize: 16,
    fontWeight: '700',
  },
  totalValueBold: {
    fontSize: 16,
    fontWeight: '700',
  },
  totalDivider: {
    height: 1,
    marginVertical: 8,
  },
  documentContainer: {
    alignItems: 'center',
  },
  documentPlaceholder: {
    width: '100%',
    height: 120,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  documentLabel: {
    fontSize: 13,
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
  },
  actionsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 6,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  approveButton: {
    backgroundColor: '#10B981',
  },
  paidButton: {
    backgroundColor: '#3B82F6',
  },
  rejectButton: {
    backgroundColor: '#EF4444',
  },
});
