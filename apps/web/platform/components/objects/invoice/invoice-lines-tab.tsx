/**
 * Line items tab of the invoice panel: one row per line (description, quantity
 * × unit price with discount and tax rate, the tax settings, the line total),
 * then the totals.
 */

import { ListOrdered } from 'lucide-react';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { isWeldTaxCode } from '@/lib/weldbooks/tax-codes';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { hasSalesTaxInfoOf } from './invoice-capabilities';
import { InvoiceTotals } from './invoice-totals';

type InvoiceLine = InvoiceWithTax['items'][number];

type DocumentTexts = ReturnType<typeof useDocumentTexts>;

/** The line's sales tax settings, when they are not the defaults. */
function lineTaxFlags(item: InvoiceLine, td: DocumentTexts): string[] {
  const flags: string[] = [];
  if (item.taxCode) flags.push(isWeldTaxCode(item.taxCode) ? td.taxCodes[item.taxCode] : item.taxCode);
  if (item.taxUse === 'business') flags.push(td.detail.lineFlags.business);
  if (item.taxUse === 'personal') flags.push(td.detail.lineFlags.personal);
  if (item.taxIncluded) flags.push(td.detail.lineFlags.taxIncluded);
  if (item.taxOverrideAmount !== null && item.taxOverrideAmount !== undefined) {
    flags.push(td.detail.lineFlags.overridden.replace('{reason}', item.taxOverrideReason ?? ''));
  }
  return flags;
}

const isNonZero = (value: string | null | undefined): value is string => Boolean(value) && Number(value) !== 0;

function LineRow({ item, invoice }: Readonly<{ item: InvoiceLine; invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const td = useDocumentTexts();
  const { labels } = useJurisdictionLabels();
  const { formatMoney, formatNumber } = useWeldbooksFormat();

  const flags = hasSalesTaxInfoOf(invoice) ? lineTaxFlags(item, td) : [];

  // "2 hours × $40.00 · Discount 10% · Sales tax 8.25%"
  const quantity = item.quantity ? formatNumber(item.quantity) : '-';
  const unit = item.unit ? ` ${item.unit}` : '';
  const meta = [`${quantity}${unit} × ${formatMoney(item.unitPrice, invoice.currency)}`];
  if (isNonZero(item.discountPercent)) meta.push(`${ti.discount} ${formatNumber(item.discountPercent)}%`);
  if (isNonZero(item.taxRate)) meta.push(`${labels.tax} ${formatNumber(item.taxRate)}%`);

  return (
    <TabListRow label={item.description}>
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm">{item.description}</div>
        <div className="text-xs text-muted-foreground tabular-nums">{meta.join(' · ')}</div>
        {flags.length > 0 && <div className="text-xs text-muted-foreground">{flags.join(' · ')}</div>}
      </div>
      <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(item.lineTotalWithTax ?? item.lineTotal, invoice.currency)}
      </span>
    </TabListRow>
  );
}

export function InvoiceLinesTab({
  invoice,
  isCreditMemo,
}: Readonly<{ invoice: InvoiceWithTax; isCreditMemo: boolean }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const items = invoice.items ?? [];

  if (items.length === 0) {
    return (
      <TabEmptyState
        bare
        illustration={
          <TabEmptyIllustration>
            <ListOrdered className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </TabEmptyIllustration>
        }
        title={ti.noLineItems}
        description={ti.panel.noLineItemsDescription}
      />
    );
  }

  return (
    <div>
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border">
          {items.map((item) => (
            <LineRow key={item.id} item={item} invoice={invoice} />
          ))}
        </div>
      </TabListScope>
      <InvoiceTotals invoice={invoice} isCreditMemo={isCreditMemo} />
    </div>
  );
}
