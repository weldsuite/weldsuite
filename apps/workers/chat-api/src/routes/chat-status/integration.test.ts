/**
 * DB-backed tests for /api/chat-status: a member's chosen status is stored
 * here, their live presence comes from the realtime WorkspaceHub, and GET
 * combines the two into what everyone sees.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatStatusRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { LivePresence } from '@weldsuite/realtime/presence';
import type { Env } from '../../types';

let db: Database;

const ANN = 'user_ann';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const DAVE = 'user_dave';

/** The REALTIME service binding: answers presence reads, records publishes. */
function fakeRealtime(live: Record<string, LivePresence>) {
  const published: Array<{ topic: string; event: string; data: Record<string, unknown> }> = [];
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      if (url.pathname === '/internal/presence') return Response.json({ users: live });
      if (url.pathname === '/publish/workspace') {
        published.push(JSON.parse(String(init?.body)));
        return new Response('ok');
      }
      return new Response('Not found', { status: 404 });
    },
  };
  return { binding: binding as unknown as Fetcher, published };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.chatUserStatus);
});

/** A plain member: may read statuses and use WeldChat, nothing more. */
function app(userId: string, realtime: ReturnType<typeof fakeRealtime>) {
  return createTestApp('/api/chat-status', chatStatusRoutes, {
    context: { userId, permissions: permissions('settings:read', 'channels:read'), tenantDb: db },
    env: { REALTIME: realtime.binding, REALTIME_INTERNAL_SECRET: 'secret' } as Partial<Env>,
  });
}

const put = (userId: string, realtime: ReturnType<typeof fakeRealtime>, body: Record<string, unknown>) =>
  app(userId, realtime).request('/api/chat-status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function list(realtime: ReturnType<typeof fakeRealtime>) {
  const res = await app(ANN, realtime).request('/api/chat-status');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown> & { userId: string }> };
  return new Map(body.data.map((row) => [row.userId, row]));
}

const storedStatus = async (userId: string) =>
  (await db.select().from(schema.chatUserStatus).where(eq(schema.chatUserStatus.userId, userId)))[0]?.status;

describe('/api/chat-status', () => {
  it('lets a member without settings:update set their own status', async () => {
    const rt = fakeRealtime({});
    const res = await put(ANN, rt, { status: 'dnd', statusText: 'Focus' });

    expect(res.status).toBe(200);
    expect(await storedStatus(ANN)).toBe('dnd');
    expect(rt.published).toEqual([
      expect.objectContaining({
        topic: 'presence',
        event: 'status_changed',
        data: expect.objectContaining({ userId: ANN, status: 'dnd', statusText: 'Focus' }),
      }),
    ]);
  });

  it('stores Away and Appear offline apart from the values old presence writers left', async () => {
    const rt = fakeRealtime({});
    await put(ANN, rt, { status: 'away' });
    expect(await storedStatus(ANN)).toBe('away_manual');
    await put(ANN, rt, { status: 'offline' });
    expect(await storedStatus(ANN)).toBe('invisible');
  });

  it('combines chosen status with live presence from the hub', async () => {
    const now = new Date();
    await db.insert(schema.chatUserStatus).values([
      // Left behind by the hub's old offline write: means automatic.
      { id: 'cus_ann', userId: ANN, status: 'offline', updatedAt: now },
      { id: 'cus_bob', userId: BOB, status: 'dnd', statusText: 'Heads down', updatedAt: now },
      { id: 'cus_carol', userId: CAROL, status: 'dnd', updatedAt: now },
    ]);
    const statuses = await list(fakeRealtime({ [ANN]: 'online', [BOB]: 'online', [DAVE]: 'away' }));

    expect(statuses.get(ANN)).toMatchObject({ status: 'online', manualStatus: 'online', live: 'online' });
    expect(statuses.get(BOB)).toMatchObject({ status: 'dnd', manualStatus: 'dnd', statusText: 'Heads down' });
    // Not connected: offline whatever they chose.
    expect(statuses.get(CAROL)).toMatchObject({ status: 'offline', manualStatus: 'dnd', live: null });
    // Connected without ever picking a status: listed from the hub alone.
    expect(statuses.get(DAVE)).toMatchObject({ status: 'away', manualStatus: 'online', live: 'away' });
  });

  it('drops a chosen status and its text once it expires', async () => {
    await db.insert(schema.chatUserStatus).values({
      id: 'cus_bob',
      userId: BOB,
      status: 'busy',
      statusText: 'Lunch',
      statusExpiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(),
    });
    const statuses = await list(fakeRealtime({ [BOB]: 'online' }));

    expect(statuses.get(BOB)).toMatchObject({ status: 'online', manualStatus: 'online', statusText: null });
  });

  it('shows everyone offline rather than failing when the hub cannot be reached', async () => {
    await db.insert(schema.chatUserStatus).values({ id: 'cus_bob', userId: BOB, status: 'busy', updatedAt: new Date() });
    const down = {
      binding: { fetch: async () => new Response('down', { status: 503 }) } as unknown as Fetcher,
      published: [],
    };
    const statuses = await list(down);

    expect(statuses.get(BOB)).toMatchObject({ status: 'offline', manualStatus: 'busy' });
  });
});
