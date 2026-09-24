/**
 * Workflows service — pure business logic for workflow CRUD + sub-resource
 * operations (stats, for-chaining, status, duplicate, metrics).
 *
 * No Hono context — takes a tenant Database instance and typed params.
 * Routes wire HTTP / permissions / entity events on top of this.
 */

import { and, desc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { clearWorkflowTriggerIndex, syncWorkflowTriggerIndex } from './workflow-trigger-index';
import { syncWorkflowSchedules } from './workflow-schedule-sync';
import type { ScheduleIndexSync } from '../lib/schedule-index';

const { workflows, workflowExecutions } = schema;

export interface ListWorkflowsParams {
  search?: string;
  status?: string;
  triggerType?: string;
  folderId?: string;
  tags?: string;
  excludeTags?: string;
  cursor?: string;
  limit?: number;
}

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listWorkflows(
  db: Database,
  params: ListWorkflowsParams,
): Promise<ListResult<typeof workflows.$inferSelect>> {
  const limit = Math.min(params.limit ?? 25, 100);

  const filterConditions: any[] = [isNull(workflows.deletedAt)];
  if (params.search) {
    const term = `%${params.search}%`;
    filterConditions.push(or(like(workflows.name, term), like(workflows.description, term))!);
  }
  if (params.status) filterConditions.push(eq(workflows.status, params.status));
  if (params.folderId) filterConditions.push(eq(workflows.folderId, params.folderId));
  // Comma-separated. `tags` requires every listed tag; `excludeTags` drops rows
  // carrying any of them (WeldConnect passes `__type:sequence` so CRM
  // sequences, which share this table, stay out of its list).
  for (const tag of splitTags(params.tags)) {
    filterConditions.push(sql`coalesce(${workflows.tags}, '[]'::jsonb) ? ${tag}`);
  }
  for (const tag of splitTags(params.excludeTags)) {
    filterConditions.push(sql`not (coalesce(${workflows.tags}, '[]'::jsonb) ? ${tag})`);
  }

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(workflows.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(workflows)
      .where(and(...conditions))
      .orderBy(desc(workflows.updatedAt), desc(workflows.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflows)
      .where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  const totalCount = Number(countRes[0]?.count ?? 0);

  return { data, totalCount, hasMore, cursor };
}

function splitTags(value: string | undefined): string[] {
  return (value ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

export async function getWorkflow(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createWorkflow(
  db: Database,
  data: {
    name: string;
    description?: string | null;
    status?: string;
    triggers?: unknown[];
    steps?: unknown[];
    settings?: Record<string, unknown>;
    tags?: string[];
    folderId?: string | null;
  },
  userId: string,
  scheduleSync?: ScheduleIndexSync,
) {
  const id = generateId('wf');
  const now = new Date();

  const status = data.status || 'draft';
  const triggers = data.triggers ?? [];

  await syncWorkflowTriggerIndex(db, id, triggers, {
    workflowActive: status === 'active',
    withStatements: (handle) => [
      handle.insert(workflows).values({
        id,
        name: data.name,
        description: data.description ?? null,
        status,
        triggers: triggers as any,
        steps: (data.steps ?? []) as any,
        settings: (data.settings ?? {}) as any,
        tags: data.tags ?? [],
        folderId: data.folderId,
        createdBy: userId,
        version: 1,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      }),
    ],
  });

  await syncWorkflowSchedules(db, scheduleSync, {
    workflowId: id,
    previousTriggers: [],
    nextTriggers: triggers,
    workflowActive: status === 'active',
  });

  return { id };
}

export async function updateWorkflow(
  db: Database,
  id: string,
  data: Record<string, unknown>,
  scheduleSync?: ScheduleIndexSync,
) {
  const [existing] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'status', 'triggers', 'steps', 'settings', 'tags', 'folderId'] as const) {
    if (data[k] !== undefined) update[k] = data[k];
  }

  const nextStatus = (update.status as string | undefined) ?? existing.status;
  const nextTriggers = update.triggers !== undefined ? update.triggers : existing.triggers;
  await syncWorkflowTriggerIndex(db, id, nextTriggers, {
    workflowActive: nextStatus === 'active',
    withStatements: (handle) => [
      handle.update(workflows).set(update).where(eq(workflows.id, id)),
    ],
  });

  await syncWorkflowSchedules(db, scheduleSync, {
    workflowId: id,
    previousTriggers: existing.triggers,
    nextTriggers,
    workflowActive: nextStatus === 'active',
  });

  return { id };
}

export async function updateWorkflowStatus(
  db: Database,
  id: string,
  status: string,
  scheduleSync?: ScheduleIndexSync,
) {
  const [existing] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1);
  if (!existing) return null;

  await syncWorkflowTriggerIndex(db, id, existing.triggers, {
    workflowActive: status === 'active',
    withStatements: (handle) => [
      handle.update(workflows).set({ status, updatedAt: new Date() }).where(eq(workflows.id, id)),
    ],
  });

  await syncWorkflowSchedules(db, scheduleSync, {
    workflowId: id,
    previousTriggers: existing.triggers,
    nextTriggers: existing.triggers,
    workflowActive: status === 'active',
  });
  return { id, status };
}

export async function duplicateWorkflow(
  db: Database,
  id: string,
  userId: string,
  name?: string,
) {
  const [original] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1);
  if (!original) return null;

  const newId = generateId('wf');
  const now = new Date();

  // Duplicates start as draft — no active trigger index rows.
  await syncWorkflowTriggerIndex(db, newId, original.triggers, {
    workflowActive: false,
    withStatements: (handle) => [
      handle.insert(workflows).values({
        id: newId,
        name: name || `${original.name} (Copy)`,
        description: original.description,
        status: 'draft',
        triggers: (original.triggers ?? []) as any,
        steps: (original.steps ?? []) as any,
        settings: (original.settings ?? {}) as any,
        tags: original.tags ?? [],
        folderId: original.folderId,
        createdBy: userId,
        version: 1,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      }),
    ],
  });

  return { id: newId };
}

export async function deleteWorkflow(db: Database, id: string, scheduleSync?: ScheduleIndexSync) {
  const [existing] = await db
    .select({ triggers: workflows.triggers })
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1);

  await clearWorkflowTriggerIndex(db, id, {
    withStatements: (handle) => [
      handle
        .update(workflows)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workflows.id, id), isNull(workflows.deletedAt))),
    ],
  });

  if (existing) {
    await syncWorkflowSchedules(db, scheduleSync, {
      workflowId: id,
      previousTriggers: existing.triggers,
      nextTriggers: [],
      workflowActive: false,
    });
  }
}

