/**
 * pglite-backed test for GET /api/dashboard/onboarding-checklist (CRM items).
 *
 * The four CRM checklist items must be computed from CRM data only: companies,
 * people flagged `in_crm` (not mail/helpdesk auto-created contacts), `note`
 * activities and tasks linked to a company or person.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { dashboardRoutes } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';

const { companies, people, crmActivities, tasks } = schema;

type Items = Record<string, boolean>;

let db: Database;

async function checklist(): Promise<Items> {
  const { request } = createTestApp('/api/dashboard', dashboardRoutes, {
    context: { userId: 'user_admin', tenantDb: db },
  });
  const res = await request('/api/dashboard/onboarding-checklist');
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { items: Items } };
  return json.data.items;
}

const now = new Date();

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 120_000);

describe('GET /api/dashboard/onboarding-checklist · CRM items', () => {
  it('reports every CRM item as incomplete on an empty workspace', async () => {
    const items = await checklist();
    expect(items.crm_customer_created).toBe(false);
    expect(items.crm_contact_created).toBe(false);
    expect(items.crm_note_created).toBe(false);
    expect(items.crm_task_created).toBe(false);
  });

  it('does not count a person that is not in the CRM (auto-created contact)', async () => {
    await db.insert(people).values({
      id: 'person_auto',
      displayName: 'Mail Contact',
      inCrm: false,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof people.$inferInsert);
    expect((await checklist()).crm_contact_created).toBe(false);
  });

  it('does not count a task without a CRM link', async () => {
    await db.insert(tasks).values({
      id: 'task_plain',
      title: 'Plain task',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof tasks.$inferInsert);
    expect((await checklist()).crm_task_created).toBe(false);
  });

  it('does not count a non-note activity', async () => {
    await db.insert(crmActivities).values({
      id: 'act_call',
      type: 'call',
      subject: 'Call',
      assignedToId: 'user_admin',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof crmActivities.$inferInsert);
    expect((await checklist()).crm_note_created).toBe(false);
  });

  it('completes each item once the CRM record exists', async () => {
    await db.insert(companies).values({
      id: 'company_1',
      name: 'Acme',
      displayName: 'Acme',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof companies.$inferInsert);
    await db.insert(people).values({
      id: 'person_crm',
      displayName: 'Jane Doe',
      inCrm: true,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof people.$inferInsert);
    await db.insert(crmActivities).values({
      id: 'act_note',
      type: 'note',
      subject: 'Note',
      assignedToId: 'user_admin',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof crmActivities.$inferInsert);
    await db.insert(tasks).values({
      id: 'task_crm',
      title: 'Call Acme',
      customerId: 'company_1',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof tasks.$inferInsert);

    const items = await checklist();
    expect(items.crm_customer_created).toBe(true);
    expect(items.crm_contact_created).toBe(true);
    expect(items.crm_note_created).toBe(true);
    expect(items.crm_task_created).toBe(true);
  });
});
