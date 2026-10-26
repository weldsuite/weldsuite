/**
 * Finishing a request once the last signer has signed: build the signed PDF,
 * send it out, then file a copy in WeldDrive (and on the CRM record the
 * request came from). sign-api's FinalizeEnvelopeWorkflow runs these as
 * separately retried steps; `finalizeEnvelope` runs them in one go, for a
 * Worker without the Workflow binding.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getMasterDb, getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { FinalizeEnvelopeParams, SignEnv } from './env';
import { buildFinalPdf, notifyCompleted } from './finalize';
import { fileSignedPdf } from './filing';

export type { FinalizeEnvelopeParams } from './env';

/** Run every step directly: what the Workflow does, and the fallback when its binding is missing. */
export async function finalizeEnvelope(env: SignEnv, params: FinalizeEnvelopeParams): Promise<void> {
  const db = await getTenantDbForWorkspace(env, params.clerkOrgId);
  const master = getMasterDb(env);
  const ctx = { env, db, bucket: env.PRIVATE_STORAGE, clerkOrgId: params.clerkOrgId, master };
  const built = await buildFinalPdf(ctx, params.envelopeId);
  if (!built) return;
  await notifyCompleted(ctx, master, params.workspaceId, params.envelopeId);
  await publishCompleted(env, params, built.sha256);
  try {
    await fileSignedPdf(ctx, params.envelopeId);
  } catch (err) {
    console.error(`[sign] filing the signed PDF of ${params.envelopeId} failed:`, err);
  }
}

export async function publishCompleted(env: SignEnv, params: FinalizeEnvelopeParams, sha256: string): Promise<void> {
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
