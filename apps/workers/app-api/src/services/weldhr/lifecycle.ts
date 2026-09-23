/**
 * Onboarding and offboarding.
 *
 * A template is a list of items with a due offset in days. Starting a template
 * on an employee copies the items into real tasks with real due dates, so a
 * later template edit never rewrites a checklist that is already running.
 *
 * Finishing the last task closes the checklist and moves the employee along:
 * onboarding → `active`; offboarding → `terminated`, open client assignments
 * ended, portal access revoked.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HrChecklistTemplateItem } from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { endAssignmentsFor } from './assignments';
import { requireEmployee } from './employees';
import { HrConflictError, HrNotFoundError, addDays, memberNames, todayIso } from './shared';

const tpl = schema.hrChecklistTemplates;
const chk = schema.hrChecklists;
const tsk = schema.hrChecklistTasks;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(db: Database, kind?: string) {
  const conditions = [isNull(tpl.deletedAt)];
  if (kind) conditions.push(eq(tpl.kind, kind));
  return db.select().from(tpl).where(and(...conditions)).orderBy(asc(tpl.kind), asc(tpl.name));
}

export async function requireTemplate(db: Database, id: string) {
  const [row] = await db.select().from(tpl).where(and(eq(tpl.id, id), isNull(tpl.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Checklist template', id);
  return row;
}

type TemplateInput = {
  name?: string;
  description?: string | null;
  kind?: string;
  departmentId?: string | null;
  items?: HrChecklistTemplateItem[];
  isDefault?: boolean;
};

async function clearDefault(db: Database, kind: string, exceptId?: string) {
  const conditions = [eq(tpl.kind, kind), eq(tpl.isDefault, true)];
  if (exceptId) conditions.push(sql`${tpl.id} <> ${exceptId}`);
  await db.update(tpl).set({ isDefault: false, updatedAt: new Date() }).where(and(...conditions));
}

export async function createTemplate(db: Database, input: TemplateInput & { name: string; kind: string; items: HrChecklistTemplateItem[] }) {
  if (input.isDefault) await clearDefault(db, input.kind);
  const [row] = await db.insert(tpl).values({ id: generateId('hrctp'), ...input }).returning();
  return row!;
}

export async function updateTemplate(db: Database, id: string, input: TemplateInput) {
  const existing = await requireTemplate(db, id);
  if (input.isDefault) await clearDefault(db, input.kind ?? existing.kind, id);
  const [row] = await db.update(tpl).set({ ...input, updatedAt: new Date() }).where(eq(tpl.id, id)).returning();
  return row!;
}

export async function deleteTemplate(db: Database, id: string) {
  await requireTemplate(db, id);
  const now = new Date();
  await db.update(tpl).set({ deletedAt: now, updatedAt: now }).where(eq(tpl.id, id));
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export async function requireChecklist(db: Database, id: string) {
  const [row] = await db.select().from(chk).where(eq(chk.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Checklist', id);
  return row;
}

export async function requireTask(db: Database, id: string) {
  const [row] = await db.select().from(tsk).where(eq(tsk.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Checklist task', id);
  return row;
}

/** Checklists with their tasks, newest first. `employeeId` omitted → every open checklist. */
export async function listChecklists(db: Database, filters: { employeeId?: string; status?: string; kind?: string }) {
  const conditions = [];
  if (filters.employeeId) conditions.push(eq(chk.employeeId, filters.employeeId));
  if (filters.status) conditions.push(eq(chk.status, filters.status));
  if (filters.kind) conditions.push(eq(chk.kind, filters.kind));

  const checklists = await db
    .select({
      checklist: chk,
      firstName: schema.hrEmployees.firstName,
      lastName: schema.hrEmployees.lastName,
      preferredName: schema.hrEmployees.preferredName,
      startDate: schema.hrEmployees.startDate,
    })
    .from(chk)
    .innerJoin(schema.hrEmployees, eq(schema.hrEmployees.id, chk.employeeId))
    .where(and(isNull(schema.hrEmployees.deletedAt), ...conditions))
    .orderBy(desc(chk.startedAt));
  if (checklists.length === 0) return [];

  const tasks = await db
    .select()
    .from(tsk)
    .where(inArray(tsk.checklistId, checklists.map((c) => c.checklist.id)))
    .orderBy(asc(tsk.sortOrder), asc(tsk.dueDate));
  const names = await memberNames(db, tasks.flatMap((x) => [x.assigneeUserId, x.completedBy]));

  const byChecklist = new Map<string, Array<(typeof tasks)[number] & { assigneeName: string | null; completedByName: string | null }>>();
  for (const task of tasks) {
    const list = byChecklist.get(task.checklistId) ?? [];
    list.push({
      ...task,
      assigneeName: task.assigneeUserId ? names.get(task.assigneeUserId) ?? null : null,
      completedByName: task.completedBy
        ? task.completedBy.startsWith('portal:')
          ? null
          : names.get(task.completedBy) ?? null
        : null,
    });
    byChecklist.set(task.checklistId, list);
  }

  return checklists.map(({ checklist, firstName, lastName, preferredName }) => {
    const list = byChecklist.get(checklist.id) ?? [];
    const done = list.filter((x) => x.completedAt).length;
    return {
      ...checklist,
      employeeName: `${preferredName?.trim() || firstName} ${lastName}`.trim(),
      tasks: list,
      progress: { done, total: list.length },
    };
  });
}

