/**
 * Route tests for WeldHR onboarding and offboarding: /checklist-templates and
 * /checklists, against a real pglite tenant database through the whole
 * /api/weldhr router.
 *
 * These are the requests the Rust port (rust/modules/hr) is compared on in
 * conformance mode, refusals included.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  HR_ADMIN,
  daysFromToday,
  data,
  errorOf,
  hrCaller,
  hrDb,
  resetHr,
  seedCompany,
  seedEmployee,
  seedMember,
} from '../../test/hr-fixtures';

let db: Database;

const STARTER_TEMPLATES = ['hrctp_default_onboarding', 'hrctp_default_offboarding'];

beforeAll(async () => {
  db = await hrDb();
  // Seed the starter templates before any test adds its own: the first
  // request only seeds an empty table.
  await hrCaller(db).get('/checklist-templates');
}, 60_000);

beforeEach(async () => {
  await resetHr(db);
  // A test that makes its own template the default clears the starters' flag.
  await db
    .update(schema.hrChecklistTemplates)
    .set({ isDefault: true })
    .where(inArray(schema.hrChecklistTemplates.id, STARTER_TEMPLATES));
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_mia', { name: 'Mia Manager', email: 'mia@example.com' });
  await seedMember(db, 'user_ann', { name: 'Ann Agent', email: 'ann@example.com' });
  await seedEmployee(db, { id: 'hremp_mia', userId: 'user_mia', email: 'mia@example.com', firstName: 'Mia', lastName: 'Manager', startDate: '2024-01-01' });
  await seedEmployee(db, {
    id: 'hremp_ann',
    userId: 'user_ann',
    email: 'ann@example.com',
    firstName: 'Ann',
    lastName: 'Agent',
    preferredName: 'Annie',
    status: 'onboarding',
    startDate: daysFromToday(7),
    managerId: 'hremp_mia',
  });
  await seedEmployee(db, { id: 'hremp_bo', email: 'bo@example.com', firstName: 'Bo', lastName: 'Berg', managerId: 'hremp_mia' });
  await db.insert(schema.hrChecklistTemplates).values([
    {
      id: 'hrctp_on1',
      name: 'Short onboarding',
      kind: 'onboarding',
      items: [
        { id: 'a', title: 'Sign contract', assigneeRole: 'hr', dueOffsetDays: -3, visibleToEmployee: false },
        { id: 'b', title: 'Meet the team', description: 'Coffee first', assigneeRole: 'manager', dueOffsetDays: 0, visibleToEmployee: true },
        { id: 'c', title: 'Fill in your profile', assigneeRole: 'employee', dueOffsetDays: 1, visibleToEmployee: true },
      ],
      createdAt: new Date('2026-01-05T09:00:00.000Z'),
      updatedAt: new Date('2026-01-05T09:00:00.000Z'),
    },
    {
      id: 'hrctp_off1',
      name: 'Short offboarding',
      kind: 'offboarding',
      items: [{ id: 'x', title: 'Return laptop', assigneeRole: 'employee', dueOffsetDays: 0, visibleToEmployee: true }],
      createdAt: new Date('2026-01-05T09:00:00.000Z'),
      updatedAt: new Date('2026-01-05T09:00:00.000Z'),
    },
  ]);
});

const admin = () => hrCaller(db);
const as = (...grants: string[]) => hrCaller(db, { grants });

interface TaskBody {
  id: string;
  title: string;
  dueDate: string | null;
  sortOrder: number;
  assigneeUserId: string | null;
  assigneeName: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
}

interface ChecklistBody {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: string;
  status: string;
  anchorDate: string | null;
  tasks: TaskBody[];
  progress: { done: number; total: number };
}

async function checklistsOf(employeeId: string): Promise<ChecklistBody[]> {
  const res = await admin().get(`/checklists?employeeId=${employeeId}`);
  expect(res.status).toBe(200);
  return data<ChecklistBody[]>(res);
}

async function start(employeeId: string, templateId: string, extra: Record<string, unknown> = {}) {
  const res = await admin().send('POST', '/checklists', { employeeId, templateId, ...extra });
  expect(res.status).toBe(201);
  return data<{ id: string; status: string; anchorDate: string }>(res);
}

async function employeeRow(id: string) {
  const [row] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, id));
  return row!;
}

async function checklistRow(id: string) {
  const [row] = await db.select().from(schema.hrChecklists).where(eq(schema.hrChecklists.id, id));
  return row;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe('/checklist-templates', () => {
  it('lists the starter templates and the workspace’s own, by kind then name', async () => {
    await db.insert(schema.hrChecklistTemplates).values({
      id: 'hrctp_gone',
      name: 'Removed',
      kind: 'onboarding',
      deletedAt: new Date('2026-01-06T00:00:00.000Z'),
    });
    const res = await admin().get('/checklist-templates');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; isDefault: boolean; items: unknown[] }>>(res);
    expect(rows.map((r) => r.id)).toEqual(['hrctp_off1', 'hrctp_default_offboarding', 'hrctp_on1', 'hrctp_default_onboarding']);
    expect(rows.find((r) => r.id === 'hrctp_default_onboarding')).toMatchObject({ isDefault: true });
    expect(rows.find((r) => r.id === 'hrctp_default_onboarding')!.items).toHaveLength(8);

    const onboarding = await data<Array<{ id: string }>>(await admin().get('/checklist-templates?kind=onboarding'));
    expect(onboarding.map((r) => r.id)).toEqual(['hrctp_on1', 'hrctp_default_onboarding']);
    expect((await as('leave:read').get('/checklist-templates')).status).toBe(403);
  });

  it('creates a template, and a new default takes the flag from the old one', async () => {
    const res = await admin().send('POST', '/checklist-templates', {
      name: '  Agent onboarding ',
      description: 'For contact-centre agents',
      kind: 'onboarding',
      items: [{ id: 'i1', title: 'Headset', assigneeRole: 'it', dueOffsetDays: -2, visibleToEmployee: false }],
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      name: 'Agent onboarding',
      description: 'For contact-centre agents',
      kind: 'onboarding',
      departmentId: null,
      isDefault: false,
      deletedAt: null,
      items: [{ id: 'i1', title: 'Headset', assigneeRole: 'it', dueOffsetDays: -2, visibleToEmployee: false }],
    });

    const preferred = await admin().send('POST', '/checklist-templates', { name: 'Exit', kind: 'offboarding', items: [], isDefault: true });
    expect(preferred.status).toBe(201);
    const exit = await data<{ id: string; isDefault: boolean }>(preferred);
    expect(exit.isDefault).toBe(true);
    const offboarding = await data<Array<{ id: string; isDefault: boolean }>>(await admin().get('/checklist-templates?kind=offboarding'));
    expect(offboarding.filter((r) => r.isDefault).map((r) => r.id)).toEqual([exit.id]);
    // The other kind keeps its default.
    const onboarding = await data<Array<{ id: string; isDefault: boolean }>>(await admin().get('/checklist-templates?kind=onboarding'));
    expect(onboarding.filter((r) => r.isDefault).map((r) => r.id)).toEqual(['hrctp_default_onboarding']);
  });

  it('validates the body and needs employees:manage', async () => {
    const res = await admin().send('POST', '/checklist-templates', {
      name: '',
      kind: 'midboarding',
      items: [{ id: 'i1', title: 'X', assigneeRole: 'hr', dueOffsetDays: 400, visibleToEmployee: true }],
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe(
      'Name is required. Kind must be one of onboarding, offboarding. Items #1 due offset days must be at most 365',
    );
    expect((await as('employees:update').send('POST', '/checklist-templates', { name: 'X', kind: 'onboarding', items: [] })).status).toBe(403);
  });

  it('updates a template and moves the default flag within its kind', async () => {
    const res = await admin().send('PATCH', '/checklist-templates/hrctp_on1', {
      name: 'Shorter onboarding',
      items: [{ id: 'a', title: 'Sign contract', assigneeRole: 'hr', dueOffsetDays: -5, visibleToEmployee: false }],
      isDefault: true,
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrctp_on1', name: 'Shorter onboarding', isDefault: true, kind: 'onboarding' });
    const [starter] = await db.select().from(schema.hrChecklistTemplates).where(eq(schema.hrChecklistTemplates.id, 'hrctp_default_onboarding'));
    expect(starter!.isDefault).toBe(false);
    const [offStarter] = await db.select().from(schema.hrChecklistTemplates).where(eq(schema.hrChecklistTemplates.id, 'hrctp_default_offboarding'));
    expect(offStarter!.isDefault).toBe(true);

    expect((await admin().send('PATCH', '/checklist-templates/hrctp_nope', { name: 'X' })).status).toBe(404);
    const invalid = await admin().send('PATCH', '/checklist-templates/hrctp_on1', { items: [{ id: 'a' }] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Items #1 title is required. Items #1 assignee role is required. Items #1 due offset days is required. Items #1 visible to employee is required',
    );
    expect((await as('employees:update').send('PATCH', '/checklist-templates/hrctp_on1', { name: 'X' })).status).toBe(403);
  });

  it('deletes a template softly', async () => {
    expect((await as('employees:update').send('DELETE', '/checklist-templates/hrctp_on1')).status).toBe(403);
    expect((await admin().send('DELETE', '/checklist-templates/hrctp_on1')).status).toBe(204);
    const rows = await data<Array<{ id: string }>>(await admin().get('/checklist-templates'));
    expect(rows.map((r) => r.id)).not.toContain('hrctp_on1');
    expect((await admin().send('DELETE', '/checklist-templates/hrctp_on1')).status).toBe(404);
    expect((await admin().send('PATCH', '/checklist-templates/hrctp_on1', { name: 'Back' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

describe('POST /checklists', () => {
  it('starts onboarding with due dates from the start date and assignees by role', async () => {
    const checklist = await start('hremp_ann', 'hrctp_on1');
    expect(checklist).toMatchObject({
      employeeId: 'hremp_ann',
      templateId: 'hrctp_on1',
      kind: 'onboarding',
      name: 'Short onboarding',
      status: 'in_progress',
      anchorDate: daysFromToday(7),
      startedBy: HR_ADMIN,
      completedAt: null,
    });

    const [listed] = await checklistsOf('hremp_ann');
    expect(listed).toMatchObject({ id: checklist.id, employeeName: 'Annie Agent', progress: { done: 0, total: 3 } });
    expect(listed!.tasks.map((t) => [t.title, t.sortOrder, t.dueDate, t.assigneeUserId, t.assigneeName])).toEqual([
      ['Sign contract', 0, daysFromToday(4), null, null],
      ['Meet the team', 1, daysFromToday(7), 'user_mia', 'Mia Manager'],
      ['Fill in your profile', 2, daysFromToday(8), 'user_ann', 'Ann Agent'],
    ]);
    // Still onboarding: starting onboarding never moves someone who is onboarding.
    expect((await employeeRow('hremp_ann')).status).toBe('onboarding');
  });

  it('anchors on the given date, and moves someone on leave back to onboarding', async () => {
    await db.update(schema.hrEmployees).set({ status: 'on_leave' }).where(eq(schema.hrEmployees.id, 'hremp_bo'));
    const checklist = await start('hremp_bo', 'hrctp_on1', { anchorDate: '2026-03-02' });
    expect(checklist.anchorDate).toBe('2026-03-02');
    expect((await employeeRow('hremp_bo')).status).toBe('onboarding');
    const [listed] = await checklistsOf('hremp_bo');
    expect(listed!.tasks.map((t) => t.dueDate)).toEqual(['2026-02-27', '2026-03-02', '2026-03-03']);
  });

  it('refuses a second checklist of the same kind, an unknown employee or template, and bad input', async () => {
    await start('hremp_ann', 'hrctp_on1');
    const second = await admin().send('POST', '/checklists', { employeeId: 'hremp_ann', templateId: 'hrctp_default_onboarding' });
    expect(second.status).toBe(409);
    expect((await errorOf(second)).message).toBe('This employee already has an onboarding checklist in progress');

    expect((await admin().send('POST', '/checklists', { employeeId: 'hremp_nope', templateId: 'hrctp_on1' })).status).toBe(404);
    const template = await admin().send('POST', '/checklists', { employeeId: 'hremp_bo', templateId: 'hrctp_nope' });
    expect(template.status).toBe(404);
    expect((await errorOf(template)).code).toBe('NOT_FOUND');

    const invalid = await admin().send('POST', '/checklists', { anchorDate: '02-03-2026' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Template id is required. Anchor date: Expected YYYY-MM-DD. Employee id is required');
    expect((await as('employees:read', 'employees:create').send('POST', '/checklists', { employeeId: 'hremp_bo', templateId: 'hrctp_on1' })).status).toBe(403);
  });

  it('offboarding refuses someone who has not started without force, and needs a last working day', async () => {
    const early = await admin().send('POST', '/checklists', { employeeId: 'hremp_ann', templateId: 'hrctp_off1', anchorDate: daysFromToday(20) });
    expect(early.status).toBe(409);
    expect((await errorOf(early)).message).toBe(
      'This employee has not started yet (still onboarding or a start date in the future). Send force: true to offboard them anyway',
    );

    const noDate = await admin().send('POST', '/checklists', { employeeId: 'hremp_bo', templateId: 'hrctp_off1' });
    expect(noDate.status).toBe(400);
    expect((await errorOf(noDate)).message).toBe(
      "Set the last working day (anchorDate) or the employee's end date before starting offboarding",
    );

    const forced = await start('hremp_ann', 'hrctp_off1', { anchorDate: daysFromToday(20), force: true });
    expect(forced).toMatchObject({ status: 'in_progress', anchorDate: daysFromToday(20) });
    expect((await employeeRow('hremp_ann')).status).toBe('offboarding');

    // The employee's own end date is the anchor when none is given.
    await db.update(schema.hrEmployees).set({ endDate: daysFromToday(30) }).where(eq(schema.hrEmployees.id, 'hremp_bo'));
    expect((await start('hremp_bo', 'hrctp_off1')).anchorDate).toBe(daysFromToday(30));
  });
});

describe('PATCH /checklists/tasks/:taskId', () => {
  it('ticking the last task completes onboarding and activates the employee; un-ticking reopens it', async () => {
    const checklist = await start('hremp_ann', 'hrctp_on1');
    const [listed] = await checklistsOf('hremp_ann');
    const [first, second, third] = listed!.tasks;

    const one = await admin().send('PATCH', `/checklists/tasks/${first!.id}`, { completed: true });
    expect(one.status).toBe(200);
    const oneBody = await data<{ task: TaskBody; outcome: unknown }>(one);
    expect(oneBody.task).toMatchObject({ id: first!.id, completedBy: HR_ADMIN });
    expect(oneBody.task.completedAt).not.toBeNull();
    expect(oneBody.outcome).toEqual({ checklistCompleted: false, kind: 'onboarding', employeeId: 'hremp_ann', employeeStatus: null });

    const renamed = await admin().send('PATCH', `/checklists/tasks/${second!.id}`, { title: 'Meet the whole team', completed: true, dueDate: daysFromToday(9) });
    expect((await data<{ task: TaskBody }>(renamed)).task).toMatchObject({ title: 'Meet the whole team', dueDate: daysFromToday(9) });

    const last = await admin().send('PATCH', `/checklists/tasks/${third!.id}`, { completed: true });
    expect(await data<{ outcome: unknown }>(last).then((b) => b.outcome)).toEqual({
      checklistCompleted: true,
      kind: 'onboarding',
      employeeId: 'hremp_ann',
      employeeStatus: 'active',
    });
    expect((await employeeRow('hremp_ann')).status).toBe('active');
    const [done] = await checklistsOf('hremp_ann');
    expect(done).toMatchObject({ id: checklist.id, status: 'completed', progress: { done: 3, total: 3 } });
    expect(done!.tasks[0]!.completedByName).toBe('Hanna Admin');

    const undone = await admin().send('PATCH', `/checklists/tasks/${third!.id}`, { completed: false });
    expect(await data<{ task: TaskBody; outcome: { checklistCompleted: boolean } }>(undone)).toMatchObject({
      task: { completedAt: null, completedBy: null },
      outcome: { checklistCompleted: false },
    });
    expect((await checklistRow(checklist.id))!.status).toBe('in_progress');
  });

  it('completing an offboarding terminates the employee and ends their client assignments', async () => {
    await seedCompany(db, 'co_acme', 'Acme');
    await db.insert(schema.hrClientAssignments).values([
      { id: 'hrasg_o1', employeeId: 'hremp_bo', companyId: 'co_acme', startDate: '2025-02-01' },
      { id: 'hrasg_o2', employeeId: 'hremp_bo', companyId: 'co_acme', startDate: '2025-01-01', endDate: '2025-01-31' },
    ]);
    const anchor = daysFromToday(14);
    await start('hremp_bo', 'hrctp_off1', { anchorDate: anchor });
    expect((await employeeRow('hremp_bo')).status).toBe('offboarding');
    const [listed] = await checklistsOf('hremp_bo');
    expect(listed!.tasks[0]).toMatchObject({ title: 'Return laptop', dueDate: anchor, assigneeUserId: null });

    const res = await admin().send('PATCH', `/checklists/tasks/${listed!.tasks[0]!.id}`, { completed: true });
    expect(res.status).toBe(200);
    expect((await data<{ outcome: unknown }>(res)).outcome).toEqual({
      checklistCompleted: true,
      kind: 'offboarding',
      employeeId: 'hremp_bo',
      employeeStatus: 'terminated',
    });
    const bo = await employeeRow('hremp_bo');
    expect(bo.status).toBe('terminated');
    expect(bo.endDate).toBe(anchor);
    const assignments = await db.select().from(schema.hrClientAssignments).where(eq(schema.hrClientAssignments.employeeId, 'hremp_bo'));
    expect(assignments.map((a) => [a.id, a.endDate]).sort()).toEqual([
      ['hrasg_o1', anchor],
      ['hrasg_o2', '2025-01-31'],
    ]);
  });

  it('is a 404 for an unknown task, validates the body and needs employees:update', async () => {
    await start('hremp_ann', 'hrctp_on1');
    const [listed] = await checklistsOf('hremp_ann');
    const taskId = listed!.tasks[0]!.id;
    expect((await admin().send('PATCH', '/checklists/tasks/hrtsk_nope', { completed: true })).status).toBe(404);
    const invalid = await admin().send('PATCH', `/checklists/tasks/${taskId}`, { dueDate: 'soon', assigneeRole: 'boss' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Assignee role must be one of hr, manager, it, employee, other. Due date: Expected YYYY-MM-DD',
    );
    expect((await as('employees:read').send('PATCH', `/checklists/tasks/${taskId}`, { completed: true })).status).toBe(403);
  });
});

describe('POST /checklists/:checklistId/tasks and DELETE /checklists/tasks/:taskId', () => {
  beforeEach(async () => {
    await db.insert(schema.hrChecklists).values({
      id: 'hrchk_c1',
      employeeId: 'hremp_mia',
      templateId: null,
      kind: 'onboarding',
      name: 'Done onboarding',
      status: 'completed',
      anchorDate: '2024-01-01',
      startedAt: new Date('2024-01-01T09:00:00.000Z'),
      completedAt: new Date('2024-01-10T09:00:00.000Z'),
    });
    await db.insert(schema.hrChecklistTasks).values({
      id: 'hrtsk_c1',
      checklistId: 'hrchk_c1',
      employeeId: 'hremp_mia',
      title: 'Welcome',
      completedAt: new Date('2024-01-10T09:00:00.000Z'),
      completedBy: HR_ADMIN,
    });
  });

  it('adding a task reopens a completed checklist; deleting the last open one completes it again', async () => {
    const res = await admin().send('POST', '/checklists/hrchk_c1/tasks', {
      title: 'Extra step',
      description: 'Added later',
      assigneeUserId: 'user_mia',
      dueDate: daysFromToday(3),
      visibleToEmployee: true,
    });
    expect(res.status).toBe(201);
    const task = await data<TaskBody & { checklistId: string; employeeId: string; assigneeRole: string; visibleToEmployee: boolean }>(res);
    expect(task).toMatchObject({
      checklistId: 'hrchk_c1',
      employeeId: 'hremp_mia',
      title: 'Extra step',
      assigneeRole: 'hr',
      assigneeUserId: 'user_mia',
      dueDate: daysFromToday(3),
      visibleToEmployee: true,
      sortOrder: 1,
      completedAt: null,
    });
    expect(await checklistRow('hrchk_c1')).toMatchObject({ status: 'in_progress', completedAt: null });

    expect((await admin().send('DELETE', `/checklists/tasks/${task.id}`)).status).toBe(204);
    expect((await checklistRow('hrchk_c1'))!.status).toBe('completed');
    // Mia is active already: completing her onboarding changes nothing about her.
    expect((await employeeRow('hremp_mia')).status).toBe('active');
    expect((await admin().send('DELETE', `/checklists/tasks/${task.id}`)).status).toBe(404);
  });

  it('refuses an unknown checklist, bad input and a caller without employees:update', async () => {
    expect((await admin().send('POST', '/checklists/hrchk_nope/tasks', { title: 'X' })).status).toBe(404);
    const invalid = await admin().send('POST', '/checklists/hrchk_c1/tasks', { title: '  ' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Title is required');
    expect((await as('employees:read').send('POST', '/checklists/hrchk_c1/tasks', { title: 'X' })).status).toBe(403);
    expect((await as('employees:read').send('DELETE', '/checklists/tasks/hrtsk_c1')).status).toBe(403);
  });
});

describe('POST /checklists/:checklistId/cancel and DELETE /checklists/:checklistId', () => {
  it('cancelling an offboarding puts the employee back to active, or to onboarding while that runs', async () => {
    const off = await start('hremp_bo', 'hrctp_off1', { anchorDate: daysFromToday(10) });
    const res = await admin().send('POST', `/checklists/${off.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: off.id, status: 'cancelled', kind: 'offboarding' });
    expect((await employeeRow('hremp_bo')).status).toBe('active');

    await start('hremp_ann', 'hrctp_on1');
    const annOff = await start('hremp_ann', 'hrctp_off1', { anchorDate: daysFromToday(20), force: true });
    expect((await employeeRow('hremp_ann')).status).toBe('offboarding');
    expect((await admin().send('POST', `/checklists/${annOff.id}/cancel`)).status).toBe(200);
    expect((await employeeRow('hremp_ann')).status).toBe('onboarding');
  });

  it('cancelling an onboarding leaves the employee alone', async () => {
    const on = await start('hremp_ann', 'hrctp_on1');
    const res = await admin().send('POST', `/checklists/${on.id}/cancel`);
    expect((await data<{ status: string }>(res)).status).toBe('cancelled');
    expect((await employeeRow('hremp_ann')).status).toBe('onboarding');
    expect((await admin().send('POST', '/checklists/hrchk_nope/cancel')).status).toBe(404);
    expect((await as('employees:read').send('POST', `/checklists/${on.id}/cancel`)).status).toBe(403);
  });

  it('deleting a checklist removes its tasks and restores the status', async () => {
    const off = await start('hremp_bo', 'hrctp_off1', { anchorDate: daysFromToday(10) });
    expect((await as('employees:read').send('DELETE', `/checklists/${off.id}`)).status).toBe(403);
    expect((await admin().send('DELETE', `/checklists/${off.id}`)).status).toBe(204);
    expect(await checklistRow(off.id)).toBeUndefined();
    expect(await db.select().from(schema.hrChecklistTasks).where(eq(schema.hrChecklistTasks.checklistId, off.id))).toHaveLength(0);
    expect((await employeeRow('hremp_bo')).status).toBe('active');
    expect((await admin().send('DELETE', `/checklists/${off.id}`)).status).toBe(404);
  });
});

describe('GET /checklists', () => {
  it('lists checklists newest first, filtered by status and kind, without deleted employees', async () => {
    await db.insert(schema.hrChecklists).values([
      { id: 'hrchk_l1', employeeId: 'hremp_mia', kind: 'onboarding', name: 'Old', status: 'completed', startedAt: new Date('2024-01-01T09:00:00.000Z') },
      { id: 'hrchk_l2', employeeId: 'hremp_bo', kind: 'offboarding', name: 'Leaving', status: 'in_progress', startedAt: new Date('2026-01-08T09:00:00.000Z') },
      { id: 'hrchk_l3', employeeId: 'hremp_ann', kind: 'onboarding', name: 'Starting', status: 'in_progress', startedAt: new Date('2026-01-07T09:00:00.000Z') },
    ]);
    await seedEmployee(db, { id: 'hremp_gone', email: 'gone@example.com', deletedAt: new Date('2026-01-09T00:00:00.000Z') });
    await db.insert(schema.hrChecklists).values({ id: 'hrchk_l4', employeeId: 'hremp_gone', kind: 'onboarding', name: 'Gone', startedAt: new Date('2026-01-09T09:00:00.000Z') });

    const all = await data<ChecklistBody[]>(await admin().get('/checklists'));
    expect(all.map((c) => [c.id, c.employeeName, c.progress.total])).toEqual([
      ['hrchk_l2', 'Bo Berg', 0],
      ['hrchk_l3', 'Annie Agent', 0],
      ['hrchk_l1', 'Mia Manager', 0],
    ]);
    const open = await data<ChecklistBody[]>(await admin().get('/checklists?status=in_progress&kind=onboarding'));
    expect(open.map((c) => c.id)).toEqual(['hrchk_l3']);
    expect(await data(await admin().get('/checklists?employeeId=hremp_nope'))).toEqual([]);
    expect((await as('leave:read').get('/checklists')).status).toBe(403);
  });
});
