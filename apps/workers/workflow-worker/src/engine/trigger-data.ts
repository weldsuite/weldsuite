/**
 * Builds the `{{trigger.*}}` payload a run's steps resolve against.
 *
 * Dispatchers each send their own raw shape (the entity-event matcher sends
 * `{ entityType, entityId, action, data, changes }`, the schedule sweep sends
 * `{ scheduleId, cronExpression }`). The editor's variable picker, however,
 * offers a stable vocabulary per trigger type (`trigger.record.email`,
 * `trigger.recordId`, `trigger.scheduledTime`, … — see `getTriggerVariables`
 * in packages/design/ui/src/components/workflow-canvas/parts/variable-picker.tsx).
 * This adds those aliases on top of the raw payload (raw keys are kept, so
 * existing templates written against them still resolve). Pure.
 */

import type { TriggerType } from './types';

export interface TriggerRunMeta {
  userId: string;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  executionId: string;
  /** When the run was created (CF `WorkflowEvent.timestamp`) — stable across replays. */
  startedAt: Date;
}

type Changes = Record<string, { old: unknown; new: unknown }>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The record as it was before an `updated` event, rebuilt from its changes. */
function previousRecordFrom(record: Record<string, unknown> | undefined, changes: Changes | undefined) {
  if (!record || !changes) return undefined;
  const previous: Record<string, unknown> = { ...record };
  for (const [field, change] of Object.entries(changes)) previous[field] = change?.old;
  return previous;
}

export function buildTriggerData(
  triggerType: TriggerType,
  raw: unknown,
  meta: TriggerRunMeta,
): Record<string, unknown> {
  const base: Record<string, unknown> = asRecord(raw) ? { ...(raw as Record<string, unknown>) } : { data: raw };
  const aliases: Record<string, unknown> = {};

  if (triggerType === 'entity_event') {
    const record = asRecord(base.data);
    const changes = asRecord(base.changes) as Changes | undefined;
    aliases.entity = base.entityType;
    aliases.event = base.action;
    aliases.recordId = base.entityId;
    aliases.record = record ?? {};
    const previousRecord = previousRecordFrom(record, changes);
    if (previousRecord) aliases.previousRecord = previousRecord;
  } else if (triggerType === 'schedule') {
    aliases.scheduledTime = meta.startedAt.toISOString();
    aliases.runId = meta.executionId;
  } else if (triggerType === 'manual') {
    aliases.timestamp = meta.startedAt.toISOString();
  }

  return {
    // Aliases first so a raw key of the same name (if a dispatcher ever sends
    // one) wins — the raw payload is the source of truth.
    ...aliases,
    ...base,
    userId: meta.userId,
    workspaceId: meta.workspaceId,
    triggerType,
    workflowId: meta.workflowId,
    workflowName: meta.workflowName,
    executionId: meta.executionId,
  };
}
