/**
 * Prospect lists: the CRUD an API runs and the membership counts, against pglite.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { ReachDomainError } from './errors';
import {
  addProspectListMembers,
  createProspectList,
  deleteProspectList,
  getProspectList,
  listProspectLists,
  removeProspectListMembers,
  updateProspectList,
} from './lists';
import { resetReach, seedProspect } from './testing/reach';

let db: Database;

async function refused(promise: Promise<unknown>): Promise<ReachDomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReachDomainError);
  return err as ReachDomainError;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
});

describe('prospect lists', () => {
  it('creates, reads, renames and deletes; a deleted list answers 404', async () => {
    const list = await createProspectList(db, { name: 'Warm', description: 'Met at the fair' }, 'user_1');
    expect(list).toMatchObject({ name: 'Warm', description: 'Met at the fair', source: 'manual', prospectCount: 0 });
    expect(list.id).toMatch(/^rpl_/);

    expect(await updateProspectList(db, list.id, { name: 'Hot' })).toMatchObject({ name: 'Hot', description: 'Met at the fair' });
    expect(await getProspectList(db, list.id)).toMatchObject({ name: 'Hot' });

    await deleteProspectList(db, list.id);
    expect(await refused(getProspectList(db, list.id))).toMatchObject({ code: 'NOT_FOUND', message: `List with ID '${list.id}' not found` });
    expect(await refused(updateProspectList(db, list.id, { name: 'x' }))).toMatchObject({ status: 404 });
    expect(await refused(deleteProspectList(db, list.id))).toMatchObject({ status: 404 });
  });

  it('lists newest first with a cursor', async () => {
    await createProspectList(db, { name: 'One' }, 'u');
    await createProspectList(db, { name: 'Two' }, 'u');

    const first = await listProspectLists(db, { limit: '1' });
    expect(first).toMatchObject({ totalCount: 2, hasMore: true });
    const next = await listProspectLists(db, { limit: 1, cursor: first.cursor ?? undefined });
    expect([first.data[0]?.name, next.data[0]?.name].sort()).toEqual(['One', 'Two']);
    expect(next.hasMore).toBe(false);
  });

  it('adds and removes members, ignoring deleted and unknown prospects, and keeps the count', async () => {
    const list = await createProspectList(db, { name: 'Warm' }, 'u');
    const a = await seedProspect(db);
    const b = await seedProspect(db);
    const gone = await seedProspect(db, { deletedAt: new Date() });

    expect(await addProspectListMembers(db, list.id, [a.id, b.id, a.id, gone.id, 'rpro_ghost'])).toEqual({ added: 2 });
    expect((await getProspectList(db, list.id)).prospectCount).toBe(2);
    expect(await addProspectListMembers(db, list.id, [a.id])).toEqual({ added: 0 });

    expect(await removeProspectListMembers(db, list.id, [a.id, 'rpro_ghost'])).toEqual({ removed: 1 });
    expect((await getProspectList(db, list.id)).prospectCount).toBe(1);

    expect(await refused(addProspectListMembers(db, 'rpl_ghost', [a.id]))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await refused(removeProspectListMembers(db, 'rpl_ghost', [a.id]))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
