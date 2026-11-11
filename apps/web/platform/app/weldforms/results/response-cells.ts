/**
 * What a cell of the responses table (and a row of the response drawer) shows.
 *
 * Answers are formatted by the engine's `displayAnswer`, against the version
 * the response was given under, because a field may have changed or gone since.
 * Metadata columns (the API leaves them without a `blockId`) are matched by a
 * normalised key, so `submittedAt`, `submitted_at` and `Submitted at` all land
 * on the submission time.
 */

import { displayAnswer, fieldsOf, type FieldBlock, type FormDefinition } from '@weldsuite/forms-engine';
import type { FormResponseColumn, FormResponseDto } from '@weldsuite/app-api-client/schemas/weldforms';

export type MetaCell =
  | { type: 'number'; value: number }
  | { type: 'status'; value: 'completed' | 'in_progress' | 'abandoned' }
  | { type: 'date'; value: string }
  | { type: 'duration'; value: number }
  | { type: 'score'; value: number }
  | { type: 'text'; value: string };

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A number column's cell; none when the response has no value. */
function numericCell(type: 'number' | 'score' | 'duration', value: number | null): MetaCell | undefined {
  return value === null ? undefined : { type, value };
}

/** A text column's cell; none for a missing or empty value. */
function textCell(value: string | undefined): MetaCell | undefined {
  return value ? { type: 'text', value } : undefined;
}

/** Who answered: the email they gave, else the signed-in member. */
function respondentCell(response: FormResponseDto): MetaCell | undefined {
  if (response.respondentEmail) return { type: 'text', value: response.respondentEmail };
  if (response.respondent) return { type: 'text', value: response.respondent.name ?? response.respondent.email ?? '' };
  return undefined;
}

/** The metadata value a column stands for, or undefined when the key is not one we know. */
export function metaCell(response: FormResponseDto, key: string): MetaCell | undefined {
  switch (normalizeKey(key)) {
    case 'number':
    case 'responsenumber':
    case 'no':
      return numericCell('number', response.number);
    case 'status':
      return { type: 'status', value: response.abandoned ? 'abandoned' : response.status };
    case 'submittedat':
    case 'submitted':
      return response.submittedAt ? { type: 'date', value: response.submittedAt } : undefined;
    case 'startedat':
    case 'started':
      return { type: 'date', value: response.startedAt };
    case 'email':
    case 'respondentemail':
    case 'respondent':
      return respondentCell(response);
    case 'score':
      return numericCell('score', response.score);
    case 'duration':
    case 'durationms':
    case 'timetaken':
      return numericCell('duration', response.durationMs);
    case 'version':
    case 'versionnumber':
      return { type: 'number', value: response.versionNumber };
    case 'source':
      return textCell(response.metadata.source);
    case 'device':
      return textCell(response.metadata.device);
    case 'country':
      return textCell(response.metadata.country);
    case 'referrer':
      return textCell(response.metadata.referrer);
    default: {
      const hidden = response.hidden[key];
      return hidden === undefined ? undefined : { type: 'text', value: hidden };
    }
  }
}

/** A column's answer in a response as text; an empty string when it has none. */
export function answerText(
  field: FieldBlock | undefined,
  raw: unknown,
  part?: string,
): string {
  if (raw === undefined || raw === null) return '';
  if (part) {
    if (typeof raw !== 'object') return '';
    const value = (raw as Record<string, unknown>)[part];
    return value === undefined || value === null ? '' : String(value);
  }
  if (field) return displayAnswer(field, raw);
  // The version this was answered under is not at hand: show what the raw value looks like.
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/** The field blocks of a definition by block id. */
export function fieldIndex(def: Pick<FormDefinition, 'blocks'> | undefined): Map<string, FieldBlock> {
  const map = new Map<string, FieldBlock>();
  if (!def) return map;
  for (const field of fieldsOf(def)) map.set(field.id, field);
  return map;
}

/** The text of one cell: answer columns read the answers, the rest the metadata. */
export function cellText(
  column: FormResponseColumn,
  response: FormResponseDto,
  fields: Map<string, FieldBlock> | undefined,
): string | null {
  if (column.blockId) {
    return answerText(fields?.get(column.blockId), response.answers[column.blockId], column.part);
  }
  const meta = metaCell(response, column.key);
  return meta ? String(meta.value) : null;
}

/** Which columns a table starts with: the first few, so a wide form stays readable. */
export const DEFAULT_VISIBLE_COLUMNS = 7;

export function defaultVisibleKeys(columns: FormResponseColumn[]): string[] {
  return columns.slice(0, DEFAULT_VISIBLE_COLUMNS).map((column) => column.key);
}
