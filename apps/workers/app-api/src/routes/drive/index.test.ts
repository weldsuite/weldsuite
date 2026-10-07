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
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';

describe('/api/drive · auth gates', () => {
  it.each(['trash', 'all', 'stats'])('GET /%s returns 403 without files:read', async (view) => {
    const { request } = createTestApp('/api/drive', driveRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request(`/api/drive/${view}`);
    expect(res.status).toBe(403);
  });
});
