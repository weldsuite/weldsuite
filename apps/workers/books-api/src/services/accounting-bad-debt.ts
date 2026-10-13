/**
 * Bad debt (oninbare vorderingen): writing an invoice off and, when the
 * customer pays after all, taking the write-off back.
 *
 * In jurisdictions with bad debt VAT relief (NL art. 29 Wet OB, UK bad debt
 * relief: `adapter.badDebtVatRelief`) the supplier gets back the VAT it
 * accounted for on a sale it never got paid for. A write-off therefore splits
 * the open balance, it does not expense it gross:
 *
 *   write-off   Dr bad debts (net)  +  Dr output VAT (per rate, as the invoice credited it)
 *               /  Cr receivable (open balance)
 *               plus NEGATIVE sales tax-ledger rows per rate in the write-off date's
 *               period (same box as the original sale), so the next return deducts the
 *               VAT. Only the unpaid share of the invoice is written off, so a partly
 *               paid invoice reclaims only the VAT of its unpaid part.
 *
 *   recovery    a payment on a written-off invoice first reinstates the receivable:
 *               Dr receivable  /  Cr bad debts (net)  +  Cr output VAT, with POSITIVE
 *               tax-ledger rows, i.e. the relief is paid back in proportion to what was
 *               recovered; the payment then settles the receivable as usual.
 *
 * Without relief (IN GST, a US invoice with a sales-tax engine has its own
 * agency-based path in `accounting-document-posting`) the write-off stays gross.
 *
 * The write-off's split is not stored on the invoice: it is read back from the
 * tax ledger (rows with source `write_off` / `write_off_recovery`), so a
 * write-off booked before this existed (gross, no rows) is recovered gross.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { getAdapter, hasAdapter } from '@weldsuite/books-domain/jurisdictions/registry';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  PostingError,
  roundMoney,
  type PostedEntry,
  type PostingLine,
  type PostingTaxLine,
} from './accounting-posting';
import {
  baseConverter,
  breakdownToTaxLine,
  FALLBACK_CODES,
  loadEntity,
  loadTaxRates,
  postInvoiceWriteOff,
  requireAccount,
  taxAccountFor,
  writeOffTaxRows,
  type BreakdownRow,
} from './accounting-document-posting';

type InvoiceRow = typeof schema.invoices.$inferSelect;
type EntityRow = typeof schema.entities.$inferSelect;

/** Tax-ledger source types of a write-off and of the recoveries that take it back. */
const WRITE_OFF_SOURCES = ['write_off', 'write_off_recovery'];

/** True when writing this invoice off recovers (a share of) its VAT. */
export function badDebtVatReliefApplies(entity: Pick<EntityRow, 'jurisdictionCode'>, invoice: Pick<InvoiceRow, 'type' | 'taxEngine'>): boolean {
  return (
    invoice.type !== 'credit_note' &&
    !invoice.taxEngine &&
    hasAdapter(entity.jurisdictionCode) &&
    getAdapter(entity.jurisdictionCode).badDebtVatRelief === true
  );
}

function badDebtAccount(accounts: Awaited<ReturnType<typeof loadEntityAccounts>>) {
  return (
    accountForRole(accounts, 'bad_debt_expense') ??
    accountForRole(accounts, 'general_expense', FALLBACK_CODES.general_expense)
  );
}

/**
 * Write an invoice's open balance off to bad debts. With bad debt VAT relief
 * the VAT share is debited to the output-VAT account instead (and written to
 * the tax ledger as a negative row); otherwise the whole balance is expensed.
 * `vatRelief` is the VAT recovered, in base currency.
 */
