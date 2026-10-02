/**
 * Session recording routes against a real schema (pglite): delete, tokenized
 * access + public streaming, AI options (wallet gate + RealtimeKit update),
 * transcribe / summarize dispatch, and the server-owned-columns rule on PATCH.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { RecordingPart } from '@weldsuite/db/schema/meeting-sessions';
import { fakeBucket, fakeKv, fakeWorkflow, seedMeetingWithSession } from '../../test/fakes';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(), publishEntityEventRaw: vi.fn() };
});

const billing = vi.hoisted(() => ({
  getMeetingAiPricing: vi.fn(),
  resolveMeetingMetering: vi.fn(),
  assertMeetingAiCredits: vi.fn(),
  getMeetingBalance: vi.fn(),
}));
vi.mock('@weldsuite/meet-domain/billing', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/meet-domain/billing')>('@weldsuite/meet-domain/billing');
  return { ...actual, ...billing };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
import { InsufficientMeetingCreditsError, MeetingBillingUnavailableError } from '@weldsuite/meet-domain/billing';
import { meetingSessionsRoutes } from './index';
import { meetingsRoutes } from '../meetings';
import { publicMeetingRecordingsRoutes } from '../public-meeting-recordings';
import type { Env, Variables } from '../../types';

const mockedPublish = publishEntityEvent as unknown as ReturnType<typeof vi.fn>;
const ORG = 'org_test_default';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  mockedPublish.mockClear();
  billing.getMeetingAiPricing.mockReset().mockResolvedValue({ transcriptionCreditsPerMinute: 2, summaryCreditsPerMinute: 1 });
  billing.resolveMeetingMetering.mockReset().mockResolvedValue({ masterDb: {}, internalWsId: 'ws_int', userId: 'user_test_default' });
  billing.assertMeetingAiCredits.mockReset().mockResolvedValue(undefined);
  billing.getMeetingBalance.mockReset().mockResolvedValue(250);
});

function app(perms: string[], env: Partial<Env> = {}, context: { userId?: string } = {}) {
  return createTestApp<Env, Variables>('/api/meeting-sessions', meetingSessionsRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db, ...context },
    env: { WORKSPACE_CACHE: fakeKv(), ...env } as Partial<Env>,
  });
}

const json = { 'Content-Type': 'application/json' };

async function session(sessionId: string) {
  const [row] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
  return row!;
}

function readyPart(sessionId: string, id: string, startedAt: string): RecordingPart {
  return {
    rtkRecordingId: id,
    videoKey: `${ORG}/${sessionId}/${id}.mp4`,
    audioKey: `${ORG}/${sessionId}/${id}.mp3`,
    sizeBytes: 11,
    durationSeconds: 600,
    startedAt,
    stoppedAt: null,
    status: 'ready',
  };
}

/** A session with one ready part whose files are in the bucket. */
async function seedReady(meetingId: string, sessionId: string, extra: Partial<typeof schema.meetingSessions.$inferInsert> = {}) {
  const part = readyPart(sessionId, 'rec_a', '2026-10-02T10:00:00.000Z');
  await seedMeetingWithSession(db, {
    meetingId,
    sessionId,
    session: {
      recordingStatus: 'ready',
      recordingParts: [part],
      recordingRtkId: part.rtkRecordingId,
      recordingVideoKey: part.videoKey,
      recordingAudioKey: part.audioKey,
      recordingSizeBytes: 11,
      recordingDurationSeconds: 600,
      ...extra,
    },
  });
  return part;
}

