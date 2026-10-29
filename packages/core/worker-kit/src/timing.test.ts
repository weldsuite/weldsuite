import { afterEach, describe, expect, it, vi } from 'vitest';
import { neon, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import { createModuleApi } from './app';
import {
  COLD_START_THRESHOLD_MS,
  RequestTiming,
  instrumentNeonClient,
  timePermissionQueries,
} from './timing';

describe('RequestTiming', () => {
  it('sums each metric and reports the first tenant query on its own', () => {
    const timing = new RequestTiming(1_000);
    timing.noteWorkspaceCache('hit');
    timing.record('kv', 4);
    timing.record('db', 80);
    timing.record('db', 20);
    timing.record('perm', 15);

    expect(timing.summary(1_250)).toEqual({
      totalMs: 250,
      kvMs: 4,
      workspaceCache: 'hit',
      permMs: 15,
      permQueries: 1,
      dbMs: 100,
      dbQueries: 2,
      dbFirstMs: 80,
      coldStart: false,
    });
    expect(timing.serverTimingHeader(1_250)).toBe(
      'kv;dur=4;desc="hit", perm;dur=15;desc="1 query", db;dur=100;desc="2 queries", db-first;dur=80, total;dur=250',
    );
  });

  it('reports a permission-cache hit as "cached" instead of a query count', () => {
    const timing = new RequestTiming(0);
    timing.notePermissionsCache('hit');
    timing.record('perm', 3);
    expect(timing.summary(10)).toMatchObject({ permMs: 3, permQueries: 1, permCache: 'hit' });
    expect(timing.serverTimingHeader(10)).toContain('perm;dur=3;desc="cached"');
  });

  it('leaves the perm description as a query count on a cache miss', () => {
    const timing = new RequestTiming(0);
    timing.notePermissionsCache('miss');
    timing.record('perm', 15);
    expect(timing.summary(20)).toMatchObject({ permQueries: 1, permCache: 'miss' });
    expect(timing.serverTimingHeader(20)).toContain('perm;dur=15;desc="1 query"');
  });

  it('flags a slow first tenant query as a probable cold start', () => {
    const timing = new RequestTiming(0);
    timing.record('db', COLD_START_THRESHOLD_MS);
    timing.record('db', 5);
    expect(timing.summary(400).coldStart).toBe(true);
  });

  it('reports only the total for a request that touched no storage', () => {
    const timing = new RequestTiming(0);
    expect(timing.touchedStorage).toBe(false);
    expect(timing.summary(7)).toEqual({ totalMs: 7, coldStart: false });
    expect(timing.serverTimingHeader(7)).toBe('total;dur=7');
  });

  it('records a measured call that throws', async () => {
    const timing = new RequestTiming();
    await expect(timing.measure('master', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(timing.summary().masterMs).toBeGreaterThanOrEqual(0);
  });
});

describe('instrumentNeonClient', () => {
  const originalFetch = neonConfig.fetchFunction;
  afterEach(() => {
    neonConfig.fetchFunction = originalFetch;
  });

  /** Neon's HTTP endpoint, faked: answers a query or a batch with one row `{ n: 1 }` per query. */
  function fakeNeonHttp() {
    const calls: unknown[] = [];
    const result = {
      command: 'SELECT',
      rowCount: 1,
      rows: [['1']],
      fields: [{ name: 'n', dataTypeID: 23 }],
      rowAsArray: true,
    };
    neonConfig.fetchFunction = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { queries?: unknown[] };
      calls.push(body);
      const payload = body.queries ? { results: body.queries.map(() => result) } : result;
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    };
    return calls;
  }

  const url = 'postgresql://user:password@ep-test-123456.eu-central-1.aws.neon.tech/db';

  it('times every awaited query on a real Neon client behind Drizzle', async () => {
    const calls = fakeNeonHttp();
    const timing = new RequestTiming();
    const db = drizzle({ client: instrumentNeonClient(neon(url), timing) });

    const first = await db.execute(sql`select 1 as n`);
    await db.execute(sql`select 1 as n`);

    expect(first.rows).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(2);
    expect(timing.summary().dbQueries).toBe(2);
    expect(timing.summary().dbFirstMs).toBeGreaterThanOrEqual(0);
  });

  it('times a batch as one call and leaves its queries untimed', async () => {
    const calls = fakeNeonHttp();
    const timing = new RequestTiming();
    const db = drizzle({ client: instrumentNeonClient(neon(url), timing) });

    const results = await db.batch([db.execute(sql`select 1 as n`), db.execute(sql`select 1 as n`)]);

    expect(results).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(timing.summary().dbQueries).toBe(1);
  });

  it('leaves a client alone whose queries expose no execute function', async () => {
    const timing = new RequestTiming();
    const client = {
      query: () => Promise.resolve('row'),
      transaction: () => Promise.resolve(['row']),
    };
    instrumentNeonClient(client, timing);
    await expect(client.query()).resolves.toBe('row');
    expect(timing.touchedStorage).toBe(false);
  });
});

describe('timePermissionQueries', () => {
  it('records each lookup as perm and passes the results through', async () => {
    const timing = new RequestTiming();
    const queries = timePermissionQueries(
      {
        getMember: async () => ({ id: 'mem_1', role: 'MEMBER', roleId: 'role_1', permissions: null }),
        getRolePermissions: async () => ['weldmail:messages:read'],
        getTeamPermissions: async () => [],
      },
      timing,
    );

    expect((await queries.getMember('user_1'))?.id).toBe('mem_1');
    expect(await queries.getRolePermissions('role_1')).toEqual(['weldmail:messages:read']);
    expect(timing.summary().permQueries).toBe(2);
  });

  it('returns the queries unchanged without a timing', () => {
    const queries = {
      getMember: async () => null,
      getRolePermissions: async () => null,
      getTeamPermissions: async () => [],
    };
    expect(timePermissionQueries(queries, undefined)).toBe(queries);
  });
});

describe('requestTiming middleware', () => {
  const env = { ENVIRONMENT: 'test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds Server-Timing, and Timing-Allow-Origin for a first-party origin', async () => {
    const app = createModuleApi({ service: 'mail-api' });
    app.get('/api/ping', (c) => c.json({ ok: true }));

    const res = await app.request('/api/ping', { headers: { Origin: 'https://app.weldsuite.org' } }, env);

    expect(res.headers.get('Server-Timing')).toMatch(/^total;dur=\d+$/);
    expect(res.headers.get('Timing-Allow-Origin')).toBe('https://app.weldsuite.org');
  });

  it('does not open timing to an unknown origin', async () => {
    const app = createModuleApi({ service: 'mail-api' });
    app.get('/api/ping', (c) => c.json({ ok: true }));

    const res = await app.request('/api/ping', { headers: { Origin: 'https://evil.example' } }, env);

    expect(res.headers.get('Server-Timing')).not.toBeNull();
    expect(res.headers.get('Timing-Allow-Origin')).toBeNull();
  });

  it('logs one line with the route pattern for a request that reached storage', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createModuleApi({ service: 'mail-api' });
    app.get('/api/mail-labels/:id', (c) => {
      c.get('timing')?.record('db', 12);
      return c.json({ ok: true });
    });

    const res = await app.request('/api/mail-labels/lbl_1', {}, env);

    expect(res.headers.get('Server-Timing')).toContain('db;dur=12;desc="1 query"');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      message: 'request timing',
      service: 'mail-api',
      method: 'GET',
      route: '/api/mail-labels/:id',
      status: 200,
      dbMs: 12,
      dbQueries: 1,
      coldStart: false,
    });
  });

  it('logs nothing for a request that touched no storage', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createModuleApi({ service: 'mail-api' });
    app.get('/api/ping', (c) => c.json({ ok: true }));

    await app.request('/api/ping', {}, env);

    expect(info).not.toHaveBeenCalled();
  });
});
