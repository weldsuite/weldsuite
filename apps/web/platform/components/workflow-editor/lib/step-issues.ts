/**
 * Step checks the required-field rules cannot make: a field that is filled in,
 * but with a literal value the action will reject at run time (an email step
 * addressed to `not-an-email` used to publish fine and then fail on every run),
 * and `{{variables}}` that do not exist for this workflow.
 *
 * Values containing `{{…}}` are skipped by the format checks: what they resolve
 * to is only known when the workflow runs, and the engine validates it there.
 */

export interface StepFormatIssue {
  /** i18n key under `actionConfigForm` for the offending field's label. */
  labelKey: string;
  kind: 'email' | 'url';
  value: string;
}

type Config = Record<string, unknown>;

const EMAIL_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
// Scheme optional: the company website field is usually typed as `acme.com`.
const URL_PATTERN = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;

function hasVariable(value: string): boolean {
  return value.includes('{{');
}

/** `Name <address>` → `address`; anything else is returned trimmed. */
function addressOf(recipient: string): string {
  const bracketed = /<([^<>]*)>\s*$/.exec(recipient);
  return (bracketed ? bracketed[1] : recipient).trim();
}

function invalidRecipients(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[,;]/) : [];
  return list
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !hasVariable(entry) && !EMAIL_PATTERN.test(addressOf(entry)));
}

function literal(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' || hasVariable(value) ? null : value;
}

function sendEmailIssues(config: Config): StepFormatIssue[] {
  return (['to', 'cc', 'bcc'] as const).flatMap((field) =>
    invalidRecipients(config[field]).map((value) => ({ labelKey: field, kind: 'email' as const, value })),
  );
}

function createCustomerIssues(config: Config): StepFormatIssue[] {
  const issues: StepFormatIssue[] = [];
  const email = literal(config.email);
  if (email && !EMAIL_PATTERN.test(email)) issues.push({ labelKey: 'customerEmail', kind: 'email', value: email });
  const website = literal(config.website);
  if (website && !URL_PATTERN.test(website)) issues.push({ labelKey: 'customerWebsite', kind: 'url', value: website });
  return issues;
}

const FORMAT_CHECKS: Record<string, (config: Config) => StepFormatIssue[]> = {
  send_email: sendEmailIssues,
  email: sendEmailIssues,
  create_customer: createCustomerIssues,
};

export function getStepFormatIssues(step: { type?: string; config?: Config | null }): StepFormatIssue[] {
  return FORMAT_CHECKS[step.type ?? '']?.(step.config ?? {}) ?? [];
}

// ---------------------------------------------------------------------------
// Unknown variables
// ---------------------------------------------------------------------------

export interface VariableScope {
  /** Trigger type of the workflow (`entity_event`, `schedule`, …). */
  triggerType?: string;
  /**
   * Field paths of the trigger's record (`firstName`, `address.city`), when the
   * entity has a known field list. Undefined = unknown entity, so
   * `trigger.record.*` is not checked.
   */
  recordFields?: readonly string[];
  /** Ids of the steps that run before this one. */
  previousStepIds: readonly string[];
  /** Names of the workflow variables. */
  variableNames: readonly string[];
  /**
   * Extra roots the host adds to the picker (e.g. `contact` for CRM sequences).
   * The engine's resolver only knows `trigger`, `steps`, `variables` and
   * `contact` (apps/workers/workflow-worker/src/engine/resolve-inputs.ts).
   */
  extraRoots?: readonly string[];
}

// What `buildTriggerData` (apps/workers/workflow-worker/src/engine/trigger-data.ts)
// puts under `trigger.*` for every run, whatever started it.
const TRIGGER_META_KEYS = ['userId', 'workspaceId', 'triggerType', 'workflowId', 'workflowName', 'executionId'];

// Per trigger type: the aliases the picker offers plus the raw dispatcher keys.
const TRIGGER_KEYS: Record<string, string[]> = {
  entity_event: [
    'entity', 'event', 'recordId', 'record', 'previousRecord', 'changes',
    'entityType', 'entityId', 'action', 'data',
  ],
  schedule: ['scheduledTime', 'scheduledTimeLocal', 'runId', 'scheduleId', 'cronExpression', 'timezone'],
  manual: ['timestamp'],
};

function isKnownTriggerPath(segments: string[], scope: VariableScope): boolean {
  const [key, field] = segments;
  if (!key) return false;
  if (TRIGGER_META_KEYS.includes(key)) return true;
  const known = TRIGGER_KEYS[scope.triggerType ?? ''];
  // Trigger types without a key list (webhook, api, …) carry caller-defined payloads.
  if (!known) return true;
  if (!known.includes(key)) return false;
  // Checked on the top-level field only: anything below a known object field is the record's business.
  if (key === 'record' && field && scope.recordFields) {
    return scope.recordFields.some((path) => path.split('.')[0] === field);
  }
  return true;
}

function isKnownVariable(path: string, scope: VariableScope): boolean {
  const [root, ...rest] = path.split('.');
  switch (root) {
    case 'trigger':
      return isKnownTriggerPath(rest, scope);
    case 'steps':
      return !!rest[0] && scope.previousStepIds.includes(rest[0]);
    case 'variables':
      return scope.variableNames.includes(rest.join('.'));
    default:
      return !!scope.extraRoots?.includes(root);
  }
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out));
}

/**
 * The `{{paths}}` used in a step's config that resolve to nothing for this
 * workflow (a typo, a field the record does not have, a step that runs later).
 * At run time those render as an empty string without any error.
 */
export function findUnknownVariables(config: Config | null | undefined, scope: VariableScope): string[] {
  const strings: string[] = [];
  collectStrings(config ?? {}, strings);
  const unknown = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const path = match[1].trim();
      if (path && !isKnownVariable(path, scope)) unknown.add(path);
    }
  }
  return [...unknown];
}
