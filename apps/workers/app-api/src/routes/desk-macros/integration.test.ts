/**
 * DB-backed integration tests for /api/desk/macros — proving validation →
 * service → response envelope end to end. `applyMacro` behavior itself is
 * covered in services/desk/macros-pglite.test.ts; the apply-macro HTTP route
 * (mounted on desk-conversations) is covered in
 * routes/desk-conversations/apply-macro.integration.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskMacrosRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(perm: string) {
  return createTestApp('/api/desk/macros', deskMacrosRoutes, {
    context: { permissions: permissions(perm), tenantDb: db },
  }).request;
}

describe('/api/desk/macros · pglite integration', () => {
  it('POST / creates a macro with actions', async () => {
    const request = app('macros:create');
    const res = await request('/api/desk/macros', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Close as spam',
        insertAs: 'note',
        actions: [{ type: 'add_tag', tag: 'spam' }, { type: 'close' }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; actions: unknown[] } };
    expect(body.data.id).toMatch(/^dmacro_/);
    expect(body.data.actions).toHaveLength(2);
  });

  it('rejects an invalid action shape (missing discriminant fields)', async () => {
    const res = await app('macros:create')('/api/desk/macros', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad macro', actions: [{ type: 'assign' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /:id updates a macro', async () => {
    const createRes = await app('macros:create')('/api/desk/macros', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Draft macro', actions: [] }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('macros:update')(`/api/desk/macros/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Final macro' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('Final macro');
  });

  it('DELETE /:id archives (204), excluded from default list', async () => {
    const createRes = await app('macros:create')('/api/desk/macros', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To archive', actions: [] }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const delRes = await app('macros:delete')(`/api/desk/macros/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const listRes = await app('macros:read')('/api/desk/macros');
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.some((m) => m.id === created.id)).toBe(false);
  });

  it('GET /:id returns 404 for a missing macro', async () => {
    const res = await app('macros:read')('/api/desk/macros/dmacro_missing');
    expect(res.status).toBe(404);
  });
});
