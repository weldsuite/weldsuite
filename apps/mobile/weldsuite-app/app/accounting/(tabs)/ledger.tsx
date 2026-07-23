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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface LedgerEntry {
  id: string;
  date: string;
  reference: string;
  description: string;
  accountName: string;
  accountCode: string;
  debit: number;
  credit: number;
  balance: number;
  type: 'debit' | 'credit';
}

export default function LedgerScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [total, setTotal] = useState(0);

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    try {
      setLoading(true);
      const response = await api.getLedgerEntries({
        search: searchQuery || undefined,
      });

      if (response.success && response.data) {
        setEntries(response.data.items);
        setTotal(response.data.meta.total);
      }
    } catch (error) {
      console.error('Error loading ledger entries:', error);
      toast.error('Failed to load ledger entries');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleSearch = () => {
    loadEntries();
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadEntries();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const renderEntry = ({ item }: { item: LedgerEntry }) => {
    const isDebit = item.type === 'debit';

    return (
      <View style={[styles.entryItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={styles.entryContent}>
          <View style={styles.entryLeft}>
            <View style={styles.entryHeader}>
              <Text style={[styles.entryReference, { color: colors.text }]}>{item.reference}</Text>
              <Text style={[styles.entryDate, { color: colors.muted }]}>{formatDate(item.date)}</Text>
            </View>
            <Text style={[styles.entryDescription, { color: colors.muted }]} numberOfLines={1}>
              {item.description}
            </Text>
            <Text style={[styles.accountName, { color: colors.muted }]}>
              {item.accountCode ? `${item.accountCode} - ` : ''}{item.accountName}
            </Text>
          </View>
          <View style={styles.entryRight}>
            {item.debit > 0 && (
              <Text style={[styles.debitAmount, { color: colors.text }]}>
                {formatCurrency(item.debit)}
              </Text>
            )}
            {item.credit > 0 && (
              <Text style={[styles.creditAmount, { color: '#10B981' }]}>
                ({formatCurrency(item.credit)})
              </Text>
            )}
            <Text style={[styles.typeLabel, { color: isDebit ? '#EF4444' : '#10B981' }]}>
              {isDebit ? 'DR' : 'CR'}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <View style={[styles.emptyIconContainer, { backgroundColor: '#F3F4F6' }]}>
        <Ionicons name="document-text-outline" size={32} color="#9CA3AF" />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No Entries</Text>
      <Text style={[styles.emptyText, { color: colors.muted }]}>
        {searchQuery
          ? 'No entries match your search'
          : 'Ledger entries will appear here'
        }
      </Text>
    </View>
  );

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading ledger...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>General Ledger ({total})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search entries..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
        </View>
      </View>

      <FlatList
        data={entries}
        renderItem={renderEntry}
        keyExtractor={(item) => item.id}
        contentContainerStyle={entries.length === 0 ? styles.emptyListContainer : styles.listContainer}
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
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchContainer: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 16,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  emptyListContainer: {
    flex: 1,
  },
  entryItem: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  entryContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  entryLeft: {
    flex: 1,
    marginRight: 12,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  entryReference: {
    fontSize: 15,
    fontWeight: '600',
  },
  entryDate: {
    fontSize: 12,
  },
  entryDescription: {
    fontSize: 13,
    marginBottom: 2,
  },
  accountName: {
    fontSize: 12,
  },
  entryRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  debitAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
  creditAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
  typeLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 250,
  },
});
