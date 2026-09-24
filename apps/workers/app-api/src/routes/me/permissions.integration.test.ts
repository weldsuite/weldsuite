/**
 * GET /me/permissions — what first-party clients gate their UI on.
 *
 * Returns the resolved grants plus the member's denies and `appEnforced`:
 * clients apply per-app checks only once the server enforces them, so the UI
 * never hides what the API still serves during the log-only rollout.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { meRoutes } from './index';
import { createTestApp } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_me',
    userId: 'user_me',
    email: 'me@example.com',
    role: 'MEMBER',
    permissions: ['weldcrm:companies:read'],
    permissionDenies: ['welddesk:companies:read'],
    createdAt: now,
    updatedAt: now,
  } as typeof schema.workspaceMembers.$inferInsert);
}, 60_000);

async function fetchMe(env: Record<string, string> = {}) {
  const t = createTestApp('/api/me', meRoutes, { context: { tenantDb: db, userId: 'user_me' }, env });
  const res = await t.request('/api/me/permissions');
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe('GET /me/permissions', () => {
  it('returns grants, member denies and the log-only mode by default', async () => {
    const data = await fetchMe();
    expect(data.permissions).toEqual(expect.arrayContaining(['weldcrm:companies:read']));
    expect(data.denies).toEqual(['welddesk:companies:read']);
    expect(data.appEnforced).toBe(false);
  });

  it('reports enforcement once PERMISSIONS_APP_ENFORCE is on', async () => {
    const data = await fetchMe({ PERMISSIONS_APP_ENFORCE: 'true' });
    expect(data.appEnforced).toBe(true);
  });
});
