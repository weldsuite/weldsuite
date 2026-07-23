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
) {
  const id = generateId('wf');
  const now = new Date();

  await db.insert(workflows).values({
    id,
    name: data.name,
    description: data.description ?? null,
    status: data.status || 'draft',
    triggers: (data.triggers ?? []) as any,
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
  });

  return { id };
}

export async function updateWorkflow(
  db: Database,
  id: string,
  data: Record<string, unknown>,
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

  await db.update(workflows).set(update).where(eq(workflows.id, id));
  return { id };
}

export async function updateWorkflowStatus(db: Database, id: string, status: string) {
  const [existing] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1);
  if (!existing) return null;

  await db.update(workflows).set({ status, updatedAt: new Date() }).where(eq(workflows.id, id));
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

  await db.insert(workflows).values({
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
  });

  return { id: newId };
}

export async function deleteWorkflow(db: Database, id: string) {
  await db
    .update(workflows)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)));
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
