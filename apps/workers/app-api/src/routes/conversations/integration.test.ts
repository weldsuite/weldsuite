/**
 * DB-backed integration tests for /api/conversations.
 *
 * The Zod schema doesn't require `conversationNumber` or `customerName`
 * but the DB columns are NOT NULL — passed explicitly here. Once the
 * route normalises these (auto-generated number, customerName derived
 * from contact) the explicit fields can drop.
 *
 * SCOPE NOTE (W5b): only read paths are covered at the route layer. Every
 * mutation route calls `publishEntityEvent`, which now always reaches
 * `c.executionCtx` (the webhook-delivery sink added in 70375cfed fans out
 * whenever `workspaceId` is set, and the harness sets it by default) — and
 * `createTestApp` provides no ExecutionContext, so those requests 500. That
 * is a pre-existing harness gap, not a route bug: `routes/boxes` fails the
 * same way on an untouched route. Mutation behaviour is covered at the
 * service layer instead — see services/helpdesk/conversation-messages-pglite.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversationsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

/** Insert a conversation straight to the DB (bypasses the route's event publish). */
async function seedConversation(
  overrides: Partial<typeof schema.helpdeskConversations.$inferInsert> = {},
) {
  const id = generateId('conv');
  const now = new Date();
  await db.insert(schema.helpdeskConversations).values({
    id,
    conversationNumber: `CONV-${id.slice(-8)}`,
    subject: 'Seeded thread',
    customerName: 'Seed Customer',
    status: 'active',
    channel: 'email',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

function readApp() {
  return createTestApp('/api/conversations', conversationsRoutes, {
    context: { permissions: permissions('conversations:read'), tenantDb: db },
  });
}

async function listIds(query: string): Promise<string[]> {
  const { request } = readApp();
  const res = await request(`/api/conversations${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((c) => c.id);
}

describe('/api/conversations · pglite integration', () => {
  it('POST / writes a conversation row', async () => {
    const { request } = createTestApp('/api/conversations', conversationsRoutes, {
      context: {
        permissions: permissions('conversations:create'),
        tenantDb: db,
      },
    });

    const res = await request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: 'E2E support thread',
        customerName: 'Jane E2E',
        conversationNumber: 'CONV-E2E-1',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^conv_/);

    const [row] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, body.data.id))
      .limit(1);
    expect(row?.subject).toBe('E2E support thread');
    expect(row?.customerName).toBe('Jane E2E');
  });

  it('POST / rejects empty subject', async () => {
    const { request } = createTestApp('/api/conversations', conversationsRoutes, {
      context: {
        permissions: permissions('conversations:create'),
        tenantDb: db,
      },
    });
    const res = await request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: '', customerName: 'X', conversationNumber: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for missing conversation', async () => {
    const { request } = createTestApp('/api/conversations', conversationsRoutes, {
      context: {
        permissions: permissions('conversations:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/conversations/conv_missing');
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // List filters — the discord/slack/email inboxes are unusable without these.
  // -------------------------------------------------------------------------

  describe('GET / filters', () => {
    it('channel: returns only that channel', async () => {
      const discord = await seedConversation({ channel: 'discord' });
      const slack = await seedConversation({ channel: 'slack' });

      const ids = await listIds('?channel=discord&limit=100');
      expect(ids).toContain(discord);
      expect(ids).not.toContain(slack);
    });

    it('excludeStatus: drops the excluded status (the discord inbox hides closed)', async () => {
      const open = await seedConversation({ channel: 'discord', status: 'active' });
      const closed = await seedConversation({ channel: 'discord', status: 'closed' });

      const ids = await listIds('?channel=discord&excludeStatus=closed&limit=100');
      expect(ids).toContain(open);
      expect(ids).not.toContain(closed);
    });

    it('contactId: scopes to one contact — an unknown param must not fall back to "everything"', async () => {
      const contactId = generateId('cont');
      await db.insert(schema.people).values({
        id: contactId,
        firstName: 'Ada',
        lastName: 'Lovelace',
        fullName: 'Ada Lovelace',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        status: 'active',
      });
      const hers = await seedConversation({ contactId });
      const theirs = await seedConversation();

      const ids = await listIds(`?contactId=${contactId}&limit=100`);
      expect(ids).toEqual([hers]);
      expect(ids).not.toContain(theirs);
    });

    it('isStarred / isRead: boolean filters round-trip', async () => {
      const starred = await seedConversation({ isStarred: true, isRead: false });
      const plain = await seedConversation({ isStarred: false, isRead: true });

      expect(await listIds('?isStarred=true&limit=100')).toContain(starred);
      expect(await listIds('?isStarred=true&limit=100')).not.toContain(plain);
      expect(await listIds('?isRead=false&limit=100')).toContain(starred);
    });

    it('hides a chat conversation until the customer has actually said something', async () => {
      const greetingOnly = await seedConversation({ channel: 'chat', lastCustomerMessageAt: null });
      const realChat = await seedConversation({ channel: 'chat', lastCustomerMessageAt: new Date() });

      const ids = await listIds('?limit=100');
      expect(ids).not.toContain(greetingOnly);
      expect(ids).toContain(realChat);
    });

    it('hides conversations whose multi-step workflow is still running', async () => {
      const midWorkflow = await seedConversation({ hasActiveWorkflow: true });
      const done = await seedConversation({ hasActiveWorkflow: false });

      const ids = await listIds('?limit=100');
      expect(ids).not.toContain(midWorkflow);
      expect(ids).toContain(done);
    });

    it('enriches customerName/email from the linked contact', async () => {
      const contactId = generateId('cont');
      await db.insert(schema.people).values({
        id: contactId,
        firstName: 'Grace',
        lastName: 'Hopper',
        fullName: 'Grace Hopper',
        displayName: 'Grace Hopper',
        email: 'grace@example.com',
        status: 'active',
      });
      const id = await seedConversation({
        contactId,
        customerName: 'stale denormalised name',
        customerEmail: 'stale@example.com',
      });

      const { request } = readApp();
      const res = await request(`/api/conversations/${id}`);
      const body = (await res.json()) as { data: { customerName: string; customerEmail: string } };
      expect(body.data.customerName).toBe('Grace Hopper');
      expect(body.data.customerEmail).toBe('grace@example.com');
    });
  });

  // -------------------------------------------------------------------------
  // Messages — the surface that had no app-api route at all before W5b.
  // -------------------------------------------------------------------------

  describe('GET /:id/messages', () => {
    it('returns the thread oldest-first in the legacy shape', async () => {
      const convId = await seedConversation();
      const now = Date.now();
      for (const [i, content] of ['first', 'second'].entries()) {
        await db.insert(schema.helpdeskConversationMessages).values({
          id: generateId('msg'),
          conversationId: convId,
          authorName: 'Grace',
          authorType: 'agent',
          content,
          type: 'message',
          createdAt: new Date(now + i * 1000),
          updatedAt: new Date(now + i * 1000),
        });
      }

      const { request } = readApp();
      const res = await request(`/api/conversations/${convId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ content: string; authorType: string }> };
      expect(body.data.map((m) => m.content)).toEqual(['first', 'second']);
      expect(body.data[0].authorType).toBe('agent');
    });

    it('404s for a conversation that does not exist', async () => {
      const { request } = readApp();
      const res = await request('/api/conversations/conv_missing/messages');
      expect(res.status).toBe(404);
    });

    it('requires conversations:read', async () => {
      const convId = await seedConversation();
      const { request } = createTestApp('/api/conversations', conversationsRoutes, {
        context: { permissions: permissions('tickets:read'), tenantDb: db },
      });
      const res = await request(`/api/conversations/${convId}/messages`);
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Folder counts — must resolve before the /:id param route.
  // -------------------------------------------------------------------------

  it('GET /folder-counts is not swallowed by /:id', async () => {
    const { request } = readApp();
    const res = await request('/api/conversations/folder-counts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, number> };
    expect(body.data).toMatchObject({
      all: expect.any(Number),
      chat: expect.any(Number),
      unassigned: expect.any(Number),
      mine: expect.any(Number),
    });
  });
});
