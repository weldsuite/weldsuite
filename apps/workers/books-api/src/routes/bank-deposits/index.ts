/**
 * Bank deposits from Undeposited Funds — /api/bank-deposits.
 *
 *   GET    /              deposits of the entity (cursor pagination)
 *   GET    /undeposited   received payments waiting in Undeposited Funds
 *   POST   /              {bankAccountId, date, paymentIds[], otherLines?[], memo?}
 *                         posts one entry: Dr bank / Cr Undeposited Funds per payment
 *   GET    /:id           the deposit with its payments and other lines
 *   PATCH  /:id           {memo}: a posted deposit's amounts can't change, only void it
 *   DELETE /:id           void: reverses the entry, releases the payments and the bank line
 *
 * Matching a deposit to its bank line is POST /api/bank-transactions/:id/match-deposit.
 *
 * Permissions: banking:read | banking:create | banking:update (void).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
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
  createDeposit,
  listDeposits,
  listUndepositedPayments,
  loadDepositDetail,
  voidDeposit,
} from '../../services/accounting-bank-deposits';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a YYYY-MM-DD date');

const createDepositSchema = z.object({
  bankAccountId: z.string().min(1).max(30),
  date: day,
  paymentIds: z.array(z.string().min(1).max(30)).max(500).default([]),
  /** Other lines on the slip: positive adds money (credits that account), negative is cash back. */
  otherLines: z
    .array(
      z.object({
        accountId: z.string().min(1).max(30),
        amount: z.number().finite(),
        description: z.string().max(255).optional(),
      }),
    )
    .max(50)
    .optional(),
  memo: z.string().max(500).optional(),
});

const updateDepositSchema = z.object({ memo: z.string().max(500).nullable() });

function isUserFixable(err: unknown): err is Error {
  return err instanceof PostingError || err instanceof ClosedPeriodError || err instanceof LockedPeriodError;
}

// GET / — deposits, newest first
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const limit = Math.min(Math.max(Number.parseInt(q.limit || '25', 10) || 25, 1), 100);
    const result = await listDeposits(db, entityId, {
      bankAccountId: q.bankAccountId,
      status: q.status,
      from: q.from,
      to: q.to,
      limit,
      cursor: q.cursor,
    });
    return list(c, result.rows, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-deposits] list failed:', err);
    return error.internal(c, 'Failed to fetch bank deposits');
  }
});

// GET /undeposited — payments in Undeposited Funds that no deposit holds yet
app.get('/undeposited', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const rows = await listUndepositedPayments(db, entityId);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[books-api/bank-deposits] undeposited failed:', err);
    return error.internal(c, 'Failed to fetch undeposited payments');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const [deposit] = await db
      .select()
      .from(schema.bankDeposits)
      .where(and(eq(schema.bankDeposits.id, id), eq(schema.bankDeposits.entityId, entityId), isNull(schema.bankDeposits.deletedAt)))
      .limit(1);
    if (!deposit) return error.notFound(c, 'Bank deposit', id);
    return success(c, await loadDepositDetail(db, deposit));
  } catch (err) {
    console.error('[books-api/bank-deposits] get failed:', err);
    return error.internal(c, 'Failed to fetch bank deposit');
  }
});

// POST / — group payments into a deposit and post it
app.post('/', requirePermission('banking:create'), zValidator('json', createDepositSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const created = await createDeposit(db, {
      entityId,
      bankAccountId: data.bankAccountId,
      date: data.date,
      paymentIds: data.paymentIds,
      otherLines: data.otherLines,
      memo: data.memo ?? null,
      userId: c.get('userId') ?? null,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_deposit',
      entityId: created.depositId,
      action: 'created',
      changes: {
        bankAccountId: { old: null, new: data.bankAccountId },
        amount: { old: null, new: created.amount.toFixed(2) },
        paymentCount: { old: null, new: data.paymentIds.length },
        journalEntryId: { old: null, new: created.journalEntryId },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_deposit',
      entityId: created.depositId,
      action: 'created',
      data: {
        id: created.depositId,
        bankAccountId: data.bankAccountId,
        date: data.date,
        amount: created.amount.toFixed(2),
        paymentCount: data.paymentIds.length,
      },
    });
    return success(c, { id: created.depositId, journalEntryId: created.journalEntryId, amount: created.amount.toFixed(2) }, 201);
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-deposits] create failed:', err);
    return error.internal(c, 'Failed to create bank deposit');
  }
});

// PATCH /:id — only the memo; a posted deposit's amounts are fixed
app.patch('/:id', requirePermission('banking:update'), zValidator('json', updateDepositSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const [deposit] = await db
      .select()
      .from(schema.bankDeposits)
      .where(and(eq(schema.bankDeposits.id, id), eq(schema.bankDeposits.entityId, entityId), isNull(schema.bankDeposits.deletedAt)))
      .limit(1);
    if (!deposit) return error.notFound(c, 'Bank deposit', id);

    const memo = data.memo?.trim() || null;
    await db.update(schema.bankDeposits).set({ memo, updatedAt: new Date() }).where(eq(schema.bankDeposits.id, id));
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_deposit',
      entityId: id,
      action: 'updated',
      changes: { memo: { old: deposit.memo, new: memo } },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_deposit',
      entityId: id,
      action: 'updated',
      data: { id, bankAccountId: deposit.bankAccountId, amount: deposit.amount, memo },
    });
    return success(c, { ...deposit, memo });
  } catch (err) {
    console.error('[books-api/bank-deposits] update failed:', err);
    return error.internal(c, 'Failed to update bank deposit');
  }
});

// DELETE /:id — void the deposit
app.delete('/:id', requirePermission('banking:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const deposit = await voidDeposit(db, { entityId, depositId: id, userId: c.get('userId') ?? null });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_deposit',
      entityId: id,
      action: 'voided',
      changes: { status: { old: deposit.status, new: 'void' } },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_deposit',
      entityId: id,
      action: 'deleted',
      data: { id, bankAccountId: deposit.bankAccountId, amount: deposit.amount },
    });
    return noContent(c);
  } catch (err) {
    if (err instanceof PostingError && err.message === 'Deposit not found') return error.notFound(c, 'Bank deposit', id);
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-deposits] void failed:', err);
    return error.internal(c, 'Failed to void bank deposit');
  }
});

export const bankDepositsRoutes = app;
