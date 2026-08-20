/**
 * Bank accounts — balances across every connected account.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Landmark } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Card } from '@weldsuite/mobile-ui/components/Card';

import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { formatDate } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import type { BankAccount } from '@/types/accounting';

export default function BankAccountsScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(false);
      setAccounts(await api.getBankAccounts());
    } catch (err) {
      console.error('Failed to load bank accounts:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Accounts can be in different currencies; only total the ones that agree.
  const total = useMemo(() => {
    if (accounts.length === 0) return null;
    const currency = accounts[0].currency;
    if (accounts.some((a) => a.currency !== currency)) return null;
    return { amount: accounts.reduce((sum, a) => sum + a.balance, 0), currency };
  }, [accounts]);

  const header = <ScreenHeader title="Bank accounts" showBack />;

  if (loading) {
    return (
      <Screen header={header}>
        <ListSkeleton count={4} />
      </Screen>
    );
  }

  if (error && accounts.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message="Couldn't load bank accounts." onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={accounts}
        keyExtractor={(item) => item.id}
        contentContainerStyle={accounts.length ? styles.list : styles.listEmpty}
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
          total ? (
            <Card style={styles.totalCard}>
              <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>
                Total balance
              </Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>
                {formatCurrency(total.amount, total.currency)}
              </Text>
            </Card>
          ) : null
        }
        renderItem={({ item }) => (
          <RecordRow
            leading={<IconTile icon={Landmark} color={ACCENTS.banking} />}
            title={item.name}
            subtitle={item.iban || item.bankName || undefined}
            meta={
              item.lastImportDate ? `Last import ${formatDate(item.lastImportDate)}` : 'Never imported'
            }
            amount={formatCurrency(item.balance, item.currency)}
            amountColor={item.balance < 0 ? colors.destructive : undefined}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push(`/bank/${item.id}` as never);
            }}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={<Landmark size={32} color={colors.mutedForeground} />}
            title="No bank accounts"
            description="Connect or import a bank account in WeldBooks on the web to see balances here."
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
  totalCard: { padding: 16, marginBottom: 4 },
  totalLabel: { fontSize: 12, fontWeight: '500' },
  totalValue: { fontSize: 28, fontWeight: '700', marginTop: 4, letterSpacing: -0.6 },
});
