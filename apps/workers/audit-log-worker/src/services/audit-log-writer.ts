/**
 * Audit Log Writer — Writes audit log entries from entity events
 *
 * Called by the event processor to persist audit logs for every entity mutation.
 * Failures are caught and logged so they never block event forwarding.
 */

import { eq } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from '../lib/id';
import type { EntityEventMessage } from '../lib/entity-events';
import type { Database } from '../db';

/** Maps entity types to the field(s) in event.data that contain a human-readable name. */
const ENTITY_NAME_FIELDS: Record<string, string[]> = {
  project_task: ['title'],
  personal_task: ['title'],
  contact: ['fullName', 'firstName'],
  customer: ['name', 'companyName'],
  commerce_customer: ['name', 'companyName'],
  // Identity layer — companies/people moved to app-api with these payloads.
  company: ['displayName', 'name', 'tradingName'],
  person: ['displayName', 'fullName', 'firstName', 'email'],
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
};

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

/** Extract a human-readable name from the entity's data payload. */
function getEntityDisplayName(
  entityType: string,
  data: Record<string, unknown>,
): string | null {
  const fields = ENTITY_NAME_FIELDS[entityType];
  if (!fields) return null;
  for (const field of fields) {
    const value = data[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
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
function buildDescription(
  action: string,
  entityType: string,
  entityName: string | null,
  userName: string | null,
  changedFields: string[] | null,
): string {
  const displayType = stripModulePrefix(entityType).replace(/_/g, ' ');
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

  const pastAction = toPastTense(action);
  return `${subject} was ${pastAction} by ${actor}`;
}

/** "camelCase" / "snake_case" → "Camel Case" / "Snake Case" */
function humaniseFieldName(field: string): string {
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** ["status", "priority", "assignee"] → "Status, Priority, and Assignee" */
function formatFieldList(fields: string[]): string {
  const names = fields.map(humaniseFieldName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toPastTense(action: string): string {
  if (action.endsWith('ed')) return action;
  if (action.endsWith('e')) return `${action}d`;
  return `${action}ed`;
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
 */
export async function writeAuditLogFromEvent(
  db: Database,
  event: EntityEventMessage,
): Promise<void> {
  try {
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
  } catch (err) {
    console.error('[AuditLogWriter] Failed to write audit log:', err);
  }
}
