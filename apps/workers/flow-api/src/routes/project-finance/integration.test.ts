/**
 * DB-backed integration tests for /api/project-finance (FLOW-019): the figures,
 * the cost lines by source, the weekly snapshots and the manual forecast. Runs
 * against the TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json), so every status, message, figure and event
 * asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectFinanceRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_fin_manager';
const MEMBER = 'user_fin_member';
const FINANCE = 'user_fin_finance';
const OUTSIDER = 'user_fin_outsider';

const READ = ['projects:read'];
const FULL = ['projects:read', 'projects:update'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-finance', projectFinanceRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-finance${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const manager = () => as(MANAGER);
const member = () => as(MEMBER, READ);

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);

beforeEach(() => {
  published.mockClear();
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const T0 = new Date('2026-01-01T00:00:00.000Z');

async function seedProject(id: string, extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  await db.insert(schema.projects).values({
    id,
    name: id,
    projectManagerId: MANAGER,
    budgetedAmount: '1000.00',
    budgetCurrency: 'EUR',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-12-31T00:00:00.000Z'),
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: T0, updatedAt: T0, joinedAt: T0 },
    { id: `pm_${id}_f`, projectId: id, userId: FINANCE, role: 'member', isActive: true, createdAt: T0, updatedAt: T0, joinedAt: T0 },
  ]);
}

async function seedDeliverable(projectId: string, id: string, number: number, extra: Partial<typeof schema.projectDeliverables.$inferInsert> = {}) {
  await db.insert(schema.projectDeliverables).values({
    id,
    projectId,
    number,
    title: `Deliverable ${number}`,
    createdBy: MANAGER,
    plannedStart: new Date('2026-01-01T00:00:00.000Z'),
    plannedEnd: new Date('2026-12-31T00:00:00.000Z'),
    ...extra,
  });
}

async function seedTask(projectId: string, id: string, deliverableId: string | null, status: string, hours: string) {
  await db.insert(schema.tasks).values({ id, projectId, deliverableId, title: id, status, estimatedHours: hours, createdAt: T0, updatedAt: T0 });
}

async function seedTime(projectId: string, id: string, taskId: string | null, date: string, minutes: string, cost: string, status = 'approved') {
  await db.insert(schema.timeEntries).values({ id, projectId, taskId, userId: MEMBER, date, duration: minutes, cost, status });
}

/** Everything a tagged bill, journal line, PO line and declaration needs. */
async function seedSources(projectId: string, p: string) {
  const now = new Date('2026-05-10T00:00:00.000Z');
  await db.insert(schema.entities).values({ id: `ent_${p}`, name: 'Ent', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
  await db.insert(schema.accounts).values([
    { id: `acc_${p}_x`, entityId: `ent_${p}`, code: '4000', name: 'Costs', type: 'expense', normalSide: 'debit' },
    { id: `acc_${p}_r`, entityId: `ent_${p}`, code: '8000', name: 'Revenue', type: 'revenue', normalSide: 'credit' },
  ]);
  const bill = (id: string, status: string, currency: string, type = 'standard') => ({
    id, entityId: `ent_${p}`, billNumber: id.toUpperCase(), type, status, contactId: 'ct_1', issueDate: now, dueDate: now, currency,
  });
  await db.insert(schema.bills).values([
    bill(`bil_${p}_a`, 'approved', 'EUR'),
    bill(`bil_${p}_d`, 'draft', 'EUR'),
    bill(`bil_${p}_u`, 'approved', 'USD'),
    bill(`bil_${p}_c`, 'paid', 'EUR', 'credit_note'),
  ]);
  const line = (id: string, billId: string, total: string, tagged = true) => ({
    id, entityId: `ent_${p}`, billId, description: `Line ${id}`, unitPrice: total, lineTotal: total, projectId: tagged ? projectId : null,
  });
  await db.insert(schema.billItems).values([
    line(`bli_${p}_1`, `bil_${p}_a`, '100.00'),
    line(`bli_${p}_2`, `bil_${p}_d`, '999.00'),
    line(`bli_${p}_3`, `bil_${p}_u`, '555.00'),
    line(`bli_${p}_4`, `bil_${p}_c`, '10.00'),
    line(`bli_${p}_5`, `bil_${p}_a`, '777.00', false),
  ]);
  const entry = (id: string, status: string) => ({ id, entityId: `ent_${p}`, date: now, status, description: `Entry ${id}` });
  await db.insert(schema.journalEntries).values([entry(`je_${p}_1`, 'posted'), entry(`je_${p}_2`, 'reversed'), entry(`je_${p}_3`, 'draft')]);
  const jl = (id: string, entryId: string, account: string, debit: string, credit: string) => ({
    id, entityId: `ent_${p}`, journalEntryId: entryId, accountId: account, debit, credit, projectId,
  });
  await db.insert(schema.journalLines).values([
    jl(`jl_${p}_1`, `je_${p}_1`, `acc_${p}_x`, '40.00', '0.00'),
    jl(`jl_${p}_2`, `je_${p}_2`, `acc_${p}_x`, '25.00', '0.00'),
    jl(`jl_${p}_3`, `je_${p}_2`, `acc_${p}_x`, '0.00', '25.00'),
    jl(`jl_${p}_4`, `je_${p}_3`, `acc_${p}_x`, '500.00', '0.00'),
    jl(`jl_${p}_5`, `je_${p}_1`, `acc_${p}_r`, '0.00', '40.00'),
  ]);
  const po = (id: string, status: string, currency = 'EUR') => ({ id, poNumber: id.toUpperCase(), status, currency });
  await db.insert(schema.purchaseOrders).values([
    po(`po_${p}_o`, 'ordered'),
    po(`po_${p}_r`, 'received'),
    po(`po_${p}_x`, 'cancelled'),
    po(`po_${p}_u`, 'ordered', 'USD'),
  ]);
  const item = (id: string, poId: string, ordered: number, received: number, total: string, tax: string) => ({
    id, purchaseOrderId: poId, name: `Item ${id}`, quantityOrdered: ordered, quantityReceived: received, unitPrice: '1.00', total, taxAmount: tax, projectId,
  });
  await db.insert(schema.purchaseOrderItems).values([
    item(`poi_${p}_1`, `po_${p}_o`, 10, 4, '121.00', '21.00'),
    item(`poi_${p}_2`, `po_${p}_r`, 2, 2, '60.50', '10.50'),
    item(`poi_${p}_3`, `po_${p}_x`, 1, 0, '999.00', '0.00'),
    item(`poi_${p}_4`, `po_${p}_u`, 1, 1, '88.00', '0.00'),
  ]);
  const decl = (id: string, status: string, amount: string, currency = 'EUR') => ({
    id, employeeId: 'emp_1', expenseDate: '2026-05-02', description: `Expense ${id}`, amount, currency, status, projectId,
  });
  await db.insert(schema.hrDeclarations).values([
    decl(`hrd_${p}_1`, 'approved', '30.00'),
    decl(`hrd_${p}_2`, 'pending', '300.00'),
    decl(`hrd_${p}_3`, 'paid', '20.00', 'USD'),
  ]);
}

// ── Figures ─────────────────────────────────────────────────────────────────

type Figures = {
  currency: string | null;
  canSeeAmounts: boolean;
  figures: Record<string, string | number | null>;
  percent: Record<string, number | null>;
  bySource: Record<string, string | null>;
  excludedLines: number;
  rows: Array<Record<string, string | number | null>>;
  baseline: { version: number } | null;
};

describe('GET /:projectId', () => {
  it('counts only approved time and the posted, received and approved lines tagged to the project', async () => {
    await seedProject('prj_fin_all');
    await seedDeliverable('prj_fin_all', 'del_fin_1', 1);
    await seedTask('prj_fin_all', 'tsk_fin_1', 'del_fin_1', 'done', '10');
    await seedTask('prj_fin_all', 'tsk_fin_2', 'del_fin_1', 'todo', '30');
    await seedTime('prj_fin_all', 'te_fin_1', 'tsk_fin_1', '2026-05-04', '60', '50.00');
    await seedTime('prj_fin_all', 'te_fin_2', null, '2026-05-05', '30', '20.00', 'billed');
    await seedTime('prj_fin_all', 'te_fin_3', 'tsk_fin_1', '2026-05-06', '60', '900.00', 'draft');
    await seedSources('prj_fin_all', 'a');

    const res = await manager()('GET', '/prj_fin_all');
    expect(res.status).toBe(200);
    const f = await data<Figures>(res);

    expect(f.currency).toBe('EUR');
    expect(f.canSeeAmounts).toBe(true);
    // Labour 70; bills 100 - 10 credit note = 90; journal 40 + (25 - 25 + 25 on the reversed entry... see below) = 40 + 25 - 25 + 0; declarations 30;
    // purchase receipts: 100 * 4/10 = 40 (ordered) + 50 (received, 60.50 - 10.50) = 90.
    expect(f.bySource).toEqual({
      time: '70.00',
      bill: '90.00',
      journal: '40.00',
      purchase_order: '90.00',
      declaration: '30.00',
    });
    expect(f.figures.actual).toBe('320.00');
    // 100 * 6 / 10 still to receive on the ordered purchase order.
    expect(f.figures.committed).toBe('60.00');
    // One bill line, one purchase order line and one declaration in USD.
    expect(f.excludedLines).toBe(3);
    expect(f.figures.budget).toBe('1000.00');
    // Done 10 of 40 hours: earned 25% of the 1000 budget (the unassigned time has no task).
    expect(f.figures.earnedValue).toBe('250.00');
    expect(f.figures.cpi).toBe(0.78);
    expect(f.figures.forecastSource).toBe('cpi');
    expect(f.percent.spent).toBe(32);
    expect(f.rows[0]).toMatchObject({ id: 'del_fin_1', code: 'D1', labour: '50.00', percentDone: 25 });
    // The costs without a deliverable close the table.
    expect(f.rows[f.rows.length - 1]).toMatchObject({ id: null, labour: '20.00', expenses: '70.00', purchases: '180.00', committed: '60.00' });
  });

  it('shows percentages only to a member without finance rights', async () => {
    await seedProject('prj_fin_pct');
    await seedSources('prj_fin_pct', 'b');
    const f = await data<Figures>(await member()('GET', '/prj_fin_pct'));
    expect(f.canSeeAmounts).toBe(false);
    expect(f.figures.budget).toBeNull();
    expect(f.figures.actual).toBeNull();
    expect(f.bySource.bill).toBeNull();
    expect(f.percent.spent).toBe(25);

    const finance = await data<Figures>(await as(FINANCE, ['projects:read', 'projects:finance'])('GET', '/prj_fin_pct'));
    expect(finance.canSeeAmounts).toBe(true);
    expect(finance.figures.actual).toBe('250.00');
  });

  it('uses the manual forecast and the budget when nothing is earned', async () => {
    await seedProject('prj_fin_fc', {
      settings: { finance: { manualForecast: { amount: 1500, reason: 'New licence', setBy: MANAGER, setAt: '2026-05-01T00:00:00.000Z' }, history: [] } },
    });
    const f = await data<Figures>(await manager()('GET', '/prj_fin_fc'));
    expect(f.figures.forecast).toBe('1500.00');
    expect(f.figures.forecastSource).toBe('manual');
    expect(f.figures.variance).toBe('500.00');
    expect(f.figures.cpi).toBeNull();
  });

  it('answers 404 for a missing or deleted project, 403 for a non-member', async () => {
    await seedProject('prj_fin_gone', { deletedAt: new Date('2026-02-01T00:00:00.000Z') });
    await seedProject('prj_fin_priv');
    expect((await manager()('GET', '/prj_fin_missing')).status).toBe(404);
    expect((await manager()('GET', '/prj_fin_gone')).status).toBe(404);
    const denied = await as(OUTSIDER, READ)('GET', '/prj_fin_priv');
    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).message).toBe('You are not a member of this project');
  });

  it('needs projects:read', async () => {
    await seedProject('prj_fin_perm');
    expect((await as(MANAGER, [])('GET', '/prj_fin_perm')).status).toBe(403);
  });
});

