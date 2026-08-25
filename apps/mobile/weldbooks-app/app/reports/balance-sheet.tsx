/**
 * Balance sheet.
 *
 * Flags when assets don't equal liabilities + equity — a genuine books problem
 * worth surfacing rather than quietly rounding away.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import type { BalanceSheetData, BalanceSheetSection } from '@/types/accounting';

function Section({
  section,
  currency,
}: {
  section: BalanceSheetSection;
  currency: string;
}) {
  const { colors } = useTheme();
  if (section.accounts.length === 0 && section.total === 0) return null;

  return (
    <SectionCard title={section.label}>
      {section.accounts.map((account) => (
        <View key={`${account.code}-${account.name}`} style={styles.accountRow}>
          <View style={styles.accountText}>
            <Text style={[styles.accountName, { color: colors.text }]} numberOfLines={1}>
              {account.name}
            </Text>
            {account.code ? (
              <Text style={[styles.accountCode, { color: colors.mutedForeground }]}>
                {account.code}
              </Text>
            ) : null}
          </View>
          <Text style={[styles.accountBalance, { color: colors.text }]}>
            {formatCurrency(account.balance, currency)}
          </Text>
        </View>
      ))}
      <Divider style={styles.sectionDivider} />
      <View style={styles.accountRow}>
        <Text style={[styles.sectionTotalLabel, { color: colors.text }]}>
          Total {section.label.toLowerCase()}
        </Text>
        <Text style={[styles.sectionTotalValue, { color: colors.text }]}>
          {formatCurrency(section.total, currency)}
        </Text>
      </View>
    </SectionCard>
  );
}

export default function BalanceSheetScreen() {
  const { colors } = useTheme();

  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(false);
      setData(await api.getBalanceSheet());
    } catch (err) {
      console.error('Failed to load balance sheet:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const header = <ScreenHeader title="Balance sheet" showBack />;

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
          message="Couldn't load the balance sheet."
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  // Tolerate sub-cent rounding, flag anything larger.
  const balanced = Math.abs(data.totalAssets - data.totalLiabilitiesAndEquity) < 0.01;

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
            tintColor={ACCENTS.balanceSheet}
          />
        }
      >
        <Card style={styles.hero}>
          <Text style={[styles.heroLabel, { color: colors.mutedForeground }]}>Total assets</Text>
          <Text style={[styles.heroValue, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
            {formatCurrency(data.totalAssets, data.currency)}
          </Text>
        </Card>

        {!balanced ? (
          <Banner variant="warning" title="Books don't balance" style={styles.banner}>
            Assets are {formatCurrency(data.totalAssets, data.currency)} but liabilities plus equity
            are {formatCurrency(data.totalLiabilitiesAndEquity, data.currency)}. Review your journal
            entries in WeldBooks on the web.
          </Banner>
        ) : null}

        <Section section={data.assets} currency={data.currency} />
        <Section section={data.liabilities} currency={data.currency} />
        <Section section={data.equity} currency={data.currency} />

        <SectionCard>
          <View style={styles.accountRow}>
            <Text style={[styles.sectionTotalLabel, { color: colors.text }]}>
              Liabilities + equity
            </Text>
            <Text style={[styles.sectionTotalValue, { color: colors.text }]}>
              {formatCurrency(data.totalLiabilitiesAndEquity, data.currency)}
            </Text>
          </View>
        </SectionCard>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 8 },
  hero: { marginHorizontal: 12, padding: 20, alignItems: 'center' },
  heroLabel: { fontSize: 13, fontWeight: '500' },
  heroValue: { fontSize: 32, fontWeight: '700', marginTop: 4, letterSpacing: -0.8 },
  banner: { marginHorizontal: 12, marginTop: 8 },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: 16,
  },
  accountText: { flex: 1, minWidth: 0 },
  accountName: { fontSize: 14, fontWeight: '500' },
  accountCode: { fontSize: 12, marginTop: 1 },
  accountBalance: { fontSize: 14, fontWeight: '500' },
  sectionDivider: { marginVertical: 8 },
  sectionTotalLabel: { fontSize: 14, fontWeight: '700' },
  sectionTotalValue: { fontSize: 16, fontWeight: '700' },
});
