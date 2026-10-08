/**
 * Posting the stored depreciation of the ledger book.
 *
 * One journal entry per period per entity, with a pair of lines per asset
 * (debit depreciation expense, credit accumulated depreciation). The posting
 * key is `fixed_asset:dep:<periodEnd>:<hash of the row ids>`, so:
 *
 * - running it twice posts nothing the second time (no unposted rows left);
 * - two runs at once, which both see the same rows, produce the same key and
 *   the posting service hands the second one the first one's entry;
 * - an asset added to a period that was already posted gets its own entry for
 *   that period instead of being swallowed by the old key.
 *
 * Lock dates and closed periods are the posting service's: a period it refuses
 * is reported in `skipped` and the run goes on with the next one. The rows of
 * a skipped period stay unposted and are picked up by the next run once the
 * lock is lifted (or never, if the books stay locked: depreciation of a locked
 * period needs a lock exception).
 *
 * `runMonthlyDepreciation` is what the daily cron calls.
 */

import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { addDays, endOfMonth, isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import { postJournalEntry, type PostingLine } from '../accounting-posting';
import {
  FixedAssetError,
  dayToDate,
  asNumber,
  fromCents,
  isLedgerError,
  toCents,
  type AssetRow,
  type BookRow,
  type DepreciationRowRecord,
} from './shared';

const assetsTable = schema.fixedAssets;
const booksTable = schema.fixedAssetBooks;
const depTable = schema.fixedAssetDepreciation;

export interface PostedPeriod {
  periodEnd: string;
  journalEntryId: string;
  entryNumber: string | null;
  /** Total depreciation of the entry. */
  amount: number;
  /** Number of assets in the entry. */
  assets: number;
  /** An entry for exactly these rows existed already (a retry or a concurrent run). */
  alreadyPosted: boolean;
}

export interface SkippedPeriod {
  periodEnd: string;
  assets: number;
  amount: number;
  reason: string;
}

export interface DepreciationRunResult {
  through: string;
  posted: PostedPeriod[];
  skipped: SkippedPeriod[];
  /** Assets whose last depreciation row was posted in this run (status `fully_depreciated`). */
  fullyDepreciatedAssetIds: string[];
  /** Total depreciation posted by this run, excluding entries that already existed. */
  totalPosted: number;
}

export interface PendingRow {
  row: DepreciationRowRecord;
  asset: AssetRow;
  book: BookRow;
}

/** The last day depreciation can be posted through when nothing else is asked: the end of last month. */
export function lastCompletedMonthEnd(today: string): string {
  const startOfThisMonth = `${today.slice(0, 7)}-01`;
  return addDays(startOfThisMonth, -1);
}

async function hashIds(ids: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode([...ids].sort().join(','));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Unposted depreciation rows of the ledger book up to and including `through`. */
export async function loadPendingRows(
  db: Database,
  args: { entityId: string; through: string; assetId?: string },
): Promise<PendingRow[]> {
  const conditions = [
    eq(depTable.entityId, args.entityId),
    isNull(depTable.journalEntryId),
    lte(depTable.periodEnd, args.through),
    eq(booksTable.postsToLedger, true),
    isNull(assetsTable.deletedAt),
    sql`${depTable.amount} > 0`,
  ];
  if (args.assetId) conditions.push(eq(depTable.assetId, args.assetId));
  const rows = await db
    .select({ row: depTable, asset: assetsTable, book: booksTable })
    .from(depTable)
    .innerJoin(booksTable, eq(depTable.bookId, booksTable.id))
    .innerJoin(assetsTable, eq(depTable.assetId, assetsTable.id))
    .where(and(...conditions));
  return rows.sort(
    (a, b) =>
      a.row.periodEnd.localeCompare(b.row.periodEnd) ||
      (a.asset.assetNumber ?? a.asset.name).localeCompare(b.asset.assetNumber ?? b.asset.name) ||
      a.row.id.localeCompare(b.row.id),
  );
}

function describePeriod(periodStart: string, periodEnd: string): string {
  return periodStart.slice(0, 7) === periodEnd.slice(0, 7) && endOfMonth(periodStart) === periodEnd
    ? `Depreciation ${periodStart.slice(0, 7)}`
    : `Depreciation ${periodStart} to ${periodEnd}`;
}

/** The pair of lines every asset's depreciation posts as, and the dimensions to put on them. */
export function depreciationLines(items: readonly Pick<PendingRow, 'row' | 'asset'>[]): {
  lines: PostingLine[];
  dimensions: Array<{ index: number; classId: string | null; locationId: string | null }>;
} {
  const lines: PostingLine[] = [];
  const dimensions: Array<{ index: number; classId: string | null; locationId: string | null }> = [];
  for (const { row, asset } of items) {
    const label = asset.assetNumber ? `${asset.assetNumber} ${asset.name}` : asset.name;
    const amount = asNumber(row.amount);
    lines.push({ accountId: asset.depreciationExpenseAccountId, debit: amount, description: `Depreciation ${label}` });
    lines.push({ accountId: asset.accumulatedDepreciationAccountId, credit: amount, description: `Accumulated depreciation ${label}` });
    if (asset.classId || asset.locationId) {
      dimensions.push({ index: lines.length - 2, classId: asset.classId, locationId: asset.locationId });
      dimensions.push({ index: lines.length - 1, classId: asset.classId, locationId: asset.locationId });
    }
  }
  return { lines, dimensions };
}

/**
 * Statements that put class and location on journal lines of an entry. The
 * posting service does not take dimensions yet, so they are written in the
 * same atomic batch by line position (`sort_order` is the index of the line).
 */
export function dimensionStatements(
  h: Database,
  journalEntryId: string,
  dimensions: ReadonlyArray<{ index: number; classId: string | null; locationId: string | null }>,
): unknown[] {
  const groups = new Map<string, { classId: string | null; locationId: string | null; indexes: number[] }>();
  for (const dimension of dimensions) {
    const key = `${dimension.classId ?? ''}|${dimension.locationId ?? ''}`;
    const group = groups.get(key) ?? { classId: dimension.classId, locationId: dimension.locationId, indexes: [] };
    group.indexes.push(dimension.index);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    h
      .update(schema.journalLines)
      .set({ classId: group.classId, locationId: group.locationId })
      .where(and(eq(schema.journalLines.journalEntryId, journalEntryId), inArray(schema.journalLines.sortOrder, group.indexes))),
  );
}

/** The last stored row of each ledger book, to see which postings finish an asset. */
async function lastPeriodEndByBook(db: Database, bookIds: readonly string[]): Promise<Map<string, string>> {
  if (bookIds.length === 0) return new Map();
  const rows = await db
    .select({ bookId: depTable.bookId, last: sql<string>`to_char(max(${depTable.periodEnd}), 'YYYY-MM-DD')` })
    .from(depTable)
    .where(inArray(depTable.bookId, [...bookIds]))
    .groupBy(depTable.bookId);
  return new Map(rows.map((row) => [row.bookId, row.last]));
}

export interface RunArgs {
  entityId: string;
  /** Last day (inclusive) of the last period to post. */
  through: string;
  userId?: string | null;
  /** Restrict the run to one asset. */
  assetId?: string;
  /** Mark an asset `fully_depreciated` when its last row is posted. Default true; the disposal catch-up turns it off. */
  finishAssets?: boolean;
}

export async function runDepreciation(db: Database, args: RunArgs): Promise<DepreciationRunResult> {
  if (!isIsoDate(args.through)) throw new FixedAssetError('through must be a date (YYYY-MM-DD)');
  const result: DepreciationRunResult = { through: args.through, posted: [], skipped: [], fullyDepreciatedAssetIds: [], totalPosted: 0 };

  const pending = await loadPendingRows(db, args);
  if (pending.length === 0) return result;
  const lastEnds = await lastPeriodEndByBook(db, [...new Set(pending.map((p) => p.book.id))]);

  const byPeriod = new Map<string, PendingRow[]>();
  for (const item of pending) {
    const group = byPeriod.get(item.row.periodEnd) ?? [];
    group.push(item);
    byPeriod.set(item.row.periodEnd, group);
  }

  for (const [periodEnd, items] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const total = items.reduce((sum, { row }) => sum + toCents(asNumber(row.amount)), 0);
    const { lines, dimensions } = depreciationLines(items);
    const rowIds = items.map(({ row }) => row.id);
    const finishing =
      args.finishAssets === false ? [] : items.filter(({ row, book }) => lastEnds.get(book.id) === row.periodEnd).map(({ asset }) => asset.id);
    const now = new Date();

    let posted;
    try {
      posted = await postJournalEntry(db, {
        entityId: args.entityId,
        date: dayToDate(periodEnd),
        description: describePeriod(items[0]!.row.periodStart, periodEnd),
        sourceType: 'fixed_asset_depreciation',
        postingKey: `fixed_asset:dep:${periodEnd}:${await hashIds(rowIds)}`,
        lockKind: 'general',
        createdBy: args.userId ?? null,
        isAutomatic: true,
        lines,
        alsoWrite: (h, entry) => {
          const statements: unknown[] = [
            h
              .update(depTable)
              .set({ journalEntryId: entry.journalEntryId })
              .where(and(inArray(depTable.id, rowIds), isNull(depTable.journalEntryId))),
            ...dimensionStatements(h, entry.journalEntryId, dimensions),
          ];
          if (finishing.length > 0) {
            statements.push(
              h
                .update(assetsTable)
                .set({ status: 'fully_depreciated', updatedAt: now })
                .where(and(inArray(assetsTable.id, finishing), eq(assetsTable.status, 'active'))),
            );
          }
          return statements;
        },
      });
    } catch (err) {
      if (!isLedgerError(err)) throw err;
      result.skipped.push({ periodEnd, assets: items.length, amount: fromCents(total), reason: err.message });
      continue;
    }
    if (!posted.journalEntryId) continue;

    if (posted.alreadyPosted) {
      // Another run (or an earlier attempt) wrote the entry; make sure its rows point at it.
      await db
        .update(depTable)
        .set({ journalEntryId: posted.journalEntryId })
        .where(and(inArray(depTable.id, rowIds), isNull(depTable.journalEntryId)));
      if (finishing.length > 0) {
        await db
          .update(assetsTable)
          .set({ status: 'fully_depreciated', updatedAt: now })
          .where(and(inArray(assetsTable.id, finishing), eq(assetsTable.status, 'active')));
      }
    } else {
      result.totalPosted += total;
      result.fullyDepreciatedAssetIds.push(...finishing);
    }
    result.posted.push({
      periodEnd,
      journalEntryId: posted.journalEntryId,
      entryNumber: posted.entryNumber,
      amount: fromCents(total),
      assets: items.length,
      alreadyPosted: posted.alreadyPosted,
    });
  }
  result.totalPosted = fromCents(result.totalPosted);
  return result;
}

export interface MonthlyRunArgs {
  /** One entity, or every entity with unposted depreciation. */
  entityId?: string;
  /** Last day (inclusive) of the last period to post; the cron passes `lastCompletedMonthEnd(today)`. */
  through: string;
  userId?: string | null;
}

export type EntityDepreciationRun = DepreciationRunResult & { entityId: string };

/**
 * The cron entry point: post the due depreciation of one entity, or of every
 * entity that has some. Never throws for a locked period (see `skipped`).
 *
 *   const results = await runMonthlyDepreciation(db, { through: lastCompletedMonthEnd(today) });
 */
export async function runMonthlyDepreciation(db: Database, args: MonthlyRunArgs): Promise<EntityDepreciationRun[]> {
  let entityIds: string[];
  if (args.entityId) {
    entityIds = [args.entityId];
  } else {
    const rows = await db
      .selectDistinct({ entityId: depTable.entityId })
      .from(depTable)
      .where(and(isNull(depTable.journalEntryId), lte(depTable.periodEnd, args.through)));
    entityIds = rows.map((row) => row.entityId).sort();
  }
  const results: EntityDepreciationRun[] = [];
  for (const entityId of entityIds) {
    const run = await runDepreciation(db, { entityId, through: args.through, userId: args.userId ?? null });
    if (run.posted.length > 0 || run.skipped.length > 0) results.push({ entityId, ...run });
  }
  return results;
}
