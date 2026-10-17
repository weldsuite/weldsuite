/**
 * DB-backed tests for what makes a WeldChat call connect fast:
 * - a DM keeps one RealtimeKit room, so starting a call there skips createMeeting;
 * - the callee is rung before the caller's own token comes back;
 * - POST /:id/prepare mints the callee's token while it rings, and the join that
 *   answers reuses that participant instead of adding a second one.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { addParticipant, createMeeting, endMeeting, kickAllParticipants, removeParticipant } from '@weldsuite/cloudflare-realtime';
import { dmCallRoomKey } from '@weldsuite/chat-domain/dm-call-room';
import { publishChatCallIncoming } from '@weldsuite/chat-domain/realtime/weldchat-call-publisher';
import type { Env } from '../../types';
import { chatCallsRoutes } from './index';
import { preparedJoinKey } from '../../services/chat/prepared-join';

vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  createMeeting: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  kickAllParticipants: vi.fn(),
  endMeeting: vi.fn(),
  getLiveParticipantCount: vi.fn(async () => 0),
}));

vi.mock('@weldsuite/chat-domain/realtime/weldchat-call-publisher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/chat-domain/realtime/weldchat-call-publisher')>();
  return {
    ...actual,
    publishChatCallIncoming: vi.fn(async () => undefined),
    publishChatCallStarted: vi.fn(async () => undefined),
    publishChatCallEnded: vi.fn(async () => undefined),
    publishChatCallParticipantJoined: vi.fn(async () => undefined),
    broadcastChatCallToMembers: vi.fn(async () => undefined),
  };
});

vi.mock('@weldsuite/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/notifications')>()),
  sendMissedCallNotification: vi.fn(async () => undefined),
  sendIncomingCallNotification: vi.fn(async () => undefined),
}));

const ORG = 'org_fast';
const CAROL = 'user_fast_carol';
const DAVE = 'user_fast_dave';

let db: Database;
let store: Map<string, string>;

function fakeKv() {
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_fast_carol', userId: CAROL, email: 'carol@example.com', name: 'Carol', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_fast_dave', userId: DAVE, email: 'dave@example.com', name: 'Dave', role: 'MEMBER', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  store = new Map();
  vi.mocked(createMeeting).mockReset().mockResolvedValue({ id: 'rtk_created' } as never);
  vi.mocked(addParticipant).mockReset().mockResolvedValue({ id: 'cf_added', token: 'tok_added' } as never);
  vi.mocked(removeParticipant).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(kickAllParticipants).mockReset().mockResolvedValue(0);
  vi.mocked(endMeeting).mockReset().mockResolvedValue(undefined);
  vi.mocked(publishChatCallIncoming).mockClear();
});

async function seedChannel(type: 'dm' | 'public' = 'dm') {
  const channelId = generateId('ch');
  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: channelId,
    slug: channelId,
    type,
  } as typeof schema.chatChannels.$inferInsert);
  await db.insert(schema.chatChannelMembers).values(
    [CAROL, DAVE].map((userId) => ({ id: generateId('chm'), channelId, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
  );
  return channelId;
}

const post = (userId: string, path: string, body?: unknown) =>
  createTestApp('/api/chat-calls', chatCallsRoutes, {
    context: {
      userId,
      orgId: ORG,
      permissions: permissions('channels:read', 'channels:create', 'channels:update'),
      tenantDb: db,
    },
    env: { WORKSPACE_CACHE: fakeKv() } as unknown as Env,
  }).request(`/api/chat-calls${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

async function loadCall(callId: string) {
  const [row] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, callId)).limit(1);
  if (!row) throw new Error('call missing');
  return row;
}

async function startCall(userId: string, channelId: string) {
  const res = await post(userId, '/start-and-join', { channelId, callType: 'voice' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { callId: string; authToken: string } }).data;
}

describe('POST /start-and-join · the persistent DM room', () => {
  it("creates the DM's room on its first call and remembers it", async () => {
    const channelId = await seedChannel();

    const { callId } = await startCall(CAROL, channelId);

    expect(createMeeting).toHaveBeenCalledTimes(1);
    expect((await loadCall(callId)).cfAppId).toBe('rtk_created');
    await vi.waitFor(() => expect(store.get(dmCallRoomKey(ORG, channelId))).toBe('rtk_created'));
  });

  it('starts the next call in the same room without creating a meeting', async () => {
    const channelId = await seedChannel();
    store.set(dmCallRoomKey(ORG, channelId), 'rtk_dm_room');

    const { callId, authToken } = await startCall(CAROL, channelId);

    expect(createMeeting).not.toHaveBeenCalled();
    expect(addParticipant).toHaveBeenCalledWith(expect.anything(), 'rtk_dm_room', expect.objectContaining({ customParticipantId: CAROL }));
    expect(authToken).toBe('tok_added');
    expect((await loadCall(callId)).cfAppId).toBe('rtk_dm_room');
  });

  it('moves the call into a new room when the stored one is unusable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const channelId = await seedChannel();
    store.set(dmCallRoomKey(ORG, channelId), 'rtk_dead');
    vi.mocked(addParticipant)
      .mockRejectedValueOnce(new Error('Failed to add RTK participant: 404'))
      .mockResolvedValueOnce({ id: 'cf_added', token: 'tok_added' } as never);

    const { callId } = await startCall(CAROL, channelId);

    expect(createMeeting).toHaveBeenCalledTimes(1);
    expect((await loadCall(callId)).cfAppId).toBe('rtk_created');
    expect(store.get(dmCallRoomKey(ORG, channelId))).toBe('rtk_created');
    expect(JSON.parse(store.get('rtk-meeting:rtk_created') ?? '{}')).toMatchObject({ callId });
  });

  it('gives a channel call its own room every time', async () => {
    const channelId = await seedChannel('public');

    await startCall(CAROL, channelId);

    expect(createMeeting).toHaveBeenCalledTimes(1);
    expect(store.has(dmCallRoomKey(ORG, channelId))).toBe(false);
  });

  it("rings the callee before the caller's own token is back", async () => {
    const channelId = await seedChannel();
    store.set(dmCallRoomKey(ORG, channelId), 'rtk_dm_room');
    let releaseCaller!: () => void;
    vi.mocked(addParticipant).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCaller = () => resolve({ id: 'cf_added', token: 'tok_added' } as never);
        }),
    );

    const pending = post(CAROL, '/start-and-join', { channelId, callType: 'voice' });

    await vi.waitFor(() =>
      expect(publishChatCallIncoming).toHaveBeenCalledWith(expect.anything(), ORG, DAVE, expect.objectContaining({ channelId })),
    );
    releaseCaller();
    expect((await pending).status).toBe(201);
  });

  it("an ended call only empties the DM's room: it stays active for the next call", async () => {
    const channelId = await seedChannel();
    store.set(dmCallRoomKey(ORG, channelId), 'rtk_room_kept');
    const { callId } = await startCall(CAROL, channelId);

    const res = await post(CAROL, `/${callId}/end`);

    expect(res.status).toBe(200);
    expect(kickAllParticipants).toHaveBeenCalledWith(expect.anything(), 'rtk_room_kept');
    // (Carol's calls from the tests above are left and ended in their own rooms.)
    expect(endMeeting).not.toHaveBeenCalledWith(expect.anything(), 'rtk_room_kept');
    expect(store.get('rtk-meeting:rtk_room_kept')).toBeDefined();
    expect(store.get(dmCallRoomKey(ORG, channelId))).toBe('rtk_room_kept');
  });
});

describe('POST /:callId/prepare · the token is ready before the callee answers', () => {
  it('mints the token while it rings and records nothing on the call', async () => {
    const channelId = await seedChannel();
    store.set(dmCallRoomKey(ORG, channelId), 'rtk_dm_room');
    const { callId } = await startCall(CAROL, channelId);
    vi.mocked(addParticipant).mockResolvedValueOnce({ id: 'cf_dave', token: 'tok_dave' } as never);

    const res = await post(DAVE, `/${callId}/prepare`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { authToken: string; channelId: string; callType: string } };
    expect(body.data).toMatchObject({ authToken: 'tok_dave', channelId, callType: 'voice' });
    const call = await loadCall(callId);
    expect(call.participants?.some((p) => p.userId === DAVE)).toBe(false);
  });

  it('a second prepare (another tab, a repeated ring) gets the same participant', async () => {
    const channelId = await seedChannel();
    const { callId } = await startCall(CAROL, channelId);
    vi.mocked(addParticipant).mockClear().mockResolvedValueOnce({ id: 'cf_dave', token: 'tok_dave' } as never);

    await post(DAVE, `/${callId}/prepare`);
    const again = await post(DAVE, `/${callId}/prepare`);

    expect(((await again.json()) as { data: { authToken: string } }).data.authToken).toBe('tok_dave');
    expect(addParticipant).toHaveBeenCalledTimes(1);
  });

  it('the join that answers reuses the prepared participant instead of adding another', async () => {
    const channelId = await seedChannel();
    const { callId } = await startCall(CAROL, channelId);
    vi.mocked(addParticipant).mockClear().mockResolvedValueOnce({ id: 'cf_dave', token: 'tok_dave' } as never);
    await post(DAVE, `/${callId}/prepare`);

    const res = await post(DAVE, `/${callId}/join`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { authToken: string } }).data.authToken).toBe('tok_dave');
    expect(addParticipant).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const dave = (await loadCall(callId)).participants?.find((p) => p.userId === DAVE);
      expect(dave?.cfSessionId).toBe('cf_dave');
    });
    await vi.waitFor(() => expect(store.has(preparedJoinKey(callId, DAVE))).toBe(false));
  });

  it('refuses a call in a channel the user cannot access', async () => {
    const channelId = await seedChannel();
    const { callId } = await startCall(CAROL, channelId);

    const res = await post('user_fast_outsider', `/${callId}/prepare`);

    expect(res.status).toBe(403);
  });

  it('refuses a call that is no longer joinable', async () => {
    const channelId = await seedChannel();
    const { callId } = await startCall(CAROL, channelId);
    await db.update(schema.chatCalls).set({ status: 'ended' }).where(eq(schema.chatCalls.id, callId));

    const res = await post(DAVE, `/${callId}/prepare`);

    expect(res.status).toBe(400);
  });
});
