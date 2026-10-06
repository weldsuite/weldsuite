/**
 * Routing of RealtimeKit's post-meeting webhook events through the real receiver:
 * recording.statusUpdate, meeting.transcript, meeting.summary. They arrive AFTER
 * the meeting ended, so they must resolve through the 14-day `rtk-session:`
 * mapping (the 24 h `rtk-meeting:` one is deleted at session end).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { RecordingPart } from '@weldsuite/db/schema/meeting-sessions';
import { fakeKv, fakeWorkflow, seedMeetingWithSession } from '../test/fakes';

const state = vi.hoisted(() => ({ db: null as unknown as Database }));

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getTenantDbForWorkspace: async () => state.db };
});
vi.mock('@weldsuite/cloudflare-realtime/webhook-signature', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/cloudflare-realtime/webhook-signature')>(
    '@weldsuite/cloudflare-realtime/webhook-signature',
  );
  return { ...actual, verifyRtkWebhookSignature: async () => true };
});
vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => undefined), publishEntityEvent: vi.fn() };
});

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { webhooksCloudflareRealtimeRoutes } from '../routes/webhooks-cloudflare-realtime';
import { resetLoggedPayloadShapes } from './rtk-webhook';
import type { Env, Variables } from '../types';

const MOUNT = '/api/webhooks/cloudflare-realtime';
const ORG = 'org_hook';
const mockedRaw = publishEntityEventRaw as unknown as ReturnType<typeof vi.fn>;

let deliveries = 0;

function setup(opts: { kv?: Record<string, unknown>; copy?: ReturnType<typeof fakeWorkflow>; ai?: ReturnType<typeof fakeWorkflow> } = {}) {
  const copy = opts.copy ?? fakeWorkflow();
  const ai = opts.ai ?? fakeWorkflow();
  const kv = fakeKv(opts.kv);
  const { request } = createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, {
    env: { WORKSPACE_CACHE: kv, MEETING_RECORDING_COPY: copy, MEETING_AI: ai } as Partial<Env>,
  });
  const post = (payload: Record<string, unknown>) =>
    request(MOUNT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rtk-signature': 'sig', 'rtk-uuid': `delivery-${++deliveries}` },
      body: JSON.stringify(payload),
    });
  return { post, copy, ai, kv };
}

const sessionMapping = (sessionId: string, meetingId: string) => ({ orgId: ORG, sessionId, meetingId });

async function readSession(sessionId: string) {
  const [row] = await state.db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
  return row!;
}

beforeAll(async () => {
  state.db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  mockedRaw.mockClear();
  resetLoggedPayloadShapes();
});

describe('recording.statusUpdate', () => {
  it('tracks a part from RECORDING to UPLOADED and starts the copy workflow, resolving via rtk-session (the 24h mapping is gone)', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w1', sessionId: 'msess_w1' });
    const { post, copy } = setup({ kv: { 'rtk-session:rtk_m_w1': sessionMapping('msess_w1', 'meet_w1') } });
    const base = { event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w1', sessionId: 'rtk_sess_1' } };

    await post({ ...base, recording: { id: 'rec_1', status: 'RECORDING', startedTime: '2026-10-02T10:00:00.000Z' } });
    let session = await readSession('msess_w1');
    expect(session.recordingStatus).toBe('recording');
    expect(session.recordingEnabled).toBe(true);
    expect(session.rtkSessionId).toBe('rtk_sess_1');

    await post({ ...base, recording: { id: 'rec_1', status: 'UPLOADING' } });
    session = await readSession('msess_w1');
    expect(session.recordingStatus).toBe('processing');
    expect(session.recordingEnabled).toBe(false);
    expect(copy.created).toHaveLength(0);

    const res = await post({
      ...base,
      recording: {
        id: 'rec_1',
        status: 'UPLOADED',
        stoppedTime: '2026-10-02T10:30:00.000Z',
        fileSize: '123456789',
        recordingDuration: 1800,
        downloadUrl: 'https://rtk.example/expiring.mp4',
      },
    });
    expect(await res.json()).toEqual({ ok: true });

    session = await readSession('msess_w1');
    const part = (session.recordingParts as RecordingPart[])[0]!;
    expect(part).toMatchObject({
      rtkRecordingId: 'rec_1',
      status: 'processing',
      sizeBytes: 123456789,
      durationSeconds: 1800,
      startedAt: '2026-10-02T10:00:00.000Z',
      stoppedAt: '2026-10-02T10:30:00.000Z',
    });
    expect(copy.created).toEqual([
      {
        id: 'rec-rec_1',
        params: expect.objectContaining({ orgId: ORG, sessionId: 'msess_w1', rtkRecordingId: 'rec_1', durationSeconds: 1800 }),
      },
    ]);
    // The expiring URL is NOT forwarded: the workflow resolves a fresh one itself.
    expect(JSON.stringify(copy.created[0])).not.toContain('expiring.mp4');
    expect(mockedRaw).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'meeting_session', action: 'updated', entityId: 'msess_w1', workspaceId: ORG }),
    );
  });

  it('accepts recording.meetingId when it differs from meeting.id', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w2', sessionId: 'msess_w2' });
    const { post } = setup({ kv: { 'rtk-session:rtk_other_id': sessionMapping('msess_w2', 'meet_w2') } });

    await post({
      event: 'recording.statusUpdate',
      meeting: { id: 'rtk_unrelated', sessionId: 's' },
      recording: { id: 'rec_2', status: 'RECORDING', meetingId: 'rtk_other_id' },
    });
    expect((await readSession('msess_w2')).recordingStatus).toBe('recording');
  });

  it('falls back to the live rtk-meeting mapping (a recording that finishes while the meeting is still on)', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w3', sessionId: 'msess_w3', session: { status: 'active' } });
    const { post } = setup({
      kv: { 'rtk-meeting:rtk_m_w3': { orgId: ORG, type: 'session', sessionId: 'msess_w3', meetingId: 'meet_w3' } },
    });
    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w3' }, recording: { id: 'rec_3', status: 'RECORDING' } });
    expect((await readSession('msess_w3')).recordingStatus).toBe('recording');
  });

  it('marks an ERRORED recording failed with a reason', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w4', sessionId: 'msess_w4' });
    const { post, copy } = setup({ kv: { 'rtk-session:rtk_m_w4': sessionMapping('msess_w4', 'meet_w4') } });
    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w4' }, recording: { id: 'rec_4', status: 'ERRORED' } });
    const session = await readSession('msess_w4');
    expect(session.recordingStatus).toBe('failed');
    expect(session.recordingError).toMatch(/ERRORED/);
    expect(copy.created).toHaveLength(0);
  });

  it('ignores PAUSED, and any later event for a part that is already ready', async () => {
    const part: RecordingPart = {
      rtkRecordingId: 'rec_5',
      videoKey: `${ORG}/msess_w5/rec_5.mp4`,
      audioKey: null,
      sizeBytes: 10,
      durationSeconds: 60,
      startedAt: '2026-10-02T10:00:00.000Z',
      stoppedAt: null,
      status: 'ready',
    };
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_w5',
      sessionId: 'msess_w5',
      session: { recordingStatus: 'ready', recordingParts: [part], recordingVideoKey: part.videoKey },
    });
    const { post, copy } = setup({ kv: { 'rtk-session:rtk_m_w5': sessionMapping('msess_w5', 'meet_w5') } });

    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w5' }, recording: { id: 'rec_5', status: 'PAUSED' } });
    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w5' }, recording: { id: 'rec_5', status: 'UPLOADING' } });
    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w5' }, recording: { id: 'rec_5', status: 'UPLOADED' } });

    const session = await readSession('msess_w5');
    expect(session.recordingStatus).toBe('ready');
    expect(copy.created).toHaveLength(0);
  });

  it('does not resurrect a deleted recording from a stale upload event', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_w6',
      sessionId: 'msess_w6',
      session: { recordingStatus: 'deleted' },
    });
    const { post, copy } = setup({ kv: { 'rtk-session:rtk_m_w6': sessionMapping('msess_w6', 'meet_w6') } });
    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w6' }, recording: { id: 'rec_old', status: 'UPLOADED' } });
    expect((await readSession('msess_w6')).recordingStatus).toBe('deleted');
    expect(copy.created).toHaveLength(0);
  });

  it('treats a redelivered UPLOADED as already running (workflow id exists) and still answers ok', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w7', sessionId: 'msess_w7' });
    const copy = fakeWorkflow({ failWith: new Error('instance.already_exists') });
    const { post } = setup({ copy, kv: { 'rtk-session:rtk_m_w7': sessionMapping('msess_w7', 'meet_w7') } });
    const res = await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w7' }, recording: { id: 'rec_7', status: 'UPLOADED' } });
    expect(await res.json()).toEqual({ ok: true });
    // Not marked failed: the copy is simply already in flight.
    expect((await readSession('msess_w7')).recordingStatus).toBe('processing');
  });

  it('marks the part failed when the copy workflow cannot be started at all', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w8', sessionId: 'msess_w8' });
    const copy = fakeWorkflow({ failWith: new Error('workflow service down') });
    const { post } = setup({ copy, kv: { 'rtk-session:rtk_m_w8': sessionMapping('msess_w8', 'meet_w8') } });
    await post({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w8' }, recording: { id: 'rec_8', status: 'UPLOADED' } });
    const session = await readSession('msess_w8');
    expect(session.recordingStatus).toBe('failed');
    expect(session.recordingError).toMatch(/Could not start the recording copy/);
  });

  it('acknowledges unknown meetings and WeldChat calls without touching anything', async () => {
    const { post, copy, ai } = setup({
      kv: { 'rtk-meeting:rtk_call': { orgId: ORG, type: 'call', callId: 'call_1', channelId: 'ch_1' } },
    });
    for (const meetingId of ['rtk_nobody', 'rtk_call']) {
      const res = await post({ event: 'recording.statusUpdate', meeting: { id: meetingId }, recording: { id: 'r', status: 'UPLOADED' } });
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(copy.created).toHaveLength(0);
    expect(ai.created).toHaveLength(0);
  });

  it('drops a duplicate delivery id', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_w9', sessionId: 'msess_w9' });
    const { kv, copy } = setup({ kv: { 'rtk-session:rtk_m_w9': sessionMapping('msess_w9', 'meet_w9') } });
    const { request } = createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, {
      env: { WORKSPACE_CACHE: kv, MEETING_RECORDING_COPY: copy, MEETING_AI: fakeWorkflow() } as Partial<Env>,
    });
    const send = () =>
      request(MOUNT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'rtk-signature': 'sig', 'rtk-uuid': 'same-delivery' },
        body: JSON.stringify({ event: 'recording.statusUpdate', meeting: { id: 'rtk_m_w9' }, recording: { id: 'rec_9', status: 'UPLOADED' } }),
      });
    await send();
    await send();
    expect(copy.created).toHaveLength(1);
  });
});

describe('meeting.transcript / meeting.summary', () => {
  it('dispatches the transcript ingest with the expiring URL and stores the RTK session id', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_t1', sessionId: 'msess_t1' });
    const { post, ai } = setup({ kv: { 'rtk-session:rtk_m_t1': sessionMapping('msess_t1', 'meet_t1') } });

    await post({
      event: 'meeting.transcript',
      meeting: { id: 'rtk_m_t1', sessionId: 'rtk_sess_t1' },
      transcriptDownloadUrl: 'https://rtk.example/transcript.csv',
      transcriptDownloadUrlExpiry: '2026-10-09T10:00:00.000Z',
    });

    expect(ai.created).toEqual([
      {
        id: 'rtk-transcript-msess_t1',
        params: {
          kind: 'ingest-rtk-transcript',
          orgId: ORG,
          sessionId: 'msess_t1',
          rtkSessionId: 'rtk_sess_t1',
          downloadUrl: 'https://rtk.example/transcript.csv',
        },
      },
    ]);
    expect((await readSession('msess_t1')).rtkSessionId).toBe('rtk_sess_t1');
  });

  it('dispatches the summary ingest', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_t2', sessionId: 'msess_t2' });
    const { post, ai } = setup({ kv: { 'rtk-session:rtk_m_t2': sessionMapping('msess_t2', 'meet_t2') } });

    await post({
      event: 'meeting.summary',
      meeting: { id: 'rtk_m_t2', sessionId: 'rtk_sess_t2' },
      summaryDownloadUrl: 'https://rtk.example/summary.md',
    });

    expect(ai.created).toEqual([
      {
        id: 'rtk-summary-msess_t2',
        params: {
          kind: 'ingest-rtk-summary',
          orgId: ORG,
          sessionId: 'msess_t2',
          rtkSessionId: 'rtk_sess_t2',
          downloadUrl: 'https://rtk.example/summary.md',
        },
      },
    ]);
  });

  it('survives a missing MEETING_AI binding (logs, acknowledges)', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_t3', sessionId: 'msess_t3' });
    const kv = fakeKv({ 'rtk-session:rtk_m_t3': sessionMapping('msess_t3', 'meet_t3') });
    const { request } = createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, {
      env: { WORKSPACE_CACHE: kv } as Partial<Env>,
    });
    const res = await request(MOUNT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rtk-signature': 'sig', 'rtk-uuid': 'd-t3' },
      body: JSON.stringify({ event: 'meeting.transcript', meeting: { id: 'rtk_m_t3', sessionId: 's' }, transcriptDownloadUrl: 'u' }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('payload shape logging', () => {
  it('logs the raw key set once per event type, keys only', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await seedMeetingWithSession(state.db, { meetingId: 'meet_l1', sessionId: 'msess_l1' });
    const { post } = setup({ kv: { 'rtk-session:rtk_m_l1': sessionMapping('msess_l1', 'meet_l1') } });

    const payload = {
      event: 'recording.statusUpdate',
      meeting: { id: 'rtk_m_l1' },
      recording: { id: 'rec_l', status: 'PAUSED', downloadUrl: 'https://secret.example/file' },
    };
    await post(payload);
    await post(payload);

    const shapeLogs = log.mock.calls.filter((args) => String(args[0]).includes('payload keys'));
    expect(shapeLogs).toHaveLength(1);
    const logged = JSON.stringify(shapeLogs[0]);
    expect(logged).toContain('downloadUrl');
    expect(logged).not.toContain('secret.example');
    log.mockRestore();
  });
});

describe('POST /setup (idempotent registration)', () => {
  const setupEnv = (fetchStub: (url: string, init?: RequestInit) => Response) =>
    ({
      ENVIRONMENT: 'test',
      CF_REALTIME_WEBHOOK_TOKEN: 'operator',
      CF_ACCOUNT_ID: 'acct',
      CF_REALTIME_APP_ID: 'app',
      CF_REALTIME_APP_SECRET: 'secret',
      WORKSPACE_CACHE: fakeKv(),
      RTK_FETCH: async (input: unknown, init?: RequestInit) => fetchStub(String(input), init),
    }) as unknown as Partial<Env>;

  const call = (env: Partial<Env>) =>
    createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, { env }).request(`${MOUNT}/setup`, {
      method: 'POST',
      headers: { Authorization: 'Bearer operator' },
    });

  const EXPECTED_URL = 'https://meet-api-test.weldsuite.org/api/webhooks/cloudflare-realtime';
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('replaces the event list of the existing webhook and deletes duplicates', async () => {
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    const env = setupEnv((url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      if (method === 'GET') {
        const hook = (id: string) => ({ id, created_at: 'x', updated_at: 'x', enabled: true, name: 'n', url: EXPECTED_URL, events: ['meeting.ended'] });
        return json({ success: true, data: [hook('wh_1'), hook('wh_2')] });
      }
      return json({ success: true, data: { id: 'wh_1' } });
    });

    const res = await call(env);
    const body = (await res.json()) as { action: string; removedDuplicates: number; events: string[] };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ action: 'updated', removedDuplicates: 1 });
    expect(body.events).toEqual([
      'meeting.ended',
      'meeting.participantJoined',
      'meeting.participantLeft',
      'recording.statusUpdate',
      'meeting.transcript',
      'meeting.summary',
    ]);

    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toContain('/webhooks/wh_1');
    expect(put?.body?.events).toEqual(body.events);
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('/webhooks/wh_2');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates the webhook when none has this URL', async () => {
    const methods: string[] = [];
    const env = setupEnv((_url, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      return method === 'GET' ? json({ success: true, data: [] }) : json({ success: true, data: { id: 'wh_new' } });
    });
    const res = await call(env);
    expect(await res.json()).toMatchObject({ ok: true, id: 'wh_new', action: 'created' });
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('refuses without the operator bearer token', async () => {
    const env = setupEnv(() => json({}));
    const res = await createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, { env }).request(`${MOUNT}/setup`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
