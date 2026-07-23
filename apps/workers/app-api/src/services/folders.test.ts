/**
 * pglite-backed service tests for `services/folders.ts`. Covers
 * folder CRUD + the soft-delete / restore cycle the WeldDrive trash
 * UI depends on.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createFolder,
  getFolder,
  updateFolder,
  softDeleteFolder,
  restoreFolder,
  listTrashedFolders,
  listFolders,
} from './folders';
import { createPgliteDb } from '../test/pglite';
import type { Database } from '../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('folders service · pglite integration', () => {
  it('createFolder writes a row with the expected fields', async () => {
    const f = await createFolder(db, {
      name: 'Project Docs',
      createdById: 'user_test',
      color: '#ff8800',
    });
    expect(f.id).toMatch(/^fld_/);

    const fetched = await getFolder(db, f.id);
    expect(fetched?.name).toBe('Project Docs');
    expect(fetched?.color).toBe('#ff8800');
    expect(fetched?.createdById).toBe('user_test');
  });

  it('updateFolder writes only the provided fields', async () => {
    const f = await createFolder(db, {
      name: 'Before',
      createdById: 'user_test',
    });
    await updateFolder(db, f.id, { name: 'After' });

    const fetched = await getFolder(db, f.id);
    expect(fetched?.name).toBe('After');
    expect(fetched?.createdById).toBe('user_test'); // unchanged
  });

  it('soft-delete → restore round-trip', async () => {
    const f = await createFolder(db, {
      name: 'To Trash',
      createdById: 'user_test',
    });

    await softDeleteFolder(db, f.id);
    expect(await getFolder(db, f.id)).toBeNull();

    const trashed = await listTrashedFolders(db);
    expect(trashed.find((r) => r.id === f.id)).toBeDefined();

    await restoreFolder(db, f.id);
    const restored = await getFolder(db, f.id);
    expect(restored?.name).toBe('To Trash');
  });

  it('listFolders excludes soft-deleted rows', async () => {
    const keep = await createFolder(db, {
      name: 'KeepMe',
      createdById: 'user_test',
    });
    const drop = await createFolder(db, {
      name: 'DropMe',
      createdById: 'user_test',
    });
    await softDeleteFolder(db, drop.id);

    const all = await listFolders(db, { all: true });
    const ids = all.map((r) => r.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
  });
});
