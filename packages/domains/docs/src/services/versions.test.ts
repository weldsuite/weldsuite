import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDoc } from './docs';
import { getVersion, insertVersion, listVersions, renameVersion, toVersion, versionEventData, versionKeyFor } from './versions';

const { docVersions, docs, files } = schema;
const WORKSPACE = 'org_versions_test';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(docVersions);
  await db.delete(docs);
  await db.delete(files);
  for (const id of ['doc_1', 'doc_2']) await createDoc(db, { workspaceId: WORKSPACE, docId: id, name: id, folderId: null, userId: 'alice', snapshotSize: 1 });
});

/** A version of `docId` saved `secondsAgo`. */
async function saved(id: string, docId: string, secondsAgo: number, name: string | null = null) {
  await insertVersion(db, { id, docId, revision: 100 - secondsAgo, name, snapshotKey: `k/${id}`, size: 10, createdById: 'alice' });
  const [row] = await db
    .update(docVersions)
    .set({ createdAt: new Date(Date.UTC(2026, 0, 1) - secondsAgo * 1000) })
    .where(eq(docVersions.id, id))
    .returning();
  return row!;
}

describe('document versions', () => {
  it('keeps a version’s snapshot next to the document’s checkpoint', () => {
    expect(versionKeyFor('workspaces/ws/docs/doc_1/document.json.gz', 'dv_1')).toBe('workspaces/ws/docs/doc_1/versions/dv_1.json.gz');
  });

  it('saves a version and shows it to the API and in events', async () => {
    const row = await saved('dv_1', 'doc_1', 0, 'Draft');
    expect(toVersion(row)).toEqual({ id: 'dv_1', docId: 'doc_1', revision: 100, name: 'Draft', size: 10, createdAt: '2026-01-01T00:00:00.000Z', createdById: 'alice' });
    expect(versionEventData(row)).toEqual({ id: 'dv_1', docId: 'doc_1', name: 'Draft', revision: 100, createdById: 'alice' });
  });

  it('finds a version of its own document only', async () => {
    await saved('dv_1', 'doc_1', 0);
    expect((await getVersion(db, 'doc_1', 'dv_1'))?.id).toBe('dv_1');
    expect(await getVersion(db, 'doc_2', 'dv_1')).toBeNull();
    expect(await getVersion(db, 'doc_1', 'dv_missing')).toBeNull();
  });

  it('lists versions newest first, a page after another', async () => {
    await saved('dv_a', 'doc_1', 30);
    await saved('dv_b', 'doc_1', 20);
    await saved('dv_c', 'doc_1', 20);
    await saved('dv_d', 'doc_1', 10);
    await saved('dv_other', 'doc_2', 0);
    const first = await listVersions(db, 'doc_1', { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(['dv_d', 'dv_c']);
    expect(first).toMatchObject({ total: 4, hasMore: true });
    // Same time: the id breaks the tie, so the cursor neither repeats nor skips one.
    const second = await listVersions(db, 'doc_1', { limit: 2, after: 'dv_c' });
    expect(second.rows.map((r) => r.id)).toEqual(['dv_b', 'dv_a']);
    expect(second).toMatchObject({ total: 4, hasMore: false });
    expect(await listVersions(db, 'doc_1', { limit: 2, after: 'dv_other' })).toEqual({ rows: [], total: 4, hasMore: false });
    expect(await listVersions(db, 'doc_missing', { limit: 2 })).toEqual({ rows: [], total: 0, hasMore: false });
  });

  it('renames a version of its own document only', async () => {
    await saved('dv_1', 'doc_1', 0);
    expect((await renameVersion(db, 'doc_1', 'dv_1', 'Final'))?.name).toBe('Final');
    expect(await renameVersion(db, 'doc_2', 'dv_1', 'Hijacked')).toBeNull();
    expect((await getVersion(db, 'doc_1', 'dv_1'))?.name).toBe('Final');
  });
});
