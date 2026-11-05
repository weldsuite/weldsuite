/**
 * DB-backed integration tests for project templates: /api/project-templates
 * (save a project as a template, the gallery, create a project from a
 * template). Runs against the TypeScript worker and, in conformance mode
 * (rust/conformance/suites.json), the Rust backend, so every status code,
 * message and event payload asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectTemplatesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const ADMIN = 'user_tpl_admin';
const OTHER_ADMIN = 'user_tpl_admin2';
const MEMBER = 'user_tpl_member';
const OUTSIDER = 'user_tpl_outsider';
const SCOPE_ALL = 'user_tpl_scope_all';
const NEW_PM = 'user_tpl_new_pm';
const NEW_SPONSOR = 'user_tpl_new_sponsor';
const NEW_DEV = 'user_tpl_new_dev';

const ADMIN_KEYS = ['projects:read', 'projects:create', 'projects:update', 'projects:delete', 'project_templates:manage'];
const USER_KEYS = ['projects:read', 'projects:create'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = ADMIN_KEYS, env?: Record<string, unknown>): Send {
  const { request } = createTestApp('/api/project-templates', projectTemplatesRoutes, {
    context: {
      userId,
      permissions: permissions(...keys, ...(userId === SCOPE_ALL ? ['projects:scope:all'] : [])),
      tenantDb: db,
    },
    ...(env ? { env } : {}),
  });
  return (method, path, body) =>
    request(`/api/project-templates${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const admin = () => as(ADMIN);
const user = (userId = MEMBER) => as(userId, USER_KEYS);

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  shared: boolean;
  sourceProjectId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  summary: {
    durationDays: number;
    tasks: number;
    milestones: number;
    phases: number;
    deliverables: number;
    raidItems: number;
    stages: number;
    roles: number;
  };
  usageCount: number;
  blueprint?: {
    version: number;
    durationDays: number;
    roles: Array<{ key: string; label: string; projectRole: string | null }>;
    tasks: Array<{ key: string; title: string; startOffset: number | null; dueOffset: number | null }>;
    [key: string]: unknown;
  };
}

interface Instantiated {
  project: { id: string; name: string; startDate: string; endDate: string; projectManagerId: string | null };
  counts: Record<string, number>;
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

/** The id a create answered, as its events carry it: in conformance mode only the prefix is the same. */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeEach(() => {
  published.mockClear();
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const at = (value: string) => new Date(`${value}T00:00:00.000Z`);
const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);

// ── The source project ──────────────────────────────────────────────────────

/**
 * A small project with one of everything a blueprint carries: a manager and a
 * sponsor, members, stages, phases with gate criteria, a milestone, a
 * deliverable, tasks (one cancelled) with a dependency of each kind, open and
 * closed register items, and the control and reporting settings.
 */
let sources = 0;
const seeded = new Set<string>();

async function seedSource(id = 'prj_tpl_src') {
  if (seeded.has(id)) return id;
  seeded.add(id);
  const numberBase = 9000 + (sources += 1) * 10;
  const now = new Date('2026-12-01T08:00:00.000Z');
  await db.insert(schema.projects).values({
    id,
    name: 'Customer Portal Relaunch',
    projectManagerId: ADMIN,
    status: 'Active',
    startDate: at('2027-01-11'),
    endDate: at('2027-02-05'),
    type: 'software',
    methodology: 'agile',
    priority: 'high',
    budgetCurrency: 'EUR',
    isBillable: true,
    trackTime: true,
    settings: {
      sponsorId: 'user_tpl_src_sponsor',
      changeControl: { costLimit: 8000, scheduleLimitDays: 3, boardMemberIds: ['user_tpl_src_sponsor', ADMIN] },
      statusReport: { cadence: 'biweekly', weekday: 5, hour: 15, recipients: { rule: 'all_stakeholders' } },
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: true },
      riskAppetite: 12,
    },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectMembers).values([
    { id: `${id}_pm1`, projectId: id, userId: ADMIN, role: 'owner', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `${id}_pm2`, projectId: id, userId: 'user_tpl_src_dev', role: 'member', isActive: true, createdAt: now, updatedAt: new Date(now.getTime() + 1), joinedAt: new Date(now.getTime() + 1) },
    { id: `${id}_pm3`, projectId: id, userId: MEMBER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: new Date(now.getTime() + 2) },
  ]);
  await db.insert(schema.projectPipelineStages).values([
    { id: `${id}_s1`, projectId: id, name: 'Backlog', color: '#94a3b8', position: 0, systemStatus: 'backlog' },
    { id: `${id}_s2`, projectId: id, name: 'To Do', color: '#c4b5fd', position: 1, systemStatus: 'todo' },
    { id: `${id}_s3`, projectId: id, name: 'Done', color: null, position: 2, systemStatus: 'done' },
  ]);
  await db.insert(schema.projectPhases).values([
    {
      id: `${id}_ph1`,
      projectId: id,
      position: 0,
      name: 'Build',
      plannedStart: at('2027-01-11'),
      plannedEnd: at('2027-01-22'),
      status: 'active',
      gateCriteria: [{ key: 'no_change_request_pending' }, { manual: 'Design signed', met: true, metAt: '2027-01-20T00:00:00.000Z' }],
      createdBy: ADMIN,
      createdAt: now,
      updatedAt: now,
    },
    { id: `${id}_ph2`, projectId: id, position: 1, name: 'Go-live', plannedStart: at('2027-01-25'), plannedEnd: at('2027-02-05'), gateCriteria: [], createdBy: ADMIN, createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.milestones).values({
    id: `${id}_ms1`,
    projectId: id,
    name: 'Design signed off',
    dueDate: at('2027-01-15'),
    ownerId: 'user_tpl_src_sponsor',
    isKeyMilestone: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectDeliverables).values({
    id: `${id}_dl1`,
    projectId: id,
    number: 4,
    title: 'Ordering',
    description: 'Place orders',
    ownerId: 'user_tpl_src_dev',
    status: 'accepted',
    plannedStart: at('2027-01-12'),
    plannedEnd: at('2027-01-29'),
    acceptanceCriteria: [{ text: 'Checkout works', met: true, metAt: '2027-01-28T00:00:00.000Z' }],
    clientVisible: true,
    createdBy: ADMIN,
    createdAt: now,
    updatedAt: now,
  });
  const task = (n: number, values: Record<string, unknown>) => ({
    id: `${id}_t${n}`,
    number: numberBase + n,
    projectId: id,
    title: `Task ${n}`,
    status: 'in_progress',
    priority: 'medium',
    position: n,
    createdAt: now,
    updatedAt: now,
    ...values,
  });
  await db.insert(schema.tasks).values([
    task(1, { title: 'Build ordering', assigneeId: 'user_tpl_src_dev', startDate: at('2027-01-11'), dueDate: at('2027-01-15'), milestoneId: `${id}_ms1`, deliverableId: `${id}_dl1`, estimatedHours: '16.00', progress: '50' }),
    task(2, { title: 'Write tests', parentTaskId: `${id}_t1`, status: 'backlog', assigneeIds: ['user_tpl_src_dev', MEMBER] }),
    task(3, { title: 'Release', priority: 'critical', dueDate: at('2027-02-05'), dependsOn: [`${id}_t1`] }),
    task(4, { title: 'Dropped idea', status: 'cancelled' }),
  ] as unknown as (typeof schema.tasks.$inferInsert)[]);
  await db.insert(schema.taskDependencies).values({
    id: `${id}_dep1`,
    projectId: id,
    predecessorId: `${id}_t2`,
    successorId: `${id}_t3`,
    type: 'ss',
    lagDays: 2,
    createdBy: ADMIN,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectRaidItems).values([
    { id: `${id}_r1`, projectId: id, kind: 'risk', number: 1, title: 'Data migration loses history', status: 'mitigating', ownerId: 'user_tpl_src_dev', probability: 3, impact: 4, strategy: 'mitigate', reviewIntervalDays: 14, costImpact: '5000.00', createdBy: ADMIN, createdAt: now, updatedAt: now },
    { id: `${id}_r2`, projectId: id, kind: 'issue', number: 1, title: 'Build is red', status: 'resolved', severity: 'high', closedAt: now, createdBy: ADMIN, createdAt: now, updatedAt: now },
    { id: `${id}_r3`, projectId: id, kind: 'assumption', number: 1, title: 'Client supplies content by week 8', status: 'open', ownerId: 'user_tpl_src_sponsor', confidence: 'medium', ifWrong: 'Launch slips', createdBy: ADMIN, createdAt: now, updatedAt: now },
  ]);
  return id;
}

async function saveTemplate(body: Record<string, unknown> = {}, who: Send = admin(), projectId = 'prj_tpl_src'): Promise<Template> {
  const res = await who('POST', `/from-project/${projectId}`, { name: 'Website relaunch', ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Template>(res);
}

const ROLES = { project_manager: NEW_PM, sponsor: NEW_SPONSOR, member_1: NEW_DEV };

async function instantiate(templateId: string, body: Record<string, unknown> = {}, who: Send = admin()) {
  return who('POST', `/${templateId}/instantiate`, { name: 'Supplier Portal', startDate: '2027-03-03', roles: ROLES, ...body });
}

// ── Save as template ────────────────────────────────────────────────────────

describe('POST /from-project/:projectId', () => {
  it('turns a project into a blueprint: dates as offsets, people as roles, ids as keys', async () => {
    await seedSource();
    published.mockClear();
    const template = await saveTemplate({ description: 'Standard relaunch', roleLabels: { member_1: 'Tech lead', sponsor: 'Executive sponsor' } });

    expect(template).toMatchObject({
      name: 'Website relaunch',
      description: 'Standard relaunch',
      shared: false,
      sourceProjectId: 'prj_tpl_src',
      createdBy: ADMIN,
      usageCount: 0,
      summary: { durationDays: 19, tasks: 3, milestones: 1, phases: 2, deliverables: 1, raidItems: 2, stages: 3, roles: 4 },
    });
    expect(template.id).toMatch(/^tpl_/);
    const blueprint = template.blueprint!;
    expect(blueprint.version).toBe(1);
    expect(blueprint.roles).toEqual([
      { key: 'project_manager', label: 'Project manager', projectRole: 'owner' },
      { key: 'sponsor', label: 'Executive sponsor', projectRole: null },
      { key: 'member_1', label: 'Tech lead', projectRole: 'member' },
      { key: 'member_2', label: 'Team member 2', projectRole: 'viewer' },
    ]);
    expect(blueprint.tasks.map((task) => [task.key, task.title, task.startOffset, task.dueOffset])).toEqual([
      ['t1', 'Build ordering', 0, 4],
      ['t2', 'Write tests', null, null],
      ['t3', 'Release', null, 19],
    ]);
    expect(JSON.stringify(blueprint)).not.toContain('prj_tpl_src');
    expect(JSON.stringify(blueprint)).not.toContain('user_tpl_src_dev');

    expect(events()).toEqual([
      {
        entityType: 'project_template',
        action: 'created',
        entityId: minted(template.id),
        data: { id: minted(template.id), name: 'Website relaunch', shared: false, sourceProjectId: 'prj_tpl_src' },
      },
    ]);
  });

  it('is for template managers, and for projects the caller is in', async () => {
    await seedSource();
    const body = { name: 'Nope' };
    expect((await user()('POST', '/from-project/prj_tpl_src', body)).status).toBe(403);
    const outsider = await as(OUTSIDER)('POST', '/from-project/prj_tpl_src', body);
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    const missing = await admin()('POST', '/from-project/prj_tpl_nowhere', body);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Project with ID 'prj_tpl_nowhere' not found");
    expect((await as(SCOPE_ALL)('POST', '/from-project/prj_tpl_src', body)).status).toBe(201);
  });

  it('refuses a body that does not fit', async () => {
    await seedSource();
    for (const body of [{}, { name: '   ' }, { name: 'x', shared: 'yes' }, { name: 'x', extra: 1 }, { name: 'x', roleLabels: { member_1: '' } }, 'not an object']) {
      const res = await admin()('POST', '/from-project/prj_tpl_src', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
  });
});

// ── Create, edit, delete ────────────────────────────────────────────────────

const minimalBlueprint = () => ({
  version: 1,
  durationDays: 10,
  roles: [{ key: 'project_manager', label: 'Project manager', projectRole: 'owner' }],
  project: { type: null, methodology: null, priority: null, visibility: null, color: null, icon: null, budgetCurrency: null, billingMethod: null, isBillable: true, trackTime: true },
  stages: [],
  phases: [],
  milestones: [],
  deliverables: [],
  tasks: [
    { key: 't1', parentKey: null as string | null, title: 'Kick-off', description: null, priority: 'medium', type: 'task', status: 'todo', assigneeRoles: ['project_manager'], startOffset: 0, dueOffset: 1, estimatedHours: null, storyPoints: null, milestoneKey: null, deliverableKey: null, labels: null, tags: null, isBillable: true },
  ],
  dependencies: [],
  raid: [],
  settings: {},
});

describe('POST /', () => {
  it('creates a template from a blueprint in the body', async () => {
    const res = await admin()('POST', '', { name: 'Kick-off only', description: null, blueprint: minimalBlueprint(), shared: true });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const template = await data<Template>(res);
    expect(template).toMatchObject({ name: 'Kick-off only', shared: true, sourceProjectId: null, createdBy: ADMIN, summary: { tasks: 1, durationDays: 10, roles: 1 } });
    expect(template.blueprint).toEqual(minimalBlueprint());
    expect(actions()).toEqual(['project_template.created']);
  });

  it('refuses a blueprint that fails the schema', async () => {
    const broken: Array<[string, (blueprint: Record<string, unknown>) => void]> = [
      ['an unknown version', (b) => (b.version = 2)],
      ['an unknown field', (b) => (b.extra = true)],
      ['a missing section', (b) => delete b.tasks],
      ['a bad key', (b) => ((b.tasks as Array<Record<string, unknown>>)[0]!.key = 'Task 1')],
      ['a bad priority', (b) => ((b.tasks as Array<Record<string, unknown>>)[0]!.priority = 'urgent')],
      ['a risk without ratings', (b) => (b.raid = [{ kind: 'risk', title: 'R', description: null, category: null, ownerRole: null, probability: null, impact: null, strategy: null, trigger: null, costImpact: null, scheduleImpactDays: null, reviewIntervalDays: null, confidence: null, ifWrong: null, severity: null, direction: null, partyType: null, partyName: null }])],
    ];
    for (const [label, change] of broken) {
      const blueprint = minimalBlueprint() as unknown as Record<string, unknown>;
      change(blueprint);
      const res = await admin()('POST', '', { name: 'Bad', blueprint });
      expect(res.status, label).toBe(400);
      expect((await errorOf(res)).message, label).toBe('Invalid request body');
    }
  });

  it('refuses a blueprint whose references do not resolve', async () => {
    const blueprint = minimalBlueprint();
    blueprint.tasks[0]!.assigneeRoles = ['ghost'];
    const res = await admin()('POST', '', { name: 'Bad', blueprint });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('Task t1 refers to an unknown role: ghost');

    const twice = minimalBlueprint();
    twice.tasks = [twice.tasks[0]!, { ...twice.tasks[0]! }];
    const duplicate = await admin()('POST', '', { name: 'Bad', blueprint: twice });
    expect((await errorOf(duplicate)).message).toBe('Duplicate task key: t1');
    expect(actions()).toEqual([]);
  });

  it('is for template managers', async () => {
    expect((await user()('POST', '', { name: 'No', blueprint: minimalBlueprint() })).status).toBe(403);
    expect((await as(ADMIN, ['projects:create'])('POST', '', { name: 'No', blueprint: minimalBlueprint() })).status).toBe(403);
    expect((await admin()('POST', '', { blueprint: minimalBlueprint() })).status).toBe(400);
  });
});

describe('PATCH /:id and DELETE /:id', () => {
  it('renames, shares and replaces the blueprint', async () => {
    await seedSource();
    const template = await saveTemplate({ name: 'To edit' });
    published.mockClear();

    const res = await admin()('PATCH', `/${template.id}`, { name: 'Edited', description: 'Now shared', shared: true });
    expect(res.status).toBe(200);
    expect(await data<Template>(res)).toMatchObject({ id: template.id, name: 'Edited', description: 'Now shared', shared: true, summary: { tasks: 3 } });
    expect(events()).toEqual([
      {
        entityType: 'project_template',
        action: 'updated',
        entityId: minted(template.id),
        data: { id: minted(template.id), name: 'Edited', shared: true, sourceProjectId: 'prj_tpl_src' },
      },
    ]);

    const replaced = await admin()('PATCH', `/${template.id}`, { blueprint: minimalBlueprint(), description: null });
    expect(await data<Template>(replaced)).toMatchObject({ name: 'Edited', description: null, summary: { tasks: 1 } });
    const bad = minimalBlueprint();
    bad.tasks[0]!.parentKey = 't9';
    const refused = await admin()('PATCH', `/${template.id}`, { blueprint: bad });
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).message).toBe('Task t1 refers to an unknown parent: t9');
    expect((await admin()('PATCH', `/${template.id}`, { shared: 'yes' })).status).toBe(400);
    expect((await admin()('PATCH', `/${template.id}`, { source: 'x' })).status).toBe(400);
  });

  it('is for template managers, and only for templates they may see', async () => {
    await seedSource();
    const mine = await saveTemplate({ name: 'Private to the admin' });
    expect((await user()('PATCH', `/${mine.id}`, { name: 'No' })).status).toBe(403);
    expect((await user()('DELETE', `/${mine.id}`)).status).toBe(403);
    // Another manager cannot see an unshared template.
    const other = as(OTHER_ADMIN);
    const hidden = await other('PATCH', `/${mine.id}`, { name: 'No' });
    expect(hidden.status).toBe(404);
    expect((await errorOf(hidden)).message).toBe(`Template with ID '${mine.id}' not found`);
    expect((await other('DELETE', `/${mine.id}`)).status).toBe(404);
    // Once shared, they can.
    await admin()('PATCH', `/${mine.id}`, { shared: true });
    expect((await other('PATCH', `/${mine.id}`, { name: 'Renamed by the other manager' })).status).toBe(200);
    expect((await admin()('PATCH', '/tpl_nowhere', { name: 'x' })).status).toBe(404);
  });

  it('deletes a template for good from the gallery', async () => {
    await seedSource();
    const template = await saveTemplate({ name: 'To delete', shared: true });
    published.mockClear();
    const res = await admin()('DELETE', `/${template.id}`);
    expect(res.status).toBe(204);
    expect(events()).toEqual([
      {
        entityType: 'project_template',
        action: 'deleted',
        entityId: minted(template.id),
        data: { id: minted(template.id), name: 'To delete', shared: true, sourceProjectId: 'prj_tpl_src' },
      },
    ]);
    expect((await admin()('GET', `/${template.id}`)).status).toBe(404);
    expect((await admin()('DELETE', `/${template.id}`)).status).toBe(404);
    const [row] = await db.select().from(schema.projectTemplates).where(eq(schema.projectTemplates.id, template.id));
    expect(row?.deletedAt).not.toBeNull();
    const list = await data<Template[]>(await admin()('GET', ''));
    expect(list.map((entry) => entry.id)).not.toContain(template.id);
  });
});

// ── The gallery ─────────────────────────────────────────────────────────────

describe('GET / and GET /:id', () => {
  let shared: Template;
  let own: Template;
  let theirs: Template;

  beforeAll(async () => {
    await seedSource('prj_tpl_gallery');
    shared = await saveTemplate({ name: 'Gallery shared', description: 'Shared with everyone', shared: true }, admin(), 'prj_tpl_gallery');
    own = await saveTemplate({ name: 'Gallery own' }, admin(), 'prj_tpl_gallery');
    // Not a member of the project, but allowed to read every project.
    theirs = await saveTemplate({ name: 'Gallery theirs' }, as(OTHER_ADMIN, [...ADMIN_KEYS, 'projects:scope:all']), 'prj_tpl_gallery');
  });

  const names = async (query: string, who: Send) => {
    const res = await who('GET', `?${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Template[] }).data.map((entry) => entry.name).sort();
  };

  it('lists the shared templates and the caller’s own, without blueprints', async () => {
    expect(await names('search=Gallery', as(ADMIN, USER_KEYS))).toEqual(['Gallery own', 'Gallery shared']);
    expect(await names('search=Gallery', as(OTHER_ADMIN, USER_KEYS))).toEqual(['Gallery shared', 'Gallery theirs']);
    expect(await names('search=Gallery', user())).toEqual(['Gallery shared']);
    const res = await user()('GET', '?search=Gallery shared');
    const [entry] = ((await res.json()) as { data: Template[] }).data;
    expect(entry).toMatchObject({ id: shared.id, shared: true, description: 'Shared with everyone', usageCount: 0, summary: { tasks: 3 } });
    expect(entry).not.toHaveProperty('blueprint');
  });

  it('filters by shared and by search in the name or the description', async () => {
    const mine = admin();
    expect(await names('search=Gallery&shared=true', mine)).toEqual(['Gallery shared']);
    expect(await names('search=Gallery&shared=false', mine)).toEqual(['Gallery own']);
    expect(await names('search=everyone', mine)).toEqual(['Gallery shared']);
    expect(await names('search=%25', mine)).toEqual([]);
  });

  it('pages with a cursor, newest first', async () => {
    const mine = admin();
    const first = (await (await mine('GET', '?search=Gallery&limit=1')).json()) as { data: Template[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(first.pagination).toMatchObject({ totalCount: 2, hasMore: true });
    const second = (await (await mine('GET', `?search=Gallery&limit=1&cursor=${first.pagination.cursor}`)).json()) as typeof first;
    expect(second.pagination).toMatchObject({ hasMore: false, cursor: null });
    expect(new Set([first.data[0]!.id, second.data[0]!.id]).size).toBe(2);
  });

  it('answers one template with its blueprint, to those who may see it', async () => {
    const res = await user()('GET', `/${shared.id}`);
    expect(res.status).toBe(200);
    const detail = await data<Template>(res);
    expect(detail.blueprint?.version).toBe(1);
    expect(detail.blueprint?.tasks).toHaveLength(3);
    expect(detail.summary.tasks).toBe(3);
    expect((await admin()('GET', `/${own.id}`)).status).toBe(200);
    const hidden = await user()('GET', `/${own.id}`);
    expect(hidden.status).toBe(404);
    expect((await errorOf(hidden)).message).toBe(`Template with ID '${own.id}' not found`);
  });

  it('answers 409 for a template whose blueprint is no longer valid, and still lists it', async () => {
    const id = 'tpl_broken';
    await db.insert(schema.projectTemplates).values({
      id,
      name: 'Broken blueprint',
      blueprint: { version: 7, tasks: [1, 2, 3], durationDays: 4 },
      shared: true,
      createdBy: ADMIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await user()('GET', `/${id}`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('The template is no longer valid');
    const list = await data<Template[]>(await user()('GET', '?search=Broken blueprint'));
    expect(list[0]).toMatchObject({ id, summary: { tasks: 3, durationDays: 4 } });
  });

  it('needs projects:create or the manage key', async () => {
    expect((await as(MEMBER, ['projects:read'])('GET', '')).status).toBe(403);
    expect((await as(MEMBER, ['projects:read'])('GET', `/${shared.id}`)).status).toBe(403);
    expect((await as(MEMBER, ['project_templates:manage'])('GET', '')).status).toBe(200);
    expect((await user()('GET', '?limit=abc')).status).toBe(200);
    expect((await user()('GET', '?shared=maybe')).status).toBe(400);
  });
});

// ── Create project ──────────────────────────────────────────────────────────

describe('POST /:id/instantiate', () => {
  let template: Template;

  beforeAll(async () => {
    await seedSource('prj_tpl_inst');
    template = await saveTemplate({ name: 'Instantiate me', shared: true }, admin(), 'prj_tpl_inst');
  });

  it('marks the status report sweep due when the project carries a report schedule', async () => {
    const marks: unknown[][] = [];
    const scheduleIndex = {
      prepare: () => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            marks.push(args);
          },
        }),
      }),
    } as unknown as D1Database;
    const send = as(ADMIN, ADMIN_KEYS, { SCHEDULE_INDEX: scheduleIndex });
    expect((await instantiate(template.id, { name: 'Scheduled reports' }, send)).status).toBe(201);
    expect(marks.map(([kind]) => kind)).toEqual(['status_report_due']);

    // No schedule copied, nothing to draft: the index is left alone.
    marks.length = 0;
    const without = await instantiate(template.id, { name: 'No reports', copy: { statusReport: false } }, send);
    expect(without.status).toBe(201);
    expect(marks).toEqual([]);
  });

  it('creates the whole project from the template, with dates counted in working days from the start', async () => {
    published.mockClear();
    const res = await instantiate(template.id, { clientId: 'cmp_tpl_1' }, user(MEMBER));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const result = await data<Instantiated>(res);
    expect(result.project).toMatchObject({ name: 'Supplier Portal', startDate: '2027-03-03T00:00:00.000Z', endDate: '2027-03-30T00:00:00.000Z', projectManagerId: NEW_PM });
    expect(result.project.id).toMatch(/^prj_/);
    expect(result.counts).toEqual({ members: 3, stages: 3, phases: 2, milestones: 1, deliverables: 1, tasks: 3, dependencies: 2, raidItems: 2 });
    const projectId = result.project.id;

    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(project).toMatchObject({ name: 'Supplier Portal', status: 'Planning', customerId: 'cmp_tpl_1', projectManagerId: NEW_PM, type: 'software', methodology: 'agile', budgetCurrency: 'EUR' });
    expect(day(project?.startDate)).toBe('2027-03-03');
    expect(day(project?.endDate)).toBe('2027-03-30');
    const phases = await db.select().from(schema.projectPhases).where(eq(schema.projectPhases.projectId, projectId)).orderBy(asc(schema.projectPhases.position));
    expect(project?.settings).toEqual({
      templateId: template.id,
      sponsorId: NEW_SPONSOR,
      currentPhaseId: phases[0]!.id,
      changeControl: { costLimit: 8000, scheduleLimitDays: 3, boardMemberIds: [NEW_SPONSOR, NEW_PM] },
      statusReport: { cadence: 'biweekly', weekday: 5, hour: 15, recipients: { rule: 'all_stakeholders' } },
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: true },
      riskAppetite: 12,
    });

    // The creator owns the project; each role's person joins as the template says.
    const members = await db.select().from(schema.projectMembers).where(eq(schema.projectMembers.projectId, projectId));
    expect(members.map((member) => [member.userId, member.role]).sort()).toEqual([
      [MEMBER, 'owner'],
      [NEW_DEV, 'member'],
      [NEW_PM, 'owner'],
    ]);

    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).orderBy(asc(schema.tasks.position));
    expect(tasks.map((task) => [task.title, task.status, day(task.startDate), day(task.dueDate), task.assigneeId])).toEqual([
      ['Build ordering', 'todo', '2027-03-03', '2027-03-09', NEW_DEV],
      ['Write tests', 'backlog', null, null, NEW_DEV],
      ['Release', 'todo', null, '2027-03-30', null],
    ]);
    expect(new Set(tasks.map((task) => task.number)).size).toBe(3);
    expect(tasks.every((task) => typeof task.number === 'number' && task.number > 0 && task.reporterId === MEMBER)).toBe(true);
    expect(tasks[0]).toMatchObject({ progress: '0.00', estimatedHours: '16.00' });
    expect(tasks[1]!.parentTaskId).toBe(tasks[0]!.id);
    expect(tasks[0]!.deliverableId).not.toBeNull();
    expect(tasks[0]!.milestoneId).not.toBeNull();

    const dependencies = await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.projectId, projectId));
    expect(dependencies.map((dependency) => [dependency.predecessorId, dependency.successorId, dependency.type, dependency.lagDays]).sort()).toEqual(
      [
        [tasks[1]!.id, tasks[2]!.id, 'ss', 2],
        [tasks[0]!.id, tasks[2]!.id, 'fs', 0],
      ].sort(),
    );
    expect(tasks[2]!.dependsOn!.slice().sort()).toEqual([tasks[0]!.id, tasks[1]!.id].sort());
    expect(tasks[0]!.blocks).toEqual([tasks[2]!.id]);

    const [milestone] = await db.select().from(schema.milestones).where(eq(schema.milestones.projectId, projectId));
    expect(milestone).toMatchObject({ name: 'Design signed off', status: 'pending', ownerId: NEW_SPONSOR, isKeyMilestone: true });
    expect(day(milestone?.dueDate)).toBe('2027-03-09');
    expect(phases.map((phase) => [phase.name, phase.status, day(phase.plannedStart), day(phase.plannedEnd)])).toEqual([
      ['Build', 'active', '2027-03-03', '2027-03-16'],
      ['Go-live', 'upcoming', '2027-03-17', '2027-03-30'],
    ]);
    expect(phases[0]!.gateCriteria).toEqual([{ key: 'no_change_request_pending' }, { manual: 'Design signed', met: false, metAt: null }]);

    const [deliverable] = await db.select().from(schema.projectDeliverables).where(eq(schema.projectDeliverables.projectId, projectId));
    expect(deliverable).toMatchObject({ number: 1, title: 'Ordering', status: 'not_started', ownerId: NEW_DEV, clientVisible: true, acceptedAt: null, position: 0, createdBy: MEMBER });
    expect(deliverable?.acceptanceCriteria).toEqual([{ text: 'Checkout works', met: false, metAt: null }]);

    const stages = await db.select().from(schema.projectPipelineStages).where(eq(schema.projectPipelineStages.projectId, projectId)).orderBy(asc(schema.projectPipelineStages.position));
    expect(stages.map((stage) => [stage.name, stage.systemStatus])).toEqual([['Backlog', 'backlog'], ['To Do', 'todo'], ['Done', 'done']]);
    expect(tasks[0]!.stageId).toBe(stages[1]!.id);
    expect(tasks[1]!.stageId).toBe(stages[0]!.id);

    // The register: first status of each kind, numbered per project from 1, the risk assessed once.
    const raid = await db.select().from(schema.projectRaidItems).where(eq(schema.projectRaidItems.projectId, projectId)).orderBy(asc(schema.projectRaidItems.kind));
    expect(raid.map((item) => [item.kind, item.number, item.status, item.ownerId, item.closedAt])).toEqual([
      ['assumption', 1, 'open', NEW_SPONSOR, null],
      ['risk', 1, 'identified', NEW_DEV, null],
    ]);
    const risk = raid.find((item) => item.kind === 'risk')!;
    expect(risk).toMatchObject({ probability: 3, impact: 4, score: 12, strategy: 'mitigate', costImpact: '5000.00', reviewIntervalDays: 14 });
    const assessments = await db.select().from(schema.projectRaidAssessments).where(eq(schema.projectRaidAssessments.projectId, projectId));
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({ itemId: risk.id, probability: 3, impact: 4, assessedBy: MEMBER });

    // The new project's counters continue after what was made.
    const sequences = await db.select().from(schema.taskNumberSequences);
    const scopes = Object.fromEntries(sequences.filter((sequence) => sequence.scope.endsWith(`:${projectId}`)).map((sequence) => [sequence.scope, sequence.nextValue]));
    expect(scopes).toEqual({ [`del:${projectId}`]: 2, [`rsk:${projectId}`]: 2, [`asm:${projectId}`]: 2 });

    // Events: the project, its members, stages, milestones, phases, deliverables, tasks, dependencies and register, then the template.
    const names = actions();
    expect(names).toEqual([
      'project.created',
      'project_member.added',
      'project_member.added',
      'project_member.added',
      'project_pipeline_stage.created',
      'project_pipeline_stage.created',
      'project_pipeline_stage.created',
      'project_milestone.created',
      'project_phase.created',
      'project_phase.created',
      'project_deliverable.created',
      'project_task.created',
      'project_task.created',
      'project_task.created',
      'task_dependency.created',
      'task_dependency.created',
      'project_raid_item.created',
      'project_raid_item.created',
      'project_template.instantiated',
    ]);
    expect(events()[0]).toMatchObject({ entityId: minted(projectId), data: { id: minted(projectId), name: 'Supplier Portal', status: 'Planning' } });
    expect(events().find((event) => event.entityType === 'project_deliverable')?.data).toMatchObject({ number: 1, code: 'D1', title: 'Ordering', status: 'not_started' });
    expect(events().find((event) => event.entityType === 'project_task')?.data).toMatchObject({ title: 'Build ordering', projectId: minted(projectId), status: 'todo', assigneeId: NEW_DEV });
    expect(events().filter((event) => event.entityType === 'project_raid_item').map((event) => (event.data as { code: string }).code)).toEqual(['RSK-1', 'A-1']);
    expect(events().at(-1)).toEqual({
      entityType: 'project_template',
      action: 'instantiated',
      entityId: template.id,
      data: { id: template.id, name: 'Instantiate me', shared: true, sourceProjectId: 'prj_tpl_inst', projectId: minted(projectId) },
    });
  });

  it('counts the project against the template', async () => {
    const before = (await data<Template>(await admin()('GET', `/${template.id}`))).usageCount;
    expect((await instantiate(template.id, { name: 'Another one' })).status).toBe(201);
    expect((await data<Template>(await admin()('GET', `/${template.id}`))).usageCount).toBe(before + 1);
    const list = await data<Template[]>(await admin()('GET', '?search=Instantiate me'));
    expect(list[0]!.usageCount).toBe(before + 1);
  });

  it('numbers the tasks of each project after the ones before, without gaps or repeats', async () => {
    const first = await data<Instantiated>(await instantiate(template.id, { name: 'Numbered 1' }));
    const second = await data<Instantiated>(await instantiate(template.id, { name: 'Numbered 2' }));
    const numbers = async (projectId: string) =>
      (await db.select({ number: schema.tasks.number }).from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).orderBy(asc(schema.tasks.position))).map((row) => row.number as number);
    const a = await numbers(first.project.id);
    const b = await numbers(second.project.id);
    expect(b[0]).toBe(a[2]! + 1);
    expect([a[1]! - a[0]!, a[2]! - a[1]!, b[1]! - b[0]!]).toEqual([1, 1, 1]);
    // Each project counts its own register from 1.
    const raid = await db.select().from(schema.projectRaidItems).where(eq(schema.projectRaidItems.projectId, second.project.id));
    expect(raid.map((item) => item.number)).toEqual([1, 1]);
  });

  it('works for a person with no roles to fill: the creator manages', async () => {
    const res = await instantiate(template.id, { name: 'No roles', roles: undefined, copy: { tasks: false } });
    expect(res.status).toBe(201);
    const result = await data<Instantiated>(res);
    expect(result.project.projectManagerId).toBe(ADMIN);
    expect(result.counts).toMatchObject({ members: 1, tasks: 0, dependencies: 0 });
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, result.project.id));
    expect(project?.settings).not.toHaveProperty('sponsorId');
  });

  it('leaves out what the copy options turn off', async () => {
    const res = await instantiate(template.id, {
      name: 'Lean',
      copy: { phases: false, milestones: false, deliverables: false, tasks: false, stages: false, raid: false, changeControl: false, statusReport: false },
    });
    expect(res.status).toBe(201);
    const result = await data<Instantiated>(res);
    expect(result.counts).toEqual({ members: 3, stages: 0, phases: 0, milestones: 0, deliverables: 0, tasks: 0, dependencies: 0, raidItems: 0 });
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, result.project.id));
    expect(project?.settings).toEqual({
      templateId: template.id,
      sponsorId: NEW_SPONSOR,
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: true },
      riskAppetite: 12,
    });
    expect(actions()).toEqual(['project.created', 'project_member.added', 'project_member.added', 'project_member.added', 'project_template.instantiated']);

    const withoutRefs = await data<Instantiated>(await instantiate(template.id, { name: 'No milestones', copy: { milestones: false, deliverables: false, stages: false } }));
    const [task] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, withoutRefs.project.id), eq(schema.tasks.title, 'Build ordering')));
    expect(task).toMatchObject({ milestoneId: null, deliverableId: null, stageId: null });
  });

  it('is atomic: a failure leaves nothing of the project behind', async () => {
    const [sequence] = await db.select().from(schema.taskNumberSequences).where(eq(schema.taskNumberSequences.scope, 'task'));
    // Take the number the next task would get, so the insert of the tasks collides.
    const taken = sequence?.nextValue ?? 1;
    await db.insert(schema.tasks).values({ id: 'task_tpl_squatter', number: taken, title: 'Squatter', status: 'todo', priority: 'medium', createdAt: new Date(), updatedAt: new Date() });
    published.mockClear();

    const res = await instantiate(template.id, { name: 'Rollback me' });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).message).toBe('Failed to create the project');
    expect(await db.select().from(schema.projects).where(eq(schema.projects.name, 'Rollback me'))).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it('refuses what does not fit', async () => {
    const cases: Array<[unknown, string]> = [
      [{ startDate: '2027-03-03' }, 'no name'],
      [{ name: 'x' }, 'no start date'],
      [{ name: 'x', startDate: '03-03-2027' }, 'a start date in the wrong format'],
      [{ name: 'x', startDate: '2027-02-30' }, 'a start date that does not exist'],
      [{ name: 'x', startDate: '2027-03-03', roles: { sponsor: '' } }, 'an empty person'],
      [{ name: 'x', startDate: '2027-03-03', copy: { tasks: 'yes' } }, 'a copy option that is not a boolean'],
      [{ name: 'x', startDate: '2027-03-03', copy: { budget: true } }, 'an unknown copy option'],
      [{ name: 'x', startDate: '2027-03-03', extra: 1 }, 'an unknown field'],
      ['not an object', 'not an object'],
    ];
    for (const [body, label] of cases) {
      const res = await admin()('POST', `/${template.id}/instantiate`, body);
      expect(res.status, label).toBe(400);
      expect((await errorOf(res)).message, label).toBe('Invalid request body');
    }
    const unknownRole = await instantiate(template.id, { roles: { ghost: NEW_DEV } });
    expect(unknownRole.status).toBe(400);
    expect((await errorOf(unknownRole)).message).toBe("The template has no role 'ghost'");
    expect(actions()).toEqual([]);
  });

  it('needs projects:create, and a template the caller may see', async () => {
    expect((await instantiate(template.id, {}, as(MEMBER, ['projects:read']))).status).toBe(403);
    expect((await instantiate(template.id, {}, as(MEMBER, ['project_templates:manage']))).status).toBe(403);
    const missing = await instantiate('tpl_nowhere');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Template with ID 'tpl_nowhere' not found");

    const mine = await saveTemplate({ name: 'Instantiate private' }, admin(), 'prj_tpl_inst');
    const hidden = await instantiate(mine.id, {}, user());
    expect(hidden.status).toBe(404);
    expect((await instantiate(mine.id, {}, admin())).status).toBe(201);
  });

  it('refuses a template whose blueprint is no longer valid', async () => {
    await db.insert(schema.projectTemplates).values({
      id: 'tpl_old',
      name: 'Old format',
      blueprint: { version: 0 },
      shared: true,
      createdBy: ADMIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await instantiate('tpl_old');
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('This template was saved in a format that is not supported');
    const broken = 'tpl_broken_shape';
    await db.insert(schema.projectTemplates).values({ id: broken, name: 'Broken', blueprint: { version: 1 }, shared: true, createdBy: ADMIN, createdAt: new Date(), updatedAt: new Date() });
    expect((await errorOf(await instantiate(broken))).message).toBe('The template is no longer valid');
  });
});
