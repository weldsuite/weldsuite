/**
 * TASK-854: the weekly purge removes R2 objects and rows of project files, task
 * attachments and project documents that were soft-deleted past the retention
 * window, and nothing else.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { purgeDeletedFiles, RETENTION_DAYS, type ObjectStore } from './purge-deleted-files';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
const old = new Date(now.getTime() - (RETENTION_DAYS + 5) * DAY);
const recent = new Date(now.getTime() - 2 * DAY);

function fakeStore() {
  const deleted: string[] = [];
  const store: ObjectStore = {
    delete: async (keys) => {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  return { store, deleted };
}

async function projectFile(id: string, key: string, deletedAt: Date | null, extra: Partial<typeof schema.projectFiles.$inferInsert> = {}) {
  await db.insert(schema.projectFiles).values({
    id,
    fileName: id,
    mimeType: 'text/plain',
    fileSize: 1,
    storagePath: key,
    fileKey: key,
    deletedAt,
    ...extra,
  });
}

async function driveFile(id: string, key: string, deletedAt: Date | null, entityType: string | null) {
  await db.insert(schema.files).values({
    id,
    fileName: id,
    mimeType: 'text/plain',
    fileSize: 1,
    storagePath: key,
    fileKey: key,
    deletedAt,
    entityType,
    entityId: 'prj_x',
  });
}

describe('purgeDeletedFiles', () => {
  it('removes old soft-deleted project files, keeps recent and live ones', async () => {
    await projectFile('pf_old', 'k/old', old);
    await projectFile('pf_recent', 'k/recent', recent);
    await projectFile('pf_live', 'k/live', null);
    await projectFile('pf_old_folder', '', old, { isFolder: true, fileType: 'folder', mimeType: 'inode/directory' });

    const { store, deleted } = fakeStore();
    const result = await purgeDeletedFiles(db, store, cutoff);

    expect(deleted).toContain('k/old');
    expect(deleted).not.toContain('k/recent');
    expect(deleted).not.toContain('k/live');
    expect(deleted).not.toContain('');
    const left = (await db.select({ id: schema.projectFiles.id }).from(schema.projectFiles)).map((r) => r.id);
    expect(left).toContain('pf_recent');
    expect(left).toContain('pf_live');
    expect(left).not.toContain('pf_old');
    expect(left).not.toContain('pf_old_folder');
    expect(result.rows).toBeGreaterThanOrEqual(2);
  });

  it('keeps the object when a surviving row still points at the same key', async () => {
    await projectFile('pf_shared_old', 'k/shared', old);
    await projectFile('pf_shared_live', 'k/shared', null);
    const { store, deleted } = fakeStore();
    await purgeDeletedFiles(db, store, cutoff);
    expect(deleted).not.toContain('k/shared');
    const rows = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.id, 'pf_shared_old'));
    expect(rows).toHaveLength(0);
  });

  it('purges project and task files with their document rows, but not other drive files', async () => {
    await driveFile('file_doc_old', 'k/doc', old, 'project');
    await driveFile('file_att_old', 'k/att', old, 'task');
    await driveFile('file_drive_old', 'k/drive', old, null);
    await driveFile('file_doc_recent', 'k/doc-recent', recent, 'project');
    await db.insert(schema.docs).values({ id: 'doc_old', fileId: 'file_doc_old', content: [] });
    await db
      .insert(schema.documentVersions)
      .values({ id: 'ver_old', fileId: 'file_doc_old', content: [], createdAt: old });

    const { store, deleted } = fakeStore();
    await purgeDeletedFiles(db, store, cutoff);

    expect(deleted).toEqual(expect.arrayContaining(['k/doc', 'k/att']));
    expect(deleted).not.toContain('k/drive');
    expect(deleted).not.toContain('k/doc-recent');
    const remaining = (await db.select({ id: schema.files.id }).from(schema.files)).map((r) => r.id);
    expect(remaining).toEqual(expect.arrayContaining(['file_drive_old', 'file_doc_recent']));
    expect(remaining).not.toContain('file_doc_old');
    expect(remaining).not.toContain('file_att_old');
    expect(await db.select().from(schema.docs).where(eq(schema.docs.id, 'doc_old'))).toHaveLength(0);
    expect(await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, 'ver_old'))).toHaveLength(0);
  });
});
