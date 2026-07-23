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
  Calendar,
} from 'lucide-react-native';
import api from '@/services/api';
import type { VatReturn } from '@/services/api';

export default function VatReturnsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [vatReturns, setVatReturns] = useState<VatReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => {
    loadVatReturns();
  }, [selectedYear]);

  const loadVatReturns = async () => {
    setLoading(true);
    try {
      const response = await api.getVatReturns({ year: selectedYear });
      if (response.success && response.data) {
        setVatReturns(response.data);
      } else {
        // Mock data for demo
        setVatReturns([
          {
            id: '1',
            period: 'Q3',
            year: 2024,
            status: 'submitted',
            dueDate: '2024-10-31',
            submittedAt: '2024-10-28',
            vatDue: 12500.00,
            vatReclaimable: 4200.00,
            netVat: 8300.00,
            totalSales: 62500.00,
            totalPurchases: 21000.00,
            createdAt: '2024-10-01',
            updatedAt: '2024-10-28',
          },
          {
            id: '2',
            period: 'Q2',
            year: 2024,
            status: 'accepted',
            dueDate: '2024-07-31',
            submittedAt: '2024-07-25',
            vatDue: 15800.00,
            vatReclaimable: 5100.00,
            netVat: 10700.00,
            totalSales: 79000.00,
            totalPurchases: 25500.00,
            createdAt: '2024-07-01',
            updatedAt: '2024-07-25',
          },
          {
            id: '3',
            period: 'Q1',
            year: 2024,
            status: 'accepted',
            dueDate: '2024-04-30',
            submittedAt: '2024-04-20',
            vatDue: 11200.00,
            vatReclaimable: 3800.00,
            netVat: 7400.00,
            totalSales: 56000.00,
            totalPurchases: 19000.00,
            createdAt: '2024-04-01',
            updatedAt: '2024-04-20',
          },
          {
            id: '4',
            period: 'Q4',
            year: 2024,
            status: 'draft',
            dueDate: '2025-01-31',
            vatDue: 0,
            vatReclaimable: 0,
            netVat: 0,
            totalSales: 0,
            totalPurchases: 0,
            createdAt: '2024-10-01',
            updatedAt: '2024-10-01',
          },
        ]);
      }
    } catch (error) {
      console.error('Failed to load VAT returns:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadVatReturns();
    setRefreshing(false);
  };

  const getStatusInfo = (status: VatReturn['status']) => {
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

  // Calculate totals
  const totalNetVat = vatReturns.reduce((sum, vr) => sum + vr.netVat, 0);
  const submittedCount = vatReturns.filter(vr => ['submitted', 'accepted'].includes(vr.status)).length;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>VAT Returns</Text>
        </View>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: '#10B981' }]}
          onPress={() => router.push('/accounting/vat/create' as any)}
        >
          <Plus size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" />
        }
      >
        {/* Year Selector */}
        <View style={styles.yearSelector}>
          <TouchableOpacity
            style={[styles.yearButton, selectedYear === 2023 && styles.yearButtonActive]}
            onPress={() => setSelectedYear(2023)}
          >
            <Text style={[
              styles.yearButtonText,
              { color: selectedYear === 2023 ? '#FFFFFF' : colors.text }
            ]}>2023</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.yearButton, selectedYear === 2024 && styles.yearButtonActive]}
            onPress={() => setSelectedYear(2024)}
          >
            <Text style={[
              styles.yearButtonText,
              { color: selectedYear === 2024 ? '#FFFFFF' : colors.text }
            ]}>2024</Text>
          </TouchableOpacity>
        </View>

        {/* Summary Card */}
        <View style={[styles.summaryCard, { backgroundColor: '#10B98110', borderColor: '#10B981' }]}>
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Total Net VAT</Text>
              <Text style={[styles.summaryValue, { color: '#10B981' }]}>
                {formatCurrency(totalNetVat)}
              </Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Submitted</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {submittedCount} / {vatReturns.length}
              </Text>
            </View>
          </View>
        </View>

        {/* VAT Returns List */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#10B981" />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading VAT returns...</Text>
          </View>
        ) : vatReturns.length === 0 ? (
          <View style={styles.emptyState}>
            <FileText size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No VAT Returns</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              Create your first VAT return for {selectedYear}
            </Text>
          </View>
        ) : (
          vatReturns.map((vatReturn) => {
            const statusInfo = getStatusInfo(vatReturn.status);
            const StatusIcon = statusInfo.icon;

            return (
              <TouchableOpacity
                key={vatReturn.id}
                style={[styles.vatCard, { backgroundColor: colors.background, borderColor: colors.border }]}
                onPress={() => router.push(`/accounting/vat/${vatReturn.id}` as any)}
              >
                <View style={styles.vatHeader}>
                  <View style={styles.vatPeriod}>
                    <Text style={[styles.periodLabel, { color: colors.text }]}>
                      {vatReturn.period} {vatReturn.year}
                    </Text>
                    <View style={[styles.statusBadge, { backgroundColor: statusInfo.color + '20' }]}>
                      <StatusIcon size={12} color={statusInfo.color} />
                      <Text style={[styles.statusText, { color: statusInfo.color }]}>
                        {statusInfo.label}
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={colors.muted} />
                </View>

                <View style={styles.vatDetails}>
                  <View style={styles.vatRow}>
                    <Text style={[styles.vatLabel, { color: colors.muted }]}>VAT Due</Text>
                    <Text style={[styles.vatValue, { color: colors.text }]}>
                      {formatCurrency(vatReturn.vatDue)}
                    </Text>
                  </View>
                  <View style={styles.vatRow}>
                    <Text style={[styles.vatLabel, { color: colors.muted }]}>VAT Reclaimable</Text>
                    <Text style={[styles.vatValue, { color: '#10B981' }]}>
                      -{formatCurrency(vatReturn.vatReclaimable)}
                    </Text>
                  </View>
                  <View style={[styles.vatRow, styles.vatRowTotal]}>
                    <Text style={[styles.vatLabel, styles.vatLabelTotal, { color: colors.text }]}>Net VAT</Text>
                    <Text style={[styles.vatValue, styles.vatValueTotal, { color: vatReturn.netVat >= 0 ? '#EF4444' : '#10B981' }]}>
                      {formatCurrency(vatReturn.netVat)}
                    </Text>
                  </View>
                </View>

                <View style={styles.vatFooter}>
                  <View style={styles.dueDateContainer}>
                    <Calendar size={14} color={colors.muted} />
                    <Text style={[styles.dueDate, { color: colors.muted }]}>
                      Due: {formatDate(vatReturn.dueDate)}
                    </Text>
                  </View>
                  {vatReturn.submittedAt && (
                    <Text style={[styles.submittedDate, { color: colors.muted }]}>
                      Submitted: {formatDate(vatReturn.submittedAt)}
                    </Text>
                  )}
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
  yearSelector: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  yearButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  yearButtonActive: {
    backgroundColor: '#10B981',
  },
  yearButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  summaryCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 20,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  summaryItem: {
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
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
  vatCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  vatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  vatPeriod: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  periodLabel: {
    fontSize: 16,
    fontWeight: '600',
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
  vatDetails: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 12,
    marginBottom: 12,
  },
  vatRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  vatRowTotal: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 8,
    marginTop: 4,
  },
  vatLabel: {
    fontSize: 13,
  },
  vatLabelTotal: {
    fontWeight: '600',
  },
  vatValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  vatValueTotal: {
    fontWeight: '700',
    fontSize: 15,
  },
  vatFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dueDateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dueDate: {
    fontSize: 12,
  },
  submittedDate: {
    fontSize: 12,
  },
});
