/**
 * Which tax-ledger rows a return's worksheet is built from.
 *
 * Accrual agencies: the agency's rows dated in the period that no filed return
 * has stamped yet, plus the rows stamped by the return itself (or the returns
 * it amends) and rows carried forward from an earlier period.
 *
 * Cash-basis agencies (where the state allows it): an invoice's rows count in
 * the period its payments are dated, in proportion to the payments (allocations
 * in the period divided by the invoice total, never beyond what is still
 * unreported). Credit memos, write-offs and reversals count on their tax date,
 * in proportion to the share of the original invoice paid by the end of the
 * period (a credit memo of an unpaid invoice never appears: its sale never
 * did). Every other row (journals, use tax) counts on its tax date. A voided
 * payment has no allocations, so its share drops out again. Shares are rounded
 * to the cent per row, so a partly paid invoice can differ by a cent across
 * periods.
 */

import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { SalesTaxWorksheetLine } from '@weldsuite/books-domain/jurisdictions/us/sales-tax-return';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { chunk, nextDay, num, startOfDay, toWorksheetLine, type AgencyRow, type TaxLineRow } from './common';

/** Source types that reduce an earlier sale: counted on their own date, scaled on a cash basis. */
const ADJUSTING_SOURCES = ['credit_note', 'reversal', 'write_off', 'bad_debt'];
const LEDGER_DIRECTIONS = ['sales', 'use'];
/** Postgres allows 65535 parameters; keep `IN` lists well below that. */
const ID_CHUNK = 2000;

export interface LoadRowsOptions {
  entityId: string;
  agency: AgencyRow;
  periodStart: string;
  periodEnd: string;
  reportingBasis: 'accrual' | 'cash';
  /** Returns whose stamped rows belong to this worksheet: the return itself, or the chain it amends. */
  includeStampedBy?: string[];
  /** Rows carried forward from an earlier period (`tax_lines.id`), counted in this period. */
  carriedIds?: string[];
  /** Ignore rows (and payments) created after this moment. */
  createdNotAfter?: Date;
  /** Only rows (and payments) created after this moment: what was posted after a return was filed. */
  createdAfter?: Date;
}

export interface LoadedEntry {
  row: TaxLineRow;
  line: SalesTaxWorksheetLine;
  /** Share of the row counted (1 on an accrual basis). */
  scale: number;
  /** Counted in this period although dated in an earlier one. */
  carried: boolean;
}

export interface LoadedRows {
  entries: LoadedEntry[];
  lines: SalesTaxWorksheetLine[];
  /** Rows the worksheet counts for good: stamped when the return is filed. */
  settledIds: string[];
  carriedIds: string[];
}

const tl = schema.taxLines;

function createdConditions(
  column: typeof tl.createdAt | typeof schema.payments.createdAt,
  opts: Pick<LoadRowsOptions, 'createdNotAfter' | 'createdAfter'>,
): SQL[] {
  const out: SQL[] = [];
  if (opts.createdNotAfter) out.push(lte(column, opts.createdNotAfter));
  if (opts.createdAfter) out.push(gt(column, opts.createdAfter));
  return out;
}

function stampCondition(includeStampedBy: string[] | undefined): SQL {
  return includeStampedBy && includeStampedBy.length > 0
    ? (or(isNull(tl.taxReturnId), inArray(tl.taxReturnId, includeStampedBy)) as SQL)
    : isNull(tl.taxReturnId);
}

function stampMatches(row: TaxLineRow, includeStampedBy: string[] | undefined): boolean {
  return row.taxReturnId === null || (includeStampedBy?.includes(row.taxReturnId) ?? false);
}

async function selectRowsByIds(db: Database, ids: string[]): Promise<TaxLineRow[]> {
  const out: TaxLineRow[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    out.push(...(await db.select().from(tl).where(inArray(tl.id, part))));
  }
  return out;
}

