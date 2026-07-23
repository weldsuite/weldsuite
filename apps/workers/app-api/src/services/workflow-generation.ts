/**
 * AI workflow generation — turns a plain-English prompt into a workflow
 * draft (trigger + steps) the client loads into the WeldConnect editor for
 * review. Nothing is persisted here; `POST /api/workflows` (existing route)
 * saves it once the user is happy.
 *
 * Distinct from the older `services/workflow-builder.ts` / `/api/workflow-builder/*`
 * chat-driven builder (which persists a draft `workflows` row per turn and
 * applies incremental tool-call edits — currently AI-disabled at `/chat`,
 * out of scope here). This is a single-shot generation: one prompt in, one
 * full draft out, nothing written to the DB.
 *
 * Uses `@weldsuite/ai`'s `generateObject` against a plain JSON schema (not a
 * zod schema) — matches the convention in `services/mail/ai.ts`: a zod
 * schema this shape deep trips TS2589 "excessively deep" against the AI SDK
 * v7 generics.
 *
 * Credit metering: identical hard-gate + post-consume posture as
 * `/api/ai/generate` (`services/ai/billing.ts`) — the caller resolves
 * `AiMetering` and passes it in.
 */

import {
  assertGatewayConfigured,
  createWeldAI,
  generateObject,
  jsonSchema,
  recommended,
  type WeldAI,
  type AiUsage,
} from '@weldsuite/ai';
import type { Env } from '../types';
import { generateId } from '../lib/id';
import { assertAiCredits, chargeAiUsage, type AiMetering } from './ai/billing';
import { ACTION_TYPES, TRIGGER_TYPES, ENTITY_EVENTS } from '../routes/workflow-dashboard/static-catalogs';

export class WorkflowGenerationError extends Error {
  constructor(
    public readonly code: 'AI_NOT_CONFIGURED' | 'AI_REQUEST_FAILED' | 'INVALID_PROMPT',
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'WorkflowGenerationError';
  }
}

// ---------------------------------------------------------------------------
// Draft shape (what the model emits, before post-validation)
// ---------------------------------------------------------------------------

export interface GeneratedStep {
  id?: string;
  type: string;
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
}

export interface GeneratedTrigger {
  id?: string;
  type: string;
  name?: string;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
}

export interface GeneratedWorkflowDraft {
  name?: string;
  description?: string;
  triggers?: GeneratedTrigger[];
  steps?: GeneratedStep[];
}

/** Validated + normalized draft — every step/trigger has a stable id + name. */
export interface WorkflowDraftOut {
  name: string;
  description?: string;
  triggers: Array<Required<Omit<GeneratedTrigger, 'config'>> & { config: Record<string, unknown> }>;
  steps: Array<Required<Pick<GeneratedStep, 'id' | 'type' | 'name'>> & Pick<GeneratedStep, 'description'> & {
    config: Record<string, unknown>;
  }>;
}

const workflowDraftSchema = jsonSchema<GeneratedWorkflowDraft>({
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    triggers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          name: { type: 'string' },
          isEnabled: { type: 'boolean' },
          config: { type: 'object', additionalProperties: true },
        },
        required: ['type', 'name'],
        additionalProperties: false,
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          config: { type: 'object', additionalProperties: true },
        },
        required: ['type', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'triggers', 'steps'],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// System prompt — teaches the model the exact catalog it must pick from.
// ---------------------------------------------------------------------------

/**
 * Config field names for the built-in (non-integration) action types. Kept
 * inline rather than importing `packages/design/ui`'s `ACTION_REQUIRED_FIELDS` —
 * that package is a React UI library (JSX, browser deps) and isn't safe to
 * pull into a Workers bundle. Third-party integration actions don't need an
 * entry here: `deriveActionTypes()` already carries `.inputs` per action.
 */
