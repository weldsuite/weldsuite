/**
 * What approving a gate does: the `gate` subject handler of the approvals core
 * (services/project-phases.ts). TypeScript only: the approvals routes are
 * another slice's, and this is the handler they run when the last answer comes
 * in, driven here through `decideApproval` as they drive it.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { decideApproval, getApprovalSubjectHandler } from '@weldsuite/flow-domain/approvals';
import { projectPhasesRoutes } from '../routes/project-phases';
import { publishGateResolution, resolveGate } from './project-phases';

// A plain spy: the events are asserted here, not sent (this file has no request context to send them with).
vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

const MANAGER = 'user_gr_manager';
const SPONSOR = 'user_gr_sponsor';
const BOARD = 'user_gr_board';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));

beforeEach(() => {
  published.mockClear();
});

const context = {} as Context;

function as(userId: string) {
  const { request } = createTestApp('/api/project-phases', projectPhasesRoutes, {
    context: { userId, permissions: permissions('projects:read', 'projects:create', 'projects:update', 'projects:delete'), tenantDb: db },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/project-phases${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function seedGate(projectId: string, phaseNames = ['Build', 'Accept']) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({
    id: projectId,
    name: projectId,
    projectManagerId: MANAGER,
    settings: { sponsorId: SPONSOR, changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: [BOARD] } },
    createdAt: now,
    updatedAt: now,
  });
  const ids: string[] = [];
  for (const name of phaseNames) {
    const res = await as(MANAGER)('POST', '', { projectId, name, gateCriteria: name === 'Build' ? [{ key: 'no_change_request_pending' }, { manual: 'Plan approved' }] : [] });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { data: { id: string } }).data.id);
  }
  await as(MANAGER)('PATCH', `/${ids[0]}/criteria/1`, { met: true });
  expect((await as(MANAGER)('POST', `/${ids[0]}/request-approval`)).status).toBe(201);
  published.mockClear();
  return ids;
}

const phaseRow = async (id: string) => (await db.select().from(schema.projectPhases).where(eq(schema.projectPhases.id, id)))[0];
const approvalOf = async (phaseId: string, approverId: string) =>
  (await db.select().from(schema.flowApprovals).where(and(eq(schema.flowApprovals.subjectId, phaseId), eq(schema.flowApprovals.approverId, approverId))))[0];
const currentPhaseId = async (projectId: string) =>
  (await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, projectId)))[0].settings?.currentPhaseId;

describe('the gate subject handler', () => {
  it('is registered by the service', () => {
    expect(getApprovalSubjectHandler('gate')).toBeDefined();
  });

  it('passes the phase, activates the next one and moves currentPhaseId when the last approval comes in', async () => {
    const [build, accept] = await seedGate('prj_gr_pass');
    const sponsor = await approvalOf(build, SPONSOR);
    const board = await approvalOf(build, BOARD);

    const first = await decideApproval(db, { approvalId: sponsor.id, actor: SPONSOR, decision: 'approved' });
    expect(first).toMatchObject({ ok: true, outcome: 'pending', resolved: false });
    expect((await phaseRow(build)).status).toBe('active');

    // Approving with conditions is a yes.
    const second = await decideApproval(db, { approvalId: board.id, actor: BOARD, decision: 'approved_with_conditions', note: 'Rehearse the migration' });
    expect(second).toMatchObject({ ok: true, outcome: 'approved', resolved: true });

    const passed = await phaseRow(build);
    expect(passed.status).toBe('passed');
    expect(passed.passedAt).toBeInstanceOf(Date);
    expect(passed.gateResult).toMatchObject({ waived: [] });
    expect(passed.gateResult?.criteria).toHaveLength(2);
    expect(new Date(passed.gateResult?.checkedAt ?? '').getTime()).toBeGreaterThanOrEqual(passed.passedAt?.getTime() ?? 0);
    expect((await phaseRow(accept)).status).toBe('active');
    expect(await currentPhaseId('prj_gr_pass')).toBe(accept);

    await publishGateResolution(context, db, build, 'approved');
    expect(events().map((event) => `${event.entityType}.${event.action}:${event.entityId}`)).toEqual([
      `project_phase.passed:${build}`,
      `project_phase.updated:${accept}`,
    ]);
    expect(events()[0].data).toMatchObject({ id: build, projectId: 'prj_gr_pass', status: 'passed', nextPhaseId: accept });
    expect(events()[1].data).toMatchObject({ id: accept, status: 'active' });
  });

  it('can be run again without changing what it did', async () => {
    const [build, accept] = await seedGate('prj_gr_again');
    const sponsor = await approvalOf(build, SPONSOR);
    const board = await approvalOf(build, BOARD);
    await decideApproval(db, { approvalId: sponsor.id, actor: SPONSOR, decision: 'approved' });
    await decideApproval(db, { approvalId: board.id, actor: BOARD, decision: 'approved' });
    const once = await phaseRow(build);

    await resolveGate(db, build, 'approved');

    const twice = await phaseRow(build);
    expect(twice.passedAt?.toISOString()).toBe(once.passedAt?.toISOString());
    expect(twice.gateResult).toEqual(once.gateResult);
    expect((await phaseRow(accept)).status).toBe('active');
  });

  it('leaves the project without a current phase when the last gate passes', async () => {
    const [only] = await seedGate('prj_gr_last', ['Build']);
    await decideApproval(db, { approvalId: (await approvalOf(only, SPONSOR)).id, actor: SPONSOR, decision: 'approved' });
    await decideApproval(db, { approvalId: (await approvalOf(only, BOARD)).id, actor: BOARD, decision: 'approved' });
    expect((await phaseRow(only)).status).toBe('passed');
    expect(await currentPhaseId('prj_gr_last')).toBeNull();
    await publishGateResolution(context, db, only, 'approved');
    expect(events().map((event) => event.action)).toEqual(['passed']);
  });

  it('keeps the phase active and reopens its gate when an approver declines, and the gate can be asked for again', async () => {
    const [build, accept] = await seedGate('prj_gr_reject');
    const sponsor = await approvalOf(build, SPONSOR);

    const declined = await decideApproval(db, { approvalId: sponsor.id, actor: SPONSOR, decision: 'rejected', note: 'The migration is not rehearsed' });
    expect(declined).toMatchObject({ ok: true, outcome: 'rejected', resolved: true });

    const phase = await phaseRow(build);
    expect(phase.status).toBe('active');
    expect(phase.gateRequestedAt).toBeNull();
    expect(phase.passedAt).toBeNull();
    expect((await phaseRow(accept)).status).toBe('upcoming');
    expect(await currentPhaseId('prj_gr_reject')).toBe(build);
    // The other approver is no longer asked about a gate that was turned down.
    const open = await db
      .select()
      .from(schema.flowApprovals)
      .where(and(eq(schema.flowApprovals.subjectId, build), isNull(schema.flowApprovals.deletedAt)));
    expect(open.map((row) => [row.approverId, row.decision])).toEqual([[SPONSOR, 'rejected']]);

    await publishGateResolution(context, db, build, 'rejected');
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ entityType: 'project_phase', action: 'rejected', entityId: build });
    expect(events()[0].data).toMatchObject({ rejectedBy: SPONSOR, note: 'The migration is not rehearsed' });

    // The project manager asks again, and the old answers are cleared first.
    const again = await as(MANAGER)('POST', `/${build}/request-approval`);
    expect(again.status).toBe(201);
    const fresh = await db
      .select()
      .from(schema.flowApprovals)
      .where(and(eq(schema.flowApprovals.subjectId, build), isNull(schema.flowApprovals.deletedAt)));
    expect(fresh.map((row) => [row.approverId, row.decision]).sort()).toEqual([[BOARD, 'pending'], [SPONSOR, 'pending']]);
  });

  it('does nothing for a phase that is gone, and publishes nothing for a gate that did not pass', async () => {
    await resolveGate(db, 'phs_gr_ghost', 'approved');
    await resolveGate(db, 'phs_gr_ghost', 'rejected');
    const [build] = await seedGate('prj_gr_none');
    await publishGateResolution(context, db, build, 'approved');
    await publishGateResolution(context, db, 'phs_gr_ghost', 'approved');
    expect(published).not.toHaveBeenCalled();
  });
});
