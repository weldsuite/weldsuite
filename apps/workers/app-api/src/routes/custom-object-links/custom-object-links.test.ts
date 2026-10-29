/**
 * Relationship traversal on records (`/api/objects/:slug/records/:id/links`)
 * and the reverse lookup a built-in record's page uses
 * (`/api/related/:entityType/:entityId/custom-objects`): panels filtered by
 * what the caller may read, attach with the to-one rules, detach.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { customObjectLinkTraversalRoutes, customObjectReverseRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { seedCustomObjects } from '../../test/custom-object-fixtures';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedCustomObjects(db);
}, 60_000);

const READ_ALL = ['weldobjects:asset:read', 'weldobjects:asset:scope:all', 'companies:read', 'weldobjects:site:read', 'tickets:read'];
const UPDATE = ['weldobjects:asset:update', 'weldobjects:asset:scope:all', 'companies:read', 'weldobjects:site:read'];

function objects(...keys: string[]) {
  return createTestApp('/api/objects', customObjectLinkTraversalRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys) },
  });
}

function related(...keys: string[]) {
  return createTestApp('/api/related', customObjectReverseRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys) },
  });
}

const attach = (path: string, ...keys: string[]) =>
  objects(...(keys.length ? keys : UPDATE)).request(`/api/objects/asset/records${path}`, { method: 'POST' });
const detach = (path: string, ...keys: string[]) =>
  objects(...(keys.length ? keys : UPDATE)).request(`/api/objects/asset/records${path}`, { method: 'DELETE' });

type Panel = { linkSlug: string; records: Array<{ id: string; title: string; href: string; relationId: string }> };

describe('/api/objects/:slug/records/:id/links · panels', () => {
  it('lists every relationship of a record with resolved targets', async () => {
    const res = await objects(...READ_ALL).request('/api/objects/asset/records/cor_as_1/links');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Panel[] };
    expect(data.map((p) => p.linkSlug)).toEqual(['customer', 'primary_site', 'sites', 'ticket']);
    expect(data[0]!.records).toEqual([
      { id: 'comp_fx_1', entityType: 'company', title: 'Acme', href: '/crm/companies/comp_fx_1', relationId: 'corl_fx_1' },
    ]);
    expect(data[2]!.records.map((r) => r.id)).toEqual(['cor_site_2', 'cor_site_1']);
    // An edge whose target no longer resolves is dropped.
    expect(data[3]!.records).toEqual([]);
  });

  it('drops panels whose target the caller cannot read', async () => {
    const res = await objects('weldobjects:asset:read').request('/api/objects/asset/records/cor_as_1/links');
    expect(((await res.json()) as { data: Panel[] }).data).toEqual([]);
    const some = await objects('weldobjects:asset:read', 'weldobjects:site:read').request('/api/objects/asset/records/cor_as_1/links');
    expect(((await some.json()) as { data: Panel[] }).data.map((p) => p.linkSlug)).toEqual(['primary_site', 'sites']);
  });

  it('404s a record the caller cannot see', async () => {
    expect((await objects('weldobjects:asset:read').request('/api/objects/asset/records/cor_as_2/links')).status).toBe(404);
    expect((await objects(...READ_ALL).request('/api/objects/asset/records/cor_none/links')).status).toBe(404);
    expect((await objects(...READ_ALL).request('/api/objects/nope/records/cor_as_1/links')).status).toBe(404);
    expect((await objects('weldobjects:site:read').request('/api/objects/asset/records/cor_as_1/links')).status).toBe(403);
  });
});

describe('/api/objects/:slug/records/:id/links/:linkSlug', () => {
  it('lists one relationship', async () => {
    const res = await objects(...READ_ALL).request('/api/objects/asset/records/cor_as_1/links/sites');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; title: string; href: string }> };
    expect(data).toEqual([
      { id: 'cor_site_2', entityType: 'co_site', title: 'South', href: '/objects/site/cor_site_2', relationId: 'corl_fx_2' },
      { id: 'cor_site_1', entityType: 'co_site', title: 'North', href: '/objects/site/cor_site_1', relationId: 'corl_fx_3' },
    ]);
  });

  it('refuses a relationship whose target the caller cannot read, and 404s unknowns', async () => {
    const res = await objects('weldobjects:asset:read').request('/api/objects/asset/records/cor_as_1/links/customer');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('You do not have permission to view customer');
    const unknown = await objects(...READ_ALL).request('/api/objects/asset/records/cor_as_1/links/nope');
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toBe("Relationship with ID 'nope' not found");
    expect((await objects(...READ_ALL).request('/api/objects/asset/records/cor_none/links/sites')).status).toBe(404);
  });
});

describe('/api/objects/:slug/records/:id/links/:linkSlug/:targetId · attach and detach', () => {
  it('attaches to a to-one relationship, replacing the previous target', async () => {
    const first = await attach('/cor_as_2/links/customer/comp_fx_1');
    expect(first.status).toBe(201);
    expect(((await first.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(['comp_fx_1']);

    const replaced = await attach('/cor_as_2/links/customer/comp_fx_2');
    expect(replaced.status).toBe(201);
    expect(((await replaced.json()) as { data: Array<{ id: string; title: string }> }).data).toMatchObject([
      { id: 'comp_fx_2', title: 'Blank Co' },
    ]);

    const again = await attach('/cor_as_2/links/customer/comp_fx_2');
    expect(again.status).toBe(201);
    const edges = await db
      .select()
      .from(schema.customObjectRelations)
      .where(and(eq(schema.customObjectRelations.linkId, 'colk_as_customer'), eq(schema.customObjectRelations.sourceId, 'cor_as_2')));
    expect(edges).toHaveLength(1);
  });

  it('keeps a one-to-one target to a single source', async () => {
    expect((await attach('/cor_as_1/links/primary_site/cor_site_1')).status).toBe(201);
    const taken = await attach('/cor_as_2/links/primary_site/cor_site_1');
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: { message: string } }).error.message).toBe(
      'This primary site is already linked to another record and the relationship is one-to-one',
    );
    // Re-attaching the same pair is fine.
    expect((await attach('/cor_as_1/links/primary_site/cor_site_1')).status).toBe(201);
  });

  it('attaches to a to-many relationship, ignoring a target that does not resolve', async () => {
    const res = await attach('/cor_as_4/links/sites/cor_site_1');
    expect(res.status).toBe(201);
    const ghost = await attach('/cor_as_4/links/sites/cor_site_missing');
    expect(ghost.status).toBe(201);
    expect(((await ghost.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(['cor_site_1']);
  });

  it('refuses without read access to the target, update on the source, or a known relationship', async () => {
    const res = await attach('/cor_as_2/links/customer/comp_fx_1', 'weldobjects:asset:update', 'weldobjects:asset:scope:all');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('You do not have permission to link customer');
    expect((await attach('/cor_as_2/links/customer/comp_fx_1', 'weldobjects:asset:read', 'companies:read')).status).toBe(403);
    expect((await attach('/cor_as_2/links/nope/comp_fx_1')).status).toBe(404);
    expect((await attach('/cor_none/links/customer/comp_fx_1')).status).toBe(404);
    expect((await attach('/cor_as_2/links/customer/comp_fx_1', 'weldobjects:asset:update', 'companies:read')).status).toBe(404);
  });

  it('detaches, and treats a missing edge as done', async () => {
    expect((await detach('/cor_as_1/links/sites/cor_site_2')).status).toBe(204);
    expect((await detach('/cor_as_1/links/sites/cor_site_2')).status).toBe(204);
    const panel = await objects(...READ_ALL).request('/api/objects/asset/records/cor_as_1/links/sites');
    expect(((await panel.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(['cor_site_1']);
    expect((await detach('/cor_as_1/links/nope/cor_site_2')).status).toBe(404);
    expect((await detach('/cor_none/links/sites/cor_site_2')).status).toBe(404);
    expect((await detach('/cor_as_1/links/sites/cor_site_2', 'weldobjects:asset:read')).status).toBe(403);
  });
});

describe('/api/related/:entityType/:entityId/custom-objects', () => {
  it('groups the custom object records linked to a record, per relationship', async () => {
    const res = await related('weldobjects:read', 'weldobjects:asset:read', 'weldobjects:site:read').request(
      '/api/related/company/comp_fx_1/custom-objects',
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{ linkId: string; label: string; objectSlug: string; objectLabelPlural: string; records: Array<{ id: string }> }>;
    };
    expect(data.map((p) => p.linkId)).toEqual(['colk_as_customer', 'colk_site_company']);
    expect(data[0]).toMatchObject({ label: 'Assets', objectSlug: 'asset', objectLabelPlural: 'Assets' });
    // The deleted record's edge is skipped.
    expect(data[0]!.records.map((r) => r.id)).toEqual(['cor_as_1']);
  });

  it('shows only the objects the caller may read', async () => {
    const res = await related('weldobjects:read', 'weldobjects:site:read').request('/api/related/company/comp_fx_1/custom-objects');
    expect(((await res.json()) as { data: Array<{ objectSlug: string }> }).data.map((p) => p.objectSlug)).toEqual(['site']);
  });

  it('answers an empty list for a record nothing links to, and needs weldobjects:read', async () => {
    const res = await related('weldobjects:read').request('/api/related/ticket/tkt_none/custom-objects');
    expect(await res.json()).toEqual({ data: [] });
    expect((await related('weldobjects:asset:read').request('/api/related/company/comp_fx_1/custom-objects')).status).toBe(403);
  });
});
