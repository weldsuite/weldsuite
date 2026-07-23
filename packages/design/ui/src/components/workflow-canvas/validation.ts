/**
 * Canonical workflow step validation — the SINGLE source of truth for
 * "which required fields is this action still missing?".
 *
 * Both the canvas (per-node "Setup required" badge, via flow-utils) and the
 * platform editor (required-fields guidance card + publish gating) consume
 * this module, so the rules can never drift out of sync again.
 *
 * Rules are keyed on the EXACT config key each action's config form writes
 * (see apps/web/platform/components/workflow-editor/components/action-config-form.tsx).
 *
 * `labelKey` is a stable key under the i18n `actionConfigForm` namespace; the
 * host app resolves it to a translated, user-facing field label. The package
 * itself stays i18n-free.
 */

export interface MissingField {
  /** Stable i18n key under `actionConfigForm` (e.g. 'to', 'waitDuration'). */
  labelKey: string;
}

interface RequiredRule {
  /** i18n key under `actionConfigForm` for the field's label. */
  labelKey: string;
  /** Returns true when this required field is not satisfied by the config. */
  isMissing: (config: Record<string, any>) => boolean;
}

/** Empty = undefined, null, blank/whitespace string. 0 and false count as present. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function isEmptyArray(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0;
}

function isEmptyObject(value: unknown): boolean {
  return !value || typeof value !== 'object' || Object.keys(value as object).length === 0;
}

/** Operators that compare a single value vs. operators that don't need one. */
const NO_VALUE_OPERATORS = ['isEmpty', 'isNotEmpty'];

/**
 * Required-field rules per action type. Action types that accept any config
 * (or have no required fields) are intentionally absent — they are always
 * considered "configured".
 */
