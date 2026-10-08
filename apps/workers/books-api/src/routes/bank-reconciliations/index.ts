/**
 * Statement reconciliations — /api/bank-reconciliations.
 *
 *   GET    /                  history (?bankAccountId=&status=&page=&pageSize=)
 *   POST   /                  {bankAccountId, statementDate, statementEndingBalance, beginningBalance?}
 *   GET    /:id               open ledger lines up to the statement date, ticked ids, cleared balance, difference
 *   PATCH  /:id               {clearedLineIds?, statementDate?, statementEndingBalance?}: save progress
 *   POST   /:id/complete      {clearedLineIds?, adjustment?: {accountId, memo?}}: needs difference 0.00,
 *                             or posts the difference to `adjustment.accountId`
 *   POST   /:id/undo          latest completed reconciliation of the account only (banking:manage)
 *   DELETE /:id               discard a reconciliation that is still in progress
 *   GET    /:id/report        the reconciliation report (stored snapshot, or a live preview while open)
 *
 * Statement balances: a bank account's is what it holds, a credit card's what
 * is owed (positive), and the signs of the ticked lines flip accordingly.
 *
 * Permissions: banking:read | banking:create | banking:update | banking:manage.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  ClosedPeriodError,
  LockedPeriodError,
  writeAccountingAudit,
} from '@weldsuite/books-domain/accounting-guards';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { PostingError } from '../../services/accounting-posting';
import {
  completeReconciliation,
  discardReconciliation,
  getReconciliationView,
  getReport,
  ReconciliationConflictError,
  saveProgress,
  startReconciliation,
  undoReconciliation,
} from '../../services/accounting-bank-reconciliation-statement';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const money = z
  .union([z.number().finite(), z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Use an amount such as 1234.56')])
  .transform((v) => (typeof v === 'number' ? v : Number(v)));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');
const lineIds = z.array(z.string().min(1).max(30)).max(20_000);

const createSchema = z.object({
  bankAccountId: z.string().min(1).max(30),
  statementDate: day,
  statementEndingBalance: money,
  /** Only used for the first reconciliation of an account. */
  beginningBalance: money.optional(),
});

const progressSchema = z.object({
  clearedLineIds: lineIds.optional(),
  statementDate: day.optional(),
  statementEndingBalance: money.optional(),
});

const completeSchema = z.object({
  clearedLineIds: lineIds.optional(),
  adjustment: z.object({ accountId: z.string().min(1).max(30), memo: z.string().max(255).optional() }).optional(),
});

function isUserFixable(err: unknown): err is Error {
  return err instanceof PostingError || err instanceof ClosedPeriodError || err instanceof LockedPeriodError;
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The reconciliation `id` of the resolved entity, or null. */
async function findReconciliation(c: AppContext, id: string) {
  const db = c.get('tenantDb');
  const entityId = await resolveEntityId(c, db);
  if (!entityId) return { entityId: null, rec: null } as const;
  const [rec] = await db
    .select()
    .from(schema.bankReconciliations)
    .where(and(eq(schema.bankReconciliations.id, id), eq(schema.bankReconciliations.entityId, entityId)))
    .limit(1);
  return { entityId, rec: rec ?? null } as const;
}

function eventData(rec: typeof schema.bankReconciliations.$inferSelect) {
  return {
    id: rec.id,
    bankAccountId: rec.bankAccountId,
    statementDate: rec.statementDate,
    statementEndingBalance: rec.statementEndingBalance,
    status: rec.status,
  };
}

// GET / — history
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const t = schema.bankReconciliations;
  const page = Math.max(Number.parseInt(q.page || '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(q.pageSize || '25', 10) || 25, 1), 100);
  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const conditions = [eq(t.entityId, entityId)];
    if (q.bankAccountId) conditions.push(eq(t.bankAccountId, q.bankAccountId));
    if (q.status) conditions.push(eq(t.status, q.status));
    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.statementDate), desc(t.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(count[0]?.count ?? 0);
    // The stored report is large; the history list doesn't carry it (GET /:id/report does).
    const slim = rows.map(({ report: _report, ...rest }) => ({ ...rest, hasReport: _report != null }));
    return list(c, slim, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[books-api/bank-reconciliations] list failed:', err);
    return error.internal(c, 'Failed to fetch reconciliations');
  }
});

// POST / — start a reconciliation
app.post('/', requirePermission('banking:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const rec = await startReconciliation(db, {
      entityId,
      bankAccountId: data.bankAccountId,
      statementDate: data.statementDate,
      statementEndingBalance: data.statementEndingBalance,
      beginningBalance: data.beginningBalance,
      userId: c.get('userId') ?? null,
    });
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_reconciliation',
      entityId: rec.id,
      action: 'created',
      changes: {
        bankAccountId: { old: null, new: rec.bankAccountId },
        statementDate: { old: null, new: rec.statementDate },
        statementEndingBalance: { old: null, new: rec.statementEndingBalance },
      },
    });
    publishEntityEvent({ c, entityType: 'bank_reconciliation', entityId: rec.id, action: 'created', data: eventData(rec) });
    return success(c, await getReconciliationView(db, rec), 201);
  } catch (err) {
    if (err instanceof ReconciliationConflictError) return error.conflict(c, err.message, { reconciliationId: err.existingId });
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-reconciliations] create failed:', err);
    return error.internal(c, 'Failed to start the reconciliation');
  }
});

