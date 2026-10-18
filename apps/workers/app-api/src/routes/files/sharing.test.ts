/**
 * Per-person sharing on /api/files, /api/folders and /api/drive against
 * pglite: a restricted file shared with one teammate shows up under their
 * Shared with me, a member it was not shared with cannot open it, and the
 * roles decide who may change it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { filesRoutes } from './index';
import { foldersRoutes } from '../folders';
import { driveRoutes } from '../drive';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ANN = 'user_ann';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const ADMIN = 'user_admin';

const DRIVE_PERMISSIONS = [
  'files:read', 'files:create', 'files:update', 'files:delete',
  'folders:read', 'folders:create', 'folders:update', 'folders:delete',
];

let db: Database;

function as(userId: string, { admin = false } = {}) {
  const context = {
    tenantDb: db,
    userId,
    // `*` resolves as the admin role in the test harness.
    permissions: admin ? permissions('*') : permissions(...DRIVE_PERMISSIONS),
  };
  const apps = {
    files: createTestApp('/api/files', filesRoutes, { context }),
    folders: createTestApp('/api/folders', foldersRoutes, { context }),
    drive: createTestApp('/api/drive', driveRoutes, { context }),
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
    post: (path: string, body: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
    delete: (path: string) => send('DELETE', path),
  };
}

async function json<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function seedMember(userId: string, role = 'MEMBER', status = 'ACTIVE') {
  const now = new Date();
  await db.insert(schema.workspaceMembers).values({
    id: `wm_${userId}`,
    userId,
    email: `${userId}@test.dev`,
    name: userId.replace('user_', ''),
    role,
    status,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.workspaceMembers.$inferInsert);
}

async function upload(who: ReturnType<typeof as>, fileName: string, folderId?: string): Promise<{ id: string }> {
  const res = await who.post('/api/files', {
    fileName,
    mimeType: 'text/plain',
    fileSize: 10,
    storagePath: `workspaces/w/${fileName}`,
    folderId,
  });
  expect(res.status).toBe(201);
  return json(res);
}

const ann = () => as(ANN);
const bob = () => as(BOB);
const carol = () => as(CAROL);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMember(ANN);
  await seedMember(BOB);
  await seedMember(CAROL);
  await seedMember(ADMIN, 'ADMIN');
  await seedMember('user_gone', 'MEMBER', 'DEACTIVATED');
}, 60_000);

describe('sharing a restricted file with one teammate', () => {
  let file: { id: string };

  beforeAll(async () => {
    file = await upload(ann(), 'salaries.txt');
    expect((await ann().patch(`/api/files/${file.id}`, { generalAccess: 'restricted' })).status).toBe(200);
    const res = await ann().put(`/api/files/${file.id}/shares/${BOB}`, { role: 'viewer' });
    expect(res.status).toBe(200);
  });

  it('shows the file under Shared with me for the teammate', async () => {
    const shared = await json<{ files: { id: string; sharedRole: string; sharedBy: string; accessRole: string }[] }>(
      await bob().get('/api/drive/shared'),
    );
    expect(shared.files.map((f) => f.id)).toEqual([file.id]);
    expect(shared.files[0]).toMatchObject({ sharedRole: 'viewer', sharedBy: ANN, accessRole: 'viewer' });
  });

  it('lets the teammate open it, as a viewer', async () => {
    const res = await bob().get(`/api/files/${file.id}`);
    expect(res.status).toBe(200);
    expect(await json<{ accessRole: string; effectiveAccess: string }>(res)).toMatchObject({
      accessRole: 'viewer',
      effectiveAccess: 'restricted',
    });
  });

  it('keeps it from a member it was not shared with', async () => {
    expect((await carol().get(`/api/files/${file.id}`)).status).toBe(404);
    expect((await carol().get(`/api/files/${file.id}/content`)).status).toBe(404);
    expect((await carol().get(`/api/files/${file.id}/shares`)).status).toBe(404);
    expect((await carol().patch(`/api/files/${file.id}`, { fileName: 'mine.txt' })).status).toBe(404);
    expect((await carol().delete(`/api/files/${file.id}`)).status).toBe(404);

    const list = await json<{ id: string }[]>(await carol().get('/api/files?pageSize=200'));
    expect(list.map((f) => f.id)).not.toContain(file.id);
    const all = await json<{ id: string }[]>(await carol().get('/api/drive/all?pageSize=200'));
    expect(all.map((f) => f.id)).not.toContain(file.id);
    expect((await json<{ files: unknown[] }>(await carol().get('/api/drive/shared'))).files).toEqual([]);
  });

  it('stops a viewer from changing or re-sharing it', async () => {
    expect((await bob().patch(`/api/files/${file.id}`, { fileName: 'renamed.txt' })).status).toBe(403);
    expect((await bob().delete(`/api/files/${file.id}`)).status).toBe(403);
    expect((await bob().put(`/api/files/${file.id}/shares/${CAROL}`, { role: 'viewer' })).status).toBe(403);
  });

  it('lists the owner and the teammate in its sharing', async () => {
    const sharing = await json<{
      owner: { userId: string };
      generalAccess: string;
      accessRole: string;
      shares: { userId: string; role: string }[];
    }>(await ann().get(`/api/files/${file.id}/shares`));
    expect(sharing.owner.userId).toBe(ANN);
    expect(sharing.generalAccess).toBe('restricted');
    expect(sharing.accessRole).toBe('owner');
    expect(sharing.shares).toEqual([expect.objectContaining({ userId: BOB, role: 'viewer' })]);
  });

  it('lets an editor change it', async () => {
    expect((await ann().put(`/api/files/${file.id}/shares/${BOB}`, { role: 'editor' })).status).toBe(200);
    expect((await bob().patch(`/api/files/${file.id}`, { fileName: 'salaries-2026.txt' })).status).toBe(200);
  });

  it('opens it to workspace admins', async () => {
    expect((await as(ADMIN, { admin: true }).get(`/api/files/${file.id}`)).status).toBe(200);
  });

  it('lets the teammate leave it, after which it is gone for them', async () => {
    const res = await bob().delete(`/api/files/${file.id}/shares/${BOB}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toBeNull();
    expect((await bob().get(`/api/files/${file.id}`)).status).toBe(404);
    expect((await json<{ files: unknown[] }>(await bob().get('/api/drive/shared'))).files).toEqual([]);
  });
});

describe('who a file can be shared with', () => {
  let file: { id: string };

  beforeAll(async () => {
    file = await upload(ann(), 'plan.txt');
  });

  it('refuses the owner, yourself, a stranger and a deactivated member', async () => {
    expect((await bob().put(`/api/files/${file.id}/shares/${ANN}`, { role: 'viewer' })).status).toBe(400);
    expect((await ann().put(`/api/files/${file.id}/shares/${ANN}`, { role: 'viewer' })).status).toBe(400);
    expect((await ann().put(`/api/files/${file.id}/shares/user_stranger`, { role: 'viewer' })).status).toBe(400);
    expect((await ann().put(`/api/files/${file.id}/shares/user_gone`, { role: 'viewer' })).status).toBe(400);
  });

  it('refuses an unknown role', async () => {
    expect((await ann().put(`/api/files/${file.id}/shares/${BOB}`, { role: 'owner' })).status).toBe(400);
  });

  it('answers 404 when removing a share that does not exist', async () => {
    expect((await ann().delete(`/api/files/${file.id}/shares/${CAROL}`)).status).toBe(404);
  });

  it('keeps a workspace file open to everyone after sharing it', async () => {
    expect((await ann().put(`/api/files/${file.id}/shares/${BOB}`, { role: 'viewer' })).status).toBe(200);
    expect((await carol().get(`/api/files/${file.id}`)).status).toBe(200);
    const shared = await json<{ files: { id: string }[] }>(await bob().get('/api/drive/shared'));
    expect(shared.files.map((f) => f.id)).toContain(file.id);
  });
});

describe('sharing a folder', () => {
  let folder: { id: string };
  let inside: { id: string };

  beforeAll(async () => {
    const res = await ann().post('/api/folders', { name: 'HR' });
    expect(res.status).toBe(201);
    folder = await json(res);
    expect((await ann().patch(`/api/folders/${folder.id}`, { generalAccess: 'restricted' })).status).toBe(200);
    inside = await upload(ann(), 'contract.txt', folder.id);
  });

  it('hides a restricted folder and what is in it', async () => {
    expect((await carol().get(`/api/folders/${folder.id}`)).status).toBe(404);
    expect((await carol().get(`/api/files/${inside.id}`)).status).toBe(404);
    const folders = await json<{ id: string }[]>(await carol().get('/api/folders?all=true'));
    expect(folders.map((f) => f.id)).not.toContain(folder.id);
    expect((await carol().post('/api/files', {
      fileName: 'sneaky.txt',
      mimeType: 'text/plain',
      fileSize: 1,
      storagePath: 'workspaces/w/sneaky.txt',
      folderId: folder.id,
    })).status).toBe(404);
  });

  it('opens the folder and its files to the teammate it is shared with', async () => {
    expect((await ann().put(`/api/folders/${folder.id}/shares/${CAROL}`, { role: 'viewer' })).status).toBe(200);

    const shared = await json<{ folders: { id: string; sharedRole: string }[] }>(await carol().get('/api/drive/shared'));
    expect(shared.folders).toEqual([expect.objectContaining({ id: folder.id, sharedRole: 'viewer' })]);

    const list = await json<{ id: string; accessRole: string }[]>(await carol().get(`/api/files?pageSize=200`));
    expect(list.find((f) => f.id === inside.id)?.accessRole).toBe('viewer');

    const sharing = await json<{ inherited: { userId: string; folderName: string }[] }>(
      await ann().get(`/api/files/${inside.id}/shares`),
    );
    expect(sharing.inherited).toEqual([expect.objectContaining({ userId: CAROL, folderName: 'HR' })]);
  });

  it('keeps a viewer from adding to or moving things out of the folder', async () => {
    expect((await carol().post('/api/folders', { name: 'Mine', parentId: folder.id })).status).toBe(403);
    expect((await carol().post(`/api/files/${inside.id}/move`, { folderId: null })).status).toBe(403);
  });

  it('keeps the trash to what the caller may see', async () => {
    const trashed = await upload(ann(), 'old-contract.txt', folder.id);
    expect((await ann().delete(`/api/files/${trashed.id}`)).status).toBe(200);
    const bobTrash = await json<{ files: { id: string }[] }>(await bob().get('/api/drive/trash'));
    expect(bobTrash.files.map((f) => f.id)).not.toContain(trashed.id);
    expect((await bob().post(`/api/drive/trash/restore/file/${trashed.id}`, {})).status).toBe(404);
    // Bob empties his trash; Ann's restricted file survives it.
    expect((await bob().delete('/api/drive/trash/empty')).status).toBe(200);
    const annTrash = await json<{ files: { id: string }[] }>(await ann().get('/api/drive/trash'));
    expect(annTrash.files.map((f) => f.id)).toContain(trashed.id);
  });
});
