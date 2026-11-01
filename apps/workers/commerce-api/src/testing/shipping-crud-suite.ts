/**
 * The route tests the plain CRUD route files of this worker share (carriers,
 * return-reasons, return-rules, pickups, returns, shipments, shipping-rules,
 * shipping-prices, parcels): list (empty, order, paging, filters, a cursor
 * whose row is gone, odd limits), detail, create, update and soft delete,
 * with their refusals (403, 400, 404) and the entity events they publish.
 *
 * On pglite, so the same tests run against the Rust backend in conformance
 * mode (rust/conformance/suites.json, "commerce: shipping"). Each test file
 * calls `describeShippingCrud` once and gets its own database.
 *
 * The test file must wrap `publishEntityEvent` in a spy that still calls the
 * real publisher (so conformance mode keeps recording the events):
 *
 *   vi.mock('@weldsuite/entity-events', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
 *     return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
 *   });
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';

type Row = Record<string, unknown>;

/** A body and what it leaves behind. */
interface Write {
  body: Row;
  /** Columns the stored row then has (a subset). */
  stored: Row;
  /** The entity event's `data`, without its `id`. */
  event: Row;
}

export interface ShippingCrudSuite {
  /** `/api/carriers`. */
  base: string;
  routes: Hono<{ Bindings: Env; Variables: Variables }>;
  /** The Drizzle table, soft-deleted through `deletedAt`. */
  table: PgTable & { id: AnyPgColumn; deletedAt: AnyPgColumn };
  gates: { read: string; create: string; update: string; delete: string };
  /** The resource `error.notFound` names (`Carrier`). */
  resource: string;
  /** The noun of the route's 500 messages (`Failed to list carriers`, `Failed to create carrier`). */
  noun: { one: string; many: string };
  /** `generateId`'s prefix for new rows (`crr`). */
  idPrefix: string;
  entityType: string;
  /** A row to seed: every NOT NULL column without a default. */
  seed: (n: number) => Row;
  /** Part of what `GET /:id` answers for seed 1 (defaults and nulls included). */
  detail: Row;
  /** A body `POST /` stores (201); absent when the table can never take one from the schema. */
  valid?: Write;
  /** Bodies the schema accepts that the table can't store: the route's 500. */
  unstorable: Row[];
  /** Bodies the schema refuses (400). */
  invalid: Row[];
  /** What `POST /` answers for a body sent without a JSON content type (read as `{}`). */
  emptyBodyStatus: 201 | 400 | 500;
  /** `PATCH /:id` on a seeded row, with that row's own columns (`target`). */
  patch: Write & { target?: Row };
  /** A body `.partial()` refuses (400). */
  invalidPatch: Row;
  /** List filters: the query, and the seed overrides of the one row it matches. */
  filters: Array<{ query: string; match: Row }>;
  /** Queries that match no row (`search` is a case-sensitive LIKE). */
  misses?: string[];
  /**
   * What `totalCount` is when the cursor row is gone. Most of these lists
   * drop the last WHERE condition from the count whenever a cursor is given
   * (`conditions.slice(0, -1)`), assuming it was the cursor's: with no
   * cursor row that is the last filter, or `deletedAt IS NULL` without one.
   * Parcels builds its count from the filters alone.
   */
  goneCursorCount: 'drops-last-condition' | 'filters';
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type Page = { data: Row[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };

/** What a route file's own tests (run after the suite's, on its rows) use. */
export interface ShippingCrudContext {
  app: (...keys: string[]) => ReturnType<typeof createTestApp<Env, Variables>>;
  json: (body: unknown, method?: string) => RequestInit;
  /** The row as stored. */
  row: (id: string) => Promise<Row | undefined>;
  /** The row as `GET /:id` answers it. */
  detailOf: (id: string) => Promise<Row>;
  /** The entity events published since the last `clearEvents()`. */
  published: () => Array<{ entityType: string; action: string; entityId: string; data: unknown }>;
  clearEvents: () => void;
  /** Seed row `n` (1 is left untouched by the suite's tests). */
  seedId: (n: number) => string;
}

/** The tests for one route file. */
export function describeShippingCrud(suite: ShippingCrudSuite): ShippingCrudContext {
  const t = suite.table;
  const p = suite.idPrefix;
  const events = vi.mocked(publishEntityEvent);
  let db: Database;

  const app = (...keys: string[]) =>
    createTestApp(suite.base, suite.routes, { context: { permissions: permissions(...keys), tenantDb: db } });
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));
  const row = async (id: string) => (await db.select().from(t).where(eq(t.id, id)).limit(1))[0] as Row | undefined;
  /** The row as `GET /:id` answers it. */
  const detailOf = async (id: string) => {
    const res = await app(suite.gates.read).request(`${suite.base}/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Row }).data;
  };
  const ids = (page: Page) => page.data.map((r) => r.id);
  const published = () =>
    events.mock.calls.map(([params]) => ({
      entityType: params.entityType,
      action: params.action,
      entityId: params.entityId,
      data: params.data,
    }));

  // The seeded rows, by id; `live` is the list order (newest first, ties on id).
  const id = {
    seed: (n: number) => `${p}_seed${n}`,
    filter: (i: number) => `${p}_filter${i}`,
    tieA: `${p}_tie_a`,
    tieB: `${p}_tie_b`,
    gone: `${p}_gone`,
    patch: `${p}_patch`,
    del: `${p}_del`,
  };
  const live = [
    id.tieB,
    id.tieA,
    ...suite.filters.map((_, i) => id.filter(i)).reverse(),
    id.del,
    id.patch,
    id.seed(4),
    id.seed(3),
    id.seed(2),
    id.seed(1),
  ];

  async function seed(rowId: string, n: number, overrides: Row = {}, createdAt = at(n)): Promise<void> {
    await db
      .insert(t)
      .values({ ...suite.seed(n), id: rowId, createdAt, updatedAt: createdAt, ...overrides } as never);
  }

  describe(`${suite.base} · routes`, () => {
    beforeAll(async () => {
      db = (await createPgliteDb()).db;
    }, 60_000);

    beforeEach(() => {
      events.mockClear();
    });

    it('GET / answers an empty page on an empty table', async () => {
      const res = await app(suite.gates.read).request(suite.base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
    });

    describe('with rows', () => {
      beforeAll(async () => {
        for (let n = 1; n <= 4; n++) await seed(id.seed(n), n);
        await seed(id.gone, 5, { deletedAt: at(30) });
        await seed(id.patch, 6, suite.patch.target ?? {});
        await seed(id.del, 7);
        for (const [i, filter] of suite.filters.entries()) await seed(id.filter(i), 10 + i, filter.match);
        // Two rows sharing a creation time: the id breaks the tie.
        const tie = new Date(Date.UTC(2026, 0, 2));
        await seed(id.tieA, 20, {}, tie);
        await seed(id.tieB, 21, {}, tie);
      });

      it('GET / lists the live rows newest first, ties broken on id, with the count', async () => {
        const res = await app(suite.gates.read).request(suite.base);
        expect(res.status).toBe(200);
        const page = (await res.json()) as Page;
        expect(ids(page)).toEqual(live);
        expect(page.pagination).toEqual({ totalCount: live.length, hasMore: false, cursor: null });
      });

      it('GET / pages with limit and cursor; the count ignores the cursor', async () => {
        const { request } = app(suite.gates.read);
        const seen: unknown[] = [];
        let query = '?limit=3';
        for (let i = 0; i < 10; i++) {
          const res = await request(`${suite.base}${query}`);
          expect(res.status).toBe(200);
          const page = (await res.json()) as Page;
          expect(page.pagination.totalCount).toBe(live.length);
          seen.push(...ids(page));
          expect(page.pagination.cursor).toBe(page.pagination.hasMore ? seen.at(-1) : null);
          if (!page.pagination.hasMore) break;
          query = `?limit=3&cursor=${page.pagination.cursor}`;
        }
        expect(seen).toEqual(live);
      });

      it('GET / resumes after a soft-deleted cursor row', async () => {
        const res = await app(suite.gates.read).request(`${suite.base}?cursor=${id.gone}`);
        const page = (await res.json()) as Page;
        expect(ids(page)).toEqual([id.seed(4), id.seed(3), id.seed(2), id.seed(1)]);
        expect(page.pagination.totalCount).toBe(live.length);
      });

      it('GET / with a cursor whose row is gone lists from the top', async () => {
        const { request } = app(suite.gates.read);
        const dropsLast = suite.goneCursorCount === 'drops-last-condition';
        const page = (await (await request(`${suite.base}?cursor=nope_missing`)).json()) as Page;
        expect(ids(page)).toEqual(live);
        // Without the `deletedAt IS NULL` condition the soft-deleted row is counted too.
        expect(page.pagination.totalCount).toBe(dropsLast ? live.length + 1 : live.length);
        for (const [i, filter] of suite.filters.entries()) {
          const filtered = (await (await request(`${suite.base}?${filter.query}&cursor=nope_missing`)).json()) as Page;
          expect(ids(filtered), filter.query).toEqual([id.filter(i)]);
          expect(filtered.pagination.totalCount, filter.query).toBe(dropsLast ? live.length : 1);
        }
      });

      it('GET / limit edge cases follow JavaScript', async () => {
        const { request } = app(suite.gates.read);
        const page = async (limit: string) => (await (await request(`${suite.base}?limit=${limit}`)).json()) as Page;
        const total = live.length;
        // limit + 1 = 1 row fetched, none answered, but "more".
        expect(await page('0')).toEqual({ data: [], pagination: { totalCount: total, hasMore: true, cursor: null } });
        // LIMIT 0.
        expect(await page('-1')).toEqual({ data: [], pagination: { totalCount: total, hasMore: true, cursor: null } });
        // A negative LIMIT is left out, and slice(0, -2) drops the last two rows.
        const minusTwo = await page('-2');
        expect(ids(minusTwo)).toEqual(live.slice(0, -2));
        expect(minusTwo.pagination).toEqual({ totalCount: total, hasMore: true, cursor: live.at(-3) });
        // NaN: no LIMIT, and `rows.length > NaN` is false.
        const notANumber = await page('abc');
        expect(ids(notANumber)).toEqual(live);
        expect(notANumber.pagination).toEqual({ totalCount: total, hasMore: false, cursor: null });
        // parseInt: 2.9 is 2; anything above 100 is 100.
        const fraction = await page('2.9');
        expect(ids(fraction)).toEqual(live.slice(0, 2));
        expect(fraction.pagination.cursor).toBe(live[1]);
        expect(ids(await page('500'))).toEqual(live);
      });

      it('GET / filters; an empty filter value is no filter', async () => {
        const { request } = app(suite.gates.read);
        for (const [i, filter] of suite.filters.entries()) {
          const page = (await (await request(`${suite.base}?${filter.query}`)).json()) as Page;
          expect(ids(page), filter.query).toEqual([id.filter(i)]);
          expect(page.pagination.totalCount, filter.query).toBe(1);
          const empty = (await (await request(`${suite.base}?${filter.query.split('=')[0]}=`)).json()) as Page;
          expect(ids(empty), `${filter.query} (empty)`).toEqual(live);
        }
        for (const miss of suite.misses ?? []) {
          const page = (await (await request(`${suite.base}?${miss}`)).json()) as Page;
          expect(page, miss).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
        }
      });

      it('GET / needs the read permission', async () => {
        expect((await app(suite.gates.create).request(suite.base)).status).toBe(403);
      });

      it('GET /:id answers the row; 404 when missing or deleted; 403 without read', async () => {
        const { request } = app(suite.gates.read);
        const res = await request(`${suite.base}/${id.seed(1)}`);
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { data: Row };
        expect(data).toMatchObject({
          ...suite.detail,
          id: id.seed(1),
          createdAt: '2026-01-01T12:00:01.000Z',
          updatedAt: '2026-01-01T12:00:01.000Z',
          deletedAt: null,
        });
        const missing = await request(`${suite.base}/nope_missing`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
          error: { code: 'NOT_FOUND', message: `${suite.resource} with ID 'nope_missing' not found` },
        });
        expect((await request(`${suite.base}/${id.gone}`)).status).toBe(404);
        expect((await app().request(`${suite.base}/${id.seed(1)}`)).status).toBe(403);
      });

      if (suite.valid) {
        const valid = suite.valid;
        it('POST / stores the body (passthrough columns too) and publishes created', async () => {
          const res = await app(suite.gates.create).request(suite.base, json(valid.body));
          expect(res.status).toBe(201);
          const { data } = (await res.json()) as { data: { id: string } };
          expect(Object.keys(data)).toEqual(['id']);
          expect(data.id).toMatch(new RegExp(`^${p}_[0-9a-z]+$`));
          expect(await detailOf(data.id)).toMatchObject({ ...valid.stored, deletedAt: null });
          expect(published()).toEqual([
            {
              entityType: suite.entityType,
              action: 'created',
              entityId: expect.stringMatching(new RegExp(`^${p}_`)),
              data: { id: expect.stringMatching(new RegExp(`^${p}_`)), ...valid.event },
            },
          ]);
        });
      }

      it('POST / answers its 500 when the row cannot be stored', async () => {
        const { request } = app(suite.gates.create);
        for (const body of suite.unstorable) {
          const res = await request(suite.base, json(body));
          expect(res.status, JSON.stringify(body)).toBe(500);
          expect(await res.json()).toEqual({
            error: { code: 'INTERNAL_ERROR', message: `Failed to create ${suite.noun.one}` },
          });
        }
        expect(published()).toEqual([]);
      });

      it('POST / refuses an invalid body', async () => {
        const { request } = app(suite.gates.create);
        for (const body of suite.invalid) {
          expect((await request(suite.base, json(body))).status, JSON.stringify(body)).toBe(400);
        }
        expect((await request(suite.base, json(['not', 'an', 'object']))).status).toBe(400);
        const malformed = await request(suite.base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"oops',
        });
        expect(malformed.status).toBe(400);
        expect(published()).toEqual([]);
      });

      it('POST / reads a body without a JSON content type as {}', async () => {
        const res = await app(suite.gates.create).request(suite.base, { method: 'POST', body: 'name=x' });
        expect(res.status).toBe(suite.emptyBodyStatus);
      });

      it('POST / needs the create permission', async () => {
        const body = suite.valid?.body ?? suite.unstorable[0];
        expect((await app(suite.gates.read).request(suite.base, json(body))).status).toBe(403);
        expect(published()).toEqual([]);
      });

      it('PATCH /:id updates the row and publishes updated', async () => {
        const res = await app(suite.gates.update).request(`${suite.base}/${id.patch}`, json(suite.patch.body, 'PATCH'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: { id: id.patch } });
        expect(await detailOf(id.patch)).toMatchObject(suite.patch.stored);
        expect(published()).toEqual([
          { entityType: suite.entityType, action: 'updated', entityId: id.patch, data: { id: id.patch, ...suite.patch.event } },
        ]);
      });

      it('PATCH /:id with an empty body only touches updatedAt', async () => {
        const before = await row(id.seed(2));
        const res = await app(suite.gates.update).request(`${suite.base}/${id.seed(2)}`, json({}, 'PATCH'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: { id: id.seed(2) } });
        const after = await row(id.seed(2));
        expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
        expect(published()).toHaveLength(1);
      });

      it('PATCH /:id refusals: 404, 400, 403, and the route 500', async () => {
        const { request } = app(suite.gates.update);
        const missing = await request(`${suite.base}/nope_missing`, json(suite.patch.body, 'PATCH'));
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
          error: { code: 'NOT_FOUND', message: `${suite.resource} with ID 'nope_missing' not found` },
        });
        expect((await request(`${suite.base}/${id.gone}`, json(suite.patch.body, 'PATCH'))).status).toBe(404);
        expect((await request(`${suite.base}/${id.seed(3)}`, json(suite.invalidPatch, 'PATCH'))).status).toBe(400);
        expect((await app(suite.gates.read).request(`${suite.base}/${id.seed(3)}`, json(suite.patch.body, 'PATCH'))).status).toBe(403);
        // Every body key is written, the route's own `updatedAt` included: a string there can't be stored.
        const unstorable = await request(`${suite.base}/${id.seed(3)}`, json({ updatedAt: '2026-01-01T00:00:00.000Z' }, 'PATCH'));
        expect(unstorable.status).toBe(500);
        expect(await unstorable.json()).toEqual({
          error: { code: 'INTERNAL_ERROR', message: `Failed to update ${suite.noun.one}` },
        });
        expect(published()).toEqual([]);
      });

      it('DELETE /:id soft-deletes and publishes deleted; a deleted row is gone', async () => {
        const { request } = app(suite.gates.delete, suite.gates.read);
        const res = await request(`${suite.base}/${id.del}`, { method: 'DELETE' });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
        expect((await row(id.del))?.deletedAt).toBeInstanceOf(Date);
        expect(published()).toEqual([
          { entityType: suite.entityType, action: 'deleted', entityId: id.del, data: { id: id.del } },
        ]);
        const again = await request(`${suite.base}/${id.del}`, { method: 'DELETE' });
        expect(again.status).toBe(404);
        expect(await again.json()).toEqual({
          error: { code: 'NOT_FOUND', message: `${suite.resource} with ID '${id.del}' not found` },
        });
        expect((await request(`${suite.base}/${id.del}`)).status).toBe(404);
        expect((await app(suite.gates.read).request(`${suite.base}/${id.seed(4)}`, { method: 'DELETE' })).status).toBe(403);
      });
    });
  });

  return {
    app,
    json,
    row,
    detailOf,
    published,
    clearEvents: () => events.mockClear(),
    seedId: id.seed,
  };
}
