/**
 * Audit Log Writer — Writes audit log entries from entity events
 *
 * Called by the event processor to persist audit logs for every entity mutation.
 * Failures are caught and logged so they never block event forwarding.
 *
 * Idempotency (Phase 2): skips insert when `metadata.eventId` already matches
 * `event.id` (hub retries re-fan out the same message). No unique index yet —
 * select-before-insert only; a DB unique constraint is a follow-up migration.
 */

import { eq, sql } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from '../lib/id';
import type { EntityEventMessage } from '../lib/entity-events';
import type { Database } from '../db';

/**
 * Entity types whose display name sits in a field the generic list below would
 * miss or reach too late. Every other entity type uses `GENERIC_NAME_FIELDS`.
 */
const ENTITY_NAME_FIELDS: Record<string, string[]> = {
  project_task: ['title'],
  personal_task: ['title'],
  contact: ['displayName', 'fullName'],
  customer: ['name', 'companyName'],
  commerce_customer: ['name', 'companyName'],
  // Identity layer — companies/people moved to app-api with these payloads.
  company: ['displayName', 'name', 'tradingName'],
  person: ['displayName', 'fullName'],
  product: ['name'],
  order: ['orderNumber'],
  invoice: ['invoiceNumber'],
  category: ['name'],
  helpdesk_conversation: ['subject'],
  parcel: ['trackingNumber'],
  lead: ['name', 'companyName'],
  opportunity: ['name'],
  journal_entry: ['reference'],
  bank_account: ['name'],
  account: ['name'],
  project: ['name'],
  warehouse: ['name'],
  supplier: ['name', 'companyName'],
  pipeline: ['name'],
  deal: ['name'],
  tag: ['name'],
  label: ['name'],
  template: ['name'],
  workflow: ['name'],
  vat_return: ['periodLabel', 'name'],
  tax_return: ['periodLabel', 'name'],
  bill: ['billNumber', 'number', 'reference'],
  accounting_contact: ['displayName', 'name', 'companyName'],
  meeting: ['title', 'name', 'subject'],
  meeting_session: ['title', 'name'],
  calendar_event: ['title', 'summary'],
  email: ['subject'],
  helpdesk_ticket: ['subject', 'title'],
  ticket: ['subject', 'title'],
};

/**
 * Fields tried, in order, for any entity type, after its own fields. Payloads
 * across modules name the same thing differently (contacts `firstName` +
 * `lastName`, VAT returns `periodLabel`, documents `number`, …); without a
 * fallback most rows had no record name at all.
 */
const GENERIC_NAME_FIELDS = [
  'displayName',
  'name',
  'title',
  'subject',
  'fullName',
  'companyName',
  'label',
  'periodLabel',
  'invoiceNumber',
  'orderNumber',
  'billNumber',
  'number',
  'reference',
  'trackingNumber',
  'code',
  'email',
];

/** Module prefixes to strip for cleaner display names. */
const MODULE_PREFIXES = [
  'project_',
  'personal_',
  'commerce_',
  'helpdesk_',
  'accounting_',
  'mail_',
  'parcel_',
  'wms_',
];

function nonEmptyString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Extract a human-readable name from the entity's data payload. */
export function getEntityDisplayName(
  entityType: string,
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data || typeof data !== 'object') return null;
  for (const field of ENTITY_NAME_FIELDS[entityType] ?? []) {
    const value = nonEmptyString(data[field]);
    if (value) return value;
  }
  // A person's name split over two fields.
  const first = nonEmptyString(data.firstName);
  const last = nonEmptyString(data.lastName);
  if (first || last) return [first, last].filter(Boolean).join(' ');
  for (const field of GENERIC_NAME_FIELDS) {
    const value = nonEmptyString(data[field]);
    if (value) return value;
  }
  return null;
}

/** Strip module prefix from entity type for display. e.g. "project_task" → "task" */
function stripModulePrefix(entityType: string): string {
  for (const prefix of MODULE_PREFIXES) {
    if (entityType.startsWith(prefix)) {
      return entityType.slice(prefix.length);
    }
  }
  return entityType;
}

