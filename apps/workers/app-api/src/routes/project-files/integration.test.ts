/**
 * PGlite integration tests for project-files storage replacement cleanup.
 *
 * Covers PATCH /:id when storagePath/fileKey change: previous R2 object is
 * deleted only after a successful DB update, and cleanup failures must not
 * flip the successful update response.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectFilesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

const { projectFiles, projects } = schema;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedFile(opts?: { storagePath?: string; fileKey?: string }) {
  const projectId = generateId('proj');
  const fileId = generateId('pfile');
  const now = new Date();
  await db.insert(projects).values({
    id: projectId,
    name: 'Replace Cleanup Project',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof projects.$inferInsert);

  const storagePath = opts?.storagePath ?? 'old/key.pdf';
  const fileKey = opts?.fileKey ?? storagePath;
  await db.insert(projectFiles).values({
    id: fileId,
    projectId,
    fileName: 'report.pdf',
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 100,
    storagePath,
    fileKey,
    storageProvider: 'r2',
    fileType: 'file',
    isFolder: false,
    createdAt: now,
    updatedAt: now,
  });
  return { projectId, fileId, storagePath, fileKey };
}

describe('/api/project-files · replace storage cleanup', () => {
  it('PATCH deletes the previous R2 key after a successful storage replace', async () => {
    const { fileId, storagePath: oldKey } = await seedFile();
    const storage = {
      delete: vi.fn(async (_key: string) => undefined),
    };

    const { request } = createTestApp('/api/project-files', projectFilesRoutes, {
      context: {
        permissions: permissions('files:update', 'projects:scope:all'),
        tenantDb: db,
      },
      env: { STORAGE: storage as unknown as R2Bucket },
    });

    const res = await request(`/api/project-files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storagePath: 'new/key.pdf',
        fileKey: 'new/key.pdf',
        fileSize: 200,
        mimeType: 'application/pdf',
        url: 'https://example.com/new/key.pdf',
      }),
    });

    expect(res.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(oldKey);

    const [row] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.id, fileId))
      .limit(1);
    expect(row?.storagePath).toBe('new/key.pdf');
    expect(row?.fileKey).toBe('new/key.pdf');
    expect(row?.fileSize).toBe(200);
  });

  it('PATCH still returns success when R2 cleanup fails', async () => {
    const { fileId } = await seedFile({
      storagePath: 'old/fail-cleanup.pdf',
      fileKey: 'old/fail-cleanup.pdf',
    });
    const storage = {
      delete: vi.fn(async () => {
        throw new Error('R2 unavailable');
      }),
    };

    const { request } = createTestApp('/api/project-files', projectFilesRoutes, {
      context: {
        permissions: permissions('files:update', 'projects:scope:all'),
        tenantDb: db,
      },
      env: { STORAGE: storage as unknown as R2Bucket },
    });

    const res = await request(`/api/project-files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storagePath: 'new/fail-cleanup.pdf',
        fileKey: 'new/fail-cleanup.pdf',
        fileSize: 300,
      }),
    });

    expect(res.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledWith('old/fail-cleanup.pdf');

    const [row] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.id, fileId))
      .limit(1);
    expect(row?.storagePath).toBe('new/fail-cleanup.pdf');
    expect(row?.fileKey).toBe('new/fail-cleanup.pdf');
    expect(row?.fileSize).toBe(300);
  });

  it('PATCH rename-only does not call STORAGE.delete', async () => {
    const { fileId } = await seedFile({
      storagePath: 'keep/key.pdf',
      fileKey: 'keep/key.pdf',
    });
    const storage = {
      delete: vi.fn(async (_key: string) => undefined),
    };

    const { request } = createTestApp('/api/project-files', projectFilesRoutes, {
      context: {
        permissions: permissions('files:update', 'projects:scope:all'),
        tenantDb: db,
      },
      env: { STORAGE: storage as unknown as R2Bucket },
    });

    const res = await request(`/api/project-files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'renamed-report.pdf' }),
    });

    expect(res.status).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.id, fileId))
      .limit(1);
    expect(row?.fileName).toBe('renamed-report.pdf');
    expect(row?.storagePath).toBe('keep/key.pdf');
  });
});
