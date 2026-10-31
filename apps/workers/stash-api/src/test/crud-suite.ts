/**
 * The route tests every plain CRUD route file of this worker shares
 * (boxes, warehouses, warehouse-zones, warehouse-locations, wms-suppliers,
 * cycle-counts, purchase-orders, inventory-movements): list (filters,
 * paging, an unknown cursor, a bad limit), detail, create, update and delete,
 * with their refusals (403, 400, 404). On pglite, so the same tests run
 * against the Rust backend in conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../types';

type Row = Record<string, unknown>;

export interface CrudSuite {
  /** `/api/boxes`. */
  base: string;
  routes: Hono<{ Bindings: Env; Variables: Variables }>;
  /** The Drizzle table, with an `id` column. */
  table: PgTable & { id: unknown };
  gates: { read: string; create: string; update: string; delete: string };
  /** A row to seed: every NOT NULL column without a default. */
  seed: (n: number) => Row;
  /** A body `POST /` accepts (201). */
  valid: Row;
  /** Bodies the schema accepts that the table can't store (the route's 500). */
  unstorable?: Row[];
  /** Bodies the schema refuses (400). */
  invalid: Row[];
  /** Bodies `PATCH /:id` accepts. */
  patches: Row[];
  /** A body the update schema refuses (400). */
  invalidPatch: Row;
  /** A `PATCH /:id` body the schema lets through that the table can't store (the route's 500). */
  unstorablePatch?: Row;
  /** List filters: the query, and the seed overrides that match it. */
  filters: Array<{ query: string; match: Row }>;
  /** Queries the list answers without a matching seed (an ignored value, an empty one). */
  queries?: string[];
  /** Whether `DELETE /:id` soft-deletes (a `deletedAt` column); otherwise the row is gone. */
  softDelete?: boolean;
}

