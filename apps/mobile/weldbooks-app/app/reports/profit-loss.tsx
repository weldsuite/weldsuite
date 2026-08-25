/**
 * Profit & loss, with a period switcher.
 *
 * app-api computes the figures; the margin is derived here (revenue > 0 only)
 * so a zero-revenue period reads 0% instead of NaN.
 */

import { useCallback, useEffect, useState } from 'react';
import { Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Card } from '@weldsuite/mobile-ui/components/Card';

import api from '@/services/api';
import { formatPercent } from '@/lib/currency';
import { currentMonthRange, currentYearRange } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, TotalsBlock } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { ProfitLossData } from '@/types/accounting';

export default function ProfitLossScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { formatCurrency, formatDate } = useLocaleFormatters();

  const PERIODS = [
    { label: t.profitLoss.thisMonth, value: 'month' },
    { label: t.profitLoss.thisYear, value: 'year' },
  ];

  const [period, setPeriod] = useState('month');
  const [data, setData] = useState<ProfitLossData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const range = period === 'year' ? currentYearRange() : currentMonthRange();

  const load = useCallback(async () => {
    const { from, to } = period === 'year' ? currentYearRange() : currentMonthRange();
    try {
      setError(false);
      setData(await api.getProfitLoss(from, to));
    } catch (err) {
      console.error('Failed to load profit & loss:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const header = (
    <ScreenHeader
      title={t.profitLoss.title}
      subtitle={`${formatDate(range.from)} – ${formatDate(range.to)}`}
      showBack
      below={
        <SegmentedControl
          options={PERIODS}
          value={period}
          onValueChange={setPeriod}
          style={styles.segments}
        />
      }
    />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (error || !data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.profitLoss.loadError}
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  const profitable = data.netProfit >= 0;

  return (
    <Screen header={header}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={ACCENTS.profitLoss}
          />
        }
      >
        <Card style={styles.hero}>
          <Text style={[styles.heroLabel, { color: colors.mutedForeground }]}>
            {profitable ? t.profitLoss.netProfit : t.profitLoss.netLoss}
          </Text>
          <Text
            style={[styles.heroValue, { color: profitable ? colors.success : colors.destructive }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {formatCurrency(Math.abs(data.netProfit), data.currency)}
          </Text>
          <Text style={[styles.heroMeta, { color: colors.mutedForeground }]}>
            {formatPercent(data.profitMargin)} margin
          </Text>
        </Card>

        <SectionCard title={t.profitLoss.breakdown}>
          <TotalsBlock
            rows={[
              { label: t.profitLoss.revenue, value: formatCurrency(data.revenue, data.currency) },
              { label: t.profitLoss.expenses, value: `−${formatCurrency(data.expenses, data.currency)}` },
            ]}
            total={{
              label: profitable ? t.profitLoss.netProfit : t.profitLoss.netLoss,
              value: formatCurrency(data.netProfit, data.currency),
            }}
          />
        </SectionCard>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  segments: { marginBottom: 4 },
  content: { paddingBottom: 40, paddingTop: 8 },
  hero: { marginHorizontal: 12, padding: 20, alignItems: 'center' },
  heroLabel: { fontSize: 13, fontWeight: '500' },
  heroValue: { fontSize: 36, fontWeight: '700', marginTop: 4, letterSpacing: -1 },
  heroMeta: { fontSize: 13, marginTop: 6 },
});
