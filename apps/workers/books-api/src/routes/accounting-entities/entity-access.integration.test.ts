/**
 * Per-entity access in WeldBooks (pglite, the real `legalEntityContext()` with
 * real permission resolution, mounted the way index.ts mounts it):
 *
 *  (a) a restricted entity is missing from GET /accounting-entities for a
 *      member without access, and its invoice is 404 by id;
 *  (b) a member whose entity role is Viewer gets 403 creating an invoice in
 *      that entity, but can create one in an open entity with their workspace role;
 *  (c) a member who is not allowed everywhere gets 404 on a PATCH of entity
 *      B's invoice while sending entity A's header;
 *  (d) POST /accounting-entities with `legalEntityId` enables WeldBooks for an
 *      existing core entity (and DELETE refuses once there are documents, see
 *      delete.integration.test.ts): it takes `entities:create` in the member's
 *      role inside that entity, leaves the company's identity alone, and only
 *      moves the workspace default with `legal_entities:update`.
 *
 * Every request goes through `createTestApp`, one app per member with that
 * member's workspace permissions resolved from the database, so conformance
 * mode runs it on the Rust backend too.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { legalEntityContext } from '@weldsuite/core-domain/legal-entities';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { accountingEntitiesRoutes } from './index';
import { invoicesRoutes } from '../invoices';

const USERS = ['u_admin', 'u_member', 'u_clerk'] as const;
type User = (typeof USERS)[number];

let db: Database;
/** Each member's workspace permissions, resolved from the database once the fixtures are in. */
const memberPermissions = new Map<User, ResolvedPermissions>();
const apps = new Map<User, ReturnType<typeof createTestApp>>();

/** The routes under test as index.ts mounts them: legalEntityContext on /api/*, then the routers. */
function booksRoutes() {
  const books = new Hono<{ Bindings: Env; Variables: Variables }>();
  books.use(
    '/api/*',
    legalEntityContext({
      app: 'weldbooks',
      scoped: true,
      skip: (c) => {
        let path = c.req.path;
        while (path.endsWith('/')) path = path.slice(0, -1);
        return path === '/api/accounting-entities' && (c.req.method === 'GET' || c.req.method === 'POST');
      },
    }),
  );
  books.route('/api/accounting-entities', accountingEntitiesRoutes);
  books.route('/api/invoices', invoicesRoutes);
  return books;
}

/** The member's test app, made on first use (inside a test, where conformance mode records it). */
function appFor(user: User) {
  let app = apps.get(user);
  if (!app) {
    const permissions = memberPermissions.get(user);
    if (!permissions) throw new Error(`no permissions resolved for ${user}`);
    app = createTestApp('/', booksRoutes(), { context: { userId: user, tenantDb: db, permissions } });
    apps.set(user, app);
  }
  return app;
}

async function call(user: User, method: string, path: string, opts: { entity?: string; body?: unknown } = {}) {
  const app = appFor(user);
  const res = await app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.entity ? { 'x-accounting-entity-id': opts.entity } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (text ? JSON.parse(text) : {}) as { data?: any; error?: { message: string } };
  return { status: res.status, ...json };
}

