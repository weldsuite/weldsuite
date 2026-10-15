/**
 * The platform's side of invoice templates: turns the invoice detail payload
 * into the `InvoiceDocumentData` the template engine places, with the same
 * jurisdiction rules the fixed PDF (`./invoice-pdf`) applies — US
 * per-jurisdiction tax rows, India's HSN/SAC and place of supply, Brazil's tax
 * groups, NCM / CFOP and Pix, and the exempt-sale notice.
 */
import type { InvoiceDocumentData, TableColumnData, TotalsRowData } from '@weldsuite/books-domain/invoice-template/data';
import type { LineItemColumnKey } from '@weldsuite/books-domain/invoice-template/schema';
import type { TranslationNamespaces } from '@weldsuite/i18n/types';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { normalizeAccountingAddress } from './address';
import { formatWeldbooksNumber } from './format-money';
import { exemptNoticeText, exemptReasonsOf, hasExemptRows } from './document-tax';
import { placeOfSupplyName } from './gst';
import { pixQrMatrix } from './pix';
import {
  brLineCodes,
  brTotalsOf,
  defaultFormatDate,
  formatCurrency,
  printableEin,
  taxRowsOf,
  type BrInvoicePdfExtras,
  type InvoicePdfEntity,
  type InvoicePdfLabels,
} from './invoice-pdf';

export type InvoiceTemplateDocumentLabels = TranslationNamespaces['accounting']['invoiceTemplateDocument'];

export interface InvoiceTemplateDataOptions {
  /** The fixed PDF's labels: totals, bank, tax and jurisdiction wording. */
  pdfLabels: InvoicePdfLabels;
  /** Natural-case document labels of the template. */
  labels: InvoiceTemplateDocumentLabels;
  formatDate?: (value: string | null | undefined) => string;
  countryName?: (code: string) => string;
  certificateNumbers?: string[];
  br?: BrInvoicePdfExtras;
}

type InvoiceCustomer = { name?: string | null; email?: string | null } | null | undefined;

/** Fields the invoice payload carries but its type doesn't name. */
type LooseInvoice = InvoiceWithTax & { paymentTermsDays?: number | null; discountTotal?: string | null };

const positive = (value: string | number | null | undefined) => Number(value ?? 0) > 0;

