/**
 * DB-backed integration tests for accepting a risk (FLOW-016):
 * POST /api/project-raid/:id/request-acceptance and the sponsor's answer in
 * /api/approvals. A risk with strategy `accept` that scores 9 or more needs the
 * sponsor; accepting it moves the risk to `monitoring` and notes who accepted it.
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { approvalsRoutes } from '../approvals';
import { projectRaidRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/approvals', approvalsRoutes);
router.route('/project-raid', projectRaidRoutes);

const PM = 'user_acc_pm';
const SPONSOR = 'user_acc_sponsor';
const MEMBER = 'user_acc_member';
const VIEWER = 'user_acc_viewer';
const OUTSIDER = 'user_acc_outsider';
const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete', 'tasks:create'];
const READ = ['projects:read'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api', router, { context: { userId, permissions: permissions(...keys), tenantDb: db } });
  return (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const pm = () => as(PM);
const data = async <T = Record<string, unknown>>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

beforeEach(async () => {
  published.mockClear();
  // The sponsor is shared between tests: each starts with an empty inbox.
  await db.delete(schema.flowApprovals);
});

async function seedProject(id: string, settings: Record<string, unknown> | null = { sponsorId: SPONSOR }, manager: string | null = PM) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: `Project ${id}`, projectManagerId: manager, settings, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values(
    [
      [SPONSOR, 'viewer'],
      [MEMBER, 'member'],
      [VIEWER, 'viewer'],
    ].map(([userId, role]) => ({ id: `pm_${id}_${userId}`, projectId: id, userId: userId as string, role: role as string, isActive: true, createdAt: now, updatedAt: now, joinedAt: now })),
  );
}

type Item = { id: string; code: string; status: string; strategy: string | null; score: number | null; closedAt: string | null };

async function createRisk(projectId: string, extra: Record<string, unknown> = {}, who: Send = pm()): Promise<Item> {
  const res = await who('POST', '/project-raid', { kind: 'risk', projectId, title: 'Supplier delivers late', probability: 3, impact: 3, strategy: 'accept', ...extra });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Item>(res);
}

async function request(id: string, body: unknown = {}, who: Send = pm()) {
  return who('POST', `/project-raid/${id}/request-acceptance`, body);
}

async function approvalOf(id: string) {
  const rows = await db.select().from(schema.flowApprovals).where(and(eq(schema.flowApprovals.subjectType, 'risk_acceptance'), eq(schema.flowApprovals.subjectId, id)));
  return rows;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('POST /project-raid/:id/request-acceptance', () => {
  it('asks the sponsor, with the score and the reason, and tells them', async () => {
    await seedProject('prj_acc_ask');
    const risk = await createRisk('prj_acc_ask');
    published.mockClear();
    const res = await request(risk.id, { note: '  Cheaper than the fix  ' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const body = await data<{ item: Item; approvers: Array<{ approverId: string; roleLabel: string; decision: string; step: number }> }>(res);
    expect(body.item).toMatchObject({ id: risk.id, status: 'identified' });
    expect(body.approvers).toEqual([expect.objectContaining({ approverId: SPONSOR, roleLabel: 'Sponsor', decision: 'pending', step: 1 })]);
    expect(actions()).toEqual(['flow_approval.requested']);

    const [row] = await approvalOf(risk.id);
    expect(row).toMatchObject({ approverId: SPONSOR, projectId: 'prj_acc_ask', createdBy: PM, decision: 'pending' });
    expect(row?.rule).toEqual({ code: 'risk_acceptance', params: { score: 9, band: 'medium', strategy: 'accept', note: 'Cheaper than the fix' } });
    expect(row?.dueAt).not.toBeNull();

    await tick();
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, SPONSOR));
    expect(notes.filter((n) => n.entityId === row?.id).map((n) => [n.title, n.actionUrl])).toEqual([[`Review requested: ${risk.code} Supplier delivers late`, '/weldflow/reviews']]);
  });

  it('falls back to the project manager when no sponsor is set', async () => {
    await seedProject('prj_acc_pm', null);
    const risk = await createRisk('prj_acc_pm', { probability: 4, impact: 4 });
    const res = await request(risk.id, {}, as(MEMBER));
    expect(res.status).toBe(201);
    expect((await approvalOf(risk.id))[0]).toMatchObject({ approverId: PM });
  });

  it('refuses an item that is not a risk, a risk that does not accept, scores under 9, closed risks and a second request', async () => {
    await seedProject('prj_acc_rules');
    const assumption = await pm()('POST', '/project-raid', { kind: 'assumption', projectId: 'prj_acc_rules', title: 'Users have SSO' });
    const notRisk = await request((await data<Item>(assumption)).id);
    expect(notRisk.status).toBe(400);
    expect((await errorOf(notRisk)).message).toBe('Only a risk can be accepted');

    const mitigate = await createRisk('prj_acc_rules', { strategy: 'mitigate' });
    const strategy = await request(mitigate.id);
    expect(strategy.status).toBe(400);
    expect((await errorOf(strategy)).message).toBe('Set the strategy to accept before asking for acceptance');
    const noStrategy = await createRisk('prj_acc_rules', { strategy: null });
    expect((await request(noStrategy.id)).status).toBe(400);

    const low = await createRisk('prj_acc_rules', { probability: 2, impact: 4 });
    const below = await request(low.id);
    expect(below.status).toBe(400);
    expect((await errorOf(below)).message).toBe('Only a risk scoring 9 or more needs the sponsor to accept it');

    const closed = await createRisk('prj_acc_rules', { status: 'closed' });
    const closedRes = await request(closed.id);
    expect(closedRes.status).toBe(409);
    expect((await errorOf(closedRes)).message).toBe('This item is already closed');

    const open = await createRisk('prj_acc_rules');
    expect((await request(open.id)).status).toBe(201);
    const twice = await request(open.id);
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).message).toBe('Acceptance has already been requested for this risk');
  });

  it('refuses a viewer, an outsider, a missing item, a bad body and a project with nobody to ask', async () => {
    await seedProject('prj_acc_deny');
    const risk = await createRisk('prj_acc_deny');
    expect((await request(risk.id, {}, as(VIEWER))).status).toBe(403);
    expect((await request(risk.id, {}, as(OUTSIDER))).status).toBe(403);
    expect((await request(risk.id, {}, as(MEMBER, READ))).status).toBe(403);
    expect((await request('raid_missing')).status).toBe(404);
    const bad = await request(risk.id, { note: 'x', extra: true });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).message).toBe('Invalid request body');
    await seedProject('prj_acc_nobody', null, null);
    const orphan = await createRisk('prj_acc_nobody', {}, as(MEMBER));
    const none = await request(orphan.id, {}, as(MEMBER));
    expect(none.status).toBe(400);
    expect((await errorOf(none)).message).toBe('This project has no sponsor or project manager to accept the risk');
  });
});

describe('the sponsor answers', () => {
  it('moves the risk to monitoring and notes the acceptance when the sponsor approves', async () => {
    await seedProject('prj_acc_yes');
    const risk = await createRisk('prj_acc_yes');
    await request(risk.id);
    const [row] = await approvalOf(risk.id);
    published.mockClear();
    const res = await as(SPONSOR, READ)('POST', `/approvals/${row!.id}/decide`, { decision: 'approved' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await data(res)).toMatchObject({ outcome: 'approved', resolved: true });
    expect(actions()).toEqual(['flow_approval.decided', 'project_raid_item.updated']);

    const detail = await data<Item & { assessments: Array<{ note: string | null; assessedBy: string; probability: number; impact: number }> }>(await pm()('GET', `/project-raid/${risk.id}`));
    expect(detail).toMatchObject({ status: 'monitoring', closedAt: null });
    expect(detail.assessments[0]).toMatchObject({ note: 'Accepted by the sponsor', assessedBy: SPONSOR, probability: 3, impact: 3 });
    expect(detail.assessments).toHaveLength(2);
  });

  it('keeps the conditions in the note when the sponsor approves with conditions', async () => {
    await seedProject('prj_acc_cond');
    const risk = await createRisk('prj_acc_cond');
    await request(risk.id);
    const [row] = await approvalOf(risk.id);
    await as(SPONSOR, READ)('POST', `/approvals/${row!.id}/decide`, { decision: 'approved_with_conditions', note: 'Review again in March' });
    const detail = await data<{ status: string; assessments: Array<{ note: string | null }> }>(await pm()('GET', `/project-raid/${risk.id}`));
    expect(detail.status).toBe('monitoring');
    expect(detail.assessments[0]?.note).toBe('Accepted by the sponsor with conditions: Review again in March');
  });

  it('leaves the risk as it was when the sponsor declines, and lets it be asked again', async () => {
    await seedProject('prj_acc_no');
    const risk = await createRisk('prj_acc_no');
    await request(risk.id);
    const [row] = await approvalOf(risk.id);
    const noNote = await as(SPONSOR, READ)('POST', `/approvals/${row!.id}/decide`, { decision: 'rejected' });
    expect(noNote.status).toBe(400);
    published.mockClear();
    const res = await as(SPONSOR, READ)('POST', `/approvals/${row!.id}/decide`, { decision: 'rejected', note: 'Mitigate it' });
    expect(await data(res)).toMatchObject({ outcome: 'rejected', resolved: true });
    expect(actions()).toEqual(['flow_approval.decided']);
    const detail = await data<{ status: string; assessments: unknown[] }>(await pm()('GET', `/project-raid/${risk.id}`));
    expect(detail).toMatchObject({ status: 'identified' });
    expect(detail.assessments).toHaveLength(1);

    published.mockClear();
    const again = await request(risk.id, { note: 'Second try' });
    expect(again.status).toBe(201);
    expect(actions()).toEqual(['flow_approval.cancelled', 'flow_approval.requested']);
    expect((await approvalOf(risk.id)).filter((r) => r.deletedAt === null)).toHaveLength(1);
  });

  it('shows the request in the sponsor inbox with the score and the risk figures', async () => {
    await seedProject('prj_acc_inbox');
    const risk = await createRisk('prj_acc_inbox', { probability: 4, impact: 4, costImpact: 2500, scheduleImpactDays: 6, description: 'May slip' });
    await request(risk.id, { note: 'Accept it' });
    const mine = await data<{ total: number; groups: { later: Array<Record<string, unknown>>; this_week: Array<Record<string, unknown>>; overdue: Array<Record<string, unknown>> } }>(
      await as(SPONSOR, READ)('GET', '/approvals/mine'),
    );
    const [review] = [...mine.groups.overdue, ...mine.groups.this_week, ...mine.groups.later];
    expect(mine.total).toBe(1);
    expect(review).toMatchObject({
      type: 'risk_acceptance',
      subjectId: risk.id,
      code: risk.code,
      title: 'Supplier delivers late',
      summary: 'May slip',
      roleLabel: 'Sponsor',
      rule: { code: 'risk_acceptance', params: { score: 16, band: 'high', strategy: 'accept', note: 'Accept it' } },
      impacts: [
        { kind: 'cost', value: '2500.00', currency: null },
        { kind: 'schedule_days', value: 6 },
        { kind: 'risk_score', value: 16 },
      ],
    });
  });
});

describe('a risk that goes away takes its open acceptance request with it', () => {
  it('closes the request, and tells the sponsor, when the risk is deleted', async () => {
    await seedProject('prj_acc_del');
    const risk = await createRisk('prj_acc_del');
    await request(risk.id);
    expect((await approvalOf(risk.id)).filter((r) => r.deletedAt === null)).toHaveLength(1);
    published.mockClear();
    expect((await pm()('DELETE', `/project-raid/${risk.id}`)).status).toBe(204);
    expect(actions()).toContain('flow_approval.cancelled');
    expect((await approvalOf(risk.id)).filter((r) => r.deletedAt === null)).toHaveLength(0);
    const inbox = await data<{ total: number }>(await as(SPONSOR, READ)('GET', '/approvals/mine'));
    expect(inbox.total).toBe(0);
  });

  it('closes the request when the risk is converted to an issue', async () => {
    await seedProject('prj_acc_conv');
    const risk = await createRisk('prj_acc_conv');
    await request(risk.id);
    published.mockClear();
    const res = await pm()('POST', `/project-raid/${risk.id}/convert`, { to: 'issue', title: 'Supplier is late' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(actions()).toContain('flow_approval.cancelled');
    expect((await approvalOf(risk.id)).filter((r) => r.deletedAt === null)).toHaveLength(0);
    expect((await data<{ total: number }>(await as(SPONSOR, READ)('GET', '/approvals/mine'))).total).toBe(0);
  });
});
