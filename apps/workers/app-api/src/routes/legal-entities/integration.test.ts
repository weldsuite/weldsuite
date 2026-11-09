/**
 * /api/legal-entities against a real tenant schema (pglite): per-entity
 * access (restricted entities, member roles, my-access), the default entity
 * rules and the registration / bank account sub-resources.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { legalEntitiesRoutes } from './index';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

const READ = 'legal_entities:read';
const INVOICES_READ = 'weldbooks:invoices:read';
const INVOICES_CREATE = 'weldbooks:invoices:create';
// Also holds what CUSTOM_ROLE carries, so it may give that role (the grant ceiling).
const ADMIN_KEYS = [
  READ,
  'legal_entities:create',
  'legal_entities:update',
  'legal_entities:delete',
  'legal_entities:reveal',
  'legal_entities:manage',
  INVOICES_READ,
];

const CUSTOM_ROLE = 'role_le_books';
const CREATOR_ROLE = 'role_le_creator';
const ADMIN_ROLE = 'role_le_admin';
const OWNER_ROLE = 'role_le_owner';

async function seed(): Promise<void> {
  await db.delete(schema.legalEntityMembers);
  await db.delete(schema.legalEntityRegistrations);
  await db.delete(schema.bankAccounts);
  await db.delete(schema.legalEntities);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.roles);
  const now = new Date();
  await db.insert(schema.roles).values([
    { id: CUSTOM_ROLE, name: 'Books reader', isSystem: false, permissions: [READ, INVOICES_READ], apps: [] },
    { id: CREATOR_ROLE, name: 'Books clerk', isSystem: false, permissions: [READ, INVOICES_READ, INVOICES_CREATE], apps: [] },
    // A system role row resolves to the catalog's permissions, not the stored ones.
    { id: ADMIN_ROLE, name: 'Admin', isSystem: true, permissions: [], apps: [] },
    { id: OWNER_ROLE, name: 'Owner', isSystem: true, permissions: ['*'], apps: [] },
  ] as (typeof schema.roles.$inferInsert)[]);
  const member = (userId: string, role: string, memberType?: string) => ({
    id: `wm_${userId}`,
    userId,
    email: `${userId}@example.com`,
    name: userId,
    role,
    status: 'ACTIVE',
    ...(memberType && { memberType }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workspaceMembers).values([
    member('user_owner', 'OWNER'),
    member('user_admin', 'ADMIN'),
    member('user_member', 'MEMBER'),
    member('user_member2', 'MEMBER'),
    member('user_employee', 'MEMBER', 'EMPLOYEE'),
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}

beforeEach(seed);

function app(userId: string, keys: string[]) {
  return createTestApp('/api/legal-entities', legalEntitiesRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
    env: { DATABASE_ENCRYPTION_KEY: '07'.repeat(32) },
  });
}

const asAdmin = () => app('user_admin', ADMIN_KEYS);
const asMember = (userId = 'user_member') => app(userId, [READ]);

function send(t: ReturnType<typeof app>, path: string, method: string, body?: unknown) {
  return t.request(`/api/legal-entities${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Entity {
  id: string;
  name: string;
  isDefault: boolean;
  accessRestricted: boolean;
  myAccess?: { source: string; roleId: string | null };
}

async function createEntity(name: string, country = 'NL'): Promise<Entity> {
  const res = await send(asAdmin(), '', 'POST', { name, jurisdictionCode: country, baseCurrency: 'EUR' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Entity }).data;
}

async function listAs(t: ReturnType<typeof app>): Promise<Entity[]> {
  const res = await t.request('/api/legal-entities');
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Entity[] }).data;
}

describe('per-entity access', () => {
  it('hides a restricted entity from a member without a row, and shows it to admins and members with a row', async () => {
    const open = await createEntity('Acme Holding BV');
    const secret = await createEntity('Acme Secret BV');

    expect((await listAs(asMember())).map((e) => e.id).sort()).toEqual([open.id, secret.id].sort());

    const restrict = await send(asAdmin(), `/${secret.id}/access`, 'PATCH', { restricted: true });
    expect(restrict.status).toBe(200);
    expect(((await restrict.json()) as { data: { restricted: boolean } }).data.restricted).toBe(true);

    // A member without a row: gone from the list, 404 on every route for it.
    expect((await listAs(asMember())).map((e) => e.id)).toEqual([open.id]);
    expect((await asMember().request(`/api/legal-entities/${secret.id}`)).status).toBe(404);
    expect((await asMember().request(`/api/legal-entities/${secret.id}/registrations`)).status).toBe(404);
    expect((await asMember().request(`/api/legal-entities/${secret.id}/my-access`)).status).toBe(404);

    // An admin holding legal_entities:manage sees both.
    expect((await listAs(asAdmin())).map((e) => e.id).sort()).toEqual([open.id, secret.id].sort());
    expect((await asAdmin().request(`/api/legal-entities/${secret.id}`)).status).toBe(200);

    // A member with a row sees it, and the list says why.
    const grant = await send(asAdmin(), `/${secret.id}/access/members/user_member2`, 'PUT', { roleId: null });
    expect(grant.status).toBe(201);
    const accessList = await asAdmin().request(`/api/legal-entities/${secret.id}/access`);
    expect(accessList.status).toBe(200);
    const listed = ((await accessList.json()) as { data: { restricted: boolean; members: { userId: string }[] } }).data;
    expect(listed.restricted).toBe(true);
    expect(listed.members.map((m) => m.userId)).toEqual(['user_member2']);
    const withRow = await listAs(asMember('user_member2'));
    expect(withRow.map((e) => e.id).sort()).toEqual([open.id, secret.id].sort());
    expect(withRow.find((e) => e.id === secret.id)?.myAccess?.source).toBe('member');
    expect((await asMember('user_member2').request(`/api/legal-entities/${secret.id}`)).status).toBe(200);
    // The first member still does not.
    expect((await asMember().request(`/api/legal-entities/${secret.id}`)).status).toBe(404);

    // Removing the row hides it again; the default endpoint never leaks a hidden entity.
    expect((await send(asAdmin(), `/${secret.id}/access/members/user_member2`, 'DELETE')).status).toBe(204);
    expect((await asMember('user_member2').request(`/api/legal-entities/${secret.id}`)).status).toBe(404);
  });

  it('refuses the Owner role, an EMPLOYEE member and an unknown role', async () => {
    const entity = await createEntity('Acme BV');
    const put = (userId: string, roleId: string | null) =>
      send(asAdmin(), `/${entity.id}/access/members/${userId}`, 'PUT', { roleId });

    expect((await put('user_member', OWNER_ROLE)).status).toBe(400);
    expect((await put('user_employee', null)).status).toBe(400);
    expect((await put('user_member', 'role_does_not_exist')).status).toBe(400);
    expect((await put('user_nobody', null)).status).toBe(400);

    const ok = await put('user_member', CUSTOM_ROLE);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      userId: 'user_member',
      roleId: CUSTOM_ROLE,
      roleName: 'Books reader',
      workspaceRole: 'MEMBER',
    });
    // Changing the role is an update (200).
    expect((await put('user_member', null)).status).toBe(200);
  });

  it('only lets the caller give an entity role whose permissions they hold themselves', async () => {
    const entity = await createEntity('Acme BV');
    const put = (t: ReturnType<typeof app>, roleId: string | null) =>
      send(t, `/${entity.id}/access/members/user_member`, 'PUT', { roleId });
    const members = async () => {
      const res = await asAdmin().request(`/api/legal-entities/${entity.id}/access`);
      return ((await res.json()) as { data: { members: { userId: string; roleId: string | null }[] } }).data.members;
    };

    // A manager without invoices:create cannot give a role that has it, nor the Admin role.
    const refused = await put(asAdmin(), CREATOR_ROLE);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'You cannot grant permissions you do not hold yourself' },
    });
    expect((await put(asAdmin(), ADMIN_ROLE)).status).toBe(403);
    expect(await members()).toEqual([]);

    // A manager who holds every key of the role can give it.
    const holder = app('user_admin', [...ADMIN_KEYS, INVOICES_CREATE]);
    expect((await put(holder, CREATOR_ROLE)).status).toBe(201);
    expect((await members()).map((m) => [m.userId, m.roleId])).toEqual([['user_member', CREATOR_ROLE]]);
    // The owner holds them all, the Admin role's included.
    expect((await put(app('user_owner', ['*']), ADMIN_ROLE)).status).toBe(200);
    // Acting with their workspace role takes no check.
    expect((await put(asAdmin(), null)).status).toBe(200);
  });

  it('needs legal_entities:manage to manage access', async () => {
    const entity = await createEntity('Acme BV');
    const asEditor = app('user_member', [READ, 'legal_entities:update']);
    expect((await send(asEditor, `/${entity.id}/access`, 'PATCH', { restricted: true })).status).toBe(403);
    expect((await asEditor.request(`/api/legal-entities/${entity.id}/access`)).status).toBe(403);
    expect((await send(asEditor, `/${entity.id}/access/members/user_member2`, 'PUT', { roleId: null })).status).toBe(403);
  });

  it('my-access returns the permissions of the role the member acts with in the entity', async () => {
    const entity = await createEntity('Acme BV');
    await send(asAdmin(), `/${entity.id}/access/members/user_member`, 'PUT', { roleId: CUSTOM_ROLE });

    const res = await asMember().request(`/api/legal-entities/${entity.id}/my-access`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { source: string; roleId: string; roleName: string; permissions: string[]; isOwner: boolean };
    };
    expect(data).toMatchObject({ source: 'member', roleId: CUSTOM_ROLE, roleName: 'Books reader', isOwner: false });
    expect(data.permissions).toContain('weldbooks:invoices:read');

    // A member with no row acts with the workspace role.
    const open = await asMember('user_member2').request(`/api/legal-entities/${entity.id}/my-access`);
    const openBody = (await open.json()) as { data: { source: string; roleId: string | null } };
    expect(openBody.data).toMatchObject({ source: 'open', roleId: null });
  });
});

describe('default entity', () => {
  it('makes the first entity the default and refuses to delete the default', async () => {
    const first = await createEntity('Acme BV');
    const second = await createEntity('Acme Two BV');
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const def = await asMember().request('/api/legal-entities/default');
    expect(((await def.json()) as { data: Entity }).data.id).toBe(first.id);

    expect((await send(asAdmin(), `/${first.id}`, 'DELETE')).status).toBe(409);
    expect((await send(asAdmin(), `/${first.id}/archive`, 'POST')).status).toBe(409);

    const made = await send(asAdmin(), `/${second.id}/make-default`, 'POST');
    expect(made.status).toBe(200);
    expect(((await made.json()) as { data: Entity }).data.isDefault).toBe(true);
    expect((await send(asAdmin(), `/${first.id}`, 'DELETE')).status).toBe(204);
    expect((await asAdmin().request(`/api/legal-entities/${first.id}`)).status).toBe(404);
  });

  it('archives and unarchives an entity that is not the default', async () => {
    await createEntity('Acme BV');
    const second = await createEntity('Acme Two BV');

    const archived = await send(asAdmin(), `/${second.id}/archive`, 'POST');
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as { data: { isActive: boolean } }).data.isActive).toBe(false);
    // Archived entities are left out of the list unless asked for.
    expect((await listAs(asAdmin())).map((e) => e.id)).not.toContain(second.id);
    const withArchived = await asAdmin().request('/api/legal-entities?includeArchived=true');
    expect(((await withArchived.json()) as { data: Entity[] }).data.map((e) => e.id)).toContain(second.id);
    // An archived entity cannot become the default.
    expect((await send(asAdmin(), `/${second.id}/make-default`, 'POST')).status).toBe(409);

    const restored = await send(asAdmin(), `/${second.id}/unarchive`, 'POST');
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { data: { isActive: boolean } }).data.isActive).toBe(true);
    expect((await listAs(asAdmin())).map((e) => e.id)).toContain(second.id);
  });

  it('answers data: null when there is no default entity', async () => {
    const res = await asMember().request('/api/legal-entities/default');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });
});

describe('registrations and bank accounts', () => {
  it('creates a registration, validates its format, and never returns the account number', async () => {
    const entity = await createEntity('Acme BV');

    const bad = await send(asAdmin(), `/${entity.id}/registrations`, 'POST', { type: 'vat', number: 'NL1' });
    expect(bad.status).toBe(400);
    const reg = await send(asAdmin(), `/${entity.id}/registrations`, 'POST', { type: 'vat', number: 'nl 123456789 b01' });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as { data: { number: string; isPrimary: boolean } }).data).toMatchObject({
      number: 'NL123456789B01',
      isPrimary: true,
    });

    const account = await send(asAdmin(), `/${entity.id}/bank-accounts`, 'POST', {
      name: 'Main',
      iban: 'NL91ABNA0417164300',
      accountNumber: '9988774300',
    });
    expect(account.status).toBe(201);
    const created = ((await account.json()) as { data: Record<string, unknown> }).data;
    expect(created).toMatchObject({ accountNumberLast4: '4300', hasAccountNumber: true });
    expect(JSON.stringify(created)).not.toContain('9988774300');
    expect(created).not.toHaveProperty('accountNumberEncrypted');

    // A reveal needs legal_entities:reveal and returns the number.
    const refused = await send(app('user_member', [READ, 'legal_entities:update']), `/${entity.id}/bank-accounts/${created.id}/reveal`, 'POST', {});
    expect(refused.status).toBe(403);
    const reveal = await send(asAdmin(), `/${entity.id}/bank-accounts/${created.id}/reveal`, 'POST', { reason: 'audit' });
    expect(reveal.status).toBe(200);
    expect(((await reveal.json()) as { data: { accountNumber: string } }).data.accountNumber).toBe('9988774300');
    const logged = await db.select().from(schema.taxIdReveals);
    expect(logged).toHaveLength(1);
  });

  it('changes and removes a registration and a bank account, and reports usage', async () => {
    const entity = await createEntity('Acme BV');

    const reg = await send(asAdmin(), `/${entity.id}/registrations`, 'POST', { type: 'company_registration', number: '12345678' });
    expect(reg.status).toBe(201);
    const registration = ((await reg.json()) as { data: { id: string } }).data;
    const patched = await send(asAdmin(), `/${entity.id}/registrations/${registration.id}`, 'PATCH', {
      number: '87654321',
      label: 'KvK',
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: Record<string, unknown> }).data).toMatchObject({ number: '87654321', label: 'KvK' });
    const regs = await asMember().request(`/api/legal-entities/${entity.id}/registrations`);
    expect(regs.status).toBe(200);
    expect(((await regs.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([registration.id]);
    expect((await send(asAdmin(), `/${entity.id}/registrations/${registration.id}`, 'DELETE')).status).toBe(204);
    expect((await send(asAdmin(), `/${entity.id}/registrations/${registration.id}`, 'DELETE')).status).toBe(404);

    const created = await send(asAdmin(), `/${entity.id}/bank-accounts`, 'POST', { name: 'Main', iban: 'NL91ABNA0417164300' });
    expect(created.status).toBe(201);
    const account = ((await created.json()) as { data: { id: string } }).data;
    const banks = await asMember().request(`/api/legal-entities/${entity.id}/bank-accounts`);
    expect(banks.status).toBe(200);
    expect(((await banks.json()) as { data: { id: string }[] }).data.map((a) => a.id)).toEqual([account.id]);
    expect((await send(asAdmin(), `/${entity.id}/bank-accounts/${account.id}`, 'DELETE')).status).toBe(204);
    const after = await asMember().request(`/api/legal-entities/${entity.id}/bank-accounts`);
    expect(((await after.json()) as { data: unknown[] }).data).toEqual([]);

    // WeldHR works with any entity; WeldBooks needs its extension row. Neither holds data yet.
    const usage = await asMember().request(`/api/legal-entities/${entity.id}/usage`);
    expect(usage.status).toBe(200);
    expect(((await usage.json()) as { data: unknown }).data).toEqual([
      { app: 'weldbooks', enabled: false, hasData: false },
      { app: 'weldhr', enabled: true, hasData: false },
    ]);
  });

  it('answers 404 for a bank account of another entity', async () => {
    const a = await createEntity('Acme BV');
    const b = await createEntity('Other BV');
    const account = await send(asAdmin(), `/${a.id}/bank-accounts`, 'POST', { name: 'Main' });
    const { data } = (await account.json()) as { data: { id: string } };
    expect((await send(asAdmin(), `/${b.id}/bank-accounts/${data.id}`, 'PATCH', { name: 'x' })).status).toBe(404);
  });
});

describe('PATCH replaces address, contact and branding as whole objects', () => {
  it('replaces them, and null clears them', async () => {
    const entity = await createEntity('Acme BV');
    const first = await send(asAdmin(), `/${entity.id}`, 'PATCH', {
      address: { line1: 'A 1', city: 'Amsterdam' },
      contact: { email: 'a@example.com', phone: '1' },
      branding: { logoUrl: 'https://cdn/x.png', primaryColor: '#fff' },
    });
    expect(first.status).toBe(200);
    const second = await send(asAdmin(), `/${entity.id}`, 'PATCH', {
      address: { city: 'Utrecht' },
      contact: { email: 'b@example.com' },
      branding: { primaryColor: '#000' },
    });
    const { data } = (await second.json()) as { data: Record<string, Record<string, unknown>> };
    expect(data.address).toEqual({ city: 'Utrecht' });
    expect(data.contact).toEqual({ email: 'b@example.com' });
    expect(data.branding).toEqual({ primaryColor: '#000' });
    const cleared = await send(asAdmin(), `/${entity.id}`, 'PATCH', { address: null, contact: null });
    const body = (await cleared.json()) as { data: { address: unknown; contact: unknown } };
    expect(body.data.address).toBeNull();
    expect(body.data.contact).toBeNull();
  });
});
