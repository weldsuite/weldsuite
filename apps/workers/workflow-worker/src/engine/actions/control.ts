/**
 * Control / utility actions: set_variable, log, condition, loop, delay.
 *
 * `condition` and `loop` only decide; the orchestrator (execute-steps.ts) runs
 * the branch a condition picks and the body of a loop once per item.
 */

import type { ActionContext, ActionHandler } from '../types';
import { NonRetryableStepError } from '../errors';
import { asText } from '@weldsuite/text';

export const handleSetVariable: ActionHandler = (inputs, ctx) => {
  const varName = asText(inputs.name || inputs.variableName || '');
  if (!varName) return Promise.reject(new Error('Variable name is required'));
  ctx.variables[varName] = inputs.value;
  return Promise.resolve({ set: true, name: varName, value: inputs.value });
};

export const handleLog: ActionHandler = (inputs) => {
  const message = asText(inputs.message || inputs.text || '');
  const level = asText(inputs.level || 'info').toLowerCase();
  switch (level) {
    case 'error':
      console.error(`[LOG] ${message}`);
      break;
    case 'warn':
    case 'warning':
      console.warn(`[LOG] ${message}`);
      break;
    default:
      console.log(`[LOG] ${message}`);
  }
  return Promise.resolve({ logged: true, message });
};

/** Walk a dotted property path (already split) through a value, tolerating gaps. */
function getPath(root: unknown, props: string[]): unknown {
  return props.reduce<unknown>((obj, prop) => (obj as Record<string, unknown> | null | undefined)?.[prop], root);
}

const PATH_REFERENCE = /^(steps|trigger|variables|loop)\.[\w.-]+$/;

/**
 * The value a condition checks. The editor stores `field` as a template
 * (`{{trigger.data.status}}`), which input resolution has already replaced by
 * the value itself. A bare path (`trigger.status`, older workflows) is still
 * looked up.
 */
function resolveConditionField(field: unknown, ctx: ActionContext): unknown {
  if (typeof field !== 'string' || !PATH_REFERENCE.test(field)) return field;
  if (field.startsWith('steps.')) {
    const [, stepId, ...rest] = field.split('.');
    return getPath(ctx.previousResults[stepId], rest);
  }
  if (field.startsWith('trigger.')) return getPath(ctx.triggerData, field.slice(8).split('.'));
  if (field.startsWith('variables.')) return getPath(ctx.variables, field.slice(10).split('.'));
  const [, prop, ...rest] = field.split('.');
  if (prop === 'index') return ctx.loopIndex;
  return prop === 'item' ? getPath(ctx.loopItem, rest) : undefined;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Equality across the string/number/boolean mix templates produce ("5" equals 5). */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return isEmptyValue(a) && isEmptyValue(b);
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return asText(a).trim() === asText(b).trim();
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function compareNumbers(a: unknown, b: unknown, test: (x: number, y: number) => boolean): boolean {
  const x = toNumber(a);
  const y = toNumber(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && test(x, y);
}

/** A list operand: an array, or a comma-separated string. */
function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((part) => part.trim()).filter(Boolean);
  return value === undefined || value === null ? [] : [value];
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle));
  if (haystack === undefined || haystack === null) return false;
  return asText(haystack).toLowerCase().includes(asText(needle ?? '').toLowerCase());
}

function matchesPattern(value: unknown, pattern: unknown): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(asText(pattern ?? ''));
  } catch {
    throw new NonRetryableStepError(`"${String(pattern)}" is not a valid regular expression`);
  }
  return regex.test(asText(value ?? ''));
}

const lowerText = (value: unknown) => asText(value ?? '').toLowerCase();

type Comparison = (fieldValue: unknown, value: unknown) => boolean;

/** Operators by the names the editor saves (see ConditionForm). */
const COMPARISONS: Record<string, Comparison> = {
  eq: looseEquals,
  ne: (a, b) => !looseEquals(a, b),
  gt: (a, b) => compareNumbers(a, b, (x, y) => x > y),
  gte: (a, b) => compareNumbers(a, b, (x, y) => x >= y),
  lt: (a, b) => compareNumbers(a, b, (x, y) => x < y),
  lte: (a, b) => compareNumbers(a, b, (x, y) => x <= y),
  contains: containsValue,
  not_contains: (a, b) => !containsValue(a, b),
  startswith: (a, b) => lowerText(a).startsWith(lowerText(b)),
  endswith: (a, b) => lowerText(a).endsWith(lowerText(b)),
  isEmpty: (a) => isEmptyValue(a),
  isNotEmpty: (a) => !isEmptyValue(a),
  in: (a, b) => toList(b).some((item) => looseEquals(item, a)),
  not_in: (a, b) => !toList(b).some((item) => looseEquals(item, a)),
  regex: matchesPattern,
};

