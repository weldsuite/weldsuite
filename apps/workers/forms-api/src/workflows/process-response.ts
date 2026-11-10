/**
 * ProcessResponseWorkflow: what happens after a response is submitted (or a
 * verified respondent edited theirs). The instance id is the response id
 * (`<id>-update-<n>` for an edit), so a response is processed once.
 *
 * The workflow loads the response, then runs the ordered steps of
 * `./steps/index.ts`, each as its own `step.do`: a failing step retries with
 * backoff without repeating the others. Integration steps run once per enabled
 * integration of their kind and are recorded in `form_response_actions`
 * (pending, then done, skipped or failed with the error), which is what the
 * response's actions list and its Retry button show. Without a Workflow binding
 * (local dev) the same runner runs inline.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import type { Env } from '../types';
import type { ProcessResponseParams } from './process-params';
import { PROCESS_STEPS } from './steps';
import type { ProcessContext, ProcessStep, RetryConfig, StepResult } from './steps/types';

export type { ProcessResponseParams } from './process-params';

const { forms, formVersions, formResponses, formResponseFiles, formIntegrations, formResponseActions } = schema;

const DEFAULT_RETRIES: RetryConfig = { limit: 5, delay: '10 seconds', backoff: 'exponential' };

/** The part of `WorkflowStep` the runner uses; the real step and the inline one both fit. */
export interface StepRunner {
  do<T>(name: string, config: { retries: RetryConfig }, run: () => Promise<T>): Promise<T>;
}

/** Runs steps in place, once, for deployments without a Workflow binding. */
export const inlineSteps: StepRunner = { do: (_name, _config, run) => run() };

/** Everything a step needs, read fresh inside the step (a DB handle does not survive a Workflow replay). */
async function loadContext(env: Env, params: ProcessResponseParams, db: Database): Promise<ProcessContext | null> {
  const [response] = await db.select().from(formResponses).where(eq(formResponses.id, params.responseId)).limit(1);
  if (!response || response.status !== 'completed') return null;
  const [[form], [version], files] = await Promise.all([
    db.select().from(forms).where(eq(forms.id, response.formId)).limit(1),
    db.select().from(formVersions).where(eq(formVersions.id, response.versionId)).limit(1),
    db.select().from(formResponseFiles).where(eq(formResponseFiles.responseId, response.id)),
  ]);
  if (!form || !version) return null;
  return { env, db, master: getMasterDb(env), params, form, response, definition: formDefinitionSchema.parse(version.definition), files };
}

type IntegrationRow = typeof formIntegrations.$inferSelect;

/** Marks the attempt: one row per integration per response, attempts counted. */
async function markPending(db: Database, ctx: ProcessContext, integration: IntegrationRow): Promise<void> {
  const now = new Date();
  await db
    .insert(formResponseActions)
    .values({ id: generateId('fra'), responseId: ctx.response.id, formId: ctx.form.id, integrationId: integration.id, kind: integration.kind, status: 'pending', attempts: 1 })
    .onConflictDoUpdate({
      target: [formResponseActions.responseId, formResponseActions.integrationId],
      set: { status: 'pending', error: null, attempts: sql`${formResponseActions.attempts} + 1`, updatedAt: now },
    });
}

async function finishAction(db: Database, ctx: ProcessContext, integration: IntegrationRow, outcome: StepResult | { status: 'failed'; error: string }): Promise<void> {
  const now = new Date();
  const where = and(eq(formResponseActions.responseId, ctx.response.id), eq(formResponseActions.integrationId, integration.id));
  if (outcome.status === 'done') {
    await db
      .update(formResponseActions)
      .set({ status: 'done', entityType: outcome.entityType ?? null, entityId: outcome.entityId ?? null, error: null, updatedAt: now })
      .where(where);
    await db.update(formIntegrations).set({ lastError: null }).where(eq(formIntegrations.id, integration.id));
    return;
  }
  const error = outcome.status === 'skipped' ? outcome.reason : outcome.error;
  await db.update(formResponseActions).set({ status: outcome.status, error, updatedAt: now }).where(where);
  await db.update(formIntegrations).set({ lastError: error }).where(eq(formIntegrations.id, integration.id));
}

/**
 * The workflow's body, on a step runner. Returns without error even when a step
 * failed for good: the failure is recorded on its action row and the other
 * steps still run.
 */
export async function runProcessResponse(
  env: Env,
  params: ProcessResponseParams,
  runner: StepRunner,
  steps: readonly ProcessStep[] = PROCESS_STEPS,
): Promise<void> {
  const integrations = await runner.do('load response', { retries: DEFAULT_RETRIES }, async () => {
    const db = await getTenantDbForWorkspace(env, params.clerkOrgId);
    const ctx = await loadContext(env, params, db);
    if (!ctx) return null;
    const rows = await db.select({ id: formIntegrations.id, kind: formIntegrations.kind }).from(formIntegrations).where(and(eq(formIntegrations.formId, ctx.form.id), eq(formIntegrations.enabled, true)));
    return rows;
  });
  if (integrations === null) return;

  for (const step of steps) {
    const retries = step.retries ?? DEFAULT_RETRIES;
    try {
      // A retry runs one integration's step again, not the notifications or the receipt.
      if (step.type === 'always') {
        if (params.retryIntegrationId) continue;
        await runner.do(step.name, { retries }, async () => {
          const db = await getTenantDbForWorkspace(env, params.clerkOrgId);
          const ctx = await loadContext(env, params, db);
          if (ctx) await step.run(ctx);
          return null;
        });
        continue;
      }
      for (const integration of integrations.filter((i) => i.kind === step.kind && (!params.retryIntegrationId || i.id === params.retryIntegrationId))) {
        await runIntegrationStep(env, params, runner, step, integration.id, retries);
      }
    } catch (err) {
      console.error(`[forms-api] ProcessResponse step ${step.name} failed for ${params.responseId}:`, err);
    }
  }
}

async function runIntegrationStep(
  env: Env,
  params: ProcessResponseParams,
  runner: StepRunner,
  step: Extract<ProcessStep, { type: 'integration' }>,
  integrationId: string,
  retries: RetryConfig,
): Promise<void> {
  await runner.do(`${step.name}:${integrationId}`, { retries }, async () => {
    const db = await getTenantDbForWorkspace(env, params.clerkOrgId);
    const [integration] = await db.select().from(formIntegrations).where(eq(formIntegrations.id, integrationId)).limit(1);
    // Not this step's kind, or removed or switched off since the run started.
    if (!integration || integration.kind !== step.kind || !integration.enabled) return null;
    const ctx = await loadContext(env, params, db);
    if (!ctx) return null;
    await markPending(db, ctx, integration);
    try {
      await finishAction(db, ctx, integration, await step.run(ctx, integration));
    } catch (err) {
      await finishAction(db, ctx, integration, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return null;
  });
}

export class ProcessResponseWorkflow extends WorkflowEntrypoint<Env, ProcessResponseParams> {
  async run(event: WorkflowEvent<ProcessResponseParams>, step: WorkflowStep) {
    await runProcessResponse(this.env, event.payload, step as unknown as StepRunner);
  }
}
