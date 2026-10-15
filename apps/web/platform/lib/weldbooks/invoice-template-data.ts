/**
 * The platform's side of invoice templates: turns the invoice detail payload
 * into the `InvoiceDocumentData` the template engine places, with the same
 * jurisdiction rules the fixed PDF (`./invoice-pdf`) applies — US
 * per-jurisdiction tax rows, India's HSN/SAC and place of supply, Brazil's tax
 * groups, NCM / CFOP and Pix, and the exempt-sale notice.
 */
import type { InvoiceDocumentData, LegalData, TableColumnData, TableRowData, TotalsRowData } from '@weldsuite/books-domain/invoice-template/data';
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

/** What every part of the document needs: the invoice, the labels and the formatters. */
interface DataCtx {
  invoice: LooseInvoice;
  entity: InvoicePdfEntity;
  options: InvoiceTemplateDataOptions;
  pl: InvoicePdfLabels;
  dl: InvoiceTemplateDocumentLabels;
  locale: string | undefined;
  currency: string | null;
  money: (value: string | number | null | undefined) => string;
  gst: boolean;
  br: boolean;
}

function dataCtx(invoice: InvoiceWithTax, entity: InvoicePdfEntity, options: InvoiceTemplateDataOptions): DataCtx {
  const locale = entity.locale || undefined;
  const currency = invoice.currency || entity.baseCurrency || null;
  const jurisdiction = entity.jurisdictionCode?.toUpperCase();
  return {
    invoice: invoice as LooseInvoice,
    entity,
    options,
    pl: options.pdfLabels,
    dl: options.labels,
    locale,
    currency,
    money: (value) => formatCurrency(value, currency, locale),
    gst: jurisdiction === 'IN',
    br: jurisdiction === 'BR' || Boolean(options.br),
  };
}

/** The columns the invoice can fill; an Indian tax invoice requires its HSN/SAC and tax amounts. */
function tableColumns(c: DataCtx): Partial<Record<LineItemColumnKey, TableColumnData>> {
  const { pl, dl, gst } = c;
  const items = c.invoice.items ?? [];
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
  if (gst) columns.hsnSac = { label: pl.hsnSac ?? 'HSN/SAC', required: true };
  return columns;
}

/** The line items; a Brazilian line prints its NCM / CFOP under the description. */
function tableRows(c: DataCtx): TableRowData[] {
  const { money, locale } = c;
  const percent = (value: string) => `${formatWeldbooksNumber(value, locale)}%`;
  return (c.invoice.items ?? []).map((item, i) => {
    const codes = c.br ? brLineCodes(item, c.pl) : null;
    return {
      cells: {
        index: String(i + 1),
        description: item.description,
        hsnSac: item.hsnSac ?? '',
        quantity: formatWeldbooksNumber(item.quantity ?? '1', locale),
        unit: item.unit ?? '',
        unitPrice: money(item.unitPrice),
        discount: positive(item.discountPercent) ? percent(item.discountPercent ?? '0') : '',
        taxRate: item.taxRate ? percent(item.taxRate) : '-',
        taxAmount: money(item.taxAmount),
        amount: money(item.lineTotal),
        amountWithTax: money(item.lineTotalWithTax ?? item.lineTotal),
      },
      subLines: codes ? [codes] : undefined,
    };
  });
}

/** Brazil: taxes inside the price and the CBS / IBS test amounts, for information under the total. */
function brInformationRows(c: DataCtx, brTotals: ReturnType<typeof brTotalsOf>): TotalsRowData[] {
  const groups: Array<[string | undefined, Array<{ label: string; amount: number }>]> = [
    [c.pl.br?.includedTaxes, brTotals.embedded],
    [c.pl.br?.informationalTaxes, brTotals.informational],
  ];
  return groups
    .filter(([, rows]) => rows.length > 0)
    .flatMap(([title, rows]) => [
      { label: title ?? '', value: '', kind: 'heading' as const },
      ...rows.map((row) => ({ label: row.label, value: c.money(row.amount), kind: 'muted' as const })),
    ]);
}

