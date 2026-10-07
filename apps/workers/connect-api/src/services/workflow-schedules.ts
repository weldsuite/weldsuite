/**
 * Workflow schedules service — CRUD + toggle. DB-only for config/stats; a cron
 * sweep in workflow-worker fires queued schedules by polling a D1 schedule
 * index. Each mutation here keeps that index in sync (best-effort) so the sweep
 * never has to fan out across every tenant DB. No Trigger.dev wiring lives here.
 */

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
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

const PASSTHROUGH_UPDATE_FIELDS = ['name', 'cronExpression', 'timezone', 'isEnabled'] as const;
const DATE_UPDATE_FIELDS = ['startDate', 'endDate'] as const;

/** Map a partial schedule payload onto the columns to write (undefined = untouched). */
function buildScheduleUpdate(data: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const field of PASSTHROUGH_UPDATE_FIELDS) {
    if (data[field] !== undefined) update[field] = data[field];
  }
  for (const field of DATE_UPDATE_FIELDS) {
    if (data[field] !== undefined) update[field] = data[field] ? new Date(String(data[field])) : null;
  }
  return update;
}

/** The value written by this update when the field is present, else the stored value. */
function pickUpdated<T>(update: Record<string, unknown>, field: string, existing: T): T {
  return field in update ? (update[field] as T) : existing;
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

  const update = buildScheduleUpdate(data);

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
      cronExpression: (update.cronExpression as string) ?? existing.cronExpression ?? '',
      timezone: (update.timezone as string) ?? existing.timezone,
      startDate: pickUpdated<Date | null>(update, 'startDate', existing.startDate),
      endDate: pickUpdated<Date | null>(update, 'endDate', existing.endDate),
      isEnabled: pickUpdated<boolean>(update, 'isEnabled', existing.isEnabled),
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
    scheduleType: existing.scheduleType === 'one_time' ? 'one_time' : 'recurring',
    cronExpression: existing.cronExpression ?? '',
    timezone: existing.timezone,
    startDate: existing.startDate,
    endDate: existing.endDate,
    executeAt: existing.executeAt,
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
