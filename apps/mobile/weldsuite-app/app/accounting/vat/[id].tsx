import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ChevronLeft,
  Send,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  TrendingUp,
  TrendingDown,
  Building2,
  Receipt,
} from 'lucide-react-native';
import api from '@/services/api';
import type { VatReturnDetail } from '@/services/api';

export default function VatReturnDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [vatReturn, setVatReturn] = useState<VatReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadVatReturn();
  }, [id]);

  const loadVatReturn = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const response = await api.getVatReturnDetails(id);
      if (response.success && response.data) {
        setVatReturn(response.data);
      } else {
        // Mock data for demo
        setVatReturn({
          id,
          period: 'Q3',
          year: 2024,
          status: 'draft',
          dueDate: '2024-10-31',
          vatDue: 12500.00,
          vatReclaimable: 4200.00,
          netVat: 8300.00,
          totalSales: 62500.00,
          totalPurchases: 21000.00,
          createdAt: '2024-10-01',
          updatedAt: '2024-10-15',
          salesBreakdown: [
            { rate: 21, taxableAmount: 50000, vatAmount: 10500, description: 'Standard rate' },
            { rate: 9, taxableAmount: 10000, vatAmount: 900, description: 'Reduced rate' },
            { rate: 0, taxableAmount: 2500, vatAmount: 0, description: 'Zero rate / Exempt' },
          ],
          purchasesBreakdown: [
            { rate: 21, taxableAmount: 18000, vatAmount: 3780, description: 'Standard rate' },
            { rate: 9, taxableAmount: 3000, vatAmount: 270, description: 'Reduced rate' },
            { rate: 0, taxableAmount: 150, vatAmount: 0, description: 'Zero rate' },
          ],
          adjustments: [],
          notes: 'Q3 VAT return - all invoices and expenses have been verified.',
        });
      }
    } catch (error) {
      console.error('Failed to load VAT return:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = () => {
    Alert.alert(
      'Submit VAT Return',
      'Are you sure you want to submit this VAT return? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          style: 'default',
          onPress: async () => {
            setSubmitting(true);
            try {
              const response = await api.submitVatReturn(id!);
              if (response.success) {
                Alert.alert('Success', 'VAT return submitted successfully');
                loadVatReturn();
              } else {
                Alert.alert('Error', 'Failed to submit VAT return');
              }
            } catch (error) {
              Alert.alert('Error', 'An error occurred while submitting');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  const getStatusInfo = (status: string) => {
    switch (status) {
      case 'accepted':
        return { color: '#10B981', label: 'Accepted', icon: CheckCircle2 };
      case 'submitted':
        return { color: '#3B82F6', label: 'Submitted', icon: Clock };
      case 'pending':
        return { color: '#F59E0B', label: 'Pending', icon: Clock };
      case 'rejected':
        return { color: '#EF4444', label: 'Rejected', icon: AlertCircle };
      case 'draft':
      default:
        return { color: '#6B7280', label: 'Draft', icon: FileText };
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#10B981" />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading VAT return...</Text>
      </View>
    );
  }

  if (!vatReturn) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>VAT return not found</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => router.back()}>
          <Text style={styles.retryButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const statusInfo = getStatusInfo(vatReturn.status);
  const StatusIcon = statusInfo.icon;
  const canSubmit = vatReturn.status === 'draft';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <View>
            <Text style={[styles.headerTitle, { color: colors.text }]}>
              {vatReturn.period} {vatReturn.year}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: statusInfo.color + '20' }]}>
              <StatusIcon size={12} color={statusInfo.color} />
              <Text style={[styles.statusText, { color: statusInfo.color }]}>
                {statusInfo.label}
              </Text>
            </View>
          </View>
        </View>
        {canSubmit && (
          <TouchableOpacity
            style={[styles.submitButton, { backgroundColor: '#10B981' }]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Send size={16} color="#FFFFFF" />
                <Text style={styles.submitButtonText}>Submit</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
      >
        {/* Summary Card */}
        <View style={[styles.summaryCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.summaryHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>VAT Summary</Text>
            <Text style={[styles.dueDate, { color: colors.muted }]}>
              Due: {formatDate(vatReturn.dueDate)}
            </Text>
          </View>

          <View style={styles.summaryGrid}>
            <View style={[styles.summaryItem, { backgroundColor: '#EF444410' }]}>
              <View style={styles.summaryItemHeader}>
                <TrendingUp size={18} color="#EF4444" />
                <Text style={[styles.summaryItemLabel, { color: colors.muted }]}>Output VAT</Text>
              </View>
              <Text style={[styles.summaryItemValue, { color: '#EF4444' }]}>
                {formatCurrency(vatReturn.vatDue)}
              </Text>
              <Text style={[styles.summaryItemSub, { color: colors.muted }]}>
                Sales: {formatCurrency(vatReturn.totalSales)}
              </Text>
            </View>

            <View style={[styles.summaryItem, { backgroundColor: '#10B98110' }]}>
              <View style={styles.summaryItemHeader}>
                <TrendingDown size={18} color="#10B981" />
                <Text style={[styles.summaryItemLabel, { color: colors.muted }]}>Input VAT</Text>
              </View>
              <Text style={[styles.summaryItemValue, { color: '#10B981' }]}>
                {formatCurrency(vatReturn.vatReclaimable)}
              </Text>
              <Text style={[styles.summaryItemSub, { color: colors.muted }]}>
                Purchases: {formatCurrency(vatReturn.totalPurchases)}
              </Text>
            </View>
          </View>

          <View style={[styles.netVatRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.netVatLabel, { color: colors.text }]}>Net VAT Payable</Text>
            <Text style={[styles.netVatValue, { color: vatReturn.netVat >= 0 ? '#EF4444' : '#10B981' }]}>
              {formatCurrency(vatReturn.netVat)}
            </Text>
          </View>
        </View>

        {/* Sales Breakdown */}
        <View style={[styles.breakdownCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.breakdownHeader}>
            <Receipt size={18} color="#3B82F6" />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Sales (Output VAT)</Text>
          </View>

          {vatReturn.salesBreakdown.map((item, index) => (
            <View
              key={index}
              style={[styles.breakdownRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}
            >
              <View style={styles.breakdownInfo}>
                <Text style={[styles.breakdownRate, { color: colors.text }]}>{item.rate}% VAT</Text>
                <Text style={[styles.breakdownDesc, { color: colors.muted }]}>{item.description}</Text>
              </View>
              <View style={styles.breakdownAmounts}>
                <Text style={[styles.breakdownTaxable, { color: colors.muted }]}>
                  {formatCurrency(item.taxableAmount)}
                </Text>
                <Text style={[styles.breakdownVat, { color: colors.text }]}>
                  {formatCurrency(item.vatAmount)}
                </Text>
              </View>
            </View>
          ))}

          <View style={[styles.breakdownTotal, { borderTopColor: colors.border }]}>
            <Text style={[styles.breakdownTotalLabel, { color: colors.text }]}>Total Output VAT</Text>
            <Text style={[styles.breakdownTotalValue, { color: '#EF4444' }]}>
              {formatCurrency(vatReturn.vatDue)}
            </Text>
          </View>
        </View>

        {/* Purchases Breakdown */}
        <View style={[styles.breakdownCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.breakdownHeader}>
            <Building2 size={18} color="#10B981" />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Purchases (Input VAT)</Text>
          </View>

          {vatReturn.purchasesBreakdown.map((item, index) => (
            <View
              key={index}
              style={[styles.breakdownRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}
            >
              <View style={styles.breakdownInfo}>
                <Text style={[styles.breakdownRate, { color: colors.text }]}>{item.rate}% VAT</Text>
                <Text style={[styles.breakdownDesc, { color: colors.muted }]}>{item.description}</Text>
              </View>
              <View style={styles.breakdownAmounts}>
                <Text style={[styles.breakdownTaxable, { color: colors.muted }]}>
                  {formatCurrency(item.taxableAmount)}
                </Text>
                <Text style={[styles.breakdownVat, { color: colors.text }]}>
                  {formatCurrency(item.vatAmount)}
                </Text>
              </View>
            </View>
          ))}

          <View style={[styles.breakdownTotal, { borderTopColor: colors.border }]}>
            <Text style={[styles.breakdownTotalLabel, { color: colors.text }]}>Total Input VAT</Text>
            <Text style={[styles.breakdownTotalValue, { color: '#10B981' }]}>
              {formatCurrency(vatReturn.vatReclaimable)}
            </Text>
          </View>
        </View>

        {/* Notes */}
        {vatReturn.notes && (
          <View style={[styles.notesCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Notes</Text>
            <Text style={[styles.notesText, { color: colors.muted }]}>{vatReturn.notes}</Text>
          </View>
        )}

        {/* Metadata */}
        <View style={styles.metadata}>
          <Text style={[styles.metadataText, { color: colors.muted }]}>
            Created: {formatDate(vatReturn.createdAt)}
          </Text>
          <Text style={[styles.metadataText, { color: colors.muted }]}>
            Last updated: {formatDate(vatReturn.updatedAt)}
          </Text>
        </View>
      </ScrollView>
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
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  errorText: {
    fontSize: 16,
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#10B981',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
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
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginTop: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  summaryCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  dueDate: {
    fontSize: 12,
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  summaryItem: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
  },
  summaryItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  summaryItemLabel: {
    fontSize: 12,
  },
  summaryItemValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  summaryItemSub: {
    fontSize: 11,
    marginTop: 4,
  },
  netVatRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  netVatLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  netVatValue: {
    fontSize: 22,
    fontWeight: '700',
  },
  breakdownCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  breakdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  breakdownInfo: {
    flex: 1,
  },
  breakdownRate: {
    fontSize: 14,
    fontWeight: '500',
  },
  breakdownDesc: {
    fontSize: 12,
    marginTop: 2,
  },
  breakdownAmounts: {
    alignItems: 'flex-end',
  },
  breakdownTaxable: {
    fontSize: 12,
  },
  breakdownVat: {
    fontSize: 14,
    fontWeight: '600',
  },
  breakdownTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: 2,
  },
  breakdownTotalLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  breakdownTotalValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  notesCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  metadata: {
    gap: 4,
  },
  metadataText: {
    fontSize: 12,
    textAlign: 'center',
  },
});
