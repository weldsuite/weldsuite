/**
 * Auth-gate tests for /api/drive cross-cutting views.
 *
 * Focus: `GET /trash` must be gated by `files:read` like its sibling
 * views (`/all`, `/stats`). Previously it had NO `requirePermission`,
 * so any authenticated workspace member could list trashed files +
 * folders without the files permission.
 */

import { describe, it, expect } from 'vitest';
import { driveRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

describe('/api/drive · auth gates', () => {
  it('GET /trash returns 403 without files:read', async () => {
    const { request } = createTestApp('/api/drive', driveRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request('/api/drive/trash');
    expect(res.status).toBe(403);
  });

  it('GET /all returns 403 without files:read', async () => {
    const { request } = createTestApp('/api/drive', driveRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request('/api/drive/all');
    expect(res.status).toBe(403);
  });

  it('GET /stats returns 403 without files:read', async () => {
    const { request } = createTestApp('/api/drive', driveRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request('/api/drive/stats');
    expect(res.status).toBe(403);
  });
});
