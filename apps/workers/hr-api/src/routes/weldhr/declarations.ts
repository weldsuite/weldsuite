/**
 * /api/weldhr/declarations — expense declarations, for the back office.
 *
 * `declarations:approve` covers both the decision and marking an approved
 * declaration as paid. The receipt is a private file: uploaded as multipart
 * `file`, and streamed back only through GET /:declarationId/receipt.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrDeclarationSchema,
  reviewHrDeclarationSchema,
  updateHrDeclarationSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { noContent, success } from '@weldsuite/worker-kit/response';
import {
  attachDeclarationReceipt,
  cancelDeclaration,
  createDeclaration,
  deleteDeclaration,
  listDeclarations,
  loadDeclarationReceipt,
  markDeclarationPaid,
  receiptFileFrom,
  receiptResponse,
  reviewDeclaration,
  toPublicDeclaration,
  updateDeclaration,
} from '../../services/weldhr/declarations';
import { actor, db, emit, param, receiptBucket, workspaceIdOf } from './helpers';

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const declarationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

declarationsRoutes.get('/', requirePermission('declarations:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listDeclarations(db(c), {
      employeeId: q.employeeId || undefined,
      status: q.status || undefined,
      category: q.category || undefined,
      from: q.from && isoDate.test(q.from) ? q.from : undefined,
      to: q.to && isoDate.test(q.to) ? q.to : undefined,
    }),
  );
});

declarationsRoutes.post('/', requirePermission('declarations:create'), zValidator('json', createHrDeclarationSchema), async (c) => {
  const row = await createDeclaration(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_declaration', 'created', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, toPublicDeclaration(row), 201);
});

declarationsRoutes.patch(
  '/:declarationId',
  requirePermission('declarations:update'),
  zValidator('json', updateHrDeclarationSchema),
  async (c) => {
    const row = await updateDeclaration(db(c), param(c, 'declarationId'), c.req.valid('json'));
    emit(c, 'hr_declaration', 'updated', row.id, { employeeId: row.employeeId, status: row.status });
    return success(c, toPublicDeclaration(row));
  },
);

declarationsRoutes.post(
  '/:declarationId/review',
  requirePermission('declarations:approve'),
  zValidator('json', reviewHrDeclarationSchema),
  async (c) => {
    const row = await reviewDeclaration(db(c), param(c, 'declarationId'), c.req.valid('json'), actor(c));
    emit(c, 'hr_declaration', row.status === 'approved' ? 'approved' : 'rejected', row.id, {
      employeeId: row.employeeId,
      status: row.status,
    });
    return success(c, toPublicDeclaration(row));
  },
);

declarationsRoutes.post('/:declarationId/pay', requirePermission('declarations:approve'), async (c) => {
  const row = await markDeclarationPaid(db(c), param(c, 'declarationId'), actor(c));
  emit(c, 'hr_declaration', 'paid', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, toPublicDeclaration(row));
});

declarationsRoutes.post('/:declarationId/cancel', requirePermission('declarations:update'), async (c) => {
  const row = await cancelDeclaration(db(c), param(c, 'declarationId'));
  emit(c, 'hr_declaration', 'updated', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, toPublicDeclaration(row));
});

declarationsRoutes.delete('/:declarationId', requirePermission('declarations:delete'), async (c) => {
  const row = await deleteDeclaration(db(c), param(c, 'declarationId'));
  if (row.receiptFileKey) c.executionCtx.waitUntil(receiptBucket(c).delete(row.receiptFileKey));
  emit(c, 'hr_declaration', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});

// Filing a declaration is two calls (the record, then its receipt), so the
// upload accepts the create grant as well as the update one.
declarationsRoutes.post(
  '/:declarationId/receipt',
  requirePermission('declarations:create', 'declarations:update'),
  async (c) => {
    const file = receiptFileFrom(await c.req.parseBody());
    const row = await attachDeclarationReceipt(db(c), receiptBucket(c), workspaceIdOf(c), param(c, 'declarationId'), file);
    emit(c, 'hr_declaration', 'updated', row.id, { employeeId: row.employeeId, status: row.status });
    return success(c, toPublicDeclaration(row));
  },
);

declarationsRoutes.get('/:declarationId/receipt', requirePermission('declarations:read'), async (c) => {
  return receiptResponse(await loadDeclarationReceipt(db(c), receiptBucket(c), workspaceIdOf(c), param(c, 'declarationId')));
});
