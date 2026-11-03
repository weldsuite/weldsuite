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
import { schema } from '../db';

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

  it('GET /v1/settings/members/:id → the member, 404 when unknown, 403 without the scope', async () => {
    await db.insert(schema.workspaceMembers).values({
      id: 'wm_special',
      userId: 'user_special',
      role: 'MEMBER',
      hoursPerWeek: '32.50',
    } as typeof schema.workspaceMembers.$inferInsert);
    const found = await app()('/v1/settings/members/wm_special');
    expect(found.status).toBe(200);
    expect(((await found.json()) as { data: { hoursPerWeek: string } }).data.hoursPerWeek).toBe('32.50');
    const page = await app()('/v1/settings/members?limit=1');
    expect(page.status).toBe(200);
    expect((await app()('/v1/settings/members?limit=0')).status).toBe(400);
    expect((await app()('/v1/settings/members/wm_missing')).status).toBe(404);
    const noScope = createExternalTestApp({ scopes: ['settings:read'], tenantDb: db }).request;
    expect((await noScope('/v1/settings/members/wm_special')).status).toBe(403);
    expect((await noScope('/v1/settings/workspace')).status).toBe(200);
    const noSession = createExternalTestApp({ session: null, tenantDb: db }).request;
    expect((await noSession('/v1/settings/members')).status).toBe(401);
  });

  it('GET /v1/project-sheets → 200 list', async () => {
    const res = await app()('/v1/project-sheets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("GET /v1/project-sheets lists a project's live spreadsheets, newest first, a page at a time", async () => {
    const sheet = (id: string, fields: Partial<typeof schema.files.$inferInsert>) => ({
      id,
      fileName: `${id}.sheet`,
      mimeType: 'application/vnd.weldsuite.sheet',
      fileSize: 1,
      storagePath: `sheets/${id}`,
      fileType: 'spreadsheet',
      entityType: 'project',
      entityId: 'prj_sheets_a',
      ...fields,
    });
    await db
      .insert(schema.files)
      .values([
        sheet('fil_sheet_a1', { createdAt: new Date('2026-01-01T10:00:00Z') }),
        sheet('fil_sheet_a2', { createdAt: new Date('2026-01-02T10:00:00Z') }),
        sheet('fil_sheet_b1', { entityId: 'prj_sheets_b', createdAt: new Date('2026-01-03T10:00:00Z') }),
        sheet('fil_sheet_gone', { deletedAt: new Date('2026-01-04T10:00:00Z') }),
        sheet('fil_sheet_doc', { fileType: 'document' }),
        sheet('fil_sheet_task', { entityType: 'task' }),
      ] as (typeof schema.files.$inferInsert)[]);
    const ids = async (path: string) => {
      const res = await app()(path);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as {
        data: { id: string }[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      };
      return { ids: body.data.map((row) => row.id), pagination: body.pagination };
    };
    expect((await ids('/v1/project-sheets')).ids).toEqual(['fil_sheet_b1', 'fil_sheet_a2', 'fil_sheet_a1']);
    const first = await ids('/v1/project-sheets?projectId=prj_sheets_a&limit=1');
    expect(first.ids).toEqual(['fil_sheet_a2']);
    expect(first.pagination).toMatchObject({ totalCount: 2, hasMore: true });
    const next = await ids(`/v1/project-sheets?projectId=prj_sheets_a&limit=1&cursor=${first.pagination.cursor}`);
    expect(next.ids).toEqual(['fil_sheet_a1']);
    expect((await app()('/v1/project-sheets?limit=0')).status).toBe(400);
    const noScope = createExternalTestApp({ scopes: ['projects:read'], tenantDb: db }).request;
    expect((await noScope('/v1/project-sheets')).status).toBe(403);
  });

  it('GET /v1/tickets/:ticketId/messages → 200 or 404', async () => {
    const res = await app()('/v1/tickets/missing_ticket_id/messages');
    expect([200, 404]).toContain(res.status);
  });
});
