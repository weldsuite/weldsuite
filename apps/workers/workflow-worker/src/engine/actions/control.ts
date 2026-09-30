/**
 * Control / utility actions: set_variable, log, condition, loop, delay.
 */

import type { ActionContext, ActionHandler } from '../types';

export const handleSetVariable: ActionHandler = async (inputs, ctx) => {
  const varName = String(inputs.name || inputs.variableName || '');
  if (!varName) throw new Error('Variable name is required');
  ctx.variables[varName] = inputs.value;
  return { set: true, name: varName, value: inputs.value };
};

export const handleLog: ActionHandler = async (inputs) => {
  const message = String(inputs.message || inputs.text || '');
  const level = String(inputs.level || 'info').toLowerCase();
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
  return { logged: true, message };
};

/** Walk a dotted property path (already split) through a value, tolerating gaps. */
function getPath(root: unknown, props: string[]): unknown {
  return props.reduce<unknown>((obj, prop) => (obj as Record<string, unknown> | null | undefined)?.[prop], root);
}

/** Resolve a condition `field` reference (steps./trigger./variables./loop./input) to its value. */
function resolveConditionField(
  field: unknown,
  inputs: Record<string, unknown>,
  ctx: ActionContext,
): unknown {
  if (!field || typeof field !== 'string') return undefined;
  if (field.startsWith('steps.')) {
    const [, stepId, ...rest] = field.split('.');
    return getPath(ctx.previousResults[stepId], rest);
  }
  if (field.startsWith('trigger.')) return getPath(ctx.triggerData, field.slice(8).split('.'));
  if (field.startsWith('variables.')) return ctx.variables[field.slice(10)];
  if (field.startsWith('loop.')) {
    const prop = field.slice(5);
    if (prop === 'item') return ctx.loopItem;
    return prop === 'index' ? ctx.loopIndex : undefined;
  }
  return inputs[field];
}

export const handleCondition: ActionHandler = async (inputs, ctx) => {
  const operator = String(inputs.operator || 'eq');
  const value = inputs.value;

  const fieldValue = resolveConditionField(inputs.field, inputs, ctx);

  let passed = false;
  switch (operator) {
    case 'eq':
    case 'equals':
      passed = fieldValue === value;
      break;
    case 'neq':
    case 'not_equals':
      passed = fieldValue !== value;
      break;
    case 'gt':
    case 'greater_than':
      passed = Number(fieldValue) > Number(value);
      break;
    case 'gte':
    case 'greater_than_or_equals':
      passed = Number(fieldValue) >= Number(value);
      break;
    case 'lt':
    case 'less_than':
      passed = Number(fieldValue) < Number(value);
      break;
    case 'lte':
    case 'less_than_or_equals':
      passed = Number(fieldValue) <= Number(value);
      break;
    case 'contains':
      passed = String(fieldValue).includes(String(value));
      break;
    case 'starts_with':
      passed = String(fieldValue).startsWith(String(value));
      break;
    case 'ends_with':
      passed = String(fieldValue).endsWith(String(value));
      break;
    case 'exists':
      passed = fieldValue !== undefined && fieldValue !== null;
      break;
    case 'not_exists':
      passed = fieldValue === undefined || fieldValue === null;
      break;
    case 'in':
      passed = Array.isArray(value) && value.includes(fieldValue);
      break;
    case 'not_in':
      passed = !Array.isArray(value) || !value.includes(fieldValue);
      break;
    case 'matches':
      passed = new RegExp(String(value)).test(String(fieldValue));
      break;
    default:
      passed = true;
  }
  return { passed, result: fieldValue };
};

export const handleLoop: ActionHandler = async (inputs, ctx) => {
  const items = inputs.items as unknown[];
  const iteratorName = String(inputs.iteratorName || 'item');
  if (!Array.isArray(items)) throw new Error('Items must be an array');

  const results: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    ctx.variables[iteratorName] = items[i];
    ctx.variables[`${iteratorName}Index`] = i;
    results.push({ index: i, item: items[i], processed: true });
  }
  return { items: results, count: results.length };
};

export const handleDelay: ActionHandler = async (inputs) => {
  // The actual wait is performed by the orchestrator (runtime.sleep) using the
  // returned __delayMs sentinel.
  let durationMs = 1000;
  let durationDescription = '1 second';

  if (inputs.days && Number(inputs.days) > 0) {
    durationMs = Number(inputs.days) * 86400000;
    durationDescription = `${inputs.days} day(s)`;
  } else if (inputs.hours && Number(inputs.hours) > 0) {
    durationMs = Number(inputs.hours) * 3600000;
    durationDescription = `${inputs.hours} hour(s)`;
  } else if (inputs.minutes && Number(inputs.minutes) > 0) {
    durationMs = Number(inputs.minutes) * 60000;
    durationDescription = `${inputs.minutes} minute(s)`;
  } else if (inputs.seconds && Number(inputs.seconds) > 0) {
    durationMs = Number(inputs.seconds) * 1000;
    durationDescription = `${inputs.seconds} second(s)`;
  } else if (inputs.duration || inputs.ms) {
    durationMs = Number(inputs.duration || inputs.ms || 1000);
    durationDescription = `${Math.ceil(durationMs / 1000)} second(s)`;
  }

  return { delayed: true, duration: durationDescription, durationMs, __delayMs: durationMs };
};