export async function startChecklist(
  db: Database,
  employeeId: string,
  input: { templateId: string; anchorDate?: string },
  startedBy: string,
) {
  const employee = await requireEmployee(db, employeeId);
  const template = await requireTemplate(db, input.templateId);

  const [running] = await db
    .select({ id: chk.id })
    .from(chk)
    .where(and(eq(chk.employeeId, employeeId), eq(chk.kind, template.kind), eq(chk.status, 'in_progress')))
    .limit(1);
  if (running) throw new HrConflictError(`This employee already has an ${template.kind} checklist in progress`);

  const anchor =
    input.anchorDate ??
    (template.kind === 'onboarding' ? employee.startDate : employee.endDate) ??
    todayIso();

  const checklistId = generateId('hrchk');
  const [checklist] = await db
    .insert(chk)
    .values({
      id: checklistId,
      employeeId,
      templateId: template.id,
      kind: template.kind,
      name: template.name,
      status: 'in_progress',
      startedBy,
    })
    .returning();

  // "manager" items go straight to the employee's manager when they have a workspace login.
  let managerUserId: string | null = null;
  if (employee.managerId) {
    const [manager] = await db
      .select({ userId: schema.hrEmployees.userId })
      .from(schema.hrEmployees)
      .where(eq(schema.hrEmployees.id, employee.managerId))
      .limit(1);
    managerUserId = manager?.userId ?? null;
  }

  const items = template.items ?? [];
  if (items.length) {
    await db.insert(tsk).values(
      items.map((item, index) => ({
        id: generateId('hrtsk'),
        checklistId,
        employeeId,
        title: item.title,
        description: item.description ?? null,
        assigneeRole: item.assigneeRole,
        assigneeUserId:
          item.assigneeRole === 'manager'
            ? managerUserId
            : item.assigneeRole === 'employee'
              ? employee.userId
              : null,
        dueDate: addDays(anchor, item.dueOffsetDays),
        visibleToEmployee: item.visibleToEmployee,
        sortOrder: index,
      })),
    );
  }

  const statusPatch =
    template.kind === 'onboarding'
      ? employee.status === 'active' ? null : 'onboarding'
      : 'offboarding';
  if (statusPatch && statusPatch !== employee.status) {
    await db.update(schema.hrEmployees).set({ status: statusPatch, updatedAt: new Date() }).where(eq(schema.hrEmployees.id, employeeId));
  }

  return checklist!;
}

export async function addTask(
  db: Database,
  checklistId: string,
  input: {
    title: string;
    description?: string | null;
    assigneeRole?: string;
    assigneeUserId?: string | null;
    dueDate?: string | null;
    visibleToEmployee?: boolean;
  },
) {
  const checklist = await requireChecklist(db, checklistId);
  const [{ max } = { max: -1 }] = await db
    .select({ max: sql<number>`coalesce(max(${tsk.sortOrder}), -1)` })
    .from(tsk)
    .where(eq(tsk.checklistId, checklistId));
  const [row] = await db
    .insert(tsk)
    .values({
      id: generateId('hrtsk'),
      checklistId,
      employeeId: checklist.employeeId,
      title: input.title,
      description: input.description ?? null,
      assigneeRole: input.assigneeRole ?? 'hr',
      assigneeUserId: input.assigneeUserId ?? null,
      dueDate: input.dueDate ?? null,
      visibleToEmployee: input.visibleToEmployee ?? false,
      sortOrder: Number(max) + 1,
    })
    .returning();
  if (checklist.status === 'completed') {
    await db.update(chk).set({ status: 'in_progress', completedAt: null, updatedAt: new Date() }).where(eq(chk.id, checklistId));
  }
  return row!;
}

export type ChecklistOutcome = {
  checklistCompleted: boolean;
  kind: string;
  employeeId: string;
  employeeStatus: string | null;
};

export async function updateTask(
  db: Database,
  taskId: string,
  input: {
    title?: string;
    description?: string | null;
    assigneeRole?: string;
    assigneeUserId?: string | null;
    dueDate?: string | null;
    visibleToEmployee?: boolean;
    completed?: boolean;
  },
  actorId: string,
) {
  const task = await requireTask(db, taskId);
  const { completed, ...rest } = input;
  const patch: Partial<typeof tsk.$inferInsert> = { ...rest, updatedAt: new Date() };
  if (completed === true && !task.completedAt) {
    patch.completedAt = new Date();
    patch.completedBy = actorId;
  } else if (completed === false) {
    patch.completedAt = null;
    patch.completedBy = null;
  }
  const [row] = await db.update(tsk).set(patch).where(eq(tsk.id, taskId)).returning();
  const outcome = await settleChecklist(db, task.checklistId);
  return { task: row!, outcome };
}

