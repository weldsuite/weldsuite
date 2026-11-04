/**
 * Schedule queries and presenters shared by `/api/project-schedule` and
 * `/api/task-dependencies` (design: weldflow-delivery-and-portfolio.md; ADR
 * FLOW-015).
 *
 * The calculation itself (`computeSchedule`, `previewMove`) is in
 * `@weldsuite/flow-domain/schedule`; this file is the database side: reading a
 * project's network, the go-live date, the deliverables, and turning the
 * result into the response shapes.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { ProjectSettings } from '@weldsuite/db/schema/project-settings';
import { DEFAULT_CHANGE_CONTROL } from '@weldsuite/db/schema/project-settings';
import type {
  MoveDeliverableImpact,
  ProjectSchedule,
  ScheduleDeliverable,
  ScheduleGoLive,
  ScheduleMoveImpact,
  ScheduleSettings,
  ScheduleSummary,
  ScheduleTask,
  TaskDependency,
} from '@weldsuite/app-api-client/schemas/project-schedule';
import {
  dateOf,
  normalizeCalendar,
  projectDeliverables,
  workingDaysBetween,
  type MovePreview,
  type ScheduleCalendar,
  type ScheduleInput,
  type ScheduleResult,
} from '@weldsuite/flow-domain/schedule';

const tasksTable = schema.tasks;
const depsTable = schema.taskDependencies;

export type DependencyRow = typeof depsTable.$inferSelect;
export type ProjectRow = typeof schema.projects.$inferSelect;

/** A live project by id. */
export async function findLiveProject(db: Database, projectId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The project calendar and the auto-schedule switch, with the defaults for what is not set. */
export function scheduleSettingsOf(settings: ProjectSettings | null | undefined): ScheduleSettings {
  const stored = settings?.schedule;
  const calendar = normalizeCalendar(stored);
  return { ...calendar, autoSchedule: stored?.autoSchedule === true };
}

export function presentTaskDependency(row: DependencyRow): TaskDependency {
  return {
    id: row.id,
    projectId: row.projectId,
    predecessorId: row.predecessorId,
    successorId: row.successorId,
    type: row.type,
    lagDays: row.lagDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The event payload of a dependency. */
export function taskDependencyEventData(row: DependencyRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    predecessorId: row.predecessorId,
    successorId: row.successorId,
    type: row.type,
    lagDays: row.lagDays,
  };
}

export interface ScheduleTaskRow {
  id: string;
  number: number | null;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  parentTaskId: string | null;
  deliverableId: string | null;
  progress: string;
  startDate: Date | null;
  dueDate: Date | null;
}

export interface ScheduleDeliverableRow {
  id: string;
  number: number;
  title: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
}

/** Everything the calculation and its presentation read of one project. */
export interface ScheduleData {
  project: ProjectRow;
  settings: ScheduleSettings;
  tasks: ScheduleTaskRow[];
  links: DependencyRow[];
  deliverables: ScheduleDeliverableRow[];
  goLive: ScheduleGoLive;
  scheduleLimitDays: number;
}

/** The latest baseline's go-live date and version, if any. */
async function latestBaselineGoLive(db: Database, projectId: string): Promise<{ version: number; goLive: string | null } | null> {
  const [row] = await db
    .select({ version: schema.projectBaselines.version, snapshot: schema.projectBaselines.snapshot })
    .from(schema.projectBaselines)
    .where(eq(schema.projectBaselines.projectId, projectId))
    .orderBy(sql`${schema.projectBaselines.version} desc`)
    .limit(1);
  if (!row) return null;
  return { version: row.version, goLive: dateOf(row.snapshot?.goLive ?? null) };
}

/** One query for the tasks, one for the links, one for the deliverables and one for the baseline. */
export async function loadScheduleData(db: Database, project: ProjectRow): Promise<ScheduleData> {
  const [tasks, links, deliverables, baseline] = await Promise.all([
    db
      .select({
        id: tasksTable.id,
        number: tasksTable.number,
        title: tasksTable.title,
        status: tasksTable.status,
        priority: tasksTable.priority,
        assigneeId: tasksTable.assigneeId,
        parentTaskId: tasksTable.parentTaskId,
        deliverableId: tasksTable.deliverableId,
        progress: tasksTable.progress,
        startDate: tasksTable.startDate,
        dueDate: tasksTable.dueDate,
      })
      .from(tasksTable)
      .where(and(eq(tasksTable.projectId, project.id), isNull(tasksTable.deletedAt)))
      .orderBy(
        sql`${tasksTable.startDate} asc nulls last`,
        sql`${tasksTable.dueDate} asc nulls last`,
        asc(tasksTable.position),
        asc(tasksTable.id),
      ),
    db.select().from(depsTable).where(eq(depsTable.projectId, project.id)).orderBy(asc(depsTable.createdAt), asc(depsTable.id)),
    db
      .select({
        id: schema.projectDeliverables.id,
        number: schema.projectDeliverables.number,
        title: schema.projectDeliverables.title,
        plannedStart: schema.projectDeliverables.plannedStart,
        plannedEnd: schema.projectDeliverables.plannedEnd,
      })
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, project.id), isNull(schema.projectDeliverables.deletedAt)))
      .orderBy(asc(schema.projectDeliverables.position), asc(schema.projectDeliverables.number)),
    latestBaselineGoLive(db, project.id),
  ]);

  const baselineGoLive = baseline?.goLive ?? null;
  const baselineVersion = baseline?.version ?? null;
  const projectEnd = dateOf(project.endDate);
  let goLive: ScheduleGoLive = { date: null, source: null, baselineVersion };
  if (baselineGoLive) goLive = { date: baselineGoLive, source: 'baseline', baselineVersion };
  else if (projectEnd) goLive = { date: projectEnd, source: 'project', baselineVersion };

  return {
    project,
    settings: scheduleSettingsOf(project.settings),
    tasks,
    links,
    deliverables,
    goLive,
    scheduleLimitDays: project.settings?.changeControl?.scheduleLimitDays ?? DEFAULT_CHANGE_CONTROL.scheduleLimitDays,
  };
}

