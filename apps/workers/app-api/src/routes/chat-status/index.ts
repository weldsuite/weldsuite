/**
 * WeldChat user status routes — flat /api/chat-status/* surface backed by
 * `chatUserStatus`. Manages the caller's presence + custom status
 * (online, away, dnd, offline) and broadcasts changes over the realtime
 * WorkspaceHub via the REALTIME service binding.
 *
 * WeldChat streams over its own ChatRoom DO / realtime path, not the
 * entity-event bus — no entity events are published here.
 *
 * Permissions: settings:read | settings:update | settings:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { setChatStatusSchema } from '@weldsuite/app-api-client/schemas/chat-status';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatUserStatus;

/** Upsert a user's status row to `offline` and bump updatedAt. */
async function setUserOffline(db: Database, userId: string): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select({ id: t.id })
    .from(t)
    .where(eq(t.userId, userId))
    .limit(1);

  if (existing) {
    await db.update(t).set({ status: 'offline', updatedAt: now }).where(eq(t.userId, userId));
  } else {
    await db.insert(t).values({ id: generateId('cus'), userId, status: 'offline', updatedAt: now });
  }
}

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const statuses = await db.select().from(t);
    return success(c, statuses);
  } catch (err) {
    console.error('[app-api/chat-status] list failed:', err);
    return error.internal(c, 'Failed to fetch statuses');
  }
});

app.put('/', requirePermission('settings:update'), zValidator('json', setChatStatusSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const data = c.req.valid('json');

  try {
    const now = new Date();
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(eq(t.userId, userId))
      .limit(1);

    if (existing) {
      await db
        .update(t)
        .set({
          status: data.status,
          statusText: data.statusText ?? null,
          statusEmoji: data.statusEmoji ?? null,
          statusExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(eq(t.userId, userId));
    } else {
      await db.insert(t).values({
        id: generateId('cus'),
        userId,
        status: data.status,
        statusText: data.statusText ?? null,
        statusEmoji: data.statusEmoji ?? null,
        statusExpiresAt: expiresAt,
        updatedAt: now,
      });
    }

    const [updated] = await db.select().from(t).where(eq(t.userId, userId)).limit(1);

    if (c.env.REALTIME) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.publish(
          orgId,
          'presence',
          'status_changed',
          {
            userId,
            status: data.status,
            statusText: data.statusText,
            statusEmoji: data.statusEmoji,
          },
          userId,
        );
      } catch (e) {
        console.error('[app-api/chat-status] realtime publish failed:', e);
      }
    }

    return success(c, updated);
  } catch (err) {
    console.error('[app-api/chat-status] set failed:', err);
    return error.internal(c, 'Failed to set status');
  }
});

app.post('/offline', requirePermission('settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');

  try {
    await setUserOffline(db, userId);

    if (c.env.REALTIME) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.publish(orgId, 'presence', 'status_changed', { userId, status: 'offline' }, userId);
      } catch (e) {
        console.error('[app-api/chat-status] realtime publish failed:', e);
      }
    }

    return success(c, { userId, status: 'offline' });
  } catch (err) {
    console.error('[app-api/chat-status] offline failed:', err);
    return error.internal(c, 'Failed to set offline');
  }
});

app.delete('/', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');

  try {
    await db.delete(t).where(eq(t.userId, userId));

    if (c.env.REALTIME) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.publish(orgId, 'presence', 'status_cleared', { userId }, userId);
      } catch (e) {
        console.error('[app-api/chat-status] realtime publish failed:', e);
      }
    }

    return success(c, { userId, cleared: true });
  } catch (err) {
    console.error('[app-api/chat-status] clear failed:', err);
    return error.internal(c, 'Failed to clear status');
  }
});

export const chatStatusRoutes = app;
