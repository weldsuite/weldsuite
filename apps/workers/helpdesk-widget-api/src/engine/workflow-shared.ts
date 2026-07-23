/**
 * Shared Workflow Utilities — ported verbatim from helpdesk-workflow-worker.
 */

export function isInteractiveStep(stepType: string): boolean {
  return stepType === 'send_choices' || stepType === 'collect_input' || stepType === 'collect_customer_info';
}

export function resolveInputs(
  inputs: Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === 'string') {
      if (value.includes('{{') && value.includes('}}')) {
        resolved[key] = value.replace(/\{\{([^}]+)\}\}/g, (_match, path) => {
          const p = (path as string).trim();
          if (p.startsWith('steps.')) {
            const [, stepId, ...rest] = p.split('.');
            const out = previousResults[stepId] as Record<string, unknown>;
            const r = rest.reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), out);
            return r !== undefined ? String(r) : '';
          } else if (p.startsWith('trigger.')) {
            const r = p.slice(8).split('.').reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), triggerData);
            return r !== undefined ? String(r) : '';
          } else if (p.startsWith('variables.')) {
            const r = variables[p.slice(10)];
            return r !== undefined ? String(r) : '';
          } else if (p.startsWith('contact.')) {
            const r = contactData[p.slice(8)];
            return r !== undefined ? String(r) : '';
          }
          return '';
        });

        if (value.match(/^\{\{[^}]+\}\}$/)) {
          const p = value.slice(2, -2).trim();
          let result: unknown;
          if (p.startsWith('steps.')) {
            const [, stepId, ...rest] = p.split('.');
            const out = previousResults[stepId] as Record<string, unknown>;
            result = rest.reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), out);
          } else if (p.startsWith('trigger.')) {
            result = p.slice(8).split('.').reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), triggerData);
          } else if (p.startsWith('variables.')) {
            result = variables[p.slice(10)];
          } else if (p.startsWith('contact.')) {
            result = contactData[p.slice(8)];
          }
          if (result !== undefined) resolved[key] = result;
        }
      } else {
        resolved[key] = value;
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      resolved[key] = resolveInputs(value as Record<string, unknown>, previousResults, triggerData, variables, contactData);
    } else if (Array.isArray(value)) {
      resolved[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? resolveInputs(item as Record<string, unknown>, previousResults, triggerData, variables, contactData)
          : item,
      );
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

export function evaluateCondition(
  condition: { field?: string; operator?: string; value?: unknown } | Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): boolean {
  if (!condition.field || !condition.operator) return false;

  let fieldValue: unknown;
  const field = String(condition.field);

  if (field.startsWith('steps.')) {
    const [, stepId, ...rest] = field.split('.');
    const out = previousResults[stepId] as Record<string, unknown>;
    fieldValue = rest.reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), out);
  } else if (field.startsWith('trigger.')) {
    fieldValue = field.slice(8).split('.').reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), triggerData);
  } else if (field.startsWith('variables.')) {
    fieldValue = variables[field.slice(10)];
  } else if (field.startsWith('contact.')) {
    fieldValue = contactData[field.slice(8)];
  } else {
    fieldValue = condition.field;
  }

  switch (condition.operator) {
    case 'eq': case 'equals': return fieldValue === condition.value;
    case 'neq': case 'not_equals': return fieldValue !== condition.value;
    case 'gt': case 'greater_than': return Number(fieldValue) > Number(condition.value);
    case 'gte': case 'greater_than_or_equals': return Number(fieldValue) >= Number(condition.value);
    case 'lt': case 'less_than': return Number(fieldValue) < Number(condition.value);
    case 'lte': case 'less_than_or_equals': return Number(fieldValue) <= Number(condition.value);
    case 'contains': return String(fieldValue).includes(String(condition.value));
    case 'starts_with': return String(fieldValue).startsWith(String(condition.value));
    case 'ends_with': return String(fieldValue).endsWith(String(condition.value));
    case 'exists': return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists': return fieldValue === undefined || fieldValue === null;
    case 'in': return Array.isArray(condition.value) && condition.value.includes(fieldValue);
    case 'not_in': return !Array.isArray(condition.value) || !condition.value.includes(fieldValue);
    case 'matches': return new RegExp(String(condition.value)).test(String(fieldValue));
    default: return false;
  }
}

export function resolveConversationId(
  inputs: Record<string, unknown>,
  triggerData: unknown,
): string | null {
  if (inputs.conversationId) return String(inputs.conversationId);
  const td = triggerData as Record<string, unknown> | undefined;
  if (td?.entityType === 'helpdesk_conversation') return String(td.entityId);
  if (td?.data && typeof td.data === 'object' && 'conversationId' in (td.data as object)) {
    return String((td.data as Record<string, unknown>).conversationId);
  }
  return null;
}
