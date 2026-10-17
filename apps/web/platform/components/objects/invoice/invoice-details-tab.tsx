/**
 * Details tab of the invoice panel: the figures at a glance, then the header
 * fields of the old detail page (customer, dates, reference, exchange rate,
 * addresses) and the documents the invoice was created from.
 */

import type { ReactNode } from 'react';
import {
  Banknote,
  CalendarClock,
  CalendarDays,
  CircleDot,
  Coins,
  FileText,
  Hash,
  Loader2,
  Mail,
  MapPin,
  Repeat,
  Scale,
  Truck,
  User,
  Wallet,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { PanelSection } from '@/components/objects/_shared/record-panel-parts';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { isForeignCurrency } from '@/lib/weldbooks/currencies';
import { useCountryLabel } from '@/lib/weldbooks/use-country-label';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { InvoiceStatusChip } from './invoice-status';

const EMPTY = '—';

/** A credit memo says what it credits and opens that invoice in place. */
function CreditMemoNotice({
  creditNoteForInvoiceId,
  onOpenInvoice,
}: Readonly<{ creditNoteForInvoiceId?: string | null; onOpenInvoice: (id: string) => void }>) {
  const td = useDocumentTexts();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
      <span className="text-muted-foreground">{td.detail.creditMemoNote}</span>
      {creditNoteForInvoiceId ? (
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => onOpenInvoice(creditNoteForInvoiceId)}
        >
          {td.detail.viewOriginal}
        </button>
      ) : null}
    </div>
  );
}

function AddressRow({
  icon,
  label,
  lines,
}: Readonly<{ icon: typeof MapPin; label: string; lines: string[] }>) {
  if (lines.length === 0) return null;
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={lines.join(', ')}
      readOnly
      renderValue={() => (
        <span className="min-w-0">
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </span>
      )}
    />
  );
}

/** The files the invoice was created from, opened one at a time. */
function OriginalDocuments({
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
    <PanelSection title={ti.originalDocuments}>
      <div className="flex flex-wrap gap-2">
        {attachmentKeys.map((key, index) => {
          const name = key.split('/').pop() || ti.attachmentFallback.replace('{n}', String(index + 1));
          const opening = openingAttachment === index;
          return (
            <Button
              key={`${key}-${index}`}
              variant="outline"
              size="sm"
              disabled={opening}
              onClick={() => onOpen(index, name)}
            >
              {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {opening ? ti.generatingPdf : `${ti.openAttachment}: ${name}`}
            </Button>
          );
        })}
      </div>
    </PanelSection>
  );
}

export function InvoiceDetailsTab({
  invoice,
  isCreditMemo,
  openingAttachment,
  onOpenAttachment,
  onOpenInvoice,
}: Readonly<{
  invoice: InvoiceWithTax;
  isCreditMemo: boolean;
  openingAttachment: number | null;
  onOpenAttachment: (index: number, fallbackName: string) => void;
  onOpenInvoice: (id: string) => void;
}>) {
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const country = useCountryLabel();
  const { formatMoney, formatDate, formatNumber, entityCurrency } = useWeldbooksFormat();

  const billingLines = formatPostalAddressLines(normalizeAccountingAddress(invoice.billingAddress), {
    countryName: country,
  });
  const shippingLines = formatPostalAddressLines(normalizeAccountingAddress(invoice.shippingAddress), {
    countryName: country,
  });
  const hasRate = Boolean(invoice.exchangeRate) && Number(invoice.exchangeRate) > 0;
  const foreign = isForeignCurrency(entityCurrency, invoice.currency);
  const paid = Number(invoice.amountPaid ?? 0);
  const owed = Number(invoice.balanceDue ?? 0);

  let exchangeRate: ReactNode = null;
  if (foreign) {
    exchangeRate = (
      <PropertyRow
        icon={Repeat}
        label={t.accounting.documentCurrency.exchangeRate}
        value={hasRate ? `1 ${entityCurrency} = ${formatNumber(invoice.exchangeRate)} ${invoice.currency}` : null}
        placeholder={EMPTY}
        readOnly
        renderValue={(value) => <span data-testid="exchange-rate">{value}</span>}
      />
    );
  }

  return (
    <div className="@container">
      <div className="p-4 space-y-4">
        {isCreditMemo ? (
          <CreditMemoNotice
            creditNoteForInvoiceId={invoice.creditNoteForInvoiceId}
            onOpenInvoice={onOpenInvoice}
          />
        ) : null}

        <div className="space-y-1">
          <PropertyRow icon={Banknote} label={ti.total} value={formatMoney(invoice.total, invoice.currency)} readOnly />
          <PropertyRow
            icon={Wallet}
            label={isCreditMemo ? ti.creditUsed : ti.amountPaid}
            value={formatMoney(paid, invoice.currency)}
            readOnly
          />
          <PropertyRow
            icon={Scale}
            label={isCreditMemo ? ti.creditRemaining : ti.balanceDue}
            value={formatMoney(owed, invoice.currency)}
            readOnly
          />
          <PropertyRow
            icon={CircleDot}
            label={st('sweep.entities.fieldStatus')}
            value={invoice.status}
            readOnly
            renderValue={(status) => <InvoiceStatusChip status={status ?? ''} />}
          />
          <PropertyRow icon={User} label={ti.contact} value={invoice.contactName} placeholder={EMPTY} readOnly />
          <PropertyRow
            icon={Mail}
            label={st('sweep.entities.fieldEmail')}
            value={invoice.contactEmail}
            type="email"
            placeholder={EMPTY}
            readOnly
          />
          <PropertyRow
            icon={CalendarDays}
            label={ti.issueDate}
            value={formatDate(invoice.issueDate, '')}
            placeholder={EMPTY}
            readOnly
          />
          <PropertyRow
            icon={CalendarClock}
            label={ti.dueDate}
            value={formatDate(invoice.dueDate, '')}
            placeholder={EMPTY}
            readOnly
          />
          <PropertyRow icon={Hash} label={ti.reference} value={invoice.reference} placeholder={EMPTY} readOnly />
          <PropertyRow
            icon={Coins}
            label={t.accounting.documentCurrency.currency}
            value={invoice.currency ?? entityCurrency}
            placeholder={EMPTY}
            readOnly
          />
          {exchangeRate}
          <AddressRow icon={MapPin} label={ti.billTo} lines={billingLines} />
          <AddressRow icon={Truck} label={ti.shipTo} lines={shippingLines} />
        </div>

        {invoice.attachmentKeys && invoice.attachmentKeys.length > 0 ? (
          <OriginalDocuments
            attachmentKeys={invoice.attachmentKeys}
            openingAttachment={openingAttachment}
            onOpen={onOpenAttachment}
          />
        ) : null}
      </div>
    </div>
  );
}
