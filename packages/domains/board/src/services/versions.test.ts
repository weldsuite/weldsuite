import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/db/testing/pglite';
import * as schema from '@weldsuite/db/schema';
import type { TenantDb as Database } from '@weldsuite/db/lib/any-db';
import { createBoard } from './boards';
import { getVersion, insertVersion, listVersions, renameVersion, toVersion, versionEventData, versionKeyFor } from './versions';

const { boardVersions, whiteboards, files } = schema;
const WORKSPACE = 'org_versions_test';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(boardVersions);
  await db.delete(whiteboards);
  await db.delete(files);
  for (const id of ['brd_1', 'brd_2']) await createBoard(db, { workspaceId: WORKSPACE, boardId: id, name: id, folderId: null, userId: 'alice', snapshotSize: 1 });
});

/** A version of `boardId` saved `secondsAgo`. */
async function saved(id: string, boardId: string, secondsAgo: number, name: string | null = null) {
  await insertVersion(db, { id, boardId, revision: 100 - secondsAgo, name, snapshotKey: `k/${id}`, size: 10, createdById: 'alice' });
  const [row] = await db
    .update(boardVersions)
    .set({ createdAt: new Date(Date.UTC(2026, 0, 1) - secondsAgo * 1000) })
    .where(eq(boardVersions.id, id))
    .returning();
  return row!;
}

describe('board versions', () => {
  it('keeps a version’s snapshot next to the board’s checkpoint', () => {
    expect(versionKeyFor('workspaces/ws/boards/brd_1/board.json.gz', 'bv_1')).toBe('workspaces/ws/boards/brd_1/versions/bv_1.json.gz');
  });

  it('saves a version and shows it to the API and in events', async () => {
    const row = await saved('bv_1', 'brd_1', 0, 'Draft');
    expect(toVersion(row)).toEqual({ id: 'bv_1', boardId: 'brd_1', revision: 100, name: 'Draft', size: 10, createdAt: '2026-01-01T00:00:00.000Z', createdById: 'alice' });
    expect(versionEventData(row)).toEqual({ id: 'bv_1', boardId: 'brd_1', name: 'Draft', revision: 100, createdById: 'alice' });
  });

  it('finds a version of its own board only', async () => {
    await saved('bv_1', 'brd_1', 0);
    expect((await getVersion(db, 'brd_1', 'bv_1'))?.id).toBe('bv_1');
    expect(await getVersion(db, 'brd_2', 'bv_1')).toBeNull();
    expect(await getVersion(db, 'brd_1', 'bv_missing')).toBeNull();
  });

  it('lists versions newest first, a page after another', async () => {
    await saved('bv_a', 'brd_1', 30);
    await saved('bv_b', 'brd_1', 20);
    await saved('bv_c', 'brd_1', 20);
    await saved('bv_d', 'brd_1', 10);
    await saved('bv_other', 'brd_2', 0);
    const first = await listVersions(db, 'brd_1', { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(['bv_d', 'bv_c']);
    expect(first).toMatchObject({ total: 4, hasMore: true });
    // Same time: the id breaks the tie, so the cursor neither repeats nor skips one.
    const second = await listVersions(db, 'brd_1', { limit: 2, after: 'bv_c' });
    expect(second.rows.map((r) => r.id)).toEqual(['bv_b', 'bv_a']);
    expect(second).toMatchObject({ total: 4, hasMore: false });
    expect(await listVersions(db, 'brd_1', { limit: 2, after: 'bv_other' })).toEqual({ rows: [], total: 4, hasMore: false });
    expect(await listVersions(db, 'brd_missing', { limit: 2 })).toEqual({ rows: [], total: 0, hasMore: false });
  });

  it('renames a version of its own board only', async () => {
    await saved('bv_1', 'brd_1', 0);
    expect((await renameVersion(db, 'brd_1', 'bv_1', 'Final'))?.name).toBe('Final');
    expect(await renameVersion(db, 'brd_2', 'bv_1', 'Hijacked')).toBeNull();
    expect((await getVersion(db, 'brd_1', 'bv_1'))?.name).toBe('Final');
  });
});
