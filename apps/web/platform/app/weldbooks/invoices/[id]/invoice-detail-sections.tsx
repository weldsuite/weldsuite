import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import {
  exemptReasonsOf,
  groupTaxBreakdown,
  hasExemptRows,
  hasProviderSyncWarning,
} from '@/lib/weldbooks/document-tax';
import { isWeldTaxCode } from '@/lib/weldbooks/tax-codes';
import { isForeignCurrency } from '@/lib/weldbooks/currencies';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { countryName } from '@/components/address/countries';
import { BrTaxSummary } from '../components/br-fields';
import { isBrBreakdown } from '@/lib/weldbooks/br-fiscal';
import { ExemptNotice, TaxBreakdownList, TaxWarnings } from '../components/tax-breakdown';
import type { InvoiceCapabilities } from './invoice-capabilities';

type InvoiceTexts = ReturnType<typeof useI18n>['t']['accounting']['invoiceDetail'];
type JurisdictionFeatures = ReturnType<typeof useJurisdictionLabels>['features'];
export type InvoiceStatusDialog = 'cancelled' | 'uncollectible' | null;

/** Localised country name lookup in the member's language. */
export function useCountryLabel() {
  const { language } = useI18n();
  return (code: string) => countryName(code, language || 'en');
}

export function getStatusBadge(status: string, labels: Record<string, string>) {
  switch (status) {
    case 'draft':
      return <Badge variant="outline">{labels.draft}</Badge>;
    case 'sent':
      return <Badge variant="secondary">{labels.sent}</Badge>;
    case 'paid':
      return (
        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
          {labels.paid}
        </Badge>
      );
    case 'overdue':
      return <Badge variant="destructive">{labels.overdue}</Badge>;
    case 'partial':
      return <Badge variant="secondary">{labels.partial}</Badge>;
    case 'cancelled':
      return <Badge variant="outline">{labels.cancelled}</Badge>;
    case 'finalized':
      return <Badge variant="secondary">{labels.finalized}</Badge>;
    case 'uncollectible':
      return <Badge variant="outline">{labels.uncollectible}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

/** Whether the invoice carries any sales tax engine output worth showing. */
export function hasSalesTaxInfoOf(invoice: InvoiceWithTax): boolean {
  return Boolean(invoice.taxEngine) || (invoice.taxWarnings?.length ?? 0) > 0;
}

/** The label of the main "record payment" button: a credit note is refunded, a written-off invoice recovered. */
function recordPaymentLabel(ti: InvoiceTexts, invoice: InvoiceWithTax, isCreditMemo: boolean): string {
  if (isCreditMemo) return ti.recordRefund;
  return invoice.status === 'uncollectible' ? ti.recordRecovery : ti.recordPayment;
}

type InvoiceActionHandlers = {
  onDownload: () => void;
  onSend: () => void;
  onFinalize: () => void;
  onApplyCredit: () => void;
  onRecordPayment: () => void;
  onCreateCreditMemo: () => void;
  onStatusDialog: (status: 'cancelled' | 'uncollectible') => void;
};

type InvoiceActionPending = {
  downloading: boolean;
  finalizing: boolean;
  applyingCredit: boolean;
  creatingCreditMemo: boolean;
};

function MoreActionsMenu({
  caps,
  creatingCreditMemo,
  on,
}: Readonly<{
  caps: InvoiceCapabilities;
  creatingCreditMemo: boolean;
  on: InvoiceActionHandlers;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const td = useDocumentTexts();
  const { labels } = useJurisdictionLabels();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={ti.moreActions}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {caps.canCreateCreditMemo && (
          <DropdownMenuItem onClick={on.onCreateCreditMemo} disabled={creatingCreditMemo}>
            {td.detail.createCreditMemo.replace('{name}', labels.creditNote.toLowerCase())}
          </DropdownMenuItem>
        )}
        {caps.canWriteOff && (
          <DropdownMenuItem onClick={() => on.onStatusDialog('uncollectible')}>
            {ti.markUncollectible}
          </DropdownMenuItem>
        )}
        {caps.canCancel && (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => on.onStatusDialog('cancelled')}
          >
            {ti.cancelInvoice}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Title row: the invoice number with its status, and the actions the invoice allows. */
export function InvoiceHeader({
  invoice,
  routeId,
  caps,
  pending,
  on,
}: Readonly<{
  invoice: InvoiceWithTax;
  routeId: string;
  caps: InvoiceCapabilities;
  pending: InvoiceActionPending;
  on: InvoiceActionHandlers;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const tsl = t.accounting.statusLabels.invoice;
  const { isDraft, isCreditMemo } = caps;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">{invoice.invoiceNumber ?? tsl.fallback}</h1>
        {getStatusBadge(invoice.status, tsl)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={on.onDownload} disabled={pending.downloading}>
          {pending.downloading ? ti.generatingPdf : ti.downloadPdf}
        </Button>
        {isDraft && (
          <Button variant="outline" asChild>
            <Link to="/weldbooks/invoices/$id/edit" params={{ id: routeId }}>{ti.edit}</Link>
          </Button>
        )}
        {caps.canSend && (
          <Button variant="outline" onClick={on.onSend}>
            {ti.send}
          </Button>
        )}
        {isDraft && (
          <Button variant="outline" onClick={on.onFinalize} disabled={pending.finalizing}>
            {pending.finalizing ? ti.finalizing : ti.finalize}
          </Button>
        )}
        {caps.canApplyCredit && (
          <Button variant="outline" onClick={on.onApplyCredit} disabled={pending.applyingCredit}>
            {pending.applyingCredit ? ti.applyingCredit : ti.applyCredit}
          </Button>
        )}
        {caps.canRecordPayment && (
          <Button onClick={on.onRecordPayment}>{recordPaymentLabel(ti, invoice, isCreditMemo)}</Button>
        )}
        {(caps.canCancel || caps.canWriteOff || caps.canCreateCreditMemo) && (
          <MoreActionsMenu caps={caps} creatingCreditMemo={pending.creatingCreditMemo} on={on} />
        )}
      </div>
    </div>
  );
}

export function CreditMemoNotice({ creditNoteForInvoiceId }: Readonly<{ creditNoteForInvoiceId?: string | null }>) {
  const td = useDocumentTexts();
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-6 text-sm">
        <span className="text-muted-foreground">{td.detail.creditMemoNote}</span>
        {creditNoteForInvoiceId && (
          <Link
            to="/weldbooks/invoices/$id"
            params={{ id: creditNoteForInvoiceId }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {td.detail.viewOriginal}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function AddressColumn({ title, lines }: Readonly<{ title: string; lines: string[] }>) {
  if (lines.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase text-muted-foreground">{title}</p>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

export function ContactCard({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const country = useCountryLabel();
  const billingLines = formatPostalAddressLines(normalizeAccountingAddress(invoice.billingAddress), {
    countryName: country,
  });
  const shippingLines = formatPostalAddressLines(normalizeAccountingAddress(invoice.shippingAddress), {
    countryName: country,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ti.contact}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <p className="font-medium">{invoice.contactName ?? '-'}</p>
          {invoice.contactEmail && (
            <p className="text-sm text-muted-foreground">{invoice.contactEmail}</p>
          )}
        </div>
        {(billingLines.length > 0 || shippingLines.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <AddressColumn title={ti.billTo} lines={billingLines} />
            <AddressColumn title={ti.shipTo} lines={shippingLines} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DetailLine({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function DatesCard({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const { formatDate, formatNumber, entityCurrency } = useWeldbooksFormat();
  const hasRate = Boolean(invoice.exchangeRate) && Number(invoice.exchangeRate) > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ti.dates}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <DetailLine label={ti.issueDate}>
          <span>{formatDate(invoice.issueDate, '-')}</span>
        </DetailLine>
        <DetailLine label={ti.dueDate}>
          <span>{formatDate(invoice.dueDate, '-')}</span>
        </DetailLine>
        {invoice.reference && (
          <DetailLine label={ti.reference}>
            <span>{invoice.reference}</span>
          </DetailLine>
        )}
        {isForeignCurrency(entityCurrency, invoice.currency) && (
          <DetailLine label={t.accounting.documentCurrency.exchangeRate}>
            <span data-testid="exchange-rate">
              {hasRate ? `1 ${entityCurrency} = ${formatNumber(invoice.exchangeRate)} ${invoice.currency}` : '-'}
            </span>
          </DetailLine>
        )}
      </CardContent>
    </Card>
  );
}

/** Sales tax engine, calculation and provider sync status of the invoice (nothing when it has none). */
export function SalesTaxCard({
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
    normalizeAccountingAddress(invoice.shippingAddress)?.state ?? normalizeAccountingAddress(invoice.billingAddress)?.state ?? null;
  const providerEngine = invoice.taxEngine === 'stripe_tax' || invoice.taxEngine === 'avalara';
  const engineLabel = invoice.taxEngine
    ? ((td.engines as Record<string, string>)[invoice.taxEngine] ?? invoice.taxEngine)
    : null;
  const canRetryCommit = canUpdate && !isDraft && providerEngine && hasProviderSyncWarning(invoice.taxWarnings);
  const providerRecord = invoice.taxCommittedAt
    ? td.detail.committedAt.replace('{date}', formatDateTime(invoice.taxCommittedAt))
    : td.detail.notCommitted;

  return (
    <Card data-testid="sales-tax-card">
      <CardHeader>
        <CardTitle>{td.detail.taxTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TaxWarnings warnings={invoice.taxWarnings} state={taxState} title={td.detail.warningsTitle} />

        <div className="space-y-1 text-sm">
          {engineLabel && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{td.detail.engine}</span>
              <span>{engineLabel}</span>
            </div>
          )}
          {invoice.taxCalculatedAt && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{td.detail.calculatedAt}</span>
              <span>{formatDateTime(invoice.taxCalculatedAt)}</span>
            </div>
          )}
          {providerEngine && !isDraft && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{td.detail.providerRecord}</span>
              <span data-testid="provider-status">{providerRecord}</span>
            </div>
          )}
        </div>

        {invoice.marketplaceFacilitated && (
          <p className="text-sm text-muted-foreground">{td.detail.marketplaceNote}</p>
        )}

        {hasExemptRows(invoice.taxBreakdown) && (
          <ExemptNotice
            reasons={exemptReasonsOf(invoice.taxBreakdown)}
            certificateNumbers={certificateNumbers}
          />
        )}

        {canRetryCommit && (
          <Button variant="outline" size="sm" onClick={onRetryCommit} disabled={retrying}>
            {retrying ? td.detail.retrying : td.detail.retryCommit}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** The files the invoice was created from, opened one at a time. */
export function AttachmentsCard({
  attachmentKeys,
  openingAttachment,
  onOpen,
}: Readonly<{
  attachmentKeys: string[];
  openingAttachment: number | null;
  onOpen: (index: number, fallbackName: string) => void;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ti.originalDocuments}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {attachmentKeys.map((key, index) => {
          const name = key.split('/').pop() || ti.attachmentFallback.replace('{n}', String(index + 1));
          return (
            <Button
              key={`${key}-${index}`}
              variant="outline"
              size="sm"
              disabled={openingAttachment === index}
              onClick={() => onOpen(index, name)}
            >
              {openingAttachment === index ? ti.generatingPdf : `${ti.openAttachment}: ${name}`}
            </Button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function LineItemRow({ item, invoice }: Readonly<{ item: InvoiceWithTax['items'][number]; invoice: InvoiceWithTax }>) {
  const td = useDocumentTexts();
  const { formatMoney, formatNumber } = useWeldbooksFormat();
  const hasSalesTaxInfo = hasSalesTaxInfoOf(invoice);

  /** The line's sales tax settings, when they are not the defaults. */
  const lineFlags = (): string[] => {
    if (!hasSalesTaxInfo) return [];
    const flags: string[] = [];
    if (item.taxCode) {
      flags.push(isWeldTaxCode(item.taxCode) ? td.taxCodes[item.taxCode] : item.taxCode);
    }
    if (item.taxUse === 'business') flags.push(td.detail.lineFlags.business);
    if (item.taxUse === 'personal') flags.push(td.detail.lineFlags.personal);
    if (item.taxIncluded) flags.push(td.detail.lineFlags.taxIncluded);
    if (item.taxOverrideAmount !== null && item.taxOverrideAmount !== undefined) {
      flags.push(td.detail.lineFlags.overridden.replace('{reason}', item.taxOverrideReason ?? ''));
    }
    return flags;
  };

  const flags = lineFlags();
  return (
    <TableRow>
      <TableCell>
        {item.description}
        {flags.length > 0 && (
          <span className="block text-xs text-muted-foreground">{flags.join(' · ')}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {item.quantity ? formatNumber(item.quantity) : '-'}
        {item.unit ? ` ${item.unit}` : ''}
      </TableCell>
      <TableCell className="text-right">
        {formatMoney(item.unitPrice, invoice.currency)}
      </TableCell>
      <TableCell className="text-right">
        {item.discountPercent ? `${formatNumber(item.discountPercent)}%` : '-'}
      </TableCell>
      <TableCell className="text-right">
        {item.taxRate ? `${formatNumber(item.taxRate)}%` : '-'}
      </TableCell>
      <TableCell className="text-right font-medium">
        {formatMoney(item.lineTotalWithTax ?? item.lineTotal, invoice.currency)}
      </TableCell>
    </TableRow>
  );
}

export function LineItemsCard({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const { labels } = useJurisdictionLabels();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ti.lineItems}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">{ti.description}</TableHead>
              <TableHead className="text-right">{ti.qty}</TableHead>
              <TableHead className="text-right">{ti.unitPrice}</TableHead>
              <TableHead className="text-right">{ti.discount}</TableHead>
              <TableHead className="text-right">{labels.tax}</TableHead>
              <TableHead className="text-right">{ti.total}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.items?.map((item) => (
              <LineItemRow key={item.id} item={item} invoice={invoice} />
            ))}
            {(!invoice.items || invoice.items.length === 0) && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {ti.noLineItems}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

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

export function TotalsCard({ invoice, isCreditMemo }: Readonly<{ invoice: InvoiceWithTax; isCreditMemo: boolean }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const { formatMoney } = useWeldbooksFormat();
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex justify-end">
          <div className="w-full max-w-xs space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{ti.subtotal}</span>
              <span>{formatMoney(invoice.subtotal, invoice.currency)}</span>
            </div>
            <TaxLines invoice={invoice} />
            <div className="flex justify-between font-semibold border-t pt-2">
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
      </CardContent>
    </Card>
  );
}

/** Credit notes issued against this invoice: once finalized they lower its balance. */
export function CreditNotesCard({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const tsl = t.accounting.statusLabels.invoice;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const notes = invoice.creditNotes ?? [];
  if (notes.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ti.creditNotesTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {notes.map((note) => (
          <div key={note.id} className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Link
                to="/weldbooks/invoices/$id"
                params={{ id: note.id }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {note.invoiceNumber ?? note.id}
              </Link>
              {getStatusBadge(note.status, tsl)}
              <span className="text-muted-foreground">{formatDate(note.issueDate)}</span>
            </div>
            <span>-{formatMoney(note.total ?? '0', invoice.currency)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Why writing an invoice off matters: VAT relief, a sales tax deduction, or neither. */
function uncollectibleDescription(ti: InvoiceTexts, features: JurisdictionFeatures): string {
  if (features?.vatReturn) return ti.uncollectibleDescriptionVat;
  if (features?.salesTax) return ti.uncollectibleDescriptionSalesTax;
  return ti.uncollectibleDescription;
}

/** Confirms cancelling an invoice or writing it off as uncollectible. */
export function StatusChangeDialog({
  status,
  loading,
  onClose,
  onConfirm,
}: Readonly<{
  status: InvoiceStatusDialog;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const { features } = useJurisdictionLabels();
  const writeOff = status === 'uncollectible';
  return (
    <ConfirmDialog
      open={status !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={writeOff ? ti.uncollectibleTitle : ti.cancelInvoiceTitle}
      description={writeOff ? uncollectibleDescription(ti, features) : ti.cancelInvoiceDescription}
      confirmLabel={writeOff ? ti.confirmUncollectible : ti.confirmCancel}
      cancelLabel={ti.keepInvoice}
      variant="destructive"
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
