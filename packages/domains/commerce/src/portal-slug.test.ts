import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getMasterDb: vi.fn(),
  getTenantDbForWorkspace: vi.fn(),
}));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: mocks.getMasterDb, getTenantDbForWorkspace: mocks.getTenantDbForWorkspace };
});

import {
  commercePortalSlugMiddleware,
  normalizePortalSlug,
  PORTAL_SLUG_PATTERN,
  readPortalSlug,
  type PortalSlugContext,
} from './portal-slug';

const dialect = new PgDialect();

interface MasterQuery {
  sql: string;
  params: unknown[];
}

type WorkspaceRow = { id: string; clerkOrgId: string | null; isActive: boolean };

/** A master DB whose queries are recorded as rendered SQL; every query answers with `rows`. */
function fakeMasterDb(rows: WorkspaceRow[]) {
  const queries: MasterQuery[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => ({
          limit: async () => {
            queries.push(dialect.sqlToQuery(condition));
            return rows;
          },
        }),
      }),
    }),
  };
  mocks.getMasterDb.mockReturnValue(db);
  return queries;
}

class FakeKv {
  store = new Map<string, string>();
  ttls = new Map<string, number | undefined>();
  reads = 0;
  async get(key: string, type?: string) {
    this.reads += 1;
    const raw = this.store.get(key);
    if (raw == null) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.store.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }
}

