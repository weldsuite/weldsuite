/**
 * WeldKnow through the public API: teamspaces and pages on the rules know-api
 * shares (`@weldsuite/know-domain/access`). A workspace key reaches open
 * teamspaces only and acts in them as an owner; a personal key follows the
 * person's memberships. Pages take plain text / light markdown (`content`) or
 * BlockNote blocks (`contentJson`), move within and across spaces, and go to
 * the trash with their sub-pages.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';
import type { ApiKeySession } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // A personal key's person must be a teammate to own the teamspace they create.
  await db
    .insert(schema.workspaceMembers)
    .values({ id: 'wm_know_ext', userId: 'user_know_ext', role: 'ADMIN' } as typeof schema.workspaceMembers.$inferInsert)
    .onConflictDoNothing();
}, 60_000);

const workspaceKey: ApiKeySession = {
  keyId: 'key_know_ws',
  keyType: 'workspace',
  workspaceId: 'ws_test',
  userId: null,
  scopes: ['knowledge:read', 'knowledge:write'],
  tier: 'enterprise',
  databaseUrl: null,
  licensedApps: null,
} as ApiKeySession;

const personalKey = (userId: string): ApiKeySession =>
  ({ ...workspaceKey, keyId: `key_${userId}`, keyType: 'personal', userId }) as ApiKeySession;

const as = (session: ApiKeySession) => {
  const { request } = createExternalTestApp({ session, tenantDb: db });
  return {
    get: (path: string) => request(path),
    post: (path: string, body: unknown) =>
      request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) =>
      request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }),
    del: (path: string) => request(path, { method: 'DELETE' }),
  };
};

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

describe('external-api · knowledge spaces', () => {
  it('lets a workspace key create and manage open teamspaces only', async () => {
    const key = as(workspaceKey);
    expect((await key.post('/v1/knowledge-spaces', { name: 'Closed', visibility: 'closed' })).status).toBe(400);
    expect((await key.post('/v1/knowledge-spaces', { name: 'Default', isDefault: true })).status).toBe(403);

    const res = await key.post('/v1/knowledge-spaces', { name: 'Know ext open', icon: null });
    expect(res.status, await res.clone().text()).toBe(201);
    const space = await data<{ id: string; kind: string; visibility: string; sortOrder: number; createdBy: string | null }>(res);
    expect(space).toMatchObject({ kind: 'team', visibility: 'open', createdBy: null });
    expect(typeof space.sortOrder).toBe('number');

    const listed = await data<{ id: string; canWrite: boolean; role: string | null; memberCount: number }[]>(
      await key.get('/v1/knowledge-spaces'),
    );
    expect(listed.find((s) => s.id === space.id)).toMatchObject({ canWrite: true, role: null, memberCount: 0 });
    expect((await key.get(`/v1/knowledge-spaces/${space.id}`)).status).toBe(200);

    expect((await key.patch(`/v1/knowledge-spaces/${space.id}`, { visibility: 'private' })).status).toBe(400);
    expect((await key.patch(`/v1/knowledge-spaces/${space.id}`, { isDefault: true })).status).toBe(403);
    const renamed = await key.patch(`/v1/knowledge-spaces/${space.id}`, { name: 'Know ext renamed', sortOrder: 7 });
    expect(renamed.status).toBe(200);
    expect(await data(renamed)).toMatchObject({ name: 'Know ext renamed', sortOrder: 7 });
    expect((await key.patch('/v1/knowledge-spaces/kspc_missing', { name: 'x' })).status).toBe(404);
    expect((await key.del('/v1/knowledge-spaces/kspc_missing')).status).toBe(404);
  });

  it('makes a personal key the owner, and hides closed spaces from a key', async () => {
    const person = as(personalKey('user_know_ext'));
    const res = await person.post('/v1/knowledge-spaces', { name: 'Know ext closed', visibility: 'closed', sortOrder: 3 });
    expect(res.status, await res.clone().text()).toBe(201);
    const space = await data<{ id: string }>(res);
    const mine = await data<{ id: string; role: string | null; canManage: boolean }[]>(await person.get('/v1/knowledge-spaces'));
    expect(mine.find((s) => s.id === space.id)).toMatchObject({ role: 'owner', canManage: true });

    // A key does not see a closed teamspace at all.
    const key = as(workspaceKey);
    expect((await key.get(`/v1/knowledge-spaces/${space.id}`)).status).toBe(404);
    expect((await key.del(`/v1/knowledge-spaces/${space.id}`)).status).toBe(404);
    // Another person sees it exists but cannot change it.
    const other = as(personalKey('user_know_other'));
    expect((await other.get(`/v1/knowledge-spaces/${space.id}`)).status).toBe(200);
    expect((await other.patch(`/v1/knowledge-spaces/${space.id}`, { name: 'Taken' })).status).toBe(403);
    expect((await other.del(`/v1/knowledge-spaces/${space.id}`)).status).toBe(403);

    // A person who is no teammate cannot become an owner: the worker's 500.
    const stranger = as(personalKey('user_know_stranger'));
    expect((await stranger.post('/v1/knowledge-spaces', { name: 'Nobody' })).status).toBe(500);

    expect((await person.del(`/v1/knowledge-spaces/${space.id}`)).status).toBe(204);
    expect((await person.get(`/v1/knowledge-spaces/${space.id}`)).status).toBe(404);
  });
});

describe('external-api · knowledge pages', () => {
  it('writes pages from text and blocks, lists, trees, moves and trashes them', async () => {
    const key = as(workspaceKey);
    const a = await data<{ id: string }>(await key.post('/v1/knowledge-spaces', { name: 'Know ext A' }));
    const b = await data<{ id: string }>(await key.post('/v1/knowledge-spaces', { name: 'Know ext B' }));

    expect((await key.post('/v1/knowledge-pages', { spaceId: 'kspc_missing', title: 'x' })).status).toBe(404);
    expect((await key.post('/v1/knowledge-pages', { title: 'no space' })).status).toBe(400);

    const rootRes = await key.post('/v1/knowledge-pages', {
      spaceId: a.id,
      title: 'Know ext root',
      content: '# Heading\n\n- one\n2. two\nplain words  ',
    });
    expect(rootRes.status, await rootRes.clone().text()).toBe(201);
    const root = await data<{ id: string; position: number; contentText: string; contentJson: unknown[] }>(rootRes);
    expect(root.position).toBe(0);
    expect(root.contentText).toBe('Heading one two plain words');
    expect(root.contentJson).toHaveLength(4);

    const untitled = await data<{ id: string; title: string; position: number }>(
      await key.post('/v1/knowledge-pages', { spaceId: a.id, title: '' }),
    );
    expect(untitled).toMatchObject({ title: 'Untitled', position: 1 });

    const child = await data<{ id: string; parentId: string; position: number }>(
      await key.post('/v1/knowledge-pages', {
        spaceId: a.id,
        parentId: root.id,
        title: 'Know ext child',
        contentJson: [{ type: 'paragraph', content: [{ type: 'text', text: 'block   body' }], children: [] }],
      }),
    );
    expect(child).toMatchObject({ parentId: root.id, position: 0 });
    expect((await key.post('/v1/knowledge-pages', { spaceId: b.id, parentId: root.id })).status).toBe(400);
    expect((await key.post('/v1/knowledge-pages', { spaceId: a.id, parentId: 'kpag_missing' })).status).toBe(404);

    const search = await data<{ id: string }[]>(await key.get(`/v1/knowledge-pages?spaceId=${a.id}&search=block`));
    expect(search.map((p) => p.id)).toEqual([child.id]);
    const children = await data<{ id: string }[]>(await key.get(`/v1/knowledge-pages?parentId=${root.id}`));
    expect(children.map((p) => p.id)).toEqual([child.id]);
    expect(await data(await key.get('/v1/knowledge-pages?spaceId=kspc_nowhere'))).toEqual([]);

    const tree = await data<{ id: string; position: number }[]>(await key.get(`/v1/knowledge-pages/tree?spaceId=${a.id}`));
    expect(tree.map((p) => p.id)).toEqual([root.id, child.id, untitled.id]);
    expect(Object.keys(tree[0] ?? {}).sort()).toEqual(['icon', 'id', 'parentId', 'position', 'spaceId', 'title', 'updatedAt']);
    expect(await data(await key.get('/v1/knowledge-pages/tree?spaceId=kspc_nowhere'))).toEqual([]);

    // Locked pages refuse new content unless the same call unlocks them.
    expect((await key.patch(`/v1/knowledge-pages/${child.id}`, { isLocked: true })).status).toBe(200);
    expect((await key.patch(`/v1/knowledge-pages/${child.id}`, { content: 'new' })).status).toBe(409);
    const unlocked = await key.patch(`/v1/knowledge-pages/${child.id}`, { content: 'new text', isLocked: false, icon: null });
    expect(unlocked.status).toBe(200);
    expect(await data(unlocked)).toMatchObject({ contentText: 'new text', isLocked: false, icon: null });
    expect((await key.patch('/v1/knowledge-pages/kpag_missing', { title: 'x' })).status).toBe(404);

    // Moves: not under itself, then across spaces with the subtree.
    expect((await key.post(`/v1/knowledge-pages/${root.id}/move`, { parentId: child.id })).status).toBe(400);
    expect((await key.post(`/v1/knowledge-pages/${root.id}/move`, { spaceId: b.id })).status).toBe(400);
    expect((await key.post(`/v1/knowledge-pages/${root.id}/move`, { parentId: null, spaceId: 'kspc_missing' })).status).toBe(404);
    const moved = await key.post(`/v1/knowledge-pages/${root.id}/move`, { parentId: null, spaceId: b.id });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await data(moved)).toMatchObject({ spaceId: b.id, parentId: null, position: 0 });
    expect(await data(await key.get(`/v1/knowledge-pages/${child.id}`))).toMatchObject({ spaceId: b.id });
    const under = await key.post(`/v1/knowledge-pages/${untitled.id}/move`, { parentId: null, position: 4 });
    expect(await data(under)).toMatchObject({ position: 4 });

    expect((await key.del(`/v1/knowledge-pages/${root.id}`)).status).toBe(204);
    expect((await key.get(`/v1/knowledge-pages/${child.id}`)).status).toBe(404);
    expect((await key.del(`/v1/knowledge-pages/${root.id}`)).status).toBe(404);

    // Deleting a space trashes its pages.
    expect((await key.del(`/v1/knowledge-spaces/${a.id}`)).status).toBe(204);
    expect((await key.get(`/v1/knowledge-pages/${untitled.id}`)).status).toBe(404);
  });

  it('keeps a viewer to reading', async () => {
    const owner = as(personalKey('user_know_ext'));
    const space = await data<{ id: string }>(await owner.post('/v1/knowledge-spaces', { name: 'Know ext viewers', visibility: 'open' }));
    const page = await data<{ id: string }>(await owner.post('/v1/knowledge-pages', { spaceId: space.id, title: 'Read me' }));
    // Not a member of an open space: may read, not write.
    const reader = as(personalKey('user_know_reader'));
    expect((await reader.get(`/v1/knowledge-pages/${page.id}`)).status).toBe(200);
    expect((await reader.patch(`/v1/knowledge-pages/${page.id}`, { title: 'Mine' })).status).toBe(403);
    expect((await reader.post(`/v1/knowledge-pages/${page.id}/move`, { parentId: null })).status).toBe(403);
    expect((await reader.del(`/v1/knowledge-pages/${page.id}`)).status).toBe(403);
    expect((await reader.post('/v1/knowledge-pages', { spaceId: space.id, title: 'x' })).status).toBe(403);
    expect((await owner.del(`/v1/knowledge-spaces/${space.id}`)).status).toBe(204);
  });
});
