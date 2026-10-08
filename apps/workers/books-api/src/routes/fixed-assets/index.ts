/**
 * Fixed assets and depreciation: /api/fixed-assets.
 *
 *   GET    /                        list (status, assetClass, search, limit, cursor)
 *   GET    /register                ?asOf=&book=book|federal|state&stateCode=&includeDisposed=
 *   GET    /tax-depreciation        ?taxYear=&book=federal|state&stateCode=  (Form 4562 style)
 *   GET    /mid-quarter-test        ?taxYear=
 *   POST   /de-minimis-check        { amount, hasAfs, date? } → expense or capitalize
 *   POST   /from-bill-line          { billItemId, assetClass, ..., reclass? }
 *   POST   /depreciation/run        { through } post unposted ledger depreciation (journal:create)
 *   POST   /                        create (default books: `book` + for a US entity `federal`)
 *   GET    /:id                     asset + books + schedules + stored rows
 *   GET    /:id/schedule            ?book=&stateCode=  yearly rows per book, monthly rows for the ledger book
 *   PATCH  /:id                     change; the financial facts freeze once depreciation is posted
 *   DELETE /:id                     only while nothing is posted
 *   POST   /:id/dispose             { date, proceeds, depositAccountId?, gainLossAccountId? }
 *
 * One book (`book`, GAAP) posts to the ledger, month by month. The federal and
 * state books are for the return and are computed on request; they post
 * nothing. The mid-quarter test runs over the entity's federal MACRS assets
 * and decides each asset's convention, so adding a late-year purchase can move
 * the other assets of that year to the mid-quarter convention.
 *
 * Permissions: accounts:read | create | update | delete; posting (the run and a
 * disposal) also needs journal:create. Static paths are registered before
 * /:id.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import { fiscalYearRange } from '@weldsuite/books-domain/us-compliance/fiscal-year';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { todayFor } from '../../services/accounting-report-periods';
import {
  FixedAssetError,
  accumulatedPostedByAsset,
  assetDetail,
  booksByAsset,
  createFixedAsset,
  createFixedAssetFromBillLine,
  deMinimisCheck,
  deleteFixedAsset,
  disposeFixedAsset,
  fixedAssetRegister,
  isLedgerError,
  loadAsset,
  loadBooks,
  loadEntity,
  loadLedgerRows,
  midQuarterTestFor,
  runDepreciation,
  scheduleContextFor,
  taxDepreciationReport,
  updateFixedAsset,
} from '../../services/fixed-assets';
import { annualSchedule } from '../../services/fixed-assets/schedules';
import { entityFiscalConfig, money } from '../../services/fixed-assets/shared';
import {
  createAssetSchema,
  deMinimisSchema,
  disposeSchema,
  fromBillLineSchema,
  runSchema,
  updateAssetSchema,
} from './schemas';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.fixedAssets;
const LOG = '[books-api/fixed-assets]';

/** Map a service failure to the response; anything unexpected is a 500. */
function fail(c: Context, err: unknown, what: string) {
  if (err instanceof FixedAssetError) {
    if (err.kind === 'not_found') return error.notFound(c, err.message.replace(/ not found$/, ''));
    if (err.kind === 'conflict') return error.conflict(c, err.message);
    return error.badRequest(c, err.message);
  }
  if (isLedgerError(err)) return error.badRequest(c, err.message);
  console.error(`${LOG} ${what} failed:`, err);
  return error.internal(c, `Failed to ${what}`);
}

async function requireEntity(c: Context<{ Bindings: Env; Variables: Variables }>, db: Database): Promise<string | null> {
  return resolveEntityId(c, db);
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return btoa(encodeURIComponent(JSON.stringify([row.createdAt.toISOString(), row.id])));
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(cursor))) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') return [parsed[0], parsed[1]];
  } catch {
    // fall through
  }
  return null;
}

function eventData(asset: typeof t.$inferSelect) {
  return { ...asset } as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /

app.get('/', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(Math.max(Number.parseInt(q.limit || '50', 10) || 50, 1), 200);
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const conditions: SQL[] = [isNull(t.deletedAt), eq(t.entityId, entityId)];
    if (q.status) conditions.push(eq(t.status, q.status));
    if (q.assetClass) conditions.push(eq(t.assetClass, q.assetClass));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(ilike(t.name, term), ilike(t.assetNumber, term))!);
    }
    const total = await db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions));

    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) return error.badRequest(c, 'Invalid cursor');
      conditions.push(sql`(${t.createdAt}, ${t.id}) < (${new Date(decoded[0])}, ${decoded[1]})`);
    }
    const rows = await db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const ids = page.map((row) => row.id);
    const [books, posted] = await Promise.all([booksByAsset(db, ids), accumulatedPostedByAsset(db, ids)]);
    const data = page.map((row) => {
      const postedCents = posted.get(row.id) ?? 0;
      return {
        ...row,
        books: (books.get(row.id) ?? []).map((book) => ({
          id: book.id,
          book: book.book,
          stateCode: book.stateCode,
          method: book.method,
          convention: book.convention,
          recoveryYears: book.recoveryYears,
          postsToLedger: book.postsToLedger,
        })),
        accumulatedPosted: money(postedCents),
        netBookValuePosted: money(Math.round(Number(row.cost) * 100) - postedCents),
      };
    });
    return list(c, data, cursorPagination(Number(total[0]?.count ?? 0), hasMore, hasMore ? encodeCursor(page[page.length - 1]!) : null));
  } catch (err) {
    return fail(c, err, 'list fixed assets');
  }
});