export function buildInvoiceDocumentData(
  invoice: InvoiceWithTax,
  entity: InvoicePdfEntity,
  options: InvoiceTemplateDataOptions,
  customer?: InvoiceCustomer,
): InvoiceDocumentData {
  const { pdfLabels: pl, labels: dl } = options;
  const inv = invoice as LooseInvoice;
  const locale = entity.locale || undefined;
  const currency = invoice.currency || entity.baseCurrency || null;
  const money = (value: string | number | null | undefined) => formatCurrency(value, currency, locale);
  const formatDate = options.formatDate ?? defaultFormatDate(locale);
  const jurisdiction = entity.jurisdictionCode?.toUpperCase();
  const gst = jurisdiction === 'IN';
  const br = jurisdiction === 'BR' || Boolean(options.br);
  const addressLines = (address: unknown) =>
    formatPostalAddressLines(normalizeAccountingAddress(address as never), { countryName: options.countryName });

  // Seller
  const ids = entity.taxIdentifiers;
  const sellerTaxId = ids?.vatNumber || printableEin(ids?.einOrSsn);
  const bank = entity.bankDetails;

  // Buyer
  const billing = normalizeAccountingAddress(invoice.billingAddress);
  const shipping = normalizeAccountingAddress(invoice.shippingAddress);
  const buyerName = customer?.name ?? invoice.contactName ?? '';
  const buyerEmail = customer?.email ?? invoice.contactEmail ?? '';
  const shipsElsewhere = shipping && JSON.stringify(shipping) !== JSON.stringify(billing);

  // Table
  const items = invoice.items ?? [];
  const columns: Partial<Record<LineItemColumnKey, TableColumnData>> = {
    index: { label: dl.index, align: 'right' },
    description: { label: dl.description },
    quantity: { label: dl.quantity, align: 'right' },
    unitPrice: { label: dl.unitPrice, align: 'right' },
    taxRate: { label: pl.tax, align: 'right' },
    taxAmount: { label: dl.taxAmount, align: 'right', required: gst },
    amount: { label: dl.amount, align: 'right' },
    amountWithTax: { label: dl.amountWithTax, align: 'right' },
  };
  if (items.some((item) => item.unit)) columns.unit = { label: dl.unit };
  if (items.some((item) => positive(item.discountPercent))) columns.discount = { label: dl.discount, align: 'right' };
  // An Indian tax invoice names each line's HSN/SAC code.
  if (gst) columns.hsnSac = { label: pl.hsnSac ?? 'HSN/SAC', required: true };

  const rows = items.map((item, i) => {
    const codes = br ? brLineCodes(item, pl) : null;
    return {
      cells: {
        index: String(i + 1),
        description: item.description,
        hsnSac: item.hsnSac ?? '',
        quantity: formatWeldbooksNumber(item.quantity ?? '1', locale),
        unit: item.unit ?? '',
        unitPrice: money(item.unitPrice),
        discount: positive(item.discountPercent) ? `${formatWeldbooksNumber(item.discountPercent ?? '0', locale)}%` : '',
        taxRate: item.taxRate ? `${formatWeldbooksNumber(item.taxRate, locale)}%` : '-',
        taxAmount: money(item.taxAmount),
        amount: money(item.lineTotal),
        amountWithTax: money(item.lineTotalWithTax ?? item.lineTotal),
      },
      subLines: codes ? [codes] : undefined,
    };
  });

  // Totals
  const totals: TotalsRowData[] = [{ label: pl.subtotal, value: money(invoice.subtotal) }];
  if (positive(inv.discountTotal)) totals.push({ label: dl.discount, value: '-' + money(inv.discountTotal) });
  const brTotals = br ? brTotalsOf(invoice) : null;
  const taxRows = brTotals ? [...brTotals.added, ...brTotals.withheld] : taxRowsOf(invoice, pl);
  for (const row of taxRows) totals.push({ label: row.label, value: money(row.amount) });
  totals.push({ label: brTotals ? (pl.br?.netAmount ?? pl.total) : pl.total, value: money(invoice.total), kind: 'total' });
  if (positive(invoice.amountPaid)) {
    totals.push({ label: pl.paid, value: '-' + money(invoice.amountPaid), kind: 'muted' });
    totals.push({ label: pl.balanceDue, value: money(invoice.balanceDue), kind: 'balance' });
  }
  if (brTotals) {
    const info: Array<[string | undefined, Array<{ label: string; amount: number }>]> = [
      [pl.br?.includedTaxes, brTotals.embedded],
      [pl.br?.informationalTaxes, brTotals.informational],
    ];
    for (const [title, groupRows] of info) {
      if (groupRows.length === 0) continue;
      totals.push({ label: title ?? '', value: '', kind: 'heading' });
      for (const row of groupRows) totals.push({ label: row.label, value: money(row.amount), kind: 'muted' });
    }
  }

  // Legal
  const notices: string[] = [];
  if (pl.exempt && hasExemptRows(invoice.taxBreakdown)) {
    notices.push(exemptNoticeText(pl.exempt, exemptReasonsOf(invoice.taxBreakdown), options.certificateNumbers ?? []));
  }
  notices.push(...(options.br?.notices ?? []));
  const fiscal = options.br?.fiscalDocument;
  const pix = options.br?.pix;

  const placeOfSupply = gst && invoice.placeOfSupply ? placeOfSupplyName(invoice.placeOfSupply, pl.outsideIndia ?? 'Outside India') : '';
  const balanceDue = invoice.balanceDue ?? invoice.total;

  return {
    fields: {
      title: invoice.type === 'credit_note' ? dl.creditNote : dl.invoice,
      invoiceNumber: invoice.invoiceNumber ?? '',
      issueDate: formatDate(invoice.issueDate),
      dueDate: formatDate(invoice.dueDate),
      reference: invoice.reference ?? '',
      placeOfSupply,
      currency: currency ?? '',
      total: money(invoice.total),
      balanceDue: money(balanceDue),
      amountPaid: positive(invoice.amountPaid) ? money(invoice.amountPaid) : '',
      paymentTerms: inv.paymentTermsDays ? dl.paymentTermsDays.replace('{days}', String(inv.paymentTermsDays)) : '',
      customerName: buyerName,
      customerEmail: buyerEmail,
      customerTaxId: invoice.contactTaxNumber ?? '',
      sellerName: entity.name,
      sellerLegalName: entity.legalName || entity.name,
      sellerEmail: entity.contact?.email ?? '',
      sellerPhone: entity.contact?.phone ?? '',
      sellerWebsite: entity.contact?.website ?? '',
      sellerTaxId: sellerTaxId ?? '',
      sellerRegistrationId: ids?.registrationNumber ?? '',
      sellerIban: bank?.iban ?? '',
      sellerBic: bank?.bic ?? '',
      footerText: entity.branding?.footerText ?? '',
    },
    fieldLabels: { ...dl.fields, placeOfSupply: pl.placeOfSupply ?? dl.fields.placeOfSupply, sellerTaxId: pl.taxId, sellerRegistrationId: pl.registrationId },
    labels: { from: dl.from, billTo: dl.billTo, shipTo: dl.shipTo, payment: dl.payment, notes: dl.notes, terms: dl.terms, page: pl.page },
    logoUrl: entity.branding?.logoUrl ?? null,
    seller: {
      name: entity.legalName || entity.name,
      lines: addressLines(entity.address),
      contactLines: [entity.contact?.email, entity.contact?.phone, entity.contact?.website].filter((v): v is string => !!v),
      taxIdLines: [
        sellerTaxId ? `${pl.taxId}: ${sellerTaxId}` : '',
        ids?.registrationNumber ? `${pl.registrationId}: ${ids.registrationNumber}` : '',
      ].filter(Boolean),
    },
    billTo: {
      name: buyerName,
      lines: addressLines(billing),
      contactLines: buyerEmail ? [buyerEmail] : [],
      // The buyer's VAT number / GSTIN as finalized: required on reverse-charge and GST invoices.
      taxIdLines: invoice.contactTaxNumber ? [`${pl.taxId}: ${invoice.contactTaxNumber}`] : [],
    },
    shipTo: shipsElsewhere ? { name: buyerName, lines: addressLines(shipping) } : null,
    table: { columns, rows },
    totals,
    payment: {
      bankLines: bank
        ? [
            bank.bankName ? `${pl.bank}: ${bank.bankName}` : '',
            ...(bank.iban
              ? [`${pl.iban}: ${bank.iban}`, bank.bic ? `${pl.bic}: ${bank.bic}` : '']
              : [bank.routingNumber ? `${pl.routingNumber}: ${bank.routingNumber}` : '', bank.accountNumber ? `${pl.accountNumber}: ${bank.accountNumber}` : '']),
          ].filter(Boolean)
        : [],
      instructions: entity.branding?.paymentInstructions ?? null,
    },
    notes: invoice.notes,
    terms: entity.branding?.termsAndConditions ?? null,
    legal: {
      notices,
      fiscalDocument: fiscal
        ? [
            [fiscal.label, fiscal.number ? (pl.br?.fiscalDocumentNumber ?? '{number}').replace('{number}', fiscal.number) : ''].filter(Boolean).join(' '),
            fiscal.accessKey ? `${pl.br?.accessKey ?? ''}: ${fiscal.accessKey.replace(/(\d{4})(?=\d)/g, '$1 ')}` : '',
          ].filter(Boolean)
        : null,
      pix: pix ? { title: pl.br?.pixPayment ?? 'Pix', key: pix.key, payload: pix.payload, matrix: pixQrMatrix(pix.payload) } : null,
    },
    draft: invoice.status === 'draft' ? { banner: dl.draftBanner, watermark: dl.draftWatermark } : null,
  };
}

