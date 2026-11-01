/**
 * /api/webhooks/cloudflare-realtime end to end against a real schema
 * (pglite): RealtimeKit's signed deliveries (presence, the end of a meeting,
 * the recorder and the AI artefacts), the operator's webhook setup and the
 * legacy recording backfill. RealtimeKit (its REST API and the key it signs
 * deliveries with) is answered at the HTTP level, so both backends make, and
 * are compared on, the same calls.
 *
 * One key pair for the whole file, and this is the only file that signs
 * deliveries: the server remembers RealtimeKit's key for an hour, as the
 * worker does. The key-unavailable case runs first, before either backend
 * has fetched it. WeldChat calls (a `call` mapping) are TypeScript only
 * (../../services/rtk-webhook.calls.test.ts): the Kubernetes editions have no
 * chat calls.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb, createSeparatePgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MeetingSessionParticipant, RecordingPart } from '@weldsuite/db/schema/meeting-sessions';
import { RTK_WEBHOOK_PUBLIC_KEY_URL } from '@weldsuite/cloudflare-realtime/webhook-signature';
import { RTK_ENV, fakeKv, fakeRealtime, fakeRtkApi, fakeWorkflow } from '../../test/fakes';

const ORG = 'org_test_default';

// The workspace's own database and the master one, shared with the Rust
// server in conformance mode; other workspaces' databases for the backfill.
const holder = vi.hoisted(() => ({
  db: null as unknown,
  master: null as unknown,
  others: {} as Record<string, unknown>,
}));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async (_env: unknown, orgId: string) => {
      if (orgId === ORG) return conformanceTenantDb(holder.db);
      const other = holder.others[orgId];
      if (!other) throw new Error(`no database for ${orgId}`);
      return other;
    },
  };
});

import { webhooksCloudflareRealtimeRoutes } from './index';
import type { Env, Variables } from '../../types';

const MOUNT = '/api/webhooks/cloudflare-realtime';
const ROOM = 'rtk_wh_room';
const REC_ROOM = 'rtk_wh_recorded';

let db: Database;
let otherDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicKeyPem: string;
let keyStatus = 200;
let realtime = fakeRealtime();
const rtk = fakeRtkApi();

async function rsaPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}
const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const sign = async (body: string, key = signingKey) =>
  toBase64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body)));

/** RealtimeKit's signing key, then its REST API (../../test/fakes.ts). */
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === RTK_WEBHOOK_PUBLIC_KEY_URL) {
    if (keyStatus !== 200) return new Response('unavailable', { status: keyStatus });
    return new Response(JSON.stringify({ success: true, data: { publicKey: publicKeyPem } }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return rtk.fetch(input, init);
});

function participant(userId: string, cfSessionId: string, extra: Partial<MeetingSessionParticipant> = {}): MeetingSessionParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: '2026-10-01T09:00:00.000Z',
    cfSessionId,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  };
}

async function seedSession(meetingId: string, sessionId: string, cfAppId: string, participants: MeetingSessionParticipant[]) {
  await db.insert(schema.meetings).values({ id: meetingId, title: `Meeting ${meetingId}`, organizerId: 'user_host', status: 'in_progress', activeSessionId: sessionId });
  await db.insert(schema.meetingSessions).values({
    id: sessionId,
    meetingId,
    status: 'active',
    cfAppId,
    startedBy: 'user_host',
    startedByName: 'Host',
    participants,
    startedAt: new Date('2026-10-01T09:00:00.000Z'),
  });
}

