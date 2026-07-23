/**
 * Email forward routes — /api/email-forwards/*.
 *
 * Permissions: `email:read | email:create | email:update | email:delete`.
 * Entity events: `email_forward:created | updated | deleted`.
 *
 * Replaces the legacy `/api/host-email-forwards` stub.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listEmailForwardsQuery,
  createEmailForwardSchema,
  updateEmailForwardSchema,
} from '@weldsuite/core-api-client/schemas/email-forwards';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as emailForwardsService from '../../services/email-forwards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get(
  '/',
  requirePermission('email:read'),
  zValidator('query', listEmailForwardsQuery),
  async (c) => {
    try {
      const result = await emailForwardsService.listEmailForwards(
        c.get('tenantDb'),
        c.req.valid('query') as never,
      );
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    } catch (err) {
      console.error('[app-api/email-forwards] list failed:', err);
      return error.internal(c, 'Failed to list email forwards');
    }
  },
);

app.get('/:id', requirePermission('email:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await emailForwardsService.getEmailForward(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Email forward', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/email-forwards] get failed:', err);
    return error.internal(c, 'Failed to fetch email forward');
  }
});

app.post(
  '/',
  requirePermission('email:create'),
  zValidator('json', createEmailForwardSchema),
  async (c) => {
    try {
      const row = await emailForwardsService.createEmailForward(
        c.get('tenantDb'),
        c.req.valid('json'),
      );
      publishEntityEvent({
        c,
        entityType: 'email_forward',
        entityId: row.id,
        action: 'created',
        data: {
          id: row.id,
          domainId: row.domainId,
          source: row.source,
          destination: row.destination,
          enabled: row.enabled,
          status: row.status,
        },
      });
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/email-forwards] create failed:', err);
      return error.internal(c, 'Failed to create email forward');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('email:update'),
  zValidator('json', updateEmailForwardSchema),
  async (c) => {
    const id = c.req.param('id');
    try {
      const row = await emailForwardsService.updateEmailForward(
        c.get('tenantDb'),
        id,
        c.req.valid('json') as Record<string, unknown>,
      );
      if (!row) return error.notFound(c, 'Email forward', id);
      publishEntityEvent({
        c,
        entityType: 'email_forward',
        entityId: row.id,
        action: 'updated',
        data: {
          id: row.id,
          domainId: row.domainId,
          source: row.source,
          destination: row.destination,
          enabled: row.enabled,
          status: row.status,
        },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/email-forwards] update failed:', err);
      return error.internal(c, 'Failed to update email forward');
    }
  },
);

app.delete('/:id', requirePermission('email:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await emailForwardsService.deleteEmailForward(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Email forward', id);
    publishEntityEvent({
      c,
      entityType: 'email_forward',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        domainId: deleted.domainId,
        source: deleted.source,
        destination: deleted.destination,
        enabled: deleted.enabled,
        status: deleted.status,
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/email-forwards] delete failed:', err);
    return error.internal(c, 'Failed to delete email forward');
  }
});

export const emailForwardsRoutes = app;
