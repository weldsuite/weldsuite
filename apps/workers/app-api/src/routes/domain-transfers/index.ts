/**
 * Domain transfer routes — /api/domain-transfers/*.
 *
 * Permissions: `transfers:read | transfers:create | transfers:update | transfers:delete`.
 * Entity events: `domain_transfer:created | updated | approved | rejected | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listDomainTransfersQuery,
  createDomainTransferSchema,
  failDomainTransferSchema,
} from '@weldsuite/core-api-client/schemas/domain-transfers';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import * as transfersService from '../../services/domain-transfers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get(
  '/',
  requirePermission('transfers:read'),
  zValidator('query', listDomainTransfersQuery),
  async (c) => {
    try {
      const result = await transfersService.listDomainTransfers(
        c.get('tenantDb'),
        c.req.valid('query') as never,
      );
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    } catch (err) {
      console.error('[app-api/domain-transfers] list failed:', err);
      return error.internal(c, 'Failed to list domain transfers');
    }
  },
);

app.get('/:id', requirePermission('transfers:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await transfersService.getDomainTransfer(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Domain transfer', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/domain-transfers] get failed:', err);
    return error.internal(c, 'Failed to fetch domain transfer');
  }
});

app.post(
  '/',
  requirePermission('transfers:create'),
  zValidator('json', createDomainTransferSchema),
  async (c) => {
    try {
      const row = await transfersService.createDomainTransfer(
        c.get('tenantDb'),
        c.req.valid('json'),
      );
      publishEntityEvent({
        c,
        entityType: 'domain_transfer',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, domainName: row.domainName, type: row.type, status: row.status },
      });
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/domain-transfers] create failed:', err);
      return error.internal(c, 'Failed to create domain transfer');
    }
  },
);

app.patch('/:id/complete', requirePermission('transfers:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await transfersService.completeDomainTransfer(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Domain transfer', id);
    publishEntityEvent({
      c,
      entityType: 'domain_transfer',
      entityId: row.id,
      action: 'updated',
      data: { id: row.id, domainName: row.domainName, type: row.type, status: row.status },
    });
    return success(c, row);
  } catch (err) {
    console.error('[app-api/domain-transfers] complete failed:', err);
    return error.internal(c, 'Failed to complete domain transfer');
  }
});

app.patch(
  '/:id/fail',
  requirePermission('transfers:update'),
  zValidator('json', failDomainTransferSchema),
  async (c) => {
    const id = c.req.param('id');
    const reason = c.req.valid('json').reason ?? 'Unknown error';
    try {
      const row = await transfersService.failDomainTransfer(c.get('tenantDb'), id, reason);
      if (!row) return error.notFound(c, 'Domain transfer', id);
      publishEntityEvent({
        c,
        entityType: 'domain_transfer',
        entityId: row.id,
        action: 'updated',
        data: { id: row.id, domainName: row.domainName, type: row.type, status: row.status },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/domain-transfers] fail failed:', err);
      return error.internal(c, 'Failed to mark domain transfer as failed');
    }
  },
);

export const domainTransfersRoutes = app;
