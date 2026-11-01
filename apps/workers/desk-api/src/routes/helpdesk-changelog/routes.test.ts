/**
 * GET /api/helpdesk-changelog on pglite: both pagination modes (cursor by
 * release date, and the numbered `page`/`pageSize` pager), the clamped and
 * unparsable limits, and the status/type/search filters. Runs against Rust in
 * conformance mode.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskChangelogRoutes } from './index';

const BASE = '/api/helpdesk-changelog';

interface Page {
  data: Array<Record<string, unknown>>;
  pagination: Record<string, unknown>;
}

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskChangelogRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

async function list(query = ''): Promise<Page> {
  const res = await app('articles:read').request(`${BASE}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

const ids = (page: Page) => page.data.map((r) => r.id);
const ALL = ['chl_06', 'chl_05', 'chl_04', 'chl_03', 'chl_02', 'chl_01'];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = new Date(Date.UTC(2025, 11, 1));
  const entry = (
    id: string,
    version: string,
    title: string,
    description: string,
    releaseDate: Date,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    version,
    title,
    description,
    releaseDate,
    status: 'published',
    type: 'feature',
    authorId: 'user_a',
    createdAt: created,
    updatedAt: created,
    ...extra,
  });
  const day = (month: number, date: number) => new Date(Date.UTC(2026, month, date));
  await db.insert(schema.helpdeskChangelog).values([
    entry('chl_01', '1.0.0', 'Initial release', 'First version', day(0, 1), {
      authorName: 'Ada',
      changes: [{ id: 'c1', type: 'feature', description: 'Everything' }],
    }),
    entry('chl_02', '1.1.0', 'Faster search', 'Search is quicker', day(1, 1), { type: 'improvement' }),
    entry('chl_03', '1.1.1', 'Fix Login bug', 'Login works again', day(1, 15), { type: 'bugfix' }),
    entry('chl_04', '1.2.0', 'Draft notes', 'Not out yet', day(2, 1), { status: 'draft' }),
    // Two entries released together: the id breaks the tie.
    entry('chl_05', '1.2.1', 'Tie A', 'Same day', day(2, 10), { type: 'bugfix' }),
    entry('chl_06', '1.2.2', 'Tie B', 'Same day', day(2, 10), { type: 'security' }),
    entry('chl_07', '1.3.0', 'Deleted Needle', 'Gone', day(3, 1), { deletedAt: day(3, 2) }),
  ]);
}, 60_000);

describe('GET /api/helpdesk-changelog · cursor mode', () => {
  it('lists live entries, newest release first, with the plain pagination', async () => {
    const page = await list();
    expect(ids(page)).toEqual(ALL);
    expect(page.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
    expect(page.data.at(-1)).toMatchObject({
      version: '1.0.0',
      title: 'Initial release',
      status: 'published',
      type: 'feature',
      authorName: 'Ada',
      changes: [{ id: 'c1', type: 'feature', description: 'Everything' }],
      deletedAt: null,
      releaseDate: '2026-01-01T00:00:00.000Z',
    });
  });

  it('pages by release date and id; the count ignores the cursor', async () => {
    const first = await list('?limit=2');
    expect(ids(first)).toEqual(['chl_06', 'chl_05']);
    expect(first.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'chl_05' });
    const second = await list('?limit=2&cursor=chl_05');
    expect(ids(second)).toEqual(['chl_04', 'chl_03']);
    expect(second.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'chl_03' });
    const last = await list('?limit=2&cursor=chl_03');
    expect(ids(last)).toEqual(['chl_02', 'chl_01']);
    expect(last.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('an unknown or empty cursor is no window; a deleted entry still works as one', async () => {
    const unknown = await list('?cursor=nope_missing');
    expect(ids(unknown)).toEqual(ALL);
    expect(unknown.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
    expect(ids(await list('?cursor='))).toEqual(ALL);
    expect(ids(await list('?cursor=chl_07'))).toEqual(ALL);
    expect(ids(await list('?cursor=chl_04&status=published'))).toEqual(['chl_03', 'chl_02', 'chl_01']);
  });

  it('clamps the limit to 1..100; one that is not a number has no LIMIT', async () => {
    const zero = await list('?limit=0');
    expect(ids(zero)).toEqual(['chl_06']);
    expect(zero.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'chl_06' });
    expect(ids(await list('?limit=-5'))).toEqual(['chl_06']);
    expect(ids(await list('?limit=500'))).toEqual(ALL);
    const nan = await list('?limit=abc');
    expect(ids(nan)).toEqual(ALL);
    expect(nan.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('filters by status and type (`all` is no filter) and searches title, version and description', async () => {
    const published = await list('?status=published');
    expect(ids(published)).toEqual(['chl_06', 'chl_05', 'chl_03', 'chl_02', 'chl_01']);
    expect(published.pagination.totalCount).toBe(5);
    expect(ids(await list('?status=all'))).toEqual(ALL);
    expect(ids(await list('?type=bugfix'))).toEqual(['chl_05', 'chl_03']);
    expect(ids(await list('?type=all&status=all'))).toEqual(ALL);
    expect(ids(await list('?status=draft&type=feature'))).toEqual(['chl_04']);
    expect(ids(await list('?search=1.1'))).toEqual(['chl_03', 'chl_02']);
    expect(ids(await list('?search=quicker'))).toEqual(['chl_02']);
    // LIKE: case-sensitive.
    expect(ids(await list('?search=Login'))).toEqual(['chl_03']);
    expect(ids(await list('?search=login'))).toEqual([]);
    expect(ids(await list('?search=Needle'))).toEqual([]);
  });
});

describe('GET /api/helpdesk-changelog · offset mode', () => {
  it('a valid page switches to the numbered pager, pageSize defaulting to the limit', async () => {
    const first = await list('?page=1&limit=2');
    expect(ids(first)).toEqual(['chl_06', 'chl_05']);
    expect(first.pagination).toEqual({
      totalCount: 6,
      hasMore: true,
      cursor: 'chl_05',
      page: 1,
      pageSize: 2,
      totalPages: 3,
    });
    const last = await list('?page=3&limit=2');
    expect(ids(last)).toEqual(['chl_02', 'chl_01']);
    expect(last.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null, page: 3, pageSize: 2, totalPages: 3 });
    const defaults = await list('?page=1');
    expect(ids(defaults)).toEqual(ALL);
    expect(defaults.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null, page: 1, pageSize: 25, totalPages: 1 });
  });

  it('pageSize wins over limit and is clamped to 1..100', async () => {
    expect((await list('?page=2&pageSize=4&limit=2')).pagination).toEqual({
      totalCount: 6,
      hasMore: false,
      cursor: null,
      page: 2,
      pageSize: 4,
      totalPages: 2,
    });
    const one = await list('?page=1&pageSize=0');
    expect(ids(one)).toEqual(['chl_06']);
    expect(one.pagination).toMatchObject({ hasMore: true, cursor: 'chl_06', pageSize: 1, totalPages: 6 });
    expect((await list('?page=1&pageSize=500')).pagination).toMatchObject({ pageSize: 100, totalPages: 1 });
    expect((await list('?page=1&pageSize=abc&limit=3')).pagination).toMatchObject({ pageSize: 3, totalPages: 2 });
  });

  it('a page below 1 is page 1; one past the end is empty', async () => {
    expect((await list('?page=0&limit=2')).pagination).toMatchObject({ page: 1, cursor: 'chl_05' });
    expect((await list('?page=-3&limit=2')).pagination).toMatchObject({ page: 1 });
    const past = await list('?page=99&limit=2');
    expect(past.data).toEqual([]);
    expect(past.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null, page: 99, pageSize: 2, totalPages: 3 });
  });

  it('a page that is not a number, or any cursor, keeps the cursor mode', async () => {
    expect((await list('?page=abc&limit=2')).pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'chl_05' });
    expect((await list('?page=2&limit=2&cursor=chl_05')).pagination).toEqual({
      totalCount: 6,
      hasMore: true,
      cursor: 'chl_03',
    });
    const emptyCursor = await list('?page=2&limit=2&cursor=');
    expect(ids(emptyCursor)).toEqual(['chl_06', 'chl_05']);
    expect(emptyCursor.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'chl_05' });
  });

  it('filters count in offset mode too', async () => {
    expect((await list('?page=1&limit=2&status=published')).pagination).toEqual({
      totalCount: 5,
      hasMore: true,
      cursor: 'chl_05',
      page: 1,
      pageSize: 2,
      totalPages: 3,
    });
  });

  it('a limit that is not a number leaves pageSize and totalPages null (NaN) and reads every row', async () => {
    const page = await list('?page=1&limit=abc');
    expect(ids(page)).toEqual(ALL);
    expect(page.pagination).toEqual({
      totalCount: 6,
      hasMore: false,
      cursor: null,
      page: 1,
      pageSize: null,
      totalPages: null,
    });
  });
});

describe('GET /api/helpdesk-changelog · permission', () => {
  it('needs articles:read', async () => {
    expect((await app().request(BASE)).status).toBe(403);
    expect((await app('tickets:read').request(BASE)).status).toBe(403);
  });
});