describe('DELETE /:id/recording', () => {
  it('removes every part, the transcript and the summary, publishes the event and leaves other sessions alone', async () => {
    const part = await seedReady('meet_d1', 'msess_d1', {
      aiTranscribeRequested: true,
      summaryStatus: 'completed',
      summaryText: 'Notes',
      summaryFormat: 'markdown',
      summarySource: 'rtk',
    });
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_d1', activityId: 'msess_d1', status: 'completed', fullText: 'hello' });
    await db.insert(schema.crmTranscriptSegments).values({
      id: 'seg_d1', transcriptionId: 'trans_d1', speakerId: 0, text: 'hello', startTime: 0, endTime: 1, sequenceNumber: 0,
    });
    const bucket = fakeBucket({
      [part.videoKey!]: 'video',
      [part.audioKey!]: 'audio',
      [`${ORG}/msess_d1/transcript.json`]: '[]',
      [`${ORG}/msess_other/rec.mp4`]: 'keep me',
      [`other_org/msess_d1/rec.mp4`]: 'keep me too',
    });

    const { request } = app(['recordings:delete'], { MEETING_RECORDINGS: bucket });
    const res = await request('/api/meeting-sessions/msess_d1/recording', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ ok: true, deletedObjects: 3 });
    expect([...bucket.objects.keys()].sort()).toEqual([`${ORG}/msess_other/rec.mp4`, 'other_org/msess_d1/rec.mp4']);

    const row = await session('msess_d1');
    expect(row).toMatchObject({
      recordingStatus: 'deleted',
      recordingParts: null,
      recordingVideoKey: null,
      recordingAudioKey: null,
      aiTranscribeRequested: false,
      summaryStatus: null,
      summaryText: null,
    });
    expect(await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.activityId, 'msess_d1'))).toHaveLength(0);
    expect(await db.select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, 'trans_d1'))).toHaveLength(0);

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    expect(mockedPublish.mock.calls[0]![0]).toMatchObject({
      entityType: 'meeting_session',
      action: 'updated',
      entityId: 'msess_d1',
      data: expect.objectContaining({ recordingDeleted: true }),
    });
  });

  it('is idempotent: a second delete finds nothing and still succeeds', async () => {
    await seedReady('meet_d2', 'msess_d2');
    const bucket = fakeBucket({ [`${ORG}/msess_d2/rec_a.mp4`]: 'v' });
    const { request } = app(['recordings:delete'], { MEETING_RECORDINGS: bucket });
    await request('/api/meeting-sessions/msess_d2/recording', { method: 'DELETE' });
    const again = await request('/api/meeting-sessions/msess_d2/recording', { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { deletedObjects: number } }).data.deletedObjects).toBe(0);
  });

  it('needs recordings:delete', async () => {
    await seedReady('meet_d3', 'msess_d3');
    const { request } = app(['recordings:read', 'sessions:update'], { MEETING_RECORDINGS: fakeBucket() });
    expect((await request('/api/meeting-sessions/msess_d3/recording', { method: 'DELETE' })).status).toBe(403);
  });

  it('is limited to the meeting organizer unless the caller holds meetings:scope:all', async () => {
    await seedReady('meet_d4', 'msess_d4');
    const bucket = fakeBucket({ [`${ORG}/msess_d4/rec_a.mp4`]: 'v' });

    const stranger = app(['recordings:delete'], { MEETING_RECORDINGS: bucket }, { userId: 'user_stranger' });
    expect((await stranger.request('/api/meeting-sessions/msess_d4/recording', { method: 'DELETE' })).status).toBe(403);
    expect(bucket.objects.size).toBe(1);

    const admin = app(['recordings:delete', 'meetings:scope:all'], { MEETING_RECORDINGS: bucket }, { userId: 'user_stranger' });
    expect((await admin.request('/api/meeting-sessions/msess_d4/recording', { method: 'DELETE' })).status).toBe(200);
  });

  it('refuses while the recorder is running, and 404s an unknown session', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_d5', sessionId: 'msess_d5', session: { status: 'active', recordingStatus: 'recording' } });
    const { request } = app(['recordings:delete'], { MEETING_RECORDINGS: fakeBucket() });
    expect((await request('/api/meeting-sessions/msess_d5/recording', { method: 'DELETE' })).status).toBe(409);
    expect((await request('/api/meeting-sessions/msess_nope/recording', { method: 'DELETE' })).status).toBe(404);
  });

  it('keeps the files and the row when the bucket is not bound (no orphaning)', async () => {
    await seedReady('meet_d6', 'msess_d6');
    const { request } = app(['recordings:delete']);
    expect((await request('/api/meeting-sessions/msess_d6/recording', { method: 'DELETE' })).status).toBe(503);
    expect((await session('msess_d6')).recordingStatus).toBe('ready');
  });
});

