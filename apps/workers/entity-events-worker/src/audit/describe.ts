/**
 * Human-readable audit descriptions.
 *
 * Moved from audit-log-worker/src/services/audit-log-writer.ts. Pure string
 * formatting, split out from the consumer so it can be tested without a DB.
 *
 * created/deleted/archived → "'Fix login bug' was created by Jane Doe"
 * updated (with changes)   → "Jane Doe changed Status on 'Fix login bug'"
 */

/** Fields in event.data that hold a human-readable name, per entity type. */
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

/** Module prefixes stripped for cleaner display names. */
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

export function getEntityDisplayName(
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

/** "project_task" → "task" */
export function stripModulePrefix(entityType: string): string {
  for (const prefix of MODULE_PREFIXES) {
    if (entityType.startsWith(prefix)) return entityType.slice(prefix.length);
  }
  return entityType;
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
  if (names.length === 1) return names[0]!;
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

export function buildDescription(
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
    const fields = changedFields?.length ? formatFieldList(changedFields) : null;
    return fields ? `${actor} changed ${fields}` : `${actor} updated ${subject}`;
  }

  return `${subject} was ${toPastTense(action)} by ${actor}`;
}

/** audit_logs stores `{ from, to }`; the wire format is `{ old, new }`. */
export function transformChanges(
  changes?: Record<string, { old: unknown; new: unknown }>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  if (!changes) return undefined;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(changes)) {
    out[key] = { from: value.old, to: value.new };
  }
  return out;
}
