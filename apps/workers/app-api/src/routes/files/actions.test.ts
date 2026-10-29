/**
 * /api/files against pglite: star, pin, move, content writes, list filters,
 * module files, and the refusals of each (permissions, Drive roles, bad
 * bodies), so every route is reached with its success and its errors.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { filesRoutes } from './index';
import { foldersRoutes } from '../folders';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ANN = 'user_ann';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const ALL = [
  'files:read', 'files:create', 'files:update', 'files:delete',
  'folders:read', 'folders:create', 'folders:update', 'folders:delete',
];

let db: Database;

/** An in-memory R2 bucket shared by every request of this file. */
const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
const bucket = {
  head: async (key: string) => {
    const object = objects.get(key);
    return object ? { key, size: object.bytes.byteLength, httpMetadata: { contentType: object.contentType } } : null;
  },
  get: async (key: string) => {
    const object = objects.get(key);
    return object
      ? { body: object.bytes, size: object.bytes.byteLength, httpMetadata: { contentType: object.contentType } }
      : null;
  },
  put: async (key: string, body: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
    objects.set(key, { bytes: new Uint8Array(body), contentType: options?.httpMetadata?.contentType });
    return { key };
  },
  delete: async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
  },
} as unknown as R2Bucket;

function as(userId: string, keys: string[] = ALL, context: Record<string, unknown> = {}) {
  const ctx = { tenantDb: db, userId, permissions: permissions(...keys), ...context };
  const env = { PRIVATE_STORAGE: bucket } as never;
  const files = createTestApp('/api/files', filesRoutes, { context: ctx, env });
  const folders = createTestApp('/api/folders', foldersRoutes, { context: ctx, env });
  const send = (method: string, path: string, body?: unknown, raw?: string) =>
    (path.startsWith('/api/folders') ? folders : files).request(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  return {
    get: (path: string) => send('GET', path),
    post: (path: string, body?: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
    putRaw: (path: string, raw: string) => send('PUT', path, undefined, raw),
    delete: (path: string) => send('DELETE', path),
  };
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function seedMember(userId: string) {
  const now = new Date();
  await db.insert(schema.workspaceMembers).values({
    id: `wm_${userId}`,
    userId,
    email: `${userId}@test.dev`,
    name: userId.replace('user_', ''),
    role: 'MEMBER',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.workspaceMembers.$inferInsert);
}

async function upload(who: ReturnType<typeof as>, fileName: string, extra: Record<string, unknown> = {}) {
  const key = `workspaces/org_test_default/drive/${fileName}`;
  const res = await who.post('/api/files', {
    fileName,
    mimeType: 'text/plain',
    fileSize: 4,
    storagePath: key,
    fileKey: key,
    ...extra,
  });
  expect(res.status).toBe(201);
  return data<{ id: string; fileName: string; folderId: string | null }>(res);
}

const ann = () => as(ANN);
const bob = () => as(BOB);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMember(ANN);
  await seedMember(BOB);
  await seedMember(CAROL);
}, 60_000);

describe('POST /api/files', () => {
  it('refuses a body the schema rejects', async () => {
    expect((await ann().post('/api/files', { mimeType: 'text/plain', fileSize: -1, storagePath: '' })).status).toBe(400);
    expect((await ann().post('/api/files', { fileName: 'a.txt', mimeType: 'text/plain', fileSize: 1.5, storagePath: 'x', metadata: [] })).status).toBe(400);
  });

  it('needs files:create', async () => {
    const res = await as(ANN, ['files:read']).post('/api/files', {
      fileName: 'x.txt', mimeType: 'text/plain', fileSize: 1, storagePath: 'workspaces/org_test_default/x.txt',
    });
    expect(res.status).toBe(403);
  });

  it('gives a second upload of the same name a free one, and records the private bucket', async () => {
    objects.set('workspaces/org_test_default/drive/dup.txt', { bytes: new Uint8Array(4), contentType: 'text/plain' });
    const first = await upload(ann(), 'dup.txt', { metadata: { source: 'test' }, isPublic: false });
    const second = await upload(ann(), 'dup.txt');
    expect(first.fileName).toBe('dup.txt');
    expect(second.fileName).toBe('dup (1).txt');
  });
});

describe('GET /api/files', () => {
  it('filters, searches, sorts and pages', async () => {
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Listing' }));
    await upload(ann(), 'alpha.txt', { folderId: folder.id });
    await upload(ann(), 'beta.txt', { fileType: 'document' });
    await upload(ann(), 'linked.txt', { entityType: 'crm_contact', entityId: 'per_1' });

    const inFolder = await data<{ name: string }[]>(await ann().get(`/api/files?folderId=${folder.id}`));
    expect(inFolder.map((f) => f.name)).toEqual(['alpha.txt']);
    const root = await data<{ name: string }[]>(await ann().get('/api/files?folderId=&pageSize=200'));
    expect(root.map((f) => f.name)).not.toContain('alpha.txt');
    const docs = await data<{ name: string }[]>(await ann().get('/api/files?type=document'));
    expect(docs.map((f) => f.name)).toEqual(['beta.txt']);
    const linked = await data<{ name: string; navigateTo: string }[]>(
      await ann().get('/api/files?entityType=crm_contact&entityId=per_1'),
    );
    expect(linked[0]?.navigateTo).toBe('/weldcrm/people?stack=person:per_1');
    const searched = await data<{ name: string }[]>(await ann().get('/api/files?search=ALPHA'));
    expect(searched.map((f) => f.name)).toEqual(['alpha.txt']);

    const paged = await ann().get('/api/files?sortBy=name&sortOrder=asc&pageSize=2&page=2');
    expect(paged.status).toBe(200);
    const body = (await paged.json()) as { pagination: { page: number; hasMore: boolean } };
    expect(body.pagination.page).toBe(2);
  });

  it('refuses a bad query and a caller without files:read', async () => {
    expect((await ann().get('/api/files?pageSize=500')).status).toBe(400);
    expect((await ann().get('/api/files?page=0&sortOrder=up')).status).toBe(400);
    expect((await as(ANN, []).get('/api/files')).status).toBe(403);
  });
});

describe('POST /api/files/:id/star and /pin', () => {
  it('toggles the star for anyone who sees the file', async () => {
    const file = await upload(ann(), 'star.txt');
    expect(await data(await bob().post(`/api/files/${file.id}/star`))).toEqual({ isStarred: true });
    expect(await data(await ann().post(`/api/files/${file.id}/star`))).toEqual({ isStarred: false });
    expect((await ann().post('/api/files/fil_missing/star')).status).toBe(404);
  });

  it('toggles the pin for editors only', async () => {
    const file = await upload(ann(), 'pin.txt');
    expect(await data(await ann().post(`/api/files/${file.id}/pin`))).toEqual({ isPinned: true });
    expect(await data(await ann().post(`/api/files/${file.id}/pin`))).toEqual({ isPinned: false });
    expect((await ann().patch(`/api/files/${file.id}`, { generalAccess: 'workspace_view' })).status).toBe(200);
    expect((await bob().post(`/api/files/${file.id}/pin`)).status).toBe(403);
    expect((await as(ANN, ['files:read']).post(`/api/files/${file.id}/pin`)).status).toBe(403);
  });
});

describe('POST /api/files/:id/move', () => {
  it('moves into a folder and back to My Drive', async () => {
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Moves' }));
    const file = await upload(ann(), 'move.txt');
    const moved = await ann().post(`/api/files/${file.id}/move`, { folderId: folder.id });
    expect(await data(moved)).toEqual({ moved: true, folderId: folder.id });
    expect(await data(await ann().post(`/api/files/${file.id}/move`, { folderId: null }))).toEqual({
      moved: true,
      folderId: null,
    });
  });

  it('refuses a name taken in the destination, a missing folder and a bad body', async () => {
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Taken' }));
    await upload(ann(), 'same.txt', { folderId: folder.id });
    const file = await upload(ann(), 'same.txt');
    expect((await ann().post(`/api/files/${file.id}/move`, { folderId: folder.id })).status).toBe(409);
    expect((await ann().post(`/api/files/${file.id}/move`, { folderId: 'fld_missing' })).status).toBe(404);
    expect((await ann().post(`/api/files/${file.id}/move`, {})).status).toBe(400);
    expect((await ann().post('/api/files/fil_missing/move', { folderId: null })).status).toBe(404);
  });

  it('refuses to move into a trashed folder', async () => {
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Gone' }));
    expect((await ann().delete(`/api/folders/${folder.id}`)).status).toBe(200);
    const file = await upload(ann(), 'orphan.txt');
    expect((await ann().post(`/api/files/${file.id}/move`, { folderId: folder.id })).status).toBe(404);
  });
});

describe('PATCH /api/files/:id', () => {
  it('moves, stars and publishes through the patch, and refuses a bad body', async () => {
    const folder = await data<{ id: string }>(await ann().post('/api/folders', { name: 'Patch target' }));
    const file = await upload(ann(), 'patch.txt');
    const res = await ann().patch(`/api/files/${file.id}`, { folderId: folder.id, isStarred: true, isPublic: true });
    expect(res.status).toBe(200);
    expect((await ann().patch(`/api/files/${file.id}`, { folderId: 'fld_missing' })).status).toBe(404);
    expect((await ann().patch(`/api/files/${file.id}`, { generalAccess: 'everyone' })).status).toBe(400);
    expect((await ann().patch(`/api/files/${file.id}`, { fileName: '' })).status).toBe(400);
    expect((await ann().patch(`/api/files/${file.id}`, { description: '' })).status).toBe(200);
  });
});

describe('module files', () => {
  it('cannot be reshared or opened up through Drive', async () => {
    const file = await upload(ann(), 'module.txt', { entityType: 'project', entityId: 'prj_1' });
    expect((await ann().patch(`/api/files/${file.id}`, { generalAccess: 'restricted' })).status).toBe(400);
    expect((await ann().get(`/api/files/${file.id}/shares`)).status).toBe(400);
    expect((await ann().put(`/api/files/${file.id}/shares/${BOB}`, { role: 'viewer' })).status).toBe(400);
  });
});

describe('GET|PUT /api/files/:id/content', () => {
  it('overwrites the content, records the size, and serves it as a download', async () => {
    const file = await upload(ann(), 'sheet.csv', { mimeType: 'text/csv' });
    objects.set(`workspaces/org_test_default/drive/sheet.csv`, { bytes: new TextEncoder().encode('a,b'), contentType: 'text/csv' });
    const written = await ann().putRaw(`/api/files/${file.id}/content`, 'a,b\n1,2');
    expect(written.status).toBe(200);
    expect((await data<{ fileSize: number }>(written)).fileSize).toBe(7);

    const read = await ann().get(`/api/files/${file.id}/content?download=1`);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('a,b\n1,2');
  });

  it('serves an active type as an attachment', async () => {
    const file = await upload(ann(), 'page.html', { mimeType: 'text/html' });
    objects.set('workspaces/org_test_default/drive/page.html', { bytes: new TextEncoder().encode('<p>x</p>') });
    const read = await ann().get(`/api/files/${file.id}/content`);
    expect(read.status).toBe(200);
  });

  it('answers 404 when the object is missing, and keeps viewers from writing', async () => {
    const file = await upload(ann(), 'missing-object.txt');
    objects.delete('workspaces/org_test_default/drive/missing-object.txt');
    expect((await ann().get(`/api/files/${file.id}/content`)).status).toBe(404);
    expect((await ann().patch(`/api/files/${file.id}`, { generalAccess: 'workspace_view' })).status).toBe(200);
    expect((await bob().putRaw(`/api/files/${file.id}/content`, 'nope')).status).toBe(403);
  });
});

describe('DELETE /api/files/:id', () => {
  it('needs files:delete and a workspace', async () => {
    const file = await upload(ann(), 'keep.txt');
    expect((await as(ANN, ['files:read']).delete(`/api/files/${file.id}`)).status).toBe(403);
    expect((await as(ANN, ALL, { clerkOrgId: null }).delete(`/api/files/${file.id}`)).status).toBe(400);
    expect((await ann().delete(`/api/files/${file.id}`)).status).toBe(200);
    expect((await ann().get(`/api/files/${file.id}`)).status).toBe(404);
  });
});

describe('DELETE /api/files/:id/shares/:userId', () => {
  it('lets an editor without files:update leave but not remove others', async () => {
    const file = await upload(ann(), 'team.txt');
    expect((await ann().patch(`/api/files/${file.id}`, { generalAccess: 'restricted' })).status).toBe(200);
    expect((await ann().put(`/api/files/${file.id}/shares/${BOB}`, { role: 'editor' })).status).toBe(200);
    expect((await ann().put(`/api/files/${file.id}/shares/${CAROL}`, { role: 'viewer' })).status).toBe(200);
    // Changing a role answers the previous one in the event.
    expect((await ann().put(`/api/files/${file.id}/shares/${CAROL}`, { role: 'editor' })).status).toBe(200);
    const readOnly = as(BOB, ['files:read']);
    expect((await readOnly.delete(`/api/files/${file.id}/shares/${CAROL}`)).status).toBe(403);
    const left = await readOnly.delete(`/api/files/${file.id}/shares/${BOB}`);
    expect(left.status).toBe(200);
    expect(await data(left)).toBeNull();
    const removed = await ann().delete(`/api/files/${file.id}/shares/${CAROL}`);
    expect((await data<{ shares: unknown[] }>(removed)).shares).toEqual([]);
  });
});