function entry(
  row: TaxLineRow,
  period: { start: string; end: string },
  options: { scale?: number; carried?: boolean; taxDate?: string } = {},
): LoadedEntry {
  const scale = options.scale ?? 1;
  const outside = row.taxDate < period.start || row.taxDate > period.end;
  // A carried-forward row is counted from the period's first day.
  const taxDate = options.taxDate ?? (outside ? period.start : row.taxDate);
  return { row, scale, carried: options.carried ?? outside, line: toWorksheetLine(row, { scale, taxDate }) };
}

function finish(entries: LoadedEntry[], settledIds: string[]): LoadedRows {
  return {
    entries,
    lines: entries.map((e) => e.line),
    settledIds,
    carriedIds: entries.filter((e) => e.carried).map((e) => e.row.id),
  };
}

/** Rows carried forward into this worksheet (still unstamped), counted from the period's first day. */
async function carriedEntries(db: Database, opts: LoadRowsOptions, taken: Set<string>): Promise<LoadedEntry[]> {
  const ids = [...new Set(opts.carriedIds ?? [])].filter((id) => !taken.has(id));
  if (ids.length === 0) return [];
  const rows = (await selectRowsByIds(db, ids)).filter(
    (row) => row.agencyId === opts.agency.id && LEDGER_DIRECTIONS.includes(row.direction) && stampMatches(row, opts.includeStampedBy),
  );
  const period = { start: opts.periodStart, end: opts.periodEnd };
  return rows.map((row) => entry(row, period, { carried: true, taxDate: opts.periodStart }));
}

async function loadAccrual(db: Database, opts: LoadRowsOptions): Promise<LoadedRows> {
  const period = { start: opts.periodStart, end: opts.periodEnd };
  const rows = await db
    .select()
    .from(tl)
    .where(
      and(
        eq(tl.entityId, opts.entityId),
        eq(tl.agencyId, opts.agency.id),
        gte(tl.taxDate, opts.periodStart),
        lte(tl.taxDate, opts.periodEnd),
        inArray(tl.direction, LEDGER_DIRECTIONS),
        stampCondition(opts.includeStampedBy),
        ...createdConditions(tl.createdAt, opts),
      ),
    );
  const own = rows.map((row) => entry(row, period));
  const carried = await carriedEntries(db, opts, new Set(own.map((e) => e.row.id)));
  const entries = [...own, ...carried];
  return finish(entries, entries.map((e) => e.row.id));
}

/** Payments received from customers, per invoice, dated in `[from, before)`; legacy payments with a bare `invoice_id` included. */
export async function receivedByInvoice(
  db: Database,
  entityId: string,
  filter: { invoiceIds?: string[]; from?: Date; before?: Date; createdNotAfter?: Date; createdAfter?: Date },
): Promise<Map<string, number>> {
  const pa = schema.paymentAllocations;
  const p = schema.payments;
  const totals = new Map<string, number>();
  const add = (invoiceId: string | null, amount: string | number | null) => {
    if (!invoiceId) return;
    totals.set(invoiceId, (totals.get(invoiceId) ?? 0) + num(amount));
  };

  const paymentConditions = (): SQL[] => {
    const c: SQL[] = [eq(p.entityId, entityId), isNull(p.deletedAt), eq(p.type, 'received')];
    if (filter.from) c.push(gte(p.date, filter.from));
    if (filter.before) c.push(lt(p.date, filter.before));
    c.push(...createdConditions(p.createdAt, filter));
    return c;
  };

  const idParts = filter.invoiceIds ? chunk(filter.invoiceIds, ID_CHUNK) : [undefined];
  for (const part of idParts) {
    const allocated = await db
      .select({ invoiceId: pa.invoiceId, amount: sql<string>`sum(${pa.amount})` })
      .from(pa)
      .innerJoin(p, eq(p.id, pa.paymentId))
      .where(and(...paymentConditions(), isNull(pa.deletedAt), isNotNull(pa.invoiceId), ...(part ? [inArray(pa.invoiceId, part)] : [])))
      .groupBy(pa.invoiceId);
    for (const r of allocated) add(r.invoiceId, r.amount);

    const legacy = await db
      .select({ invoiceId: p.invoiceId, amount: p.amount })
      .from(p)
      .where(
        and(
          ...paymentConditions(),
          isNotNull(p.invoiceId),
          sql`not exists (select 1 from ${pa} where ${pa.paymentId} = ${p.id} and ${pa.deletedAt} is null)`,
          ...(part ? [inArray(p.invoiceId, part)] : []),
        ),
      );
    for (const r of legacy) add(r.invoiceId, r.amount);
  }
  return totals;
}

