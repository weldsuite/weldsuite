import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft } from 'lucide-react-native';

type Transaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  runningBalance: number;
};

type BankAccountDetail = {
  id: string;
  name: string;
  bankName: string;
  iban: string;
  balance: number;
  currency: string;
  transactions: Transaction[];
};

export default function BankAccountDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();

  const [account, setAccount] = useState<BankAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccount = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const data = await api.getBankAccount(id);
      setAccount(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAccount();
  }, [fetchAccount]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAccount();
  }, [fetchAccount]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const renderTransaction = ({ item }: { item: Transaction }) => {
    const isPositive = item.amount >= 0;
    return (
      <View style={[styles.transactionRow, { backgroundColor: colors.cardBackground }]}>
        <View style={styles.transactionLeft}>
          <Text style={[styles.transactionDate, { color: colors.muted }]}>
            {formatDate(item.date)}
          </Text>
          <Text style={[styles.transactionDesc, { color: colors.text }]} numberOfLines={1}>
            {item.description}
          </Text>
        </View>
        <View style={styles.transactionRight}>
          <Text
            style={[
              styles.transactionAmount,
              { color: isPositive ? '#10B981' : '#EF4444' },
            ]}
          >
            {isPositive ? '+' : ''}
            {formatCurrency(item.amount, account?.currency)}
          </Text>
          <Text style={[styles.runningBalance, { color: colors.muted }]}>
            {formatCurrency(item.runningBalance, account?.currency)}
          </Text>
        </View>
      </View>
    );
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

  if (error || !account) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Account</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error || 'Account not found'}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchAccount}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {account.name}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList
        data={account.transactions}
        keyExtractor={(item) => item.id}
        renderItem={renderTransaction}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#10B981" />
        }
        ListHeaderComponent={
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>{account.bankName}</Text>
            <Text style={styles.balanceAmount}>
              {formatCurrency(account.balance, account.currency)}
            </Text>
            <Text style={styles.balanceIban}>{account.iban}</Text>
          </View>
        }
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: colors.divider }]} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.muted }]}>No transactions yet</Text>
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 32,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  balanceCard: {
    backgroundColor: '#1F2937',
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
    alignItems: 'center',
  },
  balanceLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    marginBottom: 4,
  },
  balanceAmount: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  balanceIban: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  transactionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
  },
  transactionLeft: {
    flex: 1,
    marginRight: 12,
  },
  transactionDate: {
    fontSize: 12,
    marginBottom: 2,
  },
  transactionDesc: {
    fontSize: 15,
    fontWeight: '500',
  },
  transactionRight: {
    alignItems: 'flex-end',
  },
  transactionAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
  runningBalance: {
    fontSize: 12,
    marginTop: 2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 2,
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 15,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retryButton: {
    paddingHorizontal: 20,
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