export async function writeOffInvoice(
  db: Database,
  invoice: InvoiceRow,
  opts: { userId: string | null; date?: Date },
): Promise<PostedEntry & { vatRelief: number }> {
  const entity = await loadEntity(db, invoice.entityId);
  if (!badDebtVatReliefApplies(entity, invoice)) {
    const posted = await postInvoiceWriteOff(db, invoice, opts);
    return { ...posted, vatRelief: 0 };
  }

  const accounts = await loadEntityAccounts(db, invoice.entityId);
  const toBase = baseConverter(entity, invoice.currency, invoice.exchangeRate);
  const currency = invoice.currency || entity.baseCurrency;
  const meta = { currency, exchangeRate: invoice.exchangeRate ?? '1', contactId: invoice.contactId };
  const open = toBase(Number.parseFloat(invoice.balanceDue ?? '0'));
  const date = opts.date ?? new Date();
  const badDebt = badDebtAccount(accounts);

  // The open share of every taxed row of the invoice, as negative output tax.
  const { rows } = writeOffTaxRows(invoice);
  const taxable = rows.filter((r): r is BreakdownRow => r.kind !== 'use' && !r.selfAssessed && r.taxAmount !== 0);
  const rates = await loadTaxRates(db, invoice.entityId, taxable.map((r) => r.taxRateId));

  const vatByAccount = new Map<string, number>();
  const taxLines: PostingTaxLine[] = [];
  for (const row of taxable) {
    const rate = rates.get(row.taxRateId);
    const accountId = taxAccountFor(accounts, row, rate, 'sales');
    vatByAccount.set(accountId, roundMoney((vatByAccount.get(accountId) ?? 0) + toBase(row.taxAmount)));
    if (row.taxRateId) {
      taxLines.push(breakdownToTaxLine(row, rate, { direction: 'sales', sign: -1, currency, toBase, contactId: invoice.contactId }));
    }
  }
  const vatBase = Math.min(open, roundMoney([...vatByAccount.values()].reduce((sum, v) => sum + v, 0)));

  const lines: PostingLine[] = [
    {
      accountId: requireAccount(badDebt, 'No bad-debt or general expense account found for this entity.'),
      debit: roundMoney(open - vatBase),
      description: `Bad debt ${invoice.invoiceNumber ?? ''}`.trim(),
      ...meta,
    },
    ...[...vatByAccount.entries()].map(([accountId, amount]): PostingLine => ({
      accountId,
      debit: amount,
      description: `VAT bad debt relief ${invoice.invoiceNumber ?? ''}`.trim(),
      taxAmount: -amount,
      ...meta,
    })),
    {
      accountId: requireAccount(
        accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable),
        'No accounts receivable account found for this entity.',
      ),
      credit: open,
      description: `Write-off ${invoice.invoiceNumber ?? ''}`.trim(),
      ...meta,
    },
  ];

  const posted = await postJournalEntry(db, {
    entityId: invoice.entityId,
    date,
    description: `Write-off ${invoice.invoiceNumber ?? ''} - ${invoice.contactName ?? ''}`.trim(),
    sourceType: 'write_off',
    sourceId: invoice.id,
    postingKey: `invoice:${invoice.id}:write_off`,
    lockKind: 'sales',
    lines,
    taxLines,
    createdBy: opts.userId,
    alsoWrite: (h) => [
      h
        .update(schema.invoices)
        .set({ status: 'uncollectible', balanceDue: '0.00', updatedAt: new Date() })
        .where(eq(schema.invoices.id, invoice.id)),
    ],
  });
  return { ...posted, vatRelief: vatBase };
}

/** What is still written off on an invoice, in the document currency (total less what was paid, incl. recoveries). */
export function writtenOffBalance(invoice: Pick<InvoiceRow, 'status' | 'total' | 'amountPaid'>): number {
  if (invoice.status !== 'uncollectible') return 0;
  return roundMoney(Math.max(0, Number.parseFloat(invoice.total ?? '0') - Number.parseFloat(invoice.amountPaid ?? '0')));
}

interface ReliefGroup {
  taxRateId: string | null;
  taxRateName: string | null;
  taxCategoryCode: string | null;
  rate: number;
  component: string | null;
  taxable: number;
  tax: number;
  baseTaxable: number;
  baseTax: number;
}

