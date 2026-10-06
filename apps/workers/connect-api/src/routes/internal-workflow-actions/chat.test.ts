/**
 * WeldConnect `post_chat_message` over the internal route, against pglite:
 * the owner's permissions AND channel membership are checked at run time,
 * `@weldsuite/chat-domain/post-system-message` writes the row attributed to
 * the workflow (never the owner), and the entity event carries the run's
 * chain depth.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const published: Array<Record<string, unknown>> = [];

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => db };
});

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEventRaw: async (event: Record<string, unknown>) => {
      published.push(event);
    },
  };
});

const { internalWorkflowActionsRoutes } = await import('./index');

function app() {
  const root = new Hono<{ Variables: { internalTrusted: boolean } }>();
  root.use('*', async (c, next) => {
    c.set('internalTrusted', true);
    await next();
  });
  root.route('/', internalWorkflowActionsRoutes as never);
  return (path: string, body: unknown) =>
    root.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, {});
}

const actor = (ownerUserId: string) => ({
  workspaceId: 'org_1',
  ownerUserId,
  triggeredBy: 'system',
  chainDepth: 1,
  workflowId: 'wf_1',
  workflowName: 'Weekly Digest',
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_member', userId: 'member_1', role: 'MEMBER' },
    { id: 'wm_member2', userId: 'member_2', role: 'MEMBER' },
    { id: 'wm_viewer', userId: 'viewer_1', role: 'VIEWER' },
  ]);
  await db.insert(schema.chatChannels).values([
    { id: 'chan_public', name: 'general', slug: 'general', type: 'public' },
    { id: 'chan_private', name: 'leadership', slug: 'leadership', type: 'private' },
  ]);
  await db.insert(schema.chatChannelMembers).values([
    { id: 'cmb_1', channelId: 'chan_private', userId: 'member_1', role: 'member' },
  ]);
}, 60_000);

beforeEach(() => {
  published.length = 0;
});

describe('POST /post-chat-message', () => {
  it('posts the message as the workflow (not the owner) and publishes chat_message:created with the chain depth', async () => {
    const res = await app()('/post-chat-message', {
      ...actor('member_1'),
      channelId: 'chan_public',
      content: 'The weekly report is ready',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; message: { id: string; channelId: string } };
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, body.message.id));
    expect(row).toMatchObject({
      authorId: 'workflow:wf_1',
      authorName: 'Weekly Digest',
      authorType: 'system',
      content: 'The weekly report is ready',
    });
    expect(published).toEqual([
      expect.objectContaining({
        entityType: 'chat_message',
        action: 'created',
        userId: 'member_1',
        workflowDepth: 1,
        data: expect.objectContaining({ authorId: 'workflow:wf_1', authorType: 'system' }),
      }),
    ]);
  });

  it("falls back to 'Workflow' and the workspace id when the run carries no workflow name/id", async () => {
    const res = await app()('/post-chat-message', {
      workspaceId: 'org_1',
      ownerUserId: 'member_1',
      triggeredBy: 'system',
      chainDepth: 0,
      channelId: 'chan_public',
      content: 'No workflow metadata on this run',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { id: string } };
    const [row] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, body.message.id));
    expect(row).toMatchObject({ authorId: 'workflow:org_1', authorName: 'Workflow' });
  });

  it('refuses when the owner may not post chat messages', async () => {
    const res = await app()('/post-chat-message', {
      ...actor('viewer_1'),
      channelId: 'chan_public',
      content: 'Should not post',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to post chat messages/);
    expect(published).toEqual([]);
  });

  it("refuses when the owner (who otherwise has permission) isn't a member of a private channel", async () => {
    const res = await app()('/post-chat-message', {
      ...actor('member_2'), // MEMBER role, but never joined chan_private
      channelId: 'chan_private',
      content: 'Should not post',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/access to this channel/);
    expect(published).toEqual([]);
  });

  it('lets a member of the private channel post to it', async () => {
    const ok = await app()('/post-chat-message', {
      ...actor('member_1'), // seeded as a chan_private member in beforeAll
      channelId: 'chan_private',
      content: 'Private channel update',
    });
    expect(ok.status).toBe(200);
  });

  it('rejects a missing channelId or empty content before touching the database', async () => {
    const res = await app()('/post-chat-message', { ...actor('member_1'), channelId: '', content: '' });
    expect(res.status).toBe(400);
  });
});
