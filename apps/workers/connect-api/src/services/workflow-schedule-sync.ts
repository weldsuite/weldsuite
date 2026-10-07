/**
 * Keeps `workflow_schedules` (and the D1 schedule index the cron sweep polls)
 * in step with the `schedule` triggers embedded in `workflows.triggers`.
 *
 * The editor saves a schedule trigger as JSON on the workflow; the sweep in
 * workflow-worker only fires rows in the D1 index, which is written from
 * `workflow_schedules`. Without this bridge an editor-configured schedule
 * never fires. One row per (workflow, schedule trigger id):
 *   - a recurring trigger on an active workflow → enabled row
 *   - a one-time (`scheduleType: 'one_time'`) trigger on an active workflow →
 *     enabled row, UNLESS it has already fired once (`lastRunAt` set) — a
 *     fired one-time schedule is never re-enabled by a later save, it stays
 *     done forever. The editor only lets a never-fired one get edited, so
 *     this never fights the UI.
 *   - workflow paused/draft or trigger disabled → row kept but disabled
 *     (preserving its run stats), not created if it doesn't exist yet
 *   - trigger removed or workflow deleted → row soft-deleted, index entry removed
 *
 * Only rows whose `triggerId` belongs to the workflow's embedded triggers (now
 * or before the change) are touched; schedules created through
 * /api/workflow-schedules or /api/workflow-triggers are left alone.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  syncRemoveScheduleIndex,
  syncUpsertScheduleIndex,
  type ScheduleIndexSync,
} from '../lib/schedule-index';
import { oneTimeScheduleTriggers, recurringScheduleTriggers, scheduleTriggerIds } from './weldconnect-mvp';

const { workflowSchedules } = schema;

export interface SyncWorkflowSchedulesParams {
  workflowId: string;
  /** The workflow's triggers before this change (`[]` on create). */
  previousTriggers: unknown;
  /** The workflow's triggers after this change (`[]` on delete). */
  nextTriggers: unknown;
  workflowActive: boolean;
}

