/**
 * Brazil's monthly tax worksheet (apuração) for an entity: gathers the
 * month's revenue (per Simples annex and per kind of supply), the revenue of
 * the 12 months before (RBT12), the payroll for the fator R, the tax ledger
 * and, at the end of a quarter, the quarter's revenue and profit, then hands
 * them to `computeBrApuracao` from the books domain.
 *
 * Booking the worksheet posts what the invoices did not already post: the DAS
 * (Simples / MEI) as a revenue deduction, IRPJ and CSLL of the quarter, and
 * the withholdings customers kept back offset against the taxes they reduce.
 * The worksheet is kept as a `tax_returns` row (jurisdiction BR, one per month).
 */

import { and, eq, gte, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  brProfileOf,
  brRegimeOf,
  brSettingsOf,
  computeBrApuracao,
  proportionalRbt12,
  type BrApuracao,
  type BrQuarterRevenue,
  type BrSimplesAnexo,
  type BrTaxLedgerTotal,
  type SimplesRevenueSlice,
} from '@weldsuite/books-domain/jurisdictions/br';
import { toBaseCurrency } from './accounting-currency';
import { parseRate } from './accounting-fx';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  PostingError,
  roundMoney,
  type PostingLine,
} from './accounting-posting';

type EntityRow = typeof schema.entities.$inferSelect;
type BreakdownRow = NonNullable<(typeof schema.invoices.$inferSelect)['taxBreakdown']>[number];

export class BrApuracaoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrApuracaoError';
  }
}

const NOT_REVENUE_STATUSES = ['draft', 'cancelled'];
const NOT_REVENUE_TYPES = ['proforma'];

/** First day of the month and first day of the next one, as Dates (UTC). */
export function monthRange(period: string): { from: Date; to: Date; start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BrApuracaoError('period must be YYYY-MM');
  const [y, m] = period.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to, start: from.toISOString().slice(0, 10), end };
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

interface RevenueLine {
  amount: number;
  anexo: BrSimplesAnexo;
  kind: 'service' | 'goods' | 'export';
  invoiceId: string;
}

/** Revenue lines (base currency, credit notes negative) of the invoices issued in [from, to). */
async function revenueLines(db: Database, entity: EntityRow, from: Date, to: Date): Promise<{ lines: RevenueLine[]; issWithheld: Map<string, number> }> {
  const settings = brSettingsOf(entity.jurisdictionSettings);
  const rows = await db
    .select({
      invoiceId: schema.invoices.id,
      type: schema.invoices.type,
      currency: schema.invoices.currency,
      exchangeRate: schema.invoices.exchangeRate,
      taxBreakdown: schema.invoices.taxBreakdown,
      lineTotal: schema.invoiceItems.lineTotal,
      taxRateId: schema.invoiceItems.taxRateId,
    })
    .from(schema.invoiceItems)
    .innerJoin(schema.invoices, eq(schema.invoiceItems.invoiceId, schema.invoices.id))
    .where(
      and(
        eq(schema.invoices.entityId, entity.id),
        isNull(schema.invoices.deletedAt),
        isNull(schema.invoiceItems.deletedAt),
        gte(schema.invoices.issueDate, from),
        lt(schema.invoices.issueDate, to),
        notInArray(schema.invoices.status, NOT_REVENUE_STATUSES),
        notInArray(schema.invoices.type, NOT_REVENUE_TYPES),
      ),
    );

  const rateIds = [...new Set(rows.map((r) => r.taxRateId).filter((id): id is string => Boolean(id)))];
  const rates = rateIds.length
    ? await db
        .select({ id: schema.taxRates.id, jurisdictionMetadata: schema.taxRates.jurisdictionMetadata })
        .from(schema.taxRates)
        .where(inArray(schema.taxRates.id, rateIds))
    : [];
  const profileById = new Map(rates.map((r) => [r.id, brProfileOf(r.jurisdictionMetadata as Record<string, unknown> | null)]));

  const toBase = (amount: number, currency: string | null, rate: string | null) => {
    if (!currency || currency === entity.baseCurrency) return amount;
    const parsed = parseRate(rate);
    return parsed ? toBaseCurrency(amount, parsed) : amount;
  };

  const lines: RevenueLine[] = [];
  const issWithheld = new Map<string, number>();
  for (const row of rows) {
    const sign = row.type === 'credit_note' ? -1 : 1;
    const profile = row.taxRateId ? profileById.get(row.taxRateId) : undefined;
    let kind: RevenueLine['kind'] = 'service';
    if (profile?.kind === 'export_goods' || profile?.kind === 'export_service') kind = 'export';
    else if (profile?.kind === 'goods_resale' || profile?.kind === 'goods_production') kind = 'goods';
    lines.push({
      amount: sign * toBase(Number.parseFloat(row.lineTotal ?? '0'), row.currency, row.exchangeRate),
      anexo: profile?.simplesAnexo ?? settings.simplesAnexo ?? (kind === 'goods' ? 'I' : 'III'),
      kind,
      invoiceId: row.invoiceId,
    });
    if (!issWithheld.has(row.invoiceId)) {
      const base = ((row.taxBreakdown ?? []) as BreakdownRow[])
        .filter((b) => b.component === 'iss_ret')
        .reduce((sum, b) => sum + b.taxableAmount, 0);
      issWithheld.set(row.invoiceId, sign * toBase(base, row.currency, row.exchangeRate));
    }
  }
  return { lines, issWithheld };
}

