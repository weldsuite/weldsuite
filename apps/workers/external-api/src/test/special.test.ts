/**
 * Smoke coverage for the non-CRUD routes that the data-driven matrices
 * don't reach: the v1 index + health probe, drive aggregates, settings,
 * project-sheets (list-only), webhook events, and ticket message sub-routes.
 *
 * Uses a wildcard-scoped session so the focus stays on routing + handler
 * execution (scope gating is already proven in contract.test.ts). All run
 * against a real pglite DB; assertions allow the "empty but valid" 200/404
 * outcomes since no fixtures are seeded.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('external-api · special routes', () => {
  const app = () => createExternalTestApp({ scopes: ['*'], tenantDb: db }).request;

  it('GET /v1 → 200 version index', async () => {
    const res = await app()('/v1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: string; endpoints: string[] } };
    expect(body.data.version).toBe('v1');
    expect(Array.isArray(body.data.endpoints)).toBe(true);
  });

  it('GET /v1/health/db → 200 connected', async () => {
    const res = await app()('/v1/health/db');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('connected');
  });

  it.each([
    ['GET /v1/drive/all → 200 list', '/v1/drive/all'],
    ['GET /v1/drive/stats → 200', '/v1/drive/stats'],
    ['GET /v1/settings/workspace → 200', '/v1/settings/workspace'],
    ['GET /v1/webhooks/events → 200 catalog', '/v1/webhooks/events'],
  ])('%s', async (_name, path) => {
    const res = await app()(path);
    expect(res.status).toBe(200);
  });

  it('GET /v1/settings/members → 200 list', async () => {
    const res = await app()('/v1/settings/members');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /v1/project-sheets → 200 list', async () => {
    const res = await app()('/v1/project-sheets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /v1/tickets/:ticketId/messages → 200 or 404', async () => {
    const res = await app()('/v1/tickets/missing_ticket_id/messages');
    expect([200, 404]).toContain(res.status);
  });
});
