/**
 * /api/helpdesk-settings/priority-matrix: the WeldDesk priority matrix,
 * ITIL impact × urgency → priority, kept in
 * `helpdesk_settings.tickets.priorityMatrix` (the rest of `tickets` is left
 * as it is). GET answers the default grid, off, until it is saved; PUT
 * replaces the whole setting.
 *
 * Permissions: settings:read | settings:update.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { deskPriorityMatrixSchema } from '@weldsuite/core-api-client/schemas/desk-priority-matrix';
import { getDeskPriorityMatrix, normalizeDeskPriorityMatrix } from '@weldsuite/db/lib/desk-priority-matrix';
import type { TicketSettings } from '@weldsuite/db/schema/helpdesk-settings';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('settings:read'), async (c) => {
  try {
    return success(c, await getDeskPriorityMatrix(c.get('tenantDb')));
  } catch (err) {
    console.error('[desk-api/helpdesk-settings] get priority matrix failed:', err);
    return error.internal(c, 'Failed to fetch the priority matrix');
  }
});

app.put('/', requirePermission('settings:update'), zValidator('json', deskPriorityMatrixSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskSettings } = schema;
  const priorityMatrix = normalizeDeskPriorityMatrix(c.req.valid('json'));
  try {
    const [existing] = await db.select().from(helpdeskSettings).where(isNull(helpdeskSettings.deletedAt)).limit(1);
    const id = existing?.id ?? generateId('hds');
    const now = new Date();
    if (existing) {
      const tickets = { ...(existing.tickets as unknown as Record<string, unknown>), priorityMatrix } as unknown as TicketSettings;
      await db.update(helpdeskSettings).set({ tickets, updatedAt: now }).where(eq(helpdeskSettings.id, id));
    } else {
      await db.insert(helpdeskSettings).values({
        id,
        tickets: { priorityMatrix } as unknown as TicketSettings,
        createdAt: now,
        updatedAt: now,
      });
    }
    publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { tickets: { priorityMatrix } } });
    return success(c, priorityMatrix);
  } catch (err) {
    console.error('[desk-api/helpdesk-settings] update priority matrix failed:', err);
    return error.internal(c, 'Failed to update the priority matrix');
  }
});

export { app as priorityMatrixRoutes };
