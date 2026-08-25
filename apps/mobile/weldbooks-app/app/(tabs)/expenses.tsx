/**
 * Expenses — the bill list.
 *
 * Quick expenses are one-line bills on app-api (there is no separate expense
 * entity), so this is a single list over `GET /api/bills` with status filters
 * rather than the two-mode segmented view it used to be.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Receipt, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import api from '@/services/api';
import { formatCurrency, toNumber } from '@/lib/currency';
import { formatShortDate, isOverdue } from '@/lib/date';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { BillStatusBadge } from '@/components/status-badge';
import { usePagedList } from '@/hooks/usePagedList';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import type { Bill } from '@/types/accounting';

/** `value: undefined` = no filter; `overdue` is derived client-side. */
const FILTERS: { key: string; label: string; value?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft', value: 'draft' },
  { key: 'pending', label: 'Pending', value: 'pending' },
  { key: 'approved', label: 'Approved', value: 'approved' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid', value: 'paid' },
];

export default function ExpensesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { activeEntity } = useAccountingEntity();
  const [filter, setFilter] = useState('all');

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];

  const list = usePagedList<Bill>({
    fetcher: (params) => api.getBills(params),
    status: activeFilter.value,
    resetKey: activeEntity?.id,
  });

  const { reload } = list;
  useFocusEffect(useCallback(() => reload(), [reload]));

  const visible = useMemo(() => {
    if (filter !== 'overdue') return list.items;
    return list.items.filter(
      (bill) =>
        (bill.status === 'approved' || bill.status === 'partially_paid') &&
        isOverdue(bill.dueDate, toNumber(bill.balanceDue)),
    );
  }, [list.items, filter]);

  const open = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title="Expenses"
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel="New expense"
          onPress={() => open('/expense/quick')}
        />
      }
      below={
        <View style={styles.controls}>
          <SearchBar
            value={list.search}
            onChangeText={list.setSearch}
            placeholder="Search bills and expenses"
            containerStyle={styles.search}
          />
          <View style={styles.chips}>
            {FILTERS.map((f) => (
              <Chip
                key={f.key}
                label={f.label}
                selected={filter === f.key}
                onPress={() => setFilter(f.key)}
              />
            ))}
          </View>
        </View>
      }
    />
  );

  if (list.loading) {
    return (
      <Screen header={header}>
        <ListSkeleton />
      </Screen>
    );
  }

  if (list.error && visible.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message="Couldn't load expenses." onRetry={list.refresh} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        contentContainerStyle={visible.length ? styles.list : styles.listEmpty}
        refreshControl={
          <RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={BRAND} />
        }
        onEndReached={list.loadMore}
        onEndReachedThreshold={0.3}
        renderItem={({ item }) => (
          <RecordRow
            leading={<IconTile icon={Receipt} color={BRAND} />}
            title={item.contactName || 'Unknown vendor'}
            subtitle={item.billNumber || 'Draft'}
            meta={`Due ${formatShortDate(item.dueDate)}`}
            amount={formatCurrency(item.total, item.currency)}
            badge={
              <BillStatusBadge
                status={item.status}
                dueDate={item.dueDate}
                balanceDue={item.balanceDue}
              />
            }
            onPress={() => open(`/bill/${item.id}`)}
          />
        )}
        ListFooterComponent={
          list.loadingMore ? <ActivityIndicator style={styles.footer} color={BRAND} /> : null
        }
        ListEmptyComponent={
          <EmptyState
            icon={<Receipt size={32} color={colors.mutedForeground} />}
            title={list.search ? 'No matching expenses' : 'No expenses yet'}
            description={
              list.search
                ? 'Try a different search term or clear the filter.'
                : 'Scan a receipt or add an expense to start tracking costs.'
            }
            action={
              list.search ? undefined : (
                <Button title="Add expense" onPress={() => open('/expense/quick')} />
              )
            }
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { gap: 10, paddingBottom: 8 },
  search: { borderRadius: 12, minHeight: 40 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  list: { paddingBottom: 8 },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
  footer: { paddingVertical: 20 },
});