describe('POST /:id/recording/access + GET /public/meeting-recordings/:token', () => {
  const content = new TextEncoder().encode('0123456789abcdef');

  async function mint(sessionId: string, bucket: ReturnType<typeof fakeBucket>, kv: ReturnType<typeof fakeKv>) {
    const { request } = app(['recordings:read'], { MEETING_RECORDINGS: bucket, WORKSPACE_CACHE: kv });
    return request(`/api/meeting-sessions/${sessionId}/recording/access`, { method: 'POST' });
  }

  function stream(bucket: ReturnType<typeof fakeBucket>, kv: ReturnType<typeof fakeKv>) {
    return createTestApp<Env, Variables>('/public/meeting-recordings', publicMeetingRecordingsRoutes, {
      env: { MEETING_RECORDINGS: bucket, WORKSPACE_CACHE: kv } as Partial<Env>,
    });
  }

  const tokenOf = (url: string) => url.split('/').pop()!;

  it('mints video + audio tokens, then streams the file with Range support and no auth header', async () => {
    const part = await seedReady('meet_a1', 'msess_a1');
    const bucket = fakeBucket({ [part.videoKey!]: content, [part.audioKey!]: 'audio-bytes' });
    const kv = fakeKv();

    const res = await mint('msess_a1', bucket, kv);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { url: string; audioUrl: string; expiresAt: string } };
    expect(data.url).toContain('/public/meeting-recordings/');
    expect(data.audioUrl).toContain('/public/meeting-recordings/');
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const grant = JSON.parse((kv as unknown as { store: Map<string, string> }).store.get(`rec-token:${tokenOf(data.url)}`)!);
    expect(grant).toMatchObject({ orgId: ORG, sessionId: 'msess_a1', key: part.videoKey, kind: 'video', contentType: 'video/mp4', filename: 'Weekly_sync.mp4' });

    const { request } = stream(bucket, kv);
    const token = tokenOf(data.url);

    const full = await request(`/public/meeting-recordings/${token}`);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('0123456789abcdef');
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(full.headers.get('Content-Type')).toBe('video/mp4');
    expect(full.headers.get('Cache-Control')).toBe('private, no-store');
    expect(full.headers.get('Content-Disposition')).toContain('inline');

    const partial = await request(`/public/meeting-recordings/${token}`, { headers: { Range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/16');
    expect(partial.headers.get('Content-Length')).toBe('4');
    expect(await partial.text()).toBe('2345');

    const tail = await request(`/public/meeting-recordings/${token}`, { headers: { Range: 'bytes=-4' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('Content-Range')).toBe('bytes 12-15/16');
    expect(await tail.text()).toBe('cdef');

    const open = await request(`/public/meeting-recordings/${token}`, { headers: { Range: 'bytes=10-' } });
    expect(open.headers.get('Content-Range')).toBe('bytes 10-15/16');

    const beyond = await request(`/public/meeting-recordings/${token}`, { headers: { Range: 'bytes=100-200' } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('Content-Range')).toBe('bytes */16');

    const download = await request(`/public/meeting-recordings/${token}?download=1`);
    expect(download.headers.get('Content-Disposition')).toBe('attachment; filename="Weekly_sync.mp4"');

    const audio = await request(`/public/meeting-recordings/${tokenOf(data.audioUrl)}`);
    expect(audio.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(await audio.text()).toBe('audio-bytes');
  });

  it('answers 404 for unknown, malformed and out-of-prefix tokens, and 503 without the bucket', async () => {
    const bucket = fakeBucket({ [`${ORG}/msess_x/rec.mp4`]: 'v', 'someone-elses/file.mp4': 'secret' });
    const kv = fakeKv({
      'rec-token:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA': { orgId: ORG, sessionId: 'msess_x', key: 'someone-elses/file.mp4', kind: 'video', contentType: 'video/mp4', filename: 'x.mp4', userId: 'u' },
    });
    const { request } = stream(bucket, kv);
    expect((await request('/public/meeting-recordings/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).status).toBe(404);
    expect((await request('/public/meeting-recordings/short')).status).toBe(404);
    expect((await request('/public/meeting-recordings/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);

    const noBucket = createTestApp<Env, Variables>('/public/meeting-recordings', publicMeetingRecordingsRoutes, {
      env: { WORKSPACE_CACHE: kv } as Partial<Env>,
    });
    expect((await noBucket.request('/public/meeting-recordings/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(503);
  });

  it('stops serving once the file is deleted', async () => {
    const part = await seedReady('meet_a2', 'msess_a2');
    const bucket = fakeBucket({ [part.videoKey!]: content });
    const kv = fakeKv();
    const { data } = (await (await mint('msess_a2', bucket, kv)).json()) as { data: { url: string } };
    bucket.objects.clear();
    expect((await stream(bucket, kv).request(`/public/meeting-recordings/${tokenOf(data.url)}`)).status).toBe(404);
  });

  it('refuses access while processing (409) and for a never-recorded session (404)', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_a3', sessionId: 'msess_a3', session: { recordingStatus: 'processing' } });
    await seedMeetingWithSession(db, { meetingId: 'meet_a4', sessionId: 'msess_a4' });
    const bucket = fakeBucket();
    expect((await mint('msess_a3', bucket, fakeKv())).status).toBe(409);
    expect((await mint('msess_a4', bucket, fakeKv())).status).toBe(404);
  });

  it('needs recordings:read and is organizer-scoped', async () => {
    await seedReady('meet_a5', 'msess_a5');
    const bucket = fakeBucket();
    const denied = app(['sessions:read'], { MEETING_RECORDINGS: bucket });
    expect((await denied.request('/api/meeting-sessions/msess_a5/recording/access', { method: 'POST' })).status).toBe(403);
    const stranger = app(['recordings:read'], { MEETING_RECORDINGS: bucket }, { userId: 'user_stranger' });
    expect((await stranger.request('/api/meeting-sessions/msess_a5/recording/access', { method: 'POST' })).status).toBe(403);
  });
});

describe('GET /:id/recording', () => {
  it('reports state without any file URL', async () => {
    await seedReady('meet_g1', 'msess_g1');
    const { request } = app(['recordings:read']);
    const res = await request('/api/meeting-sessions/msess_g1/recording');
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ sessionId: 'msess_g1', status: 'ready', hasVideo: true, hasAudio: true, durationSeconds: 600 });
    expect(JSON.stringify(data)).not.toMatch(/https?:\/\//);
    expect((data.parts as unknown[]).length).toBe(1);
  });
});

describe('POST /:id/recording/ai-options (wallet gate + live RealtimeKit update)', () => {
  function rtk() {
    const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const env = {
      CF_ACCOUNT_ID: 'acct',
      CF_REALTIME_APP_ID: 'app',
      CF_REALTIME_APP_SECRET: 'secret',
      RTK_FETCH: async (input: unknown, init?: RequestInit) => {
        requests.push({ method: init?.method ?? 'GET', url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        return new Response(JSON.stringify({ success: true, data: { id: 'rtk_meeting_1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    } as unknown as Partial<Env>;
    return { requests, env };
  }

  it('updates the live RTK meeting, remembers the choice and publishes', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_o1', sessionId: 'msess_o1', session: { status: 'active', duration: null } });
    const { requests, env } = rtk();
    const { request } = app(['sessions:update'], env);

    const res = await request('/api/meeting-sessions/msess_o1/recording/ai-options', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: true, summarize: true, language: 'nl-NL' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ ok: true, ai: { transcribe: true, summarize: true, language: 'nl' } });

    expect(billing.assertMeetingAiCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), { transcription: true, summary: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('PATCH');
    expect(requests[0]!.url).toContain('/meetings/rtk_meeting_1');
    expect(requests[0]!.body).toMatchObject({
      transcribe_on_end: true,
      summarize_on_end: true,
      ai_config: { transcription: { language: 'nl' }, summarization: { text_format: 'markdown' } },
    });

    expect(await session('msess_o1')).toMatchObject({ aiTranscribeRequested: true, aiSummarizeRequested: true, aiLanguage: 'nl' });
    expect(mockedPublish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'meeting_session', action: 'updated', entityId: 'msess_o1' }));
  });

  it('answers 402 INSUFFICIENT_CREDITS when the wallet cannot cover a minute, without touching RealtimeKit', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_o2', sessionId: 'msess_o2', session: { status: 'active' } });
    billing.assertMeetingAiCredits.mockRejectedValue(new InsufficientMeetingCreditsError(1, 3, 2));
    const { requests, env } = rtk();
    const { request } = app(['sessions:update'], env);

    const res = await request('/api/meeting-sessions/msess_o2/recording/ai-options', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: true, summarize: false }),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_CREDITS', details: { currentBalance: 1, required: 3, shortfall: 2 } } });
    expect(requests).toHaveLength(0);
    expect((await session('msess_o2')).aiTranscribeRequested).toBeFalsy();
  });

  it('does not gate switching everything off', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_o3', sessionId: 'msess_o3', session: { status: 'active', aiTranscribeRequested: true } });
    billing.assertMeetingAiCredits.mockRejectedValue(new InsufficientMeetingCreditsError(0, 1, 1));
    const { requests, env } = rtk();
    const { request } = app(['sessions:update'], env);
    const res = await request('/api/meeting-sessions/msess_o3/recording/ai-options', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: false, summarize: false }),
    });
    expect(res.status).toBe(200);
    expect(requests[0]!.body).toMatchObject({ transcribe_on_end: false, summarize_on_end: false });
  });

  it('maps an unsupported locale to auto-detect instead of sending it to RealtimeKit', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_o4', sessionId: 'msess_o4', session: { status: 'active' } });
    const { requests, env } = rtk();
    const { request } = app(['sessions:update'], env);
    await request('/api/meeting-sessions/msess_o4/recording/ai-options', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: true, summarize: false, language: 'es' }),
    });
    expect(JSON.stringify(requests[0]!.body)).not.toContain('"language"');
    expect((await session('msess_o4')).aiLanguage).toBeNull();
  });

  it('rejects a summary without a transcript, an ended meeting, and a non-organizer', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_o5', sessionId: 'msess_o5', session: { status: 'active' } });
    await seedMeetingWithSession(db, { meetingId: 'meet_o6', sessionId: 'msess_o6', session: { status: 'ended' } });
    const { env } = rtk();
    const { request } = app(['sessions:update'], env);
    const post = (id: string, body: unknown) =>
      request(`/api/meeting-sessions/${id}/recording/ai-options`, { method: 'POST', headers: json, body: JSON.stringify(body) });

    expect((await post('msess_o5', { transcribe: false, summarize: true })).status).toBe(400);
    expect((await post('msess_o6', { transcribe: true, summarize: false })).status).toBe(400);
    const stranger = app(['sessions:update'], env, { userId: 'user_stranger' });
    expect((await stranger.request('/api/meeting-sessions/msess_o5/recording/ai-options', { method: 'POST', headers: json, body: JSON.stringify({ transcribe: true, summarize: false }) })).status).toBe(403);
  });

  it('answers 503 when the wallet cannot be resolved', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_o7', sessionId: 'msess_o7', session: { status: 'active' } });
    billing.resolveMeetingMetering.mockRejectedValue(new MeetingBillingUnavailableError());
    const { env } = rtk();
    const { request } = app(['sessions:update'], env);
    const res = await request('/api/meeting-sessions/msess_o7/recording/ai-options', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: true, summarize: false }),
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /:id/recording/start + stop', () => {
  it('marks the session recording and applies AI options in the same round trip', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_s1', sessionId: 'msess_s1', session: { status: 'active' } });
    const rtkRequests: string[] = [];
    const { request } = app(['sessions:update'], {
      CF_ACCOUNT_ID: 'a', CF_REALTIME_APP_ID: 'b', CF_REALTIME_APP_SECRET: 'c',
      RTK_FETCH: async (input: unknown) => {
        rtkRequests.push(String(input));
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    } as unknown as Partial<Env>);

    const res = await request('/api/meeting-sessions/msess_s1/recording/start', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: true, summarize: false }),
    });
    expect(res.status).toBe(200);
    expect(await session('msess_s1')).toMatchObject({ recordingEnabled: true, recordingStatus: 'recording', aiTranscribeRequested: true });
    expect(rtkRequests).toHaveLength(1);

    const stop = await request('/api/meeting-sessions/msess_s1/recording/stop', { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(await session('msess_s1')).toMatchObject({ recordingEnabled: false, recordingStatus: 'processing' });
    // The stop no longer stores the RTK meeting id as a fake recording key.
    expect((await session('msess_s1')).recordingKey).toBeNull();
  });

  it('works without a body, and keeps spending credits with the host', async () => {
    await seedMeetingWithSession(db, {
      meetingId: 'meet_s2', sessionId: 'msess_s2', organizerId: 'user_host',
      session: { status: 'active' }, meeting: { allowParticipantRecord: true },
    });
    const { request } = app(['sessions:update'], {}, { userId: 'user_guest' });
    expect((await request('/api/meeting-sessions/msess_s2/recording/start', { method: 'POST' })).status).toBe(200);
    const withAi = await request('/api/meeting-sessions/msess_s2/recording/start', {
      method: 'POST', headers: json, body: JSON.stringify({ transcribe: true }),
    });
    expect(withAi.status).toBe(403);
  });

  it('refuses a participant when only the organizer may record', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_s3', sessionId: 'msess_s3', organizerId: 'user_host', session: { status: 'active' } });
    const { request } = app(['sessions:update'], {}, { userId: 'user_guest' });
    expect((await request('/api/meeting-sessions/msess_s3/recording/start', { method: 'POST' })).status).toBe(403);
  });
});

describe('POST /:id/recording/transcribe (Whisper afterwards)', () => {
  it('creates a pending transcript, dispatches the workflow and publishes', async () => {
    await seedReady('meet_x1', 'msess_x1');
    const ai = fakeWorkflow();
    const { request } = app(['sessions:update', 'recordings:read'], { MEETING_AI: ai });

    const res = await request('/api/meeting-sessions/msess_x1/recording/transcribe', {
      method: 'POST', headers: json, body: JSON.stringify({ language: 'nl' }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; status: string } };
    expect(data.status).toBe('pending');
    expect(data.id).toMatch(/^trans_/);

    expect(ai.created).toEqual([
      { id: `whisper-${data.id}`, params: { kind: 'whisper-transcribe', orgId: ORG, sessionId: 'msess_x1', transcriptionId: data.id, userId: 'user_test_default', language: 'nl' } },
    ]);
    const [row] = await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.id, data.id));
    expect(row).toMatchObject({ activityId: 'msess_x1', status: 'pending', language: 'nl' });
    expect(mockedPublish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'meeting_session', entityId: 'msess_x1' }));
  });

  it('is gated on the wallet before anything is created', async () => {
    await seedReady('meet_x2', 'msess_x2');
    billing.assertMeetingAiCredits.mockRejectedValue(new InsufficientMeetingCreditsError(0, 2, 2));
    const ai = fakeWorkflow();
    const { request } = app(['sessions:update', 'recordings:read'], { MEETING_AI: ai });
    const res = await request('/api/meeting-sessions/msess_x2/recording/transcribe', { method: 'POST' });
    expect(res.status).toBe(402);
    expect(ai.created).toHaveLength(0);
    expect(await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.activityId, 'msess_x2'))).toHaveLength(0);
  });

  it('does not start a second transcript, retries a failed one, and needs a ready recording with audio', async () => {
    await seedReady('meet_x3', 'msess_x3');
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_x3', activityId: 'msess_x3', status: 'completed' });
    const ai = fakeWorkflow();
    const { request } = app(['sessions:update', 'recordings:read'], { MEETING_AI: ai });
    const existing = await request('/api/meeting-sessions/msess_x3/recording/transcribe', { method: 'POST' });
    expect(((await existing.json()) as { data: { status: string } }).data.status).toBe('existing');
    expect(ai.created).toHaveLength(0);

    await seedReady('meet_x4', 'msess_x4');
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_x4', activityId: 'msess_x4', status: 'failed' });
    expect((await request('/api/meeting-sessions/msess_x4/recording/transcribe', { method: 'POST' })).status).toBe(201);
    const rows = await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.activityId, 'msess_x4'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe('trans_x4');

    await seedMeetingWithSession(db, { meetingId: 'meet_x5', sessionId: 'msess_x5', session: { recordingStatus: 'processing' } });
    expect((await request('/api/meeting-sessions/msess_x5/recording/transcribe', { method: 'POST' })).status).toBe(400);
  });

  it('is not reachable with meetings:read alone (it spends credits)', async () => {
    await seedReady('meet_x6', 'msess_x6');
    const { request } = app(['meetings:read', 'recordings:read'], { MEETING_AI: fakeWorkflow() });
    expect((await request('/api/meeting-sessions/msess_x6/recording/transcribe', { method: 'POST' })).status).toBe(403);
  });

  it('the per-meeting alias resolves the latest recorded session and demands sessions:update', async () => {
    await seedReady('meet_x7', 'msess_x7');
    const ai = fakeWorkflow();
    const alias = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('sessions:update', 'recordings:read', 'meetings:read'), tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv(), MEETING_AI: ai } as Partial<Env>,
    });
    expect((await alias.request('/api/meetings/meet_x7/recording/transcribe', { method: 'POST' })).status).toBe(201);
    expect(ai.created[0]!.params).toMatchObject({ sessionId: 'msess_x7' });

    const readOnly = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv(), MEETING_AI: ai } as Partial<Env>,
    });
    expect((await readOnly.request('/api/meetings/meet_x7/recording/transcribe', { method: 'POST' })).status).toBe(403);
  });
});

