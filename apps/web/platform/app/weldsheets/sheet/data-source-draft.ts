/**
 * A connected table as its editor holds it: every value as typed (a limit or
 * a filter value is text until it is saved), turned into the definition
 * sheets-api takes on save.
 */

import {
  checkSheetDataDefinition,
  defaultSheetDataColumns,
  findSheetDataField,
  sheetDataOpNeedsValue,
  SHEET_DATA_FILTER_OPS_BY_TYPE,
  type SheetDataDefinitionInput,
  type SheetDataFilter,
  type SheetDataFilterOp,
  type SheetDataObjectKey,
} from '@weldsuite/app-api-client/schemas/sheet-data';
import type { SheetDataRefresh, SheetDataSource } from '@weldsuite/app-api-client/schemas/sheets';

/** Records a new connected table lists. */
export const DEFAULT_LIMIT = 1000;

export interface ColumnDraft {
  field: string;
  header: string;
}

export interface FilterDraft {
  field: string;
  op: SheetDataFilterOp;
  /** As typed: a number, a date (yyyy-mm-dd), 'true'/'false', or text. */
  value: string;
}

export interface SourceDraft {
  objectType: SheetDataObjectKey;
  columns: ColumnDraft[];
  filters: FilterDraft[];
  /** Null: newest first. */
  sort: { field: string; descending: boolean } | null;
  limit: string;
  refresh: SheetDataRefresh;
}

/** A field's name in the viewer's language. */
export type FieldLabel = (objectType: SheetDataObjectKey, field: string) => string;

/** A new connected table of an object: its usual fields, newest first. */
export function newDraft(objectType: SheetDataObjectKey, label: FieldLabel): SourceDraft {
  return {
    objectType,
    columns: defaultSheetDataColumns(objectType).map((field) => ({ field, header: label(objectType, field) })),
    filters: [],
    sort: null,
    limit: String(DEFAULT_LIMIT),
    refresh: 'manual',
  };
}

/** The draft of a saved connected table. */
export function draftOf(source: SheetDataSource): SourceDraft {
  const { definition } = source;
  return {
    objectType: source.objectType,
    columns: definition.columns.map((field, i) => ({ field, header: definition.headers[i] ?? field })),
    filters: definition.filters.map((f) => ({ field: f.field, op: f.op, value: f.value === undefined || f.value === null ? '' : String(f.value) })),
    sort: definition.sort ? { field: definition.sort.field, descending: !!definition.sort.descending } : null,
    limit: String(definition.limit),
    refresh: source.refresh,
  };
}

/** A filter on a field, with the first operator that fits it. */
export function newFilter(objectType: SheetDataObjectKey, field: string): FilterDraft {
  const type = findSheetDataField(objectType, field)?.type ?? 'text';
  return { field, op: SHEET_DATA_FILTER_OPS_BY_TYPE[type][0]!, value: type === 'boolean' ? 'true' : '' };
}

/** A filter moved to another field: its operator stays when it fits there. */
export function refield(objectType: SheetDataObjectKey, filter: FilterDraft, field: string): FilterDraft {
  const next = newFilter(objectType, field);
  const type = findSheetDataField(objectType, field)?.type ?? 'text';
  return SHEET_DATA_FILTER_OPS_BY_TYPE[type].includes(filter.op) ? { ...next, op: filter.op } : next;
}

function filterOf(objectType: SheetDataObjectKey, draft: FilterDraft): SheetDataFilter {
  if (!sheetDataOpNeedsValue(draft.op)) return { field: draft.field, op: draft.op };
  const type = findSheetDataField(objectType, draft.field)?.type;
  const text = draft.value.trim();
  if (type === 'boolean') return { field: draft.field, op: draft.op, value: text === 'true' };
  if ((type === 'number' || type === 'currency') && text !== '' && Number.isFinite(Number(text))) {
    return { field: draft.field, op: draft.op, value: Number(text) };
  }
  return { field: draft.field, op: draft.op, value: text === '' ? null : text };
}

/** The definition to save. */
export function definitionOf(draft: SourceDraft): SheetDataDefinitionInput {
  return {
    columns: draft.columns.map((c) => c.field),
    headers: draft.columns.map((c) => c.header.trim()),
    filters: draft.filters.map((f) => filterOf(draft.objectType, f)),
    ...(draft.sort ? { sort: { field: draft.sort.field, descending: draft.sort.descending } } : {}),
    limit: Number(draft.limit),
  };
}

/** Whether a filter's value reads as its field's kind (a number for a number, a date for a date). */
function valueFits(objectType: SheetDataObjectKey, draft: FilterDraft): boolean {
  if (!sheetDataOpNeedsValue(draft.op)) return true;
  const type = findSheetDataField(objectType, draft.field)?.type;
  const text = draft.value.trim();
  if (type === 'number' || type === 'currency') return text !== '' && Number.isFinite(Number(text));
  if (type === 'date' || type === 'datetime') return /^\d{4}-\d{2}-\d{2}$/.test(text);
  return true;
}

/** Whether the draft can be saved: every header named, every filter value readable, and the definition valid. */
export function draftIsValid(draft: SourceDraft): boolean {
  if (draft.columns.some((c) => !c.header.trim())) return false;
  if (!draft.filters.every((f) => valueFits(draft.objectType, f))) return false;
  return checkSheetDataDefinition(draft.objectType, definitionOf(draft)) === null;
}

/** Moves a column one place up (-1) or down (1). */
export function moveColumn(columns: ColumnDraft[], index: number, by: -1 | 1): ColumnDraft[] {
  const to = index + by;
  if (to < 0 || to >= columns.length) return columns;
  const next = [...columns];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
