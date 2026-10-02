import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RTK_WEBHOOK_PUBLIC_KEY_URL,
  resetRtkWebhookKeyCache,
} from '@weldsuite/cloudflare-realtime/webhook-signature';

vi.mock('../../services/rtk-webhook', () => ({
  POST_MEETING_EVENTS: new Set(['recording.statusUpdate', 'meeting.transcript', 'meeting.summary']),
  handleMeetingEnded: vi.fn(async () => {}),
  handleParticipantLeft: vi.fn(async () => {}),
  handleRecordingStatus: vi.fn(async () => {}),
  handleMeetingTranscript: vi.fn(async () => {}),
  handleMeetingSummary: vi.fn(async () => {}),
  logPayloadShapeOnce: vi.fn(),
  resolvePostMeetingMapping: vi.fn(async () => null),
}));
vi.mock('@weldsuite/cloudflare-realtime', () => ({
  upsertWebhook: vi.fn(async () => ({ id: 'wh_1', action: 'created', removedDuplicates: 0 })),
}));

const {
  handleMeetingEnded,
  handleParticipantLeft,
  handleRecordingStatus,
  handleMeetingTranscript,
  handleMeetingSummary,
  resolvePostMeetingMapping,
} = await import('../../services/rtk-webhook');
const { upsertWebhook } = await import('@weldsuite/cloudflare-realtime');
const { webhooksCloudflareRealtimeRoutes: app } = await import('./index');

let signingKey: CryptoKey;
let publicKeyPem: string;
let otherSigningKey: CryptoKey;

async function rsaPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function sign(body: string, key = signingKey): Promise<string> {
  return toBase64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body)));
}

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

const MAPPING = { orgId: 'org_1', type: 'session', sessionId: 'msess_1', meetingId: 'mtg_1' };
const ENDED = JSON.stringify({
  event: 'meeting.ended',
  meeting: { id: 'rtk-meeting-1', sessionId: 'rtk-session-1', endedAt: '2026-10-02T10:30:00.000Z' },
  reason: 'ALL_PARTICIPANTS_LEFT',
});

let kv: ReturnType<typeof makeKv>;
let fetchMock: ReturnType<typeof vi.fn>;

function post(body: string, headers: Record<string, string> = {}) {
  return app.request(
    '/',
    { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } },
    { WORKSPACE_CACHE: kv } as never,
  );
}

