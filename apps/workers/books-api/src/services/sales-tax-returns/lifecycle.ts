/**
 * Creating, calculating, adjusting, reviewing, listing and deleting returns.
 * Filing, payment and amendments are in filing.ts and payment.ts.
 */

import { and, desc, eq, gte, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  EDITABLE_STATUSES,
  TaxReturnError,
  computeTotalDue,
  todayIn,
  type AgencyRow,
  type EntityRow,
  type ReturnAdjustment,
  type ReturnRow,
} from './common';
import { calculateReturn, type ReturnSummary } from './calculate';
import { releaseAmendedExceptions } from './filing';
import { loadAgencyReturns, matchPeriod, nextPeriodToOpen } from './periods';

export interface CreateReturnInput {
  entity: EntityRow;
  agency: AgencyRow;
  periodStart?: string;
  periodEnd?: string;
  now?: Date;
}

/** Creates an open return for a period of the agency's grid (the next one without a return when no dates are given). */
export async function createReturn(db: Database, input: CreateReturnInput): Promise<ReturnRow> {
  const { entity, agency } = input;
  if (agency.status === 'monitoring') {
    throw new TaxReturnError('The agency is only being monitored for nexus; register it before preparing a return');
  }
  const now = input.now ?? new Date();
  const today = todayIn(entity.timezone, now);
  const returns = await loadAgencyReturns(db, entity.id, agency.id);

  let period;
  if (input.periodStart && input.periodEnd) {
    period = matchPeriod(agency, input.periodStart, input.periodEnd);
    if (!period) {
      throw new TaxReturnError(
        `${input.periodStart} to ${input.periodEnd} is not a ${agency.filingFrequency} period of this agency. Check its filing frequency and first period start.`,
      );
    }
  } else if (input.periodStart || input.periodEnd) {
    throw new TaxReturnError('Give both periodStart and periodEnd, or neither to open the next period');
  } else {
    period = nextPeriodToOpen(agency, returns, today);
  }

  const clash = returns.find((r) => !r.amendsReturnId && r.periodStart <= period.periodEnd && r.periodEnd >= period.periodStart);
  if (clash) {
    throw new TaxReturnError(`This period already has a return (${clash.id}, ${clash.status})`, 'conflict', { returnId: clash.id });
  }

  const row: typeof schema.taxReturns.$inferInsert = {
    id: generateId('txr'),
    entityId: entity.id,
    jurisdictionCode: 'US',
    agencyId: agency.id,
    stateCode: agency.stateCode,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    dueDate: period.dueDate,
    status: 'open',
    reportingBasis: agency.reportingBasis === 'cash' ? 'cash' : 'accrual',
    adjustments: [],
    totalDue: '0',
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.taxReturns).values(row);
  const [created] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, row.id as string)).limit(1);
  return created!;
}

/** Builds the worksheet and stores it on the return (open, calculated or reviewed returns only). */
export async function calculateAndStore(
  db: Database,
  args: { entity: EntityRow; agency: AgencyRow; ret: ReturnRow; now?: Date },
): Promise<{ ret: ReturnRow; summary: ReturnSummary }> {
  const { ret } = args;
  if (!EDITABLE_STATUSES.includes(ret.status)) {
    throw new TaxReturnError(`A ${ret.status} return cannot be recalculated; amend it instead`, 'conflict');
  }
  const now = args.now ?? new Date();
  const calc = await calculateReturn(db, { ...args, now });
  await db
    .update(schema.taxReturns)
    .set({
      status: 'calculated',
      summary: calc.summary as unknown as Record<string, unknown>,
      lines: calc.lines,
      adjustments: calc.adjustments,
      totalDue: calc.totalDue.toFixed(2),
      updatedAt: now,
    })
    .where(and(eq(schema.taxReturns.id, ret.id), eq(schema.taxReturns.status, ret.status)));
  const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);
  if (!updated || updated.status !== 'calculated') throw new TaxReturnError('This return was changed meanwhile; reload it and try again', 'conflict');
  return { ret: updated, summary: calc.summary };
}

export interface PatchInput {
  adjustments?: ReturnAdjustment[];
  notes?: string | null;
}