export const ACTION_REQUIRED_FIELDS: Record<string, RequiredRule[]> = {
  // --- Communication -------------------------------------------------------
  send_email: [
    { labelKey: 'to', isMissing: (c) => isBlank(c.to) },
    { labelKey: 'subject', isMissing: (c) => isBlank(c.subject) },
    { labelKey: 'body', isMissing: (c) => isBlank(c.body) },
  ],
  send_notification: [
    { labelKey: 'title', isMissing: (c) => isBlank(c.title) },
    { labelKey: 'recipient', isMissing: (c) => isEmptyArray(c.userIds) },
  ],

  // --- Integration ---------------------------------------------------------
  http_request: [
    { labelKey: 'url', isMissing: (c) => isBlank(c.url) },
    { labelKey: 'method', isMissing: (c) => isBlank(c.method) },
  ],

  // --- Data ----------------------------------------------------------------
  create_record: [
    { labelKey: 'entityType', isMissing: (c) => isBlank(c.entityType) && isBlank(c.entity) },
    { labelKey: 'fields', isMissing: (c) => isEmptyObject(c.data) },
  ],
  update_record: [
    { labelKey: 'entityType', isMissing: (c) => isBlank(c.entityType) && isBlank(c.entity) },
    { labelKey: 'recordId', isMissing: (c) => isBlank(c.id) },
    { labelKey: 'fields', isMissing: (c) => isEmptyObject(c.data) },
  ],
  delete_record: [
    { labelKey: 'entityType', isMissing: (c) => isBlank(c.entityType) && isBlank(c.entity) },
    { labelKey: 'recordId', isMissing: (c) => isBlank(c.id) },
  ],
  query_data: [
    { labelKey: 'entityType', isMissing: (c) => isBlank(c.entityType) && isBlank(c.entity) },
  ],
  set_variable: [
    { labelKey: 'variableName', isMissing: (c) => isBlank(c.name) },
    { labelKey: 'value', isMissing: (c) => isBlank(c.value) },
  ],
  transform_data: [
    { labelKey: 'inputData', isMissing: (c) => isBlank(c.input) },
    { labelKey: 'transformation', isMissing: (c) => isBlank(c.transformation) },
  ],

  // --- Logic / flow control -----------------------------------------------
  condition: [
    { labelKey: 'fieldToCheck', isMissing: (c) => isBlank(c.field) },
    {
      labelKey: 'value',
      isMissing: (c) => !NO_VALUE_OPERATORS.includes(c.operator || 'eq') && isBlank(c.value),
    },
  ],
  loop: [{ labelKey: 'itemsToIterate', isMissing: (c) => isBlank(c.items) }],
  delay: [
    {
      labelKey: 'waitDuration',
      isMissing: (c) =>
        !(Number(c.seconds) > 0 || Number(c.minutes) > 0 || Number(c.hours) > 0 || Number(c.days) > 0),
    },
  ],
  manual_step: [{ labelKey: 'manualTitle', isMissing: (c) => isBlank(c.title) }],
  log_message: [{ labelKey: 'message', isMissing: (c) => isBlank(c.message) }],

  // --- AI ------------------------------------------------------------------
  ai_agent: [
    {
      // A saved agent definition OR an inline system prompt satisfies the step.
      labelKey: 'systemPrompt',
      isMissing: (c) => isBlank(c.agentDefinitionId) && isBlank(c.systemPrompt),
    },
  ],
  // Field names match what apps/workers/workflow-worker/src/engine/actions/ai.ts
  // reads first (`prompt`; `text`/`categories`, with `input`/`labels` as
  // back-compat aliases only) — keep in sync with that file.
  ai_generate: [{ labelKey: 'prompt', isMissing: (c) => isBlank(c.prompt) }],
  ai_classify: [
    { labelKey: 'textToClassify', isMissing: (c) => isBlank(c.text) && isBlank(c.input) },
    { labelKey: 'categories', isMissing: (c) => isEmptyArray(c.categories) && isEmptyArray(c.labels) },
  ],

  // --- Helpdesk ------------------------------------------------------------
  assign_conversation: [
    { labelKey: 'assignmentStrategy', isMissing: (c) => isBlank(c.strategy) },
    {
      labelKey: 'agent',
      isMissing: (c) => c.strategy === 'specific_agent' && isBlank(c.agentId),
    },
    {
      labelKey: 'departmentId',
      isMissing: (c) => c.strategy === 'department' && isBlank(c.departmentId),
    },
  ],
  tag_conversation: [{ labelKey: 'tags', isMissing: (c) => isEmptyArray(c.tags) }],
  change_conversation_status: [
    { labelKey: 'status', isMissing: (c) => isBlank(c.status) },
    {
      labelKey: 'snoozeDuration',
      isMissing: (c) => c.status === 'snoozed' && !(Number(c.snoozeDurationMinutes) > 0),
    },
  ],
  change_priority: [{ labelKey: 'priority', isMissing: (c) => isBlank(c.priority) }],
  send_reply: [{ labelKey: 'message', isMissing: (c) => isBlank(c.message) }],
  add_internal_note: [{ labelKey: 'noteContent', isMissing: (c) => isBlank(c.content) }],
  apply_sla: [{ labelKey: 'slaPolicyId', isMissing: (c) => isBlank(c.slaId) }],

  // --- Chat widget ---------------------------------------------------------
  send_message: [{ labelKey: 'message', isMissing: (c) => isBlank(c.message) }],
  send_choices: [
    { labelKey: 'promptMessage', isMissing: (c) => isBlank(c.message) },
    { labelKey: 'options', isMissing: (c) => !Array.isArray(c.options) || c.options.length < 2 },
  ],
  collect_input: [
    { labelKey: 'promptMessage', isMissing: (c) => isBlank(c.message) },
    { labelKey: 'fields', isMissing: (c) => isEmptyArray(c.fields) },
  ],
  collect_customer_info: [{ labelKey: 'fieldsToCollect', isMissing: (c) => isEmptyArray(c.fields) }],
};

/** Action type aliases that share another type's rules. */
const ACTION_TYPE_ALIASES: Record<string, string> = {
  email: 'send_email',
  notification: 'send_notification',
  http: 'http_request',
  webhook: 'http_request',
  api_call: 'http_request',
  if: 'condition',
  branch: 'condition',
  wait: 'delay',
  iterate: 'loop',
  assign: 'set_variable',
  transform: 'transform_data',
  query: 'query_data',
  log: 'log_message',
  debug: 'log_message',
};

/**
 * Returns the list of still-missing required fields for an action's config.
 * Empty array ⇒ the step has everything it needs to run.
 */
export function getMissingRequiredFields(
  actionType: string,
  config: Record<string, any> = {},
): MissingField[] {
  const resolvedType = ACTION_TYPE_ALIASES[actionType] || actionType;
  const rules = ACTION_REQUIRED_FIELDS[resolvedType];
  if (!rules) return [];
  return rules
    .filter((rule) => rule.isMissing(config || {}))
    .map((rule) => ({ labelKey: rule.labelKey }));
}

/** True when the step has no missing required fields. */
export function isStepConfigured(step: { type: string; config?: Record<string, any> | null }): boolean {
  return getMissingRequiredFields(step.type, step.config || {}).length === 0;
}
