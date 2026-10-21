/**
 * POST /public/chat-calls/decline — the phone's lock-screen / CallKit Decline
 * with the ring's signed token, no session.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { signCallRingToken } from '@weldsuite/chat-domain/call-ring-token';
import { cancelIncomingCallPush, sendMissedCallNotification } from '@weldsuite/notifications';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Env } from '../../types';
import { publicChatCallsRoutes } from './public-decline';

let db: Database;

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: vi.fn(async () => db),
}));

vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  kickAllParticipants: vi.fn(async () => 0),
  endMeeting: vi.fn(async () => undefined),
}));

vi.mock('@weldsuite/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/notifications')>()),
  sendMissedCallNotification: vi.fn(async () => undefined),
  cancelIncomingCallPush: vi.fn(async () => undefined),
}));

const SECRET = 'ring-secret-for-tests';
const ORG = 'org_ring';
const ALICE = 'user_ring_alice';
const BOB = 'user_ring_bob';
const MALLORY = 'user_ring_mallory';

const env = (secret: string | undefined = SECRET) =>
  ({
    CALL_RING_SECRET: secret,
    WORKSPACE_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
  }) as unknown as Env;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_ring_alice', userId: ALICE, email: 'alice@example.com', name: 'Alice', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_ring_bob', userId: BOB, email: 'bob@example.com', name: 'Bob', role: 'MEMBER', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  vi.mocked(cancelIncomingCallPush).mockClear();
  vi.mocked(sendMissedCallNotification).mockClear();
});

/** A DM between Alice and Bob in which Alice is calling Bob. */
async function seedRingingCall(participants: ChatCallParticipant[] = []) {
  const channelId = generateId('ch');
  const callId = generateId('call');
  const now = new Date();
  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: channelId,
    slug: channelId,
    type: 'dm',
  } as typeof schema.chatChannels.$inferInsert);
  await db.insert(schema.chatChannelMembers).values(
    [ALICE, BOB].map((userId) => ({ id: generateId('chm'), channelId, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
  );
  await db.insert(schema.chatCalls).values({
    id: callId,
    channelId,
    callType: 'voice',
    status: 'active',
    cfAppId: `rtk_${callId}`,
    initiatorId: ALICE,
    initiatorName: 'Alice',
    participants,
    maxParticipants: participants.length,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return callId;
}

const decline = (token: string, e: Env = env()) =>
  publicChatCallsRoutes.request(
    '/decline',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) },
    e,
  );

async function statusOf(callId: string) {
  const [row] = await db.select({ status: schema.chatCalls.status }).from(schema.chatCalls).where(eq(schema.chatCalls.id, callId));
  return row?.status;
}

const callerInRoom: ChatCallParticipant = {
  userId: ALICE,
  userName: 'Alice',
  joinedAt: new Date().toISOString(),
  cfSessionId: 'cf_alice',
  hasAudio: false,
  hasVideo: false,
  hasScreenShare: false,
};

describe('POST /public/chat-calls/decline', () => {
  it('declines the ring and stops it on the callee phones', async () => {
    const callId = await seedRingingCall([callerInRoom]);
    const token = await signCallRingToken(SECRET, { orgId: ORG, userId: BOB, callId });

    const res = await decline(token);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { declined: boolean } }).data.declined).toBe(true);
    expect(await statusOf(callId)).toBe('declined');
    expect(cancelIncomingCallPush).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BOB, callId, reason: 'declined' }),
    );
    expect(sendMissedCallNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: BOB }));
  });

  it('is a no-op success once the call stopped ringing', async () => {
    const bobJoined = { ...callerInRoom, userId: BOB, userName: 'Bob', cfSessionId: 'cf_bob' };
    const callId = await seedRingingCall([callerInRoom, bobJoined]);
    const token = await signCallRingToken(SECRET, { orgId: ORG, userId: BOB, callId });

    const res = await decline(token);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { declined: boolean } }).data.declined).toBe(false);
    expect(await statusOf(callId)).toBe('active');
  });

  it('rejects a token signed with another secret', async () => {
    const callId = await seedRingingCall([callerInRoom]);
    const token = await signCallRingToken('not-the-secret', { orgId: ORG, userId: BOB, callId });

    expect((await decline(token)).status).toBe(401);
    expect(await statusOf(callId)).toBe('active');
  });

  it('rejects an expired token', async () => {
    const callId = await seedRingingCall([callerInRoom]);
    const token = await signCallRingToken(SECRET, { orgId: ORG, userId: BOB, callId }, Date.now() - 10 * 60_000);

    expect((await decline(token)).status).toBe(401);
  });

  it('rejects everything when CALL_RING_SECRET is unset', async () => {
    const callId = await seedRingingCall([callerInRoom]);
    const token = await signCallRingToken(SECRET, { orgId: ORG, userId: BOB, callId });

    expect((await decline(token, env(''))).status).toBe(401);
    expect(await statusOf(callId)).toBe('active');
  });

  it('refuses a recipient who is not in the channel', async () => {
    const callId = await seedRingingCall([callerInRoom]);
    const token = await signCallRingToken(SECRET, { orgId: ORG, userId: MALLORY, callId });

    expect((await decline(token)).status).toBe(403);
    expect(await statusOf(callId)).toBe('active');
  });
});
