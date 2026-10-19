/**
 * Line items and tax tabs of the bill panel.
 *
 * The lines are `TabListRow` rows, so they fit the 480px side panel: the
 * quantity, unit price, discount and tax columns drop out below 560px of list
 * width (the quantity and price move under the description instead), and all
 * of them are there in fullscreen.
 */

import type { ReactNode } from 'react';
import { Percent } from 'lucide-react';
import { FilesIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { BrTaxSummary } from '@/app/weldbooks/invoices/components/br-fields';
import { TaxBreakdownList } from '@/app/weldbooks/invoices/components/tax-breakdown';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { Link as AppLink } from '@/lib/router';
import { isBrBreakdown } from '@/lib/weldbooks/br-fiscal';
import { groupTaxBreakdown } from '@/lib/weldbooks/document-tax';
import { FORM_1099_OMIT, form1099BoxName } from '@/lib/weldbooks/form-1099';
import { isWeldTaxCode } from '@/lib/weldbooks/tax-codes';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { cn } from '@/lib/utils';

type BillItemRow = BillWithTax['items'][number];

/** Whether a bill has a breakdown the tax tab shows: Brazil fiscal taxes, or the use tax a US bill accrued. */
export function hasBillTaxTab(bill: BillWithTax | undefined, salesTaxEnabled: boolean): boolean {
  if (!bill) return false;
  if (isBrBreakdown(bill.taxBreakdown)) return true;
  return salesTaxEnabled && groupTaxBreakdown(bill.taxBreakdown).some((group) => group.kind === 'use');
}

function useLineFlags() {
  const td = useDocumentTexts();
  const { features } = useJurisdictionLabels();
  /** Tax code, use tax accrual and 1099 box of a line, when they are set. */
  return (item: BillItemRow): string[] => {
    const flags: string[] = [];
    if (features.salesTax && item.taxCode) {
      flags.push(isWeldTaxCode(item.taxCode) ? td.taxCodes[item.taxCode] : item.taxCode);
    }
    if (item.accrueUseTax) flags.push(td.bill.accrueUseTax);
    if (features.form1099 && item.form1099Box) {
      flags.push(item.form1099Box === FORM_1099_OMIT ? td.bill.form1099Omit : form1099BoxName(item.form1099Box));
    }
    return flags;
  };
}

function Cell({ children, className }: Readonly<{ children: ReactNode; className: string }>) {
  return <span className={cn('flex-shrink-0 text-right text-sm tabular-nums', className)}>{children}</span>;
}

function ColumnHeaders() {
  const { t } = useI18n();
  const tb = t.accounting.billDetail;
  return (
    // The secondary columns (and so their headers) show from 560px of list width.
    <div className="hidden items-center gap-4 border-b border-gray-200/70 px-4 py-2 text-xs text-muted-foreground dark:border-border @min-[560px]:flex">
      <span className="min-w-0 flex-1">{tb.description}</span>
      <Cell className="w-[56px]">{tb.qty}</Cell>
      <Cell className="w-[96px]">{tb.unitPrice}</Cell>
      <Cell className="w-[64px]">{tb.discountPercent}</Cell>
      <Cell className="w-[88px]">{tb.tax}</Cell>
      <Cell className="w-[104px]">{tb.lineTotal}</Cell>
      <span className="w-[40px] flex-shrink-0" />
    </div>
  );
}

function LineItemRow({
  item,
  currency,
  canCreateFixedAsset,
}: Readonly<{ item: BillItemRow; currency: string | null; canCreateFixedAsset: boolean }>) {
  const td = useDocumentTexts();
  const { formatMoney, formatNumber } = useWeldbooksFormat();
  const lineFlags = useLineFlags();
  const flags = lineFlags(item);
  const quantity = item.quantity ? formatNumber(item.quantity) : '-';

  return (
    <TabListRow label={item.description}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{item.description}</div>
        {flags.length > 0 ? <div className="truncate text-xs text-muted-foreground">{flags.join(' · ')}</div> : null}
        <div className="truncate text-xs text-muted-foreground tabular-nums @min-[560px]:hidden">
          {quantity} × {formatMoney(item.unitPrice, currency)}
        </div>
        {canCreateFixedAsset ? (
          <AppLink
            href={`/weldbooks/fixed-assets/new?billItemId=${encodeURIComponent(item.id)}`}
            className="block text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {td.bill.createFixedAsset}
          </AppLink>
        ) : null}
      </div>
      <Cell className="w-[56px] @max-[559px]:hidden">{quantity}</Cell>
      <Cell className="w-[96px] @max-[559px]:hidden">{formatMoney(item.unitPrice, currency)}</Cell>
      <Cell className="w-[64px] @max-[559px]:hidden">
        {item.discountPercent ? `${formatNumber(item.discountPercent)}%` : '-'}
      </Cell>
      <Cell className="w-[88px] @max-[559px]:hidden">{formatMoney(item.taxAmount, currency)}</Cell>
      <Cell className="w-[104px] font-medium">{formatMoney(item.lineTotalWithTax ?? item.lineTotal, currency)}</Cell>
    </TabListRow>
  );
}

function TotalRow({
  label,
  value,
  className,
}: Readonly<{ label: string; value: string; className?: string }>) {
  return (
    <div className={cn('flex justify-between gap-4 text-sm', className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function BillTotals({ bill }: Readonly<{ bill: BillWithTax }>) {
  const { t } = useI18n();
  const tb = t.accounting.billDetail;
  const td = useDocumentTexts();
  const { formatMoney } = useWeldbooksFormat();
  const { features } = useJurisdictionLabels();
  const hasPayment = !!bill.amountPaid && Number(bill.amountPaid) > 0;

  return (
    <div className="ml-auto w-full max-w-xs space-y-2 p-4">
      <TotalRow label={tb.subtotal} value={formatMoney(bill.subtotal, bill.currency)} />
      <TotalRow
        label={features.salesTax ? td.bill.vendorTaxLabel : tb.tax}
        value={formatMoney(bill.taxTotal, bill.currency)}
      />
      <div className="border-t border-border pt-2">
        <TotalRow
          label={tb.total}
          value={formatMoney(bill.total, bill.currency)}
          className="font-semibold [&>span]:text-foreground"
        />
      </div>
      {hasPayment ? (
        <>
          <TotalRow label={tb.paid} value={formatMoney(bill.amountPaid, bill.currency)} />
          <TotalRow
            label={tb.balanceDue}
            value={formatMoney(bill.balanceDue, bill.currency)}
            className="font-semibold [&>span]:text-destructive"
          />
        </>
      ) : null}
    </div>
  );
}

export function BillLineItemsTab({ bill }: Readonly<{ bill: BillWithTax }>) {
  const { t } = useI18n();
  const tb = t.accounting.billDetail;
  const { features } = useJurisdictionLabels();
  const items = bill.items ?? [];
  // Fixed assets come from the lines of a bill that is posted.
  const isPosted =
    bill.approvalStatus === 'approved' || ['approved', 'paid', 'partial', 'overdue'].includes(bill.status);

  if (items.length === 0) {
    return (
      <TabEmptyState
        bare
        illustration={<FilesIllustration />}
        title={tb.noLineItems}
        description={tb.noLineItemsDescription}
      />
    );
  }

  return (
    <div>
      <TabListScope>
        <ColumnHeaders />
        {items.map((item) => (
          <LineItemRow
            key={item.id}
            item={item}
            currency={bill.currency}
            canCreateFixedAsset={features.salesTax && isPosted}
          />
        ))}
      </TabListScope>
      <BillTotals bill={bill} />
    </div>
  );
}

function TaxSection({ title, testId, children }: Readonly<{ title: string; testId: string; children: ReactNode }>) {
  return (
    <section className="space-y-3" data-testid={testId}>
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Percent className="h-4 w-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

export function BillTaxTab({ bill }: Readonly<{ bill: BillWithTax }>) {
  const { t } = useI18n();
  const td = useDocumentTexts();
  const { features } = useJurisdictionLabels();
  const useTaxGroups = groupTaxBreakdown(bill.taxBreakdown).filter((group) => group.kind === 'use');

  return (
    <div className="space-y-6 p-4">
      {isBrBreakdown(bill.taxBreakdown) ? (
        <TaxSection title={t.weldbooksBr.document.billTaxTitle} testId="br-bill-tax-card">
          <BrTaxSummary rows={bill.taxBreakdown} warnings={bill.taxWarnings} currency={bill.currency} />
        </TaxSection>
      ) : null}

      {features.salesTax && useTaxGroups.length > 0 ? (
        <TaxSection title={td.bill.useTaxTitle} testId="use-tax-card">
          <TaxBreakdownList groups={useTaxGroups} currency={bill.currency} taxLabel={td.bill.useTaxTitle} plain />
          <p className="text-xs text-muted-foreground">{td.bill.useTaxNote}</p>
        </TaxSection>
      ) : null}
    </div>
  );
}
