/**
 * Workflow schedules service — CRUD + toggle. DB-only for config/stats; a cron
 * sweep in workflow-worker fires queued schedules by polling a D1 schedule
 * index. Each mutation here keeps that index in sync (best-effort) so the sweep
 * never has to fan out across every tenant DB. No Trigger.dev wiring lives here.
 */

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import {
  syncUpsertScheduleIndex,
  syncRemoveScheduleIndex,
  updateTouchesTiming,
  type ScheduleIndexSync,
} from '../lib/schedule-index';

const { workflowSchedules, workflows } = schema;

export interface ListSchedulesParams {
  workflowId?: string;
  isEnabled?: boolean;
  cursor?: string;
  limit?: number;
}

export async function listSchedules(db: Database, params: ListSchedulesParams) {
  const limit = Math.min(params.limit ?? 25, 100);

  const filterConditions: any[] = [isNull(workflowSchedules.deletedAt)];
  if (params.workflowId) filterConditions.push(eq(workflowSchedules.workflowId, params.workflowId));
  if (params.isEnabled !== undefined) filterConditions.push(eq(workflowSchedules.isEnabled, params.isEnabled));

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(workflowSchedules.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(workflowSchedules)
      .where(and(...conditions))
      .orderBy(desc(workflowSchedules.createdAt))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(workflowSchedules).where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data, totalCount: Number(countRes[0]?.count ?? 0), hasMore, cursor };
}

export async function getSchedule(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.id, id), isNull(workflowSchedules.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createSchedule(
  db: Database,
  data: Record<string, unknown>,
  _userId: string,
  sync?: ScheduleIndexSync,
): Promise<{ id: string } | { error: 'workflow_not_found' }> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, String(data.workflowId)), isNull(workflows.deletedAt)))
    .limit(1);
  if (!workflow) return { error: 'workflow_not_found' };

  const id = generateId('sched');
  const now = new Date();
  const startDate = data.startDate ? new Date(String(data.startDate)) : undefined;
  const endDate = data.endDate ? new Date(String(data.endDate)) : undefined;
  const cronExpression = String(data.cronExpression);
  const timezone = String(data.timezone || 'UTC');
  const isEnabled = data.isEnabled !== false;

  await db.insert(workflowSchedules).values({
    id,
    workflowId: String(data.workflowId),
    triggerId: (data.triggerId as string) ?? null,
    name: (data.name as string) ?? null,
    cronExpression,
    timezone,
    startDate,
    endDate,
    isEnabled,
    createdAt: now,
    updatedAt: now,
  });

  await syncUpsertScheduleIndex(sync, {
    scheduleId: id,
    workspaceId: sync?.workspaceId ?? '',
    workflowId: String(data.workflowId),
    triggerId: (data.triggerId as string) ?? null,
    cronExpression,
    timezone,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    isEnabled,
  });

  return { id };
}

export async function updateSchedule(
  db: Database,
  id: string,
  data: Record<string, unknown>,
  sync?: ScheduleIndexSync,
) {
  const [existing] = await db
    .select()
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.id, id), isNull(workflowSchedules.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name;
  if (data.cronExpression !== undefined) update.cronExpression = data.cronExpression;
  if (data.timezone !== undefined) update.timezone = data.timezone;
  if (data.startDate !== undefined) update.startDate = data.startDate ? new Date(String(data.startDate)) : null;
  if (data.endDate !== undefined) update.endDate = data.endDate ? new Date(String(data.endDate)) : null;
  if (data.isEnabled !== undefined) update.isEnabled = data.isEnabled;

  await db.update(workflowSchedules).set(update).where(eq(workflowSchedules.id, id));

  // Only re-index when a timing-relevant field changed (a rename doesn't affect
  // the sweep, and re-indexing would needlessly reset next_run_at). Merge the
  // update over the existing row so the index carries the full current config.
  if (updateTouchesTiming(data)) {
    await syncUpsertScheduleIndex(sync, {
      scheduleId: id,
      workspaceId: sync?.workspaceId ?? '',
      workflowId: existing.workflowId,
      triggerId: existing.triggerId,
      cronExpression: (update.cronExpression as string) ?? existing.cronExpression,
      timezone: (update.timezone as string) ?? existing.timezone,
      startDate: 'startDate' in update ? (update.startDate as Date | null) : existing.startDate,
      endDate: 'endDate' in update ? (update.endDate as Date | null) : existing.endDate,
      isEnabled: 'isEnabled' in update ? (update.isEnabled as boolean) : existing.isEnabled,
    });
  }

  return { id };
}

export async function toggleSchedule(db: Database, id: string, enabled: boolean, sync?: ScheduleIndexSync) {
  const [existing] = await db
    .select()
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.id, id), isNull(workflowSchedules.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(workflowSchedules)
    .set({ isEnabled: enabled, updatedAt: new Date() })
    .where(eq(workflowSchedules.id, id));

  await syncUpsertScheduleIndex(sync, {
    scheduleId: id,
    workspaceId: sync?.workspaceId ?? '',
    workflowId: existing.workflowId,
    triggerId: existing.triggerId,
    cronExpression: existing.cronExpression,
    timezone: existing.timezone,
    startDate: existing.startDate,
    endDate: existing.endDate,
    isEnabled: enabled,
  });

  return { id, isEnabled: enabled };
}

export async function deleteSchedule(db: Database, id: string, sync?: ScheduleIndexSync) {
  await db
    .update(workflowSchedules)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflowSchedules.id, id), isNull(workflowSchedules.deletedAt)));
  await syncRemoveScheduleIndex(sync, id);
}