/** Look up a user's display name from the workspace_members table. */
async function getUserName(
  db: Database,
  userId: string,
): Promise<string | null> {
  try {
    const [member] = await db
      .select({ name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .limit(1);
    return member?.name || null;
  } catch {
    return null;
  }
}

/**
 * Build an Attio-style description.
 *
 * created/deleted/archived → "'Fix login bug' was created by Jane Doe"
 * updated (with changes)   → "Jane Doe changed Status on 'Fix login bug'"
 * updated (multi)          → "Jane Doe changed Status and Priority on 'Fix login bug'"
 */
export function buildDescription(
  action: string,
  entityType: string,
  entityName: string | null,
  userName: string | null,
  changedFields: string[] | null,
): string {
  const displayType = stripModulePrefix(entityType).replaceAll('_', ' ');
  const subject = entityName ? `'${entityName}'` : capitalise(displayType);
  const actor = userName || 'System';

  if (action === 'updated') {
    const fields = changedFields?.length
      ? formatFieldList(changedFields)
      : null;
    if (fields) {
      return `${actor} changed ${fields}`;
    }
    return `${actor} updated ${subject}`;
  }

  return `${subject} was ${actionPhrase(action)} by ${actor}`;
}

/**
 * How an action reads after "was". Physical actions other than the CRUD ones
 * (stage_changed, won, …) used to be turned into "stage_changeded" / "woned".
 */
const ACTION_PHRASES: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  archived: 'archived',
  unarchived: 'restored',
  restored: 'restored',
  won: 'marked as won',
  lost: 'marked as lost',
  stage_changed: 'moved to another stage',
  status_changed: 'given another status',
  priority_changed: 'given another priority',
  state_changed: 'given another state',
  converted: 'converted',
  qualified: 'qualified',
  completed: 'completed',
  assigned: 'assigned',
  escalated: 'escalated',
  resolved: 'resolved',
  closed: 'closed',
  tagged: 'tagged',
  sent: 'sent',
  paid: 'marked as paid',
  moved: 'moved',
};

/** "stage_changed" → "moved to another stage"; unknown keys are humanised ("foo_bar" → "foo bar"). */
export function actionPhrase(action: string): string {
  return ACTION_PHRASES[action] ?? action.replaceAll(/[_-]+/g, ' ').trim();
}

/** "camelCase" / "snake_case" → "Camel Case" / "Snake Case" */
function humaniseFieldName(field: string): string {
  return field
    .replaceAll('_', ' ')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

/** ["status", "priority", "assignee"] → "Status, Priority, and Assignee" */
function formatFieldList(fields: string[]): string {
  const names = fields.map(humaniseFieldName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Transform entity event changes from `{ old, new }` to `{ from, to }` format
 * used by the audit_logs table.
 */
function transformChanges(
  changes?: Record<string, { old: unknown; new: unknown }>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  if (!changes) return undefined;

  const transformed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(changes)) {
    transformed[key] = { from: value.old, to: value.new };
  }
  return transformed;
}

/**
 * Write an audit log entry from an entity event message.
 * Wrapped in try/catch so failures never block event forwarding.
 *
 * @returns `'written'` | `'duplicate'` | `'error'`
 */
export async function writeAuditLogFromEvent(
  db: Database,
  event: EntityEventMessage,
): Promise<'written' | 'duplicate' | 'error'> {
  try {
    // Phase 2 idempotency: hub (and queue) retries reuse the same event.id.
    const [existing] = await db
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(sql`${schema.auditLogs.metadata}->>'eventId' = ${event.id}`)
      .limit(1);
    if (existing) {
      console.log(`[AuditLogWriter] Skipping duplicate event ${event.id}`);
      return 'duplicate';
    }

    const data = event.data as Record<string, unknown>;
    const entityName = getEntityDisplayName(event.entityType, data);
    const displayType = stripModulePrefix(event.entityType);
    const userName = await getUserName(db, event.metadata.userId);

    await db.insert(schema.auditLogs).values({
      id: generateId('aud'),
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      description: buildDescription(
        event.action,
        event.entityType,
        entityName,
        userName,
        event.changes ? Object.keys(event.changes) : null,
      ),
      changes: transformChanges(event.changes),
      data,
      performedBy: event.metadata.userId,
      performedByName: userName,
      metadata: {
        source: event.metadata.source,
        workspaceId: event.metadata.workspaceId,
        eventId: event.id,
        translationKey: `audit.${event.action}`,
        translationParams: {
          entityType: displayType,
          entityName,
          changedFields: event.changes ? Object.keys(event.changes) : undefined,
        },
      },
    });
    return 'written';
  } catch (err) {
    console.error('[AuditLogWriter] Failed to write audit log:', err);
    return 'error';
  }
}
