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
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface Transaction {
  id: string;
  date: string;
  description: string;
  reference?: string;
  amount: number;
  type: 'deposit' | 'withdrawal';
  category: string;
  status: string;
}

interface BankAccount {
  id: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
  balance: number;
  availableBalance?: number;
}

export default function BankTransactionsScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams();
  const toast = useToast();
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'withdrawal' | 'deposit'>('all');

  const getBankLogo = (bankName: string) => {
    const logoStyle = { width: 48, height: 48, borderRadius: 8 };
    const iconColor = colors.background;
    
    switch (bankName.toLowerCase()) {
      case 'chase':
        return (
          <View style={[logoStyle, { backgroundColor: '#117ACA', alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: iconColor, fontSize: 18, fontWeight: '600' }}>C</Text>
          </View>
        );
      case 'american express':
        return (
          <View style={[logoStyle, { backgroundColor: '#006FCF', alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: iconColor, fontSize: 18, fontWeight: '600' }}>AE</Text>
          </View>
        );
      case 'wells fargo':
        return (
          <View style={[logoStyle, { backgroundColor: '#D71E2B', alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: iconColor, fontSize: 18, fontWeight: '600' }}>WF</Text>
          </View>
        );
      case 'bank of america':
        return (
          <View style={[logoStyle, { backgroundColor: '#E31837', alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: iconColor, fontSize: 18, fontWeight: '600' }}>BA</Text>
          </View>
        );
      case 'fidelity':
        return (
          <View style={[logoStyle, { backgroundColor: '#4CAF50', alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: iconColor, fontSize: 18, fontWeight: '600' }}>F</Text>
          </View>
        );
      default:
        return (
          <View style={[logoStyle, { backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' }]}>
            <Ionicons name="business" size={24} color={iconColor} />
          </View>
        );
    }
  };

  useEffect(() => {
    loadAccountAndTransactions();
  }, [id]);

  useEffect(() => {
    filterTransactions();
  }, [searchQuery, selectedFilter, transactions]);

  const loadAccountAndTransactions = async () => {
    try {
      setLoading(true);
      const response = await api.getBankAccount(id as string);

      if (response.success && response.data) {
        setAccount(response.data.account as BankAccount);
        setTransactions(response.data.transactions as Transaction[]);
        setFilteredTransactions(response.data.transactions as Transaction[]);
      }
    } catch (error) {
      console.error('Error loading account transactions:', error);
      toast.error('Failed to load transactions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterTransactions = () => {
    let filtered = [...transactions];

    // Filter by type
    if (selectedFilter !== 'all') {
      filtered = filtered.filter(t => t.type === selectedFilter);
    }

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(transaction =>
        transaction.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        transaction.reference?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        transaction.category.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    setFilteredTransactions(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadAccountAndTransactions();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
      });
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(amount));
  };

  const renderTransaction = ({ item }: { item: Transaction }) => {
    const isDeposit = item.type === 'deposit';
    const isPending = item.status === 'pending';

    return (
      <TouchableOpacity
        style={[styles.transactionItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        activeOpacity={0.7}
      >
        <View style={styles.transactionContent}>
          <View style={styles.transactionLeft}>
            <View style={styles.transactionHeader}>
              <Text style={[styles.transactionDescription, { color: colors.text }]}>
                {item.description}
              </Text>
              {isPending && (
                <View style={[styles.pendingBadge, { backgroundColor: '#FEF3C7' }]}>
                  <Text style={[styles.pendingText, { color: '#92400E' }]}>PENDING</Text>
                </View>
              )}
            </View>
            {item.reference && (
              <Text style={[styles.merchantName, { color: colors.muted }]}>
                {item.reference}
              </Text>
            )}
            <Text style={[styles.transactionDate, { color: colors.muted }]}>
              {formatDate(item.date)} · {item.category}
            </Text>
          </View>
          <View style={styles.transactionRight}>
            <Text style={[
              styles.transactionAmount,
              { color: isDeposit ? '#10B981' : colors.text }
            ]}>
              {isDeposit ? '+' : '-'}{formatCurrency(Math.abs(item.amount))}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <>
      {/* Account Info Card */}
      <View style={[styles.accountCard, { backgroundColor: colors.text }]}>
        <View style={styles.accountInfo}>
          <Text style={[styles.accountName, { color: colors.background }]}>
            {account?.accountName}
          </Text>
          <Text style={[styles.accountMeta, { color: colors.background, opacity: 0.7 }]}>
            {account?.bankName} ••••{account?.accountNumber}
          </Text>
          <View>
            <Text style={[styles.balanceLabel, { color: colors.background, opacity: 0.7 }]}>
              CURRENT BALANCE
            </Text>
            <Text style={[styles.balanceAmount, { color: colors.background }]}>
              {formatCurrency(account?.balance || 0)}
            </Text>
          </View>
        </View>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search transactions..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {/* Filter Tabs */}
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          <TouchableOpacity
            style={[
              styles.filterButton,
              {
                backgroundColor: selectedFilter === 'all' ? colors.text : colors.background,
                borderColor: selectedFilter === 'all' ? colors.text : colors.buttonBorder,
              }
            ]}
            onPress={() => setSelectedFilter('all')}
          >
            <Text style={[
              styles.filterButtonText,
              { color: selectedFilter === 'all' ? colors.background : colors.text }
            ]}>
              All Transactions
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.filterButton,
              {
                backgroundColor: selectedFilter === 'deposit' ? colors.text : colors.background,
                borderColor: selectedFilter === 'deposit' ? colors.text : colors.buttonBorder,
              }
            ]}
            onPress={() => setSelectedFilter('deposit')}
          >
            <Text style={[
              styles.filterButtonText,
              { color: selectedFilter === 'deposit' ? colors.background : colors.text }
            ]}>
              Money In
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.filterButton,
              {
                backgroundColor: selectedFilter === 'withdrawal' ? colors.text : colors.background,
                borderColor: selectedFilter === 'withdrawal' ? colors.text : colors.buttonBorder,
              }
            ]}
            onPress={() => setSelectedFilter('withdrawal')}
          >
            <Text style={[
              styles.filterButtonText,
              { color: selectedFilter === 'withdrawal' ? colors.background : colors.text }
            ]}>
              Money Out
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </>
  );

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.muted }]}>No transactions found</Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Transactions</Text>
        <View style={{ width: 24 }} />
      </View>

      <FlatList
        data={filteredTransactions}
        renderItem={renderTransaction}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomWidth: 0.5,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  accountCard: {
    margin: 24,
    marginTop: 16,
    marginBottom: 16,
    padding: 20,
    borderRadius: 8,
  },
  accountInfo: {
    gap: 4,
  },
  accountName: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 2,
  },
  accountMeta: {
    fontSize: 13,
    marginBottom: 16,
  },
  balanceLabel: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  balanceAmount: {
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  availableAmount: {
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.5,
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
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  listContainer: {
    paddingBottom: 24,
  },
  transactionItem: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  transactionContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  transactionLeft: {
    flex: 1,
    gap: 2,
  },
  transactionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  transactionDescription: {
    fontSize: 15,
    fontWeight: '500',
  },
  pendingBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  pendingText: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  merchantName: {
    fontSize: 13,
  },
  transactionDate: {
    fontSize: 12,
  },
  transactionRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  transactionAmount: {
    fontSize: 16,
    fontWeight: '600',
  },
  balanceText: {
    fontSize: 11,
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
});