/**
 * Condition evaluator for `step.condition` (and the `condition` action).
 *
 * Resolves the field value from one of four sources by prefix
 * (`steps.` / `trigger.` / `variables.` / `contact.`; a bare field with no
 * known prefix resolves to the literal field string), then applies the
 * operator. Missing field/operator fails closed; unknown operator → false.
 */

import type { StepCondition } from './types';

export function evaluateCondition(
  condition: StepCondition | Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): boolean {
  const c = condition as { field?: string; operator?: string; value?: unknown };
  if (!c.field || !c.operator) {
    console.warn('Condition missing field or operator, failing closed');
    return false;
  }

  let fieldValue: unknown;
  const field = String(c.field);

  if (field.startsWith('steps.')) {
    const [, stepId, ...rest] = field.split('.');
    const stepOutput = previousResults[stepId] as Record<string, unknown>;
    fieldValue = rest.reduce((obj: any, prop: string) => obj?.[prop], stepOutput);
  } else if (field.startsWith('trigger.')) {
    const props = field.slice(8).split('.');
    fieldValue = props.reduce((obj: any, prop: string) => obj?.[prop], triggerData);
  } else if (field.startsWith('variables.')) {
    fieldValue = variables[field.slice(10)];
  } else if (field.startsWith('contact.')) {
    fieldValue = contactData[field.slice(8)];
  } else {
    fieldValue = c.field;
  }

  switch (c.operator) {
    case 'eq':
    case 'equals':
      return fieldValue === c.value;
    case 'neq':
    case 'not_equals':
      return fieldValue !== c.value;
    case 'gt':
    case 'greater_than':
      return Number(fieldValue) > Number(c.value);
    case 'gte':
    case 'greater_than_or_equals':
      return Number(fieldValue) >= Number(c.value);
    case 'lt':
    case 'less_than':
      return Number(fieldValue) < Number(c.value);
    case 'lte':
    case 'less_than_or_equals':
      return Number(fieldValue) <= Number(c.value);
    case 'contains':
      return String(fieldValue).includes(String(c.value));
    case 'starts_with':
      return String(fieldValue).startsWith(String(c.value));
    case 'ends_with':
      return String(fieldValue).endsWith(String(c.value));
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists':
      return fieldValue === undefined || fieldValue === null;
    case 'in':
      return Array.isArray(c.value) && c.value.includes(fieldValue);
    case 'not_in':
      return !Array.isArray(c.value) || !c.value.includes(fieldValue);
    case 'matches':
      return new RegExp(String(c.value)).test(String(fieldValue));
    default:
      console.warn(`Unknown operator: ${c.operator}`);
      return false;
  }
}
