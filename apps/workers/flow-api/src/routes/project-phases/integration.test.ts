/**
 * DB-backed integration tests for phases and stage gates (delivery): /api/project-phases.
 * Runs against the TypeScript worker and, in conformance mode, the Rust
 * backend (rust/conformance/suites.json), so every status code, message and
 * event payload asserted here is the contract of both. The check itself is
 * covered by the shared fixtures of packages/domains/flow/src/testing/gate-fixtures.json;
 * what approving a gate does is in ../../services/project-phases.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectPhasesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_ph_manager';
const MEMBER = 'user_ph_member';
const VIEWER = 'user_ph_viewer';
const SPONSOR = 'user_ph_sponsor';
const BOARD = 'user_ph_board';
const OUTSIDER = 'user_ph_outsider';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-phases', projectPhasesRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-phases${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const manager = () => as(MANAGER);

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));
const actions = () => events().map((event) => `${event.entityType}.${event.action}`);

/**
 * The id a create answered, as the create's events carry it. In conformance
 * mode the spy records the TypeScript run (rolled back) and the answer is
 * Rust's, so the two mint different ids: only the prefix is the same.
 */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

interface SeedOptions {
  sponsorId?: string | null;
  boardMemberIds?: string[];
  manager?: string | null;
}

async function seedProject(id: string, options: SeedOptions = {}) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  const sponsorId = options.sponsorId === undefined ? SPONSOR : options.sponsorId;
  await db.insert(schema.projects).values({
    id,
    name: id,
    projectManagerId: options.manager === undefined ? MANAGER : options.manager,
    budgetCurrency: 'EUR',
    settings: {
      ...(sponsorId ? { sponsorId } : {}),
      changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: options.boardMemberIds ?? [BOARD] },
    },
    createdAt: now,
    updatedAt: now,
  });
  const member = (suffix: string, userId: string, role: string) => ({
    id: `pm_${id}_${suffix}`,
    projectId: id,
    userId,
    role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    joinedAt: now,
  });
  await db.insert(schema.projectMembers).values([member('m', MEMBER, 'member'), member('v', VIEWER, 'viewer'), member('s', SPONSOR, 'viewer')]);
}

interface Phase {
  id: string;
  projectId: string;
  position: number;
  name: string;
  status: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  gateCriteria: Array<Record<string, unknown>>;
  gateResult: { checkedAt: string; criteria: unknown[]; waived: Array<{ index: number; note: string; by: string }> } | null;
  gateRequestedAt: string | null;
  passedAt: string | null;
  gateNumber: number;
  criteriaCount: number;
  approvals: Array<{ approverId: string; decision: string; roleLabel: string | null; step: number }>;
}

async function addPhase(projectId: string, body: Record<string, unknown>, who: Send = manager()): Promise<Phase> {
  const res = await who('POST', '', { projectId, ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Phase>(res);
}

const settingsOf = async (projectId: string) => {
  const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, projectId));
  return row.settings;
};

const phaseRow = async (id: string) => {
  const [row] = await db.select().from(schema.projectPhases).where(eq(schema.projectPhases.id, id));
  return row;
};

const gateApprovals = (phaseId: string) =>
  db
    .select()
    .from(schema.flowApprovals)
    .where(and(eq(schema.flowApprovals.subjectType, 'gate'), eq(schema.flowApprovals.subjectId, phaseId), isNull(schema.flowApprovals.deletedAt)));

// ── Create ──────────────────────────────────────────────────────────────────

