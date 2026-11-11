/**
 * What a ProcessResponse step looks like. Adding a step is one file: write it
 * against these types and list it in `./index.ts`.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';
import type { Database, MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import type { ProcessResponseParams } from '../process-params';

export interface ProcessContext {
  env: Env;
  db: Database;
  master: MasterDatabase;
  params: ProcessResponseParams;
  form: typeof schema.forms.$inferSelect;
  response: typeof schema.formResponses.$inferSelect;
  /** The version the response answered. */
  definition: FormDefinition;
  files: Array<typeof schema.formResponseFiles.$inferSelect>;
}

/** What an integration step did. `skipped` carries the reason shown on the integration. */
export type StepResult =
  | { status: 'done'; entityType?: string; entityId?: string }
  | { status: 'skipped'; reason: string };

export interface RetryConfig {
  limit: number;
  delay: string;
  backoff: 'constant' | 'linear' | 'exponential';
}

/** A step that runs once per response (notifications, the receipt email). */
export interface AlwaysStep {
  type: 'always';
  /** Unique; the Workflow step name. */
  name: string;
  retries?: RetryConfig;
  run(ctx: ProcessContext): Promise<void>;
}

/**
 * A step that runs once per enabled integration of `kind` (CRM, Desk, Flow). The
 * workflow records it in `form_response_actions` (pending, then done, skipped
 * or failed with the error) and retries a failure without repeating the other
 * steps; the response shows it with a Retry button.
 */
export interface IntegrationStep {
  type: 'integration';
  kind: (typeof schema.formIntegrations.$inferSelect)['kind'];
  name: string;
  retries?: RetryConfig;
  run(ctx: ProcessContext, integration: typeof schema.formIntegrations.$inferSelect): Promise<StepResult>;
}

export type ProcessStep = AlwaysStep | IntegrationStep;