const BUILTIN_ACTION_CONFIG_FIELDS: Record<string, string[]> = {
  send_email: ['to', 'subject', 'body'],
  send_sms: ['to', 'body'],
  send_notification: ['title', 'userIds'],
  slack_message: ['channel', 'text'],
  create_record: ['entityType', 'data'],
  update_record: ['entityType', 'id', 'data'],
  delete_record: ['entityType', 'id'],
  query_data: ['entityType', 'filters'],
  condition: ['field', 'operator', 'value'],
  loop: ['items'],
  delay: ['seconds', 'minutes', 'hours', 'days'],
  transform: ['input', 'transformation'],
  http_request: ['url', 'method', 'headers', 'body'],
  webhook: ['url', 'method', 'headers', 'body'],
  ai_generate: ['prompt', 'systemPrompt', 'model', 'temperature', 'maxTokens'],
  ai_classify: ['text', 'categories', 'model'],
  set_variable: ['name', 'value'],
  log: ['message', 'level'],
  manual_step: ['title'],
  assign_conversation: ['strategy', 'agentId'],
  tag_conversation: ['tags'],
  change_conversation_status: ['status'],
  change_priority: ['priority'],
  send_reply: ['message'],
  add_internal_note: ['note'],
  send_message: ['message'],
  send_choices: ['question', 'choices'],
  collect_input: ['question', 'variableName'],
};

const TRIGGER_CATEGORY_HELP = [
  'manual: config = {} (no fields needed).',
  'schedule: config = { cronExpression, timezone }.',
  'entity_event: config = { entityType, eventType } — the pair MUST come from the "Entity types + events" list below.',
  'webhook: config = { method }.',
  'integration_event: config = { provider, event } — pick from the "Integration triggers" list below.',
  'api: config = {} (no fields needed).',
  'workflow_complete: config = { sourceWorkflowId, triggerOn }.',
].join('\n');

