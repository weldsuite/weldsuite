/**
 * Positive Pay: /api/payment-runs/positive-pay.
 *
 *   GET /formats                           the formats and where each layout comes from
 *   GET /?bankAccountId=&from=&to=&format= the issued-checks file for the range:
 *                                          { fileName, content, format, counts, warnings }
 *
 * The account number is decrypted for the file and each request writes a
 * `tax_id_reveals` row (`positive_pay`). Permissions: banking:read (formats),
 * banking:manage (the file).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { cursorPagination, list, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { generatePositivePay, POSITIVE_PAY_FORMAT_LIST } from '../../services/payment-runs/positive-pay';
import { bankAccountIdQuery, day, requireEntity, respondError } from './shared';

export const positivePayRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

positivePayRoutes.get('/formats', requirePermission('banking:read'), (c) =>
  list(c, [...POSITIVE_PAY_FORMAT_LIST], cursorPagination(POSITIVE_PAY_FORMAT_LIST.length, false, null)),
);

const fileQuery = z.object({
  bankAccountId: bankAccountIdQuery,
  from: day.optional(),
  to: day.optional(),
  format: z.string().max(30).optional(),
});

positivePayRoutes.get('/', requirePermission('banking:manage'), zValidator('query', fileQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const file = await generatePositivePay(db, c.env, { entityId, userId: c.get('userId'), ...q });
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_account',
      entityId: q.bankAccountId,
      action: 'positive_pay',
      changes: { fileName: { old: null, new: file.fileName }, records: { old: null, new: file.counts.records } },
    });
    return success(c, file);
  } catch (err) {
    return respondError(c, err, 'make Positive Pay file');
  }
});