async function invoiceTotals(db: Database, entityId: string, ids: string[]): Promise<Map<string, { total: number; creditNoteFor: string | null }>> {
  const out = new Map<string, { total: number; creditNoteFor: string | null }>();
  for (const part of chunk(ids, ID_CHUNK)) {
    const rows = await db
      .select({ id: schema.invoices.id, total: schema.invoices.total, creditNoteFor: schema.invoices.creditNoteForInvoiceId })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.entityId, entityId), inArray(schema.invoices.id, part)));
    for (const r of rows) out.set(r.id, { total: num(r.total), creditNoteFor: r.creditNoteFor });
  }
  return out;
}

async function loadCash(db: Database, opts: LoadRowsOptions): Promise<LoadedRows> {
  const period = { start: opts.periodStart, end: opts.periodEnd };
  const start = startOfDay(opts.periodStart);
  const after = startOfDay(nextDay(opts.periodEnd));
  const entries: LoadedEntry[] = [];
  const settled: string[] = [];

  // (A) invoices: counted in proportion to the payments of the period.
  const inPeriod = await receivedByInvoice(db, opts.entityId, {
    from: start,
    before: after,
    createdNotAfter: opts.createdNotAfter,
    createdAfter: opts.createdAfter,
  });
  const invoiceIds = [...inPeriod.keys()];
  if (invoiceIds.length > 0) {
    const totals = await invoiceTotals(db, opts.entityId, invoiceIds);
    const before = await receivedByInvoice(db, opts.entityId, {
      invoiceIds,
      before: start,
      createdNotAfter: opts.createdNotAfter,
    });
    const shares = new Map<string, { scale: number; settled: boolean }>();
    for (const [id, paidNow] of inPeriod) {
      const total = totals.get(id)?.total ?? 0;
      if (total <= 0) continue;
      const paidBefore = Math.min(before.get(id) ?? 0, total);
      const counted = Math.min(paidNow, Math.max(0, total - paidBefore));
      if (counted <= 0) continue;
      shares.set(id, { scale: counted / total, settled: paidBefore + counted >= total - 0.005 });
    }
    const rows: TaxLineRow[] = [];
    for (const part of chunk([...shares.keys()], ID_CHUNK)) {
      rows.push(
        ...(await db
          .select()
          .from(tl)
          .where(
            and(
              eq(tl.entityId, opts.entityId),
              eq(tl.agencyId, opts.agency.id),
              eq(tl.sourceType, 'invoice'),
              inArray(tl.sourceId, part),
              inArray(tl.direction, LEDGER_DIRECTIONS),
            ),
          )),
      );
    }
    // No stamp filter: an invoice's rows count again in every period it is paid in.
    for (const row of rows) {
      const share = shares.get(row.sourceId ?? '');
      if (!share) continue;
      // Counted on the day of payment: the row's own date may be in another period.
      entries.push(entry(row, period, { scale: share.scale, carried: false, taxDate: opts.periodEnd }));
      if (share.settled) settled.push(row.id);
    }
  }

  // (B) credit memos and the like, (C) everything else: on their tax date.
  const dated = await db
    .select()
    .from(tl)
    .where(
      and(
        eq(tl.entityId, opts.entityId),
        eq(tl.agencyId, opts.agency.id),
        gte(tl.taxDate, opts.periodStart),
        lte(tl.taxDate, opts.periodEnd),
        inArray(tl.direction, LEDGER_DIRECTIONS),
        sql`${tl.sourceType} <> 'invoice'`,
        stampCondition(opts.includeStampedBy),
        ...createdConditions(tl.createdAt, opts),
      ),
    );
  const adjusting = dated.filter((row) => ADJUSTING_SOURCES.includes(row.sourceType) && row.direction !== 'use');
  const sourceTotals = await invoiceTotals(
    db,
    opts.entityId,
    [...new Set(adjusting.map((r) => r.sourceId).filter((id): id is string => Boolean(id)))],
  );
  const originalOf = (row: TaxLineRow): string | null =>
    row.sourceType === 'credit_note' ? (sourceTotals.get(row.sourceId ?? '')?.creditNoteFor ?? null) : row.sourceId;
  const originalIds = [...new Set(adjusting.map(originalOf).filter((id): id is string => Boolean(id)))];
  const originalTotals = await invoiceTotals(db, opts.entityId, originalIds);
  const paidThroughPeriod = await receivedByInvoice(db, opts.entityId, { invoiceIds: originalIds, before: after });

  for (const row of dated) {
    let scale = 1;
    if (ADJUSTING_SOURCES.includes(row.sourceType) && row.direction !== 'use') {
      const originalId = originalOf(row);
      const total = originalId ? (originalTotals.get(originalId)?.total ?? 0) : 0;
      // No traceable original: counted in full, like any other row.
      if (originalId && total > 0) scale = Math.min(1, (paidThroughPeriod.get(originalId) ?? 0) / total);
      else if (originalId) scale = 0;
    }
    if (scale <= 0) continue;
    entries.push(entry(row, period, { scale }));
    settled.push(row.id);
  }

  const carried = await carriedEntries(db, opts, new Set(entries.map((e) => e.row.id)));
  entries.push(...carried);
  settled.push(...carried.map((e) => e.row.id));
  return finish(entries, settled);
}