function totalsRows(c: DataCtx): TotalsRowData[] {
  const { invoice, pl, money } = c;
  const totals: TotalsRowData[] = [{ label: pl.subtotal, value: money(invoice.subtotal) }];
  if (positive(invoice.discountTotal)) totals.push({ label: c.dl.discount, value: '-' + money(invoice.discountTotal) });
  const brTotals = c.br ? brTotalsOf(invoice) : null;
  const taxRows = brTotals ? [...brTotals.added, ...brTotals.withheld] : taxRowsOf(invoice, pl);
  for (const row of taxRows) totals.push({ label: row.label, value: money(row.amount) });
  totals.push({ label: brTotals ? (pl.br?.netAmount ?? pl.total) : pl.total, value: money(invoice.total), kind: 'total' });
  if (positive(invoice.amountPaid)) {
    totals.push({ label: pl.paid, value: '-' + money(invoice.amountPaid), kind: 'muted' });
    totals.push({ label: pl.balanceDue, value: money(invoice.balanceDue), kind: 'balance' });
  }
  if (brTotals) totals.push(...brInformationRows(c, brTotals));
  return totals;
}

/** The exempt-sale notice, Brazil's regime statements, fiscal document and Pix. */
function legalData(c: DataCtx): LegalData {
  const { invoice, pl, options } = c;
  const notices: string[] = [];
  if (pl.exempt && hasExemptRows(invoice.taxBreakdown)) {
    notices.push(exemptNoticeText(pl.exempt, exemptReasonsOf(invoice.taxBreakdown), options.certificateNumbers ?? []));
  }
  notices.push(...(options.br?.notices ?? []));
  const fiscal = options.br?.fiscalDocument;
  const pix = options.br?.pix;
  const fiscalNumber = fiscal?.number ? (pl.br?.fiscalDocumentNumber ?? '{number}').replace('{number}', fiscal.number) : '';
  const accessKey = fiscal?.accessKey ? fiscal.accessKey.replace(/(\d{4})(?=\d)/g, '$1 ') : '';
  return {
    notices,
    fiscalDocument: fiscal
      ? [[fiscal.label, fiscalNumber].filter(Boolean).join(' '), accessKey ? `${pl.br?.accessKey ?? ''}: ${accessKey}` : ''].filter(Boolean)
      : null,
    pix: pix ? { title: pl.br?.pixPayment ?? 'Pix', key: pix.key, payload: pix.payload, matrix: pixQrMatrix(pix.payload) } : null,
  };
}

/** Bank name and IBAN / BIC, or routing and account number. */
function bankLines(c: DataCtx): string[] {
  const bank = c.entity.bankDetails;
  if (!bank) return [];
  const { pl } = c;
  const account = bank.iban
    ? [`${pl.iban}: ${bank.iban}`, bank.bic ? `${pl.bic}: ${bank.bic}` : '']
    : [bank.routingNumber ? `${pl.routingNumber}: ${bank.routingNumber}` : '', bank.accountNumber ? `${pl.accountNumber}: ${bank.accountNumber}` : ''];
  return [bank.bankName ? `${pl.bank}: ${bank.bankName}` : '', ...account].filter(Boolean);
}

interface Buyer {
  name: string;
  email: string;
}

