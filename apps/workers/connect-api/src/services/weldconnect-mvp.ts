/**
 * WeldConnect MVP scope — what a WeldConnect workflow may use to go live.
 *
 * The engine (apps/workers/workflow-worker) still implements many more
 * triggers and actions, shared with WeldDesk workflows and CRM sequences. For
 * the production MVP, WeldConnect is narrowed to:
 *   - triggers: `entity_event` (a record is created/updated/…) and recurring
 *     `schedule` (cron + timezone)
 *   - actions:  `send_email` and `create_customer`
 *
 * Drafts may hold anything (the editor only offers the MVP set); activation is
 * what's gated, so an unsupported workflow can never start running. CRM
 * sequences (rows tagged `__type:sequence`) live in the same table and are
 * exempt — they have their own editor and launch flow.
 *
 * Keep the lists in sync with the platform's editor restrictions in
 * apps/web/platform/app/weldconnect/mvp.ts.
 */

import { ENTITY_EVENTS as ENTITY_EVENT_CATALOG } from '@weldsuite/entity-events';

export const WELDCONNECT_TRIGGER_TYPES = ['entity_event', 'schedule'] as const;
export const WELDCONNECT_ACTION_TYPES = ['send_email', 'create_customer'] as const;

/** Tag carried by CRM sequence workflows (see routes/sequences). */
export const SEQUENCE_WORKFLOW_TAG = '__type:sequence';

export type WorkflowIssueCode =
  | 'no_trigger'
  | 'unsupported_trigger'
  | 'incomplete_entity_event'
  | 'unknown_entity_event'
  | 'schedule_not_recurring'
  | 'invalid_cron'
  | 'invalid_timezone'
  | 'no_steps'
  | 'unsupported_action'
  | 'missing_field';

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  triggerId?: string;
  stepId?: string;
  /** The offending trigger/action type, when relevant. */
  type?: string;
  /** The missing config field, for `missing_field`. */
  field?: string;
}

type Bag = Record<string, unknown>;

function asBag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Read a trigger field that the editor may store flat or nested under `config`. */
function triggerField(trigger: Bag, key: string): unknown {
  return trigger[key] ?? asBag(trigger.config)[key];
}

export function isSequenceWorkflow(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes(SEQUENCE_WORKFLOW_TAG);
}

// Cron — the grammar the schedule sweep's matcher understands
// (@weldsuite/workflow-integrations/cron): `*`, `*/n`, and comma lists of numbers or
// `a-b` ranges, per field. Anything else would silently never fire.
const CRON_FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function isValidCronField(field: string, [min, max]: [number, number]): boolean {
  if (field === '*') return true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= max;
  }
  return field.split(',').every((token) => {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      return a >= min && b <= max && a <= b;
    }
    if (!/^\d+$/.test(token)) return false;
    const n = Number(token);
    return n >= min && n <= max;
  });
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => isValidCronField(field, CRON_FIELD_BOUNDS[i]));
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Required config per MVP action — mirrors ACTION_REQUIRED_FIELDS in the editor. */
const REQUIRED_ACTION_FIELDS: Record<(typeof WELDCONNECT_ACTION_TYPES)[number], string[]> = {
  send_email: ['to', 'subject', 'body'],
  create_customer: ['name'],
};

function validateTrigger(trigger: Bag): WorkflowIssue[] {
  const triggerId = typeof trigger.id === 'string' ? trigger.id : undefined;
  const type = String(trigger.type ?? '');

  if (!(WELDCONNECT_TRIGGER_TYPES as readonly string[]).includes(type)) {
    return [{ code: 'unsupported_trigger', triggerId, type }];
  }

  if (type === 'entity_event') {
    const entityType = triggerField(trigger, 'entityType');
    const eventType = triggerField(trigger, 'eventType');
    if (isBlank(entityType) || isBlank(eventType)) return [{ code: 'incomplete_entity_event', triggerId }];
    const events = (ENTITY_EVENT_CATALOG as Record<string, readonly string[]>)[String(entityType)];
    if (!events || !events.includes(String(eventType))) {
      return [{ code: 'unknown_entity_event', triggerId }];
    }
    return [];
  }

  // schedule
  const scheduleType = triggerField(trigger, 'scheduleType');
  if (scheduleType !== undefined && scheduleType !== 'recurring') {
    return [{ code: 'schedule_not_recurring', triggerId }];
  }
  const issues: WorkflowIssue[] = [];
  const cron = triggerField(trigger, 'cronExpression');
  if (typeof cron !== 'string' || !isValidCronExpression(cron)) issues.push({ code: 'invalid_cron', triggerId });
  const timezone = triggerField(trigger, 'timezone');
  if (timezone !== undefined && (typeof timezone !== 'string' || !isValidTimezone(timezone))) {
    issues.push({ code: 'invalid_timezone', triggerId });
  }
  return issues;
}

