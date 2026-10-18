/**
 * pglite-backed tests for `checkFolderParent`: a folder may not become its
 * own parent or move under one of its subfolders, and the parent must exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { checkFolderParent } from './folders';

let db: Database;

async function folder(id: string, parentId: string | null, deletedAt: Date | null = null) {
  const now = new Date();
  await db.insert(schema.folders).values({
    id,
    name: id,
    parentId,
    createdAt: now,
    updatedAt: now,
    deletedAt,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // root ─ child ─ grandchild, plus a sibling tree and a trashed folder
  await folder('fld_root', null);
  await folder('fld_child', 'fld_root');
  await folder('fld_grandchild', 'fld_child');
  await folder('fld_other', null);
  await folder('fld_trashed', null, new Date());
}, 60_000);

describe('checkFolderParent', () => {
  it('allows My Drive and any unrelated folder as the parent', async () => {
    expect(await checkFolderParent(db, 'fld_child', null)).toBe('ok');
    expect(await checkFolderParent(db, 'fld_child', 'fld_other')).toBe('ok');
    expect(await checkFolderParent(db, 'fld_grandchild', 'fld_root')).toBe('ok');
  });

  it('rejects the folder as its own parent', async () => {
    expect(await checkFolderParent(db, 'fld_root', 'fld_root')).toBe('cycle');
  });

  it('rejects a parent inside the folder, at any depth', async () => {
    expect(await checkFolderParent(db, 'fld_root', 'fld_child')).toBe('cycle');
    expect(await checkFolderParent(db, 'fld_root', 'fld_grandchild')).toBe('cycle');
    expect(await checkFolderParent(db, 'fld_child', 'fld_grandchild')).toBe('cycle');
  });

  it('rejects a parent that does not exist or is in the trash', async () => {
    expect(await checkFolderParent(db, 'fld_child', 'fld_missing')).toBe('parent_not_found');
    expect(await checkFolderParent(db, 'fld_child', 'fld_trashed')).toBe('parent_not_found');
    expect(await checkFolderParent(db, null, 'fld_missing')).toBe('parent_not_found');
  });

  it('allows any live parent for a new folder', async () => {
    expect(await checkFolderParent(db, null, 'fld_grandchild')).toBe('ok');
  });
});
