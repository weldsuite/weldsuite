/**
 * /api/dashboard against a real tenant database (pglite): the 30-day chart
 * (orders, revenue and tickets merged per day, each gated on its object), the
 * activity feed (newest 20 live CRM activities), the ticket and order badges,
 * the full onboarding checklist and dismissing an app's checklist, and the
 * installed apps a role or an assignment grants.
 *
 * Conformance-ready (rust/conformance/suites.json): every request here runs on
 * the Rust backend too and must answer the same.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { dashboardRoutes } from './index';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** `days` ago to the millisecond; the seeds stay well clear of the chart's 30-day edge. */
const daysAgo = (days: number) => new Date(NOW - days * DAY);
const dateOf = (date: Date) => date.toISOString().slice(0, 10);

let db: Database;

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/dashboard', dashboardRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
}

async function get<T>(path: string, userId = 'user_admin', ...keys: string[]): Promise<T> {
  const res = await app(userId, ...keys).request(`/api/dashboard${path}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: T }).data;
}

function dismiss(body: string) {
  return app('user_admin').request('/api/dashboard/onboarding-checklist/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function seedOrder(id: string, createdAt: Date, total: string, extra: Record<string, unknown> = {}) {
  await db.insert(schema.orders).values({
    id,
    orderNumber: id.toUpperCase(),
    total,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  } as typeof schema.orders.$inferInsert);
}

async function seedTicket(id: string, createdAt: Date, extra: Record<string, unknown> = {}) {
  await db.insert(schema.helpdeskTickets).values({
    id,
    ticketNumber: id.toUpperCase(),
    customerName: 'Customer',
    customerEmail: 'customer@example.com',
    subject: 'Help',
    createdAt,
    updatedAt: createdAt,
    ...extra,
  } as typeof schema.helpdeskTickets.$inferInsert);
}

// Chart days: A has orders only, B orders and a ticket, C tickets only.
const A = daysAgo(5);
const B = daysAgo(3);
const C = daysAgo(1);

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await seedOrder('ord_a1', A, '100.50');
  await seedOrder('ord_a2', A, '49.50', { status: 'paid' });
  await seedOrder('ord_a_deleted', A, '999.00', { deletedAt: new Date() });
  await seedOrder('ord_b1', B, '20.25');
  await seedOrder('ord_old', daysAgo(40), '75.00');

  await seedTicket('tkt_b1', B, { status: 'open' });
  await seedTicket('tkt_c1', C, { status: 'open' });
  await seedTicket('tkt_c2', C, { status: 'closed' });
  await seedTicket('tkt_deleted', C, { status: 'open', deletedAt: new Date() });
  await seedTicket('tkt_old', daysAgo(45), { status: 'open' });

  // 21 live activities (one more than the feed shows) and a deleted one.
  for (let i = 0; i < 21; i++) {
    await db.insert(schema.crmActivities).values({
      id: `act_${String(i).padStart(2, '0')}`,
      type: i % 2 === 0 ? 'call' : 'meeting',
      subject: `Activity ${i}`,
      assignedToId: 'user_admin',
      createdAt: new Date(NOW - (30 - i) * 60_000),
      updatedAt: new Date(NOW - (30 - i) * 60_000),
    } as typeof schema.crmActivities.$inferInsert);
  }
  await db.insert(schema.crmActivities).values({
    id: 'act_deleted',
    type: 'note',
    subject: 'Deleted',
    assignedToId: 'user_admin',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    deletedAt: new Date(NOW),
  } as typeof schema.crmActivities.$inferInsert);
}, 120_000);

describe('GET /api/dashboard/chart', () => {
  it('merges order counts, revenue and ticket counts per day, oldest first', async () => {
    expect(await get('/chart', 'user_admin', 'orders:read', 'tickets:read')).toEqual([
      { date: dateOf(A), orders: 2, tickets: 0, revenue: 150 },
      { date: dateOf(B), orders: 1, tickets: 1, revenue: 20.25 },
      { date: dateOf(C), orders: 0, tickets: 2, revenue: 0 },
    ]);
  });

  it('gives the ticket days a point of their own without orders:read', async () => {
    expect(await get('/chart', 'user_admin', 'tickets:read')).toEqual([
      { date: dateOf(B), orders: 0, tickets: 1, revenue: 0 },
      { date: dateOf(C), orders: 0, tickets: 2, revenue: 0 },
    ]);
  });

  it('leaves the ticket counts at zero without tickets:read', async () => {
    expect(await get('/chart', 'user_admin', 'orders:read')).toEqual([
      { date: dateOf(A), orders: 2, tickets: 0, revenue: 150 },
      { date: dateOf(B), orders: 1, tickets: 0, revenue: 20.25 },
    ]);
  });
});

describe('GET /api/dashboard/activity', () => {
  it('lists the 20 newest live activities, newest first', async () => {
    const activities = await get<Array<{ id: string; subject: string }>>('/activity', 'user_admin', 'activities:read');
    expect(activities).toHaveLength(20);
    expect(activities[0]).toMatchObject({ id: 'act_20', subject: 'Activity 20' });
    expect(activities.at(-1)?.id).toBe('act_01');
    expect(activities.map((a) => a.id)).not.toContain('act_deleted');
  });
});

describe('GET /api/dashboard/sidebar-badges', () => {
  it('counts live open tickets and pending orders for members who may read them', async () => {
    expect(await get('/sidebar-badges', 'user_admin', 'tickets:read', 'orders:read')).toEqual({
      unreadMessages: 0,
      openTickets: 3,
      pendingOrders: 3,
    });
  });

  it('counts only the objects the member may read', async () => {
    expect(await get('/sidebar-badges', 'user_admin', 'orders:read')).toEqual({
      unreadMessages: 0,
      openTickets: 0,
      pendingOrders: 3,
    });
  });
});

describe('GET /api/dashboard/onboarding-checklist', () => {
  type Checklist = { dismissedApps: string[]; items: Record<string, boolean> };

  it('reports every item open on a workspace without settings or data', async () => {
    const checklist = await get<Checklist>('/onboarding-checklist');
    expect(checklist.dismissedApps).toEqual([]);
    expect(Object.values(checklist.items).every((done) => done === false)).toBe(true);
    expect(Object.keys(checklist.items)).toHaveLength(16);
  });
});

describe('POST /api/dashboard/onboarding-checklist/dismiss', () => {
  it('refuses a body without an app code', async () => {
    const res = await dismiss('{}');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: 'appCode is required' } });
    expect((await dismiss('{"appCode":""}')).status).toBe(400);
  });

  it('answers 500 when the body is not JSON', async () => {
    const res = await dismiss('not json');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { message: 'Failed to dismiss checklist' } });
  });

  it('creates the settings record on the first dismissal', async () => {
    const res = await dismiss('{"appCode":"weldcrm"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    const checklist = await get<{ dismissedApps: string[] }>('/onboarding-checklist');
    expect(checklist.dismissedApps).toEqual(['weldcrm']);
  });

  it('adds later dismissals once each and keeps the other custom settings', async () => {
    await db.update(schema.workspaceSettings).set({
      customSettings: { onboardingChecklistDismissedApps: ['weldcrm'], theme: 'dark' },
    });
    expect((await dismiss('{"appCode":"welddesk"}')).status).toBe(200);
    expect((await dismiss('{"appCode":"weldcrm"}')).status).toBe(200);
    const [settings] = await db.select().from(schema.workspaceSettings);
    expect(settings.customSettings).toEqual({ onboardingChecklistDismissedApps: ['weldcrm', 'welddesk'], theme: 'dark' });
    expect((await get<{ dismissedApps: string[] }>('/onboarding-checklist')).dismissedApps).toEqual([
      'weldcrm',
      'welddesk',
    ]);
  });
});

describe('GET /api/dashboard/installed-apps · roles and assignments', () => {
  beforeAll(async () => {
    for (const [i, appCode] of ['weldcrm', 'welddesk', 'weldmail', 'weldbooks'].entries()) {
      await db.insert(schema.workspaceInstalledApps).values({ id: `wia_d${i}`, appCode, displayOrder: i });
    }
    await db.insert(schema.roles).values({ id: 'role_sales', name: 'Sales', apps: ['weldbooks', 'weldcrm', 'weldhost'] });
    await db.insert(schema.workspaceMembers).values([
      { id: 'wm_d_sales', userId: 'user_sales', email: 'sales@test.dev', role: 'MEMBER', roleId: 'role_sales' },
      { id: 'wm_d_plain', userId: 'user_plain', email: 'plain@test.dev', role: 'member' },
    ] as (typeof schema.workspaceMembers.$inferInsert)[]);
    await db.insert(schema.userAppAssignments).values([
      { id: 'uaa_d1', userId: 'user_sales', appCode: 'weldmail' },
      { id: 'uaa_d2', userId: 'user_sales', appCode: 'welddesk', isActive: false },
      { id: 'uaa_d3', userId: 'user_plain', appCode: 'weldmail' },
      { id: 'uaa_d4', userId: 'user_plain', appCode: 'weldhost' },
      { id: 'uaa_d5', userId: 'user_stranger', appCode: 'welddesk' },
    ]);
  });

  it("joins the role's installed apps and the active assignments, in installed order", async () => {
    expect(await get('/installed-apps', 'user_sales')).toEqual(['weldcrm', 'weldmail', 'weldbooks']);
  });

  it('gives a member without a role only their installed assignments', async () => {
    expect(await get('/installed-apps', 'user_plain')).toEqual(['weldmail']);
  });

  it('gives a user without a member row their assignments (nothing to link)', async () => {
    expect(await get('/installed-apps', 'user_stranger')).toEqual(['welddesk']);
  });
});

describe('GET /api/dashboard/onboarding-checklist · every item', () => {
  it('reads a blank logo as missing', async () => {
    await db.update(schema.workspaceSettings).set({ logoUrl: '  ' });
    expect((await get<{ items: Record<string, boolean> }>('/onboarding-checklist')).items.workspace_logo_uploaded).toBe(
      false,
    );
  });

  it('completes each item once its data exists', async () => {
    const now = new Date();
    await db.update(schema.workspaceSettings).set({ logoUrl: 'https://cdn.example.com/logo.png' });
    const seed = async (table: unknown, row: Record<string, unknown>) =>
      db.insert(table as typeof schema.companies).values({ createdAt: now, updatedAt: now, ...row } as never);
    await seed(schema.companies, { id: 'co_1', name: 'Acme', displayName: 'Acme' });
    await seed(schema.people, { id: 'pe_1', displayName: 'Jane', inCrm: true });
    await seed(schema.crmActivities, {
      id: 'act_note',
      type: 'note',
      subject: 'Note',
      assignedToId: 'user_admin',
      createdAt: daysAgo(400),
      updatedAt: daysAgo(400),
    });
    await seed(schema.tasks, { id: 'task_1', title: 'Call Jane', personId: 'pe_1' });
    await seed(schema.crmPipelines, { id: 'pipe_1', name: 'Sales' });
    await seed(schema.helpdeskDepartments, { id: 'dept_1', name: 'Support' });
    await seed(schema.mailAccounts, { id: 'mail_1', name: 'Inbox', email: 'inbox@example.com' });
    await seed(schema.projects, { id: 'proj_1', name: 'Launch' });
    await seed(schema.hostDomains, { id: 'dom_1', name: 'example', tld: 'com', fullDomain: 'example.com' });
    await seed(schema.carriers, { id: 'car_1', name: 'PostNL', code: 'postnl' });
    await seed(schema.warehouses, { id: 'wh_1', name: 'Main' });
    await seed(schema.accounts, { id: 'acc_1', entityId: 'ent_1', code: '1000', name: 'Cash', type: 'asset', normalSide: 'debit' });
    await seed(schema.socialAccounts, {
      id: 'soc_1',
      platform: 'facebook',
      platformAccountId: 'fb_1',
      name: 'Acme',
      connectedByUserId: 'user_admin',
    });

    const { dismissedApps, items } = await get<{ dismissedApps: string[]; items: Record<string, boolean> }>(
      '/onboarding-checklist',
    );
    expect(dismissedApps).toEqual(['weldcrm', 'welddesk']);
    // Two live members (user_sales, user_plain) from the installed-apps block.
    expect(items).toEqual({
      crm_customer_created: true,
      crm_contact_created: true,
      crm_note_created: true,
      crm_task_created: true,
      crm_pipeline_created: true,
      helpdesk_department_created: true,
      mail_account_connected: true,
      project_created: true,
      task_created: true,
      host_domain_added: true,
      parcel_carrier_configured: true,
      wms_warehouse_added: true,
      accounting_chart_setup: true,
      social_account_connected: true,
      workspace_member_invited: true,
      workspace_logo_uploaded: true,
    });
  });
});