/** The month's revenue per annex, with the ISS-withheld and export parts (ISS withheld is spread over the invoice's service lines). */
function simplesSlices(lines: RevenueLine[], issWithheld: Map<string, number>): SimplesRevenueSlice[] {
  const slices = new Map<BrSimplesAnexo, SimplesRevenueSlice>();
  const serviceTotalByInvoice = new Map<string, number>();
  for (const l of lines) if (l.kind === 'service') serviceTotalByInvoice.set(l.invoiceId, (serviceTotalByInvoice.get(l.invoiceId) ?? 0) + l.amount);
  for (const l of lines) {
    const slice = slices.get(l.anexo) ?? { anexo: l.anexo, revenue: 0, issWithheld: 0, exports: 0 };
    slice.revenue += l.amount;
    if (l.kind === 'export') slice.exports = (slice.exports ?? 0) + l.amount;
    const serviceTotal = serviceTotalByInvoice.get(l.invoiceId) ?? 0;
    if (l.kind === 'service' && serviceTotal) {
      slice.issWithheld = (slice.issWithheld ?? 0) + ((issWithheld.get(l.invoiceId) ?? 0) * l.amount) / serviceTotal;
    }
    slices.set(l.anexo, slice);
  }
  return [...slices.values()];
}

/** Net movement (debit - credit, base currency) of a set of accounts over [from, to). */
async function accountMovement(db: Database, entityId: string, accountIds: string[], from: Date, to: Date): Promise<number> {
  if (accountIds.length === 0) return 0;
  const [row] = await db
    .select({
      net: sql<string>`coalesce(sum(coalesce(${schema.journalLines.baseCurrencyDebit}, ${schema.journalLines.debit}) - coalesce(${schema.journalLines.baseCurrencyCredit}, ${schema.journalLines.credit})), 0)`,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.journalEntryId, schema.journalEntries.id))
    .where(
      and(
        eq(schema.journalLines.entityId, entityId),
        inArray(schema.journalLines.accountId, accountIds),
        gte(schema.journalEntries.date, from),
        lt(schema.journalEntries.date, to),
        eq(schema.journalEntries.status, 'posted'),
      ),
    );
  return Number.parseFloat(row?.net ?? '0');
}

async function taxLedger(db: Database, entityId: string, start: string, end: string): Promise<BrTaxLedgerTotal[]> {
  const rows = await db
    .select({
      component: schema.taxLines.component,
      direction: schema.taxLines.direction,
      taxable: sql<string>`coalesce(sum(${schema.taxLines.baseTaxableAmount}), 0)`,
      tax: sql<string>`coalesce(sum(${schema.taxLines.baseTaxAmount}), 0)`,
    })
    .from(schema.taxLines)
    .where(and(eq(schema.taxLines.entityId, entityId), gte(schema.taxLines.taxDate, start), sql`${schema.taxLines.taxDate} <= ${end}`))
    .groupBy(schema.taxLines.component, schema.taxLines.direction);
  return rows
    .filter((r) => r.component && (r.direction === 'sales' || r.direction === 'purchase'))
    .map((r) => ({
      component: r.component as string,
      direction: r.direction as 'sales' | 'purchase',
      taxableAmount: Number.parseFloat(r.taxable),
      taxAmount: Number.parseFloat(r.tax),
    }));
}

