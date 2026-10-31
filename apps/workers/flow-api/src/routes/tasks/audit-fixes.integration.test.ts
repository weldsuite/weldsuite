/**
 * DB-backed tests for the WeldFlow task audit fixes (TASK-774/775/776/778/779/780/
 * 781/788/789/794/795): query booleans, project-scoped references, recurrence,
 * the `completed` event, subtree delete, clearing fields, reorder and the
 * workspace-timezone due-date buckets.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { reorderedPositions, reorderedPositionsByProject, tasksRoutes } from './index';
import { myTasksRoutes } from '../my-tasks';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const now = new Date();
const json = { 'Content-Type': 'application/json' };
const ME = 'user_test_default';

const seedProject = (id: string) =>
  db
    .insert(schema.projects)
    .values({ id, name: id, createdAt: now, updatedAt: now } as typeof schema.projects.$inferInsert);
const seedTask = (values: Record<string, unknown>) =>
  db.insert(schema.tasks).values({ title: 'Task', ...values } as typeof schema.tasks.$inferInsert);
const row = async (id: string) => {
  const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return found;
};
const app = () =>
  createTestApp('/api/tasks', tasksRoutes, {
    context: {
      permissions: permissions('tasks:read', 'tasks:create', 'tasks:update', 'tasks:delete', 'projects:scope:all'),
      tenantDb: db,
    },
  });
const send = (method: string, path: string, body?: unknown) =>
  app().request(`/api/tasks${path}`, {
    method,
    headers: json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const published = (action: string) =>
  mockedPublish.mock.calls
    .map((call) => call[0] as { action: string; entityId: string; entityType: string })
    .filter((call) => call.action === action && call.entityType === 'project_task');

describe('boolean query params (TASK-778)', () => {
  it('?myTasks=false lists everyone’s tasks and ?myTasks=true only the caller’s', async () => {
    await seedTask({ id: 'task_qb_mine', assigneeId: ME, projectId: null });
    await seedTask({ id: 'task_qb_other', assigneeId: 'user_other', projectId: null });

    const ids = async (query: string) =>
      ((await (await send('GET', `?${query}&limit=200`)).json()) as { data: { id: string }[] }).data.map(
        (task) => task.id,
      );

    const all = await ids('myTasks=false');
    expect(all).toContain('task_qb_mine');
    expect(all).toContain('task_qb_other');

    const mine = await ids('myTasks=true');
    expect(mine).toContain('task_qb_mine');
    expect(mine).not.toContain('task_qb_other');
  });

  it('?crmLinked=false does not restrict to CRM-linked tasks', async () => {
    await seedTask({ id: 'task_qb_unlinked', projectId: null });
    const res = await send('GET', '?crmLinked=false&limit=200');
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((task) => task.id)).toContain('task_qb_unlinked');
  });

  it('?enrich=false skips the enrichment and ?includeSubtasks=false the subtask tree', async () => {
    await seedProject('proj_qb');
    await seedTask({ id: 'task_qb_parent', projectId: 'proj_qb' });
    await seedTask({ id: 'task_qb_child', projectId: 'proj_qb', parentTaskId: 'task_qb_parent' });

    const res = await send('GET', '?projectId=proj_qb&enrich=false&includeSubtasks=false');
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('assignees');
    expect(body.data[0]).not.toHaveProperty('children');
    expect(body.data[0]?.subtaskCount).toBe(1);

    const withTree = await send('GET', '?projectId=proj_qb&includeSubtasks=true');
    const treeBody = (await withTree.json()) as { data: { children: unknown[] }[] };
    expect(treeBody.data[0]?.children).toHaveLength(1);
  });

  it('rejects a value that is not a boolean with 400', async () => {
    expect((await send('GET', '?myTasks=maybe')).status).toBe(400);
  });
});

describe('project-scoped references (TASK-781)', () => {
  const seedStage = (id: string, projectId: string, systemStatus: string) =>
    db.insert(schema.projectPipelineStages).values({
      id,
      projectId,
      name: id,
      position: 0,
      systemStatus,
    } as typeof schema.projectPipelineStages.$inferInsert);

  it('refuses a sprint, milestone, stage or parent from another project on create', async () => {
    await seedProject('proj_ref_a');
    await seedProject('proj_ref_b');
    await db.insert(schema.sprints).values({ id: 'sprint_ref_b', projectId: 'proj_ref_b', name: 'S' } as typeof schema.sprints.$inferInsert);
    await db.insert(schema.milestones).values({
      id: 'ms_ref_b',
      projectId: 'proj_ref_b',
      name: 'M',
      dueDate: now,
    } as typeof schema.milestones.$inferInsert);
    await seedStage('stage_ref_b', 'proj_ref_b', 'done');
    await seedTask({ id: 'task_ref_b', projectId: 'proj_ref_b' });

    for (const body of [
      { sprintId: 'sprint_ref_b' },
      { milestoneId: 'ms_ref_b' },
      { stageId: 'stage_ref_b' },
      { parentTaskId: 'task_ref_b' },
    ]) {
      const res = await send('POST', '/projects/proj_ref_a', { title: 'x', ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing was written for the refused requests.
    const written = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, 'proj_ref_a'));
    expect(written).toEqual([]);
  });

  it('accepts references from the task’s own project, and a personal task has none', async () => {
    await seedProject('proj_ref_ok');
    await db.insert(schema.sprints).values({ id: 'sprint_ref_ok', projectId: 'proj_ref_ok', name: 'S' } as typeof schema.sprints.$inferInsert);
    await seedStage('stage_ref_ok', 'proj_ref_ok', 'in_progress');

    const ok = await send('POST', '/projects/proj_ref_ok', {
      title: 'x',
      sprintId: 'sprint_ref_ok',
      stageId: 'stage_ref_ok',
    });
    expect(ok.status).toBe(201);

    const personal = await send('POST', '', { title: 'personal', sprintId: 'sprint_ref_ok' });
    expect(personal.status).toBe(400);
  });

  it('PATCH refuses another project’s sprint / stage but lets an unchanged one through', async () => {
    await seedProject('proj_ref_p1');
    await seedProject('proj_ref_p2');
    await db.insert(schema.sprints).values({ id: 'sprint_ref_p2', projectId: 'proj_ref_p2', name: 'S' } as typeof schema.sprints.$inferInsert);
    await seedStage('stage_ref_p2', 'proj_ref_p2', 'done');
    await seedTask({ id: 'task_ref_p1', projectId: 'proj_ref_p1', status: 'todo' });

    expect((await send('PATCH', '/task_ref_p1', { sprintId: 'sprint_ref_p2' })).status).toBe(400);
    expect((await send('PATCH', '/task_ref_p1', { stageId: 'stage_ref_p2' })).status).toBe(400);
    // The other project's stage never leaked its status into this task.
    const untouched = await row('task_ref_p1');
    expect(untouched?.status).toBe('todo');
    expect(untouched?.stageId).toBeNull();

    // A task already on a sprint that is later deleted can still be edited when the body repeats it.
    await db.insert(schema.sprints).values({ id: 'sprint_ref_gone', projectId: 'proj_ref_p1', name: 'S', deletedAt: now } as typeof schema.sprints.$inferInsert);
    await seedTask({ id: 'task_ref_p1b', projectId: 'proj_ref_p1', sprintId: 'sprint_ref_gone' });
    expect(
      (await send('PATCH', '/task_ref_p1b', { sprintId: 'sprint_ref_gone', title: 'renamed' })).status,
    ).toBe(200);
  });
});

describe('clearing fields (TASK-794)', () => {
  it('writes null for a cleared due date, start date, description and estimate', async () => {
    await seedTask({
      id: 'task_clear_1',
      description: 'text',
      dueDate: now,
      startDate: now,
      estimatedHours: '3.00',
      storyPoints: 5,
    });

    const res = await send('PATCH', '/task_clear_1', {
      dueDate: null,
      startDate: null,
      description: null,
      estimatedHours: null,
      storyPoints: null,
    });
    expect(res.status).toBe(200);

    const cleared = await row('task_clear_1');
    expect(cleared?.dueDate).toBeNull();
    expect(cleared?.startDate).toBeNull();
    expect(cleared?.description).toBeNull();
    expect(cleared?.estimatedHours).toBeNull();
    expect(cleared?.storyPoints).toBeNull();
  });

  it('an empty body leaves the stored values alone', async () => {
    await seedTask({ id: 'task_clear_2', description: 'keep', dueDate: now });
    expect((await send('PATCH', '/task_clear_2', {})).status).toBe(200);
    const kept = await row('task_clear_2');
    expect(kept?.description).toBe('keep');
    expect(kept?.dueDate).not.toBeNull();
  });
});

describe('completion: events and recurrence (TASK-774, TASK-775, TASK-788)', () => {
  const stageRows = [
    { id: 'stage_rec_todo', projectId: 'proj_rec', name: 'To Do', position: 0, systemStatus: 'todo' },
    { id: 'stage_rec_done', projectId: 'proj_rec', name: 'Done', position: 1, systemStatus: 'done' },
  ];

  beforeAll(async () => {
    await seedProject('proj_rec');
    await db.insert(schema.projectPipelineStages).values(stageRows as (typeof schema.projectPipelineStages.$inferInsert)[]);
    await db.insert(schema.sprints).values({ id: 'sprint_rec', projectId: 'proj_rec', name: 'S' } as typeof schema.sprints.$inferInsert);
  });

  const seedRepeating = (id: string, extra: Record<string, unknown> = {}) =>
    seedTask({
      id,
      title: `Repeat ${id}`,
      projectId: 'proj_rec',
      stageId: 'stage_rec_todo',
      sprintId: 'sprint_rec',
      status: 'todo',
      dueDate: new Date('2031-03-10T00:00:00.000Z'),
      repeat: { frequency: 'weekly' },
      customerId: 'cust_rec',
      ...extra,
    });
  const successors = async (title: string) =>
    db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.title, title), isNull(schema.tasks.deletedAt)));

  it('completing a repeating task creates the next occurrence with its stage, sprint and CRM link', async () => {
    await seedRepeating('task_rec_1');
    mockedPublish.mockClear();

    const res = await send('PATCH', '/task_rec_1/status', { status: 'done' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { nextTaskId?: string } };
    expect(body.data.nextTaskId).toMatch(/^task_/);

    const next = await row(body.data.nextTaskId!);
    expect(next?.status).toBe('todo');
    expect(next?.stageId).toBe('stage_rec_todo');
    expect(next?.sprintId).toBe('sprint_rec');
    expect(next?.customerId).toBe('cust_rec');
    expect(next?.dueDate?.toISOString()).toBe('2031-03-17T00:00:00.000Z');

    // The new occurrence is announced like any created task. In conformance mode
    // the spy sees the TypeScript run's event, whose new id is its own; the
    // harness compares both runs' events itself.
    expect(published('created')).toHaveLength(1);
    if (!conformanceTarget()) expect(published('created').map((call) => call.entityId)).toEqual([next?.id]);
  });

  it('does not spawn again when done is sent twice, or from a reorder inside Done', async () => {
    await seedRepeating('task_rec_2');
    expect((await send('PATCH', '/task_rec_2/status', { status: 'done' })).status).toBe(200);
    expect((await successors('Repeat task_rec_2')).filter((task) => task.status === 'todo')).toHaveLength(1);

    const again = await send('PATCH', '/task_rec_2/status', { status: 'done' });
    expect(((await again.json()) as { data: { nextTaskId?: string } }).data.nextTaskId).toBeUndefined();
    const reorder = await send('PATCH', '/task_rec_2/position', { position: 3, status: 'done' });
    expect(((await reorder.json()) as { data: { nextTaskId?: string } }).data.nextTaskId).toBeUndefined();
    const stale = await send('PATCH', '/task_rec_2/toggle', { currentStatus: 'todo' });
    expect(((await stale.json()) as { data: { nextTaskId?: string } }).data.nextTaskId).toBeUndefined();

    expect((await successors('Repeat task_rec_2')).filter((task) => task.status === 'todo')).toHaveLength(1);
  });

  it('two concurrent completions spawn one occurrence and publish `completed` once', async () => {
    await seedRepeating('task_rec_race');
    mockedPublish.mockClear();

    const responses = await Promise.all([
      send('PATCH', '/task_rec_race/status', { status: 'done' }),
      send('PATCH', '/task_rec_race/status', { status: 'done' }),
      send('PATCH', '/task_rec_race/toggle', { currentStatus: 'todo' }),
      send('PATCH', '/task_rec_race/position', { position: 2, status: 'done' }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    const spawned = await Promise.all(
      responses.map(async (res) => ((await res.json()) as { data: { nextTaskId?: string } }).data.nextTaskId),
    );
    expect(spawned.filter(Boolean)).toHaveLength(1);
    expect((await successors('Repeat task_rec_race')).filter((task) => task.id !== 'task_rec_race')).toHaveLength(1);
    expect(published('completed').filter((call) => call.entityId === 'task_rec_race')).toHaveLength(1);
    // The loser requests did not overwrite the winner's completion.
    expect((await row('task_rec_race'))?.status).toBe('done');
  });

  it('done → todo → done does not stack a second open occurrence', async () => {
    await seedRepeating('task_rec_3');
    await send('PATCH', '/task_rec_3/status', { status: 'done' });
    await send('PATCH', '/task_rec_3/status', { status: 'todo' });
    const second = await send('PATCH', '/task_rec_3/status', { status: 'done' });
    expect(((await second.json()) as { data: { nextTaskId?: string } }).data.nextTaskId).toBeUndefined();
    expect((await successors('Repeat task_rec_3')).filter((task) => task.id !== 'task_rec_3')).toHaveLength(1);
  });

  it('repeats personal and CRM tasks that have no project', async () => {
    await seedTask({
      id: 'task_rec_personal',
      title: 'Personal repeat',
      status: 'todo',
      dueDate: new Date('2031-03-10T00:00:00.000Z'),
      repeat: { frequency: 'daily' },
      customerId: 'cust_rec',
    });
    const res = await send('PATCH', '/task_rec_personal/toggle', { currentStatus: 'todo' });
    const nextId = ((await res.json()) as { data: { nextTaskId?: string } }).data.nextTaskId;
    expect(nextId).toBeDefined();
    const next = await row(nextId!);
    expect(next?.projectId).toBeNull();
    expect(next?.customerId).toBe('cust_rec');
    expect(next?.dueDate?.toISOString()).toBe('2031-03-11T00:00:00.000Z');
  });

  it('a PATCH to done spawns the next occurrence too, with the new fields', async () => {
    await seedRepeating('task_rec_patch');
    const res = await send('PATCH', '/task_rec_patch', { status: 'done', title: 'Renamed repeat' });
    const nextId = ((await res.json()) as { data: { nextTaskId?: string } }).data.nextTaskId;
    expect(nextId).toBeDefined();
    expect((await row(nextId!))?.title).toBe('Renamed repeat');
  });

  it('publishes project_task.completed once per not-done → done transition, on every path', async () => {
    await seedTask({ id: 'task_ev_patch', projectId: 'proj_rec', status: 'todo' });
    await seedTask({ id: 'task_ev_status', projectId: 'proj_rec', status: 'todo' });
    await seedTask({ id: 'task_ev_toggle', projectId: 'proj_rec', status: 'todo' });
    await seedTask({ id: 'task_ev_position', projectId: 'proj_rec', status: 'todo' });
    mockedPublish.mockClear();

    await send('PATCH', '/task_ev_patch', { status: 'done' });
    await send('PATCH', '/task_ev_status', { status: 'done' });
    await send('PATCH', '/task_ev_toggle/toggle', { currentStatus: 'todo' });
    await send('PATCH', '/task_ev_position/position', { status: 'done', position: 1 });
    expect(published('completed').map((call) => call.entityId).sort()).toEqual([
      'task_ev_patch',
      'task_ev_position',
      'task_ev_status',
      'task_ev_toggle',
    ]);

    // Repeating the completion publishes nothing new; `updated` keeps firing as before.
    mockedPublish.mockClear();
    await send('PATCH', '/task_ev_status', { status: 'done' });
    await send('PATCH', '/task_ev_position/position', { status: 'done', position: 2 });
    expect(published('completed')).toEqual([]);
    expect(published('updated')).toHaveLength(2);
  });
});

describe('moving a subtask (TASK-780)', () => {
  const flagsOn = {
    isOn: async () => true,
    getValue: async () => true,
  } as unknown as NonNullable<import('../../types').Variables['flags']>;

  it('lists the moved subtask at the top level of the destination project', async () => {
    await seedProject('proj_mvl_src');
    await seedProject('proj_mvl_dst');
    await seedTask({ id: 'task_mvl_parent', projectId: 'proj_mvl_src' });
    await seedTask({ id: 'task_mvl_child', projectId: 'proj_mvl_src', parentTaskId: 'task_mvl_parent' });

    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:read', 'tasks:update', 'projects:scope:all'), tenantDb: db, flags: flagsOn },
    });
    const moved = await request('/api/tasks/task_mvl_child/move', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ projectId: 'proj_mvl_dst' }),
    });
    expect(moved.status).toBe(200);

    const list = await request('/api/tasks?projectId=proj_mvl_dst');
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.map((task) => task.id)).toEqual(['task_mvl_child']);
  });
});

describe('deleting a task (TASK-779)', () => {
  it('soft-deletes the comments and attachments of the task and its subtasks, and keeps time entries', async () => {
    await seedProject('proj_del_rel');
    await seedTask({ id: 'task_dr_parent', projectId: 'proj_del_rel' });
    await seedTask({ id: 'task_dr_child', projectId: 'proj_del_rel', parentTaskId: 'task_dr_parent' });
    await seedTask({ id: 'task_dr_other', projectId: 'proj_del_rel' });

    for (const [id, taskId] of [
      ['tcmt_dr_1', 'task_dr_parent'],
      ['tcmt_dr_2', 'task_dr_child'],
      ['tcmt_dr_keep', 'task_dr_other'],
    ] as const) {
      await db.insert(schema.taskComments).values({
        id,
        taskId,
        taskType: 'project',
        content: 'hi',
        authorId: ME,
      } as typeof schema.taskComments.$inferInsert);
    }
    for (const [id, entityId] of [
      ['fil_dr_1', 'task_dr_parent'],
      ['fil_dr_2', 'task_dr_child'],
      ['fil_dr_keep', 'task_dr_other'],
    ] as const) {
      await db.insert(schema.files).values({
        id,
        fileName: `${id}.txt`,
        mimeType: 'text/plain',
        fileSize: 1,
        storagePath: `k/${id}`,
        entityType: 'task',
        entityId,
      } as typeof schema.files.$inferInsert);
    }
    await db.insert(schema.timeEntries).values({
      id: 'te_dr_1',
      projectId: 'proj_del_rel',
      taskId: 'task_dr_parent',
      userId: ME,
      date: '2031-01-01',
      duration: '60',
    } as typeof schema.timeEntries.$inferInsert);

    expect((await send('DELETE', '/task_dr_parent')).status).toBe(204);

    const deleted = async (table: typeof schema.taskComments | typeof schema.files, id: string) => {
      const [found] = await db.select().from(table).where(eq(table.id, id)).limit(1);
      return found?.deletedAt ?? null;
    };
    expect(await deleted(schema.taskComments, 'tcmt_dr_1')).not.toBeNull();
    expect(await deleted(schema.taskComments, 'tcmt_dr_2')).not.toBeNull();
    expect(await deleted(schema.taskComments, 'tcmt_dr_keep')).toBeNull();
    expect(await deleted(schema.files, 'fil_dr_1')).not.toBeNull();
    expect(await deleted(schema.files, 'fil_dr_2')).not.toBeNull();
    expect(await deleted(schema.files, 'fil_dr_keep')).toBeNull();

    const [entry] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, 'te_dr_1')).limit(1);
    expect(entry?.deletedAt).toBeNull();
  });
});

describe('reorder (TASK-795)', () => {
  it('reorderedPositions swaps tasks into each other’s slots in the requested order', () => {
    const rows = [
      { id: 'a', position: 3 },
      { id: 'b', position: 7 },
      { id: 'c', position: 9 },
    ];
    const result = reorderedPositions(rows, ['c', 'a', 'b']);
    expect([...result]).toEqual([
      ['c', 3],
      ['a', 7],
      ['b', 9],
    ]);
  });

  it('reorderedPositions spreads rows that share a position and skips unknown ids', () => {
    const result = reorderedPositions(
      [
        { id: 'a', position: 0 },
        { id: 'b', position: 0 },
        { id: 'c', position: 0 },
      ],
      ['b', 'ghost', 'c', 'a', 'b'],
    );
    expect([...result]).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('reorderedPositionsByProject reuses the slots of each project on its own', () => {
    const rows = [
      { id: 'a1', projectId: 'A', position: 1 },
      { id: 'b1', projectId: 'B', position: 10 },
      { id: 'a2', projectId: 'A', position: 2 },
      { id: 'b2', projectId: 'B', position: 20 },
      { id: 'p1', projectId: null, position: 5 },
      { id: 'p2', projectId: null, position: 6 },
    ];
    const result = reorderedPositionsByProject(rows, ['b2', 'a2', 'p2', 'b1', 'a1', 'p1']);
    expect(Object.fromEntries(result)).toEqual({ a2: 1, a1: 2, b2: 10, b1: 20, p2: 5, p1: 6 });
  });

  it('a reorder without projectId groups tasks by project: positions never cross projects', async () => {
    await seedProject('proj_ro_one');
    await seedProject('proj_ro_two');
    await seedTask({ id: 'task_rm_a1', projectId: 'proj_ro_one', position: 1 });
    await seedTask({ id: 'task_rm_b1', projectId: 'proj_ro_two', position: 100 });
    await seedTask({ id: 'task_rm_a2', projectId: 'proj_ro_one', position: 2 });
    await seedTask({ id: 'task_rm_b2', projectId: 'proj_ro_two', position: 200 });
    await seedTask({ id: 'task_rm_other', projectId: 'proj_ro_two', position: 150 }); // not in the list

    const res = await send('PATCH', '/reorder', {
      taskIds: ['task_rm_b2', 'task_rm_a2', 'task_rm_b1', 'task_rm_a1'],
    });
    expect(res.status).toBe(200);

    const position = async (id: string) => (await row(id))?.position;
    expect(await position('task_rm_a2')).toBe(1);
    expect(await position('task_rm_a1')).toBe(2);
    expect(await position('task_rm_b2')).toBe(100);
    expect(await position('task_rm_b1')).toBe(200);
    expect(await position('task_rm_other')).toBe(150);
  });

  it('keeps the dropped order after a reload and never lands on another task’s position', async () => {
    await seedProject('proj_reorder');
    await seedTask({ id: 'task_ro_a', projectId: 'proj_reorder', position: 1 });
    await seedTask({ id: 'task_ro_x', projectId: 'proj_reorder', position: 2 });
    await seedTask({ id: 'task_ro_b', projectId: 'proj_reorder', position: 3 });
    await seedTask({ id: 'task_ro_y', projectId: 'proj_reorder', position: 4 });
    await seedTask({ id: 'task_ro_c', projectId: 'proj_reorder', position: 5 });

    // A partial list (only the caller's rows, as My Tasks sends): c, a, b.
    const res = await send('PATCH', '/reorder?projectId=proj_reorder', {
      taskIds: ['task_ro_c', 'task_ro_a', 'task_ro_b'],
    });
    expect(res.status).toBe(200);

    const list = await send('GET', '?projectId=proj_reorder&sortField=position&sortDirection=asc');
    const ids = ((await list.json()) as { data: { id: string }[] }).data.map((task) => task.id);
    expect(ids).toEqual(['task_ro_c', 'task_ro_x', 'task_ro_a', 'task_ro_y', 'task_ro_b']);

    const positions = (await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, 'proj_reorder'))).map(
      (task) => task.position,
    );
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('refuses a reorder that includes a task of a project the caller cannot write', async () => {
    await seedProject('proj_reorder_locked');
    await seedTask({ id: 'task_ro_locked', projectId: 'proj_reorder_locked' });
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:update'), tenantDb: db },
    });
    const res = await request('/api/tasks/reorder', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ taskIds: ['task_ro_locked'] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('due-date buckets in the workspace time zone (TASK-790)', () => {
  // Auckland is UTC+13 in January: its local midnight is 11:00Z the day before,
  // so a UTC-midnight cut would call a task due "today" overdue.
  it('buckets "due today" by the workspace day, not the UTC day', async () => {
    await db.insert(schema.workspaceSettings).values({
      id: 'wss_tz',
      timezone: 'Pacific/Auckland',
    } as typeof schema.workspaceSettings.$inferInsert);

    const { dayBoundsInTimezone } = await import('@weldsuite/flow-domain/day-boundaries');
    const bounds = dayBoundsInTimezone('Pacific/Auckland');
    const justAfterMidnight = new Date(bounds.startOfToday.getTime() + 60 * 1000);
    const justBeforeMidnight = new Date(bounds.startOfToday.getTime() - 60 * 1000);
    await seedTask({ id: 'task_tz_today', dueDate: justAfterMidnight });
    await seedTask({ id: 'task_tz_yesterday', dueDate: justBeforeMidnight });

    const ids = async (bucket: string) =>
      (
        (await (await send('GET', `?dueDateBucket=${bucket}&limit=200`)).json()) as {
          data: { id: string }[];
        }
      ).data.map((task) => task.id);

    expect(await ids('today')).toContain('task_tz_today');
    expect(await ids('today')).not.toContain('task_tz_yesterday');
    expect(await ids('overdue')).toContain('task_tz_yesterday');
    expect(await ids('overdue')).not.toContain('task_tz_today');

    // My Tasks uses the same boundaries.
    const { request } = createTestApp('/api/my-tasks', myTasksRoutes, {
      context: { permissions: permissions('tasks:read'), tenantDb: db },
    });
    await seedTask({ id: 'task_tz_mine', assigneeId: ME, dueDate: justAfterMidnight });
    const mine = await request('/api/my-tasks?dueDateBucket=today');
    const mineIds = ((await mine.json()) as { data: { id: string }[] }).data.map((task) => task.id);
    expect(mineIds).toContain('task_tz_mine');
  });
});

describe('search (TASK-789)', () => {
  it('My Tasks finds a task regardless of case and treats % and _ literally', async () => {
    await seedTask({ id: 'task_srch_1', title: 'Alpha Launch', assigneeId: ME });
    await seedTask({ id: 'task_srch_2', title: '50% off banner', assigneeId: ME });
    await seedTask({ id: 'task_srch_3', title: 'Other thing', assigneeId: ME });
    const { request } = createTestApp('/api/my-tasks', myTasksRoutes, {
      context: { permissions: permissions('tasks:read'), tenantDb: db },
    });
    const ids = async (search: string) =>
      (
        (await (await request(`/api/my-tasks?search=${encodeURIComponent(search)}&pageSize=100`)).json()) as {
          data: { id: string }[];
        }
      ).data.map((task) => task.id);

    expect(await ids('alpha')).toEqual(['task_srch_1']);
    expect(await ids('50%')).toEqual(['task_srch_2']);
    expect(await ids('%')).toEqual(['task_srch_2']);
    expect(await ids('_')).toEqual([]);
  });

  it('the tasks list treats % literally too', async () => {
    const res = await send('GET', `?search=${encodeURIComponent('%')}&limit=200`);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((task) => task.id);
    expect(ids).toContain('task_srch_2');
    expect(ids).not.toContain('task_srch_3');
  });
});

describe('task attachments keep to this workspace (TASK-620)', () => {
  const attach = (taskId: string, fileKey: string) =>
    send('POST', `/${taskId}/attachments`, { fileName: 'a.pdf', fileKey, fileSize: 1, mimeType: 'application/pdf' });

  it("stores one of this workspace's uploads", async () => {
    await seedProject('proj_att_scope');
    await seedTask({ id: 'task_att_scope', projectId: 'proj_att_scope' });
    const key = 'workspaces/org_test_default/tasks/task_att_scope/1_abc/a.pdf';
    const res = await attach('task_att_scope', key);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { fileKey: string } }).data.fileKey).toBe(key);
  });

  it.each([
    ['foreign', 'workspaces/org_victim/drive/general/1_abc/payroll.pdf'],
    ['traversal', 'workspaces/org_test_default/../org_victim/payroll.pdf'],
    ['unscoped', 'payroll.pdf'],
  ])('refuses a %s key and stores nothing', async (name, fileKey) => {
    await seedProject(`proj_att_${name}`);
    await seedTask({ id: `task_att_${name}`, projectId: `proj_att_${name}` });
    const res = await attach(`task_att_${name}`, fileKey);
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.files).where(eq(schema.files.fileKey, fileKey));
    expect(rows).toHaveLength(0);
  });
});

describe('task attachments: removal', () => {
  it('soft-deletes an attachment of the task, and nothing of another task', async () => {
    await seedProject('proj_att_rm');
    await seedTask({ id: 'task_att_rm', projectId: 'proj_att_rm' });
    await seedTask({ id: 'task_att_rm_other', projectId: 'proj_att_rm' });
    const key = 'workspaces/org_test_default/tasks/task_att_rm/1_abc/a.pdf';
    const created = await send('POST', '/task_att_rm/attachments', {
      fileName: 'a.pdf',
      fileKey: key,
      fileSize: 1,
      mimeType: 'application/pdf',
    });
    const { data } = (await created.json()) as { data: { id: string } };

    expect((await send('DELETE', `/task_att_rm_other/attachments/${data.id}`)).status).toBe(404);
    expect((await send('DELETE', `/task_att_missing/attachments/${data.id}`)).status).toBe(404);
    expect((await send('DELETE', `/task_att_rm/attachments/${data.id}`)).status).toBe(204);
    const [file] = await db.select().from(schema.files).where(eq(schema.files.id, data.id));
    expect(file?.deletedAt).not.toBeNull();
    expect((await send('DELETE', `/task_att_rm/attachments/${data.id}`)).status).toBe(404);
  });
});

describe('GET /api/tasks/:id/subtasks', () => {
  it('lists the direct subtasks in position order with their own subtask counts', async () => {
    await seedProject('proj_sub_list');
    await seedTask({ id: 'task_sub_parent', projectId: 'proj_sub_list' });
    await seedTask({ id: 'task_sub_b', projectId: 'proj_sub_list', parentTaskId: 'task_sub_parent', position: 2 });
    await seedTask({ id: 'task_sub_a', projectId: 'proj_sub_list', parentTaskId: 'task_sub_parent', position: 1 });
    await seedTask({ id: 'task_sub_a1', projectId: 'proj_sub_list', parentTaskId: 'task_sub_a', status: 'done' });
    await seedTask({ id: 'task_sub_a2', projectId: 'proj_sub_list', parentTaskId: 'task_sub_a' });
    await seedTask({ id: 'task_sub_gone', projectId: 'proj_sub_list', parentTaskId: 'task_sub_parent', deletedAt: now });

    const res = await send('GET', '/task_sub_parent/subtasks');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { id: string; subtaskCount: number; completedSubtaskCount: number }[];
    };
    expect(data.map((task) => task.id)).toEqual(['task_sub_a', 'task_sub_b']);
    expect(data[0]).toMatchObject({ subtaskCount: 2, completedSubtaskCount: 1 });
    expect(data[1]).toMatchObject({ subtaskCount: 0, completedSubtaskCount: 0 });

    expect((await send('GET', '/task_sub_missing/subtasks')).status).toBe(404);
    const empty = await send('GET', '/task_sub_b/subtasks');
    expect(((await empty.json()) as { data: unknown[] }).data).toEqual([]);
  });
});
