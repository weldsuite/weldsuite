/**
 * /api/custom-objects/templates: listing the ready-made object types and
 * installing the asset template (object, fields, relationships, events),
 * mounted ahead of the object routes as app-api mounts it.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { customObjectTemplateRoutes } from './index';
import { customObjectsRoutes } from '../custom-objects';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

let db: Database;

const routes = new Hono<{ Bindings: Env; Variables: Variables }>();
routes.route('/', customObjectTemplateRoutes);
routes.route('/', customObjectsRoutes);

const app = (keys: string[]) =>
  createTestApp('/api/custom-objects', routes, {
    context: { permissions: permissions(...keys), tenantDb: db },
  });

const install = (keys = ['weldobjects:manage']) =>
  app(keys).request('/api/custom-objects/templates/asset', { method: 'POST' });

interface Template {
  key: string;
  installed: boolean;
  objectId: string | null;
  fieldCount: number;
  linkCount: number;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('GET /api/custom-objects/templates', () => {
  it('lists the asset template as not installed', async () => {
    const res = await app(['weldobjects:read']).request('/api/custom-objects/templates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Template[]; pagination: { totalCount: number } };
    expect(body.data).toEqual([
      expect.objectContaining({
        key: 'asset',
        slug: 'asset',
        labelPlural: 'Assets',
        icon: 'Laptop',
        fieldCount: 9,
        linkCount: 2,
        installed: false,
        objectId: null,
      }),
    ]);
    expect(body.pagination.totalCount).toBe(1);
  });

  it('needs weldobjects:read or weldobjects:manage', async () => {
    const res = await app(['companies:read']).request('/api/custom-objects/templates');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/custom-objects/templates/:key', () => {
  it('refuses a caller without weldobjects:manage', async () => {
    expect((await install(['weldobjects:read'])).status).toBe(403);
  });

  it('answers 404 for a template that does not exist', async () => {
    const res = await app(['weldobjects:manage']).request('/api/custom-objects/templates/vehicle', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('answers 409 when a deleted object still holds the slug', async () => {
    await db.insert(schema.customObjects).values({
      id: 'cobj_old_asset',
      slug: 'asset',
      entityKey: 'co_asset',
      labelSingular: 'Asset',
      labelPlural: 'Assets',
      createdAt: new Date('2026-05-01T08:00:00.000Z'),
      updatedAt: new Date('2026-05-01T08:00:00.000Z'),
      deletedAt: new Date('2026-05-02T08:00:00.000Z'),
    });
    const res = await install();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("The name 'asset' belonged to a deleted object and cannot be reused");
    await db.delete(schema.customObjects).where(eq(schema.customObjects.id, 'cobj_old_asset'));
  });

  it('installs the asset object with its fields and relationships', async () => {
    const res = await install();
    expect(res.status).toBe(201);
    const { data: object } = (await res.json()) as {
      data: { id: string; slug: string; entityKey: string; status: string; enableSearch: boolean; enableEvents: boolean; titleFieldId: string | null; icon: string };
    };
    expect(object).toMatchObject({
      slug: 'asset',
      entityKey: 'co_asset',
      status: 'active',
      enableSearch: true,
      enableEvents: true,
      icon: 'Laptop',
    });

    const fields = await db
      .select()
      .from(schema.customFieldDefinitions)
      .where(eq(schema.customFieldDefinitions.entityType, 'co_asset'))
      .orderBy(asc(schema.customFieldDefinitions.sortOrder));
    expect(fields.map((f) => [f.slug, f.fieldType, f.required])).toEqual([
      ['name', 'text', true],
      ['asset_type', 'single_select', false],
      ['serial_number', 'text', false],
      ['location', 'text', false],
      ['warranty_until', 'date', false],
      ['purchase_date', 'date', false],
      ['supplier', 'text', false],
      ['status', 'single_select', false],
      ['notes', 'textarea', false],
    ]);
    expect(object.titleFieldId).toBe(fields[0]!.id);
    expect(fields[1]!.options?.map((o) => o.value)).toEqual([
      'laptop', 'desktop', 'monitor', 'phone', 'tablet', 'server', 'network_device', 'printer', 'software_licence', 'other',
    ]);
    expect(fields[7]!.options?.map((o) => o.value)).toEqual(['in_use', 'in_stock', 'in_repair', 'retired', 'lost']);

    const links = await db
      .select()
      .from(schema.customObjectLinks)
      .where(eq(schema.customObjectLinks.sourceEntityKey, 'co_asset'))
      .orderBy(asc(schema.customObjectLinks.sortOrder));
    expect(links.map((l) => [l.slug, l.targetEntityKey, l.cardinality, l.sourceLabel, l.targetLabel])).toEqual([
      ['owner', 'person', 'many_to_one', 'Assets', 'Owner'],
      ['tickets', 'conversation', 'many_to_many', 'Assets', 'Tickets'],
    ]);
  });

  it('lists the template as installed afterwards', async () => {
    const [object] = await db.select().from(schema.customObjects).where(eq(schema.customObjects.slug, 'asset'));
    const res = await app(['weldobjects:manage']).request('/api/custom-objects/templates');
    const body = (await res.json()) as { data: Template[] };
    expect(body.data[0]).toMatchObject({ installed: true, objectId: object!.id });
  });

  it('answers 409 with the existing object when installed twice', async () => {
    const [object] = await db.select().from(schema.customObjects).where(eq(schema.customObjects.slug, 'asset'));
    const res = await install();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; details: { id: string } } };
    expect(body.error.message).toBe("A custom object with the name 'asset' already exists");
    expect(body.error.details.id).toBe(object!.id);
    const objects = await db.select().from(schema.customObjects).where(eq(schema.customObjects.slug, 'asset'));
    expect(objects).toHaveLength(1);
  });

  it('still serves GET /:id for real objects behind the templates mount', async () => {
    const [object] = await db.select().from(schema.customObjects).where(eq(schema.customObjects.slug, 'asset'));
    const res = await app(['weldobjects:read']).request(`/api/custom-objects/${object!.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fieldCount: number } };
    expect(body.data.fieldCount).toBe(9);
  });
});
