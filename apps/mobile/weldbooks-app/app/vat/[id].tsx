/**
 * VAT return detail.
 *
 * Filing is a real submission (SBR/XBRL via Digipoort on app-api), not a status
 * flip — hence the deliberate confirmation copy about it being irreversible.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Send } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { formatDate } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow, TotalsBlock } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { VatStatusBadge } from '@/components/status-badge';
import type { VatReturnDetail } from '@/types/accounting';

/** The rubrieken worth showing on a phone, in Belastingdienst order. */
const RUBRIEKEN: { key: string; label: string }[] = [
  { key: 'r1a', label: '1a — Supplies at the high rate' },
  { key: 'r1b', label: '1b — Supplies at the low rate' },
  { key: 'r2a', label: '2a — Reverse charge to you' },
  { key: 'r3a', label: '3a — Supplies to non-EU' },
  { key: 'r3b', label: '3b — Supplies to EU' },
  { key: 'r4a', label: '4a — Acquisitions from non-EU' },
  { key: 'r4b', label: '4b — Acquisitions from EU' },
];

export default function VatReturnDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const toast = useToast();

  const [vatReturn, setVatReturn] = useState<VatReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [confirmFile, setConfirmFile] = useState(false);
  const [filing, setFiling] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(false);
      setVatReturn(await api.getVatReturn(id));
    } catch (err) {
      console.error('Failed to load VAT return:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const header = (
    <ScreenHeader title={vatReturn?.period || 'VAT return'} showBack />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (error || !vatReturn) {
    return (
      <Screen header={header}>
        <ErrorState
          message="Couldn't load this VAT return."
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  const { currency, netAmount } = vatReturn;
  const payable = netAmount >= 0;
  const rubriekRows = RUBRIEKEN.filter((r) => vatReturn.rubrieken[r.key] != null);

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
            tintColor={ACCENTS.vat}
          />
        }
      >
        <SectionCard>
          <View style={styles.summary}>
            <View>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                {payable ? 'To pay' : 'To reclaim'}
              </Text>
              <Text
                style={[styles.summaryValue, { color: payable ? colors.text : colors.success }]}
              >
                {formatCurrency(Math.abs(netAmount), currency)}
              </Text>
            </View>
            <VatStatusBadge status={vatReturn.status} size="md" />
          </View>
        </SectionCard>

        {vatReturn.status === 'submitted' || vatReturn.status === 'accepted' ? (
          <Banner variant="success" style={styles.banner}>
            Filed{vatReturn.filedAt ? ` on ${formatDate(vatReturn.filedAt)}` : ''}.
          </Banner>
        ) : null}

        <SectionCard title="Period">
          <DetailRow label="Period" value={vatReturn.period || '—'} />
          {vatReturn.periodStart ? (
            <DetailRow label="From" value={formatDate(vatReturn.periodStart)} />
          ) : null}
          {vatReturn.periodEnd ? (
            <DetailRow label="To" value={formatDate(vatReturn.periodEnd)} />
          ) : null}
          {vatReturn.dueDate ? (
            <DetailRow label="Filing deadline" value={formatDate(vatReturn.dueDate)} />
          ) : null}
        </SectionCard>

        <SectionCard title="Summary">
          <TotalsBlock
            rows={[
              { label: 'Output VAT (5a)', value: formatCurrency(vatReturn.salesTax, currency) },
              { label: 'Input VAT (5b)', value: formatCurrency(vatReturn.purchaseTax, currency) },
            ]}
            total={{
              label: payable ? 'Payable (5c)' : 'Reclaimable (5c)',
              value: formatCurrency(Math.abs(netAmount), currency),
            }}
          />
        </SectionCard>

        {rubriekRows.length ? (
          <SectionCard title="Rubrieken">
            {rubriekRows.map((r) => (
              <DetailRow
                key={r.key}
                label={r.label}
                value={formatCurrency(Number(vatReturn.rubrieken[r.key] ?? 0), currency)}
              />
            ))}
          </SectionCard>
        ) : null}

        {vatReturn.status === 'draft' ? (
          <View style={styles.actions}>
            <Button
              title="File return"
              leftIcon={<Send size={18} color={colors.primaryForeground} />}
              onPress={() => setConfirmFile(true)}
              loading={filing}
              fullWidth
            />
          </View>
        ) : null}
      </ScrollView>

      <ConfirmModal
        visible={confirmFile}
        title="File this VAT return?"
        message="This submits the return to the tax authority. It cannot be undone from the app."
        confirmText="File return"
        loading={filing}
        onCancel={() => setConfirmFile(false)}
        onConfirm={async () => {
          setConfirmFile(false);
          setFiling(true);
          try {
            await api.submitVatReturn(vatReturn.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            toast.success('VAT return filed');
            await load();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not file the return');
          } finally {
            setFiling(false);
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  summary: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  summaryLabel: { fontSize: 13, fontWeight: '500' },
  summaryValue: { fontSize: 30, fontWeight: '700', marginTop: 2, letterSpacing: -0.8 },
  banner: { marginHorizontal: 12, marginTop: 8 },
  actions: { padding: 12, paddingTop: 20 },
});