/** The VAT relief still outstanding on a written-off invoice, per rate: write-off rows (negative) net of earlier recoveries. */
async function outstandingRelief(db: Database, invoice: InvoiceRow): Promise<ReliefGroup[]> {
  const rows = await db
    .select()
    .from(schema.taxLines)
    .where(
      and(
        eq(schema.taxLines.entityId, invoice.entityId),
        eq(schema.taxLines.sourceId, invoice.id),
        inArray(schema.taxLines.sourceType, WRITE_OFF_SOURCES),
      ),
    );
  const groups = new Map<string, ReliefGroup>();
  for (const row of rows) {
    const key = `${row.taxRateId ?? ''}|${row.rate}|${row.component ?? ''}|${row.taxCategoryCode ?? ''}`;
    const group = groups.get(key) ?? {
      taxRateId: row.taxRateId,
      taxRateName: row.taxRateName,
      taxCategoryCode: row.taxCategoryCode,
      rate: Number(row.rate),
      component: row.component,
      taxable: 0,
      tax: 0,
      baseTaxable: 0,
      baseTax: 0,
    };
    group.taxable += Number(row.taxableAmount);
    group.tax += Number(row.taxAmount);
    group.baseTaxable += Number(row.baseTaxableAmount);
    group.baseTax += Number(row.baseTaxAmount);
    groups.set(key, group);
  }
  // Relief is negative output tax: what is left of it, as a positive amount to give back.
  return [...groups.values()]
    .map((g) => ({ ...g, taxable: -g.taxable, tax: -g.tax, baseTaxable: -g.baseTaxable, baseTax: -g.baseTax }))
    .filter((g) => g.tax > 0.004 || g.baseTax > 0.004);
}

/** The relief that comes back when `amount` of the `writtenOff` balance is recovered: the same share of every outstanding rate. */
export function reliefShare(groups: ReliefGroup[], amount: number, writtenOff: number): ReliefGroup[] {
  const share = writtenOff > 0 ? Math.min(1, amount / writtenOff) : 0;
  return groups.map((g) => ({
    ...g,
    taxable: roundMoney(g.taxable * share),
    tax: roundMoney(g.tax * share),
    baseTaxable: roundMoney(g.baseTaxable * share),
    baseTax: roundMoney(g.baseTax * share),
  }));
}

/**
 * A customer pays (part of) a written-off invoice: reinstate that part of the
 * receivable, take back the matching share of the bad debt and of the VAT
 * relief (output VAT is owed again, in the period of the payment). The payment
 * itself then settles the receivable like any other. `amount` is in the
 * invoice's currency; idempotent per payment.
 */
