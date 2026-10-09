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
type TaxRateRow = typeof schema.taxRates.$inferSelect;
type BreakdownRow = NonNullable<InvoiceRow['taxBreakdown']>[number];

/** Legacy fallbacks for entities seeded before a role existed (NL / IN template codes). */
const FALLBACK_CODES = {
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

async function loadTaxRates(db: Database, entityId: string, ids: Array<string | null | undefined>) {
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

/** Converts document-currency amounts to the entity's base currency. */
function baseConverter(entity: EntityRow, currency: string | null | undefined, exchangeRate: string | null | undefined) {
  const rate = Number.parseFloat(exchangeRate ?? '1');
  const sameCurrency = !currency || currency === entity.baseCurrency;
  return (amount: number) =>
    sameCurrency || !Number.isFinite(rate) || rate === 0 ? roundMoney(amount) : toBaseCurrency(amount, rate);
}

function requireAccount(
  account: { id: string } | undefined,
  message: string,
): string {
  if (!account) throw new PostingError(message);
  return account.id;
}

/** Account for a breakdown row's tax: component role (India), the rate's ledger account, else the role for the direction. */
function taxAccountFor(
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

function breakdownToTaxLine(
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

// ---------------------------------------------------------------------------
// Invoices and credit notes
// ---------------------------------------------------------------------------

export async function buildInvoicePosting(
  db: Database,
  invoice: InvoiceRow,
  items: InvoiceItemRow[],
): Promise<{ lines: PostingLine[]; taxLines: PostingTaxLine[] }> {
  const entity = await loadEntity(db, invoice.entityId);
  const accounts = await loadEntityAccounts(db, invoice.entityId);
  const breakdown = (invoice.taxBreakdown ?? []) as BreakdownRow[];
  // A US document calculated by the sales tax engine: tax per jurisdiction and agency, no rate rows.
  const salesTax = Boolean(invoice.taxEngine);
  const rates = salesTax ? new Map<string, TaxRateRow>() : await loadTaxRates(db, invoice.entityId, breakdown.map((r) => r.taxRateId));
  const party = await loadParty(db, invoice.contactId);

  const sign: 1 | -1 = invoice.type === 'credit_note' ? -1 : 1;
  const currency = invoice.currency || entity.baseCurrency;
  const toBase = baseConverter(entity, invoice.currency, invoice.exchangeRate);
  const meta = { currency, exchangeRate: invoice.exchangeRate ?? '1', contactId: invoice.contactId };

  const defaultRevenue =
    accounts.byId(invoice.revenueAccountId) ??
    accounts.byId(party?.defaultRevenueAccountId) ??
    accountForRole(accounts, 'sales_revenue', FALLBACK_CODES.sales_revenue);
  if (invoice.revenueAccountId && !accounts.byId(invoice.revenueAccountId)) {
    throw new PostingError('revenueAccountId does not belong to this accounting entity');
  }

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

  const taxLines: PostingTaxLine[] = [];
  if (salesTax) {
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
  } else {
    for (const row of breakdown) {
      const rate = rates.get(row.taxRateId);
      if (row.taxAmount !== 0) {
        lines.push({
          accountId: taxAccountFor(accounts, row, rate, 'sales'),
          credit: toBase(row.taxAmount * sign),
          description: `${row.taxRateName ?? 'Tax'} ${invoice.invoiceNumber ?? ''}`.trim(),
          taxRateId: row.taxRateId || null,
          taxAmount: toBase(row.taxAmount * sign),
          ...meta,
        });
      }
      if (row.taxRateId) {
        taxLines.push(
          breakdownToTaxLine(row, rate, { direction: 'sales', sign, currency, toBase, contactId: invoice.contactId }),
        );
      }
    }
  }

  // The receivable is the sum of what was credited, so the entry always balances in base currency.
  const receivable = roundMoney(lines.reduce((sum, l) => sum + (l.credit ?? 0), 0));
  lines.unshift({
    accountId: requireAccount(
      accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable),
      'No accounts receivable account found for this entity.',
    ),
    debit: receivable,
    description: `${invoice.type === 'credit_note' ? 'Credit note' : 'Invoice'} ${invoice.invoiceNumber ?? ''}`.trim(),
    ...meta,
  });

  return { lines, taxLines };
}

/** The ship-to ZIP stored with a US document's tax rows: the shipping address, else the billing address. */
function pickShipToZip(invoice: InvoiceRow): string | null {
  return zip5Of(pickShipTo(invoice.shippingAddress, invoice.billingAddress)) ?? null;
}

/** Post a draft invoice or credit note and mark it finalized ('sent'). */
export async function postInvoice(
  db: Database,
  invoice: InvoiceRow,
  items: InvoiceItemRow[],
  opts: { userId: string | null; markSent?: boolean; keepStatus?: boolean },
): Promise<PostedEntry> {
  const { lines, taxLines } = await buildInvoicePosting(db, invoice, items);
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
          ...(opts.keepStatus ? {} : { status: 'sent' }),
          journalEntryId: posted.journalEntryId,
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

export async function buildBillPosting(
  db: Database,
  bill: BillRow,
  items: BillItemRow[],
): Promise<{ lines: PostingLine[]; taxLines: PostingTaxLine[] }> {
  const entity = await loadEntity(db, bill.entityId);
  const accounts = await loadEntityAccounts(db, bill.entityId);
  const breakdown = (bill.taxBreakdown ?? []) as BreakdownRow[];
  const rates = await loadTaxRates(db, bill.entityId, breakdown.map((r) => r.taxRateId));
  const party = await loadParty(db, bill.contactId);

  const sign: 1 | -1 = bill.type === 'credit_note' ? -1 : 1;
  const currency = bill.currency || entity.baseCurrency;
  const toBase = baseConverter(entity, bill.currency, bill.exchangeRate);
  const meta = { currency, exchangeRate: bill.exchangeRate ?? '1', contactId: bill.contactId };
  // Tax the supplier charged is part of the cost under the Dutch KOR and in the US (sales tax is never reclaimed).
  const taxDeductible = !purchaseTaxIsCost(entity) && !isKorActive(entity, bill.issueDate);

  if (bill.expenseAccountId && !accounts.byId(bill.expenseAccountId)) {
    throw new PostingError('expenseAccountId does not belong to this accounting entity');
  }
  const defaultExpense =
    accounts.byId(bill.expenseAccountId) ??
    accounts.byId(party?.defaultExpenseAccountId) ??
    accountForRole(accounts, 'general_expense', FALLBACK_CODES.general_expense);

  const expenses = new DimensionedAmounts();
  const itemById = new Map(items.map((i) => [i.id, i]));
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

  const taxLines: PostingTaxLine[] = [];
  const useRows = breakdown.filter((r) => r.kind === 'use');
  if (useRows.length > 0) {
    // Use tax the buyer accrues: Dr the line's expense or asset, Cr the agency's Use Tax Payable.
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

  for (const row of breakdown) {
    if (row.kind === 'use') continue;
    const rate = rates.get(row.taxRateId);
    if (row.selfAssessed) {
      // Owed and deducted by the buyer itself: both legs, nothing to the supplier.
      if (row.taxAmount !== 0) {
        const amount = toBase(row.taxAmount * sign);
        if (taxDeductible) {
          lines.push({
            accountId: taxAccountFor(accounts, row, rate, 'purchase'),
            debit: amount,
            description: `${row.taxRateName ?? 'Tax'} (self-assessed) ${bill.billNumber ?? ''}`.trim(),
            taxRateId: row.taxRateId || null,
            taxAmount: amount,
            ...meta,
          });
        } else {
          lines.push({
            accountId: requireAccount(defaultExpense, 'No expense account found for non-deductible tax.'),
            debit: amount,
            description: `${row.taxRateName ?? 'Tax'} (self-assessed, not deductible) ${bill.billNumber ?? ''}`.trim(),
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
          description: `${row.taxRateName ?? 'Tax'} (self-assessed) ${bill.billNumber ?? ''}`.trim(),
          taxRateId: row.taxRateId || null,
          taxAmount: amount,
          ...meta,
        });
      }
    } else if (taxDeductible && row.taxAmount !== 0) {
      lines.push({
        accountId: taxAccountFor(accounts, row, rate, 'purchase'),
        debit: toBase(row.taxAmount * sign),
        description: `${row.taxRateName ?? 'Tax'} ${bill.billNumber ?? ''}`.trim(),
        taxRateId: row.taxRateId || null,
        taxAmount: toBase(row.taxAmount * sign),
        ...meta,
      });
    }
    if (row.taxRateId && taxDeductible) {
      taxLines.push(
        breakdownToTaxLine(row, rate, { direction: 'purchase', sign, currency, toBase, contactId: bill.contactId }),
      );
    }
  }

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

  return { lines, taxLines };
}

/** Post an approved bill. */
export async function postBill(
  db: Database,
  bill: BillRow,
  items: BillItemRow[],
  opts: { userId: string | null; keepStatus?: boolean },
): Promise<PostedEntry> {
  const { lines, taxLines } = await buildBillPosting(db, bill, items);
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
            ? { journalEntryId: posted.journalEntryId, updatedAt: now }
            : {
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

  const counterAccount = requireAccount(
    received
      ? accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable)
      : accountForRole(accounts, 'accounts_payable', FALLBACK_CODES.accounts_payable),
    received ? 'No accounts receivable account found for this entity.' : 'No accounts payable account found for this entity.',
  );
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
      accountId: counterAccount,
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
  const unpaid =
    unpaidStatus === 'sent'
      ? sql`case when ${table.dueDate} < now() then 'overdue' else 'sent' end`
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
