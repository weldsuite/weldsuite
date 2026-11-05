/**
 * GitLab project hooks: registered per repository with the fresh secret as the
 * hook's secret token (`X-Gitlab-Token`), deleted when the repository is
 * removed. Verification and parsing are the pure functions in
 * @weldsuite/merge-domain/providers/gitlab.
 *
 *   POST   {host}/api/v4/projects/:id/hooks
 *   DELETE {host}/api/v4/projects/:id/hooks/:hookId
 */

import { parseGitlabWebhook, verifyGitlabToken } from '@weldsuite/merge-domain/providers/gitlab';
import { isStatus } from '../provider-http';
import type { AdapterContext, ConnectionAdapter, RepositoryRef, WebhookTarget } from '../types';
import { gitlabClient, projectPath } from './client';

export async function registerGitlabWebhook(
  ctx: AdapterContext,
  repository: RepositoryRef,
  target: WebhookTarget,
): Promise<{ webhookId: string }> {
  const hook = await gitlabClient(ctx).send<{ id: number }>('POST', `${projectPath(repository)}/hooks`, {
    url: target.url,
    token: target.secret,
    merge_requests_events: true,
    issues_events: true,
    note_events: true,
    pipeline_events: true,
    push_events: false,
    enable_ssl_verification: true,
  });
  return { webhookId: String(hook?.id) };
}

export async function deleteGitlabWebhook(ctx: AdapterContext, repository: RepositoryRef, webhookId: string): Promise<void> {
  try {
    await gitlabClient(ctx).send('DELETE', `${projectPath(repository)}/hooks/${encodeURIComponent(webhookId)}`);
  } catch (err) {
    // Already gone (the project was removed, or someone deleted the hook).
    if (!isStatus(err, 404)) throw err;
  }
}

export const gitlabWebhooks: Pick<ConnectionAdapter, 'registerWebhook' | 'deleteWebhook' | 'verifyWebhook' | 'parseWebhook'> = {
  registerWebhook: registerGitlabWebhook,
  deleteWebhook: deleteGitlabWebhook,
  async verifyWebhook(headers, _rawBody, secret) {
    return verifyGitlabToken(headers, secret);
  },
  parseWebhook: parseGitlabWebhook,
};
