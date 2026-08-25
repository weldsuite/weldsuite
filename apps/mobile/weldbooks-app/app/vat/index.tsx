/**
 * VAT returns.
 *
 * app-api's list takes no filters, so the year/status narrowing happens
 * client-side (in the API adapter) over the full set.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FileCheck } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';

import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { VatStatusBadge } from '@/components/status-badge';
import type { VatReturn } from '@/types/accounting';

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

export default function VatReturnsScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [returns, setReturns] = useState<VatReturn[]>([]);
  const [year, setYear] = useState<number | null>(CURRENT_YEAR);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(false);
      setReturns(await api.getVatReturns(year ? { year } : undefined));
    } catch (err) {
      console.error('Failed to load VAT returns:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [year]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // A return filed on the detail screen should show its new status on return.
  useFocusEffect(useCallback(() => void load(), [load]));

  const header = (
    <ScreenHeader
      title="VAT returns"
      showBack
      below={
        <View style={styles.chips}>
          <Chip label="All years" selected={year === null} onPress={() => setYear(null)} />
          {YEARS.map((y) => (
            <Chip key={y} label={String(y)} selected={year === y} onPress={() => setYear(y)} />
          ))}
        </View>
      }
    />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <ListSkeleton count={4} />
      </Screen>
    );
  }

  if (error && returns.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message="Couldn't load VAT returns." onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={returns}
        keyExtractor={(item) => item.id}
        contentContainerStyle={returns.length ? styles.list : styles.listEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={ACCENTS.vat}
          />
        }
        renderItem={({ item }) => (
          <RecordRow
            leading={<IconTile icon={FileCheck} color={ACCENTS.vat} />}
            title={item.period || String(item.year)}
            subtitle={`Output ${formatCurrency(item.salesTax, item.currency)} · Input ${formatCurrency(item.purchaseTax, item.currency)}`}
            amount={formatCurrency(item.netAmount, item.currency)}
            amountColor={item.netAmount < 0 ? colors.success : undefined}
            badge={<VatStatusBadge status={item.status} />}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push(`/vat/${item.id}` as never);
            }}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={<FileCheck size={32} color={colors.mutedForeground} />}
            title="No VAT returns"
            description={
              year
                ? `No returns for ${year}. Try another year.`
                : 'Returns appear here once a VAT period closes.'
            }
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 4 },
  list: { paddingBottom: 8 },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
});
