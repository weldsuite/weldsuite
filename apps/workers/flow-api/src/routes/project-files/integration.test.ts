/**
 * PGlite integration tests for project-files storage replacement cleanup.
 *
 * Covers PATCH /:id when storagePath/fileKey change: previous R2 object is
 * deleted only after a successful DB update, and cleanup failures must not
 * flip the successful update response.
 *
 * Also covers the storage-key boundary: the bucket is shared, so a key is only
 * accepted (and an old object only deleted) when it is one of the project's
 * own upload keys and no other project file points at it.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectFilesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { projectFiles, projects } = schema;

/** Matches the harness default `workspaceId`. */
const WORKSPACE_ID = 'org_test_default';
const DRIVE_KEY = `workspaces/${WORKSPACE_ID}/drive/general/1_secret.pdf`;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

/** A key shaped like the ones `/api/storage/generate-upload-url` issues. */
function uploadKey(projectId: string, name: string, workspaceId = WORKSPACE_ID) {
  return `workspaces/${workspaceId}/projects/project/${projectId}/${name}`;
}

function mockStorage() {
  return { delete: vi.fn(async (_key: string) => undefined) };
}

function testApp(storage: { delete: unknown }, permission: string) {
  return createTestApp('/api/project-files', projectFilesRoutes, {
    context: {
      permissions: permissions(permission, 'projects:scope:all'),
      tenantDb: db,
    },
    env: { STORAGE: storage as unknown as R2Bucket },
  });
}

type TestRequest = ReturnType<typeof testApp>['request'];