function fieldValues(c: DataCtx, buyer: Buyer): InvoiceDocumentData['fields'] {
  const { invoice, entity, dl, money } = c;
  const formatDate = c.options.formatDate ?? defaultFormatDate(c.locale);
  const ids = entity.taxIdentifiers;
  const placeOfSupply = c.gst && invoice.placeOfSupply ? placeOfSupplyName(invoice.placeOfSupply, c.pl.outsideIndia ?? 'Outside India') : '';
  return {
    title: invoice.type === 'credit_note' ? dl.creditNote : dl.invoice,
    invoiceNumber: invoice.invoiceNumber ?? '',
    issueDate: formatDate(invoice.issueDate),
    dueDate: formatDate(invoice.dueDate),
    reference: invoice.reference ?? '',
    placeOfSupply,
    currency: c.currency ?? '',
    total: money(invoice.total),
    balanceDue: money(invoice.balanceDue ?? invoice.total),
    amountPaid: positive(invoice.amountPaid) ? money(invoice.amountPaid) : '',
    paymentTerms: invoice.paymentTermsDays ? dl.paymentTermsDays.replace('{days}', String(invoice.paymentTermsDays)) : '',
    customerName: buyer.name,
    customerEmail: buyer.email,
    customerTaxId: invoice.contactTaxNumber ?? '',
    sellerName: entity.name,
    sellerLegalName: entity.legalName || entity.name,
    sellerEmail: entity.contact?.email ?? '',
    sellerPhone: entity.contact?.phone ?? '',
    sellerWebsite: entity.contact?.website ?? '',
    sellerTaxId: ids?.vatNumber || printableEin(ids?.einOrSsn) || '',
    sellerRegistrationId: ids?.registrationNumber ?? '',
    sellerIban: entity.bankDetails?.iban ?? '',
    sellerBic: entity.bankDetails?.bic ?? '',
    footerText: entity.branding?.footerText ?? '',
  };
}

function parties(c: DataCtx, buyer: Buyer): Pick<InvoiceDocumentData, 'seller' | 'billTo' | 'shipTo'> {
  const { invoice, entity, pl } = c;
  const addressLines = (address: unknown) =>
    formatPostalAddressLines(normalizeAccountingAddress(address as never), { countryName: c.options.countryName });
  const ids = entity.taxIdentifiers;
  const sellerTaxId = ids?.vatNumber || printableEin(ids?.einOrSsn);
  const billing = normalizeAccountingAddress(invoice.billingAddress);
  const shipping = normalizeAccountingAddress(invoice.shippingAddress);
  const shipsElsewhere = shipping && JSON.stringify(shipping) !== JSON.stringify(billing);
  return {
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
      name: buyer.name,
      lines: addressLines(billing),
      contactLines: buyer.email ? [buyer.email] : [],
      // The buyer's VAT number / GSTIN as finalized: required on reverse-charge and GST invoices.
      taxIdLines: invoice.contactTaxNumber ? [`${pl.taxId}: ${invoice.contactTaxNumber}`] : [],
    },
    shipTo: shipsElsewhere ? { name: buyer.name, lines: addressLines(shipping) } : null,
  };
}

export function buildInvoiceDocumentData(
  invoice: InvoiceWithTax,
  entity: InvoicePdfEntity,
  options: InvoiceTemplateDataOptions,
  customer?: InvoiceCustomer,
): InvoiceDocumentData {
  const c = dataCtx(invoice, entity, options);
  const { pl, dl } = c;
  const buyer: Buyer = { name: customer?.name ?? invoice.contactName ?? '', email: customer?.email ?? invoice.contactEmail ?? '' };
  return {
    fields: fieldValues(c, buyer),
    fieldLabels: { ...dl.fields, placeOfSupply: pl.placeOfSupply ?? dl.fields.placeOfSupply, sellerTaxId: pl.taxId, sellerRegistrationId: pl.registrationId },
    labels: { from: dl.from, billTo: dl.billTo, shipTo: dl.shipTo, payment: dl.payment, notes: dl.notes, terms: dl.terms, page: pl.page },
    logoUrl: entity.branding?.logoUrl ?? null,
    ...parties(c, buyer),
    table: { columns: tableColumns(c), rows: tableRows(c) },
    totals: totalsRows(c),
    payment: { bankLines: bankLines(c), instructions: entity.branding?.paymentInstructions ?? null },
    notes: invoice.notes,
    terms: entity.branding?.termsAndConditions ?? null,
    legal: legalData(c),
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
