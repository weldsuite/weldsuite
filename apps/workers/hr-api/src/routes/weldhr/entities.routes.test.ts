/**
 * Legal entities in WeldHR (docs/plans/legal-entities.md): the request's
 * entity scopes lists, an entity role limits what a member may do there, a
 * record of an entity the member acts in differently is a 404, and a payroll
 * employer is a registration of a legal entity.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ALL_HR_GRANTS, HR, HR_ADMIN, data, errorOf, hrCaller, hrDb, resetHr, seedEmployee, seedMember } from '../../test/hr-fixtures';

let db: Database;

beforeAll(async () => {
  db = await hrDb();
}, 60_000);

const VIEWER = 'user_entity_viewer';

beforeEach(async () => {
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, VIEWER, { name: 'Vera Viewer', email: 'vera@example.com' });
  await db.insert(schema.roles).values({ id: 'role_hr_viewer', name: 'HR viewer', isSystem: false, permissions: ['employees:read'] });
  await db.insert(schema.legalEntities).values([
    { id: 'ent_a', name: 'Alpha BV', legalName: 'Alpha B.V.', jurisdictionCode: 'NL', baseCurrency: 'EUR', isDefault: true },
    { id: 'ent_b', name: 'Beta BV', legalName: 'Beta B.V.', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
  ]);
  // The member acts with the Viewer role in Beta, and with their workspace role in Alpha.
  await db.insert(schema.legalEntityMembers).values({ id: 'lem_viewer_b', entityId: 'ent_b', userId: VIEWER, roleId: 'role_hr_viewer' });
  await seedEmployee(db, { id: 'hremp_ann', firstName: 'Ann', legalEntityId: 'ent_a' });
  await seedEmployee(db, { id: 'hremp_ben', firstName: 'Ben', legalEntityId: 'ent_b' });
});

afterEach(async () => {
  for (const table of ['hr_payroll_employers', 'legal_entity_members', 'legal_entity_registrations', 'bank_accounts', 'entities', 'roles']) {
    await db.execute(sql.raw(`delete from ${table}`));
  }
});

const as = (userId: string, extra: { flags?: string[]; grants?: string[] } = {}) =>
  hrCaller(db, { userId, grants: extra.grants, flags: extra.flags });
const inEntity = (entityId: string) => ({ headers: { 'X-Legal-Entity-Id': entityId } });
const ids = async (res: Response) => (await data<Array<{ id: string }>>(res)).map((e) => e.id).sort();

describe('employee lists', () => {
  it('filter by X-Legal-Entity-Id, and span every entity without it', async () => {
    const admin = as(HR_ADMIN);
    expect(await ids(await admin.request(`${HR}/employees`, inEntity('ent_a')))).toEqual(['hremp_ann']);
    expect(await ids(await admin.request(`${HR}/employees`, inEntity('ent_b')))).toEqual(['hremp_ben']);
    expect(await ids(await admin.get('/employees'))).toEqual(['hremp_ann', 'hremp_ben']);
  });

  it('only list the entities where the member acts with their workspace role when no entity is named', async () => {
    const viewer = as(VIEWER);
    expect(await ids(await viewer.get('/employees'))).toEqual(['hremp_ann']);
    // Naming the entity with the role works, with that role.
    expect(await ids(await viewer.request(`${HR}/employees`, inEntity('ent_b')))).toEqual(['hremp_ben']);
  });

  it('scope what hangs off an employee, not just the directory', async () => {
    await db.insert(schema.hrAbsences).values([
      { id: 'hrabs_a', employeeId: 'hremp_ann', startDate: '2026-01-05' },
      { id: 'hrabs_b', employeeId: 'hremp_ben', startDate: '2026-01-05' },
    ]);
    const admin = as(HR_ADMIN);
    const absences = await admin.request(`${HR}/absences`, inEntity('ent_b'));
    expect(((await absences.json()) as { data: Array<{ id: string }> }).data.map((a) => a.id)).toEqual(['hrabs_b']);
    const dashboard = await data<{ headcount: { total: number } }>(await admin.request(`${HR}/dashboard`, inEntity('ent_a')));
    expect(dashboard.headcount.total).toBe(1);
  });
});

describe('an entity role', () => {
  it('stops a Viewer creating an employee in that entity', async () => {
    const res = await as(VIEWER).request(`${HR}/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Legal-Entity-Id': 'ent_b' },
      body: JSON.stringify({ firstName: 'New', lastName: 'Hire', email: 'new@example.com' }),
    });
    expect(res.status).toBe(403);
  });

  it('keeps another entity\'s employee a 404 by id', async () => {
    const viewer = as(VIEWER);
    // Beta's employee while checked with the workspace role (no entity, or Alpha): not theirs to see.
    expect((await viewer.get('/employees/hremp_ben')).status).toBe(404);
    expect((await viewer.request(`${HR}/employees/hremp_ben`, inEntity('ent_a'))).status).toBe(404);
    expect((await errorOf(await viewer.get('/employees/hremp_ben'))).code).toBe('NOT_FOUND');
    // Alpha's employee is fine with the workspace role, and Beta's with the role named for it.
    expect((await viewer.get('/employees/hremp_ann')).status).toBe(200);
    expect((await viewer.request(`${HR}/employees/hremp_ben`, inEntity('ent_b'))).status).toBe(200);
    // An admin sees both.
    expect((await as(HR_ADMIN).get('/employees/hremp_ben')).status).toBe(200);
  });
});

describe('employee entity', () => {
  it('goes to the request\'s entity, else the named one, else the default', async () => {
    await seedMember(db, 'user_x1', { email: 'x1@example.com' });
    await seedMember(db, 'user_x2', { email: 'x2@example.com' });
    await seedMember(db, 'user_x3', { email: 'x3@example.com' });
    const admin = as(HR_ADMIN);
    const create = (email: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
      admin.request(`${HR}/employees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ firstName: 'N', lastName: 'Ew', email, ...extra }),
      });
    expect((await data<{ legalEntityId: string }>(await create('x1@example.com', { 'X-Legal-Entity-Id': 'ent_b' }))).legalEntityId).toBe('ent_b');
    expect((await data<{ legalEntityId: string }>(await create('x2@example.com', {}, { legalEntityId: 'ent_b' }))).legalEntityId).toBe('ent_b');
    expect((await data<{ legalEntityId: string }>(await create('x3@example.com', {}))).legalEntityId).toBe('ent_a');
  });

  const newHire = (caller: ReturnType<typeof as>, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    caller.request(`${HR}/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ firstName: 'N', lastName: 'Ew', email: 'new@example.com', ...extra }),
    });

  it('refuses an entity the request names but may not use, instead of the named or default one', async () => {
    const admin = as(HR_ADMIN);
    const unknown = await newHire(admin, { 'X-Legal-Entity-Id': 'ent_nope' }, { legalEntityId: 'ent_a' });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual({ code: 'NOT_FOUND', message: "Legal entity with ID 'ent_nope' not found" });

    // Beta restricted, and the admin (no legal_entities:manage) has no row there.
    await db.update(schema.legalEntities).set({ accessRestricted: true }).where(eq(schema.legalEntities.id, 'ent_b'));
    const hidden = await newHire(admin, { 'X-Legal-Entity-Id': 'ent_b' });
    expect(hidden.status).toBe(404);
    expect(await errorOf(hidden)).toEqual({ code: 'NOT_FOUND', message: "Legal entity with ID 'ent_b' not found" });
    expect(await db.select({ id: schema.hrEmployees.id }).from(schema.hrEmployees)).toHaveLength(2);
  });

  it('refuses the default entity when the member may not add employees there, without naming it', async () => {
    // Alpha, the default, restricted: the member has no row there, so does not see it.
    await db.update(schema.legalEntities).set({ accessRestricted: true }).where(eq(schema.legalEntities.id, 'ent_a'));
    const hidden = await newHire(as(VIEWER));
    expect(hidden.status).toBe(404);
    expect(await errorOf(hidden)).toEqual({ code: 'NOT_FOUND', message: 'Legal entity not found' });

    // Beta the default: the member acts there as an HR viewer, so the workspace role
    // the request was checked with does not reach it.
    await db.update(schema.legalEntities).set({ accessRestricted: false, isDefault: false }).where(eq(schema.legalEntities.id, 'ent_a'));
    await db.update(schema.legalEntities).set({ isDefault: true }).where(eq(schema.legalEntities.id, 'ent_b'));
    const withRole = await newHire(as(VIEWER));
    expect(withRole.status).toBe(404);
    expect(await errorOf(withRole)).toEqual({ code: 'NOT_FOUND', message: 'Legal entity not found' });
    expect(await db.select({ id: schema.hrEmployees.id }).from(schema.hrEmployees)).toHaveLength(2);

    // Someone who acts there with their workspace role still lands in it.
    await seedMember(db, 'user_new_hire', { email: 'new@example.com' });
    const placed = await newHire(as(HR_ADMIN));
    expect(placed.status).toBe(201);
    expect((await data<{ legalEntityId: string }>(placed)).legalEntityId).toBe('ent_b');
  });
});

describe('payroll employers', () => {
  const grants = [...ALL_HR_GRANTS, 'payroll:read', 'payroll:prepare', 'payroll:manage'];

  it('are payroll registrations of a legal entity, with the entity\'s facts mirrored', async () => {
    const admin = as(HR_ADMIN, { flags: ['weldhr-payroll'], grants });
    const res = await admin.send('POST', '/payroll/employers', {
      legalEntityId: 'ent_a',
      registrationNumber: '123456789L01',
      label: 'L01 DGA',
    });
    expect(res.status).toBe(201);
    const employer = await data<{
      id: string;
      legalEntityId: string;
      legalEntityName: string;
      registrationId: string;
      registrationNumber: string;
      label: string;
      name: string;
      legalName: string;
      country: string;
      nlSettings: { loonheffingennummer?: string };
    }>(res);
    expect(employer).toMatchObject({
      legalEntityId: 'ent_a',
      legalEntityName: 'Alpha BV',
      registrationNumber: '123456789L01',
      label: 'L01 DGA',
      name: 'L01 DGA',
      legalName: 'Alpha B.V.',
      country: 'NL',
    });
    expect(employer.nlSettings.loonheffingennummer).toBe('123456789L01');
    const [registration] = await db.select().from(schema.legalEntityRegistrations);
    expect(registration).toMatchObject({ id: employer.registrationId, entityId: 'ent_a', type: 'nl_payroll_tax', number: '123456789L01' });
    // The deprecated copy is written too.
    const [row] = await db.select().from(schema.hrPayrollEmployers);
    expect(row).toMatchObject({ legalEntityId: 'ent_a', name: 'Alpha BV', accountingEntityId: null });
    expect(row!.nlSettings.loonheffingennummer).toBe('123456789L01');
  });

  it('are listed per entity, and an employer of another entity is a 404 for a member who acts there with a role', async () => {
    const admin = as(HR_ADMIN, { flags: ['weldhr-payroll'], grants });
    await admin.send('POST', '/payroll/employers', { legalEntityId: 'ent_a' });
    const b = await data<{ id: string }>(await admin.send('POST', '/payroll/employers', { legalEntityId: 'ent_b' }));
    const list = async (entity: string) =>
      (await data<Array<{ legalEntityId: string }>>(await admin.request(`${HR}/payroll/employers`, inEntity(entity)))).map((e) => e.legalEntityId);
    expect(await list('ent_a')).toEqual(['ent_a']);
    expect(await list('ent_b')).toEqual(['ent_b']);

    const viewer = as(VIEWER, { flags: ['weldhr-payroll'], grants });
    expect((await viewer.get(`/payroll/employers/${b.id}`)).status).toBe(404);
  });

  it('need a legal entity when the request names neither it nor the pre-entity facts', async () => {
    const admin = as(HR_ADMIN, { flags: ['weldhr-payroll'], grants });
    expect((await admin.send('POST', '/payroll/employers', {})).status).toBe(400);
  });

  it('must belong to the legal entity of the employee they pay', async () => {
    const admin = as(HR_ADMIN, { flags: ['weldhr-payroll'], grants });
    const b = await data<{ id: string }>(await admin.send('POST', '/payroll/employers', { legalEntityId: 'ent_b' }));
    const res = await admin.send('PUT', '/payroll/employees/hremp_ann/profile', { employerId: b.id });
    expect(res.status).toBe(400);
    expect((await admin.send('PUT', '/payroll/employees/hremp_ben/profile', { employerId: b.id })).status).toBe(200);
  });
});
