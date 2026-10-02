import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RTK_WEBHOOK_PUBLIC_KEY_URL,
  resetRtkWebhookKeyCache,
} from '@weldsuite/cloudflare-realtime/webhook-signature';

vi.mock('../../services/rtk-webhook', () => ({
  handleMeetingEnded: vi.fn(async () => {}),
  handleParticipantLeft: vi.fn(async () => {}),
}));
vi.mock('@weldsuite/cloudflare-realtime', () => ({
  registerWebhook: vi.fn(async () => ({ id: 'wh_1' })),
}));

const { handleMeetingEnded, handleParticipantLeft } = await import('../../services/rtk-webhook');
const { registerWebhook } = await import('@weldsuite/cloudflare-realtime');
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
  vi.mocked(registerWebhook).mockClear();
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
    expect(registerWebhook).not.toHaveBeenCalled();
  });

  it('refuses when the operator token is not configured', async () => {
    const res = await app.request(
      '/setup',
      { method: 'POST', headers: { Authorization: 'Bearer ' } },
      { ...env, CF_REALTIME_WEBHOOK_TOKEN: undefined } as never,
    );
    expect(res.status).toBe(401);
    expect(registerWebhook).not.toHaveBeenCalled();
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
    const url = vi.mocked(registerWebhook).mock.calls[0][1].url;
    expect(url).toMatch(/^https:\/\/[a-z-]+\.weldsuite\.org\/api\/webhooks\/cloudflare-realtime$/);
  });
});
