/**
 * Moving existing private drive files to the private bucket (TASK-620),
 * against pglite.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { files } from '@weldsuite/db/schema';
import { migratePrivateFilesBatch } from './private-storage-migration';

const WS = 'org_a';
const API = 'https://app-api.example';

function memoryBucket(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const bucket = {
    objects,
    head: async (key: string) => (objects.has(key) ? { key } : null),
    get: async (key: string) =>
      objects.has(key) ? { key, body: objects.get(key), httpMetadata: { contentType: 'application/pdf' }, customMetadata: {} } : null,
    put: async (key: string, body: string) => {
      objects.set(key, body);
      return { key };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
  return bucket as typeof bucket & R2Bucket;
}

let db: Database;

async function addFile(id: string, key: string, extra: Partial<typeof files.$inferInsert> = {}) {
  await db.insert(files).values({
    id,
    fileName: `${id}.pdf`,
    mimeType: 'application/pdf',
    fileSize: 6,
    storagePath: key,
    fileKey: key,
    url: `https://files.example/${key}`,
    ...extra,
  });
}

const key = (name: string) => `workspaces/${WS}/drive/general/1_x/${name}.pdf`;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(files);
});

describe('migratePrivateFilesBatch', () => {
  it('moves private drive files and leaves everything else alone', async () => {
    await addFile('file_1', key('a'));
    await addFile('file_2', key('b'), { isPublic: true });
    await addFile('file_3', key('c'), { entityType: 'ticket', entityId: 't1' });
    await addFile('file_4', 'workspaces/org_other/x/y.pdf');
    const env = {
      STORAGE: memoryBucket({ [key('a')]: 'A', [key('b')]: 'B', [key('c')]: 'C', 'workspaces/org_other/x/y.pdf': 'Y' }),
      PRIVATE_STORAGE: memoryBucket(),
    };

    const result = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API });

    expect(result).toMatchObject({ moved: 1, repointed: 0, done: true });
    // Only the moved row is reported for a file:updated event, with its new url.
    expect(result.updated).toEqual([
      expect.objectContaining({ id: 'file_1', name: 'file_1.pdf', url: `${API}/api/storage/private/${key('a')}` }),
    ]);
    expect(result.skipped).toEqual([{ id: 'file_4', reason: 'foreign-key' }]);
    expect(env.PRIVATE_STORAGE.objects.get(key('a'))).toBe('A');
    expect(env.STORAGE.objects.has(key('a'))).toBe(false);
    expect([...env.STORAGE.objects.keys()].sort()).toEqual(
      [key('b'), key('c'), 'workspaces/org_other/x/y.pdf'].sort(),
    );

    const [row] = await db.select().from(files).where(eq(files.id, 'file_1'));
    expect(row).toMatchObject({ url: `${API}/api/storage/private/${key('a')}`, bucket: 'private' });
  });

  it('changes nothing on a dry run', async () => {
    await addFile('file_1', key('a'));
    const env = { STORAGE: memoryBucket({ [key('a')]: 'A' }), PRIVATE_STORAGE: memoryBucket() };

    const result = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API, dryRun: true });

    expect(result.moved).toBe(1);
    expect(result.updated).toEqual([]);
    expect(env.STORAGE.objects.has(key('a'))).toBe(true);
    expect(env.PRIVATE_STORAGE.objects.size).toBe(0);
  });

  it('finishes a move that crashed after the copy', async () => {
    await addFile('file_1', key('a'));
    const env = { STORAGE: memoryBucket({ [key('a')]: 'A' }), PRIVATE_STORAGE: memoryBucket({ [key('a')]: 'A' }) };

    const result = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API });

    expect(result).toMatchObject({ moved: 0, repointed: 1 });
    expect(result.updated.map((u) => u.id)).toEqual(['file_1']);
    expect(env.STORAGE.objects.has(key('a'))).toBe(false);
  });

  it('pages with a cursor and skips files already moved', async () => {
    for (const n of ['1', '2', '3']) await addFile(`file_${n}`, key(n));
    const env = {
      STORAGE: memoryBucket({ [key('1')]: '1', [key('2')]: '2', [key('3')]: '3' }),
      PRIVATE_STORAGE: memoryBucket(),
    };

    const first = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API, limit: 2 });
    expect(first).toMatchObject({ moved: 2, cursor: 'file_2', done: false });
    const second = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API, limit: 2, cursor: first.cursor });
    expect(second).toMatchObject({ moved: 1, done: true });

    const again = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API });
    expect(again).toMatchObject({ moved: 0, repointed: 0, done: true });
  });

  it('reports rows whose object is gone', async () => {
    await addFile('file_1', key('a'));
    const env = { STORAGE: memoryBucket(), PRIVATE_STORAGE: memoryBucket() };
    const result = await migratePrivateFilesBatch({ db, env, workspaceId: WS, apiOrigin: API });
    expect(result.skipped).toEqual([{ id: 'file_1', reason: 'missing-object' }]);
  });
});