async function loadSession(id: string) {
  const [row] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, id));
  return row!;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  const pair = await rsaPair();
  signingKey = pair.privateKey;
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${toBase64((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer)}\n-----END PUBLIC KEY-----`;
  otherKey = (await rsaPair()).privateKey;

  db = (await createPgliteDb()).db;
  holder.db = db;
  otherDb = (await createSeparatePgliteDb()).db;
  holder.others = { org_wh_other: otherDb };
  master = (await createMasterPgliteDb()).db;
  holder.master = master;

  // The backfill's workspaces: one whose database can't be opened (listed
  // first), this one, another one, an inactive one and one without an org.
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_wh_broken', clerkOrgId: 'org_wh_broken', name: 'Broken', slug: 'wh-broken' },
    { id: 'ws_test_default', clerkOrgId: ORG, name: 'Default', slug: 'wh-default' },
    { id: 'ws_wh_other', clerkOrgId: 'org_wh_other', name: 'Other', slug: 'wh-other' },
    { id: 'ws_wh_inactive', clerkOrgId: 'org_wh_inactive', name: 'Inactive', slug: 'wh-inactive', isActive: false },
    { id: 'ws_wh_no_org', clerkOrgId: null, name: 'No org', slug: 'wh-no-org' },
  ] as Array<typeof masterSchema.workspaces.$inferInsert>);

  // Legacy recordings (an expiring URL or marker, no status) for the backfill.
  for (const [database, prefix, count] of [
    [db, 'bf_here', 2],
    [otherDb, 'bf_other', 1],
  ] as const) {
    for (let i = 0; i < count; i++) {
      await database.insert(schema.meetings).values({ id: `mtg_${prefix}_${i}`, title: 'Old', organizerId: 'user_host', status: 'completed' });
      await database.insert(schema.meetingSessions).values({
        id: `msess_${prefix}_${i}`,
        meetingId: `mtg_${prefix}_${i}`,
        status: 'ended',
        cfAppId: `rtk_${prefix}_${i}`,
        startedBy: 'user_host',
        startedByName: 'Host',
        recordingUrl: `https://rtk.example.com/${prefix}_${i}.mp4`,
      });
    }
  }
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  rtk.reset();
  keyStatus = 200;
  realtime = fakeRealtime();
});

/** The deliveries' app: RealtimeKit's mappings in KV, the workflows bound. */
function receiver(kv = fakeKv(), env: Record<string, unknown> = {}) {
  return createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, {
    // No session: the route is public. The database is the mapping's workspace.
    context: { tenantDb: db },
    env: { ...RTK_ENV, WORKSPACE_CACHE: kv, REALTIME: realtime.binding, ...env } as unknown as Partial<Env>,
  });
}

async function deliver(
  request: ReturnType<typeof receiver>['request'],
  payload: unknown,
  options: { key?: CryptoKey; signature?: string | null; uuid?: string } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const signature = options.signature === undefined ? await sign(body, options.key) : options.signature;
  if (signature !== null) headers['rtk-signature'] = signature;
  if (options.uuid) headers['rtk-uuid'] = options.uuid;
  return request(MOUNT, { method: 'POST', headers, body });
}

const sessionMapping = (sessionId: string, meetingId: string) => ({ orgId: ORG, type: 'session', sessionId, meetingId });

