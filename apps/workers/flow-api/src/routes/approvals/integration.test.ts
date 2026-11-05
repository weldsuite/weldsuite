/**
 * DB-backed integration tests for the approvals inbox: /api/approvals (My
 * reviews, the count badge, Sent by me, Done, answering, delegation, the
 * sponsor setting and the pending time entries). Change requests and accepting
 * a risk are the subjects that put reviews in the inbox; steps are exercised
 * with a close-project request. Runs against the TypeScript worker and, in
 * conformance mode, the Rust backend (rust/conformance/suites.json).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { requestApprovals } from '@weldsuite/flow-domain/approvals';
import type { Env, Variables } from '../../types';
import { projectChangesRoutes } from '../project-changes';
import { projectRaidRoutes } from '../project-raid';
import { approvalsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/approvals', approvalsRoutes);
router.route('/project-changes', projectChangesRoutes);
router.route('/project-raid', projectRaidRoutes);

const PM = 'user_apr_pm';
const SPONSOR = 'user_apr_sponsor';
const MEMBER = 'user_apr_member';
const AWAY = 'user_apr_away';
const COVER = 'user_apr_cover';
const OUTSIDER = 'user_apr_outsider';

const READ = ['projects:read'];
const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete', 'time:update'];
const DAY = 86_400_000;

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

beforeEach(async () => {
  published.mockClear();
  // Each test starts with an empty inbox: the users are shared, the projects are not.
  await db.delete(schema.flowApprovals);
  await db.delete(schema.flowApprovalDelegations);
  await db.delete(schema.timeEntries);
});

async function seedProject(id: string, settings: Record<string, unknown> | null = null) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: `Project ${id}`, projectManagerId: PM, budgetedAmount: '12000.00', budgetCurrency: 'EUR', settings, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values(
    [
      [SPONSOR, 'viewer'],
      [MEMBER, 'member'],
      // The delegate of the delegation tests: answering is the row's right, but it needs the project.
      [COVER, 'viewer'],
    ].map(([userId, role]) => ({ id: `pm_${id}_${userId}`, projectId: id, userId: userId as string, role: role as string, isActive: true, createdAt: now, updatedAt: now, joinedAt: now })),
  );
}

type Review = {
  id: string;
  source: string;
  type: string;
  subjectId: string;
  projectId: string | null;
  projectName: string | null;
  code: string | null;
  title: string;
  summary: string | null;
  requestedBy: string | null;
  dueAt: string | null;
  bucket: string;
  decision: string;
  step: number;
  roleLabel: string | null;
  rule: { code: string; params?: Record<string, unknown> } | null;
  viaDelegation: boolean;
  delegatedFrom: string | null;
  actionable: boolean;
  approvers: Array<{ approverId: string; decision: string; step: number }>;
  impacts: Array<{ kind: string; value: string | number | null; currency?: string | null }>;
  links: Array<{ type: string; title: string; relation: string }>;
};

type Mine = { total: number; counts: Record<string, number>; groups: { overdue: Review[]; this_week: Review[]; later: Review[] } };

async function mine(who: Send, query = ''): Promise<Mine> {
  const res = await who('GET', `/approvals/mine${query}`);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return data<Mine>(res);
}

const all = (m: Mine) => [...m.groups.overdue, ...m.groups.this_week, ...m.groups.later];

async function createAndSubmit(projectId: string, extra: Record<string, unknown> = {}, who: Send = as(MEMBER, FULL)) {
  const created = await who('POST', '/project-changes', { projectId, title: 'Move the beta', costDelta: 4000, scheduleDeltaDays: 2, ...extra });
  expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
  const change = await data<{ id: string; code: string }>(created);
  const submitted = await who('POST', `/project-changes/${change.id}/submit`);
  expect(submitted.status, JSON.stringify(await submitted.clone().json())).toBe(200);
  const body = await data<{ approvers: Array<{ approvalId: string; approverId: string }> }>(submitted);
  return { change, approvalId: body.approvers[0]!.approvalId };
}

/** Put a review's due date where a test wants it (the routes set their own). */
async function dueAt(approvalId: string, at: Date | null) {
  await db.update(schema.flowApprovals).set({ dueAt: at }).where(eq(schema.flowApprovals.id, approvalId));
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

// ── My reviews ──────────────────────────────────────────────────────────────

describe('GET /approvals/mine', () => {
  it('lists the caller reviews with why they were asked, the figures and the project', async () => {
    await seedProject('prj_apr_mine');
    await db.insert(schema.milestones).values({ id: 'ms_apr_mine', projectId: 'prj_apr_mine', name: 'Beta release', dueDate: new Date('2026-11-20T00:00:00.000Z'), createdAt: new Date(), updatedAt: new Date() });
    const { change } = await createAndSubmit('prj_apr_mine', {
      description: 'The supplier is late',
      planChanges: { milestones: [{ milestoneId: 'ms_apr_mine', to: '2026-11-28T00:00:00.000Z' }] },
    });
    const result = await mine(pm());
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ change_request: 1, timesheet: 0 });
    const [review] = all(result);
    expect(review).toMatchObject({
      source: 'approval',
      type: 'change_request',
      subjectId: change.id,
      projectId: 'prj_apr_mine',
      projectName: 'Project prj_apr_mine',
      code: change.code,
      title: 'Move the beta',
      summary: 'The supplier is late',
      requestedBy: MEMBER,
      decision: 'pending',
      step: 1,
      roleLabel: 'Project manager',
      viaDelegation: false,
      actionable: true,
      rule: { code: 'change_manager' },
    });
    expect(review?.rule?.params).toMatchObject({ costDelta: 4000, costLimit: 5000, scheduleDeltaDays: 2, scheduleLimitDays: 5, overLimit: false });
    expect(review?.impacts).toEqual([
      { kind: 'cost', value: '4000.00', currency: 'EUR' },
      { kind: 'schedule_days', value: 2 },
    ]);
    expect(review?.links).toEqual([{ type: 'milestone', id: 'ms_apr_mine', title: 'Beta release', code: null, relation: 'moves' }]);
    expect(review?.approvers).toEqual([expect.objectContaining({ approverId: PM, decision: 'pending', step: 1 })]);
    // Somebody who was not asked has an empty inbox.
    expect((await mine(as(MEMBER))).total).toBe(0);
  });

  it('groups by due date: overdue, this week, later, and orders each by due date', async () => {
    await seedProject('prj_apr_buckets');
    const a = await createAndSubmit('prj_apr_buckets', { title: 'Late one' });
    const b = await createAndSubmit('prj_apr_buckets', { title: 'Soon' });
    const c = await createAndSubmit('prj_apr_buckets', { title: 'Far away' });
    const d = await createAndSubmit('prj_apr_buckets', { title: 'No date' });
    const now = Date.now();
    await dueAt(a.approvalId, new Date(now - 2 * DAY));
    await dueAt(b.approvalId, new Date(now + 60_000));
    await dueAt(c.approvalId, new Date(now + 40 * DAY));
    await dueAt(d.approvalId, null);
    const result = await mine(pm(), '?projectId=prj_apr_buckets');
    expect(result.groups.overdue.map((r) => r.title)).toEqual(['Late one']);
    expect(result.groups.this_week.map((r) => r.title)).toEqual(['Soon']);
    expect(result.groups.later.map((r) => r.title)).toEqual(['Far away', 'No date']);
    expect(result.total).toBe(4);
  });

  it('filters by type and counts every type whatever the filter', async () => {
    await seedProject('prj_apr_type');
    await createAndSubmit('prj_apr_type');
    await db.insert(schema.timeEntries).values({ id: 'te_apr_type', projectId: 'prj_apr_type', userId: MEMBER, date: '2026-11-02', duration: '90.00', status: 'draft', description: 'Fix login', createdAt: new Date(), updatedAt: new Date() });
    const unfiltered = await mine(pm());
    expect(unfiltered.counts).toEqual({ change_request: 1, timesheet: 1 });
    expect(unfiltered.total).toBe(2);
    const changes = await mine(pm(), '?type=change_request');
    expect(all(changes).map((r) => r.type)).toEqual(['change_request']);
    expect(changes.counts).toEqual({ change_request: 1, timesheet: 1 });
    const sheets = await mine(pm(), '?type=timesheet');
    expect(all(sheets).map((r) => r.type)).toEqual(['timesheet']);
    const bad = await pm()('GET', '/approvals/mine?type=bogus');
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).message).toBe('Invalid query parameters');
    expect((await as(OUTSIDER, [])('GET', '/approvals/mine')).status).toBe(403);
  });

  it('lists a pending time entry on a project the caller manages, never their own, never one already answered', async () => {
    await seedProject('prj_apr_time');
    await seedProject('prj_apr_time_other');
    await db.update(schema.projects).set({ projectManagerId: SPONSOR }).where(eq(schema.projects.id, 'prj_apr_time_other'));
    const entry = (id: string, projectId: string, userId: string, status = 'draft') => ({
      id,
      projectId,
      userId,
      date: '2026-11-02',
      duration: '90.00',
      status,
      description: id === 'te_apr_time_1' ? 'Fix login' : null,
      activity: 'Support',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.timeEntries).values([
      entry('te_apr_time_1', 'prj_apr_time', MEMBER),
      entry('te_apr_time_own', 'prj_apr_time', PM),
      entry('te_apr_time_done', 'prj_apr_time', MEMBER, 'approved'),
      entry('te_apr_time_other', 'prj_apr_time_other', MEMBER),
    ]);
    const result = await mine(pm(), '?type=timesheet');
    expect(all(result).map((r) => r.id)).toEqual(['te_apr_time_1']);
    const [item] = all(result);
    expect(item).toMatchObject({
      source: 'timesheet',
      subjectId: 'te_apr_time_1',
      projectName: 'Project prj_apr_time',
      title: 'Fix login',
      summary: '2026-11-02 · 1.5h',
      requestedBy: MEMBER,
      rule: null,
      approvers: [],
      actionable: true,
    });
    expect(item?.impacts).toEqual([{ kind: 'hours', value: 1.5 }]);
    // Without time:update the entries are not offered.
    expect((await mine(as(PM, READ))).counts.timesheet).toBeUndefined();
  });

  it('holds a later step back until the earlier one is approved', async () => {
    await seedProject('prj_apr_steps');
    const first = await requestApprovals(db, {
      projectId: 'prj_apr_steps',
      subjectType: 'project_close',
      subjectId: 'prj_apr_steps',
      requestedBy: MEMBER,
      rows: [
        { approverId: SPONSOR, step: 1, rule: { code: 'close' } },
        { approverId: PM, step: 2, rule: { code: 'close' } },
      ],
    });
    expect(first.ok).toBe(true);
    expect((await mine(pm())).total).toBe(0);
    const sponsor = await mine(as(SPONSOR, READ));
    expect(all(sponsor).map((r) => [r.type, r.title, r.step])).toEqual([['project_close', 'Project prj_apr_steps', 1]]);
    expect(all(sponsor)[0]?.approvers.map((a) => [a.approverId, a.step])).toEqual([[SPONSOR, 1], [PM, 2]]);
    const early = await as(PM, READ)('POST', `/approvals/${first.ok ? first.rows[1]!.id : ''}/decide`, { decision: 'approved' });
    expect(early.status).toBe(409);
    expect((await errorOf(early)).message).toBe('This review is waiting for an earlier step to be answered');
    expect((await as(SPONSOR, READ)('POST', `/approvals/${first.ok ? first.rows[0]!.id : ''}/decide`, { decision: 'approved' })).status).toBe(200);
    expect(all(await mine(pm())).map((r) => r.step)).toEqual([2]);
  });
});

