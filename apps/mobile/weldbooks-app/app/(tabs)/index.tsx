/**
 * WeldBooks dashboard.
 *
 * The KPI set and ordering mirror the platform's
 * `app/weldbooks/dashboard/components/kpi-cards.tsx` so the two surfaces report
 * the same figures, laid out two-up for phones.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FileText, Receipt, Camera, BarChart3, ChevronRight, WifiOff } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

import api from '@/services/api';
import { formatCompactCurrency, formatCurrency } from '@/lib/currency';
import { formatShortDate } from '@/lib/date';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { RecordRow } from '@/components/record-row';
import { ErrorState } from '@/components/data-states';
import { InvoiceStatusBadge } from '@/components/status-badge';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import type { DashboardData } from '@/types/accounting';

const QUICK_ACTIONS = [
  { label: 'New invoice', icon: FileText, route: '/invoice/new' },
  { label: 'Quick expense', icon: Receipt, route: '/expense/quick' },
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
    <ScreenHeader title="WeldBooks" subtitle={activeEntity?.name ?? undefined} />
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
            <KpiCard label="Revenue (month)" value={money(data.revenue.month)} />
            <KpiCard label="Revenue (year)" value={money(data.revenue.year)} />
            <KpiCard label="Expenses (month)" value={money(data.expenses.month)} />
            <KpiCard label="Profit (month)" value={money(data.profit.month)} />
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
              label="Pending documents"
              value={String(data.pendingDocuments)}
              onPress={() => navigate('/scan')}
            />
          </KpiGrid>
        ) : null}

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>QUICK ACTIONS</Text>
        <View style={styles.actions}>
          {QUICK_ACTIONS.map(({ label, icon: Icon, route }) => (
            <Pressable
              key={route}
              onPress={() => navigate(route)}
              accessibilityRole="button"
              accessibilityLabel={label}
              style={({ pressed }) => [styles.actionCell, pressed && styles.pressed]}
            >
              <Card style={styles.actionCard}>
                <View style={styles.actionIcon}>
                  <Icon size={20} color={BRAND} />
                </View>
                <Text style={[styles.actionLabel, { color: colors.text }]} numberOfLines={1}>
                  {label}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            RECENT INVOICES
          </Text>
          <Pressable onPress={() => navigate('/(tabs)/invoices')} accessibilityRole="button">
            <View style={styles.seeAll}>
              <Text style={[styles.seeAllText, { color: BRAND }]}>See all</Text>
              <ChevronRight size={16} color={BRAND} />
            </View>
          </Pressable>
        </View>

        {data && data.recentInvoices.length === 0 ? (
          <EmptyState
            icon={<FileText size={32} color={colors.mutedForeground} />}
            title="No invoices yet"
            description="Create your first invoice to start tracking revenue."
            style={styles.empty}
          />
        ) : (
          <View style={styles.list}>
            {(data?.recentInvoices ?? []).slice(0, 5).map((invoice) => (
              <RecordRow
                key={invoice.id}
                title={invoice.invoiceNumber || 'Draft'}
                subtitle={invoice.contactName}
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
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 12, paddingBottom: 32 },
  banner: { marginHorizontal: 12, marginBottom: 12 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginTop: 24,
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 12,
  },
  seeAll: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
  seeAllText: { fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 8 },
  actionCell: { width: '48.4%' },
  pressed: { opacity: 0.7 },
  actionCard: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: 'rgba(16,185,129,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  list: { paddingHorizontal: 12, gap: 8 },
  empty: { marginTop: 8 },
});
