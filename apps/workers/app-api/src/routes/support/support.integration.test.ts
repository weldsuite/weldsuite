/**
 * /api/support (Contact Support) against real tenant and master databases
 * (pglite): the refusals (the `general:read` gate, no organisation, a plan
 * other than Enterprise), the channel created on first access, messages with
 * their cursor pages and the channel's last-message preview, and adding and
 * removing members.
 *
 * Conformance-ready (rust/conformance/suites.json): every request also runs on
 * the Rust backend, and the realtime publishes (the workspace hub's `support`
 * topic and the SupportRoom) are compared between the backends.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));

import { supportRoutes } from './index';

const ENTERPRISE = 'org_sup_ent';
const OWNER = 'user_sup_owner';
const PLAN_REQUIRED = 'Contact Support is available on the Enterprise plan.';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

interface Caller {
  userId?: string;
  orgId?: string | null;
  keys?: string[];
}

function app({ userId = OWNER, orgId = ENTERPRISE, keys = ['general:read'] }: Caller = {}) {
  return createTestApp('/api/support', supportRoutes, {
    context: { userId, orgId, tenantDb: db, masterDb: master, permissions: permissions(...keys) },
  });
}

function call(path: string, init: RequestInit = {}, caller: Caller = {}) {
  return app(caller).request(`/api/support${path}`, init);
}

function send(method: string, path: string, body: unknown, caller: Caller = {}) {
  return call(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    caller,
  );
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface Message {
  id: string;
  content: string;
  authorId: string;
  authorAvatar: string | null;
  htmlContent: string | null;
}

interface Member {
  userId: string;
  role: string;
}

interface Channel {
  id: string;
  memberCount: number;
  messageCount: number;
  lastMessagePreview: string | null;
}

/** Every route, for the refusals every one of them shares. */
const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/channel', undefined],
  ['GET', '/messages', undefined],
  ['POST', '/messages', { content: 'Hello', authorName: 'Owner' }],
  ['GET', '/members', undefined],
  ['POST', '/members', { userIds: ['user_sup_b'] }],
  ['DELETE', '/members/user_sup_b', undefined],
];

function hit([method, path, body]: [string, string, unknown], caller: Caller) {
  return body === undefined ? call(path, { method }, caller) : send(method, path, body, caller);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;

  await master.insert(masterSchema.plans).values([
    { id: 'plan_sup_ent', name: 'Enterprise', slug: 'enterprise' },
    { id: 'plan_sup_pro', name: 'Pro', slug: 'sup-pro' },
  ]);
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_sup_ent', clerkOrgId: ENTERPRISE, name: 'Enterprise WS', slug: 'sup-ent', planId: 'plan_sup_ent' },
    { id: 'ws_sup_pro', clerkOrgId: 'org_sup_pro', name: 'Pro WS', slug: 'sup-pro', planId: 'plan_sup_pro' },
    { id: 'ws_sup_none', clerkOrgId: 'org_sup_none', name: 'No plan WS', slug: 'sup-none' },
  ]);
}, 180_000);

describe('support refusals', () => {
  it('needs general:read on every route', async () => {
    for (const route of ROUTES) {
      expect((await hit(route, { keys: [] })).status).toBe(403);
    }
  });

  it('needs an organisation on every route', async () => {
    for (const route of ROUTES) {
      const res = await hit(route, { orgId: null });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'ORG_REQUIRED' } });
    }
  });

  it('is for Enterprise workspaces only', async () => {
    for (const orgId of ['org_sup_pro', 'org_sup_none', 'org_sup_unknown']) {
      for (const route of ROUTES) {
        const res = await hit(route, { orgId });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: PLAN_REQUIRED } });
      }
    }
  });
});

describe('support before the channel exists', () => {
  it('lists no messages and no members', async () => {
    expect(await data(await call('/messages'))).toEqual({ messages: [], hasMore: false, nextCursor: null });
    expect(await data(await call('/members'))).toEqual([]);
  });

  it('checks the message and the member list before looking for the channel', async () => {
    for (const body of [{}, { content: '   ', authorName: 'Owner' }, { content: null }]) {
      const res = await send('POST', '/messages', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { message: 'Message content is required.' } });
    }
    for (const body of [{}, { userIds: [] }]) {
      const res = await send('POST', '/members', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { message: 'At least one userId is required.' } });
    }
  });

  it('answers 500 for a body that is not JSON', async () => {
    expect((await send('POST', '/messages', 'not json')).status).toBe(500);
    expect((await send('POST', '/members', '{')).status).toBe(500);
  });

  it('cannot post, add or remove without a channel', async () => {
    for (const route of ROUTES.filter(([method]) => method !== 'GET')) {
      const res = await hit(route, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { message: 'Support channel not found' } });
    }
  });
});

describe('GET /api/support/channel', () => {
  it('creates the channel on first access, with the caller as its owner', async () => {
    // A GET that writes: compared as a write (Rust on the database, TypeScript on a copy).
    const res = await call('/channel', { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } });
    expect(res.status).toBe(201);
    const { channel, members } = await data<{ channel: Channel & { status: string }; members: Member[] }>(res);
    expect(channel).toMatchObject({ status: 'active', memberCount: 1, messageCount: 0, lastMessagePreview: null });
    expect(members).toEqual([expect.objectContaining({ channelId: channel.id, userId: OWNER, role: 'owner' })]);
  });

  it('returns the existing channel afterwards', async () => {
    const res = await call('/channel', {}, { userId: 'user_sup_b' });
    expect(res.status).toBe(200);
    const { members } = await data<{ members: Member[] }>(res);
    expect(members.map((m) => m.userId)).toEqual([OWNER]);
  });
});

