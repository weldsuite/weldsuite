/**
 * Bitbucket Cloud repository webhooks: registered per repository with the fresh
 * secret (Bitbucket signs each delivery `X-Hub-Signature: sha256=<hmac>`),
 * deleted when the repository is removed. Verification and parsing are the pure
 * functions in @weldsuite/merge-domain/providers/bitbucket.
 *
 *   POST   https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/hooks
 *   DELETE https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/hooks/{uuid}
 */

import { parseBitbucketWebhook, verifyBitbucketSignature } from '@weldsuite/merge-domain/providers/bitbucket';
import { isStatus } from '../provider-http';
import type { AdapterContext, ConnectionAdapter, RepositoryRef, WebhookTarget } from '../types';
import { bitbucketClient, repoPath } from './client';

export const BITBUCKET_HOOK_EVENTS = [
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:approved',
  'pullrequest:unapproved',
  'pullrequest:changes_request_created',
  'pullrequest:changes_request_removed',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
  'repo:commit_status_created',
  'repo:commit_status_updated',
];

export async function registerBitbucketWebhook(
  ctx: AdapterContext,
  repository: RepositoryRef,
  target: WebhookTarget,
): Promise<{ webhookId: string }> {
  const hook = await bitbucketClient(ctx).send<{ uuid: string }>('POST', `${repoPath(repository)}/hooks`, {
    description: 'WeldMerge',
    url: target.url,
    active: true,
    secret: target.secret,
    events: BITBUCKET_HOOK_EVENTS,
  });
  return { webhookId: String(hook?.uuid) };
}

export async function deleteBitbucketWebhook(ctx: AdapterContext, repository: RepositoryRef, webhookId: string): Promise<void> {
  try {
    await bitbucketClient(ctx).send('DELETE', `${repoPath(repository)}/hooks/${encodeURIComponent(webhookId)}`);
  } catch (err) {
    if (!isStatus(err, 404)) throw err;
  }
}

export const bitbucketWebhooks: Pick<ConnectionAdapter, 'registerWebhook' | 'deleteWebhook' | 'verifyWebhook' | 'parseWebhook'> = {
  registerWebhook: registerBitbucketWebhook,
  deleteWebhook: deleteBitbucketWebhook,
  verifyWebhook: verifyBitbucketSignature,
  parseWebhook: parseBitbucketWebhook,
};
