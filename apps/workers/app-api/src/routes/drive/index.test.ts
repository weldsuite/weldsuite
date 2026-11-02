/**
 * Auth-gate tests for /api/drive cross-cutting views.
 *
 * Focus: `GET /trash` must be gated by `files:read` like its sibling
 * views (`/all`, `/stats`). Previously it had NO `requirePermission`,
 * so any authenticated workspace member could list trashed files +
 * folders without the files permission.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { driveRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('/api/drive · auth gates', () => {
  it.each(['trash', 'all', 'stats', 'shared'])('GET /%s returns 403 without files:read', async (view) => {
    const { request } = createTestApp('/api/drive', driveRoutes, {
      context: { tenantDb: db, permissions: permissions() },
    });
    const res = await request(`/api/drive/${view}`);
    expect(res.status).toBe(403);
  });

  it.each([
    ['POST', '/api/drive/trash/restore/file/fil_x', 'files:update'],
    ['POST', '/api/drive/trash/restore/folder/fld_x', 'folders:update'],
    ['DELETE', '/api/drive/trash/file/fil_x', 'files:delete'],
    ['DELETE', '/api/drive/trash/folder/fld_x', 'folders:delete'],
    ['DELETE', '/api/drive/trash/empty', 'files:delete'],
  ])('%s %s returns 403 without %s', async (method, path) => {
    const { request } = createTestApp('/api/drive', driveRoutes, {
      context: { tenantDb: db, permissions: permissions('files:read', 'folders:read') },
    });
    expect((await request(path, { method })).status).toBe(403);
  });
});