function buildSystemPrompt(): string {
  const actionsList = ACTION_TYPES.map((a) => {
    const fields = BUILTIN_ACTION_CONFIG_FIELDS[a.id] ?? (a as { inputs?: Array<{ key: string }> }).inputs?.map((i) => i.key) ?? [];
    return `- ${a.id}: ${a.description}${fields.length ? ` (config fields: ${fields.join(', ')})` : ''}`;
  }).join('\n');

  const integrationTriggers = (TRIGGER_TYPES as Array<{ id: string; description: string; provider?: string }>)
    .filter((t) => typeof t.provider === 'string')
    .map((t) => `- provider=${t.provider}, event=${t.id}: ${t.description}`)
    .join('\n');

  const entityEventsList = ENTITY_EVENTS.map(
    (e) => `- entityType=${e.entityType}: eventType ∈ [${e.events.map((ev) => ev.id).join(', ')}]`,
  ).join('\n');

  return [
    'You are a workflow-automation architect for WeldSuite (WeldConnect), a visual automation builder.',
    'Given a plain-English description of an automation, output a workflow draft as structured data.',
    '',
    'Rules:',
    '- Use ONLY the action types and trigger categories listed below — never invent new ones.',
    '- Every step needs a short, human-readable `name` and a `config` object using the field names shown for its type.',
    '- Every trigger needs a `type` (one of the 7 trigger categories below) and a matching `config`.',
    '- Prefer exactly 1 trigger and 2–6 steps for a typical automation. Keep it directly focused on the prompt.',
    '- Write a short `name` (a few words) and one-sentence `description` for the whole workflow.',
    '',
    'Available action types:',
    actionsList,
    '',
    'Trigger categories:',
    TRIGGER_CATEGORY_HELP,
    '',
    'Entity types + events (for entity_event triggers):',
    entityEventsList || '(none configured)',
    '',
    'Integration triggers (for integration_event triggers):',
    integrationTriggers || '(none connected)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Post-validation — pure, unit-testable without any AI/DB call.
// ---------------------------------------------------------------------------

const TRIGGER_CATEGORIES = new Set([
  'schedule',
  'entity_event',
  'integration_event',
  'webhook',
  'manual',
  'api',
  'workflow_complete',
]);

export interface ValidationCatalog {
  actionTypeIds: Set<string>;
  entityEventsByType: Map<string, Set<string>>;
}

export function buildValidationCatalog(): ValidationCatalog {
  return {
    actionTypeIds: new Set(ACTION_TYPES.map((a) => a.id)),
    entityEventsByType: new Map(ENTITY_EVENTS.map((e) => [e.entityType, new Set(e.events.map((ev) => ev.id))])),
  };
}

export interface PostValidateResult {
  workflow: WorkflowDraftOut;
  warnings: string[];
}

/**
 * Normalize the model's draft (assign stable ids/names where missing) and
 * flag — never silently drop — anything referencing an action/trigger type
 * outside the catalog, so the human reviewer sees exactly what needs fixing
 * before publishing.
 */
export function postValidateDraft(raw: GeneratedWorkflowDraft, catalog: ValidationCatalog): PostValidateResult {
  const warnings: string[] = [];

  const steps: WorkflowDraftOut['steps'] = (raw.steps ?? []).map((s, i) => {
    const id = s.id?.trim() || generateId('step');
    const name = s.name?.trim() || `Step ${i + 1}`;
    const type = s.type?.trim() || '';
    if (!type || !catalog.actionTypeIds.has(type)) {
      warnings.push(`Step "${name}" uses an unknown action type "${type}" — review before publishing.`);
    }
    return { id, type, name, description: s.description, config: s.config ?? {} };
  });

  const triggers: WorkflowDraftOut['triggers'] = (raw.triggers ?? []).map((t, i) => {
    const id = t.id?.trim() || generateId('trg');
    const name = t.name?.trim() || `Trigger ${i + 1}`;
    const type = t.type?.trim() || '';
    const config = (t.config ?? {}) as Record<string, unknown>;

    if (!TRIGGER_CATEGORIES.has(type)) {
      warnings.push(`Trigger "${name}" uses an unknown trigger type "${type}" — review before publishing.`);
    } else if (type === 'entity_event') {
      const entityType = String(config.entityType ?? '');
      const eventType = String(config.eventType ?? '');
      const events = catalog.entityEventsByType.get(entityType);
      if (!events) {
        warnings.push(`Trigger "${name}" references an unknown entity type "${entityType}" — review before publishing.`);
      } else if (!eventType || !events.has(eventType)) {
        warnings.push(
          `Trigger "${name}" references an unknown event "${eventType}" for entity "${entityType}" — review before publishing.`,
        );
      }
    }

    return { id, type, name, isEnabled: t.isEnabled ?? true, config };
  });

  if (steps.length === 0) {
    warnings.push('The generated workflow has no steps — add at least one action before publishing.');
  }
  if (triggers.length === 0) {
    warnings.push('The generated workflow has no trigger — add one before publishing.');
  }

  return {
    workflow: {
      name: raw.name?.trim() || 'Untitled workflow',
      description: raw.description?.trim(),
      triggers,
      steps,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GenerateWorkflowInput {
  prompt: string;
}

export interface GenerateWorkflowResult {
  workflow: WorkflowDraftOut;
  warnings: string[];
  model: string;
  usage: unknown;
}

function getAi(env: Env): WeldAI {
  // Delegate to @weldsuite/ai: it validates the Cloudflare AI Gateway env.
  try {
    assertGatewayConfigured(env);
  } catch (err) {
    throw new WorkflowGenerationError(
      'AI_NOT_CONFIGURED',
      err instanceof Error ? err.message : 'AI gateway is not configured',
      503,
    );
  }
  return createWeldAI(env);
}

/**
 * Model: the `copilot` (agentic tool-calling) quality tier — the closest fit
 * in `recommended` for "pick from a tool/action catalog and emit structured
 * output". Generation quality matters more than cost/latency here (this
 * drives what a user reviews and may publish), so always the quality tier —
 * there's no established free/quality toggle pattern elsewhere to hook into,
 * so this is intentionally simple.
 */
const GENERATION_MODEL = recommended.copilot.quality;

export async function generateWorkflowDraft(
  env: Env,
  input: GenerateWorkflowInput,
  metering: AiMetering | null,
): Promise<GenerateWorkflowResult> {
  const ai = getAi(env);
  await assertAiCredits(metering);

  let result: { object: GeneratedWorkflowDraft; usage: AiUsage };
  try {
    result = await generateObject({
      model: ai.model(GENERATION_MODEL),
      schema: workflowDraftSchema,
      system: buildSystemPrompt(),
      prompt: `Build a workflow for: ${input.prompt}`,
    });
  } catch (err) {
    throw new WorkflowGenerationError(
      'AI_REQUEST_FAILED',
      err instanceof Error ? err.message : 'AI request failed',
      502,
    );
  }

  await chargeAiUsage(metering, { modelId: GENERATION_MODEL, usage: result.usage, op: 'workflow_generate' });

  const { workflow, warnings } = postValidateDraft(result.object, buildValidationCatalog());
  return { workflow, warnings, model: GENERATION_MODEL, usage: result.usage };
}