beforeAll(async () => {
  const pair = await rsaPair();
  signingKey = pair.privateKey;
  const spki = (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer;
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${toBase64(spki)}\n-----END PUBLIC KEY-----`;
  otherSigningKey = (await rsaPair()).privateKey;
});

beforeEach(() => {
  resetRtkWebhookKeyCache();
  vi.mocked(handleMeetingEnded).mockClear();
  vi.mocked(handleParticipantLeft).mockClear();
  vi.mocked(upsertWebhook).mockClear();
  vi.mocked(handleRecordingStatus).mockClear();
  vi.mocked(handleMeetingTranscript).mockClear();
  vi.mocked(handleMeetingSummary).mockClear();
  vi.mocked(resolvePostMeetingMapping).mockReset().mockResolvedValue(null);
  kv = makeKv();
  kv.store.set('rtk-meeting:rtk-meeting-1', JSON.stringify(MAPPING));
  fetchMock = vi.fn(async (url: string) => {
    if (url !== RTK_WEBHOOK_PUBLIC_KEY_URL) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify({ success: true, data: { publicKey: publicKeyPem } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/webhooks/cloudflare-realtime', () => {
  it('rejects an unsigned delivery without touching the meeting', async () => {
    const res = await post(ENDED);
    expect(res.status).toBe(401);
    expect(handleMeetingEnded).not.toHaveBeenCalled();
  });

  it('rejects a delivery signed with a different key', async () => {
    const res = await post(ENDED, { 'rtk-signature': await sign(ENDED, otherSigningKey) });
    expect(res.status).toBe(401);
    expect(handleMeetingEnded).not.toHaveBeenCalled();
  });

  it('rejects a tampered body carrying a valid signature for another body', async () => {
    const forged = ENDED.replace('rtk-meeting-1', 'rtk-meeting-2');
    const res = await post(forged, { 'rtk-signature': await sign(ENDED) });
    expect(res.status).toBe(401);
    expect(handleMeetingEnded).not.toHaveBeenCalled();
  });

  it('rejects a garbage signature header', async () => {
    const res = await post(ENDED, { 'rtk-signature': '%%%not-base64%%%' });
    expect(res.status).toBe(401);
  });

  it('ignores the legacy ?token= — a token alone is not authentication', async () => {
    const res = await app.request(
      '/?token=anything',
      { method: 'POST', body: ENDED },
      { WORKSPACE_CACHE: kv, CF_REALTIME_WEBHOOK_TOKEN: 'anything' } as never,
    );
    expect(res.status).toBe(401);
    expect(handleMeetingEnded).not.toHaveBeenCalled();
  });

  it('processes a correctly signed meeting.ended (documented nested payload)', async () => {
    const res = await post(ENDED, { 'rtk-signature': await sign(ENDED), 'rtk-uuid': 'delivery-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handleMeetingEnded).toHaveBeenCalledWith(expect.anything(), MAPPING, 'rtk-meeting-1');
  });

  it('still reads the legacy flat meetingId', async () => {
    const body = JSON.stringify({ event: 'meeting.ended', meetingId: 'rtk-meeting-1' });
    const res = await post(body, { 'rtk-signature': await sign(body) });
    expect(res.status).toBe(200);
    expect(handleMeetingEnded).toHaveBeenCalledTimes(1);
  });

  it('routes a signed meeting.participantLeft to the participant handler', async () => {
    const body = JSON.stringify({
      event: 'meeting.participantLeft',
      meeting: { id: 'rtk-meeting-1' },
      participant: { peerId: 'peer-1', customParticipantId: 'user_1', leftAt: '2026-10-02T10:25:00.000Z' },
    });
    const res = await post(body, { 'rtk-signature': await sign(body) });
    expect(res.status).toBe(200);
    expect(handleParticipantLeft).toHaveBeenCalledWith(
      expect.anything(),
      MAPPING,
      expect.objectContaining({ participant: expect.objectContaining({ customParticipantId: 'user_1' }) }),
    );
  });

  describe('post-meeting events (recorder, transcript, summary)', () => {
    const SESSION_MAPPING = { orgId: 'org_1', type: 'session' as const, sessionId: 'msess_1', meetingId: 'mtg_1' };

    const cases = [
      ['recording.statusUpdate', () => handleRecordingStatus, { recording: { id: 'rec_1', status: 'UPLOADED', meetingId: 'rtk-meeting-1' } }],
      ['meeting.transcript', () => handleMeetingTranscript, { transcriptDownloadUrl: 'https://rtk.example/t.csv' }],
      ['meeting.summary', () => handleMeetingSummary, { summaryDownloadUrl: 'https://rtk.example/s.md' }],
    ] as const;

    it.each(cases)('routes a signed %s through the long-lived session mapping', async (event, handler, extra) => {
      vi.mocked(resolvePostMeetingMapping).mockResolvedValue(SESSION_MAPPING);
      // The 24 h mapping is already gone, as it is after the meeting ended.
      kv.store.delete('rtk-meeting:rtk-meeting-1');
      const body = JSON.stringify({ event, meeting: { id: 'rtk-meeting-1', sessionId: 'rtk-session-1' }, ...extra });

      const res = await post(body, { 'rtk-signature': await sign(body), 'rtk-uuid': `post-${event.replace('.', '-')}` });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(handler()).toHaveBeenCalledWith(expect.anything(), SESSION_MAPPING, expect.objectContaining({ event }));
      expect(handleMeetingEnded).not.toHaveBeenCalled();
      expect(kv.store.get(`rtk-webhook-delivery:post-${event.replace('.', '-')}`)).toBe('1');
    });

    it.each(cases)('acknowledges %s for an unmapped meeting without calling a handler', async (event, handler, extra) => {
      const body = JSON.stringify({ event, meeting: { id: 'rtk-unknown' }, ...extra });
      const res = await post(body, { 'rtk-signature': await sign(body) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(handler()).not.toHaveBeenCalled();
    });

    it('reads the meeting id from recording.meetingId when the payload has no meeting block', async () => {
      const body = JSON.stringify({ event: 'recording.statusUpdate', recording: { id: 'rec_1', status: 'RECORDING', meetingId: 'rtk-meeting-1' } });
      await post(body, { 'rtk-signature': await sign(body) });
      expect(resolvePostMeetingMapping).toHaveBeenCalledTimes(1);
    });
  });

  it('drops a repeated delivery (same rtk-uuid)', async () => {
    const headers = { 'rtk-signature': await sign(ENDED), 'rtk-uuid': 'delivery-dup' };
    expect((await post(ENDED, headers)).status).toBe(200);
    expect((await post(ENDED, headers)).status).toBe(200);
    expect(handleMeetingEnded).toHaveBeenCalledTimes(1);
    expect(kv.store.get('rtk-webhook-delivery:delivery-dup')).toBe('1');
  });

  it('caches the public key across deliveries', async () => {
    const sig = await sign(ENDED);
    await post(ENDED, { 'rtk-signature': sig, 'rtk-uuid': 'a' });
    await post(ENDED, { 'rtk-signature': sig, 'rtk-uuid': 'b' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers 503 (so RealtimeKit retries) when the public key cannot be fetched', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 502 }));
    const res = await post(ENDED, { 'rtk-signature': await sign(ENDED) });
    expect(res.status).toBe(503);
    expect(handleMeetingEnded).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/cloudflare-realtime/setup', () => {
  const env = {
    CF_ACCOUNT_ID: 'acc',
    CF_REALTIME_APP_ID: 'app',
    CF_REALTIME_APP_SECRET: 'secret',
    CF_REALTIME_WEBHOOK_TOKEN: 'setup-token',
    ENVIRONMENT: 'test',
  };

  it('refuses without the operator bearer token', async () => {
    const res = await app.request('/setup', { method: 'POST' }, env as never);
    expect(res.status).toBe(401);
    expect(upsertWebhook).not.toHaveBeenCalled();
  });

  it('refuses when the operator token is not configured', async () => {
    const res = await app.request(
      '/setup',
      { method: 'POST', headers: { Authorization: 'Bearer ' } },
      { ...env, CF_REALTIME_WEBHOOK_TOKEN: undefined } as never,
    );
    expect(res.status).toBe(401);
    expect(upsertWebhook).not.toHaveBeenCalled();
  });

  it('registers a URL that carries no secret and never echoes the token', async () => {
    const res = await app.request(
      '/setup',
      { method: 'POST', headers: { Authorization: 'Bearer setup-token' } },
      env as never,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('setup-token');
    const params = vi.mocked(upsertWebhook).mock.calls[0][1];
    expect(params.url).toMatch(/^https:\/\/[a-z-]+\.weldsuite\.org\/api\/webhooks\/cloudflare-realtime$/);
    // Every event the receiver handles, so a re-run of /setup never drops one.
    expect(params.events).toEqual([
      'meeting.ended',
      'meeting.participantLeft',
      'recording.statusUpdate',
      'meeting.transcript',
      'meeting.summary',
    ]);
  });
});