const invoiceBody = {
  contactId: 'pty_access',
  issueDate: '2099-01-01',
  dueDate: '2099-01-31',
  currency: 'EUR',
  items: [{ description: 'Workshop', quantity: '1', unitPrice: '100' }],
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await db.insert(schema.roles).values([
    { id: 'role_viewer', name: 'Books viewer', isSystem: false, permissions: ['invoices:read'] },
    // May enable WeldBooks for a company (entities:create), but not change companies (no legal_entities:*).
    { id: 'role_clerk', name: 'Books clerk', isSystem: false, permissions: ['entities:read', 'entities:create'] },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_admin', userId: 'u_admin', role: 'ADMIN' },
    { id: 'wm_member', userId: 'u_member', role: 'MEMBER', permissions: ['entities:read'] },
    { id: 'wm_clerk', userId: 'u_clerk', role: 'MEMBER', roleId: 'role_clerk' },
  ]);
  await db.insert(schema.legalEntities).values([
    { id: 'ent_open', name: 'Open BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', isDefault: true },
    { id: 'ent_secret', name: 'Secret BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', accessRestricted: true },
    { id: 'ent_role', name: 'Viewer here BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    { id: 'ent_core', name: 'Core only BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    // Core-only companies u_clerk enables WeldBooks for (or may not).
    { id: 'ent_clerk_viewer', name: 'Clerk views BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    {
      id: 'ent_clerk_open',
      name: 'Clerk BV',
      legalName: 'Clerk Holding BV',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      address: { line1: 'Kerkstraat 1', city: 'Amsterdam', postalCode: '1011 AA', country: 'NL' },
      contact: { email: 'info@clerk.example' },
      taxIdentifiers: { vatNumber: 'NL123456789B01' },
      bankDetails: { iban: 'NL91ABNA0417164300' },
      branding: { logoUrl: 'https://example.com/clerk.png', primaryColor: '#123456' },
      fiscalYearStart: 1,
    },
    { id: 'ent_clerk_default', name: 'Clerk default BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    { id: 'ent_admin_default', name: 'Admin default BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
  ]);
  // WeldBooks is enabled for the first three, not for ent_core and the clerk's and admin's companies.
  await db.insert(schema.accountingEntitySettings).values([{ entityId: 'ent_open' }, { entityId: 'ent_secret' }, { entityId: 'ent_role' }]);
  await db.insert(schema.legalEntityMembers).values([
    { id: 'lem_1', entityId: 'ent_role', userId: 'u_member', roleId: 'role_viewer' },
    { id: 'lem_2', entityId: 'ent_clerk_viewer', userId: 'u_clerk', roleId: 'role_viewer' },
  ]);
  await db.insert(schema.parties).values({ id: 'pty_access', displayName: 'Klant BV', role: 'none' });

  // Each member's workspace permissions as the API resolves them (legalEntityContext
  // swaps in the entity role per request).
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  for (const user of USERS) memberPermissions.set(user, await resolveEffectivePermissions(queries, user));
}, 120_000);

describe('a restricted entity', () => {
  let secretInvoice: string;

  it('is missing from the entity list of a member without access, and shown to an admin', async () => {
    const member = await call('u_member', 'GET', '/api/accounting-entities', { entity: 'ent_secret' });
    expect(member.status).toBe(200);
    expect(member.data.map((e: { id: string }) => e.id).sort()).toEqual(['ent_open', 'ent_role']);
    const admin = await call('u_admin', 'GET', '/api/accounting-entities');
    expect(admin.data.map((e: { id: string }) => e.id).sort()).toEqual(['ent_open', 'ent_role', 'ent_secret']);
    expect((await call('u_member', 'GET', '/api/accounting-entities/ent_secret')).status).toBe(404);
  });

  it('keeps its invoice a 404 by id for that member, whichever entity the header names', async () => {
    const created = await call('u_admin', 'POST', '/api/invoices', { entity: 'ent_secret', body: invoiceBody });
    expect(created.status).toBe(201);
    secretInvoice = created.data.id;
    expect((await call('u_admin', 'GET', `/api/invoices/${secretInvoice}`, { entity: 'ent_secret' })).status).toBe(200);
    expect((await call('u_member', 'GET', `/api/invoices/${secretInvoice}`, { entity: 'ent_open' })).status).toBe(404);
    expect((await call('u_member', 'GET', `/api/invoices/${secretInvoice}`, { entity: 'ent_secret' })).status).toBe(404);
  });
});

describe('an entity role', () => {
  it('limits what the member may do in that entity, not in an open one', async () => {
    const refused = await call('u_member', 'POST', '/api/invoices', { entity: 'ent_role', body: invoiceBody });
    expect(refused.status).toBe(403);
    const allowed = await call('u_member', 'POST', '/api/invoices', { entity: 'ent_open', body: invoiceBody });
    expect(allowed.status).toBe(201);
  });
});

describe('a record of another entity', () => {
  it('answers 404 when a member who is not allowed everywhere names a different entity', async () => {
    const created = await call('u_admin', 'POST', '/api/invoices', { entity: 'ent_role', body: invoiceBody });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    // Entity A's header (open, workspace role), entity B's invoice.
    const patched = await call('u_member', 'PATCH', `/api/invoices/${id}`, { entity: 'ent_open', body: { reference: 'sneaky' } });
    expect(patched.status).toBe(404);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1);
    expect(row?.reference).not.toBe('sneaky');
    // An admin's access is the same everywhere, so deep links keep working.
    expect((await call('u_admin', 'PATCH', `/api/invoices/${id}`, { entity: 'ent_open', body: { reference: 'fine' } })).status).toBe(200);
  });
});