function validateStep(step: Bag): WorkflowIssue[] {
  const stepId = typeof step.id === 'string' ? step.id : undefined;
  const type = String(step.type ?? '');
  if (!(WELDCONNECT_ACTION_TYPES as readonly string[]).includes(type)) {
    return [{ code: 'unsupported_action', stepId, type }];
  }
  const config = asBag(step.config ?? step.inputs);
  return REQUIRED_ACTION_FIELDS[type as (typeof WELDCONNECT_ACTION_TYPES)[number]]
    .filter((field) => isBlank(config[field]))
    .map((field) => ({ code: 'missing_field' as const, stepId, type, field }));
}

/**
 * Everything that stops this workflow from going live in WeldConnect. Empty ⇒
 * it may be activated. Disabled triggers are ignored (they never fire), but at
 * least one enabled trigger is required.
 */
export function validateWeldConnectWorkflow(workflow: { triggers?: unknown; steps?: unknown }): WorkflowIssue[] {
  const triggers = (Array.isArray(workflow.triggers) ? workflow.triggers : [])
    .map(asBag)
    .filter((t) => t.isEnabled !== false);
  const steps = (Array.isArray(workflow.steps) ? workflow.steps : []).map(asBag);

  const issues: WorkflowIssue[] = [];
  if (triggers.length === 0) issues.push({ code: 'no_trigger' });
  for (const trigger of triggers) issues.push(...validateTrigger(trigger));
  if (steps.length === 0) issues.push({ code: 'no_steps' });
  for (const step of steps) issues.push(...validateStep(step));
  return issues;
}

/**
 * The recurring schedule triggers of a workflow, normalized — the input to the
 * `workflow_schedules` sync. One-time schedules and malformed entries are left
 * out (activation rejects them anyway).
 */
export interface RecurringScheduleTrigger {
  triggerId: string;
  name: string | null;
  cronExpression: string;
  timezone: string;
  isEnabled: boolean;
}

export function recurringScheduleTriggers(triggers: unknown): RecurringScheduleTrigger[] {
  if (!Array.isArray(triggers)) return [];
  const result: RecurringScheduleTrigger[] = [];
  for (const raw of triggers) {
    const trigger = asBag(raw);
    // `workflow_schedules.trigger_id` is varchar(30); editor ids (`trigger-<ms>`) fit easily.
    if (trigger.type !== 'schedule' || typeof trigger.id !== 'string' || !trigger.id || trigger.id.length > 30) {
      continue;
    }
    const scheduleType = triggerField(trigger, 'scheduleType');
    if (scheduleType !== undefined && scheduleType !== 'recurring') continue;
    const cron = triggerField(trigger, 'cronExpression');
    if (typeof cron !== 'string' || !isValidCronExpression(cron)) continue;
    const timezone = triggerField(trigger, 'timezone');
    result.push({
      triggerId: trigger.id,
      name: typeof trigger.name === 'string' && trigger.name ? trigger.name : null,
      cronExpression: cron.trim(),
      timezone: typeof timezone === 'string' && isValidTimezone(timezone) ? timezone : 'UTC',
      isEnabled: trigger.isEnabled !== false,
    });
  }
  return result;
}

/** Ids of every schedule trigger in a trigger list (recurring or not). */
export function scheduleTriggerIds(triggers: unknown): string[] {
  if (!Array.isArray(triggers)) return [];
  return triggers
    .map(asBag)
    .filter((t) => t.type === 'schedule' && typeof t.id === 'string' && t.id && t.id.length <= 30)
    .map((t) => t.id as string);
}
