/**
 * Click-to-call on pglite: POST /api/calls with a `deskConversationId` links
 * the call to the conversation and, for an outbound call, notes it on the
 * conversation's timeline. The conversation must exist.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { callsRoutes } from './index';

const BASE = '/api/calls';

let db: Database;

function post(body: Record<string, unknown>) {
  const { request } = createTestApp(BASE, callsRoutes, {
    context: {
      userId: 'user_dialer',
      workspaceId: 'ws_ctc',
      clerkOrgId: 'org_ctc',
      tenantDb: db,
      masterDb: holder.master as Database,
      permissions: permissions('activities:create'),
    },
  });
  return request(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const call = { fromNumber: '+31200000001', toNumber: '+31612345678' };
const rowOf = async (id: string) => (await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, id)))[0]!;
const messagesOf = (conversationId: string) =>
  db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, conversationId));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const master = (await createMasterPgliteDb()).db;
  holder.master = master;
  const now = new Date();
  await master.insert(masterSchema.workspaces).values({ id: 'ws_ctc', clerkOrgId: 'org_ctc', name: 'Ctc', slug: 'ctc' } as typeof masterSchema.workspaces.$inferInsert);
  await master.insert(masterSchema.workspaceCredits).values({ id: 'wcr_ctc', workspaceId: 'ws_ctc', currentBalance: 100, periodStart: now, periodEnd: now });
  await db.insert(schema.deskVisitors).values({ id: 'dvis_ctc', name: 'Eve', phone: '+31612345678' });
  await db.insert(schema.deskConversations).values({
    id: 'dconv_ctc', conversationNumber: 8001, title: 'Call Eve', state: 'open', channel: 'email', visitorId: 'dvis_ctc',
  });
}, 180_000);

describe('POST /api/calls with a conversation', () => {
  it('links an outbound call to the conversation and notes it there', async () => {
    const res = await post({ ...call, direction: 'outbound', deskConversationId: 'dconv_ctc' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await rowOf(data.id)).toMatchObject({ deskConversationId: 'dconv_ctc', direction: 'outbound', userId: 'user_dialer' });
    const messages = await messagesOf('dconv_ctc');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'message',
      authorType: 'system',
      body: 'Outbound call to +31612345678',
      metadata: { event: 'call_outbound', callId: data.id, userId: 'user_dialer' },
    });
  });

  it('links an inbound record without a note', async () => {
    const res = await post({ ...call, direction: 'inbound', deskConversationId: 'dconv_ctc' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await rowOf(data.id)).toMatchObject({ deskConversationId: 'dconv_ctc' });
    expect(await messagesOf('dconv_ctc')).toHaveLength(1);
  });

  it('answers 404 for a conversation that does not exist, and creates nothing', async () => {
    const before = (await db.select().from(schema.voipCalls)).length;
    const res = await post({ ...call, direction: 'outbound', deskConversationId: 'dconv_missing' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Conversation with ID 'dconv_missing' not found" } });
    expect(await db.select().from(schema.voipCalls)).toHaveLength(before);
  });

  it('still creates a call with no conversation, as before', async () => {
    const res = await post({ ...call, direction: 'outbound' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect((await rowOf(data.id)).deskConversationId).toBeNull();
    expect(await messagesOf('dconv_ctc')).toHaveLength(1);
  });

  it('refuses an empty conversation id', async () => {
    expect((await post({ ...call, direction: 'outbound', deskConversationId: '' })).status).toBe(400);
  });
});
