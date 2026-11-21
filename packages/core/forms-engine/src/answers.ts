/**
 * Answer normalisation and validation, one field at a time.
 *
 * Normalising: strings are trimmed and an empty string is no answer; choice
 * ids are de-duplicated; a choice answer's literal `other` id is dropped (the
 * "Other" option is the `other` text); matrix rows, contact and address parts
 * that the field doesn't have (or has disabled) are dropped; a website without
 * a scheme gets `https://`. A value of the wrong shape is `invalid`.
 */

import { choicesOf, fieldsOf, partsOf, type ChoiceField, type CompositeField } from './blocks';
import type { AnswerValue, Answers, ChoiceAnswer, FieldBlock, FieldBlockOf, FileAnswerItem, FormDefinition } from './definition';
import type { AnswerError, AnswerErrorCode } from './types';

/** An answer after normalising: none, of the wrong shape, or a value to check further. */
export type PreparedAnswer =
  | { kind: 'empty' }
  | { kind: 'invalid'; error: AnswerError }
  | { kind: 'value'; value: AnswerValue };

const EMPTY: PreparedAnswer = { kind: 'empty' };

function invalid(code: AnswerErrorCode = 'invalid', part?: string): PreparedAnswer {
  return { kind: 'invalid', error: part === undefined ? { code } : { code, part } };
}

function value(v: AnswerValue): PreparedAnswer {
  return { kind: 'value', value: v };
}

function answerError(code: AnswerErrorCode, part?: string): AnswerError {
  return part === undefined ? { code } : { code, part };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own property of a record, never an inherited one (`toString`, `__proto__`). */
export function ownValue(record: Record<string, unknown> | undefined, key: string): unknown {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Length in Unicode code points (what Rust's `chars().count()` gives). */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function prepareFileItem(v: unknown): FileAnswerItem | null {
  if (!isPlainObject(v)) return null;
  const { fileId, name, size, type } = v;
  if (typeof fileId !== 'string' || fileId === '') return null;
  if (typeof name !== 'string' || typeof type !== 'string') return null;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return null;
  return { fileId, name, size, type };
}

function prepareChoice(field: FieldBlock, raw: unknown): PreparedAnswer {
  if (!isPlainObject(raw)) return invalid();
  const rawIds = ownValue(raw, 'choiceIds') ?? [];
  const rawOther = ownValue(raw, 'other') ?? '';
  if (!isStringArray(rawIds) || typeof rawOther !== 'string') return invalid();
  const hasOtherChoice = choicesOf(field).some((c) => c.id === 'other');
  const choiceIds = dedupe(rawIds.filter((id) => id !== '' && (hasOtherChoice || id !== 'other')));
  const other = rawOther.trim();
  if (choiceIds.length === 0 && other === '') return EMPTY;
  const answer: ChoiceAnswer = other === '' ? { choiceIds } : { choiceIds, other };
  return value(answer);
}

function prepareText(raw: unknown): PreparedAnswer {
  return typeof raw === 'string' ? value(raw.trim()) : invalid();
}

function prepareWebsite(raw: unknown): PreparedAnswer {
  if (typeof raw !== 'string') return invalid();
  const url = raw.trim();
  return value(SCHEME_RE.test(url) ? url : `https://${url}`);
}

function prepareNumber(raw: unknown): PreparedAnswer {
  return typeof raw === 'number' && Number.isFinite(raw) ? value(raw) : invalid();
}

function prepareBoolean(raw: unknown): PreparedAnswer {
  return typeof raw === 'boolean' ? value(raw) : invalid();
}

function prepareRanking(raw: unknown): PreparedAnswer {
  if (!isStringArray(raw)) return invalid();
  return raw.length === 0 ? EMPTY : value([...raw]);
}

function prepareMatrix(field: FieldBlockOf<'matrix'>, raw: unknown): PreparedAnswer {
  if (!isPlainObject(raw)) return invalid();
  const out: Record<string, string[]> = {};
  for (const row of field.properties.rows) {
    const cols = ownValue(raw, row.id);
    if (cols === undefined || cols === null) continue;
    if (!isStringArray(cols)) return invalid('invalid', row.id);
    const ids = dedupe(cols.filter((c) => c !== ''));
    if (ids.length > 0) out[row.id] = ids;
  }
  return Object.keys(out).length === 0 ? EMPTY : value(out);
}

function prepareFiles(raw: unknown): PreparedAnswer {
  if (!Array.isArray(raw)) return invalid();
  const items: FileAnswerItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = prepareFileItem(entry);
    if (!item) return invalid();
    if (seen.has(item.fileId)) continue;
    seen.add(item.fileId);
    items.push(item);
  }
  return items.length === 0 ? EMPTY : value(items);
}

function prepareSignature(raw: unknown): PreparedAnswer {
  const item = prepareFileItem(raw);
  return item ? value(item) : invalid();
}

function prepareParts(field: CompositeField, raw: unknown): PreparedAnswer {
  if (!isPlainObject(raw)) return invalid();
  const out: Record<string, string> = {};
  for (const { part, enabled } of partsOf(field)) {
    if (!enabled) continue;
    const v = ownValue(raw, part);
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return invalid('invalid', part);
    const trimmed = v.trim();
    if (trimmed !== '') out[part] = trimmed;
  }
  return Object.keys(out).length === 0 ? EMPTY : value(out);
}

/**
 * Normalise a raw answer for a field. `undefined`, `null` and an empty (or
 * blank) string are no answer.
 */
export function prepareAnswer(field: FieldBlock, raw: unknown): PreparedAnswer {
  if (raw === undefined || raw === null) return EMPTY;
  if (typeof raw === 'string' && raw.trim() === '') return EMPTY;

  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'date':
      return prepareText(raw);
    case 'website':
      return prepareWebsite(raw);
    case 'number':
    case 'rating':
    case 'opinion_scale':
    case 'nps':
      return prepareNumber(raw);
    case 'yes_no':
    case 'legal':
      return prepareBoolean(raw);
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
      return prepareChoice(field, raw);
    case 'ranking':
      return prepareRanking(raw);
    case 'matrix':
      return prepareMatrix(field, raw);
    case 'file_upload':
      return prepareFiles(raw);
    case 'signature':
      return prepareSignature(raw);
    case 'contact_info':
    case 'address':
      return prepareParts(field, raw);
  }
}

