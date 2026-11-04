/**
 * DB-backed tests for the client-portal flag on project files (FLOW-020):
 * `clientVisible` on POST and PATCH /api/project-files. Runs against the
 * TypeScript worker and, in conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectFilesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_cvf_manager';
const VIEWER = 'user_cvf_viewer';
const PROJECT = 'prj_cvf';
const FILE = 'pfile_cvf';

/** A key shaped like the ones `/api/storage/generate-upload-url` issues (harness org id). */
const uploadKey = (name: string) =>
  `workspaces/org_test_default/projects/project/${PROJECT}/1760000000000_${'0123456789abcdef'.repeat(2)}/${name}`;

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[]): Send {
  const { request } = createTestApp('/api/project-files', projectFilesRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-files${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);

async function visibleOf(id: string) {
  const [row] = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.id, id)).limit(1);
  return row?.clientVisible;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id: PROJECT, name: PROJECT, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values({
    id: 'pm_cvf_v', projectId: PROJECT, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now,
  });
  await db.insert(schema.projectFiles).values({
    id: FILE, projectId: PROJECT, fileName: 'plan.pdf', originalName: 'plan.pdf', mimeType: 'application/pdf',
    fileSize: 10, storagePath: 'workspaces/x/plan.pdf', fileKey: 'workspaces/x/plan.pdf', storageProvider: 'r2', fileType: 'file', isFolder: false, createdAt: now, updatedAt: now,
  });
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

describe('PATCH /:id clientVisible', () => {
  it('shares and unshares a file and publishes project_file.updated', async () => {
    const send = as(MANAGER, ['files:update']);

    const on = await send('PATCH', `/${FILE}`, { clientVisible: true });
    expect(on.status).toBe(200);
    expect(await visibleOf(FILE)).toBe(true);
    expect(actions()).toEqual(['project_file.updated']);

    const off = await send('PATCH', `/${FILE}`, { clientVisible: false });
    expect(off.status).toBe(200);
    expect(await visibleOf(FILE)).toBe(false);
  });

  it('leaves the flag alone when the patch does not mention it', async () => {
    const send = as(MANAGER, ['files:update']);
    await send('PATCH', `/${FILE}`, { clientVisible: true });
    const res = await send('PATCH', `/${FILE}`, { fileName: 'plan-v2.pdf' });
    expect(res.status).toBe(200);
    expect(await visibleOf(FILE)).toBe(true);
    await send('PATCH', `/${FILE}`, { clientVisible: false });
  });

  it('refuses a non-boolean value', async () => {
    const res = await as(MANAGER, ['files:update'])('PATCH', `/${FILE}`, { clientVisible: 'yes' });
    expect(res.status).toBe(400);
    expect(await visibleOf(FILE)).toBe(false);
  });

  it('denies a viewer with 403 and keeps the flag', async () => {
    const res = await as(VIEWER, ['files:update'])('PATCH', `/${FILE}`, { clientVisible: true });
    expect(res.status).toBe(403);
    expect(await visibleOf(FILE)).toBe(false);
    expect(actions()).toEqual([]);
  });

  it('denies a caller without files:update', async () => {
    const res = await as(MANAGER, ['files:read'])('PATCH', `/${FILE}`, { clientVisible: true });
    expect(res.status).toBe(403);
  });
});

describe('POST / clientVisible', () => {
  it('stores the flag on a new file and defaults it to false', async () => {
    const send = as(MANAGER, ['files:create']);
    const shared = await send('POST', '', { projectId: PROJECT, fileName: 'shared.pdf', storagePath: uploadKey('shared.pdf'), originalName: 'shared.pdf', mimeType: 'application/pdf', fileSize: 10, clientVisible: true });
    expect(shared.status).toBe(201);
    const sharedId = ((await shared.json()) as { data: { id: string } }).data.id;
    expect(await visibleOf(sharedId)).toBe(true);

    const plain = await send('POST', '', { projectId: PROJECT, fileName: 'plain.pdf', storagePath: uploadKey('plain.pdf'), originalName: 'plain.pdf', mimeType: 'application/pdf', fileSize: 10 });
    const plainId = ((await plain.json()) as { data: { id: string } }).data.id;
    expect(await visibleOf(plainId)).toBe(false);
  });
});
