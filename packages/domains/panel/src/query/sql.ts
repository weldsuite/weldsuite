/**
 * The only way a value gets into WeldPanel SQL. Basin SQL has no bind
 * parameters, so every literal goes through {@link lit} / {@link num} /
 * {@link ts}, names and keys are checked against the collector's own patterns,
 * and anything unexpected throws a {@link PanelQueryError} (a 400, never SQL).
 */

import { CUSTOM_EVENT_NAME, PROPERTY_KEY } from '../wire';

/** A spec the compiler refuses. The route answers 400 with `message`. */
export class PanelQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelQueryError';
  }
}

/**
 * Control characters and backslashes: engines disagree on how a backslash
 * escapes, so none is written into a literal. They are built with `chr(n)`
 * and joined with `||` instead (ids may contain a backslash, `CORP\jdoe`).
 */
// eslint-disable-next-line no-control-regex
const SPECIAL_IN_LITERAL = /[\u0001-\u001f\u007f\\]/;
// eslint-disable-next-line no-control-regex
const SPLIT_SPECIAL = /([\u0001-\u001f\u007f\\])/;

/**
 * A string literal: single quotes doubled. A backslash or control character
 * becomes a `chr(n)` piece, `('CORP' || chr(92) || 'jdoe')`; plain text stays a
 * plain literal. NUL is refused (no engine takes it in a string).
 */
export function lit(value: string): string {
  if (typeof value !== 'string') throw new PanelQueryError('Expected text');
  if (value.includes('\u0000')) throw new PanelQueryError('Values cannot contain a null character');
  if (!SPECIAL_IN_LITERAL.test(value)) return quoted(value);
  const pieces = value
    .split(SPLIT_SPECIAL)
    .filter((part) => part !== '')
    .map((part) => (part.length === 1 && SPECIAL_IN_LITERAL.test(part) ? `chr(${part.charCodeAt(0)})` : quoted(part)));
  return `(${pieces.join(' || ')})`;
}

function quoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A finite number, never NaN, Infinity or a string pretending to be one. */
export function num(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PanelQueryError('Expected a number');
  return String(value);
}

/** A non-negative integer for LIMIT and similar, bounded by `max`. */
export function int(value: number, max: number): string {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new PanelQueryError(`Expected a whole number from 0 to ${max}`);
  return String(value);
}

/** A UTC instant as a `TIMESTAMP '…'` literal. */
export function ts(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new PanelQueryError('Invalid date');
  return `TIMESTAMP '${date.toISOString().slice(0, 19).replace('T', ' ')}'`;
}

/** `$pageview`, `$webvitals`, `$app_opened`: the SDKs' own events (copy of `PANEL_SYSTEM_EVENT_NAME`). */
const SYSTEM_EVENT = /^\$[a-z][a-z_]{1,31}$/;

/** True for a tracked event name (custom or `$` system), the only names {@link eventName} writes. */
export function isEventName(name: unknown): name is string {
  return typeof name === 'string' && (CUSTOM_EVENT_NAME.test(name) || SYSTEM_EVENT.test(name));
}

/** An event name: a custom event or a `$` system event. */
export function eventName(name: string): string {
  if (!isEventName(name)) throw new PanelQueryError('Not a valid event name');
  return lit(name);
}

/** A property key: a custom key, or a `$` system key (`$email`, `$action`). */
export function propertyKey(key: string): string {
  if (typeof key !== 'string' || !PROPERTY_KEY.test(key.startsWith('$') ? key.slice(1) : key)) {
    throw new PanelQueryError('Not a valid property key');
  }
  return lit(key);
}

/** `LIKE` pattern pieces: `!` is the escape character (see {@link LIKE_ESCAPE}); `%`, `_` and `!` in the value are escaped. */
export const LIKE_ESCAPE = " ESCAPE '!'";

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/** `'%value%'`, for case-insensitive contains (compare with `LOWER(expr)`). */
export function likeContains(value: string): string {
  return lit(`%${escapeLike(value.toLowerCase())}%`);
}

/** A path pattern (`/products/*`): `*` matches any characters, everything else is literal. */
export function likePattern(pattern: string): string {
  return lit(pattern.split('*').map(escapeLike).join('%'));
}

/** `IN (…)` list of string literals. */
export function inList(values: readonly string[]): string {
  if (values.length === 0) throw new PanelQueryError('Empty list');
  return `(${values.map(lit).join(', ')})`;
}

const GROUP_TYPE = /^[a-z][a-z0-9_]{0,31}$/;

/** A group type (`company`), safe as part of an alias: refused unless it matches the pattern. */
export function groupType(type: string): string {
  if (typeof type !== 'string' || !GROUP_TYPE.test(type)) throw new PanelQueryError('Not a valid group type');
  return type;
}

/**
 * An approximate percentile (0-1) of `expr`. Basin SQL is DataFusion:
 * `approx_percentile_cont(expr, p)` (t-digest). The one place that names it,
 * so another engine needs one change.
 */
export function percentileSql(expr: string, p: number): string {
  if (!(p > 0 && p < 1)) throw new PanelQueryError('Expected a percentile between 0 and 1');
  return `approx_percentile_cont(${expr}, ${num(p)})`;
}

/** A row id inside a ref (`pnce_ab12`), checked before it is used anywhere. */
export function refIdOf(ref: string, prefix: 'pnce' | 'pncp'): string {
  const match = new RegExp(`^@(${prefix}_[A-Za-z0-9]{1,26})$`).exec(ref);
  if (!match) throw new PanelQueryError('Not a valid reference');
  return match[1] as string;
}