describe('GET /approvals/mine/count', () => {
  it('counts the reviews waiting and the overdue ones, with the time entries', async () => {
    await seedProject('prj_apr_count');
    const a = await createAndSubmit('prj_apr_count', { title: 'One' });
    await createAndSubmit('prj_apr_count', { title: 'Two' });
    await dueAt(a.approvalId, new Date(Date.now() - DAY));
    await db.insert(schema.timeEntries).values({ id: 'te_apr_count', projectId: 'prj_apr_count', userId: MEMBER, date: '2026-11-02', duration: '30.00', status: 'draft', createdAt: new Date(), updatedAt: new Date() });
    const res = await pm()('GET', '/approvals/mine/count');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ count: 3, overdue: 1 });
    expect(await data(await as(PM, READ)('GET', '/approvals/mine/count'))).toEqual({ count: 2, overdue: 1 });
    expect(await data(await as(OUTSIDER)('GET', '/approvals/mine/count'))).toEqual({ count: 0, overdue: 0 });
  });
});

// ── Sent by me and Done ─────────────────────────────────────────────────────

describe('GET /approvals/sent and /done', () => {
  it('shows what the caller asked for while it waits, and what they answered', async () => {
    await seedProject('prj_apr_sent');
    const first = await createAndSubmit('prj_apr_sent', { title: 'First' });
    const second = await createAndSubmit('prj_apr_sent', { title: 'Second' });
    const sent = (await (await as(MEMBER)('GET', '/approvals/sent')).json()) as { data: Array<{ type: string; subjectId: string; title: string; outcome: string; approvers: Array<{ approverId: string; decision: string }> }>; pagination: { totalCount: number } };
    expect(sent.data.map((s) => s.title)).toEqual(['Second', 'First']);
    expect(sent.data[0]).toMatchObject({ type: 'change_request', outcome: 'pending', approvers: [{ approverId: PM, decision: 'pending' }] });
    expect(sent.pagination.totalCount).toBe(2);
    const paged = (await (await as(MEMBER)('GET', '/approvals/sent?limit=1')).json()) as { data: Array<{ title: string }>; pagination: { hasMore: boolean; cursor: string } };
    expect(paged.data.map((s) => s.title)).toEqual(['Second']);
    expect(paged.pagination.hasMore).toBe(true);
    const next = (await (await as(MEMBER)('GET', `/approvals/sent?limit=1&cursor=${paged.pagination.cursor}`)).json()) as { data: Array<{ title: string }> };
    expect(next.data.map((s) => s.title)).toEqual(['First']);
    expect(((await (await pm()('GET', '/approvals/sent')).json()) as { data: unknown[] }).data).toEqual([]);

    expect((await pm()('POST', `/approvals/${first.approvalId}/decide`, { decision: 'approved' })).status).toBe(200);
    const stillSent = (await (await as(MEMBER)('GET', '/approvals/sent')).json()) as { data: Array<{ title: string }> };
    expect(stillSent.data.map((s) => s.title)).toEqual(['Second']);
    const done = (await (await pm()('GET', '/approvals/done')).json()) as { data: Review[]; pagination: { totalCount: number } };
    expect(done.data.map((r) => [r.title, r.decision])).toEqual([['First', 'approved']]);
    expect(done.pagination.totalCount).toBe(1);
    expect(second.approvalId).toBeTruthy();
    expect(((await (await as(MEMBER)('GET', '/approvals/done')).json()) as { data: unknown[] }).data).toEqual([]);
  });
});

