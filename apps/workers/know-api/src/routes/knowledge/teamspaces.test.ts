/**
 * DB-backed tests for WeldKnow teamspaces.
 *
 * The rules that must never regress:
 *
 *   1. A personal space opens for its owner and nobody else — not a teammate,
 *      and not a workspace admin holding `knowledge:manage`.
 *   2. Open teamspaces are readable by everyone; writing takes joining.
 *   3. Closed teamspaces are listed for everyone but read by members only, and
 *      only an owner adds people.
 *   4. Private teamspaces are invisible to non-members. `knowledge:manage` sees
 *      them and can fix them, but reading still takes joining.
 *   5. A viewer reads but does not write; a teamspace always keeps one owner.
 *   6. Default teamspaces pull in everyone once — leaving sticks.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { knowledgeRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const BASE = '/api/knowledge';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MEMBER_GRANTS = ['knowledge:read', 'knowledge:create', 'knowledge:update', 'knowledge:delete'];

const ALICE = 'user_alice';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const DAVE = 'user_dave';
const ADMIN = 'user_admin';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await db.insert(schema.workspaceMembers).values(
    [ALICE, BOB, CAROL, DAVE, ADMIN].map((userId) => ({
      id: `wm_${userId}`,
      userId,
      name: userId.replace('user_', ''),
      email: `${userId}@example.com`,
    })),
  );
}, 60_000);

function as(userId: string, grants: string[] = MEMBER_GRANTS) {
  const { request } = createTestApp(BASE, knowledgeRoutes, {
    context: {
      userId,
      permissions: permissions(...grants),
      tenantDb: db,
      workspaceId: 'org_know',
      orgId: 'org_know',
    },
  });
  return {
    get: (path: string) => request(`${BASE}${path}`),
    send: (method: string, path: string, body?: unknown) =>
      request(`${BASE}${path}`, {
        method,
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

const admin = () => as(ADMIN, [...MEMBER_GRANTS, 'knowledge:manage']);

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface SpaceBody {
  id: string;
  kind: 'personal' | 'team';
  name: string;
  visibility: string;
  role: string | null;
  isMember: boolean;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
}

async function spacesOf(caller: ReturnType<typeof as>) {
  return data<SpaceBody[]>(await caller.get('/spaces'));
}

async function createSpace(caller: ReturnType<typeof as>, body: Record<string, unknown>) {
  const res = await caller.send('POST', '/spaces', body);
  expect(res.status).toBe(201);
  return data<{ id: string }>(res);
}

async function createPage(caller: ReturnType<typeof as>, spaceId: string, title = 'Page') {
  return caller.send('POST', '/pages', { spaceId, title });
}

describe('personal space', () => {
  it('is created on first visit and opens for its owner only', async () => {
    const mine = (await spacesOf(as(ALICE))).filter((s) => s.kind === 'personal');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ role: 'owner', canWrite: true, canManage: false });

    // A second visit does not create another one.
    expect((await spacesOf(as(ALICE))).filter((s) => s.kind === 'personal')).toHaveLength(1);

    const page = await data<{ id: string }>(await createPage(as(ALICE), mine[0].id, 'Diary'));

    expect((await spacesOf(as(BOB))).map((s) => s.id)).not.toContain(mine[0].id);
    expect((await spacesOf(admin())).map((s) => s.id)).not.toContain(mine[0].id);
    expect((await as(BOB).get(`/pages/${page.id}`)).status).toBe(404);
    expect((await admin().get(`/pages/${page.id}`)).status).toBe(404);
    expect((await admin().send('POST', `/spaces/${mine[0].id}/members`, { userId: ADMIN, role: 'owner' })).status).toBe(404);
  });

  it('cannot be renamed or deleted', async () => {
    const [mine] = (await spacesOf(as(ALICE))).filter((s) => s.kind === 'personal');
    expect((await as(ALICE).send('PATCH', `/spaces/${mine.id}`, { name: 'Mine' })).status).toBe(403);
    expect((await as(ALICE).send('DELETE', `/spaces/${mine.id}`)).status).toBe(403);
  });
});

describe('open teamspace', () => {
  it('is readable by everyone, writable after joining', async () => {
    const space = await createSpace(as(ALICE), { name: 'Engineering', visibility: 'open' });
    const page = await data<{ id: string }>(await createPage(as(ALICE), space.id, 'Runbook'));

    const seen = (await spacesOf(as(BOB))).find((s) => s.id === space.id);
    expect(seen).toMatchObject({ isMember: false, canRead: true, canWrite: false });
    expect((await as(BOB).get(`/pages/${page.id}`)).status).toBe(200);
    expect((await as(BOB).send('PATCH', `/pages/${page.id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await createPage(as(BOB), space.id)).status).toBe(403);

    expect((await as(BOB).send('POST', `/spaces/${space.id}/join`)).status).toBe(200);
    expect((await as(BOB).send('PATCH', `/pages/${page.id}`, { title: 'Runbook v2' })).status).toBe(200);
    expect((await spacesOf(as(BOB))).find((s) => s.id === space.id)).toMatchObject({ role: 'editor' });

    // An editor cannot manage the teamspace.
    expect((await as(BOB).send('PATCH', `/spaces/${space.id}`, { name: 'Eng' })).status).toBe(403);
  });
});

describe('closed teamspace', () => {
  it('is listed for everyone but read by members only', async () => {
    const space = await createSpace(as(ALICE), { name: 'Leadership', visibility: 'closed' });
    const page = await data<{ id: string }>(await createPage(as(ALICE), space.id, 'Plans'));

    const seen = (await spacesOf(as(CAROL))).find((s) => s.id === space.id);
    expect(seen).toMatchObject({ isMember: false, canRead: false });
    expect((await as(CAROL).get(`/pages/${page.id}`)).status).toBe(404);
    expect((await as(CAROL).get(`/spaces/${space.id}/members`)).status).toBe(200);
    expect((await as(CAROL).send('POST', `/spaces/${space.id}/join`)).status).toBe(403);

    const tree = await data<{ id: string }[]>(await as(CAROL).get('/pages/tree'));
    expect(tree.map((p) => p.id)).not.toContain(page.id);

    expect((await as(ALICE).send('POST', `/spaces/${space.id}/members`, { userId: CAROL, role: 'viewer' })).status).toBe(201);
    expect((await as(CAROL).get(`/pages/${page.id}`)).status).toBe(200);
    // A viewer reads but does not write.
    expect((await as(CAROL).send('PUT', `/pages/${page.id}/content`, { contentJson: [] })).status).toBe(403);
    expect((await as(CAROL).send('DELETE', `/pages/${page.id}`)).status).toBe(403);
  });
});

describe('private teamspace', () => {
  it('is invisible to non-members; an admin sees and fixes it but joins to read', async () => {
    const space = await createSpace(as(ALICE), { name: 'Board', visibility: 'private' });
    const page = await data<{ id: string }>(await createPage(as(ALICE), space.id, 'Minutes'));

    expect((await spacesOf(as(DAVE))).map((s) => s.id)).not.toContain(space.id);
    expect((await as(DAVE).get(`/spaces/${space.id}/members`)).status).toBe(404);
    expect((await as(DAVE).send('POST', `/spaces/${space.id}/join`)).status).toBe(404);

    const seen = (await spacesOf(admin())).find((s) => s.id === space.id);
    expect(seen).toMatchObject({ isMember: false, canRead: false, canManage: true });
    expect((await admin().get(`/pages/${page.id}`)).status).toBe(404);

    expect((await admin().send('POST', `/spaces/${space.id}/members`, { userId: DAVE, role: 'editor' })).status).toBe(201);
    expect((await as(DAVE).get(`/pages/${page.id}`)).status).toBe(200);

    expect((await admin().send('POST', `/spaces/${space.id}/join`)).status).toBe(200);
    expect((await admin().get(`/pages/${page.id}`)).status).toBe(200);
  });
});

describe('ownership', () => {
  it('keeps one owner in every teamspace', async () => {
    const space = await createSpace(as(ALICE), { name: 'Sales', visibility: 'open' });
    expect((await as(ALICE).send('POST', `/spaces/${space.id}/leave`)).status).toBe(409);
    expect((await as(ALICE).send('PATCH', `/spaces/${space.id}/members/${ALICE}`, { role: 'editor' })).status).toBe(409);

    await as(ALICE).send('POST', `/spaces/${space.id}/members`, { userId: BOB, role: 'owner' });
    expect((await as(ALICE).send('POST', `/spaces/${space.id}/leave`)).status).toBe(204);
    expect((await spacesOf(as(ALICE))).find((s) => s.id === space.id)).toMatchObject({ isMember: false });
  });

  it('lets only members leave themselves and only owners remove others', async () => {
    const space = await createSpace(as(ALICE), { name: 'Support', visibility: 'open' });
    await as(BOB).send('POST', `/spaces/${space.id}/join`);
    await as(CAROL).send('POST', `/spaces/${space.id}/join`);
    expect((await as(BOB).send('DELETE', `/spaces/${space.id}/members/${CAROL}`)).status).toBe(403);
    expect((await as(BOB).send('DELETE', `/spaces/${space.id}/members/${BOB}`)).status).toBe(204);
    expect((await as(ALICE).send('DELETE', `/spaces/${space.id}/members/${CAROL}`)).status).toBe(204);
  });
});

describe('default teamspaces', () => {
  it('needs knowledge:manage', async () => {
    expect((await as(ALICE).send('POST', '/spaces', { name: 'All hands', isDefault: true })).status).toBe(403);
  });

  it('adds everyone once; leaving sticks', async () => {
    const space = await createSpace(admin(), { name: 'Company', visibility: 'closed', isDefault: true });

    expect((await spacesOf(as(BOB))).find((s) => s.id === space.id)).toMatchObject({ role: 'editor', canRead: true });

    expect((await as(BOB).send('POST', `/spaces/${space.id}/leave`)).status).toBe(204);
    expect((await spacesOf(as(BOB))).find((s) => s.id === space.id)).toMatchObject({ isMember: false, canRead: false });

    // Bringing them back is an owner's call, and clears the left marker.
    expect((await admin().send('POST', `/spaces/${space.id}/members`, { userId: BOB, role: 'viewer' })).status).toBe(201);
    expect((await spacesOf(as(BOB))).find((s) => s.id === space.id)).toMatchObject({ role: 'viewer' });
  });

  it('lazily adds people who were not around when it was switched on', async () => {
    const space = await createSpace(admin(), { name: 'Handbook', visibility: 'open' });
    expect((await admin().send('PATCH', `/spaces/${space.id}`, { isDefault: true })).status).toBe(200);

    await db.insert(schema.workspaceMembers).values({
      id: 'wm_user_erin',
      userId: 'user_erin',
      name: 'erin',
      email: 'erin@example.com',
    });
    expect((await spacesOf(as('user_erin'))).find((s) => s.id === space.id)).toMatchObject({ role: 'editor' });
  });

  it('does not pull in external or suspended members', async () => {
    const space = await createSpace(admin(), { name: 'Staff only', visibility: 'closed', isDefault: true });

    await db.insert(schema.workspaceMembers).values([
      { id: 'wm_user_guest', userId: 'user_guest', name: 'guest', email: 'guest@example.com', memberType: 'EXTERNAL' },
      { id: 'wm_user_gone', userId: 'user_gone', name: 'gone', email: 'gone@example.com', status: 'SUSPENDED' },
    ]);
    for (const userId of ['user_guest', 'user_gone']) {
      expect((await spacesOf(as(userId))).find((s) => s.id === space.id)).toMatchObject({
        isMember: false,
        canRead: false,
      });
    }
  });
});
