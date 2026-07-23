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
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft } from 'lucide-react-native';

type BankAccount = {
  id: string;
  name: string;
  bankName: string;
  iban: string;
  balance: number;
  currency: string;
  lastSyncedAt: string | null;
};

function maskIban(iban: string): string {
  if (iban.length <= 8) return iban;
  return iban.slice(0, 4) + ' **** **** ' + iban.slice(-4);
}

export default function BankAccountsScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getBankAccounts();
      setAccounts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bank accounts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAccounts();
  }, [fetchAccounts]);

  const totalBalance = accounts.reduce((sum, acc) => sum + acc.balance, 0);
  const primaryCurrency = accounts[0]?.currency || 'EUR';

  const handleAccountPress = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/bank/${id}` as any);
  };

  const renderAccount = ({ item }: { item: BankAccount }) => {
    const synced = item.lastSyncedAt != null;
    return (
      <TouchableOpacity
        style={[styles.accountCard, { backgroundColor: colors.cardBackground }]}
        onPress={() => handleAccountPress(item.id)}
        activeOpacity={0.6}
      >
        <View style={styles.accountTop}>
          <View style={styles.accountInfo}>
            <Text style={[styles.accountName, { color: colors.text }]}>{item.name}</Text>
            <Text style={[styles.bankName, { color: colors.muted }]}>{item.bankName}</Text>
          </View>
          <View style={styles.syncContainer}>
            <View style={[styles.syncDot, { backgroundColor: synced ? '#10B981' : '#F59E0B' }]} />
            <Text style={[styles.syncText, { color: colors.muted }]}>
              {synced ? 'Synced' : 'Pending'}
            </Text>
          </View>
        </View>
        <Text style={[styles.iban, { color: colors.muted }]}>{maskIban(item.iban)}</Text>
        <Text style={[styles.accountBalance, { color: colors.text }]}>
          {formatCurrency(item.balance, item.currency)}
        </Text>
      </TouchableOpacity>
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

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Bank Accounts</Text>
        <View style={styles.headerSpacer} />
      </View>

      {error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: '#EF4444' }]}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchAccounts}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={accounts}
          keyExtractor={(item) => item.id}
          renderItem={renderAccount}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#10B981" />
          }
          ListHeaderComponent={
            <View style={styles.totalCard}>
              <Text style={styles.totalLabel}>Total Balance</Text>
              <Text style={styles.totalAmount}>
                {formatCurrency(totalBalance, primaryCurrency)}
              </Text>
              <Text style={styles.totalAccounts}>
                {accounts.length} account{accounts.length !== 1 ? 's' : ''}
              </Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                No bank accounts connected
              </Text>
            </View>
          }
        />
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
  totalCard: {
    backgroundColor: '#1F2937',
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
    alignItems: 'center',
  },
  totalLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    marginBottom: 4,
  },
  totalAmount: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  totalAccounts: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginTop: 4,
  },
  accountCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  accountTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  accountInfo: {
    flex: 1,
  },
  accountName: {
    fontSize: 16,
    fontWeight: '600',
  },
  bankName: {
    fontSize: 13,
    marginTop: 2,
  },
  syncContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  syncDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  syncText: {
    fontSize: 12,
  },
  iban: {
    fontSize: 13,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  accountBalance: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 8,
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 15,
  },
  errorText: {
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