async function quarterRevenue(db: Database, entity: EntityRow, period: string): Promise<BrQuarterRevenue | undefined> {
  const [year, month] = period.split('-').map(Number);
  if (month % 3 !== 0) return undefined;
  const services: number[] = [];
  const goods: number[] = [];
  for (let q = 1; q <= month / 3; q++) {
    const from = new Date(Date.UTC(year, (q - 1) * 3, 1));
    const { lines } = await revenueLines(db, entity, from, addMonths(from, 3));
    services.push(roundMoney(lines.filter((l) => l.kind !== 'goods').reduce((s, l) => s + l.amount, 0)));
    goods.push(roundMoney(lines.filter((l) => l.kind === 'goods').reduce((s, l) => s + l.amount, 0)));
  }

  const qFrom = new Date(Date.UTC(year, month - 3, 1));
  const qTo = new Date(Date.UTC(year, month, 1));
  const accounts = await db
    .select({ id: schema.accounts.id, type: schema.accounts.type, subtype: schema.accounts.subtype, metadata: schema.accounts.metadata })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entity.id), isNull(schema.accounts.deletedAt)));
  const roleOf = (a: (typeof accounts)[number]) => (a.metadata as { systemRole?: string } | null)?.systemRole;
  const otherIncomeIds = accounts.filter((a) => a.subtype === 'other_income').map((a) => a.id);
  const incomeTaxRoles = new Set(['income_tax_expense', 'social_contribution_expense']);
  const resultIds = accounts.filter((a) => (a.type === 'revenue' || a.type === 'expense') && !incomeTaxRoles.has(roleOf(a) ?? '')).map((a) => a.id);

  // Income is a credit balance: negate the movement.
  const otherIncome = -(await accountMovement(db, entity.id, otherIncomeIds, qFrom, qTo));
  const profitBeforeTax = -(await accountMovement(db, entity.id, resultIds, qFrom, qTo));
  return { services, goods, otherIncome: roundMoney(otherIncome), profitBeforeTax: roundMoney(profitBeforeTax) };
}

/** Payroll of the 12 months before the period (salaries, pró-labore, charges), for the fator R. */
async function payroll12m(db: Database, entity: EntityRow, from: Date): Promise<number> {
  const accounts = await loadEntityAccounts(db, entity.id);
  const ids = [
    accountForRole(accounts, 'payroll_wages_expense')?.id,
    accountForRole(accounts, 'payroll_tax_expense')?.id,
    accounts.byCode('4.2.1.03')?.id, // pró-labore
  ].filter((id): id is string => Boolean(id));
  const fromLedger = await accountMovement(db, entity.id, ids, addMonths(from, -12), from);
  return fromLedger > 0 ? roundMoney(fromLedger) : (brSettingsOf(entity.jurisdictionSettings).payroll12m ?? 0);
}

export async function computeEntityApuracao(db: Database, entity: EntityRow, period: string): Promise<BrApuracao> {
  if (entity.jurisdictionCode !== 'BR') throw new BrApuracaoError('The apuração is for Brazilian entities only');
  const regime = brRegimeOf(entity.taxClassification);
  const { from, to, start, end } = monthRange(period);
  const month = await revenueLines(db, entity, from, to);

  let simples: { slices: SimplesRevenueSlice[]; rbt12: number; payroll12m: number } | undefined;
  if (regime === 'simples_nacional') {
    const previousFrom = addMonths(from, -12);
    const opened = entity.createdAt ? new Date(Date.UTC(entity.createdAt.getUTCFullYear(), entity.createdAt.getUTCMonth(), 1)) : previousFrom;
    const activeFrom = opened > previousFrom ? opened : previousFrom;
    const monthsBefore = Math.max(0, (from.getUTCFullYear() - activeFrom.getUTCFullYear()) * 12 + from.getUTCMonth() - activeFrom.getUTCMonth());
    const before = await revenueLines(db, entity, previousFrom, from);
    const revenueBefore = before.lines.reduce((s, l) => s + l.amount, 0);
    const currentRevenue = month.lines.reduce((s, l) => s + l.amount, 0);
    simples = {
      slices: simplesSlices(month.lines, month.issWithheld),
      rbt12: roundMoney(proportionalRbt12({ revenueBefore, monthsBefore, currentMonthRevenue: currentRevenue })),
      payroll12m: await payroll12m(db, entity, from),
    };
  }

  const kinds = new Set(month.lines.map((l) => l.kind));
  let meiActivity: 'commerce' | 'services' | 'both' = 'services';
  if (kinds.has('goods')) meiActivity = kinds.has('service') ? 'both' : 'commerce';

  const result = computeBrApuracao({
    period,
    regime,
    meiActivity,
    simples,
    ledger: await taxLedger(db, entity.id, start, end),
    quarter: regime === 'lucro_presumido' || regime === 'lucro_real' ? await quarterRevenue(db, entity, period) : undefined,
    applyLc224: (entity.jurisdictionSettings as { lc224Injunction?: boolean } | null)?.lc224Injunction !== true,
  });
  return result;
}

