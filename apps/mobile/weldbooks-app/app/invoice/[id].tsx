/**
 * Invoice detail.
 *
 * Actions map onto app-api's dedicated endpoints. Note what is deliberately
 * absent: there is no edit. app-api has no `PUT /invoices/:id` because an issued
 * document is immutable — a draft can be deleted and re-created, and an issued
 * invoice is corrected with a credit note.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { MoreHorizontal, FileText, Send, CreditCard, Lock } from 'lucide-react-native';

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
import { InvoiceStatusBadge } from '@/components/status-badge';
import { RecordPaymentSheet } from '@/components/record-payment-sheet';
import type { Invoice } from '@/types/accounting';

type Confirm = 'delete' | 'cancel' | 'creditNote' | null;

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { t, format, plural } = useI18n();
  const { formatCurrency, formatDate } = useLocaleFormatters();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
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
      setInvoice(await api.getInvoice(id));
    } catch (err) {
      console.error('Failed to load invoice:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /** Runs a mutation, then refreshes so derived fields (balance, status) are current. */
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

  const handleMore = useCallback(() => {
    if (!invoice) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const options: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] = [
      {
        text: t.invoiceDetail.duplicate,
        onPress: () =>
          run(async () => {
            const copy = await api.duplicateInvoice(invoice.id);
            router.replace(`/invoice/${copy.id}`);
          }, t.invoiceDetail.duplicated),
      },
    ];

    if (invoice.status !== 'draft' && invoice.status !== 'cancelled') {
      options.push({ text: t.invoiceDetail.createCreditNote, onPress: () => setConfirm('creditNote') });
      options.push({ text: t.invoiceDetail.cancelInvoice, style: 'destructive', onPress: () => setConfirm('cancel') });
    }
    if (invoice.status === 'draft') {
      options.push({ text: t.invoiceDetail.deleteDraft, style: 'destructive', onPress: () => setConfirm('delete') });
    }
    options.push({ text: t.common.dismiss, style: 'cancel' });

    Alert.alert(t.invoiceDetail.actionsTitle, undefined, options);
  }, [invoice, run, router, t]);

  const header = (
    <ScreenHeader
      title={invoice?.invoiceNumber || t.invoiceDetail.title}
      subtitle={invoice?.contactName}
      showBack
      actions={
        invoice ? (
          <>
            <IconButton
              icon={<FileText size={20} color={colors.text} />}
              accessibilityLabel={t.invoiceDetail.viewDocument}
              onPress={() => router.push(`/invoice/document?id=${invoice.id}` as never)}
            />
            <IconButton
              icon={<MoreHorizontal size={22} color={colors.text} />}
              accessibilityLabel={t.invoiceDetail.moreActions}
              onPress={handleMore}
            />
          </>
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

  if (error || !invoice) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.invoiceDetail.loadError}
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  const currency = invoice.currency || 'EUR';
  const balanceDue = toNumber(invoice.balanceDue);
  const amountPaid = toNumber(invoice.amountPaid);
  const due = daysUntil(invoice.dueDate);
  const isSettled =
    invoice.status === 'paid' || invoice.status === 'cancelled' || invoice.status === 'uncollectible';

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
                {balanceDue > 0 ? t.invoiceDetail.balanceDue : t.invoiceDetail.total}
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {formatCurrency(balanceDue > 0 ? balanceDue : invoice.total, currency)}
              </Text>
            </View>
            <InvoiceStatusBadge
              status={invoice.status}
              dueDate={invoice.dueDate}
              balanceDue={invoice.balanceDue}
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
                ? plural(Math.abs(due), t.invoiceDetail.overdueBy)
                : due === 0
                  ? t.invoiceDetail.dueToday
                  : plural(due, t.invoiceDetail.dueIn)}
            </Text>
          ) : null}
        </SectionCard>

        <SectionCard title={t.invoiceDetail.details}>
          <DetailRow label={t.invoiceDetail.customer} value={invoice.contactName} />
          {invoice.contactEmail ? <DetailRow label={t.invoiceDetail.email} value={invoice.contactEmail} /> : null}
          <DetailRow label={t.invoiceDetail.issueDate} value={formatDate(invoice.issueDate)} />
          <DetailRow label={t.invoiceDetail.dueDate} value={formatDate(invoice.dueDate)} />
          {invoice.reference ? <DetailRow label={t.invoiceDetail.reference} value={invoice.reference} /> : null}
        </SectionCard>

        {invoice.items?.length ? (
          <SectionCard title={t.invoiceDetail.lineItems}>
            {invoice.items.map((item, index) => (
              <View key={item.id ?? index}>
                {index > 0 ? <Divider style={styles.itemDivider} /> : null}
                <Text style={[styles.itemDescription, { color: colors.text }]}>
                  {item.description}
                </Text>
                <View style={styles.itemMeta}>
                  <Text style={[styles.itemQty, { color: colors.mutedForeground }]}>
                    {toNumber(item.quantity)} × {formatCurrency(item.unitPrice, currency)}
                    {toNumber(item.taxRate) > 0
                      ? `  ·  ${format(t.invoiceDetail.vatRate, { rate: toNumber(item.taxRate) })}`
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

        <SectionCard title={t.invoiceDetail.totals}>
          <TotalsBlock
            rows={[
              { label: t.invoiceDetail.subtotal, value: formatCurrency(invoice.subtotal, currency) },
              { label: t.invoiceDetail.vat, value: formatCurrency(invoice.taxTotal, currency) },
              ...(amountPaid > 0
                ? [{ label: t.invoiceDetail.paid, value: `−${formatCurrency(amountPaid, currency)}` }]
                : []),
            ]}
            total={{
              label: balanceDue > 0 && amountPaid > 0 ? t.invoiceDetail.balanceDue : t.invoiceDetail.total,
              value: formatCurrency(balanceDue > 0 && amountPaid > 0 ? balanceDue : invoice.total, currency),
            }}
          />
        </SectionCard>

        {invoice.notes ? (
          <SectionCard title={t.invoiceDetail.notes}>
            <Text style={[styles.notes, { color: colors.mutedForeground }]}>{invoice.notes}</Text>
          </SectionCard>
        ) : null}

        <View style={styles.actions}>
          {invoice.status === 'draft' ? (
            <Button
              title={t.invoiceDetail.finalise}
              leftIcon={<Lock size={18} color={colors.primaryForeground} />}
              onPress={() => run(() => api.finalizeInvoice(invoice.id), t.invoiceDetail.finalised)}
              loading={busy}
              fullWidth
            />
          ) : null}

          {invoice.status !== 'draft' && !isSettled ? (
            <Button
              title={t.invoiceDetail.send}
              variant="outline"
              leftIcon={<Send size={18} color={colors.text} />}
              onPress={() => run(() => api.sendInvoice(invoice.id), t.invoiceDetail.sent)}
              loading={busy}
              fullWidth
            />
          ) : null}

          {balanceDue > 0 && invoice.status !== 'draft' && invoice.status !== 'cancelled' ? (
            <Button
              title={t.invoiceDetail.recordPayment}
              leftIcon={<CreditCard size={18} color={colors.primaryForeground} />}
              onPress={() => setPaymentOpen(true)}
              disabled={busy}
              fullWidth
            />
          ) : null}

          <Button
            title={t.invoiceDetail.viewDocument}
            variant="ghost"
            leftIcon={<FileText size={18} color={colors.text} />}
            onPress={() => router.push(`/invoice/document?id=${invoice.id}` as never)}
            fullWidth
          />
        </View>
      </ScrollView>

      <RecordPaymentSheet
        visible={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        balanceDue={balanceDue}
        currency={currency}
        submitting={busy}
        onSubmit={async (payment) => {
          await run(
            () => api.recordInvoicePayment(invoice.id, payment),
            t.invoiceDetail.paymentRecorded,
          );
          setPaymentOpen(false);
        }}
      />

      <ConfirmModal
        visible={confirm === 'delete'}
        title={t.invoiceDetail.deleteTitle}
        message={t.invoiceDetail.deleteMessage}
        confirmText={t.common.delete}
        variant="destructive"
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          setBusy(true);
          try {
            await api.deleteInvoice(invoice.id);
            toast.success(t.invoiceDetail.deleted);
            router.back();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.invoiceDetail.deleteFailed);
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmModal
        visible={confirm === 'cancel'}
        title={t.invoiceDetail.cancelTitle}
        message={t.invoiceDetail.cancelMessage}
        confirmText={t.invoiceDetail.cancelInvoice}
        cancelText={t.common.keep}
        variant="destructive"
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          run(() => api.setInvoiceStatus(invoice.id, 'cancelled'), t.invoiceDetail.cancelled);
        }}
      />

      <ConfirmModal
        visible={confirm === 'creditNote'}
        title={t.invoiceDetail.creditNoteTitle}
        message={t.invoiceDetail.creditNoteMessage}
        confirmText={t.common.create}
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          run(async () => {
            const note = await api.createCreditNote(invoice.id);
            router.replace(`/invoice/${note.id}`);
          }, t.invoiceDetail.creditNoteCreated);
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
