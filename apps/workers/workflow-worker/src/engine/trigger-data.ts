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

const MINUTE_MS = 60_000;

/** The scheduled slot as a Date floored to the minute; the run's start when no valid slot was sent. */
export function scheduledSlot(raw: unknown, fallback: Date): Date {
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null;
  const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** `YYYY-MM-DD HH:mm` of an instant in an IANA timezone (UTC when missing or unknown). */
export function formatLocalMinute(at: Date, timeZone: unknown): string {
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'UTC';
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(zone);
  } catch {
    parts = format('UTC'); // unknown timezone name
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
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
    // The slot the schedule was due for (the sweep sends it as `scheduledTime`),
    // not the instant the run happened to start: floored to the minute.
    const slot = scheduledSlot(base.scheduledTime, meta.startedAt);
    aliases.scheduledTime = slot.toISOString();
    aliases.scheduledTimeLocal = formatLocalMinute(slot, base.timezone);
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
