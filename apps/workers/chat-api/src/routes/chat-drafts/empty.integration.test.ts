/**
 * DB-backed tests for /api/chat-drafts: an empty draft (no text, no
 * attachments) is never stored, deletes the draft it replaces, and is never listed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chatDraftsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

const CAROL = 'user_carol';
const CHANNEL = 'ch_empty_draft';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app() {
  return createTestApp('/api/chat-drafts', chatDraftsRoutes, {
    context: { userId: CAROL, permissions: permissions('channels:read'), tenantDb: db },
  });
}

const send = (method: string, path: string, body: Record<string, unknown>) =>
  app().request(`/api/chat-drafts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const rowsFor = (channelId: string) =>
  db
    .select()
    .from(schema.chatDrafts)
    .where(and(eq(schema.chatDrafts.userId, CAROL), eq(schema.chatDrafts.channelId, channelId)));

describe('/api/chat-drafts · empty drafts', () => {
  it('POST / with empty or whitespace content stores nothing', async () => {
    for (const content of ['', '   \n ']) {
      const res = await send('POST', '', { channelId: CHANNEL, content });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { deleted: boolean } }).data.deleted).toBe(false);
    }
    expect(await rowsFor(CHANNEL)).toHaveLength(0);
  });

  it('POST / with empty content deletes the existing draft at that location', async () => {
    const created = await send('POST', '', { channelId: CHANNEL, content: 'keep me' });
    expect(created.status).toBe(201);
    expect(await rowsFor(CHANNEL)).toHaveLength(1);

    const res = await send('POST', '', { channelId: CHANNEL, content: '' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { deleted: boolean } }).data.deleted).toBe(true);
    expect(await rowsFor(CHANNEL)).toHaveLength(0);
  });

  it('POST / with empty text but an attachment is kept', async () => {
    const res = await send('POST', '', {
      channelId: 'ch_attach_only',
      content: '',
      attachments: [{ id: 'f1', fileName: 'a.png', fileSize: 1, mimeType: 'image/png', url: 'https://x/a.png' }],
    });
    expect(res.status).toBe(201);
    expect(await rowsFor('ch_attach_only')).toHaveLength(1);
  });

  it('PATCH /:id that would leave the draft empty deletes it', async () => {
    const created = (await (await send('POST', '', { channelId: 'ch_patch_empty', content: 'text' })).json()) as {
      data: { id: string };
    };
    const res = await send('PATCH', `/${created.data.id}`, { content: '  ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { deleted: boolean } }).data.deleted).toBe(true);
    expect(await rowsFor('ch_patch_empty')).toHaveLength(0);
  });

  it('GET / hides empty drafts already in the table', async () => {
    const now = new Date();
    const base = { workspaceId: 'org_test_default', userId: CAROL, createdAt: now, updatedAt: now };
    await db.insert(schema.chatDrafts).values([
      { id: generateId('cdft'), channelId: 'ch_legacy_empty', content: '', ...base },
      { id: generateId('cdft'), channelId: 'ch_legacy_blank', content: '  ', ...base },
      { id: generateId('cdft'), channelId: 'ch_legacy_real', content: 'real', ...base },
    ]);
    const res = await app().request('/api/chat-drafts');
    const body = (await res.json()) as {
      data: { channelId: string }[];
      pagination: { totalCount: number };
    };
    const channels = body.data.map((d) => d.channelId);
    expect(channels).toContain('ch_legacy_real');
    expect(channels).not.toContain('ch_legacy_empty');
    expect(channels).not.toContain('ch_legacy_blank');
    expect(body.pagination.totalCount).toBe(body.data.length);
  });
});
