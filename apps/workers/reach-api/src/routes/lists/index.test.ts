import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import type { ReachProspectList } from '@weldsuite/app-api-client/schemas/reach';
import { reachProspectListMembers, reachProspectLists } from '@weldsuite/db/schema';
import listRoutes from './index';
import { asJson, readJson, reachApp } from '../../test-support/routes';
import { resetReach, seedProspect } from '../../test-support/reach';

let db: Database;
const app = (permissions = ['reach_prospects:read', 'reach_prospects:create', 'reach_prospects:update', 'reach_prospects:delete']) =>
  reachApp('/api/reach/lists', listRoutes, { permissions, db });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
});

const create = async (body: Record<string, unknown>) => (await readJson<{ data: ReachProspectList }>(await app().request('/api/reach/lists', asJson('POST', body)))).data;

describe('lists CRUD', () => {
  it('creates, reads, renames and deletes a list', async () => {
    const res = await app().request('/api/reach/lists', asJson('POST', { name: 'Conference', description: 'Met in Berlin' }));
    expect(res.status).toBe(201);
    const { data } = await readJson<{ data: ReachProspectList }>(res);
    expect(data).toMatchObject({ name: 'Conference', description: 'Met in Berlin', source: 'manual', prospectCount: 0 });
    expect(data.id).toMatch(/^rpl_/);

    expect((await readJson<{ data: ReachProspectList }>(await app().request(`/api/reach/lists/${data.id}`))).data.name).toBe('Conference');
    const renamed = await app().request(`/api/reach/lists/${data.id}`, asJson('PATCH', { name: 'Berlin 2026' }));
    expect((await readJson<{ data: ReachProspectList }>(renamed)).data).toMatchObject({ name: 'Berlin 2026', description: 'Met in Berlin' });

    expect((await app().request(`/api/reach/lists/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app().request(`/api/reach/lists/${data.id}`)).status).toBe(404);
    expect((await app().request(`/api/reach/lists/${data.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app().request('/api/reach/lists/rpl_nope', asJson('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await app().request('/api/reach/lists', asJson('POST', { name: '' }))).status).toBe(400);
  });

  it('lists newest first with a cursor and hides deleted lists', async () => {
    await create({ name: 'A' });
    await create({ name: 'B' });
    const c = await create({ name: 'C' });
    await app().request(`/api/reach/lists/${c.id}`, { method: 'DELETE' });

    const first = await readJson<{ data: ReachProspectList[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(await app().request('/api/reach/lists?limit=1'));
    expect(first.pagination).toMatchObject({ totalCount: 2, hasMore: true });
    const second = await readJson<{ data: ReachProspectList[] }>(await app().request(`/api/reach/lists?limit=1&cursor=${first.pagination.cursor}`));
    expect([...first.data, ...second.data].map((l) => l.name).sort()).toEqual(['A', 'B']);
  });

  it('is refused without the permissions', async () => {
    expect((await app(['reach_prospects:read']).request('/api/reach/lists', asJson('POST', { name: 'x' }))).status).toBe(403);
    expect((await app([]).request('/api/reach/lists')).status).toBe(403);
  });
});

describe('members', () => {
  it('adds prospects once, counts them, and removes them again', async () => {
    const list = await create({ name: 'L' });
    const p1 = await seedProspect(db);
    const p2 = await seedProspect(db);
    const deleted = await seedProspect(db, { deletedAt: new Date() });

    const add = await app().request(`/api/reach/lists/${list.id}/members`, asJson('POST', { prospectIds: [p1.id, p2.id, p1.id, deleted.id, 'rpro_nope'] }));
    expect((await readJson<{ data: { added: number } }>(add)).data.added).toBe(2);
    const again = await app().request(`/api/reach/lists/${list.id}/members`, asJson('POST', { prospectIds: [p1.id] }));
    expect((await readJson<{ data: { added: number } }>(again)).data.added).toBe(0);
    expect((await db.select().from(reachProspectLists).where(eq(reachProspectLists.id, list.id)))[0]?.prospectCount).toBe(2);

    const remove = await app().request(`/api/reach/lists/${list.id}/members/remove`, asJson('POST', { prospectIds: [p1.id, 'rpro_nope'] }));
    expect((await readJson<{ data: { removed: number } }>(remove)).data.removed).toBe(1);
    expect((await db.select().from(reachProspectLists).where(eq(reachProspectLists.id, list.id)))[0]?.prospectCount).toBe(1);
    expect(await db.select().from(reachProspectListMembers)).toHaveLength(1);
  });

  it('answers 404 for a list that does not exist and 400 for an empty selection', async () => {
    const list = await create({ name: 'L' });
    expect((await app().request('/api/reach/lists/rpl_nope/members', asJson('POST', { prospectIds: ['rpro_1'] }))).status).toBe(404);
    expect((await app().request('/api/reach/lists/rpl_nope/members/remove', asJson('POST', { prospectIds: ['rpro_1'] }))).status).toBe(404);
    expect((await app().request(`/api/reach/lists/${list.id}/members`, asJson('POST', { prospectIds: [] }))).status).toBe(400);
  });

  it('drops memberships when the list is deleted, keeping the prospects', async () => {
    const list = await create({ name: 'L' });
    const p = await seedProspect(db);
    await app().request(`/api/reach/lists/${list.id}/members`, asJson('POST', { prospectIds: [p.id] }));
    await app().request(`/api/reach/lists/${list.id}`, { method: 'DELETE' });
    expect(await db.select().from(reachProspectListMembers)).toHaveLength(0);
    expect((await readJson<{ data: unknown[] }>(await app().request('/api/reach/lists'))).data).toHaveLength(0);
  });
});
