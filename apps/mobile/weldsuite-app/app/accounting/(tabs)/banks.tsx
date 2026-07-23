import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface BankAccount {
  id: string;
  accountName: string;
  accountNumber: string; // Last 4 digits only
  bankName: string;
  bankIcon?: string;
  type: 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'other';
  balance: number;
  availableBalance?: number;
  currency: string;
  status: 'connected' | 'syncing' | 'error' | 'disconnected';
  lastSync: string;
  institution?: {
    name: string;
    logo?: string;
    color?: string;
  };
}

const ACCOUNT_TYPE_CONFIG = {
  checking: {
    label: 'Checking',
    icon: 'wallet-outline' as const,
    color: '#3B82F6',
  },
  savings: {
    label: 'Savings',
    icon: 'shield-checkmark-outline' as const,
    color: '#10B981',
  },
  credit: {
    label: 'Credit Card',
    icon: 'card-outline' as const,
    color: '#8B5CF6',
  },
  investment: {
    label: 'Investment',
    icon: 'trending-up-outline' as const,
    color: '#F59E0B',
  },
  loan: {
    label: 'Loan',
    icon: 'home-outline' as const,
    color: '#EF4444',
  },
  other: {
    label: 'Other',
    icon: 'ellipsis-horizontal-outline' as const,
    color: '#6B7280',
  },
};

const SYNC_STATUS_CONFIG = {
  connected: {
    label: 'Connected',
    color: '#10B981',
    icon: 'checkmark-circle' as const,
  },
  syncing: {
    label: 'Syncing',
    color: '#F59E0B',
    icon: 'sync' as const,
  },
  error: {
    label: 'Error',
    color: '#EF4444',
    icon: 'alert-circle' as const,
  },
  disconnected: {
    label: 'Disconnected',
    color: '#6B7280',
    icon: 'unlink' as const,
  },
};

