/**
 * Domain search and availability on pglite, through Realtime Register's
 * ADAC checker or (on OTE) its REST check, stubbed by URL
 * (../test/provider-stub.ts), and priced from the master `domain_pricing`:
 * catalog prices, markup by amount or percentage, premium wholesale prices
 * and the currency fallback.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { CF_ENV, RTR_ENV, createProviderFetchStub } from '../test/provider-stub';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { domainsRoutes } from './domains';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  vi.stubGlobal('fetch', createProviderFetchStub());
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  const price = (id: string, tld: string, registrationPrice: string, extra: Record<string, unknown> = {}) => ({
    id,
    tld,
    registrationPrice,
    renewalPrice: registrationPrice,
    transferPrice: registrationPrice,
    currency: 'USD',
    ...extra,
  });
  await master.insert(masterSchema.hostDomainPricing).values([
    price('dp_com', 'com', '10.00', { markupPercent: '10.00' }),
    price('dp_net', '.NET', '12.50', { markupAmount: 200 }),
    price('dp_io', 'io', '40.00'),
    price('dp_org', 'org', '9.99', { currency: 'EUR' }),
    price('dp_dev', 'dev', '15.00'),
    price('dp_off', 'xyz', '1.00', { isActive: false }),
  ]);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

function api(env: Record<string, unknown>) {
  return createTestApp('/api/domains', domainsRoutes, {
    context: { permissions: permissions('*'), tenantDb: db, masterDb: master },
    env: env as never,
  });
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const domains = (env: Record<string, unknown> = { ...RTR_ENV, ...CF_ENV }) => api(env).request;

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

// Search and availability
// ---------------------------------------------------------------------------

describe('domains: search and availability', () => {
  type Result = { domain: string; price: number | null; currency: string; available: boolean; reason?: string };

  it('searches the typed name across ADAC’s TLD set, priced with markup', async () => {
    const res = await domains()('/api/domains/search?q=weldsite');
    expect(res.status).toBe(200);
    const results = await data<Result[]>(res);
    expect(results.map((r) => r.domain)).toEqual(['weldsite.com', 'weldsite.net', 'weldsite.org', 'weldsite.io']);
    expect(results[0]).toMatchObject({ price: 1100, currency: 'USD', available: true });
    expect(results[1]!.price).toBe(1450);
  });

  it('pins a typed name, honours the limit, and keeps taken and premium names', async () => {
    const request = domains();
    const pinned = await data<Result[]>(await request('/api/domains/search?q=https://www.Premium-Pick.io'));
    expect(pinned[0]!.domain).toBe('premium-pick.io');
    const limited = await data<Result[]>(await request('/api/domains/search?q=taken-name&limit=2'));
    expect(limited).toHaveLength(2);
    expect(limited[0]).toMatchObject({ available: false, reason: 'domain_unavailable' });
    expect((await request('/api/domains/search?q=...')).status).toBe(200);
  });

  it('maps ADAC failures', async () => {
    const request = domains();
    expect((await request('/api/domains/search?q=adacerror')).status).toBe(400);
    const down = await request('/api/domains/search?q=adacdown');
    expect(down.status).toBe(502);
  });

  it('checks names one by one on OTE, priced TLDs first', async () => {
    const env = { ...RTR_ENV, REALTIME_REGISTER_ADAC_API_KEY: undefined, REALTIME_REGISTER_OTE: ' TRUE ' };
    const request = api(env).request;
    const results = await data<Result[]>(await request('/api/domains/search?q=otename'));
    expect(results.map((r) => r.domain)).toEqual(['otename.com', 'otename.net', 'otename.org', 'otename.io', 'otename.dev']);
    const typed = await data<Result[]>(await request('/api/domains/search?q=otename.shop&limit=3'));
    expect(typed.map((r) => r.domain)).toEqual(['otename.shop', 'otename.com', 'otename.net']);
    const checked = await data<Result[]>(
      await request('/api/domains/check', send('POST', { domains: ['boom-name.com', ' Premium-X.io ', 'taken-x.com', 'Fine.org'] })),
    );
    expect(checked.map((r) => r.reason ?? 'ok')).toEqual(['check_failed', 'ok', 'domain_unavailable', 'ok']);
    expect(checked[1]!.price).toBe(125000);
    // a premium price in another currency than the catalog falls back to it
    expect(checked[3]).toMatchObject({ price: 999, currency: 'EUR' });
  });

  it('checks names through ADAC', async () => {
    const results = await data<Result[]>(
      await domains()('/api/domains/check', send('POST', { domains: ['free-name.com', 'taken-name.com', 'premium-name.net', 'broken-name.org', 'unpriced.zz'] })),
    );
    expect(results.map((r) => [r.domain, r.available, r.reason ?? null, r.price])).toEqual([
      ['free-name.com', true, null, 1100],
      ['taken-name.com', false, 'domain_unavailable', 1100],
      ['premium-name.net', true, null, 99200],
      ['broken-name.org', false, 'check_failed', 999],
      ['unpriced.zz', true, null, null],
    ]);
  });
});

