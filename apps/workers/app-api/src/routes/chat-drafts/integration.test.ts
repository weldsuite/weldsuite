/**
 * DB-backed integration tests for /api/chat-drafts (WeldChat) — focused on the
 * owner boundary: a draft is private to its author.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatDraftsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

const ALICE = 'user_alice';
const BOB = 'user_bob';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  await db.insert(schema.chatDrafts).values([
    {
      id: generateId('cdft'),
      workspaceId: 'org_test_default',
      userId: ALICE,
      content: 'alice draft',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId('cdft'),
      workspaceId: 'org_test_default',
      userId: BOB,
      content: 'bob draft',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}, 60_000);

describe('/api/chat-drafts · owner boundary', () => {
  it('GET / returns only the caller’s drafts even with a spoofed userId filter', async () => {
    const { request } = createTestApp('/api/chat-drafts', chatDraftsRoutes, {
      context: { userId: ALICE, permissions: permissions('channels:read'), tenantDb: db },
    });
    // Attempt to read Bob's drafts via the query filter — must be ignored.
    const res = await request(`/api/chat-drafts?userId=${BOB}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; userId: string }[] };
    expect(body.data.every((d) => d.userId === ALICE)).toBe(true);
    expect(body.data.some((d) => d.content === 'bob draft')).toBe(false);
  });

  it('POST / stamps the caller as owner, ignoring a body userId', async () => {
    // Drafts are personal and low-privilege: every chat-drafts op (incl. create)
    // gates on `channels:read`, not `channels:create`.
    const { request } = createTestApp('/api/chat-drafts', chatDraftsRoutes, {
      context: { userId: ALICE, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request('/api/chat-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: BOB, channelId: generateId('ch'), content: 'new draft' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.chatDrafts)
      .where(eq(schema.chatDrafts.id, body.data.id))
      .limit(1);
    expect(row?.userId).toBe(ALICE);
  });

  it('GET /:id 404s another user’s draft', async () => {
    const [bobDraft] = await db
      .select()
      .from(schema.chatDrafts)
      .where(eq(schema.chatDrafts.userId, BOB))
      .limit(1);

    const { request } = createTestApp('/api/chat-drafts', chatDraftsRoutes, {
      context: { userId: ALICE, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-drafts/${bobDraft.id}`);
    expect(res.status).toBe(404);
  });
});
