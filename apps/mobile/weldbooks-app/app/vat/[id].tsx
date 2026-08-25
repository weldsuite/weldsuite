/**
 * VAT return detail.
 *
 * Filing is a real submission (SBR/XBRL via Digipoort on app-api), not a status
 * flip — hence the deliberate confirmation copy about it being irreversible.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow, TotalsBlock } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { VatStatusBadge } from '@/components/status-badge';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { VatReturnDetail } from '@/types/accounting';

export default function VatReturnDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const toast = useToast();
  const { t, format } = useI18n();
  const { formatCurrency, formatDate } = useLocaleFormatters();

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

  /** The rubrieken worth showing on a phone, in Belastingdienst order. */
  const RUBRIEKEN = useMemo(
    () => [
      { key: 'r1a', label: t.vatDetail.r1a },
      { key: 'r1b', label: t.vatDetail.r1b },
      { key: 'r2a', label: t.vatDetail.r2a },
      { key: 'r3a', label: t.vatDetail.r3a },
      { key: 'r3b', label: t.vatDetail.r3b },
      { key: 'r4a', label: t.vatDetail.r4a },
      { key: 'r4b', label: t.vatDetail.r4b },
    ],
    [t],
  );

  const header = (
    <ScreenHeader title={vatReturn?.period || t.vatDetail.title} showBack />
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
          message={t.vatDetail.loadError}
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
                {payable ? t.vatDetail.toPay : t.vatDetail.toReclaim}
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
            {vatReturn.filedAt
              ? format(t.vatDetail.filedOn, { date: formatDate(vatReturn.filedAt) })
              : t.vatDetail.filed}
          </Banner>
        ) : null}

        <SectionCard title={t.vatDetail.period}>
          <DetailRow label={t.vatDetail.period} value={vatReturn.period || t.common.dash} />
          {vatReturn.periodStart ? (
            <DetailRow label={t.vatDetail.from} value={formatDate(vatReturn.periodStart)} />
          ) : null}
          {vatReturn.periodEnd ? (
            <DetailRow label={t.vatDetail.to} value={formatDate(vatReturn.periodEnd)} />
          ) : null}
          {vatReturn.dueDate ? (
            <DetailRow label={t.vatDetail.filingDeadline} value={formatDate(vatReturn.dueDate)} />
          ) : null}
        </SectionCard>

        <SectionCard title={t.vatDetail.summary}>
          <TotalsBlock
            rows={[
              { label: t.vatDetail.outputVat, value: formatCurrency(vatReturn.salesTax, currency) },
              { label: t.vatDetail.inputVat, value: formatCurrency(vatReturn.purchaseTax, currency) },
            ]}
            total={{
              label: payable ? t.vatDetail.payable : t.vatDetail.reclaimable,
              value: formatCurrency(Math.abs(netAmount), currency),
            }}
          />
        </SectionCard>

        {rubriekRows.length ? (
          <SectionCard title={t.vatDetail.rubrieken}>
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
              title={t.vatDetail.fileReturn}
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
        title={t.vatDetail.fileTitle}
        message={t.vatDetail.fileMessage}
        confirmText={t.vatDetail.fileReturn}
        cancelText={t.common.cancel}
        loading={filing}
        onCancel={() => setConfirmFile(false)}
        onConfirm={async () => {
          setConfirmFile(false);
          setFiling(true);
          try {
            await api.submitVatReturn(vatReturn.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            toast.success(t.vatDetail.filedSuccess);
            await load();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.vatDetail.fileFailed);
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
