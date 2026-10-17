/**
 * Invoice object panel (WeldBooks). Credit notes are invoices of type
 * `credit_note` and open in the same panel.
 *
 * Built on the shell of the company / person / bank account panels
 * (`useObjectPanelShell` + `EntityDetailView` + tabs), so it inherits the
 * shared header, the panel↔fullscreen toggle and the stacking/back behaviour.
 * It replaces the standalone `/weldbooks/invoices/:id` page, which now
 * redirects to the list with this panel open in fullscreen. Nothing here
 * depends on a WeldBooks route: the panel opens from the lists, the dashboard
 * and other modules alike.
 *
 * Tabs: Details · Line items · Payments · Credit notes · Tax · History.
 */

import { useMemo, useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useAccountingEntity, useAccountingInvoice } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { RecordPaymentDialog } from '@/app/weldbooks/invoices/components/record-payment-dialog';
import { SalesTaxErrorNotice } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';
import { SendInvoiceDialog } from '@/app/weldbooks/invoices/components/send-invoice-dialog';
import { getInvoiceCapabilities, hasSalesTaxInfoOf, type InvoiceCapabilities } from './invoice-capabilities';
import { InvoiceCreditNotesTab } from './invoice-credit-notes-tab';
import { InvoiceDetailsTab } from './invoice-details-tab';
import {
  InvoiceActionBar,
  InvoiceAvatar,
  InvoiceHeaderActions,
  InvoiceTitle,
  recordPaymentLabel,
} from './invoice-header';
import { InvoiceLinesTab } from './invoice-lines-tab';
import { InvoicePaymentsTab } from './invoice-payments-tab';
import { StatusChangeDialog } from './invoice-status-dialog';
import { InvoiceTaxTab } from './invoice-tax-tab';
import { getInvoiceTabs, type InvoiceTabId } from './invoice-tabs';
import { useInvoiceCertificates, useInvoiceDocuments } from './use-invoice-documents';
import { useInvoiceWorkflow } from './use-invoice-workflow';

const INVOICE_PANEL_WIDTH = 480;

const TAB_IDS: readonly InvoiceTabId[] = ['overview', 'items', 'payments', 'creditNotes', 'tax', 'history'];

function isTabId(value: string | undefined): value is InvoiceTabId {
  return TAB_IDS.includes(value as InvoiceTabId);
}