describe('POST / (signed deliveries)', () => {
  it("answers 503 while RealtimeKit's key can't be fetched, so RealtimeKit retries", async () => {
    keyStatus = 500;
    const { request } = receiver();
    const res = await deliver(request, { event: 'meeting.ended', meeting: { id: ROOM } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'signature key unavailable' });
  });

  it('rejects an unsigned, a foreign-signed, a tampered and a garbage-signed delivery', async () => {
    const { request } = receiver();
    const payload = { event: 'meeting.ended', meeting: { id: ROOM } };
    expect((await deliver(request, payload, { signature: null })).status).toBe(401);
    expect((await deliver(request, payload, { key: otherKey })).status).toBe(401);
    const tampered = await sign(JSON.stringify({ ...payload, meeting: { id: 'rtk_other' } }));
    expect((await deliver(request, payload, { signature: tampered })).status).toBe(401);
    expect((await deliver(request, payload, { signature: '%%%not-base64%%%' })).status).toBe(401);
    expect(await (await deliver(request, payload, { signature: '' })).json()).toEqual({ error: 'unauthorized' });
  });

  it('acknowledges a delivery without a meeting id or with no mapping', async () => {
    const { request } = receiver();
    expect(await (await deliver(request, { event: 'meeting.ended' })).json()).toEqual({ ok: true });
    expect(await (await deliver(request, { event: 'meeting.ended', meeting: { id: 'rtk_unknown_room' } })).json()).toEqual({ ok: true });
    expect(await (await deliver(request, { event: 'recording.statusUpdate', recording: { id: 'rec_x', meetingId: 'rtk_unknown_room', status: 'UPLOADED' } })).json()).toEqual({ ok: true });
    // Not valid JSON once verified: still a 200 so it is not retried.
    const garbage = 'not json';
    const res = await request(MOUNT, { method: 'POST', headers: { 'rtk-signature': await sign(garbage) }, body: garbage });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('tracks a connection joining and leaving the session', async () => {
    await seedSession('mtg_wh_p', 'msess_wh_p', ROOM, [
      participant('user_host', 'cf_host', { peerIds: ['peer_host'] }),
      participant('user_guest', 'cf_guest', { leftAt: '2026-10-01T09:10:00.000Z' }),
    ]);
    const kv = fakeKv({ [`rtk-meeting:${ROOM}`]: sessionMapping('msess_wh_p', 'mtg_wh_p') });
    const { request } = receiver(kv);

    // The guest is back on a new connection.
    const joined = await deliver(request, {
      event: 'meeting.participantJoined',
      meeting: { id: ROOM },
      participant: { id: 'cf_guest', customParticipantId: 'user_guest', peerId: 'peer_guest_2', joinedAt: '2026-10-01T09:20:00.000Z' },
    });
    expect(await joined.json()).toEqual({ ok: true });
    let guest = (await loadSession('msess_wh_p')).participants!.find((p) => p.userId === 'user_guest')!;
    expect(guest.leftAt).toBeUndefined();
    expect(guest.peerIds).toEqual(['peer_guest_2']);

    // The host's only connection leaves.
    await deliver(request, {
      event: 'meeting.participantLeft',
      meeting: { id: ROOM },
      participant: { id: 'cf_host', customParticipantId: 'user_host', peerId: 'peer_host', leftAt: '2026-10-01T09:30:00.000Z' },
    });
    const host = (await loadSession('msess_wh_p')).participants!.find((p) => p.userId === 'user_host')!;
    expect(host.leftAt).toBeTruthy();
    expect(host.peerIds).toBeUndefined();

    // A leave without a participant is ignored.
    expect(await (await deliver(request, { event: 'meeting.participantLeft', meeting: { id: ROOM }, participant: {} })).json()).toEqual({ ok: true });
    guest = (await loadSession('msess_wh_p')).participants!.find((p) => p.userId === 'user_guest')!;
    expect(guest.leftAt).toBeUndefined();
    expect((await loadSession('msess_wh_p')).status).toBe('active');
  });

  it('ends the session on meeting.ended once RealtimeKit confirms the room is empty, never while people are in it', async () => {
    const busy = 'rtk_wh_busy';
    await seedSession('mtg_wh_busy', 'msess_wh_busy', busy, [participant('user_host', 'cf_busy')]);
    await seedSession('mtg_wh_end', 'msess_wh_end', 'rtk_wh_end', [participant('user_host', 'cf_end')]);
    const kv = fakeKv({
      [`rtk-meeting:${busy}`]: sessionMapping('msess_wh_busy', 'mtg_wh_busy'),
      'rtk-meeting:rtk_wh_end': sessionMapping('msess_wh_end', 'mtg_wh_end'),
    });
    const { request } = receiver(kv);

    rtk.state.live.set(busy, 2);
    expect(await (await deliver(request, { event: 'meeting.ended', meeting: { id: busy, sessionId: 'rtks_1' } })).json()).toEqual({ ok: true });
    expect((await loadSession('msess_wh_busy')).status).toBe('active');

    // The documented nested payload and the legacy flat one.
    await deliver(request, { event: 'meeting.ended', meetingId: 'rtk_wh_end', reason: 'ALL_PARTICIPANTS_LEFT' });
    const ended = await loadSession('msess_wh_end');
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).toBeTruthy();
    const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, 'mtg_wh_end'));
    expect(meeting?.activeSessionId).toBeNull();

    // Already ended: nothing more happens.
    await deliver(request, { event: 'meeting.ended', meeting: { id: 'rtk_wh_end' } });
    expect((await loadSession('msess_wh_end')).status).toBe('ended');
  });

  it('drops a repeated delivery (same rtk-uuid)', async () => {
    await seedSession('mtg_wh_dup', 'msess_wh_dup', 'rtk_wh_dup', [participant('user_host', 'cf_dup')]);
    const kv = fakeKv({ 'rtk-session:rtk_wh_dup': { orgId: ORG, sessionId: 'msess_wh_dup', meetingId: 'mtg_wh_dup' } });
    const copy = fakeWorkflow();
    const { request } = receiver(kv, { MEETING_RECORDING_COPY: copy });
    const uploaded = { event: 'recording.statusUpdate', recording: { id: 'rec_dup', meetingId: 'rtk_wh_dup', status: 'UPLOADED' } };

    await deliver(request, uploaded, { uuid: 'delivery-1' });
    expect(copy.created).toHaveLength(1);
    await deliver(request, uploaded, { uuid: 'delivery-1' });
    expect(copy.created).toHaveLength(1);
  });

  it("follows RealtimeKit's recorder and starts the copy once uploaded", async () => {
    await seedSession('mtg_wh_rec', 'msess_wh_rec', REC_ROOM, [participant('user_host', 'cf_rec')]);
    const kv = fakeKv({ [`rtk-session:${REC_ROOM}`]: { orgId: ORG, sessionId: 'msess_wh_rec', meetingId: 'mtg_wh_rec' } });
    const copy = fakeWorkflow();
    const { request } = receiver(kv, { MEETING_RECORDING_COPY: copy });

    await deliver(request, {
      event: 'recording.statusUpdate',
      meeting: { id: REC_ROOM, sessionId: 'rtks_rec' },
      recording: { id: 'rec_1', status: 'RECORDING', startedTime: '2026-10-01T09:01:00.000Z' },
    });
    let session = await loadSession('msess_wh_rec');
    expect(session.recordingStatus).toBe('recording');
    expect(session.rtkSessionId).toBe('rtks_rec');
    expect(session.recordingParts?.[0]).toMatchObject({ rtkRecordingId: 'rec_1', status: 'recording' });

    await deliver(request, {
      event: 'recording.statusUpdate',
      recording: {
        id: 'rec_1',
        meetingId: REC_ROOM,
        status: 'UPLOADED',
        fileSize: 1234,
        recordingDuration: 95,
        startedTime: '2026-10-01T09:01:00.000Z',
        stoppedTime: '2026-10-01T09:02:35.000Z',
      },
    });
    session = await loadSession('msess_wh_rec');
    expect(session.recordingStatus).toBe('processing');
    expect(session.recordingParts?.[0]).toMatchObject({ status: 'processing', sizeBytes: 1234, durationSeconds: 95 } satisfies Partial<RecordingPart>);
    expect(copy.created).toEqual([
      {
        id: 'rec-rec_1',
        params: {
          orgId: ORG,
          sessionId: 'msess_wh_rec',
          rtkRecordingId: 'rec_1',
          startedAt: '2026-10-01T09:01:00.000Z',
          stoppedAt: '2026-10-01T09:02:35.000Z',
          durationSeconds: 95,
        },
      },
    ]);

    // A late RECORDING never moves the part back; an unknown status is ignored.
    await deliver(request, { event: 'recording.statusUpdate', recording: { id: 'rec_1', meetingId: REC_ROOM, status: 'RECORDING' } });
    await deliver(request, { event: 'recording.statusUpdate', recording: { id: 'rec_1', meetingId: REC_ROOM, status: 'SOMETHING_NEW' } });
    expect((await loadSession('msess_wh_rec')).recordingParts?.[0]?.status).toBe('processing');

    // A failed second part.
    await deliver(request, { event: 'recording.statusUpdate', recording: { id: 'rec_2', meetingId: REC_ROOM, status: 'ERRORED' } });
    session = await loadSession('msess_wh_rec');
    expect(session.recordingParts).toHaveLength(2);
    expect(session.recordingError).toContain('ERRORED');
  });

  it('marks the part failed when the copy cannot start', async () => {
    await seedSession('mtg_wh_cf', 'msess_wh_cf', 'rtk_wh_cf', [participant('user_host', 'cf_cf')]);
    const kv = fakeKv({ 'rtk-session:rtk_wh_cf': { orgId: ORG, sessionId: 'msess_wh_cf', meetingId: 'mtg_wh_cf' } });
    const copy = fakeWorkflow({ failWith: new Error('workflow service down') });
    const { request } = receiver(kv, { MEETING_RECORDING_COPY: copy });
    await deliver(request, { event: 'recording.statusUpdate', recording: { id: 'rec_cf', meetingId: 'rtk_wh_cf', status: 'UPLOADED' } });
    const session = await loadSession('msess_wh_cf');
    expect(session.recordingParts?.[0]?.status).toBe('failed');
    expect(session.recordingError).toContain('Could not start the recording copy');
  });

  it("hands RealtimeKit's transcript and summary to the AI workflow, by the live mapping too", async () => {
    await seedSession('mtg_wh_ai', 'msess_wh_ai', 'rtk_wh_ai', [participant('user_host', 'cf_ai')]);
    const kv = fakeKv({ 'rtk-meeting:rtk_wh_ai': sessionMapping('msess_wh_ai', 'mtg_wh_ai') });
    const ai = fakeWorkflow();
    const { request } = receiver(kv, { MEETING_AI: ai });

    await deliver(request, {
      event: 'meeting.transcript',
      meeting: { id: 'rtk_wh_ai', sessionId: 'rtks_ai' },
      transcriptDownloadUrl: 'https://rtk.example.com/transcript.csv',
    });
    await deliver(request, { event: 'meeting.summary', meeting: { id: 'rtk_wh_ai' }, summaryDownloadUrl: 'https://rtk.example.com/summary.md' });
    expect((await loadSession('msess_wh_ai')).rtkSessionId).toBe('rtks_ai');
    expect(ai.created).toEqual([
      {
        id: 'rtk-transcript-msess_wh_ai',
        params: { kind: 'ingest-rtk-transcript', orgId: ORG, sessionId: 'msess_wh_ai', rtkSessionId: 'rtks_ai', downloadUrl: 'https://rtk.example.com/transcript.csv' },
      },
      {
        id: 'rtk-summary-msess_wh_ai',
        params: { kind: 'ingest-rtk-summary', orgId: ORG, sessionId: 'msess_wh_ai', rtkSessionId: 'rtks_ai', downloadUrl: 'https://rtk.example.com/summary.md' },
      },
    ]);
  });

  it('acknowledges the AI artefacts without the workflow binding', async () => {
    await seedSession('mtg_wh_noai', 'msess_wh_noai', 'rtk_wh_noai', [participant('user_host', 'cf_noai')]);
    const kv = fakeKv({ 'rtk-session:rtk_wh_noai': { orgId: ORG, sessionId: 'msess_wh_noai', meetingId: 'mtg_wh_noai' } });
    const { request } = receiver(kv);
    const res = await deliver(request, { event: 'meeting.summary', meeting: { id: 'rtk_wh_noai', sessionId: 'rtks_noai' } });
    expect(await res.json()).toEqual({ ok: true });
    expect((await loadSession('msess_wh_noai')).rtkSessionId).toBe('rtks_noai');
  });
});