/** The input of `computeSchedule` for the data read. */
export function buildScheduleInput(data: ScheduleData): ScheduleInput {
  const calendar: ScheduleCalendar = { workingDays: data.settings.workingDays, holidays: data.settings.holidays };
  return {
    tasks: data.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      startDate: dateOf(task.startDate),
      dueDate: dateOf(task.dueDate),
    })),
    links: data.links.map((link) => ({
      id: link.id,
      predecessorId: link.predecessorId,
      successorId: link.successorId,
      type: link.type,
      lagDays: link.lagDays,
    })),
    calendar,
    goLive: data.goLive.date,
  };
}

const deliverableCode = (number: number) => `D${number}`;

function calendarOf(data: ScheduleData): ScheduleCalendar {
  return { workingDays: data.settings.workingDays, holidays: data.settings.holidays };
}

/** Each deliverable with the end its tasks project and how far that is from the planned end. */
function presentDeliverables(data: ScheduleData, result: ScheduleResult): ScheduleDeliverable[] {
  const refs = data.tasks.flatMap((task) => (task.deliverableId ? [{ deliverableId: task.deliverableId, taskId: task.id }] : []));
  const projections = projectDeliverables(
    data.deliverables.map((deliverable) => deliverable.id),
    refs,
    result,
  );
  const calendar = calendarOf(data);
  return data.deliverables.map((deliverable, index) => {
    const plannedEnd = dateOf(deliverable.plannedEnd);
    const projectedEnd = projections[index].projectedEnd;
    return {
      id: deliverable.id,
      code: deliverableCode(deliverable.number),
      title: deliverable.title,
      plannedStart: dateOf(deliverable.plannedStart),
      plannedEnd,
      projectedEnd,
      slipDays: plannedEnd && projectedEnd ? workingDaysBetween(calendar, plannedEnd, projectedEnd) : null,
    };
  });
}