// ---------------------------------------------------------------------------
// Reports (before /:id)

app.get('/register', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const entity = await loadEntity(db, entityId);
    const asOf = q.asOf || todayFor(entity);
    if (!isIsoDate(asOf)) return error.badRequest(c, 'asOf must be a date (YYYY-MM-DD)');
    const book = q.book || 'book';
    if (book !== 'book' && book !== 'federal' && book !== 'state') return error.badRequest(c, "book must be 'book', 'federal' or 'state'");
    if (book === 'state' && !q.stateCode) return error.badRequest(c, 'A state register needs a stateCode');
    return success(c, await fixedAssetRegister(db, { entityId, asOf, book, stateCode: q.stateCode, includeDisposed: q.includeDisposed === 'true' }));
  } catch (err) {
    return fail(c, err, 'build the fixed asset register');
  }
});

app.get('/tax-depreciation', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const entity = await loadEntity(db, entityId);
    const taxYear = q.taxYear ? Number.parseInt(q.taxYear, 10) : fiscalYearRange(entityFiscalConfig(entity), todayFor(entity)).year;
    if (!Number.isInteger(taxYear) || taxYear < 1990 || taxYear > 2200) return error.badRequest(c, 'taxYear must be a year');
    const book = q.book || 'federal';
    if (book !== 'federal' && book !== 'state') return error.badRequest(c, "book must be 'federal' or 'state'");
    return success(c, await taxDepreciationReport(db, { entityId, taxYear, book, stateCode: q.stateCode }));
  } catch (err) {
    return fail(c, err, 'build the tax depreciation report');
  }
});

app.get('/mid-quarter-test', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const entity = await loadEntity(db, entityId);
    const taxYear = q.taxYear ? Number.parseInt(q.taxYear, 10) : fiscalYearRange(entityFiscalConfig(entity), todayFor(entity)).year;
    if (!Number.isInteger(taxYear) || taxYear < 1990 || taxYear > 2200) return error.badRequest(c, 'taxYear must be a year');
    return success(c, await midQuarterTestFor(db, entityId, taxYear));
  } catch (err) {
    return fail(c, err, 'run the mid-quarter test');
  }
});

app.post('/de-minimis-check', requirePermission('accounts:read'), zValidator('json', deMinimisSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    const entity = entityId ? await loadEntity(db, entityId) : null;
    const date = data.date ?? todayFor({ timezone: entity?.timezone ?? null });
    return success(c, deMinimisCheck({ amount: data.amount, hasAfs: data.hasAfs, date }));
  } catch (err) {
    return fail(c, err, 'check the de minimis safe harbor');
  }
});

// ---------------------------------------------------------------------------
// POST /depreciation/run

app.post('/depreciation/run', requirePermission('journal:create'), zValidator('json', runSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const result = await runDepreciation(db, { entityId, through: data.through, userId: c.get('userId') ?? null });

    for (const assetId of result.fullyDepreciatedAssetIds) {
      publishEntityEvent({ c, entityType: 'fixed_asset', entityId: assetId, action: 'updated', data: { id: assetId, status: 'fully_depreciated' } });
    }
    if (result.posted.some((p) => !p.alreadyPosted)) {
      await writeAccountingAudit(c, db, {
        accountingEntityId: entityId,
        entityType: 'fixed_asset',
        entityId,
        action: 'depreciation_posted',
        changes: { through: { old: null, new: data.through }, total: { old: null, new: result.totalPosted } },
      });
    }
    return success(c, result);
  } catch (err) {
    return fail(c, err, 'post depreciation');
  }
});

// ---------------------------------------------------------------------------
// POST /from-bill-line

app.post('/from-bill-line', requirePermission('accounts:create'), zValidator('json', fromBillLineSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const result = await createFixedAssetFromBillLine(db, { entityId, userId: c.get('userId') ?? null, input: data });
    await writeAccountingAudit(c, db, { accountingEntityId: entityId, entityType: 'fixed_asset', entityId: result.asset.id, action: 'created' });
    publishEntityEvent({ c, entityType: 'fixed_asset', entityId: result.asset.id, action: 'created', data: eventData(result.asset) });
    return success(c, { ...result.asset, books: result.books, issues: result.issues, source: result.source }, 201);
  } catch (err) {
    return fail(c, err, 'create a fixed asset from a bill line');
  }
});

