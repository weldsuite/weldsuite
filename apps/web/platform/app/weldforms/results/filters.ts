/**
 * The responses table's filters: the editable state, and how it becomes the
 * query the API takes (`filters` is a JSON-encoded `ResponseAnswerFilter[]`).
 */

import type {
  ListFormResponsesQuery,
  ResponseAnswerFilter,
} from '@weldsuite/app-api-client/schemas/weldforms';

export type AnswerOperator = ResponseAnswerFilter['operator'];

export const MAX_ANSWER_FILTERS = 20;
/** The API refuses a longer `filters` string. */
export const MAX_FILTERS_LENGTH = 5000;

/** An answer filter as the user edits it; incomplete ones are dropped on serialising. */
export interface AnswerFilterDraft {
  /** Local key for React lists. */
  key: string;
  blockId: string;
  part?: string;
  operator: AnswerOperator;
  /** Text, a number, or choice ids joined by the picker; kept as the raw input. */
  value?: string | number | boolean | string[];
}

export interface ResponsesFilterState {
  status: 'completed' | 'in_progress' | 'all';
  /** `YYYY-MM-DD` from a date input. */
  from: string;
  to: string;
  q: string;
  /** '' = every version. */
  versionId: string;
  sort: NonNullable<ListFormResponsesQuery['sort']>;
  answers: AnswerFilterDraft[];
}

export const EMPTY_FILTERS: ResponsesFilterState = {
  status: 'all',
  from: '',
  to: '',
  q: '',
  versionId: '',
  sort: 'newest',
  answers: [],
};

const VALUELESS: ReadonlySet<AnswerOperator> = new Set(['is_answered', 'is_empty']);
const LIST_OPERATORS: ReadonlySet<AnswerOperator> = new Set(['any_of', 'none_of']);

export function needsValue(operator: AnswerOperator): boolean {
  return !VALUELESS.has(operator);
}

export function isListOperator(operator: AnswerOperator): boolean {
  return LIST_OPERATORS.has(operator);
}

const CHOICE_TYPES = new Set(['multiple_choice', 'dropdown', 'picture_choice']);
const NUMERIC_TYPES = new Set(['number', 'rating', 'opinion_scale', 'nps']);
const BOOLEAN_TYPES = new Set(['yes_no', 'legal']);
const TEXT_TYPES = new Set(['short_text', 'long_text', 'email', 'phone', 'website', 'contact_info', 'address']);

/** The operators that make sense for a field type, the first being the default. */
export function operatorsFor(fieldType: string): AnswerOperator[] {
  if (CHOICE_TYPES.has(fieldType)) return ['any_of', 'none_of', 'is_answered', 'is_empty'];
  if (NUMERIC_TYPES.has(fieldType)) return ['is', 'greater_than', 'less_than', 'is_not', 'is_answered', 'is_empty'];
  if (BOOLEAN_TYPES.has(fieldType)) return ['is', 'is_answered', 'is_empty'];
  if (TEXT_TYPES.has(fieldType)) return ['contains', 'is', 'is_not', 'is_answered', 'is_empty'];
  if (fieldType === 'date') return ['is', 'greater_than', 'less_than', 'is_answered', 'is_empty'];
  return ['is_answered', 'is_empty'];
}

/** Typed text as a filter value: trimmed, or a number where it compares as one; null when blank. */
function textFilterValue(operator: AnswerOperator, value: string): string | number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (operator === 'greater_than' || operator === 'less_than') {
    const n = Number(trimmed);
    // A date compares as text, a number as a number.
    return Number.isFinite(n) ? n : trimmed;
  }
  return trimmed.slice(0, 500);
}

/** A draft with a usable value, as the API's filter; null while it is still incomplete. */
export function toAnswerFilter(draft: AnswerFilterDraft): ResponseAnswerFilter | null {
  if (!draft.blockId) return null;
  const base = { blockId: draft.blockId, ...(draft.part ? { part: draft.part } : {}) };
  if (!needsValue(draft.operator)) return { ...base, operator: draft.operator };

  const { value } = draft;
  if (isListOperator(draft.operator)) {
    if (!Array.isArray(value) || value.length === 0) return null;
    return { ...base, operator: draft.operator, value };
  }
  if (typeof value === 'boolean') return { ...base, operator: draft.operator, value };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ...base, operator: draft.operator, value } : null;
  }
  if (typeof value === 'string') {
    const text = textFilterValue(draft.operator, value);
    return text === null ? null : { ...base, operator: draft.operator, value: text };
  }
  return null;
}

/** The `filters` query value, or undefined when no filter is complete. */
export function serializeFilters(drafts: readonly AnswerFilterDraft[]): string | undefined {
  const complete: ResponseAnswerFilter[] = [];
  for (const draft of drafts) {
    const filter = toAnswerFilter(draft);
    if (filter) complete.push(filter);
    if (complete.length === MAX_ANSWER_FILTERS) break;
  }
  if (complete.length === 0) return undefined;
  const json = JSON.stringify(complete);
  return json.length <= MAX_FILTERS_LENGTH ? json : undefined;
}

/** Whether the typed filters would not fit in one request (so the UI can say so). */
export function filtersTooLong(drafts: readonly AnswerFilterDraft[]): boolean {
  const complete = drafts.map(toAnswerFilter).filter((f): f is ResponseAnswerFilter => f !== null);
  return complete.length > 0 && JSON.stringify(complete).length > MAX_FILTERS_LENGTH;
}

function startOfDay(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function endOfDay(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The filter state as the list query (without cursor and limit). */
export function toResponsesQuery(state: ResponsesFilterState): Omit<ListFormResponsesQuery, 'cursor' | 'limit'> {
  const query: Omit<ListFormResponsesQuery, 'cursor' | 'limit'> = {};
  if (state.status !== 'all') query.status = state.status;
  const from = startOfDay(state.from);
  if (from) query.from = from;
  const to = endOfDay(state.to);
  if (to) query.to = to;
  const q = state.q.trim();
  if (q) query.q = q;
  if (state.versionId) query.versionId = state.versionId;
  if (state.sort !== 'newest') query.sort = state.sort;
  const filters = serializeFilters(state.answers);
  if (filters) query.filters = filters;
  return query;
}

/** How many filters are active, for the badge on the filter button. */
export function activeFilterCount(state: ResponsesFilterState): number {
  let count = 0;
  if (state.status !== 'all') count += 1;
  if (state.from) count += 1;
  if (state.to) count += 1;
  if (state.versionId) count += 1;
  count += state.answers.filter((a) => toAnswerFilter(a) !== null).length;
  return count;
}