export default function BanksScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<BankAccount | null>(null);
  const [accountModalVisible, setAccountModalVisible] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      setLoading(true);
      const response = await api.getBankAccounts();

      if (response.success && response.data) {
        setAccounts(response.data as BankAccount[]);
      }
    } catch (error) {
      console.error('Error loading bank accounts:', error);
      toast.error('Failed to load bank accounts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadAccounts();
  };

  const handleAccountPress = (account: BankAccount) => {
    router.push(`/bank/${account.id}` as any);
  };

  const handleSyncAccount = (account: BankAccount) => {
    setAccounts(accounts.map(acc =>
      acc.id === account.id
        ? { ...acc, status: 'syncing', lastSync: new Date().toISOString() }
        : acc
    ));
    toast.success(`Syncing ${account.accountName}`);
    // Simulate sync completion
    setTimeout(() => {
      setAccounts(accounts.map(acc =>
        acc.id === account.id
          ? { ...acc, status: 'connected', lastSync: new Date().toISOString() }
          : acc
      ));
      toast.success(`${account.accountName} synced successfully`);
    }, 2000);
  };

  const handleDisconnectAccount = (account: BankAccount) => {
    setAccounts(accounts.map(acc =>
      acc.id === account.id
        ? { ...acc, status: 'disconnected' }
        : acc
    ));
    setAccountModalVisible(false);
    toast.success(`${account.accountName} has been disconnected`);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  const getTotalBalance = () => {
    return accounts.reduce((total, account) => total + account.balance, 0);
  };

  const getAccountsByType = (type: BankAccount['type']) => {
    return accounts.filter(account => account.type === type);
  };

  const renderAccount = ({ item }: { item: BankAccount }) => {
    const typeConfig = ACCOUNT_TYPE_CONFIG[item.type];
    const statusConfig = SYNC_STATUS_CONFIG[item.status];

    return (
      <TouchableOpacity
        style={[styles.accountCard, { backgroundColor: colors.background, borderColor: colors.divider }]}
        onPress={() => handleAccountPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.accountContent}>
          <View style={styles.accountLeft}>
            <Text style={[styles.accountName, { color: colors.text }]}>{item.accountName}</Text>
            <Text style={[styles.accountMeta, { color: colors.muted }]}>
              {item.bankName} ••••{item.accountNumber}
            </Text>
            <Text style={[styles.balanceValue, { color: colors.text }]}>
              {formatCurrency(item.balance)}
            </Text>
          </View>
          <Ionicons name={statusConfig.icon} size={18} color={statusConfig.color} />
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <View style={styles.headerSection}>
      {/* Total Balance Card - black shadcn style */}
      <View style={[styles.totalCard, { backgroundColor: colors.text }]}>
        <View style={styles.totalContent}>
          <Text style={[styles.totalLabel, { color: colors.background, opacity: 0.7 }]}>TOTAL BALANCE</Text>
          <Text style={[styles.totalAmount, { color: colors.background }]}>
            {formatCurrency(getTotalBalance())}
          </Text>
          <Text style={[styles.totalAccounts, { color: colors.background, opacity: 0.7 }]}>
            {accounts.length} accounts connected
          </Text>
        </View>
      </View>
    </View>
  );

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.text }]}>No accounts</Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        Connect accounts via web dashboard
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading bank accounts...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Bank Accounts</Text>
      </View>

      <FlatList
        data={accounts}
        renderItem={renderAccount}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />

      {/* Account Details Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={accountModalVisible}
        onRequestClose={() => setAccountModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            {selectedAccount && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, { color: colors.text }]}>
                    {selectedAccount.accountName}
                  </Text>
                  <TouchableOpacity onPress={() => setAccountModalVisible(false)}>
                    <Ionicons name="close" size={24} color={colors.muted} />
                  </TouchableOpacity>
                </View>

                <View style={styles.modalBody}>
                  <View style={styles.modalSection}>
                    <Text style={[styles.modalLabel, { color: colors.muted }]}>Bank</Text>
                    <Text style={[styles.modalValue, { color: colors.text }]}>
                      {selectedAccount.bankName}
                    </Text>
                  </View>

                  <View style={styles.modalSection}>
                    <Text style={[styles.modalLabel, { color: colors.muted }]}>Account Number</Text>
                    <Text style={[styles.modalValue, { color: colors.text }]}>
                      ••••{selectedAccount.accountNumber}
                    </Text>
                  </View>

                  <View style={styles.modalSection}>
                    <Text style={[styles.modalLabel, { color: colors.muted }]}>Current Balance</Text>
                    <Text style={[styles.modalValue, { color: colors.text }]}>
                      {formatCurrency(selectedAccount.balance)}
                    </Text>
                  </View>

                  {selectedAccount.availableBalance !== undefined && (
                    <View style={styles.modalSection}>
                      <Text style={[styles.modalLabel, { color: colors.muted }]}>Available Balance</Text>
                      <Text style={[styles.modalValue, { color: colors.text }]}>
                        {formatCurrency(selectedAccount.availableBalance)}
                      </Text>
                    </View>
                  )}

                  <View style={styles.modalSection}>
                    <Text style={[styles.modalLabel, { color: colors.muted }]}>Last Synced</Text>
                    <Text style={[styles.modalValue, { color: colors.text }]}>
                      {formatTime(selectedAccount.lastSync)}
                    </Text>
                  </View>
                </View>

                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[styles.modalButton, { backgroundColor: colors.text }]}
                    onPress={() => {
                      setAccountModalVisible(false);
                      router.push(`/bank-transactions/${selectedAccount.id}` as any);
                    }}
                  >
                    <Text style={[styles.modalButtonText, { color: colors.background }]}>
                      View Transactions
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.divider }]}
                    onPress={() => handleSyncAccount(selectedAccount)}
                  >
                    <Text style={[styles.modalButtonText, { color: colors.text }]}>Sync Now</Text>
                  </TouchableOpacity>

                  {selectedAccount.status !== 'disconnected' && (
                    <TouchableOpacity
                      style={styles.modalDangerButton}
                      onPress={() => handleDisconnectAccount(selectedAccount)}
                    >
                      <Text style={styles.modalDangerText}>Disconnect Account</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
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
  header: {
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
    paddingBottom: 24,
  },
  headerSection: {
    padding: 24,
    paddingTop: 0,
  },
  totalCard: {
    borderRadius: 8,
    marginBottom: 0,
  },
  totalContent: {
    padding: 20,
  },
  totalLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  totalAmount: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  totalMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  totalAccounts: {
    fontSize: 13,
  },
  accountCard: {
    marginHorizontal: 24,
    marginBottom: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 8,
    borderWidth: 0.5,
  },
  accountContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  accountLeft: {
    flex: 1,
    gap: 4,
  },
  accountName: {
    fontSize: 15,
    fontWeight: '600',
  },
  accountMeta: {
    fontSize: 12,
  },
  balanceValue: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 48,
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtext: {
    fontSize: 13,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  modalBody: {
    marginBottom: 24,
  },
  modalSection: {
    marginBottom: 16,
  },
  modalLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  modalValue: {
    fontSize: 16,
    fontWeight: '500',
  },
  modalActions: {
    gap: 12,
  },
  modalButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalSecondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  modalButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalDangerButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalDangerText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#EF4444',
  },
});