function patchFile(request: TestRequest, fileId: string, body: unknown) {
  return request(`/api/project-files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postFile(request: TestRequest, body: unknown) {
  return request('/api/project-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getRow(fileId: string) {
  const [row] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1);
  return row;
}

async function seedFile(opts?: { storagePath?: string; fileKey?: string; projectId?: string }) {
  const projectId = opts?.projectId ?? generateId('proj');
  const fileId = generateId('pfile');
  const now = new Date();
  if (!opts?.projectId) {
    await db.insert(projects).values({
      id: projectId,
      name: 'Replace Cleanup Project',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as typeof projects.$inferInsert);
  }

  const storagePath = opts?.storagePath ?? uploadKey(projectId, `${fileId}_old.pdf`);
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
    const { fileId, projectId, storagePath: oldKey } = await seedFile();
    const newKey = uploadKey(projectId, 'new_key.pdf');
    const storage = mockStorage();
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, fileId, {
      storagePath: newKey,
      fileKey: newKey,
      fileSize: 200,
      mimeType: 'application/pdf',
      url: 'https://example.com/new/key.pdf',
    });

    expect(res.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(oldKey);

    const row = await getRow(fileId);
    expect(row?.storagePath).toBe(newKey);
    expect(row?.fileKey).toBe(newKey);
    expect(row?.fileSize).toBe(200);
  });

  it('PATCH still returns success when R2 cleanup fails', async () => {
    const { fileId, projectId, storagePath: oldKey } = await seedFile();
    const newKey = uploadKey(projectId, 'new_fail-cleanup.pdf');
    const storage = {
      delete: vi.fn(async () => {
        throw new Error('R2 unavailable');
      }),
    };
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, fileId, {
      storagePath: newKey,
      fileKey: newKey,
      fileSize: 300,
    });

    expect(res.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledWith(oldKey);

    const row = await getRow(fileId);
    expect(row?.storagePath).toBe(newKey);
    expect(row?.fileKey).toBe(newKey);
    expect(row?.fileSize).toBe(300);
  });

  it('PATCH rename-only does not call STORAGE.delete', async () => {
    const { fileId, storagePath } = await seedFile();
    const storage = mockStorage();
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, fileId, { fileName: 'renamed-report.pdf' });

    expect(res.status).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();

    const row = await getRow(fileId);
    expect(row?.fileName).toBe('renamed-report.pdf');
    expect(row?.storagePath).toBe(storagePath);
  });
});

describe('/api/project-files · storage key boundary', () => {
  it.each([
    ['a Drive object in the same workspace', () => DRIVE_KEY],
    ['another workspace', (projectId: string) => uploadKey(projectId, '1_secret.pdf', 'org_victim')],
    ['another project', () => uploadKey('proj_victim', '1_secret.pdf')],
    ['a traversal out of the project prefix', (projectId: string) => uploadKey(projectId, '..')],
  ])('PATCH refuses a storage key pointing at %s', async (_label, victimKey) => {
    const { fileId, projectId, storagePath } = await seedFile();
    const key = victimKey(projectId);
    const storage = mockStorage();
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, fileId, { storagePath: key, fileKey: key });

    expect(res.status).toBe(400);
    expect(storage.delete).not.toHaveBeenCalled();
    expect((await getRow(fileId))?.fileKey).toBe(storagePath);
  });

  it('PATCH refuses the storage key of another file in the same project', async () => {
    const victim = await seedFile();
    const attacker = await seedFile({ projectId: victim.projectId });
    const storage = mockStorage();
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, attacker.fileId, { fileKey: victim.fileKey });

    expect(res.status).toBe(400);
    expect(storage.delete).not.toHaveBeenCalled();
    expect((await getRow(attacker.fileId))?.fileKey).toBe(attacker.fileKey);
  });

  it('PATCH never deletes an object outside the project prefix, even when the row already points at it', async () => {
    // A row written before the prefix existed, or through another API surface.
    const { fileId, projectId } = await seedFile({ storagePath: DRIVE_KEY });
    const newKey = uploadKey(projectId, 'replacement.pdf');
    const storage = mockStorage();
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, fileId, { storagePath: newKey, fileKey: newKey });

    expect(res.status).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();
    expect((await getRow(fileId))?.fileKey).toBe(newKey);
  });

  it('PATCH does not delete an object another project file still points at', async () => {
    const shared = await seedFile();
    const other = await seedFile({ projectId: shared.projectId, storagePath: shared.storagePath });
    const newKey = uploadKey(shared.projectId, 'replacement-shared.pdf');
    const storage = mockStorage();
    const { request } = testApp(storage, 'files:update');

    const res = await patchFile(request, other.fileId, { storagePath: newKey, fileKey: newKey });

    expect(res.status).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('PATCH ignores columns that are not writable', async () => {
    const { fileId, projectId } = await seedFile();
    const { request } = testApp(mockStorage(), 'files:update');

    const res = await patchFile(request, fileId, {
      fileName: 'still-here.pdf',
      id: 'pfile_hijacked',
      deletedAt: '2026-01-01T00:00:00.000Z',
      isFolder: true,
      bucket: 'other-bucket',
      uploadedById: 'user_someone_else',
    });

    expect(res.status).toBe(200);
    const row = await getRow(fileId);
    expect(row?.fileName).toBe('still-here.pdf');
    expect(row?.projectId).toBe(projectId);
    expect(row?.deletedAt).toBeNull();
    expect(row?.isFolder).toBe(false);
    expect(row?.bucket).toBeNull();
    expect(row?.uploadedById).toBeNull();
  });

  it('POST refuses a storage key outside the project prefix', async () => {
    const { projectId } = await seedFile();
    const { request } = testApp(mockStorage(), 'files:create');

    const res = await postFile(request, {
      projectId,
      fileName: 'secret.pdf',
      mimeType: 'application/pdf',
      fileSize: 10,
      storagePath: DRIVE_KEY,
      fileKey: DRIVE_KEY,
    });

    expect(res.status).toBe(400);
  });

  it('POST stores a file whose key the upload flow issued for the project', async () => {
    const { projectId } = await seedFile();
    const key = uploadKey(projectId, 'uploaded.pdf');
    const { request } = testApp(mockStorage(), 'files:create');

    // Same payload the platform sends after `/api/storage/confirm-upload`.
    const res = await postFile(request, {
      projectId,
      fileName: 'uploaded.pdf',
      originalName: 'uploaded.pdf',
      mimeType: 'application/pdf',
      fileSize: 10,
      storagePath: key,
      fileKey: key,
      url: 'https://example.com/uploaded.pdf',
      storageProvider: 'r2',
      isPublic: false,
      parentId: null,
      id: 'pfile_hijacked',
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).not.toBe('pfile_hijacked');
    const row = await getRow(data.id);
    expect(row?.fileKey).toBe(key);
    expect(row?.uploadedById).toBe('user_test_default');
  });
});
