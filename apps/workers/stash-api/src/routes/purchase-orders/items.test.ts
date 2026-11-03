/**
 * /api/purchase-orders/:id/items (pglite): the lines of a purchase order and
 * the WeldFlow project each one's cost belongs to (FLOW-019). List, create,
 * edit and delete a line; the server works out the amounts; `projectId` is set
 * on create, changed on edit, cleared with null, and has to be a live project
 * of the workspace; refusals and the `purchase_order` events.
 *
 * Runs against Rust in conformance mode.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { purchaseOrdersRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));

let db: Database;
const PO = 'po_items_main';
const PROJECT = 'proj_po_live';
const OTHER_PROJECT = 'proj_po_other';
const DELETED_PROJECT = 'proj_po_deleted';

const call = (perms: string[]) =>
  createTestApp('/api/purchase-orders', purchaseOrdersRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db },
  });

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type Line = Record<string, unknown> & { id: string };
type Envelope = { data?: Line & Line[]; pagination?: { totalCount: number; hasMore: boolean; cursor: string | null }; error?: { message: string } };

async function send(perms: string[], path: string, init?: RequestInit) {
  const res = await call(perms).request(`/api/purchase-orders${path}`, init);
  const text = res.status === 204 ? '' : await res.text();
  // A malformed body is refused by the validator in plain text, not the envelope.
  let body: Envelope = {};
  try {
    body = text ? (JSON.parse(text) as Envelope) : {};
  } catch {
    body = {};
  }
  return { status: res.status, ...body };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-03-01T08:00:00.000Z');
  await db.insert(schema.purchaseOrders).values([
    { id: PO, poNumber: 'PO-2026-114', supplierId: 'sup_1', status: 'ordered', createdAt: now, updatedAt: now },
    { id: 'po_items_gone', poNumber: 'PO-2026-115', createdAt: now, updatedAt: now, deletedAt: now },
    { id: 'po_items_other', poNumber: 'PO-2026-116', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.projects).values([
    { id: PROJECT, name: 'Portal', createdAt: now, updatedAt: now },
    { id: OTHER_PROJECT, name: 'Website', createdAt: now, updatedAt: now },
    { id: DELETED_PROJECT, name: 'Gone', createdAt: now, updatedAt: now, deletedAt: now },
  ]);
}, 60_000);

describe('purchase order lines', () => {
  let lineId = '';

  it('creates a line with its amounts and the project tag', async () => {
    const res = await send(['orders:create'], `/${PO}/items`, json('POST', {
      name: 'Translation, batch 1',
      sku: 'TR-1',
      quantityOrdered: 3,
      unitPrice: 600,
      discountPercent: 10,
      taxPercent: 21,
      projectId: PROJECT,
    }));
    expect(res.status).toBe(201);
    lineId = res.data!.id;
    expect(lineId).toMatch(/^poi_/);
    expect(res.data).toMatchObject({
      purchaseOrderId: PO,
      name: 'Translation, batch 1',
      sku: 'TR-1',
      quantityOrdered: 3,
      quantityReceived: 0,
      quantityPending: 3,
      quantityRejected: 0,
      unitPrice: '600.00',
      discountPercent: '10.00',
      discountAmount: '180.00',
      taxPercent: '21.00',
      taxAmount: '340.20',
      total: '1960.20',
      projectId: PROJECT,
    });
  });

  it('defaults to one unit, no discount, no tax and no project', async () => {
    const res = await send(['orders:create'], `/${PO}/items`, json('POST', { name: 'Courier', unitPrice: 12.5 }));
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      quantityOrdered: 1,
      quantityPending: 1,
      unitPrice: '12.50',
      discountPercent: '0.00',
      discountAmount: '0.00',
      taxPercent: '0.00',
      taxAmount: '0.00',
      total: '12.50',
      projectId: null,
    });
    const nulled = await send(['orders:create'], `/${PO}/items`, json('POST', { name: 'Parcel', unitPrice: 1, projectId: null }));
    expect(nulled.data).toMatchObject({ projectId: null });
  });

  it('lists the lines of the purchase order, oldest first, with the tag', async () => {
    const res = await send(['orders:read'], `/${PO}/items`);
    expect(res.status).toBe(200);
    expect(res.data!.map((l) => l.name)).toEqual(['Translation, batch 1', 'Courier', 'Parcel']);
    expect(res.data![0]).toMatchObject({ id: lineId, projectId: PROJECT });
    expect(res.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
    const other = await send(['orders:read'], '/po_items_other/items');
    expect(other.data).toEqual([]);
  });

  it('changes the tag and the amounts of a line, and clears the tag with null', async () => {
    const changed = await send(['orders:update'], `/${PO}/items/${lineId}`, json('PATCH', {
      projectId: OTHER_PROJECT,
      quantityOrdered: 4,
      quantityReceived: 1,
    }));
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({
      id: lineId,
      projectId: OTHER_PROJECT,
      quantityOrdered: 4,
      quantityReceived: 1,
      quantityPending: 3,
      discountAmount: '240.00',
      taxAmount: '453.60',
      total: '2613.60',
    });

    const kept = await send(['orders:update'], `/${PO}/items/${lineId}`, json('PATCH', { notes: 'Rush' }));
    expect(kept.data).toMatchObject({ projectId: OTHER_PROJECT, notes: 'Rush', total: '2613.60' });

    const cleared = await send(['orders:update'], `/${PO}/items/${lineId}`, json('PATCH', { projectId: null }));
    expect(cleared.data).toMatchObject({ projectId: null });
    const [row] = await db.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.id, lineId));
    expect(row?.projectId).toBeNull();
  });

  it('refuses a project that does not exist or is deleted', async () => {
    const unknown = await send(['orders:create'], `/${PO}/items`, json('POST', { name: 'X', unitPrice: 1, projectId: 'proj_nope' }));
    expect(unknown.status).toBe(400);
    expect(unknown.error?.message).toBe('Project proj_nope does not exist');
    const deleted = await send(['orders:create'], `/${PO}/items`, json('POST', { name: 'X', unitPrice: 1, projectId: DELETED_PROJECT }));
    expect(deleted.status).toBe(400);
    expect(deleted.error?.message).toBe(`Project ${DELETED_PROJECT} does not exist`);
    const patched = await send(['orders:update'], `/${PO}/items/${lineId}`, json('PATCH', { projectId: 'proj_nope' }));
    expect(patched.status).toBe(400);
    expect(patched.error?.message).toBe('Project proj_nope does not exist');
  });

  it('refuses an invalid body', async () => {
    for (const body of [{ unitPrice: 5 }, { name: 'X' }, { name: 'X', unitPrice: -1 }, { name: 'X', unitPrice: 1.005 }, { name: 'X', unitPrice: 1, quantityOrdered: 0 }, { name: 'X', unitPrice: 1, taxPercent: 101 }, { name: 'X', unitPrice: 1, projectId: 7 }]) {
      expect((await send(['orders:create'], `/${PO}/items`, json('POST', body))).status).toBe(400);
    }
    expect((await send(['orders:update'], `/${PO}/items/${lineId}`, json('PATCH', { name: '' }))).status).toBe(400);
    const malformed = await send(['orders:create'], `/${PO}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"oops' });
    expect(malformed.status).toBe(400);
  });

  it('is a 404 for an unknown or deleted purchase order, and for a line of another one', async () => {
    expect((await send(['orders:read'], '/po_nope/items')).status).toBe(404);
    expect((await send(['orders:create'], '/po_items_gone/items', json('POST', { name: 'X', unitPrice: 1 }))).status).toBe(404);
    const missing = await send(['orders:update'], `/${PO}/items/poi_nope`, json('PATCH', { notes: 'x' }));
    expect(missing.status).toBe(404);
    expect(missing.error?.message).toBe("Purchase order line with ID 'poi_nope' not found");
    expect((await send(['orders:update'], `/po_items_other/items/${lineId}`, json('PATCH', { notes: 'x' }))).status).toBe(404);
    expect((await send(['orders:delete'], `/po_items_other/items/${lineId}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('publishes purchase_order updated for each line change, and none for a refusal', async () => {
    published.mockClear();
    const created = await send(['orders:create'], `/${PO}/items`, json('POST', { name: 'Event line', unitPrice: 2 }));
    await send(['orders:update'], `/${PO}/items/${created.data!.id}`, json('PATCH', { notes: 'n' }));
    await send(['orders:delete'], `/${PO}/items/${created.data!.id}`, { method: 'DELETE' });
    await send(['orders:create'], `/${PO}/items`, json('POST', { name: 'X', unitPrice: 1, projectId: 'proj_nope' }));
    const expected = { entityType: 'purchase_order', action: 'updated', entityId: PO, data: { id: PO, poNumber: 'PO-2026-114', status: 'ordered', supplierId: 'sup_1' } };
    expect(events()).toEqual([expected, expected, expected]);
  });

  it('needs the matching orders permission', async () => {
    expect((await send(['orders:update'], `/${PO}/items`)).status).toBe(403);
    expect((await send(['orders:read'], `/${PO}/items`, json('POST', { name: 'X', unitPrice: 1 }))).status).toBe(403);
    expect((await send(['orders:read'], `/${PO}/items/${lineId}`, json('PATCH', { notes: 'x' }))).status).toBe(403);
    expect((await send(['orders:read'], `/${PO}/items/${lineId}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('deletes a line', async () => {
    expect((await send(['orders:delete'], `/${PO}/items/${lineId}`, { method: 'DELETE' })).status).toBe(204);
    const rows = await db.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.id, lineId));
    expect(rows).toEqual([]);
    expect((await send(['orders:delete'], `/${PO}/items/${lineId}`, { method: 'DELETE' })).status).toBe(404);
  });
});
