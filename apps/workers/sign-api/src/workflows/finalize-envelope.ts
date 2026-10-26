/**
 * FinalizeEnvelopeWorkflow — builds the signed PDF once the last signer has
 * signed, sends it out, then files a copy in WeldDrive (and on the CRM record
 * the request came from). Each step is idempotent and retried on its own, so
 * a failed email never rebuilds the PDF, a failed build never sends mail, and
 * a filing problem holds back nothing (@weldsuite/sign-domain finalize, filing).
 *
 * apps/web/sign-portal starts it too, through a `script_name` binding, when a
 * signer finishes the last signature.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getMasterDb, getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import { buildFinalPdf, notifyCompleted } from '@weldsuite/sign-domain/finalize';
import { fileSignedPdf } from '@weldsuite/sign-domain/filing';
import { publishCompleted, type FinalizeEnvelopeParams } from '@weldsuite/sign-domain/finalize-envelope';
import type { Env } from '../types';

export { finalizeEnvelope, type FinalizeEnvelopeParams } from '@weldsuite/sign-domain/finalize-envelope';

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
    // Last, and on its own: a filing problem never holds back the signed PDF or its emails.
    await step.do('file signed pdf', { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' } }, async () => {
      const db = await getTenantDbForWorkspace(this.env, params.clerkOrgId);
      await fileSignedPdf({ env: this.env, db, bucket: this.env.PRIVATE_STORAGE, clerkOrgId: params.clerkOrgId }, params.envelopeId);
    });
  }
}
