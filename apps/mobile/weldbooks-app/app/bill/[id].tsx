/**
 * Bill detail.
 *
 * Approve / reject are dedicated app-api endpoints; settling a bill is a
 * payment (`POST /api/payments` with `type: 'sent'`), not a status flip, so
 * partial payments are supported the same way invoices support them.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Check, X, CreditCard, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import api from '@/services/api';
import { toNumber } from '@/lib/currency';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { accruedUseTaxTotal } from '@/lib/sales-tax';
import { addressLines } from '@/lib/us';
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
import { BillStatusBadge } from '@/components/status-badge';
import { RecordPaymentSheet } from '@/components/record-payment-sheet';
import { TaxBreakdownCard } from '@/components/tax-breakdown';
import type { Bill } from '@/types/accounting';

type Confirm = 'reject' | 'delete' | null;

/** Draft and pending bills can still be approved, rejected or deleted. */
function isAwaitingApproval(status: Bill['status'] | undefined): boolean {
  return status === 'draft' || status === 'pending';
}

function isPayable(bill: Bill, balanceDue: number): boolean {
  return balanceDue > 0 && (bill.status === 'approved' || bill.status === 'partially_paid');
}

function BillActions({
  canApprove,
  canPay,
  busy,
  onApprove,
  onReject,
  onPay,
}: Readonly<{
  canApprove: boolean;
  canPay: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onPay: () => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <View style={styles.actions}>
      {canApprove ? (
        <>
          <Button
            title={t.billDetail.approve}
            leftIcon={<Check size={18} color={colors.primaryForeground} />}
            onPress={onApprove}
            loading={busy}
            fullWidth
          />
          <Button
            title={t.billDetail.reject}
            variant="outline"
            leftIcon={<X size={18} color={colors.destructive} />}
            onPress={onReject}
            disabled={busy}
            fullWidth
          />
        </>
      ) : null}

      {canPay ? (
        <Button
          title={t.billDetail.recordPayment}
          leftIcon={<CreditCard size={18} color={colors.primaryForeground} />}
          onPress={onPay}
          disabled={busy}
          fullWidth
        />
      ) : null}
    </View>
  );
}

export default function BillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { formatDate, formatCurrency, currency: entityCurrency } = useLocaleFormatters();
  const { isUs, labels, terms } = useJurisdiction();

  const [bill, setBill] = useState<Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
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

  const { busy, run, remove } = useDocumentMutations(load);

  const header = (
    <ScreenHeader
      title={bill?.billNumber || t.billDetail.title}
      subtitle={bill?.contactName}
      showBack
      actions={
        isAwaitingApproval(bill?.status) ? (
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

  const currency = documentCurrency(bill, entityCurrency);
  const balanceDue = toNumber(bill.balanceDue);
  // US: the vendor's tax is part of the cost; use tax accrued on lines it charged none on is owed to the state.
  const useTax = isUs ? accruedUseTaxTotal(bill.taxBreakdown) : 0;
  const deliveredTo = isUs ? addressLines(bill.deliveryAddress) : [];

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
          doc={bill}
          labels={t.billDetail}
          badge={
            <BillStatusBadge
              status={bill.status}
              dueDate={bill.dueDate}
              balanceDue={bill.balanceDue}
              size="md"
            />
          }
        />

        <SectionCard title={t.billDetail.details}>
          <DetailRow label={labels.supplier} value={bill.contactName} />
          <DetailRow label={t.billDetail.issueDate} value={formatDate(bill.issueDate)} />
          <DetailRow label={t.billDetail.dueDate} value={formatDate(bill.dueDate)} />
          {bill.reference ? <DetailRow label={t.billDetail.reference} value={bill.reference} /> : null}
          {deliveredTo.length > 0 ? (
            <DetailRow label={t.billDetail.deliveredTo} value={deliveredTo.join('\n')} />
          ) : null}
        </SectionCard>

        <DocumentLineItems
          items={bill.items}
          currency={currency}
          title={t.billDetail.lineItems}
          kind="bill"
        />

        <DocumentTotalsCard
          doc={bill}
          labels={t.billDetail}
          taxLabel={isUs ? format(t.billDetail.taxPaid, terms) : labels.tax}
          extraRows={useTax > 0 ? [{ label: t.salesTax.useTaxAccrued, value: formatCurrency(useTax, currency) }] : []}
        />

        {useTax > 0 ? (
          <TaxBreakdownCard
            rows={bill.taxBreakdown}
            currency={currency}
            title={t.salesTax.useTaxAccrued}
            footnote={format(t.billDetail.useTaxHint, terms)}
          />
        ) : null}

        {bill.notes ? (
          <SectionCard title={t.billDetail.notes}>
            <Text style={[styles.notes, { color: colors.mutedForeground }]}>{bill.notes}</Text>
          </SectionCard>
        ) : null}

        <BillActions
          canApprove={isAwaitingApproval(bill.status)}
          canPay={isPayable(bill, balanceDue)}
          busy={busy}
          onApprove={() => run(() => api.approveBill(bill.id), t.billDetail.approved)}
          onReject={() => setConfirm('reject')}
          onPay={() => setPaymentOpen(true)}
        />
      </ScrollView>

      <RecordPaymentSheet
        visible={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        balanceDue={balanceDue}
        currency={currency}
        direction="sent"
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
        onConfirm={() => {
          setConfirm(null);
          remove(() => api.deleteBill(bill.id), t.billDetail.deleted, t.billDetail.deleteFailed);
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
