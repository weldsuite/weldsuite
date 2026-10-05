/**
 * RealtimeKit webhooks for a WeldChat call, against a real (pglite) call row:
 * meeting.ended only ends a call RealtimeKit confirms is empty, and
 * meeting.participantLeft ignores the connection someone had before rejoining.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import { fakeKv } from '../test/fakes';

const state = vi.hoisted(() => ({ db: null as unknown as Database }));

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getTenantDbForWorkspace: async () => state.db };
});
vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => undefined), publishEntityEvent: vi.fn() };
});
vi.mock('@weldsuite/cloudflare-realtime', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/cloudflare-realtime')>(
    '@weldsuite/cloudflare-realtime',
  );
  return {
    ...actual,
    kickAllParticipants: vi.fn(async () => 0),
    endMeeting: vi.fn(async () => undefined),
    getLiveParticipantCount: vi.fn(async () => 0),
  };
});
vi.mock('@weldsuite/notifications', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/notifications')>('@weldsuite/notifications');
  return { ...actual, sendMissedCallNotification: vi.fn(async () => undefined) };
});

import { getLiveParticipantCount, kickAllParticipants } from '@weldsuite/cloudflare-realtime';
import { handleMeetingEnded, handleParticipantLeft, type RtkMeetingMapping } from './rtk-webhook';
import type { Env } from '../types';

const ORG = 'org_calls';
const ALICE = 'user_alice';
const BOB = 'user_bob';

const env = { WORKSPACE_CACHE: fakeKv() } as unknown as Env;

function participant(userId: string, extra: Partial<ChatCallParticipant> = {}): ChatCallParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: '2026-10-02T10:00:00.000Z',
    cfSessionId: `cf_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  };
}

async function seed(key: string, participants: ChatCallParticipant[]) {
  const channelId = `ch_calls_${key}`;
  const callId = `call_calls_${key}`;
  const cfAppId = `rtk_${key}`;
  await state.db.insert(schema.chatChannels).values({
    id: channelId,
    name: channelId,
    slug: channelId,
    type: 'dm',
  } as typeof schema.chatChannels.$inferInsert);
  await state.db.insert(schema.chatCalls).values({
    id: callId,
    channelId,
    callType: 'voice',
    status: 'active',
    cfAppId,
    initiatorId: ALICE,
    initiatorName: 'Alice',
    participants,
    maxParticipants: participants.length,
    startedAt: new Date(Date.now() - 20 * 60_000),
  });
  const mapping: RtkMeetingMapping = { orgId: ORG, type: 'call', callId, channelId };
  return { callId, cfAppId, mapping };
}

async function readCall(callId: string) {
  const [row] = await state.db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, callId));
  return row!;
}

beforeAll(async () => {
  state.db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  vi.mocked(kickAllParticipants).mockClear();
  vi.mocked(getLiveParticipantCount).mockReset().mockResolvedValue(0);
});

describe('meeting.ended for a call', () => {
  it('ends the call when RealtimeKit confirms the room is empty', async () => {
    const { callId, cfAppId, mapping } = await seed('ended_empty', [participant(ALICE), participant(BOB)]);

    await handleMeetingEnded(env, mapping, cfAppId);

    expect((await readCall(callId)).status).toBe('ended');
    expect(kickAllParticipants).toHaveBeenCalledWith(expect.anything(), cfAppId);
  });

  it('ignores a late or replayed meeting.ended while people are in the room', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { callId, cfAppId, mapping } = await seed('ended_occupied', [participant(ALICE), participant(BOB)]);

    await handleMeetingEnded(env, mapping, cfAppId);

    const call = await readCall(callId);
    expect(call.status).toBe('active');
    expect(call.endedAt).toBeNull();
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });

  it('still ends the call when RealtimeKit cannot be asked: it reported the end itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getLiveParticipantCount).mockRejectedValue(new Error('RTK 503'));
    const { callId, cfAppId, mapping } = await seed('ended_unknown', [participant(ALICE), participant(BOB)]);

    await handleMeetingEnded(env, mapping, cfAppId);

    expect((await readCall(callId)).status).toBe('ended');
  });
});

describe('meeting.participantLeft for a call', () => {
  const leftEvent = (customParticipantId: string, joinedAt: string) => ({
    event: 'meeting.participantLeft',
    participant: { customParticipantId, peerId: 'peer_1', joinedAt, leftAt: new Date().toISOString() },
  });

  it('marks the participant as left when their current connection goes', async () => {
    const { callId, mapping } = await seed('left_current', [participant(ALICE), participant(BOB)]);

    await handleParticipantLeft(env, mapping, leftEvent(BOB, '2026-10-02T10:00:05.000Z'));

    const call = await readCall(callId);
    expect(call.participants?.find((p) => p.userId === BOB)?.leftAt).toBeTruthy();
    expect(call.participants?.find((p) => p.userId === ALICE)?.leftAt).toBeUndefined();
    expect(call.status).toBe('active');
  });

  it('keeps a participant present when the connection that left predates their rejoin', async () => {
    // Bob rejoined at 10:20; the leave is for the connection he had since 10:00.
    const { callId, mapping } = await seed('left_stale', [
      participant(ALICE),
      participant(BOB, { joinedAt: '2026-10-02T10:20:00.000Z' }),
    ]);

    await handleParticipantLeft(env, mapping, leftEvent(BOB, '2026-10-02T10:00:05.000Z'));

    expect((await readCall(callId)).participants?.find((p) => p.userId === BOB)?.leftAt).toBeUndefined();
  });
});
