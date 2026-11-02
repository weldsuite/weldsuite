/**
 * /api/push-tokens against a real pglite tenant DB, with Expo's push API
 * stubbed on `fetch`: registering, listing (masked), deactivating, and the
 * test push with its per-app batches, retries and invalid-token cleanup.
 * Runs in the Rust conformance suite too (`rust/conformance/suites.json`), so
 * the stub answers by URL and body, never by call order, and hands every
 * other request (the harness's own) to the real `fetch`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { pushTokensRoutes } from './index';

let db: Database;

const ANNA = 'user_pt_anna';
const BEN = 'user_pt_ben';
const CORA = 'user_pt_cora';
const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

const realFetch = globalThis.fetch;

/** Expo, by token: `…[bad]` is unregistered, `…[mixed]` makes a batch fail with 400, `…[down]` 500s. */
async function expo(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== EXPO_URL) return realFetch(input, init);
  const messages = JSON.parse(String(init?.body)) as Array<{ to: string }>;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (messages.some((m) => m.to.includes('[down]'))) return json(500, { error: 'Expo is down' });
  if (messages.length > 1 && messages.some((m) => m.to.includes('[mixed]'))) {
    return json(400, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'Mixed projects' }] });
  }
  return json(200, {
    data: messages.map((m) =>
      m.to.includes('[bad]')
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok', id: `ticket-${m.to}` },
    ),
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-01-01T10:00:00.000Z');
  const token = (id: string, userId: string, deviceId: string, value: string, appCode: string, tokenType = 'expo') => ({
    id,
    userId,
    deviceId,
    platform: 'ios',
    token: value,
    tokenType,
    appCode,
    lastUsedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(schema.deviceTokens).values([
    // Ben: a good WeldChat token, an unregistered one, a raw FCM token, a call token, a WeldMail token.
    token('dt_pt_b1', BEN, 'phone', 'ExponentPushToken[good-chat]', 'weldchat'),
    token('dt_pt_b2', BEN, 'tablet', 'ExponentPushToken[bad]', 'weldchat'),
    token('dt_pt_b3', BEN, 'old', 'fcm-raw-token', 'weldsuite'),
    token('dt_pt_b4', BEN, 'phone:call', 'voip-token', 'weldchat', 'voip'),
    token('dt_pt_b5', BEN, 'phone', 'ExponentPushToken[mail]', 'weldmail'),
    // Cora: every push fails.
    token('dt_pt_c1', CORA, 'phone', 'ExponentPushToken[down]', 'weldchat'),
  ]);
}, 60_000);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(expo));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function app(userId: string) {
  return createTestApp('/api/push-tokens', pushTokensRoutes, { context: { tenantDb: db, userId } });
}

function post(path: string, body?: unknown): [string, RequestInit] {
  return [
    path,
    body === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ];
}

async function tokenRow(id: string) {
  const [row] = await db.select().from(schema.deviceTokens).where(eq(schema.deviceTokens.id, id));
  return row;
}

describe('POST /api/push-tokens and GET /api/push-tokens', () => {
  it('registers a token with the defaults and lists it masked', async () => {
    const res = await app(ANNA).request(
      ...post('/api/push-tokens', { token: 'ExponentPushToken[anna-phone-0001]', platform: 'android', deviceId: 'pixel', deviceModel: 'Pixel 9' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deviceId: 'pixel', platform: 'android', registered: true } });

    const list = await app(ANNA).request('/api/push-tokens');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ deviceId: 'pixel', platform: 'android', appCode: 'weldsuite', tokenSuffix: '-phone-0001]' });
  });

  it('re-registering updates the token and keeps the details it leaves out', async () => {
    const res = await app(ANNA).request(
      ...post('/api/push-tokens', { token: 'ExponentPushToken[anna-new]', platform: 'android', deviceId: 'pixel', tokenType: 'fcm' }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.deviceTokens).where(eq(schema.deviceTokens.userId, ANNA));
    expect(row).toMatchObject({ token: 'ExponentPushToken[anna-new]', tokenType: 'fcm', deviceModel: 'Pixel 9', isActive: null });
  });

  it('lists the existing tokens of a user', async () => {
    const res = await app(BEN).request('/api/push-tokens');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ lastUsedAt: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]?.lastUsedAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it.each([
    ['an unknown platform', { token: 't', platform: 'blackberry', deviceId: 'd' }],
    ['an empty app code', { token: 't', platform: 'ios', deviceId: 'd', appCode: '' }],
    ['no token', { platform: 'ios', deviceId: 'd' }],
  ])('refuses %s', async (_name, body) => {
    const res = await app(ANNA).request(...post('/api/push-tokens', body));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/push-tokens', () => {
  it("deactivates a device's push and call tokens", async () => {
    await app(ANNA).request(
      ...post('/api/push-tokens', { token: 'voip-anna', platform: 'ios', deviceId: 'pixel:call', tokenType: 'voip', appCode: 'weldchat' }),
    );
    const res = await app(ANNA).request('/api/push-tokens?deviceId=pixel', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deviceId: 'pixel', unregistered: true } });
    const rows = await db.select().from(schema.deviceTokens).where(eq(schema.deviceTokens.userId, ANNA));
    expect(rows.every((row) => row.isActive !== null)).toBe(true);
    const list = await app(ANNA).request('/api/push-tokens');
    expect(((await list.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('needs a deviceId', async () => {
    const res = await app(ANNA).request('/api/push-tokens', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/push-tokens/test', () => {
  it('refuses a user without a WeldChat token', async () => {
    const res = await app(ANNA).request(...post('/api/push-tokens/test'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('No active WeldChat push token');
  });

  it('sends one batch per app, counts the tickets and deactivates invalid tokens', async () => {
    const res = await app(BEN).request(...post('/api/push-tokens/test'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sent: number; failed: number; errors: string[] } };
    expect(body.data).toMatchObject({ sent: 1, failed: 2 });
    // One batch per app, in the order the rows come back.
    expect([...body.data.errors].sort()).toEqual(['DeviceNotRegistered', 'InvalidCredentials']);
    expect((await tokenRow('dt_pt_b2'))?.isActive).not.toBeNull();
    expect((await tokenRow('dt_pt_b3'))?.isActive).not.toBeNull();
    expect((await tokenRow('dt_pt_b1'))?.isActive).toBeNull();
    expect((await tokenRow('dt_pt_b4'))?.isActive).toBeNull();
  });

  it('retries a rejected batch one message at a time', async () => {
    await app(BEN).request(...post('/api/push-tokens', { token: 'ExponentPushToken[mixed]', platform: 'ios', deviceId: 'ipad', appCode: 'weldchat' }));
    const res = await app(BEN).request(...post('/api/push-tokens/test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { sent: 2, failed: 0, errors: [] } });
  });

  it("answers 500 with Expo's reason when nothing was delivered", async () => {
    const res = await app(CORA).request(...post('/api/push-tokens/test'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('HTTP 500: Expo is down');
  });

  it('answers 500 when Expo cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === EXPO_URL) throw new Error('offline');
        return realFetch(input, init);
      }),
    );
    const res = await app(CORA).request(...post('/api/push-tokens/test'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Failed to send test push');
  });
});