export async function postBadDebtRecovery(
  db: Database,
  invoice: InvoiceRow,
  opts: { amount: number; paymentId: string; date: Date; userId: string | null },
): Promise<PostedEntry & { vatReinstated: number }> {
  const writtenOff = writtenOffBalance(invoice);
  if (opts.amount > writtenOff + 0.005) {
    throw new PostingError(
      `The amount (${opts.amount.toFixed(2)}) is more than what was written off on invoice ${invoice.invoiceNumber ?? invoice.id} (${writtenOff.toFixed(2)})`,
    );
  }

  const entity = await loadEntity(db, invoice.entityId);
  const accounts = await loadEntityAccounts(db, invoice.entityId);
  const toBase = baseConverter(entity, invoice.currency, invoice.exchangeRate);
  const currency = invoice.currency || entity.baseCurrency;
  const meta = { currency, exchangeRate: invoice.exchangeRate ?? '1', contactId: invoice.contactId };
  const amountBase = toBase(opts.amount);

  const relief = reliefShare(await outstandingRelief(db, invoice), opts.amount, writtenOff);
  const rates = await loadTaxRates(db, invoice.entityId, relief.map((g) => g.taxRateId));

  const vatByAccount = new Map<string, number>();
  const taxLines: PostingTaxLine[] = [];
  for (const g of relief) {
    const rate = g.taxRateId ? rates.get(g.taxRateId) : undefined;
    const accountId = taxAccountFor(
      accounts,
      { taxRateId: g.taxRateId ?? '', taxRateName: g.taxRateName ?? '', taxRate: g.rate, taxableAmount: g.taxable, taxAmount: g.tax },
      rate,
      'sales',
    );
    vatByAccount.set(accountId, roundMoney((vatByAccount.get(accountId) ?? 0) + g.baseTax));
    taxLines.push({
      direction: 'sales',
      taxRateId: g.taxRateId,
      taxRateName: g.taxRateName,
      taxCategoryCode: g.taxCategoryCode,
      rate: g.rate,
      component: g.component,
      selfAssessed: false,
      taxableAmount: g.taxable,
      taxAmount: g.tax,
      currency,
      baseTaxableAmount: g.baseTaxable,
      baseTaxAmount: g.baseTax,
      contactId: invoice.contactId,
    });
  }
  const vatBase = Math.min(amountBase, roundMoney([...vatByAccount.values()].reduce((sum, v) => sum + v, 0)));

  const lines: PostingLine[] = [
    {
      accountId: requireAccount(
        accountForRole(accounts, 'accounts_receivable', FALLBACK_CODES.accounts_receivable),
        'No accounts receivable account found for this entity.',
      ),
      debit: amountBase,
      description: `Write-off recovered ${invoice.invoiceNumber ?? ''}`.trim(),
      ...meta,
    },
    {
      accountId: requireAccount(badDebtAccount(accounts), 'No bad-debt or general expense account found for this entity.'),
      credit: roundMoney(amountBase - vatBase),
      description: `Bad debt recovered ${invoice.invoiceNumber ?? ''}`.trim(),
      ...meta,
    },
    ...[...vatByAccount.entries()].map(([accountId, amount]): PostingLine => ({
      accountId,
      credit: amount,
      description: `VAT bad debt relief repaid ${invoice.invoiceNumber ?? ''}`.trim(),
      taxAmount: amount,
      ...meta,
    })),
  ];

  const posted = await postJournalEntry(db, {
    entityId: invoice.entityId,
    date: opts.date,
    description: `Write-off recovered ${invoice.invoiceNumber ?? ''} - ${invoice.contactName ?? ''}`.trim(),
    sourceType: 'write_off_recovery',
    sourceId: invoice.id,
    postingKey: recoveryPostingKey(invoice.id, opts.paymentId),
    lockKind: 'sales',
    lines,
    taxLines,
    createdBy: opts.userId,
  });
  return { ...posted, vatReinstated: vatBase };
}

export function recoveryPostingKey(invoiceId: string, paymentId: string): string {
  return `invoice:${invoiceId}:write_off_recovery:${paymentId}`;
}

/** The recovery entries a payment made (one per written-off invoice it settled). */
export async function findRecoveryEntries(
  db: Database,
  paymentId: string,
  invoiceIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (invoiceIds.length === 0) return result;
  const keys = invoiceIds.map((id) => recoveryPostingKey(id, paymentId));
  const rows = await db
    .select({ id: schema.journalEntries.id, postingKey: schema.journalEntries.postingKey, status: schema.journalEntries.status })
    .from(schema.journalEntries)
    .where(inArray(schema.journalEntries.postingKey, keys));
  for (const row of rows) {
    if (row.status !== 'posted') continue;
    const invoiceId = invoiceIds.find((id) => recoveryPostingKey(id, paymentId) === row.postingKey);
    if (invoiceId) result.set(invoiceId, row.id);
  }
  return result;
}

/**
 * Invoice columns after `delta` was paid on a written-off invoice (negative
 * when the payment is voided): the open balance stays 0, it is paid in full
 * once everything written off came back and stays 'uncollectible' until then.
 */
export function writtenOffSettlementSet(delta: number) {
  const d = delta.toFixed(2);
  const newPaid = sql`(coalesce(${schema.invoices.amountPaid}, '0')::numeric + ${d}::numeric)`;
  const remaining = sql`(coalesce(${schema.invoices.total}, '0')::numeric - ${newPaid})`;
  return {
    amountPaid: sql`${newPaid}`,
    balanceDue: sql`0`,
    status: sql`case when ${remaining} <= 0.005 then 'paid' else 'uncollectible' end`,
    paidAt: sql`case when ${remaining} <= 0.005 then now() else null end`,
    updatedAt: new Date(),
  };
}
