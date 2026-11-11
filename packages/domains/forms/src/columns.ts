/**
 * The column model of a form's responses table: metadata columns plus one
 * column per question across every published version, plus the hidden fields.
 * WeldSheets' connected table `form_responses` (ADR SHEETS-007) lists with it;
 * the responses table and the export of forms-api can read the same shape.
 *
 * Column keys fit the connected-table field key rule (`[a-zA-Z][a-zA-Z0-9]*`,
 * saved in sheet definitions, so they never change):
 *   - metadata: `number`, `submittedAt`, ... (FORM_RESPONSE_META_COLUMNS);
 *   - a question: `q` + its block id without the underscore (`b_x7Kp2QaZ` is
 *     `qbx7Kp2QaZ`); only block ids of the builder's shape (`b_` + letters
 *     and digits) get a column;
 *   - a hidden field: `h` + its name, when the name is letters and digits.
 *
 * Left out on purpose: questions the author marked sensitive (a sheet is shared
 * more widely than a form) and file or signature questions.
 */

import {
  displayAnswer,
  fieldsOf,
  isBooleanField,
  isFileField,
  isNumericField,
  ownValue,
  prepareAnswer,
  type FieldBlock,
  type FormDefinition,
} from '@weldsuite/forms-engine';

export type FormColumnType = 'text' | 'number' | 'date' | 'datetime' | 'boolean';

export interface FormColumn {
  key: string;
  kind: 'meta' | 'answer' | 'hidden';
  type: FormColumnType;
  /** The title of the question (its latest wording), the hidden field's name, or the metadata key. */
  label: string;
  /** `answer` columns: the block id. */
  blockId?: string;
  /** `hidden` columns: the field name. */
  name?: string;
}

/** The metadata of a completed response, in table order. Keys are saved in sheet definitions. */
export const FORM_RESPONSE_META_COLUMNS = [
  { key: 'number', type: 'number' },
  { key: 'submittedAt', type: 'datetime' },
  { key: 'startedAt', type: 'datetime' },
  { key: 'respondentEmail', type: 'text' },
  { key: 'score', type: 'number' },
  { key: 'durationSeconds', type: 'number' },
  { key: 'personId', type: 'text' },
] as const satisfies ReadonlyArray<{ key: string; type: FormColumnType }>;

export type FormMetaKey = (typeof FORM_RESPONSE_META_COLUMNS)[number]['key'];

const META_BY_KEY: ReadonlyMap<string, FormColumnType> = new Map<string, FormColumnType>(
  FORM_RESPONSE_META_COLUMNS.map((c) => [c.key, c.type]),
);

export function isMetaColumnKey(key: string): key is FormMetaKey {
  return META_BY_KEY.has(key);
}

const BLOCK_ID = /^b_([A-Za-z0-9]+)$/;
const ANSWER_KEY = /^qb([A-Za-z0-9]+)$/;
const HIDDEN_KEY = /^h([A-Za-z0-9]+)$/;

/** The column key of a question, or null when its id is not of the builder's shape. */
export function answerColumnKey(blockId: string): string | null {
  const m = BLOCK_ID.exec(blockId);
  return m ? `qb${m[1]}` : null;
}

/** The block id behind a question column key; null when the key is not one. */
export function blockIdOfColumnKey(key: string): string | null {
  const m = ANSWER_KEY.exec(key);
  return m ? `b_${m[1]}` : null;
}

export function hiddenColumnKey(name: string): string | null {
  return /^[A-Za-z0-9]+$/.test(name) ? `h${name}` : null;
}

export function hiddenNameOfColumnKey(key: string): string | null {
  return HIDDEN_KEY.exec(key)?.[1] ?? null;
}

/** The kind of a column key without a form at hand: a metadata, question or hidden-field key, else null. */
export function columnKindOfKey(key: string): FormColumn['kind'] | null {
  if (isMetaColumnKey(key)) return 'meta';
  if (blockIdOfColumnKey(key)) return 'answer';
  if (hiddenNameOfColumnKey(key)) return 'hidden';
  return null;
}

function columnTypeOf(field: FieldBlock): FormColumnType {
  if (isNumericField(field)) return 'number';
  if (isBooleanField(field)) return 'boolean';
  if (field.type === 'date') return 'date';
  return 'text';
}

