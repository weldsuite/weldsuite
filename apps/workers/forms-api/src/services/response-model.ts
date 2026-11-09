/**
 * What the results side shares: the versions of a form, the column model of
 * the responses table (merged across versions by block id), the response DTO
 * and the list conditions, including the answer filters evaluated in SQL on
 * the `answers` jsonb (docs/plans/weldforms.md, "Platform UI → Results").
 */

import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  displayAnswer,
  fieldsOf,
  isBooleanField,
  isChoiceField,
  isCompositeField,
  isNumericField,
  isTextField,
  partsOf,
  type FieldBlock,
} from '@weldsuite/forms-engine';
import { formDefinitionSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import {
  FORM_LIMITS,
  responseAnswerFilterSchema,
  type FormResponseColumn,
  type FormResponseDto,
  type FormUserRef,
  type ListFormResponsesQuery,
  type ResponseAnswerFilter,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError } from '../lib/errors';

const { formResponses, formVersions, formResponseFiles } = schema;

export type ResponseRow = typeof formResponses.$inferSelect;
export type FileRow = typeof formResponseFiles.$inferSelect;

export interface VersionInfo {
  id: string;
  number: number;
  definition: FormDefinition;
  fields: Map<string, FieldBlock>;
}

/** Every version of a form, oldest first. */
export async function loadVersions(db: Database, formId: string): Promise<VersionInfo[]> {
  const rows = await db.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(asc(formVersions.number));
  return rows.map((row) => {
    const definition = formDefinitionSchema.parse(row.definition);
    return { id: row.id, number: row.number, definition, fields: new Map(fieldsOf(definition).map((f) => [f.id, f])) };
  });
}

/** A field by block id as the newest version that has it defines it. */
export function latestFields(versions: readonly VersionInfo[]): Map<string, FieldBlock> {
  const map = new Map<string, FieldBlock>();
  for (const version of versions) for (const [id, field] of version.fields) map.set(id, field);
  return map;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** The metadata columns; their keys are what the platform's `metaCell` recognises. */
export const META_COLUMNS = {
  number: { label: 'Number', type: 'number' },
  submittedAt: { label: 'Submitted', type: 'date' },
  status: { label: 'Status', type: 'status' },
  startedAt: { label: 'Started', type: 'date' },
  email: { label: 'Email', type: 'email' },
  score: { label: 'Score', type: 'score' },
  duration: { label: 'Time taken', type: 'duration' },
  version: { label: 'Version', type: 'number' },
  source: { label: 'Source', type: 'text' },
  device: { label: 'Device', type: 'text' },
  country: { label: 'Country', type: 'text' },
  referrer: { label: 'Referrer', type: 'text' },
} as const;

export type MetaKey = keyof typeof META_COLUMNS;

/** The same normalising as the platform: `Submitted at` and `submitted_at` are one key. */
const normalise = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const RESERVED = new Set([...Object.keys(META_COLUMNS).map(normalise), 'responsenumber', 'no', 'submitted', 'started', 'respondentemail', 'respondent', 'durationms', 'timetaken', 'versionnumber']);

/** The key of an answer column: the block id, with the sub-field for contact info and address. */
export const columnKey = (blockId: string, part?: string) => (part ? `${blockId}.${part}` : blockId);

const PART_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  line1: 'Address line 1',
  line2: 'Address line 2',
  city: 'City',
  state: 'State',
  postalCode: 'Postal code',
  country: 'Country',
};

/**
 * Columns of the responses table and the export: number, submitted and email
 * first, then every field of every version (a field removed later stays),
 * the hidden fields, then the rest of the metadata.
 */
export function buildColumns(versions: readonly VersionInfo[]): FormResponseColumn[] {
  const answers = new Map<string, FormResponseColumn>();
  const order: string[] = [];
  const hidden = new Map<string, number[]>();
  for (const version of versions) {
    for (const field of version.fields.values()) {
      const parts = isCompositeField(field) ? partsOf(field).filter((p) => p.enabled) : [{ part: undefined as string | undefined }];
      for (const { part } of parts) {
        const key = columnKey(field.id, part);
        const label = part ? `${field.title || field.ref} · ${PART_LABELS[part] ?? part}` : field.title || field.ref;
        const existing = answers.get(key);
        if (existing) {
          existing.versions.push(version.number);
          existing.label = label;
          existing.type = field.type;
        } else {
          answers.set(key, { key, blockId: field.id, ...(part ? { part } : {}), label, type: field.type, versions: [version.number] });
          order.push(key);
        }
      }
    }
    for (const { name } of version.definition.hidden) {
      const list = hidden.get(name) ?? [];
      list.push(version.number);
      hidden.set(name, list);
    }
  }
  const meta = (key: MetaKey, versionNumbers: number[]): FormResponseColumn => ({ key, ...META_COLUMNS[key], versions: versionNumbers });
  const all = versions.map((v) => v.number);
  return [
    meta('number', all),
    meta('submittedAt', all),
    meta('email', all),
    ...order.map((key) => answers.get(key)!),
    // A hidden field named like a metadata column would be shadowed by it in the table: it stays out.
    ...[...hidden].filter(([name]) => !RESERVED.has(normalise(name))).map(([name, v]): FormResponseColumn => ({ key: name, label: name, type: 'hidden', versions: v })),
    meta('score', all),
    meta('duration', all),
    meta('status', all),
    meta('startedAt', all),
    meta('version', all),
    meta('source', all),
    meta('device', all),
    meta('country', all),
    meta('referrer', all),
  ];
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export const isAbandoned = (row: Pick<ResponseRow, 'status' | 'updatedAt'>, now: number): boolean =>
  row.status === 'in_progress' && now - row.updatedAt.getTime() >= FORM_LIMITS.abandonedAfterSeconds * 1000;

export const downloadPath = (formId: string, responseId: string, fileId: string) => `/api/forms/forms/${formId}/responses/${responseId}/files/${fileId}`;

export function toResponseDto(
  row: ResponseRow,
  extras: { versionNumber: number; files: FileRow[]; respondent: FormUserRef | null; now?: number },
): FormResponseDto {
  const m = row.metadata ?? {};
  return {
    id: row.id,
    formId: row.formId,
    versionId: row.versionId,
    versionNumber: extras.versionNumber,
    number: row.number,
    status: row.status,
    answers: row.answers ?? {},
    hidden: row.hidden ?? {},
    variables: row.variables ?? {},
    score: row.score,
    endingId: row.endingId,
    respondentEmail: row.respondentEmail,
    respondent: extras.respondent,
    personId: row.personId,
    invitationId: row.invitationId,
    lastBlockId: row.lastBlockId,
    answeredCount: row.answeredCount,
    abandoned: isAbandoned(row, extras.now ?? Date.now()),
    metadata: {
      ...(m.referrer ? { referrer: m.referrer } : {}),
      ...(m.utm ? { utm: m.utm } : {}),
      ...(m.source ? { source: m.source } : {}),
      ...(m.device ? { device: m.device } : {}),
      ...(m.browser ? { browser: m.browser } : {}),
      ...(m.os ? { os: m.os } : {}),
      ...(m.country ? { country: m.country } : {}),
    },
    files: extras.files.map((f) => ({
      fileId: f.id,
      name: f.name,
      size: f.sizeBytes,
      type: f.contentType,
      blockId: f.blockId,
      kind: f.kind,
      downloadPath: downloadPath(f.formId, f.responseId, f.id),
    })),
    startedAt: row.startedAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    durationMs: row.durationMs,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** An answer as text, for the export and the cells; the part of a contact or address answer when given. */
export function answerCell(field: FieldBlock | undefined, raw: unknown, part?: string): string {
  if (raw === undefined || raw === null) return '';
  if (part) {
    if (typeof raw !== 'object') return '';
    const value = (raw as Record<string, unknown>)[part];
    return value === undefined || value === null ? '' : String(value);
  }
  if (field) return displayAnswer(field, raw);
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const likePattern = (text: string) => `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

export function parseAnswerFilters(raw: string | undefined): ResponseAnswerFilter[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new FormsError(400, 'BAD_REQUEST', '"filters" must be a JSON array.');
  }
  if (!Array.isArray(json)) throw new FormsError(400, 'BAD_REQUEST', '"filters" must be a JSON array.');
  if (json.length > 20) throw new FormsError(400, 'BAD_REQUEST', 'At most 20 filters can be combined.');
  const parsed: ResponseAnswerFilter[] = [];
  for (const item of json) {
    const result = responseAnswerFilterSchema.safeParse(item);
    if (!result.success) throw new FormsError(400, 'BAD_REQUEST', 'A filter is not valid.');
    parsed.push(result.data);
  }
  return parsed;
}

type Kind = 'text' | 'numeric' | 'boolean' | 'choice' | 'presence';

function kindOf(field: FieldBlock | undefined, part: string | undefined): Kind {
  if (!field) return 'text';
  if (isCompositeField(field)) return part ? 'text' : 'presence';
  if (isChoiceField(field)) return 'choice';
  if (isNumericField(field)) return 'numeric';
  if (isBooleanField(field)) return 'boolean';
  if (isTextField(field) || field.type === 'date') return 'text';
  return 'presence';
}

const asArray = (value: ResponseAnswerFilter['value']): string[] => (Array.isArray(value) ? value : value === undefined ? [] : [String(value)]);

/** One answer filter as SQL on `form_responses.answers`. `fields` decides how the stored value is read. */
export function answerFilterSql(filter: ResponseAnswerFilter, fields: ReadonlyMap<string, FieldBlock>): SQL {
  const answers = formResponses.answers;
  const field = fields.get(filter.blockId);
  const kind = kindOf(field, filter.part);
  const node = sql`(${answers} -> ${filter.blockId}::text)`;
  const text = filter.part ? sql`(${node} ->> ${filter.part}::text)` : sql`(${answers} ->> ${filter.blockId}::text)`;
  const { operator, value } = filter;

  if (operator === 'is_answered' || operator === 'is_empty') {
    let answered: SQL;
    if (kind === 'text') answered = sql`(${text} is not null and btrim(${text}) <> '')`;
    else if (kind === 'presence') answered = sql`(${node} is not null and ${node} <> 'null'::jsonb and ${node} <> '[]'::jsonb and ${node} <> '{}'::jsonb)`;
    else answered = sql`(${node} is not null and ${node} <> 'null'::jsonb)`;
    return operator === 'is_answered' ? answered : sql`(not ${answered})`;
  }

  if (value === undefined) throw new FormsError(400, 'BAD_REQUEST', 'A filter needs a value.');

  switch (kind) {
    case 'choice': {
      const ids = sql`(${node} -> 'choiceIds')`;
      const other = sql`(${node} ->> 'other')`;
      const list = asArray(value);
      const any = sql`coalesce(jsonb_exists_any(${ids}, ${sql`ARRAY[${sql.join(list.map((v) => sql`${v}`), sql`, `)}]::text[]`}), false)`;
      if (operator === 'any_of' || operator === 'is') return list.length === 0 ? sql`false` : any;
      if (operator === 'none_of' || operator === 'is_not') return list.length === 0 ? sql`true` : sql`(not ${any})`;
      if (operator === 'contains') return sql`${other} ilike ${likePattern(String(value))}`;
      throw new FormsError(400, 'BAD_REQUEST', `Operator "${operator}" does not apply to this field.`);
    }
    case 'numeric': {
      const num = sql`(case when jsonb_typeof(${node}) = 'number' then (${answers} ->> ${filter.blockId}::text)::numeric end)`;
      const n = Number(value);
      if (!Number.isFinite(n)) throw new FormsError(400, 'BAD_REQUEST', 'A number is needed for this filter.');
      if (operator === 'is') return sql`coalesce(${num} = ${n}, false)`;
      if (operator === 'is_not') return sql`coalesce(${num} <> ${n}, true)`;
      if (operator === 'greater_than') return sql`coalesce(${num} > ${n}, false)`;
      if (operator === 'less_than') return sql`coalesce(${num} < ${n}, false)`;
      throw new FormsError(400, 'BAD_REQUEST', `Operator "${operator}" does not apply to this field.`);
    }
    case 'boolean': {
      const wanted = value === true || value === 'true' || value === 'yes' || value === 1;
      const bool = sql`coalesce(${node} = ${JSON.stringify(wanted)}::jsonb, false)`;
      if (operator === 'is') return bool;
      if (operator === 'is_not') return sql`(not ${bool})`;
      throw new FormsError(400, 'BAD_REQUEST', `Operator "${operator}" does not apply to this field.`);
    }
    case 'text': {
      const v = String(value);
      const lowered = sql`lower(btrim(${text}))`;
      if (operator === 'is' || operator === 'any_of') {
        const list = operator === 'is' ? [v] : asArray(value);
        return list.length === 0 ? sql`false` : sql`coalesce(${lowered} in (${sql.join(list.map((x) => sql`${x.trim().toLowerCase()}`), sql`, `)}), false)`;
      }
      if (operator === 'is_not' || operator === 'none_of') {
        const list = operator === 'is_not' ? [v] : asArray(value);
        return list.length === 0 ? sql`true` : sql`coalesce(${lowered} not in (${sql.join(list.map((x) => sql`${x.trim().toLowerCase()}`), sql`, `)}), true)`;
      }
      if (operator === 'contains') return sql`coalesce(lower(${text}) like ${likePattern(v.toLowerCase())}, false)`;
      if (operator === 'greater_than') return sql`coalesce(${text} > ${v}, false)`;
      if (operator === 'less_than') return sql`coalesce(${text} < ${v}, false)`;
      throw new FormsError(400, 'BAD_REQUEST', `Operator "${operator}" does not apply to this field.`);
    }
    default:
      throw new FormsError(400, 'BAD_REQUEST', 'This field can only be filtered on whether it was answered.');
  }
}

export type ResponseFilterQuery = Pick<ListFormResponsesQuery, 'status' | 'from' | 'to' | 'q' | 'versionId' | 'personId' | 'invitationId' | 'filters'>;

/** The `where` of a responses list or export: the form, the status, dates, search, version, person, invitation and answer filters. */
export function responseConditions(formId: string, query: ResponseFilterQuery, fields: ReadonlyMap<string, FieldBlock>): SQL {
  const when = sql`coalesce(${formResponses.submittedAt}, ${formResponses.startedAt})`;
  const conditions: SQL[] = [eq(formResponses.formId, formId)];
  if (query.status && query.status !== 'all') conditions.push(eq(formResponses.status, query.status));
  if (query.from) conditions.push(sql`${when} >= ${new Date(query.from).toISOString()}::timestamptz`);
  if (query.to) conditions.push(sql`${when} <= ${new Date(query.to).toISOString()}::timestamptz`);
  if (query.q?.trim()) {
    const like = likePattern(query.q.trim().toLowerCase());
    conditions.push(or(ilike(formResponses.searchText, like), ilike(formResponses.respondentEmail, like))!);
  }
  if (query.versionId) conditions.push(eq(formResponses.versionId, query.versionId));
  if (query.personId) conditions.push(eq(formResponses.personId, query.personId));
  if (query.invitationId) conditions.push(eq(formResponses.invitationId, query.invitationId));
  for (const filter of parseAnswerFilters(query.filters)) conditions.push(answerFilterSql(filter, fields));
  return and(...conditions)!;
}

export function responseOrder(sort: ListFormResponsesQuery['sort']): SQL[] {
  const when = sql`coalesce(${formResponses.submittedAt}, ${formResponses.startedAt})`;
  switch (sort) {
    case 'oldest':
      return [sql`${when} asc`, sql`${formResponses.id} asc`];
    case 'score_desc':
      return [sql`${formResponses.score} desc nulls last`, sql`${when} desc`, sql`${formResponses.id} desc`];
    case 'score_asc':
      return [sql`${formResponses.score} asc nulls last`, sql`${when} desc`, sql`${formResponses.id} desc`];
    default:
      return [sql`${when} desc`, sql`${formResponses.id} desc`];
  }
}