describe('POST /setup (operator)', () => {
  function operator(env: Record<string, unknown> = {}) {
    return createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, {
      context: { tenantDb: db },
      env: { ...RTK_ENV, ENVIRONMENT: 'test', CF_REALTIME_WEBHOOK_TOKEN: 'operator', WORKSPACE_CACHE: fakeKv(), ...env } as unknown as Partial<Env>,
    });
  }
  const setup = (app: ReturnType<typeof operator>, auth: string | null = 'Bearer operator') =>
    app.request(`${MOUNT}/setup`, { method: 'POST', headers: auth ? { Authorization: auth } : {} });

  it('is operator-only', async () => {
    expect((await setup(operator(), null)).status).toBe(401);
    expect((await setup(operator(), 'Bearer nope')).status).toBe(401);
    expect((await setup(operator({ CF_REALTIME_WEBHOOK_TOKEN: undefined }))).status).toBe(401);
    expect(rtk.state.calls).toHaveLength(0);
  });

  it('needs the RealtimeKit app', async () => {
    const res = await setup(operator({ CF_REALTIME_APP_SECRET: undefined }));
    expect(res.status).toBe(400);
  });

  it('registers the webhook with every event, then replaces it and drops duplicates', async () => {
    const res = await setup(operator());
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ok: boolean; url: string; id: string; action: string; removedDuplicates: number; events: string[] };
    expect(created).toMatchObject({ ok: true, id: 'wh_created', action: 'created', removedDuplicates: 0 });
    expect(created.url).toMatch(/^https:\/\/[^/]+\/api\/webhooks\/cloudflare-realtime$/);
    expect(created.url).not.toContain('operator');
    expect(created.events).toEqual([
      'meeting.ended',
      'meeting.participantJoined',
      'meeting.participantLeft',
      'recording.statusUpdate',
      'meeting.transcript',
      'meeting.summary',
    ]);
    expect(rtk.calls('create-webhook').map((c) => c.body)).toEqual([
      { name: 'WeldSuite meeting lifecycle (test)', url: created.url, events: created.events, enabled: true },
    ]);

    rtk.reset();
    rtk.state.webhooks = [
      { id: 'wh_kept', name: 'old', url: created.url, events: ['meeting.ended'], enabled: true },
      { id: 'wh_dupe', name: 'old', url: created.url, events: ['meeting.ended'], enabled: true },
      { id: 'wh_unrelated', name: 'other', url: 'https://elsewhere.example.com/hook', events: ['meeting.ended'], enabled: true },
    ];
    const replaced = (await (await setup(operator())).json()) as { id: string; action: string; removedDuplicates: number };
    expect(replaced).toMatchObject({ id: 'wh_kept', action: 'updated', removedDuplicates: 1 });
    expect(rtk.calls('replace-webhook').map((c) => c.path)).toEqual(['/webhooks/wh_kept']);
    expect(rtk.calls('delete-webhook').map((c) => c.path)).toEqual(['/webhooks/wh_dupe']);
  });

  it('answers 500 when RealtimeKit refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rtk.state.failures.set('webhooks', 403);
    const res = await setup(operator());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to register webhook' });
  });
});

