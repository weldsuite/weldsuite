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
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { VatStatusBadge } from '@/components/status-badge';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { VatReturn } from '@/types/accounting';

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

export default function VatReturnsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format } = useI18n();
  const { formatCurrency } = useLocaleFormatters();

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
      title={t.vat.title}
      showBack
      below={
        <View style={styles.chips}>
          <Chip label={t.vat.allYears} selected={year === null} onPress={() => setYear(null)} />
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
        <ErrorState message={t.vat.loadError} onRetry={load} />
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
            subtitle={format(t.vat.outputInput, {
              output: formatCurrency(item.salesTax, item.currency),
              input: formatCurrency(item.purchaseTax, item.currency),
            })}
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
            title={t.vat.emptyTitle}
            description={
              year ? format(t.vat.emptyYear, { year }) : t.vat.emptyAll
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