export interface StoredApuracao {
  status: 'open' | 'booked';
  taxReturnId?: string;
  journalEntryId?: string;
}

export async function storedApuracao(db: Database, entityId: string, period: string): Promise<StoredApuracao> {
  const { start } = monthRange(period);
  const [row] = await db
    .select({ id: schema.taxReturns.id, summary: schema.taxReturns.summary })
    .from(schema.taxReturns)
    .where(
      and(
        eq(schema.taxReturns.entityId, entityId),
        eq(schema.taxReturns.jurisdictionCode, 'BR'),
        eq(schema.taxReturns.periodStart, start),
        isNull(schema.taxReturns.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return { status: 'open' };
  const journalEntryId = (row.summary as { journalEntryId?: string } | null)?.journalEntryId;
  return { status: 'booked', taxReturnId: row.id, journalEntryId };
}

/**
 * Book a month: the DAS, the quarter's IRPJ/CSLL and the offsets of what
 * customers withheld. Booking twice is refused (the posting key is the month).
 */
export async function bookApuracao(
  db: Database,
  entity: EntityRow,
  period: string,
  userId: string | null,
): Promise<{ taxReturnId: string; journalEntryId: string | null; apuracao: BrApuracao }> {
  const existing = await storedApuracao(db, entity.id, period);
  if (existing.status === 'booked') throw new BrApuracaoError(`The apuração of ${period} is already booked`);
  const apuracao = await computeEntityApuracao(db, entity, period);
  const accounts = await loadEntityAccounts(db, entity.id);
  const role = (name: string) => {
    const account = accountForRole(accounts, name);
    if (!account) throw new PostingError(`No account with the role ${name}. Add it to the chart of accounts.`);
    return account.id;
  };
  const lines: PostingLine[] = [];
  const pair = (debitRole: string, creditRole: string, amount: number, description: string) => {
    const value = roundMoney(amount);
    if (value <= 0) return;
    lines.push({ accountId: role(debitRole), debit: value, description });
    lines.push({ accountId: role(creditRole), credit: value, description });
  };

  const das = (apuracao.simples?.total ?? 0) + (apuracao.mei?.amount ?? 0);
  pair('revenue_deduction_simples', 'tax_payable_simples', das, `DAS ${period}`);
  for (const tax of apuracao.taxes) {
    if (tax.code === 'pis') pair('tax_payable_pis', 'withheld_receivable_pis', Math.min(tax.offsets, tax.debits - tax.credits), `PIS retido compensado ${period}`);
    if (tax.code === 'cofins') pair('tax_payable_cofins', 'withheld_receivable_cofins', Math.min(tax.offsets, tax.debits - tax.credits), `COFINS retida compensada ${period}`);
  }
  const q = apuracao.quarterly;
  if (q) {
    pair('income_tax_expense', 'tax_payable_irpj', q.irpj + q.irpjAdditional, `IRPJ ${q.quarter}º trimestre`);
    pair('social_contribution_expense', 'tax_payable_csll', q.csll, `CSLL ${q.quarter}º trimestre`);
    pair('tax_payable_irpj', 'withheld_receivable_irrf', q.irrfOffset, `IRRF retido compensado ${q.quarter}º trimestre`);
    pair('tax_payable_csll', 'withheld_receivable_csll', q.csllOffset, `CSLL retida compensada ${q.quarter}º trimestre`);
  }

  const { start, end } = monthRange(period);
  const taxReturnId = generateId('txr');
  const now = new Date();
  const summary = { ...apuracao } as unknown as Record<string, unknown>;
  const returnRow = {
    id: taxReturnId,
    entityId: entity.id,
    jurisdictionCode: 'BR',
    periodStart: start,
    periodEnd: end,
    status: 'calculated',
    totalDue: apuracao.total.toFixed(2),
    createdAt: now,
    updatedAt: now,
  };

  if (lines.length === 0) {
    await db.insert(schema.taxReturns).values({ ...returnRow, summary });
    return { taxReturnId, journalEntryId: null, apuracao };
  }

  const posted = await postJournalEntry(db, {
    entityId: entity.id,
    date: new Date(`${end}T12:00:00Z`),
    description: `Apuração ${period}`,
    sourceType: 'tax_return',
    sourceId: taxReturnId,
    postingKey: `br-apuracao:${period}`,
    lockKind: 'general',
    lines,
    createdBy: userId,
    alsoWrite: (h, entry) => [h.insert(schema.taxReturns).values({ ...returnRow, summary: { ...summary, journalEntryId: entry.journalEntryId } })],
  });
  return { taxReturnId, journalEntryId: posted.journalEntryId, apuracao };
}
