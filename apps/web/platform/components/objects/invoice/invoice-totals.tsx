import { useMemo } from 'react';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { isBrBreakdown } from '@/lib/weldbooks/br-fiscal';
import { groupTaxBreakdown } from '@/lib/weldbooks/document-tax';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { BrTaxSummary } from '@/app/weldbooks/invoices/components/br-fields';
import { TaxBreakdownList } from '@/app/weldbooks/invoices/components/tax-breakdown';

function TaxLines({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { formatMoney } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const taxGroups = useMemo(() => groupTaxBreakdown(invoice.taxBreakdown), [invoice.taxBreakdown]);
  // Brazil: taxes on top of the price, included in it, withholdings and the CBS / IBS test amounts, apart.
  if (isBrBreakdown(invoice.taxBreakdown)) {
    return <BrTaxSummary rows={invoice.taxBreakdown} warnings={invoice.taxWarnings} currency={invoice.currency} />;
  }
  // US: one row per jurisdiction, with the exempt amounts a certificate covers.
  if (taxGroups.some((group) => group.isJurisdiction)) {
    return <TaxBreakdownList groups={taxGroups} currency={invoice.currency} taxLabel={labels.tax} />;
  }
  if (invoice.taxBreakdown && invoice.taxBreakdown.length > 0) {
    return (
      <>
        {invoice.taxBreakdown.map((row, idx) => (
          <div key={`${row.taxRateName}-${idx}`} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{row.taxRateName}</span>
            <span>{formatMoney(row.taxAmount, invoice.currency)}</span>
          </div>
        ))}
      </>
    );
  }
  if (invoice.taxTotal && Number(invoice.taxTotal) !== 0) {
    return (
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{labels.tax}</span>
        <span>{formatMoney(invoice.taxTotal, invoice.currency)}</span>
      </div>
    );
  }
  return null;
}

/** Subtotal, the tax per rate or jurisdiction, the total, and what has been paid and is still due. */
export function InvoiceTotals({ invoice, isCreditMemo }: Readonly<{ invoice: InvoiceWithTax; isCreditMemo: boolean }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const { formatMoney } = useWeldbooksFormat();
  return (
    <div className="p-4">
      <div className="ml-auto w-full max-w-sm space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{ti.subtotal}</span>
          <span>{formatMoney(invoice.subtotal, invoice.currency)}</span>
        </div>
        <TaxLines invoice={invoice} />
        <div className="flex justify-between border-t pt-2 font-semibold">
          <span>{ti.total}</span>
          <span>{formatMoney(invoice.total, invoice.currency)}</span>
        </div>
        {invoice.amountPaid && Number(invoice.amountPaid) > 0 && (
          <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
            <span>{isCreditMemo ? ti.creditUsed : ti.amountPaid}</span>
            <span>-{formatMoney(invoice.amountPaid, invoice.currency)}</span>
          </div>
        )}
        {invoice.balanceDue && Number(invoice.balanceDue) > 0 && (
          <div className="flex justify-between font-semibold">
            <span>{isCreditMemo ? ti.creditRemaining : ti.balanceDue}</span>
            <span>{formatMoney(invoice.balanceDue, invoice.currency)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
