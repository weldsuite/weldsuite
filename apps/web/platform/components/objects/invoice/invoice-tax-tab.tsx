/**
 * Tax tab of the invoice panel: what the sales tax engine did (engine, when it
 * calculated, whether the invoice is recorded with the provider, warnings,
 * exemptions) and, for Brazil, the NF-e / NFS-e and the Pix code.
 */

import { Calculator, Cloud, Clock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { exemptReasonsOf, hasExemptRows, hasProviderSyncWarning } from '@/lib/weldbooks/document-tax';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { ExemptNotice, TaxWarnings } from '@/app/weldbooks/invoices/components/tax-breakdown';
import { FiscalDocumentCard, PixCard } from './br-fiscal-card';
import { hasSalesTaxInfoOf } from './invoice-capabilities';

/** Sales tax engine, calculation and provider sync status of the invoice (nothing when it has none). */
function SalesTaxSection({
  invoice,
  isDraft,
  canUpdate,
  certificateNumbers,
  retrying,
  onRetryCommit,
}: Readonly<{
  invoice: InvoiceWithTax;
  isDraft: boolean;
  canUpdate: boolean;
  certificateNumbers: string[];
  retrying: boolean;
  onRetryCommit: () => void;
}>) {
  const td = useDocumentTexts();
  const { formatDateTime } = useWeldbooksFormat();
  if (!hasSalesTaxInfoOf(invoice)) return null;

  const taxState =
    normalizeAccountingAddress(invoice.shippingAddress)?.state ??
    normalizeAccountingAddress(invoice.billingAddress)?.state ??
    null;
  const providerEngine = invoice.taxEngine === 'stripe_tax' || invoice.taxEngine === 'avalara';
  const engineLabel = invoice.taxEngine
    ? ((td.engines as Record<string, string>)[invoice.taxEngine] ?? invoice.taxEngine)
    : null;
  const canRetryCommit = canUpdate && !isDraft && providerEngine && hasProviderSyncWarning(invoice.taxWarnings);
  const providerRecord = invoice.taxCommittedAt
    ? td.detail.committedAt.replace('{date}', formatDateTime(invoice.taxCommittedAt))
    : td.detail.notCommitted;

  return (
    <section className="space-y-3" data-testid="sales-tax-card">
      <TaxWarnings warnings={invoice.taxWarnings} state={taxState} title={td.detail.warningsTitle} />

      <div className="space-y-1">
        {engineLabel ? <PropertyRow icon={Calculator} label={td.detail.engine} value={engineLabel} readOnly /> : null}
        {invoice.taxCalculatedAt ? (
          <PropertyRow
            icon={Clock}
            label={td.detail.calculatedAt}
            value={formatDateTime(invoice.taxCalculatedAt)}
            readOnly
          />
        ) : null}
        {providerEngine && !isDraft ? (
          <PropertyRow
            icon={Cloud}
            label={td.detail.providerRecord}
            value={providerRecord}
            readOnly
            renderValue={(value) => <span data-testid="provider-status">{value}</span>}
          />
        ) : null}
      </div>

      {invoice.marketplaceFacilitated ? (
        <p className="text-sm text-muted-foreground">{td.detail.marketplaceNote}</p>
      ) : null}

      {hasExemptRows(invoice.taxBreakdown) ? (
        <ExemptNotice reasons={exemptReasonsOf(invoice.taxBreakdown)} certificateNumbers={certificateNumbers} />
      ) : null}

      {canRetryCommit ? (
        <Button variant="outline" size="sm" onClick={onRetryCommit} disabled={retrying}>
          {retrying ? td.detail.retrying : td.detail.retryCommit}
        </Button>
      ) : null}
    </section>
  );
}

export function InvoiceTaxTab({
  invoice,
  isDraft,
  canUpdate,
  entity,
  certificateNumbers,
  retrying,
  onRetryCommit,
}: Readonly<{
  invoice: InvoiceWithTax;
  isDraft: boolean;
  canUpdate: boolean;
  entity: Parameters<typeof PixCard>[0]['entity'];
  certificateNumbers: string[];
  retrying: boolean;
  onRetryCommit: () => void;
}>) {
  const { features } = useJurisdictionLabels();
  return (
    <div className="@container">
      <div className="p-4 space-y-4">
        <SalesTaxSection
          invoice={invoice}
          isDraft={isDraft}
          canUpdate={canUpdate}
          certificateNumbers={certificateNumbers}
          retrying={retrying}
          onRetryCommit={onRetryCommit}
        />
        {features.fiscalDocuments && <FiscalDocumentCard invoice={invoice} canUpdate={canUpdate} />}
        {features.brTaxReturn && <PixCard invoice={invoice} entity={entity} />}
      </div>
    </div>
  );
}
