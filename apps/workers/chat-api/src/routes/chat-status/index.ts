/**
 * WeldChat user status routes — flat /api/chat-status/* surface.
 *
 * A member's status dot is two facts (`@weldsuite/realtime/presence`):
 *  - their *chosen* status (Busy, Do not disturb, Away, Appear offline, or
 *    automatic) with a custom text and emoji, stored here in `chatUserStatus`;
 *  - their *live* presence (connected, idle, in a call), which only the
 *    realtime WorkspaceHub knows. It is read from the hub, never stored.
 *
 * Changes are broadcast on the hub's `presence` topic via the REALTIME
 * service binding. WeldChat streams over its own realtime path, not the
 * entity-event bus — no entity events are published here.
 *
 * Permissions: reading everyone's status takes `settings:read`. Setting or
 * clearing one's own takes `channels:read`, like one's own chat drafts: every
 * role that can use WeldChat has a status to set.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  PRESENCE_EVENTS,
  PRESENCE_TOPIC,
  chosenStatusFromStored,
  effectivePresence,
  isStatusExpired,
  storedStatusFor,
  type ChosenStatus,
  type EffectiveStatus,
  type LivePresence,
  type PresenceStatusChange,
} from '@weldsuite/realtime/presence';
import { setChatStatusSchema } from '@weldsuite/app-api-client/schemas/chat-status';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatUserStatus;

/** One member's status as every client reads it. */
interface MemberStatus {
  userId: string;
  /** What others see: the chosen status while connected, else offline. */
  status: EffectiveStatus;
  /** What the member picked (`online` = automatic). */
  manualStatus: ChosenStatus;
  /** Live presence from the hub; null = not connected. */
  live: LivePresence | null;
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: string | null;
  updatedAt: string | null;
}

function publisher(c: AppContext): RealtimePublisher | null {
  if (!c.env.REALTIME) return null;
  return new RealtimePublisher(c.env.REALTIME, { internalSecret: c.env.REALTIME_INTERNAL_SECRET });
}

/** Live presence of the workspace, or nothing when the hub cannot be reached. */
async function readLivePresence(c: AppContext, orgId: string): Promise<Record<string, LivePresence>> {
  const rt = publisher(c);
  if (!rt) return {};
  try {
    return await rt.getPresence(orgId);
  } catch (err) {
    console.error('[chat-api/chat-status] reading live presence failed:', err);
    return {};
  }
}

async function publishPresence(c: AppContext, orgId: string, event: string, data: unknown, userId: string) {
  const rt = publisher(c);
  if (!rt) return;
  try {
    await rt.publish(orgId, PRESENCE_TOPIC, event, data, userId);
  } catch (e) {
    console.error('[chat-api/chat-status] realtime publish failed:', e);
  }
}

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  try {
    const [rows, live] = await Promise.all([
      db.select().from(t),
      orgId ? readLivePresence(c, orgId) : Promise.resolve<Record<string, LivePresence>>({}),
    ]);

    const now = Date.now();
    const statuses = new Map<string, MemberStatus>();
    for (const row of rows) {
      const expired = isStatusExpired(row.statusExpiresAt, now);
      const manualStatus = chosenStatusFromStored(row.status, row.statusExpiresAt, now);
      const memberLive = live[row.userId] ?? null;
      statuses.set(row.userId, {
        userId: row.userId,
        status: effectivePresence(manualStatus, memberLive),
        manualStatus,
        live: memberLive,
        statusText: expired ? null : row.statusText,
        statusEmoji: expired ? null : row.statusEmoji,
        statusExpiresAt: expired ? null : (row.statusExpiresAt?.toISOString() ?? null),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    // Connected members who never picked a status have no row.
    for (const [userId, memberLive] of Object.entries(live)) {
      if (statuses.has(userId)) continue;
      statuses.set(userId, {
        userId,
        status: memberLive,
        manualStatus: 'online',
        live: memberLive,
        statusText: null,
        statusEmoji: null,
        statusExpiresAt: null,
        updatedAt: null,
      });
    }

    return success(c, [...statuses.values()]);
  } catch (err) {
    console.error('[chat-api/chat-status] list failed:', err);
    return error.internal(c, 'Failed to fetch statuses');
  }
});

app.put('/', requirePermission('channels:read'), zValidator('json', setChatStatusSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const data = c.req.valid('json');

  try {
    const now = new Date();
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    const values = {
      status: storedStatusFor(data.status),
      statusText: data.statusText ?? null,
      statusEmoji: data.statusEmoji ?? null,
      statusExpiresAt: expiresAt,
      updatedAt: now,
    };

    await db
      .insert(t)
      .values({ id: generateId('cus'), userId, ...values })
      .onConflictDoUpdate({ target: t.userId, set: values });

    const change: PresenceStatusChange = {
      userId,
      status: data.status,
      statusText: values.statusText,
      statusEmoji: values.statusEmoji,
      expiresAt: expiresAt?.toISOString() ?? null,
      updatedAt: now.toISOString(),
    };
    await publishPresence(c, orgId, PRESENCE_EVENTS.status, change, userId);

    return success(c, { ...change, manualStatus: data.status });
  } catch (err) {
    console.error('[chat-api/chat-status] set failed:', err);
    return error.internal(c, 'Failed to set status');
  }
});

app.delete('/', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');

  try {
    await db.delete(t).where(eq(t.userId, userId));
    await publishPresence(c, orgId, PRESENCE_EVENTS.cleared, { userId, updatedAt: new Date().toISOString() }, userId);
    return success(c, { userId, cleared: true });
  } catch (err) {
    console.error('[chat-api/chat-status] clear failed:', err);
    return error.internal(c, 'Failed to clear status');
  }
});

export const chatStatusRoutes = app;
