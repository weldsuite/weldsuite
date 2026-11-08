/**
 * `legalEntityContext()` and the record/list helpers against a real tenant
 * schema: resolution by header, the entity role swap, the record check and
 * the scope of a request that names no entity.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { KitVariables } from '@weldsuite/worker-kit/env';
import {
  legalEntityContext,
  recordInRequestEntity,
  requestEntityScope,
} from './middleware';
import { myEffectiveAccess, setEntityMember } from './service';
import { getEntityAccess } from './access';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.roles).values([
    { id: 'role_viewer', name: 'Books viewer', isSystem: false, permissions: ['invoices:read'] },
    { id: 'role_owner', name: 'Owner', isSystem: true, permissions: ['*'] },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_member', userId: 'u_member', role: 'MEMBER', permissions: ['invoices:create'] },
    { id: 'wm_admin', userId: 'u_admin', role: 'ADMIN' },
    { id: 'wm_emp', userId: 'u_emp', role: 'MEMBER', memberType: 'EMPLOYEE' },
  ]);
  await db.insert(schema.legalEntities).values([
    { id: 'ent_open', name: 'Open', jurisdictionCode: 'NL', baseCurrency: 'EUR', isDefault: true },
    { id: 'ent_secret', name: 'Secret', jurisdictionCode: 'NL', baseCurrency: 'EUR', accessRestricted: true },
    { id: 'ent_role', name: 'Viewer here', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
  ]);
  await db.insert(schema.legalEntityMembers).values({ id: 'lem_1', entityId: 'ent_role', userId: 'u_member', roleId: 'role_viewer' });
}, 120_000);

function probeApp(options: Parameters<typeof legalEntityContext>[0]) {
  const app = new Hono<{ Variables: KitVariables }>();
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-user') ?? '';
    c.set('userId', userId);
    c.set('tenantDb', db);
    const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
    c.set('userPermissions', await resolveEffectivePermissions(queries, userId));
    await next();
  });
  app.use('*', legalEntityContext(options));
  app.get('/probe', async (c) =>
    c.json({
      entity: c.get('legalEntityId'),
      permissions: c.get('userPermissions')?.permissions ?? [],
      scope: await requestEntityScope(c),
    }),
  );
  app.get('/record/:entityId', async (c) => c.json({ ok: await recordInRequestEntity(c, c.req.param('entityId')) }));
  app.get('/my-access/:entityId', async (c) =>
    c.json(await myEffectiveAccess(db, await getEntityAccess(c), c.req.param('entityId'))),
  );
  return app;
}

async function get(app: Hono<{ Variables: KitVariables }>, path: string, user: string, entity?: string) {
  const res = await app.request(path, { headers: { 'x-user': user, ...(entity ? { 'x-legal-entity-id': entity } : {}) } });
  return res.json() as Promise<Record<string, unknown>>;
}

describe('legalEntityContext', () => {
  const books = probeApp({ scoped: true });
  const hr = probeApp({ scoped: true, fallbackToDefault: false });

  it('resolves the named entity, and the default when none is named', async () => {
    expect((await get(books, '/probe', 'u_member', 'ent_open')).entity).toBe('ent_open');
    expect((await get(books, '/probe', 'u_member')).entity).toBe('ent_open');
    expect((await get(hr, '/probe', 'u_member')).entity).toBeNull();
  });

  it('resolves a restricted entity to nothing for a member without a row, never to the default', async () => {
    const body = await get(books, '/probe', 'u_member', 'ent_secret');
    expect(body.entity).toBeNull();
    expect(body.scope).toEqual([]);
    expect((await get(books, '/probe', 'u_admin', 'ent_secret')).entity).toBe('ent_secret');
  });

  it('swaps in the entity role, keeping personal extras', async () => {
    const inRole = await get(books, '/probe', 'u_member', 'ent_role');
    expect(inRole.entity).toBe('ent_role');
    expect(inRole.permissions).toEqual(expect.arrayContaining(['invoices:read', 'invoices:create']));
    const open = await get(books, '/probe', 'u_member', 'ent_open');
    expect((open.permissions as string[]).length).toBeGreaterThan((inRole.permissions as string[]).length);
  });

  it('only lets a non-uniform member touch records acting with the same role', async () => {
    expect((await get(books, '/record/ent_role', 'u_member', 'ent_role')).ok).toBe(true);
    // Checked with the workspace role (open entity), record in the entity with a Viewer role.
    expect((await get(books, '/record/ent_role', 'u_member', 'ent_open')).ok).toBe(false);
    expect((await get(books, '/record/ent_secret', 'u_member', 'ent_open')).ok).toBe(false);
    // An admin's access is uniform.
    expect((await get(books, '/record/ent_secret', 'u_admin', 'ent_open')).ok).toBe(true);
  });

  it('scopes a request without an entity to where the member acts with the workspace role', async () => {
    expect((await get(hr, '/probe', 'u_member')).scope).toEqual(['ent_open']);
    expect((await get(hr, '/probe', 'u_admin')).scope).toBeNull();
  });

  it('reports the effective access inside an entity', async () => {
    const access = await get(books, '/my-access/ent_role', 'u_member');
    expect(access).toMatchObject({ entityId: 'ent_role', source: 'member', roleId: 'role_viewer', roleName: 'Books viewer' });
    expect(await get(books, '/my-access/ent_secret', 'u_member')).toBeNull();
  });
});

describe('setEntityMember', () => {
  it('refuses the Owner role, unknown roles and Employee members', async () => {
    await expect(setEntityMember(db, { entityId: 'ent_open', userId: 'u_member', roleId: 'role_owner', grantedBy: 'u_admin' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(setEntityMember(db, { entityId: 'ent_open', userId: 'u_member', roleId: 'role_missing', grantedBy: 'u_admin' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(setEntityMember(db, { entityId: 'ent_open', userId: 'u_emp', roleId: null, grantedBy: 'u_admin' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('adds a member and then changes their role', async () => {
    const first = await setEntityMember(db, { entityId: 'ent_secret', userId: 'u_member', roleId: null, grantedBy: 'u_admin' });
    expect(first.created).toBe(true);
    const second = await setEntityMember(db, { entityId: 'ent_secret', userId: 'u_member', roleId: 'role_viewer', grantedBy: 'u_admin' });
    expect(second.created).toBe(false);
    expect(second.member.roleId).toBe('role_viewer');
  });
});
