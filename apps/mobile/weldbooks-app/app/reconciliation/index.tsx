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
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft, Check } from 'lucide-react-native';

type ReconciliationStats = {
  totalUnmatched: number;
  totalMatched: number;
  pendingAmount: number;
  currency: string;
};

type SuggestedMatch = {
  id: string;
  description: string;
  amount: number;
  type: string;
  confidence: number;
};

type UnmatchedTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  suggestedMatches: SuggestedMatch[];
};

export default function ReconciliationScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const [stats, setStats] = useState<ReconciliationStats | null>(null);
  const [transactions, setTransactions] = useState<UnmatchedTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [statsData, txData] = await Promise.all([
        api.getReconciliationStats(),
        api.getUnmatchedTransactions(),
      ]);
      setStats(statsData);
      setTransactions(txData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reconciliation data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  const handleToggleExpand = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedId(expandedId === id ? null : id);
  };

  const handleAcceptMatch = async (transactionId: string, matchId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMatchingId(matchId);
    try {
      await api.matchTransaction(transactionId, matchId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTransactions((prev) => prev.filter((tx) => tx.id !== transactionId));
      setExpandedId(null);
      // Refresh stats
      const updatedStats = await api.getReconciliationStats();
      setStats(updatedStats);
    } catch (err) {
      Alert.alert('Error', 'Failed to match transaction. Please try again.');
    } finally {
      setMatchingId(null);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const renderTransaction = ({ item }: { item: UnmatchedTransaction }) => {
    const isExpanded = expandedId === item.id;
    const isPositive = item.amount >= 0;

    return (
      <View style={[styles.txCard, { backgroundColor: colors.cardBackground }]}>
        <TouchableOpacity
          style={styles.txHeader}
          onPress={() => handleToggleExpand(item.id)}
          activeOpacity={0.6}
        >
          <View style={styles.txLeft}>
            <Text style={[styles.txDate, { color: colors.muted }]}>{formatDate(item.date)}</Text>
            <Text style={[styles.txDesc, { color: colors.text }]} numberOfLines={1}>
              {item.description}
            </Text>
          </View>
          <View style={styles.txRight}>
            <Text
              style={[
                styles.txAmount,
                { color: isPositive ? '#10B981' : '#EF4444' },
              ]}
            >
              {isPositive ? '+' : ''}
              {formatCurrency(item.amount, item.currency)}
            </Text>
            {item.suggestedMatches.length > 0 && (
              <Text style={[styles.matchCount, { color: colors.muted }]}>
                {item.suggestedMatches.length} suggestion
                {item.suggestedMatches.length !== 1 ? 's' : ''}
              </Text>
            )}
          </View>
        </TouchableOpacity>

        {isExpanded && (
          <View style={styles.matchesContainer}>
            <View style={[styles.matchesDivider, { backgroundColor: colors.divider }]} />
            {item.suggestedMatches.length === 0 ? (
              <Text style={[styles.noMatchesText, { color: colors.muted }]}>
                No suggested matches
              </Text>
            ) : (
              item.suggestedMatches.map((match) => (
                <View key={match.id} style={styles.matchRow}>
                  <View style={styles.matchInfo}>
                    <Text style={[styles.matchDesc, { color: colors.text }]}>
                      {match.description}
                    </Text>
                    <Text style={[styles.matchMeta, { color: colors.muted }]}>
                      {match.type} &middot; {Math.round(match.confidence * 100)}% match
                    </Text>
                  </View>
                  <Text style={[styles.matchAmount, { color: colors.text }]}>
                    {formatCurrency(match.amount, item.currency)}
                  </Text>
                  <TouchableOpacity
                    style={styles.acceptButton}
                    onPress={() => handleAcceptMatch(item.id, match.id)}
                    disabled={matchingId === match.id}
                  >
                    {matchingId === match.id ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Check size={16} color="#fff" />
                    )}
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        )}
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

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Reconciliation</Text>
        <View style={styles.headerSpacer} />
      </View>

      {error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchData}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={transactions}
          keyExtractor={(item) => item.id}
          renderItem={renderTransaction}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#10B981" />
          }
          ListHeaderComponent={
            stats ? (
              <View style={styles.statsRow}>
                <View style={[styles.statCard, { backgroundColor: colors.cardBackground }]}>
                  <Text style={[styles.statValue, { color: '#EF4444' }]}>
                    {stats.totalUnmatched}
                  </Text>
                  <Text style={[styles.statLabel, { color: colors.muted }]}>Unmatched</Text>
                </View>
                <View style={[styles.statCard, { backgroundColor: colors.cardBackground }]}>
                  <Text style={[styles.statValue, { color: '#10B981' }]}>
                    {stats.totalMatched}
                  </Text>
                  <Text style={[styles.statLabel, { color: colors.muted }]}>Matched</Text>
                </View>
                <View style={[styles.statCard, { backgroundColor: colors.cardBackground }]}>
                  <Text style={[styles.statValue, { color: '#F59E0B' }]}>
                    {formatCurrency(stats.pendingAmount, stats.currency)}
                  </Text>
                  <Text style={[styles.statLabel, { color: colors.muted }]}>Pending</Text>
                </View>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                All transactions are matched
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
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
  },
  txCard: {
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
  },
  txHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  txLeft: {
    flex: 1,
    marginRight: 12,
  },
  txDate: {
    fontSize: 12,
    marginBottom: 2,
  },
  txDesc: {
    fontSize: 15,
    fontWeight: '500',
  },
  txRight: {
    alignItems: 'flex-end',
  },
  txAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
  matchCount: {
    fontSize: 12,
    marginTop: 2,
  },
  matchesContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  matchesDivider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  noMatchesText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 8,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  matchInfo: {
    flex: 1,
  },
  matchDesc: {
    fontSize: 14,
    fontWeight: '500',
  },
  matchMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  matchAmount: {
    fontSize: 14,
    fontWeight: '600',
  },
  acceptButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#10B981',
    justifyContent: 'center',
    alignItems: 'center',
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
