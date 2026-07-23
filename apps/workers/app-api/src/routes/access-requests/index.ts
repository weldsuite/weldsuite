/**
 * Access Requests Routes — flat /api/access-requests/* surface backed by
 * the `access_requests` table.
 *
 * Endpoint a user can hit when they land on a page they lack permission for —
 * persists the request and notifies workspace admins. No `requirePermission`
 * gate on POST / GET me/pending: by definition the requester does not have the
 * permission they're asking for. Clerk auth + workspace DB middleware still
 * apply globally. Resolving a request requires `team:update`.
 *
 * Ported from apps/core-api/src/routes/team/access-requests.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  createAccessRequestSchema,
  resolveAccessRequestSchema,
} from '@weldsuite/app-api-client/schemas/access-requests';
import type { Env, Variables } from '../../types';
import { success, error, list, cursorPagination } from '../../lib/response';
import * as service from '../../services/access-requests';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', zValidator('json', createAccessRequestSchema), async (c) => {
  const db = c.get('tenantDb');
  const requesterId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  const input = c.req.valid('json');

  try {
    const [member] = await db
      .select({ name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.userId, requesterId),
          isNull(schema.workspaceMembers.deletedAt),
        ),
      )
      .limit(1);

    const result = await service.createAccessRequest(db, {
      requesterId,
      requesterName: member?.name ?? null,
      permission: input.permission,
      pageLabel: input.pageLabel,
      pagePath: input.pagePath,
    });

    if (!result.deduped && workspaceId && c.env.REALTIME && result.insertedNotifications.length > 0) {
      const realtime = new RealtimePublisher(c.env.REALTIME);
      // Publish each admin's full notification row to their personal
      // `notification.{userId}` topic so the bell updates live.
      const promise = Promise.allSettled(
        result.insertedNotifications.map((notification) =>
          realtime.notify(workspaceId, notification.userId, notification),
        ),
      ).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') {
            console.error('[app-api/access-requests] realtime notify failed:', r.reason);
          }
        }
      });
      c.executionCtx.waitUntil(promise);
    }

    return success(c, result.request, result.deduped ? 200 : 201);
  } catch (err) {
    console.error('[app-api/access-requests] create failed:', err);
    return error.internal(c, 'Failed to submit access request');
  }
});

app.patch(
  '/:id',
  requirePermission('team:update'),
  zValidator('json', resolveAccessRequestSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const resolverUserId = c.get('userId');
    const workspaceId = c.get('workspaceId');
    const requestId = c.req.param('id');
    const { status } = c.req.valid('json');

    try {
      const result = await service.resolveAccessRequest(db, {
        requestId,
        resolverUserId,
        status,
      });

      if (result.kind === 'not_found') {
        return error.notFound(c, 'Access request', requestId);
      }
      if (result.kind === 'already_resolved') {
        return error.conflict(c, 'Access request has already been resolved');
      }

      if (workspaceId && c.env.REALTIME) {
        const realtime = new RealtimePublisher(c.env.REALTIME);
        const promise = Promise.allSettled([
          // Push the full requester-facing notification row so their bell updates live.
          realtime.notify(
            workspaceId,
            result.requesterId,
            result.requesterNotification,
          ),
          realtime.publish(
            workspaceId,
            'access_request',
            'resolved',
            {
              accessRequestId: result.request.id,
              status: result.request.status,
              resolvedBy: resolverUserId,
            },
            resolverUserId,
          ),
        ]).then((results) => {
          for (const r of results) {
            if (r.status === 'rejected') {
              console.error('[app-api/access-requests] realtime resolve publish failed:', r.reason);
            }
          }
        });
        c.executionCtx.waitUntil(promise);
      }

      return success(c, result.request);
    } catch (err) {
      console.error('[app-api/access-requests] resolve failed:', err);
      return error.internal(c, 'Failed to resolve access request');
    }
  },
);

app.get('/me/pending', async (c) => {
  const db = c.get('tenantDb');
  const requesterId = c.get('userId');

  try {
    const rows = await service.listMyPendingAccessRequests(db, requesterId);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/access-requests] list me/pending failed:', err);
    return error.internal(c, 'Failed to list access requests');
  }
});

export const accessRequestsRoutes = app;
