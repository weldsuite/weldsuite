/**
 * personal-api's own surface around the routes: the worker's plain routes
 * and 404s, the Clerk session check (authorized parties, entitlement
 * claims), the personal account lookup, `POST /api/onboard`, `GET /api/me`
 * and `/api/push-tokens`. pglite master and personal databases; run on both
 * backends by the `personal: account` conformance suite.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as personalSchema from '@weldsuite/db/schema/personal';
import { createMasterPgliteDb, createPersonalPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  CONFORMANCE_WRITE_HEADER,
  conformanceMasterDb,
  conformanceTenantDb,
} from '@weldsuite/worker-kit/testing/conformance';
import { authHeaders, createPersonalTestApp } from '../test/harness';
import { ACCOUNT, AT, OTHER_ACCOUNT, USER, resetDatabases, seedBothAccounts, seedPersonalAccount } from '../test/seed';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, personalDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getPersonalDb: () => conformanceTenantDb(holder.personalDb),
}));

type Db = Awaited<ReturnType<typeof createPersonalPgliteDb>>['db'];
let masterDb: Db;
let personalDb: Db;

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
  personalDb = (await createPersonalPgliteDb()).db;
  holder.masterDb = masterDb;
  holder.personalDb = personalDb;
}, 60_000);

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await resetDatabases(masterDb, personalDb);
});

function app(env: Record<string, unknown> = {}) {
  return createPersonalTestApp({ masterDb, personalDb, env });
}

describe('plain routes', () => {
  it('answers /health and /robots.txt', async () => {
    const target = app();
    // The timestamp is the current one: compared as a write's is.
    const health = await target.request('/health', { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', environment: 'test' });

    const robots = await target.request('/robots.txt');
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('answers an unknown path with its own 404', async () => {
    const res = await app().request('/nowhere/at-all');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not Found', details: { path: '/nowhere/at-all' } },
    });
  });

  it('checks the session before an unknown /api path, then answers 404', async () => {
    const target = app();
    expect((await target.request('/api/nothing-here')).status).toBe(401);

    await seedPersonalAccount(masterDb);
    const res = await target.request('/api/nothing-here', { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not Found', details: { path: '/api/nothing-here' } },
    });
  });
});

describe('session', () => {
  it('refuses a request without a bearer token', async () => {
    const res = await app().request('/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
    });
  });

  it('refuses a token minted for another frontend', async () => {
    const res = await app().request('/api/me', { headers: authHeaders({ azp: 'https://app.weldsuite.org' }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } });
  });

  it('refuses an authorized party that is not a string', async () => {
    const res = await app().request('/api/me', { headers: authHeaders({ azp: 42 }) });
    expect(res.status).toBe(401);
  });

  it.each([
    'https://weldmail.weldsuite.org',
    'https://mail.weldmail.com',
    'http://localhost:3201',
    'https://feature-x.weldmail-web-test.pages.dev',
    'https://weldcalendar-web.pages.dev',
  ])('accepts a token from %s', async (azp) => {
    const res = await app().request('/api/me', { headers: authHeaders({ azp }) });
    expect(res.status).toBe(200);
  });

  it('refuses a host two labels deep under a consumer web host', async () => {
    const res = await app().request('/api/me', { headers: authHeaders({ azp: 'https://a.b.weldmail.com' }) });
    expect(res.status).toBe(401);
  });

  it('accepts an extra origin from CLERK_AUTHORIZED_PARTIES', async () => {
    const target = app({ CLERK_AUTHORIZED_PARTIES: 'https://mail.example.org, junk' });
    const res = await target.request('/api/me', { headers: authHeaders({ azp: 'https://mail.example.org' }) });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/onboard', () => {
  it('creates the personal account once', async () => {
    const target = app();
    const created = await target.request('/api/onboard', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ displayName: 'Pat' }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; clerkUserId: string; displayName: string } };
    expect(data).toMatchObject({ clerkUserId: USER, displayName: 'Pat' });
    expect(data.id).toMatch(/^pa_/);

    const [row] = await masterDb
      .select()
      .from(masterSchema.personalAccounts)
      .where(eq(masterSchema.personalAccounts.clerkUserId, USER));
    expect(row).toMatchObject({ id: data.id, isActive: true });

    // Again: the existing account, 200.
    const again = await target.request('/api/onboard', { method: 'POST', headers: authHeaders(), body: '{}' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(data.id);
  });

  it('takes no body, or one that is not JSON', async () => {
    const target = app();
    const res = await target.request('/api/onboard', { method: 'POST', headers: authHeaders(), body: 'not json' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { displayName: unknown } }).data.displayName).toBeNull();
  });

  it('refuses a display name that is empty or not an object body', async () => {
    const target = app();
    const empty = await target.request('/api/onboard', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ displayName: '' }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Invalid body' } });

    const list = await target.request('/api/onboard', { method: 'POST', headers: authHeaders(), body: '[]' });
    expect(list.status).toBe(400);
  });
});

describe('GET /api/me', () => {
  it('answers an empty profile before onboarding, with the free plan', async () => {
    const res = await app().request('/api/me', { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        account: null,
        mailAccounts: [],
        calendars: [],
        entitlements: {
          plan: 'free',
          maxAddresses: 1,
          dailySendLimit: 50,
          calendarPlan: 'free',
          maxCalendars: 1,
          maxBookingPages: 1,
        },
      },
    });
  });

  it('lists the account, its mailboxes and calendars, not another person’s', async () => {
    await seedBothAccounts(masterDb);
    await personalDb.insert(personalSchema.personalMailAccounts).values([
      {
        id: 'pma_mine',
        personalAccountId: ACCOUNT,
        name: 'pat',
        email: 'pat@weldmail.com',
        displayName: 'Pat',
        createdAt: AT,
        updatedAt: AT,
      },
      {
        id: 'pma_gone',
        personalAccountId: ACCOUNT,
        name: 'old',
        email: 'old@weldmail.com',
        createdAt: AT,
        updatedAt: AT,
        deletedAt: AT,
      },
      {
        id: 'pma_theirs',
        personalAccountId: OTHER_ACCOUNT,
        name: 'olly',
        email: 'olly@weldmail.com',
        createdAt: AT,
        updatedAt: AT,
      },
    ]);
    await personalDb.insert(personalSchema.personalCalendars).values({
      id: 'pcal_mine',
      personalAccountId: ACCOUNT,
      name: 'Home',
      color: '#ff0000',
      ownerId: USER,
      isDefault: true,
      createdAt: AT,
      updatedAt: AT,
    });

    const res = await app().request('/api/me', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { account: unknown; mailAccounts: Array<{ id: string }>; calendars: Array<{ id: string }> };
    };
    expect(data.account).toEqual({ id: ACCOUNT, clerkUserId: USER, displayName: 'Pat Personal' });
    expect(data.mailAccounts.map((a) => a.id)).toEqual(['pma_mine']);
    expect(data.calendars).toEqual([{ id: 'pcal_mine', name: 'Home', color: '#ff0000', isDefault: true }]);
  });

  it.each([
    [{ fea: 'u:weldmail_pro' }, { plan: 'pro', dailySendLimit: 500, calendarPlan: 'free', maxCalendars: 1 }],
    [{ pla: 'u:weldcalendar_pro' }, { plan: 'free', calendarPlan: 'pro', maxCalendars: 10, maxBookingPages: 10 }],
    [{ pla: { u: [{ slug: 'u:pro' }] } }, { plan: 'pro' }],
    [{ public_metadata: { plans: ['weldcalendar_pro', 'weldmail_pro'] } }, { plan: 'pro', calendarPlan: 'pro' }],
    [{ publicMetadata: { plan: 'WELDMAIL_PRO' } }, { plan: 'pro', calendarPlan: 'free' }],
  ])('reads the plan from the session claims %j', async (claims, expected) => {
    const res = await app().request('/api/me', { headers: authHeaders(claims) });
    const { data } = (await res.json()) as { data: { entitlements: Record<string, unknown> } };
    expect(data.entitlements).toMatchObject(expected);
  });
});

describe('personal account required', () => {
  it('answers PERSONAL_ACCOUNT_REQUIRED before onboarding', async () => {
    const res = await app().request('/api/calendars', { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: 'PERSONAL_ACCOUNT_REQUIRED',
        message: 'Personal account required. Call POST /api/onboard first.',
      },
    });
  });
});

describe('/api/push-tokens', () => {
  beforeEach(async () => {
    await seedPersonalAccount(masterDb);
  });

  it('registers a device, then updates it in place', async () => {
    const target = app();
    const first = await target.request('/api/push-tokens', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: 'ExponentPushToken[aaa]', platform: 'ios', deviceId: 'device-1', osVersion: '18.1' }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { deviceId: 'device-1', platform: 'ios', registered: true } });

    const second = await target.request('/api/push-tokens', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        token: 'ExponentPushToken[bbb]',
        platform: 'ios',
        deviceId: 'device-1',
        tokenType: 'apns',
        appVersion: '2.0.0',
      }),
    });
    expect(second.status).toBe(200);

    const rows = await personalDb.select().from(personalSchema.personalDeviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      personalAccountId: ACCOUNT,
      clerkUserId: USER,
      token: 'ExponentPushToken[bbb]',
      tokenType: 'apns',
      appCode: 'weldmail',
      appVersion: '2.0.0',
      // Left out of the update: kept.
      osVersion: '18.1',
      isActive: null,
    });
  });

  it('keeps a token per app on one device', async () => {
    const target = app();
    for (const appCode of ['weldmail', 'weldcalendar']) {
      const res = await target.request('/api/push-tokens', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ token: `tok-${appCode}`, platform: 'android', deviceId: 'device-2', appCode }),
      });
      expect(res.status).toBe(200);
    }
    expect(await personalDb.select().from(personalSchema.personalDeviceTokens)).toHaveLength(2);
  });

  it('refuses a body that does not parse', async () => {
    const res = await app().request('/api/push-tokens', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: '', platform: 'windows', tokenType: 'sms', appCode: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: { name: 'ZodError' } });
  });

  it('deactivates a device', async () => {
    const target = app();
    await target.request('/api/push-tokens', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: 'tok', platform: 'web', deviceId: 'device-3' }),
    });
    const res = await target.request('/api/push-tokens?deviceId=device-3', { method: 'DELETE', headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deviceId: 'device-3', unregistered: true } });
    const [row] = await personalDb.select().from(personalSchema.personalDeviceTokens);
    expect(row?.isActive).toBeInstanceOf(Date);

    // A device nobody registered: nothing to do, same answer.
    const unknown = await target.request('/api/push-tokens?deviceId=nope', { method: 'DELETE', headers: authHeaders() });
    expect(unknown.status).toBe(200);
  });

  it('needs the device id to deactivate', async () => {
    const res = await app().request('/api/push-tokens', { method: 'DELETE', headers: authHeaders() });
    expect(res.status).toBe(400);
  });
});