// ── Answering ───────────────────────────────────────────────────────────────

describe('POST /approvals/:id/decide', () => {
  it('stores the answer with its note, publishes decided and answers the outcome', async () => {
    await seedProject('prj_apr_dec');
    const { approvalId } = await createAndSubmit('prj_apr_dec');
    published.mockClear();
    const res = await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'approved_with_conditions', note: '  After the audit  ' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      approval: { approvalId, approverId: PM, decision: 'approved_with_conditions', note: 'After the audit', subjectType: 'change_request', projectId: 'prj_apr_dec' },
      outcome: 'approved',
      resolved: true,
      viaDelegation: false,
    });
    expect(actions().slice(0, 2)).toEqual(['flow_approval.decided', 'project_change_request.approved']);
    expect(published.mock.calls[0]?.[0].data).toMatchObject({ id: approvalId, decision: 'approved_with_conditions', outcome: 'approved', resolved: true });
    expect(JSON.stringify(published.mock.calls[0]?.[0].data)).not.toContain('After the audit');
  });

  it('refuses a bad body, an unknown review, a stranger, a missing note and a second answer', async () => {
    await seedProject('prj_apr_err');
    const { approvalId } = await createAndSubmit('prj_apr_err');
    const bad = await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'pending' });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).message).toBe('Invalid request body');
    expect((await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'approved', extra: 1 })).status).toBe(400);
    const missing = await pm()('POST', '/approvals/apr_missing/decide', { decision: 'approved' });
    expect(missing.status).toBe(404);
    const stranger = await as(MEMBER, READ)('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(stranger.status).toBe(403);
    expect((await errorOf(stranger)).message).toBe('You are not an approver of this review');
    const note = await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'approved_with_conditions' });
    expect(note.status).toBe(400);
    expect((await errorOf(note)).message).toBe('A note is required to decline or to set conditions');
    expect((await as(OUTSIDER, [])('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' })).status).toBe(403);
    expect((await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'rejected', note: 'No' })).status).toBe(200);
    const again = await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This review has already been answered');
  });

  it('approves a pending time entry with the rules of the time entry approval, and declines it with a note', async () => {
    await seedProject('prj_apr_te');
    const make = (id: string, userId: string) => ({ id, projectId: 'prj_apr_te', userId, date: '2026-11-02', duration: '60.00', status: 'draft', createdAt: new Date(), updatedAt: new Date() });
    await db.insert(schema.timeEntries).values([make('te_apr_ok', MEMBER), make('te_apr_no', MEMBER), make('te_apr_own', PM)]);
    published.mockClear();
    const ok = await pm()('POST', '/approvals/te_apr_ok/decide', { decision: 'approved' });
    expect(ok.status).toBe(200);
    expect(await data(ok)).toMatchObject({ approval: { approvalId: 'te_apr_ok', decision: 'approved', subjectType: 'timesheet', projectId: 'prj_apr_te' }, outcome: 'approved', resolved: true });
    const [row] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, 'te_apr_ok'));
    expect(row).toMatchObject({ status: 'approved', approvedBy: PM });
    expect(actions()).toEqual(['project_time_entry.updated', 'project_timesheet.approved']);

    const noNote = await pm()('POST', '/approvals/te_apr_no/decide', { decision: 'rejected' });
    expect(noNote.status).toBe(400);
    expect((await errorOf(noNote)).message).toBe('A note is required to decline or to set conditions');
    expect((await pm()('POST', '/approvals/te_apr_no/decide', { decision: 'rejected', note: 'Wrong day' })).status).toBe(200);
    expect((await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, 'te_apr_no')))[0]?.status).toBe('rejected');

    const conditions = await pm()('POST', '/approvals/te_apr_own/decide', { decision: 'approved_with_conditions', note: 'x' });
    expect(conditions.status).toBe(403); // not their own entry, whatever the answer
    expect((await errorOf(conditions)).message).toBe('You cannot approve or reject your own time entry');
    const again = await pm()('POST', '/approvals/te_apr_ok/decide', { decision: 'approved' });
    expect(again.status).toBe(409);
    expect((await as(PM, READ)('POST', '/approvals/te_apr_own/decide', { decision: 'approved' })).status).toBe(403);
    expect((await as(MEMBER)('POST', '/approvals/te_apr_own/decide', { decision: 'approved' })).status).toBe(403);
  });
});

