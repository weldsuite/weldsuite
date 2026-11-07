/**
 * A visitor writing into a conversation the team merged into another one of
 * theirs (POST /api/conversations/:id/messages), on pglite: the message lands
 * on the kept conversation, reopening it, the answer names that conversation
 * so the widget switches over to it, and the duplicate stays closed. The
 * merge's own timeline events never reach the visitor.
 *
 * Conformance-ready: fixed seeds; the realtime and entity-event publishes are
 * recorded by the harness and compared with the Rust backend's.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { WIDGET, addWidget, at, getAs, json, seedWorkspaces, visitorRow, visitorToken, widgetEnv } from '../test/widget-fixtures';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const { deskConversations, deskMessages, deskVisitors } = tenantSchema;
const BASE = '/api/conversations';

let tenantDb: Database;
let masterDb: Database;
let token = '';

const call = (path: string, init?: RequestInit) =>
  createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(),
    rustBasePath: '/public/helpdesk-widget',
  }).request(path, init);

async function seed(id: string, conversationNumber: number, values: Partial<typeof deskConversations.$inferInsert>) {
  await tenantDb.insert(deskConversations).values({
    id,
    conversationNumber,
    visitorId: 'vis_mo',
    name: 'Mo',
    title: id,
    channel: 'messenger',
    createdAt: at(0),
    updatedAt: at(0),
    lastMessageAt: at(1),
    lastMessagePreview: 'Seed',
    ...values,
  });
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await tenantDb.insert(deskVisitors).values(visitorRow('vis_mo'));
  token = await visitorToken('vis_mo');

  // The kept conversation (closed since), and the duplicate merged into it.
  await seed('dconv_kept', 501, { state: 'closed' });
  await seed('dconv_dup', 502, { state: 'closed', mergedIntoId: 'dconv_kept' });
  await tenantDb.insert(deskMessages).values({
    id: 'dmsg_dup_merged',
    conversationId: 'dconv_dup',
    kind: 'event',
    authorType: 'agent',
    authorId: 'user_ann',
    metadata: { eventType: 'merged_into', linkedConversationId: 'dconv_kept', linkedConversationNumber: 501 },
    createdAt: at(2),
  });
}, 60_000);

describe('a message on a merged conversation', () => {
  it('keeps the merge event away from the visitor', async () => {
    const res = await call(`${BASE}/dconv_dup`, getAs(token));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { messages: Array<{ id: string }> } };
    expect(data.messages.map((m) => m.id)).not.toContain('dmsg_dup_merged');
  });

  it('lands on the kept conversation, reopening it, and says so', async () => {
    const res = await call(`${BASE}/dconv_dup/messages`, json({ body: 'Any news on my order?' }, { token }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { conversation: { id: string; state: string }; message: { conversationId: string; body: string } };
    };
    expect(data.conversation).toMatchObject({ id: 'dconv_kept', state: 'open' });
    expect(data.message).toMatchObject({ conversationId: 'dconv_kept', body: 'Any news on my order?' });

    const [dup] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_dup'));
    expect(dup?.state).toBe('closed');
    const onDup = await tenantDb.select().from(deskMessages).where(eq(deskMessages.conversationId, 'dconv_dup'));
    expect(onDup.map((m) => m.id)).toEqual(['dmsg_dup_merged']);
  });
});