/** Other names for the same operators (templates, AI drafts, older workflows). */
const OPERATOR_ALIASES: Record<string, string> = {
  equals: 'eq',
  neq: 'ne',
  not_equals: 'ne',
  greater_than: 'gt',
  greater_than_or_equals: 'gte',
  less_than: 'lt',
  less_than_or_equals: 'lte',
  starts_with: 'startswith',
  ends_with: 'endswith',
  exists: 'isNotEmpty',
  not_exists: 'isEmpty',
  is_empty: 'isEmpty',
  is_not_empty: 'isNotEmpty',
  matches: 'regex',
};

/** Evaluate one comparison; an operator the engine doesn't know fails the step. */
export function compareValues(operator: string, fieldValue: unknown, value: unknown): boolean {
  const comparison = COMPARISONS[OPERATOR_ALIASES[operator] ?? operator];
  if (!comparison) throw new NonRetryableStepError(`Unknown condition operator "${operator}"`);
  return comparison(fieldValue, value);
}

/** The value branch a multi-branch condition picks (`default` catches the rest). */
function matchBranch(branches: unknown[], fieldValue: unknown): string | null {
  const values = branches.map((branch) => asText((branch as { value?: unknown } | null)?.value ?? ''));
  const matched = values.find((value) => value !== 'default' && looseEquals(fieldValue, value));
  if (matched !== undefined) return matched;
  return values.includes('default') ? 'default' : null;
}

/**
 * condition — checks one value. For a plain if/else it returns `passed`, and
 * the engine runs the "If true" or the "If false" branch. When the step lists
 * `branches`, it returns the `matchedBranch` whose value equals the field (no
 * match and no `default` branch runs no branch).
 */
export const handleCondition: ActionHandler = (inputs, ctx) => {
  try {
    if (inputs.field === undefined) throw new NonRetryableStepError('Choose the value this condition checks');
    const fieldValue = resolveConditionField(inputs.field, ctx);

    if (Array.isArray(inputs.branches)) {
      return Promise.resolve({ matchedBranch: matchBranch(inputs.branches, fieldValue), value: fieldValue });
    }

    const operator = asText(inputs.operator || 'eq');
    const passed = compareValues(operator, fieldValue, inputs.value);
    return Promise.resolve({ passed, value: fieldValue, result: fieldValue });
  } catch (err) {
    return Promise.reject(err);
  }
};

/** Most items one loop may run over (the engine also caps iterations per run). */
export const MAX_LOOP_ITEMS = 100;

/**
 * loop — validates the list to run over; the engine then runs the loop's body
 * once per item, with `{{loop.item}}` / `{{loop.index}}` set. An empty or
 * unresolved list runs the body zero times. A JSON array string is accepted
 * (a template spliced into text arrives as one).
 */
export const handleLoop: ActionHandler = (inputs) => {
  let items = inputs.items;
  if (items === undefined || items === null || items === '') items = [];
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      // Not JSON: rejected below.
    }
  }
  if (!Array.isArray(items)) {
    return Promise.reject(
      new NonRetryableStepError('The loop needs a list of items, for example {{trigger.data.lineItems}}'),
    );
  }
  if (items.length > MAX_LOOP_ITEMS) {
    return Promise.reject(
      new NonRetryableStepError(`The list has ${items.length} items; a loop can run over at most ${MAX_LOOP_ITEMS}`),
    );
  }
  return Promise.resolve({ items, count: items.length });
};

/** Longest wait a delay may ask for (Cloudflare Workflows sleeps up to a year). */
const MAX_DELAY_MS = 365 * 86_400_000;

const DELAY_UNITS: Array<{ key: string; ms: number; label: string }> = [
  { key: 'days', ms: 86_400_000, label: 'day(s)' },
  { key: 'hours', ms: 3_600_000, label: 'hour(s)' },
  { key: 'minutes', ms: 60_000, label: 'minute(s)' },
  { key: 'seconds', ms: 1000, label: 'second(s)' },
];

export const handleDelay: ActionHandler = (inputs) => {
  // The actual wait is performed by the orchestrator (runtime.sleep) using the
  // returned __delayMs sentinel.
  let durationMs = 1000;
  let durationDescription = '1 second';

  const unit = DELAY_UNITS.find(({ key }) => inputs[key] !== undefined && Number(inputs[key]) > 0);
  if (unit) {
    durationMs = Number(inputs[unit.key]) * unit.ms;
    durationDescription = `${String(inputs[unit.key])} ${unit.label}`;
  } else if (inputs.duration || inputs.ms) {
    durationMs = Number(inputs.duration || inputs.ms || 1000);
    durationDescription = `${Math.ceil(durationMs / 1000)} second(s)`;
  }

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return Promise.reject(new NonRetryableStepError('The wait time must be a positive number'));
  }
  if (durationMs > MAX_DELAY_MS) return Promise.reject(new NonRetryableStepError('A delay can wait at most 365 days'));

  return Promise.resolve({ delayed: true, duration: durationDescription, durationMs, __delayMs: durationMs });
};