export async function getWorkflowStats(db: Database) {
  const [allWorkflows, allExecutions] = await Promise.all([
    db.select({ status: workflows.status }).from(workflows).where(isNull(workflows.deletedAt)),
    db.select({ status: workflowExecutions.status }).from(workflowExecutions),
  ]);

  const wf = { total: 0, active: 0, draft: 0, paused: 0, archived: 0 };
  for (const w of allWorkflows) {
    wf.total++;
    if (w.status === 'active') wf.active++;
    else if (w.status === 'draft') wf.draft++;
    else if (w.status === 'paused') wf.paused++;
    else if (w.status === 'archived') wf.archived++;
  }

  const ex = { total: 0, running: 0, completed: 0, failed: 0, queued: 0 };
  for (const e of allExecutions) {
    ex.total++;
    if (e.status === 'running') ex.running++;
    else if (e.status === 'completed') ex.completed++;
    else if (e.status === 'failed') ex.failed++;
    else if (e.status === 'queued') ex.queued++;
  }

  return {
    totalWorkflows: wf.total,
    activeWorkflows: wf.active,
    draftWorkflows: wf.draft,
    pausedWorkflows: wf.paused,
    totalExecutions: ex.total,
    successfulExecutions: ex.completed,
    failedExecutions: ex.failed,
    pendingExecutions: ex.queued + ex.running,
    workflows: wf,
    executions: ex,
  };
}

export async function listWorkflowsForChaining(db: Database, excludeId?: string) {
  const conditions: any[] = [isNull(workflows.deletedAt)];
  if (excludeId) conditions.push(sql`${workflows.id} != ${excludeId}`);

  return db
    .select({ id: workflows.id, name: workflows.name, status: workflows.status })
    .from(workflows)
    .where(and(...conditions))
    .orderBy(workflows.name);
}

export async function getWorkflowMetrics(db: Database, workflowId: string) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  if (!workflow) return null;

  const recentExecutions = await db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId))
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(10);

  const avg = workflow.averageExecutionTime ? Number(workflow.averageExecutionTime) : 0;

  return {
    totalExecutions: workflow.executionCount ?? 0,
    successCount: workflow.successCount ?? 0,
    failureCount: workflow.failureCount ?? 0,
    averageExecutionTime: avg,
    recentExecutions,
  };
}