// ── Delegation ──────────────────────────────────────────────────────────────

describe('delegations', () => {
  const when = (fromDays: number, toDays: number) => ({
    startsAt: new Date(Date.now() + fromDays * DAY).toISOString(),
    endsAt: new Date(Date.now() + toDays * DAY).toISOString(),
  });

  it('lets a delegate see and answer the reviews of the member who is away', async () => {
    await seedProject('prj_apr_dlg');
    const { approvalId } = await createAndSubmit('prj_apr_dlg');
    published.mockClear();
    // PM hands their reviews to COVER from yesterday for a week.
    const created = await pm()('POST', '/approvals/delegations', { delegateId: COVER, ...when(-1, 7) });
    expect(created.status).toBe(201);
    const delegation = await data<{ id: string; memberId: string; delegateId: string }>(created);
    expect(delegation).toMatchObject({ memberId: PM, delegateId: COVER });
    expect(actions()).toEqual(['flow_approval.delegated']);

    const cover = await mine(as(COVER, READ));
    expect(all(cover).map((r) => [r.id, r.viaDelegation])).toEqual([[approvalId, true]]);
    expect(await data(await as(COVER, READ)('GET', '/approvals/mine/count'))).toEqual({ count: 1, overdue: 0 });
    const res = await as(COVER, READ)('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ viaDelegation: true, outcome: 'approved' });
    const done = (await (await as(COVER, READ)('GET', '/approvals/done')).json()) as { data: Review[] };
    expect(done.data.map((r) => r.id)).toEqual([approvalId]);
  });

  it('refuses a delegate who is not a member of the project, and keeps its reviews out of their lists', async () => {
    await seedProject('prj_apr_dlg_out');
    const { approvalId } = await createAndSubmit('prj_apr_dlg_out');
    expect((await pm()('POST', '/approvals/delegations', { delegateId: AWAY, ...when(-1, 7) })).status).toBe(201);
    const stranger = as(AWAY, READ);
    expect((await mine(stranger)).total).toBe(0);
    expect(await data(await stranger('GET', '/approvals/mine/count'))).toEqual({ count: 0, overdue: 0 });
    const res = await stranger('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe('You are not a member of this project');
    const [row] = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.id, approvalId));
    expect(row?.decision).toBe('pending');
    const [change] = await db.select().from(schema.projectChangeRequests).where(eq(schema.projectChangeRequests.projectId, 'prj_apr_dlg_out'));
    expect(change?.status).toBe('awaiting_approval');
  });

  it('hides the reviews of a project the caller left from My reviews, the badge and Done', async () => {
    await seedProject('prj_apr_left');
    const { approvalId } = await createAndSubmit('prj_apr_left');
    await pm()('POST', '/approvals/delegations', { delegateId: COVER, ...when(-1, 7) });
    const cover = as(COVER, READ);
    const leave = (isActive: boolean) =>
      db.update(schema.projectMembers).set({ isActive }).where(eq(schema.projectMembers.id, `pm_prj_apr_left_${COVER}`));
    await leave(false);
    expect((await mine(cover)).total).toBe(0);
    expect(await data(await cover('GET', '/approvals/mine/count'))).toEqual({ count: 0, overdue: 0 });
    await leave(true);
    expect((await mine(cover)).total).toBe(1);
    expect((await cover('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' })).status).toBe(200);
    await leave(false);
    expect(((await (await cover('GET', '/approvals/done')).json()) as { data: Review[] }).data).toEqual([]);
    await leave(true);
    expect(((await (await cover('GET', '/approvals/done')).json()) as { data: Review[] }).data.map((r) => r.id)).toEqual([approvalId]);
  });

  it('keeps a review asked of the delegate with the member after the delegation ended', async () => {
    await seedProject('prj_apr_dlg_end');
    const active = await data<{ id: string }>(await pm()('POST', '/approvals/delegations', { delegateId: COVER, ...when(-1, 7) }));
    const { approvalId } = await createAndSubmit('prj_apr_dlg_end');
    expect((await pm()('DELETE', `/approvals/delegations/${active.id}`)).status).toBe(204);
    const [row] = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.id, approvalId));
    expect(row).toMatchObject({ approverId: COVER, delegatedFrom: PM });
    // The member sees it again, as their own, and the badge counts it.
    expect(all(await mine(pm())).map((r) => [r.id, r.viaDelegation, r.delegatedFrom])).toEqual([[approvalId, false, PM]]);
    expect(await data(await pm()('GET', '/approvals/mine/count'))).toEqual({ count: 1, overdue: 0 });
    const res = await pm()('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ viaDelegation: false, outcome: 'approved' });
  });

  it('asks the delegate instead for reviews requested while the member is away', async () => {
    await seedProject('prj_apr_dlg2');
    await as(PM)('POST', '/approvals/delegations', { delegateId: COVER, ...when(-1, 7) });
    const { approvalId } = await createAndSubmit('prj_apr_dlg2');
    const [row] = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.id, approvalId));
    expect(row).toMatchObject({ approverId: COVER, delegatedFrom: PM });
    expect(all(await mine(as(COVER, READ))).map((r) => [r.id, r.delegatedFrom])).toEqual([[approvalId, PM]]);
    // The member who handed it over still has it, as their own: it stays theirs when the delegation ends.
    expect(all(await mine(pm())).map((r) => [r.id, r.viaDelegation, r.delegatedFrom])).toEqual([[approvalId, false, PM]]);
  });

  it('does not delegate before it starts or after it ends, and ending it takes the delegate out again', async () => {
    await seedProject('prj_apr_dlg3');
    const { approvalId } = await createAndSubmit('prj_apr_dlg3');
    const future = await as(PM)('POST', '/approvals/delegations', { delegateId: AWAY, ...when(2, 4) });
    expect((await mine(as(AWAY, READ))).total).toBe(0);
    const active = await data<{ id: string }>(await as(PM)('POST', '/approvals/delegations', { delegateId: COVER, ...when(-1, 3) }));
    expect((await mine(as(COVER, READ))).total).toBe(1);
    published.mockClear();
    expect((await pm()('DELETE', `/approvals/delegations/${active.id}`)).status).toBe(204);
    expect(actions()).toEqual(['flow_approval.delegated']);
    expect((await mine(as(COVER, READ))).total).toBe(0);
    const refused = await as(COVER, READ)('POST', `/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(refused.status).toBe(403);
    expect(future.status).toBe(201);
  });

  it('lists the delegations that have not ended, given and received', async () => {
    const user = 'user_apr_lister';
    await as(user, READ)('POST', '/approvals/delegations', { delegateId: COVER, ...when(1, 3) });
    await as(user, READ)('POST', '/approvals/delegations', { delegateId: COVER, ...when(-9, -2) }).catch(() => undefined);
    await as(COVER, READ)('POST', '/approvals/delegations', { delegateId: user, ...when(0, 2) });
    const mineRes = await data<{ given: Array<{ delegateId: string }>; received: Array<{ memberId: string }> }>(await as(user, READ)('GET', '/approvals/delegations'));
    expect(mineRes.given.map((d) => d.delegateId)).toEqual([COVER]);
    expect(mineRes.received.map((d) => d.memberId)).toEqual([COVER]);
  });

  it('refuses a delegation to oneself, a backwards or a finished period and a stranger delegation to end', async () => {
    const self = await pm()('POST', '/approvals/delegations', { delegateId: PM, ...when(0, 2) });
    expect(self.status).toBe(400);
    expect((await errorOf(self)).message).toBe('You cannot delegate your reviews to yourself');
    const backwards = await pm()('POST', '/approvals/delegations', { delegateId: COVER, ...when(2, 1) });
    expect((await errorOf(backwards)).message).toBe('The end of the delegation must be after its start');
    const ended = await pm()('POST', '/approvals/delegations', { delegateId: COVER, ...when(-3, -1) });
    expect((await errorOf(ended)).message).toBe('The delegation has already ended');
    expect((await pm()('POST', '/approvals/delegations', { delegateId: COVER })).status).toBe(400);
    const theirs = await data<{ id: string }>(await as(AWAY)('POST', '/approvals/delegations', { delegateId: COVER, ...when(0, 2) }));
    expect((await pm()('DELETE', `/approvals/delegations/${theirs.id}`)).status).toBe(404);
    expect((await pm()('DELETE', '/approvals/delegations/apd_missing')).status).toBe(404);
  });
});

// ── Sponsor ─────────────────────────────────────────────────────────────────

describe('PUT /approvals/projects/:projectId/sponsor', () => {
  it('sets the sponsor by a merge write that keeps the other settings, and clears it with null', async () => {
    await seedProject('prj_apr_sp', { changeControl: { costLimit: 1, scheduleLimitDays: 1, boardMemberIds: [] } });
    const res = await pm()('PUT', '/approvals/projects/prj_apr_sp/sponsor', { sponsorId: SPONSOR });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ projectId: 'prj_apr_sp', sponsorId: SPONSOR });
    const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, 'prj_apr_sp'));
    expect(row?.settings).toMatchObject({ sponsorId: SPONSOR, changeControl: { costLimit: 1 } });
    expect(actions()).toEqual(['project.updated']);
    expect(await data(await pm()('PUT', '/approvals/projects/prj_apr_sp/sponsor', { sponsorId: null }))).toEqual({ projectId: 'prj_apr_sp', sponsorId: null });
    const [cleared] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, 'prj_apr_sp'));
    expect(cleared?.settings).toMatchObject({ sponsorId: null, changeControl: { costLimit: 1 } });
  });

  it('refuses a member, an outsider, a sponsor from outside the project, a bad body and an unknown project', async () => {
    await seedProject('prj_apr_sp2');
    expect((await as(MEMBER)('PUT', '/approvals/projects/prj_apr_sp2/sponsor', { sponsorId: SPONSOR })).status).toBe(403);
    expect((await as(OUTSIDER)('PUT', '/approvals/projects/prj_apr_sp2/sponsor', { sponsorId: SPONSOR })).status).toBe(403);
    expect((await as(PM, READ)('PUT', '/approvals/projects/prj_apr_sp2/sponsor', { sponsorId: SPONSOR })).status).toBe(403);
    const outside = await pm()('PUT', '/approvals/projects/prj_apr_sp2/sponsor', { sponsorId: OUTSIDER });
    expect(outside.status).toBe(400);
    expect((await errorOf(outside)).message).toBe('The sponsor must be a member of this project');
    expect((await pm()('PUT', '/approvals/projects/prj_apr_sp2/sponsor', {})).status).toBe(400);
    expect((await pm()('PUT', '/approvals/projects/prj_apr_nope/sponsor', { sponsorId: SPONSOR })).status).toBe(404);
  });
});
