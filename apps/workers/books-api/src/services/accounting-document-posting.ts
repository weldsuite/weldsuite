/**
 * Ledger postings for documents: which accounts an invoice, credit note,
 * bill, payment, write-off or categorized bank line debits and credits, and
 * which tax-ledger rows it writes. Everything goes through
 * `postJournalEntry`, so every document posts atomically and at most once.
 *
 *   invoice        Dr receivable (total)  /  Cr revenue per line account, Cr tax per rate
 *   US invoice     the same, with Cr tax per agency (Sales Tax Payable - <agency>) and one
 *                  tax-ledger row per jurisdiction and line, zero-tax sales included
 *   credit note    the invoice entry mirrored (US: negative tax-ledger rows)
 *   bill           Dr expense per line, Dr deductible input tax  /  Cr payable (total)
 *                  self-assessed tax (reverse charge, imports): Dr input tax / Cr tax payable
 *                  non-deductible tax (NL KOR) is added to the line's expense
 *   US bill        tax the vendor charged is part of each line's expense or asset (the
 *                  adapter's purchaseTax 'cost'), no tax-ledger rows for it; use tax accrued
 *                  on a line: Dr the line's account / Cr Use Tax Payable - <agency>, one
 *                  'use' tax-ledger row per jurisdiction
 *   payment in     Dr bank  /  Cr receivable per allocation (unallocated stays on the receivable)
 *   payment out    Dr payable per allocation  /  Cr bank
 *   write-off      Dr bad debts  /  Cr receivable (open balance)
 *                  US invoice with tax: the tax share of the open balance is Dr the agency's
 *                  payable instead, with negative write_off tax-ledger rows per jurisdiction
 *   bank line      Dr/Cr bank against a category account, tax split out when a rate is given
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isKorActive } from '@weldsuite/books-domain/accounting-guards';
import { getAdapter, hasAdapter } from '@weldsuite/books-domain/jurisdictions/registry';
import {
  allocateCents,
  breakdownToTaxLineFields,
  fromCents,
  roundHalfUp,
  toCents,
  zip5Of,
} from '@weldsuite/books-domain/sales-tax';
import { pickShipTo } from './sales-tax/document-tax';
import { toBaseCurrency } from './accounting-currency';
import { parseRate, requireBookingRate } from './accounting-fx';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  PostingError,
  roundMoney,
  type EntityAccounts,
  type PostedEntry,
  type PostingLine,
  type PostingTaxLine,
} from './accounting-posting';

type InvoiceRow = typeof schema.invoices.$inferSelect;
type InvoiceItemRow = typeof schema.invoiceItems.$inferSelect;
type BillRow = typeof schema.bills.$inferSelect;
type BillItemRow = typeof schema.billItems.$inferSelect;
type EntityRow = typeof schema.entities.$inferSelect;
export type TaxRateRow = typeof schema.taxRates.$inferSelect;
export type BreakdownRow = NonNullable<InvoiceRow['taxBreakdown']>[number];

/** Legacy fallbacks for entities seeded before a role existed (NL / IN template codes). */
export const FALLBACK_CODES = {
  accounts_receivable: ['1300'],
  accounts_payable: ['1600'],
  sales_revenue: ['8000'],
  tax_payable: ['1700'],
  tax_input: ['1730'],
  general_expense: ['4600'],
};

export async function loadEntity(db: Database, entityId: string): Promise<EntityRow> {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new PostingError('Accounting entity not found');
  return entity;
}