// ---------------------------------------------------------------------------
// POST /

app.post('/', requirePermission('accounts:create'), zValidator('json', createAssetSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const { asset, books, issues } = await createFixedAsset(db, {
      entityId,
      input: { ...data, placedInServiceDate: data.placedInServiceDate ?? data.acquisitionDate },
    });
    await writeAccountingAudit(c, db, { accountingEntityId: entityId, entityType: 'fixed_asset', entityId: asset.id, action: 'created' });
    publishEntityEvent({ c, entityType: 'fixed_asset', entityId: asset.id, action: 'created', data: eventData(asset) });
    return success(c, { ...asset, books, issues }, 201);
  } catch (err) {
    return fail(c, err, 'create the fixed asset');
  }
});

// ---------------------------------------------------------------------------
// GET /:id, /:id/schedule

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const asset = await loadAsset(db, id);
    if (!asset) return error.notFound(c, 'Fixed asset', id);
    return success(c, await assetDetail(db, asset));
  } catch (err) {
    return fail(c, err, 'fetch the fixed asset');
  }
});

app.get('/:id/schedule', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const q = c.req.query();
  try {
    const asset = await loadAsset(db, id);
    if (!asset) return error.notFound(c, 'Fixed asset', id);
    if (q.book && q.book !== 'book' && q.book !== 'federal' && q.book !== 'state') {
      return error.badRequest(c, "book must be 'book', 'federal' or 'state'");
    }
    const context = await scheduleContextFor(db, await loadEntity(db, asset.entityId));
    const [books, stored] = await Promise.all([loadBooks(db, id), loadLedgerRows(db, id)]);
    const schedules = books
      .filter((book) => !q.book || (book.book === q.book && (!q.stateCode || book.stateCode === q.stateCode.toUpperCase())))
      .map((book) => {
        const schedule = annualSchedule(asset, book, context);
        return {
          bookId: book.id,
          book: book.book,
          stateCode: book.stateCode,
          method: schedule.method,
          convention: schedule.convention,
          recoveryYears: schedule.recoveryYears,
          postsToLedger: book.postsToLedger,
          basis: schedule.basis,
          annual: schedule.rows,
          // The ledger book's monthly rows, with the entry each one was posted in.
          monthly: book.postsToLedger
            ? stored
                .filter((row) => row.bookId === book.id)
                .map((row) => ({
                  periodStart: row.periodStart,
                  periodEnd: row.periodEnd,
                  amount: row.amount,
                  accumulated: row.accumulated,
                  journalEntryId: row.journalEntryId,
                }))
            : undefined,
          issues: schedule.issues,
        };
      });
    return success(c, { assetId: id, schedules });
  } catch (err) {
    return fail(c, err, 'build the depreciation schedule');
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id

app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateAssetSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const result = await updateFixedAsset(db, { assetId: id, patch: data });
    await writeAccountingAudit(c, db, {
      accountingEntityId: result.asset.entityId,
      entityType: 'fixed_asset',
      entityId: id,
      action: 'updated',
      changes: result.changes,
    });
    publishEntityEvent({
      c,
      entityType: 'fixed_asset',
      entityId: id,
      action: 'updated',
      data: eventData(result.asset),
      changes: result.changes,
    });
    return success(c, { ...result.asset, books: result.books, issues: result.issues });
  } catch (err) {
    return fail(c, err, 'update the fixed asset');
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const asset = await deleteFixedAsset(db, id);
    await writeAccountingAudit(c, db, { accountingEntityId: asset.entityId, entityType: 'fixed_asset', entityId: id, action: 'deleted' });
    publishEntityEvent({ c, entityType: 'fixed_asset', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    return fail(c, err, 'delete the fixed asset');
  }
});

// ---------------------------------------------------------------------------
// POST /:id/dispose

app.post(
  '/:id/dispose',
  requirePermission('accounts:update'),
  requirePermission('journal:create'),
  zValidator('json', disposeSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const result = await disposeFixedAsset(db, { assetId: id, userId: c.get('userId') ?? null, input: data });
      await writeAccountingAudit(c, db, {
        accountingEntityId: result.asset.entityId,
        entityType: 'fixed_asset',
        entityId: id,
        action: 'disposed',
        changes: {
          disposalDate: { old: null, new: data.date },
          proceeds: { old: null, new: result.proceeds },
          gainOrLoss: { old: null, new: result.gainOrLoss },
        },
      });
      publishEntityEvent({ c, entityType: 'fixed_asset', entityId: id, action: 'disposed', data: eventData(result.asset) });
      return success(c, result);
    } catch (err) {
      return fail(c, err, 'dispose of the fixed asset');
    }
  },
);

export const fixedAssetsRoutes = app;
