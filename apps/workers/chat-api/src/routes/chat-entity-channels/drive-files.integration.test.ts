/**
 * DB-backed integration tests for sheet and document chats (ADR CHAT-007):
 * who may read them (their WeldDrive file's access), who may write in them
 * (who may comment on the file), who follows a new one, and `GET …/comments`,
 * which returns the comment threads (messages posted with `metadata.anchor`)
 * and their replies.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes, so the events reach the queue binding too.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

import { chatEntityChannelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { DriveGeneralAccess } from '@weldsuite/db/schema';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  for (const userId of ['alice', 'bob', 'cara']) {
    const now = new Date();
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'),
      userId,
      email: `${userId}@example.com`,
      name: userId,
      role: 'MEMBER',
      memberType: 'INTERNAL',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    } as typeof schema.workspaceMembers.$inferInsert);
  }
}, 60_000);

const SHEETS = ['channels:read', 'messages:create', 'sheets:read', 'sheets:comment'];
const DOCS = ['channels:read', 'messages:create', 'docs:read', 'docs:comment'];
/** May open sheets, but not comment on them. */
const SHEETS_READ = ['channels:read', 'messages:create', 'sheets:read'];

function api(userId: string, perms: string[]) {
  const { request } = createTestApp('/api/chat-entity-channels', chatEntityChannelsRoutes, {
    context: { userId, permissions: permissions(...perms), tenantDb: db },
    env: { REALTIME: { fetch: async () => new Response('{}') } as unknown as Fetcher },
  });
  return (path: string, method = 'GET', body?: unknown) =>
    request(`/api/chat-entity-channels${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function seedFile(name: string, ownerId: string, generalAccess: DriveGeneralAccess, kind: 'sheet' | 'doc'): Promise<string> {
  const fileId = generateId('fil');
  const id = generateId(kind === 'sheet' ? 'sht' : 'doc');
  const now = new Date();
  await db.insert(schema.files).values({
    id: fileId,
    fileName: name,
    originalName: name,
    mimeType: 'application/octet-stream',
    fileSize: 1,
    storagePath: `k/${id}`,
    uploadedById: ownerId,
    generalAccess,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.files.$inferInsert);
  const row = { id, fileId, snapshotKey: `k/${id}`, revision: 0, updatedById: ownerId, createdAt: now, updatedAt: now };
  if (kind === 'sheet') await db.insert(schema.sheets).values({ ...row, snapshotRevision: 0 } as typeof schema.sheets.$inferInsert);
  else await db.insert(schema.docs).values(row as typeof schema.docs.$inferInsert);
  return id;
}

async function followerIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.chatChannelMembers.userId })
    .from(schema.chatChannelMembers)
    .where(eq(schema.chatChannelMembers.channelId, channelId));
  return rows.map((r) => r.userId).sort();
}

interface CommentsBody {
  data: { channel: { id: string } | null; messages: { id: string; parentId: string | null; content: string; metadata: { anchor?: { id: string } } | null }[] };
}

describe('sheet and document chats', () => {
  it('holds a sheet\'s comment threads and their replies, and leaves other messages out', async () => {
    const sheetId = await seedFile('Budget', 'alice', 'workspace_view', 'sheet');
    const bob = api('bob', SHEETS);

    const empty = await bob(`/sheet/${sheetId}/comments`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as CommentsBody).data).toEqual({ channel: null, messages: [] });

    const started = await bob(`/sheet/${sheetId}/messages`, 'POST', {
      content: 'Is this total right?',
      metadata: { anchor: { id: 'cm_1', label: 'Sheet1!B7' } },
    });
    expect(started.status).toBe(201);
    const { channel, message } = ((await started.json()) as { data: { channel: { id: string; name: string }; message: { id: string } } }).data;
    expect(channel.name).toBe('Budget');
    // The owner follows from the start; the commenter by commenting.
    expect(await followerIds(channel.id)).toEqual(['alice', 'bob']);

    const alice = api('alice', SHEETS);
    expect((await alice(`/sheet/${sheetId}/messages`, 'POST', { content: 'Yes', parentId: message.id })).status).toBe(201);
    expect((await alice(`/sheet/${sheetId}/messages`, 'POST', { content: 'Just chatting' })).status).toBe(201);

    const read = ((await (await bob(`/sheet/${sheetId}/comments`)).json()) as CommentsBody).data;
    expect(read.channel?.id).toBe(channel.id);
    expect(read.messages.map((m) => [m.content, m.parentId, m.metadata?.anchor?.id ?? null])).toEqual([
      ['Is this total right?', null, 'cm_1'],
      ['Yes', message.id, null],
    ]);
  });

  it('is open to whoever may open the file, with the module\'s read permission', async () => {
    const sheetId = await seedFile('Private', 'alice', 'restricted', 'sheet');
    expect((await api('alice', SHEETS)(`/sheet/${sheetId}/comments`)).status).toBe(200);
    expect((await api('bob', SHEETS)(`/sheet/${sheetId}/comments`)).status).toBe(403);
    expect((await api('bob', SHEETS)(`/sheet/${sheetId}/messages`, 'POST', { content: 'x' })).status).toBe(403);

    const shared = await seedFile('Shared', 'alice', 'workspace_view', 'sheet');
    expect((await api('bob', ['channels:read', 'messages:create'])(`/sheet/${shared}/comments`)).status).toBe(403);
    expect((await api('bob', SHEETS)('/sheet/sht_missing/comments')).status).toBe(403);
  });

  it('takes the right to comment to write in it: the comment permission, or editing the file', async () => {
    const viewOnly = await seedFile('Read only', 'alice', 'workspace_view', 'sheet');
    const refused = await api('bob', SHEETS_READ)(`/sheet/${viewOnly}/messages`, 'POST', { content: 'x', metadata: { anchor: { id: 'cm_x' } } });
    expect(refused.status).toBe(403);
    // Refused before the chat exists: reading it alone never creates it.
    expect(((await (await api('bob', SHEETS_READ)(`/sheet/${viewOnly}/comments`)).json()) as CommentsBody).data.channel).toBeNull();

    // Editing the file is enough.
    const editable = await seedFile('Shared to edit', 'alice', 'workspace_edit', 'sheet');
    expect((await api('bob', [...SHEETS_READ, 'sheets:update'])(`/sheet/${editable}/messages`, 'POST', { content: 'y' })).status).toBe(201);
    // Update rights on a file shared to view are not.
    expect((await api('bob', [...SHEETS_READ, 'sheets:update'])(`/sheet/${viewOnly}/messages`, 'POST', { content: 'z' })).status).toBe(403);
  });

  it('gives documents a chat too', async () => {
    const docId = await seedFile('Plan', 'alice', 'workspace_edit', 'doc');
    const cara = api('cara', DOCS);
    const posted = await cara(`/doc/${docId}/messages`, 'POST', { content: 'Reword this?', metadata: { anchor: { id: 'd_1', quote: 'the plan' } } });
    expect(posted.status).toBe(201);
    const read = ((await (await cara(`/doc/${docId}/comments`)).json()) as CommentsBody).data;
    expect(read.messages.map((m) => m.metadata?.anchor?.id)).toEqual(['d_1']);
    // A document needs docs:read, not sheets:read.
    expect((await api('cara', SHEETS)(`/doc/${docId}/comments`)).status).toBe(403);
  });
});
