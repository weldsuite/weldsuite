/**
 * Invoice list — search, status filter and infinite scroll over
 * `GET /api/invoices`.
 *
 * `overdue` isn't a server-side status (app-api derives it), so that filter is
 * applied client-side over the loaded pages rather than sent as a query param.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FileText, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import api from '@/services/api';
import { toNumber } from '@/lib/currency';
import { isOverdue } from '@/lib/date';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { InvoiceStatusBadge } from '@/components/status-badge';
import { usePagedList } from '@/hooks/usePagedList';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { Invoice } from '@/types/accounting';

export default function InvoicesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { activeEntity } = useAccountingEntity();
  const [filter, setFilter] = useState('all');
  const { t, format } = useI18n();
  const { formatCurrency, formatShortDate } = useLocaleFormatters();

  /** `value: undefined` = no filter; `overdue` is filtered client-side. */
  const FILTERS: { key: string; label: string; value?: string }[] = [
    { key: 'all', label: t.invoices.filterAll },
    { key: 'draft', label: t.invoices.filterDraft, value: 'draft' },
    { key: 'sent', label: t.invoices.filterSent, value: 'sent' },
    { key: 'overdue', label: t.invoices.filterOverdue },
    { key: 'paid', label: t.invoices.filterPaid, value: 'paid' },
  ];

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];

  const list = usePagedList<Invoice>({
    fetcher: (params) => api.getInvoices(params),
    status: activeFilter.value,
    resetKey: activeEntity?.id,
  });

  const { reload } = list;
  // Coming back from a detail screen that sent/paid/deleted an invoice.
  useFocusEffect(useCallback(() => reload(), [reload]));

  const visible = useMemo(() => {
    if (filter !== 'overdue') return list.items;
    return list.items.filter(
      (invoice) =>
        (invoice.status === 'sent' ||
          invoice.status === 'viewed' ||
          invoice.status === 'partially_paid') &&
        isOverdue(invoice.dueDate, toNumber(invoice.balanceDue)),
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
      title={t.invoices.title}
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel={t.invoices.newInvoice}
          onPress={() => open('/invoice/new')}
        />
      }
      below={
        <View style={styles.controls}>
          <SearchBar
            value={list.search}
            onChangeText={list.setSearch}
            placeholder={t.invoices.searchPlaceholder}
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
        <ErrorState message={t.invoices.loadError} onRetry={list.refresh} />
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
            leading={<IconTile icon={FileText} color={BRAND} />}
            title={item.contactName || item.invoiceNumber || t.common.draft}
            subtitle={item.invoiceNumber || t.common.draft}
            meta={format(t.common.dueOn, { date: formatShortDate(item.dueDate) })}
            amount={formatCurrency(item.total, item.currency)}
            badge={
              <InvoiceStatusBadge
                status={item.status}
                dueDate={item.dueDate}
                balanceDue={item.balanceDue}
              />
            }
            onPress={() => open(`/invoice/${item.id}`)}
          />
        )}
        ListFooterComponent={
          list.loadingMore ? (
            <ActivityIndicator style={styles.footer} color={BRAND} />
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon={<FileText size={32} color={colors.mutedForeground} />}
            title={list.search ? t.invoices.noMatchTitle : t.invoices.emptyTitle}
            description={
              list.search ? t.invoices.noMatchDescription : t.invoices.emptyDescription
            }
            action={
              list.search ? undefined : (
                <Button title={t.invoices.newInvoice} onPress={() => open('/invoice/new')} />
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
