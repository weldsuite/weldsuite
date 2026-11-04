/**
 * /api/bills (pglite): the WeldFlow project cost tag on bill lines (FLOW-019).
 * A line carries `projectId` (null leaves it untagged); the project has to be
 * a live one of the workspace; the tag is returned with the bill's lines, can
 * be changed or cleared by saving the lines again, and stays on the saved lines
 * when only the header is edited.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { billsRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';

let db: Database;
let entityId = '';
const PROJECT = 'proj_bill_live';
const OTHER_PROJECT = 'proj_bill_other';
const DELETED_PROJECT = 'proj_bill_deleted';

const app = () =>
  createTestApp('/api/bills', billsRoutes, {
    context: { permissions: permissions('*'), tenantDb: db },
  });

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': entityId },
  body: JSON.stringify(body),
});

type Line = { description: string; projectId: string | null; sortOrder: number };

async function createBill(items: Array<Record<string, unknown>>) {
  const res = await app().request(
    '/api/bills',
    json('POST', { contactId: 'acn_bill_project', issueDate: '2026-03-10', dueDate: '2026-04-09', items }),
  );
  const body = (await res.json()) as { data?: { id: string }; error?: { message: string } };
  return { status: res.status, id: body.data?.id ?? '', error: body.error };
}

async function detail(id: string) {
  const res = await app().request(`/api/bills/${id}`, { headers: { 'X-Accounting-Entity-Id': entityId } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { items: Line[] } }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: { permissions: permissions('*'), tenantDb: db },
  });
  const res = await request('/api/accounting-entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bill Project BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' }),
  });
  expect(res.status).toBe(201);
  entityId = ((await res.json()) as { data: { id: string } }).data.id;
  await db.insert(schema.parties).values({ id: 'acn_bill_project', displayName: 'Licence Vendor', role: 'none' });
  const now = new Date();
  await db.insert(schema.projects).values([
    { id: PROJECT, name: 'Portal', createdAt: now, updatedAt: now },
    { id: OTHER_PROJECT, name: 'Website', createdAt: now, updatedAt: now },
    { id: DELETED_PROJECT, name: 'Gone', createdAt: now, updatedAt: now, deletedAt: now },
  ]);
}, 120_000);

describe('project tag on bill lines', () => {
  let billId: string;

  it('stores the tag on a line and leaves the others untagged', async () => {
    const created = await createBill([
      { description: 'Load-test licence', unitPrice: '100.00', projectId: PROJECT },
      { description: 'Office paper', unitPrice: '20.00' },
      { description: 'Shared hosting', unitPrice: '30.00', projectId: null },
    ]);
    expect(created.status).toBe(201);
    billId = created.id;
    const rows = await db
      .select({ description: schema.billItems.description, projectId: schema.billItems.projectId })
      .from(schema.billItems)
      .where(eq(schema.billItems.billId, billId))
      .orderBy(schema.billItems.sortOrder);
    expect(rows.map((r) => r.projectId)).toEqual([PROJECT, null, null]);
  });

  it('returns the tag with the lines of the bill', async () => {
    const bill = await detail(billId);
    expect(bill.items.map((l) => l.projectId)).toEqual([PROJECT, null, null]);
  });

  it('changes and clears the tag when the lines are saved again', async () => {
    const res = await app().request(
      `/api/bills/${billId}`,
      json('PATCH', {
        items: [
          { description: 'Load-test licence', unitPrice: '100.00', projectId: OTHER_PROJECT },
          { description: 'Office paper', unitPrice: '20.00', projectId: PROJECT },
          { description: 'Shared hosting', unitPrice: '30.00', projectId: null },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect((await detail(billId)).items.map((l) => l.projectId)).toEqual([OTHER_PROJECT, PROJECT, null]);
  });

  it('keeps the tags when only the header is edited', async () => {
    const res = await app().request(`/api/bills/${billId}`, json('PATCH', { notes: 'Checked' }));
    expect(res.status).toBe(200);
    expect((await detail(billId)).items.map((l) => l.projectId)).toEqual([OTHER_PROJECT, PROJECT, null]);
  });

  it('refuses a project that does not exist, on create and on edit', async () => {
    const created = await createBill([{ description: 'Nothing', unitPrice: '1.00', projectId: 'proj_nope' }]);
    expect(created.status).toBe(400);
    expect(created.error?.message).toBe('Project proj_nope does not exist');

    const res = await app().request(
      `/api/bills/${billId}`,
      json('PATCH', { items: [{ description: 'Nothing', unitPrice: '1.00', projectId: 'proj_nope' }] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Project proj_nope does not exist');
    // The refused edit left the saved lines alone.
    expect((await detail(billId)).items).toHaveLength(3);
  });

  it('refuses a deleted project', async () => {
    const created = await createBill([{ description: 'Nothing', unitPrice: '1.00', projectId: DELETED_PROJECT }]);
    expect(created.status).toBe(400);
    expect(created.error?.message).toBe(`Project ${DELETED_PROJECT} does not exist`);
  });
});