/** The API answered 404: the invoice was deleted, or the link is wrong. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

interface InvoiceTabBodyProps {
  tab: InvoiceTabId;
  invoice: InvoiceWithTax;
  caps: InvoiceCapabilities;
  canUpdate: boolean;
  entity: ReturnType<typeof useAccountingEntity>['data'];
  certificateNumbers: string[];
  documents: ReturnType<typeof useInvoiceDocuments>;
  workflow: ReturnType<typeof useInvoiceWorkflow>;
  onOpenInvoice: (id: string) => void;
}

function InvoiceTabBody({
  tab,
  invoice,
  caps,
  canUpdate,
  entity,
  certificateNumbers,
  documents,
  workflow,
  onOpenInvoice,
}: Readonly<InvoiceTabBodyProps>) {
  const { t } = useI18n();
  switch (tab) {
    case 'overview':
      return (
        <InvoiceDetailsTab
          invoice={invoice}
          isCreditMemo={caps.isCreditMemo}
          openingAttachment={documents.openingAttachment}
          onOpenAttachment={documents.openAttachment}
          onOpenInvoice={onOpenInvoice}
        />
      );
    case 'items':
      return <InvoiceLinesTab invoice={invoice} isCreditMemo={caps.isCreditMemo} />;
    case 'payments':
      return (
        <InvoicePaymentsTab
          invoice={invoice}
          recordLabel={
            caps.canRecordPayment ? recordPaymentLabel(t.accounting.invoiceDetail, invoice, caps.isCreditMemo) : null
          }
          onRecordPayment={() => workflow.setPaymentOpen(true)}
        />
      );
    case 'creditNotes':
      return <InvoiceCreditNotesTab invoice={invoice} onOpenInvoice={onOpenInvoice} />;
    case 'tax':
      return (
        <InvoiceTaxTab
          invoice={invoice}
          isDraft={caps.isDraft}
          canUpdate={canUpdate}
          entity={entity}
          certificateNumbers={certificateNumbers}
          retrying={workflow.retryingCommit}
          onRetryCommit={workflow.retryCommit}
        />
      );
    case 'history':
      return <EntityAuditPanel entityType="invoice" entityId={invoice.id} />;
  }
}

/** The dialogs the invoice's actions ask in. */
function InvoiceDialogs({
  invoice,
  caps,
  workflow,
}: Readonly<{
  invoice: InvoiceWithTax;
  caps: InvoiceCapabilities;
  workflow: ReturnType<typeof useInvoiceWorkflow>;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  return (
    <>
      <SendInvoiceDialog
        invoiceId={invoice.id}
        contactEmail={invoice.contactEmail}
        isDraft={caps.isDraft}
        open={workflow.sendOpen}
        onOpenChange={workflow.setSendOpen}
        onTaxError={workflow.setTaxError}
      />
      <RecordPaymentDialog
        invoiceId={invoice.id}
        balanceDue={invoice.status === 'uncollectible' ? caps.writtenOffBalance.toFixed(2) : (invoice.balanceDue ?? '0')}
        currency={invoice.currency}
        open={workflow.paymentOpen}
        onOpenChange={workflow.setPaymentOpen}
        refund={caps.isCreditMemo}
      />
      <ConfirmDialog
        open={workflow.finalizeOpen}
        onOpenChange={workflow.setFinalizeOpen}
        title={ti.finalizeConfirmTitle}
        description={ti.finalizeConfirmDescription}
        confirmLabel={ti.confirmFinalize}
        cancelLabel={ti.keepDraft}
        loading={workflow.finalizing}
        onConfirm={workflow.finalize}
      />
      <StatusChangeDialog
        status={workflow.statusDialog}
        loading={workflow.changingStatus}
        onClose={() => workflow.setStatusDialog(null)}
        onConfirm={workflow.changeStatus}
      />
    </>
  );
}

export function InvoicePanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const td = useDocumentTexts();
  const canUpdate = useCan('invoices:update');
  const canCreate = useCan('invoices:create');
  const { features } = useJurisdictionLabels();
  const { open: openPanel } = useObjectPanel();

  const { entityId } = useCurrentAccountingEntity();
  const { data: entity } = useAccountingEntity(entityId);

  const invoiceQuery = useAccountingInvoice(id);
  const invoice = invoiceQuery.data?.data as unknown as InvoiceWithTax | undefined;
  const caps = invoice ? getInvoiceCapabilities(invoice, canUpdate, canCreate) : undefined;

  const workflow = useInvoiceWorkflow(invoice);
  const { certificateIds, certificates, certificateNumbers } = useInvoiceCertificates(invoice);
  const documents = useInvoiceDocuments({ invoice, entity, entityId, certificateIds, certificates });

  const shell = useObjectPanelShell({
    ...props,
    width: INVOICE_PANEL_WIDTH,
    loading: invoiceQuery.isLoading && !invoice,
  });
  const mode = shell.mode;

  const creditNoteCount = invoice?.creditNotes?.length ?? 0;
  const hasTaxDetails =
    (invoice ? hasSalesTaxInfoOf(invoice) : false) || features.fiscalDocuments || features.brTaxReturn;
  const tabs = useMemo(
    () =>
      getInvoiceTabs({
        labels: {
          details: st('sweep.entities.detailsTab'),
          items: ti.lineItems,
          payments: ti.panel.paymentsTab,
          creditNotes: ti.creditNotesTitle,
          tax: td.detail.taxTitle,
          history: st('sweep.entities.auditLogTab'),
        },
        counts: {
          items: invoice?.items?.length || undefined,
          payments: invoice?.payments?.length || undefined,
          creditNotes: creditNoteCount || undefined,
        },
        hasCreditNotes: creditNoteCount > 0,
        hasTaxDetails,
      }),
    [st, ti, td, invoice?.items?.length, invoice?.payments?.length, creditNoteCount, hasTaxDetails],
  );

  const [activeTab, setActiveTab] = useState<InvoiceTabId>(isTabId(initialTab) ? initialTab : 'overview');

  /** A credit note or the invoice it credits: opened in place, with a back arrow to this one. */
  const openInvoice = (invoiceId: string) => openPanel({ type: 'invoice', id: invoiceId, stack: true });

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        avatar={<InvoiceAvatar isCreditMemo={caps?.isCreditMemo} />}
        title={<InvoiceTitle invoice={invoice} />}
        actions={
          <InvoiceHeaderActions
            invoice={invoice}
            caps={caps}
            creatingCreditMemo={workflow.creatingCreditMemo}
            downloading={documents.downloading}
            onCreateCreditMemo={workflow.createCreditMemo}
            onDownload={() => void documents.download()}
            onRecordPayment={() => workflow.setPaymentOpen(true)}
            onSend={() => workflow.setSendOpen(true)}
            onStatusDialog={workflow.setStatusDialog}
          />
        }
        subheader={
          invoice && caps ? (
            <InvoiceActionBar
              caps={caps}
              finalizing={workflow.finalizing}
              applyingCredit={workflow.applyingCredit}
              onFinalize={() => workflow.setFinalizeOpen(true)}
              onApplyCredit={workflow.applyCredit}
            />
          ) : null
        }
        tabs={
          <ConfigurablePanelTabs
            objectType="invoice"
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
      >
        {!invoiceQuery.isLoading && invoiceQuery.isError && !isNotFound(invoiceQuery.error) && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!invoiceQuery.isLoading && !invoice && (!invoiceQuery.isError || isNotFound(invoiceQuery.error)) && (
          <div className="p-6 text-center text-sm text-muted-foreground">{ti.invoiceNotFound}</div>
        )}

        {invoice && caps && workflow.taxError !== null && (
          <div className="px-4 pt-4">
            <SalesTaxErrorNotice error={workflow.taxError} invoiceId={invoice.id} />
          </div>
        )}

        {invoice && caps && (
          <InvoiceTabBody
            tab={activeTab}
            invoice={invoice}
            caps={caps}
            canUpdate={canUpdate}
            entity={entity}
            certificateNumbers={certificateNumbers}
            documents={documents}
            workflow={workflow}
            onOpenInvoice={openInvoice}
          />
        )}
      </EntityDetailView>

      {invoice && caps ? <InvoiceDialogs invoice={invoice} caps={caps} workflow={workflow} /> : null}
    </>
  );
}
