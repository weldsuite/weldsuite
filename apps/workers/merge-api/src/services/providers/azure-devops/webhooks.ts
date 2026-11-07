/**
 * Azure DevOps service hooks: one web-hook subscription per pull request event
 * (created, updated, merged) on the repository, with HTTP basic auth carrying
 * the fresh secret as its password. The provider's `webhookId` is the three
 * subscription ids joined by commas. Verification and parsing are the pure
 * functions in @weldsuite/merge-domain/providers/azure-devops.
 *
 *   GET    {org}/_apis/git/repositories/{repoId}?api-version=7.1       (the project's GUID)
 *   POST   {org}/_apis/hooks/subscriptions?api-version=7.1             (x3)
 *   DELETE {org}/_apis/hooks/subscriptions/{id}?api-version=7.1
 */

import { parseAzureWebhook, verifyAzureBasicAuth } from '@weldsuite/merge-domain/providers/azure-devops';
import { ProviderApiError } from '../types';
import { isStatus } from '../provider-http';
import type { AdapterContext, ConnectionAdapter, RepositoryRef, WebhookTarget } from '../types';
import { API_VERSION, azureClient, type AzureRepository } from './client';

export const AZURE_HOOK_EVENTS = ['git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged'];
const HOOK_USER = 'weldmerge';

async function deleteSubscription(ctx: AdapterContext, id: string): Promise<void> {
  try {
    await azureClient(ctx).send('DELETE', `/_apis/hooks/subscriptions/${encodeURIComponent(id)}?${API_VERSION}`);
  } catch (err) {
    if (!isStatus(err, 404)) throw err;
  }
}

export async function registerAzureWebhook(
  ctx: AdapterContext,
  repository: RepositoryRef,
  target: WebhookTarget,
): Promise<{ webhookId: string }> {
  const client = azureClient(ctx);
  const repo = await client.get<AzureRepository>(`/_apis/git/repositories/${encodeURIComponent(repository.externalId)}?${API_VERSION}`);
  const projectId = repo?.project?.id;
  if (!projectId) throw new ProviderApiError('azure_devops', 404, 'The Azure DevOps repository was not found');
  const ids: string[] = [];
  try {
    for (const eventType of AZURE_HOOK_EVENTS) {
      const created = await client.send<{ id: string }>('POST', `/_apis/hooks/subscriptions?${API_VERSION}`, {
        publisherId: 'tfs',
        eventType,
        resourceVersion: '1.0',
        consumerId: 'webHooks',
        consumerActionId: 'httpRequest',
        publisherInputs: { projectId, repository: repository.externalId },
        consumerInputs: { url: target.url, basicAuthUsername: HOOK_USER, basicAuthPassword: target.secret },
      });
      ids.push(String(created?.id));
    }
  } catch (err) {
    // Leave nothing half-registered.
    for (const id of ids) await deleteSubscription(ctx, id).catch(() => undefined);
    throw err;
  }
  return { webhookId: ids.join(',') };
}

export async function deleteAzureWebhook(ctx: AdapterContext, _repository: RepositoryRef, webhookId: string): Promise<void> {
  for (const id of webhookId.split(',').filter(Boolean)) await deleteSubscription(ctx, id);
}

export const azureWebhooks: Pick<ConnectionAdapter, 'registerWebhook' | 'deleteWebhook' | 'verifyWebhook' | 'parseWebhook'> = {
  registerWebhook: registerAzureWebhook,
  deleteWebhook: deleteAzureWebhook,
  async verifyWebhook(headers, _rawBody, secret) {
    return verifyAzureBasicAuth(headers, secret);
  },
  parseWebhook: parseAzureWebhook,
};