describe('POST /:id/recording/summarize', () => {
  it('needs a completed transcript, then dispatches and marks pending', async () => {
    await seedReady('meet_m1', 'msess_m1');
    const ai = fakeWorkflow();
    const { request } = app(['sessions:update'], { MEETING_AI: ai });
    expect((await request('/api/meeting-sessions/msess_m1/recording/summarize', { method: 'POST' })).status).toBe(400);

    await db.insert(schema.crmTranscriptions).values({ id: 'trans_m1', activityId: 'msess_m1', status: 'completed' });
    const res = await request('/api/meeting-sessions/msess_m1/recording/summarize', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(ai.created).toHaveLength(1);
    expect(ai.created[0]!.id).toMatch(/^summarize-msess_m1-/);
    expect(ai.created[0]!.params).toMatchObject({ kind: 'summarize', orgId: ORG, sessionId: 'msess_m1' });
    expect((await session('msess_m1')).summaryStatus).toBe('pending');

    // A second click does not start (or charge) another one.
    const again = await request('/api/meeting-sessions/msess_m1/recording/summarize', { method: 'POST' });
    expect(((await again.json()) as { data: { status: string } }).data.status).toBe('existing');
    expect(ai.created).toHaveLength(1);
  });

  it('is gated on the wallet', async () => {
    await seedReady('meet_m2', 'msess_m2');
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_m2', activityId: 'msess_m2', status: 'completed' });
    billing.assertMeetingAiCredits.mockRejectedValue(new InsufficientMeetingCreditsError(0, 1, 1));
    const ai = fakeWorkflow();
    const { request } = app(['sessions:update'], { MEETING_AI: ai });
    expect((await request('/api/meeting-sessions/msess_m2/recording/summarize', { method: 'POST' })).status).toBe(402);
    expect(ai.created).toHaveLength(0);
    expect((await session('msess_m2')).summaryStatus).toBeNull();
  });
});

describe('transcription reads', () => {
  it('returns the transcript with segments and the session summary', async () => {
    await seedReady('meet_r1', 'msess_r1', { summaryStatus: 'completed', summaryText: '# Notes' });
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_r1', activityId: 'msess_r1', status: 'completed', fullText: 'hi', provider: 'cloudflare-rtk' });
    await db.insert(schema.crmTranscriptSegments).values({
      id: 'seg_r1', transcriptionId: 'trans_r1', speakerId: 0, speakerLabel: 'Alice', text: 'hi', startTime: 1, endTime: 2, sequenceNumber: 0,
    });
    const { request } = app(['recordings:read']);

    const res = await request('/api/meeting-sessions/msess_r1/transcription');
    const { data } = (await res.json()) as { data: { segments: Array<Record<string, unknown>>; summary: string; provider: string } };
    expect(data.provider).toBe('cloudflare-rtk');
    expect(data.summary).toBe('# Notes');
    expect(data.segments[0]).toMatchObject({ speaker: 'Alice', start: 1, end: 2 });

    const status = await request('/api/meeting-sessions/msess_r1/transcription/status');
    expect(((await status.json()) as { data: unknown }).data).toMatchObject({ exists: true, id: 'trans_r1', status: 'completed', summaryStatus: 'completed' });
  });

  it('the per-meeting aliases fall back to the legacy meeting-keyed transcript', async () => {
    await seedMeetingWithSession(db, { meetingId: 'meet_r2', sessionId: 'msess_r2' });
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_r2', activityId: 'meet_r2', status: 'completed', fullText: 'legacy', provider: 'assemblyai' });
    const alias = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv() } as Partial<Env>,
    });
    const res = await alias.request('/api/meetings/meet_r2/recording/transcription');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { provider: string } }).data.provider).toBe('assemblyai');
    const status = await alias.request('/api/meetings/meet_r2/recording/transcription-status');
    expect(((await status.json()) as { data: { exists: boolean } }).data.exists).toBe(true);
  });
});

