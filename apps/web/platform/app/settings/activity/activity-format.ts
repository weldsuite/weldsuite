/**
 * Display helpers for Settings › Activity Log.
 *
 * Audit rows store raw keys (`opportunity`, `stage_changed`) and an English
 * description written at the time. The page renders its own translated text
 * from the structured fields instead, so old rows ("was woned by") read right
 * too, and anything without a translation is humanised rather than shown raw.
 */

import type { AuditLogRecord } from '@/hooks/queries/use-audit-log-queries';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

const NS = 'settings.activity';

/**
 * A dot-path translator over the locale tree that returns the key, silently,
 * when there is no string there. The page probes for optional translations
 * (an entity type or action may have none), which the shared translator would
 * log a warning for on every render.
 */
export function createQuietTranslator(tree: unknown): Translate {
  return (key, params) => {
    let value: unknown = tree;
    for (const part of key.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    }
    if (typeof value !== 'string') return key;
    if (!params) return value;
    // One pass, so a record name that happens to contain "{actor}" stays as is.
    return value.replaceAll(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/** `t(key)`, or null when the key has no translation (the translator echoes the key). */
function lookup(t: Translate, key: string, params?: Record<string, unknown>): string | null {
  const value = t(key, params);
  return value && value !== key ? value : null;
}

/** Module prefixes dropped from an untranslated entity type: `project_task` → `task`. */
const MODULE_PREFIXES = ['project_', 'personal_', 'commerce_', 'helpdesk_', 'accounting_', 'mail_', 'parcel_', 'wms_', 'desk_', 'hr_'];

/** `stage_changed` → `Stage changed`. */
export function humanizeKey(key: string): string {
  const words = key.replaceAll(/[_-]+/g, ' ').replaceAll(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function entityTypeLabel(entityType: string, t: Translate): string {
  const label = lookup(t, `${NS}.entityTypes.${entityType}`);
  if (label) return label;
  const prefix = MODULE_PREFIXES.find((p) => entityType.startsWith(p) && entityType.length > p.length);
  return humanizeKey(prefix ? entityType.slice(prefix.length) : entityType);
}

/** Action column label: `stage_changed` → "Stage changed". */
export function actionLabel(action: string, t: Translate): string {
  return lookup(t, `${NS}.actions.${action}`) ?? humanizeKey(action);
}

/** How an action reads after "was": `won` → "marked as won"; unknown → "stage changed". */
export function actionPhrase(action: string, t: Translate): string {
  return lookup(t, `${NS}.phrases.${action}`) ?? humanizeKey(action).toLowerCase();
}

/**
 * Field names tried for a record name, in order, when the row has none of its
 * own. Kept in step with GENERIC_NAME_FIELDS in the audit-log-worker writer;
 * rows written before that list grew only have their `data` snapshot.
 */
const NAME_FIELDS = [
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

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** The record's name, from the writer's resolved name or the data snapshot. */
export function recordName(log: Pick<AuditLogRecord, 'data' | 'metadata'>): string | null {
  const params = (log.metadata as { translationParams?: { entityName?: unknown } } | undefined)?.translationParams;
  const resolved = text(params?.entityName);
  if (resolved) return resolved;
  const data = log.data;
  if (!data || typeof data !== 'object') return null;
  const preferred = text(data.displayName) ?? text(data.fullName);
  if (preferred) return preferred;
  // A person's name split over two fields.
  const first = text(data.firstName);
  const last = text(data.lastName);
  if (first || last) return [first, last].filter(Boolean).join(' ');
  for (const field of NAME_FIELDS) {
    const value = text(data[field]);
    if (value) return value;
  }
  return null;
}

/**
 * Where a record opens, for the entity types that already have a URL. Others
 * render their name as plain text.
 */
export function recordHref(entityType: string, entityId: string): string | null {
  const id = encodeURIComponent(entityId);
  switch (entityType) {
    case 'company':
    case 'customer':
      return `/weldcrm/companies?stack=company:${id}:panel`;
    case 'person':
    case 'contact':
      return `/weldcrm/people?stack=person:${id}:panel`;
    case 'project_task':
    case 'task':
      return `/weldflow/task/${id}`;
    case 'project':
      return `/weldflow/project/${id}`;
    default:
      return null;
  }
}

function joinList(items: string[], and: string): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
}

/** Translated one-line description of an activity row. */
export function describeActivity(
  log: Pick<AuditLogRecord, 'action' | 'entityType' | 'changes' | 'data' | 'metadata' | 'performedByName'>,
  t: Translate,
): string {
  const name = recordName(log);
  const record = name ? `'${name}'` : entityTypeLabel(log.entityType, t);
  const actor = log.performedByName?.trim() || (lookup(t, `${NS}.descriptions.system`) ?? 'System');

  if (log.action === 'updated') {
    const fields = Object.keys(log.changes ?? {}).map(humanizeKey);
    if (fields.length > 0) {
      const and = lookup(t, `${NS}.descriptions.and`) ?? 'and';
      return t(`${NS}.descriptions.changedFieldsOn`, { actor, fields: joinList(fields, and), record });
    }
    return t(`${NS}.descriptions.updatedRecord`, { actor, record });
  }

  return t(`${NS}.descriptions.wasActioned`, { record, action: actionPhrase(log.action, t), actor });
}

/**
 * Entity-type filter options: one per label, so a current type and its legacy
 * name (company + customer) are one option whose value is a comma list.
 */
export const ENTITY_TYPE_FILTER_GROUPS: ReadonlyArray<readonly string[]> = [
  ['company', 'customer'],
  ['person', 'contact'],
  ['lead'],
  ['opportunity'],
  ['activity'],
  ['pipeline'],
  ['pipeline_stage'],
  ['project'],
  ['project_task', 'task'],
  ['invoice'],
  ['bill'],
  ['payment'],
  ['journal_entry'],
  ['accounting_contact'],
  ['vat_return'],
  ['product'],
  ['order', 'commerce_order'],
  ['helpdesk_ticket', 'ticket'],
  ['helpdesk_conversation', 'desk_conversation', 'conversation'],
  ['chat_channel'],
  ['meeting'],
  ['calendar_event'],
  ['parcel'],
  ['shipment'],
  ['hr_employee'],
];

/** Local-day bounds of a `YYYY-MM-DD` date, as ISO strings for the API. */
export function dayBounds(day: string): { start: string; end: string } | null {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}