/** The rows a return's worksheet is built from (see the file header for what counts). */
export function loadWorksheetRows(db: Database, opts: LoadRowsOptions): Promise<LoadedRows> {
  return opts.reportingBasis === 'cash' ? loadCash(db, opts) : loadAccrual(db, opts);
}

/** The rows a filed return counted: its own worksheet, as filed. */
export async function loadFiledRows(
  db: Database,
  args: {
    entityId: string;
    agency: AgencyRow;
    returnId: string;
    periodStart: string;
    periodEnd: string;
    reportingBasis: 'accrual' | 'cash';
    filedAt: Date | null;
  },
): Promise<LoadedRows> {
  const period = { start: args.periodStart, end: args.periodEnd };
  if (args.reportingBasis !== 'cash') {
    const rows = await db
      .select()
      .from(tl)
      .where(and(eq(tl.entityId, args.entityId), eq(tl.taxReturnId, args.returnId), inArray(tl.direction, LEDGER_DIRECTIONS)));
    const entries = rows.map((row) => entry(row, period));
    return finish(entries, entries.map((e) => e.row.id));
  }
  const outside = await db
    .select({ id: tl.id })
    .from(tl)
    .where(and(eq(tl.entityId, args.entityId), eq(tl.taxReturnId, args.returnId), or(lt(tl.taxDate, args.periodStart), gt(tl.taxDate, args.periodEnd))));
  return loadCash(db, {
    entityId: args.entityId,
    agency: args.agency,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    reportingBasis: 'cash',
    includeStampedBy: [args.returnId],
    carriedIds: outside.map((r) => r.id),
    // What was posted by the time of filing; later payments are exceptions.
    createdNotAfter: args.filedAt ?? undefined,
  });
}