export const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The tests for one route file. */
export function describeCrud(name: string, suite: CrudSuite): void {
  let db: Database;
  const seeded: string[] = [];

  const app = (...keys: string[]) =>
    createTestApp(suite.base, suite.routes, { context: { permissions: permissions(...keys), tenantDb: db } });

  async function seed(n: number, overrides: Row = {}, at?: Date): Promise<string> {
    const id = generateId('seed');
    const createdAt = at ?? new Date(Date.UTC(2026, 0, 1, 12, 0, n));
    await db
      .insert(suite.table)
      .values({ ...suite.seed(n), id, createdAt, updatedAt: createdAt, ...overrides } as never);
    seeded.push(id);
    return id;
  }

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    for (let n = 1; n <= 4; n++) await seed(n);
    for (const [i, filter] of suite.filters.entries()) await seed(10 + i, filter.match);
    // Two rows sharing a creation time: the id breaks the tie.
    const tie = new Date(Date.UTC(2026, 0, 2));
    await seed(20, {}, tie);
    await seed(21, {}, tie);
  }, 60_000);

  describe(`${name} · routes`, () => {
    it('GET / lists rows, with the count', async () => {
      const res = await app(suite.gates.read).request(suite.base);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Row[]; pagination: { totalCount: number } };
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.pagination.totalCount).toBe(body.data.length);
    });

    it('GET / pages with limit and cursor', async () => {
      const { request } = app(suite.gates.read);
      const first = (await (await request(`${suite.base}?limit=2`)).json()) as {
        data: Row[];
        pagination: { cursor: string | null; hasMore: boolean };
      };
      expect(first.data).toHaveLength(2);
      expect(first.pagination.hasMore).toBe(true);
      const next = await request(`${suite.base}?limit=2&cursor=${first.pagination.cursor}`);
      expect(next.status).toBe(200);
      const rest = await request(`${suite.base}?limit=50&cursor=${first.pagination.cursor}`);
      expect(rest.status).toBe(200);
      const zero = await request(`${suite.base}?limit=0`);
      expect(zero.status).toBe(200);
      const big = await request(`${suite.base}?limit=500`);
      expect(big.status).toBe(200);
    });

    it('GET / with a cursor that is gone counts without the last condition', async () => {
      const { request } = app(suite.gates.read);
      expect((await request(`${suite.base}?cursor=nope_missing`)).status).toBe(200);
      for (const filter of suite.filters) {
        const res = await request(`${suite.base}?${filter.query}&cursor=nope_missing`);
        expect(res.status).toBe(200);
      }
    });

    it('GET / filters', async () => {
      const { request } = app(suite.gates.read);
      for (const filter of suite.filters) {
        const res = await request(`${suite.base}?${filter.query}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Row[] };
        expect(body.data.length).toBeGreaterThan(0);
      }
      for (const query of suite.queries ?? []) {
        expect((await request(`${suite.base}?${query}`)).status).toBe(200);
      }
    });

    it('GET / with a limit that is not a number, or below zero, has no LIMIT', async () => {
      // Drizzle leaves out a LIMIT that is NaN or negative.
      const { request } = app(suite.gates.read);
      for (const limit of ['abc', '-1', '-3', '2.7']) {
        expect((await request(`${suite.base}?limit=${limit}`)).status).toBe(200);
      }
    });

    it('GET / needs the read permission', async () => {
      expect((await app().request(suite.base)).status).toBe(403);
    });

    it('GET /:id answers the row, 404 when missing', async () => {
      const { request } = app(suite.gates.read);
      const id = seeded[0]!;
      const res = await request(`${suite.base}/${id}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: Row }).data.id).toBe(id);
      expect((await request(`${suite.base}/nope_missing`)).status).toBe(404);
      expect((await app().request(`${suite.base}/${id}`)).status).toBe(403);
    });

    it('POST / creates', async () => {
      const res = await app(suite.gates.create).request(suite.base, json(suite.valid));
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string } };
      const [row] = await db
        .select()
        .from(suite.table)
        .where(eq(suite.table.id as never, data.id))
        .limit(1);
      expect(row).toBeTruthy();
    });

    it('POST / drops keys that are not columns', async () => {
      const res = await app(suite.gates.create).request(suite.base, json({ ...suite.valid, notAColumn: 'x' }));
      expect(res.status).toBe(201);
    });

    if (suite.unstorable?.length) {
      const unstorable = suite.unstorable;
      it('POST / answers its 500 when the row cannot be stored', async () => {
        const { request } = app(suite.gates.create);
        for (const body of unstorable) {
          expect((await request(suite.base, json(body))).status).toBe(500);
        }
      });
    }

    it('POST / refuses an invalid body', async () => {
      const { request } = app(suite.gates.create);
      for (const body of suite.invalid) {
        expect((await request(suite.base, json(body))).status).toBe(400);
      }
      const malformed = await request(suite.base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"oops',
      });
      expect(malformed.status).toBe(400);
      expect((await request(suite.base, json([1, 2]))).status).toBe(400);
    });

    it('POST / needs the create permission', async () => {
      const res = await app(suite.gates.read).request(suite.base, json(suite.valid));
      expect(res.status).toBe(403);
    });

    it('PATCH /:id updates, 404 when missing, 400 when invalid', async () => {
      const { request } = app(suite.gates.update);
      const id = seeded[1]!;
      for (const patch of suite.patches) {
        const res = await request(`${suite.base}/${id}`, json(patch, 'PATCH'));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { data: Row }).data).toEqual({ id });
      }
      expect((await request(`${suite.base}/${id}`, json({}, 'PATCH'))).status).toBe(200);
      expect((await request(`${suite.base}/nope_missing`, json(suite.patches[0], 'PATCH'))).status).toBe(404);
      expect((await request(`${suite.base}/${id}`, json(suite.invalidPatch, 'PATCH'))).status).toBe(400);
      expect((await app().request(`${suite.base}/${id}`, json(suite.patches[0], 'PATCH'))).status).toBe(403);
    });

    if (suite.unstorablePatch) {
      const unstorablePatch = suite.unstorablePatch;
      it('PATCH /:id answers its 500 when the change cannot be stored', async () => {
        const res = await app(suite.gates.update).request(`${suite.base}/${seeded[1]!}`, json(unstorablePatch, 'PATCH'));
        expect(res.status).toBe(500);
      });
    }

    it('DELETE /:id deletes; a deleted row is gone', async () => {
      const { request } = app(suite.gates.delete, suite.gates.read, suite.gates.update);
      const id = seeded[2]!;
      expect((await request(`${suite.base}/${id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await request(`${suite.base}/${id}`, { method: 'DELETE' })).status).toBe(404);
      expect((await request(`${suite.base}/${id}`)).status).toBe(404);
      expect((await request(`${suite.base}/${id}`, json(suite.patches[0], 'PATCH'))).status).toBe(404);
      expect((await app().request(`${suite.base}/${seeded[3]!}`, { method: 'DELETE' })).status).toBe(403);
      if (suite.softDelete !== false) {
        const [row] = await db
          .select()
          .from(suite.table)
          .where(eq(suite.table.id as never, id))
          .limit(1);
        expect(row).toBeTruthy();
      }
    });
  });
}
