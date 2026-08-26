/**
 * Bill detail.
 *
 * Approve / reject are dedicated app-api endpoints; settling a bill is a
 * payment (`POST /api/payments` with `type: 'sent'`), not a status flip, so
 * partial payments are supported the same way invoices support them.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, X, CreditCard, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import api from '@/services/api';
import { toNumber } from '@/lib/currency';
import { daysUntil } from '@/lib/date';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow, TotalsBlock } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { BillStatusBadge } from '@/components/status-badge';
import { RecordPaymentSheet } from '@/components/record-payment-sheet';
import type { Bill } from '@/types/accounting';

type Confirm = 'reject' | 'delete' | null;

export default function BillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { t, format, plural } = useI18n();
  const { formatCurrency, formatDate } = useLocaleFormatters();

  const [bill, setBill] = useState<Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(false);
      setBill(await api.getBill(id));
    } catch (err) {
      console.error('Failed to load bill:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await action();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success(successMessage);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t.common.actionFailed);
      } finally {
        setBusy(false);
      }
    },
    [load, toast, t],
  );

  const header = (
    <ScreenHeader
      title={bill?.billNumber || t.billDetail.title}
      subtitle={bill?.contactName}
      showBack
      actions={
        bill?.status === 'draft' || bill?.status === 'pending' ? (
          <IconButton
            icon={<Trash2 size={20} color={colors.destructive} />}
            accessibilityLabel={t.billDetail.deleteBill}
            onPress={() => setConfirm('delete')}
          />
        ) : null
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

  if (error || !bill) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.billDetail.loadError}
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  const currency = bill.currency || 'EUR';
  const balanceDue = toNumber(bill.balanceDue);
  const amountPaid = toNumber(bill.amountPaid);
  const due = daysUntil(bill.dueDate);
  const canApprove = bill.status === 'draft' || bill.status === 'pending';
  const canPay = balanceDue > 0 && (bill.status === 'approved' || bill.status === 'partially_paid');

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
            tintColor={BRAND}
          />
        }
      >
        <SectionCard>
          <View style={styles.summary}>
            <View>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                {balanceDue > 0 ? t.billDetail.balanceDue : t.billDetail.total}
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {formatCurrency(balanceDue > 0 ? balanceDue : bill.total, currency)}
              </Text>
            </View>
            <BillStatusBadge
              status={bill.status}
              dueDate={bill.dueDate}
              balanceDue={bill.balanceDue}
              size="md"
            />
          </View>
          {balanceDue > 0 && due !== null ? (
            <Text
              style={[
                styles.dueHint,
                { color: due < 0 ? colors.destructive : colors.mutedForeground },
              ]}
            >
              {due < 0
                ? plural(Math.abs(due), t.billDetail.overdueBy)
                : due === 0
                  ? t.billDetail.dueToday
                  : plural(due, t.billDetail.dueIn)}
            </Text>
          ) : null}
        </SectionCard>

        <SectionCard title={t.billDetail.details}>
          <DetailRow label={t.billDetail.vendor} value={bill.contactName} />
          <DetailRow label={t.billDetail.issueDate} value={formatDate(bill.issueDate)} />
          <DetailRow label={t.billDetail.dueDate} value={formatDate(bill.dueDate)} />
          {bill.reference ? <DetailRow label={t.billDetail.reference} value={bill.reference} /> : null}
        </SectionCard>

        {bill.items?.length ? (
          <SectionCard title={t.billDetail.lineItems}>
            {bill.items.map((item, index) => (
              <View key={item.id ?? index}>
                {index > 0 ? <Divider style={styles.itemDivider} /> : null}
                <Text style={[styles.itemDescription, { color: colors.text }]}>
                  {item.description}
                </Text>
                <View style={styles.itemMeta}>
                  <Text style={[styles.itemQty, { color: colors.mutedForeground }]}>
                    {toNumber(item.quantity)} × {formatCurrency(item.unitPrice, currency)}
                    {toNumber(item.taxRate) > 0
                      ? `  ·  ${format(t.billDetail.vatRate, { rate: toNumber(item.taxRate) })}`
                      : ''}
                  </Text>
                  <Text style={[styles.itemTotal, { color: colors.text }]}>
                    {formatCurrency(item.lineTotal, currency)}
                  </Text>
                </View>
              </View>
            ))}
          </SectionCard>
        ) : null}

        <SectionCard title={t.billDetail.totals}>
          <TotalsBlock
            rows={[
              { label: t.billDetail.subtotal, value: formatCurrency(bill.subtotal, currency) },
              { label: t.billDetail.vat, value: formatCurrency(bill.taxTotal, currency) },
              ...(amountPaid > 0
                ? [{ label: t.billDetail.paid, value: `−${formatCurrency(amountPaid, currency)}` }]
                : []),
            ]}
            total={{
              label: balanceDue > 0 && amountPaid > 0 ? t.billDetail.balanceDue : t.billDetail.total,
              value: formatCurrency(balanceDue > 0 && amountPaid > 0 ? balanceDue : bill.total, currency),
            }}
          />
        </SectionCard>

        {bill.notes ? (
          <SectionCard title={t.billDetail.notes}>
            <Text style={[styles.notes, { color: colors.mutedForeground }]}>{bill.notes}</Text>
          </SectionCard>
        ) : null}

        <View style={styles.actions}>
          {canApprove ? (
            <>
              <Button
                title={t.billDetail.approve}
                leftIcon={<Check size={18} color={colors.primaryForeground} />}
                onPress={() => run(() => api.approveBill(bill.id), t.billDetail.approved)}
                loading={busy}
                fullWidth
              />
              <Button
                title={t.billDetail.reject}
                variant="outline"
                leftIcon={<X size={18} color={colors.destructive} />}
                onPress={() => setConfirm('reject')}
                disabled={busy}
                fullWidth
              />
            </>
          ) : null}

          {canPay ? (
            <Button
              title={t.billDetail.recordPayment}
              leftIcon={<CreditCard size={18} color={colors.primaryForeground} />}
              onPress={() => setPaymentOpen(true)}
              disabled={busy}
              fullWidth
            />
          ) : null}
        </View>
      </ScrollView>

      <RecordPaymentSheet
        visible={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        balanceDue={balanceDue}
        currency={currency}
        submitting={busy}
        onSubmit={async (payment) => {
          await run(() => api.recordBillPayment(bill.id, payment), t.billDetail.paymentRecorded);
          setPaymentOpen(false);
        }}
      />

      <ConfirmModal
        visible={confirm === 'reject'}
        title={t.billDetail.rejectTitle}
        message={t.billDetail.rejectMessage}
        confirmText={t.billDetail.reject}
        variant="destructive"
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          run(() => api.rejectBill(bill.id), t.billDetail.rejected);
        }}
      />

      <ConfirmModal
        visible={confirm === 'delete'}
        title={t.billDetail.deleteTitle}
        message={t.billDetail.deleteMessage}
        confirmText={t.common.delete}
        variant="destructive"
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          setBusy(true);
          try {
            await api.deleteBill(bill.id);
            toast.success(t.billDetail.deleted);
            router.back();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.billDetail.deleteFailed);
          } finally {
            setBusy(false);
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
  dueHint: { fontSize: 13, marginTop: 8 },
  itemDivider: { marginVertical: 12 },
  itemDescription: { fontSize: 14, fontWeight: '500' },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: 12,
  },
  itemQty: { fontSize: 13, flexShrink: 1 },
  itemTotal: { fontSize: 14, fontWeight: '600' },
  notes: { fontSize: 14, lineHeight: 20 },
  actions: { padding: 12, paddingTop: 20, gap: 8 },
});
