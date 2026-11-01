/**
 * POST /api/meetings/start-instant: create, start and join in one round trip,
 * with RealtimeKit's REST API answered at the HTTP level (../../test/fakes.ts),
 * so both backends make (and are compared on) the same calls.
 *
 * A user is in at most ONE live call at a time: starting an instant meeting
 * joins it, so the server drops the user from every other session they are
 * still in (a leave, never an end for everyone), after the response and
 * without touching the meeting just started. The WeldChat side of the rule is
 * ./start-instant.chat-calls.integration.test.ts (TypeScript only).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { meetingsRoutes } from './index';
import { RTK_ENV, RTK_PRESETS_SEEDED, fakeKv, fakeRealtime, fakeRtkApi } from '../../test/fakes';

const USER = 'user_instant_one_call';
const rtk = fakeRtkApi();

let db: Database;

beforeAll(async () => {
  vi.stubGlobal('fetch', rtk.fetch);
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_instant',
    userId: USER,
    email: 'instant@example.com',
    name: 'Ina Stant',
    picture: 'https://cdn.example.com/ina.png',
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  rtk.reset();
  rtk.state.meetingId = 'rtk_instant_new';
  rtk.state.participant = { id: 'cf_instant_new', token: 'tok_instant' };
  rtk.state.defaultLive = 1;
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

function app(realtime = fakeRealtime(), perms = ['meetings:create']) {
  const test = createTestApp('/api/meetings', meetingsRoutes, {
    context: { permissions: permissions(...perms), userId: USER, tenantDb: db },
    env: { ...RTK_ENV, WORKSPACE_CACHE: fakeKv(RTK_PRESETS_SEEDED), REALTIME: realtime.binding },
  });
  const pending: Promise<unknown>[] = [];
  // Keep the harness's own waitUntil: in conformance mode it waits for this
  // work before comparing the side effects.
  const harnessWaitUntil = test.executionCtx.waitUntil.bind(test.executionCtx);
  test.executionCtx.waitUntil = (promise: Promise<unknown>) => {
    pending.push(Promise.resolve(promise).catch(() => undefined));
    harnessWaitUntil(promise);
  };
  return { ...test, flush: () => Promise.all(pending) };
}

const start = (request: ReturnType<typeof app>['request'], body: unknown) =>
  request('/api/meetings/start-instant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/meetings/start-instant', () => {
  it('creates the meeting and its live session, joins the host and answers the room', async () => {
    const { request, flush } = app();
    const res = await start(request, { title: 'Stand-up', meetingType: 'audio', waitingRoom: false });
    await flush();

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { meetingId: string; sessionId: string; rtkMeetingId: string; authToken: string; joinCode: string };
    };
    expect(data).toMatchObject({ rtkMeetingId: 'rtk_instant_new', authToken: 'tok_instant' });
    expect(data.joinCode).toMatch(/^wm-[a-z]{3}-[a-z]{3}-[a-z]{3}$/);

    const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, data.meetingId));
    expect(meeting).toMatchObject({
      title: 'Stand-up',
      meetingType: 'audio',
      status: 'in_progress',
      accessType: 'anyone_with_link',
      waitingRoom: false,
      activeSessionId: data.sessionId,
      organizerId: USER,
    });
    const [session] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, data.sessionId));
    expect(session).toMatchObject({ status: 'active', cfAppId: 'rtk_instant_new', sessionType: 'audio' });
    expect(session?.participants?.[0]).toMatchObject({ userId: USER, cfSessionId: 'cf_instant_new', userName: 'Ina Stant' });

    // The room is created with the audio export and the host joins with the host preset.
    expect(rtk.calls('create').map((c) => c.body)).toEqual([
      { title: 'Stand-up', recording_config: { audio_config: { export_file: true, codec: 'MP3' } } },
    ]);
    expect(rtk.calls('add').map((c) => c.body)).toEqual([
      {
        name: 'Ina Stant',
        preset_name: 'group_call_host_v3',
        custom_participant_id: USER,
        picture: 'https://cdn.example.com/ina.png',
      },
    ]);
  });

  it('defaults the title and validates the body', async () => {
    const { request, flush } = app();
    const res = await start(request, {});
    await flush();
    expect(res.status).toBe(201);
    expect(rtk.calls('create')[0]?.body).toMatchObject({ title: 'Instant Meeting' });

    expect((await start(request, { meetingType: 'hologram' })).status).toBe(400);
    expect((await start(request, { title: 'x'.repeat(256) })).status).toBe(400);
    expect((await start(app(fakeRealtime(), ['meetings:read']).request, {})).status).toBe(403);
  });

  it('answers 500 when RealtimeKit refuses the room', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rtk.state.failures.set('create', 422);
    const { request, flush } = app();
    const res = await start(request, { title: 'Refused' });
    await flush();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to start instant meeting' } });
  });

  it('leaves every other meeting session after starting, never the new meeting', async () => {
    // A room of its own: the meetings started above are still live.
    rtk.state.meetingId = 'rtk_instant_fresh';
    const realtime = fakeRealtime();
    const other = await seedSession('rtk_instant_other', [entry('user_someone_else', 'cf_else'), entry(USER, 'cf_user_other')]);
    const { request, flush } = app(realtime);

    const res = await start(request, {});
    await flush();

    expect(res.status).toBe(201);
    const { sessionId } = ((await res.json()) as { data: { sessionId: string } }).data;

    const removed = rtk.removed();
    expect(removed).toContainEqual(['rtk_instant_other', 'cf_user_other']);
    expect(removed.map(([room]) => room)).not.toContain('rtk_instant_fresh');

    const [otherSession] = await db
      .select()
      .from(schema.meetingSessions)
      .where(eq(schema.meetingSessions.id, other.sessionId));
    expect(otherSession?.participants?.find((p) => p.userId === USER)?.leftAt).toBeTruthy();
    expect(otherSession?.participants?.find((p) => p.userId === 'user_someone_else')?.leftAt).toBeUndefined();
    expect(otherSession?.status).toBe('active');
    // Left, never ended for everybody.
    expect(rtk.seen('kick-all')).toBe(false);

    const [started] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(started?.participants?.find((p) => p.userId === USER)?.leftAt).toBeUndefined();

    const announced = realtime.published.filter((e) => e.event === 'call_superseded');
    expect(announced.map((e) => e.topic)).toContain(`chat.user.${USER}`);
    expect(announced.map((e) => e.data.id)).toContain(other.sessionId);
  });
});
