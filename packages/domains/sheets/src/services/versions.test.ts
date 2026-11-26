import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createSheet } from './sheets';
import { getVersion, insertVersion, listVersions, renameVersion, toVersion, versionEventData, versionKeyFor } from './versions';

const { sheetVersions, sheets, files } = schema;
const WORKSPACE = 'org_versions_test';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(sheetVersions);
  await db.delete(sheets);
  await db.delete(files);
  for (const id of ['sht_1', 'sht_2']) await createSheet(db, { workspaceId: WORKSPACE, sheetId: id, name: id, folderId: null, userId: 'alice', snapshotSize: 1 });
});

/** A version of `sheetId` saved `secondsAgo`. */
async function saved(id: string, sheetId: string, secondsAgo: number, name: string | null = null) {
  await insertVersion(db, { id, sheetId, revision: 100 - secondsAgo, name, snapshotKey: `k/${id}`, size: 10, createdById: 'alice' });
  const [row] = await db
    .update(sheetVersions)
    .set({ createdAt: new Date(Date.UTC(2026, 0, 1) - secondsAgo * 1000) })
    .where(eq(sheetVersions.id, id))
    .returning();
  return row!;
}

describe('sheet versions', () => {
  it('keeps a version’s snapshot next to the sheet’s checkpoint', () => {
    expect(versionKeyFor('workspaces/ws/sheets/sht_1/workbook.json.gz', 'sv_1')).toBe('workspaces/ws/sheets/sht_1/versions/sv_1.json.gz');
  });

  it('saves a version and shows it to the API and in events', async () => {
    const row = await saved('sv_1', 'sht_1', 0, 'Draft');
    expect(toVersion(row)).toEqual({ id: 'sv_1', sheetId: 'sht_1', revision: 100, name: 'Draft', size: 10, createdAt: '2026-01-01T00:00:00.000Z', createdById: 'alice' });
    expect(versionEventData(row)).toEqual({ id: 'sv_1', sheetId: 'sht_1', name: 'Draft', revision: 100, createdById: 'alice' });
  });

  it('finds a version of its own sheet only', async () => {
    await saved('sv_1', 'sht_1', 0);
    expect((await getVersion(db, 'sht_1', 'sv_1'))?.id).toBe('sv_1');
    expect(await getVersion(db, 'sht_2', 'sv_1')).toBeNull();
    expect(await getVersion(db, 'sht_1', 'sv_missing')).toBeNull();
  });

  it('lists versions newest first, a page after another', async () => {
    await saved('sv_a', 'sht_1', 30);
    await saved('sv_b', 'sht_1', 20);
    await saved('sv_c', 'sht_1', 20);
    await saved('sv_d', 'sht_1', 10);
    await saved('sv_other', 'sht_2', 0);
    const first = await listVersions(db, 'sht_1', { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(['sv_d', 'sv_c']);
    expect(first).toMatchObject({ total: 4, hasMore: true });
    // Same time: the id breaks the tie, so the cursor neither repeats nor skips one.
    const second = await listVersions(db, 'sht_1', { limit: 2, after: 'sv_c' });
    expect(second.rows.map((r) => r.id)).toEqual(['sv_b', 'sv_a']);
    expect(second).toMatchObject({ total: 4, hasMore: false });
    expect(await listVersions(db, 'sht_1', { limit: 2, after: 'sv_other' })).toEqual({ rows: [], total: 4, hasMore: false });
    expect(await listVersions(db, 'sht_missing', { limit: 2 })).toEqual({ rows: [], total: 0, hasMore: false });
  });

  it('renames a version of its own sheet only', async () => {
    await saved('sv_1', 'sht_1', 0);
    expect((await renameVersion(db, 'sht_1', 'sv_1', 'Final'))?.name).toBe('Final');
    expect(await renameVersion(db, 'sht_2', 'sv_1', 'Hijacked')).toBeNull();
    expect((await getVersion(db, 'sht_1', 'sv_1'))?.name).toBe('Final');
  });
});
