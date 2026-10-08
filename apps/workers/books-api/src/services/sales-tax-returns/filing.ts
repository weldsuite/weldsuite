/**
 * Filing a return, and what happens to a filed period afterwards.
 *
 * Filing stamps every ledger row the worksheet counted with the return's id
 * (`tax_lines.tax_return_id`), in the same batch that marks the return filed,
 * so a filed period cannot change under it. The entity-wide tax lock date is
 * not moved: agencies have different periods, and the stamp protects the rows.
 *
 * A change to a filed period (a late credit memo, a voided invoice dated back
 * into it) never edits the filed return. It shows as an exception: an
 * unstamped ledger row dated in the period and posted after filing. The user
 * either amends the return (a new return for the same period, which counts the
 * exceptions and pays the difference) or carries the rows forward (the next
 * return of the agency counts them). The choice is recorded per row on the
 * filed return's `exceptions`.
 */

import { and, eq, gt, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { addMonths } from '@weldsuite/books-domain/us-compliance/dates';
import {
  FILED_STATUSES,
  TaxReturnError,
  chunk,
  isoDate,
  num,
  sumMoney,
  todayIn,
  type AgencyRow,
  type EntityRow,
  type ReturnRow,
  type TaxLineRow,
} from './common';
import { calculateReturn, reportingBasisOf, sameWorksheet, summaryOf, type Calculation } from './calculate';
import { describeDocuments, documentKey } from './documents';
import { buildPeriodRows, loadAgencyReturns } from './periods';
import { receivedByInvoice, type LoadedRows } from './rows';

const tl = schema.taxLines;

export interface Warning {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------

/** Statements that stamp the rows a return counted with its id. Rows another return stamped stay as they are. */
export function stampStatements(
  h: Database,
  args: {
    entityId: string;
    agency: AgencyRow;
    ret: Pick<ReturnRow, 'id' | 'periodStart' | 'periodEnd'>;
    rows: LoadedRows;
    cutoff: Date;
  },
): unknown[] {
  const statements: unknown[] = [];
  const stampIds = (ids: string[]) => {
    for (const part of chunk(ids, 2000)) {
      statements.push(h.update(tl).set({ taxReturnId: args.ret.id }).where(and(inArray(tl.id, part), isNull(tl.taxReturnId))));
    }
  };
  if (reportingBasisOf(args.agency) === 'cash') {
    stampIds(args.rows.settledIds);
    return statements;
  }
  statements.push(
    h
      .update(tl)
      .set({ taxReturnId: args.ret.id })
      .where(
        and(
          eq(tl.entityId, args.entityId),
          eq(tl.agencyId, args.agency.id),
          gte(tl.taxDate, args.ret.periodStart),
          lte(tl.taxDate, args.ret.periodEnd),
          inArray(tl.direction, ['sales', 'use']),
          isNull(tl.taxReturnId),
          lte(tl.createdAt, args.cutoff),
        ),
      ),
  );
  stampIds(args.rows.carriedIds);
  return statements;
}

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

export interface FileInput {
  entity: EntityRow;
  agency: AgencyRow;
  ret: ReturnRow;
  confirmationNumber: string;
  filedAt?: Date;
  userId: string | null;
  now?: Date;
}

export async function fileReturn(db: Database, input: FileInput): Promise<{ ret: ReturnRow; warnings: Warning[] }> {
  const { entity, agency, ret } = input;
  if (ret.status === 'open') throw new TaxReturnError('Calculate the return before filing it');
  if (FILED_STATUSES.includes(ret.status)) throw new TaxReturnError('This return has already been filed', 'conflict');
  if (!['calculated', 'reviewed'].includes(ret.status)) throw new TaxReturnError(`A ${ret.status} return cannot be filed`);

  const now = input.now ?? new Date();
  const filedAt = input.filedAt ?? now;
  const filedDay = isoDate(filedAt);
  if (filedDay < ret.periodEnd) throw new TaxReturnError('A return cannot be filed before its period has ended');

  // The ledger must still be what was calculated; filing counts and stamps exactly those rows.
  const calc = await calculateReturn(db, { entity, agency, ret, now, createdNotAfter: now });
  if (!sameWorksheet(summaryOf(ret), calc.summary)) {
    throw new TaxReturnError(
      'The ledger changed since this return was calculated. Recalculate it, review the worksheet and file again.',
      'conflict',
    );
  }

  await atomically(db, (h) => [
    h
      .update(schema.taxReturns)
      .set({
        status: 'filed',
        filedAt,
        filedBy: input.userId,
        confirmationNumber: input.confirmationNumber.trim(),
        updatedAt: now,
      })
      .where(and(eq(schema.taxReturns.id, ret.id), inArray(schema.taxReturns.status, ['calculated', 'reviewed']))),
    ...stampStatements(h, { entityId: ret.entityId, agency, ret, rows: calc.rows, cutoff: now }),
  ]);
  const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);
  if (!updated || updated.status !== 'filed' || updated.filedAt === null) throw new TaxReturnError('This return was changed while filing; reload it and try again', 'conflict');

  const warnings: Warning[] = [];
  const timely = !ret.dueDate || filedDay <= ret.dueDate;
  if (!timely) {
    warnings.push({
      code: 'late_filing',
      message: `Filed after the due date (${ret.dueDate}). Penalty and interest may apply; add them as adjustments before recording the payment.`,
    });
    if (((ret.adjustments ?? []) as Array<{ type: string }>).some((a) => a.type === 'vendor_discount')) {
      warnings.push({
        code: 'vendor_discount_late',
        message: 'The vendor discount only holds when the return is filed and paid on time. Remove it unless the state still allows it.',
      });
    }
  }
  const unfiled = await unfiledEarlierPeriods(db, agency, ret, todayIn(entity.timezone, now));
  if (unfiled.length > 0) {
    warnings.push({
      code: 'earlier_period_unfiled',
      message: `Earlier period(s) of this agency have no filed return: ${unfiled.join(', ')}.`,
    });
  }
  return { ret: updated, warnings };
}

/** Period ends before this return's period (within the last two years) that have no filed return. */
async function unfiledEarlierPeriods(db: Database, agency: AgencyRow, ret: ReturnRow, today: string): Promise<string[]> {
  const returns = await loadAgencyReturns(db, ret.entityId, agency.id);
  const from = addMonths(ret.periodStart, -24);
  const rows = buildPeriodRows(agency, returns, from, addMonths(ret.periodStart, 0), today);
  return rows.filter((p) => p.periodEnd < ret.periodStart && p.unfiled).map((p) => p.periodEnd);
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export interface StoredException {
  type: 'late_entry';
  taxLineId: string;
  resolution: 'carried_forward' | 'amended';
  resolvedAt: string;
  resolvedBy: string | null;
  amendedByReturnId?: string;
}

export function storedExceptions(ret: Pick<ReturnRow, 'exceptions'>): StoredException[] {
  return ((ret.exceptions ?? []) as Array<Record<string, unknown>>).filter(
    (e): e is StoredException & Record<string, unknown> =>
      e.type === 'late_entry' && typeof e.taxLineId === 'string' && (e.resolution === 'carried_forward' || e.resolution === 'amended'),
  );
}

export type ExceptionResolution = 'open' | 'carried_forward' | 'amended';

export interface ExceptionItem {
  key: string;
  document: { type: string; id: string | null; number: string | null; contactName: string | null; date: string | null };
  taxDate: string;
  postedAt: string;
  taxLineIds: string[];
  grossAmount: number;
  taxableAmount: number;
  taxAmount: number;
  resolution: ExceptionResolution | 'partial';
  amendedByReturnId: string | null;
  /** The return that counted a carried-forward row, once it was filed. */
  countedByReturnId: string | null;
}

export interface LatePayment {
  invoiceId: string;
  invoiceNumber: string | null;
  contactName: string | null;
  amount: number;
}

export interface ExceptionsResult {
  returnId: string;
  applicable: boolean;
  items: ExceptionItem[];
  /** Cash basis: payments dated in the period but recorded after filing. An amended return picks them up; they cannot be carried forward. */
  latePayments: LatePayment[];
  totals: Record<ExceptionResolution, { documents: number; taxAmount: number }>;
}

async function isLatestInChain(db: Database, ret: ReturnRow): Promise<boolean> {
  const [later] = await db
    .select({ id: schema.taxReturns.id })
    .from(schema.taxReturns)
    .where(
      and(
        eq(schema.taxReturns.entityId, ret.entityId),
        eq(schema.taxReturns.amendsReturnId, ret.id),
        isNull(schema.taxReturns.deletedAt),
        inArray(schema.taxReturns.status, [...FILED_STATUSES]),
      ),
    )
    .limit(1);
  return !later;
}

async function liveExceptionRows(db: Database, agency: AgencyRow, ret: ReturnRow): Promise<TaxLineRow[]> {
  if (!ret.filedAt || !(await isLatestInChain(db, ret))) return [];
  const conditions: SQL[] = [
    eq(tl.entityId, ret.entityId),
    eq(tl.agencyId, agency.id),
    gte(tl.taxDate, ret.periodStart),
    lte(tl.taxDate, ret.periodEnd),
    inArray(tl.direction, ['sales', 'use']),
    isNull(tl.taxReturnId),
    gt(tl.createdAt, ret.filedAt),
  ];
  // Cash basis counts invoices by payment; their rows are not exceptions, late payments are.
  if (reportingBasisOf(agency) === 'cash') conditions.push(sql`${tl.sourceType} <> 'invoice'`);
  return db.select().from(tl).where(and(...conditions));
}

export async function listExceptions(
  db: Database,
  args: { entity: EntityRow; agency: AgencyRow; ret: ReturnRow },
): Promise<ExceptionsResult> {
  const { agency, ret } = args;
  const empty: ExceptionsResult['totals'] = {
    open: { documents: 0, taxAmount: 0 },
    carried_forward: { documents: 0, taxAmount: 0 },
    amended: { documents: 0, taxAmount: 0 },
  };
  if (!FILED_STATUSES.includes(ret.status)) {
    return { returnId: ret.id, applicable: false, items: [], latePayments: [], totals: empty };
  }

  const stored = new Map(storedExceptions(ret).map((e) => [e.taxLineId, e]));
  const live = await liveExceptionRows(db, agency, ret);
  const storedRows: TaxLineRow[] = [];
  const missing = [...stored.keys()].filter((id) => !live.some((r) => r.id === id));
  for (const part of chunk(missing, 2000)) {
    storedRows.push(...(await db.select().from(tl).where(inArray(tl.id, part))));
  }
  const rows = [...live, ...storedRows];
  const docs = await describeDocuments(db, ret.entityId, rows);

  const byDoc = new Map<string, TaxLineRow[]>();
  for (const row of rows) {
    const key = documentKey(row);
    const list = byDoc.get(key);
    if (list) list.push(row);
    else byDoc.set(key, [row]);
  }

  const items: ExceptionItem[] = [];
  for (const [key, list] of byDoc) {
    const resolutions = new Set(list.map((r): ExceptionResolution => stored.get(r.id)?.resolution ?? 'open'));
    const info = docs.get(key)!;
    const amended = list.map((r) => stored.get(r.id)?.amendedByReturnId).find(Boolean) ?? null;
    const counted = list.find((r) => r.taxReturnId && r.taxReturnId !== ret.id && stored.get(r.id)?.resolution === 'carried_forward');
    items.push({
      key,
      document: { type: info.type, id: info.id, number: info.number, contactName: info.contactName, date: info.date },
      taxDate: list[0]!.taxDate,
      postedAt: list.reduce((latest, r) => (r.createdAt > latest ? r.createdAt : latest), list[0]!.createdAt).toISOString(),
      taxLineIds: list.map((r) => r.id),
      grossAmount: sumMoney(list.filter((r) => r.grossAmount !== null).map((r) => num(r.grossAmount))),
      taxableAmount: sumMoney(list.map((r) => num(r.taxableAmount))),
      taxAmount: sumMoney(list.map((r) => num(r.taxAmount))),
      resolution: resolutions.size === 1 ? [...resolutions][0]! : 'partial',
      amendedByReturnId: amended,
      countedByReturnId: counted?.taxReturnId ?? null,
    });
  }
  items.sort((a, b) => a.taxDate.localeCompare(b.taxDate) || a.key.localeCompare(b.key));

  const totals: ExceptionsResult['totals'] = JSON.parse(JSON.stringify(empty));
  for (const item of items) {
    const bucket = item.resolution === 'partial' ? 'open' : item.resolution;
    totals[bucket].documents += 1;
    totals[bucket].taxAmount = sumMoney([totals[bucket].taxAmount, item.taxAmount]);
  }

  return {
    returnId: ret.id,
    applicable: true,
    items,
    latePayments: reportingBasisOf(agency) === 'cash' ? await latePayments(db, ret) : [],
    totals,
  };
}

async function latePayments(db: Database, ret: ReturnRow): Promise<LatePayment[]> {
  if (!ret.filedAt) return [];
  const from = new Date(`${ret.periodStart}T00:00:00Z`);
  const before = new Date(`${ret.periodEnd}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() + 1);
  const late = await receivedByInvoice(db, ret.entityId, { from, before, createdAfter: ret.filedAt });
  const ids = [...late.keys()];
  if (ids.length === 0) return [];
  const docs = await describeDocuments(
    db,
    ret.entityId,
    ids.map((id) => ({ sourceType: 'invoice', sourceId: id, journalEntryId: id })),
  );
  return ids.map((id) => {
    const info = docs.get(`invoice|${id}`);
    return { invoiceId: id, invoiceNumber: info?.number ?? null, contactName: info?.contactName ?? null, amount: late.get(id) ?? 0 };
  });
}

function openRowIds(result: ExceptionsResult): string[] {
  return result.items.filter((i) => i.resolution === 'open' || i.resolution === 'partial').flatMap((i) => i.taxLineIds);
}

/** Records how exception rows were resolved on the filed return. */
function withResolutions(
  ret: Pick<ReturnRow, 'exceptions'>,
  ids: string[],
  resolution: StoredException['resolution'],
  userId: string | null,
  now: Date,
  amendedByReturnId?: string,
): Array<Record<string, unknown>> {
  const keep = (ret.exceptions ?? []) as Array<Record<string, unknown>>;
  const resolved = new Set(ids);
  return [
    ...keep.filter((e) => !(e.type === 'late_entry' && typeof e.taxLineId === 'string' && resolved.has(e.taxLineId))),
    ...ids.map((taxLineId) => ({
      type: 'late_entry',
      taxLineId,
      resolution,
      resolvedAt: now.toISOString(),
      resolvedBy: userId,
      ...(amendedByReturnId ? { amendedByReturnId } : {}),
    })),
  ];
}

// ---------------------------------------------------------------------------
// Carry forward
// ---------------------------------------------------------------------------

export interface CarryForwardResult {
  ret: ReturnRow;
  carriedRows: number;
  taxAmount: number;
  /** Later returns of the agency that are still open: recalculate them to pick the rows up. */
  recalculate: Array<{ id: string; status: string; periodEnd: string }>;
}

export async function carryForward(
  db: Database,
  args: { entity: EntityRow; agency: AgencyRow; ret: ReturnRow; taxLineIds?: string[]; userId: string | null; now?: Date },
): Promise<CarryForwardResult> {
  const { ret } = args;
  if (!FILED_STATUSES.includes(ret.status)) throw new TaxReturnError('Only a filed return has exceptions to carry forward');
  const now = args.now ?? new Date();
  const result = await listExceptions(db, args);
  const open = new Set(openRowIds(result));
  const ids = args.taxLineIds && args.taxLineIds.length > 0 ? [...new Set(args.taxLineIds)] : [...open];
  const unknown = ids.filter((id) => !open.has(id));
  if (unknown.length > 0) throw new TaxReturnError('Some rows are not open exceptions of this return', 'bad_request', { taxLineIds: unknown });
  if (ids.length === 0) throw new TaxReturnError('This return has no open exceptions to carry forward');

  const exceptions = withResolutions(ret, ids, 'carried_forward', args.userId, now);
  await db.update(schema.taxReturns).set({ exceptions, updatedAt: now }).where(eq(schema.taxReturns.id, ret.id));
  const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);

  const carried = result.items.filter((i) => i.taxLineIds.some((id) => ids.includes(id)));
  const later = await db
    .select({ id: schema.taxReturns.id, status: schema.taxReturns.status, periodEnd: schema.taxReturns.periodEnd })
    .from(schema.taxReturns)
    .where(
      and(
        eq(schema.taxReturns.entityId, ret.entityId),
        eq(schema.taxReturns.agencyId, args.agency.id),
        isNull(schema.taxReturns.deletedAt),
        gt(schema.taxReturns.periodStart, ret.periodEnd),
        inArray(schema.taxReturns.status, ['calculated', 'reviewed']),
      ),
    );
  return {
    ret: updated ?? ret,
    carriedRows: ids.length,
    taxAmount: sumMoney(carried.map((i) => i.taxAmount)),
    recalculate: later,
  };
}

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

export async function amendReturn(
  db: Database,
  args: { entity: EntityRow; agency: AgencyRow; ret: ReturnRow; userId: string | null; now?: Date },
): Promise<{ ret: ReturnRow; calculation: Calculation; exceptionRows: number }> {
  const { entity, agency, ret } = args;
  if (!FILED_STATUSES.includes(ret.status)) throw new TaxReturnError('Only a filed return can be amended');
  const now = args.now ?? new Date();

  const [existing] = await db
    .select({ id: schema.taxReturns.id, status: schema.taxReturns.status })
    .from(schema.taxReturns)
    .where(and(eq(schema.taxReturns.amendsReturnId, ret.id), isNull(schema.taxReturns.deletedAt)))
    .limit(1);
  if (existing) {
    throw new TaxReturnError(
      FILED_STATUSES.includes(existing.status)
        ? `This return was already amended by ${existing.id}; amend that return instead`
        : `An amended return (${existing.id}) is already open for this period`,
      'conflict',
    );
  }

  // Rows still waiting as exceptions (open, or carried forward but not yet counted) move into the amendment.
  const exceptions = await listExceptions(db, { entity, agency, ret });
  const takeIds = exceptions.items
    .filter((i) => i.resolution !== 'amended' && !i.countedByReturnId)
    .flatMap((i) => i.taxLineIds);

  const id = generateId('txr');
  const draft: ReturnRow = {
    id,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId: ret.entityId,
    jurisdictionCode: ret.jurisdictionCode,
    agencyId: ret.agencyId,
    stateCode: ret.stateCode,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    dueDate: ret.dueDate,
    status: 'open',
    reportingBasis: ret.reportingBasis,
    summary: null,
    lines: null,
    adjustments: null,
    exceptions: null,
    totalDue: '0',
    filedAt: null,
    filedBy: null,
    confirmationNumber: null,
    paidAt: null,
    paymentAmount: null,
    paymentBankAccountId: null,
    paymentJournalEntryId: null,
    amendsReturnId: ret.id,
    notes: null,
  };
  const calculation = await calculateReturn(db, { entity, agency, ret: draft, now });
  if (takeIds.length === 0 && sameWorksheet(summaryOf(ret), calculation.summary)) {
    throw new TaxReturnError('Nothing to amend: the ledger still matches the filed return');
  }

  await atomically(db, (h) => [
    h.insert(schema.taxReturns).values({
      ...draft,
      status: 'calculated',
      summary: calculation.summary as unknown as Record<string, unknown>,
      lines: calculation.lines,
      adjustments: calculation.adjustments,
      totalDue: calculation.totalDue.toFixed(2),
    }),
    ...(takeIds.length > 0
      ? [
          h
            .update(schema.taxReturns)
            .set({ exceptions: withResolutions(ret, takeIds, 'amended', args.userId, now, id), updatedAt: now })
            .where(eq(schema.taxReturns.id, ret.id)),
        ]
      : []),
  ]);
  const [created] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, id)).limit(1);
  return { ret: created!, calculation, exceptionRows: takeIds.length };
}

/** Takes the "amended" marks of a deleted amendment off the return it amended. */
export async function releaseAmendedExceptions(db: Database, amendment: ReturnRow): Promise<void> {
  if (!amendment.amendsReturnId) return;
  const [original] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, amendment.amendsReturnId)).limit(1);
  if (!original) return;
  const exceptions = ((original.exceptions ?? []) as Array<Record<string, unknown>>).filter(
    (e) => !(e.type === 'late_entry' && e.resolution === 'amended' && e.amendedByReturnId === amendment.id),
  );
  if (exceptions.length === (original.exceptions ?? []).length) return;
  await db.update(schema.taxReturns).set({ exceptions, updatedAt: new Date() }).where(eq(schema.taxReturns.id, original.id));
}
