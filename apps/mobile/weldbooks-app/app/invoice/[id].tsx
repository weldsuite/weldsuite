/**
 * Invoice detail.
 *
 * Actions map onto app-api's dedicated endpoints. Note what is deliberately
 * absent: there is no edit. app-api has no `PUT /invoices/:id` because an issued
 * document is immutable — a draft can be deleted and re-created, and an issued
 * invoice is corrected with a credit note.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { MoreHorizontal, FileText, Send, CreditCard, Lock } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

import api from '@/services/api';
import { toNumber } from '@/lib/currency';
import { useJurisdiction, useJurisdictions } from '@/hooks/useJurisdiction';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { missingInvoiceFields, requiredInvoiceFields } from '@/lib/company';
import { invoiceFieldNames, listInvoiceFields } from '@/lib/company-form';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';
import { BRAND } from '@/lib/brand';
import { addressLines, isUsAddressTaxable, toAddressDraft } from '@/lib/us';
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
import { ActionSheet, type ActionSheetOption } from '@/components/action-sheet';
import { EditCompanySheet } from '@/components/edit-company-sheet';
import { TaxBreakdownCard, TreatmentBreakdownCard } from '@/components/tax-breakdown';
import { hasTreatmentRows } from '@/lib/tax-treatment';
import type { Invoice } from '@/types/accounting';

type Confirm = 'delete' | 'cancel' | 'creditNote' | null;

function isSettled(status: Invoice['status']): boolean {
  return status === 'paid' || status === 'cancelled' || status === 'uncollectible';
}

/** An issued invoice can be credited or cancelled; only a draft can be deleted. */
function statusOptions(
  status: Invoice['status'],
  t: Translations,
  setConfirm: (confirm: Confirm) => void,
  createCreditNote: string,
): ActionSheetOption[] {
  if (status === 'draft') {
    return [{ label: t.invoiceDetail.deleteDraft, destructive: true, onPress: () => setConfirm('delete') }];
  }
  if (status === 'cancelled') return [];
  return [
    { label: createCreditNote, onPress: () => setConfirm('creditNote') },
    { label: t.invoiceDetail.cancelInvoice, destructive: true, onPress: () => setConfirm('cancel') },
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

/** A US draft finalises only with a ship-to (or bill-to) state and ZIP; the app can't edit a draft afterwards. */
function isMissingUsAddress(invoice: Invoice, isUs: boolean): boolean {
  return (
    isUs &&
    invoice.status === 'draft' &&
    !isUsAddressTaxable(toAddressDraft(invoice.shippingAddress)) &&
    !isUsAddressTaxable(toAddressDraft(invoice.billingAddress))
  );
}

/** Document type, customer, dates, reference and (US) the ship-to / bill-to addresses. */
function InvoiceDetailsSection({
  invoice,
  isUs,
  creditNoteLabel,
}: Readonly<{ invoice: Invoice; isUs: boolean; creditNoteLabel: string }>) {
  const { t } = useI18n();
  const { formatDate } = useLocaleFormatters();
  const isCreditNote = invoice.type === 'credit_note';
  const shipTo = addressLines(invoice.shippingAddress);
  const billTo = addressLines(invoice.billingAddress);

  return (
    <SectionCard title={t.invoiceDetail.details}>
      {isCreditNote ? (
        <DetailRow label={t.invoiceDetail.documentType} value={creditNoteLabel} />
      ) : null}
      <DetailRow label={t.invoiceDetail.customer} value={invoice.contactName} />
      {invoice.contactEmail ? <DetailRow label={t.invoiceDetail.email} value={invoice.contactEmail} /> : null}
      <DetailRow label={t.invoiceDetail.issueDate} value={formatDate(invoice.issueDate)} />
      <DetailRow label={t.invoiceDetail.dueDate} value={formatDate(invoice.dueDate)} />
      {invoice.reference ? <DetailRow label={t.invoiceDetail.reference} value={invoice.reference} /> : null}
      {isUs && shipTo.length > 0 ? (
        <DetailRow label={t.invoiceDetail.shipTo} value={shipTo.join('\n')} />
      ) : null}
      {isUs && billTo.length > 0 && billTo.join() !== shipTo.join() ? (
        <DetailRow label={t.invoiceDetail.billTo} value={billTo.join('\n')} />
      ) : null}
    </SectionCard>
  );
}

type Mutations = ReturnType<typeof useDocumentMutations>;
type FieldList = Parameters<typeof listInvoiceFields>[0];

/** Warnings above the details: US address, missing company fields, and the last refused action. */
function InvoiceBanners({
  invoice,
  isUs,
  companyMissing,
  errorFields,
  actionError,
  clearError,
  listFields,
  onAddCompany,
}: Readonly<{
  invoice: Invoice;
  isUs: boolean;
  companyMissing: FieldList;
  errorFields: Mutations['errorFields'];
  actionError: Mutations['error'];
  clearError: () => void;
  listFields: (fields: FieldList) => string;
  onAddCompany: () => void;
}>) {
  const { t, format } = useI18n();
  // The refusal that names fields (ENTITY_INVOICE_FIELDS_MISSING) replaces the server's English sentence.
  const rejectedFields = errorFields.length > 0 ? errorFields : null;
  const warnCompany = invoice.status === 'draft' && companyMissing.length > 0 && !rejectedFields;

  return (
    <>
      {isMissingUsAddress(invoice, isUs) ? (
        <Banner variant="warning" style={styles.banner}>
          {t.invoiceDetail.addressMissing}
        </Banner>
      ) : null}

      {warnCompany ? (
        <View style={styles.banner}>
          <Banner variant="warning">
            {format(t.invoiceDetail.companyFieldsMissing, { fields: listFields(companyMissing) })}
          </Banner>
          <Button
            title={t.invoiceDetail.addCompanyDetails}
            variant="outline"
            size="sm"
            onPress={onAddCompany}
            style={styles.bannerAction}
          />
        </View>
      ) : null}

      {actionError ? (
        <View style={styles.banner}>
          <Banner variant="error" title={t.invoiceDetail.finaliseFailed} onClose={clearError}>
            {rejectedFields
              ? format(t.invoiceDetail.companyFieldsRejected, { fields: listFields(rejectedFields) })
              : actionError}
          </Banner>
          {rejectedFields ? (
            <Button
              title={t.invoiceDetail.addCompanyDetails}
              variant="outline"
              size="sm"
              onPress={onAddCompany}
              style={styles.bannerAction}
            />
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** Sales tax breakdown for US invoices, the VAT treatment breakdown for everyone else. */
function InvoiceTaxSections({
  invoice,
  isUs,
  currency,
}: Readonly<{ invoice: Invoice; isUs: boolean; currency: string }>) {
  if (isUs) {
    return (
      <TaxBreakdownCard
        rows={invoice.taxBreakdown}
        warnings={invoice.taxWarnings}
        currency={currency}
        initiallyExpanded={invoice.status === 'draft'}
      />
    );
  }
  if (hasTreatmentRows(invoice.taxBreakdown)) {
    return <TreatmentBreakdownCard rows={invoice.taxBreakdown} currency={currency} />;
  }
  return null;
}

/** The delete, cancel and credit note confirmations; at most one is open at a time. */
function InvoiceConfirmModals({
  invoice,
  confirm,
  setConfirm,
  busy,
  run,
  remove,
}: Readonly<{
  invoice: Invoice;
  confirm: Confirm;
  setConfirm: (confirm: Confirm) => void;
  busy: boolean;
  run: Mutations['run'];
  remove: Mutations['remove'];
}>) {
  const router = useRouter();
  const { t, format } = useI18n();
  const { terms } = useJurisdiction();

  return (
    <>
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
        title={format(t.invoiceDetail.creditNoteTitle, terms)}
        message={t.invoiceDetail.creditNoteMessage}
        confirmText={t.common.create}
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          run(async () => {
            const note = await api.createCreditNote(invoice.id);
            router.replace(`/invoice/${note.id}`);
          }, format(t.invoiceDetail.creditNoteCreated, terms));
        }}
      />
    </>
  );
}

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format } = useI18n();
  const { currency: entityCurrency } = useLocaleFormatters();
  const { isUs, labels, terms } = useJurisdiction();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const { activeEntity, refresh: refreshEntity } = useAccountingEntity();
  const { code } = useJurisdiction();
  const { data: loadedJurisdictions } = useJurisdictions();

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
  const { busy, run, remove, error: actionError, errorFields, clearError } = useDocumentMutations(load);

  const actionOptions = useMemo<ActionSheetOption[]>(() => {
    if (!invoice) return [];
    return [
      {
        label: t.invoiceDetail.duplicate,
        onPress: () =>
          run(async () => {
            const copy = await api.duplicateInvoice(invoice.id);
            router.replace(`/invoice/${copy.id}`);
          }, t.invoiceDetail.duplicated),
      },
      ...statusOptions(invoice.status, t, setConfirm, format(t.invoiceDetail.createCreditNote, terms)),
    ];
  }, [invoice, run, router, t, format, terms]);

  const handleMore = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActionsOpen(true);
  }, []);

  // What the company still has to fill in before this draft can be finalised.
  const companyMissing = useMemo(
    () => missingInvoiceFields(activeEntity, requiredInvoiceFields(code, loadedJurisdictions)),
    [activeEntity, code, loadedJurisdictions],
  );
  const fieldNames = invoiceFieldNames(t, labels);
  const separators = { comma: ', ', and: t.company.listAnd };
  const listFields = (fields: Parameters<typeof listInvoiceFields>[0]) =>
    listInvoiceFields(fields, fieldNames, separators);

  const header = (
    <ScreenHeader
      title={invoice?.invoiceNumber || (invoice?.type === 'credit_note' ? labels.creditNote : t.invoiceDetail.title)}
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

  const currency = documentCurrency(invoice, entityCurrency);
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
              // The company too: its fields may have been filled in on the web since.
              void refreshEntity();
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

        <InvoiceBanners
          invoice={invoice}
          isUs={isUs}
          companyMissing={companyMissing}
          errorFields={errorFields}
          actionError={actionError}
          clearError={clearError}
          listFields={listFields}
          onAddCompany={() => setCompanyOpen(true)}
        />

        <InvoiceDetailsSection invoice={invoice} isUs={isUs} creditNoteLabel={labels.creditNote} />

        <DocumentLineItems
          items={invoice.items}
          currency={currency}
          title={t.invoiceDetail.lineItems}
          kind="invoice"
        />

        <DocumentTotalsCard
          doc={invoice}
          labels={t.invoiceDetail}
          taxLabel={labels.tax}
          taxBreakdown={invoice.taxBreakdown}
        />

        <InvoiceTaxSections invoice={invoice} isUs={isUs} currency={currency} />

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

      <ActionSheet
        visible={actionsOpen}
        onClose={() => setActionsOpen(false)}
        title={t.invoiceDetail.actionsTitle}
        options={actionOptions}
      />

      <EditCompanySheet visible={companyOpen} onClose={() => setCompanyOpen(false)} onSaved={clearError} />

      <RecordPaymentSheet
        visible={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        balanceDue={balanceDue}
        currency={currency}
        direction="received"
        submitting={busy}
        onSubmit={async (payment) => {
          await run(
            () => api.recordInvoicePayment(invoice.id, payment),
            t.invoiceDetail.paymentRecorded,
          );
          setPaymentOpen(false);
        }}
      />

      <InvoiceConfirmModals
        invoice={invoice}
        confirm={confirm}
        setConfirm={setConfirm}
        busy={busy}
        run={run}
        remove={remove}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  banner: { marginHorizontal: 12, marginTop: 8 },
  bannerAction: { alignSelf: 'flex-start', marginTop: 8 },
  notes: { fontSize: 14, lineHeight: 20 },
  actions: { padding: 12, paddingTop: 20, gap: 8 },
});
