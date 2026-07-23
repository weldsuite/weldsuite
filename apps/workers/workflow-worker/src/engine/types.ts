/**
 * Engine contracts — the shapes the WeldConnect workflow engine is built
 * against. These are *types*, not behavior, so they're fully defined here; the
 * behavior lives in the (currently throwing) modules that import them.
 */

import type { Database } from '../db';

export type WorkflowDb = Database;

// ---------------------------------------------------------------------------
// Workflow definition (persisted as JSONB on the `workflows` row)
// ---------------------------------------------------------------------------

export interface StepCondition {
  field?: string;
  operator?: string;
  value?: unknown;
}

export interface RetryPolicy {
  maxAttempts: number;
  delayMs?: number;
  backoffMultiplier?: number;
}

export interface OnError {
  action: 'stop' | 'continue' | 'retry' | 'goto';
  retryCount?: number;
  gotoStep?: string;
}

export interface WorkflowStep {
  id: string;
  type: string;
  name?: string;
  description?: string;
  order?: number;
  /** The UI persists action inputs to `config`; the engine reads it (falling back to `inputs`). */
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  /** When present and falsy at runtime, the step is skipped. */
  condition?: StepCondition;
  onError?: OnError;
  retryPolicy?: RetryPolicy;
  continueOnError?: boolean;
  position?: { x: number; y: number };
}

export interface WorkflowDefinition {
  id: string;
  name?: string;
  version?: number;
  steps: WorkflowStep[];
  settings?: Record<string, unknown>;
}

export type TriggerType =
  | 'manual'
  | 'schedule'
  | 'webhook'
  | 'entity_event'
  | 'integration_event'
  | 'api'
  | 'workflow_complete';

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

/** Cloudflare Worker env / service bindings available to the engine. */
export interface WorkflowEnv {
  [key: string]: unknown;
  // Tenant DB resolution
  DATABASE_URL_MASTER?: string;
  NEON_API_KEY?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  WORKSPACE_CACHE?: KVNamespace;
  // Cross-worker
  REALTIME?: Fetcher;
  AGENT_WORKER?: Fetcher;
  EXECUTE_WORKFLOW?: { create: (init: { params: Record<string, unknown> }) => Promise<unknown> };
  // D1 schedule index — always-on timing layer for the schedule sweep
  // (see cron/schedule-sweep.ts + schedule-index.ts).
  SCHEDULE_INDEX?: D1Database;
  // Email / integrations
  INTERNAL_API_SECRET?: string;
  /** Origin of app-api hosting POST /api/internal/send-email (send_email
   *  action). Repointed from the legacy api-worker in phase W3 of the
   *  legacy-worker phase-out plan (.claude/open-source-plan.md). */
  APP_API_URL?: string;
  TELNYX_API_KEY?: string;
  // AI (@weldsuite/ai) — Cloudflare AI Gateway. See packages/core/ai/src/config.ts
  // for the full list of recognised keys. Mirrors app-api's wrangler.toml vars.
  /** Optional; must be `cloudflare` (the only gateway). */
  AI_GATEWAY_PROVIDER?: string;
  /** Default canonical model id; falls back to the free Workers AI default. */
  AI_DEFAULT_MODEL?: string;
  CF_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_API_TOKEN?: string;
  CF_AI_GATEWAY?: string;
  CF_AIG_TOKEN?: string;
}

export interface ActionContext {
  tenant: { workspaceId: string; userId: string };
  executionId: string;
  /** The workflow step's own id — used by ai_generate/ai_classify to key
   *  idempotent credit charges (`executionId:stepId:op`) so a step retry never
   *  double-charges the wallet. */
  stepId: string;
  db: WorkflowDb;
  env: WorkflowEnv;
  /** Outputs of every previously-completed step, keyed by step id. */
  previousResults: Record<string, unknown>;
  /** Enriched trigger payload (trigger data + run metadata). */
  triggerData: unknown;
  /** Workflow + global variables (mutable; `set_variable` writes here). */
  variables: Record<string, unknown>;
  /** Optional contact/customer context used by `{{contact.*}}`. */
  contactData?: Record<string, unknown>;
  loopItem?: unknown;
  loopIndex?: number;
}

export type ActionHandler = (
  inputs: Record<string, unknown>,
  context: ActionContext,
) => Promise<unknown>;

/** Sentinel an action returns to pause the run pending external input. */
export interface WaitingForInputResult {
  __waitingForInput: true;
  conversationId?: string;
  messageId?: string;
  stepType: 'send_choices' | 'collect_input' | 'manual_step';
}

export function isWaitingForInput(result: unknown): result is WaitingForInputResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>).__waitingForInput === true
  );
}

/** Sentinel a `delay` action returns so the orchestrator can sleep durably. */
export function getDelayMs(result: unknown): number | null {
  if (typeof result === 'object' && result !== null && '__delayMs' in result) {
    const ms = (result as Record<string, unknown>).__delayMs;
    return typeof ms === 'number' ? ms : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step orchestration (runtime-agnostic)
// ---------------------------------------------------------------------------

/**
 * Durability port. In production this adapts the Cloudflare `WorkflowStep`
 * (`step.do` / `step.sleep` / `step.waitForEvent`); in tests it's a synchronous
 * fake that runs work immediately and records sleeps/waits.
 */
export interface StepRuntime {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
  waitForEvent<T = unknown>(name: string, opts: { type: string; timeoutMs?: number }): Promise<T>;
}

export type StepStatus = 'completed' | 'failed' | 'skipped' | 'waiting_for_input';

export interface StepOutcome {
  status: StepStatus;
  result?: unknown;
  error?: string;
  /** How many attempts the step took (1 = succeeded first try). */
  attempts?: number;
}

export interface ExecutionHooks {
  onStepStart?(step: WorkflowStep, index: number): void | Promise<void>;
  onStepResult?(step: WorkflowStep, index: number, outcome: StepOutcome): void | Promise<void>;
  onComplete?(result: ExecuteStepsResult): void | Promise<void>;
}

export interface WorkflowRunContext {
  tenant: { workspaceId: string; userId: string };
  executionId: string;
  db: WorkflowDb;
  env: WorkflowEnv;
  triggerData?: unknown;
  variables?: Record<string, unknown>;
  contactData?: Record<string, unknown>;
}

export interface ExecuteStepsDeps {
  runtime: StepRuntime;
  executeAction: (
    type: string,
    inputs: Record<string, unknown>,
    ctx: ActionContext,
  ) => Promise<unknown>;
  hooks?: ExecutionHooks;
}

export interface ExecuteStepsResult {
  status: 'completed' | 'failed' | 'waiting_for_input';
  /** Each step's result keyed by step id (skipped steps → `{ skipped: true }`). */
  output: Record<string, unknown>;
  error?: { stepId: string; message: string };
  waiting?: { stepId: string; stepType?: string };
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export interface ResolvedIntegration {
  id: string;
  type: string;
  status: string;
  /** Decrypted credential bag (api keys, tokens, etc.). */
  credentials: Record<string, unknown>;
  oauthTokens?: { accessToken: string; refreshToken?: string; expiresAt?: string };
  settings?: Record<string, unknown>;
}

export interface ResolveIntegrationParams {
  /** Match a specific integration by id (takes precedence over `type`). */
  integrationId?: string;
  /** Match the first connected integration of this type (e.g. `'slack'`). */
  type?: string;
}

export interface ResolveIntegrationOptions {
  /** Decrypts a stored credential bag. Defaults to identity (already plaintext). */
  decrypt?: (value: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
}
