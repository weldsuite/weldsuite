/**
 * DB-backed tests for /api/chat-sections (the sidebar's channel groups), and
 * the bookmark, draft and status routes the other files leave out: editing
 * and removing a bookmark, removing a draft, clearing a status.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatSectionsRoutes } from './index';
import { chatBookmarksRoutes } from '../chat-bookmarks';
import { chatDraftsRoutes } from '../chat-drafts';
import { chatStatusRoutes } from '../chat-status';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const USER = 'user_sec_ann';
const OTHER = 'user_sec_bob';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function sections(keys = ['channels:read', 'channels:create', 'channels:update', 'channels:delete']) {
  return createTestApp('/api/chat-sections', chatSectionsRoutes, {
    context: { userId: USER, permissions: permissions(...keys), tenantDb: db },
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('/api/chat-sections', () => {
  it('creates, lists, pages, searches, reads, renames and deletes a section', async () => {
    const created: string[] = [];
    for (const name of ['Projects', 'Customers', 'Team']) {
      const res = await sections().request('/api/chat-sections', json({ name, position: created.length }));
      expect(res.status).toBe(201);
      created.push(((await res.json()) as { data: { id: string } }).data.id);
    }
    const page = await sections().request('/api/chat-sections?limit=2');
    expect(page.status).toBe(200);
    const body = (await page.json()) as { data: Array<{ id: string }>; pagination: { cursor: string | null; totalCount: number } };
    expect(body.data.length).toBe(2);
    expect(body.pagination.totalCount).toBe(3);
    const next = await sections().request(`/api/chat-sections?cursor=${body.pagination.cursor}`);
    expect(((await next.json()) as { data: unknown[] }).data.length).toBe(1);
    const found = await sections().request('/api/chat-sections?search=Cust');
    expect(((await found.json()) as { data: Array<{ name: string }> }).data[0]?.name).toBe('Customers');

    const one = await sections().request(`/api/chat-sections/${created[0]}`);
    expect(((await one.json()) as { data: { name: string } }).data.name).toBe('Projects');
    const renamed = await sections().request(`/api/chat-sections/${created[0]}`, json({ name: 'Work', position: 9 }, 'PATCH'));
    expect(renamed.status).toBe(200);

    // A channel in the section is unassigned, not left dangling.
    const channelId = generateId('ch');
    const now = new Date();
    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'sec-ch', slug: `sec-ch-${channelId}`, type: 'public', sectionId: created[0], createdAt: now, updatedAt: now,
    });
    const removed = await sections().request(`/api/chat-sections/${created[0]}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    const [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, channelId));
    expect(channel?.sectionId).toBeNull();
  });

  it('refuses a missing section, an empty name and a missing permission', async () => {
    expect((await sections().request('/api/chat-sections/csec_missing')).status).toBe(404);
    expect((await sections().request('/api/chat-sections/csec_missing', json({ name: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await sections().request('/api/chat-sections/csec_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await sections().request('/api/chat-sections', json({ name: '' }))).status).toBe(400);
    expect((await sections().request('/api/chat-sections', json({ name: 'ok', position: 1.5 }))).status).toBe(400);
    expect((await sections(['channels:read']).request('/api/chat-sections', json({ name: 'x' }))).status).toBe(403);
  });
});

describe('bookmarks, drafts and status: edits and removals', () => {
  it('edits a bookmark note and deletes it, never someone else\'s', async () => {
    const now = new Date();
    const channelId = generateId('ch');
    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'bm-ch', slug: `bm-ch-${channelId}`, type: 'public', createdAt: now, updatedAt: now,
    });
    const messageId = generateId('msg');
    await db.insert(schema.chatMessages).values({
      id: messageId, channelId, authorId: OTHER, authorName: 'Bob', content: 'keep this', createdAt: now, updatedAt: now,
    });
    const app = (userId: string) =>
      createTestApp('/api/chat-bookmarks', chatBookmarksRoutes, {
        context: { userId, permissions: permissions('messages:read', 'messages:create', 'messages:update', 'messages:delete'), tenantDb: db },
      });
    const created = await app(USER).request('/api/chat-bookmarks', json({ messageId, channelId, note: 'later' }));
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    expect((await app(USER).request(`/api/chat-bookmarks/${id}`, json({ note: null }, 'PATCH'))).status).toBe(200);
    expect((await app(USER).request(`/api/chat-bookmarks/${id}`, json({ note: 'again' }, 'PATCH'))).status).toBe(200);
    expect((await app(OTHER).request(`/api/chat-bookmarks/${id}`, json({ note: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await app(OTHER).request(`/api/chat-bookmarks/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app(USER).request(`/api/chat-bookmarks/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app(USER).request(`/api/chat-bookmarks/${id}`)).status).toBe(404);
  });

  it('deletes a draft, never someone else\'s', async () => {
    const app = (userId: string) =>
      createTestApp('/api/chat-drafts', chatDraftsRoutes, {
        context: { userId, permissions: permissions('channels:read'), tenantDb: db },
      });
    const created = await app(USER).request('/api/chat-drafts', json({ channelId: null, content: 'half a thought' }));
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    expect((await app(OTHER).request(`/api/chat-drafts/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app(USER).request(`/api/chat-drafts/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app(USER).request(`/api/chat-drafts/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('clears a status', async () => {
    const app = createTestApp('/api/chat-status', chatStatusRoutes, {
      context: { userId: USER, permissions: permissions('settings:read', 'channels:read'), tenantDb: db },
    });
    expect((await app.request('/api/chat-status', json({ status: 'busy', statusText: 'Heads down' }, 'PUT'))).status).toBe(200);
    const cleared = await app.request('/api/chat-status', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { data: { cleared: boolean } }).data.cleared).toBe(true);
    const rows = await db.select().from(schema.chatUserStatus).where(eq(schema.chatUserStatus.userId, USER));
    expect(rows).toHaveLength(0);
  });
});