// GET /:id/report — before /:id so the path isn't read as an id
app.get('/:id/report', requirePermission('banking:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const { entityId, rec } = await findReconciliation(c, id);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    if (!rec) return error.notFound(c, 'Reconciliation', id);
    return success(c, await getReport(c.get('tenantDb'), rec));
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-reconciliations] report failed:', err);
    return error.internal(c, 'Failed to build the reconciliation report');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const { entityId, rec } = await findReconciliation(c, id);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    if (!rec) return error.notFound(c, 'Reconciliation', id);
    return success(c, await getReconciliationView(c.get('tenantDb'), rec));
  } catch (err) {
    console.error('[books-api/bank-reconciliations] get failed:', err);
    return error.internal(c, 'Failed to fetch the reconciliation');
  }
});

// PATCH /:id — save progress
app.patch('/:id', requirePermission('banking:update'), zValidator('json', progressSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { entityId, rec } = await findReconciliation(c, id);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    if (!rec) return error.notFound(c, 'Reconciliation', id);
    const saved = await saveProgress(db, rec, data);
    publishEntityEvent({ c, entityType: 'bank_reconciliation', entityId: id, action: 'updated', data: eventData(saved) });
    return success(c, await getReconciliationView(db, saved));
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-reconciliations] update failed:', err);
    return error.internal(c, 'Failed to save the reconciliation');
  }
});

// POST /:id/complete
app.post('/:id/complete', requirePermission('banking:update'), zValidator('json', completeSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { entityId, rec } = await findReconciliation(c, id);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    if (!rec) return error.notFound(c, 'Reconciliation', id);

    const done = await completeReconciliation(db, rec, { ...data, userId: c.get('userId') ?? null });
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_reconciliation',
      entityId: id,
      action: 'completed',
      changes: {
        status: { old: rec.status, new: 'completed' },
        clearedBalance: { old: rec.clearedBalance, new: done.reconciliation.clearedBalance },
        adjustmentJournalEntryId: { old: null, new: done.adjustmentJournalEntryId },
      },
    });
    publishEntityEvent({ c, entityType: 'bank_reconciliation', entityId: id, action: 'completed', data: eventData(done.reconciliation) });
    return success(c, { ...(await getReconciliationView(db, done.reconciliation)), adjustmentJournalEntryId: done.adjustmentJournalEntryId });
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-reconciliations] complete failed:', err);
    return error.internal(c, 'Failed to complete the reconciliation');
  }
});

// POST /:id/undo — admins only; the latest completed reconciliation of the account
app.post('/:id/undo', requirePermission('banking:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const { entityId, rec } = await findReconciliation(c, id);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    if (!rec) return error.notFound(c, 'Reconciliation', id);

    const undone = await undoReconciliation(db, rec, { userId: c.get('userId') ?? null });
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_reconciliation',
      entityId: id,
      action: 'undone',
      changes: {
        status: { old: rec.status, new: 'undone' },
        statementDate: { old: rec.statementDate, new: rec.statementDate },
        adjustmentJournalEntryId: { old: rec.adjustmentJournalEntryId, new: null },
      },
    });
    publishEntityEvent({ c, entityType: 'bank_reconciliation', entityId: id, action: 'undone', data: eventData(undone) });
    return success(c, await getReconciliationView(db, undone));
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-reconciliations] undo failed:', err);
    return error.internal(c, 'Failed to undo the reconciliation');
  }
});

// DELETE /:id — discard an unfinished reconciliation
app.delete('/:id', requirePermission('banking:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const { entityId, rec } = await findReconciliation(c, id);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    if (!rec) return error.notFound(c, 'Reconciliation', id);

    await discardReconciliation(db, rec);
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_reconciliation',
      entityId: id,
      action: 'deleted',
      changes: { status: { old: rec.status, new: null } },
    });
    publishEntityEvent({ c, entityType: 'bank_reconciliation', entityId: id, action: 'deleted', data: eventData(rec) });
    return noContent(c);
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-reconciliations] discard failed:', err);
    return error.internal(c, 'Failed to discard the reconciliation');
  }
});

export const bankReconciliationsRoutes = app;
