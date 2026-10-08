/**
 * Check routes outside a single run: voiding (and reissuing) a check, and
 * the check register of a bank account. Mounted by ./index.ts at
 * /api/payment-runs/checks and /api/payment-runs/check-register.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { checkRegister, voidCheck } from '../../services/payment-runs/checks';
import { auditRun, bankAccountIdQuery, day, pageLimit, requireEntity, respondError, runEventData, voidCheckSchema } from './shared';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';

export const checksRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /:paymentId/void — void a check (the ledger entry is reversed, the bills are open again)
checksRoutes.post('/:paymentId/void', requirePermission('banking:manage'), zValidator('json', voidCheckSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const paymentId = c.req.param('paymentId');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const result = await voidCheck(db, {
      entityId,
      paymentId,
      userId: c.get('userId'),
      reason: data.reason,
      reissue: data.reissue,
      date: data.date,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'payment',
      entityId: paymentId,
      action: 'check_voided',
      changes: {
        checkStatus: { old: 'printed', new: 'voided' },
        reason: { old: null, new: data.reason },
        ...(result.replacement ? { replacedBy: { old: null, new: result.replacement.paymentId } } : {}),
      },
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: paymentId,
      action: 'deleted',
      data: {
        id: paymentId,
        amount: result.voided.amount,
        ...(result.voided.backupWithholdingAmount ? { backupWithholdingAmount: result.voided.backupWithholdingAmount } : {}),
        method: 'check',
      },
    });
    if (result.replacement) {
      publishEntityEvent({
        c,
        entityType: 'payment',
        entityId: result.replacement.paymentId,
        action: 'created',
        data: {
          id: result.replacement.paymentId,
          amount: result.replacement.amount,
          ...(result.replacement.backupWithholdingAmount ? { backupWithholdingAmount: result.replacement.backupWithholdingAmount } : {}),
          method: 'check',
        },
      });
    }
    if (result.run) {
      await auditRun(c, db, result.run, 'check_voided', { checkNumber: { old: result.voided.checkNumber, new: 'voided' } });
      publishEntityEvent({
        c,
        entityType: 'payment_run',
        entityId: result.run.id,
        action: 'updated',
        data: runEventData(result.run),
      });
    }
    return success(c, result);
  } catch (err) {
    return respondError(c, err, 'void check');
  }
});

export const checkRegisterRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const registerQuery = z.object({
  bankAccountId: bankAccountIdQuery.optional(),
  from: day.optional(),
  to: day.optional(),
  status: z.enum(['to_print', 'printed', 'cleared', 'voided']).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

// GET / — every check written, voided ones included, by check number
checkRegisterRoutes.get('/', requirePermission('banking:read'), zValidator('query', registerQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return list(c, [], cursorPagination(0, false, null));
    const result = await checkRegister(db, {
      entityId,
      bankAccountId: q.bankAccountId,
      from: q.from,
      to: q.to,
      status: q.status,
      limit: pageLimit(q.limit, 100, 500),
      cursor: q.cursor,
    });
    return c.json({
      data: result.rows,
      summary: result.summary,
      pagination: cursorPagination(result.totalCount, result.hasMore, result.cursor),
    });
  } catch (err) {
    return respondError(c, err, 'fetch check register');
  }
});