/** The normalised answer, or undefined when there is none or it has the wrong shape. */
export function normalizeAnswer(field: FieldBlock, raw: unknown): AnswerValue | undefined {
  const prepared = prepareAnswer(field, raw);
  return prepared.kind === 'value' ? prepared.value : undefined;
}

/** Whether a value counts as an answer (a value of the wrong shape does; `false` does). */
export function isAnswered(field: FieldBlock, raw: unknown): boolean {
  return prepareAnswer(field, raw).kind !== 'empty';
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Something, `@`, then a domain with a dot that is neither its first nor its
 * last character; no whitespace and no second `@`. The domain is read up to
 * its first dot after the first character, so the match can't backtrack.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/;
export const URL_RE = /^https?:\/\/[^\s/?#:@.]+(\.[^\s/?#:@.]+)+(:\d{1,5})?([/?#]\S*)?$/i;
const PHONE_RE = /^\+?[0-9 ()-]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidEmail(v: string): boolean {
  return codePointLength(v) <= 254 && EMAIL_RE.test(v);
}

export function isValidUrl(v: string): boolean {
  return URL_RE.test(v);
}

/** `+` optional, then 6 to 20 digits, with spaces, dashes and parentheses allowed. */
export function isValidPhone(v: string): boolean {
  if (!PHONE_RE.test(v)) return false;
  const digits = v.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 20;
}

/** `YYYY-MM-DD` and a real calendar date (year 1 to 9999). */
export function isValidDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

/**
 * Whether `n` has at most `decimals` decimal places, with a tolerance for
 * float noise: `|s - round(s)| <= max(1e-9, |s| * 1e-12)` where `s = n * 10^decimals`.
 */
export function hasAtMostDecimals(n: number, decimals: number): boolean {
  const scaled = n * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) <= Math.max(1e-9, Math.abs(scaled) * 1e-12);
}

function isIntegerIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/** The error `code` when `failed`, else no error. */
function errorIf(failed: boolean, code: AnswerErrorCode): AnswerError | null {
  return failed ? answerError(code) : null;
}

function checkTextLength(field: FieldBlockOf<'short_text' | 'long_text'>, text: string): AnswerError | null {
  const max = field.properties.maxLength;
  return errorIf(max !== undefined && codePointLength(text) > max, 'too_long');
}

function checkNumber(field: FieldBlockOf<'number'>, n: number): AnswerError | null {
  const { decimals, min, max } = field.properties;
  if (!hasAtMostDecimals(n, decimals)) return answerError(decimals === 0 ? 'not_integer' : 'too_many_decimals');
  if (min !== undefined && n < min) return answerError('too_small');
  if (max !== undefined && n > max) return answerError('too_large');
  return null;
}

function checkDate(field: FieldBlockOf<'date'>, d: string): AnswerError | null {
  if (!isValidDate(d)) return answerError('invalid_date');
  const { min, max } = field.properties;
  if (min !== undefined && d < min) return answerError('date_too_early');
  if (max !== undefined && d > max) return answerError('date_too_late');
  return null;
}

function checkChoice(field: ChoiceField, a: ChoiceAnswer): AnswerError | null {
  const ids = new Set(field.properties.choices.map((c) => c.id));
  if (a.choiceIds.some((id) => !ids.has(id))) return answerError('invalid_choice');
  const allowOther = field.type === 'dropdown' ? false : field.properties.allowOther;
  if (a.other !== undefined && !allowOther) return answerError('invalid_choice');
  const count = a.choiceIds.length + (a.other !== undefined ? 1 : 0);
  if (field.type === 'dropdown' || !field.properties.multiple) {
    return errorIf(count > 1, 'too_many_choices');
  }
  const { minSelections, maxSelections } = field.properties;
  if (minSelections !== undefined && count < minSelections) return answerError('too_few_choices');
  if (maxSelections !== undefined && count > maxSelections) return answerError('too_many_choices');
  return null;
}

function checkRanking(field: FieldBlockOf<'ranking'>, ranked: string[]): AnswerError | null {
  const ids = field.properties.choices.map((c) => c.id);
  const rankedSet = new Set(ranked);
  const ok = ranked.length === ids.length && rankedSet.size === ranked.length && ids.every((id) => rankedSet.has(id));
  return errorIf(!ok, 'invalid');
}

function checkMatrix(field: FieldBlockOf<'matrix'>, a: Record<string, string[]>): AnswerError | null {
  const columns = new Set(field.properties.columns.map((c) => c.id));
  for (const row of field.properties.rows) {
    const cols = a[row.id];
    if (cols === undefined) {
      if (field.required) return answerError('required', row.id);
      continue;
    }
    if (cols.some((c) => !columns.has(c))) return answerError('invalid_choice', row.id);
    if (!field.properties.multiple && cols.length > 1) return answerError('too_many_choices', row.id);
  }
  return null;
}

/** The email and phone parts of contact info must be valid; the other parts are free text. */
function checkContactPart(part: string, v: string): AnswerError | null {
  if (part === 'email' && !isValidEmail(v)) return answerError('invalid_email', part);
  if (part === 'phone' && !isValidPhone(v)) return answerError('invalid_phone', part);
  return null;
}

function checkParts(field: CompositeField, a: Record<string, string>): AnswerError | null {
  for (const { part, enabled, required } of partsOf(field)) {
    if (!enabled) continue;
    const v = a[part];
    if (v === undefined) {
      if (required) return answerError('required', part);
      continue;
    }
    if (field.type === 'contact_info') {
      const error = checkContactPart(part, v);
      if (error) return error;
    }
  }
  return null;
}

/** Checks a normalised (non-empty) answer against its field. */
export function checkAnswer(field: FieldBlock, answer: AnswerValue): AnswerError | null {
  switch (field.type) {
    case 'short_text':
    case 'long_text':
      return checkTextLength(field, answer as string);
    case 'email':
      return errorIf(!isValidEmail(answer as string), 'invalid_email');
    case 'phone':
      return errorIf(!isValidPhone(answer as string), 'invalid_phone');
    case 'website':
      return errorIf(!isValidUrl(answer as string), 'invalid_url');
    case 'number':
      return checkNumber(field, answer as number);
    case 'rating':
      return errorIf(!isIntegerIn(answer as number, 1, field.properties.steps), 'invalid');
    case 'opinion_scale':
      return errorIf(!isIntegerIn(answer as number, field.properties.start, field.properties.end), 'invalid');
    case 'nps':
      return errorIf(!isIntegerIn(answer as number, 0, 10), 'invalid');
    case 'date':
      return checkDate(field, answer as string);
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
      return checkChoice(field, answer as ChoiceAnswer);
    case 'yes_no':
      return null;
    case 'legal':
      return errorIf(field.required && answer === false, 'must_accept');
    case 'ranking':
      return checkRanking(field, answer as string[]);
    case 'matrix':
      return checkMatrix(field, answer as Record<string, string[]>);
    case 'file_upload':
      return errorIf((answer as FileAnswerItem[]).length > field.properties.maxFiles, 'too_many_files');
    case 'signature':
      return null;
    case 'contact_info':
    case 'address':
      return checkParts(field, answer as Record<string, string>);
  }
}

/** Validates one field's raw answer; `undefined` = unanswered. */
export function validateAnswer(field: FieldBlock, raw: unknown): AnswerError | null {
  const prepared = prepareAnswer(field, raw);
  if (prepared.kind === 'empty') return field.required ? answerError('required') : null;
  if (prepared.kind === 'invalid') return prepared.error;
  return checkAnswer(field, prepared.value);
}

/**
 * Every field's answer, normalised and checked. `valid` holds the answers
 * without an error; `errors` every field's error (required ones included),
 * whether or not the field is on the path. Unknown ids are dropped.
 */
export function collectAnswers(
  def: Pick<FormDefinition, 'blocks'>,
  answers: Record<string, unknown> | undefined,
): { valid: Answers; errors: Record<string, AnswerError> } {
  const valid: Answers = {};
  const errors: Record<string, AnswerError> = {};
  for (const field of fieldsOf(def)) {
    const prepared = prepareAnswer(field, ownValue(answers, field.id));
    if (prepared.kind === 'empty') {
      if (field.required) errors[field.id] = answerError('required');
      continue;
    }
    if (prepared.kind === 'invalid') {
      errors[field.id] = prepared.error;
      continue;
    }
    const error = checkAnswer(field, prepared.value);
    if (error) errors[field.id] = error;
    else valid[field.id] = prepared.value;
  }
  return { valid, errors };
}

/** The normalised answers of every field that has one (errors are not checked); unknown ids dropped. */
export function normalizeAnswers(def: Pick<FormDefinition, 'blocks'>, answers: Record<string, unknown> | undefined): Answers {
  const out: Answers = {};
  for (const field of fieldsOf(def)) {
    const v = normalizeAnswer(field, ownValue(answers, field.id));
    if (v !== undefined) out[field.id] = v;
  }
  return out;
}