describe('PATCH /:id ignores server-owned columns', () => {
  it('updates allowed fields and drops recorder, summary and id columns', async () => {
    await seedReady('meet_p1', 'msess_p1');
    const { request } = app(['sessions:update']);
    const res = await request('/api/meeting-sessions/msess_p1', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({
        status: 'waiting',
        recordingStatus: 'deleted',
        recordingVideoKey: 'hacked/key.mp4',
        recordingParts: [],
        summaryText: 'forged',
        summaryStatus: 'completed',
        aiTranscribeRequested: true,
        cfAppId: 'other_meeting',
        recordingUrl: 'https://evil.example',
        id: 'msess_other',
      }),
    });
    expect(res.status).toBe(200);
    const row = await session('msess_p1');
    expect(row).toMatchObject({
      status: 'waiting',
      recordingStatus: 'ready',
      recordingVideoKey: `${ORG}/msess_p1/rec_a.mp4`,
      summaryText: null,
      cfAppId: 'rtk_meeting_1',
      recordingUrl: null,
    });
    expect(row.aiTranscribeRequested).toBeFalsy();
    expect((row.recordingParts as RecordingPart[]).length).toBe(1);
  });
});

describe('GET /api/meetings/ai-pricing and /recordings', () => {
  it('returns the per-minute rates and the wallet balance', async () => {
    const { request } = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv() } as Partial<Env>,
    });
    const res = await request('/api/meetings/ai-pricing');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      transcriptionCreditsPerMinute: 2,
      summaryCreditsPerMinute: 1,
      balance: 250,
    });
  });

  it('lists recorded sessions with state, never a file URL, and hides deleted ones', async () => {
    await seedReady('meet_l1', 'msess_l1', { summaryStatus: 'completed', startedAt: new Date('2026-10-03T10:00:00Z') });
    await seedMeetingWithSession(db, { meetingId: 'meet_l2', sessionId: 'msess_l2', session: { recordingStatus: 'deleted', startedAt: new Date('2026-10-03T11:00:00Z') } });
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_l1', activityId: 'msess_l1', status: 'completed' });

    const { request } = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv() } as Partial<Env>,
    });
    const { data } = (await (await request('/api/meetings/recordings')).json()) as { data: Array<Record<string, unknown>> };
    const mine = data.find((r) => r.sessionId === 'msess_l1')!;
    expect(mine).toMatchObject({
      recordingUrl: null, recordingStatus: 'ready', hasAudio: true, hasTranscript: true, hasSummary: true, recordingDurationSeconds: 600,
    });
    expect(data.some((r) => r.sessionId === 'msess_l2')).toBe(false);
  });

  it('the per-meeting recording alias returns state plus fresh tokenized URLs once ready', async () => {
    const part = await seedReady('meet_l3', 'msess_l3');
    const bucket = fakeBucket({ [part.videoKey!]: 'v' });
    const { request } = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), tenantDb: db },
      env: { WORKSPACE_CACHE: fakeKv(), MEETING_RECORDINGS: bucket } as Partial<Env>,
    });
    const { data } = (await (await request('/api/meetings/meet_l3/recording')).json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ status: 'ready', sessionId: 'msess_l3' });
    expect(String(data.url)).toContain('/public/meeting-recordings/');
    expect(data.expiresAt).toBeTruthy();
  });
});
