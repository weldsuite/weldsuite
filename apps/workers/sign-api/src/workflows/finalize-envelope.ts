/**
 * FinalizeEnvelopeWorkflow — builds the signed PDF once the last signer has
 * signed, then sends it out. Two steps, each idempotent and retried on its
 * own, so a failed email never rebuilds the PDF and a failed build never
 * sends mail (services/finalize.ts).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getMasterDb, getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { buildFinalPdf, notifyCompleted } from '../services/finalize';

export interface FinalizeEnvelopeParams {
  clerkOrgId: string;
  /** Master `workspaces.id` (link registry). */
  workspaceId: string;
  envelopeId: string;
}

/** Run both steps directly: what the Workflow does, and the fallback when its binding is missing. */
export async function finalizeEnvelope(env: Env, params: FinalizeEnvelopeParams): Promise<void> {
  const db = await getTenantDbForWorkspace(env, params.clerkOrgId);
  const master = getMasterDb(env);
  const ctx = { env, db, bucket: env.PRIVATE_STORAGE, clerkOrgId: params.clerkOrgId, master };
  const built = await buildFinalPdf(ctx, params.envelopeId);
  if (!built) return;
  await notifyCompleted(ctx, master, params.workspaceId, params.envelopeId);
  await publishCompleted(env, params, built.sha256);
}

async function publishCompleted(env: Env, params: FinalizeEnvelopeParams, sha256: string): Promise<void> {
  await publishEntityEventRaw({
    env,
    workspaceId: params.clerkOrgId,
    userId: 'system',
    entityType: 'sign_envelope',
    action: 'completed',
    entityId: params.envelopeId,
    data: { id: params.envelopeId, status: 'completed', finalSha256: sha256 },
  });
}

export class FinalizeEnvelopeWorkflow extends WorkflowEntrypoint<Env, FinalizeEnvelopeParams> {
  async run(event: WorkflowEvent<FinalizeEnvelopeParams>, step: WorkflowStep) {
    const params = event.payload;
    const built = await step.do('build signed pdf', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } }, async () => {
      const db = await getTenantDbForWorkspace(this.env, params.clerkOrgId);
      return buildFinalPdf(
        { env: this.env, db, bucket: this.env.PRIVATE_STORAGE, clerkOrgId: params.clerkOrgId, master: getMasterDb(this.env) },
        params.envelopeId,
      );
    });
    if (!built) return;
    await step.do('send signed pdf', { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } }, async () => {
      const db = await getTenantDbForWorkspace(this.env, params.clerkOrgId);
      await notifyCompleted(
        { env: this.env, db, bucket: this.env.PRIVATE_STORAGE, clerkOrgId: params.clerkOrgId },
        getMasterDb(this.env),
        params.workspaceId,
        params.envelopeId,
      );
    });
    await step.do('publish completed', async () => publishCompleted(this.env, params, built.sha256));
  }
}