describe('POST /backfill-recordings (operator)', () => {
  function call(body: unknown = {}, options: { auth?: string | null; backfill?: ReturnType<typeof fakeWorkflow> | null; token?: string | null } = {}) {
    const backfill = options.backfill === undefined ? fakeWorkflow() : options.backfill;
    const { request } = createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, {
      context: { tenantDb: db, masterDb: master, tenantDbs: { [ORG]: db, org_wh_other: otherDb } },
      env: {
        ENVIRONMENT: 'test',
        CF_REALTIME_WEBHOOK_TOKEN: options.token === undefined ? 'operator' : options.token,
        WORKSPACE_CACHE: fakeKv(),
        ...(backfill ? { MEETING_RECORDING_BACKFILL: backfill } : {}),
      } as unknown as Partial<Env>,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.auth !== null) headers.Authorization = options.auth ?? 'Bearer operator';
    return { backfill, res: request(`${MOUNT}/backfill-recordings`, { method: 'POST', headers, body: JSON.stringify(body) }) };
  }
  type Result = { ok: boolean; dryRun: boolean; workspaces: number; candidates: number; dispatched: number; failed: number; perRunLimit: number; results: Array<{ orgId: string; candidates: number; instanceId?: string; error?: string }> };

  it('is operator-only', async () => {
    expect((await call({}, { auth: null }).res).status).toBe(401);
    expect((await call({}, { auth: 'Bearer nope' }).res).status).toBe(401);
    expect((await call({}, { token: null }).res).status).toBe(401);
  });

  it('dry run counts legacy candidates per active workspace and reports the one it cannot open', async () => {
    const { backfill, res } = call({ dryRun: true });
    const body = (await (await res).json()) as Result;
    expect(body).toMatchObject({ ok: true, dryRun: true, workspaces: 3, candidates: 3, dispatched: 0, failed: 1 });
    expect(body.results.map((r) => [r.orgId, r.candidates])).toEqual([
      ['org_wh_broken', 0],
      [ORG, 2],
      ['org_wh_other', 1],
    ]);
    expect(body.results[0]?.error).toBeTruthy();
    expect(backfill!.created).toHaveLength(0);
  });

  it('starts one workflow per workspace with candidates', async () => {
    const { backfill, res } = call();
    const body = (await (await res).json()) as Result;
    expect(body).toMatchObject({ dispatched: 2, failed: 1 });
    expect(backfill!.created.map((c) => c.params)).toEqual([{ orgId: ORG }, { orgId: 'org_wh_other' }]);
    for (const created of backfill!.created) expect(created.id).toMatch(/^bf-org_[a-z_]+-[0-9a-z]+$/);
  });

  it('can be limited to one workspace', async () => {
    const { backfill, res } = call({ orgId: 'org_wh_other' });
    const body = (await (await res).json()) as Result;
    expect(body).toMatchObject({ workspaces: 1, candidates: 1, dispatched: 1, failed: 0 });
    expect(backfill!.created.map((c) => c.params)).toEqual([{ orgId: 'org_wh_other' }]);
  });

  it('refuses a real run without the workflow binding and rejects a bad body', async () => {
    expect((await call({}, { backfill: null }).res).status).toBe(503);
    expect((await call({ dryRun: true, orgId: ORG }, { backfill: null }).res).status).toBe(200);
    expect((await call({ dryRun: 'yes' }).res).status).toBe(400);
    expect((await call({ orgId: '' }).res).status).toBe(400);
  });
});