describe('POST /api/accounting-entities with legalEntityId', () => {
  it('enables WeldBooks for an existing core entity instead of creating a company', async () => {
    const before = await call('u_admin', 'GET', '/api/accounting-entities');
    expect(before.data.map((e: { id: string }) => e.id)).not.toContain('ent_core');
    const companiesBefore = await db.select({ id: schema.legalEntities.id }).from(schema.legalEntities).where(isNull(schema.legalEntities.deletedAt));

    const res = await call('u_admin', 'POST', '/api/accounting-entities', { body: { legalEntityId: 'ent_core', jurisdictionCode: 'NL' } });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ id: 'ent_core', name: 'Core only BV' });
    expect(res.data.accountsCreated).toBeGreaterThan(0);

    const [ext] = await db.select().from(schema.accountingEntitySettings).where(eq(schema.accountingEntitySettings.entityId, 'ent_core'));
    expect(ext).toBeTruthy();
    const sequences = await db.select().from(schema.entityNumberSequences).where(eq(schema.entityNumberSequences.entityId, 'ent_core'));
    expect(sequences).toHaveLength(4);
    // No second company was made.
    const companies = await db.select({ id: schema.legalEntities.id }).from(schema.legalEntities).where(isNull(schema.legalEntities.deletedAt));
    expect(companies).toHaveLength(companiesBefore.length);

    const after = await call('u_admin', 'GET', '/api/accounting-entities');
    expect(after.data.map((e: { id: string }) => e.id)).toContain('ent_core');
    // Enabling it twice is a conflict.
    expect((await call('u_admin', 'POST', '/api/accounting-entities', { body: { legalEntityId: 'ent_core' } })).status).toBe(409);
  });

  it('refuses to create a new company without legal_entities:create', async () => {
    const res = await call('u_member', 'POST', '/api/accounting-entities', { body: { name: 'New BV', jurisdictionCode: 'NL' } });
    expect(res.status).toBe(403);
  });

  it('answers 403 when the member\'s role inside that entity lacks entities:create', async () => {
    // u_clerk holds entities:create in the workspace, but is a Books viewer in ent_clerk_viewer.
    const res = await call('u_clerk', 'POST', '/api/accounting-entities', { body: { legalEntityId: 'ent_clerk_viewer' } });
    expect(res).toMatchObject({
      status: 403,
      success: false,
      error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
    });
    const ext = await db.select().from(schema.accountingEntitySettings).where(eq(schema.accountingEntitySettings.entityId, 'ent_clerk_viewer'));
    expect(ext).toHaveLength(0);
  });

  it('leaves the company\'s identity alone and only takes what WeldBooks adds', async () => {
    const identity = (row: typeof schema.legalEntities.$inferSelect) => ({
      name: row.name,
      legalName: row.legalName,
      dba: row.dba,
      entityType: row.entityType,
      taxClassification: row.taxClassification,
      jurisdictionCode: row.jurisdictionCode,
      baseCurrency: row.baseCurrency,
      locale: row.locale,
      timezone: row.timezone,
      taxIdentifiers: row.taxIdentifiers,
      address: row.address,
      contact: row.contact,
      bankDetails: row.bankDetails,
      branding: row.branding,
      fiscalYearStart: row.fiscalYearStart,
      fiscalYearConfig: row.fiscalYearConfig,
      isDefault: row.isDefault,
    });
    const [before] = await db.select().from(schema.legalEntities).where(eq(schema.legalEntities.id, 'ent_clerk_open'));

    const res = await call('u_clerk', 'POST', '/api/accounting-entities', {
      body: {
        legalEntityId: 'ent_clerk_open',
        name: 'Renamed BV',
        legalName: 'Renamed Holding BV',
        dba: 'Renamed',
        entityType: 'bv',
        jurisdictionCode: 'BE',
        baseCurrency: 'USD',
        locale: 'en-US',
        timezone: 'America/New_York',
        vatNumber: 'not a VAT number',
        taxIdentifiers: { registrationNumber: '12345678' },
        address: { line1: 'Elsewhere 2', city: 'Utrecht', country: 'NL' },
        contact: { email: 'new@clerk.example' },
        bankDetails: { bankName: 'Other bank' },
        branding: { logoUrl: 'https://example.com/other.png', primaryColor: '#000000', footerText: 'Thank you' },
        fiscalYearStart: 4,
        accountingMethod: 'cash',
      },
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      id: 'ent_clerk_open',
      name: 'Clerk BV',
      accountingMethod: 'cash',
      branding: { logoUrl: 'https://example.com/clerk.png', primaryColor: '#123456', footerText: 'Thank you' },
    });

    const [after] = await db.select().from(schema.legalEntities).where(eq(schema.legalEntities.id, 'ent_clerk_open'));
    expect(identity(after!)).toEqual(identity(before!));
    const registrations = await db
      .select()
      .from(schema.legalEntityRegistrations)
      .where(eq(schema.legalEntityRegistrations.entityId, 'ent_clerk_open'));
    expect(registrations).toHaveLength(0);
    // WeldBooks' own fields went to its extension.
    const [ext] = await db.select().from(schema.accountingEntitySettings).where(eq(schema.accountingEntitySettings.entityId, 'ent_clerk_open'));
    expect(ext).toMatchObject({ accountingMethod: 'cash', documentTexts: { footerText: 'Thank you' } });
  });

  it('only moves WeldBooks\' default, not the workspace default, without legal_entities:update', async () => {
    const res = await call('u_clerk', 'POST', '/api/accounting-entities', { body: { legalEntityId: 'ent_clerk_default', isDefault: true } });
    expect(res.status).toBe(201);
    expect(res.data.isDefault).toBe(false);
    const defaults = await db
      .select({ id: schema.legalEntities.id })
      .from(schema.legalEntities)
      .where(and(eq(schema.legalEntities.isDefault, true), isNull(schema.legalEntities.deletedAt)));
    expect(defaults.map((e) => e.id)).toEqual(['ent_open']);
    const [settings] = await db.select({ defaultEntityId: schema.settings.defaultEntityId }).from(schema.settings);
    expect(settings?.defaultEntityId).toBe('ent_clerk_default');
  });

  it('makes it the workspace default for a member with legal_entities:update', async () => {
    const res = await call('u_admin', 'POST', '/api/accounting-entities', { body: { legalEntityId: 'ent_admin_default', isDefault: true } });
    expect(res.status).toBe(201);
    expect(res.data.isDefault).toBe(true);
    const defaults = await db
      .select({ id: schema.legalEntities.id })
      .from(schema.legalEntities)
      .where(and(eq(schema.legalEntities.isDefault, true), isNull(schema.legalEntities.deletedAt)));
    expect(defaults.map((e) => e.id)).toEqual(['ent_admin_default']);
    const [settings] = await db.select({ defaultEntityId: schema.settings.defaultEntityId }).from(schema.settings);
    expect(settings?.defaultEntityId).toBe('ent_admin_default');
  });
});
