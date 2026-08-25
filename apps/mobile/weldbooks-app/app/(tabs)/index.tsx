/**
 * WeldBooks dashboard.
 *
 * List-first home that matches the floating pill nav: a large title, a
 * compact KPI strip, icon shortcuts, then recent invoices as full-bleed rows.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FileText, Receipt, Camera, BarChart3, WifiOff } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

import api from '@/services/api';
import { BRAND, tint } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ErrorState } from '@/components/data-states';
import { InvoiceStatusBadge } from '@/components/status-badge';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { DashboardData } from '@/types/accounting';

export default function DashboardScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { activeEntity, canSwitch, openSwitcher } = useAccountingEntity();
  const { queue, isOnline } = useOfflineQueue();
  const { t, format, plural } = useI18n();
  const { formatCompactCurrency, formatCurrency, formatShortDate } = useLocaleFormatters();

  const QUICK_ACTIONS = [
    { label: t.dashboard.invoice, icon: FileText, route: '/invoice/new' },
    { label: t.dashboard.expense, icon: Receipt, route: '/expense/quick' },
    { label: t.dashboard.scan, icon: Camera, route: '/scan' },
    { label: t.dashboard.reports, icon: BarChart3, route: '/reports' },
  ] as const;

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const fetchDashboard = useCallback(async () => {
    try {
      setError(false);
      setData(await api.getDashboard());
    } catch (err) {
      console.error('Failed to load dashboard:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeEntity?.id]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetchDashboard();
  }, [fetchDashboard]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboard();
  }, [fetchDashboard]);

  const navigate = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={activeEntity?.name || 'WeldBooks'}
      onTitlePress={canSwitch ? openSwitcher : undefined}
    />
  );

  if (error && !data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.dashboard.loadError}
          onRetry={() => {
            setLoading(true);
            fetchDashboard();
          }}
        />
      </Screen>
    );
  }

  const currency = data?.currency ?? 'EUR';
  const money = (value: number) => formatCompactCurrency(value, currency);

  return (
    <Screen header={header}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND} />
        }
      >
        {!isOnline || queue.length > 0 ? (
          <Banner
            variant={isOnline ? 'info' : 'warning'}
            icon={<WifiOff size={18} color={colors.warning} />}
            style={styles.banner}
          >
            {isOnline
              ? plural(queue.length, t.dashboard.itemsWaiting)
              : plural(queue.length, t.dashboard.offlineQueued)}
          </Banner>
        ) : null}

        {loading && !data ? (
          <KpiSkeletonGrid />
        ) : data ? (
          <KpiGrid>
            <KpiCard
              label={t.dashboard.outstanding}
              value={money(data.receivables.outstanding)}
              sub={plural(data.receivables.outstandingCount, t.dashboard.invoiceCount)}
              onPress={() => navigate('/(tabs)/invoices')}
            />
            <KpiCard
              label={t.dashboard.overdue}
              value={money(data.receivables.overdue)}
              sub={plural(data.receivables.overdueCount, t.dashboard.invoiceCount)}
              warn={data.receivables.overdue > 0}
              onPress={() => navigate('/(tabs)/invoices')}
            />
            <KpiCard
              label={t.dashboard.payables}
              value={money(data.payables.outstanding)}
              sub={plural(data.payables.outstandingCount, t.dashboard.billCount)}
              onPress={() => navigate('/(tabs)/expenses')}
            />
            <KpiCard
              label={t.dashboard.profit}
              value={money(data.profit.month)}
              sub={t.dashboard.thisMonth}
            />
          </KpiGrid>
        ) : null}

        <View style={styles.actions}>
          {QUICK_ACTIONS.map(({ label, icon: Icon, route }) => (
            <Pressable
              key={route}
              onPress={() => navigate(route)}
              accessibilityRole="button"
              accessibilityLabel={label}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <View style={[styles.actionIcon, { backgroundColor: tint(BRAND) }]}>
                <Icon size={22} color={BRAND} strokeWidth={2.2} />
              </View>
              <Text style={[styles.actionLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        {data && data.recentInvoices.length === 0 ? (
          <EmptyState
            icon={<FileText size={32} color={colors.mutedForeground} />}
            title={t.dashboard.noInvoicesTitle}
            description={t.dashboard.noInvoicesDescription}
            style={styles.empty}
          />
        ) : (
          (data?.recentInvoices ?? []).slice(0, 8).map((invoice) => (
            <RecordRow
              key={invoice.id}
              leading={<IconTile icon={FileText} color={BRAND} />}
              title={invoice.contactName || invoice.invoiceNumber || t.common.draft}
              subtitle={invoice.invoiceNumber || t.common.draft}
              meta={format(t.common.dueOn, { date: formatShortDate(invoice.dueDate) })}
              amount={formatCurrency(invoice.total, invoice.currency || currency)}
              badge={
                <InvoiceStatusBadge
                  status={invoice.status}
                  dueDate={invoice.dueDate}
                  balanceDue={invoice.balanceDue}
                />
              }
              onPress={() => navigate(`/invoice/${invoice.id}`)}
            />
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 16 },
  banner: { marginHorizontal: 16, marginBottom: 12 },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingTop: 20,
    paddingBottom: 12,
  },
  action: { flex: 1, alignItems: 'center', gap: 8 },
  pressed: { opacity: 0.7 },
  actionIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 12, fontWeight: '600' },
  empty: { marginTop: 24 },
});
