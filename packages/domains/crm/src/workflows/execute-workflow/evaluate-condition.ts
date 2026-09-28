/**
 * Condition evaluator for workflow step conditions.
 *
 * Ported verbatim from apps/api-worker/src/workflows/execute-workflow/
 * evaluate-condition.ts (W4 legacy-worker phase-out). No worker-specific
 * imports.
 *
 * Resolves field values from steps, trigger data, variables, and contact data,
 * then evaluates using the specified operator.
 */

export function evaluateCondition(
  condition: { field?: string; operator?: string; value?: unknown } | Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): boolean {
  if (!condition.field || !condition.operator) {
    console.warn('Condition missing field or operator, failing closed');
    return false;
  }

  // Get the field value
  let fieldValue: unknown;
  const field = String(condition.field);

  if (field.startsWith('steps.')) {
    const [, stepId, ...rest] = field.split('.');
    const stepOutput = previousResults[stepId] as Record<string, unknown>;
    fieldValue = rest.reduce((obj: any, prop: string) => obj?.[prop], stepOutput);
  } else if (field.startsWith('trigger.')) {
    const props = field.slice(8).split('.');
    fieldValue = props.reduce((obj: any, prop: string) => obj?.[prop], triggerData);
  } else if (field.startsWith('variables.')) {
    const varName = field.slice(10);
    fieldValue = variables[varName];
  } else if (field.startsWith('contact.')) {
    const prop = field.slice(8);
    fieldValue = contactData[prop];
  } else {
    fieldValue = condition.field;
  }

  // Evaluate based on operator
  switch (condition.operator) {
    case 'eq':
    case 'equals':
      return fieldValue === condition.value;
    case 'neq':
    case 'not_equals':
      return fieldValue !== condition.value;
    case 'gt':
    case 'greater_than':
      return Number(fieldValue) > Number(condition.value);
    case 'gte':
    case 'greater_than_or_equals':
      return Number(fieldValue) >= Number(condition.value);
    case 'lt':
    case 'less_than':
      return Number(fieldValue) < Number(condition.value);
    case 'lte':
    case 'less_than_or_equals':
      return Number(fieldValue) <= Number(condition.value);
    case 'contains':
      return String(fieldValue).includes(String(condition.value));
    case 'starts_with':
      return String(fieldValue).startsWith(String(condition.value));
    case 'ends_with':
      return String(fieldValue).endsWith(String(condition.value));
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists':
      return fieldValue === undefined || fieldValue === null;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(fieldValue);
    case 'not_in':
      return !Array.isArray(condition.value) || !condition.value.includes(fieldValue);
    case 'matches':
      return new RegExp(String(condition.value)).test(String(fieldValue));
    default:
      console.warn(`Unknown operator: ${condition.operator}`);
      return false;
  }
}
