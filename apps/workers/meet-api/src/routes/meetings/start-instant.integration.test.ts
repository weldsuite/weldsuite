/**
 * POST /api/meetings/start-instant: a user is in at most ONE live call at a
 * time, across WeldMeet sessions and WeldChat calls. Starting an instant
 * meeting joins it, so the server drops the user from every other session and
 * chat call they are still in (a leave, never an end for everyone), after the
 * response and without ever touching the meeting that was just started.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import {
  addParticipant,
  createMeeting,
  getLiveParticipantCount,
  kickAllParticipants,
  removeParticipant,
} from '@weldsuite/cloudflare-realtime';
import { meetingsRoutes } from './index';
import { fakeKv, fakeRealtime, seedActiveChatCall } from '../../test/fakes';

vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  ensurePresets: vi.fn(async () => undefined),
  createMeeting: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  kickAllParticipants: vi.fn(),
  getLiveParticipantCount: vi.fn(),
}));

const USER = 'user_instant_one_call';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  vi.mocked(createMeeting).mockReset().mockResolvedValue({ id: 'rtk_instant_new' } as never);
  vi.mocked(addParticipant).mockReset().mockResolvedValue({ id: 'cf_instant_new', token: 'tok_instant' } as never);
  vi.mocked(removeParticipant).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(kickAllParticipants).mockReset().mockResolvedValue(0);
  vi.mocked(getLiveParticipantCount).mockReset().mockResolvedValue(1);
});

function entry(userId: string, cfSessionId: string): MeetingSessionParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: new Date(Date.now() - 60_000).toISOString(),
    cfSessionId,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
  };
}

async function seedSession(cfAppId: string, participants: MeetingSessionParticipant[]) {
  const meetingId = generateId('mtg');
  const sessionId = generateId('msess');
  await db.insert(schema.meetings).values({
    id: meetingId,
    title: 'Elsewhere',
    organizerId: 'user_someone_else',
    status: 'in_progress',
    activeSessionId: null,
  });
  await db.insert(schema.meetingSessions).values({
    id: sessionId,
    meetingId,
    status: 'active',
    cfAppId,
    startedBy: 'user_someone_else',
    startedByName: 'Someone',
    participants,
    startedAt: new Date(Date.now() - 5 * 60_000),
  });
  return { meetingId, sessionId };
}

describe('POST /api/meetings/start-instant · one live call at a time', () => {
  it('leaves every other meeting session and chat call after starting, never the new meeting', async () => {
    const realtime = fakeRealtime();
    const other = await seedSession('rtk_instant_other', [entry('user_someone_else', 'cf_else'), entry(USER, 'cf_user_other')]);
    const chat = await seedActiveChatCall(db, {
      userId: USER,
      otherUserId: 'user_someone_else',
      cfAppId: 'rtk_instant_chat',
      cfSessionId: 'cf_user_chat',
    });

    const app = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: USER, tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv(), REALTIME: realtime.binding },
    });
    const pending: Promise<unknown>[] = [];
    app.executionCtx.waitUntil = (promise: Promise<unknown>) => {
      pending.push(Promise.resolve(promise).catch(() => undefined));
    };

    const res = await app.request('/api/meetings/start-instant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await Promise.all(pending);

    expect(res.status).toBe(201);
    const { sessionId } = ((await res.json()) as { data: { sessionId: string } }).data;

    const removed = vi.mocked(removeParticipant).mock.calls.map((c) => [c[1], c[2]]);
    expect(removed).toContainEqual(['rtk_instant_other', 'cf_user_other']);
    expect(removed).toContainEqual(['rtk_instant_chat', 'cf_user_chat']);
    expect(removed.map(([room]) => room)).not.toContain('rtk_instant_new');

    const [otherSession] = await db
      .select()
      .from(schema.meetingSessions)
      .where(eq(schema.meetingSessions.id, other.sessionId));
    expect(otherSession?.participants?.find((p) => p.userId === USER)?.leftAt).toBeTruthy();
    expect(otherSession?.participants?.find((p) => p.userId === 'user_someone_else')?.leftAt).toBeUndefined();
    expect(otherSession?.status).toBe('active');
    const [call] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, chat.callId));
    expect(call?.participants?.find((p) => p.userId === USER)?.leftAt).toBeTruthy();
    expect(call?.status).toBe('active');
    // Left, never ended for everybody.
    expect(vi.mocked(kickAllParticipants)).not.toHaveBeenCalled();

    const [started] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(started?.participants?.find((p) => p.userId === USER)?.leftAt).toBeUndefined();

    const announced = realtime.published.filter((e) => e.event === 'call_superseded');
    expect(announced.map((e) => e.topic)).toEqual([`chat.user.${USER}`, `chat.user.${USER}`]);
    expect(announced.map((e) => e.data.id).sort()).toEqual([chat.callId, other.sessionId].sort());
  });
});