/** The project's schedule as `GET /api/project-schedule/:projectId` answers it. */
export function presentProjectSchedule(data: ScheduleData, result: ScheduleResult): ProjectSchedule {
  const tasks: ScheduleTask[] = data.tasks.map((task, index) => {
    const scheduled = result.tasks[index];
    return {
      id: task.id,
      number: task.number,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assigneeId: task.assigneeId,
      parentTaskId: task.parentTaskId,
      deliverableId: task.deliverableId,
      progress: task.progress,
      startDate: task.startDate ? task.startDate.toISOString() : null,
      dueDate: task.dueDate ? task.dueDate.toISOString() : null,
      scheduled: scheduled.scheduled,
      done: scheduled.done,
      plannedStart: scheduled.plannedStart,
      plannedFinish: scheduled.plannedFinish,
      durationDays: scheduled.durationDays,
      earlyStart: scheduled.earlyStart,
      earlyFinish: scheduled.earlyFinish,
      lateStart: scheduled.lateStart,
      lateFinish: scheduled.lateFinish,
      totalFloat: scheduled.totalFloat,
      critical: scheduled.critical,
      shiftDays: scheduled.shiftDays,
      linked: scheduled.linked,
    };
  });

  const criticalIds = new Set(result.criticalPath);
  const critical = result.tasks.filter((task) => criticalIds.has(task.id));
  const firstCriticalStart = result.criticalPath.length > 0 ? (result.tasks.find((t) => t.id === result.criticalPath[0])?.earlyStart ?? null) : null;
  const summary: ScheduleSummary = {
    taskCount: data.tasks.length,
    scheduledCount: result.tasks.filter((task) => task.scheduled).length,
    unlinkedCount: result.tasks.filter((task) => task.scheduled && !task.linked).length,
    linkCount: data.links.length,
    criticalCount: critical.length,
    criticalSpanDays:
      firstCriticalStart && result.finish
        ? (workingDaysBetween(calendarOf(data), firstCriticalStart, result.finish) ?? 0) + 1
        : null,
    conflictCount: result.conflicts.length,
  };

  return {
    projectId: data.project.id,
    settings: data.settings,
    goLive: data.goLive,
    finish: result.finish,
    goLiveSlackDays: result.goLiveSlackDays,
    scheduleLimitDays: data.scheduleLimitDays,
    tasks,
    dependencies: data.links.map(presentTaskDependency),
    conflicts: result.conflicts,
    criticalPath: result.criticalPath,
    cyclicTaskIds: result.cyclicTaskIds,
    deliverables: presentDeliverables(data, result),
    summary,
  };
}

/** What a move does, as the preview and the apply answer it. */
export function presentMoveImpact(data: ScheduleData, before: ScheduleResult, preview: MovePreview): ScheduleMoveImpact {
  const calendar = calendarOf(data);
  const beforeEnds = presentDeliverables(data, before);
  const afterEnds = presentDeliverables(data, preview.schedule);
  const deliverables: MoveDeliverableImpact[] = [];
  beforeEnds.forEach((was, index) => {
    const now = afterEnds[index];
    if (was.projectedEnd === now.projectedEnd) return;
    deliverables.push({
      id: was.id,
      code: was.code,
      title: was.title,
      plannedEnd: was.plannedEnd,
      endBefore: was.projectedEnd,
      endAfter: now.projectedEnd,
      shiftDays:
        was.projectedEnd && now.projectedEnd ? (workingDaysBetween(calendar, was.projectedEnd, now.projectedEnd) ?? 0) : 0,
    });
  });
  return {
    taskId: preview.taskId,
    task: preview.task,
    moved: preview.moved,
    newConflicts: preview.newConflicts,
    before: preview.before,
    after: preview.after,
    deliverables,
    goLive: data.goLive,
    exceedsGoLive: preview.after.goLiveSlackDays !== null && preview.after.goLiveSlackDays < 0,
    finishShiftDays:
      preview.before.finish && preview.after.finish
        ? (workingDaysBetween(calendar, preview.before.finish, preview.after.finish) ?? 0)
        : 0,
    autoSchedule: data.settings.autoSchedule,
    scheduleLimitDays: data.scheduleLimitDays,
  };
}

/** The live task rows by id, with the dependency arrays (the arrays a dependency row write keeps in step). */
export async function findTasksForLink(db: Database, ids: string[]) {
  return db
    .select({
      id: tasksTable.id,
      projectId: tasksTable.projectId,
      title: tasksTable.title,
      number: tasksTable.number,
      status: tasksTable.status,
      priority: tasksTable.priority,
      type: tasksTable.type,
      assigneeId: tasksTable.assigneeId,
      estimatedHours: tasksTable.estimatedHours,
      actualHours: tasksTable.actualHours,
      progress: tasksTable.progress,
      dependsOn: tasksTable.dependsOn,
      blocks: tasksTable.blocks,
    })
    .from(tasksTable)
    .where(and(inArray(tasksTable.id, ids), isNull(tasksTable.deletedAt)));
}

/** A dependency row by id. */
export async function findDependency(db: Database, id: string): Promise<DependencyRow | null> {
  const [row] = await db.select().from(depsTable).where(eq(depsTable.id, id)).limit(1);
  return row ?? null;
}
