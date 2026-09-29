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
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import api from '@/services/api';
import { toNumber } from '@/lib/currency';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import {
  DocumentLineItems,
  DocumentSummaryCard,
  DocumentTotalsCard,
  documentCurrency,
  useDocumentMutations,
} from '@/components/document-detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { InvoiceStatusBadge } from '@/components/status-badge';
import { RecordPaymentSheet } from '@/components/record-payment-sheet';
import type { Invoice } from '@/types/accounting';

type Confirm = 'delete' | 'cancel' | 'creditNote' | null;

type MoreOption = { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void };

function isSettled(status: Invoice['status']): boolean {
  return status === 'paid' || status === 'cancelled' || status === 'uncollectible';
}

/** An issued invoice can be credited or cancelled; only a draft can be deleted. */
function statusOptions(
  status: Invoice['status'],
  t: Translations,
  setConfirm: (confirm: Confirm) => void,
): MoreOption[] {
  if (status === 'draft') {
    return [{ text: t.invoiceDetail.deleteDraft, style: 'destructive', onPress: () => setConfirm('delete') }];
  }
  if (status === 'cancelled') return [];
  return [
    { text: t.invoiceDetail.createCreditNote, onPress: () => setConfirm('creditNote') },
    { text: t.invoiceDetail.cancelInvoice, style: 'destructive', onPress: () => setConfirm('cancel') },
  ];
}

function InvoiceActions({
  invoice,
  balanceDue,
  busy,
  onFinalise,
  onSend,
  onPay,
  onViewDocument,
}: Readonly<{
  invoice: Invoice;
  balanceDue: number;
  busy: boolean;
  onFinalise: () => void;
  onSend: () => void;
  onPay: () => void;
  onViewDocument: () => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const isDraft = invoice.status === 'draft';
  const canSend = !isDraft && !isSettled(invoice.status);
  const canPay = balanceDue > 0 && !isDraft && invoice.status !== 'cancelled';

  return (
    <View style={styles.actions}>
      {isDraft ? (
        <Button
          title={t.invoiceDetail.finalise}
          leftIcon={<Lock size={18} color={colors.primaryForeground} />}
          onPress={onFinalise}
          loading={busy}
          fullWidth
        />
      ) : null}

      {canSend ? (
        <Button
          title={t.invoiceDetail.send}
          variant="outline"
          leftIcon={<Send size={18} color={colors.text} />}
          onPress={onSend}
          loading={busy}
          fullWidth
        />
      ) : null}

      {canPay ? (
        <Button
          title={t.invoiceDetail.recordPayment}
          leftIcon={<CreditCard size={18} color={colors.primaryForeground} />}
          onPress={onPay}
          disabled={busy}
          fullWidth
        />
      ) : null}

      <Button
        title={t.invoiceDetail.viewDocument}
        variant="ghost"
        leftIcon={<FileText size={18} color={colors.text} />}
        onPress={onViewDocument}
        fullWidth
      />
    </View>
  );
}

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const { t } = useI18n();
  const { formatDate } = useLocaleFormatters();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
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

  /** `run` refreshes after each mutation so derived fields (balance, status) are current. */
  const { busy, run, remove } = useDocumentMutations(load);

  const handleMore = useCallback(() => {
    if (!invoice) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const options: MoreOption[] = [
      {
        text: t.invoiceDetail.duplicate,
        onPress: () =>
          run(async () => {
            const copy = await api.duplicateInvoice(invoice.id);
            router.replace(`/invoice/${copy.id}`);
          }, t.invoiceDetail.duplicated),
      },
      ...statusOptions(invoice.status, t, setConfirm),
      { text: t.common.dismiss, style: 'cancel' },
    ];

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

  const currency = documentCurrency(invoice);
  const balanceDue = toNumber(invoice.balanceDue);

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
        <DocumentSummaryCard
          doc={invoice}
          labels={t.invoiceDetail}
          badge={
            <InvoiceStatusBadge
              status={invoice.status}
              dueDate={invoice.dueDate}
              balanceDue={invoice.balanceDue}
              size="md"
            />
          }
        />

        <SectionCard title={t.invoiceDetail.details}>
          <DetailRow label={t.invoiceDetail.customer} value={invoice.contactName} />
          {invoice.contactEmail ? <DetailRow label={t.invoiceDetail.email} value={invoice.contactEmail} /> : null}
          <DetailRow label={t.invoiceDetail.issueDate} value={formatDate(invoice.issueDate)} />
          <DetailRow label={t.invoiceDetail.dueDate} value={formatDate(invoice.dueDate)} />
          {invoice.reference ? <DetailRow label={t.invoiceDetail.reference} value={invoice.reference} /> : null}
        </SectionCard>

        <DocumentLineItems
          items={invoice.items}
          currency={currency}
          title={t.invoiceDetail.lineItems}
          vatRateLabel={t.invoiceDetail.vatRate}
        />

        <DocumentTotalsCard doc={invoice} labels={t.invoiceDetail} />

        {invoice.notes ? (
          <SectionCard title={t.invoiceDetail.notes}>
            <Text style={[styles.notes, { color: colors.mutedForeground }]}>{invoice.notes}</Text>
          </SectionCard>
        ) : null}

        <InvoiceActions
          invoice={invoice}
          balanceDue={balanceDue}
          busy={busy}
          onFinalise={() => run(() => api.finalizeInvoice(invoice.id), t.invoiceDetail.finalised)}
          onSend={() => run(() => api.sendInvoice(invoice.id), t.invoiceDetail.sent)}
          onPay={() => setPaymentOpen(true)}
          onViewDocument={() => router.push(`/invoice/document?id=${invoice.id}` as never)}
        />
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
        onConfirm={() => {
          setConfirm(null);
          remove(() => api.deleteInvoice(invoice.id), t.invoiceDetail.deleted, t.invoiceDetail.deleteFailed);
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
  notes: { fontSize: 14, lineHeight: 20 },
  actions: { padding: 12, paddingTop: 20, gap: 8 },
});
