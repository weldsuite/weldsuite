/**
 * Bank account detail — balance plus the 50 most recent transactions.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ArrowDownLeft, ArrowUpRight, Landmark } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';

import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { formatShortDate } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import type { BankAccountDetail } from '@/types/accounting';

export default function BankAccountDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();

  const [account, setAccount] = useState<BankAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(false);
      setAccount(await api.getBankAccount(id));
    } catch (err) {
      console.error('Failed to load bank account:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const header = (
    <ScreenHeader title={account?.name || 'Account'} subtitle={account?.iban} showBack />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <ListSkeleton />
      </Screen>
    );
  }

  if (error || !account) {
    return (
      <Screen header={header}>
        <ErrorState
          message="Couldn't load this account."
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={account.transactions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={ACCENTS.banking}
          />
        }
        ListHeaderComponent={
          <Card style={styles.balanceCard}>
            <View style={styles.balanceRow}>
              <IconTile icon={Landmark} color={ACCENTS.banking} size={44} />
              <View style={styles.balanceText}>
                <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>
                  Current balance
                </Text>
                <Text
                  style={[
                    styles.balanceValue,
                    { color: account.balance < 0 ? colors.destructive : colors.text },
                  ]}
                >
                  {formatCurrency(account.balance, account.currency)}
                </Text>
              </View>
            </View>
            {account.bankName ? (
              <Text style={[styles.bankName, { color: colors.mutedForeground }]}>
                {account.bankName}
              </Text>
            ) : null}
          </Card>
        }
        renderItem={({ item }) => {
          const incoming = item.amount >= 0;
          return (
            <RecordRow
              leading={
                <IconTile
                  icon={incoming ? ArrowDownLeft : ArrowUpRight}
                  color={incoming ? colors.success : colors.destructive}
                  size={32}
                />
              }
              title={item.description || item.counterpartyName || 'Transaction'}
              subtitle={item.counterpartyName && item.description ? item.counterpartyName : undefined}
              meta={formatShortDate(item.date)}
              amount={`${incoming ? '+' : ''}${formatCurrency(item.amount, item.currency)}`}
              amountColor={incoming ? colors.success : colors.text}
              badge={
                item.status === 'reconciled' ? (
                  <Badge variant="success" size="sm" label="Reconciled" />
                ) : (
                  <Badge variant="secondary" size="sm" label="Unmatched" />
                )
              }
            />
          );
        }}
        ListEmptyComponent={
          <EmptyState
            icon={<Landmark size={32} color={colors.mutedForeground} />}
            title="No transactions"
            description="Import a bank statement to see transactions for this account."
            style={styles.empty}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 8 },
  balanceCard: { padding: 16, marginBottom: 4 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  balanceText: { flex: 1 },
  balanceLabel: { fontSize: 12, fontWeight: '500' },
  balanceValue: { fontSize: 26, fontWeight: '700', marginTop: 2, letterSpacing: -0.6 },
  bankName: { fontSize: 13, marginTop: 12 },
  empty: { marginTop: 24 },
});
