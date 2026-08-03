/**
 * Project files folder helpers — pglite-backed service tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createProjectFolder,
  softDeleteProjectFolderCascade,
  wouldCreateCycle,
  replacedStorageKey,
} from './project-files';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { eq } from 'drizzle-orm';

const { projectFiles, projects } = schema;

let db: Database;
let projectId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  projectId = generateId('proj');
  const now = new Date();
  await db.insert(projects).values({
    id: projectId,
    name: 'Folder Test Project',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof projects.$inferInsert);
}, 60_000);

async function createFile(opts: {
  fileName: string;
  parentId?: string | null;
  isFolder?: boolean;
}) {
  const id = generateId('pfile');
  const now = new Date();
  await db.insert(projectFiles).values({
    id,
    projectId,
    parentId: opts.parentId ?? null,
    fileName: opts.fileName,
    originalName: opts.fileName,
    mimeType: opts.isFolder ? 'inode/directory' : 'text/plain',
    fileSize: opts.isFolder ? 0 : 12,
    storagePath: opts.isFolder ? '' : `key/${id}`,
    fileType: opts.isFolder ? 'folder' : 'file',
    isFolder: opts.isFolder ?? false,
    storageProvider: 'r2',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('project-files service · folder hierarchy', () => {
  it('createProjectFolder writes an isFolder row under the given parent', async () => {
    const parent = await createProjectFolder(db, {
      projectId,
      name: 'Docs',
    });
    expect(parent.isFolder).toBe(true);
    expect(parent.fileType).toBe('folder');
    expect(parent.parentId).toBeNull();
    expect(parent.fileSize).toBe(0);

    const child = await createProjectFolder(db, {
      projectId,
      name: 'Specs',
      parentId: parent.id,
    });
    expect(child.parentId).toBe(parent.id);
  });

  it('softDeleteProjectFolderCascade deletes the folder and all descendants', async () => {
    const root = await createProjectFolder(db, { projectId, name: 'Cascade Root' });
    const mid = await createProjectFolder(db, {
      projectId,
      name: 'Mid',
      parentId: root.id,
    });
    const fileId = await createFile({ fileName: 'notes.txt', parentId: mid.id });

    const deleted = await softDeleteProjectFolderCascade(db, root.id);
    expect(deleted.sort()).toEqual([root.id, mid.id, fileId].sort());

    for (const id of deleted) {
      const [row] = await db.select().from(projectFiles).where(eq(projectFiles.id, id)).limit(1);
      expect(row?.deletedAt).not.toBeNull();
    }
  });

  it('wouldCreateCycle detects moving a folder into its descendant', async () => {
    const a = await createProjectFolder(db, { projectId, name: 'A' });
    const b = await createProjectFolder(db, { projectId, name: 'B', parentId: a.id });
    const c = await createProjectFolder(db, { projectId, name: 'C', parentId: b.id });

    expect(await wouldCreateCycle(db, a.id, c.id)).toBe(true);
    expect(await wouldCreateCycle(db, a.id, a.id)).toBe(true);
    expect(await wouldCreateCycle(db, a.id, null)).toBe(false);
    expect(await wouldCreateCycle(db, c.id, a.id)).toBe(false);
  });
});

describe('replacedStorageKey', () => {
  it('returns the old key when storagePath / fileKey changes', () => {
    expect(
      replacedStorageKey(
        { storagePath: 'old/key.pdf', fileKey: 'old/key.pdf' },
        { storagePath: 'new/key.pdf', fileKey: 'new/key.pdf' },
      ),
    ).toBe('old/key.pdf');
  });

  it('prefers fileKey over storagePath for the previous object', () => {
    expect(
      replacedStorageKey(
        { storagePath: 'legacy/path', fileKey: 'canonical/key' },
        { fileKey: 'new/key' },
      ),
    ).toBe('canonical/key');
  });

  it('returns null when storage is unchanged', () => {
    expect(
      replacedStorageKey(
        { storagePath: 'same/key', fileKey: 'same/key' },
        { storagePath: 'same/key', fileKey: 'same/key' },
      ),
    ).toBeNull();
  });

  it('returns null when the update does not change storage', () => {
    expect(
      replacedStorageKey(
        { storagePath: 'old/key', fileKey: 'old/key' },
        {},
      ),
    ).toBeNull();
  });

  it('ignores empty folder storage placeholders', () => {
    expect(
      replacedStorageKey(
        { storagePath: '', fileKey: null },
        { storagePath: 'new/key', fileKey: 'new/key' },
      ),
    ).toBeNull();
  });

  it('does not orphan fileKey on a storagePath-only partial update', () => {
    expect(
      replacedStorageKey(
        { storagePath: 'legacy/path', fileKey: 'canonical/a' },
        { storagePath: 'new/b' },
      ),
    ).toBeNull();
  });
});
