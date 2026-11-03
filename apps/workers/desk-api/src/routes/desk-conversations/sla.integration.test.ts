/**
 * The SLA engine through the inbox routes, against pglite: with SLA
 * policies stored, every write that can move a clock (an agent reply,
 * close, reopen, assignment, a ticket-field change) re-derives the
 * conversation's clocks and its `sla*` summary, and the list sorts by the
 * next SLA target. In conformance mode the responses and the clocks the
 * assertions read are Rust's.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { deskConversationsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDeskConversation } from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const MINUTE = 60_000;

const app = () =>
  createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: {
      permissions: permissions('conversations:read', 'conversations:update'),
      tenantDb: db,
      userId: 'user_sla_agent',
    },
  });

const send = (method: string, path: string, body?: unknown) =>
  app().request(`/api/desk/conversations${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface Conversation {
  id: string;
  slaPolicyId: string | null;
  slaStatus: string | null;
  slaDueAt: string | null;
  slaMetric: string | null;
}

async function conversationOf(res: Response): Promise<Conversation> {
  expect(res.status).toBeLessThan(300);
  const json = (await res.json()) as { data: { conversation: Conversation } };
  return json.data.conversation;
}

const clocksOf = async (conversationId: string) =>
  Object.fromEntries(
    (await db.select().from(schema.deskSlaClocks).where(eq(schema.deskSlaClocks.conversationId, conversationId))).map(
      (c) => [c.metric, c],
    ),
  );

/** A visitor's conversation, started outside the routes (the widget or email does that). */
async function start(visitorId: string) {
  const { conversation, message } = await createDeskConversation(db, {
    generateId,
    visitorId,
    name: 'Rita',
    body: 'Nothing works',
  });
  return { id: conversation.id, startedAt: message.createdAt.getTime() };
}

const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.deskSlaClocks);
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.helpdeskSlas);
  await db.delete(schema.helpdeskSettings);
  const at = new Date('2026-01-01T00:00:00Z');
  await db.insert(schema.helpdeskSlas).values([
    {
      id: 'sla_route_default',
      name: 'Standard',
      createdAt: at,
      updatedAt: at,
      isDefault: true,
      isActive: true,
      operationalHours: '24x7',
      firstResponseTime: [
        { priority: 'medium', time: 60 },
        { priority: 'urgent', time: 15, notifyAt: [50] },
      ],
      resolutionTime: [
        { priority: 'medium', time: 480 },
        { priority: 'urgent', time: 120 },
      ],
      updateTime: [{ priority: 'medium', time: 120 }],
    },
    {
      id: 'sla_route_ann',
      name: 'Ann owns it',
      createdAt: at,
      updatedAt: at,
      isActive: true,
      priority: 1,
      operationalHours: '24x7',
      conditions: [{ field: 'assignee', operator: 'equals', value: 'user_ann' }],
      firstResponseTime: [{ priority: 'medium', time: 10 }],
      reminders: [{ type: 'before_breach', time: 3, recipients: ['assignee'] }],
    },
    {
      id: 'sla_route_vip',
      name: 'VIP, office hours',
      createdAt: at,
      updatedAt: at,
      isActive: true,
      priority: 2,
      operationalHours: 'custom',
      businessHours: {
        timezone: 'Asia/Kolkata',
        monday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
        tuesday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
        wednesday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
        thursday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
        friday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
        saturday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
        sunday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
      },
      conditions: [{ field: 'tags', operator: 'contains', value: 'vip' }],
      firstResponseTime: [{ priority: 'medium', time: 30 }],
      resolutionTime: [{ priority: 'medium', time: 240 }],
    },
  ]);
});

