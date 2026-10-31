/**
 * /api/enrich-fields (the enrichment field definitions, a settings object) and
 * /api/enrichments (read-only views over the results, definitions and the
 * enrichment log) on pglite.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { enrichFieldsRoutes } from './index';
import { enrichmentsRoutes } from '../enrichments';

let db: Database;

function client(base: string, router: Parameters<typeof createTestApp>[1], grants: string[]) {
  const { request } = createTestApp(base, router, { context: { tenantDb: db, permissions: permissions(...grants) } });
  const send = (method: string, path: string, body?: unknown) =>
    request(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return {
    get: (path: string) => request(`${base}${path}`),
    post: (path: string, body: unknown) => send('POST', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
    remove: (path: string) => send('DELETE', path),
  };
}

const fields = (grants = ['settings:read', 'settings:manage']) => client('/api/enrich-fields', enrichFieldsRoutes, grants);
const enrichments = (grants = ['contacts:read']) => client('/api/enrichments', enrichmentsRoutes, grants);

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 180_000);

describe('/api/enrich-fields', () => {
  it('creates definitions, refusing a second one for the same provider and operation', async () => {
    const res = await fields().post('', {
      provider: 'hunter',
      operation: 'email_verifier',
      entityType: 'contact',
      name: 'Email check',
      slug: 'email_check',
      config: { threshold: 80 },
    });
    expect(res.status).toBe(201);
    expect((await json<{ data: unknown }>(res)).data).toMatchObject({
      provider: 'hunter',
      operation: 'email_verifier',
      entityType: 'contact',
      enabled: true,
      sortOrder: 0,
      config: { threshold: 80 },
      deletedAt: null,
    });
    await fields().post('', { provider: 'hunter', operation: 'email_finder', entityType: 'contact', name: 'Finder', slug: 'finder', enabled: false, sortOrder: 3 });
    await fields().post('', { provider: 'hunter', operation: 'domain_search', entityType: 'customer', name: 'Domain', slug: 'domain' });

    const dup = await fields().post('', { provider: 'hunter', operation: 'email_verifier', entityType: 'contact', name: 'Again', slug: 'again' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({
      error: { code: 'CONFLICT', message: 'An enrich field for hunter/email_verifier on contact already exists' },
    });
  });

  it('lists definitions, per entity type', async () => {
    const all = await json<{ data: Array<{ slug: string }> }>(await fields().get(''));
    expect(all.data.map((d) => d.slug)).toEqual(['email_check', 'domain', 'finder']);
    const contacts = await json<{ data: Array<{ slug: string }> }>(await fields().get('?entityType=contact'));
    expect(contacts.data.map((d) => d.slug)).toEqual(['email_check', 'finder']);
  });

  it('updates, reorders and deletes a definition', async () => {
    const { data } = await json<{ data: Array<{ id: string; slug: string }> }>(await fields().get('?entityType=contact'));
    const [check, finder] = data;

    const updated = await fields().put(`/${check!.id}`, { name: 'Verify', enabled: false, config: { threshold: 90 } });
    expect(updated.status).toBe(200);
    expect((await json<{ data: unknown }>(updated)).data).toMatchObject({ name: 'Verify', enabled: false, config: { threshold: 90 } });
    // Nothing changed: still answered, without an event.
    expect((await fields().put(`/${check!.id}`, { name: 'Verify' })).status).toBe(200);
    expect((await fields().put('/efd_missing', { name: 'x' })).status).toBe(404);

    const reordered = await fields().put('/reorder', { items: [{ id: finder!.id, sortOrder: -1 }, { id: 'efd_missing', sortOrder: 2 }] });
    expect(await reordered.json()).toEqual({ data: { reordered: 2 } });
    const after = await json<{ data: Array<{ slug: string }> }>(await fields().get('?entityType=contact'));
    expect(after.data.map((d) => d.slug)).toEqual(['finder', 'email_check']);

    const deleted = await fields().remove(`/${finder!.id}`);
    expect(await deleted.json()).toEqual({ data: { deleted: true } });
    expect((await fields().remove(`/${finder!.id}`)).status).toBe(404);
    // The unique index still holds the deleted row's provider and operation.
    const again = await fields().post('', { provider: 'hunter', operation: 'email_finder', entityType: 'contact', name: 'Finder', slug: 'finder' });
    expect(again.status).toBe(500);
  });

  it('validates input and needs the settings permissions', async () => {
    expect((await fields().post('', { provider: 'hunter', operation: 'x', entityType: 'contact', name: 'x', slug: 'Not A Slug' })).status).toBe(400);
    expect((await fields().post('', {})).status).toBe(400);
    expect((await fields().put('/efd_x', { sortOrder: 1.5 })).status).toBe(400);
    expect((await fields().put('/reorder', { items: [{ id: 'x' }] })).status).toBe(400);
    expect((await fields(['settings:read']).post('', {})).status).toBe(403);
    expect((await fields(['settings:read']).put('/reorder', { items: [] })).status).toBe(403);
    expect((await fields(['settings:read']).put('/x', {})).status).toBe(403);
    expect((await fields(['settings:read']).remove('/x')).status).toBe(403);
    expect((await fields(['settings:manage']).get('')).status).toBe(403);
  });
});

describe('/api/enrichments', () => {
  beforeAll(async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute, 0, 0));
    await db.insert(schema.enrichFieldResults).values([
      { id: 'efr_2', enrichFieldId: 'efd_b', entityType: 'contact', entityId: 'cnt_1', provider: 'hunter', operation: 'email_verifier', status: 'valid', resultData: { score: 97 }, createdAt: at(1), updatedAt: at(1) },
      { id: 'efr_1', enrichFieldId: 'efd_a', entityType: 'contact', entityId: 'cnt_1', provider: 'hunter', operation: 'domain_search', status: 'found', createdAt: at(2), updatedAt: at(2) },
      { id: 'efr_3', enrichFieldId: 'efd_a', entityType: 'contact', entityId: 'cnt_2', provider: 'apollo', operation: 'email_finder', status: 'no_result', createdAt: at(3), updatedAt: at(3) },
    ]);
    await db.insert(schema.enrichmentLogs).values(
      [1, 2, 3, 4, 5].map((n) => ({
        id: `elog_${n}`,
        createdAt: at(n),
        completedAt: n === 5 ? null : at(n + 1),
        provider: 'hunter',
        operation: 'email_finder',
        entityType: n % 2 ? 'contact' : 'customer',
        entityId: `cnt_${n % 2}`,
        userId: 'user_test_default',
        workspaceId: 'org_test_default',
        requestParams: { domain: `d${n}.test` },
        status: n === 5 ? 'pending' : 'success',
        creditsUsed: n,
      })),
    );
  });

  it('answers the results for one record', async () => {
    const res = await enrichments().get('?entityType=contact&entityId=cnt_1');
    expect(res.status).toBe(200);
    expect((await json<{ data: Array<{ id: string }> }>(res)).data.map((r) => r.id)).toEqual(['efr_1', 'efr_2']);
    expect((await enrichments().get('?entityType=contact')).status).toBe(400);
  });

  it('answers the definitions for an entity type', async () => {
    const all = await json<{ data: Array<{ slug: string }> }>(await enrichments().get('/definitions?entityType=contact'));
    expect(all.data.map((d) => d.slug)).toEqual(['email_check']);
    const enabled = await json<{ data: unknown[] }>(await enrichments().get('/definitions?entityType=contact&enabled=true'));
    expect(enabled.data).toEqual([]);
    expect((await enrichments().get('/definitions')).status).toBe(400);
  });

  it('pages the log', async () => {
    const first = await json<{ data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
      await enrichments().get('/logs?limit=2'),
    );
    expect(first.data.map((r) => r.id)).toEqual(['elog_5', 'elog_4']);
    expect(first.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'elog_4' });
    const next = await json<{ data: Array<{ id: string }>; pagination: { totalCount: number } }>(
      await enrichments().get(`/logs?limit=2&cursor=${first.pagination.cursor}`),
    );
    expect(next.data.map((r) => r.id)).toEqual(['elog_3', 'elog_2']);

    const contacts = await json<{ data: Array<{ id: string }>; pagination: { totalCount: number } }>(
      await enrichments().get('/logs?entityType=contact&entityId=cnt_1'),
    );
    expect(contacts.data.map((r) => r.id)).toEqual(['elog_5', 'elog_3', 'elog_1']);
    // With a cursor, the count leaves out the last filter.
    const paged = await json<{ data: Array<{ id: string }>; pagination: { totalCount: number } }>(
      await enrichments().get('/logs?entityType=contact&entityId=cnt_1&cursor=elog_5'),
    );
    expect(paged.data.map((r) => r.id)).toEqual(['elog_3', 'elog_1']);
    expect(paged.pagination.totalCount).toBe(3);
    const unknown = await json<{ data: unknown[]; pagination: { totalCount: number } }>(
      await enrichments().get('/logs?entityType=contact&cursor=elog_missing'),
    );
    expect(unknown.data).toHaveLength(3);
    expect(unknown.pagination.totalCount).toBe(5);
  });

  it('takes odd limits the way the worker always has', async () => {
    const nan = await json<{ data: unknown[]; pagination: { hasMore: boolean } }>(await enrichments().get('/logs?limit=lots'));
    expect(nan.data).toHaveLength(5);
    expect(nan.pagination.hasMore).toBe(false);
    const zero = await json<{ data: unknown[]; pagination: { hasMore: boolean; cursor: string | null } }>(await enrichments().get('/logs?limit=0'));
    expect(zero).toMatchObject({ data: [], pagination: { hasMore: true, cursor: null } });
    const negative = await json<{ data: Array<{ id: string }>; pagination: { hasMore: boolean; cursor: string | null } }>(
      await enrichments().get('/logs?limit=-2'),
    );
    expect(negative.data.map((r) => r.id)).toEqual(['elog_5', 'elog_4', 'elog_3']);
    expect(negative.pagination).toMatchObject({ hasMore: true, cursor: 'elog_3' });
    expect((await enrichments().get('/logs?limit=500')).status).toBe(200);
  });

  it('needs contacts:read', async () => {
    expect((await enrichments(['settings:read']).get('?entityType=a&entityId=b')).status).toBe(403);
    expect((await enrichments(['settings:read']).get('/definitions?entityType=a')).status).toBe(403);
    expect((await enrichments(['settings:read']).get('/logs')).status).toBe(403);
  });
});