/** A question the table shows: not sensitive, not a file, and with a block id of the builder's shape. */
function listed(field: FieldBlock): boolean {
  return !field.sensitive && !isFileField(field) && answerColumnKey(field.id) !== null;
}

/**
 * The columns of a form across its versions (oldest first): metadata, every
 * question that ever existed in order of first appearance under its latest
 * wording and type, then the hidden fields.
 */
export function formColumns(definitions: readonly FormDefinition[]): FormColumn[] {
  const meta: FormColumn[] = FORM_RESPONSE_META_COLUMNS.map((c) => ({ key: c.key, kind: 'meta', type: c.type, label: c.key }));
  const answers = new Map<string, FormColumn>();
  const hidden = new Map<string, FormColumn>();
  for (const definition of definitions) {
    for (const field of fieldsOf(definition)) {
      const key = answerColumnKey(field.id);
      if (!key) continue;
      // A question made sensitive later leaves the table, whatever its earlier versions said.
      if (!listed(field)) {
        answers.delete(key);
        continue;
      }
      answers.set(key, { key, kind: 'answer', type: columnTypeOf(field), label: field.title, blockId: field.id });
    }
    for (const h of definition.hidden) {
      const key = hiddenColumnKey(h.name);
      if (key && !hidden.has(key)) hidden.set(key, { key, kind: 'hidden', type: 'text', label: h.name, name: h.name });
    }
  }
  return [...meta, ...answers.values(), ...hidden.values()];
}

/** Days from the spreadsheet epoch (1899-12-30) to the Unix epoch. */
const SERIAL_EPOCH_OFFSET = 25_569;
const DAY_MS = 86_400_000;

/** A Unix time in ms as a spreadsheet serial: whole days for a date, a fraction for the time of day. */
export function toSerial(ms: number, withTime: boolean): number {
  const days = ms / DAY_MS;
  return (withTime ? days : Math.floor(days)) + SERIAL_EPOCH_OFFSET;
}

export type ResponseCell = string | number | boolean | null;

/** The part of a response row the table reads. */
export interface ResponseLike {
  number: number | null;
  answers: Record<string, unknown>;
  hidden: Record<string, string>;
  score: number | null;
  respondentEmail: string | null;
  personId: string | null;
  startedAt: Date;
  submittedAt: Date | null;
  durationMs: number | null;
}

function metaCell(key: FormMetaKey, r: ResponseLike): ResponseCell {
  switch (key) {
    case 'number':
      return r.number;
    case 'submittedAt':
      return r.submittedAt ? toSerial(r.submittedAt.getTime(), true) : null;
    case 'startedAt':
      return toSerial(r.startedAt.getTime(), true);
    case 'respondentEmail':
      return r.respondentEmail;
    case 'score':
      return r.score;
    case 'durationSeconds':
      return r.durationMs === null ? null : Math.round(r.durationMs / 1000);
    case 'personId':
      return r.personId;
  }
}

/**
 * One cell of one response, read with the definition of the version the
 * response answered (its choices and labels). Text answers as their display
 * text, numbers as numbers, yes/no as booleans, dates as spreadsheet serials;
 * unanswered or malformed as null.
 */
export function responseCell(column: FormColumn, response: ResponseLike, definition: FormDefinition | undefined): ResponseCell {
  if (column.kind === 'meta') return metaCell(column.key as FormMetaKey, response);
  if (column.kind === 'hidden') return response.hidden[column.name ?? ''] || null;
  const field = definition ? fieldsOf(definition).find((f) => f.id === column.blockId) : undefined;
  if (!field || !listed(field)) return null;
  const prepared = prepareAnswer(field, ownValue(response.answers, field.id));
  if (prepared.kind !== 'value') return null;
  switch (column.type) {
    case 'number':
      return typeof prepared.value === 'number' ? prepared.value : null;
    case 'boolean':
      return typeof prepared.value === 'boolean' ? prepared.value : null;
    case 'date': {
      const ms = typeof prepared.value === 'string' ? Date.parse(`${prepared.value}T00:00:00Z`) : Number.NaN;
      return Number.isFinite(ms) ? toSerial(ms, false) : null;
    }
    default:
      return displayAnswer(field, prepared.value) || null;
  }
}
