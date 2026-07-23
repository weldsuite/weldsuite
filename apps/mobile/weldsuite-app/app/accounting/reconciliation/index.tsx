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
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  ArrowRightLeft,
  Building2,
  TrendingUp,
  TrendingDown,
  Sparkles,
} from 'lucide-react-native';
import api from '@/services/api';
import type { ReconciliationStats, UnmatchedTransaction } from '@/services/api';

export default function ReconciliationScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [stats, setStats] = useState<ReconciliationStats | null>(null);
  const [unmatchedTransactions, setUnmatchedTransactions] = useState<UnmatchedTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsResponse, transactionsResponse] = await Promise.all([
        api.getReconciliationStats(),
        api.getUnmatchedTransactions({ limit: 10 }),
      ]);

      if (statsResponse.success && statsResponse.data) {
        setStats(statsResponse.data);
      } else {
        // Mock stats for demo
        setStats({
          totalUnmatched: 23,
          totalMatched: 156,
          matchedThisMonth: 42,
          pendingAmount: 15680.50,
          accounts: [
            { accountId: '1', accountName: 'Business Checking', bankName: 'ING', unmatchedCount: 15, lastReconciled: '2024-10-28' },
            { accountId: '2', accountName: 'Savings Account', bankName: 'Rabobank', unmatchedCount: 8, lastReconciled: '2024-10-25' },
          ],
        });
      }

      if (transactionsResponse.success && transactionsResponse.data) {
        setUnmatchedTransactions(transactionsResponse.data);
      } else {
        // Mock transactions for demo
        setUnmatchedTransactions([
          {
            id: '1',
            bankAccountId: '1',
            bankAccountName: 'Business Checking',
            date: '2024-10-30',
            description: 'PAYMENT FROM CUSTOMER XYZ',
            amount: 2450.00,
            type: 'credit',
            reference: 'INV-2024-089',
            counterpartyName: 'XYZ Corp',
            suggestedMatchCount: 2,
            confidence: 85,
          },
          {
            id: '2',
            bankAccountId: '1',
            bankAccountName: 'Business Checking',
            date: '2024-10-29',
            description: 'SEPA DIRECT DEBIT INSURANCE',
            amount: -580.00,
            type: 'debit',
            counterpartyName: 'Insurance Co',
            suggestedMatchCount: 1,
            confidence: 95,
          },
          {
            id: '3',
            bankAccountId: '1',
            bankAccountName: 'Business Checking',
            date: '2024-10-28',
            description: 'TRANSFER TO SUPPLIER',
            amount: -1250.00,
            type: 'debit',
            reference: 'BILL-2024-045',
            counterpartyName: 'Supplier ABC',
            suggestedMatchCount: 1,
            confidence: 90,
          },
          {
            id: '4',
            bankAccountId: '2',
            bankAccountName: 'Savings Account',
            date: '2024-10-27',
            description: 'INTEREST PAYMENT',
            amount: 45.80,
            type: 'credit',
            suggestedMatchCount: 0,
          },
        ]);
      }
    } catch (error) {
      console.error('Failed to load reconciliation data:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
    }).format(Math.abs(amount));
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const getConfidenceColor = (confidence?: number) => {
    if (!confidence) return '#6B7280';
    if (confidence >= 90) return '#10B981';
    if (confidence >= 70) return '#F59E0B';
    return '#EF4444';
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Bank Reconciliation</Text>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3B82F6" />
        }
      >
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#3B82F6" />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading...</Text>
          </View>
        ) : (
          <>
            {/* Stats Cards */}
            <View style={styles.statsGrid}>
              <View style={[styles.statCard, { backgroundColor: '#EF444410', borderColor: '#EF4444' }]}>
                <AlertCircle size={20} color="#EF4444" />
                <Text style={[styles.statValue, { color: '#EF4444' }]}>{stats?.totalUnmatched || 0}</Text>
                <Text style={[styles.statLabel, { color: colors.muted }]}>Unmatched</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: '#10B98110', borderColor: '#10B981' }]}>
                <CheckCircle2 size={20} color="#10B981" />
                <Text style={[styles.statValue, { color: '#10B981' }]}>{stats?.matchedThisMonth || 0}</Text>
                <Text style={[styles.statLabel, { color: colors.muted }]}>This Month</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: '#3B82F610', borderColor: '#3B82F6' }]}>
                <ArrowRightLeft size={20} color="#3B82F6" />
                <Text style={[styles.statValue, { color: '#3B82F6' }]}>{formatCurrency(stats?.pendingAmount || 0)}</Text>
                <Text style={[styles.statLabel, { color: colors.muted }]}>Pending</Text>
              </View>
            </View>

            {/* Bank Accounts */}
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Bank Accounts</Text>
              {stats?.accounts.map((account) => (
                <TouchableOpacity
                  key={account.accountId}
                  style={[styles.accountCard, { backgroundColor: colors.background, borderColor: colors.border }]}
                  onPress={() => router.push(`/accounting/reconciliation/account/${account.accountId}` as any)}
                >
                  <View style={[styles.accountIcon, { backgroundColor: '#3B82F620' }]}>
                    <Building2 size={20} color="#3B82F6" />
                  </View>
                  <View style={styles.accountInfo}>
                    <Text style={[styles.accountName, { color: colors.text }]}>{account.accountName}</Text>
                    <Text style={[styles.accountBank, { color: colors.muted }]}>{account.bankName}</Text>
                  </View>
                  <View style={styles.accountMeta}>
                    <View style={[styles.unmatchedBadge, { backgroundColor: account.unmatchedCount > 0 ? '#EF444420' : '#10B98120' }]}>
                      <Text style={[styles.unmatchedText, { color: account.unmatchedCount > 0 ? '#EF4444' : '#10B981' }]}>
                        {account.unmatchedCount} unmatched
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={colors.muted} />
                </TouchableOpacity>
              ))}
            </View>

            {/* Unmatched Transactions */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Needs Review</Text>
                <TouchableOpacity onPress={() => router.push('/accounting/reconciliation/unmatched' as any)}>
                  <Text style={[styles.seeAll, { color: '#3B82F6' }]}>See All</Text>
                </TouchableOpacity>
              </View>

              {unmatchedTransactions.map((transaction) => (
                <TouchableOpacity
                  key={transaction.id}
                  style={[styles.transactionCard, { backgroundColor: colors.background, borderColor: colors.border }]}
                  onPress={() => router.push(`/accounting/reconciliation/match/${transaction.id}` as any)}
                >
                  <View style={styles.transactionHeader}>
                    <View style={styles.transactionType}>
                      {transaction.type === 'credit' ? (
                        <TrendingUp size={16} color="#10B981" />
                      ) : (
                        <TrendingDown size={16} color="#EF4444" />
                      )}
                      <Text style={[styles.transactionDate, { color: colors.muted }]}>
                        {formatDate(transaction.date)}
                      </Text>
                    </View>
                    <Text style={[
                      styles.transactionAmount,
                      { color: transaction.type === 'credit' ? '#10B981' : '#EF4444' }
                    ]}>
                      {transaction.type === 'credit' ? '+' : '-'}{formatCurrency(transaction.amount)}
                    </Text>
                  </View>

                  <Text style={[styles.transactionDesc, { color: colors.text }]} numberOfLines={1}>
                    {transaction.description}
                  </Text>

                  {transaction.counterpartyName && (
                    <Text style={[styles.transactionCounterparty, { color: colors.muted }]}>
                      {transaction.counterpartyName}
                    </Text>
                  )}

                  <View style={styles.transactionFooter}>
                    {transaction.suggestedMatchCount > 0 ? (
                      <View style={styles.suggestedMatch}>
                        <Sparkles size={14} color={getConfidenceColor(transaction.confidence)} />
                        <Text style={[styles.suggestedText, { color: getConfidenceColor(transaction.confidence) }]}>
                          {transaction.suggestedMatchCount} suggested match{transaction.suggestedMatchCount > 1 ? 'es' : ''}
                        </Text>
                        {transaction.confidence && (
                          <Text style={[styles.confidenceText, { color: getConfidenceColor(transaction.confidence) }]}>
                            ({transaction.confidence}%)
                          </Text>
                        )}
                      </View>
                    ) : (
                      <Text style={[styles.noMatchText, { color: colors.muted }]}>No suggestions</Text>
                    )}
                    <ChevronRight size={16} color={colors.muted} />
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </>
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
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingTop: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 8,
  },
  statLabel: {
    fontSize: 11,
    marginTop: 4,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
  },
  seeAll: {
    fontSize: 13,
    fontWeight: '500',
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    gap: 12,
  },
  accountIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountInfo: {
    flex: 1,
  },
  accountName: {
    fontSize: 15,
    fontWeight: '500',
  },
  accountBank: {
    fontSize: 12,
    marginTop: 2,
  },
  accountMeta: {
    alignItems: 'flex-end',
  },
  unmatchedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  unmatchedText: {
    fontSize: 11,
    fontWeight: '600',
  },
  transactionCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  transactionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  transactionType: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  transactionDate: {
    fontSize: 12,
  },
  transactionAmount: {
    fontSize: 16,
    fontWeight: '700',
  },
  transactionDesc: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  transactionCounterparty: {
    fontSize: 12,
    marginBottom: 10,
  },
  transactionFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  suggestedMatch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  suggestedText: {
    fontSize: 12,
    fontWeight: '500',
  },
  confidenceText: {
    fontSize: 11,
  },
  noMatchText: {
    fontSize: 12,
  },
});
