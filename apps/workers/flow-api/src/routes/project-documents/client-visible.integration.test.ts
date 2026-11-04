/**
 * DB-backed tests for the client-portal flag on project documents (FLOW-020):
 * PATCH /api/project-documents/:projectId/:fileId writes `files.client_visible`.
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectDocumentsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_cvd_manager';
const VIEWER = 'user_cvd_viewer';
const PROJECT = 'prj_cvd';
const OTHER_PROJECT = 'prj_cvd_other';
const DOC = 'file_cvd_doc';
const SHEET = 'file_cvd_sheet';
const DELETED = 'file_cvd_deleted';

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = ['projects:read', 'projects:update']): Send {
  const { request } = createTestApp('/api/project-documents', projectDocumentsRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-documents${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);

async function visibleOf(id: string) {
  const [row] = await db.select().from(schema.files).where(eq(schema.files.id, id)).limit(1);
  return row?.clientVisible;
}

function fileRow(id: string, over: Record<string, unknown> = {}) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  return {
    id,
    fileName: `${id}.docx`,
    originalName: `${id}.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileSize: 100,
    storagePath: `workspaces/x/${id}`,
    fileKey: `workspaces/x/${id}`,
    url: `https://example.com/${id}`,
    fileType: 'document',
    entityType: 'project',
    entityId: PROJECT,
    uploadedById: MANAGER,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as unknown as typeof schema.files.$inferInsert;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values(
    [PROJECT, OTHER_PROJECT].map((id) => ({ id, name: id, projectManagerId: MANAGER, createdAt: now, updatedAt: now })),
  );
  await db.insert(schema.projectMembers).values({
    id: 'pm_cvd_v', projectId: PROJECT, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now,
  });
  await db.insert(schema.files).values([
    fileRow(DOC),
    fileRow(SHEET, { fileType: 'spreadsheet' }),
    fileRow(DELETED, { deletedAt: now }),
  ]);
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

describe('PATCH /:projectId/:fileId', () => {
  it('shares and unshares a document, answering the file row and publishing file.updated', async () => {
    const res = await as(MANAGER)('PATCH', `/${PROJECT}/${DOC}`, { clientVisible: true });
    expect(res.status).toBe(200);
    const row = ((await res.json()) as { data: { id: string; clientVisible: boolean } }).data;
    expect(row).toMatchObject({ id: DOC, clientVisible: true });
    expect(await visibleOf(DOC)).toBe(true);
    expect(actions()).toEqual(['file.updated']);
    expect(published.mock.calls[0]?.[0].data).toMatchObject({ id: DOC, name: `${DOC}.docx`, fileType: 'document' });

    const off = await as(MANAGER)('PATCH', `/${PROJECT}/${DOC}`, { clientVisible: false });
    expect(off.status).toBe(200);
    expect(await visibleOf(DOC)).toBe(false);
  });

  it('answers 404 for a missing, deleted, non-document or other-project file', async () => {
    const send = as(MANAGER);
    for (const path of [`/${PROJECT}/file_cvd_missing`, `/${PROJECT}/${DELETED}`, `/${PROJECT}/${SHEET}`, `/${OTHER_PROJECT}/${DOC}`]) {
      const res = await send('PATCH', path, { clientVisible: true });
      expect(res.status, path).toBe(404);
    }
    expect(actions()).toEqual([]);
  });

  it('denies a viewer with 403 and keeps the flag', async () => {
    const res = await as(VIEWER)('PATCH', `/${PROJECT}/${DOC}`, { clientVisible: true });
    expect(res.status).toBe(403);
    const error = ((await res.json()) as { error: { message: string } }).error;
    expect(error.message).toBe('You do not have write access to this project');
    expect(await visibleOf(DOC)).toBe(false);
    expect(actions()).toEqual([]);
  });

  it('denies a caller without projects:update', async () => {
    const res = await as(MANAGER, ['projects:read'])('PATCH', `/${PROJECT}/${DOC}`, { clientVisible: true });
    expect(res.status).toBe(403);
  });

  it('refuses a bad body with 400', async () => {
    const send = as(MANAGER);
    for (const body of [{}, { clientVisible: 'yes' }, { clientVisible: true, extra: 1 }]) {
      const res = await send('PATCH', `/${PROJECT}/${DOC}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Invalid request body');
    }
    expect(await visibleOf(DOC)).toBe(false);
  });
});
