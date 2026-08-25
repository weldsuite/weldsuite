/**
 * Bank reconciliation.
 *
 * Each unmatched transaction carries app-api's ranked match suggestions; tapping
 * one calls `POST /bank-transactions/:id/reconcile`. Confidence is shown so a
 * weak suggestion reads as a guess rather than an instruction.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, RefreshControl, StyleSheet, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { GitMerge, ArrowDownLeft, ArrowUpRight, Check } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { formatShortDate } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import type { ReconciliationStats, UnmatchedTransaction } from '@/types/accounting';

/** app-api scores 0–1; anything under 0.6 is presented as a weak guess. */
function confidenceVariant(confidence: number): 'success' | 'warning' | 'secondary' {
  if (confidence >= 0.8) return 'success';
  if (confidence >= 0.6) return 'warning';
  return 'secondary';
}

export default function ReconciliationScreen() {
  const { colors } = useTheme();
  const toast = useToast();

  const [stats, setStats] = useState<ReconciliationStats | null>(null);
  const [transactions, setTransactions] = useState<UnmatchedTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [matchingId, setMatchingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(false);
      const [statsResult, rows] = await Promise.all([
        api.getReconciliationStats(),
        api.getUnmatchedTransactions({ limit: 20 }),
      ]);
      setStats(statsResult);
      setTransactions(rows);
    } catch (err) {
      console.error('Failed to load reconciliation:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleMatch = useCallback(
    async (transactionId: string, suggestionId: string) => {
      setMatchingId(transactionId);
      try {
        await api.matchTransaction(transactionId, suggestionId);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success('Transaction reconciled');
        // Drop it locally so the list doesn't jump while the counts refresh.
        setTransactions((prev) => prev.filter((t) => t.id !== transactionId));
        setStats((prev) =>
          prev
            ? {
                ...prev,
                totalUnmatched: Math.max(0, prev.totalUnmatched - 1),
                totalMatched: prev.totalMatched + 1,
              }
            : prev,
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not reconcile');
      } finally {
        setMatchingId(null);
      }
    },
    [toast],
  );

  const header = <ScreenHeader title="Reconciliation" showBack />;

  if (loading) {
    return (
      <Screen header={header}>
        <ListSkeleton />
      </Screen>
    );
  }

  if (error && transactions.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message="Couldn't load reconciliation." onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={ACCENTS.reconciliation}
          />
        }
        ListHeaderComponent={
          stats ? (
            <View style={styles.stats}>
              <Card style={styles.statCard}>
                <Text style={[styles.statValue, { color: colors.text }]}>
                  {stats.totalUnmatched}
                </Text>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Unmatched</Text>
              </Card>
              <Card style={styles.statCard}>
                <Text style={[styles.statValue, { color: colors.success }]}>
                  {stats.totalMatched}
                </Text>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Reconciled</Text>
              </Card>
              <Card style={styles.statCard}>
                <Text style={[styles.statValue, { color: colors.text }]} numberOfLines={1}>
                  {formatCurrency(stats.pendingAmount, stats.currency)}
                </Text>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Pending</Text>
              </Card>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const incoming = item.amount >= 0;
          const busy = matchingId === item.id;
          return (
            <Card style={[styles.txCard, busy && styles.busy]}>
              <View style={styles.txHeader}>
                <IconTile
                  icon={incoming ? ArrowDownLeft : ArrowUpRight}
                  color={incoming ? colors.success : colors.destructive}
                  size={34}
                />
                <View style={styles.txMain}>
                  <Text style={[styles.txTitle, { color: colors.text }]} numberOfLines={1}>
                    {item.description || item.counterpartyName || 'Transaction'}
                  </Text>
                  <Text style={[styles.txMeta, { color: colors.mutedForeground }]}>
                    {formatShortDate(item.date)}
                  </Text>
                </View>
                <Text style={[styles.txAmount, { color: colors.text }]}>
                  {incoming ? '+' : ''}
                  {formatCurrency(item.amount, item.currency)}
                </Text>
              </View>

              {item.suggestedMatches.length > 0 ? (
                <>
                  <Divider style={styles.txDivider} />
                  <Text style={[styles.suggestLabel, { color: colors.mutedForeground }]}>
                    SUGGESTED MATCHES
                  </Text>
                  {item.suggestedMatches.map((suggestion) => (
                    <Pressable
                      key={suggestion.id}
                      disabled={busy}
                      onPress={() => handleMatch(item.id, suggestion.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Match with ${suggestion.description}`}
                      style={({ pressed }) => [
                        styles.suggestion,
                        { borderColor: colors.border },
                        pressed && { backgroundColor: colors.pressed },
                      ]}
                    >
                      <View style={styles.suggestionMain}>
                        <Text
                          style={[styles.suggestionText, { color: colors.text }]}
                          numberOfLines={1}
                        >
                          {suggestion.description}
                        </Text>
                        <Text style={[styles.suggestionAmount, { color: colors.mutedForeground }]}>
                          {formatCurrency(suggestion.amount, item.currency)}
                        </Text>
                      </View>
                      <Badge
                        variant={confidenceVariant(suggestion.confidence)}
                        size="sm"
                        label={`${Math.round(suggestion.confidence * 100)}%`}
                      />
                      <Check size={16} color={colors.mutedForeground} />
                    </Pressable>
                  ))}
                </>
              ) : (
                <Text style={[styles.noSuggestions, { color: colors.mutedForeground }]}>
                  No suggested matches. Reconcile this one in WeldBooks on the web.
                </Text>
              )}
            </Card>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            icon={<GitMerge size={32} color={colors.mutedForeground} />}
            title="Everything reconciled"
            description="No unmatched bank transactions right now."
            style={styles.empty}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  stats: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  statCard: { flex: 1, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  statLabel: { fontSize: 11, marginTop: 2 },
  txCard: { padding: 14 },
  busy: { opacity: 0.5 },
  txHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  txMain: { flex: 1, minWidth: 0 },
  txTitle: { fontSize: 15, fontWeight: '600' },
  txMeta: { fontSize: 12, marginTop: 2 },
  txAmount: { fontSize: 15, fontWeight: '700' },
  txDivider: { marginVertical: 12 },
  suggestLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    marginBottom: 6,
  },
  suggestionMain: { flex: 1, minWidth: 0 },
  suggestionText: { fontSize: 14, fontWeight: '500' },
  suggestionAmount: { fontSize: 12, marginTop: 2 },
  noSuggestions: { fontSize: 13, marginTop: 12, lineHeight: 18 },
  empty: { marginTop: 40 },
});