/** Replaces the adjustments (before filing) and/or the notes. An edit after review sends the return back to `calculated`. */
export async function patchReturn(db: Database, ret: ReturnRow, patch: PatchInput, now: Date = new Date()): Promise<ReturnRow> {
  const set: Partial<typeof schema.taxReturns.$inferInsert> = { updatedAt: now };
  if (patch.adjustments !== undefined) {
    if (!EDITABLE_STATUSES.includes(ret.status)) {
      throw new TaxReturnError('A filed return cannot be adjusted; amend it instead', 'conflict');
    }
    const summary = (ret.summary ?? null) as Partial<ReturnSummary> | null;
    set.adjustments = patch.adjustments;
    set.totalDue = computeTotalDue(summary, patch.adjustments).toFixed(2);
    if (ret.status === 'reviewed') set.status = 'calculated';
  }
  if (patch.notes !== undefined) set.notes = patch.notes;
  await db.update(schema.taxReturns).set(set).where(eq(schema.taxReturns.id, ret.id));
  const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);
  return updated!;
}

export async function reviewReturn(db: Database, ret: ReturnRow, now: Date = new Date()): Promise<ReturnRow> {
  if (ret.status === 'reviewed') return ret;
  if (ret.status !== 'calculated') {
    throw new TaxReturnError(ret.status === 'open' ? 'Calculate the return before reviewing it' : `A ${ret.status} return cannot be reviewed`);
  }
  await db
    .update(schema.taxReturns)
    .set({ status: 'reviewed', updatedAt: now })
    .where(and(eq(schema.taxReturns.id, ret.id), eq(schema.taxReturns.status, 'calculated')));
  const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);
  return updated!;
}

/** Soft-deletes a return that is not filed yet (open, calculated or reviewed). */
export async function deleteReturn(db: Database, ret: ReturnRow, now: Date = new Date()): Promise<void> {
  if (!EDITABLE_STATUSES.includes(ret.status)) {
    throw new TaxReturnError('Only an open, calculated or reviewed return can be deleted', 'conflict');
  }
  await db
    .update(schema.taxReturns)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(schema.taxReturns.id, ret.id), isNull(schema.taxReturns.deletedAt)));
  await releaseAmendedExceptions(db, ret);
}

export interface ListFilter {
  agencyId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

function encodeCursor(row: Pick<ReturnRow, 'periodEnd' | 'id'>): string {
  return btoa(`${row.periodEnd}|${row.id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { periodEnd: string; id: string } | null {
  try {
    const [periodEnd, id] = atob(cursor.replaceAll('-', '+').replaceAll('_', '/')).split('|');
    return periodEnd && id && /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ? { periodEnd, id } : null;
  } catch {
    return null;
  }
}

/** Returns of an entity, newest period first, with a keyset cursor over (period end, id). */
export async function listReturns(
  db: Database,
  entityId: string,
  filter: ListFilter,
): Promise<{ rows: ReturnRow[]; totalCount: number; hasMore: boolean; cursor: string | null }> {
  const t = schema.taxReturns;
  const base: SQL[] = [eq(t.entityId, entityId), isNull(t.deletedAt)];
  if (filter.agencyId) base.push(eq(t.agencyId, filter.agencyId));
  if (filter.status) base.push(eq(t.status, filter.status));
  if (filter.from) base.push(gte(t.periodEnd, filter.from));
  if (filter.to) base.push(lte(t.periodStart, filter.to));

  const after = filter.cursor ? decodeCursor(filter.cursor) : null;
  if (filter.cursor && !after) throw new TaxReturnError('Invalid cursor');
  const page = after
    ? [...base, or(lt(t.periodEnd, after.periodEnd), and(eq(t.periodEnd, after.periodEnd), lt(t.id, after.id))) as SQL]
    : base;

  const [rows, count] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...page))
      .orderBy(desc(t.periodEnd), desc(t.id))
      .limit(filter.limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...base)),
  ]);
  const hasMore = rows.length > filter.limit;
  const pageRows = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    rows: pageRows,
    totalCount: Number(count[0]?.count ?? 0),
    hasMore,
    cursor: hasMore ? encodeCursor(pageRows.at(-1)!) : null,
  };
}