export async function deleteTask(db: Database, taskId: string) {
  const task = await requireTask(db, taskId);
  await db.delete(tsk).where(eq(tsk.id, taskId));
  return settleChecklist(db, task.checklistId);
}

/**
 * Re-evaluate a checklist after a task change. Closes it when every task is
 * done and applies the employee status transition; reopens it when a task is
 * un-ticked.
 */
export async function settleChecklist(db: Database, checklistId: string): Promise<ChecklistOutcome> {
  const checklist = await requireChecklist(db, checklistId);
  const outcome: ChecklistOutcome = {
    checklistCompleted: false,
    kind: checklist.kind,
    employeeId: checklist.employeeId,
    employeeStatus: null,
  };
  if (checklist.status === 'cancelled') return outcome;

  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      open: sql<number>`count(*) filter (where ${tsk.completedAt} is null)`,
    })
    .from(tsk)
    .where(eq(tsk.checklistId, checklistId));
  const total = Number(counts?.total ?? 0);
  const open = Number(counts?.open ?? 0);
  const now = new Date();

  if (total > 0 && open === 0 && checklist.status !== 'completed') {
    await db.update(chk).set({ status: 'completed', completedAt: now, updatedAt: now }).where(eq(chk.id, checklistId));
    outcome.checklistCompleted = true;

    const employee = await requireEmployee(db, checklist.employeeId);
    if (checklist.kind === 'onboarding' && employee.status === 'onboarding') {
      await db.update(schema.hrEmployees).set({ status: 'active', updatedAt: now }).where(eq(schema.hrEmployees.id, employee.id));
      outcome.employeeStatus = 'active';
    }
    if (checklist.kind === 'offboarding') {
      const endDate = employee.endDate ?? todayIso();
      await db
        .update(schema.hrEmployees)
        .set({ status: 'terminated', endDate, updatedAt: now })
        .where(eq(schema.hrEmployees.id, employee.id));
      await endAssignmentsFor(db, employee.id, endDate);
      await db
        .update(schema.hrPortalAccess)
        .set({ status: 'revoked', updatedAt: now })
        .where(eq(schema.hrPortalAccess.employeeId, employee.id));
      outcome.employeeStatus = 'terminated';
    }
  } else if (open > 0 && checklist.status === 'completed') {
    await db.update(chk).set({ status: 'in_progress', completedAt: null, updatedAt: now }).where(eq(chk.id, checklistId));
  }
  return outcome;
}

export async function cancelChecklist(db: Database, checklistId: string) {
  await requireChecklist(db, checklistId);
  const [row] = await db
    .update(chk)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(chk.id, checklistId))
    .returning();
  return row!;
}

export async function deleteChecklist(db: Database, checklistId: string) {
  await requireChecklist(db, checklistId);
  await db.delete(tsk).where(eq(tsk.checklistId, checklistId));
  await db.delete(chk).where(eq(chk.id, checklistId));
}

/** Seed a sensible first onboarding + offboarding template for a new workspace. */
export async function ensureDefaultTemplates(db: Database) {
  const [existing] = await db.select({ id: tpl.id }).from(tpl).where(isNull(tpl.deletedAt)).limit(1);
  if (existing) return;
  const item = (title: string, assigneeRole: HrChecklistTemplateItem['assigneeRole'], dueOffsetDays: number, visibleToEmployee = false): HrChecklistTemplateItem => ({
    id: generateId('item'),
    title,
    assigneeRole,
    dueOffsetDays,
    visibleToEmployee,
  });
  await db.insert(tpl).values([
    {
      id: generateId('hrctp'),
      name: 'Standard onboarding',
      kind: 'onboarding',
      isDefault: true,
      items: [
        item('Send contract and collect signature', 'hr', -10),
        item('Collect ID and tax documents', 'hr', -5, true),
        item('Create accounts and order equipment', 'it', -3),
        item('Complete your profile and emergency contact', 'employee', 0, true),
        item('Welcome meeting and team introduction', 'manager', 0, true),
        item('Client account training', 'manager', 5, true),
        item('30-day check-in', 'manager', 30, true),
        item('Probation review', 'hr', 90),
      ],
    },
    {
      id: generateId('hrctp'),
      name: 'Standard offboarding',
      kind: 'offboarding',
      isDefault: true,
      items: [
        item('Confirm last working day in writing', 'hr', -14),
        item('Hand over client accounts', 'manager', -7, true),
        item('Exit interview', 'hr', -2, true),
        item('Return equipment', 'employee', 0, true),
        item('Revoke system access', 'it', 0),
        item('Final pay and documents', 'hr', 7),
      ],
    },
  ]);
}