describe('POST /', () => {
  it('starts the lifecycle with the first phase active, and the next ones upcoming, in order', async () => {
    await seedProject('prj_ph_new');

    const first = await addPhase('prj_ph_new', { name: 'Initiation', plannedStart: '2026-08-01T00:00:00.000Z', plannedEnd: '2026-09-09T00:00:00.000Z' });
    const second = await addPhase('prj_ph_new', { name: 'Design', gateCriteria: [{ manual: '  Design signed off  ' }, { key: 'no_change_request_pending' }] });

    expect(first).toMatchObject({
      projectId: 'prj_ph_new',
      position: 0,
      name: 'Initiation',
      status: 'active',
      plannedStart: '2026-08-01T00:00:00.000Z',
      plannedEnd: '2026-09-09T00:00:00.000Z',
      gateCriteria: [],
      gateResult: null,
      gateRequestedAt: null,
      passedAt: null,
      gateNumber: 1,
      criteriaCount: 0,
      approvals: [],
    });
    expect(first.id).toMatch(/^phs_/);
    expect(second).toMatchObject({
      position: 1,
      status: 'upcoming',
      gateNumber: 2,
      criteriaCount: 2,
      gateCriteria: [{ manual: 'Design signed off', met: false, metAt: null }, { key: 'no_change_request_pending' }],
    });
    expect((await settingsOf('prj_ph_new'))?.currentPhaseId).toBe(first.id);
    // The other settings keys are untouched.
    expect((await settingsOf('prj_ph_new'))?.sponsorId).toBe(SPONSOR);
  });

  it('publishes project_phase.created with ids and statuses', async () => {
    await seedProject('prj_ph_events');
    const created = await addPhase('prj_ph_events', { name: 'Build', plannedStart: '2026-10-01T00:00:00.000Z' });
    expect(events()).toEqual([
      {
        entityType: 'project_phase',
        action: 'created',
        entityId: minted(created.id),
        data: {
          id: minted(created.id),
          projectId: 'prj_ph_events',
          name: 'Build',
          status: 'active',
          position: 0,
          plannedStart: '2026-10-01T00:00:00.000Z',
          plannedEnd: null,
        },
      },
    ]);
  });

  it('activates the first phase again when every phase before it has passed', async () => {
    await seedProject('prj_ph_after');
    const first = await addPhase('prj_ph_after', { name: 'One' });
    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, first.id));
    const next = await addPhase('prj_ph_after', { name: 'Two' });
    expect(next.status).toBe('active');
    expect((await settingsOf('prj_ph_after'))?.currentPhaseId).toBe(next.id);
  });

  it('takes every criterion of the catalogue with its parameters', async () => {
    await seedProject('prj_ph_crit');
    const now = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projectDeliverables).values({ id: 'dlv_ph_crit', projectId: 'prj_ph_crit', number: 2, title: 'Webshop', createdBy: MANAGER, createdAt: now, updatedAt: now });
    await db.insert(schema.projectDecisions).values({ id: 'dec_ph_crit', projectId: 'prj_ph_crit', number: 5, title: 'Payment API', createdBy: MANAGER, createdAt: now, updatedAt: now });

    const phase = await addPhase('prj_ph_crit', {
      name: 'Build',
      gateCriteria: [
        { key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_ph_crit' } },
        { key: 'deliverable_accepted', params: { deliverableId: 'dlv_ph_crit' } },
        { key: 'no_open_risk_above', params: { band: 'critical' } },
        { key: 'decision_decided', params: { decisionId: 'dec_ph_crit' } },
        { key: 'no_change_request_pending' },
        { key: 'spend_within_baseline' },
        { manual: 'Plan approved' },
      ],
    });
    expect(phase.criteriaCount).toBe(7);
  });

  it('refuses criteria that are not in the catalogue, lack their parameters or point at nothing in the project', async () => {
    await seedProject('prj_ph_bad');
    await seedProject('prj_ph_bad_other');
    const now = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projectDeliverables).values({ id: 'dlv_ph_other', projectId: 'prj_ph_bad_other', number: 1, title: 'Elsewhere', createdBy: MANAGER, createdAt: now, updatedAt: now });

    const refused = async (criteria: unknown[], message: string, status = 400) => {
      const res = await manager()('POST', '', { projectId: 'prj_ph_bad', name: 'Build', gateCriteria: criteria });
      expect(res.status, JSON.stringify(criteria)).toBe(status);
      expect((await errorOf(res)).message).toBe(message);
    };
    await refused([{ key: 'deliverable_tasks_done' }], 'This criterion needs a deliverableId');
    await refused([{ key: 'decision_decided', params: {} }], 'This criterion needs a decisionId');
    await refused([{ key: 'no_open_risk_above', params: { band: 'extreme' } }], 'This criterion needs a band: low, medium, high or critical');
    await refused([{ key: 'deliverable_accepted', params: { deliverableId: 'dlv_ph_other' } }], 'A criterion points at a deliverable that does not exist in this project');
    await refused([{ key: 'decision_decided', params: { decisionId: 'dec_nope' } }], 'A criterion points at a decision that does not exist in this project');
    // Not in the catalogue, an empty manual text, an unknown field: the schema's 400.
    await refused([{ key: 'moon_phase' }], 'Invalid request body');
    await refused([{ manual: '   ' }], 'Invalid request body');
    await refused([{ manual: 'ok', met: true }], 'Invalid request body');
    expect(published).not.toHaveBeenCalled();
  });

  it('refuses a body with unknown fields, no name, or an end before the start', async () => {
    await seedProject('prj_ph_body');
    for (const body of [{ name: 'X', status: 'passed' }, { name: '   ' }, { name: 'X', position: 3 }, { name: 'X', plannedStart: 'tomorrow' }]) {
      const res = await manager()('POST', '', { projectId: 'prj_ph_body', ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const reversed = await manager()('POST', '', { projectId: 'prj_ph_body', name: 'X', plannedStart: '2026-10-02T00:00:00.000Z', plannedEnd: '2026-10-01T00:00:00.000Z' });
    expect(reversed.status).toBe(400);
    expect((await errorOf(reversed)).message).toBe('The end date cannot be before the start date');
  });

  it('is for project managers: 403 to a member, a viewer, an outsider and a missing permission; 404 for no project', async () => {
    await seedProject('prj_ph_acl');
    const body = { projectId: 'prj_ph_acl', name: 'Build' };
    const member = await as(MEMBER)('POST', '', body);
    expect(member.status).toBe(403);
    expect((await errorOf(member)).message).toBe('You do not have manage access to this project');
    expect((await as(VIEWER)('POST', '', body)).status).toBe(403);
    expect((await as(OUTSIDER)('POST', '', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '', body)).status).toBe(403);
    // The project manager of nothing is not a manager: only a scope:all holder gets as far as the 404.
    expect((await manager()('POST', '', { projectId: 'prj_ph_ghost', name: 'Build' })).status).toBe(403);
    expect((await as('user_ph_scope', [...FULL, 'projects:scope:all'])('POST', '', { projectId: 'prj_ph_ghost', name: 'Build' })).status).toBe(404);
  });
});

// ── Read ────────────────────────────────────────────────────────────────────

describe('GET / and GET /:id', () => {
  it('lists the lifecycle in order with its current phase, and reads one phase', async () => {
    await seedProject('prj_ph_list');
    const a = await addPhase('prj_ph_list', { name: 'Initiation' });
    const b = await addPhase('prj_ph_list', { name: 'Design' });
    const c = await addPhase('prj_ph_list', { name: 'Build', gateCriteria: [{ manual: 'Plan approved' }] });

    const res = await as(VIEWER, ['projects:read'])('GET', '?projectId=prj_ph_list');
    expect(res.status).toBe(200);
    const lifecycle = await data<{ currentPhaseId: string | null; phases: Phase[] }>(res);
    expect(lifecycle.currentPhaseId).toBe(a.id);
    expect(lifecycle.phases.map((phase) => [phase.id, phase.name, phase.status, phase.gateNumber])).toEqual([
      [a.id, 'Initiation', 'active', 1],
      [b.id, 'Design', 'upcoming', 2],
      [c.id, 'Build', 'upcoming', 3],
    ]);

    const one = await as(VIEWER, ['projects:read'])('GET', `/${c.id}`);
    expect(await data<Phase>(one)).toMatchObject({ id: c.id, name: 'Build', gateNumber: 3, criteriaCount: 1, approvals: [] });
  });

  it('wants a project, 404s a phase or project that does not exist, and keeps outsiders out', async () => {
    await seedProject('prj_ph_read');
    const phase = await addPhase('prj_ph_read', { name: 'Build' });

    expect((await manager()('GET', '')).status).toBe(400);
    expect((await manager()('GET', '?projectId=prj_ph_ghost')).status).toBe(404);
    expect((await manager()('GET', '/phs_ghost')).status).toBe(404);
    expect((await manager()('GET', '/phs_ghost/check')).status).toBe(404);
    const outsider = await as(OUTSIDER)('GET', '?projectId=prj_ph_read');
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    expect((await as(OUTSIDER)('GET', `/${phase.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('GET', `/${phase.id}/check`)).status).toBe(403);
    expect((await as(MANAGER, [])('GET', '?projectId=prj_ph_read')).status).toBe(403);
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('renames and re-dates a phase, and publishes project_phase.updated', async () => {
    await seedProject('prj_ph_edit');
    const phase = await addPhase('prj_ph_edit', { name: 'Build', plannedStart: '2026-10-01T00:00:00.000Z' });
    published.mockClear();

    const res = await manager()('PATCH', `/${phase.id}`, { name: 'Construction', plannedEnd: '2026-11-30T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(await data<Phase>(res)).toMatchObject({ id: phase.id, name: 'Construction', plannedStart: '2026-10-01T00:00:00.000Z', plannedEnd: '2026-11-30T00:00:00.000Z' });
    expect(events()).toEqual([
      {
        entityType: 'project_phase',
        action: 'updated',
        entityId: phase.id,
        data: { id: phase.id, projectId: 'prj_ph_edit', name: 'Construction', status: 'active', position: 0, plannedStart: '2026-10-01T00:00:00.000Z', plannedEnd: '2026-11-30T00:00:00.000Z' },
      },
    ]);
    // A date can be cleared.
    const cleared = await manager()('PATCH', `/${phase.id}`, { plannedStart: null });
    expect((await data<Phase>(cleared)).plannedStart).toBeNull();
  });

  it('replaces the criteria and starts them clean: the ticks and the waivers of the old ones are gone', async () => {
    await seedProject('prj_ph_edit2');
    const phase = await addPhase('prj_ph_edit2', { name: 'Build', gateCriteria: [{ manual: 'Plan approved' }, { key: 'no_change_request_pending' }] });
    await manager()('PATCH', `/${phase.id}/criteria/0`, { met: true });
    await db.update(schema.projectPhases).set({ gateResult: { checkedAt: '2026-11-03T10:00:00.000Z', criteria: [], waived: [{ index: 1, note: 'ok', by: SPONSOR, at: '2026-11-03T10:00:00.000Z' }] } }).where(eq(schema.projectPhases.id, phase.id));

    const res = await manager()('PATCH', `/${phase.id}`, { gateCriteria: [{ manual: 'Plan approved' }] });

    expect(res.status).toBe(200);
    const updated = await data<Phase>(res);
    expect(updated.gateCriteria).toEqual([{ manual: 'Plan approved', met: false, metAt: null }]);
    expect(updated.gateResult).toBeNull();
  });

  it('answers 404, 403 and 400 in that order, and refuses what a passed phase or a requested gate cannot take', async () => {
    await seedProject('prj_ph_edit3');
    const phase = await addPhase('prj_ph_edit3', { name: 'Build' });
    const next = await addPhase('prj_ph_edit3', { name: 'Accept' });

    expect((await manager()('PATCH', '/phs_ghost', { name: 'X' })).status).toBe(404);
    // A member with a bad body gets the 403, not the 400.
    expect((await as(MEMBER)('PATCH', `/${phase.id}`, { status: 'passed' })).status).toBe(403);
    expect((await as(OUTSIDER)('PATCH', `/${phase.id}`, { name: 'X' })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PATCH', `/${phase.id}`, { name: 'X' })).status).toBe(403);
    for (const body of [{ status: 'passed' }, { name: '' }, { id: 'phs_x' }, { gateCriteria: [{ key: 'nope' }] }]) {
      const res = await manager()('PATCH', `/${phase.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const reversed = await manager()('PATCH', `/${phase.id}`, { plannedStart: '2026-10-02T00:00:00.000Z', plannedEnd: '2026-10-01T00:00:00.000Z' });
    expect((await errorOf(reversed)).message).toBe('The end date cannot be before the start date');
    const missing = await manager()('PATCH', `/${phase.id}`, { gateCriteria: [{ key: 'decision_decided', params: { decisionId: 'dec_nope' } }] });
    expect((await errorOf(missing)).message).toBe('A criterion points at a decision that does not exist in this project');

    // Waiting for approval: the criteria were approved as they stood.
    await db.update(schema.projectPhases).set({ gateRequestedAt: new Date() }).where(eq(schema.projectPhases.id, phase.id));
    const requested = await manager()('PATCH', `/${phase.id}`, { gateCriteria: [{ manual: 'New' }] });
    expect(requested.status).toBe(409);
    expect((await errorOf(requested)).message).toBe('Approval of this gate has already been requested');
    expect((await manager()('PATCH', `/${phase.id}`, { name: 'Renamed while waiting' })).status).toBe(200);

    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, phase.id));
    const passed = await manager()('PATCH', `/${phase.id}`, { name: 'Too late' });
    expect(passed.status).toBe(409);
    expect((await errorOf(passed)).message).toBe('This phase has passed its gate and can no longer be changed');
    expect((await manager()('PATCH', `/${next.id}`, { name: 'Still fine' })).status).toBe(200);
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('removes a phase; when it was the active one the next phase takes over', async () => {
    await seedProject('prj_ph_del');
    const a = await addPhase('prj_ph_del', { name: 'One' });
    const b = await addPhase('prj_ph_del', { name: 'Two' });
    const c = await addPhase('prj_ph_del', { name: 'Three' });
    published.mockClear();

    const res = await manager()('DELETE', `/${a.id}`);

    expect(res.status).toBe(204);
    expect((await phaseRow(a.id)).deletedAt).toBeInstanceOf(Date);
    expect((await phaseRow(b.id)).status).toBe('active');
    expect((await phaseRow(c.id)).status).toBe('upcoming');
    expect((await settingsOf('prj_ph_del'))?.currentPhaseId).toBe(b.id);
    expect(actions()).toEqual(['project_phase.deleted', 'project_phase.updated']);
    expect(events()[0]).toMatchObject({ entityId: a.id, data: { id: a.id, name: 'One' } });
    expect(events()[1]).toMatchObject({ entityId: b.id, data: { status: 'active' } });

    const listed = await data<{ currentPhaseId: string; phases: Phase[] }>(await manager()('GET', '?projectId=prj_ph_del'));
    expect(listed.phases.map((phase) => phase.id)).toEqual([b.id, c.id]);
    // The gate number follows the lifecycle as it is now.
    expect(listed.phases.map((phase) => phase.gateNumber)).toEqual([1, 2]);
  });

  it('removing the last phase leaves the project with none, and removing an upcoming one changes nothing else', async () => {
    await seedProject('prj_ph_del2');
    const a = await addPhase('prj_ph_del2', { name: 'One' });
    const b = await addPhase('prj_ph_del2', { name: 'Two' });
    expect((await manager()('DELETE', `/${b.id}`)).status).toBe(204);
    expect((await phaseRow(a.id)).status).toBe('active');
    expect((await settingsOf('prj_ph_del2'))?.currentPhaseId).toBe(a.id);
    expect((await manager()('DELETE', `/${a.id}`)).status).toBe(204);
    expect((await settingsOf('prj_ph_del2'))?.currentPhaseId).toBeNull();
  });

  it('clears the approvals asked for the gate that goes', async () => {
    await seedProject('prj_ph_del3');
    const a = await addPhase('prj_ph_del3', { name: 'One' });
    await db.insert(schema.flowApprovals).values({
      id: 'apr_ph_del3',
      projectId: 'prj_ph_del3',
      subjectType: 'gate',
      subjectId: a.id,
      approverId: SPONSOR,
      rule: { code: 'gate' },
      createdBy: MANAGER,
    });
    expect((await manager()('DELETE', `/${a.id}`)).status).toBe(204);
    expect(await gateApprovals(a.id)).toEqual([]);
  });

  it('answers 404, 403 and 409 for a phase that passed', async () => {
    await seedProject('prj_ph_del4');
    const a = await addPhase('prj_ph_del4', { name: 'One' });
    expect((await manager()('DELETE', '/phs_ghost')).status).toBe(404);
    expect((await as(MEMBER)('DELETE', `/${a.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('DELETE', `/${a.id}`)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read', 'projects:update'])('DELETE', `/${a.id}`)).status).toBe(403);
    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, a.id));
    const res = await manager()('DELETE', `/${a.id}`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('This phase has passed its gate and can no longer be changed');
    expect((await phaseRow(a.id)).deletedAt).toBeNull();
  });
});

// ── Reorder ─────────────────────────────────────────────────────────────────

describe('POST /reorder', () => {
  it('puts the phases in the new order, and publishes an update for each that moved', async () => {
    await seedProject('prj_ph_ord');
    const a = await addPhase('prj_ph_ord', { name: 'One' });
    const b = await addPhase('prj_ph_ord', { name: 'Two' });
    const c = await addPhase('prj_ph_ord', { name: 'Three' });
    published.mockClear();

    const res = await manager()('POST', '/reorder', { projectId: 'prj_ph_ord', ids: [a.id, c.id, b.id] });

    expect(res.status).toBe(200);
    const lifecycle = await data<{ currentPhaseId: string; phases: Phase[] }>(res);
    expect(lifecycle.phases.map((phase) => [phase.id, phase.position, phase.gateNumber])).toEqual([
      [a.id, 0, 1],
      [c.id, 1, 2],
      [b.id, 2, 3],
    ]);
    expect(actions()).toEqual(['project_phase.updated', 'project_phase.updated']);
    expect(events().map((event) => event.entityId)).toEqual([c.id, b.id]);
    // The same order again moves nothing.
    published.mockClear();
    expect((await manager()('POST', '/reorder', { projectId: 'prj_ph_ord', ids: [a.id, c.id, b.id] })).status).toBe(200);
    expect(published).not.toHaveBeenCalled();
  });

  it('wants every phase once, with the passed ones first and in their order', async () => {
    await seedProject('prj_ph_ord2');
    const a = await addPhase('prj_ph_ord2', { name: 'One' });
    const b = await addPhase('prj_ph_ord2', { name: 'Two' });
    const c = await addPhase('prj_ph_ord2', { name: 'Three' });
    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, a.id));

    const refuse = async (ids: string[], message: string) => {
      const res = await manager()('POST', '/reorder', { projectId: 'prj_ph_ord2', ids });
      expect(res.status, JSON.stringify(ids)).toBe(400);
      expect((await errorOf(res)).message).toBe(message);
    };
    await refuse([a.id, b.id], 'List every phase of the project exactly once');
    await refuse([a.id, b.id, b.id], 'List every phase of the project exactly once');
    await refuse([a.id, b.id, 'phs_ghost'], 'List every phase of the project exactly once');
    await refuse([b.id, a.id, c.id], 'Passed phases keep their place at the start');
    await refuse([b.id, c.id, a.id], 'Passed phases keep their place at the start');
    expect((await manager()('POST', '/reorder', { projectId: 'prj_ph_ord2', ids: [a.id, c.id, b.id] })).status).toBe(200);
  });

  it('answers 400, 404 and 403 for a bad body, an unknown project and a caller who does not manage it', async () => {
    await seedProject('prj_ph_ord3');
    expect((await manager()('POST', '/reorder', { projectId: 'prj_ph_ord3' })).status).toBe(400);
    expect((await manager()('POST', '/reorder', { ids: [] })).status).toBe(400);
    expect((await manager()('POST', '/reorder', { projectId: 'prj_ph_ghost', ids: [] })).status).toBe(404);
    expect((await as(MEMBER)('POST', '/reorder', { projectId: 'prj_ph_ord3', ids: [] })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '/reorder', { projectId: 'prj_ph_ord3', ids: [] })).status).toBe(403);
  });
});

// ── Check ───────────────────────────────────────────────────────────────────

interface Check {
  items: Array<{ index: number; kind: string; key: string | null; text: string | null; met: boolean; waived: boolean; satisfied: boolean; facts: Record<string, unknown>; link: { kind: string; id: string | null } | null }>;
  total: number;
  metCount: number;
  waivedCount: number;
  satisfiedCount: number;
  allSatisfied: boolean;
}

type Gate = Phase & { check: Check; approverIds: string[]; requestBlockedReason: string | null };

/** The mockup's gate 3: a deliverable half done, a critical risk, a proposed decision, a pending change, spend within the baseline. */
async function seedGateFacts(projectId: string) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projectDeliverables).values({ id: `dlv_${projectId}`, projectId, number: 2, title: 'Webshop', createdBy: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectDecisions).values({
    id: `dec_${projectId}`,
    projectId,
    number: 5,
    title: 'Payment API',
    status: 'proposed',
    decisionDueAt: new Date('2026-11-06T00:00:00.000Z'),
    createdBy: MANAGER,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectChangeRequests).values({ id: `cr_${projectId}`, projectId, number: 8, title: 'Pay in 3', status: 'awaiting_approval', createdBy: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectRaidItems).values([
    { id: `raid_${projectId}_1`, projectId, kind: 'risk', number: 4, title: 'Data migration loses order data', status: 'monitoring', probability: 5, impact: 4, createdBy: MANAGER },
    { id: `raid_${projectId}_2`, projectId, kind: 'risk', number: 5, title: 'Small risk', status: 'identified', probability: 2, impact: 2, createdBy: MANAGER },
    { id: `raid_${projectId}_3`, projectId, kind: 'risk', number: 6, title: 'Closed critical', status: 'closed', closedAt: now, probability: 5, impact: 5, createdBy: MANAGER },
  ]);
  const task = (suffix: string, status: string, deliverableId: string | null) => ({ id: `task_${projectId}_${suffix}`, title: suffix, projectId, status, deliverableId });
  await db.insert(schema.tasks).values([
    task('a', 'done', `dlv_${projectId}`),
    task('b', 'done', `dlv_${projectId}`),
    task('c', 'in_progress', `dlv_${projectId}`),
    task('d', 'cancelled', `dlv_${projectId}`),
    task('e', 'todo', null),
  ] as (typeof schema.tasks.$inferInsert)[]);
  await db.insert(schema.projectBaselines).values({
    id: `bl_${projectId}`,
    projectId,
    version: 4,
    snapshot: { goLive: null, milestones: [], deliverables: [], budgetedAmount: '186400.00', budgetedHours: null, budgetCurrency: 'EUR', scopeStatement: null },
    createdBy: MANAGER,
  });
  const entry = (suffix: string, cost: string, status: string) => ({ id: `te_${projectId}_${suffix}`, projectId, userId: MEMBER, date: '2026-10-20', duration: '60', cost, status });
  await db.insert(schema.timeEntries).values([entry('1', '100000.00', 'approved'), entry('2', '4800.00', 'billed'), entry('3', '9000.00', 'draft'), entry('4', '70.00', 'submitted')]);
}

describe('GET /:id/check', () => {
  it('evaluates every criterion on read, with the facts and the link behind each one', async () => {
    await seedProject('prj_ph_check');
    await seedGateFacts('prj_ph_check');
    const phase = await addPhase('prj_ph_check', {
      name: 'Build',
      gateCriteria: [
        { key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_prj_ph_check' } },
        { key: 'no_open_risk_above', params: { band: 'critical' } },
        { key: 'decision_decided', params: { decisionId: 'dec_prj_ph_check' } },
        { key: 'no_change_request_pending' },
        { key: 'spend_within_baseline' },
        { manual: 'Acceptance test plan approved' },
      ],
    });

    const res = await as(VIEWER, ['projects:read'])('GET', `/${phase.id}/check`);
    expect(res.status).toBe(200);
    const gate = await data<Gate>(res);

    expect(gate).toMatchObject({ id: phase.id, name: 'Build', status: 'active', gateNumber: 1, approverIds: [SPONSOR, BOARD], requestBlockedReason: 'criteria_open' });
    expect(gate.check).toMatchObject({ total: 6, metCount: 1, waivedCount: 0, satisfiedCount: 1, allSatisfied: false });
    expect(gate.check.items.map((item) => [item.index, item.met])).toEqual([[0, false], [1, false], [2, false], [3, false], [4, true], [5, false]]);
    expect(gate.check.items[0]).toMatchObject({
      kind: 'automatic',
      key: 'deliverable_tasks_done',
      facts: { deliverableId: 'dlv_prj_ph_check', code: 'D2', title: 'Webshop', done: 2, total: 3 },
      link: { kind: 'tasks', id: 'dlv_prj_ph_check' },
    });
    expect(gate.check.items[1]).toMatchObject({
      facts: { band: 'critical', count: 1, top: { id: 'raid_prj_ph_check_1', code: 'RSK-4', title: 'Data migration loses order data', score: 20 } },
      link: { kind: 'raid', id: 'raid_prj_ph_check_1' },
    });
    expect(gate.check.items[2]).toMatchObject({
      facts: { code: 'DEC-5', status: 'proposed', decisionDueAt: '2026-11-06T00:00:00.000Z' },
      link: { kind: 'decision', id: 'dec_prj_ph_check' },
    });
    expect(gate.check.items[3]).toMatchObject({ facts: { count: 1, first: { id: 'cr_prj_ph_check', code: 'CR-8', title: 'Pay in 3' } }, link: { kind: 'change_requests', id: 'cr_prj_ph_check' } });
    // Approved and billed time counts, a draft and a submitted entry do not.
    expect(gate.check.items[4]).toMatchObject({ facts: { spent: '104800.00', budget: '186400.00', currency: 'EUR', baselineVersion: 4 }, link: { kind: 'finance', id: null } });
    expect(gate.check.items[5]).toMatchObject({ kind: 'manual', key: null, text: 'Acceptance test plan approved', met: false, link: null });
  });

  it('reads the data as it is now: the gate turns green when the work is done', async () => {
    await seedProject('prj_ph_live');
    const now = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projectDeliverables).values({ id: 'dlv_ph_live', projectId: 'prj_ph_live', number: 1, title: 'Login', createdBy: MANAGER, createdAt: now, updatedAt: now });
    await db.insert(schema.tasks).values({ id: 'task_ph_live', title: 'Login page', projectId: 'prj_ph_live', status: 'todo', deliverableId: 'dlv_ph_live' } as typeof schema.tasks.$inferInsert);
    const phase = await addPhase('prj_ph_live', { name: 'Build', gateCriteria: [{ key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_ph_live' } }, { key: 'no_change_request_pending' }] });

    const before = await data<Gate>(await manager()('GET', `/${phase.id}/check`));
    expect(before.check.allSatisfied).toBe(false);
    expect(before.requestBlockedReason).toBe('criteria_open');

    await db.update(schema.tasks).set({ status: 'done' }).where(eq(schema.tasks.id, 'task_ph_live'));
    const after = await data<Gate>(await manager()('GET', `/${phase.id}/check`));
    expect(after.check).toMatchObject({ allSatisfied: true, metCount: 2 });
    expect(after.requestBlockedReason).toBeNull();
  });

  it('says why a gate cannot be requested: the phase is not the active one, or nobody can approve it', async () => {
    await seedProject('prj_ph_why', { sponsorId: null, manager: null, boardMemberIds: [] });
    const a = await addPhase('prj_ph_why', { name: 'One' }, as('user_ph_scope', [...FULL, 'projects:scope:all']));
    const b = await addPhase('prj_ph_why', { name: 'Two' }, as('user_ph_scope', [...FULL, 'projects:scope:all']));
    const first = await data<Gate>(await as('user_ph_scope', [...FULL, 'projects:scope:all'])('GET', `/${a.id}/check`));
    expect(first).toMatchObject({ approverIds: [], requestBlockedReason: 'no_approver' });
    const second = await data<Gate>(await as('user_ph_scope', [...FULL, 'projects:scope:all'])('GET', `/${b.id}/check`));
    expect(second.requestBlockedReason).toBe('phase_not_active');
  });
});

// ── Manual criteria ─────────────────────────────────────────────────────────

describe('PATCH /:id/criteria/:index', () => {
  it('ticks and unticks a manual criterion, which the check then reads', async () => {
    await seedProject('prj_ph_tick');
    const phase = await addPhase('prj_ph_tick', { name: 'Build', gateCriteria: [{ key: 'no_change_request_pending' }, { manual: 'Plan approved' }] });
    published.mockClear();

    const res = await manager()('PATCH', `/${phase.id}/criteria/1`, { met: true });

    expect(res.status).toBe(200);
    const gate = await data<Gate>(res);
    expect(gate.gateCriteria[1]).toMatchObject({ manual: 'Plan approved', met: true });
    expect((gate.gateCriteria[1] as { metAt: string }).metAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(gate.check.items[1]).toMatchObject({ kind: 'manual', met: true, satisfied: true });
    expect(gate.check.items[1].facts).toEqual({ metAt: (gate.gateCriteria[1] as { metAt: string }).metAt });
    expect(actions()).toEqual(['project_phase.updated']);

    const unticked = await data<Gate>(await manager()('PATCH', `/${phase.id}/criteria/1`, { met: false }));
    expect(unticked.gateCriteria[1]).toEqual({ manual: 'Plan approved', met: false, metAt: null });
    expect(unticked.check.items[1].met).toBe(false);
  });

  it('refuses an automatic criterion, a criterion that is not there, a passed phase and a gate waiting for approval', async () => {
    await seedProject('prj_ph_tick2');
    const phase = await addPhase('prj_ph_tick2', { name: 'Build', gateCriteria: [{ key: 'no_change_request_pending' }, { manual: 'Plan approved' }] });

    const automatic = await manager()('PATCH', `/${phase.id}/criteria/0`, { met: true });
    expect(automatic.status).toBe(400);
    expect((await errorOf(automatic)).message).toBe('Only manual criteria can be ticked');
    for (const index of ['2', '-1', 'x', '1.5']) {
      const res = await manager()('PATCH', `/${phase.id}/criteria/${index}`, { met: true });
      expect(res.status, index).toBe(400);
      expect((await errorOf(res)).message).toBe('This phase has no such criterion');
    }
    expect((await manager()('PATCH', `/${phase.id}/criteria/1`, { met: 'yes' })).status).toBe(400);
    expect((await manager()('PATCH', `/${phase.id}/criteria/1`, {})).status).toBe(400);

    await db.update(schema.projectPhases).set({ gateRequestedAt: new Date() }).where(eq(schema.projectPhases.id, phase.id));
    const requested = await manager()('PATCH', `/${phase.id}/criteria/1`, { met: true });
    expect(requested.status).toBe(409);
    expect((await errorOf(requested)).message).toBe('Approval of this gate has already been requested');
    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, phase.id));
    const passed = await manager()('PATCH', `/${phase.id}/criteria/1`, { met: true });
    expect(passed.status).toBe(409);
    expect((await errorOf(passed)).message).toBe('This phase has passed its gate and can no longer be changed');
  });

  it('is for project managers', async () => {
    await seedProject('prj_ph_tick3');
    const phase = await addPhase('prj_ph_tick3', { name: 'Build', gateCriteria: [{ manual: 'Plan approved' }] });
    expect((await manager()('PATCH', '/phs_ghost/criteria/0', { met: true })).status).toBe(404);
    expect((await as(MEMBER)('PATCH', `/${phase.id}/criteria/0`, { met: true })).status).toBe(403);
    expect((await as(OUTSIDER)('PATCH', `/${phase.id}/criteria/0`, { met: true })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PATCH', `/${phase.id}/criteria/0`, { met: true })).status).toBe(403);
  });
});

// ── Waive ───────────────────────────────────────────────────────────────────

describe('POST /:id/waive', () => {
  it('lets the sponsor waive an open criterion with a note, and the gate counts it as satisfied', async () => {
    await seedProject('prj_ph_waive');
    await seedGateFacts('prj_ph_waive');
    const phase = await addPhase('prj_ph_waive', {
      name: 'Build',
      gateCriteria: [{ key: 'no_change_request_pending' }, { key: 'spend_within_baseline' }, { manual: 'Plan approved' }],
    });
    published.mockClear();

    const res = await as(SPONSOR)('POST', `/${phase.id}/waive`, { criterionIndex: 0, note: '  CR-8 is decided on Monday  ' });

    expect(res.status).toBe(200);
    const gate = await data<Gate>(res);
    expect(gate.check.items[0]).toMatchObject({ met: false, waived: true, satisfied: true, waiver: { index: 0, note: 'CR-8 is decided on Monday', by: SPONSOR } });
    expect(gate.check).toMatchObject({ metCount: 1, waivedCount: 1, satisfiedCount: 2, allSatisfied: false });
    expect(gate.gateResult).toMatchObject({ waived: [{ index: 0, note: 'CR-8 is decided on Monday', by: SPONSOR }] });
    expect(gate.gateResult?.criteria).toHaveLength(3);
    expect(actions()).toEqual(['project_phase.updated']);
    expect(events()[0].data).toMatchObject({ id: phase.id, waivedCriterion: 0 });

    // The manual one next, and then nothing is left.
    const second = await data<Gate>(await as(SPONSOR)('POST', `/${phase.id}/waive`, { criterionIndex: 2, note: 'Plan is in review' }));
    expect(second.check).toMatchObject({ waivedCount: 2, allSatisfied: true });
    expect(second.requestBlockedReason).toBeNull();
  });

  it('is the sponsors alone: the project manager waives only when no sponsor is named', async () => {
    await seedProject('prj_ph_waive2');
    await seedProject('prj_ph_waive3', { sponsorId: null });
    const phase = await addPhase('prj_ph_waive2', { name: 'Build', gateCriteria: [{ manual: 'Plan approved' }] });
    const other = await addPhase('prj_ph_waive3', { name: 'Build', gateCriteria: [{ manual: 'Plan approved' }] });
    const body = { criterionIndex: 0, note: 'ok' };

    const notSponsor = await manager()('POST', `/${phase.id}/waive`, body);
    expect(notSponsor.status).toBe(403);
    expect((await errorOf(notSponsor)).message).toBe('Only the project sponsor can waive a criterion');
    expect((await as(MEMBER)('POST', `/${phase.id}/waive`, body)).status).toBe(403);
    expect((await as(SPONSOR, ['projects:read'])('POST', `/${phase.id}/waive`, body)).status).toBe(403);
    expect((await as(OUTSIDER)('POST', `/${phase.id}/waive`, body)).status).toBe(403);
    expect((await manager()('POST', `/${other.id}/waive`, body)).status).toBe(200);
    expect(((await phaseRow(phase.id)).gateResult)).toBeNull();
  });

  it('refuses in the fixed order: 404, 403, 400, then 409 for a criterion that is met, waived, or a gate that moved on', async () => {
    await seedProject('prj_ph_waive4');
    const phase = await addPhase('prj_ph_waive4', { name: 'Build', gateCriteria: [{ key: 'no_change_request_pending' }, { manual: 'Plan approved' }] });
    const send = as(SPONSOR);

    expect((await send('POST', '/phs_ghost/waive', { criterionIndex: 0, note: 'x' })).status).toBe(404);
    expect((await as(OUTSIDER)('POST', `/${phase.id}/waive`, { nonsense: true })).status).toBe(403);
    for (const body of [{}, { criterionIndex: 0 }, { criterionIndex: 0, note: '   ' }, { criterionIndex: -1, note: 'x' }, { criterionIndex: 0, note: 'x', extra: 1 }]) {
      const res = await send('POST', `/${phase.id}/waive`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const absent = await send('POST', `/${phase.id}/waive`, { criterionIndex: 2, note: 'x' });
    expect(absent.status).toBe(400);
    expect((await errorOf(absent)).message).toBe('This phase has no such criterion');

    // No change request is pending: that one is met, there is nothing to waive.
    const met = await send('POST', `/${phase.id}/waive`, { criterionIndex: 0, note: 'x' });
    expect(met.status).toBe(409);
    expect((await errorOf(met)).message).toBe('This criterion is already met');
    expect((await send('POST', `/${phase.id}/waive`, { criterionIndex: 1, note: 'x' })).status).toBe(200);
    const again = await send('POST', `/${phase.id}/waive`, { criterionIndex: 1, note: 'again' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This criterion has already been waived');

    await db.update(schema.projectPhases).set({ gateRequestedAt: new Date() }).where(eq(schema.projectPhases.id, phase.id));
    const requested = await send('POST', `/${phase.id}/waive`, { criterionIndex: 1, note: 'late' });
    expect(requested.status).toBe(409);
    expect((await errorOf(requested)).message).toBe('The gate is already waiting for approval');
    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, phase.id));
    const passed = await send('POST', `/${phase.id}/waive`, { criterionIndex: 1, note: 'late' });
    expect((await errorOf(passed)).message).toBe('This phase has passed its gate and can no longer be changed');
  });
});

// ── Request approval ────────────────────────────────────────────────────────

describe('POST /:id/request-approval', () => {
  it('asks the sponsor and one change board member once every criterion is met or waived', async () => {
    await seedProject('prj_ph_req', { boardMemberIds: [BOARD, 'user_ph_other_board'] });
    const phase = await addPhase('prj_ph_req', { name: 'Build', gateCriteria: [{ key: 'no_change_request_pending' }, { manual: 'Plan approved' }] });
    await manager()('PATCH', `/${phase.id}/criteria/1`, { met: true });
    published.mockClear();

    const res = await manager()('POST', `/${phase.id}/request-approval`);

    expect(res.status).toBe(201);
    const result = await data<{ phase: Gate; approvals: Array<{ id: string; approverId: string; roleLabel: string | null; step: number; decision: string; note: string | null; decidedAt: string | null }> }>(res);
    expect(result.approvals.map((row) => [row.approverId, row.roleLabel, row.step, row.decision])).toEqual([
      [SPONSOR, 'Sponsor', 1, 'pending'],
      [BOARD, 'Change board', 1, 'pending'],
    ]);
    expect(result.phase).toMatchObject({ id: phase.id, status: 'active', requestBlockedReason: 'already_requested' });
    expect(result.phase.gateRequestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.phase.approvals.map((row) => row.approverId)).toEqual([SPONSOR, BOARD]);
    expect(result.phase.gateResult).toMatchObject({ waived: [] });
    expect(result.phase.gateResult?.criteria).toHaveLength(2);

    const rows = await gateApprovals(phase.id);
    expect(rows.map((row) => [row.approverId, row.approverKind, row.rule, row.projectId, row.createdBy, row.decision])).toEqual([
      [SPONSOR, 'member', { code: 'gate', params: { phaseId: phase.id, phaseName: 'Build' } }, 'prj_ph_req', MANAGER, 'pending'],
      [BOARD, 'member', { code: 'gate', params: { phaseId: phase.id, phaseName: 'Build' } }, 'prj_ph_req', MANAGER, 'pending'],
    ]);
    expect(actions()).toEqual(['project_phase.gate_requested', 'flow_approval.requested', 'flow_approval.requested']);
    expect(events()[0]).toMatchObject({ entityId: phase.id, data: { id: phase.id, status: 'active', approverIds: [SPONSOR, BOARD] } });
    expect(events()[1].data).toMatchObject({ projectId: 'prj_ph_req', subjectType: 'gate', subjectId: phase.id, approverKind: 'member', approverId: SPONSOR, step: 1, decision: 'pending' });
    expect(events()[2].data).toMatchObject({ approverId: BOARD });
  });

  it('counts a waived criterion, and asks the sponsor alone when there is no board member or it is the sponsor', async () => {
    await seedProject('prj_ph_req2', { boardMemberIds: [] });
    await seedProject('prj_ph_req3', { boardMemberIds: [SPONSOR] });
    await seedGateFacts('prj_ph_req2');
    const phase = await addPhase('prj_ph_req2', { name: 'Build', gateCriteria: [{ key: 'no_change_request_pending' }] });
    const same = await addPhase('prj_ph_req3', { name: 'Build' });

    const blocked = await manager()('POST', `/${phase.id}/request-approval`);
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).message).toBe('Not every criterion is met or waived');
    expect(await gateApprovals(phase.id)).toEqual([]);

    expect((await as(SPONSOR)('POST', `/${phase.id}/waive`, { criterionIndex: 0, note: 'Decided Monday' })).status).toBe(200);
    expect((await manager()('POST', `/${phase.id}/request-approval`)).status).toBe(201);
    expect((await gateApprovals(phase.id)).map((row) => row.approverId)).toEqual([SPONSOR]);

    expect((await manager()('POST', `/${same.id}/request-approval`)).status).toBe(201);
    expect((await gateApprovals(same.id)).map((row) => row.approverId)).toEqual([SPONSOR]);
  });

  it('falls back to the project manager when no sponsor is named', async () => {
    await seedProject('prj_ph_req4', { sponsorId: null, boardMemberIds: [] });
    const phase = await addPhase('prj_ph_req4', { name: 'Build' });
    expect((await manager()('POST', `/${phase.id}/request-approval`)).status).toBe(201);
    expect((await gateApprovals(phase.id)).map((row) => row.approverId)).toEqual([MANAGER]);
  });

  it('refuses a gate that was asked for, one of an upcoming or passed phase, and one nobody can approve', async () => {
    await seedProject('prj_ph_req5');
    await seedProject('prj_ph_req6', { sponsorId: null, manager: null, boardMemberIds: [] });
    const a = await addPhase('prj_ph_req5', { name: 'One' });
    const b = await addPhase('prj_ph_req5', { name: 'Two' });
    const lone = await addPhase('prj_ph_req6', { name: 'One' }, as('user_ph_scope', [...FULL, 'projects:scope:all']));

    const upcoming = await manager()('POST', `/${b.id}/request-approval`);
    expect(upcoming.status).toBe(409);
    expect((await errorOf(upcoming)).message).toBe('Only the active phase can request its gate');
    expect((await manager()('POST', `/${a.id}/request-approval`)).status).toBe(201);
    const twice = await manager()('POST', `/${a.id}/request-approval`);
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).message).toBe('Approval of this gate has already been requested');
    expect(await gateApprovals(a.id)).toHaveLength(2);

    await db.update(schema.projectPhases).set({ status: 'passed', passedAt: new Date() }).where(eq(schema.projectPhases.id, a.id));
    const passed = await manager()('POST', `/${a.id}/request-approval`);
    expect((await errorOf(passed)).message).toBe('This phase has passed its gate and can no longer be changed');

    const nobody = await as('user_ph_scope', [...FULL, 'projects:scope:all'])('POST', `/${lone.id}/request-approval`);
    expect(nobody.status).toBe(409);
    expect((await errorOf(nobody)).message).toBe('The project has no sponsor or project manager to approve the gate');
  });

  it('asks again after a rejection, with the old answers cleared', async () => {
    await seedProject('prj_ph_req7');
    const phase = await addPhase('prj_ph_req7', { name: 'Build' });
    expect((await manager()('POST', `/${phase.id}/request-approval`)).status).toBe(201);
    // The sponsor turned it down: the approvals core cleared the other rows and the handler reopened the gate.
    await db.update(schema.flowApprovals).set({ decision: 'rejected', note: 'Not yet', decidedAt: new Date(), decidedBy: SPONSOR }).where(and(eq(schema.flowApprovals.subjectId, phase.id), eq(schema.flowApprovals.approverId, SPONSOR)));
    await db.update(schema.flowApprovals).set({ deletedAt: new Date() }).where(and(eq(schema.flowApprovals.subjectId, phase.id), eq(schema.flowApprovals.approverId, BOARD)));
    await db.update(schema.projectPhases).set({ gateRequestedAt: null }).where(eq(schema.projectPhases.id, phase.id));

    const again = await manager()('POST', `/${phase.id}/request-approval`);
    expect(again.status).toBe(201);
    expect((await gateApprovals(phase.id)).map((row) => [row.approverId, row.decision])).toEqual([[SPONSOR, 'pending'], [BOARD, 'pending']]);
  });

  it('is for project managers', async () => {
    await seedProject('prj_ph_req8');
    const phase = await addPhase('prj_ph_req8', { name: 'Build' });
    expect((await manager()('POST', '/phs_ghost/request-approval')).status).toBe(404);
    const member = await as(MEMBER)('POST', `/${phase.id}/request-approval`);
    expect(member.status).toBe(403);
    expect((await errorOf(member)).message).toBe('You do not have manage access to this project');
    expect((await as(SPONSOR)('POST', `/${phase.id}/request-approval`)).status).toBe(403);
    expect((await as(OUTSIDER)('POST', `/${phase.id}/request-approval`)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', `/${phase.id}/request-approval`)).status).toBe(403);
    expect(await gateApprovals(phase.id)).toEqual([]);
  });
});