describe('desk SLA through the inbox routes', () => {
  it('retargets on a priority change and on a policy that matches the new tags', async () => {
    const { id, startedAt } = await start('v_sla_prio');

    const urgent = await conversationOf(await send('PATCH', `/${id}`, { priority: 'urgent' }));
    expect(urgent).toMatchObject({ slaPolicyId: 'sla_route_default', slaStatus: 'active', slaMetric: 'first_response' });
    expect(urgent.slaDueAt).toBe(iso(startedAt + 15 * MINUTE));
    const clocks = await clocksOf(id);
    // notifyAt 50%: warned 8 minutes (rounded) before the 15.
    expect(clocks.first_response).toMatchObject({ targetMinutes: 15, warnBeforeMinutes: 8, status: 'running' });
    expect(clocks.first_response?.nextCheckAt?.toISOString()).toBe(iso(startedAt + 7 * MINUTE));

    const vip = await conversationOf(await send('PATCH', `/${id}`, { priority: 'medium', tags: ['VIP'] }));
    expect(vip).toMatchObject({ slaPolicyId: 'sla_route_vip', slaMetric: 'first_response' });
    expect(vip.slaDueAt).toBe(iso(startedAt + 30 * MINUTE));
    expect((await clocksOf(id)).resolution?.calendar).toMatchObject({ timezone: 'Asia/Kolkata' });

    // A change that touches nothing writes nothing and keeps the summary.
    const same = await conversationOf(await send('PATCH', `/${id}`, { tags: ['VIP'] }));
    expect(same.slaDueAt).toBe(vip.slaDueAt);
  });

  it('re-derives on assignment, meets first response on a reply, and closes and reopens', async () => {
    const { id, startedAt } = await start('v_sla_flow');

    const assigned = await conversationOf(await send('POST', `/${id}/manage`, { action: 'assign', assigneeId: 'user_ann' }));
    expect(assigned).toMatchObject({ slaPolicyId: 'sla_route_ann', slaMetric: 'first_response' });
    expect(assigned.slaDueAt).toBe(iso(startedAt + 10 * MINUTE));
    // Ann's policy has no resolution target: that clock is gone.
    expect(Object.keys(await clocksOf(id))).toEqual(['first_response']);

    const unassigned = await conversationOf(await send('POST', `/${id}/manage`, { action: 'assign', assigneeId: null }));
    expect(unassigned).toMatchObject({ slaPolicyId: 'sla_route_default' });
    expect(unassigned.slaDueAt).toBe(iso(startedAt + 60 * MINUTE));

    // An internal note never meets a clock.
    const noted = await conversationOf(await send('POST', `/${id}/reply`, { kind: 'note', body: 'Checking the logs' }));
    expect(noted.slaStatus).toBe('active');

    const replied = await conversationOf(await send('POST', `/${id}/reply`, { body: 'On it!' }));
    expect(replied).toMatchObject({ slaStatus: 'paused', slaDueAt: null, slaMetric: null });
    const clocks = await clocksOf(id);
    expect(clocks.first_response).toMatchObject({ status: 'completed', breachedAt: null, nextCheckAt: null });
    expect(clocks.resolution).toMatchObject({ status: 'paused', dueAt: null });

    const closed = await conversationOf(await send('POST', `/${id}/manage`, { action: 'close' }));
    expect(closed.slaStatus).toBe('achieved');
    expect((await clocksOf(id)).resolution).toMatchObject({ status: 'completed' });

    // Reopened by the team: waiting on the customer again.
    const reopened = await conversationOf(await send('POST', `/${id}/manage`, { action: 'open' }));
    expect(reopened.slaStatus).toBe('paused');

    const fetched = (await (await send('GET', `/${id}`)).json()) as { data: Conversation };
    expect(fetched.data).toMatchObject({ slaPolicyId: 'sla_route_default', slaStatus: 'paused' });
  });

  it('sorts the inbox by the next SLA target, conversations without one last', async () => {
    const late = await start('v_sla_sort_late');
    const soon = await start('v_sla_sort_soon');
    const none = await start('v_sla_sort_none');
    await send('PATCH', `/${soon.id}`, { priority: 'urgent' });
    await send('POST', `/${none.id}/reply`, { body: 'Answered' });

    const res = await send('GET', '?state=open&sort=sla_due');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Conversation[] };
    expect(json.data.map((c) => c.id)).toEqual([soon.id, late.id, none.id]);
  });

  it('clears the clocks when no policy applies anymore', async () => {
    const { id } = await start('v_sla_clear');
    expect(Object.keys(await clocksOf(id)).sort()).toEqual(['first_response', 'resolution']);
    await db.update(schema.helpdeskSlas).set({ isActive: false });

    const cleared = await conversationOf(await send('POST', `/${id}/reply`, { body: 'Hi' }));
    expect(cleared).toMatchObject({ slaPolicyId: null, slaStatus: null, slaDueAt: null, slaMetric: null });
    expect(await clocksOf(id)).toEqual({});
  });
});