/**
 * A made-up invoice for the designer's preview, in the entity's currency and
 * wording, so a template is designed against something that looks real.
 */
export function sampleInvoice(entity: InvoicePdfEntity, opts: { rows?: number; customerName: string; descriptions: string[] }): InvoiceWithTax {
  const count = Math.max(1, opts.rows ?? 3);
  const items = Array.from({ length: count }, (_, i) => {
    const quantity = [10, 1, 4][i % 3];
    const unitPrice = [95, 1250, 180][i % 3];
    const lineTotal = quantity * unitPrice;
    return {
      id: `sample-${i}`,
      invoiceId: 'sample',
      description: opts.descriptions[i % opts.descriptions.length],
      quantity: String(quantity),
      unitPrice: unitPrice.toFixed(2),
      unit: null,
      discountPercent: null,
      taxRateId: null,
      taxRate: '21',
      taxAmount: (lineTotal * 0.21).toFixed(2),
      lineTotal: lineTotal.toFixed(2),
      lineTotalWithTax: (lineTotal * 1.21).toFixed(2),
      accountId: null,
      sortOrder: i,
      hsnSac: entity.jurisdictionCode?.toUpperCase() === 'IN' ? '998314' : null,
    };
  });
  const subtotal = items.reduce((sum, item) => sum + Number(item.lineTotal), 0);
  const tax = subtotal * 0.21;
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const due = new Date(today.getTime() + 30 * 86_400_000);
  return {
    id: 'sample',
    invoiceNumber: 'INV-0042',
    type: 'standard',
    status: 'sent',
    contactId: 'sample',
    contactName: opts.customerName,
    contactEmail: 'accounts@example.com',
    issueDate: iso(today),
    dueDate: iso(due),
    currency: entity.baseCurrency ?? 'EUR',
    subtotal: subtotal.toFixed(2),
    taxTotal: tax.toFixed(2),
    total: (subtotal + tax).toFixed(2),
    amountPaid: '0',
    balanceDue: (subtotal + tax).toFixed(2),
    reference: 'PO-7781',
    notes: null,
    internalNotes: null,
    createdAt: today.toISOString(),
    billingAddress: { line1: 'Main Street 5', postalCode: '3011 AA', city: 'Rotterdam', country: 'NL' },
    paymentTermsDays: 30,
    taxBreakdown: null,
    items,
    payments: [],
  } as unknown as InvoiceWithTax;
}
