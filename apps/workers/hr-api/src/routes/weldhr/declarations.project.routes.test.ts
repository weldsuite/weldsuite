/**
 * Route tests for the WeldFlow project cost tag on expense declarations
 * (FLOW-019): `projectId` on create and update, null to take it off, a live
 * project of the workspace only, returned by the list and the writes, never
 * accepted from My HR. A tag moves no money, so HR can set it on an approved
 * or paid declaration too.
 *
 * Compared against the Rust port (rust/modules/hr) in conformance mode.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { HR_ADMIN, daysFromToday, data, errorOf, hrCaller, hrDb, resetHr, seedEmployee, seedMember } from '../../test/hr-fixtures';

let db: Database;
const PROJECT = 'proj_hr_live';
const OTHER_PROJECT = 'proj_hr_other';
const DELETED_PROJECT = 'proj_hr_deleted';

beforeAll(async () => {
  db = await hrDb();
  const now = new Date('2026-03-01T08:00:00.000Z');
  await db.insert(schema.projects).values([
    { id: PROJECT, name: 'Portal', createdAt: now, updatedAt: now },
    { id: OTHER_PROJECT, name: 'Website', createdAt: now, updatedAt: now },
    { id: DELETED_PROJECT, name: 'Gone', createdAt: now, updatedAt: now, deletedAt: now },
  ]);
}, 60_000);

beforeEach(async () => {
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_anna', { name: 'Anna Self', email: 'anna@example.com', memberType: 'EMPLOYEE' });
  await seedEmployee(db, { id: 'hremp_ann', userId: 'user_anna', email: 'anna@example.com', firstName: 'Ann' });
});

const admin = () => hrCaller(db);

async function seedDeclaration(id: string, fields: Partial<typeof schema.hrDeclarations.$inferInsert> = {}) {
  await db.insert(schema.hrDeclarations).values({
    id,
    employeeId: 'hremp_ann',
    expenseDate: '2026-03-10',
    category: 'travel',
    description: `Expense ${id}`,
    amount: '10.00',
    status: 'pending',
    submittedBy: HR_ADMIN,
    createdAt: new Date('2026-03-11T08:00:00.000Z'),
    updatedAt: new Date('2026-03-11T08:00:00.000Z'),
    ...fields,
  });
}

async function projectOf(id: string) {
  const [row] = await db.select().from(schema.hrDeclarations).where(eq(schema.hrDeclarations.id, id));
  return row?.projectId;
}

const claim = (extra: Record<string, unknown> = {}) => ({
  employeeId: 'hremp_ann',
  expenseDate: daysFromToday(-2),
  category: 'equipment',
  description: 'Load-test licence',
  amount: 280,
  ...extra,
});

describe('POST /declarations with a project', () => {
  it('files the declaration against the project and returns the tag', async () => {
    const res = await admin().send('POST', '/declarations', claim({ projectId: PROJECT }));
    expect(res.status).toBe(201);
    const body = await data<{ id: string; projectId: string | null }>(res);
    expect(body.projectId).toBe(PROJECT);
    expect(await projectOf(body.id)).toBe(PROJECT);
  });

  it('leaves the tag off by default or with null', async () => {
    const plain = await data<{ id: string; projectId: string | null }>(await admin().send('POST', '/declarations', claim()));
    expect(plain.projectId).toBeNull();
    const nulled = await data<{ projectId: string | null }>(await admin().send('POST', '/declarations', claim({ projectId: null })));
    expect(nulled.projectId).toBeNull();
  });

  it('refuses a project that does not exist or is deleted', async () => {
    const unknown = await admin().send('POST', '/declarations', claim({ projectId: 'proj_nope' }));
    expect(unknown.status).toBe(400);
    expect(await errorOf(unknown)).toMatchObject({ code: 'BAD_REQUEST', message: 'Project proj_nope does not exist' });

    const deleted = await admin().send('POST', '/declarations', claim({ projectId: DELETED_PROJECT }));
    expect(deleted.status).toBe(400);
    expect((await errorOf(deleted)).message).toBe(`Project ${DELETED_PROJECT} does not exist`);
  });

  it('refuses an empty or too long project id', async () => {
    const empty = await admin().send('POST', '/declarations', claim({ projectId: '' }));
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('Project id is required');
    const long = await admin().send('POST', '/declarations', claim({ projectId: 'p'.repeat(256) }));
    expect(long.status).toBe(400);
    expect((await errorOf(long)).message).toBe('Project id can be at most 255 characters');
  });
});

describe('PATCH /declarations/:declarationId with a project', () => {
  beforeEach(async () => {
    await seedDeclaration('hrdcl_t1');
    await seedDeclaration('hrdcl_t2', { status: 'approved', projectId: PROJECT });
    await seedDeclaration('hrdcl_t3', { status: 'paid' });
    await seedDeclaration('hrdcl_t4', { status: 'rejected' });
  });

  it('sets, changes and clears the tag of a pending declaration', async () => {
    const set = await admin().send('PATCH', '/declarations/hrdcl_t1', { projectId: PROJECT });
    expect(set.status).toBe(200);
    expect((await data<{ projectId: string }>(set)).projectId).toBe(PROJECT);

    const changed = await admin().send('PATCH', '/declarations/hrdcl_t1', { projectId: OTHER_PROJECT, description: 'Renamed' });
    expect(await data(changed)).toMatchObject({ projectId: OTHER_PROJECT, description: 'Renamed' });

    const cleared = await admin().send('PATCH', '/declarations/hrdcl_t1', { projectId: null });
    expect(await data(cleared)).toMatchObject({ projectId: null, description: 'Renamed' });
    expect(await projectOf('hrdcl_t1')).toBeNull();
  });

  it('keeps the tag when the patch leaves it out', async () => {
    await admin().send('PATCH', '/declarations/hrdcl_t2', { projectId: OTHER_PROJECT });
    await seedDeclaration('hrdcl_t5', { projectId: PROJECT });
    const res = await admin().send('PATCH', '/declarations/hrdcl_t5', { description: 'Edited' });
    expect(await data(res)).toMatchObject({ projectId: PROJECT, description: 'Edited' });
  });

  it('lets HR tag an approved or paid declaration, but only the tag', async () => {
    const approved = await admin().send('PATCH', '/declarations/hrdcl_t2', { projectId: OTHER_PROJECT });
    expect(approved.status).toBe(200);
    expect(await projectOf('hrdcl_t2')).toBe(OTHER_PROJECT);

    const paid = await admin().send('PATCH', '/declarations/hrdcl_t3', { projectId: PROJECT });
    expect(paid.status).toBe(200);
    expect(await projectOf('hrdcl_t3')).toBe(PROJECT);

    const withAmount = await admin().send('PATCH', '/declarations/hrdcl_t2', { projectId: PROJECT, amount: 99 });
    expect(withAmount.status).toBe(409);
    expect(await errorOf(withAmount)).toMatchObject({
      code: 'CONFLICT',
      message: 'This declaration is already approved and can no longer be changed',
    });
    expect(await projectOf('hrdcl_t2')).toBe(OTHER_PROJECT);
  });

  it('refuses to tag a rejected declaration', async () => {
    const res = await admin().send('PATCH', '/declarations/hrdcl_t4', { projectId: PROJECT });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('This declaration is already rejected and can no longer be changed');
  });

  it('refuses a project that does not exist or is deleted', async () => {
    const unknown = await admin().send('PATCH', '/declarations/hrdcl_t1', { projectId: 'proj_nope' });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).message).toBe('Project proj_nope does not exist');
    const deleted = await admin().send('PATCH', '/declarations/hrdcl_t1', { projectId: DELETED_PROJECT });
    expect(deleted.status).toBe(400);
    expect(await projectOf('hrdcl_t1')).toBeNull();
  });
});

describe('the tag in lists and My HR', () => {
  it('is on the declarations the list returns', async () => {
    await seedDeclaration('hrdcl_l1', { projectId: PROJECT });
    await seedDeclaration('hrdcl_l2', { expenseDate: '2026-03-09' });
    const rows = await data<Array<{ id: string; projectId: string | null }>>(await admin().get('/declarations'));
    expect(rows.map((r) => [r.id, r.projectId])).toEqual([
      ['hrdcl_l1', PROJECT],
      ['hrdcl_l2', null],
    ]);
  });

  it('is not accepted from a claim filed in My HR', async () => {
    const res = await hrCaller(db, { userId: 'user_anna', grants: ['employees:self'] }).send('POST', '/me/declarations', {
      expenseDate: daysFromToday(-1),
      category: 'travel',
      description: 'Train',
      amount: 12,
      projectId: PROJECT,
    });
    expect(res.status).toBe(201);
    const body = await data<{ id: string; projectId: string | null }>(res);
    expect(body.projectId).toBeNull();
    expect(await projectOf(body.id)).toBeNull();
  });
});