describe('support messages', () => {
  let channelId: string;

  beforeAll(async () => {
    const [channel] = await db.select().from(schema.supportChannels);
    channelId = channel.id;
    const base = Date.now() - 3 * 60 * 60 * 1000;
    const rows = ['old_1', 'old_2', 'old_3', 'old_deleted'].map((suffix, i) => ({
      id: `smsg_sup_${suffix}`,
      channelId,
      authorId: 'support_agent',
      authorName: 'Support',
      authorType: 'support',
      content: `Earlier message ${i + 1}`,
      createdAt: new Date(base + i * 60_000),
      updatedAt: new Date(base + i * 60_000),
      deletedAt: suffix === 'old_deleted' ? new Date(base) : null,
    }));
    await db.insert(schema.supportMessages).values(rows);
  });

  it('posts a message and moves the channel preview', async () => {
    const res = await send('POST', '/messages', {
      content: 'Our invoices do not sync',
      authorName: 'Owner',
      authorAvatar: '',
      htmlContent: '<p>Our invoices do not sync</p>',
      attachments: [{ id: 'att_1', fileName: 'log.txt', fileSize: 12, mimeType: 'text/plain', url: 'https://x.test/log.txt' }],
    });
    expect(res.status).toBe(201);
    const message = await data<Message>(res);
    expect(message).toMatchObject({
      content: 'Our invoices do not sync',
      authorId: OWNER,
      authorAvatar: null,
      htmlContent: '<p>Our invoices do not sync</p>',
    });

    const { channel } = await data<{ channel: Channel }>(await call('/channel'));
    expect(channel).toMatchObject({ messageCount: 1, lastMessagePreview: 'Our invoices do not sync' });
  });

  it('cuts the preview at 200 UTF-16 units', async () => {
    const content = '\u{1F600}'.repeat(150);
    expect((await send('POST', '/messages', { content, authorName: 'Owner' })).status).toBe(201);
    const { channel } = await data<{ channel: Channel }>(await call('/channel'));
    expect(channel.lastMessagePreview).toBe('\u{1F600}'.repeat(100));
    expect(channel.messageCount).toBe(2);
  });

  it('pages the live messages, newest first', async () => {
    const first = await data<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(
      await call('/messages?limit=3'),
    );
    expect(first.messages).toHaveLength(3);
    expect(first.messages[2].id).toBe('smsg_sup_old_3');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('smsg_sup_old_3');

    const next = await data<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(
      await call(`/messages?limit=3&before=${first.nextCursor}`),
    );
    expect(next).toMatchObject({ hasMore: false, nextCursor: null });
    expect(next.messages.map((m) => m.id)).toEqual(['smsg_sup_old_2', 'smsg_sup_old_1']);
  });

  it('clamps the page size and ignores an unknown cursor', async () => {
    const one = await data<{ messages: Message[]; hasMore: boolean }>(await call('/messages?limit=0'));
    expect(one.messages).toHaveLength(1);
    expect(one.hasMore).toBe(true);
    const all = await data<{ messages: Message[]; hasMore: boolean }>(
      await call('/messages?limit=500&before=smsg_sup_missing'),
    );
    expect(all.messages).toHaveLength(5);
    expect(all.hasMore).toBe(false);
  });
});

describe('support members', () => {
  it('adds the new members only', async () => {
    const res = await send('POST', '/members', { userIds: ['user_sup_b', 'user_sup_c', OWNER] });
    expect(res.status).toBe(200);
    const members = await data<Member[]>(res);
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      [OWNER, 'owner'],
      ['user_sup_b', 'member'],
      ['user_sup_c', 'member'],
    ]);
    const { channel } = await data<{ channel: Channel }>(await call('/channel'));
    expect(channel.memberCount).toBe(3);
  });

  it('changes nothing when everyone is a member already', async () => {
    const res = await send('POST', '/members', { userIds: ['user_sup_b'] });
    expect(res.status).toBe(200);
    expect(await data<Member[]>(res)).toHaveLength(3);
    expect((await data<{ channel: Channel }>(await call('/channel'))).channel.memberCount).toBe(3);
    expect(await data<Member[]>(await call('/members'))).toHaveLength(3);
  });

  it('refuses to remove a stranger or the owner', async () => {
    const stranger = await call('/members/user_sup_x', { method: 'DELETE' });
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({ error: { message: "Member with ID 'user_sup_x' not found" } });

    const owner = await call(`/members/${OWNER}`, { method: 'DELETE' });
    expect(owner.status).toBe(400);
    expect(await owner.json()).toMatchObject({ error: { message: 'Cannot remove the channel owner.' } });
  });

  it('removes a member', async () => {
    const res = await call('/members/user_sup_b', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ removed: 'user_sup_b' });
    expect((await data<Member[]>(await call('/members'))).map((m) => m.userId)).toEqual([OWNER, 'user_sup_c']);
    expect((await data<{ channel: Channel }>(await call('/channel'))).channel.memberCount).toBe(2);
  });
});