function makeContext(opts: { query?: string; header?: string; tenantDb?: unknown; kv?: FakeKv }) {
  const kv = opts.kv ?? new FakeKv();
  const values: Record<string, unknown> = {};
  let response: { body: unknown; status: number } | undefined;
  const c = {
    req: {
      query: (key: string) => (key === 'slug' ? opts.query : undefined),
      header: (name: string) => (name === 'X-Workspace-Slug' ? opts.header : undefined),
    },
    env: { WORKSPACE_CACHE: kv, DATABASE_URL_MASTER: 'postgres://test', NEON_API_KEY: 'test' },
    get: (key: string) => (key === 'tenantDb' ? opts.tenantDb : undefined),
    set: (key: string, value: unknown) => {
      values[key] = value;
    },
    json: (body: unknown, status: number) => {
      response = { body, status };
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as PortalSlugContext;
  return { c, kv, values, response: () => response };
}

async function run(opts: Parameters<typeof makeContext>[0]) {
  const ctx = makeContext(opts);
  const next = vi.fn(async () => {});
  const result = await commercePortalSlugMiddleware()(ctx.c, next);
  return { ...ctx, next, result };
}

beforeEach(() => {
  mocks.getMasterDb.mockReset();
  mocks.getTenantDbForWorkspace.mockReset();
  mocks.getTenantDbForWorkspace.mockResolvedValue({ tenant: true });
});

describe('normalizePortalSlug', () => {
  it.each([
    ['acme', 'acme'],
    ['acme-corp', 'acme-corp'],
    ['acme-corp-1704067200', 'acme-corp-1704067200'],
    ['a1', 'a1'],
    ['  ACME  ', 'acme'],
    ['x'.repeat(100), 'x'.repeat(100)],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizePortalSlug(raw)).toBe(expected);
  });

  it.each([
    ['%'],
    ['a%'],
    ['%a'],
    ['_'],
    ['ac_me'],
    ['acme\\'],
    ['\\%'],
    ['acme%25'],
    ['acme corp'],
    ['acme.org'],
    ['acme/corp'],
    ['acme?x=1'],
    ["acme'--"],
    ['ac\nme'],
    ['acme\u0000'],
    ['ünïcode'],
    ['ａｃｍｅ'],
    ['x'.repeat(101)],
    [''],
    ['   '],
  ])('rejects %j', (raw) => {
    expect(normalizePortalSlug(raw)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(normalizePortalSlug(undefined)).toBeNull();
    expect(normalizePortalSlug(null)).toBeNull();
  });

  it('never accepts a LIKE metacharacter, whatever the other characters are', () => {
    expect(PORTAL_SLUG_PATTERN.test('abc%')).toBe(false);
    for (const ch of ['%', '_', '\\']) {
      expect(normalizePortalSlug(`acme${ch}`)).toBeNull();
      expect(normalizePortalSlug(`${ch}acme`)).toBeNull();
      expect(normalizePortalSlug(`ac${ch}me`)).toBeNull();
    }
  });
});

describe('readPortalSlug', () => {
  it('prefers the query, falls back to the header, and validates either', () => {
    const q = (query?: string, header?: string) =>
      readPortalSlug(makeContext({ query, header }).c);
    expect(q('Acme', 'other')).toBe('acme');
    expect(q(undefined, 'Acme')).toBe('acme');
    expect(q('%', 'acme')).toBeNull();
    expect(q(undefined, undefined)).toBeNull();
  });
});

describe('commercePortalSlugMiddleware', () => {
  it('skips resolution when a tenant DB was already injected (test harness)', async () => {
    const { next, result } = await run({ query: '%', tenantDb: {} });
    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.getMasterDb).not.toHaveBeenCalled();
  });

  it('answers 400 when the slug is missing', async () => {
    const { next, response } = await run({});
    expect(response()?.status).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.getMasterDb).not.toHaveBeenCalled();
  });

  it.each(['%', 'a%', '%25', '_', 'ac_me', 'a\\b', 'acme corp', 'x'.repeat(101), '../acme'])(
    'rejects the slug %j with 400 before it reaches the cache or the master DB',
    async (slug) => {
      const kv = new FakeKv();
      const { next, response } = await run({ query: slug, kv });
      expect(response()?.status).toBe(400);
      expect(next).not.toHaveBeenCalled();
      expect(kv.reads).toBe(0);
      expect(mocks.getMasterDb).not.toHaveBeenCalled();
    },
  );

  it('also rejects an invalid slug in the header', async () => {
    const { response } = await run({ header: 'a%' });
    expect(response()?.status).toBe(400);
    expect(mocks.getMasterDb).not.toHaveBeenCalled();
  });

  it('resolves a known slug with ONE exact-match query (no LIKE) and caches the result', async () => {
    const queries = fakeMasterDb([{ id: 'ws_1', clerkOrgId: 'org_1', isActive: true }]);
    const { next, values, kv } = await run({ query: 'acme' });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/"slug" = \$1/);
    expect(queries[0]!.sql.toLowerCase()).not.toContain('like');
    expect(queries[0]!.params).toEqual(['acme']);

    expect(next).toHaveBeenCalledTimes(1);
    expect(values).toMatchObject({ workspaceId: 'ws_1', orgId: 'org_1', tenantDb: { tenant: true } });
    expect(mocks.getTenantDbForWorkspace).toHaveBeenCalledWith(expect.anything(), 'org_1');
    expect(JSON.parse(kv.store.get('cportal:slug:acme')!)).toEqual({ workspaceId: 'ws_1', clerkOrgId: 'org_1' });
    expect(kv.ttls.get('cportal:slug:acme')).toBe(300);
  });

  it('normalizes case and whitespace, so the cache key and the lookup agree', async () => {
    const queries = fakeMasterDb([{ id: 'ws_1', clerkOrgId: 'org_1', isActive: true }]);
    const { kv } = await run({ query: '  AcMe ' });
    expect(queries[0]!.params).toEqual(['acme']);
    expect([...kv.store.keys()]).toEqual(['cportal:slug:acme']);
  });

  it('reads the slug from X-Workspace-Slug when there is no query parameter', async () => {
    const queries = fakeMasterDb([{ id: 'ws_1', clerkOrgId: 'org_1', isActive: true }]);
    await run({ header: 'acme' });
    expect(queries[0]!.params).toEqual(['acme']);
  });

  it('does NOT fall back to a prefix match: an unknown slug is a 404 after a single query', async () => {
    // Another tenant, "acme-corp", exists. The old fallback ("acme-%") would have answered with it.
    const queries = fakeMasterDb([]);
    const { next, response } = await run({ query: 'acme' });
    expect(queries).toHaveLength(1);
    expect(response()?.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.getTenantDbForWorkspace).not.toHaveBeenCalled();
  });

  it('answers 404 for an inactive workspace or one without a Clerk org, and does not cache the miss', async () => {
    fakeMasterDb([{ id: 'ws_1', clerkOrgId: 'org_1', isActive: false }]);
    const inactive = await run({ query: 'acme' });
    expect(inactive.response()?.status).toBe(404);
    expect(inactive.kv.store.size).toBe(0);

    fakeMasterDb([{ id: 'ws_1', clerkOrgId: null, isActive: true }]);
    const noOrg = await run({ query: 'acme' });
    expect(noOrg.response()?.status).toBe(404);
  });

  it('serves a cached slug without touching the master DB', async () => {
    const kv = new FakeKv();
    await kv.put('cportal:slug:acme', JSON.stringify({ workspaceId: 'ws_9', clerkOrgId: 'org_9' }));
    const { next, values } = await run({ query: 'ACME', kv });
    expect(mocks.getMasterDb).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(values).toMatchObject({ workspaceId: 'ws_9', orgId: 'org_9' });
  });

  it('answers 500 when the lookup throws', async () => {
    mocks.getMasterDb.mockImplementation(() => {
      throw new Error('db down');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { response, next } = await run({ query: 'acme' });
    expect(response()?.status).toBe(500);
    expect(next).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
