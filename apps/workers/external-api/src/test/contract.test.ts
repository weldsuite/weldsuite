/**
 * Contract coverage for every CRUD entity in the external API.
 *
 * For each `/v1/<entity>` this asserts the cross-cutting behaviour that must
 * hold regardless of payload: list shape + pagination, scope gating (403),
 * missing auth (401), unknown-id (404), and validation (400). The actual
 * data round-trips live in crud.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { CRUD_ENTITIES } from './entities';
import type { Database } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('external-api · contract', () => {
  for (const entity of CRUD_ENTITIES) {
    const { seg, scope } = entity;

    describe(`/v1/${seg}`, () => {
      it('GET list → 200 with { data, pagination }', async () => {
        const { request } = createExternalTestApp({ scopes: [`${scope}:read`], tenantDb: db });
        const res = await request(`/v1/${seg}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: unknown[];
          pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
        };
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.pagination).toHaveProperty('totalCount');
        expect(body.pagination).toHaveProperty('hasMore');
        expect(body.pagination).toHaveProperty('cursor');
      });

      it('GET list without the read scope → 403', async () => {
        const { request } = createExternalTestApp({ scopes: ['unrelated:read'], tenantDb: db });
        const res = await request(`/v1/${seg}`);
        expect(res.status).toBe(403);
      });

      it('GET list with no session → 401', async () => {
        const { request } = createExternalTestApp({ session: null, tenantDb: db });
        const res = await request(`/v1/${seg}`);
        expect(res.status).toBe(401);
      });

      it('GET /:id unknown → 404', async () => {
        const { request } = createExternalTestApp({ scopes: [`${scope}:read`], tenantDb: db });
        const res = await request(`/v1/${seg}/missing_test_id`);
        expect(res.status).toBe(404);
      });

      it('POST without the write scope → 403 (before validation)', async () => {
        const { request } = createExternalTestApp({ scopes: [`${scope}:read`], tenantDb: db });
        const res = await request(`/v1/${seg}`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
        expect(res.status).toBe(403);
      });

      it('POST a non-object body → 400', async () => {
        const { request } = createExternalTestApp({ scopes: [`${scope}:write`], tenantDb: db });
        const res = await request(`/v1/${seg}`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify('not-an-object'),
        });
        expect(res.status).toBe(400);
      });
    });
  }
});