// ── Cost lines ──────────────────────────────────────────────────────────────

type Line = { id: string; source: string; date: string; amount: string; committed: string; hours: number | null; people: number | null };

describe('GET /:projectId/costs', () => {
  it('lists the lines of every source, newest first, with time as one line per week', async () => {
    await seedProject('prj_fin_cost');
    await seedTime('prj_fin_cost', 'te_fc_1', null, '2026-05-04', '60', '50.00');
    await seedTime('prj_fin_cost', 'te_fc_2', null, '2026-05-05', '120', '100.00');
    await seedTime('prj_fin_cost', 'te_fc_3', null, '2026-05-12', '60', '10.00');
    await seedSources('prj_fin_cost', 'c');

    const res = await manager()('GET', '/prj_fin_cost/costs?limit=100');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Line[]; pagination: { totalCount: number; hasMore: boolean } };
    const time = body.data.filter((l) => l.source === 'time');
    expect(time.map((l) => [l.id, l.amount, l.hours, l.people])).toEqual([
      ['time:2026-W20', '10.00', 1, 1],
      ['time:2026-W19', '150.00', 3, 1],
    ]);
    expect(body.data.filter((l) => l.source === 'bill').map((l) => l.amount).sort()).toEqual(['-10.00', '100.00']);
    const po = body.data.filter((l) => l.source === 'purchase_order');
    expect(po.map((l) => [l.amount, l.committed]).sort()).toEqual([['40.00', '60.00'], ['50.00', '0.00']]);
    // Dates never increase down the list.
    const dates = body.data.map((l) => l.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('filters by source and date and pages with a cursor', async () => {
    await seedProject('prj_fin_page');
    await seedSources('prj_fin_page', 'd');

    const bills = (await (await manager()('GET', '/prj_fin_page/costs?source=bill')).json()) as { data: Line[] };
    expect(bills.data.every((l) => l.source === 'bill')).toBe(true);

    const none = (await (await manager()('GET', '/prj_fin_page/costs?from=2027-01-01')).json()) as { data: Line[] };
    expect(none.data).toEqual([]);

    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const res = await manager()('GET', `/prj_fin_page/costs?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const page = (await res.json()) as { data: Line[]; pagination: { hasMore: boolean; cursor: string | null; totalCount: number } };
      seen.push(...page.data.map((l) => l.id));
      if (!page.pagination.hasMore) break;
      cursor = page.pagination.cursor ?? '';
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(8);
  });

  it('is closed to a member without finance rights and rejects a bad query', async () => {
    await seedProject('prj_fin_cd');
    const denied = await member()('GET', '/prj_fin_cd/costs');
    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).message).toBe('You do not have access to the amounts of this project');
    const bad = await manager()('GET', '/prj_fin_cd/costs?source=cash');
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).message).toBe('Invalid query parameters');
  });
});

// ── Snapshots ───────────────────────────────────────────────────────────────

describe('GET /:projectId/snapshots', () => {
  it('lists the weekly points oldest first, and hides amounts from a member', async () => {
    await seedProject('prj_fin_snap');
    await db.insert(schema.projectFinanceSnapshots).values([
      { id: 'pfs_1', projectId: 'prj_fin_snap', week: '2026-W19', budget: '1000.00', plannedValue: '100.00', earnedValue: '80.00', actualCost: '90.00', committed: '0.00', forecast: '1100.00' },
      { id: 'pfs_2', projectId: 'prj_fin_snap', week: '2026-W18', budget: '1000.00', plannedValue: '50.00', earnedValue: '40.00', actualCost: '45.00', committed: '10.00', forecast: null },
    ]);
    const all = (await (await manager()('GET', '/prj_fin_snap/snapshots')).json()) as { data: Array<Record<string, unknown>> };
    expect(all.data.map((s) => s.week)).toEqual(['2026-W18', '2026-W19']);
    expect(all.data[1]).toMatchObject({ plannedValue: '100.00', percent: { spent: 9, earned: 8, forecast: 110 } });

    const hidden = (await (await member()('GET', '/prj_fin_snap/snapshots')).json()) as { data: Array<Record<string, unknown>> };
    expect(hidden.data[1]).toMatchObject({ plannedValue: null, actualCost: null, percent: { spent: 9 } });
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

describe('settings', () => {
  it('sets, keeps a history of and clears the manual forecast, leaving the other settings alone', async () => {
    await seedProject('prj_fin_set', { settings: { currentPhaseId: 'phase_1', sponsorId: 'user_sponsor' } });

    const set = await manager()('PUT', '/settings/prj_fin_set', { forecast: 1200, reason: 'Extra licence' });
    expect(set.status).toBe(200);
    const saved = await data<{ manualForecast: { amount: string; reason: string }; history: unknown[] }>(set);
    expect(saved.manualForecast).toMatchObject({ amount: '1200.00', reason: 'Extra licence' });
    expect(actions()).toEqual(['project.updated']);

    await manager()('PUT', '/settings/prj_fin_set', { forecast: 1300, reason: 'Scope grew' });
    const cleared = await data<{ manualForecast: unknown; history: Array<{ amount: string | null }> }>(
      await manager()('PUT', '/settings/prj_fin_set', { forecast: null }),
    );
    expect(cleared.manualForecast).toBeNull();
    expect(cleared.history.map((h) => h.amount)).toEqual([null, '1300.00', '1200.00']);

    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_fin_set'));
    expect(row.settings).toMatchObject({ currentPhaseId: 'phase_1', sponsorId: 'user_sponsor' });

    const read = await data<{ history: unknown[] }>(await manager()('GET', '/settings/prj_fin_set'));
    expect(read.history).toHaveLength(3);
  });

  it('checks permission, project, rights and body, in that order', async () => {
    await seedProject('prj_fin_chk');
    expect((await as(MANAGER, READ)('PUT', '/settings/prj_fin_chk', { forecast: 1, reason: 'x' })).status).toBe(403);
    expect((await manager()('PUT', '/settings/prj_fin_nope', { forecast: 1, reason: 'x' })).status).toBe(404);
    expect((await as(OUTSIDER)('PUT', '/settings/prj_fin_chk', { forecast: 1, reason: 'x' })).status).toBe(403);
    const notManager = await as(MEMBER)('PUT', '/settings/prj_fin_chk', { forecast: 1, reason: 'x' });
    expect(notManager.status).toBe(403);
    expect((await errorOf(notManager)).message).toBe('Only a project manager can change the forecast');
    const noReason = await manager()('PUT', '/settings/prj_fin_chk', { forecast: 5 });
    expect(noReason.status).toBe(400);
    expect((await errorOf(noReason)).message).toBe('Invalid request body');
    expect((await manager()('PUT', '/settings/prj_fin_chk', { forecast: -1, reason: 'x' })).status).toBe(400);
    expect(published).not.toHaveBeenCalled();
  });
});
