/**
 * /api/drive against pglite: the counters, the feed across sources, the
 * trash (restore and purge of files and folders, objects removed from the
 * bucket), and folder sharing seen from the folder's side.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { driveRoutes } from './index';
import { filesRoutes } from '../files';
import { foldersRoutes } from '../folders';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ANN = 'user_ann';
const BOB = 'user_bob';
const ALL = [
  'files:read', 'files:create', 'files:update', 'files:delete',
  'folders:read', 'folders:create', 'folders:update', 'folders:delete',
];

let db: Database;

const objects = new Map<string, Uint8Array>();
const bucket = {
  head: async (key: string) => (objects.has(key) ? { key, size: objects.get(key)!.byteLength } : null),
  get: async (key: string) => (objects.has(key) ? { body: objects.get(key), size: objects.get(key)!.byteLength } : null),
  put: async (key: string, body: Uint8Array) => {
    objects.set(key, new Uint8Array(body));
    return { key };
  },
  delete: async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
  },
} as unknown as R2Bucket;

function as(userId: string, keys: string[] = ALL) {
  const context = { tenantDb: db, userId, permissions: permissions(...keys) };
  const env = { PRIVATE_STORAGE: bucket, R2_PUBLIC_URL: 'https://files.example/' } as never;
  const apps = {
    files: createTestApp('/api/files', filesRoutes, { context, env }),
    folders: createTestApp('/api/folders', foldersRoutes, { context, env }),
    drive: createTestApp('/api/drive', driveRoutes, { context, env }),
  };
  const pick = (path: string) => {
    if (path.startsWith('/api/folders')) return apps.folders;
    if (path.startsWith('/api/drive')) return apps.drive;
    return apps.files;
  };
  const send = (method: string, path: string, body?: unknown) =>
    pick(path).request(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    get: (path: string) => send('GET', path),
    post: (path: string, body?: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
    delete: (path: string) => send('DELETE', path),
  };
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function seedMember(userId: string, role = 'MEMBER') {
  const now = new Date();
  await db.insert(schema.workspaceMembers).values({
    id: `wm_${userId}`,
    userId,
    email: `${userId}@test.dev`,
    name: userId.replace('user_', ''),
    role,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.workspaceMembers.$inferInsert);
}

async function upload(who: ReturnType<typeof as>, fileName: string, folderId?: string) {
  const key = `workspaces/org_test_default/drive/${fileName}`;
  objects.set(key, new TextEncoder().encode(fileName));
  const res = await who.post('/api/files', {
    fileName,
    mimeType: 'text/plain',
    fileSize: fileName.length,
    storagePath: key,
    fileKey: key,
    folderId,
  });
  expect(res.status).toBe(201);
  return data<{ id: string; fileKey: string }>(res);
}

const ann = () => as(ANN);
const bob = () => as(BOB);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMember(ANN);
  await seedMember(BOB);
  // A public-bucket file that stores only its key, and a project whiteboard
  // and document for the feed.
  const now = new Date('2026-01-02T03:04:05.678Z');
  await db.insert(schema.files).values({
    id: 'fil_public_key',
    fileName: 'logo.png',
    mimeType: 'image/png',
    fileSize: 10,
    fileType: 'image',
    storagePath: 'workspaces/org_test_default/logo.png',
    fileKey: 'workspaces/org_test_default/logo.png',
    bucket: 'public',
    uploadedById: ANN,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.files.$inferInsert);
  await db.insert(schema.files).values({
    id: 'fil_private_key',
    fileName: 'contract.pdf',
    mimeType: 'application/pdf',
    fileSize: 10,
    fileType: 'pdf',
    storagePath: 'workspaces/org_test_default/contract pdf.pdf',
    fileKey: 'workspaces/org_test_default/contract pdf.pdf',
    bucket: 'private',
    uploadedById: ANN,
    metadata: { weldsheetId: 'sht_1' },
    createdAt: now,
    updatedAt: now,
  } as typeof schema.files.$inferInsert);
}, 60_000);

describe('GET /api/drive/all and /stats', () => {
  it('lists Drive files with their URLs, filtered by source and type', async () => {
    const all = await ann().get('/api/drive/all?pageSize=200');
    expect(all.status).toBe(200);
    const body = (await all.json()) as {
      data: { id: string; url: string | null; navigateTo: string | null }[];
      summary: { totalFiles: number };
    };
    const byId = new Map(body.data.map((f) => [f.id, f]));
    expect(byId.get('fil_public_key')?.url).toBe('https://files.example/workspaces/org_test_default/logo.png');
    expect(byId.get('fil_private_key')?.url).toBe(
      'http://localhost/api/storage/private/workspaces/org_test_default/contract%20pdf.pdf',
    );
    expect(byId.get('fil_private_key')?.navigateTo).toBe('/weldsheets/sht_1');

    const images = await data<{ id: string }[]>(await ann().get('/api/drive/all?source=drive&type=image'));
    expect(images.map((f) => f.id)).toEqual(['fil_public_key']);
    const mail = await data<unknown[]>(await ann().get('/api/drive/all?source=mail'));
    expect(mail).toEqual([]);
    expect((await ann().get('/api/drive/all?sortOrder=sideways')).status).toBe(400);
  });

  it('counts what the caller may see', async () => {
    const stats = await data<{ totalFiles: number; bySource: Record<string, number> }>(
      await ann().get('/api/drive/stats'),
    );
    expect(stats.bySource.drive).toBe(stats.totalFiles);
  });
});

describe('the trash', () => {
  it('restores a file and purges another with its object', async () => {
    const keep = await upload(ann(), 'keep.txt');
    const gone = await upload(ann(), 'gone.txt');
    expect((await ann().delete(`/api/files/${keep.id}`)).status).toBe(200);
    expect((await ann().delete(`/api/files/${gone.id}`)).status).toBe(200);

    const trash = await data<{ files: { id: string }[] }>(await ann().get('/api/drive/trash'));
    expect(trash.files.map((f) => f.id)).toEqual(expect.arrayContaining([keep.id, gone.id]));

    expect(await data(await ann().post(`/api/drive/trash/restore/file/${keep.id}`))).toEqual({ restored: true });
    expect((await ann().get(`/api/files/${keep.id}`)).status).toBe(200);
    expect((await ann().post(`/api/drive/trash/restore/file/${keep.id}`)).status).toBe(404);

    expect(await data(await ann().delete(`/api/drive/trash/file/${gone.id}`))).toEqual({ deleted: true });
    expect(objects.has(gone.fileKey)).toBe(false);
    expect((await ann().delete(`/api/drive/trash/file/${gone.id}`)).status).toBe(404);
  });

  it('refuses a viewer, and restores and purges folders', async () => {
    const res = await ann().post('/api/folders', { name: 'Archive' });
    const folder = await data<{ id: string }>(res);
    const inside = await upload(ann(), 'archived.txt', folder.id);
    const readOnly = await upload(ann(), 'read-only.txt');
    expect((await ann().patch(`/api/files/${readOnly.id}`, { generalAccess: 'workspace_view' })).status).toBe(200);
    expect((await ann().delete(`/api/files/${readOnly.id}`)).status).toBe(200);
    expect((await bob().post(`/api/drive/trash/restore/file/${readOnly.id}`)).status).toBe(403);
    expect((await bob().delete(`/api/drive/trash/file/${readOnly.id}`)).status).toBe(403);

    expect((await ann().delete(`/api/folders/${folder.id}`)).status).toBe(200);
    expect(await data(await ann().post(`/api/drive/trash/restore/folder/${folder.id}`))).toEqual({ restored: true });
    expect((await ann().post(`/api/drive/trash/restore/folder/${folder.id}`)).status).toBe(404);

    expect((await ann().patch(`/api/folders/${folder.id}`, { generalAccess: 'workspace_view' })).status).toBe(200);
    expect((await ann().delete(`/api/folders/${folder.id}`)).status).toBe(200);
    expect((await bob().post(`/api/drive/trash/restore/folder/${folder.id}`)).status).toBe(403);
    expect((await bob().delete(`/api/drive/trash/folder/${folder.id}`)).status).toBe(403);
    expect(await data(await ann().delete(`/api/drive/trash/folder/${folder.id}`))).toEqual({ deleted: true });
    expect(objects.has(inside.fileKey)).toBe(false);
    expect((await ann().delete(`/api/drive/trash/folder/${folder.id}`)).status).toBe(404);
    expect((await ann().post('/api/drive/trash/restore/folder/fld_missing')).status).toBe(404);
  });

  it('empties what the caller may change', async () => {
    const file = await upload(ann(), 'empty-me.txt');
    expect((await ann().delete(`/api/files/${file.id}`)).status).toBe(200);
    expect(await data(await ann().delete('/api/drive/trash/empty'))).toEqual({ emptied: true });
    const trash = await data<{ files: { id: string }[] }>(await ann().get('/api/drive/trash'));
    expect(trash.files.map((f) => f.id)).not.toContain(file.id);
    expect(objects.has(file.fileKey)).toBe(false);
  });
});

describe('folder sharing', () => {
  it('lists, changes and removes who a folder is shared with', async () => {
    const parent = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Clients' }));
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Acme', parentId: parent.id }));
    expect((await ann().patch(`/api/folders/${parent.id}`, { generalAccess: 'restricted' })).status).toBe(200);
    expect((await bob().get(`/api/folders/${folder.id}`)).status).toBe(404);

    expect((await ann().put(`/api/folders/${parent.id}/shares/${BOB}`, { role: 'viewer' })).status).toBe(200);
    const sharing = await data<{ inherited: { userId: string }[]; accessRole: string }>(
      await ann().get(`/api/folders/${folder.id}/shares`),
    );
    expect(sharing.inherited.map((s) => s.userId)).toEqual([BOB]);
    expect((await bob().get(`/api/folders/${folder.id}`)).status).toBe(200);
    const listed = await data<{ id: string }[]>(await bob().get(`/api/folders?parentId=${parent.id}`));
    expect(listed.map((f) => f.id)).toEqual([folder.id]);

    expect((await bob().put(`/api/folders/${parent.id}/shares/${ANN}`, { role: 'viewer' })).status).toBe(403);
    expect((await ann().put(`/api/folders/${parent.id}/shares/${ANN}`, { role: 'viewer' })).status).toBe(400);
    expect((await ann().put(`/api/folders/${parent.id}/shares/user_nobody`, { role: 'viewer' })).status).toBe(400);
    expect((await ann().put(`/api/folders/${parent.id}/shares/${BOB}`, { role: 'admin' })).status).toBe(400);
    expect((await ann().put(`/api/folders/${parent.id}/shares/${BOB}`, { role: 'editor' })).status).toBe(200);
    expect((await as(BOB, ['folders:read']).delete(`/api/folders/${parent.id}/shares/${ANN}`)).status).toBe(403);
    expect((await ann().delete(`/api/folders/${parent.id}/shares/user_nobody`)).status).toBe(404);

    const left = await bob().delete(`/api/folders/${parent.id}/shares/${BOB}`);
    expect(left.status).toBe(200);
    expect(await data(left)).toBeNull();
    expect((await ann().put(`/api/folders/${parent.id}/shares/${BOB}`, { role: 'viewer' })).status).toBe(200);
    const removed = await ann().delete(`/api/folders/${parent.id}/shares/${BOB}`);
    expect((await data<{ shares: unknown[] }>(removed)).shares).toEqual([]);
  });

  it('refuses folder writes without the permission or the role', async () => {
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Locked' }));
    expect((await as(ANN, ['folders:read']).post('/api/folders', { name: 'No' })).status).toBe(403);
    expect((await as(ANN, []).get('/api/folders')).status).toBe(403);
    expect((await as(ANN, []).get(`/api/folders/${folder.id}`)).status).toBe(403);
    expect((await as(ANN, ['folders:read']).delete(`/api/folders/${folder.id}`)).status).toBe(403);
    expect((await ann().patch(`/api/folders/${folder.id}`, { generalAccess: 'workspace_view', color: null })).status).toBe(200);
    expect((await bob().patch(`/api/folders/${folder.id}`, { name: 'Mine' })).status).toBe(403);
    expect((await bob().delete(`/api/folders/${folder.id}`)).status).toBe(403);
    expect((await ann().get('/api/folders/fld_missing')).status).toBe(404);
    expect((await ann().get('/api/folders/fld_missing/shares')).status).toBe(404);
    const created = await ann().post('/api/folders', { name: 'Colourful', color: 'red', icon: 'star' });
    expect(created.status).toBe(201);
  });
});
