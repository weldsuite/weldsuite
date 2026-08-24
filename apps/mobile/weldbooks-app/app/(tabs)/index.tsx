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
import { formatCompactCurrency, formatCurrency } from '@/lib/currency';
import { formatShortDate } from '@/lib/date';
import { BRAND, tint } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ErrorState } from '@/components/data-states';
import { InvoiceStatusBadge } from '@/components/status-badge';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import type { DashboardData } from '@/types/accounting';

const QUICK_ACTIONS = [
  { label: 'Invoice', icon: FileText, route: '/invoice/new' },
  { label: 'Expense', icon: Receipt, route: '/expense/quick' },
  { label: 'Scan', icon: Camera, route: '/scan' },
  { label: 'Reports', icon: BarChart3, route: '/reports' },
] as const;

export default function DashboardScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { activeEntity } = useAccountingEntity();
  const { queue, isOnline } = useOfflineQueue();

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
  }, []);

  useEffect(() => {
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
    <ScreenHeader title={activeEntity?.name || 'WeldBooks'} />
  );

  if (error && !data) {
    return (
      <Screen header={header}>
        <ErrorState
          message="Couldn't load your dashboard."
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
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

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
              ? `${count(queue.length, 'item')} waiting to sync.`
              : `Offline. ${count(queue.length, 'item')} queued.`}
          </Banner>
        ) : null}

        {loading && !data ? (
          <KpiSkeletonGrid />
        ) : data ? (
          <KpiGrid>
            <KpiCard
              label="Outstanding"
              value={money(data.receivables.outstanding)}
              sub={count(data.receivables.outstandingCount, 'invoice')}
              onPress={() => navigate('/(tabs)/invoices')}
            />
            <KpiCard
              label="Overdue"
              value={money(data.receivables.overdue)}
              sub={count(data.receivables.overdueCount, 'invoice')}
              warn={data.receivables.overdue > 0}
              onPress={() => navigate('/(tabs)/invoices')}
            />
            <KpiCard
              label="Payables"
              value={money(data.payables.outstanding)}
              sub={count(data.payables.outstandingCount, 'bill')}
              onPress={() => navigate('/(tabs)/expenses')}
            />
            <KpiCard
              label="Profit"
              value={money(data.profit.month)}
              sub="This month"
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
            title="No invoices yet"
            description="Create your first invoice to start tracking revenue."
            style={styles.empty}
          />
        ) : (
          (data?.recentInvoices ?? []).slice(0, 8).map((invoice) => (
            <RecordRow
              key={invoice.id}
              leading={<IconTile icon={FileText} color={BRAND} />}
              title={invoice.contactName || invoice.invoiceNumber || 'Draft'}
              subtitle={invoice.invoiceNumber || 'Draft'}
              meta={`Due ${formatShortDate(invoice.dueDate)}`}
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