export async function loadTaxRates(db: Database, entityId: string, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, TaxRateRow>();
  const rows = await db
    .select()
    .from(schema.taxRates)
    .where(and(eq(schema.taxRates.entityId, entityId), inArray(schema.taxRates.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadParty(db: Database, partyId: string | null | undefined) {
  if (!partyId) return undefined;
  const [party] = await db
    .select({
      defaultRevenueAccountId: schema.parties.defaultRevenueAccountId,
      defaultExpenseAccountId: schema.parties.defaultExpenseAccountId,
    })
    .from(schema.parties)
    .where(eq(schema.parties.id, partyId))
    .limit(1);
  return party;
}

/**
 * Converts document-currency amounts to the entity's base currency (rate: foreign
 * units per base unit). A foreign document without a usable rate is an error:
 * amounts are never carried over 1:1 across currencies.
 */
export function baseConverter(entity: EntityRow, currency: string | null | undefined, exchangeRate: string | null | undefined) {
  if (!currency || currency === entity.baseCurrency) return (amount: number) => roundMoney(amount);
  const rate = parseRate(exchangeRate);
  if (!rate) {
    throw new PostingError(
      `The exchange rate for ${currency} against ${entity.baseCurrency} is missing. Enter an exchange rate or add one under FX rates.`,
    );
  }
  return (amount: number) => toBaseCurrency(amount, rate);
}

export function requireAccount(
  account: { id: string } | undefined,
  message: string,
): string {
  if (!account) throw new PostingError(message);
  return account.id;
}

/** Account for a breakdown row's tax: component role (India), the rate's ledger account, else the role for the direction. */
export function taxAccountFor(
  accounts: EntityAccounts,
  row: BreakdownRow,
  rate: TaxRateRow | undefined,
  direction: 'sales' | 'purchase',
): string {
  const component = row.accountRole ? accounts.byRole(row.accountRole) : undefined;
  if (component) return component.id;
  const ledger = accounts.byId(rate?.ledgerAccountId);
  if (ledger) return ledger.id;
  // The US chart has no tax_payable / tax_input roles, only sales and use tax payable.
  const byDirection =
    direction === 'purchase'
      ? accountForRole(accounts, 'tax_input', FALLBACK_CODES.tax_input) ??
        accountForRole(accounts, 'tax_payable', FALLBACK_CODES.tax_payable) ??
        accountForRole(accounts, 'sales_tax_payable')
      : accountForRole(accounts, 'tax_payable', FALLBACK_CODES.tax_payable) ??
        accountForRole(accounts, 'sales_tax_payable');
  return requireAccount(byDirection, 'No tax account found. Link the tax rate to a ledger account or add a tax payable account.');
}

/** The account holding a system role (BR tax rows name theirs); a missing one is a setup error. */
function roleAccount(accounts: EntityAccounts, role: string | undefined, what: string): string {
  return requireAccount(
    role ? accounts.byRole(role) : undefined,
    `No account with the role ${role ?? '(none)'} for "${what}". Add it to the chart of accounts.`,
  );
}

export function breakdownToTaxLine(
  row: BreakdownRow,
  rate: TaxRateRow | undefined,
  args: {
    direction: 'sales' | 'purchase';
    sign: 1 | -1;
    currency: string;
    toBase: (amount: number) => number;
    contactId: string | null;
  },
): PostingTaxLine {
  const taxable = row.taxableAmount * args.sign;
  const tax = row.taxAmount * args.sign;
  return {
    direction: args.direction,
    taxRateId: row.taxRateId || null,
    taxRateName: row.taxRateName ?? rate?.name ?? null,
    taxCategoryCode: row.taxCategoryCode ?? rate?.taxCategoryCode ?? null,
    rate: row.taxRate,
    component: row.component ?? null,
    selfAssessed: row.selfAssessed ?? false,
    taxableAmount: taxable,
    taxAmount: tax,
    currency: args.currency,
    baseTaxableAmount: args.toBase(taxable),
    baseTaxAmount: args.toBase(tax),
    contactId: args.contactId,
  };
}

// ---------------------------------------------------------------------------
// US sales tax: agencies, accounts, tax-ledger rows
// ---------------------------------------------------------------------------

interface AgencyAccounts {
  name: string;
  liabilityAccountId: string | null;
  useTaxAccountId: string | null;
}

async function loadAgencyAccounts(db: Database, entityId: string): Promise<Map<string, AgencyAccounts>> {
  const rows = await db
    .select({
      id: schema.salesTaxAgencies.id,
      name: schema.salesTaxAgencies.name,
      liabilityAccountId: schema.salesTaxAgencies.liabilityAccountId,
      useTaxAccountId: schema.salesTaxAgencies.useTaxAccountId,
    })
    .from(schema.salesTaxAgencies)
    .where(eq(schema.salesTaxAgencies.entityId, entityId));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The agency's Sales Tax Payable child account, else the Sales Tax Payable role account (a row with no agency: unregistered, marketplace). */
function salesTaxAccountFor(accounts: EntityAccounts, agencies: Map<string, AgencyAccounts>, agencyId: string | undefined): string {
  const own = agencyId ? accounts.byId(agencies.get(agencyId)?.liabilityAccountId) : undefined;
  if (own) return own.id;
  return requireAccount(
    accountForRole(accounts, 'sales_tax_payable', ['2200']),
    'No Sales Tax Payable account found. Add the agency in the sales tax settings first.',
  );
}

function useTaxAccountFor(accounts: EntityAccounts, agencies: Map<string, AgencyAccounts>, agencyId: string | undefined): string {
  const own = agencyId ? accounts.byId(agencies.get(agencyId)?.useTaxAccountId) : undefined;
  if (own) return own.id;
  return requireAccount(
    accountForRole(accounts, 'use_tax_payable', ['2210']),
    'No Use Tax Payable account found for this entity.',
  );
}

/**
 * Tax-ledger rows for US breakdown rows: one per jurisdiction and line, zero-tax
 * ones included, so gross sales, exempt sales and nexus see every sale.
 * `sign` -1 writes a credit memo's rows (positive on the document) as negatives.
 */
export function usTaxLines(
  rows: BreakdownRow[],
  args: {
    sign: 1 | -1;
    direction: 'sales' | 'use';
    currency: string;
    toBase: (amount: number) => number;
    contactId: string | null;
    marketplaceFacilitated?: boolean | null;
    shipToState?: string | null;
    shipToPostalCode?: string | null;
    engine?: string | null;
    engineRef?: string | null;
  },
): PostingTaxLine[] {
  const fields = breakdownToTaxLineFields(rows, {
    sign: args.sign,
    direction: args.direction,
    marketplaceFacilitated: Boolean(args.marketplaceFacilitated),
    shipToState: args.shipToState,
    shipToPostalCode: args.shipToPostalCode,
    engine: args.engine,
    engineRef: args.engineRef,
  });
  return rows.map((row, i) => {
    const f = fields[i];
    const taxable = row.taxableAmount * args.sign;
    const tax = row.taxAmount * args.sign;
    return {
      sourceLineId: f.sourceLineId ?? null,
      direction: args.direction,
      taxRateId: null,
      taxRateName: f.taxRateName ?? null,
      rate: row.taxRate,
      selfAssessed: row.selfAssessed ?? false,
      jurisdictionCode: f.jurisdictionCode ?? null,
      jurisdictionLevel: f.jurisdictionLevel ?? null,
      stateCode: f.stateCode ?? null,
      taxableAmount: taxable,
      taxAmount: tax,
      currency: args.currency,
      baseTaxableAmount: args.toBase(taxable),
      baseTaxAmount: args.toBase(tax),
      contactId: args.contactId,
      extra: {
        agencyId: f.agencyId ?? null,
        jurisdictionName: f.jurisdictionName ?? null,
        reportingCode: f.reportingCode ?? null,
        grossAmount: f.grossAmount ?? null,
        exemptAmount: f.exemptAmount ?? null,
        nonTaxableAmount: f.nonTaxableAmount ?? null,
        exemptReason: f.exemptReason ?? null,
        certificateId: f.certificateId ?? null,
        shipToState: f.shipToState ?? null,
        shipToPostalCode: f.shipToPostalCode ?? null,
        taxCode: f.taxCode ?? null,
        marketplaceFacilitated: f.marketplaceFacilitated ?? false,
        unroundedTaxAmount: f.unroundedTaxAmount ?? null,
        engine: f.engine ?? null,
        engineRef: f.engineRef ?? null,
      },
    };
  });
}

/** An entity whose adapter posts supplier tax into the cost (US). */
function purchaseTaxIsCost(entity: EntityRow): boolean {
  return hasAdapter(entity.jurisdictionCode) && getAdapter(entity.jurisdictionCode).purchaseTax === 'cost';
}

/** Journal amounts per account and reporting dimensions, so a class or location splits the line. */
class DimensionedAmounts {
  private readonly amounts = new Map<string, { accountId: string; classId: string | null; locationId: string | null; amount: number }>();

  add(accountId: string, amount: number, dims: { classId?: string | null; locationId?: string | null }) {
    const classId = dims.classId ?? null;
    const locationId = dims.locationId ?? null;
    const key = `${accountId}|${classId ?? ''}|${locationId ?? ''}`;
    const existing = this.amounts.get(key);
    if (existing) existing.amount += amount;
    else this.amounts.set(key, { accountId, classId, locationId, amount });
  }

  entries() {
    return [...this.amounts.values()];
  }
}

/**
 * Brazil: what a bill's taxes do to the cost of its lines. A credit inside the
 * price (ICMS, PIS/COFINS a recuperar) comes out of the cost, because it is
 * booked as a receivable instead; a tax on top of the price that can't be
 * credited (IPI for a reseller) goes into it. Each row is spread over the lines
 * of its rate in proportion to their amounts, to the cent.
 */
function adjustBrPurchaseCost(
  expenses: DimensionedAmounts,
  breakdown: BreakdownRow[],
  items: BillItemRow[],
  accountOf: (item: BillItemRow) => string | undefined,
): void {
  for (const row of breakdown) {
    let direction = 0;
    if (row.treatment === 'embedded' && row.accountRole) direction = -1;
    else if (row.treatment === 'added' && !row.accountRole) direction = 1;
    if (direction === 0 || row.taxAmount === 0) continue;
    const lines = items.filter((item) => (item.taxRateId ?? '') === row.taxRateId);
    if (lines.length === 0) continue;
    const parts = allocateCents(
      toCents(row.taxAmount),
      lines.map((item) => Number.parseFloat(item.lineTotal ?? '0')),
    );
    lines.forEach((item, i) => {
      const accountId = accountOf(item);
      if (accountId) expenses.add(accountId, direction * fromCents(parts[i]), item);
    });
  }
}

type AccountRow = typeof schema.accounts.$inferSelect;

/** Where the tax rows of an invoice or bill are posted, and how their amounts convert. */
interface TaxPosting {
  accounts: EntityAccounts;
  rates: Map<string, TaxRateRow>;
  sign: 1 | -1;
  currency: string;
  toBase: (amount: number) => number;
  contactId: string | null;
  /** The document number, appended to line descriptions. */
  documentNumber: string | null;
  meta: { currency: string; exchangeRate: string; contactId: string | null };
  lines: PostingLine[];
  taxLines: PostingTaxLine[];
}

function rowTaxLine(row: BreakdownRow, rate: TaxRateRow | undefined, posting: TaxPosting, direction: 'sales' | 'purchase'): PostingTaxLine {
  const { sign, currency, toBase, contactId } = posting;
  return breakdownToTaxLine(row, rate, { direction, sign, currency, toBase, contactId });
}

// ---------------------------------------------------------------------------
// Invoices and credit notes
// ---------------------------------------------------------------------------

/** Revenue per account and dimensions: the line's own account, else the invoice's default. */
function invoiceRevenue(items: InvoiceItemRow[], accounts: EntityAccounts, defaultRevenue: AccountRow | undefined): DimensionedAmounts {
  const revenue = new DimensionedAmounts();
  for (const item of items) {
    if (item.accountId && !accounts.byId(item.accountId)) {
      throw new PostingError(`Line account ${item.accountId} does not belong to this accounting entity`);
    }
    const accountId = requireAccount(
      accounts.byId(item.accountId) ?? defaultRevenue,
      'No revenue account found. Choose a revenue account on the invoice line.',
    );
    revenue.add(accountId, Number.parseFloat(item.lineTotal ?? '0'), item);
  }
  return revenue;
}

/** US sales tax: a credit per agency's payable account, and the per-jurisdiction tax-ledger rows. */
async function postInvoiceSalesTax(db: Database, invoice: InvoiceRow, breakdown: BreakdownRow[], posting: TaxPosting): Promise<void> {
  const { accounts, sign, currency, toBase, meta, lines, taxLines } = posting;
  const agencies = await loadAgencyAccounts(db, invoice.entityId);
  const payable = new Map<string, { accountId: string; amount: number; label: string }>();
  for (const row of breakdown) {
    if (row.taxAmount === 0) continue;
    const accountId = salesTaxAccountFor(accounts, agencies, row.agencyId);
    const label = row.agencyId ? (agencies.get(row.agencyId)?.name ?? 'Sales tax') : 'Sales tax';
    const existing = payable.get(accountId);
    if (existing) existing.amount += row.taxAmount;
    else payable.set(accountId, { accountId, amount: row.taxAmount, label });
  }
  for (const { accountId, amount, label } of payable.values()) {
    lines.push({
      accountId,
      credit: toBase(amount * sign),
      description: `Sales tax ${label} ${invoice.invoiceNumber ?? ''}`.trim(),
      taxAmount: toBase(amount * sign),
      ...meta,
    });
  }
  taxLines.push(
    ...usTaxLines(breakdown, {
      sign,
      direction: 'sales',
      currency,
      toBase,
      contactId: invoice.contactId,
      marketplaceFacilitated: invoice.marketplaceFacilitated,
      shipToState: breakdown.find((r) => r.stateCode)?.stateCode ?? null,
      shipToPostalCode: pickShipToZip(invoice),
      engine: invoice.taxEngine,
      engineRef: invoice.taxEngineRef,
    }),
  );
}

/** Tax rows with a rate (or a BR withholding) on an invoice: journal lines and tax-ledger rows. */
function postInvoiceRateTax(breakdown: BreakdownRow[], posting: TaxPosting): void {
  for (const row of breakdown) {
    const rate = posting.rates.get(row.taxRateId);
    if (row.treatment === 'informational') {
      // BR CBS/IBS of the 2026 test year: on the tax ledger for the worksheet, nothing in the journal.
      posting.taxLines.push(rowTaxLine(row, rate, posting, 'sales'));
      continue;
    }
    if (row.taxAmount !== 0) posting.lines.push(...invoiceTaxRowLines(row, rate, posting));
    // Withholdings are document-level (no rate) but still reach the tax ledger.
    if (row.taxRateId || row.treatment === 'withheld') {
      posting.taxLines.push(rowTaxLine(row, rate, posting, 'sales'));
    }
  }
}

/** The journal lines of an invoice tax row with a non-zero amount. */
function invoiceTaxRowLines(row: BreakdownRow, rate: TaxRateRow | undefined, posting: TaxPosting): PostingLine[] {
  const { accounts, meta } = posting;
  const description = `${row.taxRateName ?? 'Tax'} ${posting.documentNumber ?? ''}`.trim();
  const amount = posting.toBase(row.taxAmount * posting.sign);
  if (row.treatment === 'withheld') {
    // Kept back by the customer: a receivable from the tax authority (or less tax of our own) instead of from the customer.
    return [{ accountId: roleAccount(accounts, row.accountRole, description), debit: amount, description, ...meta }];
  }
  if (row.treatment === 'embedded') {
    // Inside the price: a deduction from revenue against the tax payable.
    return [
      { accountId: roleAccount(accounts, row.offsetAccountRole, description), debit: amount, description, ...meta },
      {
        accountId: roleAccount(accounts, row.accountRole, description),
        credit: amount,
        description,
        taxRateId: row.taxRateId || null,
        taxAmount: amount,
        ...meta,
      },
    ];
  }
  return [
    {
      accountId: taxAccountFor(accounts, row, rate, 'sales'),
      credit: amount,
      description,
      taxRateId: row.taxRateId || null,
      taxAmount: amount,
      ...meta,
    },
  ];
}

export async function buildInvoicePosting(
  db: Database,
  invoice: InvoiceRow,
  items: InvoiceItemRow[],
): Promise<{ lines: PostingLine[]; taxLines: PostingTaxLine[]; exchangeRate: string }> {
  const entity = await loadEntity(db, invoice.entityId);
  const accounts = await loadEntityAccounts(db, invoice.entityId);
  const breakdown = (invoice.taxBreakdown ?? []) as BreakdownRow[];
  // A US document calculated by the sales tax engine: tax per jurisdiction and agency, no rate rows.
  const salesTax = Boolean(invoice.taxEngine);
  const rates = salesTax ? new Map<string, TaxRateRow>() : await loadTaxRates(db, invoice.entityId, breakdown.map((r) => r.taxRateId));
  const party = await loadParty(db, invoice.contactId);

  const sign: 1 | -1 = invoice.type === 'credit_note' ? -1 : 1;
  const currency = invoice.currency || entity.baseCurrency;
  // The rate on the document, or the one for its date; refuses to go on without one.
  const exchangeRate = await requireBookingRate(db, {
    baseCurrency: entity.baseCurrency,
    currency: invoice.currency,
    date: invoice.issueDate,
    stored: invoice.exchangeRate,
  });
  const toBase = baseConverter(entity, invoice.currency, exchangeRate);
  const meta = { currency, exchangeRate, contactId: invoice.contactId };

  const defaultRevenue =
    accounts.byId(invoice.revenueAccountId) ??
    accounts.byId(party?.defaultRevenueAccountId) ??
    accountForRole(accounts, 'sales_revenue', FALLBACK_CODES.sales_revenue);
  if (invoice.revenueAccountId && !accounts.byId(invoice.revenueAccountId)) {
    throw new PostingError('revenueAccountId does not belong to this accounting entity');
  }

  const revenue = invoiceRevenue(items, accounts, defaultRevenue);

  const lines: PostingLine[] = [];
  for (const { accountId, classId, locationId, amount } of revenue.entries()) {
    lines.push({
      accountId,
      credit: toBase(amount * sign),
      description: `Revenue ${invoice.invoiceNumber ?? ''}`.trim(),
      classId,
      locationId,
      ...meta,
    });
  }

  const posting: TaxPosting = {
    accounts,
    rates,
    sign,
    currency,
    toBase,
    contactId: invoice.contactId,
    documentNumber: invoice.invoiceNumber,
    meta,
    lines,
    taxLines: [],
  };
  if (salesTax) {
    await postInvoiceSalesTax(db, invoice, breakdown, posting);
  } else {
    postInvoiceRateTax(breakdown, posting);
  }
  const { taxLines } = posting;

  // The receivable balances the entry: what was credited less what was debited (BR deductions, withholdings).
  const receivable = roundMoney(lines.reduce((sum, l) => sum + (l.credit ?? 0) - (l.debit ?? 0), 0));
  lines.unshift({
    accountId: requireAccount(
      accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable),
      'No accounts receivable account found for this entity.',
    ),
    debit: receivable,
    description: `${invoice.type === 'credit_note' ? 'Credit note' : 'Invoice'} ${invoice.invoiceNumber ?? ''}`.trim(),
    ...meta,
  });

  return { lines, taxLines, exchangeRate };
}

/** The ship-to ZIP stored with a US document's tax rows: the shipping address, else the billing address. */
function pickShipToZip(invoice: InvoiceRow): string | null {
  return zip5Of(pickShipTo(invoice.shippingAddress, invoice.billingAddress)) ?? null;
}

/**
 * Post a draft invoice or credit note. It becomes 'finalized' (in the ledger, locked, not yet
 * sent) or, with `markSent`, 'sent' (the send route and auto-sending recurring invoices).
 */
export async function postInvoice(
  db: Database,
  invoice: InvoiceRow,
  items: InvoiceItemRow[],
  opts: {
    userId: string | null;
    markSent?: boolean;
    keepStatus?: boolean;
    /** Facts stored on the invoice when it is booked: the buyer's tax id and (India) the place of supply. */
    snapshot?: { contactTaxNumber?: string | null; placeOfSupply?: string | null };
  },
): Promise<PostedEntry> {
  const { lines, taxLines, exchangeRate } = await buildInvoicePosting(db, invoice, items);
  const isCreditNote = invoice.type === 'credit_note';
  const now = new Date();
  return postJournalEntry(db, {
    entityId: invoice.entityId,
    date: invoice.issueDate,
    description: `${isCreditNote ? 'Credit note' : 'Invoice'} ${invoice.invoiceNumber ?? ''} - ${invoice.contactName ?? ''}`.trim(),
    reference: invoice.reference,
    sourceType: isCreditNote ? 'credit_note' : 'invoice',
    sourceId: invoice.id,
    postingKey: `invoice:${invoice.id}:issue`,
    lockKind: 'sales',
    lines,
    taxLines,
    createdBy: opts.userId,
    alsoWrite: (h, posted) => [
      h
        .update(schema.invoices)
        .set({
          // The catch-up books invoices that are already sent or paid: their status stays.
          ...(opts.keepStatus ? {} : { status: opts.markSent ? 'sent' : 'finalized' }),
          // The rate the entry was posted at stays on the document.
          exchangeRate,
          journalEntryId: posted.journalEntryId,
          ...(opts.snapshot ?? {}),
          ...(opts.markSent ? { sentAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(schema.invoices.id, invoice.id)),
    ],
  });
}

/**
 * The tax part of a write-off, per jurisdiction: the open share of each taxed
 * row, as the negative rows of a bad debt (the next return deducts them). The
 * tax parts add up to the open share of the invoice's tax, to the cent.
 */
export function writeOffTaxRows(invoice: InvoiceRow): { rows: BreakdownRow[]; taxCents: number } {
  const total = Number.parseFloat(invoice.total ?? '0');
  const open = Number.parseFloat(invoice.balanceDue ?? '0');
  const taxed = ((invoice.taxBreakdown ?? []) as BreakdownRow[]).filter((r) => r.taxAmount !== 0);
  if (total <= 0 || open <= 0 || taxed.length === 0) return { rows: [], taxCents: 0 };

  const share = Math.min(1, open / total);
  const invoiceTaxCents = taxed.reduce((sum, r) => sum + toCents(r.taxAmount), 0);
  const taxCents = Math.round(invoiceTaxCents * share);
  const parts = allocateCents(taxCents, taxed.map((r) => r.taxAmount));
  const rows = taxed.map((row, i): BreakdownRow => {
    const tax = fromCents(parts[i]);
    return {
      ...row,
      taxableAmount: roundHalfUp(row.taxableAmount * share),
      taxAmount: tax,
      unroundedTaxAmount: tax,
      exemptAmount: 0,
      nonTaxableAmount: 0,
    };
  });
  return { rows, taxCents };
}

/** Write an invoice's open balance off to bad debts. */
export async function postInvoiceWriteOff(
  db: Database,
  invoice: InvoiceRow,
  opts: { userId: string | null; date?: Date },
): Promise<PostedEntry> {
  const entity = await loadEntity(db, invoice.entityId);
  const accounts = await loadEntityAccounts(db, invoice.entityId);
  const toBase = baseConverter(entity, invoice.currency, invoice.exchangeRate);
  const open = toBase(Number.parseFloat(invoice.balanceDue ?? '0'));
  const badDebt =
    accountForRole(accounts, 'bad_debt_expense') ??
    accountForRole(accounts, 'general_expense', FALLBACK_CODES.general_expense);
  const meta = { currency: invoice.currency, exchangeRate: invoice.exchangeRate ?? '1', contactId: invoice.contactId };
  const now = opts.date ?? new Date();

  // US sales tax already booked on the invoice comes back off the agency's payable: the bad debt is only the net.
  const writeOff =
    invoice.taxEngine && invoice.type !== 'credit_note' ? writeOffTaxRows(invoice) : { rows: [] as BreakdownRow[], taxCents: 0 };
  const taxLines: PostingTaxLine[] = [];
  const taxDebits: PostingLine[] = [];
  if (writeOff.rows.length > 0) {
    const agencies = await loadAgencyAccounts(db, invoice.entityId);
    const byAccount = new Map<string, number>();
    for (const row of writeOff.rows) {
      const accountId = salesTaxAccountFor(accounts, agencies, row.agencyId);
      byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + row.taxAmount);
    }
    for (const [accountId, amount] of byAccount) {
      taxDebits.push({
        accountId,
        debit: toBase(amount),
        description: `Sales tax written off ${invoice.invoiceNumber ?? ''}`.trim(),
        ...meta,
      });
    }
    taxLines.push(
      ...usTaxLines(writeOff.rows, {
        sign: -1,
        direction: 'sales',
        currency: invoice.currency || entity.baseCurrency,
        toBase,
        contactId: invoice.contactId,
        marketplaceFacilitated: invoice.marketplaceFacilitated,
        shipToState: writeOff.rows.find((r) => r.stateCode)?.stateCode ?? null,
        shipToPostalCode: pickShipToZip(invoice),
        engine: invoice.taxEngine,
        engineRef: invoice.taxEngineRef,
      }),
    );
  }
  const taxBase = roundMoney(taxDebits.reduce((sum, l) => sum + (l.debit ?? 0), 0));

  return postJournalEntry(db, {
    entityId: invoice.entityId,
    date: now,
    description: `Write-off ${invoice.invoiceNumber ?? ''} - ${invoice.contactName ?? ''}`.trim(),
    sourceType: 'write_off',
    sourceId: invoice.id,
    postingKey: `invoice:${invoice.id}:write_off`,
    lockKind: 'sales',
    lines: [
      {
        accountId: requireAccount(badDebt, 'No bad-debt or general expense account found for this entity.'),
        debit: roundMoney(open - taxBase),
        description: `Bad debt ${invoice.invoiceNumber ?? ''}`.trim(),
        ...meta,
      },
      ...taxDebits,
      {
        accountId: requireAccount(
          accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable),
          'No accounts receivable account found for this entity.',
        ),
        credit: open,
        description: `Write-off ${invoice.invoiceNumber ?? ''}`.trim(),
        ...meta,
      },
    ],
    taxLines,
    createdBy: opts.userId,
    alsoWrite: (h) => [
      h
        .update(schema.invoices)
        .set({ status: 'uncollectible', balanceDue: '0.00', updatedAt: new Date() })
        .where(eq(schema.invoices.id, invoice.id)),
    ],
  });
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

/** Expense per account and dimensions; supplier tax that can't be deducted is part of the line's cost. */
function billExpenses(
  items: BillItemRow[],
  accounts: EntityAccounts,
  defaultExpense: AccountRow | undefined,
  taxDeductible: boolean,
): DimensionedAmounts {
  const expenses = new DimensionedAmounts();
  for (const item of items) {
    if (item.accountId && !accounts.byId(item.accountId)) {
      throw new PostingError(`Line account ${item.accountId} does not belong to this accounting entity`);
    }
    const accountId = requireAccount(
      accounts.byId(item.accountId) ?? defaultExpense,
      'No expense account found. Choose an expense account on each bill line.',
    );
    const net = Number.parseFloat(item.lineTotal ?? '0');
    const tax = taxDeductible ? 0 : Number.parseFloat(item.taxAmount ?? '0');
    expenses.add(accountId, net + tax, item);
  }
  return expenses;
}

/** Use tax the buyer accrues: Dr the line's expense or asset, Cr the agency's Use Tax Payable. */
async function postBillUseTax(
  db: Database,
  bill: BillRow,
  useRows: BreakdownRow[],
  items: BillItemRow[],
  defaultExpense: AccountRow | undefined,
  posting: TaxPosting,
): Promise<void> {
  const { accounts, sign, currency, toBase, meta, lines, taxLines } = posting;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const agencies = await loadAgencyAccounts(db, bill.entityId);
  const accrued = new DimensionedAmounts();
  const owed = new Map<string, number>();
  for (const row of useRows) {
    if (row.taxAmount === 0) continue;
    const item = row.lineId ? itemById.get(row.lineId) : undefined;
    const expenseAccount = requireAccount(accounts.byId(item?.accountId) ?? defaultExpense, 'No expense account found for use tax.');
    accrued.add(expenseAccount, row.taxAmount, item ?? {});
    const payable = useTaxAccountFor(accounts, agencies, row.agencyId);
    owed.set(payable, (owed.get(payable) ?? 0) + row.taxAmount);
  }
  for (const { accountId, classId, locationId, amount } of accrued.entries()) {
    lines.push({ accountId, debit: toBase(amount * sign), description: `Use tax ${bill.billNumber ?? ''}`.trim(), classId, locationId, ...meta });
  }
  for (const [accountId, amount] of owed) {
    lines.push({
      accountId,
      credit: toBase(amount * sign),
      description: `Use tax ${bill.billNumber ?? ''}`.trim(),
      taxAmount: toBase(amount * sign),
      ...meta,
    });
  }
  taxLines.push(
    ...usTaxLines(useRows, {
      sign,
      direction: 'use',
      currency,
      toBase,
      contactId: bill.contactId,
      shipToState: useRows.find((r) => r.stateCode)?.stateCode ?? null,
      shipToPostalCode: zip5Of(pickShipTo(bill.deliveryAddress)) ?? null,
      engine: null,
      engineRef: null,
    }),
  );
}

/** One non-use tax row of a bill: its journal lines and, when it counts, its tax-ledger row. */
function postBillTaxRow(row: BreakdownRow, posting: TaxPosting, taxDeductible: boolean, defaultExpense: AccountRow | undefined): void {
  const rate = posting.rates.get(row.taxRateId);
  if (row.treatment && row.treatment !== 'added') {
    postBrBillTaxRow(row, rate, posting);
    return;
  }
  if (row.treatment === 'added' && !row.accountRole) return; // BR tax without a credit: part of the cost
  if (row.selfAssessed) {
    // Owed and deducted by the buyer itself: both legs, nothing to the supplier.
    if (row.taxAmount !== 0) posting.lines.push(...selfAssessedTaxLines(row, rate, posting, taxDeductible, defaultExpense));
  } else if (taxDeductible && row.taxAmount !== 0) {
    posting.lines.push({
      accountId: taxAccountFor(posting.accounts, row, rate, 'purchase'),
      debit: posting.toBase(row.taxAmount * posting.sign),
      description: `${row.taxRateName ?? 'Tax'} ${posting.documentNumber ?? ''}`.trim(),
      taxRateId: row.taxRateId || null,
      taxAmount: posting.toBase(row.taxAmount * posting.sign),
      ...posting.meta,
    });
  }
  if (row.taxRateId && taxDeductible) {
    posting.taxLines.push(rowTaxLine(row, rate, posting, 'purchase'));
  }
}

/** Brazil: a credit inside the price (Dr recoverable, already taken out of the cost) or a withholding (Cr payable). */
function postBrBillTaxRow(row: BreakdownRow, rate: TaxRateRow | undefined, posting: TaxPosting): void {
  if (row.treatment === 'informational' || !row.accountRole || row.taxAmount === 0) return;
  const { meta } = posting;
  const description = `${row.taxRateName ?? 'Tax'} ${posting.documentNumber ?? ''}`.trim();
  const amount = posting.toBase(row.taxAmount * posting.sign);
  const accountId = roleAccount(posting.accounts, row.accountRole, description);
  posting.lines.push(
    row.treatment === 'withheld'
      ? { accountId, credit: amount, description, ...meta }
      : { accountId, debit: amount, description, taxRateId: row.taxRateId || null, taxAmount: amount, ...meta },
  );
  posting.taxLines.push(rowTaxLine(row, rate, posting, 'purchase'));
}

/** Both legs of a self-assessed tax row: the deduction (or the cost, when not deductible) and the tax payable. */
function selfAssessedTaxLines(
  row: BreakdownRow,
  rate: TaxRateRow | undefined,
  posting: TaxPosting,
  taxDeductible: boolean,
  defaultExpense: AccountRow | undefined,
): PostingLine[] {
  const { accounts, meta } = posting;
  const documentNumber = posting.documentNumber ?? '';
  const amount = posting.toBase(row.taxAmount * posting.sign);
  const lines: PostingLine[] = [];
  if (taxDeductible) {
    lines.push({
      accountId: taxAccountFor(accounts, row, rate, 'purchase'),
      debit: amount,
      description: `${row.taxRateName ?? 'Tax'} (self-assessed) ${documentNumber}`.trim(),
      taxRateId: row.taxRateId || null,
      taxAmount: amount,
      ...meta,
    });
  } else {
    lines.push({
      accountId: requireAccount(defaultExpense, 'No expense account found for non-deductible tax.'),
      debit: amount,
      description: `${row.taxRateName ?? 'Tax'} (self-assessed, not deductible) ${documentNumber}`.trim(),
      ...meta,
    });
  }
  lines.push({
    accountId: requireAccount(
      accountForRole(accounts, 'tax_payable', FALLBACK_CODES.tax_payable) ??
        accountForRole(accounts, 'use_tax_payable') ??
        accountForRole(accounts, 'sales_tax_payable'),
      'No tax payable account found for this entity.',
    ),
    credit: amount,
    description: `${row.taxRateName ?? 'Tax'} (self-assessed) ${documentNumber}`.trim(),
    taxRateId: row.taxRateId || null,
    taxAmount: amount,
    ...meta,
  });
  return lines;
}

export async function buildBillPosting(
  db: Database,
  bill: BillRow,
  items: BillItemRow[],
): Promise<{ lines: PostingLine[]; taxLines: PostingTaxLine[]; exchangeRate: string }> {
  const entity = await loadEntity(db, bill.entityId);
  const accounts = await loadEntityAccounts(db, bill.entityId);
  const breakdown = (bill.taxBreakdown ?? []) as BreakdownRow[];
  const rates = await loadTaxRates(db, bill.entityId, breakdown.map((r) => r.taxRateId));
  const party = await loadParty(db, bill.contactId);

  const sign: 1 | -1 = bill.type === 'credit_note' ? -1 : 1;
  const currency = bill.currency || entity.baseCurrency;
  const exchangeRate = await requireBookingRate(db, {
    baseCurrency: entity.baseCurrency,
    currency: bill.currency,
    date: bill.issueDate,
    stored: bill.exchangeRate,
  });
  const toBase = baseConverter(entity, bill.currency, exchangeRate);
  const meta = { currency, exchangeRate, contactId: bill.contactId };
  // Tax the supplier charged is part of the cost under the Dutch KOR and in the US (sales tax is never reclaimed).
  const taxDeductible = !purchaseTaxIsCost(entity) && !isKorActive(entity, bill.issueDate);

  if (bill.expenseAccountId && !accounts.byId(bill.expenseAccountId)) {
    throw new PostingError('expenseAccountId does not belong to this accounting entity');
  }
  const defaultExpense =
    accounts.byId(bill.expenseAccountId) ??
    accounts.byId(party?.defaultExpenseAccountId) ??
    accountForRole(accounts, 'general_expense', FALLBACK_CODES.general_expense);

  const expenses = billExpenses(items, accounts, defaultExpense, taxDeductible);
  adjustBrPurchaseCost(expenses, breakdown, items, (item) => accounts.byId(item.accountId)?.id ?? defaultExpense?.id);

  const lines: PostingLine[] = [];
  for (const { accountId, classId, locationId, amount } of expenses.entries()) {
    lines.push({
      accountId,
      debit: toBase(amount * sign),
      description: `Expense ${bill.billNumber ?? ''}`.trim(),
      classId,
      locationId,
      ...meta,
    });
  }

  const posting: TaxPosting = {
    accounts,
    rates,
    sign,
    currency,
    toBase,
    contactId: bill.contactId,
    documentNumber: bill.billNumber,
    meta,
    lines,
    taxLines: [],
  };
  const useRows = breakdown.filter((r) => r.kind === 'use');
  if (useRows.length > 0) {
    await postBillUseTax(db, bill, useRows, items, defaultExpense, posting);
  }

  for (const row of breakdown) {
    if (row.kind === 'use') continue;
    postBillTaxRow(row, posting, taxDeductible, defaultExpense);
  }
  const { taxLines } = posting;

  // Payable = everything debited except the self-assessed pairs, which net out.
  const debits = roundMoney(lines.reduce((sum, l) => sum + (l.debit ?? 0), 0));
  const otherCredits = roundMoney(lines.reduce((sum, l) => sum + (l.credit ?? 0), 0));
  lines.push({
    accountId: requireAccount(
      accountForRole(accounts, 'accounts_payable', FALLBACK_CODES.accounts_payable),
      'No accounts payable account found for this entity.',
    ),
    credit: roundMoney(debits - otherCredits),
    description: `Bill ${bill.billNumber ?? ''}`.trim(),
    ...meta,
  });

  return { lines, taxLines, exchangeRate };
}

/** Post an approved bill. */
export async function postBill(
  db: Database,
  bill: BillRow,
  items: BillItemRow[],
  opts: { userId: string | null; keepStatus?: boolean },
): Promise<PostedEntry> {
  const { lines, taxLines, exchangeRate } = await buildBillPosting(db, bill, items);
  const now = new Date();
  return postJournalEntry(db, {
    entityId: bill.entityId,
    date: bill.issueDate,
    description: `Bill ${bill.billNumber ?? ''} - ${bill.contactName ?? ''}`.trim(),
    reference: bill.externalReference ?? bill.reference,
    sourceType: bill.type === 'credit_note' ? 'bill_credit_note' : 'bill',
    sourceId: bill.id,
    postingKey: `bill:${bill.id}:approve`,
    lockKind: 'purchase',
    lines,
    taxLines,
    createdBy: opts.userId,
    alsoWrite: (h, posted) => [
      h
        .update(schema.bills)
        .set(
          opts.keepStatus
            ? { exchangeRate, journalEntryId: posted.journalEntryId, updatedAt: now }
            : {
                exchangeRate,
                approvalStatus: 'approved',
                status: 'approved',
                approvedBy: opts.userId,
                approvedAt: now,
                journalEntryId: posted.journalEntryId,
                updatedAt: now,
              },
        )
        .where(eq(schema.bills.id, bill.id)),
    ],
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * The ledger account money moves through: the payment's bank account, the
 * cash account for cash payments, else the entity's default bank account.
 */
export async function resolveMoneyAccount(
  db: Database,
  accounts: EntityAccounts,
  entity: EntityRow,
  args: { bankAccountId?: string | null; paymentMethod?: string | null },
): Promise<string> {
  if (args.bankAccountId) {
    const [bankAccount] = await db
      .select({ ledgerAccountId: schema.bankAccounts.ledgerAccountId })
      .from(schema.bankAccounts)
      .where(
        and(
          eq(schema.bankAccounts.id, args.bankAccountId),
          eq(schema.bankAccounts.entityId, entity.id),
          isNull(schema.bankAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!bankAccount) throw new PostingError('Bank account not found for this accounting entity');
    return requireAccount(
      accounts.byId(bankAccount.ledgerAccountId),
      'This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.',
    );
  }
  if (args.paymentMethod === 'cash') {
    const cash = accounts.bySubtype('cash');
    if (cash) return cash.id;
  }
  const [defaultBank] = await db
    .select({ ledgerAccountId: schema.bankAccounts.ledgerAccountId })
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.entityId, entity.id),
        isNull(schema.bankAccounts.deletedAt),
        sql`${schema.bankAccounts.ledgerAccountId} is not null`,
      ),
    )
    .orderBy(sql`${schema.bankAccounts.isDefault} desc nulls last`, schema.bankAccounts.createdAt)
    .limit(1);
  const fromBank = accounts.byId(defaultBank?.ledgerAccountId);
  if (fromBank) return fromBank.id;
  // Template bank accounts: NL 1100 Bank, IN 1200 Bank.
  const templateBank = accounts.byCode(entity.jurisdictionCode === 'IN' ? '1200' : '1100');
  if (templateBank?.subtype === 'bank') return templateBank.id;
  return requireAccount(
    accounts.bySubtype('bank'),
    'No bank account linked to the ledger. Add a bank account and link it to a GL account.',
  );
}

export interface PaymentAllocationInput {
  invoiceId?: string | null;
  billId?: string | null;
  amount: number;
  contactId: string;
}

/** Ledger lines for a payment; `amount` and allocations are in the payment currency. */
export async function buildPaymentPosting(
  db: Database,
  payment: {
    entityId: string;
    type: 'received' | 'sent';
    amount: number;
    currency: string | null;
    exchangeRate: string | null;
    contactId: string;
    bankAccountId?: string | null;
    paymentMethod?: string | null;
    reference?: string | null;
    /** The ledger account the money moves through (Undeposited Funds, say), instead of resolving the bank one. */
    moneyAccountId?: string | null;
    /**
     * US backup withholding on a payment to a vendor: the bills settle for the
     * gross `amount`, the bank is credited the net and the withheld part goes
     * to Backup Withholding Payable.
     */
    backupWithholdingAmount?: number | null;
  },
  allocations: PaymentAllocationInput[],
): Promise<PostingLine[]> {
  const entity = await loadEntity(db, payment.entityId);
  const accounts = await loadEntityAccounts(db, payment.entityId);
  const toBase = baseConverter(entity, payment.currency, payment.exchangeRate);
  const meta = { currency: payment.currency ?? entity.baseCurrency, exchangeRate: payment.exchangeRate ?? '1' };
  const received = payment.type === 'received';

  const receivable = () =>
    requireAccount(
      accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable),
      'No accounts receivable account found for this entity.',
    );
  const payable = () =>
    requireAccount(
      accountForRole(accounts, 'accounts_payable', FALLBACK_CODES.accounts_payable),
      'No accounts payable account found for this entity.',
    );
  const counterAccount = received ? receivable() : payable();
  // An invoice settles against receivables and a bill against payables, whichever way the money moves:
  // a refund of a customer credit note is a sent payment that debits receivables.
  const counterFor = (allocation: PaymentAllocationInput) =>
    allocation.invoiceId ? receivable() : allocation.billId ? payable() : counterAccount;
  const moneyAccount = payment.moneyAccountId
    ? requireAccount(accounts.byId(payment.moneyAccountId), 'The money account does not belong to this accounting entity')
    : await resolveMoneyAccount(db, accounts, entity, payment);

  const total = toBase(payment.amount);
  const withheld = payment.backupWithholdingAmount ? toBase(payment.backupWithholdingAmount) : 0;
  if (withheld < 0 || (withheld > 0 && (received || withheld > total))) {
    throw new PostingError('Backup withholding applies to payments to vendors and can not be more than the payment');
  }
  const counterLines: PostingLine[] = [];
  let allocated = 0;
  for (const allocation of allocations) {
    const amount = toBase(allocation.amount);
    allocated = roundMoney(allocated + amount);
    counterLines.push({
      accountId: counterFor(allocation),
      [received ? 'credit' : 'debit']: amount,
      description: `Payment ${payment.reference ?? ''}`.trim(),
      contactId: allocation.contactId,
      ...meta,
    });
  }
  const unallocated = roundMoney(total - allocated);
  if (unallocated < 0) throw new PostingError('Allocations exceed the payment amount');
  if (unallocated > 0) {
    counterLines.push({
      accountId: counterAccount,
      [received ? 'credit' : 'debit']: unallocated,
      description: `Unapplied payment ${payment.reference ?? ''}`.trim(),
      contactId: payment.contactId,
      ...meta,
    });
  }

  const withholdingLines: PostingLine[] =
    withheld > 0
      ? [
          {
            accountId: requireAccount(
              accountForRole(accounts, 'backup_withholding_payable', ['2310']),
              'This accounting entity has no Backup Withholding Payable account',
            ),
            credit: withheld,
            description: `Backup withholding ${payment.reference ?? ''}`.trim(),
            contactId: payment.contactId,
            ...meta,
          },
        ]
      : [];

  return [
    {
      accountId: moneyAccount,
      [received ? 'debit' : 'credit']: roundMoney(total - withheld),
      description: `${received ? 'Payment received' : 'Payment sent'} ${payment.reference ?? ''}`.trim(),
      contactId: payment.contactId,
      ...meta,
    },
    ...counterLines,
    ...withholdingLines,
  ];
}

/**
 * SQL that applies `delta` (payment currency, may be negative when a payment
 * is removed) to an invoice's or bill's paid amount, balance and status in
 * one statement, so concurrent payments can't overwrite each other.
 */
export function settlementSet(
  table: typeof schema.invoices | typeof schema.bills,
  delta: number,
  unpaidStatus: 'sent' | 'approved',
) {
  const d = delta.toFixed(2);
  const newPaid = sql`(coalesce(${table.amountPaid}, '0')::numeric + ${d}::numeric)`;
  const remaining = sql`(coalesce(${table.total}, '0')::numeric - ${newPaid})`;
  // An invoice that was never sent goes back to 'finalized', not 'sent'.
  const unpaid =
    unpaidStatus === 'sent'
      ? sql`case when ${table.dueDate} < now() then 'overdue' when ${(table as typeof schema.invoices).sentAt} is not null then 'sent' else 'finalized' end`
      : sql`'approved'`;
  return {
    amountPaid: sql`${newPaid}`,
    balanceDue: sql`greatest(${remaining}, 0)`,
    status: sql`case when ${remaining} <= 0.005 then 'paid' when ${newPaid} <= 0.005 then ${unpaid} else 'partial' end`,
    paidAt: sql`case when ${remaining} <= 0.005 then now() else null end`,
    updatedAt: new Date(),
  };
}

export { PostingError, roundMoney };
