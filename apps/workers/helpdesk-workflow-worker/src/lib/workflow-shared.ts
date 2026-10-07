/**
 * Shared Workflow Utilities
 *
 * Template resolution, condition evaluation, step classification.
 * Ported from helpdesk-workflow-worker (canonical source).
 */

import { asText } from '@weldsuite/text';

// ============================================================================
// Step Classification
// ============================================================================

const CUSTOMER_FACING_STEP_TYPES = new Set([
  'send_message',
  'delay',
  'send_choices',
  'collect_input',
  'collect_customer_info',
  'suggest_articles',
  'ai_auto_reply',
  'ai_agent',
]);

const BACKEND_ONLY_STEP_TYPES = new Set([
  'assign_conversation',
  'unassign_conversation',
  'tag_conversation',
  'change_conversation_status',
  'change_priority',
  'close_conversation',
  'snooze_conversation',
  'add_internal_note',
  'send_notification',
  'apply_sla',
  'create_ticket_from_conversation',
  'trigger_csat',
  'set_conversation_attribute',
  'set_contact_attribute',
  'trigger_webhook',
  'send_reply',
  'log',
  'set_variable',
]);

export function isCustomerFacingStep(stepType: string): boolean {
  return CUSTOMER_FACING_STEP_TYPES.has(stepType);
}

export function isBackendOnlyStep(stepType: string): boolean {
  return BACKEND_ONLY_STEP_TYPES.has(stepType);
}

export function isInteractiveStep(stepType: string): boolean {
  return stepType === 'send_choices' || stepType === 'collect_input' || stepType === 'collect_customer_info';
}

// ============================================================================
// Template Resolution
// ============================================================================

type ResolveScope = {
  previousResults: Record<string, unknown>;
  triggerData: unknown;
  variables: Record<string, unknown>;
  contactData: Record<string, unknown>;
};

const REFERENCE_PREFIXES = ['steps.', 'trigger.', 'variables.', 'contact.'];

function isReference(path: string): boolean {
  return REFERENCE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function getPath(root: unknown, keys: string[]): unknown {
  return keys.reduce((o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), root);
}

/** Looks up a `steps.` / `trigger.` / `variables.` / `contact.` reference; undefined when unknown. */
function resolveReference(path: string, scope: ResolveScope): unknown {
  if (path.startsWith('steps.')) {
    const [, stepId, ...rest] = path.split('.');
    return getPath(scope.previousResults[stepId] as Record<string, unknown>, rest);
  }
  if (path.startsWith('trigger.')) return getPath(scope.triggerData, path.slice(8).split('.'));
  if (path.startsWith('variables.')) return scope.variables[path.slice(10)];
  if (path.startsWith('contact.')) return scope.contactData[path.slice(8)];
  return undefined;
}

function resolveStringInput(value: string, scope: ResolveScope): unknown {
  if (!(value.includes('{{') && value.includes('}}'))) return value;

  const interpolated = value.replace(/\{\{([^}]+)\}\}/g, (_match, path) => {
    const r = resolveReference((path as string).trim(), scope);
    return r !== undefined ? asText(r) : '';
  });

  // A value that is exactly one template keeps the referenced value's original type
  if (/^\{\{[^}]+\}\}$/.test(value)) {
    const result = resolveReference(value.slice(2, -2).trim(), scope);
    if (result !== undefined) return result;
  }
  return interpolated;
}

function resolveInputValue(value: unknown, scope: ResolveScope): unknown {
  if (typeof value === 'string') return resolveStringInput(value, scope);
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'object' && item !== null
        ? resolveInputsInScope(item as Record<string, unknown>, scope)
        : item,
    );
  }
  if (typeof value === 'object' && value !== null) {
    return resolveInputsInScope(value as Record<string, unknown>, scope);
  }
  return value;
}

function resolveInputsInScope(inputs: Record<string, unknown>, scope: ResolveScope): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    resolved[key] = resolveInputValue(value, scope);
  }
  return resolved;
}

export function resolveInputs(
  inputs: Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): Record<string, unknown> {
  return resolveInputsInScope(inputs, { previousResults, triggerData, variables, contactData });
}

// ============================================================================
// Condition Evaluation
// ============================================================================

export function evaluateCondition(
  condition: { field?: string; operator?: string; value?: unknown } | Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): boolean {
  if (!condition.field || !condition.operator) return false;

  const field = asText(condition.field);
  const fieldValue: unknown = isReference(field)
    ? resolveReference(field, { previousResults, triggerData, variables, contactData })
    : condition.field;

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

// ============================================================================
// Conversation ID Resolution
// ============================================================================

export function resolveConversationId(
  inputs: Record<string, unknown>,
  triggerData: unknown,
): string | null {
  if (inputs.conversationId) return asText(inputs.conversationId);
  const td = triggerData as Record<string, unknown> | undefined;
  if (td?.entityType === 'helpdesk_conversation') return String(td.entityId);
  if (td?.data && typeof td.data === 'object' && 'conversationId' in (td.data as object)) {
    return String((td.data as Record<string, unknown>).conversationId);
  }
  if (td?.data && typeof td.data === 'object' && 'id' in (td.data as object)) {
    return String((td.data as Record<string, unknown>).id);
  }
  return null;
}
