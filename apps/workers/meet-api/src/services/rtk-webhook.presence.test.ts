/**
 * Presence and end-of-meeting webhooks against a real (pglite) session row:
 * meeting.participantJoined / meeting.participantLeft track connections, and
 * meeting.ended only ends a session RealtimeKit confirms is empty.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { fakeKv, seedMeetingWithSession } from '../test/fakes';

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

import { getLiveParticipantCount, kickAllParticipants } from '@weldsuite/cloudflare-realtime';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import {
  handleMeetingEnded,
  handleParticipantJoined,
  handleParticipantLeft,
  type RtkMeetingMapping,
} from './rtk-webhook';
import type { Env } from '../types';

const ORG = 'org_presence';
const HOST = 'user_host';
const MEMBER = 'user_member';
const mockedRaw = publishEntityEventRaw as unknown as ReturnType<typeof vi.fn>;

const env = { WORKSPACE_CACHE: fakeKv() } as unknown as Env;

function participant(userId: string, extra: Partial<MeetingSessionParticipant> = {}): MeetingSessionParticipant {
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

async function seed(key: string, participants: MeetingSessionParticipant[]) {
  const meetingId = `meet_presence_${key}`;
  const sessionId = `msess_presence_${key}`;
  await seedMeetingWithSession(state.db, {
    meetingId,
    sessionId,
    organizerId: HOST,
    meeting: { status: 'in_progress', activeSessionId: sessionId },
    session: {
      status: 'active',
      duration: null,
      cfAppId: `rtk_${key}`,
      participants,
      startedAt: new Date(Date.now() - 20 * 60_000),
    },
  });
  const mapping: RtkMeetingMapping = { orgId: ORG, type: 'session', sessionId, meetingId };
  return { meetingId, sessionId, mapping };
}

async function readSession(sessionId: string) {
  const [row] = await state.db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
  return row!;
}

const joined = (customParticipantId: string, peerId: string) => ({
  event: 'meeting.participantJoined',
  participant: { customParticipantId, peerId, joinedAt: new Date().toISOString() },
});

const left = (customParticipantId: string, peerId: string, joinedAt = '2026-10-02T10:00:05.000Z') => ({
  event: 'meeting.participantLeft',
  participant: { customParticipantId, peerId, joinedAt, leftAt: new Date().toISOString() },
});

beforeAll(async () => {
  state.db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  mockedRaw.mockClear();
  vi.mocked(kickAllParticipants).mockClear();
  vi.mocked(getLiveParticipantCount).mockReset().mockResolvedValue(0);
});

describe('participant presence webhooks', () => {
  it('keeps a member present through a reconnect: new connection in, old connection out', async () => {
    const { sessionId, mapping } = await seed('reconnect', [participant(HOST), participant(MEMBER)]);

    await handleParticipantJoined(env, mapping, joined(MEMBER, 'peer_1'));
    await handleParticipantJoined(env, mapping, joined(MEMBER, 'peer_2'));
    await handleParticipantLeft(env, mapping, left(MEMBER, 'peer_1'));

    const member = (await readSession(sessionId)).participants?.find((p) => p.userId === MEMBER);
    expect(member?.leftAt).toBeUndefined();
    expect(member?.peerIds).toEqual(['peer_2']);
    expect(mockedRaw).not.toHaveBeenCalled();
  });

  it('marks the member as left when their last connection goes, and brings them back when they reconnect', async () => {
    const { sessionId, mapping } = await seed('lastpeer', [participant(HOST), participant(MEMBER)]);
    await handleParticipantJoined(env, mapping, joined(MEMBER, 'peer_1'));

    await handleParticipantLeft(env, mapping, left(MEMBER, 'peer_1'));
    let member = (await readSession(sessionId)).participants?.find((p) => p.userId === MEMBER);
    expect(member?.leftAt).toBeTruthy();
    expect(member?.peerIds).toBeUndefined();
    expect(mockedRaw).toHaveBeenCalledTimes(1);

    await handleParticipantJoined(env, mapping, joined(MEMBER, 'peer_2'));
    member = (await readSession(sessionId)).participants?.find((p) => p.userId === MEMBER);
    expect(member?.leftAt).toBeUndefined();
    expect(member?.peerIds).toEqual(['peer_2']);
    expect(mockedRaw).toHaveBeenCalledTimes(2);
    // Nobody else was touched.
    expect((await readSession(sessionId)).participants?.find((p) => p.userId === HOST)?.leftAt).toBeUndefined();
  });

  it('does not evict a member who rejoined when the leave of their old connection arrives late', async () => {
    // Rejoined through our join route at 10:20; the old connection (joined 10:00)
    // is reported as gone a minute later.
    const { sessionId, mapping } = await seed('laterejoin', [
      participant(HOST),
      participant(MEMBER, { lastJoinAt: '2026-10-02T10:20:00.000Z' }),
    ]);

    await handleParticipantLeft(env, mapping, left(MEMBER, 'peer_old', '2026-10-02T10:00:05.000Z'));

    const member = (await readSession(sessionId)).participants?.find((p) => p.userId === MEMBER);
    expect(member?.leftAt).toBeUndefined();
    expect(mockedRaw).not.toHaveBeenCalled();
  });

  it('ignores events once the session has ended', async () => {
    const { sessionId, mapping } = await seed('ended', [participant(MEMBER, { leftAt: '2026-10-02T10:30:00.000Z' })]);
    await state.db
      .update(schema.meetingSessions)
      .set({ status: 'ended' })
      .where(eq(schema.meetingSessions.id, sessionId));

    await handleParticipantJoined(env, mapping, joined(MEMBER, 'peer_9'));

    const member = (await readSession(sessionId)).participants?.find((p) => p.userId === MEMBER);
    expect(member?.leftAt).toBe('2026-10-02T10:30:00.000Z');
    expect(member?.peerIds).toBeUndefined();
  });
});

describe('meeting.ended', () => {
  it('ends the session when RealtimeKit confirms the room is empty', async () => {
    const { sessionId, mapping } = await seed('empty', [participant(HOST)]);

    await handleMeetingEnded(env, mapping, 'rtk_empty');

    expect(getLiveParticipantCount).toHaveBeenCalledWith(expect.anything(), 'rtk_empty');
    const session = await readSession(sessionId);
    expect(session.status).toBe('ended');
    expect(session.participants?.every((p) => !!p.leftAt)).toBe(true);
  });

  it('ignores a late event while people are back in the room, and kicks nobody', async () => {
    const { sessionId, mapping } = await seed('late', [participant(HOST)]);
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);

    await handleMeetingEnded(env, mapping, 'rtk_late');

    expect((await readSession(sessionId)).status).toBe('active');
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });

  it('still ends the session when RealtimeKit cannot be asked: it reported the end itself', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sessionId, mapping } = await seed('unknown', [participant(HOST)]);
    vi.mocked(getLiveParticipantCount).mockRejectedValue(new Error('Failed to get RTK active session: 500'));

    await handleMeetingEnded(env, mapping, 'rtk_unknown');

    expect((await readSession(sessionId)).status).toBe('ended');
    errorSpy.mockRestore();
  });
});