export async function syncWorkflowSchedules(
  db: Database,
  sync: ScheduleIndexSync | undefined,
  params: SyncWorkflowSchedulesParams,
): Promise<void> {
  const { workflowId, workflowActive } = params;
  const desiredRecurring = recurringScheduleTriggers(params.nextTriggers);
  const desiredOnce = oneTimeScheduleTriggers(params.nextTriggers);
  const managedIds = [
    ...new Set([...scheduleTriggerIds(params.previousTriggers), ...scheduleTriggerIds(params.nextTriggers)]),
  ];
  if (managedIds.length === 0) return;

  const existing = await db
    .select()
    .from(workflowSchedules)
    .where(
      and(
        eq(workflowSchedules.workflowId, workflowId),
        inArray(workflowSchedules.triggerId, managedIds),
        isNull(workflowSchedules.deletedAt),
      ),
    );
  const existingByTrigger = new Map(existing.map((row) => [row.triggerId, row]));
  const now = new Date();

  for (const trigger of desiredRecurring) {
    const isEnabled = workflowActive && trigger.isEnabled;
    const row = existingByTrigger.get(trigger.triggerId);
    existingByTrigger.delete(trigger.triggerId);

    if (!row) {
      // Nothing to disable — only materialize a schedule once it should run.
      if (!isEnabled) continue;
      const id = generateId('sched');
      await db.insert(workflowSchedules).values({
        id,
        workflowId,
        triggerId: trigger.triggerId,
        name: trigger.name,
        scheduleType: 'recurring',
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        isEnabled,
        createdAt: now,
        updatedAt: now,
      });
      await syncUpsertScheduleIndex(sync, {
        scheduleId: id,
        workspaceId: sync?.workspaceId ?? '',
        workflowId,
        triggerId: trigger.triggerId,
        scheduleType: 'recurring',
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        isEnabled,
      });
      continue;
    }

    const timingChanged =
      row.cronExpression !== trigger.cronExpression ||
      row.timezone !== trigger.timezone ||
      row.isEnabled !== isEnabled;
    if (!timingChanged && row.name === trigger.name) continue;

    await db
      .update(workflowSchedules)
      .set({
        name: trigger.name,
        scheduleType: 'recurring',
        cronExpression: trigger.cronExpression,
        executeAt: null,
        timezone: trigger.timezone,
        isEnabled,
        updatedAt: now,
      })
      .where(eq(workflowSchedules.id, row.id));
    // Re-indexing resets next_run_at, so only do it when timing actually moved.
    if (timingChanged) {
      await syncUpsertScheduleIndex(sync, {
        scheduleId: row.id,
        workspaceId: sync?.workspaceId ?? '',
        workflowId,
        triggerId: trigger.triggerId,
        scheduleType: 'recurring',
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        startDate: row.startDate,
        endDate: row.endDate,
        isEnabled,
      });
    }
  }

  for (const trigger of desiredOnce) {
    const row = existingByTrigger.get(trigger.triggerId);
    existingByTrigger.delete(trigger.triggerId);
    // Once a one-time schedule has fired, it is done forever — a later save
    // of the workflow (even reactivating it) must never resurrect it.
    const alreadyFired = row?.lastRunAt != null;
    const isEnabled = !alreadyFired && workflowActive && trigger.isEnabled;

    if (!row) {
      if (!isEnabled) continue;
      const id = generateId('sched');
      await db.insert(workflowSchedules).values({
        id,
        workflowId,
        triggerId: trigger.triggerId,
        name: trigger.name,
        scheduleType: 'one_time',
        cronExpression: null,
        executeAt: trigger.executeAt,
        timezone: trigger.timezone,
        isEnabled,
        createdAt: now,
        updatedAt: now,
      });
      await syncUpsertScheduleIndex(sync, {
        scheduleId: id,
        workspaceId: sync?.workspaceId ?? '',
        workflowId,
        triggerId: trigger.triggerId,
        scheduleType: 'one_time',
        cronExpression: '',
        executeAt: trigger.executeAt,
        timezone: trigger.timezone,
        isEnabled,
      });
      continue;
    }

    if (alreadyFired) {
      // A cosmetic rename is harmless; nothing timing-related can change once fired.
      if (row.name !== trigger.name) {
        await db.update(workflowSchedules).set({ name: trigger.name, updatedAt: now }).where(eq(workflowSchedules.id, row.id));
      }
      continue;
    }

    const timingChanged =
      row.executeAt?.getTime() !== trigger.executeAt.getTime() ||
      row.timezone !== trigger.timezone ||
      row.isEnabled !== isEnabled;
    if (!timingChanged && row.name === trigger.name) continue;

    await db
      .update(workflowSchedules)
      .set({
        name: trigger.name,
        scheduleType: 'one_time',
        cronExpression: null,
        executeAt: trigger.executeAt,
        timezone: trigger.timezone,
        isEnabled,
        updatedAt: now,
      })
      .where(eq(workflowSchedules.id, row.id));
    if (timingChanged) {
      await syncUpsertScheduleIndex(sync, {
        scheduleId: row.id,
        workspaceId: sync?.workspaceId ?? '',
        workflowId,
        triggerId: trigger.triggerId,
        scheduleType: 'one_time',
        cronExpression: '',
        executeAt: trigger.executeAt,
        timezone: trigger.timezone,
        isEnabled,
      });
    }
  }

  // Whatever is left belonged to a schedule trigger that's gone (or is no
  // longer a valid schedule): retire it.
  for (const row of existingByTrigger.values()) {
    await db
      .update(workflowSchedules)
      .set({ deletedAt: now, isEnabled: false, updatedAt: now })
      .where(eq(workflowSchedules.id, row.id));
    await syncRemoveScheduleIndex(sync, row.id);
  }
}
